/**
 * User-authored conflict resolution overrides for song merges.
 *
 * Persisted as a flat JSON map keyed by (normalized) FilePath at
 * `<userData>/sync-resolutions.json`. The file lives outside the sync repo
 * so different users on the same shared library can choose independently.
 *
 * Load-only from CLI/scripts (which don't have `app.getPath('userData')`);
 * Electron writes via IPC. When the file is missing or malformed we return
 * an empty map so callers can pass the result into
 * `mergeDatabaseRoots({ resolutions })` unconditionally.
 */
import fs from 'node:fs';
import path from 'node:path';

const FILENAME = 'sync-resolutions.json';

export function resolutionsFilePath(userDataDir) {
  if (!userDataDir) return null;
  return path.join(userDataDir, FILENAME);
}

/**
 * @param {string | null} filePath Absolute path to sync-resolutions.json,
 *                                 or null (returns empty map).
 * @returns {Record<string, 'local' | 'remote' | string>}
 */
export function loadResolutions(filePath) {
  if (!filePath) return {};
  if (!fs.existsSync(filePath)) return {};
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed;
  } catch {
    return {};
  }
}

export function saveResolutions(filePath, map) {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(map ?? {}, null, 2));
}

/**
 * @param {Record<string, string>} map
 * @param {string} songFilePath
 * @param {'local' | 'remote' | 'unset' | string} choice
 * @returns {Record<string, string>}
 */
export function applyResolution(map, songFilePath, choice) {
  const out = { ...(map ?? {}) };
  const key = String(songFilePath ?? '').trim();
  if (!key) return out;
  if (!choice || choice === 'unset') {
    delete out[key];
  } else {
    out[key] = choice;
  }
  return out;
}
