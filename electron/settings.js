/**
 * Persistent user settings for the Electron app, stored at
 * `<userData>/settings.json`. Reads and writes are synchronous JSON — the
 * document is tiny, and every call site expects instant results.
 */
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

const SETTINGS_FILENAME = 'settings.json';

/**
 * @typedef {Object} AppSettings
 * @property {string | null} vdjFolder
 * @property {'git' | 'local-folder' | 'none'} syncMode
 * @property {string | null} syncGitRemote
 * @property {string | null} syncLocalFolder
 * @property {string | null} machineId
 * @property {string} colorMode
 * @property {string} linkedFolderName
 * @property {boolean} autoRefreshOnStartup
 * @property {string | null} lastRefreshedAt
 */

/** @returns {AppSettings} */
export function getDefaults() {
  return {
    vdjFolder: null,
    syncMode: 'none',
    syncGitRemote: null,
    syncLocalFolder: null,
    machineId: null,
    colorMode: 'bpm',
    linkedFolderName: 'Linked Tracks',
    autoRefreshOnStartup: true,
    lastRefreshedAt: null,
  };
}

function settingsPath() {
  return path.join(app.getPath('userData'), SETTINGS_FILENAME);
}

/** @returns {AppSettings} */
export function getSettings() {
  const p = settingsPath();
  if (!fs.existsSync(p)) return getDefaults();
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...getDefaults(), ...parsed };
  } catch {
    return getDefaults();
  }
}

/**
 * @param {Partial<AppSettings>} patch
 * @returns {AppSettings}
 */
export function saveSettings(patch) {
  const merged = { ...getSettings(), ...(patch ?? {}) };
  const p = settingsPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(merged, null, 2));
  return merged;
}
