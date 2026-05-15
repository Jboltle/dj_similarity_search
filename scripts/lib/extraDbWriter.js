/**
 * Read-write access to VirtualDJ's `extra.db`. Used to merge linked-track
 * pairs from a different machine into a target library.
 *
 * Every write is wrapped in safety rails:
 *
 *   1. Refuse to open if `extra.db-wal` or `extra.db-shm` exist next to the
 *      target file — that's the strongest signal VirtualDJ is currently
 *      running and holding the database. Pass --force-wal to override.
 *
 *   2. Always create a timestamped backup of the target before opening
 *      read-write. Windows filenames can't contain ':' so the timestamp is
 *      sanitized.
 *
 *   3. All mutations run inside a single `db.transaction(...)`. If anything
 *      throws, better-sqlite3 rolls back automatically.
 *
 *   4. Schema is introspected at runtime via `PRAGMA table_info()` so we
 *      tolerate future VirtualDJ versions adding columns. We only write
 *      columns we recognize; others stay NULL / default.
 *
 *   5. Caller can request a dry-run that opens read-only, simulates the
 *      inserts via SELECT-only queries, and reports counts without ever
 *      touching the original file.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expandVdjPath, listDefaultVirtualDjDirs } from './paths.js';

const TRACK_DATA_TABLE = 'track_data';
const RELATED_TRACKS_TABLE = 'related_tracks';

const KNOWN_TRACK_DATA_COLUMNS = ['sid', 'file', 'artist', 'title', 'remix'];

const WAL_SIDECAR_EXTENSIONS = ['-wal', '-shm'];

function timestampForFilename() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function checkForRunningVdj(targetPath) {
  const issues = [];
  for (const ext of WAL_SIDECAR_EXTENSIONS) {
    const sidecar = `${targetPath}${ext}`;
    if (fs.existsSync(sidecar)) issues.push(sidecar);
  }
  return issues;
}

function makeBackup(targetPath, projectRoot) {
  const stamp = timestampForFilename();
  const backupDir = path.join(projectRoot, 'public', 'backups');
  fs.mkdirSync(backupDir, { recursive: true });

  const sideBySidePath = `${targetPath}.backup-${stamp}`;
  const projectMirrorPath = path.join(backupDir, `extra.db.backup-${stamp}`);

  fs.copyFileSync(targetPath, sideBySidePath);
  fs.copyFileSync(targetPath, projectMirrorPath);

  for (const ext of WAL_SIDECAR_EXTENSIONS) {
    const sidecar = `${targetPath}${ext}`;
    if (fs.existsSync(sidecar)) {
      fs.copyFileSync(sidecar, `${sideBySidePath}${ext}`);
      fs.copyFileSync(sidecar, `${projectMirrorPath}${ext}`);
    }
  }

  return { sideBySidePath, projectMirrorPath };
}

function introspectColumns(db, tableName) {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return new Set(rows.map((r) => r.name));
}

function filterToKnownColumns(availableColumns, candidate) {
  const result = {};
  for (const col of KNOWN_TRACK_DATA_COLUMNS) {
    if (availableColumns.has(col) && candidate[col] !== undefined) {
      result[col] = candidate[col];
    }
  }
  return result;
}

function buildInsertStatement(tableName, columns) {
  const cols = [...columns];
  const placeholders = cols.map(() => '?').join(', ');
  return `INSERT OR IGNORE INTO ${tableName} (${cols.join(', ')}) VALUES (${placeholders})`;
}

function ensureSchemaPresent(db) {
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
    .all()
    .map((row) => row.name);
  const missing = [];
  if (!tables.includes(TRACK_DATA_TABLE)) missing.push(TRACK_DATA_TABLE);
  if (!tables.includes(RELATED_TRACKS_TABLE)) missing.push(RELATED_TRACKS_TABLE);
  if (missing.length) {
    throw new Error(
      `Target extra.db is missing required tables: ${missing.join(', ')}. ` +
        `Make sure VirtualDJ has been launched at least once on the target machine.`
    );
  }
}

function applyPairsToDb({ db, pairs }) {
  const trackDataCols = introspectColumns(db, TRACK_DATA_TABLE);
  const relatedTracksCols = introspectColumns(db, RELATED_TRACKS_TABLE);

  if (!relatedTracksCols.has('sid1') || !relatedTracksCols.has('sid2')) {
    throw new Error(
      `Target ${RELATED_TRACKS_TABLE} schema is missing required sid1/sid2 columns.`
    );
  }

  const trackInsertCols = KNOWN_TRACK_DATA_COLUMNS.filter((c) => trackDataCols.has(c));
  if (!trackInsertCols.includes('sid')) {
    throw new Error(`Target ${TRACK_DATA_TABLE} has no 'sid' column — cannot proceed.`);
  }
  const insertTrack = db.prepare(buildInsertStatement(TRACK_DATA_TABLE, trackInsertCols));

  const checkPair = db.prepare(
    `SELECT 1 FROM ${RELATED_TRACKS_TABLE} WHERE (sid1 = ? AND sid2 = ?) OR (sid1 = ? AND sid2 = ?)`
  );
  const insertPair = db.prepare(`INSERT INTO ${RELATED_TRACKS_TABLE} (sid1, sid2) VALUES (?, ?)`);
  const checkTrack = db.prepare(`SELECT 1 FROM ${TRACK_DATA_TABLE} WHERE sid = ?`);

  const tally = {
    tracksInserted: 0,
    tracksAlreadyPresent: 0,
    pairsInserted: 0,
    pairsAlreadyPresent: 0,
    skippedMissingSid: 0,
  };
  const insertedPairs = [];

  for (const pair of pairs) {
    if (pair.left.sid == null || pair.right.sid == null) {
      tally.skippedMissingSid += 1;
      continue;
    }
    const leftSid = Number.parseInt(pair.left.sid, 10);
    const rightSid = Number.parseInt(pair.right.sid, 10);

    for (const side of [pair.left, pair.right]) {
      const sid = Number.parseInt(side.sid, 10);
      if (checkTrack.get(sid)) {
        tally.tracksAlreadyPresent += 1;
        continue;
      }
      const candidate = filterToKnownColumns(trackDataCols, {
        sid,
        file: side.file ?? null,
        artist: side.artist ?? null,
        title: side.title ?? null,
        remix: side.remix ?? null,
      });
      const values = trackInsertCols.map((c) => candidate[c] ?? null);
      insertTrack.run(...values);
      tally.tracksInserted += 1;
    }

    if (checkPair.get(leftSid, rightSid, rightSid, leftSid)) {
      tally.pairsAlreadyPresent += 1;
      continue;
    }
    insertPair.run(leftSid, rightSid);
    tally.pairsInserted += 1;
    insertedPairs.push({ sid1: leftSid, sid2: rightSid });
  }

  return { tally, insertedPairs };
}

/**
 * Top-level merge. Returns a structured report. Throws on safety violations
 * (WAL present, schema mismatch, etc.) so the caller can surface clear
 * error messages and fall back to the export-only path.
 */
export function mergePairsIntoExtraDb({ targetPath, pairs, projectRoot, dryRun, forceWal }) {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`Target extra.db not found: ${targetPath}`);
  }

  const walIssues = checkForRunningVdj(targetPath);
  if (walIssues.length && !forceWal) {
    throw new Error(
      `Target appears to be in use by VirtualDJ (sidecar files present):\n` +
        walIssues.map((p) => `  ${p}`).join('\n') +
        `\nClose VirtualDJ first, or re-run with --force-wal (DANGEROUS).`
    );
  }

  const backups = !dryRun ? makeBackup(targetPath, projectRoot) : null;

  let db;
  try {
    db = new Database(targetPath, { readonly: dryRun, fileMustExist: true });
    ensureSchemaPresent(db);

    let result;
    if (dryRun) {
      result = applyPairsToDb({ db, pairs });
    } else {
      const tx = db.transaction(() => applyPairsToDb({ db, pairs }));
      result = tx();
    }

    return {
      targetPath,
      dryRun,
      backups,
      tally: result.tally,
      insertedPairs: result.insertedPairs,
    };
  } finally {
    if (db) db.close();
  }
}

/**
 * Resolve the platform-default target path. Mirrors resolveExtraDbPath
 * in scripts/lib/relatedTracks.js but accepts a CLI override.
 */
export function resolveTargetPath(explicit) {
<<<<<<< HEAD
  if (explicit) return explicit;
  if (process.env.VDJ_EXTRA_DB_PATH) return process.env.VDJ_EXTRA_DB_PATH;
  return vdjFiles(resolveVdjFolder(null)).extraDb;
=======
  if (explicit) {
    const expanded = expandVdjPath(explicit);
    if (expanded) return expanded;
  }
  if (process.env.VDJ_EXTRA_DB_PATH) {
    const expanded = expandVdjPath(process.env.VDJ_EXTRA_DB_PATH);
    if (expanded) return expanded;
  }
  for (const dir of listDefaultVirtualDjDirs()) {
    const candidate = path.join(dir, 'extra.db');
    if (fs.existsSync(candidate)) return candidate;
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'VirtualDJ', 'extra.db');
  }
  return path.join(os.homedir(), 'Documents', 'VirtualDJ', 'extra.db');
>>>>>>> refs/remotes/origin/main
}
