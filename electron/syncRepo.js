/**
 * Sync-repo lifecycle: resolve the working tree location, and clone / update
 * it on demand. Keeps the git plumbing isolated from the rest of the IPC
 * surface so main.js only has to deal with a couple of small primitives.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { app } from 'electron';

const SYNC_REPO_DIR = 'sync-repo';
const SYNC_SUBDIRS = ['sync/mac', 'sync/windows', 'sync/merged'];

/**
 * @param {{ syncMode: string, syncLocalFolder: string | null } | null} settings
 * @returns {string | null}
 */
export function resolveSyncRepoRoot(settings) {
  if (!settings) return null;
  if (settings.syncMode === 'git') {
    return path.join(app.getPath('userData'), SYNC_REPO_DIR);
  }
  if (settings.syncMode === 'local-folder') {
    return settings.syncLocalFolder ?? null;
  }
  return null;
}

function gitExec(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function ensureSyncSubdirs(root) {
  for (const sub of SYNC_SUBDIRS) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
}

/**
 * @param {{ mode: 'git' | 'local-folder' | 'none', remoteUrl?: string, folder?: string }} opts
 * @returns {Promise<{ ok: boolean, path: string | null, error?: string }>}
 */
export async function initializeSyncRepo({ mode, remoteUrl, folder } = {}) {
  try {
    if (mode === 'git') {
      if (!remoteUrl) {
        return { ok: false, path: null, error: 'remoteUrl is required for git mode' };
      }
      const target = path.join(app.getPath('userData'), SYNC_REPO_DIR);
      if (!fs.existsSync(target)) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        gitExec(['clone', remoteUrl, target]);
      } else {
        gitExec(['remote', 'set-url', 'origin', remoteUrl], target);
        gitExec(['pull', '--ff-only'], target);
      }
      ensureSyncSubdirs(target);
      return { ok: true, path: target };
    }
    if (mode === 'local-folder') {
      if (!folder) {
        return { ok: false, path: null, error: 'folder is required for local-folder mode' };
      }
      fs.mkdirSync(folder, { recursive: true });
      ensureSyncSubdirs(folder);
      return { ok: true, path: folder };
    }
    if (mode === 'none') {
      return { ok: true, path: null };
    }
    return { ok: false, path: null, error: `unknown sync mode: ${mode}` };
  } catch (err) {
    return { ok: false, path: null, error: err?.message ?? String(err) };
  }
}
