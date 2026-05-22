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
import { execFileSync, spawnSync } from 'node:child_process';
import { resolveVdjFolder, vdjFiles } from './lib/vdjPaths.js';
import { assertNoVdjRunning, verifySqliteIntegrity } from './lib/vdjClone.js';
import {
  syncMergedDir,
  syncFolderFiles,
  projectRoot as getProjectRoot,
} from './lib/machineId.js';
import {
  backupVdjFolder,
  pruneOldBackups,
  timestampStamp,
  BACKUP_KIND,
} from './lib/syncBackups.js';
import { runSyncMerge } from './sync-merge.js';
import { mergeDatabaseXmlFiles } from './lib/databaseXmlMerge.js';
import { mergeExtraDbFiles } from './lib/extraDbMerge.js';
import { mergeHistoryDirs } from './lib/historyMerge.js';

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

function applyMergedXmlToLocal({ mergedXml, localXml, stampedOut }) {
  return mergeDatabaseXmlFiles({
    localPath: localXml,
    remotePath: mergedXml,
    outPath: stampedOut,
    localLabel: 'local',
    remoteLabel: 'merged',
    preferLocal: true,
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

function main() {
  const args = parseArgs(process.argv);

  if (!args.backup && !args.force) {
    throw new Error(
      'Refusing to skip backup without --force. Pass --no-backup --force together (DANGEROUS).'
    );
  }

  const projectDir = getProjectRoot();
  const vdjFolder = resolveVdjFolder(args.target);
  const localFiles = vdjFiles(vdjFolder);
  const mergedDir = syncMergedDir();
  const mergedFiles = syncFolderFiles(mergedDir);

  console.log(`[sync:pull] Local VDJ:   ${vdjFolder}`);
  console.log(`[sync:pull] Merged dir:  ${mergedDir}`);
  console.log(`[sync:pull] Mode:        ${args.write ? 'WRITE' : 'DRY RUN'}`);

  if (args.git) {
    gitPull(projectDir);
  } else {
    console.log('[sync:pull] --no-git: skipped git pull.');
  }

  if (args.merge) {
    runSyncMerge({ outDir: mergedDir });
  } else {
    console.log('[sync:pull] --no-merge: assuming sync/merged/ is already up to date.');
  }

  if (!fs.existsSync(mergedFiles.databaseXml) && !fs.existsSync(mergedFiles.extraDb)) {
    throw new Error(
      `sync/merged/ has no database.xml or extra.db. Run \`npm run sync:push\` on at least one machine first.`
    );
  }

  if (args.write) {
    assertNoVdjRunning(localFiles.extraDb, { forceWal: args.forceWal });
  }

  const stamp = timestampStamp();
  let backupInfo = null;
  if (args.backup && args.write) {
    backupInfo = backupVdjFolder({
      vdjFolder,
      kind: BACKUP_KIND.PULL,
      stamp,
      backupRoot: args.backupDir,
      includeHistory: args.includeHistory,
      note: 'pre-pull snapshot of local VDJ folder',
    });
    console.log(`[sync:pull] Backup folder: ${backupInfo.folder}`);
  }

  if (args.backupOnly) {
    console.log('[sync:pull] --backup-only: exiting without writing.');
    return;
  }

  // ─── Plan / apply database.xml ────────────────────────────────────────
  let xmlPlan = null;
  if (fs.existsSync(mergedFiles.databaseXml)) {
    const tmpDir = fs.mkdtempSync(path.join(projectDir, '.tmp-sync-pull-'));
    try {
      const stagedXml = path.join(tmpDir, 'database.xml');
      if (fs.existsSync(localFiles.databaseXml)) {
        const { report } = applyMergedXmlToLocal({
          mergedXml: mergedFiles.databaseXml,
          localXml: localFiles.databaseXml,
          stampedOut: stagedXml,
        });
        xmlPlan = { stagedXml, report };
      } else {
        fs.copyFileSync(mergedFiles.databaseXml, stagedXml);
        xmlPlan = {
          stagedXml,
          report: { mergedCount: -1, addedFromRemote: -1, conflicts: [], note: 'no local database.xml; copied merged through' },
        };
      }
      if (args.write) {
        copyFileAtomic(xmlPlan.stagedXml, localFiles.databaseXml);
      }
    } finally {
      if (!args.write) {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      } else {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
  }

  // ─── Plan / apply extra.db ────────────────────────────────────────────
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
      if (args.write) {
        copyFileAtomic(dbPlan.stagedDb, localFiles.extraDb);
        removeSqliteSidecars(localFiles.extraDb);
      }
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  // ─── Plan / apply History ─────────────────────────────────────────────
  let historyPlan = null;
  if (args.includeHistory && fs.existsSync(mergedFiles.historyDir)) {
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
    if (args.write) {
      if (fs.existsSync(localFiles.historyDir)) {
        fs.rmSync(localFiles.historyDir, { recursive: true, force: true });
      }
      fs.renameSync(tmpHistory, localFiles.historyDir);
    } else {
      try { fs.rmSync(tmpHistory, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  if (args.write) {
    if (args.keepBackups != null) {
      const { pruned } = pruneOldBackups({
        backupRoot: args.backupDir,
        keep: args.keepBackups,
        kindPrefixes: [BACKUP_KIND.PULL],
      });
      if (pruned.length) console.log(`[sync:pull] Pruned ${pruned.length} old backup folder(s).`);
    }

    if (fs.existsSync(localFiles.extraDb)) {
      const post = verifySqliteIntegrity(localFiles.extraDb);
      console.log(`[sync:pull] Post-apply extra.db integrity: ${post}`);
    }
  }

  console.log('[sync:pull] ─── Summary ───────────────────────────────');
  if (xmlPlan) {
    const r = xmlPlan.report;
    if (r.note) {
      console.log(`[sync:pull] database.xml: ${r.note}`);
    } else {
      console.log(
        `[sync:pull] database.xml: merged=${r.mergedCount}, addedFromMerged=${r.addedFromRemote}, conflicts=${r.conflicts?.length ?? 0}`
      );
    }
  } else {
    console.log('[sync:pull] database.xml: (no merged input)');
  }
  if (dbPlan) {
    const r = dbPlan.report;
    if (r.note) console.log(`[sync:pull] extra.db:    ${r.note}`);
    else console.log(
      `[sync:pull] extra.db:    tracks ${r.mergedTrackCount}, pairs ${r.mergedPairCount} (added ${r.pairsAddedFromRemote})`
    );
  } else {
    console.log('[sync:pull] extra.db:    (no merged input)');
  }
  if (historyPlan) {
    const r = historyPlan.report;
    console.log(
      `[sync:pull] History/:    merged=${r.mergedFileCount} (local=${r.localFileCount}, remote=${r.remoteFileCount}, deduped=${r.identicalDedup}, collisions=${r.collisionsSuffixed})`
    );
  } else {
    console.log('[sync:pull] History/:    (skipped or no merged input)');
  }

  if (!args.write) {
    console.log(
      '\n[sync:pull] Dry run complete. Re-run with --write (and VirtualDJ closed) to apply.'
    );
    return;
  }

  if (args.runParse) {
    console.log('[sync:pull] Refreshing public/graph.json...');
    runParse(projectDir);
  }

  if (args.runLinkedFolder) {
    console.log(`[sync:pull] Regenerating "${args.linkedFolderName}" .vdjfolder from merged extra.db...`);
    runBuildLinkedFolder({
      cwd: projectDir,
      target: args.target,
      name: args.linkedFolderName,
      forceWal: args.forceWal,
    });
  }
}

try {
  main();
} catch (err) {
  console.error(`[sync:pull] ERROR: ${err.message}`);
  process.exitCode = 1;
}
