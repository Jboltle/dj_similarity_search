/**
 * On-demand "find compatible matches" engine.
 *
 * Given a selected song (anchor) and the full library, score every candidate by:
 *   - BPM proximity (with optional half/double-time tolerance)
 *   - Camelot key compatibility
 *   - Genre match
 *   - Same artist
 *   - Same folder/crate
 *
 * Existing related-track edges are excluded from results so the panel only
 * shows *new* candidates.
 */
const SCORE_BPM_NEAR = 40;
const SCORE_BPM_HALF_DOUBLE = 20;
const SCORE_KEY = 25;
const SCORE_GENRE = 15;
const SCORE_ARTIST = 10;
const SCORE_FOLDER = 10;

const CAMELOT_RE = /^([1-9]|1[0-2])([AB])$/i;

function parseCamelot(camelotKey) {
  if (!camelotKey) return null;
  const match = CAMELOT_RE.exec(camelotKey);
  if (!match) return null;
  return { number: Number(match[1]), letter: match[2].toUpperCase() };
}

function isKeyCompatible(a, b) {
  const x = parseCamelot(a);
  const y = parseCamelot(b);
  if (!x || !y) return false;
  if (x.number === y.number && x.letter === y.letter) return true;
  if (x.letter === y.letter) {
    const diff = Math.abs(x.number - y.number);
    if (diff === 1 || diff === 11) return true;
  }
  if (x.number === y.number && x.letter !== y.letter) return true;
  return false;
}

function bpmDistance(a, b, allowHalfDouble) {
  if (a == null || b == null) return Infinity;
  const direct = Math.abs(a - b);
  if (!allowHalfDouble) return direct;
  return Math.min(direct, Math.abs(a - b * 2), Math.abs(a - b / 2));
}

function scoreCandidate(anchor, candidate, options) {
  const reasons = [];
  let score = 0;

  const distance = bpmDistance(anchor.bpm, candidate.bpm, options.allowHalfDouble);
  if (distance > options.bpmTolerance) return null;

  const direct = Math.abs((anchor.bpm ?? 0) - (candidate.bpm ?? 0));
  if (direct <= options.bpmTolerance) {
    score += SCORE_BPM_NEAR;
    reasons.push(`BPM Δ ${direct.toFixed(1)}`);
  } else {
    score += SCORE_BPM_HALF_DOUBLE;
    reasons.push(`BPM Δ ${distance.toFixed(1)} (half/double)`);
  }

  if (anchor.camelotKey && candidate.camelotKey && isKeyCompatible(anchor.camelotKey, candidate.camelotKey)) {
    score += SCORE_KEY;
    reasons.push(`Key ${anchor.camelotKey} ↔ ${candidate.camelotKey}`);
  } else if (options.keyOnly) {
    return null;
  }

  if (anchor.genre && candidate.genre && anchor.genre.toLowerCase() === candidate.genre.toLowerCase()) {
    score += SCORE_GENRE;
    reasons.push(`Genre ${anchor.genre}`);
  } else if (options.genreOnly) {
    return null;
  }

  if (anchor.artist && candidate.artist && anchor.artist.toLowerCase() === candidate.artist.toLowerCase()) {
    score += SCORE_ARTIST;
    reasons.push(`Artist ${anchor.artist}`);
  }
  if (anchor.folder && candidate.folder && anchor.folder === candidate.folder) {
    score += SCORE_FOLDER;
    reasons.push('Same folder');
  }

  return { score, reasons, distance };
}

const DEFAULT_OPTIONS = {
  bpmTolerance: 3,
  allowHalfDouble: false,
  keyOnly: false,
  genreOnly: false,
  limit: 25,
};

/**
 * @param {object} anchor                 the selected node
 * @param {object[]} library              all candidate nodes (typically the whole graph)
 * @param {Set<string>} excludeIds        node ids that already share an edge with the anchor
 * @param {Partial<typeof DEFAULT_OPTIONS>} userOptions
 */
export function findMatches(anchor, library, excludeIds, userOptions = {}) {
  if (!anchor || anchor.bpm == null) return [];
  const options = { ...DEFAULT_OPTIONS, ...userOptions };

  const results = [];
  for (const candidate of library) {
    if (candidate.id === anchor.id) continue;
    if (excludeIds && excludeIds.has(candidate.id)) continue;
    if (candidate.bpm == null) continue;
    const scored = scoreCandidate(anchor, candidate, options);
    if (!scored) continue;
    results.push({ node: candidate, ...scored });
  }
  results.sort((a, b) => b.score - a.score || a.distance - b.distance);
  return results.slice(0, options.limit);
}
