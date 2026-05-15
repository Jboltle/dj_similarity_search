/**
 * Shared helpers for clone-vdj-export.js and clone-vdj-apply.js.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

export const MANIFEST_FILENAME = 'manifest.json';
export const MANIFEST_SCHEMA_VERSION = 1;

const WAL_SIDECAR_EXTENSIONS = ['-wal', '-shm'];

export function timestampForCloneBackup() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export function getWalSidecarIssues(extraDbPath) {
  const issues = [];
  for (const ext of WAL_SIDECAR_EXTENSIONS) {
    const sidecar = `${extraDbPath}${ext}`;
    if (fs.existsSync(sidecar)) issues.push(sidecar);
  }
  return issues;
}

/**
 * @throws {Error} if WAL/SHM exist and forceWal is false
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

export function sha256FileSync(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function* walkFilesRecursive(rootDir) {
  const stack = [rootDir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(current, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else yield full;
    }
  }
}

/**
 * Deterministic fingerprint of a directory tree (sorted relative paths + per-file sha256).
 * Used for optional Cache/ verification; can be slow on large trees.
 */
export function sha256CacheDirectoryAggregate(cacheRoot) {
  if (!fs.existsSync(cacheRoot)) return null;
  const relHashes = [];
  for (const abs of walkFilesRecursive(cacheRoot)) {
    const rel = path.relative(cacheRoot, abs).split(path.sep).join('/');
    const h = sha256FileSync(abs);
    relHashes.push(`${rel}\0${h}`);
  }
  relHashes.sort();
  return crypto.createHash('sha256').update(relHashes.join('\n')).digest('hex');
}

/**
 * Copy extra.db plus any -wal / -shm sidecars that exist next to the source.
 */
export function copyExtraDbWithSidecars(srcExtraDb, destExtraDb) {
  fs.mkdirSync(path.dirname(destExtraDb), { recursive: true });
  fs.copyFileSync(srcExtraDb, destExtraDb);
  for (const ext of WAL_SIDECAR_EXTENSIONS) {
    const src = `${srcExtraDb}${ext}`;
    const dest = `${destExtraDb}${ext}`;
    if (fs.existsSync(src)) fs.copyFileSync(src, dest);
    else if (fs.existsSync(dest)) fs.unlinkSync(dest);
  }
}

/**
 * Replace `targetPath` with the contents of `sourcePath` using a same-directory
 * staging file so the operation survives Windows' inability to rename over an
 * existing file in some cases.
 */
export function atomicReplaceFile(targetPath, sourcePath) {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const staging = path.join(
    dir,
    `.djlinker-staging-${crypto.randomBytes(8).toString('hex')}-${path.basename(targetPath)}`
  );
  fs.copyFileSync(sourcePath, staging);
  try {
    if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
  } catch {
    /* best effort */
  }
  fs.renameSync(staging, targetPath);
}

/**
 * Remove stale WAL/SHM next to a main DB file (required after replacing extra.db).
 */
export function removeSqliteSidecars(mainDbPath) {
  for (const ext of WAL_SIDECAR_EXTENSIONS) {
    const p = `${mainDbPath}${ext}`;
    if (fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Copy an existing file to a backup path beside it and into mirrorDir (flat names).
 * @returns {{ sideBySidePath: string, mirrorPath: string } | null} null if source did not exist
 */
export function backupFileFlat(sourcePath, { stamp, mirrorDir }) {
  if (!fs.existsSync(sourcePath)) return null;
  const base = path.basename(sourcePath);
  const sideBySidePath = `${sourcePath}.backup-${stamp}`;
  fs.copyFileSync(sourcePath, sideBySidePath);
  fs.mkdirSync(mirrorDir, { recursive: true });
  const mirrorPath = path.join(mirrorDir, base);
  fs.copyFileSync(sourcePath, mirrorPath);
  return { sideBySidePath, mirrorPath };
}

/**
 * Backup extra.db + sidecars and database.xml into mirrorDir; side-by-side only for main files.
 */
export function backupVdjCloneTargets(files, { stamp, mirrorDir }) {
  const backups = { mirrorDir, entries: [] };
  const { extraDb, databaseXml } = files;

  fs.mkdirSync(mirrorDir, { recursive: true });

  for (const ext of ['', ...WAL_SIDECAR_EXTENSIONS]) {
    const p = ext ? `${extraDb}${ext}` : extraDb;
    if (!fs.existsSync(p)) continue;
    const sideBySidePath = `${p}.backup-${stamp}`;
    fs.copyFileSync(p, sideBySidePath);
    const mirrorPath = path.join(mirrorDir, path.basename(p));
    fs.copyFileSync(p, mirrorPath);
    backups.entries.push({ original: p, sideBySidePath, mirrorPath });
  }

  if (fs.existsSync(databaseXml)) {
    const sideBySidePath = `${databaseXml}.backup-${stamp}`;
    fs.copyFileSync(databaseXml, sideBySidePath);
    const mirrorPath = path.join(mirrorDir, path.basename(databaseXml));
    fs.copyFileSync(databaseXml, mirrorPath);
    backups.entries.push({ original: databaseXml, sideBySidePath, mirrorPath });
  }

  return backups;
}

/**
 * Rename Cache to Cache.backup-<stamp> if it exists.
 */
export function renameCacheForBackup(cacheDir, stamp) {
  if (!fs.existsSync(cacheDir)) return null;
  const dest = `${cacheDir}.backup-${stamp}`;
  if (fs.existsSync(dest)) {
    throw new Error(`Backup cache path already exists: ${dest}`);
  }
  fs.renameSync(cacheDir, dest);
  return dest;
}

export function copyDirectoryRecursive(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  fs.cpSync(srcDir, destDir, { recursive: true, errorOnExist: false });
}

/**
 * Generic aliases — the underlying functions are already directory-agnostic;
 * exposing them under directory-neutral names lets us reuse the same backup
 * and fingerprint primitives for History/ (and any future folder) without
 * baking "Cache" into call sites where it doesn't belong.
 */
export const renameDirectoryForBackup = renameCacheForBackup;
export const sha256DirectoryAggregate = sha256CacheDirectoryAggregate;
