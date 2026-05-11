#!/usr/bin/env node
/**
 * Parse VirtualDJ data into a graph.
 *
 * Edge sources, in priority order:
 *   1. extra.db `related_tracks` table   →  type: 'vdj_link'   (the real linked tracks
 *                                                              you defined in VirtualDJ)
 *   2. History/*.m3u play sequences      →  type: 'history'    (consecutive transitions)
 *
 * Compatible-match suggestions are no longer precomputed; the renderer scores
 * candidates from the full library on demand when a node is selected.
 *
 * Read-only. Never modifies database.xml or extra.db.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDatabasePath, normalizePath, basenameOnly, isStreamingPath } from './lib/paths.js';
import { stableId, edgeId } from './lib/id.js';
import { convertVdjBpm, bpmGroup } from './lib/bpm.js';
import { toCamelot, detectKeyNotation } from './lib/key.js';
import { readDatabase } from './lib/xml.js';
import { resolveHistoryDir, loadAllSessions, buildHistoryEdges } from './lib/history.js';
import { resolveExtraDbPath, readRelatedTracks } from './lib/relatedTracks.js';

function parseArgs(argv) {
  const args = { db: null, extraDb: null, history: null, useHistory: true };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--db' && argv[i + 1]) {
      args.db = argv[i + 1];
      i += 1;
    } else if (arg === '--extra-db' && argv[i + 1]) {
      args.extraDb = argv[i + 1];
      i += 1;
    } else if (arg === '--history' && argv[i + 1]) {
      args.history = argv[i + 1];
      i += 1;
    } else if (arg === '--no-history') {
      args.useHistory = false;
    }
  }
  return args;
}

function pickFirst(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function normalizeSong(rawSong) {
  const filePath = rawSong.FilePath ?? '';
  const tags = rawSong.Tags ?? {};
  const scan = rawSong.Scan ?? {};
  const infos = rawSong.Infos ?? {};

  const rawBpmAttr = pickFirst(tags.Bpm, scan.Bpm);
  const { bpm, raw: rawBpm, suspicious } = convertVdjBpm(rawBpmAttr);

  const key = pickFirst(tags.Key, scan.Key);
  const keyNotation = detectKeyNotation(key);
  const camelot = toCamelot(key);

  const artist = pickFirst(tags.Author, tags.Artist) ?? '';
  const title = tags.Title ?? '';
  const folder = filePath ? path.posix.dirname(normalizePath(filePath)) : '';

  // <Link NetSearch="..."> entries reference a remote source for the SAME track
  // (cover art, online preview). They are never track-to-track relationships in
  // observed databases, so we record them as node metadata and stop there.
  const links = Array.isArray(rawSong.Link) ? rawSong.Link : rawSong.Link ? [rawSong.Link] : [];
  let netSearchRef = null;
  let coverUrl = null;
  for (const link of links) {
    if (link.NetSearch && !netSearchRef) netSearchRef = link.NetSearch;
    if (link.Cover && !coverUrl) coverUrl = link.Cover;
  }

  return {
    id: stableId(filePath || `${artist}|${title}`),
    filePath,
    normalizedPath: normalizePath(filePath),
    fileName: basenameOnly(filePath),
    folder,
    isStreaming: isStreamingPath(filePath),
    artist,
    title,
    displayName: [artist, title].filter(Boolean).join(' - ') || basenameOnly(filePath) || '(untitled)',
    genre: tags.Genre ?? '',
    remix: tags.Remix ?? '',
    year: tags.Year ?? null,
    key: key ?? null,
    keyNotation,
    camelotKey: camelot,
    bpm,
    rawBpm,
    bpmGroup: bpmGroup(bpm),
    suspiciousBpm: suspicious,
    songLength: Number(infos.SongLength ?? 0) || null,
    coverHint: infos.Cover ?? null,
    netSearchRef,
    coverUrl,
    linkedCount: 0,
    historyPlayCount: 0,
  };
}

function buildIndices(songs) {
  const byFilePath = new Map();
  const byNormalizedPath = new Map();
  const byFileName = new Map();
  const byArtistTitle = new Map();

  for (const song of songs) {
    if (song.filePath) byFilePath.set(song.filePath, song);
    if (song.normalizedPath) byNormalizedPath.set(song.normalizedPath, song);
    if (song.fileName) {
      const bucket = byFileName.get(song.fileName) ?? [];
      bucket.push(song);
      byFileName.set(song.fileName, bucket);
    }
    if (song.artist || song.title) {
      const key = `${song.artist}::${song.title}`.toLowerCase();
      byArtistTitle.set(key, song);
    }
  }
  return { byFilePath, byNormalizedPath, byFileName, byArtistTitle };
}

function resolveTrackData(td, indices) {
  if (td.file && indices.byFilePath.has(td.file)) {
    return { song: indices.byFilePath.get(td.file), method: 'exact_path' };
  }
  if (td.file) {
    const normalized = normalizePath(td.file);
    if (indices.byNormalizedPath.has(normalized)) {
      return { song: indices.byNormalizedPath.get(normalized), method: 'normalized_path' };
    }
  }
  if (td.artist || td.title) {
    const key = `${td.artist ?? ''}::${td.title ?? ''}`.toLowerCase();
    if (indices.byArtistTitle.has(key)) {
      return { song: indices.byArtistTitle.get(key), method: 'artist_title' };
    }
  }
  return null;
}

function buildRelatedTrackEdges(rows, indices) {
  const edges = [];
  const unresolved = [];
  const seen = new Set();

  for (const row of rows) {
    const left = resolveTrackData({ file: row.file1, artist: row.artist1, title: row.title1 }, indices);
    const right = resolveTrackData({ file: row.file2, artist: row.artist2, title: row.title2 }, indices);
    if (!left || !right) {
      unresolved.push({
        rowId: row.rowId,
        leftMatched: Boolean(left),
        rightMatched: Boolean(right),
        left: { file: row.file1, artist: row.artist1, title: row.title1 },
        right: { file: row.file2, artist: row.artist2, title: row.title2 },
      });
      continue;
    }
    if (left.song.id === right.song.id) continue; // Skip self-links defensively.

    const id = edgeId(left.song.id, right.song.id, 'vdj_link');
    if (seen.has(id)) continue;
    seen.add(id);

    edges.push({
      id,
      source: left.song.id,
      target: right.song.id,
      type: 'vdj_link',
      displayAs: 'undirected',
      direction: 'undirected',
      resolutionMethod: `${left.method}+${right.method}`,
      sourceTrackData: { sid: row.sid1, file: row.file1, artist: row.artist1, title: row.title1 },
      targetTrackData: { sid: row.sid2, file: row.file2, artist: row.artist2, title: row.title2 },
    });
    left.song.linkedCount += 1;
    right.song.linkedCount += 1;
  }
  return { edges, unresolved };
}

function buildNodes(songs) {
  return songs.map((song) => ({
    id: song.id,
    type: 'song',
    title: song.title,
    artist: song.artist,
    displayName: song.displayName,
    bpm: song.bpm,
    bpmGroup: song.bpmGroup,
    suspiciousBpm: song.suspiciousBpm,
    key: song.key,
    camelotKey: song.camelotKey,
    keyNotation: song.keyNotation,
    genre: song.genre,
    remix: song.remix,
    year: song.year,
    filePath: song.filePath,
    fileName: song.fileName,
    folder: song.folder,
    isStreaming: song.isStreaming,
    songLength: song.songLength,
    netSearchRef: song.netSearchRef ?? null,
    coverUrl: song.coverUrl ?? null,
    linkedCount: song.linkedCount,
    historyPlayCount: song.historyPlayCount ?? 0,
  }));
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function main() {
  const args = parseArgs(process.argv);
  const dbPath = resolveDatabasePath(args.db);
  console.log(`[parse] Reading library:   ${dbPath}`);

  const { version, songs: rawSongs } = readDatabase(dbPath);
  console.log(`[parse] Songs in database: ${rawSongs.length}`);

  const songs = rawSongs.map(normalizeSong);
  const indices = buildIndices(songs);

  // Primary edge source: extra.db related_tracks
  const extraDbPath = resolveExtraDbPath(args.extraDb);
  let vdjEdges = [];
  let relatedStats = null;
  let relatedUnresolved = [];
  if (extraDbPath) {
    console.log(`[parse] Reading extra.db:  ${extraDbPath}`);
    const { rows, stats } = readRelatedTracks(extraDbPath);
    relatedStats = stats;
    const result = buildRelatedTrackEdges(rows, indices);
    vdjEdges = result.edges;
    relatedUnresolved = result.unresolved;
  } else {
    console.warn('[parse] extra.db not found; no related-track edges will be generated.');
  }
  const existingEdgeIds = new Set(vdjEdges.map((e) => e.id));

  // Secondary edge source: History play sequences.
  let historyEdges = [];
  let historyStats = null;
  let historyDir = null;
  if (args.useHistory) {
    historyDir = resolveHistoryDir(args.history);
    if (historyDir) {
      const sessions = loadAllSessions(historyDir);
      const { edges: historyAccumulator, stats } = buildHistoryEdges(sessions, indices);
      historyStats = stats;
      for (const [, edge] of historyAccumulator) {
        const id = edgeId(edge.source, edge.target, 'history');
        if (existingEdgeIds.has(id)) continue;
        existingEdgeIds.add(id);
        historyEdges.push({
          id,
          source: edge.source,
          target: edge.target,
          type: 'history',
          direction: 'source_to_target',
          displayAs: 'undirected',
          weight: edge.weight,
          sessionCount: edge.sessions.size,
          sessions: [...edge.sessions].sort(),
          lastPlayTime: edge.lastPlayTime || null,
        });
      }
      const songsById = new Map(songs.map((s) => [s.id, s]));
      for (const edge of historyEdges) {
        const a = songsById.get(edge.source);
        const b = songsById.get(edge.target);
        if (a) a.linkedCount += 1;
        if (b) b.linkedCount += 1;
      }
    } else {
      console.warn('[parse] No History/ folder found; skipping history edges.');
    }
  }

  const allEdges = [...vdjEdges, ...historyEdges];
  const nodes = buildNodes(songs);

  const meta = {
    databasePath: dbPath,
    databaseVersion: version,
    extraDbPath: extraDbPath ?? null,
    historyPath: historyDir,
    generatedAt: new Date().toISOString(),
    totals: {
      songs: nodes.length,
      withBpm: nodes.filter((n) => n.bpm != null).length,
      withKey: nodes.filter((n) => n.key).length,
      withCamelot: nodes.filter((n) => n.camelotKey).length,
      withSuspiciousBpm: nodes.filter((n) => n.suspiciousBpm).length,
      streaming: nodes.filter((n) => n.isStreaming).length,
      everPlayed: nodes.filter((n) => n.historyPlayCount > 0).length,
      inRelatedTrackPairs: new Set(vdjEdges.flatMap((e) => [e.source, e.target])).size,
    },
    edges: {
      vdjLink: vdjEdges.length,
      history: historyEdges.length,
    },
    relatedTracks: relatedStats,
    history: historyStats,
  };

  const here = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(here, '..');
  const publicDir = path.join(projectRoot, 'public');

  writeJson(path.join(publicDir, 'graph.json'), { meta, nodes, edges: allEdges });
  writeJson(path.join(publicDir, 'unresolved-links.json'), { meta, relatedUnresolved });

  console.log('[parse] ─── Summary ───────────────────────────────');
  console.log(`[parse] Songs (library):       ${meta.totals.songs}`);
  console.log(`[parse] In related pairs:      ${meta.totals.inRelatedTrackPairs}`);
  console.log(`[parse] Related-track edges:   ${vdjEdges.length}`);
  if (relatedStats) {
    console.log(
      `[parse]   total in extra.db: ${relatedStats.totalRelatedRows}, joined: ${relatedStats.joinedRows}, unresolved: ${relatedUnresolved.length}`
    );
  }
  console.log(`[parse] History edges:         ${historyEdges.length}`);
  if (historyStats) {
    console.log(
      `[parse]   sessions: ${historyStats.sessions}, transitions: ${historyStats.totalTransitions}, unmatched: ${historyStats.unmatchedEntries}`
    );
  }
  console.log(`[parse] Wrote → public/graph.json, public/unresolved-links.json`);
}

main();
