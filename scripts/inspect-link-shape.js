#!/usr/bin/env node
/**
 * Phase 1 — Inspect VirtualDJ database to learn the real <Link> attribute shape.
 * Read-only. Writes a small report to public/link-shape-report.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDatabasePath } from './lib/paths.js';
import { readDatabase } from './lib/xml.js';
import { resolveExtraDbPath, readRelatedTracks } from './lib/relatedTracks.js';

const MAX_EXAMPLES_PER_SHAPE = 3;
const OUTPUT_RELATIVE = 'public/link-shape-report.json';

function parseArgs(argv) {
  const args = { db: null };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--db' && argv[i + 1]) {
      args.db = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

function shapeKey(linkAttributes) {
  return Object.keys(linkAttributes)
    .filter((k) => k !== '#text')
    .sort()
    .join(',');
}

function collectSongLabel(song) {
  const tags = song.Tags ?? {};
  const author = tags.Author ?? tags.Artist ?? '';
  const title = tags.Title ?? '';
  const file = song.FilePath ?? '';
  const display = [author, title].filter(Boolean).join(' - ');
  return display || file || '(unknown)';
}

function main() {
  const args = parseArgs(process.argv);
  const dbPath = resolveDatabasePath(args.db);
  console.log(`[inspect] Reading: ${dbPath}`);

  const { version, songs } = readDatabase(dbPath);
  const totalSongs = songs.length;

  const shapes = new Map();
  let songsWithLinks = 0;
  let totalLinks = 0;

  for (const song of songs) {
    const links = Array.isArray(song.Link) ? song.Link : song.Link ? [song.Link] : [];
    if (links.length === 0) continue;
    songsWithLinks += 1;

    for (const link of links) {
      totalLinks += 1;
      const key = shapeKey(link) || '(no-attributes)';
      let entry = shapes.get(key);
      if (!entry) {
        entry = { attributes: key.split(',').filter(Boolean), count: 0, examples: [] };
        shapes.set(key, entry);
      }
      entry.count += 1;
      if (entry.examples.length < MAX_EXAMPLES_PER_SHAPE) {
        entry.examples.push({
          source: collectSongLabel(song),
          sourceFilePath: song.FilePath ?? null,
          link,
        });
      }
    }
  }

  // The real source of track-to-track links is extra.db.related_tracks (SQLite),
  // not <Link> in database.xml. Probe it here so the inspector reports both.
  const extraDbPath = resolveExtraDbPath();
  let extraDbReport = null;
  if (extraDbPath) {
    try {
      const { rows, stats } = readRelatedTracks(extraDbPath);
      extraDbReport = {
        path: extraDbPath,
        stats,
        sample: rows.slice(0, 5).map((r) => ({
          left: { sid: r.sid1, file: r.file1, artist: r.artist1, title: r.title1 },
          right: { sid: r.sid2, file: r.file2, artist: r.artist2, title: r.title2 },
        })),
      };
    } catch (err) {
      extraDbReport = { path: extraDbPath, error: err.message };
    }
  }

  const report = {
    databasePath: dbPath,
    databaseVersion: version,
    totalSongs,
    songsWithLinks,
    totalLinkElements: totalLinks,
    uniqueLinkShapeCount: shapes.size,
    uniqueLinkShapes: [...shapes.values()].sort((a, b) => b.count - a.count),
    extraDb: extraDbReport,
    notes: [
      'In observed databases, <Link NetSearch="..."> denotes a remote (SoundCloud / Deezer) reference for the same track, not a track-to-track link.',
      'Real track-to-track relationships ("Linked tracks" in the VirtualDJ UI) are stored in extra.db (SQLite) under the related_tracks table, joined with track_data on sid.',
    ],
  };

  const here = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(here, '..');
  const outputPath = path.join(projectRoot, OUTPUT_RELATIVE);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));

  console.log(`[inspect] Database version:    ${version ?? 'unknown'}`);
  console.log(`[inspect] Songs:                ${totalSongs}`);
  console.log(`[inspect] Songs with <Link>:    ${songsWithLinks} (NetSearch references, not track-to-track)`);
  console.log(`[inspect] Total <Link> nodes:   ${totalLinks}`);
  console.log(`[inspect] Unique link shapes:   ${shapes.size}`);
  for (const shape of report.uniqueLinkShapes) {
    console.log(`  - [${shape.count}x] attrs: ${shape.attributes.join(', ') || '(none)'}`);
  }
  if (extraDbReport) {
    if (extraDbReport.error) {
      console.warn(`[inspect] extra.db error: ${extraDbReport.error}`);
    } else {
      console.log(`[inspect] extra.db:             ${extraDbReport.path}`);
      console.log(`[inspect]   related_tracks rows: ${extraDbReport.stats.totalRelatedRows}`);
      console.log(`[inspect]   joined to track_data: ${extraDbReport.stats.joinedRows}`);
      console.log(`[inspect]   orphaned (sid missing in track_data): ${extraDbReport.stats.orphanedRows}`);
    }
  } else {
    console.warn('[inspect] extra.db not found at standard location');
  }
  console.log(`[inspect] Wrote report → ${path.relative(projectRoot, outputPath)}`);
}

main();
