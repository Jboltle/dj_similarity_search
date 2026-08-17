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
import { app, BrowserWindow } from 'electron';
import { registerIpcHandlers, setMainWindow } from './ipcHandlers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_WINDOW_WIDTH = 1400;
const DEFAULT_WINDOW_HEIGHT = 900;
const DEV_SERVER_URL_ENV = 'VITE_DEV_SERVER_URL';

function isMac() {
  return process.platform === 'darwin';
}

function resolveIndexHtml() {
  return path.join(__dirname, '..', 'dist', 'index.html');
}

async function createMainWindow() {
  const win = new BrowserWindow({
    width: DEFAULT_WINDOW_WIDTH,
    height: DEFAULT_WINDOW_HEIGHT,
    show: false,
    backgroundColor: '#0a0a0a',
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

app.whenReady().then(async () => {
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
