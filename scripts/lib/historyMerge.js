/**
 * File-level union of two VirtualDJ History/ folders.
 *
 * VirtualDJ stores each session as `<date>.m3u`, sometimes also bucketed by
 * year/month (e.g. `2026/05/2026-05-12.m3u`). Different machines on the same
 * date are *different sessions* — we never combine them into one file. Instead:
 *
 *   - Walk both source trees, key each file by its date-stamped basename.
 *   - When two files share a basename:
 *       - If their content SHA-256 matches, keep one copy.
 *       - Otherwise, write both, suffixed: `2026-05-12.mac.m3u` and
 *         `2026-05-12.windows.m3u`.
 *   - The merged tree is FLAT (no nested year/month folders) so downstream
 *     readers like scripts/lib/history.js see every session via one walk.
 *
 * Non-m3u files (e.g. `tracklist.txt`, `.DS_Store`) are skipped — they're not
 * session logs and don't round-trip cleanly.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const M3U_EXT = '.m3u';

function* walkM3uFiles(rootDir) {
  if (!fs.existsSync(rootDir)) return;
  const stack = [rootDir];
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
      else if (ent.isFile() && ent.name.toLowerCase().endsWith(M3U_EXT)) yield full;
    }
  }
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function basenameKey(filePath) {
  return path.basename(filePath).toLowerCase();
}

function indexHistorySource(rootDir, label) {
  const byBasename = new Map();
  for (const full of walkM3uFiles(rootDir)) {
    const key = basenameKey(full);
    if (!byBasename.has(key)) byBasename.set(key, []);
    byBasename.get(key).push({ absPath: full, label, sha256: sha256File(full) });
  }
  return byBasename;
}

function ensureEmptyDir(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function buildSuffixedName(basename, label) {
  const ext = path.extname(basename);
  const stem = basename.slice(0, basename.length - ext.length);
  return `${stem}.${label}${ext}`;
}

/**
 * Merge two History/ trees into outDir. Returns counts and per-file decisions.
 *
 * @param {{ localDir: string|null, remoteDir: string|null, outDir: string, localLabel?: string, remoteLabel?: string }} args
 */
export function mergeHistoryDirs({
  localDir,
  remoteDir,
  outDir,
  localLabel = 'mac',
  remoteLabel = 'windows',
}) {
  ensureEmptyDir(outDir);

  const localIdx = localDir ? indexHistorySource(localDir, localLabel) : new Map();
  const remoteIdx = remoteDir ? indexHistorySource(remoteDir, remoteLabel) : new Map();

  const report = {
    localDir,
    remoteDir,
    localFileCount: 0,
    remoteFileCount: 0,
    mergedFileCount: 0,
    identicalDedup: 0,
    collisionsSuffixed: 0,
    decisions: [],
  };
  for (const arr of localIdx.values()) report.localFileCount += arr.length;
  for (const arr of remoteIdx.values()) report.remoteFileCount += arr.length;

  const allBasenames = new Set([...localIdx.keys(), ...remoteIdx.keys()]);

  for (const basename of [...allBasenames].sort()) {
    const localList = localIdx.get(basename) ?? [];
    const remoteList = remoteIdx.get(basename) ?? [];

    if (localList.length > 0 && remoteList.length === 0) {
      copyFlat({ entries: localList, basename, outDir, report });
      continue;
    }
    if (localList.length === 0 && remoteList.length > 0) {
      copyFlat({ entries: remoteList, basename, outDir, report });
      continue;
    }

    // Both sides have at least one file with this basename. Dedupe by content.
    const seenHashes = new Map();
    for (const e of [...localList, ...remoteList]) {
      if (!seenHashes.has(e.sha256)) seenHashes.set(e.sha256, e);
    }

    if (seenHashes.size === 1) {
      const sole = [...seenHashes.values()][0];
      const dest = path.join(outDir, basename);
      fs.copyFileSync(sole.absPath, dest);
      report.mergedFileCount += 1;
      report.identicalDedup += localList.length + remoteList.length - 1;
      report.decisions.push({
        basename,
        decision: 'dedup',
        keptFrom: sole.label,
        outFile: path.basename(dest),
      });
      continue;
    }

    // Genuine collision — keep each unique-content copy with a side suffix.
    const writtenBy = new Set();
    for (const [, entry] of seenHashes) {
      let label = entry.label;
      if (writtenBy.has(label)) {
        let n = 2;
        while (writtenBy.has(`${entry.label}${n}`)) n += 1;
        label = `${entry.label}${n}`;
      }
      writtenBy.add(label);
      const name = buildSuffixedName(basename, label);
      const dest = path.join(outDir, name);
      fs.copyFileSync(entry.absPath, dest);
      report.mergedFileCount += 1;
      report.collisionsSuffixed += 1;
      report.decisions.push({
        basename,
        decision: 'collision',
        keptFrom: entry.label,
        outFile: name,
      });
    }
  }

  return report;
}

function copyFlat({ entries, basename, outDir, report }) {
  if (entries.length === 1) {
    const dest = path.join(outDir, basename);
    fs.copyFileSync(entries[0].absPath, dest);
    report.mergedFileCount += 1;
    report.decisions.push({
      basename,
      decision: 'single',
      keptFrom: entries[0].label,
      outFile: basename,
    });
    return;
  }
  // Same side had multiple files with this basename (year/month bucketing
  // produced a duplicate name when flattened). Dedupe by hash, then suffix.
  const seen = new Map();
  for (const e of entries) {
    if (!seen.has(e.sha256)) seen.set(e.sha256, e);
  }
  if (seen.size === 1) {
    const sole = [...seen.values()][0];
    const dest = path.join(outDir, basename);
    fs.copyFileSync(sole.absPath, dest);
    report.mergedFileCount += 1;
    report.identicalDedup += entries.length - 1;
    report.decisions.push({
      basename,
      decision: 'dedup-same-side',
      keptFrom: sole.label,
      outFile: basename,
    });
    return;
  }
  let n = 1;
  for (const [, entry] of seen) {
    const name = n === 1 ? basename : buildSuffixedName(basename, `${entry.label}${n}`);
    const dest = path.join(outDir, name);
    fs.copyFileSync(entry.absPath, dest);
    report.mergedFileCount += 1;
    report.decisions.push({
      basename,
      decision: 'collision-same-side',
      keptFrom: entry.label,
      outFile: name,
    });
    n += 1;
  }
}
