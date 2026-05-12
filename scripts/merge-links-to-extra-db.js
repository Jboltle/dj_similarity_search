#!/usr/bin/env node
/**
 * Merge linked-track pairs from public/graph.json into a target extra.db so a
 * different machine sees the same `Linked Tracks` set in VirtualDJ.
 *
 * SAFETY MODEL
 * ────────────
 * 1. Default mode is dry-run — no changes are written without --write.
 * 2. The portable export (JSON + SQL + standalone .db) is produced on every
 *    run, regardless of dry-run or --write or whether the in-place merge
 *    succeeds. These artifacts are the fallback if the direct DB write
 *    can't run (VDJ running, schema mismatch, locked file, etc.).
 * 3. Direct writes are blocked if extra.db-wal or extra.db-shm exist next
 *    to the target. Use --force-wal to override (DANGEROUS).
 * 4. A timestamped backup is created before any in-place write.
 *
 * Output:
 *   public/linked-tracks-export.json  ← always
 *   public/linked-tracks-export.sql   ← always
 *   public/linked-tracks.db           ← always
 *   public/merge-extra-db-report.json ← always (summary of what happened)
 *
 * Exit codes:
 *   0  — success (whether export-only or full merge)
 *   1  — graph.json missing, malformed, or no linked pairs found
 *   2  — direct merge failed but exports were written successfully (fallback)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLinkedSongs, loadFromExportFile } from './lib/linkedSongs.js';
import { writeLinkedTracksExport } from './lib/linkedTracksExport.js';
import { mergePairsIntoExtraDb, resolveTargetPath } from './lib/extraDbWriter.js';

function parseArgs(argv) {
  const args = {
    target: null,
    from: null,
    write: false,
    forceWal: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--target' && argv[i + 1]) {
      args.target = argv[i + 1];
      i += 1;
    } else if (arg === '--from' && argv[i + 1]) {
      args.from = argv[i + 1];
      i += 1;
    } else if (arg === '--write') {
      args.write = true;
    } else if (arg === '--force-wal') {
      args.forceWal = true;
    }
  }
  return args;
}

function getProjectRoot() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..');
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function printExportFallbackInstructions({ exportInfo, targetPath, reason }) {
  console.error('');
  console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.error('  DIRECT MERGE FAILED — but your export artifacts are safe.');
  console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.error(`  Reason: ${reason}`);
  console.error('');
  if (exportInfo) {
    console.error('  All linked pairs were exported to:');
    console.error(`    • ${exportInfo.jsonPath}`);
    console.error(`    • ${exportInfo.sqlPath}`);
    console.error(`    • ${exportInfo.dbPath}`);
    console.error('');
    console.error('  To apply them manually when VirtualDJ is closed:');
    console.error('');
    console.error(`    sqlite3 "${targetPath}" < "${exportInfo.sqlPath}"`);
    console.error('');
  }
  console.error('  Or re-run this command after closing VirtualDJ:');
  console.error('');
  console.error('    npm run merge:links -- --write');
  console.error('');
  console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

function loadSource(args) {
  if (args.from) {
    console.log(`[merge] Source: portable export → ${args.from}`);
    return loadFromExportFile(args.from);
  }
  console.log(`[merge] Source: local public/graph.json`);
  return loadLinkedSongs();
}

async function main() {
  const args = parseArgs(process.argv);
  const projectRoot = getProjectRoot();
  const publicDir = path.join(projectRoot, 'public');

  const { pairs, meta, sourceType } = loadSource(args);
  console.log(`[merge] Loaded ${pairs.length} linked pairs (${sourceType}).`);

  if (pairs.length === 0) {
    throw new Error(
      args.from
        ? `No pairs found in export file ${args.from}.`
        : 'No vdj_link pairs found in graph.json. Run `npm run parse` first ' +
          'and confirm you have linked tracks in VirtualDJ.'
    );
  }

  // Only regenerate the portable exports when we're sourcing from graph.json.
  // If we were given an export file directly, it IS the export — re-writing
  // would either be a no-op (export → identical export) or destructive
  // (overwriting the file the user just handed us with our own version).
  let exportInfo = null;
  if (!args.from) {
    console.log('[merge] Writing portable export artifacts (always-on fallback)...');
    exportInfo = writeLinkedTracksExport({
      pairs,
      sourceMeta: meta,
      outDir: publicDir,
    });
    console.log(`[merge]   JSON: ${exportInfo.jsonPath}`);
    console.log(`[merge]   SQL:  ${exportInfo.sqlPath}`);
    console.log(`[merge]   .db:  ${exportInfo.dbPath}`);
    console.log(`[merge]   ${exportInfo.trackCount} unique tracks, ${exportInfo.pairCount} pairs`);
  } else {
    console.log('[merge] Source is already an export file; skipping re-export.');
  }

  const targetPath = resolveTargetPath(args.target);
  const dryRun = !args.write;

  const reportPath = path.join(publicDir, 'merge-extra-db-report.json');
  let mergeReport;
  let directMergeFailed = false;
  let failureReason = null;

  try {
    console.log(
      dryRun
        ? `\n[merge] DRY RUN: simulating merge into ${targetPath} (no changes will be written).`
        : `\n[merge] LIVE: merging into ${targetPath} ...`
    );

    mergeReport = mergePairsIntoExtraDb({
      targetPath,
      pairs,
      projectRoot,
      dryRun,
      forceWal: args.forceWal,
    });

    console.log(`[merge] Done. Tally:`);
    for (const [key, val] of Object.entries(mergeReport.tally)) {
      console.log(`[merge]   ${key.padEnd(24)} ${val}`);
    }
    if (mergeReport.backups) {
      console.log(`[merge] Backup written: ${mergeReport.backups.sideBySidePath}`);
      console.log(`[merge] Backup mirror:  ${mergeReport.backups.projectMirrorPath}`);
    }
    if (dryRun) {
      console.log(`\n[merge] Dry-run complete. Re-run with --write to commit.`);
    }
  } catch (err) {
    directMergeFailed = true;
    failureReason = err.message;
    mergeReport = {
      targetPath,
      dryRun,
      failed: true,
      error: err.message,
    };
    printExportFallbackInstructions({
      exportInfo,
      targetPath,
      reason: err.message,
    });
  }

  writeJson(reportPath, {
    generatedAt: new Date().toISOString(),
    sourceType,
    sourcePath: args.from ?? meta?.databasePath ?? null,
    targetPath,
    dryRun,
    write: args.write,
    forceWal: args.forceWal,
    directMergeFailed,
    failureReason,
    mergeReport,
    exports: exportInfo
      ? {
          jsonPath: exportInfo.jsonPath,
          sqlPath: exportInfo.sqlPath,
          dbPath: exportInfo.dbPath,
          trackCount: exportInfo.trackCount,
          pairCount: exportInfo.pairCount,
        }
      : null,
  });
  console.log(`[merge] Report written: ${reportPath}`);

  if (directMergeFailed) process.exitCode = 2;
}

main().catch((error) => {
  console.error(`[merge] FATAL: ${error.message}`);
  process.exitCode = 1;
});
