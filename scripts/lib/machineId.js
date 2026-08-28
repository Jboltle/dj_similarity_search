/**
 * Machine identity + sync layout resolution.
 *
 * v2 layout: sync/machines/<machineId>/ + sync/merged/. `machineId` is any
 * stable string — a UUID from Electron settings, a legacy label ('mac' /
 * 'windows'), or a user-supplied name via CLI --as. The old two-machine
 * hardcoded layout is preserved by the migration in electron/main.js, which
 * renames sync/mac/ -> sync/machines/mac/ (and windows).
 *
 * CLI-standalone invocations fall back to a platform-derived label so
 * pre-v2 usage keeps working.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT_DEFAULT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SYNC_SUBDIR_NAME = 'sync';
const MACHINES_SUBDIR_NAME = 'machines';
const MERGED_SUBDIR_NAME = 'merged';
const MANIFEST_FILENAME = 'manifest.json';

/**
 * Legacy string labels that the pre-v2 sync tree hardcoded. Kept for
 * backward compat with existing `npm run sync:push -- --as mac` invocations
 * and for the migration step's default rename mapping.
 */
export const LEGACY_MACHINE_IDS = Object.freeze(['mac', 'windows']);
export const SYNC_MACHINE_IDS = LEGACY_MACHINE_IDS;

function currentProjectRoot() {
  const override = process.env.VDJ_PROJECT_ROOT;
  return override ? path.resolve(override) : PROJECT_ROOT_DEFAULT;
}

function currentSyncRoot() {
  const override = process.env.VDJ_SYNC_ROOT;
  if (override) return path.resolve(override);
  return path.join(currentProjectRoot(), SYNC_SUBDIR_NAME);
}

function currentMachinesRoot() {
  return path.join(currentSyncRoot(), MACHINES_SUBDIR_NAME);
}

/**
 * Normalize a machineId to a filesystem-safe token. Preserves legacy
 * 'mac'/'windows' verbatim and lowercase-hex UUIDs verbatim; anything else
 * is slugified so users can pass "My Studio Mac" and get "my-studio-mac".
 */
function normalizeMachineId(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return '';
  return trimmed
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96) || 'machine';
}

/**
 * @param {string | null | undefined} explicit A UUID, legacy label, or friendly name.
 * @returns {string} filesystem-safe machineId
 */
export function resolveMachineId(explicit) {
  if (explicit != null && explicit !== '') return normalizeMachineId(explicit);
  const fromEnv = process.env.VDJ_MACHINE_UUID || process.env.VDJ_MACHINE_ID;
  if (fromEnv) return normalizeMachineId(fromEnv);
  return process.platform === 'darwin' ? 'mac' : 'windows';
}

/**
 * @param {string} machineId
 * @returns {string} absolute path to sync/machines/<id>/
 */
export function syncMachineDir(machineId) {
  return path.join(currentMachinesRoot(), normalizeMachineId(machineId));
}

export function syncMergedDir() {
  return path.join(currentSyncRoot(), MERGED_SUBDIR_NAME);
}

export function syncRoot() {
  return currentSyncRoot();
}

export function syncMachinesRoot() {
  return currentMachinesRoot();
}

export function projectRoot() {
  return currentProjectRoot();
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
    manifest: path.join(dir, MANIFEST_FILENAME),
  };
}

/**
 * Scan sync/machines/ for every folder that at minimum contains database.xml
 * or a manifest. Returns entries sorted by (lastPushAt asc, id asc) so the
 * N-way merge fold is deterministic — the freshest snapshot wins the last
 * pairwise merge.
 *
 * @param {{ syncRoot?: string }} [args]
 * @returns {Array<{id: string, dir: string, manifest: object|null, lastPushAt: number}>}
 */
export function listSyncMachines({ syncRoot: syncRootOverride } = {}) {
  const machinesRoot = syncRootOverride
    ? path.join(syncRootOverride, MACHINES_SUBDIR_NAME)
    : currentMachinesRoot();
  if (!fs.existsSync(machinesRoot)) return [];

  const entries = [];
  for (const name of fs.readdirSync(machinesRoot)) {
    if (name.startsWith('.')) continue;
    const dir = path.join(machinesRoot, name);
    let stat;
    try {
      stat = fs.statSync(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    const files = syncFolderFiles(dir);
    if (!fs.existsSync(files.databaseXml) && !fs.existsSync(files.extraDb) && !fs.existsSync(files.manifest)) {
      continue;
    }

    let manifest = null;
    if (fs.existsSync(files.manifest)) {
      try {
        manifest = JSON.parse(fs.readFileSync(files.manifest, 'utf8'));
      } catch {
        manifest = null;
      }
    }

    const lastPushAt = Number.parseInt(String(manifest?.lastPushAt ?? manifest?.generatedAt ?? 0), 10) || 0;
    entries.push({ id: name, dir, manifest, lastPushAt });
  }

  entries.sort((a, b) => {
    if (a.lastPushAt !== b.lastPushAt) return a.lastPushAt - b.lastPushAt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return entries;
}

/**
 * @param {string} machineId
 * @returns {string} legacy alias — for the two-machine world, the "other" side.
 *          In the N-machine world callers should use listSyncMachines() instead.
 */
export function otherMachineId(machineId) {
  const id = normalizeMachineId(machineId);
  return id === 'mac' ? 'windows' : 'mac';
}
