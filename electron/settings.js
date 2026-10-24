/**
 * Persistent user settings for the Electron app, stored at
 * `<userData>/settings.json`. Reads and writes are synchronous JSON — the
 * document is tiny, and every call site expects instant results.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { app } = require('electron');

const SETTINGS_FILENAME = 'settings.json';

/**
 * @typedef {Object} SelectionRules
 * @property {string[]} [includeFolders]
 * @property {string[]} [excludeFolders]
 * @property {string[]} [playlistWhitelist]
 * @property {number | null} [onlyModifiedSince]
 * @property {boolean} [excludeStreaming]
 */

/**
 * @typedef {Object} AudioLibrarySettings
 * @property {string | null} root                 Absolute path to the shared audio library folder (ideally inside a cloud mount like Google Drive).
 * @property {boolean} includeLinkedPairs         If true, scope includes every file that participates in a related_tracks pair.
 * @property {boolean} includeRecentSessions      If true, scope also includes files played in the last N sessions.
 * @property {number} recentSessionsCount         N value when includeRecentSessions is enabled.
 * @property {boolean} autoAddDiscovered          If true, newly-discovered files in root are added to database.xml automatically on scan.
 */

/**
 * @typedef {Object} AppSettings
 * @property {string | null} vdjFolder
 * @property {'git' | 'local-folder' | 'none'} syncMode
 * @property {string | null} syncGitRemote
 * @property {string | null} syncLocalFolder
 * @property {string | null} machineId          Legacy hint ('mac' | 'windows'); superseded by machineUuid.
 * @property {string} machineUuid                Stable per-install UUID. Generated once on first run.
 * @property {string} machineDisplayName         Friendly label ("Studio iMac"). Defaults to hostname.
 * @property {string} colorMode
 * @property {string} linkedFolderName
 * @property {boolean} autoRefreshOnStartup
 * @property {string | null} lastRefreshedAt
 * @property {{push: SelectionRules, pull: SelectionRules}} syncSelection
 * @property {AudioLibrarySettings} audioLibrary
 */

const DEFAULT_RECENT_SESSIONS_COUNT = 5;

/** @returns {AudioLibrarySettings} */
export function getDefaultAudioLibrary() {
  return {
    root: null,
    includeLinkedPairs: true,
    includeRecentSessions: true,
    recentSessionsCount: DEFAULT_RECENT_SESSIONS_COUNT,
    autoAddDiscovered: false,
  };
}

/** @returns {AppSettings} */
export function getDefaults() {
  return {
    vdjFolder: null,
    syncMode: 'none',
    syncGitRemote: null,
    syncLocalFolder: null,
    machineId: null,
    machineUuid: '',
    machineDisplayName: '',
    colorMode: 'bpm',
    linkedFolderName: 'Linked Tracks',
    autoRefreshOnStartup: true,
    lastRefreshedAt: null,
    syncSelection: {
      push: {},
      pull: {},
    },
    audioLibrary: getDefaultAudioLibrary(),
  };
}

function settingsPath() {
  return path.join(app.getPath('userData'), SETTINGS_FILENAME);
}

function readRawSettings() {
  const p = settingsPath();
  if (!fs.existsSync(p)) return {};
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw) ?? {};
  } catch {
    return {};
  }
}

function writeRawSettings(obj) {
  const p = settingsPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

/**
 * Populate machineUuid / machineDisplayName the first time they're read.
 * We do this lazily on getSettings so a fresh install auto-provisions its
 * identity before the first sync-push, without needing an explicit "init"
 * IPC round trip from the renderer.
 */
function ensureMachineIdentity(current) {
  const defaults = getDefaults();
  const merged = { ...defaults, ...current };
  let mutated = false;

  if (!merged.machineUuid || typeof merged.machineUuid !== 'string') {
    merged.machineUuid = crypto.randomUUID();
    mutated = true;
  }
  if (!merged.machineDisplayName || typeof merged.machineDisplayName !== 'string') {
    let host = '';
    try { host = os.hostname(); } catch { host = ''; }
    merged.machineDisplayName = host || 'This machine';
    mutated = true;
  }
  if (!merged.syncSelection || typeof merged.syncSelection !== 'object') {
    merged.syncSelection = { push: {}, pull: {} };
    mutated = true;
  } else {
    if (!merged.syncSelection.push || typeof merged.syncSelection.push !== 'object') {
      merged.syncSelection.push = {};
      mutated = true;
    }
    if (!merged.syncSelection.pull || typeof merged.syncSelection.pull !== 'object') {
      merged.syncSelection.pull = {};
      mutated = true;
    }
  }

  if (!merged.audioLibrary || typeof merged.audioLibrary !== 'object') {
    merged.audioLibrary = getDefaultAudioLibrary();
    mutated = true;
  } else {
    const audioDefaults = getDefaultAudioLibrary();
    for (const key of Object.keys(audioDefaults)) {
      if (merged.audioLibrary[key] === undefined) {
        merged.audioLibrary[key] = audioDefaults[key];
        mutated = true;
      }
    }
  }

  if (mutated) writeRawSettings(merged);
  return merged;
}

/** @returns {AppSettings} */
export function getSettings() {
  return ensureMachineIdentity(readRawSettings());
}

/**
 * @param {Partial<AppSettings>} patch
 * @returns {AppSettings}
 */
export function saveSettings(patch) {
  const current = getSettings();
  const merged = { ...current, ...(patch ?? {}) };
  writeRawSettings(merged);
  return merged;
}
