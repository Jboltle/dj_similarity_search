/**
 * Electron main-process entry point. Wires up:
 *   - IPC handlers before window creation (so early renderer calls don't race)
 *   - A single BrowserWindow that loads either the Vite dev server or the
 *     built dist/ bundle depending on VITE_DEV_SERVER_URL.
 *   - Standard mac (persist app between windows) and Windows/Linux
 *     (quit-on-all-closed) lifecycle.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { app, BrowserWindow } = require('electron');
import { registerIpcHandlers, setMainWindow } from './ipcHandlers.js';
import { getSettings } from './settings.js';
import { resolveSyncRepoRoot } from './syncRepo.js';
import { migrateLegacySyncLayout } from './syncMigration.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_WINDOW_WIDTH = 1400;
const DEFAULT_WINDOW_HEIGHT = 900;
const MIN_WINDOW_WIDTH = 1024;
const MIN_WINDOW_HEIGHT = 720;
const APP_BACKGROUND = '#08090d';
const TITLE_BAR_HEIGHT = 40;
const TITLE_BAR_COLOR = '#0b0d13';
const TITLE_BAR_SYMBOL_COLOR = '#e6e8ef';
const DEV_SERVER_URL_ENV = 'VITE_DEV_SERVER_URL';

function isMac() {
  return process.platform === 'darwin';
}

function resolveIndexHtml() {
  return path.join(__dirname, '..', 'dist', 'index.html');
}

function windowChromeOptions() {
  if (isMac()) {
    return {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 14, y: 15 },
    };
  }
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: TITLE_BAR_COLOR,
      symbolColor: TITLE_BAR_SYMBOL_COLOR,
      height: TITLE_BAR_HEIGHT,
    },
  };
}

async function createMainWindow() {
  const win = new BrowserWindow({
    width: DEFAULT_WINDOW_WIDTH,
    height: DEFAULT_WINDOW_HEIGHT,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    show: false,
    backgroundColor: APP_BACKGROUND,
    ...windowChromeOptions(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  setMainWindow(win);
  win.once('ready-to-show', () => win.show());

  const devUrl = process.env[DEV_SERVER_URL_ENV];
  if (devUrl) {
    await win.loadURL(devUrl);
  } else {
    await win.loadFile(resolveIndexHtml());
  }
  return win;
}

function runOneShotMigrations() {
  try {
    const settings = getSettings();
    const syncRepoRoot = resolveSyncRepoRoot(settings);
    if (!syncRepoRoot) return;
    const syncRoot = path.join(syncRepoRoot, 'sync');
    const result = migrateLegacySyncLayout({
      syncRoot,
      onLog: (msg) => console.log(msg),
    });
    if (result.migrated.length > 0) {
      console.log(`[startup] Migrated legacy sync folders: ${result.migrated.join(', ')}`);
    }
  } catch (err) {
    console.warn(`[startup] Migration skipped: ${err?.message ?? err}`);
  }
}

app.whenReady().then(async () => {
  runOneShotMigrations();
  registerIpcHandlers();
  await createMainWindow();

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (!isMac()) app.quit();
});
