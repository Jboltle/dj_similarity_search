/**
 * Shared loader for both upload-to-soundcloud.js and merge-links-to-extra-db.js.
 *
 * Reads public/graph.json and extracts the data we need to act on:
 *   - Every vdj_link edge (the manually linked pairs from extra.db.related_tracks)
 *   - The unique nodes those edges touch
 *   - The subset that has a SoundCloud netSearchRef (so we can build a playlist)
 *
 * No mutation. Pure read.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const SOUNDCLOUD_PREFIX = 'sc';
const VDJ_LINK_EDGE_TYPE = 'vdj_link';
const EXPORT_DB_EXTENSION = '.db';
const EXPORT_JSON_EXTENSION = '.json';

const SKIP_REASON = {
  NO_NET_SEARCH_REF: 'no_netsearch_ref',
  NON_SOUNDCLOUD_SOURCE: 'non_soundcloud_source',
  EMPTY_TRACK_ID: 'empty_track_id',
};

function resolveGraphJsonPath(explicit) {
  if (explicit) return explicit;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(here, '..', '..');
  return path.join(projectRoot, 'public', 'graph.json');
}

function readGraph(graphJsonPath) {
  if (!fs.existsSync(graphJsonPath)) {
    throw new Error(
      `graph.json not found at ${graphJsonPath}. Run \`npm run parse\` first to generate it.`
    );
  }
  const raw = fs.readFileSync(graphJsonPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
    throw new Error(`graph.json is malformed: missing nodes or edges array.`);
  }
  return parsed;
}

function buildPairs(edges) {
  const pairs = [];
  for (const edge of edges) {
    if (edge.type !== VDJ_LINK_EDGE_TYPE) continue;
    const left = edge.sourceTrackData ?? {};
    const right = edge.targetTrackData ?? {};
    pairs.push({
      edgeId: edge.id,
      leftNodeId: edge.source,
      rightNodeId: edge.target,
      left: {
        sid: left.sid ?? null,
        file: left.file ?? null,
        artist: left.artist ?? null,
        title: left.title ?? null,
        remix: left.remix ?? null,
      },
      right: {
        sid: right.sid ?? null,
        file: right.file ?? null,
        artist: right.artist ?? null,
        title: right.title ?? null,
        remix: right.remix ?? null,
      },
    });
  }
  return pairs;
}

function collectLinkedNodes(pairs, nodes) {
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const linkedIds = new Set();
  for (const pair of pairs) {
    linkedIds.add(pair.leftNodeId);
    linkedIds.add(pair.rightNodeId);
  }
  const linkedNodes = [];
  for (const id of linkedIds) {
    const node = nodesById.get(id);
    if (node) linkedNodes.push(node);
  }
  return linkedNodes;
}

function extractSoundcloudTrackId(netSearchRef) {
  if (!netSearchRef || typeof netSearchRef !== 'string') return null;
  if (!netSearchRef.startsWith(SOUNDCLOUD_PREFIX)) return null;
  const rawId = netSearchRef.slice(SOUNDCLOUD_PREFIX.length);
  if (!/^\d+$/.test(rawId)) return null;
  return rawId;
}

function buildSoundcloudTracks(linkedNodes) {
  const included = [];
  const skipped = [];
  for (const node of linkedNodes) {
    const ref = node.netSearchRef;
    if (!ref) {
      skipped.push({ node, reason: SKIP_REASON.NO_NET_SEARCH_REF });
      continue;
    }
    const trackId = extractSoundcloudTrackId(ref);
    if (!trackId) {
      skipped.push({
        node,
        reason: SKIP_REASON.NON_SOUNDCLOUD_SOURCE,
        netSearchRef: ref,
      });
      continue;
    }
    included.push({ node, trackId });
  }
  return { included, skipped };
}

/**
 * Returns everything callers need from graph.json in one shot.
 * Throws if graph.json is missing or malformed.
 */
export function loadLinkedSongs({ graphJsonPath } = {}) {
  const fullPath = resolveGraphJsonPath(graphJsonPath);
  const graph = readGraph(fullPath);

  const pairs = buildPairs(graph.edges);
  const linkedNodes = collectLinkedNodes(pairs, graph.nodes);
  const soundcloudTracks = buildSoundcloudTracks(linkedNodes);

  return {
    graphJsonPath: fullPath,
    sourceType: 'graph',
    meta: graph.meta ?? null,
    pairs,
    linkedNodes,
    soundcloudTracks,
  };
}

function pairFromExportRow({ sid1, track1, sid2, track2 }) {
  return {
    edgeId: null,
    leftNodeId: null,
    rightNodeId: null,
    left: {
      sid: sid1 ?? track1?.sid ?? null,
      file: track1?.file ?? null,
      artist: track1?.artist ?? null,
      title: track1?.title ?? null,
      remix: track1?.remix ?? null,
    },
    right: {
      sid: sid2 ?? track2?.sid ?? null,
      file: track2?.file ?? null,
      artist: track2?.artist ?? null,
      title: track2?.title ?? null,
      remix: track2?.remix ?? null,
    },
  };
}

function loadFromExportJson(filePath) {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!Array.isArray(parsed.pairs) || !Array.isArray(parsed.tracks)) {
    throw new Error(
      `${filePath} is not a valid linked-tracks-export.json (missing 'pairs' or 'tracks').`
    );
  }
  const tracksBySid = new Map();
  for (const t of parsed.tracks) {
    if (t?.sid == null) continue;
    tracksBySid.set(String(t.sid), t);
  }
  const pairs = parsed.pairs.map((p) =>
    pairFromExportRow({
      sid1: p.sid1,
      sid2: p.sid2,
      track1: tracksBySid.get(String(p.sid1)),
      track2: tracksBySid.get(String(p.sid2)),
    })
  );
  return {
    graphJsonPath: filePath,
    sourceType: 'export-json',
    meta: parsed.meta ?? null,
    pairs,
    linkedNodes: [],
    soundcloudTracks: { included: [], skipped: [] },
  };
}

function loadFromExportDb(filePath) {
  const db = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    const trackRows = db.prepare('SELECT sid, file, artist, title, remix FROM track_data').all();
    const tracksBySid = new Map();
    for (const t of trackRows) tracksBySid.set(String(t.sid), t);

    const pairRows = db.prepare('SELECT sid1, sid2 FROM related_tracks').all();
    const pairs = pairRows.map((p) =>
      pairFromExportRow({
        sid1: p.sid1,
        sid2: p.sid2,
        track1: tracksBySid.get(String(p.sid1)),
        track2: tracksBySid.get(String(p.sid2)),
      })
    );
    return {
      graphJsonPath: filePath,
      sourceType: 'export-db',
      meta: { sourceFile: filePath, trackCount: trackRows.length, pairCount: pairRows.length },
      pairs,
      linkedNodes: [],
      soundcloudTracks: { included: [], skipped: [] },
    };
  } finally {
    db.close();
  }
}

/**
 * Load linked pairs from a portable export produced by writeLinkedTracksExport.
 * Used on the receiving machine when syncing linked tracks across computers.
 * Supports either the JSON export (preferred) or the standalone .db export.
 */
export function loadFromExportFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Export file not found: ${filePath}`);
  }
  const ext = path.extname(filePath).toLowerCase();
  if (ext === EXPORT_JSON_EXTENSION) return loadFromExportJson(filePath);
  if (ext === EXPORT_DB_EXTENSION) return loadFromExportDb(filePath);
  throw new Error(
    `Unsupported export format: ${ext}. Expected .json (linked-tracks-export.json) or .db (linked-tracks.db).`
  );
}

export { SKIP_REASON };
