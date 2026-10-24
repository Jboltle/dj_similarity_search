/**
 * Rewrite a database.xml file so Song entries whose FilePath points at the
 * shared audio library (on ANY machine) get redirected to this machine's
 * mount of that library.
 *
 * We identify "shared library" songs by basename + optional parent segments:
 * if a Song's FilePath, normalized, ends with any `relativePath` in the merged
 * audio-library index, we rewrite FilePath to `<thisMachineRoot>/<relativePath>`.
 *
 * This runs during sync-pull BEFORE the local-vs-merged XML merge, so the
 * subsequent union-merge sees paths that line up with the current OS.
 */
import fs from 'node:fs';
import path from 'node:path';
import { XMLParser, XMLBuilder } from 'fast-xml-parser';

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

const BUILDER = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: ATTR_PREFIX,
  format: true,
  indentBy: ' ',
  suppressEmptyNode: true,
  suppressBooleanAttributes: false,
});

/**
 * @typedef {Object} LibraryEntryRef
 * @property {string} relativePath   POSIX-style path from the library root.
 */

/** Normalize a FilePath to lowercase POSIX for suffix matching. */
function normalize(p) {
  if (!p || typeof p !== 'string') return '';
  return p.replaceAll('\\', '/').replace(/\/+/g, '/').trim().toLowerCase();
}

/**
 * Build an index that lets us resolve a FilePath to a library entry in O(1)
 * by basename. Collisions (two files with the same basename but different
 * parent dirs) resolve by trying longer suffixes.
 *
 * @param {LibraryEntryRef[]} entries
 * @returns {Map<string, string[]>}  basename-lowercase -> list of relative paths
 */
function indexByBasename(entries) {
  const map = new Map();
  for (const entry of entries) {
    const rel = typeof entry?.relativePath === 'string' ? entry.relativePath : '';
    const normalized = normalize(rel);
    if (!normalized) continue;
    const slash = normalized.lastIndexOf('/');
    const base = slash >= 0 ? normalized.slice(slash + 1) : normalized;
    const list = map.get(base) ?? [];
    list.push(normalized);
    map.set(base, list);
  }
  return map;
}

/**
 * Determine which library relativePath a given FilePath maps to, if any.
 * Uses longest-suffix match for disambiguation.
 */
function resolveLibraryMatch(filePath, byBasename) {
  const n = normalize(filePath);
  if (!n) return null;
  const slash = n.lastIndexOf('/');
  const base = slash >= 0 ? n.slice(slash + 1) : n;
  const candidates = byBasename.get(base);
  if (!candidates || candidates.length === 0) return null;
  let best = null;
  for (const rel of candidates) {
    if (n.endsWith(rel) && (!best || rel.length > best.length)) {
      best = rel;
    }
  }
  return best;
}

function toLocalAbsolute(audioLibraryRoot, relativePathPosix) {
  const parts = relativePathPosix.split('/').filter(Boolean);
  return path.join(audioLibraryRoot, ...parts);
}

/**
 * @param {Object} args
 * @param {string} args.inputPath         database.xml to read (merged, remote).
 * @param {string} args.outputPath        where to write the rewritten XML (safe to be the same file).
 * @param {string} args.audioLibraryRoot  this machine's library root.
 * @param {LibraryEntryRef[]} args.libraryEntries  merged index entries (relative paths).
 * @returns {{ rewritten: number, total: number }}
 */
export function rewriteDatabaseXmlToLocalLibrary({
  inputPath,
  outputPath,
  audioLibraryRoot,
  libraryEntries,
}) {
  if (!audioLibraryRoot || !Array.isArray(libraryEntries) || libraryEntries.length === 0) {
    // Nothing to do — just pass through so callers can always chain.
    if (inputPath !== outputPath) {
      fs.copyFileSync(inputPath, outputPath);
    }
    return { rewritten: 0, total: 0 };
  }
  if (!fs.existsSync(inputPath)) {
    throw new Error(`rewriteDatabaseXmlToLocalLibrary: input not found ${inputPath}`);
  }

  const raw = fs.readFileSync(inputPath, 'utf8');
  const parsed = PARSER.parse(raw);
  const root = parsed?.VirtualDJ_Database ?? parsed?.virtualDJ_Database;
  if (!root) {
    if (inputPath !== outputPath) fs.copyFileSync(inputPath, outputPath);
    return { rewritten: 0, total: 0 };
  }

  const songs = Array.isArray(root.Song) ? root.Song : root.Song ? [root.Song] : [];
  const byBasename = indexByBasename(libraryEntries);

  let rewritten = 0;
  for (const song of songs) {
    const fp = song?.[FILE_PATH_ATTR];
    if (!fp || typeof fp !== 'string') continue;
    if (STREAMING_RE.test(fp)) continue; // leave netsearch/soundcloud/etc alone
    const match = resolveLibraryMatch(fp, byBasename);
    if (!match) continue;
    const next = toLocalAbsolute(audioLibraryRoot, match);
    if (!next || next === fp) continue;
    song[FILE_PATH_ATTR] = next;
    rewritten += 1;
  }

  const body = BUILDER.build({ VirtualDJ_Database: root });
  const final = body.startsWith('<?xml')
    ? (body.endsWith('\n') ? body : `${body}\n`)
    : `<?xml version="1.0" encoding="UTF-8"?>\n${body.endsWith('\n') ? body : `${body}\n`}`;
  fs.writeFileSync(outputPath, final);

  return { rewritten, total: songs.length };
}

/**
 * Light wrapper that reads the merged library index JSON produced by
 * sync-merge. Returns the entries array (possibly empty) or null if the
 * file doesn't exist.
 */
export function readMergedLibraryIndex(indexPath) {
  if (!indexPath || !fs.existsSync(indexPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    if (!parsed || !Array.isArray(parsed.entries)) return null;
    return parsed;
  } catch {
    return null;
  }
}
