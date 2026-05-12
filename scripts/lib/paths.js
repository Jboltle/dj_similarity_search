import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { loadProjectEnv } from './env.js';

loadProjectEnv();

function shouldSkipWindowsUserDir(name) {
  return (
    name === 'Public' ||
    name === 'All Users' ||
    name === 'Default' ||
    name === 'Default User' ||
    name === 'desktop.ini'
  );
}

function profileHasVirtualDjData(profileRoot) {
  const roots = [
    path.join(profileRoot, 'Documents', 'VirtualDJ'),
    path.join(profileRoot, 'AppData', 'Local', 'VirtualDJ'),
  ];
  for (const root of roots) {
    if (fs.existsSync(path.join(root, 'database.xml'))) return true;
    if (fs.existsSync(path.join(root, 'extra.db'))) return true;
    if (fs.existsSync(path.join(root, 'History'))) return true;
  }
  return false;
}

/**
 * When VirtualDJ lives on the Windows side (WSL), pick the Windows profile
 * directory (e.g. /mnt/c/Users/Jon) that actually has VirtualDJ data under
 * Documents/VirtualDJ or AppData/Local/VirtualDJ. Prefer the Windows user
 * whose login matches the current POSIX username.
 */
function wslWindowsUserProfileDir() {
  const usersDir = '/mnt/c/Users';
  if (!fs.existsSync(usersDir)) return null;
  const uname = os.userInfo().username;
  const preferred = path.join(usersDir, uname);
  if (profileHasVirtualDjData(preferred)) return preferred;

  let entries;
  try {
    entries = fs.readdirSync(usersDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const ent of entries) {
    if (!ent.isDirectory() || shouldSkipWindowsUserDir(ent.name)) continue;
    const profileRoot = path.join(usersDir, ent.name);
    if (profileHasVirtualDjData(profileRoot)) return profileRoot;
  }
  return null;
}

/**
 * VirtualDJ data directories to probe for database.xml, extra.db, History, etc.
 * (Modern Windows installs often use %LOCALAPPDATA%\\VirtualDJ instead of Documents.)
 */
export function listDefaultVirtualDjDirs() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [path.join(home, 'Documents', 'VirtualDJ'), path.join(local, 'VirtualDJ')];
  }
  if (process.platform === 'darwin') {
    return [path.join(home, 'Library', 'Application Support', 'VirtualDJ')];
  }
  const dirs = [path.join(home, 'Documents', 'VirtualDJ')];
  const wslProfile = wslWindowsUserProfileDir();
  if (wslProfile) {
    dirs.push(path.join(wslProfile, 'Documents', 'VirtualDJ'));
    dirs.push(path.join(wslProfile, 'AppData', 'Local', 'VirtualDJ'));
  }
  return dirs;
}

function resolveUserProfileTemplate() {
  const fromEnv = process.env.USERPROFILE;
  if (fromEnv) return fromEnv.replaceAll('\\', '/').replace(/\/+$/, '');
  if (process.platform === 'win32') return os.homedir().replaceAll('\\', '/').replace(/\/+$/, '');
  const wsl = wslWindowsUserProfileDir();
  if (wsl) return wsl.replace(/\/+$/, '');
  return null;
}

/**
 * Map `C:/...` → `/mnt/c/...` on Linux/WSL when that drive is mounted.
 * Map `/mnt/c/...` → `C:\...` on Windows. No-op if the pattern does not apply.
 */
function normalizeCrossPlatformVdjPath(s) {
  if (!s || typeof s !== 'string') return s;
  const uniform = s.replaceAll('\\', '/');
  if (process.platform === 'win32') {
    const m = /^\/mnt\/([a-z])\/?(.*)$/i.exec(uniform);
    if (!m) return uniform;
    const letter = m[1].toUpperCase();
    const rest = m[2] || '';
    const parts = rest.split('/').filter(Boolean);
    return path.win32.join(`${letter}:`, ...parts);
  }
  const dm = /^([a-z]):\/(.*)$/i.exec(uniform);
  if (!dm) return uniform;
  const mount = `/mnt/${dm[1].toLowerCase()}`;
  if (!fs.existsSync(mount)) return uniform;
  const tail = dm[2].replace(/^\/+/, '');
  return path.posix.join(mount, tail);
}

function resolveLocalAppDataTemplate() {
  if (process.env.LOCALAPPDATA) {
    return process.env.LOCALAPPDATA.replaceAll('\\', '/').replace(/\/+$/, '');
  }
  if (process.platform === 'win32') {
    return path.join(os.homedir(), 'AppData', 'Local').replaceAll('\\', '/').replace(/\/+$/, '');
  }
  const wsl = wslWindowsUserProfileDir();
  if (wsl) return path.join(wsl, 'AppData', 'Local').replaceAll('\\', '/').replace(/\/+$/, '');
  return null;
}

/**
 * Expands `~`, Windows-style `%USERPROFILE%` / `%LOCALAPPDATA%` from .env templates, and normalizes
 * slashes so paths work on POSIX and Windows.
 */
export function expandVdjPath(raw) {
  if (!raw || typeof raw !== 'string') return raw;
  let s = raw.trim().replaceAll('\\', '/');
  if (s.startsWith('~/')) {
    s = path.join(os.homedir(), s.slice(2));
  } else if (s === '~') {
    s = os.homedir();
  }
  if (/%USERPROFILE%/i.test(s)) {
    const resolved = resolveUserProfileTemplate();
    if (!resolved) return null;
    s = s.replace(/%USERPROFILE%/gi, resolved);
  }
  if (/%LOCALAPPDATA%/i.test(s)) {
    const resolved = resolveLocalAppDataTemplate();
    if (!resolved) return null;
    s = s.replace(/%LOCALAPPDATA%/gi, resolved);
  }
  return normalizeCrossPlatformVdjPath(s);
}

export function resolveDatabasePath(explicit) {
  const candidates = [];
  if (explicit) {
    const expanded = expandVdjPath(explicit);
    if (expanded) candidates.push(expanded);
  }
  if (process.env.VDJ_DB_PATH) {
    const expanded = expandVdjPath(process.env.VDJ_DB_PATH);
    if (expanded) candidates.push(expanded);
  }
  for (const dir of listDefaultVirtualDjDirs()) {
    candidates.push(path.join(dir, 'database.xml'));
  }

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Could not locate VirtualDJ database.xml. Tried:\n  - ${candidates.join('\n  - ')}\n` +
      'Set VDJ_DB_PATH or pass --db <path> on the CLI.'
  );
}

export function normalizePath(rawPath) {
  if (!rawPath || typeof rawPath !== 'string') return '';
  return rawPath
    .replaceAll('\\', '/')
    .replace(/\/+/g, '/')
    .trim()
    .toLowerCase();
}

export function basenameOnly(rawPath) {
  if (!rawPath) return '';
  const cleaned = rawPath.replaceAll('\\', '/');
  const idx = cleaned.lastIndexOf('/');
  return (idx >= 0 ? cleaned.slice(idx + 1) : cleaned).trim().toLowerCase();
}

export function isStreamingPath(rawPath) {
  if (!rawPath) return false;
  return /^(netsearch|http|https|spotify|tidal|deezer|youtube|soundcloud):/i.test(rawPath);
}
