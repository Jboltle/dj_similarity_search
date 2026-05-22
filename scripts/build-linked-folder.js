#!/usr/bin/env node
/**
 * Build a VirtualDJ "Folder" containing every song that participates in at
 * least one linked-tracks pair (extra.db.related_tracks).
 *
 * The output is a `<VirtualFolder>`-style `.vdjfolder` file under VirtualDJ's
 * Folders/ directory. VirtualDJ picks it up immediately on next launch (or on
 * sidebar refresh) as a static, manually-curated folder containing only the
 * songs you've linked.
 *
 * Source of truth is the live extra.db on this machine — NOT public/graph.json.
 * That way the folder is always in sync with the actual link state and works
 * even if you've never run `npm run parse`.
 *
 * Default mode is dry-run. Pass --write to actually create / overwrite the
 * .vdjfolder file. Existing files are backed up next to the original AND into
 * public/backups/linked-folder-<stamp>/.
 *
 * Flags:
 *   --write              Actually write the file (default: dry-run).
 *   --name <label>       Folder display name (default "Linked Tracks").
 *   --target <vdj-dir>   Override the VirtualDJ data folder.
 *   --extra-db <path>    Override the extra.db path (default: from --target).
 *   --out <path>         Override the full .vdjfolder output path.
 *   --force-wal          Write even if extra.db-wal/shm sidecars exist.
 *   --backup-dir <dir>   Override public/backups/.
 *   --no-backup          Skip backup of any existing folder file (requires --force).
 *   --force              Required to pair with --no-backup.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { XMLBuilder } from 'fast-xml-parser';
import { resolveVdjFolder, vdjFiles } from './lib/vdjPaths.js';
import { assertNoVdjRunning } from './lib/sqliteGuards.js';
import { timestampStamp } from './lib/syncBackups.js';
import { projectRoot as getProjectRoot } from './lib/machineId.js';

const DEFAULT_FOLDER_NAME = 'Linked Tracks';
const ATTR_PREFIX = '@_';

const XML_BUILDER = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: ATTR_PREFIX,
  format: true,
  indentBy: ' ',
  suppressEmptyNode: true,
});

function parseArgs(argv) {
  const args = {
    write: false,
    name: DEFAULT_FOLDER_NAME,
    target: null,
    extraDb: null,
    out: null,
    forceWal: false,
    backupDir: null,
    backup: true,
    force: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--write') args.write = true;
    else if (arg === '--name' && next) { args.name = next; i += 1; }
    else if (arg === '--target' && next) { args.target = next; i += 1; }
    else if (arg === '--extra-db' && next) { args.extraDb = next; i += 1; }
    else if (arg === '--out' && next) { args.out = next; i += 1; }
    else if (arg === '--force-wal') args.forceWal = true;
    else if (arg === '--backup-dir' && next) { args.backupDir = next; i += 1; }
    else if (arg === '--no-backup') args.backup = false;
    else if (arg === '--force') args.force = true;
  }
  return args;
}

function copyExtraDbToTemp(srcDbPath) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdj-linked-folder-'));
  const tmpDb = path.join(tmpDir, 'extra.db');
  fs.copyFileSync(srcDbPath, tmpDb);
  for (const ext of ['-wal', '-shm']) {
    const sidecar = `${srcDbPath}${ext}`;
    if (fs.existsSync(sidecar)) fs.copyFileSync(sidecar, `${tmpDb}${ext}`);
  }
  return { tmpDir, tmpDb };
}

/**
 * Returns the deduplicated set of file paths from track_data that participate
 * in at least one related_tracks pair. Streaming `netsearch://…` paths are
 * preserved as-is (VirtualDJ accepts them in folder entries).
 */
function readLinkedFilePaths(extraDbPath) {
  const { tmpDir, tmpDb } = copyExtraDbToTemp(extraDbPath);
  let db;
  try {
    db = new Database(tmpDb, { readonly: true, fileMustExist: true });
    const rows = db
      .prepare(
        `SELECT DISTINCT td.file AS file
         FROM track_data td
         WHERE EXISTS (
           SELECT 1 FROM related_tracks rt WHERE rt.sid1 = td.sid OR rt.sid2 = td.sid
         )
         ORDER BY file COLLATE NOCASE`
      )
      .all();
    const totals = db.prepare('SELECT COUNT(*) AS n FROM related_tracks').get();
    return {
      filePaths: rows.map((r) => r.file).filter((p) => p && String(p).trim() !== ''),
      totalRelatedPairs: totals.n,
    };
  } finally {
    if (db) db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function buildVirtualFolderXml({ name, filePaths }) {
  const songs = filePaths.map((p) => ({ [`${ATTR_PREFIX}path`]: p }));
  const folder = {
    VirtualFolder: {
      [`${ATTR_PREFIX}noDuplicates`]: 'false',
      [`${ATTR_PREFIX}name`]: name,
      song: songs,
    },
  };
  const body = XML_BUILDER.build(folder);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${body.endsWith('\n') ? body : `${body}\n`}`;
}

function ensureOutputPath({ vdjFolder, outOverride, name }) {
  if (outOverride) return path.resolve(outOverride);
  const sanitized = name.replace(/[\\/:*?"<>|]/g, '_');
  return path.join(vdjFolder, 'Folders', `${sanitized}.vdjfolder`);
}

function backupExistingFolder({ outPath, projectDir, backupDir, stamp }) {
  if (!fs.existsSync(outPath)) return null;
  const root = backupDir ? path.resolve(backupDir) : path.join(projectDir, 'public', 'backups');
  const folder = path.join(root, `linked-folder-${stamp}`);
  fs.mkdirSync(folder, { recursive: true });
  const base = path.basename(outPath);
  const mirror = path.join(folder, base);
  const sideBySide = `${outPath}.backup-${stamp}`;
  fs.copyFileSync(outPath, mirror);
  fs.copyFileSync(outPath, sideBySide);
  fs.writeFileSync(
    path.join(folder, 'manifest.json'),
    JSON.stringify(
      {
        kind: 'linked-folder',
        stamp,
        createdAt: new Date().toISOString(),
        originalPath: outPath,
        sideBySidePath: sideBySide,
      },
      null,
      2
    )
  );
  return { folder, mirror, sideBySide };
}

function writeFileAtomic(outPath, contents) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const staging = `${outPath}.djlinker-staging-${Date.now()}`;
  fs.writeFileSync(staging, contents);
  try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch { /* best effort */ }
  fs.renameSync(staging, outPath);
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
  const files = vdjFiles(vdjFolder);
  const extraDbPath = args.extraDb
    ? path.resolve(args.extraDb)
    : files.extraDb;

  if (!fs.existsSync(extraDbPath)) {
    throw new Error(`extra.db not found at ${extraDbPath}`);
  }

  const outPath = ensureOutputPath({ vdjFolder, outOverride: args.out, name: args.name });

  console.log(`[linked:folder] VDJ folder:   ${vdjFolder}`);
  console.log(`[linked:folder] extra.db:     ${extraDbPath}`);
  console.log(`[linked:folder] Output path:  ${outPath}`);
  console.log(`[linked:folder] Folder name:  ${args.name}`);
  console.log(`[linked:folder] Mode:         ${args.write ? 'WRITE' : 'DRY RUN'}`);

  // Reading the DB itself doesn't need the WAL guard (we copy to temp), but
  // writing the .vdjfolder file alongside VirtualDJ data should only happen
  // when VirtualDJ is closed so the running app picks up changes cleanly.
  if (args.write) {
    assertNoVdjRunning(extraDbPath, { forceWal: args.forceWal });
  }

  const { filePaths, totalRelatedPairs } = readLinkedFilePaths(extraDbPath);
  console.log(
    `[linked:folder] Found ${filePaths.length} unique linked songs across ${totalRelatedPairs} pairs.`
  );

  if (filePaths.length === 0) {
    console.log(
      '[linked:folder] No linked tracks found in extra.db. Link some songs in VirtualDJ first.'
    );
    return;
  }

  const xml = buildVirtualFolderXml({ name: args.name, filePaths });

  if (!args.write) {
    console.log('[linked:folder] Sample of paths that would be written:');
    for (const p of filePaths.slice(0, 5)) console.log(`  ${p}`);
    if (filePaths.length > 5) console.log(`  ... and ${filePaths.length - 5} more`);
    console.log('\n[linked:folder] Dry run complete. Re-run with --write to create the folder.');
    return;
  }

  const stamp = timestampStamp();
  let backup = null;
  if (args.backup) {
    backup = backupExistingFolder({
      outPath,
      projectDir,
      backupDir: args.backupDir,
      stamp,
    });
    if (backup) {
      console.log(`[linked:folder] Backed up existing folder → ${backup.folder}`);
    }
  }

  writeFileAtomic(outPath, xml);

  const sizeBytes = fs.statSync(outPath).size;
  console.log(`[linked:folder] Wrote ${sizeBytes} bytes → ${outPath}`);
  console.log(
    `[linked:folder] Done. Open VirtualDJ; "${args.name}" should appear under Folders in the sidebar.`
  );
}

try {
  main();
} catch (err) {
  console.error(`[linked:folder] ERROR: ${err.message}`);
  process.exitCode = 1;
}
