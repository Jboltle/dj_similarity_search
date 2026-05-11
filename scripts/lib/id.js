import crypto from 'node:crypto';

export function stableId(...parts) {
  const hash = crypto.createHash('sha1');
  for (const part of parts) {
    hash.update(String(part ?? ''));
    hash.update('\u0001');
  }
  return `track_${hash.digest('hex').slice(0, 12)}`;
}

export function edgeId(sourceId, targetId, type) {
  const [a, b] = [sourceId, targetId].sort();
  return `edge_${type}_${a}_${b}`;
}
