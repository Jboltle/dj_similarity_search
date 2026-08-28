/**
 * Selective-sync filter rules.
 *
 * A `SelectionRules` object shapes which songs cross the sync boundary in
 * each direction. Rules are pure — same input, same output — and the entry
 * point below never mutates its arguments. When a rule field is empty or
 * omitted the filter treats it as "no restriction" so an empty rules object
 * is a no-op (identity filter).
 *
 * The rules use lowercased forward-slash-normalized folder prefixes so
 * Windows-style `C:\Music\Drum & Bass` compares cleanly against Mac-style
 * `/Users/me/Music/Drum & Bass`. Streaming URLs (spotify://, netsearch://)
 * are matched by scheme prefix only.
 */

const STREAMING_SCHEMES = /^(netsearch|http|https|spotify|tidal|deezer|youtube|soundcloud):/i;

/**
 * @typedef {Object} SelectionRules
 * @property {string[]} [includeFolders]
 * @property {string[]} [excludeFolders]
 * @property {string[]} [playlistWhitelist]
 * @property {number | null} [onlyModifiedSince]
 * @property {boolean} [excludeStreaming]
 * @property {string[]} [filePaths]  Explicit allow-list (bypasses folder rules when non-empty).
 */

function normalizeFolder(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  return s.replaceAll('\\', '/').toLowerCase();
}

function normalizeFilePath(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (STREAMING_SCHEMES.test(s)) return s;
  return s.replaceAll('\\', '/').toLowerCase();
}

function songMatchesAnyFolder(song, folders) {
  if (!folders?.length) return false;
  const filePath = normalizeFilePath(song?.filePath ?? song?.file ?? '');
  if (!filePath) return false;
  return folders.some((f) => filePath.startsWith(normalizeFolder(f)));
}

function songInAnyPlaylist(song, playlistWhitelist, playlistIndex) {
  if (!playlistWhitelist?.length) return true;
  if (!playlistIndex) return true;
  const key = normalizeFilePath(song?.filePath ?? song?.file ?? '');
  const playlists = playlistIndex.get(key);
  if (!playlists) return false;
  return playlistWhitelist.some((p) => playlists.has(p));
}

/**
 * Reduce a list of parsed songs to those matching the rules. `songs` is any
 * iterable of objects with a `filePath` (or `file`), an optional numeric
 * `lastModified`, and an optional `isStreaming` flag.
 *
 * @param {Iterable<any>} songs
 * @param {SelectionRules} rules
 * @param {{ playlistIndex?: Map<string, Set<string>> }} [opts]
 * @returns {any[]}
 */
export function applySelection(songs, rules, opts = {}) {
  const list = Array.isArray(songs) ? songs : Array.from(songs ?? []);
  if (!rules || typeof rules !== 'object') return list;

  const filePathAllowList =
    Array.isArray(rules.filePaths) && rules.filePaths.length > 0
      ? new Set(rules.filePaths.map(normalizeFilePath))
      : null;

  const include = (rules.includeFolders ?? []).filter(Boolean);
  const exclude = (rules.excludeFolders ?? []).filter(Boolean);
  const modifiedSince = Number.isFinite(rules.onlyModifiedSince)
    ? Number(rules.onlyModifiedSince)
    : null;
  const excludeStreaming = Boolean(rules.excludeStreaming);
  const playlistWhitelist = (rules.playlistWhitelist ?? []).filter(Boolean);

  return list.filter((song) => {
    const filePath = normalizeFilePath(song?.filePath ?? song?.file ?? '');
    if (!filePath) return false;

    if (filePathAllowList) {
      return filePathAllowList.has(filePath);
    }
    if (include.length && !songMatchesAnyFolder(song, include)) return false;
    if (exclude.length &&  songMatchesAnyFolder(song, exclude)) return false;
    if (modifiedSince != null) {
      const lm = Number(song?.lastModified ?? song?.LastModified ?? 0) || 0;
      if (lm < modifiedSince) return false;
    }
    if (excludeStreaming) {
      const streaming = Boolean(song?.isStreaming) || STREAMING_SCHEMES.test(String(song?.filePath ?? ''));
      if (streaming) return false;
    }
    if (!songInAnyPlaylist(song, playlistWhitelist, opts.playlistIndex)) return false;
    return true;
  });
}

/**
 * @param {SelectionRules | null | undefined} rules
 * @returns {boolean} true when the rules would filter out at least some songs.
 */
export function hasActiveRules(rules) {
  if (!rules || typeof rules !== 'object') return false;
  if (Array.isArray(rules.filePaths) && rules.filePaths.length > 0) return true;
  if (Array.isArray(rules.includeFolders) && rules.includeFolders.length > 0) return true;
  if (Array.isArray(rules.excludeFolders) && rules.excludeFolders.length > 0) return true;
  if (Array.isArray(rules.playlistWhitelist) && rules.playlistWhitelist.length > 0) return true;
  if (Number.isFinite(rules.onlyModifiedSince)) return true;
  if (rules.excludeStreaming) return true;
  return false;
}
