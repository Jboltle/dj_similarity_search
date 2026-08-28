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
 * For song conflicts we also compute per-side "provenance": which specific
 * fields differ (POIs, BPM, tags), plus a `reason` bucket the UI uses to
 * render a compact chip. Conflicts without any semantic change (only the
 * LastModified attribute drifted) are surfaced as `lastmodified_only` so
 * the UI can suppress them or show them dimmed.
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
const BPM_ATTR = `${ATTR_PREFIX}Bpm`;
const KEY_ATTR = `${ATTR_PREFIX}Key`;
const GENRE_ATTR = `${ATTR_PREFIX}Genre`;
const ALBUM_ATTR = `${ATTR_PREFIX}Album`;
const YEAR_ATTR = `${ATTR_PREFIX}Year`;

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
    machines: [],
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

function songLastModified(song) {
  const infos = song?.Infos;
  if (!infos) return 0;
  const raw = infos[LAST_MODIFIED_ATTR];
  if (!raw) return 0;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : 0;
}

function songBpm(song) {
  const scan = song?.Scan;
  const raw = scan?.[BPM_ATTR];
  if (!raw) return null;
  const n = Number.parseFloat(String(raw));
  return Number.isFinite(n) ? n : null;
}

function songPoiCount(song) {
  const poi = song?.Poi;
  if (Array.isArray(poi)) return poi.length;
  if (poi) return 1;
  return 0;
}

function songFolder(song) {
  const raw = String(song?.[FILE_PATH_ATTR] ?? '');
  if (!raw) return '';
  const normalized = raw.replaceAll('\\', '/');
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? normalized.slice(0, idx) : '';
}

function isStreaming(song) {
  const raw = String(song?.[FILE_PATH_ATTR] ?? '');
  return /^(netsearch|http|https|spotify|tidal|deezer|youtube|soundcloud):/i.test(raw);
}

function songToSummary(song) {
  const filePath = pickAttr(song, FILE_PATH_ATTR);
  const tags = song?.Tags ?? {};
  const artist = pickAttr(tags, AUTHOR_ATTR, ARTIST_ATTR);
  const title = pickAttr(tags, TITLE_ATTR);
  return {
    filePath,
    artist,
    title,
    lastModified: songLastModified(song),
    poiCount: songPoiCount(song),
    bpm: songBpm(song),
    folder: songFolder(song),
    streaming: isStreaming(song),
  };
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

/**
 * Compute the set of tag/scan/poi fields that differ between the two <Song>
 * elements. Used to power reason-chips in the UI.
 */
function computeChangedFields(local, remote) {
  const changed = [];

  const localBpm = songBpm(local);
  const remoteBpm = songBpm(remote);
  if ((localBpm ?? null) !== (remoteBpm ?? null)) changed.push('bpm');

  const localPoi = songPoiCount(local);
  const remotePoi = songPoiCount(remote);
  if (localPoi !== remotePoi) changed.push('pois');

  for (const [tag, label] of [
    [KEY_ATTR, 'key'],
    [GENRE_ATTR, 'genre'],
    [ALBUM_ATTR, 'album'],
    [YEAR_ATTR, 'year'],
  ]) {
    const l = String(local?.Tags?.[tag] ?? '').trim();
    const r = String(remote?.Tags?.[tag] ?? '').trim();
    if (l !== r) changed.push(label);
  }

  const localArtist = pickAttr(local?.Tags, AUTHOR_ATTR, ARTIST_ATTR);
  const remoteArtist = pickAttr(remote?.Tags, AUTHOR_ATTR, ARTIST_ATTR);
  if (localArtist !== remoteArtist) changed.push('artist');

  const localTitle = pickAttr(local?.Tags, TITLE_ATTR);
  const remoteTitle = pickAttr(remote?.Tags, TITLE_ATTR);
  if (localTitle !== remoteTitle) changed.push('title');

  return changed;
}

function reasonForConflict(changedFields) {
  if (changedFields.length === 0) return 'lastmodified_only';
  if (changedFields.includes('pois')) return 'poi_diff';
  if (changedFields.includes('bpm')) return 'bpm_diff';
  return 'meta_diff';
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
      const summary = songToSummary(localSong);
      localOnly.push({ ...summary, reason: 'new_locally' });
      continue;
    }
    const local = songToSummary(localSong);
    const remote = songToSummary(remoteSong);
    const changedFields = computeChangedFields(localSong, remoteSong);
    if (local.lastModified !== remote.lastModified || changedFields.length > 0) {
      const winnerIfMerged = local.lastModified >= remote.lastModified ? 'local' : 'remote';
      conflicts.push({
        filePath: local.filePath,
        artist: local.artist,
        title: local.title,
        folder: local.folder,
        streaming: local.streaming,
        localLastModified: local.lastModified,
        remoteLastModified: remote.lastModified,
        winnerIfMerged,
        reason: reasonForConflict(changedFields),
        local: {
          lastModified: local.lastModified,
          poiCount: local.poiCount,
          bpm: local.bpm,
        },
        remote: {
          lastModified: remote.lastModified,
          poiCount: remote.poiCount,
          bpm: remote.bpm,
        },
        changedFields,
      });
    }
  }
  for (const [key, remoteSong] of remoteByKey) {
    if (!localByKey.has(key)) {
      const summary = songToSummary(remoteSong);
      remoteOnly.push({ ...summary, reason: 'from_remote' });
    }
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

function readMergedMachines(mergedDir) {
  const manifestPath = path.join(mergedDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return [];
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return Array.isArray(manifest.machines) ? manifest.machines : [];
  } catch {
    return [];
  }
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
    machines: readMergedMachines(mergedDir),
  };
}
