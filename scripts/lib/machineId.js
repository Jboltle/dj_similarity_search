/**
 * Map the current OS (or an explicit override) onto one of the two committed
 * per-machine folders under sync/. Keeping this in one place avoids every
 * script having to re-derive "am I the Mac or the Windows side?".
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SYNC_MACHINE_IDS = Object.freeze(['mac', 'windows']);

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SYNC_ROOT = path.join(PROJECT_ROOT, 'sync');

/**
 * @param {string | null | undefined} explicit One of 'mac' | 'windows', or null/undefined to auto-detect.
 * @returns {'mac' | 'windows'}
 */
export function resolveMachineId(explicit) {
  if (explicit) {
    const normalized = String(explicit).trim().toLowerCase();
    if (!SYNC_MACHINE_IDS.includes(normalized)) {
      throw new Error(
        `Unknown machine id: ${explicit}. Expected one of: ${SYNC_MACHINE_IDS.join(', ')}.`
      );
    }
    return normalized;
  }
  if (process.platform === 'darwin') return 'mac';
  // Both native Windows AND WSL-with-VirtualDJ-on-Windows go into sync/windows/.
  return 'windows';
}

/**
 * @param {'mac' | 'windows'} machineId
 * @returns {string}
 */
export function syncMachineDir(machineId) {
  return path.join(SYNC_ROOT, machineId);
}

export function syncMergedDir() {
  return path.join(SYNC_ROOT, 'merged');
}

export function syncRoot() {
  return SYNC_ROOT;
}

export function projectRoot() {
  return PROJECT_ROOT;
}

/**
 * Standard layout for any sync folder (per-machine or merged). Mirrors
 * scripts/lib/vdjPaths.js vdjFiles() so the rest of the pipeline can pretend
 * a sync folder is just another VDJ folder.
 */
export function syncFolderFiles(dir) {
  return {
    extraDb: path.join(dir, 'extra.db'),
    databaseXml: path.join(dir, 'database.xml'),
    historyDir: path.join(dir, 'History'),
    manifest: path.join(dir, 'manifest.json'),
  };
}

/**
 * The id of the "other" side, used by the merge to know what counts as
 * "remote" when reporting conflict resolution.
 */
export function otherMachineId(machineId) {
  return machineId === 'mac' ? 'windows' : 'mac';
}
