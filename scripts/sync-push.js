#!/usr/bin/env node
/**
 * Snapshot the local VirtualDJ folder into sync/<machine>/, regenerate
 * sync/merged/, and (optionally) commit + push the result to git.
 *
 * Read-only with respect to your local VirtualDJ data. The only files
 * created live in sync/ and public/backups/.
 *
 * Default behavior:
 *   1. Resolve which sync/<machine>/ folder we own (mac or windows).
 *   2. Back up the previous contents of that folder + sync/merged/ into
 *      public/backups/sync-push-<label>-<stamp>/ (skippable via --no-backup
 *      and --force, with a loud warning).
 *   3. Copy local database.xml, extra.db (+ sidecars), History/ into
 *      sync/<machine>/ + write a manifest.json.
 *   4. Run sync-merge to regenerate sync/merged/.
 *   5. With --git (default ON), stage + commit + push the sync/ changes.
 *
 * Flags:
 *   --as <mac|windows>     Override auto-detected machine id.
 *   --source <vdj-folder>  Override local VirtualDJ folder.
 *   --no-history           Skip History/ in the snapshot (keeps existing).
 *   --force-wal            Snapshot even if extra.db-wal/shm sidecars exist.
 *   --backup-dir <dir>     Override public/backups/.
 *   --no-backup            Skip pre-overwrite backup (requires --force).
 *   --backup-only          Take the backup, then exit without writing sync/.
 *   --keep-backups <N>     Prune oldest sync-push backups beyond N.
 *   --no-git               Don't touch git; just update sync/.
 *   --no-push              Stage + commit, but don't `git push`.
 *   --no-linked-folder     Skip refreshing the local Linked Tracks .vdjfolder.
 *   --linked-folder-name   Folder display name (default "Linked Tracks").
 *   --force                Required to pair with --no-backup.
 *   --dry-run              Plan + back up, but don't write sync/ or git.
 *   --message <msg>        Override commit message.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolveVdjFolder, vdjFiles } from './lib/vdjPaths.js';
import { assertNoVdjRunning, verifySqliteIntegrity } from './lib/sqliteGuards.js';
import {
  resolveMachineId,
  syncMachineDir,
  syncMergedDir,
  syncFolderFiles,
  projectRoot as getProjectRoot,
} from './lib/machineId.js';
import {
  backupSyncSubfolder,
  pruneOldBackups,
  timestampStamp,
  BACKUP_KIND,
} from './lib/syncBackups.js';
import { runSyncMerge } from './sync-merge.js';

function parseArgs(argv) {
  const args = {
    as: null,
    source: null,
    includeHistory: true,
    forceWal: false,
    backupDir: null,
    backup: true,
    backupOnly: false,
    keepBackups: null,
    git: true,
    push: true,
    runLinkedFolder: true,
    linkedFolderName: 'Linked Tracks',
    force: false,
    dryRun: false,
    message: null,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--as' && next) { args.as = next; i += 1; }
    else if (arg === '--source' && next) { args.source = next; i += 1; }
    else if (arg === '--no-history') args.includeHistory = false;
    else if (arg === '--force-wal') args.forceWal = true;
    else if (arg === '--backup-dir' && next) { args.backupDir = next; i += 1; }
    else if (arg === '--no-backup') args.backup = false;
    else if (arg === '--backup-only') args.backupOnly = true;
    else if (arg === '--keep-backups' && next) { args.keepBackups = Number.parseInt(next, 10); i += 1; }
    else if (arg === '--no-git') args.git = false;
    else if (arg === '--no-push') args.push = false;
    else if (arg === '--no-linked-folder') args.runLinkedFolder = false;
    else if (arg === '--linked-folder-name' && next) { args.linkedFolderName = next; i += 1; }
    else if (arg === '--force') args.force = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--message' && next) { args.message = next; i += 1; }
  }
  return args;
}

function runBuildLinkedFolder({ cwd, source, name, forceWal }) {
  const args = ['scripts/build-linked-folder.js', '--write'];
  if (forceWal) args.push('--force-wal');
  if (source) args.push('--target', source);
  if (name) args.push('--name', name);
  const result = spawnSync('node', args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) {
    console.warn(`[sync:push] linked-folder step exited with code ${result.status}.`);
  }
}

function sha256FileSync(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function sha256DirectoryAggregate(rootDir) {
  if (!fs.existsSync(rootDir)) return null;
  const rels = [];
  const stack = [rootDir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else rels.push(`${path.relative(rootDir, full).split(path.sep).join('/')}\0${sha256FileSync(full)}`);
    }
  }
  rels.sort();
  return crypto.createHash('sha256').update(rels.join('\n')).digest('hex');
}

function emptyDirectory(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    return;
  }
  for (const ent of fs.readdirSync(dir)) {
    if (ent === '.gitkeep') continue;
    fs.rmSync(path.join(dir, ent), { recursive: true, force: true });
  }
}

function copyDirectoryRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(src, dest, { recursive: true, errorOnExist: false });
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

function snapshotLocalToSyncFolder({ vdjFolder, syncDir, includeHistory, machineId }) {
  const files = vdjFiles(vdjFolder);
  emptyDirectory(syncDir);
  const dest = syncFolderFiles(syncDir);

  const manifestFiles = {};

  if (!fs.existsSync(files.databaseXml)) {
    throw new Error(`database.xml not found at ${files.databaseXml}`);
  }
  fs.copyFileSync(files.databaseXml, dest.databaseXml);
  manifestFiles['database.xml'] = {
    bytes: fs.statSync(dest.databaseXml).size,
    sha256: sha256FileSync(dest.databaseXml),
  };

  if (!fs.existsSync(files.extraDb)) {
    throw new Error(`extra.db not found at ${files.extraDb}`);
  }
  fs.copyFileSync(files.extraDb, dest.extraDb);
  manifestFiles['extra.db'] = {
    bytes: fs.statSync(dest.extraDb).size,
    sha256: sha256FileSync(dest.extraDb),
  };

  let historyFingerprint = null;
  if (includeHistory && fs.existsSync(files.historyDir)) {
    copyDirectoryRecursive(files.historyDir, dest.historyDir);
    historyFingerprint = sha256DirectoryAggregate(dest.historyDir);
  }

  const manifest = {
    machineId,
    hostname: os.hostname(),
    platform: process.platform,
    sourceVdjFolder: vdjFolder,
    generatedAt: new Date().toISOString(),
    includesHistory: Boolean(historyFingerprint),
    historyFingerprint,
    files: manifestFiles,
  };
  writeJson(dest.manifest, manifest);
  return manifest;
}

function gitExec(args, { cwd, allowFail = false } = {}) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    if (allowFail) return null;
    throw err;
  }
}

function gitHasChanges(cwd) {
  const out = gitExec(['status', '--porcelain', '--', 'sync/'], { cwd, allowFail: true });
  return Boolean(out && out.length > 0);
}

function main() {
  const args = parseArgs(process.argv);

  if (!args.backup && !args.force) {
    throw new Error(
      'Refusing to skip backup without --force. Pass --no-backup --force together (DANGEROUS).'
    );
  }

  const machineId = resolveMachineId(args.as);
  const projectDir = getProjectRoot();
  const vdjFolder = resolveVdjFolder(args.source);
  const syncDir = syncMachineDir(machineId);
  const mergedDir = syncMergedDir();

  console.log(`[sync:push] Machine id:   ${machineId}`);
  console.log(`[sync:push] Local VDJ:    ${vdjFolder}`);
  console.log(`[sync:push] Sync folder:  ${syncDir}`);
  console.log(`[sync:push] Merged dir:   ${mergedDir}`);
  console.log(`[sync:push] Mode:         ${args.dryRun ? 'DRY RUN' : 'WRITE'}`);

  const files = vdjFiles(vdjFolder);
  assertNoVdjRunning(files.extraDb, { forceWal: args.forceWal });
  const integrity = verifySqliteIntegrity(files.extraDb);
  if (integrity !== 'ok') {
    throw new Error(`Local extra.db failed integrity_check: ${integrity}`);
  }

  const stamp = timestampStamp();
  const backups = [];
  if (args.backup && !args.dryRun) {
    const b1 = backupSyncSubfolder({
      syncSubfolder: syncDir,
      label: machineId,
      kind: BACKUP_KIND.PUSH,
      stamp,
      backupRoot: args.backupDir,
      note: 'pre-push snapshot of sync/<machine>/',
    });
    if (b1) backups.push(b1.folder);
    const b2 = backupSyncSubfolder({
      syncSubfolder: mergedDir,
      label: 'merged',
      kind: BACKUP_KIND.PUSH,
      stamp,
      backupRoot: args.backupDir,
      note: 'pre-push snapshot of sync/merged/',
    });
    if (b2) backups.push(b2.folder);
  }

  if (args.backupOnly) {
    console.log(`[sync:push] --backup-only: ${backups.length} backup folder(s) written. Exiting.`);
    return;
  }

  if (args.dryRun) {
    console.log('[sync:push] Dry run — would snapshot local VDJ → sync/<machine>/ and regenerate sync/merged/.');
    return;
  }

  const manifest = snapshotLocalToSyncFolder({
    vdjFolder,
    syncDir,
    includeHistory: args.includeHistory,
    machineId,
  });
  console.log(`[sync:push] Snapshot written: ${manifest.files['database.xml'].bytes}B xml, ${manifest.files['extra.db'].bytes}B db, history=${manifest.includesHistory}`);

  const { dest } = runSyncMerge({ outDir: mergedDir });
  console.log(`[sync:push] Re-merged → ${dest}`);

  if (args.runLinkedFolder) {
    console.log(`[sync:push] Refreshing local Linked Tracks folder ("${args.linkedFolderName}")…`);
    runBuildLinkedFolder({
      cwd: projectDir,
      source: args.source,
      name: args.linkedFolderName,
      forceWal: args.forceWal,
    });
  }

  if (args.keepBackups != null) {
    const { pruned } = pruneOldBackups({
      backupRoot: args.backupDir,
      keep: args.keepBackups,
      kindPrefixes: [BACKUP_KIND.PUSH],
    });
    if (pruned.length) console.log(`[sync:push] Pruned ${pruned.length} old backup folder(s).`);
  }

  if (!args.git) {
    console.log('[sync:push] --no-git: skipped git operations.');
    return;
  }

  if (!gitHasChanges(projectDir)) {
    console.log('[sync:push] No changes under sync/ — nothing to commit.');
    return;
  }

  gitExec(['add', 'sync/'], { cwd: projectDir });
  const commitMsg =
    args.message ??
    `sync: push from ${machineId} (${os.hostname()}) ${new Date().toISOString().slice(0, 19)}`;
  gitExec(['commit', '-m', commitMsg], { cwd: projectDir });
  console.log(`[sync:push] Committed: ${commitMsg}`);

  if (!args.push) {
    console.log('[sync:push] --no-push: skipped `git push`.');
    return;
  }
  try {
    gitExec(['push'], { cwd: projectDir });
    console.log('[sync:push] Pushed to remote.');
  } catch (err) {
    console.error(
      `[sync:push] git push failed: ${err.message}\n` +
        '  Resolve manually (e.g. pull --rebase, then push) — the commit is local.'
    );
    process.exitCode = 2;
  }
}

try {
  main();
} catch (err) {
  console.error(`[sync:push] ERROR: ${err.message}`);
  process.exitCode = 1;
}
