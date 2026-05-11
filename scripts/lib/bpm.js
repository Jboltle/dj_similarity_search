const SUSPICIOUS_MIN_BPM = 40;
const SUSPICIOUS_MAX_BPM = 250;

export function convertVdjBpm(rawBpm) {
  if (rawBpm === null || rawBpm === undefined || rawBpm === '') {
    return { bpm: null, raw: null, suspicious: false };
  }
  const numeric = Number(rawBpm);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return { bpm: null, raw: numeric, suspicious: true };
  }
  // VirtualDJ stores BPM as seconds-per-beat (Bpm="0.5" → 120 BPM).
  const bpm = Number((60 / numeric).toFixed(2));
  const suspicious = bpm < SUSPICIOUS_MIN_BPM || bpm > SUSPICIOUS_MAX_BPM;
  return { bpm, raw: numeric, suspicious };
}

export function bpmDistance(a, b) {
  if (a == null || b == null) return Infinity;
  const direct = Math.abs(a - b);
  // Consider half-time / double-time relationships as a separate, larger window.
  const halfTime = Math.abs(a - b * 2);
  const doubleTime = Math.abs(a - b / 2);
  return Math.min(direct, halfTime, doubleTime);
}

export function bpmGroup(bpm) {
  if (bpm == null) return 'unknown';
  if (bpm < 80) return '60-80';
  if (bpm < 100) return '80-100';
  if (bpm < 115) return '100-115';
  if (bpm < 130) return '115-130';
  if (bpm < 150) return '130-150';
  return '150+';
}
