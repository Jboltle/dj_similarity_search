#!/usr/bin/env node
/**
 * Pull the canonical merged VirtualDJ snapshot from git and apply it on top
 * of the local VirtualDJ folder — additively, with full pre-write backup.
 *
 * Flow:
 *   1. (optional) `git pull` to grab the other machine's latest push.
 *   2. Regenerate sync/merged/ from sync/mac/ + sync/windows/ locally so we
 *      always work from a fresh deterministic merge (handles the case where
 *      the other side pushed raw data but didn't run a merge of its own).
 *   3. Back up the LOCAL VirtualDJ folder (database.xml, extra.db + sidecars,
 *      History/) — both side-by-side `.backup-<stamp>` and into
 *      public/backups/sync-pull-<stamp>/ with a manifest.
 *   4. Apply sync/merged/ → local VDJ folder:
 *        - database.xml  : second-pass newest-wins union of local + merged
 *                          (the user's recent local edits never lose).
 *        - extra.db      : additive union of merged rows into local extra.db.
 *        - History/      : file-level additive copy, content-hash deduped.
 *   5. (optional) Re-run `npm run parse` so public/graph.json reflects the
 *      newly merged data.
 *
 * Default mode is DRY RUN. Pass `--write` to actually modify the VDJ folder.
 *
 * Flags:
 *   --write                  Actually apply changes (otherwise dry-run).
 *   --target <vdj-folder>    Override local VDJ folder.
 *   --no-git                 Skip `git pull`.
 *   --no-merge               Skip the local re-merge step.
 *   --no-history             Don't touch local History/.
 *   --no-parse               Skip `npm run parse` at the end.
 *   --no-linked-folder       Skip regenerating the "Linked Tracks" .vdjfolder.
 *   --linked-folder-name     Folder display name (default "Linked Tracks").
 *   --force-wal              Apply even if extra.db-wal/shm sidecars exist.
 *   --backup-dir <dir>       Override public/backups/.
 *   --no-backup              Skip backup (DANGEROUS; requires --force).
 *   --backup-only            Take the backup, then exit without applying.
 *   --keep-backups <N>       Prune oldest sync-pull backups beyond N.
 *   --force                  Required to pair with --no-backup.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolveVdjFolder, vdjFiles } from './lib/vdjPaths.js';
import { assertNoVdjRunning, verifySqliteIntegrity } from './lib/sqliteGuards.js';
import {
  syncMergedDir,
  syncFolderFiles,
  projectRoot as getProjectRoot,
  resolveMachineId,
} from './lib/machineId.js';
import {
  backupVdjFolder,
  pruneOldBackups,
  timestampStamp,
  BACKUP_KIND,
} from './lib/syncBackups.js';
import { acquireLock, releaseLock } from './lib/syncLock.js';
import { runSyncMerge } from './sync-merge.js';
import { mergeDatabaseXmlFiles } from './lib/databaseXmlMerge.js';
import { mergeExtraDbFiles } from './lib/extraDbMerge.js';
import { mergeHistoryDirs } from './lib/historyMerge.js';
import { applySelection, hasActiveRules } from './lib/selectionRules.js';
import { XMLParser, XMLBuilder } from 'fast-xml-parser';

const LOG_SOURCE = 'sync:pull';

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
    write: false,
    target: null,
    git: true,
    merge: true,
    includeHistory: true,
    runParse: true,
    runLinkedFolder: true,
    linkedFolderName: 'Linked Tracks',
    forceWal: false,
    backupDir: null,
    backup: true,
    backupOnly: false,
    keepBackups: null,
    force: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--write') args.write = true;
    else if (arg === '--target' && next) { args.target = next; i += 1; }
    else if (arg === '--no-git') args.git = false;
    else if (arg === '--no-merge') args.merge = false;
    else if (arg === '--no-history') args.includeHistory = false;
    else if (arg === '--no-parse') args.runParse = false;
    else if (arg === '--no-linked-folder') args.runLinkedFolder = false;
    else if (arg === '--linked-folder-name' && next) { args.linkedFolderName = next; i += 1; }
    else if (arg === '--force-wal') args.forceWal = true;
    else if (arg === '--backup-dir' && next) { args.backupDir = next; i += 1; }
    else if (arg === '--no-backup') args.backup = false;
    else if (arg === '--backup-only') args.backupOnly = true;
    else if (arg === '--keep-backups' && next) { args.keepBackups = Number.parseInt(next, 10); i += 1; }
    else if (arg === '--force') args.force = true;
  }
  return args;
}

function gitPull(cwd) {
  try {
    const out = execFileSync('git', ['pull', '--ff-only'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (out.trim()) console.log(`[sync:pull] git pull → ${out.trim().split('\n').slice(-1)[0]}`);
  } catch (err) {
    throw new Error(
      `git pull failed: ${err.message}\nResolve manually (commit or stash local changes, then re-run).`
    );
  }
}

function runParse(cwd) {
  const result = spawnSync('node', ['scripts/parse-vdj-db.js'], { cwd, stdio: 'inherit' });
  if (result.status !== 0) {
    console.warn(`[sync:pull] parse step exited with code ${result.status}.`);
  }
}

function runBuildLinkedFolder({ cwd, target, name, forceWal }) {
  const args = ['scripts/build-linked-folder.js', '--write'];
  // sync:pull has already established VDJ should be closed (or --force-wal is OK);
  // pass --force-wal through so the linked-folder regeneration doesn't bail out
  // again on the same sidecars we just intentionally wrote past.
  if (forceWal) args.push('--force-wal');
  if (target) args.push('--target', target);
  if (name) args.push('--name', name);
  const result = spawnSync('node', args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) {
    console.warn(`[sync:pull] linked-folder step exited with code ${result.status}.`);
  }
}

function applyMergedXmlToLocal({ mergedXml, localXml, stampedOut, resolutions }) {
  return mergeDatabaseXmlFiles({
    localPath: localXml,
    remotePath: mergedXml,
    outPath: stampedOut,
    localLabel: 'local',
    remoteLabel: 'merged',
    preferLocal: true,
    resolutions,
  });
}

function copyFileAtomic(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const staging = `${dest}.djlinker-staging-${Date.now()}`;
  fs.copyFileSync(src, staging);
  try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch { /* best-effort */ }
  fs.renameSync(staging, dest);
}

function removeSqliteSidecars(mainDbPath) {
  for (const ext of ['-wal', '-shm']) {
    const p = `${mainDbPath}${ext}`;
    if (fs.existsSync(p)) {
      try { fs.unlinkSync(p); } catch { /* ignore */ }
    }
  }
}

function ensureBlankDir(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

const PULL_XML_ATTR_PREFIX = '@_';
const PULL_XML_ARRAY_TAGS = new Set(['Song', 'Link', 'Poi']);

function writeFilteredMergedXml({ inputPath, outputPath, selectionRules, filePaths }) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: PULL_XML_ATTR_PREFIX,
    allowBooleanAttributes: true,
    parseAttributeValue: false,
    parseTagValue: false,
    trimValues: true,
    preserveOrder: false,
    isArray: (name) => PULL_XML_ARRAY_TAGS.has(name),
  });
  const builder = new XMLBuilder({
    ignoreAttributes: false,
    attributeNamePrefix: PULL_XML_ATTR_PREFIX,
    format: true,
    indentBy: ' ',
    suppressEmptyNode: true,
  });
  const raw = fs.readFileSync(inputPath, 'utf8');
  const parsed = parser.parse(raw);
  const root = parsed?.VirtualDJ_Database ?? parsed?.virtualDJ_Database;
  if (!root) {
    fs.copyFileSync(inputPath, outputPath);
    return { kept: 0, total: 0 };
  }
  const songs = Array.isArray(root.Song) ? root.Song : root.Song ? [root.Song] : [];
  const summaries = songs.map((s) => ({
    filePath: String(s?.[`${PULL_XML_ATTR_PREFIX}FilePath`] ?? ''),
    lastModified: Number(s?.Infos?.[`${PULL_XML_ATTR_PREFIX}LastModified`] ?? 0) || 0,
    _song: s,
  }));
  const rules = { ...(selectionRules ?? {}) };
  if (Array.isArray(filePaths) && filePaths.length > 0) rules.filePaths = filePaths;
  const kept = applySelection(summaries, rules).map((k) => k._song);
  const nextRoot = { ...root, Song: kept };
  const body = builder.build({ VirtualDJ_Database: nextRoot });
  const final = body.startsWith('<?xml') ? body : `<?xml version="1.0" encoding="UTF-8"?>\n${body}`;
  fs.writeFileSync(outputPath, final.endsWith('\n') ? final : `${final}\n`);
  return { kept: kept.length, total: songs.length };
}

const CLI_DEFAULTS_PULL = {
  write: false,
  target: null,
  git: true,
  merge: true,
  includeHistory: true,
  runParse: true,
  runLinkedFolder: true,
  linkedFolderName: 'Linked Tracks',
  forceWal: false,
  backupDir: null,
  backup: true,
  backupOnly: false,
  keepBackups: null,
  force: false,
  resolutions: null,
  filePaths: null,
  selectionRules: null,
};

export async function runSyncPull(args = {}) {
  const opts = { ...CLI_DEFAULTS_PULL, ...args };
  const log = makeLogger(opts.onLog);
  const result = { ok: false, backupFolder: null };
  let lockHeld = false;
  let lockMachineId = null;
  let lockSyncRoot = null;

  try {
    if (!opts.backup && !opts.force) {
      throw new Error(
        'Refusing to skip backup without --force. Pass --no-backup --force together (DANGEROUS).'
      );
    }

    const projectDir = getProjectRoot();
    const vdjFolder = resolveVdjFolder(opts.target);
    const localFiles = vdjFiles(vdjFolder);
    const mergedDir = syncMergedDir();
    const mergedFiles = syncFolderFiles(mergedDir);

    const machineId = resolveMachineId(null);
    lockSyncRoot = path.dirname(mergedDir);
    lockMachineId = machineId;
    const lockRes = acquireLock({
      syncRoot: lockSyncRoot,
      machineUuid: machineId,
      displayName: machineId,
    });
    if (!lockRes.ok) {
      const other = lockRes.existing;
      const who = other?.displayName || other?.machineUuid || 'another machine';
      throw new Error(
        `Sync lock is held by ${who} (acquired ${new Date(other?.acquiredAt ?? 0).toISOString()}). Retry in a few minutes.`
      );
    }
    lockHeld = true;

    log.info(`[sync:pull] Local VDJ:   ${vdjFolder}`);
    log.info(`[sync:pull] Merged dir:  ${mergedDir}`);
    log.info(`[sync:pull] Mode:        ${opts.write ? 'WRITE' : 'DRY RUN'}`);

    if (opts.git) {
      gitPull(projectDir);
    } else {
      log.info('[sync:pull] --no-git: skipped git pull.');
    }

    if (opts.merge) {
      runSyncMerge({ outDir: mergedDir, resolutions: opts.resolutions });
    } else {
      log.info('[sync:pull] --no-merge: assuming sync/merged/ is already up to date.');
    }

    if (!fs.existsSync(mergedFiles.databaseXml) && !fs.existsSync(mergedFiles.extraDb)) {
      throw new Error(
        `sync/merged/ has no database.xml or extra.db. Run \`npm run sync:push\` on at least one machine first.`
      );
    }

    if (opts.write) {
      assertNoVdjRunning(localFiles.extraDb, { forceWal: opts.forceWal });
    }

    const stamp = timestampStamp();
    let backupInfo = null;
    if (opts.backup && opts.write) {
      backupInfo = backupVdjFolder({
        vdjFolder,
        kind: BACKUP_KIND.PULL,
        stamp,
        backupRoot: opts.backupDir,
        includeHistory: opts.includeHistory,
        note: 'pre-pull snapshot of local VDJ folder',
      });
      log.info(`[sync:pull] Backup folder: ${backupInfo.folder}`);
      result.backupFolder = backupInfo.folder;
    }

    if (opts.backupOnly) {
      log.info('[sync:pull] --backup-only: exiting without writing.');
      result.ok = true;
      return result;
    }

    let xmlPlan = null;
    if (fs.existsSync(mergedFiles.databaseXml)) {
      const tmpDir = fs.mkdtempSync(path.join(projectDir, '.tmp-sync-pull-'));
      try {
        const stagedXml = path.join(tmpDir, 'database.xml');
        let mergedXmlSource = mergedFiles.databaseXml;
        const activeSelection = hasActiveRules(opts.selectionRules)
          || (Array.isArray(opts.filePaths) && opts.filePaths.length > 0);
        if (activeSelection) {
          const filteredXml = path.join(tmpDir, 'merged-filtered.xml');
          const stats = writeFilteredMergedXml({
            inputPath: mergedFiles.databaseXml,
            outputPath: filteredXml,
            selectionRules: opts.selectionRules,
            filePaths: opts.filePaths,
          });
          log.info(`[sync:pull] Selection filter narrowed merged input to ${stats.kept}/${stats.total} songs.`);
          mergedXmlSource = filteredXml;
        }
        if (fs.existsSync(localFiles.databaseXml)) {
          const { report } = applyMergedXmlToLocal({
            mergedXml: mergedXmlSource,
            localXml: localFiles.databaseXml,
            stampedOut: stagedXml,
            resolutions: opts.resolutions,
          });
          xmlPlan = { stagedXml, report };
        } else {
          fs.copyFileSync(mergedXmlSource, stagedXml);
          xmlPlan = {
            stagedXml,
            report: { mergedCount: -1, addedFromRemote: -1, conflicts: [], note: 'no local database.xml; copied merged through' },
          };
        }
        if (opts.write) {
          copyFileAtomic(xmlPlan.stagedXml, localFiles.databaseXml);
        }
      } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }

    let dbPlan = null;
    if (fs.existsSync(mergedFiles.extraDb)) {
      const tmpDir = fs.mkdtempSync(path.join(projectDir, '.tmp-sync-pull-db-'));
      try {
        const stagedDb = path.join(tmpDir, 'extra.db');
        if (fs.existsSync(localFiles.extraDb)) {
          const integrity = verifySqliteIntegrity(localFiles.extraDb);
          if (integrity !== 'ok') {
            throw new Error(`Local extra.db failed integrity_check pre-apply: ${integrity}`);
          }
          const { report } = mergeExtraDbFiles({
            localPath: localFiles.extraDb,
            remotePath: mergedFiles.extraDb,
            outPath: stagedDb,
          });
          dbPlan = { stagedDb, report };
        } else {
          fs.copyFileSync(mergedFiles.extraDb, stagedDb);
          dbPlan = { stagedDb, report: { note: 'no local extra.db; copied merged through' } };
        }
        const postIntegrity = verifySqliteIntegrity(dbPlan.stagedDb);
        if (postIntegrity !== 'ok') {
          throw new Error(`Staged merged extra.db failed integrity_check: ${postIntegrity}`);
        }
        if (opts.write) {
          copyFileAtomic(dbPlan.stagedDb, localFiles.extraDb);
          removeSqliteSidecars(localFiles.extraDb);
        }
      } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }

    let historyPlan = null;
    if (opts.includeHistory && fs.existsSync(mergedFiles.historyDir)) {
      const tmpHistory = path.join(projectDir, `.tmp-sync-pull-history-${stamp}`);
      ensureBlankDir(tmpHistory);
      const report = mergeHistoryDirs({
        localDir: fs.existsSync(localFiles.historyDir) ? localFiles.historyDir : null,
        remoteDir: mergedFiles.historyDir,
        outDir: tmpHistory,
        localLabel: 'local',
        remoteLabel: 'merged',
      });
      historyPlan = { stagedDir: tmpHistory, report };
      if (opts.write) {
        if (fs.existsSync(localFiles.historyDir)) {
          fs.rmSync(localFiles.historyDir, { recursive: true, force: true });
        }
        fs.renameSync(tmpHistory, localFiles.historyDir);
      } else {
        try { fs.rmSync(tmpHistory, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }

    if (opts.write) {
      if (opts.keepBackups != null) {
        const { pruned } = pruneOldBackups({
          backupRoot: opts.backupDir,
          keep: opts.keepBackups,
          kindPrefixes: [BACKUP_KIND.PULL],
        });
        if (pruned.length) log.info(`[sync:pull] Pruned ${pruned.length} old backup folder(s).`);
      }

      if (fs.existsSync(localFiles.extraDb)) {
        const post = verifySqliteIntegrity(localFiles.extraDb);
        log.info(`[sync:pull] Post-apply extra.db integrity: ${post}`);
      }
    }

    log.info('[sync:pull] ─── Summary ───────────────────────────────');
    if (xmlPlan) {
      const r = xmlPlan.report;
      if (r.note) {
        log.info(`[sync:pull] database.xml: ${r.note}`);
      } else {
        log.info(
          `[sync:pull] database.xml: merged=${r.mergedCount}, addedFromMerged=${r.addedFromRemote}, conflicts=${r.conflicts?.length ?? 0}`
        );
      }
    } else {
      log.info('[sync:pull] database.xml: (no merged input)');
    }
    if (dbPlan) {
      const r = dbPlan.report;
      if (r.note) log.info(`[sync:pull] extra.db:    ${r.note}`);
      else log.info(
        `[sync:pull] extra.db:    tracks ${r.mergedTrackCount}, pairs ${r.mergedPairCount} (added ${r.pairsAddedFromRemote})`
      );
    } else {
      log.info('[sync:pull] extra.db:    (no merged input)');
    }
    if (historyPlan) {
      const r = historyPlan.report;
      log.info(
        `[sync:pull] History/:    merged=${r.mergedFileCount} (local=${r.localFileCount}, remote=${r.remoteFileCount}, deduped=${r.identicalDedup}, collisions=${r.collisionsSuffixed})`
      );
    } else {
      log.info('[sync:pull] History/:    (skipped or no merged input)');
    }

    if (!opts.write) {
      log.info(
        '\n[sync:pull] Dry run complete. Re-run with --write (and VirtualDJ closed) to apply.'
      );
      result.ok = true;
      return result;
    }

    if (opts.runParse) {
      log.info('[sync:pull] Refreshing public/graph.json...');
      runParse(projectDir);
    }

    if (opts.runLinkedFolder) {
      log.info(`[sync:pull] Regenerating "${opts.linkedFolderName}" .vdjfolder from merged extra.db...`);
      runBuildLinkedFolder({
        cwd: projectDir,
        target: opts.target,
        name: opts.linkedFolderName,
        forceWal: opts.forceWal,
      });
    }

    result.ok = true;
    return result;
  } catch (err) {
    log.error(`[sync:pull] ERROR: ${err.message}`);
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
  runSyncPull(parseArgs(process.argv))
    .then((res) => {
      if (!res.ok && !process.exitCode) process.exitCode = 1;
    })
    .catch((err) => {
      console.error(`[sync:pull] ERROR: ${err.message}`);
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
