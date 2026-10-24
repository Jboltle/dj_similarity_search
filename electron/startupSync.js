/**
 * One-shot "do everything" sync for app startup and quit.
 *
 * On launch: pulls the latest shared library, rewrites paths for this
 * machine, auto-ingests new audio-library files, regenerates the
 * `Linked Tracks` .vdjfolder, then pushes anything new this machine has.
 * On quit: a last push so the next machine sees your work.
 *
 * All of it is a no-op if sync is disabled, the sync repo isn't set up,
 * or VirtualDJ is open (we never touch extra.db while VDJ owns it — that
 * corrupts the database).
 *
 * Progress is streamed into the same `vdj:log` channel the manual sync
 * UI reads, so the renderer's live log shows exactly what happened.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { app } = require('electron');

import { getSettings } from './settings.js';
import { resolveSyncRepoRoot } from './syncRepo.js';
import { runSyncPull } from '../scripts/sync-pull.js';
import { runSyncPush } from '../scripts/sync-push.js';
import { runBuildLinkedFolder } from '../scripts/build-linked-folder.js';
import { resolveVdjFolder, vdjFiles } from '../scripts/lib/vdjPaths.js';
import { loadResolutions } from '../scripts/lib/conflictResolutions.js';
import {
  applyScriptEnvOverrides,
  backupRootPath,
  resolutionsPath,
  makeLogSink,
} from './ipcHandlers.js';

const WAL_SIDECAR_EXTENSIONS = ['-wal', '-shm'];
const DEFAULT_LINKED_FOLDER_NAME = 'Linked Tracks';

/** Non-throwing check — returns true if VirtualDJ appears to be running. */
function virtualDjAppearsOpen(extraDbPath) {
  if (!extraDbPath || !fs.existsSync(extraDbPath)) return false;
  return WAL_SIDECAR_EXTENSIONS.some((ext) => fs.existsSync(`${extraDbPath}${ext}`));
}

function logInfo(sink, msg) {
  sink({ level: 'info', msg, source: 'startup:sync' });
}
function logWarn(sink, msg) {
  sink({ level: 'warn', msg, source: 'startup:sync' });
}

/**
 * Pre-flight checks shared by startup and shutdown sync. Returns
 * `{ ok: true, settings, syncRepoRoot, vdjFolder }` or `{ ok: false, reason }`.
 */
function preflight(sink) {
  const settings = getSettings();
  if (!settings.syncMode || settings.syncMode === 'none') {
    return { ok: false, reason: 'sync disabled in Settings' };
  }
  const syncRepoRoot = resolveSyncRepoRoot(settings);
  if (!syncRepoRoot) {
    return { ok: false, reason: 'sync repo not configured yet' };
  }
  const vdjFolder = settings.vdjFolder || resolveVdjFolder(null);
  if (!vdjFolder || !fs.existsSync(vdjFolder)) {
    return { ok: false, reason: 'VirtualDJ folder not found' };
  }
  const { extraDb } = vdjFiles(vdjFolder);
  if (virtualDjAppearsOpen(extraDb)) {
    logWarn(sink, 'VirtualDJ is open; skipping auto-sync so we never corrupt extra.db.');
    return { ok: false, reason: 'VirtualDJ running' };
  }
  return { ok: true, settings, syncRepoRoot, vdjFolder };
}

/**
 * Pull → rewrite paths → auto-ingest → regenerate Linked Tracks → push.
 * All steps are independent: a failure in one does not block the next.
 */
export async function runStartupSync({ onLog } = {}) {
  const sink = onLog ?? makeLogSink();
  const check = preflight(sink);
  if (!check.ok) {
    logInfo(sink, `Startup sync skipped (${check.reason}).`);
    return { ok: true, skipped: true, reason: check.reason };
  }
  const { settings, syncRepoRoot, vdjFolder } = check;

  const summary = {
    ok: true,
    skipped: false,
    pull: null,
    linkedFolder: null,
    push: null,
  };

  const restoreEnv = applyScriptEnvOverrides({
    syncRepoRoot,
    machineUuid: settings.machineUuid,
  });
  try {
    logInfo(sink, `Starting auto-sync against ${syncRepoRoot}`);

    // 1. Pull latest from shared library.
    try {
      summary.pull = await runSyncPull({
        target: vdjFolder,
        includeHistory: true,
        selectionRules: settings.syncSelection?.pull ?? null,
        resolutions: loadResolutions(resolutionsPath()),
        write: true,
        git: settings.syncMode === 'git',
        runParse: false,
        runLinkedFolder: false, // we handle it ourselves below
        audioLibraryRoot: settings.audioLibrary?.root ?? null,
        autoAddDiscovered: Boolean(settings.audioLibrary?.autoAddDiscovered),
        onLog: sink,
      });
    } catch (err) {
      logWarn(sink, `Pull failed: ${err?.message ?? err}`);
      summary.pull = { ok: false, error: String(err?.message ?? err) };
    }

    // 2. Regenerate Linked Tracks folder so new files + SoundCloud show up.
    try {
      summary.linkedFolder = await runBuildLinkedFolder({
        target: vdjFolder,
        name: settings.linkedFolderName ?? DEFAULT_LINKED_FOLDER_NAME,
        write: true,
        forceWal: false, // we already verified VDJ is closed
        backupDir: backupRootPath(),
        audioLibraryRoot: settings.audioLibrary?.root ?? null,
        mergedLibraryIndex: path.join(syncRepoRoot, 'sync', 'merged', 'audio-library-index.json'),
        onLog: sink,
      });
    } catch (err) {
      logWarn(sink, `Linked folder regen failed: ${err?.message ?? err}`);
      summary.linkedFolder = { ok: false, error: String(err?.message ?? err) };
    }

    // 3. Push local changes so other machines see what we did last session.
    try {
      summary.push = await runSyncPush({
        machineUuid: settings.machineUuid,
        machineDisplayName: settings.machineDisplayName,
        as: settings.machineId ?? undefined,
        source: vdjFolder,
        includeHistory: true,
        selectionRules: settings.syncSelection?.push ?? null,
        resolutions: loadResolutions(resolutionsPath()),
        appVersion: app.getVersion(),
        git: settings.syncMode === 'git',
        push: settings.syncMode === 'git',
        runLinkedFolder: false,
        audioLibraryRoot: settings.audioLibrary?.root ?? null,
        onLog: sink,
      });
    } catch (err) {
      logWarn(sink, `Push failed: ${err?.message ?? err}`);
      summary.push = { ok: false, error: String(err?.message ?? err) };
    }

    logInfo(sink, 'Auto-sync complete.');
  } finally {
    restoreEnv();
  }
  return summary;
}

/**
 * Lighter-weight sync for app quit: one push to share what you did in this
 * session, nothing else. Must complete before the process exits.
 */
export async function runShutdownSync({ onLog } = {}) {
  const sink = onLog ?? makeLogSink();
  const check = preflight(sink);
  if (!check.ok) return { ok: true, skipped: true, reason: check.reason };
  const { settings, syncRepoRoot, vdjFolder } = check;

  const restoreEnv = applyScriptEnvOverrides({
    syncRepoRoot,
    machineUuid: settings.machineUuid,
  });
  try {
    logInfo(sink, 'Pushing on quit so other machines see your changes...');
    return await runSyncPush({
      machineUuid: settings.machineUuid,
      machineDisplayName: settings.machineDisplayName,
      as: settings.machineId ?? undefined,
      source: vdjFolder,
      includeHistory: true,
      selectionRules: settings.syncSelection?.push ?? null,
      resolutions: loadResolutions(resolutionsPath()),
      appVersion: app.getVersion(),
      git: settings.syncMode === 'git',
      push: settings.syncMode === 'git',
      runLinkedFolder: false,
      audioLibraryRoot: settings.audioLibrary?.root ?? null,
      onLog: sink,
    });
  } catch (err) {
    logWarn(sink, `Shutdown push failed: ${err?.message ?? err}`);
    return { ok: false, error: String(err?.message ?? err) };
  } finally {
    restoreEnv();
  }
}
