/**
 * Single source of truth for the VirtualDJ application data folder.
 * Used by parsers, merge, clone, and related readers.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandVdjPath, listDefaultVirtualDjDirs } from './paths.js';

/**
 * @param {string | null | undefined} explicit Absolute path to the VDJ folder, or null to resolve automatically.
 * @returns {string}
 */
export function resolveVdjFolder(explicit) {
  if (explicit) {
    const expanded = expandVdjPath(explicit) ?? explicit;
    return path.resolve(expanded);
  }
  if (process.env.VDJ_FOLDER) {
    const expanded = expandVdjPath(process.env.VDJ_FOLDER) ?? process.env.VDJ_FOLDER;
    return path.resolve(expanded);
  }
  // Reuse the richer cross-platform discovery (Windows %LOCALAPPDATA%,
  // %USERPROFILE%\Documents, /mnt/c/Users/... from WSL, etc.) so that
  // sync:* and clone:* don't both have to require VDJ_FOLDER explicitly.
  for (const dir of listDefaultVirtualDjDirs()) {
    if (fs.existsSync(path.join(dir, 'database.xml')) || fs.existsSync(path.join(dir, 'extra.db'))) {
      return dir;
    }
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'VirtualDJ');
  }
  return path.join(os.homedir(), 'Documents', 'VirtualDJ');
}

/**
 * @param {string} folder Absolute path to the VirtualDJ data folder.
 */
export function vdjFiles(folder) {
  return {
    extraDb: path.join(folder, 'extra.db'),
    databaseXml: path.join(folder, 'database.xml'),
    cacheDir: path.join(folder, 'Cache'),
    historyDir: path.join(folder, 'History'),
  };
}
