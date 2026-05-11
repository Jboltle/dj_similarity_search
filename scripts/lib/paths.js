import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DEFAULT_DB_LOCATIONS = {
  darwin: () => path.join(os.homedir(), 'Library', 'Application Support', 'VirtualDJ', 'database.xml'),
  win32: () => path.join(os.homedir(), 'Documents', 'VirtualDJ', 'database.xml'),
  linux: () => path.join(os.homedir(), 'Documents', 'VirtualDJ', 'database.xml'),
};

export function resolveDatabasePath(explicit) {
  const candidates = [];
  if (explicit) candidates.push(explicit);
  if (process.env.VDJ_DB_PATH) candidates.push(process.env.VDJ_DB_PATH);
  const platformResolver = DEFAULT_DB_LOCATIONS[process.platform];
  if (platformResolver) candidates.push(platformResolver());

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Could not locate VirtualDJ database.xml. Tried:\n  - ${candidates.join('\n  - ')}\n` +
      'Set VDJ_DB_PATH or pass --db <path> on the CLI.'
  );
}

export function normalizePath(rawPath) {
  if (!rawPath || typeof rawPath !== 'string') return '';
  return rawPath
    .replaceAll('\\', '/')
    .replace(/\/+/g, '/')
    .trim()
    .toLowerCase();
}

export function basenameOnly(rawPath) {
  if (!rawPath) return '';
  const cleaned = rawPath.replaceAll('\\', '/');
  const idx = cleaned.lastIndexOf('/');
  return (idx >= 0 ? cleaned.slice(idx + 1) : cleaned).trim().toLowerCase();
}

export function isStreamingPath(rawPath) {
  if (!rawPath) return false;
  return /^(netsearch|http|https|spotify|tidal|deezer|youtube|soundcloud):/i.test(rawPath);
}
