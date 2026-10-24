#!/usr/bin/env node
/**
 * Entry point for `bun run start` / `npm run start`.
 *
 * Checks whether the Vite bundle under dist/ is older than any source
 * file. If it is (or if dist/ doesn't exist), runs `vite build` first.
 * Then launches Electron. Point: a user should never see a blank window
 * because they forgot to rebuild.
 *
 * Opt out of the staleness check with VDJ_SKIP_BUILD=1 (useful in dev
 * when you're already running `vite` in another terminal).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST_INDEX = path.join(projectRoot, 'dist', 'index.html');
const WATCH_DIRS = ['src', 'electron', 'index.html', 'vite.config.js', 'package.json'];
const IGNORE_DIR_NAMES = new Set(['node_modules', '.git', 'dist', 'public', 'sync']);

function latestMtime(absPath) {
  let maxMtime = 0;
  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return 0;
  }
  if (stat.isFile()) return stat.mtimeMs;
  if (!stat.isDirectory()) return 0;
  let dirents;
  try {
    dirents = fs.readdirSync(absPath, { withFileTypes: true });
  } catch {
    return maxMtime;
  }
  for (const ent of dirents) {
    if (ent.name.startsWith('.')) continue;
    if (IGNORE_DIR_NAMES.has(ent.name)) continue;
    const child = path.join(absPath, ent.name);
    const childMtime = ent.isDirectory() ? latestMtime(child) : fs.statSync(child).mtimeMs;
    if (childMtime > maxMtime) maxMtime = childMtime;
  }
  return maxMtime;
}

function needsRebuild() {
  if (process.env.VDJ_SKIP_BUILD === '1') return false;
  if (!fs.existsSync(DIST_INDEX)) return true;
  const distMtime = fs.statSync(DIST_INDEX).mtimeMs;
  const sourceMtime = WATCH_DIRS
    .map((rel) => latestMtime(path.join(projectRoot, rel)))
    .reduce((max, m) => Math.max(max, m), 0);
  return sourceMtime > distMtime;
}

function runViteBuild() {
  console.log('[launch] dist/ is stale — running vite build...');
  const result = spawnSync('npx', ['vite', 'build'], {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    console.error(`[launch] vite build failed (exit ${result.status}).`);
    process.exit(result.status ?? 1);
  }
}

function launchElectron() {
  const electronBin = path.join(projectRoot, 'node_modules', '.bin', 'electron');
  const binary = fs.existsSync(electronBin) ? electronBin : 'electron';
  const child = spawn(binary, ['.'], {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  child.on('exit', (code) => process.exit(code ?? 0));
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal));
  }
}

function main() {
  if (needsRebuild()) runViteBuild();
  launchElectron();
}

main();
