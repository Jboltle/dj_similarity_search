import * as THREE from 'three';

const BPM_COLOR_STOPS = [
  { bpm: 60, color: '#5b8def' },
  { bpm: 90, color: '#5bd3ef' },
  { bpm: 110, color: '#7cffa8' },
  { bpm: 124, color: '#ffd66b' },
  { bpm: 140, color: '#ff8a5b' },
  { bpm: 160, color: '#ff5b9b' },
  { bpm: 180, color: '#c75bff' },
];

const FALLBACK_COLOR = new THREE.Color('#6b7280');

function lerpColor(a, b, t) {
  const ca = new THREE.Color(a);
  const cb = new THREE.Color(b);
  return ca.lerp(cb, t);
}

export function colorForBpm(bpm) {
  if (bpm == null) return FALLBACK_COLOR.clone();
  if (bpm <= BPM_COLOR_STOPS[0].bpm) return new THREE.Color(BPM_COLOR_STOPS[0].color);
  if (bpm >= BPM_COLOR_STOPS[BPM_COLOR_STOPS.length - 1].bpm) {
    return new THREE.Color(BPM_COLOR_STOPS[BPM_COLOR_STOPS.length - 1].color);
  }
  for (let i = 0; i < BPM_COLOR_STOPS.length - 1; i += 1) {
    const a = BPM_COLOR_STOPS[i];
    const b = BPM_COLOR_STOPS[i + 1];
    if (bpm >= a.bpm && bpm <= b.bpm) {
      const t = (bpm - a.bpm) / (b.bpm - a.bpm);
      return lerpColor(a.color, b.color, t);
    }
  }
  return FALLBACK_COLOR.clone();
}

function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i += 1) {
    h = (h * 31 + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function colorForCategory(value) {
  if (!value) return FALLBACK_COLOR.clone();
  const hue = (hashString(value) % 360) / 360;
  return new THREE.Color().setHSL(hue, 0.55, 0.6);
}

export function colorForKey(camelotKey) {
  if (!camelotKey) return FALLBACK_COLOR.clone();
  const match = /^([1-9]|1[0-2])([AB])$/.exec(camelotKey);
  if (!match) return FALLBACK_COLOR.clone();
  const number = Number(match[1]);
  const letter = match[2];
  const hue = ((number - 1) / 12) % 1;
  const lightness = letter === 'A' ? 0.5 : 0.65;
  return new THREE.Color().setHSL(hue, 0.6, lightness);
}

export function nodeColor(node, mode) {
  switch (mode) {
    case 'genre':
      return colorForCategory(node.genre);
    case 'key':
      return colorForKey(node.camelotKey);
    case 'bpm':
    default:
      return colorForBpm(node.bpm);
  }
}
