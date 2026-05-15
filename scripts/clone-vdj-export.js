#!/usr/bin/env node
/**
 * Snapshot VirtualDJ's extra.db (+ sidecars) and database.xml into a folder
 * (USB, network drive, etc.). Optional: include Cache/ (~multi-GB).
 *
 * @see scripts/lib/vdjClone.js
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveVdjFolder, vdjFiles } from './lib/vdjPaths.js';
import {
  MANIFEST_FILENAME,
  MANIFEST_SCHEMA_VERSION,
  assertNoVdjRunning,
  verifySqliteIntegrity,
  sha256FileSync,
  copyExtraDbWithSidecars,
  copyDirectoryRecursive,
  sha256CacheDirectoryAggregate,
} from './lib/vdjClone.js';

function parseArgs(argv) {
  const args = {
    to: null,
    source: null,
    includeCache: false,
    forceWal: false,
    overwrite: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--to' && argv[i + 1]) {
      args.to = argv[i + 1];
      i += 1;
    } else if (arg === '--source' && argv[i + 1]) {
      args.source = argv[i + 1];
      i += 1;
    } else if (arg === '--include-cache') {
      args.includeCache = true;
    } else if (arg === '--force-wal') {
      args.forceWal = true;
    } else if (arg === '--overwrite') {
      args.overwrite = true;
    }
  }
  return args;
}

function getProjectRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.to) {
    throw new Error('Missing --to <directory> for the snapshot output.');
  }

  const vdjFolder = resolveVdjFolder(args.source);
  const files = vdjFiles(vdjFolder);
  const dest = path.resolve(args.to);

  if (!fs.existsSync(files.extraDb)) {
    throw new Error(`extra.db not found at ${files.extraDb}`);
  }
  if (!fs.existsSync(files.databaseXml)) {
    throw new Error(`database.xml not found at ${files.databaseXml}`);
  }

  assertNoVdjRunning(files.extraDb, { forceWal: args.forceWal });

  const integrity = verifySqliteIntegrity(files.extraDb);
  if (integrity !== 'ok') {
    throw new Error(`Source extra.db failed integrity_check: ${integrity}`);
  }

  const manifestPath = path.join(dest, MANIFEST_FILENAME);
  if (fs.existsSync(manifestPath) && !args.overwrite) {
    throw new Error(
      `Snapshot folder already contains ${MANIFEST_FILENAME}: ${dest}\n` +
        'Pass --overwrite to replace this snapshot.'
    );
  }

  fs.mkdirSync(dest, { recursive: true });
  if (args.overwrite && fs.existsSync(manifestPath)) {
    fs.unlinkSync(manifestPath);
  }

  const destExtra = path.join(dest, 'extra.db');
  const destXml = path.join(dest, 'database.xml');
  const destCache = path.join(dest, 'Cache');

  console.log(`[clone:export] Source VDJ folder: ${vdjFolder}`);
  console.log(`[clone:export] Destination:        ${dest}`);

  copyExtraDbWithSidecars(files.extraDb, destExtra);
  fs.copyFileSync(files.databaseXml, destXml);

  let cacheFingerprint = null;
  if (args.includeCache) {
    if (!fs.existsSync(files.cacheDir)) {
      console.warn(`[clone:export] --include-cache but no Cache folder at ${files.cacheDir}`);
    } else {
      if (fs.existsSync(destCache)) fs.rmSync(destCache, { recursive: true, force: true });
      copyDirectoryRecursive(files.cacheDir, destCache);
      console.log(`[clone:export] Copied Cache/ (computing fingerprint…)`);
      cacheFingerprint = sha256CacheDirectoryAggregate(destCache);
    }
  }

  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    sourceHostname: os.hostname(),
    sourcePlatform: process.platform,
    sourceVdjFolder: vdjFolder,
    includesCache: args.includeCache && fs.existsSync(destCache),
    cacheFingerprint,
    files: {
      'extra.db': {
        bytes: fs.statSync(destExtra).size,
        sha256: sha256FileSync(destExtra),
      },
      'database.xml': {
        bytes: fs.statSync(destXml).size,
        sha256: sha256FileSync(destXml),
      },
    },
  };

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`[clone:export] Wrote ${MANIFEST_FILENAME}`);
  console.log('[clone:export] Done.');
  console.log('');
  console.log('On the other machine (VirtualDJ closed), run:');
  console.log(`  npm run clone:apply -- --from "${dest}" --write`);
}

try {
  main();
} catch (err) {
  console.error(`[clone:export] ERROR: ${err.message}`);
  process.exitCode = 1;
}
