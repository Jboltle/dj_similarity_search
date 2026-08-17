/**
 * Union-merge two VirtualDJ extra.db SQLite files.
 *
 * - track_data is unioned by `sid` (the schema's primary key). When the same
 *   sid exists on both sides, the row whose `file/artist/title/remix` has the
 *   most non-empty fields wins; ties go to the local side.
 * - related_tracks is unioned by unordered (sid1, sid2) pair.
 *
 * Output is a brand-new SQLite file containing both tables — never modifies
 * either input file. The caller decides whether to copy the result into the
 * local VDJ folder (via the existing safety rails in clone:apply / merge:links).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const TRACK_DATA_DDL = `
  CREATE TABLE IF NOT EXISTS track_data (
    sid    INTEGER PRIMARY KEY,
    file   TEXT,
    artist TEXT,
    title  TEXT,
    remix  TEXT
  )
`;

const RELATED_TRACKS_DDL = `
  CREATE TABLE IF NOT EXISTS related_tracks (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    sid1 INTEGER NOT NULL,
    sid2 INTEGER NOT NULL,
    UNIQUE (sid1, sid2)
  )
`;

export function copyToTempReadonly(srcDbPath) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdj-extra-merge-'));
  const tmpDb = path.join(tmpDir, 'extra.db');
  fs.copyFileSync(srcDbPath, tmpDb);
  for (const ext of ['-wal', '-shm']) {
    const sidecar = `${srcDbPath}${ext}`;
    if (fs.existsSync(sidecar)) fs.copyFileSync(sidecar, `${tmpDb}${ext}`);
  }
  return { tmpDir, tmpDb };
}

export function readExtraDb(srcDbPath) {
  if (!fs.existsSync(srcDbPath)) return { tracks: [], pairs: [] };
  const { tmpDir, tmpDb } = copyToTempReadonly(srcDbPath);
  let db;
  try {
    db = new Database(tmpDb, { readonly: true, fileMustExist: true });
    const tables = new Set(
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
        .all()
        .map((r) => r.name)
    );
    const tracks = tables.has('track_data')
      ? db.prepare('SELECT sid, file, artist, title, remix FROM track_data').all()
      : [];
    const pairs = tables.has('related_tracks')
      ? db.prepare('SELECT sid1, sid2 FROM related_tracks').all()
      : [];
    return { tracks, pairs };
  } finally {
    if (db) db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function richnessScore(row) {
  let score = 0;
  for (const field of ['file', 'artist', 'title', 'remix']) {
    const v = row?.[field];
    if (v != null && String(v).trim() !== '') score += 1;
  }
  return score;
}

function unionTracks(localTracks, remoteTracks) {
  const bySid = new Map();
  let conflicts = 0;
  for (const t of localTracks) {
    if (t?.sid == null) continue;
    bySid.set(String(t.sid), { row: t, origin: 'local' });
  }
  for (const t of remoteTracks) {
    if (t?.sid == null) continue;
    const key = String(t.sid);
    const existing = bySid.get(key);
    if (!existing) {
      bySid.set(key, { row: t, origin: 'remote' });
      continue;
    }
    conflicts += 1;
    const localScore = richnessScore(existing.row);
    const remoteScore = richnessScore(t);
    if (remoteScore > localScore) {
      bySid.set(key, { row: t, origin: 'remote' });
    }
  }
  return { tracks: [...bySid.values()].map((entry) => entry.row), conflicts };
}

/**
 * Canonicalize (sid1, sid2) → smaller first so the dedupe key is
 * order-independent.
 */
export function pairKey(p) {
  if (p?.sid1 == null || p?.sid2 == null) return null;
  const a = BigInt(p.sid1);
  const b = BigInt(p.sid2);
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function unionPairs(localPairs, remotePairs) {
  const seen = new Map();
  for (const p of localPairs) {
    const k = pairKey(p);
    if (!k || seen.has(k)) continue;
    seen.set(k, { sid1: Number(p.sid1), sid2: Number(p.sid2), origin: 'local' });
  }
  let addedFromRemote = 0;
  for (const p of remotePairs) {
    const k = pairKey(p);
    if (!k || seen.has(k)) continue;
    seen.set(k, { sid1: Number(p.sid1), sid2: Number(p.sid2), origin: 'remote' });
    addedFromRemote += 1;
  }
  return { pairs: [...seen.values()], addedFromRemote };
}

/**
 * Write a fresh extra.db containing the merged rows. Does NOT replace any
 * existing file at destPath unless the caller pre-removed it.
 */
function writeMergedExtraDb({ destPath, tracks, pairs }) {
  if (fs.existsSync(destPath)) fs.rmSync(destPath);
  for (const ext of ['-wal', '-shm']) {
    const sidecar = `${destPath}${ext}`;
    if (fs.existsSync(sidecar)) fs.rmSync(sidecar);
  }
  const db = new Database(destPath);
  try {
    db.exec(TRACK_DATA_DDL);
    db.exec(RELATED_TRACKS_DDL);
    const insertTrack = db.prepare(
      'INSERT OR REPLACE INTO track_data (sid, file, artist, title, remix) VALUES (?, ?, ?, ?, ?)'
    );
    const insertPair = db.prepare(
      'INSERT OR IGNORE INTO related_tracks (sid1, sid2) VALUES (?, ?)'
    );
    const tx = db.transaction(() => {
      for (const t of tracks) {
        insertTrack.run(
          Number(t.sid),
          t.file ?? null,
          t.artist ?? null,
          t.title ?? null,
          t.remix ?? null
        );
      }
      for (const p of pairs) {
        const a = Number(p.sid1);
        const b = Number(p.sid2);
        const smaller = a < b ? a : b;
        const larger = a < b ? b : a;
        insertPair.run(smaller, larger);
      }
    });
    tx();
  } finally {
    db.close();
  }
}

/**
 * Read two extra.db files, union their rows, write a brand-new merged extra.db
 * at outPath. Returns a structured report for the merge log.
 */
export function mergeExtraDbFiles({ localPath, remotePath, outPath }) {
  const local = readExtraDb(localPath);
  const remote = readExtraDb(remotePath);

  const { tracks, conflicts: trackConflicts } = unionTracks(local.tracks, remote.tracks);
  const { pairs, addedFromRemote: pairsAddedFromRemote } = unionPairs(local.pairs, remote.pairs);

  writeMergedExtraDb({ destPath: outPath, tracks, pairs });

  return {
    outPath,
    report: {
      localPath,
      remotePath,
      localTrackCount: local.tracks.length,
      remoteTrackCount: remote.tracks.length,
      mergedTrackCount: tracks.length,
      trackConflicts,
      localPairCount: local.pairs.length,
      remotePairCount: remote.pairs.length,
      mergedPairCount: pairs.length,
      pairsAddedFromRemote,
    },
  };
}

/**
 * Single-source pass-through: copy one extra.db to a normalized merged file
 * (re-emitted via writeMergedExtraDb so the schema and ordering are canonical).
 */
export function copyExtraDbCanonical({ inputPath, outPath, label = 'local' }) {
  const { tracks, pairs } = readExtraDb(inputPath);
  const { tracks: canonicalTracks } = unionTracks(tracks, []);
  const { pairs: canonicalPairs } = unionPairs(pairs, []);
  writeMergedExtraDb({ destPath: outPath, tracks: canonicalTracks, pairs: canonicalPairs });
  return {
    outPath,
    report: {
      localPath: inputPath,
      remotePath: null,
      localTrackCount: tracks.length,
      remoteTrackCount: 0,
      mergedTrackCount: canonicalTracks.length,
      trackConflicts: 0,
      localPairCount: pairs.length,
      remotePairCount: 0,
      mergedPairCount: canonicalPairs.length,
      pairsAddedFromRemote: 0,
      singleSource: label,
    },
  };
}
