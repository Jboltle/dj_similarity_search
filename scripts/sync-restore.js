#!/usr/bin/env node
/**
 * Roll back the local VirtualDJ folder from a timestamped backup created by
 * `sync:pull --write` or `sync:push`.
 *
 * Usage:
 *   npm run sync:restore                       # list available backups
 *   npm run sync:restore -- --stamp <id>       # dry run validates checksums
 *   npm run sync:restore -- --stamp <id> --write
 *
 * Flags:
 *   --stamp <id>           Pick a backup by stamp (e.g. 2026-05-21T19-03-00-000Z).
 *                          Use 'latest' to pick the newest sync-pull backup.
 *   --folder <path>        Use a specific backup folder directly (skip discovery).
 *   --target <vdj-folder>  Override which VDJ folder to restore into.
 *   --backup-dir <dir>     Override public/backups/ when listing.
 *   --no-history           Don't touch local History/.
 *   --write                Actually perform the restore (default: dry-run).
 *   --force-wal            Restore even if extra.db-wal/shm sidecars exist.
 */
import path from 'node:path';
import fs from 'node:fs';
import { resolveVdjFolder, vdjFiles } from './lib/vdjPaths.js';
import { assertNoVdjRunning } from './lib/sqliteGuards.js';
import { listBackups, restoreBackup, BACKUP_KIND } from './lib/syncBackups.js';

function parseArgs(argv) {
  const args = {
    stamp: null,
    folder: null,
    target: null,
    backupDir: null,
    includeHistory: true,
    write: false,
    forceWal: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--stamp' && next) { args.stamp = next; i += 1; }
    else if (arg === '--folder' && next) { args.folder = next; i += 1; }
    else if (arg === '--target' && next) { args.target = next; i += 1; }
    else if (arg === '--backup-dir' && next) { args.backupDir = next; i += 1; }
    else if (arg === '--no-history') args.includeHistory = false;
    else if (arg === '--write') args.write = true;
    else if (arg === '--force-wal') args.forceWal = true;
  }
  return args;
}

function printBackupTable(backups) {
  if (backups.length === 0) {
    console.log('[sync:restore] No backups found.');
    return;
  }
  console.log('[sync:restore] Available backups:');
  console.log('  ' + ['STAMP', 'KIND', 'FILES'].join('  '.padEnd(4)));
  for (const b of backups) {
    const stamp = b.manifest.stamp ?? b.name;
    const kind = b.manifest.kind ?? '?';
    const files = Object.keys(b.manifest.files ?? {}).join(',') || '(no files)';
    console.log(`  ${stamp}  ${kind}  ${files}`);
  }
  console.log('');
  console.log('Restore a backup with: npm run sync:restore -- --stamp <STAMP> --write');
}

function findBackupByStamp(backups, stamp) {
  if (stamp === 'latest') {
    const pulls = backups
      .filter((b) => (b.manifest.kind ?? '').startsWith(BACKUP_KIND.PULL));
    return pulls[pulls.length - 1] ?? backups[backups.length - 1] ?? null;
  }
  return (
    backups.find((b) => (b.manifest.stamp ?? '') === stamp) ??
    backups.find((b) => b.name.includes(stamp)) ??
    null
  );
}

function main() {
  const args = parseArgs(process.argv);
  const backups = listBackups({ backupRoot: args.backupDir });

  if (!args.stamp && !args.folder) {
    printBackupTable(backups);
    return;
  }

  let chosenFolder = null;
  let chosenManifest = null;
  if (args.folder) {
    chosenFolder = path.resolve(args.folder);
    const manifestPath = path.join(chosenFolder, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`No manifest.json under ${chosenFolder}.`);
    }
    chosenManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } else {
    const match = findBackupByStamp(backups, args.stamp);
    if (!match) {
      console.error(`[sync:restore] No backup matching stamp "${args.stamp}". Available:`);
      printBackupTable(backups);
      throw new Error('No matching backup.');
    }
    chosenFolder = match.folder;
    chosenManifest = match.manifest;
  }

  const vdjFolder = resolveVdjFolder(args.target);
  const localFiles = vdjFiles(vdjFolder);

  console.log(`[sync:restore] Backup folder: ${chosenFolder}`);
  console.log(`[sync:restore] Kind:          ${chosenManifest.kind ?? '?'}`);
  console.log(`[sync:restore] Stamp:         ${chosenManifest.stamp ?? '?'}`);
  console.log(`[sync:restore] Target VDJ:    ${vdjFolder}`);
  console.log(`[sync:restore] Mode:          ${args.write ? 'WRITE' : 'DRY RUN'}`);

  if (args.write) {
    assertNoVdjRunning(localFiles.extraDb, { forceWal: args.forceWal });
  }

  const result = restoreBackup({
    backupFolder: chosenFolder,
    vdjFolder,
    write: args.write,
    includeHistory: args.includeHistory,
  });

  if (result.dryRun) {
    console.log('[sync:restore] Dry run OK — sha256s validated. Re-run with --write to apply.');
    return;
  }
  console.log('[sync:restore] Restore complete.');
}

try {
  main();
} catch (err) {
  console.error(`[sync:restore] ERROR: ${err.message}`);
  process.exitCode = 1;
}
