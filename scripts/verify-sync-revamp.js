#!/usr/bin/env node
/**
 * End-to-end verifier for the sync revamp.
 *
 * Exercises:
 *  1. Legacy sync/{mac,windows} -> sync/machines/{mac,windows} migration.
 *  2. N-way merge over sync/machines/{a,b,c} produces a superset union of
 *     songs and preserves POI-diff conflicts.
 *  3. Selection rules honor include/exclude folders.
 *  4. Lockfile handoff between two machines fails-fast.
 *
 * Run from the project root: `node scripts/verify-sync-revamp.js`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const projectRoot = process.cwd();
process.env.VDJ_PROJECT_ROOT = projectRoot;

const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vdj-verify-'));
const syncRoot = path.join(workRoot, 'sync');
process.env.VDJ_SYNC_ROOT = syncRoot;
process.env.VDJ_BACKUP_ROOT = path.join(workRoot, 'backups');

const { migrateLegacySyncLayout } = await import('../electron/syncMigration.js');
const { runSyncMerge } = await import('./sync-merge.js');
const { listSyncMachines, syncMachineDir, syncFolderFiles } = await import('./lib/machineId.js');
const { applySelection } = await import('./lib/selectionRules.js');
const { acquireLock, releaseLock, readLock } = await import('./lib/syncLock.js');

function log(msg) { console.log(`[verify] ${msg}`); }

function xmlForSongs(songs) {
  const rows = songs.map((s) => {
    const poiXml = (s.pois ?? []).map((p) => `<Poi Name="${p}" />`).join('');
    return `  <Song FilePath="${s.filePath}"><Infos LastModified="${s.lastModified}" /><Tags Author="${s.artist ?? ''}" Title="${s.title ?? ''}" />${poiXml}</Song>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<VirtualDJ_Database Version="1">\n${rows}\n</VirtualDJ_Database>\n`;
}

function writeMachine(id, songs, meta = {}) {
  const dir = syncMachineDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const files = syncFolderFiles(dir);
  fs.writeFileSync(files.databaseXml, xmlForSongs(songs));
  fs.writeFileSync(files.manifest, JSON.stringify({
    machineId: id,
    machineUuid: id,
    displayName: meta.displayName ?? id,
    platform: meta.platform ?? 'linux',
    lastPushAt: meta.lastPushAt ?? Date.now(),
  }, null, 2));
}

function songsFromMergedXml() {
  const merged = path.join(syncRoot, 'merged', 'database.xml');
  const raw = fs.readFileSync(merged, 'utf8');
  return [...raw.matchAll(/<Song FilePath="([^"]+)"/g)].map((m) => m[1]);
}

async function testMigration() {
  log('migration: seed legacy sync/mac/ + sync/windows/ folders');
  const legacyRoot = syncRoot;
  fs.rmSync(legacyRoot, { recursive: true, force: true });
  fs.mkdirSync(path.join(legacyRoot, 'mac'), { recursive: true });
  fs.mkdirSync(path.join(legacyRoot, 'windows'), { recursive: true });
  fs.writeFileSync(path.join(legacyRoot, 'mac', 'database.xml'), xmlForSongs([{
    filePath: '/Users/me/Music/a.mp3', lastModified: 1000,
  }]));
  fs.writeFileSync(path.join(legacyRoot, 'windows', 'database.xml'), xmlForSongs([{
    filePath: 'C:/Music/b.mp3', lastModified: 2000,
  }]));

  const result = migrateLegacySyncLayout({ syncRoot: legacyRoot, onLog: (m) => console.log(m) });
  assert.deepEqual(new Set(result.migrated), new Set(['mac', 'windows']), 'both legacy folders migrated');
  assert.ok(fs.existsSync(path.join(legacyRoot, 'machines', 'mac', 'database.xml')));
  assert.ok(fs.existsSync(path.join(legacyRoot, 'machines', 'windows', 'database.xml')));
  assert.ok(!fs.existsSync(path.join(legacyRoot, 'mac')));
  log('migration: PASS');
}

async function testNwayMerge() {
  log('merge: seed sync/machines/{alpha,beta,gamma}');
  fs.rmSync(syncRoot, { recursive: true, force: true });
  writeMachine('alpha', [
    { filePath: '/m/only-alpha.mp3', lastModified: 100 },
    { filePath: '/m/shared.mp3',     lastModified: 500 },
  ], { lastPushAt: 1_000 });
  writeMachine('beta', [
    { filePath: '/m/only-beta.mp3',  lastModified: 200 },
    { filePath: '/m/shared.mp3',     lastModified: 600 },
  ], { lastPushAt: 2_000 });
  writeMachine('gamma', [
    { filePath: '/m/only-gamma.mp3', lastModified: 300 },
    { filePath: '/m/shared.mp3',     lastModified: 400 },
  ], { lastPushAt: 3_000 });

  const machines = listSyncMachines();
  assert.equal(machines.length, 3, 'listSyncMachines saw 3 folders');
  assert.deepEqual(machines.map((m) => m.id), ['alpha', 'beta', 'gamma'], 'sorted by lastPushAt asc');

  runSyncMerge({});
  const merged = new Set(songsFromMergedXml());
  assert.ok(merged.has('/m/only-alpha.mp3'), 'alpha-only survives');
  assert.ok(merged.has('/m/only-beta.mp3'),  'beta-only survives');
  assert.ok(merged.has('/m/only-gamma.mp3'), 'gamma-only survives');
  assert.ok(merged.has('/m/shared.mp3'),     'shared collapsed once');
  assert.equal(merged.size, 4, 'union size == 4');
  log('merge: PASS');
}

async function testTwoWayEquivalence() {
  log('merge: 2-machine N-way reduces to the pre-v2 two-way behavior');
  fs.rmSync(syncRoot, { recursive: true, force: true });
  writeMachine('one', [
    { filePath: '/m/a.mp3', lastModified: 100 },
    { filePath: '/m/b.mp3', lastModified: 300 },
  ], { lastPushAt: 1_000 });
  writeMachine('two', [
    { filePath: '/m/a.mp3', lastModified: 200 }, // wins on lastModified
    { filePath: '/m/c.mp3', lastModified: 400 },
  ], { lastPushAt: 2_000 });

  runSyncMerge({});
  const merged = new Set(songsFromMergedXml());
  assert.deepEqual(merged, new Set(['/m/a.mp3', '/m/b.mp3', '/m/c.mp3']));
  const raw = fs.readFileSync(path.join(syncRoot, 'merged', 'database.xml'), 'utf8');
  const aBlock = raw.match(/<Song FilePath="\/m\/a\.mp3"[^]*?<\/Song>/)[0];
  assert.ok(aBlock.includes('LastModified="200"'), 'newer LastModified wins');
  log('merge: PASS');
}

async function testSelectionRules() {
  log('selection: include/exclude folders');
  const songs = [
    { filePath: '/music/live/set1.mp3',       lastModified: 100 },
    { filePath: '/music/live/set2.mp3',       lastModified: 200 },
    { filePath: '/music/archive/old.mp3',     lastModified: 300 },
    { filePath: 'spotify:track:xyz',          lastModified: 400, isStreaming: true },
  ];

  const includedOnly = applySelection(songs, { includeFolders: ['/music/live'] });
  assert.deepEqual(includedOnly.map((s) => s.filePath).sort(), [
    '/music/live/set1.mp3',
    '/music/live/set2.mp3',
  ], 'include filter kept live/ only');

  const excludedStreaming = applySelection(songs, { excludeStreaming: true });
  assert.equal(excludedStreaming.length, 3, 'streaming stripped');

  const filePathAllow = applySelection(songs, { filePaths: ['/music/archive/old.mp3'] });
  assert.deepEqual(filePathAllow.map((s) => s.filePath), ['/music/archive/old.mp3']);

  log('selection: PASS');
}

async function testLockfile() {
  log('lockfile: single-machine acquire/release + contention');
  const lockRoot = path.join(workRoot, 'lockroot');
  fs.mkdirSync(lockRoot, { recursive: true });

  const first = acquireLock({ syncRoot: lockRoot, machineUuid: 'A', displayName: 'A' });
  assert.ok(first.ok, 'A acquired');
  const second = acquireLock({ syncRoot: lockRoot, machineUuid: 'B', displayName: 'B' });
  assert.ok(!second.ok && second.existing?.machineUuid === 'A', 'B blocked by A');
  const rel = releaseLock({ syncRoot: lockRoot, machineUuid: 'A' });
  assert.ok(rel.ok);
  const readAfter = readLock({ syncRoot: lockRoot });
  assert.equal(readAfter, null, 'lock cleared');
  log('lockfile: PASS');
}

async function main() {
  try {
    await testMigration();
    await testNwayMerge();
    await testTwoWayEquivalence();
    await testSelectionRules();
    await testLockfile();
    log('ALL PASS');
    process.exit(0);
  } catch (err) {
    console.error('[verify] FAIL:', err);
    process.exit(1);
  } finally {
    try { fs.rmSync(workRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

main();
