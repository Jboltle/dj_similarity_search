/**
 * Shared Audio Library — scans a user-chosen folder (ideally inside a cloud
 * mount like Google Drive) for audio files, and emits a portable
 * machine-agnostic index.
 *
 * Design contract:
 *   - Entries use POSIX-style RELATIVE paths rooted at `audioLibraryRoot`.
 *     That way the same index resolves against `G:\My Drive\DJ Library\` on
 *     Windows and `~/Library/CloudStorage/GoogleDrive-…/My Drive/DJ Library/`
 *     on macOS.
 *   - We never read audio contents; mtime + bytes are the only identity.
 *   - We never move or rewrite files on disk — this module is read-only.
 */
import fs from 'node:fs';
import path from 'node:path';

const AUDIO_EXTENSIONS = Object.freeze([
  '.mp3',
  '.m4a',
  '.aac',
  '.wav',
  '.aif',
  '.aiff',
  '.flac',
  '.ogg',
  '.opus',
  '.wma',
]);

const AUDIO_EXTENSION_SET = new Set(AUDIO_EXTENSIONS);

const SKIP_DIR_NAMES = new Set([
  '.git',
  '.DS_Store',
  'node_modules',
  '__MACOSX',
  '.Trash',
  'System Volume Information',
  '$RECYCLE.BIN',
  '.tmp.drivedownload',
]);

const MAX_RECURSION_DEPTH = 32;

/**
 * @typedef {Object} AudioLibraryEntry
 * @property {string} relativePath   POSIX-relative path from the library root.
 * @property {number} bytes
 * @property {number} mtime          Milliseconds since epoch (fs.Stats.mtimeMs).
 */

/**
 * @typedef {Object} AudioLibraryScanResult
 * @property {string} root           The resolved absolute root we scanned.
 * @property {boolean} rootExists    False if the user picked a path that no longer resolves.
 * @property {AudioLibraryEntry[]} entries
 * @property {number} skippedDirs
 * @property {number} skippedFiles   Non-audio files we ignored.
 * @property {string[]} errors       Non-fatal read errors (permission denied, broken symlinks).
 */

function toPosixRelative(rootAbs, abs) {
  const rel = path.relative(rootAbs, abs);
  return rel.split(path.sep).join('/');
}

function isAudioFile(name) {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return AUDIO_EXTENSION_SET.has(name.slice(dot).toLowerCase());
}

/**
 * Recursively walks a directory tree, collecting audio files.
 * Does NOT follow symbolic links to avoid loops across cloud mounts.
 *
 * @param {string} root  Absolute path to scan.
 * @returns {AudioLibraryScanResult}
 */
export function scanAudioLibrary(root) {
  const result = {
    root: root ? path.resolve(root) : '',
    rootExists: false,
    entries: [],
    skippedDirs: 0,
    skippedFiles: 0,
    errors: [],
  };

  if (!result.root) return result;
  try {
    const st = fs.statSync(result.root);
    if (!st.isDirectory()) return result;
    result.rootExists = true;
  } catch {
    return result;
  }

  const stack = [{ abs: result.root, depth: 0 }];
  while (stack.length > 0) {
    const { abs, depth } = stack.pop();
    if (depth > MAX_RECURSION_DEPTH) {
      result.skippedDirs += 1;
      continue;
    }

    let dirents;
    try {
      dirents = fs.readdirSync(abs, { withFileTypes: true });
    } catch (err) {
      result.errors.push(`${abs}: ${err.code ?? err.message}`);
      continue;
    }

    for (const ent of dirents) {
      if (SKIP_DIR_NAMES.has(ent.name)) {
        if (ent.isDirectory()) result.skippedDirs += 1;
        continue;
      }
      const childAbs = path.join(abs, ent.name);
      if (ent.isSymbolicLink()) {
        result.skippedFiles += 1;
        continue;
      }
      if (ent.isDirectory()) {
        stack.push({ abs: childAbs, depth: depth + 1 });
        continue;
      }
      if (!ent.isFile()) continue;
      if (!isAudioFile(ent.name)) {
        result.skippedFiles += 1;
        continue;
      }
      let stat;
      try {
        stat = fs.statSync(childAbs);
      } catch (err) {
        result.errors.push(`${childAbs}: ${err.code ?? err.message}`);
        continue;
      }
      result.entries.push({
        relativePath: toPosixRelative(result.root, childAbs),
        bytes: Number(stat.size) || 0,
        mtime: Math.round(Number(stat.mtimeMs) || 0),
      });
    }
  }

  result.entries.sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath, undefined, { sensitivity: 'base' })
  );
  return result;
}

/**
 * Build a sync-ready index envelope keyed by this machine's library root.
 * The resulting object is written to `sync/machines/<id>/audio-library-index.json`
 * on push and merged on pull.
 */
export function buildIndexEnvelope({ machineUuid, machineDisplayName, root, entries }) {
  return {
    version: 1,
    machineUuid: machineUuid || null,
    machineDisplayName: machineDisplayName || null,
    root: root || null,
    generatedAt: new Date().toISOString(),
    count: entries.length,
    totalBytes: entries.reduce((acc, e) => acc + (e.bytes || 0), 0),
    entries,
  };
}

/**
 * Resolve a POSIX relative path from the shared index to this machine's
 * absolute path.
 */
export function resolveLocalPath(audioLibraryRoot, relativePath) {
  if (!audioLibraryRoot) return null;
  const normalized = String(relativePath || '').replace(/\\/g, '/');
  if (!normalized) return null;
  const parts = normalized.split('/').filter(Boolean);
  return path.join(audioLibraryRoot, ...parts);
}

export { AUDIO_EXTENSIONS };
