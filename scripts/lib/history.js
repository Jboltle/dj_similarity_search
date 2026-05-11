import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizePath } from './paths.js';

const EXTVDJ_RE = /^#EXTVDJ:(.*)$/i;
const ATTR_RE = /<([a-zA-Z]+)>([\s\S]*?)<\/\1>/g;

const DEFAULT_HISTORY_DIRS = {
  darwin: () => path.join(os.homedir(), 'Library', 'Application Support', 'VirtualDJ', 'History'),
  win32: () => path.join(os.homedir(), 'Documents', 'VirtualDJ', 'History'),
  linux: () => path.join(os.homedir(), 'Documents', 'VirtualDJ', 'History'),
};

export function resolveHistoryDir(explicit) {
  if (explicit && fs.existsSync(explicit)) return explicit;
  if (process.env.VDJ_HISTORY_PATH && fs.existsSync(process.env.VDJ_HISTORY_PATH)) {
    return process.env.VDJ_HISTORY_PATH;
  }
  const platform = DEFAULT_HISTORY_DIRS[process.platform];
  if (platform) {
    const candidate = platform();
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function* walkM3u(dir) {
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.m3u')) yield full;
    }
  }
}

function parseExtTag(line) {
  const match = EXTVDJ_RE.exec(line);
  if (!match) return null;
  const attrs = {};
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(match[1])) !== null) {
    attrs[m[1].toLowerCase()] = m[2].trim();
  }
  return attrs;
}

function sessionDateFromPath(filePath) {
  const base = path.basename(filePath, '.m3u');
  if (/^\d{4}-\d{2}-\d{2}$/.test(base)) return base;
  return null;
}

export function parseM3uSession(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/);
  const entries = [];
  let pending = null;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#EXTVDJ:')) {
      pending = parseExtTag(line) ?? {};
      continue;
    }
    if (line.startsWith('#')) continue;
    entries.push({
      filePath: line,
      normalizedPath: normalizePath(line),
      artist: pending?.artist ?? '',
      title: pending?.title ?? '',
      remix: pending?.remix ?? '',
      lastPlayTime: pending?.lastplaytime ? Number(pending.lastplaytime) : null,
      time: pending?.time ?? null,
    });
    pending = null;
  }
  return {
    sourceFile: filePath,
    sessionDate: sessionDateFromPath(filePath),
    entries,
  };
}

export function loadAllSessions(historyDir) {
  if (!historyDir) return [];
  const sessions = [];
  for (const filePath of walkM3u(historyDir)) {
    try {
      sessions.push(parseM3uSession(filePath));
    } catch {
      // Skip unreadable/malformed sessions; they're not critical to the graph.
    }
  }
  // Stable order makes the output deterministic across runs.
  sessions.sort((a, b) => (a.sourceFile < b.sourceFile ? -1 : 1));
  return sessions;
}

function lookupEntry(entry, indices) {
  if (entry.filePath && indices.byFilePath.has(entry.filePath)) {
    return { song: indices.byFilePath.get(entry.filePath), method: 'exact_path' };
  }
  if (entry.normalizedPath && indices.byNormalizedPath.has(entry.normalizedPath)) {
    return { song: indices.byNormalizedPath.get(entry.normalizedPath), method: 'normalized_path' };
  }
  if (entry.artist || entry.title) {
    const key = `${entry.artist}::${entry.title}`.toLowerCase();
    if (indices.byArtistTitle.has(key)) {
      return { song: indices.byArtistTitle.get(key), method: 'artist_title' };
    }
  }
  return null;
}

export function buildHistoryEdges(sessions, indices) {
  const accumulator = new Map();
  let totalEntries = 0;
  let unmatchedEntries = 0;
  let totalTransitions = 0;

  for (const session of sessions) {
    let previousSong = null;
    for (const entry of session.entries) {
      totalEntries += 1;
      const match = lookupEntry(entry, indices);
      if (!match) {
        unmatchedEntries += 1;
        previousSong = null;
        continue;
      }
      const currentSong = match.song;
      currentSong.historyPlayCount = (currentSong.historyPlayCount ?? 0) + 1;

      if (previousSong && previousSong.id !== currentSong.id) {
        totalTransitions += 1;
        const key = `${previousSong.id}|${currentSong.id}`;
        let edge = accumulator.get(key);
        if (!edge) {
          edge = {
            source: previousSong.id,
            target: currentSong.id,
            weight: 0,
            sessions: new Set(),
            lastPlayTime: 0,
          };
          accumulator.set(key, edge);
        }
        edge.weight += 1;
        if (session.sessionDate) edge.sessions.add(session.sessionDate);
        if (entry.lastPlayTime && entry.lastPlayTime > edge.lastPlayTime) {
          edge.lastPlayTime = entry.lastPlayTime;
        }
      }
      previousSong = currentSong;
    }
  }

  return {
    edges: accumulator,
    stats: {
      sessions: sessions.length,
      totalEntries,
      unmatchedEntries,
      totalTransitions,
      uniqueTransitions: accumulator.size,
    },
  };
}
