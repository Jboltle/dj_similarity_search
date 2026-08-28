/**
 * Bridges the renderer <-> main process. Exposes a single `window.vdjApi`
 * object whose methods are thin `ipcRenderer.invoke` wrappers, plus one
 * event stream (`onLog`) for live script output.
 *
 * The `sync.*` namespace holds the v2 methods (conflict resolutions,
 * selection rules, known machines, cloud backends). The top-level
 * `syncPush` / `syncPull` are preserved as aliases so nothing already
 * calling them breaks mid-flight.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

const sync = {
  push: (opts) => invoke('vdj:syncPush', opts),
  pull: (opts) => invoke('vdj:syncPull', opts),
  computeDiff: () => invoke('vdj:computeSyncDiff'),

  listKnownMachines: () => invoke('vdj:sync:listKnownMachines'),
  renameThisMachine: (displayName) => invoke('vdj:sync:renameThisMachine', displayName),
  forgetMachine: (id) => invoke('vdj:sync:forgetMachine', id),

  getSelectionRules: () => invoke('vdj:sync:getSelectionRules'),
  saveSelectionRules: (rules) => invoke('vdj:sync:saveSelectionRules', rules),
  previewSelection: (rules) => invoke('vdj:sync:previewSelection', rules),

  setConflictResolution: (filePath, choice) =>
    invoke('vdj:sync:setConflictResolution', filePath, choice),
  listConflictResolutions: () => invoke('vdj:sync:listConflictResolutions'),

  detectCloudFolders: () => invoke('vdj:sync:detectCloudFolders'),
  useCloudBackend: (opts) => invoke('vdj:sync:useCloudBackend', opts),
};

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
  sync,
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
