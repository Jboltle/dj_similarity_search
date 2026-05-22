/**
 * First-class backup + restore primitives shared by every sync write command.
 *
 * Every destructive operation (`sync:pull --write`, `sync:push` overwriting
 * the previous sync/<machine>/ contents) goes through this module so we have
 * one consistent layout, manifest, retention policy, and rollback path.
 *
 * Layout produced by `backupVdjFolder` (default location: public/backups/):
 *
 *   public/backups/sync-pull-<stamp>/
 *     manifest.json          # what was backed up + sha256 fingerprints
 *     database.xml
 *     extra.db
 *     extra.db-wal           # only if present at backup time
 *     extra.db-shm           # only if present at backup time
 *     History/               # recursive copy
 *
 * Companion side-by-side `.backup-<stamp>` files are also dropped next to
 * the original `database.xml` and `extra.db`, matching the existing pattern
 * in scripts/lib/extraDbWriter.js and scripts/lib/vdjClone.js so previous
 * habits keep working.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { vdjFiles } from './vdjPaths.js';
import { projectRoot } from './machineId.js';

const BACKUP_DEFAULT_ROOT = path.join(projectRoot(), 'public', 'backups');
export const BACKUP_MANIFEST_FILENAME = 'manifest.json';
const WAL_SIDECAR_EXTENSIONS = ['-wal', '-shm'];

export const BACKUP_KIND = Object.freeze({
  PULL: 'sync-pull',
  PUSH: 'sync-push',
  RESTORE: 'sync-restore',
});

export function timestampStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function sha256FileSync(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function copyDirectoryRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(src, dest, { recursive: true, errorOnExist: false });
}

function ensureBackupRoot(rootOverride) {
  const root = rootOverride ? path.resolve(rootOverride) : BACKUP_DEFAULT_ROOT;
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/**
 * Snapshot the local VirtualDJ folder before a write.
 *
 * Always writes:
 *   - <backupRoot>/<kind>-<stamp>/manifest.json + copies
 *   - <vdjFolder>/database.xml.backup-<stamp>
 *   - <vdjFolder>/extra.db.backup-<stamp> (+ sidecars)
 *
 * @param {{
 *   vdjFolder: string,
 *   kind?: string,
 *   stamp?: string,
 *   backupRoot?: string,
 *   includeHistory?: boolean,
 *   note?: string,
 * }} args
 */
export function backupVdjFolder({
  vdjFolder,
  kind = BACKUP_KIND.PULL,
  stamp = timestampStamp(),
  backupRoot,
  includeHistory = true,
  note = null,
}) {
  const files = vdjFiles(vdjFolder);
  const root = ensureBackupRoot(backupRoot);
  const folderName = `${kind}-${stamp}`;
  const folder = path.join(root, folderName);
  fs.mkdirSync(folder, { recursive: true });

  const fileEntries = {};

  if (fs.existsSync(files.databaseXml)) {
    const dest = path.join(folder, 'database.xml');
    fs.copyFileSync(files.databaseXml, dest);
    fs.copyFileSync(files.databaseXml, `${files.databaseXml}.backup-${stamp}`);
    fileEntries['database.xml'] = {
      bytes: fs.statSync(dest).size,
      sha256: sha256FileSync(dest),
      sideBySide: `${files.databaseXml}.backup-${stamp}`,
    };
  }

  if (fs.existsSync(files.extraDb)) {
    const dest = path.join(folder, 'extra.db');
    fs.copyFileSync(files.extraDb, dest);
    fs.copyFileSync(files.extraDb, `${files.extraDb}.backup-${stamp}`);
    fileEntries['extra.db'] = {
      bytes: fs.statSync(dest).size,
      sha256: sha256FileSync(dest),
      sideBySide: `${files.extraDb}.backup-${stamp}`,
    };
    for (const ext of WAL_SIDECAR_EXTENSIONS) {
      const sidecar = `${files.extraDb}${ext}`;
      if (!fs.existsSync(sidecar)) continue;
      const sidecarDest = path.join(folder, `extra.db${ext}`);
      fs.copyFileSync(sidecar, sidecarDest);
      fs.copyFileSync(sidecar, `${sidecar}.backup-${stamp}`);
      fileEntries[`extra.db${ext}`] = {
        bytes: fs.statSync(sidecarDest).size,
        sha256: sha256FileSync(sidecarDest),
        sideBySide: `${sidecar}.backup-${stamp}`,
      };
    }
  }

  let historyEntry = null;
  if (includeHistory && fs.existsSync(files.historyDir)) {
    const dest = path.join(folder, 'History');
    copyDirectoryRecursive(files.historyDir, dest);
    historyEntry = {
      sourceDir: files.historyDir,
      fingerprint: sha256DirectoryAggregate(dest),
    };
  }

  const manifest = {
    kind,
    stamp,
    createdAt: new Date().toISOString(),
    vdjFolder,
    files: fileEntries,
    history: historyEntry,
    note,
  };
  fs.writeFileSync(path.join(folder, BACKUP_MANIFEST_FILENAME), JSON.stringify(manifest, null, 2));

  return { folder, stamp, manifest };
}

/**
 * Snapshot a sync/* folder (per-machine raw inputs or the merged output)
 * before overwriting it from sync:push. Lightweight — just a recursive copy
 * with a manifest of what's inside.
 */
export function backupSyncSubfolder({
  syncSubfolder,
  label,
  kind = BACKUP_KIND.PUSH,
  stamp = timestampStamp(),
  backupRoot,
  note = null,
}) {
  if (!fs.existsSync(syncSubfolder)) return null;
  const root = ensureBackupRoot(backupRoot);
  const folder = path.join(root, `${kind}-${label}-${stamp}`);
  copyDirectoryRecursive(syncSubfolder, folder);
  const manifest = {
    kind,
    label,
    stamp,
    createdAt: new Date().toISOString(),
    sourceSyncFolder: syncSubfolder,
    fingerprint: sha256DirectoryAggregate(folder),
    note,
  };
  fs.writeFileSync(path.join(folder, BACKUP_MANIFEST_FILENAME), JSON.stringify(manifest, null, 2));
  return { folder, stamp, manifest };
}

function sha256DirectoryAggregate(rootDir) {
  if (!fs.existsSync(rootDir)) return null;
  const rels = [];
  const stack = [rootDir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
      } else {
        rels.push(`${path.relative(rootDir, full).split(path.sep).join('/')}\0${sha256FileSync(full)}`);
      }
    }
  }
  rels.sort();
  return crypto.createHash('sha256').update(rels.join('\n')).digest('hex');
}

/**
 * Auto-prune oldest backups in the default root, keeping the newest `keep`.
 * Side-by-side `.backup-<stamp>` files next to VDJ originals are NOT pruned
 * by this — they're cheap and live with the user's data.
 */
export function pruneOldBackups({ backupRoot, keep, kindPrefixes } = {}) {
  if (keep == null || !Number.isFinite(keep) || keep < 0) return { pruned: [] };
  const root = backupRoot ? path.resolve(backupRoot) : BACKUP_DEFAULT_ROOT;
  if (!fs.existsSync(root)) return { pruned: [] };
  const prefixes = kindPrefixes ?? Object.values(BACKUP_KIND);

  const byKind = new Map();
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const matched = prefixes.find((p) => ent.name.startsWith(`${p}-`));
    if (!matched) continue;
    const arr = byKind.get(matched) ?? [];
    arr.push(ent.name);
    byKind.set(matched, arr);
  }

  const pruned = [];
  for (const [, names] of byKind) {
    names.sort(); // ISO-style stamps sort chronologically
    const surplus = Math.max(0, names.length - keep);
    for (let i = 0; i < surplus; i += 1) {
      const dir = path.join(root, names[i]);
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        pruned.push(dir);
      } catch {
        /* best effort */
      }
    }
  }
  return { pruned };
}

/**
 * Discover available backups so the restore command can show a menu and
 * validate the requested stamp.
 */
export function listBackups({ backupRoot } = {}) {
  const root = backupRoot ? path.resolve(backupRoot) : BACKUP_DEFAULT_ROOT;
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const manifestPath = path.join(root, ent.name, BACKUP_MANIFEST_FILENAME);
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      out.push({ name: ent.name, folder: path.join(root, ent.name), manifest });
    } catch {
      /* skip malformed */
    }
  }
  out.sort((a, b) => (a.name < b.name ? -1 : 1));
  return out;
}

/**
 * Restore a previously captured backup folder back onto a VDJ folder.
 * Validates SHA-256s before touching anything, then copies file by file.
 *
 * @param {{ backupFolder: string, vdjFolder: string, write?: boolean, includeHistory?: boolean }} args
 */
export function restoreBackup({ backupFolder, vdjFolder, write = false, includeHistory = true }) {
  const manifestPath = path.join(backupFolder, BACKUP_MANIFEST_FILENAME);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`No ${BACKUP_MANIFEST_FILENAME} in ${backupFolder}.`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const files = vdjFiles(vdjFolder);

  for (const [name, meta] of Object.entries(manifest.files ?? {})) {
    const abs = path.join(backupFolder, name);
    if (!fs.existsSync(abs)) throw new Error(`Backup missing ${name} in ${backupFolder}`);
    const stat = fs.statSync(abs);
    if (stat.size !== meta.bytes) {
      throw new Error(`Backup size mismatch for ${name}: manifest=${meta.bytes} disk=${stat.size}`);
    }
    if (sha256FileSync(abs) !== meta.sha256) {
      throw new Error(`Backup sha256 mismatch for ${name} — backup folder is corrupt.`);
    }
  }

  if (!write) {
    return { dryRun: true, manifest, backupFolder, vdjFolder };
  }

  const targetByName = {
    'database.xml': files.databaseXml,
    'extra.db': files.extraDb,
    'extra.db-wal': `${files.extraDb}-wal`,
    'extra.db-shm': `${files.extraDb}-shm`,
  };

  for (const name of Object.keys(manifest.files ?? {})) {
    const target = targetByName[name];
    if (!target) continue;
    const src = path.join(backupFolder, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(src, target);
  }

  for (const ext of WAL_SIDECAR_EXTENSIONS) {
    const sidecar = `${files.extraDb}${ext}`;
    if (!(`extra.db${ext}` in (manifest.files ?? {})) && fs.existsSync(sidecar)) {
      try {
        fs.unlinkSync(sidecar);
      } catch {
        /* ignore */
      }
    }
  }

  if (includeHistory && manifest.history && fs.existsSync(path.join(backupFolder, 'History'))) {
    if (fs.existsSync(files.historyDir)) {
      fs.rmSync(files.historyDir, { recursive: true, force: true });
    }
    copyDirectoryRecursive(path.join(backupFolder, 'History'), files.historyDir);
  }

  return { dryRun: false, manifest, backupFolder, vdjFolder };
}

export const _internals = { sha256DirectoryAggregate, sha256FileSync };
