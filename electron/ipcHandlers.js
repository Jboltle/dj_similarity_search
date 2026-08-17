/**
 * All ipcMain handlers for the app. Every method is namespaced `vdj:<name>`
 * so the preload can expose a single `window.vdjApi` object to the renderer.
 *
 * Long-running script calls (parse / sync push+pull / linked-folder) stream
 * their console output back to the renderer over `vdj:log`, letting the UI
 * render a live progress log without any script-side changes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ipcMain, dialog, shell, app } from 'electron';
import { getSettings, saveSettings } from './settings.js';
import { resolveSyncRepoRoot, initializeSyncRepo } from './syncRepo.js';
import { resolveVdjFolder, vdjFiles } from '../scripts/lib/vdjPaths.js';
import { runParse } from '../scripts/parse-vdj-db.js';
import { runSyncPush } from '../scripts/sync-push.js';
import { runSyncPull } from '../scripts/sync-pull.js';
import { runSyncRestore } from '../scripts/sync-restore.js';
import { runBuildLinkedFolder } from '../scripts/build-linked-folder.js';
import { computeSyncDiff } from '../scripts/lib/syncDiff.js';
import { listBackups } from '../scripts/lib/syncBackups.js';

const GRAPH_FILENAME = 'graph.json';
const BACKUP_SUBDIR = 'backups';

let mainWindow = null;

export function setMainWindow(win) {
  mainWindow = win;
}

function graphJsonPath() {
  return path.join(app.getPath('userData'), GRAPH_FILENAME);
}

function backupRootPath() {
  return path.join(app.getPath('userData'), BACKUP_SUBDIR);
}

function makeLogSink() {
  return (line) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('vdj:log', {
        level: line?.level ?? 'info',
        msg: line?.msg ?? '',
        source: line?.source ?? 'app',
        timestamp: Date.now(),
      });
    }
  };
}

function inferMachineId(settings) {
  if (settings?.machineId) return settings.machineId;
  return process.platform === 'darwin' ? 'mac' : 'windows';
}

function currentVdjFolder(settings) {
  if (settings?.vdjFolder) return settings.vdjFolder;
  return resolveVdjFolder(null);
}

/**
 * Point the CLI helpers at the sync repo working tree and userData-based
 * backup dir for the duration of one sync call. Returns a restore function
 * so we always reset the process env once we're done, even on error.
 */
function applyScriptEnvOverrides({ syncRepoRoot }) {
  const prev = {
    VDJ_SYNC_ROOT: process.env.VDJ_SYNC_ROOT,
    VDJ_PROJECT_ROOT: process.env.VDJ_PROJECT_ROOT,
    VDJ_BACKUP_ROOT: process.env.VDJ_BACKUP_ROOT,
  };
  if (syncRepoRoot) {
    process.env.VDJ_SYNC_ROOT = path.join(syncRepoRoot, 'sync');
    process.env.VDJ_PROJECT_ROOT = syncRepoRoot;
  }
  process.env.VDJ_BACKUP_ROOT = backupRootPath();
  return () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

function toDetectResult(folder) {
  if (!folder) {
    return {
      folder: null,
      files: { databaseXml: null, extraDb: null, historyDir: null },
      exists: { databaseXml: false, extraDb: false, historyDir: false },
    };
  }
  const files = vdjFiles(folder);
  return {
    folder,
    files: {
      databaseXml: files.databaseXml,
      extraDb: files.extraDb,
      historyDir: files.historyDir,
    },
    exists: {
      databaseXml: fs.existsSync(files.databaseXml),
      extraDb: fs.existsSync(files.extraDb),
      historyDir: fs.existsSync(files.historyDir),
    },
  };
}

async function runRefreshLibrary() {
  const settings = getSettings();
  const vdjFolder = currentVdjFolder(settings);
  const files = vdjFiles(vdjFolder);
  const outPath = graphJsonPath();
  const onLog = makeLogSink();
  try {
    const parsed = await runParse({
      db: fs.existsSync(files.databaseXml) ? files.databaseXml : null,
      extraDb: fs.existsSync(files.extraDb) ? files.extraDb : null,
      history: fs.existsSync(files.historyDir) ? files.historyDir : null,
      useHistory: true,
      out: outPath,
      onLog,
    });
    saveSettings({ lastRefreshedAt: new Date().toISOString() });
    return { ok: true, meta: parsed?.meta ?? null, graphPath: parsed?.graphPath ?? outPath };
  } catch (err) {
    return { ok: false, meta: null, graphPath: null, error: err?.message ?? String(err) };
  }
}

export function registerIpcHandlers() {
  ipcMain.handle('vdj:getSettings', async () => getSettings());
  ipcMain.handle('vdj:saveSettings', async (_e, patch) => saveSettings(patch ?? {}));

  ipcMain.handle('vdj:detectVdjFolder', async () => {
    try {
      return toDetectResult(resolveVdjFolder(null));
    } catch (err) {
      return { ...toDetectResult(null), error: err?.message ?? String(err) };
    }
  });

  ipcMain.handle('vdj:pickFolder', async (_e, purpose) => {
    const title =
      purpose === 'vdj'
        ? 'Choose your VirtualDJ folder'
        : purpose === 'sync'
        ? 'Choose a sync folder'
        : 'Choose a folder';
    const result = await dialog.showOpenDialog({
      title,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('vdj:openPathInOs', async (_e, absPath) => {
    if (!absPath) return;
    await shell.openPath(absPath);
  });

  ipcMain.handle('vdj:getGraph', async () => {
    const p = graphJsonPath();
    if (!fs.existsSync(p)) {
      await runRefreshLibrary();
    }
    if (!fs.existsSync(p)) return null;
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      return null;
    }
  });

  ipcMain.handle('vdj:refreshLibrary', async () => runRefreshLibrary());

  ipcMain.handle('vdj:computeSyncDiff', async () => {
    const settings = getSettings();
    const localVdjFolder = currentVdjFolder(settings);
    const syncRepoRoot = resolveSyncRepoRoot(settings);
    const machineId = inferMachineId(settings);
    return computeSyncDiff({ localVdjFolder, syncRepoRoot, machineId });
  });

  ipcMain.handle('vdj:syncPush', async (_e, opts = {}) => {
    const settings = getSettings();
    const syncRepoRoot = resolveSyncRepoRoot(settings);
    if (!syncRepoRoot) {
      return { ok: false, backupFolder: null, commitSha: null, error: 'sync repo not configured' };
    }
    const restore = applyScriptEnvOverrides({ syncRepoRoot });
    try {
      const res = await runSyncPush({
        as: settings.machineId ?? undefined,
        source: settings.vdjFolder ?? undefined,
        message: opts.commitMessage ?? undefined,
        includeHistory: opts.includeHistory ?? true,
        git: settings.syncMode === 'git',
        push: settings.syncMode === 'git',
        runLinkedFolder: false,
        onLog: makeLogSink(),
      });
      return res;
    } finally {
      restore();
    }
  });

  ipcMain.handle('vdj:syncPull', async (_e, opts = {}) => {
    const settings = getSettings();
    const syncRepoRoot = resolveSyncRepoRoot(settings);
    if (!syncRepoRoot) {
      return { ok: false, backupFolder: null, commitSha: null, error: 'sync repo not configured' };
    }
    const restore = applyScriptEnvOverrides({ syncRepoRoot });
    try {
      const res = await runSyncPull({
        target: settings.vdjFolder ?? undefined,
        includeHistory: opts.includeHistory ?? true,
        write: true,
        git: settings.syncMode === 'git',
        runParse: false,
        runLinkedFolder: false,
        onLog: makeLogSink(),
      });
      if (res.ok) {
        await runRefreshLibrary();
      }
      return { ok: res.ok, backupFolder: res.backupFolder ?? null, commitSha: null, error: res.error };
    } finally {
      restore();
    }
  });

  ipcMain.handle('vdj:initializeSyncRepo', async (_e, opts) => initializeSyncRepo(opts ?? {}));

  ipcMain.handle('vdj:listBackups', async () => {
    const items = listBackups({ backupRoot: backupRootPath() });
    return items.map((b) => {
      const manifest = b.manifest ?? {};
      const files = manifest.files ?? {};
      const sizeBytes = Object.values(files).reduce((acc, f) => acc + (f?.bytes ?? 0), 0);
      return {
        stamp: manifest.stamp ?? b.name,
        folder: b.folder,
        kind: manifest.kind ?? 'unknown',
        sizeBytes,
      };
    });
  });

  ipcMain.handle('vdj:restoreBackup', async (_e, stamp, opts = {}) => {
    const settings = getSettings();
    const restoreEnv = applyScriptEnvOverrides({ syncRepoRoot: resolveSyncRepoRoot(settings) });
    try {
      const res = await runSyncRestore({
        stamp,
        target: settings.vdjFolder ?? undefined,
        backupDir: backupRootPath(),
        includeHistory: opts.includeHistory ?? true,
        write: true,
        forceWal: true,
        onLog: makeLogSink(),
      });
      return { ok: res.ok, error: res.error };
    } finally {
      restoreEnv();
    }
  });

  ipcMain.handle('vdj:refreshLinkedFolder', async () => {
    const settings = getSettings();
    const res = await runBuildLinkedFolder({
      target: settings.vdjFolder ?? undefined,
      name: settings.linkedFolderName ?? 'Linked Tracks',
      write: true,
      forceWal: true,
      backupDir: backupRootPath(),
      onLog: makeLogSink(),
    });
    return res;
  });
}
