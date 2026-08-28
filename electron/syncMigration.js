/**
 * One-shot v1 -> v2 sync layout migration.
 *
 * v1 layout: sync/mac/, sync/windows/, sync/merged/
 * v2 layout: sync/machines/<id>/, sync/merged/
 *
 * On first launch of v2 we rename any legacy sync/{mac,windows}/ folder into
 * sync/machines/<label>/ and drop a manifest.json with displayName + platform
 * so the N-way merge treats them as first-class machines. sync/merged/ is
 * preserved verbatim; the next `sync:push` will regenerate it from the
 * relocated inputs.
 *
 * Safe to run repeatedly: if sync/machines/<label>/ already exists we skip
 * the corresponding v1 folder untouched (letting the user resolve it
 * manually).
 */
import fs from 'node:fs';
import path from 'node:path';

const LEGACY_MACHINES = [
  { legacy: 'mac',     displayName: 'Legacy Mac',     platform: 'darwin' },
  { legacy: 'windows', displayName: 'Legacy Windows', platform: 'win32'  },
];

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function writeJson(p, obj) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

function looksNonEmpty(dir) {
  if (!isDir(dir)) return false;
  const entries = fs.readdirSync(dir).filter((n) => n !== '.gitkeep');
  return entries.length > 0;
}

/**
 * @param {{ syncRoot: string, onLog?: (msg: string) => void }} args
 * @returns {{ migrated: string[], skipped: string[] }}
 */
export function migrateLegacySyncLayout({ syncRoot, onLog } = {}) {
  const log = (msg) => {
    if (onLog) onLog(msg);
  };
  const result = { migrated: [], skipped: [] };

  if (!syncRoot || !isDir(syncRoot)) return result;

  const machinesRoot = path.join(syncRoot, 'machines');

  for (const { legacy, displayName, platform } of LEGACY_MACHINES) {
    const legacyDir = path.join(syncRoot, legacy);
    if (!looksNonEmpty(legacyDir)) continue;

    ensureDir(machinesRoot);
    const targetDir = path.join(machinesRoot, legacy);

    if (fs.existsSync(targetDir)) {
      log(`[sync:migrate] sync/machines/${legacy}/ already exists; leaving sync/${legacy}/ in place.`);
      result.skipped.push(legacy);
      continue;
    }

    try {
      fs.renameSync(legacyDir, targetDir);
    } catch (err) {
      log(`[sync:migrate] rename sync/${legacy}/ -> sync/machines/${legacy}/ failed: ${err.message}`);
      result.skipped.push(legacy);
      continue;
    }

    const manifestPath = path.join(targetDir, 'manifest.json');
    const existing = readJson(manifestPath) ?? {};
    const manifest = {
      ...existing,
      machineId: existing.machineId || legacy,
      machineUuid: existing.machineUuid || legacy,
      displayName: existing.displayName || displayName,
      platform: existing.platform || platform,
      hostname: existing.hostname || null,
      lastPushAt: existing.lastPushAt || Date.parse(existing.generatedAt ?? '') || Date.now(),
      generatedAt: existing.generatedAt || new Date().toISOString(),
      migratedFrom: `sync/${legacy}/`,
    };
    writeJson(manifestPath, manifest);

    log(`[sync:migrate] Migrated sync/${legacy}/ -> sync/machines/${legacy}/`);
    result.migrated.push(legacy);
  }

  return result;
}
