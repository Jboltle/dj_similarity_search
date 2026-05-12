/**
 * Thin SoundCloud REST client. Uses Node 20's built-in fetch — no extra dep.
 *
 * Only the two endpoints we need:
 *   POST /playlists            create a new playlist with tracks
 *   PUT  /playlists/{id}       replace the track list on an existing playlist
 *
 * Errors are surfaced as `SoundCloudApiError` so callers can match on .status.
 */
const API_BASE = 'https://api.soundcloud.com';

export class SoundCloudApiError extends Error {
  constructor(message, { status, body, endpoint } = {}) {
    super(message);
    this.name = 'SoundCloudApiError';
    this.status = status ?? null;
    this.body = body ?? null;
    this.endpoint = endpoint ?? null;
  }
}

async function callApi({ method, path, token, body }) {
  const url = `${API_BASE}${path}`;
  const response = await fetch(url, {
    method,
    headers: {
      'Accept': 'application/json; charset=utf-8',
      'Authorization': `OAuth ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text.length ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!response.ok) {
    const message =
      (parsed && typeof parsed === 'object' && (parsed.message || parsed.error)) ||
      text ||
      response.statusText;
    throw new SoundCloudApiError(`${method} ${path} → ${response.status}: ${message}`, {
      status: response.status,
      body: parsed,
      endpoint: `${method} ${path}`,
    });
  }
  return parsed;
}

function trackIdsToPayload(trackIds) {
  return trackIds
    .map((id) => Number.parseInt(id, 10))
    .filter((n) => Number.isFinite(n) && n > 0)
    .map((id) => ({ id }));
}

/**
 * POST /playlists. Returns the created playlist object (incl. `permalink_url`
 * and `id`).
 */
export async function createPlaylist({ title, description, sharing, trackIds, token }) {
  const tracks = trackIdsToPayload(trackIds);
  return callApi({
    method: 'POST',
    path: '/playlists',
    token,
    body: {
      playlist: {
        title,
        description: description ?? '',
        sharing: sharing ?? 'private',
        tracks,
      },
    },
  });
}

/**
 * PUT /playlists/{id}. Replaces the tracks list on an existing playlist.
 */
export async function updatePlaylistTracks({ playlistId, trackIds, token }) {
  const tracks = trackIdsToPayload(trackIds);
  return callApi({
    method: 'PUT',
    path: `/playlists/${encodeURIComponent(playlistId)}`,
    token,
    body: {
      playlist: { tracks },
    },
  });
}
