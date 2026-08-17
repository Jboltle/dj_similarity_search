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
import { fileURLToPath } from 'node:url';
import { resolveVdjFolder, vdjFiles } from './lib/vdjPaths.js';
import { assertNoVdjRunning } from './lib/sqliteGuards.js';
import { listBackups, restoreBackup, BACKUP_KIND } from './lib/syncBackups.js';

const LOG_SOURCE = 'sync:restore';

function makeLogger(onLog) {
  return {
    info(msg) {
      console.log(msg);
      onLog?.({ level: 'info', msg, source: LOG_SOURCE });
    },
    warn(msg) {
      console.warn(msg);
      onLog?.({ level: 'warn', msg, source: LOG_SOURCE });
    },
    error(msg) {
      console.error(msg);
      onLog?.({ level: 'error', msg, source: LOG_SOURCE });
    },
  };
}

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

function printBackupTable(backups, log) {
  if (backups.length === 0) {
    log.info('[sync:restore] No backups found.');
    return;
  }
  log.info('[sync:restore] Available backups:');
  log.info('  ' + ['STAMP', 'KIND', 'FILES'].join('  '.padEnd(4)));
  for (const b of backups) {
    const stamp = b.manifest.stamp ?? b.name;
    const kind = b.manifest.kind ?? '?';
    const files = Object.keys(b.manifest.files ?? {}).join(',') || '(no files)';
    log.info(`  ${stamp}  ${kind}  ${files}`);
  }
  log.info('');
  log.info('Restore a backup with: npm run sync:restore -- --stamp <STAMP> --write');
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

const CLI_DEFAULTS_RESTORE = {
  stamp: null,
  folder: null,
  target: null,
  backupDir: null,
  includeHistory: true,
  write: false,
  forceWal: false,
};

export async function runSyncRestore(args = {}) {
  const opts = { ...CLI_DEFAULTS_RESTORE, ...args };
  const log = makeLogger(opts.onLog);
  const result = { ok: false };

  try {
    const backups = listBackups({ backupRoot: opts.backupDir });

    if (!opts.stamp && !opts.folder) {
      printBackupTable(backups, log);
      result.ok = true;
      return result;
    }

    let chosenFolder = null;
    let chosenManifest = null;
    if (opts.folder) {
      chosenFolder = path.resolve(opts.folder);
      const manifestPath = path.join(chosenFolder, 'manifest.json');
      if (!fs.existsSync(manifestPath)) {
        throw new Error(`No manifest.json under ${chosenFolder}.`);
      }
      chosenManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } else {
      const match = findBackupByStamp(backups, opts.stamp);
      if (!match) {
        log.error(`[sync:restore] No backup matching stamp "${opts.stamp}". Available:`);
        printBackupTable(backups, log);
        throw new Error('No matching backup.');
      }
      chosenFolder = match.folder;
      chosenManifest = match.manifest;
    }

    const vdjFolder = resolveVdjFolder(opts.target);
    const localFiles = vdjFiles(vdjFolder);

    log.info(`[sync:restore] Backup folder: ${chosenFolder}`);
    log.info(`[sync:restore] Kind:          ${chosenManifest.kind ?? '?'}`);
    log.info(`[sync:restore] Stamp:         ${chosenManifest.stamp ?? '?'}`);
    log.info(`[sync:restore] Target VDJ:    ${vdjFolder}`);
    log.info(`[sync:restore] Mode:          ${opts.write ? 'WRITE' : 'DRY RUN'}`);

    if (opts.write) {
      assertNoVdjRunning(localFiles.extraDb, { forceWal: opts.forceWal });
    }

    const restoreResult = restoreBackup({
      backupFolder: chosenFolder,
      vdjFolder,
      write: opts.write,
      includeHistory: opts.includeHistory,
    });

    if (restoreResult.dryRun) {
      log.info('[sync:restore] Dry run OK — sha256s validated. Re-run with --write to apply.');
      result.ok = true;
      return result;
    }
    log.info('[sync:restore] Restore complete.');
    result.ok = true;
    return result;
  } catch (err) {
    log.error(`[sync:restore] ERROR: ${err.message}`);
    result.ok = false;
    result.error = err.message;
    return result;
  }
}

function main() {
  runSyncRestore(parseArgs(process.argv))
    .then((res) => {
      if (!res.ok && !process.exitCode) process.exitCode = 1;
    })
    .catch((err) => {
      console.error(`[sync:restore] ERROR: ${err.message}`);
      process.exitCode = 1;
    });
}

const invokedDirectly = (() => {
  try {
    const resolved = fs.realpathSync(process.argv[1] ?? '');
    const self = fs.realpathSync(fileURLToPath(import.meta.url));
    return resolved === self;
  } catch {
    return false;
  }
})();

if (invokedDirectly) main();
