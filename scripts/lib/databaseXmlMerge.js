/**
 * Union-merge two VirtualDJ database.xml files at the Song level.
 *
 * Merge rules:
 *   1. Union by FilePath (case-insensitive for filesystem paths; exact for
 *      streaming URLs like `netsearch://sc…`).
 *   2. On collision, newer <Infos LastModified="…"> wins.
 *      Tie-breaker: portable FilePath (streaming://) beats OS-specific path.
 *      Second tie-breaker: preferred side wins (used to bias toward the
 *      current machine on otherwise identical entries).
 *   3. Output is sorted by normalized FilePath so the XML diffs stably in git.
 *   4. <VirtualDJ_Database Version="…"> uses the higher numeric version.
 *
 * We use a separate parser/builder pair from scripts/lib/xml.js because the
 * reader there intentionally strips the attribute prefix for ergonomics. For
 * round-trip serialization we need the prefix back so XMLBuilder can tell
 * attributes from child elements.
 */
import fs from 'node:fs';
import { XMLParser, XMLBuilder } from 'fast-xml-parser';

const ATTR_PREFIX = '@_';

const ARRAY_TAGS = new Set(['Song', 'Link', 'Poi']);

const MERGE_PARSER = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: ATTR_PREFIX,
  allowBooleanAttributes: true,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  preserveOrder: false,
  isArray: (name) => ARRAY_TAGS.has(name),
});

const MERGE_BUILDER = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: ATTR_PREFIX,
  format: true,
  indentBy: ' ',
  suppressEmptyNode: true,
  suppressBooleanAttributes: false,
});

const FILE_PATH_ATTR = `${ATTR_PREFIX}FilePath`;
const LAST_MODIFIED_ATTR = `${ATTR_PREFIX}LastModified`;
const VERSION_ATTR = `${ATTR_PREFIX}Version`;

const STREAMING_FILE_PATH_RE = /^(netsearch|http|https|spotify|tidal|deezer|youtube|soundcloud):/i;

/**
 * Lowercased, slash-normalized FilePath. Used only as the dedupe key — the
 * original FilePath is preserved verbatim in the surviving <Song> element.
 */
export function songKey(song) {
  const raw = song?.[FILE_PATH_ATTR];
  if (!raw || typeof raw !== 'string') return null;
  if (STREAMING_FILE_PATH_RE.test(raw)) return raw.trim();
  return raw.replaceAll('\\', '/').replace(/\/+/g, '/').trim().toLowerCase();
}

function isStreamingFilePath(raw) {
  if (!raw || typeof raw !== 'string') return false;
  return STREAMING_FILE_PATH_RE.test(raw);
}

/**
 * @returns {number} unix epoch seconds, or 0 when unavailable
 */
function songLastModified(song) {
  const infos = song?.Infos;
  if (!infos) return 0;
  const raw = infos[LAST_MODIFIED_ATTR];
  if (!raw) return 0;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : 0;
}

function chooseWinner(localSong, remoteSong, { preferLocal }) {
  const localTs = songLastModified(localSong);
  const remoteTs = songLastModified(remoteSong);

  if (localTs !== remoteTs) {
    return localTs > remoteTs
      ? { winner: localSong, loser: remoteSong, reason: 'newer_local' }
      : { winner: remoteSong, loser: localSong, reason: 'newer_remote' };
  }

  const localStreaming = isStreamingFilePath(localSong?.[FILE_PATH_ATTR]);
  const remoteStreaming = isStreamingFilePath(remoteSong?.[FILE_PATH_ATTR]);
  if (localStreaming !== remoteStreaming) {
    return localStreaming
      ? { winner: localSong, loser: remoteSong, reason: 'tie_streaming_local' }
      : { winner: remoteSong, loser: localSong, reason: 'tie_streaming_remote' };
  }

  return preferLocal
    ? { winner: localSong, loser: remoteSong, reason: 'tie_preferred_local' }
    : { winner: remoteSong, loser: localSong, reason: 'tie_preferred_remote' };
}

function parseXmlFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = MERGE_PARSER.parse(raw);
  return parsed;
}

function extractRoot(parsed) {
  const root = parsed?.VirtualDJ_Database ?? parsed?.virtualDJ_Database;
  if (!root) {
    throw new Error('database.xml is missing <VirtualDJ_Database> root element.');
  }
  return root;
}

function extractSongs(root) {
  if (!root) return [];
  const arr = root.Song;
  if (Array.isArray(arr)) return arr;
  if (arr) return [arr];
  return [];
}

function higherVersion(a, b) {
  const na = Number.parseInt(String(a ?? '').trim(), 10);
  const nb = Number.parseInt(String(b ?? '').trim(), 10);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na >= nb ? String(na) : String(nb);
  if (Number.isFinite(na)) return String(na);
  if (Number.isFinite(nb)) return String(nb);
  return a ?? b ?? null;
}

/**
 * Pure merge driver. Pass two parsed XMLs (each is the parsed.VirtualDJ_Database
 * root). Returns the merged root plus a structured report.
 *
 * @param {{ root: object, label: string }} local
 * @param {{ root: object, label: string }} remote
 */
export function mergeDatabaseRoots(local, remote, { preferLocal = true } = {}) {
  const localSongs = extractSongs(local.root);
  const remoteSongs = extractSongs(remote.root);

  const merged = new Map();
  const report = {
    localCount: localSongs.length,
    remoteCount: remoteSongs.length,
    addedFromRemote: 0,
    keptLocal: 0,
    conflicts: [],
  };

  for (const song of localSongs) {
    const key = songKey(song);
    if (!key) continue;
    merged.set(key, { song, origin: local.label });
  }

  for (const song of remoteSongs) {
    const key = songKey(song);
    if (!key) continue;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { song, origin: remote.label });
      report.addedFromRemote += 1;
      continue;
    }
    const { winner, reason } = chooseWinner(existing.song, song, { preferLocal });
    const winnerOrigin =
      winner === existing.song ? existing.origin : remote.label;
    if (winner !== existing.song) {
      merged.set(key, { song: winner, origin: remote.label });
    } else {
      report.keptLocal += 1;
    }
    report.conflicts.push({
      filePath: winner?.[FILE_PATH_ATTR] ?? null,
      winner: winnerOrigin,
      reason,
      localLastModified: songLastModified(existing.song),
      remoteLastModified: songLastModified(song),
    });
  }

  const sortedSongs = [...merged.values()]
    .map((entry) => entry.song)
    .sort((a, b) => {
      const ka = songKey(a) ?? '';
      const kb = songKey(b) ?? '';
      if (ka < kb) return -1;
      if (ka > kb) return 1;
      return 0;
    });

  const mergedRoot = {};
  const version = higherVersion(local.root?.[VERSION_ATTR], remote.root?.[VERSION_ATTR]);
  if (version != null) mergedRoot[VERSION_ATTR] = version;
  mergedRoot.Song = sortedSongs;

  report.mergedCount = sortedSongs.length;
  return { mergedRoot, report };
}

/**
 * High-level helper: read both files, merge, serialize, write.
 *
 * @param {{ localPath: string, remotePath: string, outPath: string, localLabel?: string, remoteLabel?: string, preferLocal?: boolean }} args
 */
export function mergeDatabaseXmlFiles({
  localPath,
  remotePath,
  outPath,
  localLabel = 'local',
  remoteLabel = 'remote',
  preferLocal = true,
}) {
  const localParsed = parseXmlFile(localPath);
  const remoteParsed = parseXmlFile(remotePath);

  const { mergedRoot, report } = mergeDatabaseRoots(
    { root: extractRoot(localParsed), label: localLabel },
    { root: extractRoot(remoteParsed), label: remoteLabel },
    { preferLocal }
  );

  const xml = serializeWithXmlDeclaration({ VirtualDJ_Database: mergedRoot });
  fs.writeFileSync(outPath, xml);

  return {
    outPath,
    localPath,
    remotePath,
    report,
  };
}

/**
 * When only one side is available, copy through with a stable re-sort so the
 * single-input case still produces a canonical, diff-stable file.
 */
export function copyAndSortDatabaseXml({ inputPath, outPath, label = 'local' }) {
  const parsed = parseXmlFile(inputPath);
  const root = extractRoot(parsed);
  const songs = extractSongs(root);
  const sorted = [...songs].sort((a, b) => {
    const ka = songKey(a) ?? '';
    const kb = songKey(b) ?? '';
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return 0;
  });
  const mergedRoot = {};
  if (root?.[VERSION_ATTR] != null) mergedRoot[VERSION_ATTR] = root[VERSION_ATTR];
  mergedRoot.Song = sorted;

  fs.writeFileSync(outPath, serializeWithXmlDeclaration({ VirtualDJ_Database: mergedRoot }));

  return {
    outPath,
    inputPath,
    report: {
      localCount: songs.length,
      remoteCount: 0,
      addedFromRemote: 0,
      keptLocal: songs.length,
      conflicts: [],
      mergedCount: sorted.length,
      singleSource: label,
    },
  };
}

/**
 * The XMLBuilder doesn't emit a `<?xml ?>` declaration on its own; VirtualDJ's
 * native file always starts with one, so we prepend it unconditionally.
 */
function serializeWithXmlDeclaration(jsonObj) {
  const body = MERGE_BUILDER.build(jsonObj);
  if (body.startsWith('<?xml')) return body.endsWith('\n') ? body : `${body}\n`;
  const out = `<?xml version="1.0" encoding="UTF-8"?>\n${body}`;
  return out.endsWith('\n') ? out : `${out}\n`;
}
