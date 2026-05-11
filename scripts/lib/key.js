// Camelot wheel:  1A..12A (minor), 1B..12B (major).
// Compatible neighbors per Mixed In Key conventions:
//   - same key
//   - +/- 1 on the wheel (same letter)
//   - same number, swap letter (relative major/minor)

const TRADITIONAL_TO_CAMELOT = {
  'Abm': '1A', 'B': '1B',
  'Ebm': '2A', 'F#': '2B', 'Gb': '2B',
  'Bbm': '3A', 'Db': '3B', 'C#': '3B',
  'Fm': '4A', 'Ab': '4B',
  'Cm': '5A', 'Eb': '5B', 'D#': '5B',
  'Gm': '6A', 'Bb': '6B', 'A#': '6B',
  'Dm': '7A', 'F': '7B',
  'Am': '8A', 'C': '8B',
  'Em': '9A', 'G': '9B',
  'Bm': '10A', 'D': '10B',
  'F#m': '11A', 'Gbm': '11A', 'A': '11B',
  'C#m': '12A', 'Dbm': '12A', 'E': '12B',
};

const CAMELOT_RE = /^([1-9]|1[0-2])([AB])$/i;

export function detectKeyNotation(key) {
  if (!key) return 'missing';
  if (CAMELOT_RE.test(key)) return 'camelot';
  if (/^[A-G][#b]?m?$/.test(key)) return 'traditional';
  if (/^([1-9]|1[0-2])[md]$/i.test(key)) return 'open-key';
  return 'unknown';
}

export function toCamelot(key) {
  if (!key) return null;
  const trimmed = key.trim();
  if (CAMELOT_RE.test(trimmed)) return trimmed.toUpperCase();
  if (TRADITIONAL_TO_CAMELOT[trimmed]) return TRADITIONAL_TO_CAMELOT[trimmed];
  return null;
}

function parseCamelot(camelot) {
  const match = CAMELOT_RE.exec(camelot);
  if (!match) return null;
  return { number: Number(match[1]), letter: match[2].toUpperCase() };
}

export function isKeyCompatible(keyA, keyB) {
  if (!keyA || !keyB) return false;
  const a = parseCamelot(toCamelot(keyA) ?? '');
  const b = parseCamelot(toCamelot(keyB) ?? '');
  if (!a || !b) return false;
  if (a.number === b.number && a.letter === b.letter) return true;
  if (a.letter === b.letter) {
    const diff = Math.abs(a.number - b.number);
    if (diff === 1 || diff === 11) return true;
  }
  if (a.number === b.number && a.letter !== b.letter) return true;
  return false;
}
