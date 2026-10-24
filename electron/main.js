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
import { runStartupSync, runShutdownSync } from './startupSync.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Chromium blocklists WebGL2 under WSLg and some other Linux stacks even
 * when `/dev/dri` is present. The graph view uses Three.js (WebGL), so
 * disabling the GPU is NOT what we want — we need Chromium to accept the
 * GPU despite the blocklist, falling back to SwiftShader if it genuinely
 * doesn't work. Call this BEFORE app.whenReady().
 *
 * Env overrides:
 *   VDJ_DISABLE_GPU=1  — force pure software rendering (no WebGL).
 *   VDJ_FORCE_GPU=1    — skip this logic entirely (trust the defaults).
 */
function configureGpu() {
  if (process.env.VDJ_FORCE_GPU === '1') return;

  if (process.env.VDJ_DISABLE_GPU === '1') {
    app.disableHardwareAcceleration();
    app.commandLine.appendSwitch('disable-gpu');
    app.commandLine.appendSwitch('disable-gpu-compositing');
    return;
  }

  const isLinux = process.platform === 'linux';
  const isWsl =
    isLinux && (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);

  if (isLinux) {
    // Tell Chromium to stop blocklisting WebGL on Linux/WSL (we've checked
    // that /dev/dri is reachable in the terminal) and to prefer the newer
    // ANGLE+Vulkan path when it exists, with SwiftShader as a safety net.
    app.commandLine.appendSwitch('ignore-gpu-blocklist');
    app.commandLine.appendSwitch('enable-webgl');
    app.commandLine.appendSwitch('enable-unsafe-webgl');
    app.commandLine.appendSwitch('enable-unsafe-swiftshader');
  }
  if (isWsl) {
    // WSLg exposes d3d12 under the hood; ANGLE's GL backend talks to it
    // reliably. Also enable Vulkan + Skia path so WebGL2 initialises.
    app.commandLine.appendSwitch('use-angle', 'gl');
    app.commandLine.appendSwitch('enable-features', 'Vulkan,UseSkiaRenderer');
  }
}

configureGpu();

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
      backgroundThrottling: false,
    },
  });

  setMainWindow(win);
  // Normal path: show once the renderer signals it's painted.
  // Fallback: WSL/software-GL can occasionally skip ready-to-show; make sure
  // the window becomes visible either way so you never stare at a blank.
  let shown = false;
  const showOnce = () => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    win.show();
  };
  win.once('ready-to-show', showOnce);
  setTimeout(showOnce, 3000);

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

  // Kick off the "do everything" sync in the background so the window
  // paints instantly. Progress streams to the renderer's live log.
  // Opt out with VDJ_SKIP_AUTO_SYNC=1.
  if (process.env.VDJ_SKIP_AUTO_SYNC !== '1') {
    setTimeout(() => {
      runStartupSync().catch((err) =>
        console.warn(`[startup:sync] Unhandled error: ${err?.message ?? err}`)
      );
    }, 500);
  }

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createMainWindow();
    }
  });
});

// Give one last push a chance to finish before the process exits so the
// other machines see what we did this session. Capped at 15s so a hung
// network can't trap you in a quit cycle.
let shutdownSyncStarted = false;
app.on('before-quit', async (event) => {
  if (shutdownSyncStarted) return;
  if (process.env.VDJ_SKIP_AUTO_SYNC === '1') return;
  shutdownSyncStarted = true;
  event.preventDefault();
  const timeout = new Promise((resolve) => setTimeout(resolve, 15_000));
  try {
    await Promise.race([runShutdownSync(), timeout]);
  } catch (err) {
    console.warn(`[shutdown:sync] ${err?.message ?? err}`);
  } finally {
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (!isMac()) app.quit();
});
