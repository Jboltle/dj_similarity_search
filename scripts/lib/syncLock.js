/**
 * Simple TTL-based sync lockfile.
 *
 * Two machines pushing into the same cloud folder can otherwise race —
 * Dropbox/OneDrive will happily overwrite each other's files mid-copy. This
 * helper acquires an exclusive `.lock` before every push/pull and releases
 * it in a finally-block. Locks expire after `ttlMs` so a crashed process
 * doesn't wedge the folder forever.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOCK_FILE_NAME = '.lock';
const DEFAULT_TTL_MS = 5 * 60 * 1000;

function lockPath(syncRoot) {
  return path.join(syncRoot, LOCK_FILE_NAME);
}

function safeReadLock(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @param {{ syncRoot: string }} args
 * @returns {object | null}
 */
export function readLock({ syncRoot }) {
  if (!syncRoot) return null;
  const p = lockPath(syncRoot);
  if (!fs.existsSync(p)) return null;
  const raw = safeReadLock(p);
  if (!raw) return null;
  const expiresAt = Number(raw.expiresAt ?? 0);
  const now = Date.now();
  if (expiresAt && expiresAt < now) return { ...raw, expired: true };
  return { ...raw, expired: false };
}

/**
 * @param {{ syncRoot: string, machineUuid: string, displayName?: string, ttlMs?: number }} args
 * @returns {{ ok: boolean, lock?: object, existing?: object, error?: string }}
 */
export function acquireLock({ syncRoot, machineUuid, displayName, ttlMs = DEFAULT_TTL_MS }) {
  if (!syncRoot) return { ok: false, error: 'syncRoot required' };
  if (!machineUuid) return { ok: false, error: 'machineUuid required' };
  fs.mkdirSync(syncRoot, { recursive: true });
  const p = lockPath(syncRoot);

  const existing = readLock({ syncRoot });
  if (existing && !existing.expired && existing.machineUuid !== machineUuid) {
    return { ok: false, existing };
  }

  const now = Date.now();
  const lock = {
    machineUuid,
    displayName: displayName || machineUuid,
    hostname: os.hostname(),
    pid: process.pid,
    acquiredAt: now,
    expiresAt: now + ttlMs,
  };
  const tmp = `${p}.tmp-${process.pid}-${now}`;
  fs.writeFileSync(tmp, JSON.stringify(lock, null, 2));
  fs.renameSync(tmp, p);
  return { ok: true, lock };
}

/**
 * @param {{ syncRoot: string, machineUuid: string }} args
 */
export function releaseLock({ syncRoot, machineUuid }) {
  if (!syncRoot) return { ok: false, error: 'syncRoot required' };
  const p = lockPath(syncRoot);
  if (!fs.existsSync(p)) return { ok: true };
  const cur = safeReadLock(p);
  if (cur && cur.machineUuid && cur.machineUuid !== machineUuid) {
    return { ok: false, error: `lock owned by ${cur.machineUuid}` };
  }
  try {
    fs.unlinkSync(p);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}
