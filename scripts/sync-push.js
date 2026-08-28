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
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { XMLParser, XMLBuilder } from 'fast-xml-parser';
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
import { acquireLock, releaseLock } from './lib/syncLock.js';
import { applySelection, hasActiveRules } from './lib/selectionRules.js';
import { runSyncMerge } from './sync-merge.js';

const LOG_SOURCE = 'sync:push';

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

const XML_ATTR_PREFIX = '@_';
const XML_ARRAY_TAGS = new Set(['Song', 'Link', 'Poi']);

function filterSnapshotDatabaseXml({ databaseXmlPath, selectionRules, filePaths }) {
  if (!databaseXmlPath || !fs.existsSync(databaseXmlPath)) {
    return { kept: 0, total: 0 };
  }
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: XML_ATTR_PREFIX,
    allowBooleanAttributes: true,
    parseAttributeValue: false,
    parseTagValue: false,
    trimValues: true,
    preserveOrder: false,
    isArray: (name) => XML_ARRAY_TAGS.has(name),
  });
  const builder = new XMLBuilder({
    ignoreAttributes: false,
    attributeNamePrefix: XML_ATTR_PREFIX,
    format: true,
    indentBy: ' ',
    suppressEmptyNode: true,
  });

  const raw = fs.readFileSync(databaseXmlPath, 'utf8');
  const parsed = parser.parse(raw);
  const root = parsed?.VirtualDJ_Database ?? parsed?.virtualDJ_Database;
  if (!root) return { kept: 0, total: 0 };

  const songs = Array.isArray(root.Song) ? root.Song : root.Song ? [root.Song] : [];
  const total = songs.length;

  const summaries = songs.map((s) => ({
    filePath: String(s?.[`${XML_ATTR_PREFIX}FilePath`] ?? ''),
    lastModified: Number(s?.Infos?.[`${XML_ATTR_PREFIX}LastModified`] ?? 0) || 0,
    isStreaming: /^(netsearch|http|https|spotify|tidal|deezer|youtube|soundcloud):/i.test(
      String(s?.[`${XML_ATTR_PREFIX}FilePath`] ?? '')
    ),
    _song: s,
  }));

  const rulesForFilter = { ...(selectionRules ?? {}) };
  if (Array.isArray(filePaths) && filePaths.length > 0) rulesForFilter.filePaths = filePaths;

  const kept = applySelection(summaries, rulesForFilter);
  const keptSongs = kept.map((k) => k._song);

  const nextRoot = { ...root, Song: keptSongs };
  const body = builder.build({ VirtualDJ_Database: nextRoot });
  const finalXml = body.startsWith('<?xml') ? body : `<?xml version="1.0" encoding="UTF-8"?>\n${body}`;
  fs.writeFileSync(databaseXmlPath, finalXml.endsWith('\n') ? finalXml : `${finalXml}\n`);

  return { kept: keptSongs.length, total };
}

function snapshotLocalToSyncFolder({
  vdjFolder,
  syncDir,
  includeHistory,
  machineId,
  machineDisplayName,
  appVersion,
}) {
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

  const now = Date.now();
  const manifest = {
    machineId,
    machineUuid: machineId,
    displayName: machineDisplayName || machineId,
    hostname: os.hostname(),
    platform: process.platform,
    appVersion: appVersion || null,
    sourceVdjFolder: vdjFolder,
    generatedAt: new Date(now).toISOString(),
    lastPushAt: now,
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

const CLI_DEFAULTS_PUSH = {
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
  machineUuid: null,
  machineDisplayName: null,
  appVersion: null,
  selectionRules: null,
};

export async function runSyncPush(args = {}) {
  const opts = { ...CLI_DEFAULTS_PUSH, ...args };
  const log = makeLogger(opts.onLog);
  const result = { ok: false, backupFolder: null, commitSha: null };
  let lockHeld = false;
  let lockMachineId = null;
  let lockSyncRoot = null;

  try {
    if (!opts.backup && !opts.force) {
      throw new Error(
        'Refusing to skip backup without --force. Pass --no-backup --force together (DANGEROUS).'
      );
    }

    const machineId = resolveMachineId(opts.machineUuid ?? opts.as);
    const machineDisplayName =
      opts.machineDisplayName || (opts.as ? String(opts.as) : machineId);
    const projectDir = getProjectRoot();
    const vdjFolder = resolveVdjFolder(opts.source);
    const syncDir = syncMachineDir(machineId);
    const mergedDir = syncMergedDir();

    lockSyncRoot = path.dirname(path.dirname(syncDir));
    lockMachineId = machineId;
    const lockRes = acquireLock({
      syncRoot: lockSyncRoot,
      machineUuid: machineId,
      displayName: machineDisplayName,
    });
    if (!lockRes.ok) {
      const other = lockRes.existing;
      const who = other?.displayName || other?.machineUuid || 'another machine';
      throw new Error(
        `Sync lock is held by ${who} (acquired ${new Date(other?.acquiredAt ?? 0).toISOString()}). Retry in a few minutes.`
      );
    }
    lockHeld = true;

    log.info(`[sync:push] Machine id:   ${machineId}`);
    log.info(`[sync:push] Display name: ${machineDisplayName}`);
    log.info(`[sync:push] Local VDJ:    ${vdjFolder}`);
    log.info(`[sync:push] Sync folder:  ${syncDir}`);
    log.info(`[sync:push] Merged dir:   ${mergedDir}`);
    log.info(`[sync:push] Mode:         ${opts.dryRun ? 'DRY RUN' : 'WRITE'}`);

    const files = vdjFiles(vdjFolder);
    assertNoVdjRunning(files.extraDb, { forceWal: opts.forceWal });
    const integrity = verifySqliteIntegrity(files.extraDb);
    if (integrity !== 'ok') {
      throw new Error(`Local extra.db failed integrity_check: ${integrity}`);
    }

    const stamp = timestampStamp();
    const backups = [];
    if (opts.backup && !opts.dryRun) {
      const b1 = backupSyncSubfolder({
        syncSubfolder: syncDir,
        label: machineId,
        kind: BACKUP_KIND.PUSH,
        stamp,
        backupRoot: opts.backupDir,
        note: 'pre-push snapshot of sync/<machine>/',
      });
      if (b1) backups.push(b1.folder);
      const b2 = backupSyncSubfolder({
        syncSubfolder: mergedDir,
        label: 'merged',
        kind: BACKUP_KIND.PUSH,
        stamp,
        backupRoot: opts.backupDir,
        note: 'pre-push snapshot of sync/merged/',
      });
      if (b2) backups.push(b2.folder);
    }
    result.backupFolder = backups[0] ?? null;

    if (opts.backupOnly) {
      log.info(`[sync:push] --backup-only: ${backups.length} backup folder(s) written. Exiting.`);
      result.ok = true;
      return result;
    }

    if (opts.dryRun) {
      log.info('[sync:push] Dry run — would snapshot local VDJ → sync/<machine>/ and regenerate sync/merged/.');
      result.ok = true;
      return result;
    }

    const manifest = snapshotLocalToSyncFolder({
      vdjFolder,
      syncDir,
      includeHistory: opts.includeHistory,
      machineId,
      machineDisplayName,
      appVersion: opts.appVersion,
    });
    log.info(
      `[sync:push] Snapshot written: ${manifest.files['database.xml'].bytes}B xml, ${manifest.files['extra.db'].bytes}B db, history=${manifest.includesHistory}`
    );

    if (hasActiveRules(opts.selectionRules) || (Array.isArray(opts.filePaths) && opts.filePaths.length > 0)) {
      const filtered = filterSnapshotDatabaseXml({
        databaseXmlPath: syncFolderFiles(syncDir).databaseXml,
        selectionRules: opts.selectionRules,
        filePaths: opts.filePaths,
      });
      log.info(
        `[sync:push] Selection filter kept ${filtered.kept}/${filtered.total} songs in snapshot.`
      );
    }

    const { dest } = runSyncMerge({ outDir: mergedDir });
    log.info(`[sync:push] Re-merged → ${dest}`);

    if (opts.runLinkedFolder) {
      log.info(`[sync:push] Refreshing local Linked Tracks folder ("${opts.linkedFolderName}")…`);
      runBuildLinkedFolder({
        cwd: projectDir,
        source: opts.source,
        name: opts.linkedFolderName,
        forceWal: opts.forceWal,
      });
    }

    if (opts.keepBackups != null) {
      const { pruned } = pruneOldBackups({
        backupRoot: opts.backupDir,
        keep: opts.keepBackups,
        kindPrefixes: [BACKUP_KIND.PUSH],
      });
      if (pruned.length) log.info(`[sync:push] Pruned ${pruned.length} old backup folder(s).`);
    }

    if (!opts.git) {
      log.info('[sync:push] --no-git: skipped git operations.');
      result.ok = true;
      return result;
    }

    if (!gitHasChanges(projectDir)) {
      log.info('[sync:push] No changes under sync/ — nothing to commit.');
      result.ok = true;
      return result;
    }

    gitExec(['add', 'sync/'], { cwd: projectDir });
    const commitMsg =
      opts.message ??
      `sync: push from ${machineId} (${os.hostname()}) ${new Date().toISOString().slice(0, 19)}`;
    gitExec(['commit', '-m', commitMsg], { cwd: projectDir });
    log.info(`[sync:push] Committed: ${commitMsg}`);

    const sha = gitExec(['rev-parse', 'HEAD'], { cwd: projectDir, allowFail: true });
    if (sha) result.commitSha = sha;

    if (!opts.push) {
      log.info('[sync:push] --no-push: skipped `git push`.');
      result.ok = true;
      return result;
    }
    try {
      gitExec(['push'], { cwd: projectDir });
      log.info('[sync:push] Pushed to remote.');
      result.ok = true;
      return result;
    } catch (err) {
      log.error(
        `[sync:push] git push failed: ${err.message}\n` +
          '  Resolve manually (e.g. pull --rebase, then push) — the commit is local.'
      );
      process.exitCode = 2;
      result.ok = false;
      result.error = `git push failed: ${err.message}`;
      return result;
    }
  } catch (err) {
    log.error(`[sync:push] ERROR: ${err.message}`);
    result.ok = false;
    result.error = err.message;
    return result;
  } finally {
    if (lockHeld && lockSyncRoot && lockMachineId) {
      releaseLock({ syncRoot: lockSyncRoot, machineUuid: lockMachineId });
    }
  }
}

function main() {
  runSyncPush(parseArgs(process.argv))
    .then((res) => {
      if (!res.ok && !process.exitCode) process.exitCode = 1;
    })
    .catch((err) => {
      console.error(`[sync:push] ERROR: ${err.message}`);
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
