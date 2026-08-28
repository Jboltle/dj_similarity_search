/**
 * Auto-detect standard cloud-sync roots so users can one-click "Use Dropbox
 * for sync" from the Settings drawer.
 *
 * Every backend probe is a pure filesystem lookup — we never make network
 * calls, we never modify anything under the detected folder. The caller
 * (settings UI) is responsible for actually pointing sync at
 * `<detectedPath>/VirtualDJ Link Map/`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();

function statOrNull(p) {
  try { return fs.statSync(p); } catch { return null; }
}

function isDir(p) {
  const s = statOrNull(p);
  return !!s && s.isDirectory();
}

function tryFreeBytes(p) {
  try {
    if (typeof fs.statfsSync !== 'function') return null;
    const st = fs.statfsSync(p);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return null;
  }
}

function pushIfDir(out, provider, candidatePath) {
  if (!candidatePath || !isDir(candidatePath)) return;
  if (out.some((r) => r.path === candidatePath)) return;
  out.push({ provider, path: candidatePath, free: tryFreeBytes(candidatePath) });
}

function probeDropbox(out) {
  pushIfDir(out, 'Dropbox', path.join(HOME, 'Dropbox'));
  pushIfDir(out, 'Dropbox', path.join(HOME, 'Dropbox (Personal)'));
  const infoJson = path.join(HOME, '.dropbox', 'info.json');
  if (fs.existsSync(infoJson)) {
    try {
      const info = JSON.parse(fs.readFileSync(infoJson, 'utf8'));
      for (const key of Object.keys(info ?? {})) {
        const p = info[key]?.path;
        if (p) pushIfDir(out, 'Dropbox', p);
      }
    } catch { /* ignore malformed info.json */ }
  }
}

function probeOneDrive(out) {
  for (const envKey of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
    const val = process.env[envKey];
    if (val) pushIfDir(out, 'OneDrive', val);
  }
  const macCloudRoot = path.join(HOME, 'Library', 'CloudStorage');
  if (isDir(macCloudRoot)) {
    for (const name of fs.readdirSync(macCloudRoot)) {
      if (name.startsWith('OneDrive')) {
        pushIfDir(out, 'OneDrive', path.join(macCloudRoot, name));
      }
    }
  }
}

function probeICloud(out) {
  pushIfDir(out, 'iCloud Drive', path.join(HOME, 'Library', 'Mobile Documents', 'com~apple~CloudDocs'));
  pushIfDir(out, 'iCloud Drive', path.join(HOME, 'iCloudDrive'));
}

function probeGoogleDrive(out) {
  pushIfDir(out, 'Google Drive', path.join(HOME, 'Google Drive'));
  pushIfDir(out, 'Google Drive', path.join(HOME, 'GoogleDrive'));
  const macCloudRoot = path.join(HOME, 'Library', 'CloudStorage');
  if (isDir(macCloudRoot)) {
    for (const name of fs.readdirSync(macCloudRoot)) {
      if (name.startsWith('GoogleDrive')) {
        pushIfDir(out, 'Google Drive', path.join(macCloudRoot, name));
      }
    }
  }
}

/**
 * @returns {Array<{ provider: string, path: string, free: number | null }>}
 */
export function detectCloudFolders() {
  const results = [];
  probeDropbox(results);
  probeOneDrive(results);
  probeICloud(results);
  probeGoogleDrive(results);
  return results;
}
