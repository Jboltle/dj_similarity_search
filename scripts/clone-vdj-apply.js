#!/usr/bin/env node
/**
 * Apply a snapshot folder (from clone:export) onto the local VirtualDJ install.
 * Default: dry-run. Pass --write to replace extra.db + database.xml, plus
 * History/ and Cache/ if either was included in the snapshot.
 *
 * Every replaced file/directory is first backed up next to its original (and
 * for files, mirrored into public/backups/clone-<stamp>/). If any step fails
 * mid-apply, all replacements are rolled back from those backups.
 *
 * @see scripts/lib/vdjClone.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveVdjFolder, vdjFiles } from './lib/vdjPaths.js';
import {
  MANIFEST_FILENAME,
  MANIFEST_SCHEMA_VERSION,
  assertNoVdjRunning,
  verifySqliteIntegrity,
  sha256FileSync,
  atomicReplaceFile,
  removeSqliteSidecars,
  backupVdjCloneTargets,
  timestampForCloneBackup,
  renameCacheForBackup,
  renameDirectoryForBackup,
  copyDirectoryRecursive,
  sha256CacheDirectoryAggregate,
  sha256DirectoryAggregate,
} from './lib/vdjClone.js';

function parseArgs(argv) {
  const args = {
    from: null,
    target: null,
    write: false,
    forceWal: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--from' && argv[i + 1]) {
      args.from = argv[i + 1];
      i += 1;
    } else if (arg === '--target' && argv[i + 1]) {
      args.target = argv[i + 1];
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
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function readManifest(snapshotDir) {
  const manifestPath = path.join(snapshotDir, MANIFEST_FILENAME);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `No ${MANIFEST_FILENAME} in ${snapshotDir}. Point --from at a folder produced by clone:export.`
    );
  }
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

function verifySnapshotAgainstManifest(snapshotDir, manifest) {
  const files = manifest.files ?? {};
  for (const [name, meta] of Object.entries(files)) {
    const abs = path.join(snapshotDir, name);
    if (!fs.existsSync(abs)) {
      throw new Error(`Snapshot missing file listed in manifest: ${name}`);
    }
    const st = fs.statSync(abs);
    if (st.size !== meta.bytes) {
      throw new Error(
        `Size mismatch for ${name}: manifest says ${meta.bytes} bytes, disk has ${st.size}.`
      );
    }
    const h = sha256FileSync(abs);
    if (h !== meta.sha256) {
      throw new Error(
        `SHA-256 mismatch for ${name}. Snapshot may be corrupt or truncated (e.g. unsafe USB eject).`
      );
    }
  }
  if (manifest.includesCache) {
    const cacheDir = path.join(snapshotDir, 'Cache');
    if (!fs.existsSync(cacheDir)) {
      throw new Error('Manifest declares includesCache but Cache/ is missing from snapshot.');
    }
    if (manifest.cacheFingerprint) {
      const fp = sha256CacheDirectoryAggregate(cacheDir);
      if (fp !== manifest.cacheFingerprint) {
        throw new Error('Cache/ fingerprint does not match manifest (corrupt or modified snapshot).');
      }
    }
  }
  if (manifest.includesHistory) {
    const historyDir = path.join(snapshotDir, 'History');
    if (!fs.existsSync(historyDir)) {
      throw new Error('Manifest declares includesHistory but History/ is missing from snapshot.');
    }
    if (manifest.historyFingerprint) {
      const fp = sha256DirectoryAggregate(historyDir);
      if (fp !== manifest.historyFingerprint) {
        throw new Error(
          'History/ fingerprint does not match manifest (corrupt or modified snapshot).'
        );
      }
    }
  }
}

function restoreFromBackups(backups) {
  if (!backups?.entries) return;
  for (const e of backups.entries) {
    if (fs.existsSync(e.sideBySidePath)) {
      fs.copyFileSync(e.sideBySidePath, e.original);
    }
  }
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.from) {
    throw new Error('Missing --from <snapshot-directory>.');
  }

  const snapshotDir = path.resolve(args.from);
  if (!fs.existsSync(snapshotDir)) {
    throw new Error(`Snapshot directory not found: ${snapshotDir}`);
  }

  const manifest = readManifest(snapshotDir);
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    console.warn(
      `[clone:apply] Warning: manifest schemaVersion is ${manifest.schemaVersion}, ` +
        `expected ${MANIFEST_SCHEMA_VERSION}. Proceeding if file layout matches.`
    );
  }

  verifySnapshotAgainstManifest(snapshotDir, manifest);

  const vdjFolder = resolveVdjFolder(args.target);
  const targetFiles = vdjFiles(vdjFolder);
  const projectRoot = getProjectRoot();
  const publicDir = path.join(projectRoot, 'public');
  const reportPath = path.join(publicDir, 'clone-apply-report.json');

  assertNoVdjRunning(targetFiles.extraDb, { forceWal: args.forceWal });

  const snapExtra = path.join(snapshotDir, 'extra.db');
  const snapXml = path.join(snapshotDir, 'database.xml');
  const snapCache = path.join(snapshotDir, 'Cache');
  const snapHistory = path.join(snapshotDir, 'History');

  console.log(`[clone:apply] Snapshot:  ${snapshotDir}`);
  console.log(`[clone:apply] Target VDJ: ${vdjFolder}`);
  console.log(`[clone:apply] Mode:      ${args.write ? 'WRITE' : 'DRY RUN (no changes)'}`);

  const report = {
    generatedAt: new Date().toISOString(),
    snapshotDir,
    targetVdjFolder: vdjFolder,
    dryRun: !args.write,
    manifestSchemaVersion: manifest.schemaVersion,
    includesCache: Boolean(manifest.includesCache),
    includesHistory: Boolean(manifest.includesHistory),
  };

  if (!args.write) {
    report.note = 'Re-run with --write after closing VirtualDJ to apply the snapshot.';
    fs.mkdirSync(publicDir, { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`[clone:apply] Dry run OK. Report → ${reportPath}`);
    return;
  }

  const stamp = timestampForCloneBackup();
  const mirrorDir = path.join(publicDir, 'backups', `clone-${stamp}`);
  const backups = backupVdjCloneTargets(targetFiles, { stamp, mirrorDir });
  report.backups = backups;

  let cacheRenamedTo = null;
  let historyRenamedTo = null;
  try {
    atomicReplaceFile(targetFiles.extraDb, snapExtra);
    removeSqliteSidecars(targetFiles.extraDb);

    atomicReplaceFile(targetFiles.databaseXml, snapXml);

    if (manifest.includesCache && fs.existsSync(snapCache)) {
      if (fs.existsSync(targetFiles.cacheDir)) {
        cacheRenamedTo = renameCacheForBackup(targetFiles.cacheDir, stamp);
        report.cacheBackedUpTo = cacheRenamedTo;
      }
      copyDirectoryRecursive(snapCache, targetFiles.cacheDir);
    }

    if (manifest.includesHistory && fs.existsSync(snapHistory)) {
      if (fs.existsSync(targetFiles.historyDir)) {
        historyRenamedTo = renameDirectoryForBackup(targetFiles.historyDir, stamp);
        report.historyBackedUpTo = historyRenamedTo;
      }
      copyDirectoryRecursive(snapHistory, targetFiles.historyDir);
    }

    const postIntegrity = verifySqliteIntegrity(targetFiles.extraDb);
    if (postIntegrity !== 'ok') {
      throw new Error(`Post-replace integrity_check failed: ${postIntegrity}`);
    }

    report.success = true;
    report.postIntegrity = postIntegrity;
    fs.mkdirSync(publicDir, { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`[clone:apply] Success. Report → ${reportPath}`);
  } catch (err) {
    console.error(`[clone:apply] ERROR: ${err.message}`);
    console.error('[clone:apply] Restoring from backups…');
    restoreFromBackups(backups);
    removeSqliteSidecars(targetFiles.extraDb);
    restoreRenamedDirectory(targetFiles.cacheDir, cacheRenamedTo);
    restoreRenamedDirectory(targetFiles.historyDir, historyRenamedTo);
    report.success = false;
    report.error = err.message;
    report.restoredFromBackup = true;
    fs.mkdirSync(publicDir, { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    process.exitCode = 1;
  }
}

/**
 * Roll back a directory that was renamed aside before applying. Removes any
 * partially-copied replacement at `targetDir` and moves the backup back into
 * place. Best-effort: any cleanup failures are swallowed so we always attempt
 * every restore step.
 */
function restoreRenamedDirectory(targetDir, renamedTo) {
  if (!renamedTo || !fs.existsSync(renamedTo)) return;
  if (fs.existsSync(targetDir)) {
    try {
      fs.rmSync(targetDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  try {
    fs.renameSync(renamedTo, targetDir);
  } catch {
    /* ignore */
  }
}

try {
  main();
} catch (err) {
  console.error(`[clone:apply] ERROR: ${err.message}`);
  process.exitCode = 1;
}
