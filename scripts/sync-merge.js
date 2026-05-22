#!/usr/bin/env node
/**
 * Regenerate sync/merged/ from sync/mac/ + sync/windows/ deterministically.
 *
 * Pure recomputation — never touches your local VirtualDJ folder. Safe to run
 * any time to inspect what the merge would produce. The output is what
 * sync:pull will apply to your local VDJ.
 *
 * Default: write to sync/merged/.
 * Flags:
 *   --out <dir>     Override destination folder (default sync/merged/).
 *   --prefer-local  When two Songs collide on LastModified, bias toward your
 *                   own side instead of the deterministic mac>windows default.
 *                   "local" here means whichever side matches the current OS.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { syncMachineDir, syncMergedDir, syncFolderFiles, resolveMachineId } from './lib/machineId.js';
import { mergeDatabaseXmlFiles, copyAndSortDatabaseXml } from './lib/databaseXmlMerge.js';
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

export function runSyncMerge({ outDir = null, preferLocal = false } = {}) {
  const macDir = syncMachineDir('mac');
  const winDir = syncMachineDir('windows');
  const dest = outDir ? path.resolve(outDir) : syncMergedDir();
  fs.mkdirSync(dest, { recursive: true });

  const macFiles = syncFolderFiles(macDir);
  const winFiles = syncFolderFiles(winDir);
  const destFiles = syncFolderFiles(dest);

  const macXml = existingFile(macFiles.databaseXml);
  const winXml = existingFile(winFiles.databaseXml);
  const macDb = existingFile(macFiles.extraDb);
  const winDb = existingFile(winFiles.extraDb);
  const macHistory = existingDir(macFiles.historyDir);
  const winHistory = existingDir(winFiles.historyDir);

  if (!macXml && !winXml && !macDb && !winDb && !macHistory && !winHistory) {
    throw new Error(
      `Both sync/mac/ and sync/windows/ are empty. Run \`npm run sync:push\` on each machine first.`
    );
  }

  const machineId = resolveMachineId(null);
  const isLocalMac = machineId === 'mac';

  let xmlReport = null;
  if (macXml && winXml) {
    const { localPath, remotePath, localLabel, remoteLabel } = isLocalMac
      ? { localPath: macXml, remotePath: winXml, localLabel: 'mac', remoteLabel: 'windows' }
      : { localPath: winXml, remotePath: macXml, localLabel: 'windows', remoteLabel: 'mac' };
    const { report } = mergeDatabaseXmlFiles({
      localPath,
      remotePath,
      outPath: destFiles.databaseXml,
      localLabel,
      remoteLabel,
      preferLocal,
    });
    xmlReport = report;
  } else if (macXml || winXml) {
    const single = macXml ?? winXml;
    const { report } = copyAndSortDatabaseXml({
      inputPath: single,
      outPath: destFiles.databaseXml,
      label: macXml ? 'mac' : 'windows',
    });
    xmlReport = report;
  }

  let dbReport = null;
  if (macDb && winDb) {
    const { localPath, remotePath } = isLocalMac
      ? { localPath: macDb, remotePath: winDb }
      : { localPath: winDb, remotePath: macDb };
    const { report } = mergeExtraDbFiles({
      localPath,
      remotePath,
      outPath: destFiles.extraDb,
    });
    dbReport = report;
  } else if (macDb || winDb) {
    const single = macDb ?? winDb;
    const { report } = copyExtraDbCanonical({
      inputPath: single,
      outPath: destFiles.extraDb,
      label: macDb ? 'mac' : 'windows',
    });
    dbReport = report;
  }

  let historyReport = null;
  if (macHistory || winHistory) {
    historyReport = mergeHistoryDirs({
      localDir: macHistory,
      remoteDir: winHistory,
      outDir: destFiles.historyDir,
      localLabel: 'mac',
      remoteLabel: 'windows',
    });
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    generatedOn: os.hostname(),
    generatedFromPlatform: process.platform,
    preferLocal,
    inputs: {
      mac: {
        databaseXml: macXml,
        extraDb: macDb,
        historyDir: macHistory,
      },
      windows: {
        databaseXml: winXml,
        extraDb: winDb,
        historyDir: winHistory,
      },
    },
    outputs: {
      databaseXml: xmlReport ? destFiles.databaseXml : null,
      extraDb: dbReport ? destFiles.extraDb : null,
      historyDir: historyReport ? destFiles.historyDir : null,
    },
    summary: {
      databaseXml: xmlReport
        ? {
            local: xmlReport.localCount,
            remote: xmlReport.remoteCount,
            merged: xmlReport.mergedCount,
            addedFromRemote: xmlReport.addedFromRemote,
            keptLocalOnTie: xmlReport.keptLocal,
            conflicts: xmlReport.conflicts?.length ?? 0,
            singleSource: xmlReport.singleSource ?? null,
          }
        : null,
      extraDb: dbReport,
      history: historyReport
        ? {
            localFileCount: historyReport.localFileCount,
            remoteFileCount: historyReport.remoteFileCount,
            mergedFileCount: historyReport.mergedFileCount,
            identicalDedup: historyReport.identicalDedup,
            collisionsSuffixed: historyReport.collisionsSuffixed,
          }
        : null,
    },
  };

  writeJson(destFiles.manifest, manifest);
  writeJson(path.join(dest, 'merge-report.json'), {
    manifest,
    xmlConflicts: xmlReport?.conflicts ?? [],
    historyDecisions: historyReport?.decisions ?? [],
  });

  return { dest, manifest };
}

function main() {
  const args = parseArgs(process.argv);
  console.log(`[sync:merge] sync/mac/   → ${syncMachineDir('mac')}`);
  console.log(`[sync:merge] sync/windows/ → ${syncMachineDir('windows')}`);
  console.log(`[sync:merge] output      → ${args.out ?? syncMergedDir()}`);

  const { dest, manifest } = runSyncMerge({ outDir: args.out, preferLocal: args.preferLocal });

  console.log('[sync:merge] ─── Summary ───────────────────────────────');
  if (manifest.summary.databaseXml) {
    const s = manifest.summary.databaseXml;
    if (s.singleSource) {
      console.log(`[sync:merge] database.xml: single source (${s.singleSource}), ${s.merged} songs`);
    } else {
      console.log(
        `[sync:merge] database.xml: local=${s.local}, remote=${s.remote}, merged=${s.merged}, ` +
          `added=${s.addedFromRemote}, conflicts=${s.conflicts}`
      );
    }
  } else {
    console.log('[sync:merge] database.xml: (no input)');
  }
  if (manifest.summary.extraDb) {
    const e = manifest.summary.extraDb;
    console.log(
      `[sync:merge] extra.db:    tracks ${e.mergedTrackCount} (conflicts ${e.trackConflicts}), ` +
        `pairs ${e.mergedPairCount} (added ${e.pairsAddedFromRemote})`
    );
  } else {
    console.log('[sync:merge] extra.db:    (no input)');
  }
  if (manifest.summary.history) {
    const h = manifest.summary.history;
    console.log(
      `[sync:merge] History/:    local=${h.localFileCount}, remote=${h.remoteFileCount}, ` +
        `merged=${h.mergedFileCount}, deduped=${h.identicalDedup}, collisions=${h.collisionsSuffixed}`
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
