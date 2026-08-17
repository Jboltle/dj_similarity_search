/**
 * Read-only diff of the local VirtualDJ folder against the sync repo's
 * merged snapshot. Never mutates either side. Powers the Sync tab UI:
 * "what would move if I pushed?" and "what would land if I pulled?".
 *
 * The diff spans three axes:
 *   - Songs from database.xml (by lowercased/normalized FilePath).
 *   - Related-track pairs from extra.db (by canonical (sid1, sid2) key).
 *   - History .m3u files (by filename).
 *
 * When the sync repo isn't reachable or `sync/merged/` is empty we return a
 * structurally-valid, `ready: false` result so the UI can render an empty
 * state instead of crashing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { songKey } from './databaseXmlMerge.js';
import { pairKey, readExtraDb } from './extraDbMerge.js';

const ATTR_PREFIX = '@_';
const FILE_PATH_ATTR = `${ATTR_PREFIX}FilePath`;
const LAST_MODIFIED_ATTR = `${ATTR_PREFIX}LastModified`;
const AUTHOR_ATTR = `${ATTR_PREFIX}Author`;
const ARTIST_ATTR = `${ATTR_PREFIX}Artist`;
const TITLE_ATTR = `${ATTR_PREFIX}Title`;

const ARRAY_TAGS = new Set(['Song', 'Link', 'Poi']);

const DIFF_PARSER = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: ATTR_PREFIX,
  allowBooleanAttributes: true,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  preserveOrder: false,
  isArray: (name) => ARRAY_TAGS.has(name),
});

function makeEmptyDiff(reason) {
  return {
    ready: false,
    reason,
    songs: { localOnly: [], remoteOnly: [], conflicts: [] },
    linkedPairs: { localOnly: [], remoteOnly: [] },
    history: { localOnly: [], remoteOnly: [] },
  };
}

function parseSongsFromXml(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = DIFF_PARSER.parse(raw);
    const root = parsed?.VirtualDJ_Database ?? parsed?.virtualDJ_Database ?? {};
    const arr = root.Song;
    if (Array.isArray(arr)) return arr;
    if (arr) return [arr];
    return [];
  } catch {
    return [];
  }
}

function pickAttr(obj, ...attrs) {
  if (!obj) return '';
  for (const attr of attrs) {
    const val = obj[attr];
    if (val !== undefined && val !== null && val !== '') return String(val);
  }
  return '';
}

function songToSummary(song) {
  const filePath = pickAttr(song, FILE_PATH_ATTR);
  const tags = song?.Tags ?? {};
  const artist = pickAttr(tags, AUTHOR_ATTR, ARTIST_ATTR);
  const title = pickAttr(tags, TITLE_ATTR);
  const infos = song?.Infos ?? {};
  const rawLm = infos[LAST_MODIFIED_ATTR];
  const lastModified = rawLm ? Number.parseInt(String(rawLm), 10) || 0 : 0;
  const poi = song?.Poi;
  const poiCount = Array.isArray(poi) ? poi.length : poi ? 1 : 0;
  return { filePath, artist, title, lastModified, poiCount };
}

function indexBy(records, keyFn) {
  const map = new Map();
  for (const record of records) {
    const key = keyFn(record);
    if (key == null) continue;
    map.set(key, record);
  }
  return map;
}

function diffSongs(localSongs, remoteSongs) {
  const localByKey = indexBy(localSongs, songKey);
  const remoteByKey = indexBy(remoteSongs, songKey);

  const localOnly = [];
  const remoteOnly = [];
  const conflicts = [];

  for (const [key, localSong] of localByKey) {
    const remoteSong = remoteByKey.get(key);
    if (!remoteSong) {
      localOnly.push(songToSummary(localSong));
      continue;
    }
    const local = songToSummary(localSong);
    const remote = songToSummary(remoteSong);
    if (local.lastModified !== remote.lastModified) {
      conflicts.push({
        ...local,
        localLastModified: local.lastModified,
        remoteLastModified: remote.lastModified,
        winnerIfMerged: local.lastModified >= remote.lastModified ? 'local' : 'remote',
      });
    }
  }
  for (const [key, remoteSong] of remoteByKey) {
    if (!localByKey.has(key)) remoteOnly.push(songToSummary(remoteSong));
  }

  return { localOnly, remoteOnly, conflicts };
}

function trackToSongInfo(track) {
  if (!track) return { artist: '', title: '', filePath: null };
  return {
    artist: track.artist ?? '',
    title: track.title ?? '',
    filePath: track.file ?? null,
  };
}

function pairToSummary(pair, tracksBySid) {
  return {
    song1: trackToSongInfo(tracksBySid.get(String(pair.sid1))),
    song2: trackToSongInfo(tracksBySid.get(String(pair.sid2))),
  };
}

function diffLinkedPairs(localDbPath, remoteDbPath) {
  const local = fs.existsSync(localDbPath) ? readExtraDb(localDbPath) : { tracks: [], pairs: [] };
  const remote = fs.existsSync(remoteDbPath) ? readExtraDb(remoteDbPath) : { tracks: [], pairs: [] };

  const localTracksBySid = new Map(local.tracks.map((t) => [String(t.sid), t]));
  const remoteTracksBySid = new Map(remote.tracks.map((t) => [String(t.sid), t]));

  const localPairsByKey = indexBy(local.pairs, pairKey);
  const remotePairsByKey = indexBy(remote.pairs, pairKey);

  const localOnly = [];
  const remoteOnly = [];
  for (const [key, pair] of localPairsByKey) {
    if (!remotePairsByKey.has(key)) localOnly.push(pairToSummary(pair, localTracksBySid));
  }
  for (const [key, pair] of remotePairsByKey) {
    if (!localPairsByKey.has(key)) remoteOnly.push(pairToSummary(pair, remoteTracksBySid));
  }
  return { localOnly, remoteOnly };
}

function listHistoryFilenames(dir) {
  if (!dir || !fs.existsSync(dir)) return new Set();
  const filenames = new Set();
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(current, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.isFile()) filenames.add(ent.name);
    }
  }
  return filenames;
}

function diffHistory(localDir, remoteDir) {
  const local = listHistoryFilenames(localDir);
  const remote = listHistoryFilenames(remoteDir);
  const localOnly = [...local].filter((n) => !remote.has(n)).sort();
  const remoteOnly = [...remote].filter((n) => !local.has(n)).sort();
  return { localOnly, remoteOnly };
}

/**
 * @param {{ localVdjFolder: string, syncRepoRoot: string | null, machineId?: string }} args
 * @returns {Promise<object>}
 */
export async function computeSyncDiff({ localVdjFolder, syncRepoRoot, machineId } = {}) {
  void machineId; // reserved for future per-machine views; kept in the signature per contract.

  if (!syncRepoRoot) {
    return makeEmptyDiff('no sync repo configured');
  }
  if (!localVdjFolder) {
    return makeEmptyDiff('no local VirtualDJ folder configured');
  }

  const mergedDir = path.join(syncRepoRoot, 'sync', 'merged');
  if (!fs.existsSync(mergedDir)) {
    return makeEmptyDiff(`sync/merged/ missing at ${mergedDir}`);
  }

  const mergedXml = path.join(mergedDir, 'database.xml');
  const mergedDb = path.join(mergedDir, 'extra.db');
  const mergedHistory = path.join(mergedDir, 'History');
  const hasAnyMerged = fs.existsSync(mergedXml) || fs.existsSync(mergedDb) || fs.existsSync(mergedHistory);
  if (!hasAnyMerged) {
    return makeEmptyDiff(`sync/merged/ is empty at ${mergedDir}`);
  }

  const localXml = path.join(localVdjFolder, 'database.xml');
  const localDb = path.join(localVdjFolder, 'extra.db');
  const localHistory = path.join(localVdjFolder, 'History');

  const songs = diffSongs(parseSongsFromXml(localXml), parseSongsFromXml(mergedXml));
  const linkedPairs = diffLinkedPairs(localDb, mergedDb);
  const history = diffHistory(localHistory, mergedHistory);

  return {
    ready: true,
    songs,
    linkedPairs,
    history,
  };
}
