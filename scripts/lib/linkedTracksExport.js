/**
 * Portable exports of the linked-track set. The merge script writes these
 * unconditionally on every run, so they double as:
 *
 *   1. A shareable artifact (move them to a new machine and re-apply)
 *   2. A fallback when the in-place merge into extra.db fails for any reason
 *      (file locked by VirtualDJ, schema mismatch, permission denied, etc.)
 *
 * Three formats are produced:
 *
 *   linked-tracks-export.json   — machine-readable, identical pair shape
 *                                 to what gets written into extra.db
 *   linked-tracks-export.sql    — INSERT OR IGNORE statements, runnable via
 *                                 `sqlite3 extra.db < linked-tracks-export.sql`
 *   linked-tracks.db            — standalone SQLite with track_data +
 *                                 related_tracks tables, importable via
 *                                 `ATTACH DATABASE` from any extra.db
 */
import fs from 'node:fs';
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

function escapeSqlString(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function escapeSqlInt(value) {
  if (value === null || value === undefined || value === '') return 'NULL';
  const asInt = Number.parseInt(value, 10);
  if (Number.isNaN(asInt)) return 'NULL';
  return String(asInt);
}

function buildJsonExport({ pairs, sourceMeta }) {
  const tracksBySid = new Map();
  for (const pair of pairs) {
    if (pair.left.sid != null && !tracksBySid.has(pair.left.sid)) {
      tracksBySid.set(pair.left.sid, pair.left);
    }
    if (pair.right.sid != null && !tracksBySid.has(pair.right.sid)) {
      tracksBySid.set(pair.right.sid, pair.right);
    }
  }
  return {
    meta: {
      generatedAt: new Date().toISOString(),
      sourceGraphJson: sourceMeta?.databasePath ?? null,
      pairCount: pairs.length,
      trackCount: tracksBySid.size,
      note:
        'Apply to a target extra.db by running merge-links-to-extra-db.js, or ' +
        'manually via: sqlite3 extra.db < linked-tracks-export.sql',
    },
    tracks: [...tracksBySid.values()],
    pairs: pairs.map((p) => ({
      sid1: p.left.sid,
      sid2: p.right.sid,
    })),
  };
}

function buildSqlExport(pairs) {
  const lines = [];
  lines.push('-- VirtualDJ linked tracks export');
  lines.push('-- Apply with: sqlite3 /path/to/extra.db < linked-tracks-export.sql');
  lines.push('-- VirtualDJ must NOT be running while you do this.');
  lines.push('BEGIN TRANSACTION;');

  const seenSids = new Set();
  for (const pair of pairs) {
    for (const side of [pair.left, pair.right]) {
      if (side.sid == null || seenSids.has(side.sid)) continue;
      seenSids.add(side.sid);
      lines.push(
        `INSERT OR IGNORE INTO track_data (sid, file, artist, title, remix) VALUES (` +
          [
            escapeSqlInt(side.sid),
            escapeSqlString(side.file),
            escapeSqlString(side.artist),
            escapeSqlString(side.title),
            escapeSqlString(side.remix),
          ].join(', ') +
          ');'
      );
    }
  }

  for (const pair of pairs) {
    if (pair.left.sid == null || pair.right.sid == null) continue;
    const a = escapeSqlInt(pair.left.sid);
    const b = escapeSqlInt(pair.right.sid);
    lines.push(
      `INSERT INTO related_tracks (sid1, sid2) SELECT ${a}, ${b} ` +
        `WHERE NOT EXISTS (SELECT 1 FROM related_tracks WHERE ` +
        `(sid1 = ${a} AND sid2 = ${b}) OR (sid1 = ${b} AND sid2 = ${a}));`
    );
  }

  lines.push('COMMIT;');
  return lines.join('\n') + '\n';
}

function writeStandaloneDb({ pairs, dbPath }) {
  if (fs.existsSync(dbPath)) fs.rmSync(dbPath);
  const db = new Database(dbPath);
  try {
    db.exec(TRACK_DATA_DDL);
    db.exec(RELATED_TRACKS_DDL);

    const insertTrack = db.prepare(
      'INSERT OR IGNORE INTO track_data (sid, file, artist, title, remix) VALUES (?, ?, ?, ?, ?)'
    );
    const insertPair = db.prepare(
      'INSERT OR IGNORE INTO related_tracks (sid1, sid2) VALUES (?, ?)'
    );

    const tx = db.transaction(() => {
      const seenSids = new Set();
      for (const pair of pairs) {
        for (const side of [pair.left, pair.right]) {
          if (side.sid == null || seenSids.has(side.sid)) continue;
          seenSids.add(side.sid);
          insertTrack.run(
            Number.parseInt(side.sid, 10),
            side.file ?? null,
            side.artist ?? null,
            side.title ?? null,
            side.remix ?? null
          );
        }
      }
      for (const pair of pairs) {
        if (pair.left.sid == null || pair.right.sid == null) continue;
        const a = Number.parseInt(pair.left.sid, 10);
        const b = Number.parseInt(pair.right.sid, 10);
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
 * Writes JSON + SQL + standalone .db to `outDir`. Returns the absolute paths
 * of the three artifacts so the caller can print them in the report.
 */
export function writeLinkedTracksExport({ pairs, sourceMeta, outDir }) {
  fs.mkdirSync(outDir, { recursive: true });

  const jsonPath = path.join(outDir, 'linked-tracks-export.json');
  const sqlPath = path.join(outDir, 'linked-tracks-export.sql');
  const dbPath = path.join(outDir, 'linked-tracks.db');

  const jsonExport = buildJsonExport({ pairs, sourceMeta });
  fs.writeFileSync(jsonPath, JSON.stringify(jsonExport, null, 2));

  const sqlExport = buildSqlExport(pairs);
  fs.writeFileSync(sqlPath, sqlExport);

  writeStandaloneDb({ pairs, dbPath });

  return { jsonPath, sqlPath, dbPath, trackCount: jsonExport.meta.trackCount, pairCount: jsonExport.meta.pairCount };
}
