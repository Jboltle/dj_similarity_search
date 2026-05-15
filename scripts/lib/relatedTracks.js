import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { resolveVdjFolder, vdjFiles } from './vdjPaths.js';

export function resolveExtraDbPath(explicit) {
  const candidates = [];
  if (explicit) candidates.push(explicit);
  if (process.env.VDJ_EXTRA_DB_PATH) candidates.push(process.env.VDJ_EXTRA_DB_PATH);
  candidates.push(vdjFiles(resolveVdjFolder(null)).extraDb);
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Make a temporary copy so we never even touch the original file. This protects
 * against the (extremely unlikely) case where better-sqlite3's read-only mode
 * still fingerprints the source file via WAL/SHM sidecars while VirtualDJ runs.
 */
function copyToTemp(extraDbPath) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdj-link-map-'));
  const tmpDb = path.join(tmpDir, 'extra.db');
  fs.copyFileSync(extraDbPath, tmpDb);
  for (const ext of ['-wal', '-shm']) {
    const sidecar = `${extraDbPath}${ext}`;
    if (fs.existsSync(sidecar)) fs.copyFileSync(sidecar, `${tmpDb}${ext}`);
  }
  return { tmpDir, tmpDb };
}

const RELATED_QUERY = `
  SELECT
    rt.id AS rowId,
    td1.sid     AS sid1,
    td1.file    AS file1,
    td1.artist  AS artist1,
    td1.title   AS title1,
    td1.remix   AS remix1,
    td2.sid     AS sid2,
    td2.file    AS file2,
    td2.artist  AS artist2,
    td2.title   AS title2,
    td2.remix   AS remix2
  FROM related_tracks rt
  INNER JOIN track_data td1 ON td1.sid = rt.sid1
  INNER JOIN track_data td2 ON td2.sid = rt.sid2
`;

export function readRelatedTracks(extraDbPath) {
  const { tmpDir, tmpDb } = copyToTemp(extraDbPath);
  let db;
  try {
    db = new Database(tmpDb, { readonly: true, fileMustExist: true });
    const rows = db.prepare(RELATED_QUERY).all();
    const orphanCount = db.prepare(
      'SELECT COUNT(*) AS n FROM related_tracks rt WHERE NOT EXISTS (SELECT 1 FROM track_data td WHERE td.sid = rt.sid1) OR NOT EXISTS (SELECT 1 FROM track_data td WHERE td.sid = rt.sid2)'
    ).get();
    const totalRelated = db.prepare('SELECT COUNT(*) AS n FROM related_tracks').get();
    return {
      rows,
      stats: {
        totalRelatedRows: totalRelated.n,
        orphanedRows: orphanCount.n,
        joinedRows: rows.length,
      },
    };
  } finally {
    if (db) db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
