/**
 * Bridges the renderer <-> main process. Exposes a single `window.vdjApi`
 * object whose methods are thin `ipcRenderer.invoke` wrappers, plus one
 * event stream (`onLog`) for live script output.
 */
import { contextBridge, ipcRenderer } from 'electron';

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('vdjApi', {
  getSettings: () => invoke('vdj:getSettings'),
  saveSettings: (patch) => invoke('vdj:saveSettings', patch),
  detectVdjFolder: () => invoke('vdj:detectVdjFolder'),
  pickFolder: (purpose) => invoke('vdj:pickFolder', purpose),
  openPathInOs: (absPath) => invoke('vdj:openPathInOs', absPath),
  getGraph: () => invoke('vdj:getGraph'),
  refreshLibrary: () => invoke('vdj:refreshLibrary'),
  computeSyncDiff: () => invoke('vdj:computeSyncDiff'),
  syncPush: (opts) => invoke('vdj:syncPush', opts),
  syncPull: (opts) => invoke('vdj:syncPull', opts),
  initializeSyncRepo: (opts) => invoke('vdj:initializeSyncRepo', opts),
  listBackups: () => invoke('vdj:listBackups'),
  restoreBackup: (stamp, opts) => invoke('vdj:restoreBackup', stamp, opts),
  refreshLinkedFolder: () => invoke('vdj:refreshLinkedFolder'),
  onLog: (cb) => {
    const listener = (_event, line) => {
      try {
        cb(line);
      } catch {
        /* renderer callback errors shouldn't kill the pipe */
      }
    };
    ipcRenderer.on('vdj:log', listener);
    return () => ipcRenderer.removeListener('vdj:log', listener);
  },
});
