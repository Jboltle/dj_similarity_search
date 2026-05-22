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
 * Optional: `--export-dir /path/to/usb` copies those artifacts plus the report
 * to a second folder. In WSL, USB drives often have no `/mnt/g`; use a Windows
 * path instead, e.g. `--export-dir "G:\\vdj-exports"` (copy runs via Windows).
 *
 * Exit codes:
 *   0  — success (whether export-only or full merge)
 *   1  — graph.json missing, malformed, or no linked pairs found
 *   2  — direct merge failed but exports were written successfully (fallback)
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
    exportDir: null,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--target' && argv[i + 1]) {
      args.target = argv[i + 1];
      i += 1;
    } else if (arg === '--from' && argv[i + 1]) {
      args.from = argv[i + 1];
      i += 1;
    } else if (arg === '--export-dir' && argv[i + 1]) {
      args.exportDir = argv[i + 1];
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

function copyFileIfExists(src, dest) {
  if (!fs.existsSync(src)) return false;
  fs.copyFileSync(src, dest);
  return true;
}

const WSL_HOST_CMD = '/mnt/c/Windows/System32/cmd.exe';

function isWslWithWindowsHost() {
  if (process.platform !== 'linux') return false;
  if (!fs.existsSync(WSL_HOST_CMD)) return false;
  try {
    return fs.readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft');
  } catch {
    return true;
  }
}

/** Paths like G: G:\ G:/foo (USB / Windows drives) when running inside WSL. */
function isWindowsDriveExportPath(raw) {
  return /^[a-zA-Z]:(?:[\\/].*)?$/.test(raw.trim());
}

function normalizeWindowsExportDest(raw) {
  let s = raw.trim().replace(/\//g, '\\');
  if (/^[a-zA-Z]:$/.test(s)) return `${s}\\`;
  return s;
}

function wslPathToWindowsPath(wslPath) {
  try {
    return execFileSync('wslpath', ['-w', wslPath], { encoding: 'utf8' }).trim();
  } catch (err) {
    throw new Error(`wslpath failed for ${wslPath}: ${err.message}`);
  }
}

/**
 * USB / non-fixed drives often do not appear under /mnt/g in WSL. Copying via
 * the Windows host (cmd + wslpath) still reaches G:\… from Linux.
 */
function copyExportToWindowsDriveFromWsl(winDestDir, { exportInfo, fromPath, reportPath }) {
  const dest = normalizeWindowsExportDest(winDestDir).replace(/\\+$/, '');
  const isDriveRoot = /^[a-zA-Z]:$/i.test(dest);
  if (!isDriveRoot) {
    execFileSync(WSL_HOST_CMD, ['/c', 'mkdir', dest], { stdio: 'inherit' });
  }

  const wslSources = [];
  if (exportInfo) {
    wslSources.push(exportInfo.jsonPath, exportInfo.sqlPath, exportInfo.dbPath);
  } else {
    const sourceDir = path.dirname(path.resolve(fromPath));
    for (const name of ['linked-tracks-export.json', 'linked-tracks-export.sql', 'linked-tracks.db']) {
      const p = path.join(sourceDir, name);
      if (fs.existsSync(p)) wslSources.push(p);
    }
  }
  wslSources.push(reportPath);

  if (!exportInfo && fromPath && wslSources.length === 1) {
    throw new Error(
      `No linked-tracks-export.{json,sql,db} found next to ${fromPath}; nothing to copy to --export-dir.`
    );
  }

  for (const wslSrc of wslSources) {
    if (!fs.existsSync(wslSrc)) continue;
    const winSrc = wslPathToWindowsPath(wslSrc);
    const winOut = `${dest}\\${path.basename(wslSrc)}`;
    execFileSync(WSL_HOST_CMD, ['/c', 'copy', '/Y', winSrc, winOut], { stdio: 'inherit' });
  }
}

/**
 * WSL exposes Windows drives as /mnt/c, /mnt/g, etc. If the drive is not mounted,
 * /mnt/g does not exist and mkdir("/mnt/g") fails with EACCES (only root may
 * create new entries under /mnt).
 */
function ensureWritableExportDir(rawDir) {
  const resolved = path.resolve(rawDir.trim());
  const driveMount = resolved.match(/^(\/mnt\/[a-z])(?:\/|$)/i);
  if (driveMount) {
    const mountPoint = driveMount[1];
    if (!fs.existsSync(mountPoint)) {
      const letter = mountPoint.slice(-1).toUpperCase();
      throw new Error(
        `WSL does not have Windows drive ${letter}: mounted at ${mountPoint} (folder missing). ` +
          `From WSL, copy to the USB using a Windows path (no /mnt/g needed), e.g. ` +
          `npm run merge:links -- --export-dir "G:\\\\vdj-exports"`
      );
    }
  }
  if (fs.existsSync(resolved)) {
    if (!fs.statSync(resolved).isDirectory()) {
      throw new Error(`--export-dir must be a directory: ${resolved}`);
    }
    return resolved;
  }
  try {
    fs.mkdirSync(resolved, { recursive: true });
  } catch (err) {
    if (err?.code === 'EACCES' || err?.code === 'EPERM') {
      throw new Error(
        `Cannot create --export-dir (${resolved}): ${err.message}. ` +
          `If you meant a USB drive from WSL, use a path under an existing /mnt/... mount ` +
          `(see message above when the drive letter is missing), or run npm from Windows with G:\\\\...`
      );
    }
    throw err;
  }
  return resolved;
}

/** Copy JSON + SQL + .db from a writeLinkedTracksExport result into destDir. */
function copyExportArtifacts(exportInfo, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const src of [exportInfo.jsonPath, exportInfo.sqlPath, exportInfo.dbPath]) {
    fs.copyFileSync(src, path.join(destDir, path.basename(src)));
  }
}

/** When --from points at an export JSON, copy sibling export files if present. */
function copyExportSiblingsFrom(fromJsonPath, destDir) {
  const sourceDir = path.dirname(path.resolve(fromJsonPath));
  const names = ['linked-tracks-export.json', 'linked-tracks-export.sql', 'linked-tracks.db'];
  fs.mkdirSync(destDir, { recursive: true });
  let n = 0;
  for (const name of names) {
    const src = path.join(sourceDir, name);
    if (copyFileIfExists(src, path.join(destDir, name))) n += 1;
  }
  return n;
}

function copyToExportDir({ exportDir, exportInfo, fromPath, reportPath }) {
  const raw = exportDir.trim();
  if (isWindowsDriveExportPath(raw)) {
    if (isWslWithWindowsHost()) {
      copyExportToWindowsDriveFromWsl(raw, { exportInfo, fromPath, reportPath });
      console.log(`[merge] Copied export + report → ${normalizeWindowsExportDest(raw)} (via Windows)`);
      return;
    }
    if (process.platform !== 'win32') {
      throw new Error(
        'Windows-style G:\\ paths for --export-dir only work in WSL against Windows, or run npm on Windows.'
      );
    }
  }

  const destDir = ensureWritableExportDir(exportDir);
  if (exportInfo) {
    copyExportArtifacts(exportInfo, destDir);
  } else if (fromPath) {
    const n = copyExportSiblingsFrom(fromPath, destDir);
    if (n === 0) {
      throw new Error(
        `No linked-tracks-export.{json,sql,db} found next to ${fromPath}; nothing to copy to --export-dir.`
      );
    }
  }
  copyFileIfExists(reportPath, path.join(destDir, 'merge-extra-db-report.json'));
  console.log(`[merge] Copied export + report → ${destDir}`);
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

  if (args.exportDir?.trim()) {
    copyToExportDir({
      exportDir: args.exportDir,
      exportInfo,
      fromPath: args.from,
      reportPath,
    });
  }

  if (directMergeFailed) process.exitCode = 2;
}

main().catch((error) => {
  console.error(`[merge] FATAL: ${error.message}`);
  process.exitCode = 1;
});
