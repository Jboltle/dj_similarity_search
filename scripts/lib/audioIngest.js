/**
 * Insert new <Song> entries into VirtualDJ's database.xml for audio files
 * that live in the shared library but aren't yet tracked by VDJ.
 *
 * Safety rails:
 *   - Refuses to run while VirtualDJ has the extra.db open (WAL/SHM check).
 *   - Writes atomically via staging file + rename.
 *   - Produces a timestamped backup inside <projectRoot>/public/backups/.
 *
 * The ingested <Song> uses this machine's absolute path for FilePath so VDJ
 * on this machine can find and play the file. When the OTHER machine pulls
 * the database.xml, sync-pull rewrites FilePath to its own library root (via
 * the relative-path index). That way one physical file in Google Drive maps
 * to the right absolute path on each OS.
 */
import fs from 'node:fs';
import path from 'node:path';
import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import { timestampStamp } from './syncBackups.js';
import { projectRoot as getProjectRoot } from './machineId.js';

const ATTR_PREFIX = '@_';
const FILE_PATH_ATTR = `${ATTR_PREFIX}FilePath`;
const LAST_MODIFIED_ATTR = `${ATTR_PREFIX}LastModified`;
const SONG_LENGTH_ATTR = `${ATTR_PREFIX}SongLength`;
const ARRAY_TAGS = new Set(['Song', 'Link', 'Poi']);

const PARSER = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: ATTR_PREFIX,
  allowBooleanAttributes: true,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  preserveOrder: false,
  isArray: (name) => ARRAY_TAGS.has(name),
});

const BUILDER = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: ATTR_PREFIX,
  format: true,
  indentBy: ' ',
  suppressEmptyNode: true,
  suppressBooleanAttributes: false,
});

/**
 * Parse "Artist - Title (Remix).ext" style filenames into VirtualDJ's
 * Artist / Title / Remix tag triple. Falls back to using the whole basename
 * as the title when no " - " separator is present.
 */
function tagsFromFilename(absPath) {
  const base = path.basename(absPath, path.extname(absPath));
  const dashSplit = base.split(/\s[-–—]\s/);
  if (dashSplit.length < 2) {
    return { title: base.trim(), author: '', remix: '' };
  }
  const [artist, ...rest] = dashSplit;
  const remainder = rest.join(' - ');
  const remixMatch = remainder.match(/^(.*)\s*[\(\[]([^\)\]]+)[\)\]]\s*$/);
  if (remixMatch) {
    return {
      title: remixMatch[1].trim(),
      author: artist.trim(),
      remix: remixMatch[2].trim(),
    };
  }
  return { title: remainder.trim(), author: artist.trim(), remix: '' };
}

/**
 * Build the minimal <Song> JSON object that fast-xml-parser will serialize
 * back out as valid VirtualDJ XML. Only populates fields VDJ needs to show
 * the song in the browser; BPM, grid, and markers are blank until the user
 * (or the sync-pull from another machine) fills them in.
 */
function buildSongJson({ absolutePath, bytes, mtime }) {
  const tags = tagsFromFilename(absolutePath);
  const lastModified = Math.round((Number(mtime) || Date.now()) / 1000);
  const song = {
    [FILE_PATH_ATTR]: absolutePath,
    Tags: {
      [`${ATTR_PREFIX}Author`]: tags.author,
      [`${ATTR_PREFIX}Title`]: tags.title,
    },
    Infos: {
      [LAST_MODIFIED_ATTR]: String(lastModified),
      [`${ATTR_PREFIX}FileSize`]: String(Math.max(0, Math.round(Number(bytes) || 0))),
      [SONG_LENGTH_ATTR]: '0',
    },
  };
  if (tags.remix) {
    song.Tags[`${ATTR_PREFIX}Remix`] = tags.remix;
  }
  return song;
}

function readDbRoot(databaseXmlPath) {
  const raw = fs.readFileSync(databaseXmlPath, 'utf8');
  const parsed = PARSER.parse(raw);
  const root = parsed?.VirtualDJ_Database ?? parsed?.virtualDJ_Database;
  if (!root) {
    throw new Error(`database.xml at ${databaseXmlPath} is missing <VirtualDJ_Database>`);
  }
  return root;
}

function serializeDb(root) {
  const body = BUILDER.build({ VirtualDJ_Database: root });
  if (body.startsWith('<?xml')) return body.endsWith('\n') ? body : `${body}\n`;
  const out = `<?xml version="1.0" encoding="UTF-8"?>\n${body}`;
  return out.endsWith('\n') ? out : `${out}\n`;
}

function writeAtomic(outPath, contents) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const staging = `${outPath}.audio-ingest-staging-${Date.now()}`;
  fs.writeFileSync(staging, contents);
  try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch { /* best effort */ }
  fs.renameSync(staging, outPath);
}

function backupDatabaseXml(databaseXmlPath, stamp, backupDirOverride) {
  if (!fs.existsSync(databaseXmlPath)) return null;
  const projectDir = getProjectRoot();
  const root = backupDirOverride
    ? path.resolve(backupDirOverride)
    : path.join(projectDir, 'public', 'backups');
  const folder = path.join(root, `audio-ingest-${stamp}`);
  fs.mkdirSync(folder, { recursive: true });
  const mirror = path.join(folder, path.basename(databaseXmlPath));
  fs.copyFileSync(databaseXmlPath, mirror);
  return { folder, mirror };
}

function normalizeKey(absPath) {
  if (!absPath || typeof absPath !== 'string') return '';
  return absPath.replaceAll('\\', '/').replace(/\/+/g, '/').trim().toLowerCase();
}

/**
 * @param {Object} args
 * @param {string} args.databaseXmlPath                   Absolute path to database.xml we will mutate.
 * @param {Array<{ absolutePath: string, bytes?: number, mtime?: number }>} args.newFiles
 * @param {boolean} [args.backup=true]                     Create a timestamped backup of the pre-edit file.
 * @param {string} [args.backupDir]                        Override backup root (defaults to <project>/public/backups).
 * @param {boolean} [args.dryRun=false]                    If true, don't write — just return what would change.
 * @returns {{ ok: boolean, inserted: number, skipped: number, outPath: string, backup: { folder: string, mirror: string } | null, dryRun: boolean }}
 */
export function ingestNewFiles({
  databaseXmlPath,
  newFiles,
  backup = true,
  backupDir = null,
  dryRun = false,
}) {
  if (!databaseXmlPath || !fs.existsSync(databaseXmlPath)) {
    throw new Error(`database.xml not found at ${databaseXmlPath}`);
  }
  if (!Array.isArray(newFiles)) {
    throw new Error(`ingestNewFiles: newFiles must be an array`);
  }

  const root = readDbRoot(databaseXmlPath);
  const existing = Array.isArray(root.Song) ? root.Song : root.Song ? [root.Song] : [];
  const existingKeys = new Set();
  for (const song of existing) {
    const key = normalizeKey(song?.[FILE_PATH_ATTR]);
    if (key) existingKeys.add(key);
  }

  const toAppend = [];
  let skipped = 0;
  for (const entry of newFiles) {
    const abs = entry?.absolutePath;
    const key = normalizeKey(abs);
    if (!key) { skipped += 1; continue; }
    if (existingKeys.has(key)) { skipped += 1; continue; }
    toAppend.push(buildSongJson({
      absolutePath: abs,
      bytes: entry.bytes,
      mtime: entry.mtime,
    }));
    existingKeys.add(key);
  }

  if (toAppend.length === 0) {
    return { ok: true, inserted: 0, skipped, outPath: databaseXmlPath, backup: null, dryRun };
  }

  if (dryRun) {
    return { ok: true, inserted: toAppend.length, skipped, outPath: databaseXmlPath, backup: null, dryRun: true };
  }

  const nextRoot = { ...root, Song: existing.concat(toAppend) };
  const xml = serializeDb(nextRoot);

  const stamp = timestampStamp();
  const backupInfo = backup ? backupDatabaseXml(databaseXmlPath, stamp, backupDir) : null;
  writeAtomic(databaseXmlPath, xml);

  return {
    ok: true,
    inserted: toAppend.length,
    skipped,
    outPath: databaseXmlPath,
    backup: backupInfo,
    dryRun: false,
  };
}
