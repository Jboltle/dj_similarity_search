#!/usr/bin/env node
/**
 * Regenerate sync/merged/ from sync/machines/<id>/* deterministically.
 *
 * Pure recomputation — never touches your local VirtualDJ folder. Safe to run
 * any time to inspect what the merge would produce. The output is what
 * sync:pull will apply to your local VDJ.
 *
 * N-way strategy: sort machines by lastPushAt ascending (freshest last),
 * then fold pairwise via the existing 2-way mergers. Because the last
 * machine folded in wins ties, the freshest push is favored on
 * LastModified ties — which matches the pre-v2 behavior for two machines
 * and generalizes cleanly to N.
 *
 * Default: write to sync/merged/.
 * Flags:
 *   --out <dir>     Override destination folder (default sync/merged/).
 *   --prefer-local  When two Songs collide on LastModified, bias toward the
 *                   current machine's snapshot instead of the freshest.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  listSyncMachines,
  syncMachinesRoot,
  syncMergedDir,
  syncFolderFiles,
  resolveMachineId,
} from './lib/machineId.js';
import {
  mergeDatabaseXmlFiles,
  copyAndSortDatabaseXml,
} from './lib/databaseXmlMerge.js';
import { mergeExtraDbFiles, copyExtraDbCanonical } from './lib/extraDbMerge.js';
import { mergeHistoryDirs } from './lib/historyMerge.js';

function parseArgs(argv) {
  const args = { out: null, preferLocal: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out' && argv[i + 1]) {
      args.out = argv[i + 1];
      i += 1;
    } else if (arg === '--prefer-local') {
      args.preferLocal = true;
    }
  }
  return args;
}

function existingFile(p) {
  return p && fs.existsSync(p) ? p : null;
}

function existingDir(p) {
  if (!p || !fs.existsSync(p)) return null;
  try {
    return fs.statSync(p).isDirectory() ? p : null;
  } catch {
    return null;
  }
}

function writeJson(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
}

function machineDisplayNameFor(entry) {
  return entry?.manifest?.displayName || entry?.manifest?.machineDisplayName || entry.id;
}

function emptyDirectory(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    return;
  }
  for (const ent of fs.readdirSync(dir)) {
    fs.rmSync(path.join(dir, ent), { recursive: true, force: true });
  }
}

/**
 * Reduce every machine's database.xml into a single merged file by folding
 * pairwise. Each step uses the accumulator as "local" and the next machine
 * as "remote"; on the last fold, `preferLocal=false` means the freshest
 * pushing machine wins ties (which is what we want).
 */
function reduceDatabaseXmls({ machineEntries, destFile, preferLocal, resolutions }) {
  const withXml = machineEntries
    .map((e) => ({ entry: e, xml: existingFile(syncFolderFiles(e.dir).databaseXml) }))
    .filter((e) => e.xml);
  if (withXml.length === 0) return null;

  if (withXml.length === 1) {
    const only = withXml[0];
    const { report } = copyAndSortDatabaseXml({
      inputPath: only.xml,
      outPath: destFile,
      label: only.entry.id,
    });
    return { report, contributingMachines: [only.entry.id] };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdj-nway-xml-'));
  try {
    let accXml = withXml[0].xml;
    let accLabel = withXml[0].entry.id;
    const conflicts = [];
    let addedFromRemote = 0;
    let keptLocal = 0;
    let resolvedByUser = 0;
    let mergedCount = 0;

    for (let i = 1; i < withXml.length; i += 1) {
      const isLast = i === withXml.length - 1;
      const outXml = isLast
        ? destFile
        : path.join(tmpDir, `merge-${i}.xml`);
      const { report } = mergeDatabaseXmlFiles({
        localPath: accXml,
        remotePath: withXml[i].xml,
        outPath: outXml,
        localLabel: accLabel,
        remoteLabel: withXml[i].entry.id,
        preferLocal,
        resolutions,
      });
      addedFromRemote += report.addedFromRemote ?? 0;
      keptLocal += report.keptLocal ?? 0;
      resolvedByUser += report.resolvedByUser ?? 0;
      mergedCount = report.mergedCount ?? 0;
      for (const c of report.conflicts ?? []) {
        conflicts.push({ ...c, remoteMachine: withXml[i].entry.id });
      }
      accXml = outXml;
      accLabel = `merged(${accLabel}+${withXml[i].entry.id})`;
    }

    return {
      report: {
        localCount: -1,
        remoteCount: -1,
        addedFromRemote,
        keptLocal,
        resolvedByUser,
        mergedCount,
        conflicts,
      },
      contributingMachines: withXml.map((e) => e.entry.id),
    };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function reduceExtraDbs({ machineEntries, destFile }) {
  const withDb = machineEntries
    .map((e) => ({ entry: e, db: existingFile(syncFolderFiles(e.dir).extraDb) }))
    .filter((e) => e.db);
  if (withDb.length === 0) return null;

  if (withDb.length === 1) {
    const only = withDb[0];
    const { report } = copyExtraDbCanonical({
      inputPath: only.db,
      outPath: destFile,
      label: only.entry.id,
    });
    return { report, contributingMachines: [only.entry.id] };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdj-nway-db-'));
  try {
    let accDb = withDb[0].db;
    let mergedTrackCount = 0;
    let mergedPairCount = 0;
    let pairsAddedFromRemote = 0;
    let trackConflicts = 0;

    for (let i = 1; i < withDb.length; i += 1) {
      const isLast = i === withDb.length - 1;
      const outDb = isLast ? destFile : path.join(tmpDir, `merge-${i}.db`);
      const { report } = mergeExtraDbFiles({
        localPath: accDb,
        remotePath: withDb[i].db,
        outPath: outDb,
      });
      mergedTrackCount = report.mergedTrackCount ?? 0;
      mergedPairCount = report.mergedPairCount ?? 0;
      pairsAddedFromRemote += report.pairsAddedFromRemote ?? 0;
      trackConflicts += report.trackConflicts ?? 0;
      accDb = outDb;
    }

    return {
      report: { mergedTrackCount, mergedPairCount, pairsAddedFromRemote, trackConflicts },
      contributingMachines: withDb.map((e) => e.entry.id),
    };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function reduceHistories({ machineEntries, destDir }) {
  const withHistory = machineEntries
    .map((e) => ({ entry: e, dir: existingDir(syncFolderFiles(e.dir).historyDir) }))
    .filter((e) => e.dir);
  if (withHistory.length === 0) return null;

  emptyDirectory(destDir);

  if (withHistory.length === 1) {
    const only = withHistory[0];
    const report = mergeHistoryDirs({
      localDir: only.dir,
      remoteDir: null,
      outDir: destDir,
      localLabel: only.entry.id,
      remoteLabel: 'none',
    });
    return { report, contributingMachines: [only.entry.id] };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdj-nway-history-'));
  try {
    const accDir = path.join(tmpDir, 'acc-0');
    fs.mkdirSync(accDir, { recursive: true });
    fs.cpSync(withHistory[0].dir, accDir, { recursive: true, errorOnExist: false });

    let currentAcc = accDir;
    let lastReport = null;
    for (let i = 1; i < withHistory.length; i += 1) {
      const isLast = i === withHistory.length - 1;
      const out = isLast ? destDir : path.join(tmpDir, `acc-${i}`);
      if (!isLast) fs.mkdirSync(out, { recursive: true });
      lastReport = mergeHistoryDirs({
        localDir: currentAcc,
        remoteDir: withHistory[i].dir,
        outDir: out,
        localLabel: 'merged-so-far',
        remoteLabel: withHistory[i].entry.id,
      });
      currentAcc = out;
    }
    return {
      report: lastReport,
      contributingMachines: withHistory.map((e) => e.entry.id),
    };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

export function runSyncMerge({ outDir = null, preferLocal = false, resolutions = null } = {}) {
  const machines = listSyncMachines();
  const dest = outDir ? path.resolve(outDir) : syncMergedDir();
  fs.mkdirSync(dest, { recursive: true });

  const destFiles = syncFolderFiles(dest);

  if (machines.length === 0) {
    throw new Error(
      `sync/machines/ is empty at ${syncMachinesRoot()}. Run \`npm run sync:push\` on each machine first.`
    );
  }

  const xml = reduceDatabaseXmls({
    machineEntries: machines,
    destFile: destFiles.databaseXml,
    preferLocal,
    resolutions,
  });
  const db = reduceExtraDbs({
    machineEntries: machines,
    destFile: destFiles.extraDb,
  });
  const history = reduceHistories({
    machineEntries: machines,
    destDir: destFiles.historyDir,
  });

  const currentMachineId = resolveMachineId(null);
  const manifest = {
    generatedAt: new Date().toISOString(),
    generatedOn: os.hostname(),
    generatedFromPlatform: process.platform,
    generatedByMachine: currentMachineId,
    preferLocal,
    machines: machines.map((m) => ({
      id: m.id,
      displayName: machineDisplayNameFor(m),
      platform: m.manifest?.platform ?? null,
      hostname: m.manifest?.hostname ?? null,
      lastPushAt: m.lastPushAt || null,
    })),
    outputs: {
      databaseXml: xml ? destFiles.databaseXml : null,
      extraDb: db ? destFiles.extraDb : null,
      historyDir: history ? destFiles.historyDir : null,
    },
    summary: {
      databaseXml: xml
        ? {
            merged: xml.report.mergedCount,
            addedFromRemote: xml.report.addedFromRemote,
            keptLocal: xml.report.keptLocal,
            conflicts: xml.report.conflicts?.length ?? 0,
            contributing: xml.contributingMachines,
            singleSource: xml.report.singleSource ?? null,
          }
        : null,
      extraDb: db
        ? {
            mergedTrackCount: db.report.mergedTrackCount,
            mergedPairCount: db.report.mergedPairCount,
            pairsAddedFromRemote: db.report.pairsAddedFromRemote,
            trackConflicts: db.report.trackConflicts,
            contributing: db.contributingMachines,
          }
        : null,
      history: history
        ? {
            localFileCount: history.report.localFileCount,
            remoteFileCount: history.report.remoteFileCount,
            mergedFileCount: history.report.mergedFileCount,
            identicalDedup: history.report.identicalDedup,
            collisionsSuffixed: history.report.collisionsSuffixed,
            contributing: history.contributingMachines,
          }
        : null,
    },
  };

  writeJson(destFiles.manifest, manifest);
  writeJson(path.join(dest, 'merge-report.json'), {
    manifest,
    xmlConflicts: xml?.report.conflicts ?? [],
    historyDecisions: history?.report.decisions ?? [],
  });

  return { dest, manifest };
}

function main() {
  const args = parseArgs(process.argv);
  const machines = listSyncMachines();
  console.log(`[sync:merge] machines root → ${syncMachinesRoot()}`);
  console.log(`[sync:merge] machines found → ${machines.length}`);
  for (const m of machines) {
    const name = machineDisplayNameFor(m);
    console.log(`[sync:merge]   ${m.id} (${name})`);
  }
  console.log(`[sync:merge] output → ${args.out ?? syncMergedDir()}`);

  const { dest, manifest } = runSyncMerge({ outDir: args.out, preferLocal: args.preferLocal });

  console.log('[sync:merge] ─── Summary ───────────────────────────────');
  if (manifest.summary.databaseXml) {
    const s = manifest.summary.databaseXml;
    if (s.singleSource) {
      console.log(`[sync:merge] database.xml: single source (${s.singleSource}), ${s.merged} songs`);
    } else {
      console.log(
        `[sync:merge] database.xml: merged=${s.merged}, added=${s.addedFromRemote}, conflicts=${s.conflicts}, from=[${s.contributing.join(', ')}]`
      );
    }
  } else {
    console.log('[sync:merge] database.xml: (no input)');
  }
  if (manifest.summary.extraDb) {
    const e = manifest.summary.extraDb;
    console.log(
      `[sync:merge] extra.db:    tracks ${e.mergedTrackCount} (conflicts ${e.trackConflicts}), pairs ${e.mergedPairCount} (added ${e.pairsAddedFromRemote})`
    );
  } else {
    console.log('[sync:merge] extra.db:    (no input)');
  }
  if (manifest.summary.history) {
    const h = manifest.summary.history;
    console.log(
      `[sync:merge] History/:    merged=${h.mergedFileCount} (dedup=${h.identicalDedup}, collisions=${h.collisionsSuffixed})`
    );
  } else {
    console.log('[sync:merge] History/:    (no input)');
  }
  console.log(`[sync:merge] Manifest → ${path.join(dest, 'manifest.json')}`);
  console.log(`[sync:merge] Report   → ${path.join(dest, 'merge-report.json')}`);
}

const invokedDirectly = (() => {
  try {
    const resolved = fs.realpathSync(process.argv[1] ?? '');
    const self = fs.realpathSync(new URL(import.meta.url).pathname);
    return resolved === self;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  try {
    main();
  } catch (err) {
    console.error(`[sync:merge] ERROR: ${err.message}`);
    process.exitCode = 1;
  }
}
