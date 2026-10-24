/**
 * Compare an audio-library scan (relative paths rooted at the user's shared
 * folder) against VirtualDJ's `database.xml` to figure out which library
 * files VDJ doesn't know about yet and which VDJ entries point at missing
 * library files.
 *
 * All path comparison is done after normalizing to lowercase POSIX form —
 * same convention as scripts/lib/databaseXmlMerge.songKey. We never mutate
 * the inputs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { resolveLocalPath } from './audioLibrary.js';

const ATTR_PREFIX = '@_';
const FILE_PATH_ATTR = `${ATTR_PREFIX}FilePath`;
const ARRAY_TAGS = new Set(['Song', 'Link', 'Poi']);
const STREAMING_RE = /^(netsearch|http|https|spotify|tidal|deezer|youtube|soundcloud):/i;

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

/**
 * @typedef {Object} ClassifiedLibrary
 * @property {Array<{ relativePath: string, absolutePath: string, bytes: number, mtime: number }>} newFiles
 *   Files that are in the library but have no matching Song in database.xml.
 * @property {Array<{ relativePath: string, absolutePath: string }>} matched
 *   Library files that already have a Song entry pointing at them (nothing to do).
 * @property {Array<{ filePath: string, inferredRelative: string | null }>} missingFromLibrary
 *   Songs whose FilePath points inside the library root but the file no longer exists.
 * @property {Array<{ filePath: string, basename: string }>} crossMachineCandidates
 *   Songs with non-local FilePath but a basename that matches a library file —
 *   these are candidates for path rewriting on pull.
 * @property {number} totalLibraryFiles
 * @property {number} totalVdjSongs
 */

function normalizeComparable(absPath) {
  if (!absPath || typeof absPath !== 'string') return '';
  if (STREAMING_RE.test(absPath)) return absPath.trim();
  return absPath.replaceAll('\\', '/').replace(/\/+/g, '/').trim().toLowerCase();
}

function basenameLower(absPath) {
  if (!absPath) return '';
  const slashed = absPath.replaceAll('\\', '/');
  const idx = slashed.lastIndexOf('/');
  return (idx >= 0 ? slashed.slice(idx + 1) : slashed).toLowerCase();
}

/**
 * @param {string} absPath
 * @param {string} rootAbs
 * @returns {string | null}  POSIX relative path if `absPath` is inside `rootAbs`, else null.
 */
function withinRoot(absPath, rootAbs) {
  if (!absPath || !rootAbs) return null;
  const na = normalizeComparable(absPath);
  const nr = normalizeComparable(rootAbs);
  if (!na.startsWith(nr)) return null;
  const after = na.slice(nr.length).replace(/^\/+/, '');
  return after || null;
}

function readSongsFromXml(databaseXmlPath) {
  if (!databaseXmlPath || !fs.existsSync(databaseXmlPath)) return [];
  const raw = fs.readFileSync(databaseXmlPath, 'utf8');
  const parsed = PARSER.parse(raw);
  const root = parsed?.VirtualDJ_Database ?? parsed?.virtualDJ_Database;
  if (!root) return [];
  const arr = root.Song;
  if (Array.isArray(arr)) return arr;
  if (arr) return [arr];
  return [];
}

/**
 * @param {Object} args
 * @param {string} args.audioLibraryRoot
 * @param {Array<{ relativePath: string, bytes: number, mtime: number }>} args.libraryEntries
 * @param {string} args.databaseXmlPath
 * @returns {ClassifiedLibrary}
 */
export function classifyLibrary({ audioLibraryRoot, libraryEntries, databaseXmlPath }) {
  const songs = readSongsFromXml(databaseXmlPath);

  // Index VDJ songs by normalized FilePath AND by basename (so cross-machine
  // paths that only differ in prefix can still be matched).
  const songsByComparable = new Map();
  const songsByBasename = new Map();
  for (const song of songs) {
    const fp = song?.[FILE_PATH_ATTR];
    if (!fp || typeof fp !== 'string') continue;
    const key = normalizeComparable(fp);
    if (key) songsByComparable.set(key, fp);
    const base = basenameLower(fp);
    if (base) {
      const list = songsByBasename.get(base) ?? [];
      list.push(fp);
      songsByBasename.set(base, list);
    }
  }

  const newFiles = [];
  const matched = [];
  const seenLibraryBasenames = new Map();

  for (const entry of libraryEntries) {
    const absolutePath = resolveLocalPath(audioLibraryRoot, entry.relativePath);
    if (!absolutePath) continue;
    const key = normalizeComparable(absolutePath);
    const base = basenameLower(entry.relativePath);
    seenLibraryBasenames.set(base, { relativePath: entry.relativePath, absolutePath });

    if (songsByComparable.has(key)) {
      matched.push({ relativePath: entry.relativePath, absolutePath });
    } else {
      newFiles.push({
        relativePath: entry.relativePath,
        absolutePath,
        bytes: entry.bytes || 0,
        mtime: entry.mtime || 0,
      });
    }
  }

  // Songs whose FilePath points inside the library root but the file is gone.
  const missingFromLibrary = [];
  for (const song of songs) {
    const fp = song?.[FILE_PATH_ATTR];
    if (!fp || typeof fp !== 'string') continue;
    if (STREAMING_RE.test(fp)) continue;
    const rel = withinRoot(fp, audioLibraryRoot);
    if (!rel) continue;
    const existsOnDisk = (() => {
      try { return fs.existsSync(fp); } catch { return false; }
    })();
    if (!existsOnDisk) {
      missingFromLibrary.push({ filePath: fp, inferredRelative: rel });
    }
  }

  // Non-local VDJ paths whose basename matches a library file — candidates
  // for cross-machine rewrite on the next sync pull.
  const crossMachineCandidates = [];
  for (const song of songs) {
    const fp = song?.[FILE_PATH_ATTR];
    if (!fp || typeof fp !== 'string') continue;
    if (STREAMING_RE.test(fp)) continue;
    const rel = withinRoot(fp, audioLibraryRoot);
    if (rel) continue;
    const existsOnDisk = (() => {
      try { return fs.existsSync(fp); } catch { return false; }
    })();
    if (existsOnDisk) continue;
    const base = basenameLower(fp);
    if (!base) continue;
    if (seenLibraryBasenames.has(base)) {
      crossMachineCandidates.push({ filePath: fp, basename: base });
    }
  }

  return {
    newFiles,
    matched,
    missingFromLibrary,
    crossMachineCandidates,
    totalLibraryFiles: libraryEntries.length,
    totalVdjSongs: songs.length,
  };
}

/**
 * Convenience helper used by sync-pull: given the merged N-way library
 * index, return the entries whose absolute path on THIS machine isn't
 * currently referenced by database.xml. Used to auto-ingest newly-arrived
 * tracks from the other machine.
 *
 * @param {Object} args
 * @param {string} args.audioLibraryRoot        This machine's root path.
 * @param {Array<{ relativePath: string, bytes: number, mtime: number }>} args.mergedIndex
 * @param {string} args.databaseXmlPath
 * @returns {Array<{ relativePath: string, absolutePath: string, bytes: number, mtime: number }>}
 */
export function entriesNotYetIngested({ audioLibraryRoot, mergedIndex, databaseXmlPath }) {
  const classified = classifyLibrary({
    audioLibraryRoot,
    libraryEntries: mergedIndex,
    databaseXmlPath,
  });
  return classified.newFiles;
}
