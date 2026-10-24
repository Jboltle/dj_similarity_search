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
const DRIVE_LETTERS = 'cdefghijklmnopqrstuvwxyz'.split('');

function statOrNull(p) {
  try { return fs.statSync(p); } catch { return null; }
}

function isDir(p) {
  const s = statOrNull(p);
  return !!s && s.isDirectory();
}

/** True if we're running inside WSL (Linux kernel + WSL env vars). */
function isWsl() {
  return (
    process.platform === 'linux' &&
    (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP)
  );
}

/**
 * Candidate Windows user-profile directories reachable from this process.
 *  - Native Windows: process.env.USERPROFILE
 *  - WSL: /mnt/c/Users/<name> for every real user directory
 */
function windowsHomeCandidates() {
  const homes = [];
  if (process.platform === 'win32' && process.env.USERPROFILE) {
    homes.push(process.env.USERPROFILE);
  }
  if (isWsl()) {
    const usersDir = '/mnt/c/Users';
    if (isDir(usersDir)) {
      for (const name of fs.readdirSync(usersDir)) {
        if (name === 'Public' || name === 'Default' || name.startsWith('.')) continue;
        const abs = path.join(usersDir, name);
        if (isDir(abs)) homes.push(abs);
      }
    }
  }
  return homes;
}

/**
 * All reachable drive roots this process can see. On native Windows that's
 * `C:\`, `D:\`, … ; on WSL that's `/mnt/c`, `/mnt/d`, … .
 */
function windowsDriveRoots() {
  const roots = [];
  if (process.platform === 'win32') {
    for (const letter of DRIVE_LETTERS) {
      const root = `${letter.toUpperCase()}:\\`;
      if (isDir(root)) roots.push(root);
    }
  }
  if (isWsl()) {
    for (const letter of DRIVE_LETTERS) {
      const root = `/mnt/${letter}`;
      if (isDir(root)) roots.push(root);
    }
  }
  return roots;
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
  for (const winHome of windowsHomeCandidates()) {
    pushIfDir(out, 'Dropbox', path.join(winHome, 'Dropbox'));
    pushIfDir(out, 'Dropbox', path.join(winHome, 'Dropbox (Personal)'));
  }
  const infoJsonCandidates = [path.join(HOME, '.dropbox', 'info.json')];
  for (const winHome of windowsHomeCandidates()) {
    infoJsonCandidates.push(path.join(winHome, 'AppData', 'Local', 'Dropbox', 'info.json'));
    infoJsonCandidates.push(path.join(winHome, 'AppData', 'Roaming', 'Dropbox', 'info.json'));
  }
  for (const infoJson of infoJsonCandidates) {
    if (!fs.existsSync(infoJson)) continue;
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
  // Windows / WSL: OneDrive lives under the user profile with provider suffix.
  for (const winHome of windowsHomeCandidates()) {
    const entries = statOrNull(winHome)?.isDirectory() ? fs.readdirSync(winHome) : [];
    for (const name of entries) {
      if (/^OneDrive(\s|$|-)/i.test(name)) {
        pushIfDir(out, 'OneDrive', path.join(winHome, name));
      }
    }
  }
}

function probeICloud(out) {
  pushIfDir(out, 'iCloud Drive', path.join(HOME, 'Library', 'Mobile Documents', 'com~apple~CloudDocs'));
  pushIfDir(out, 'iCloud Drive', path.join(HOME, 'iCloudDrive'));
  // Windows iCloud for Windows installs here.
  for (const winHome of windowsHomeCandidates()) {
    pushIfDir(out, 'iCloud Drive', path.join(winHome, 'iCloudDrive'));
    pushIfDir(out, 'iCloud Drive', path.join(winHome, 'iCloud Drive'));
  }
}

function probeGoogleDrive(out) {
  // Linux user installs and some custom Windows setups.
  pushIfDir(out, 'Google Drive', path.join(HOME, 'Google Drive'));
  pushIfDir(out, 'Google Drive', path.join(HOME, 'GoogleDrive'));
  pushIfDir(out, 'Google Drive', path.join(HOME, 'My Drive'));

  // macOS: Drive-for-desktop mounts under Library/CloudStorage.
  const macCloudRoot = path.join(HOME, 'Library', 'CloudStorage');
  if (isDir(macCloudRoot)) {
    for (const name of fs.readdirSync(macCloudRoot)) {
      if (name.startsWith('GoogleDrive')) {
        pushIfDir(out, 'Google Drive', path.join(macCloudRoot, name));
      }
    }
  }

  // Windows (native and via WSL): Drive mounts a virtual letter whose root
  // contains "My Drive\" and "Shared drives\". Users can pick the letter, so
  // scan every reachable drive root and look for those well-known subfolders.
  for (const driveRoot of windowsDriveRoots()) {
    const myDrive = path.join(driveRoot, 'My Drive');
    const shared = path.join(driveRoot, 'Shared drives');
    if (isDir(myDrive)) pushIfDir(out, 'Google Drive', myDrive);
    if (isDir(shared)) pushIfDir(out, 'Google Drive', shared);
  }

  // Some installs put a "My Drive" shortcut directly in the user profile.
  for (const winHome of windowsHomeCandidates()) {
    pushIfDir(out, 'Google Drive', path.join(winHome, 'My Drive'));
    pushIfDir(out, 'Google Drive', path.join(winHome, 'Google Drive'));
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
