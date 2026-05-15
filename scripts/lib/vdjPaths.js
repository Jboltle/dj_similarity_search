/**
 * Single source of truth for the VirtualDJ application data folder.
 * Used by parsers, merge, clone, and related readers.
 */
import os from 'node:os';
import path from 'node:path';

/**
 * @param {string | null | undefined} explicit Absolute path to the VDJ folder, or null to resolve automatically.
 * @returns {string}
 */
export function resolveVdjFolder(explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.VDJ_FOLDER) return path.resolve(process.env.VDJ_FOLDER);
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
