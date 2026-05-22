/**
 * SQLite safety primitives shared by every command that opens VirtualDJ's
 * extra.db. Kept tiny and dependency-free so the sync/* and linked:folder
 * scripts can pull them in without dragging the rest of the project along.
 */
import fs from 'node:fs';
import Database from 'better-sqlite3';

const WAL_SIDECAR_EXTENSIONS = ['-wal', '-shm'];

function getWalSidecarIssues(extraDbPath) {
  const issues = [];
  for (const ext of WAL_SIDECAR_EXTENSIONS) {
    const sidecar = `${extraDbPath}${ext}`;
    if (fs.existsSync(sidecar)) issues.push(sidecar);
  }
  return issues;
}

/**
 * Throws if VirtualDJ-style WAL/SHM sidecars exist next to the database
 * file. Pass `forceWal: true` to acknowledge the risk and proceed anyway
 * (the script's `--force-wal` flag).
 */
export function assertNoVdjRunning(extraDbPath, { forceWal = false } = {}) {
  const issues = getWalSidecarIssues(extraDbPath);
  if (issues.length && !forceWal) {
    throw new Error(
      `VirtualDJ may be using extra.db (sidecar files present):\n` +
        issues.map((p) => `  ${p}`).join('\n') +
        `\nClose VirtualDJ first, or pass --force-wal (DANGEROUS).`
    );
  }
}

/**
 * @returns {'ok' | string} `'ok'` or the first integrity error line
 */
export function verifySqliteIntegrity(dbPath) {
  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db.prepare('PRAGMA integrity_check').get();
    const check = row?.integrity_check;
    return check === 'ok' ? 'ok' : String(check ?? 'unknown');
  } finally {
    if (db) db.close();
  }
}
