/**
 * SoundCloud OAuth 2.1 + PKCE for a CLI / native app.
 *
 * Flow:
 *   1. Build a random `code_verifier` (RFC 7636) and SHA-256 `code_challenge`.
 *   2. Open the user's browser to https://secure.soundcloud.com/authorize?... .
 *   3. SoundCloud redirects to the user-hosted HTTPS callback page
 *      (e.g. https://USERNAME.github.io/djlinker-callback/) which displays the
 *      ?code=... and ?state=... values with a copy button.
 *   4. We prompt on stdin for the code (and optionally state) and exchange it
 *      at https://secure.soundcloud.com/oauth/token .
 *   5. Tokens persist to .soundcloud-tokens.json (gitignored). On subsequent
 *      runs we use the refresh token; only if that fails do we re-prompt.
 *
 * Why no loopback HTTP server?
 *   As of October 2024 SoundCloud rejects all http:// redirect URIs at the
 *   token endpoint with 400 invalid_grant. See soundcloud/api#341.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { loadProjectEnv } from './env.js';
import { openBrowser } from './openBrowser.js';

loadProjectEnv();

const AUTHORIZE_URL = 'https://secure.soundcloud.com/authorize';
const TOKEN_URL = 'https://secure.soundcloud.com/oauth/token';

const TOKEN_REFRESH_SAFETY_MS = 60_000;
const PKCE_VERIFIER_BYTES = 48;
const STATE_BYTES = 24;

function getTokenStorePath() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(here, '..', '..');
  return path.join(projectRoot, '.soundcloud-tokens.json');
}

function base64UrlEncode(buffer) {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function generatePkcePair() {
  const verifier = base64UrlEncode(crypto.randomBytes(PKCE_VERIFIER_BYTES));
  const challenge = base64UrlEncode(
    crypto.createHash('sha256').update(verifier).digest()
  );
  return { verifier, challenge };
}

function readStoredTokens() {
  const tokenPath = getTokenStorePath();
  if (!fs.existsSync(tokenPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
    if (!parsed.access_token || !parsed.refresh_token) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeStoredTokens(tokens) {
  const tokenPath = getTokenStorePath();
  const payload = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_type: tokens.token_type ?? 'OAuth',
    expires_at:
      tokens.expires_at ??
      (typeof tokens.expires_in === 'number'
        ? Date.now() + tokens.expires_in * 1000
        : Date.now() + 3600 * 1000),
    scope: tokens.scope ?? null,
  };
  fs.writeFileSync(tokenPath, JSON.stringify(payload, null, 2), { mode: 0o600 });
  return payload;
}

function isTokenFresh(tokens) {
  if (!tokens?.expires_at) return false;
  return Date.now() + TOKEN_REFRESH_SAFETY_MS < tokens.expires_at;
}

/**
 * SoundCloud compares redirect_uri as an exact string on authorize and token.
 * GitHub Pages URLs are often registered with a trailing slash; add it without
 * using `new URL().href` — that lowercases the host and breaks apps registered
 * with mixed-case hostnames (e.g. Jboltle.github.io).
 */
function normalizeSoundCloudRedirectUri(raw) {
  const t = raw.trim();
  if (!/^https:\/\/[^/]+\.github\.io\//i.test(t)) return t;
  if (t.includes('?')) return t;
  if (t.endsWith('/')) return t;
  return `${t}/`;
}

function getConfig() {
  const clientId = process.env.SOUNDCLOUD_CLIENT_ID?.trim();
  const clientSecret = process.env.SOUNDCLOUD_CLIENT_SECRET?.trim();
  const rawRedirect = process.env.SOUNDCLOUD_REDIRECT_URI;

  const missing = [];
  if (!clientId) missing.push('SOUNDCLOUD_CLIENT_ID');
  if (!clientSecret) missing.push('SOUNDCLOUD_CLIENT_SECRET');
  if (!rawRedirect?.trim()) missing.push('SOUNDCLOUD_REDIRECT_URI');
  if (missing.length) {
    throw new Error(
      `Missing required env vars: ${missing.join(', ')}.\n` +
        `Register an app at https://soundcloud.com/you/apps, then export the values.\n` +
        `See .env.example for the full list.`
    );
  }
  const redirectUri = normalizeSoundCloudRedirectUri(rawRedirect);
  if (!/^https:\/\//i.test(redirectUri)) {
    throw new Error(
      `SOUNDCLOUD_REDIRECT_URI must be an https:// URL. SoundCloud has rejected ` +
        `http:// redirect URIs since Oct 2024. Got: ${redirectUri}`
    );
  }
  return { clientId, clientSecret, redirectUri };
}

async function postForm(url, body) {
  const params = new URLSearchParams(body);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Accept': 'application/json; charset=utf-8',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text.length ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const message = parsed?.error_description ?? parsed?.error ?? text ?? response.statusText;
    const err = new Error(`SoundCloud token endpoint ${response.status}: ${message}`);
    err.status = response.status;
    err.body = parsed ?? text;
    if (parsed?.error === 'invalid_grant' && /redirect/i.test(String(parsed?.error_description ?? ''))) {
      err.message +=
        '\nHint: In soundcloud.com/you/apps, the redirect URI must match SOUNDCLOUD_REDIRECT_URI exactly (https, path, trailing slash, and letter case).';
    }
    throw err;
  }
  return parsed;
}

async function exchangeCodeForToken({ clientId, clientSecret, redirectUri, code, codeVerifier }) {
  return postForm(TOKEN_URL, {
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
    code,
  });
}

async function refreshAccessToken({ clientId, clientSecret, refreshToken }) {
  return postForm(TOKEN_URL, {
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });
}

function buildAuthorizeUrl({ clientId, redirectUri, codeChallenge, state }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

async function promptForCode({ authorizeUrl, expectedState }) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    console.log('\nOpening your browser to authorize djLinker on SoundCloud...');
    console.log('If the browser does not open automatically, visit this URL:');
    console.log(`\n  ${authorizeUrl}\n`);
    openBrowser(authorizeUrl);

    const code = (await rl.question('Paste the authorization code from the callback page: ')).trim();
    if (!code) throw new Error('No code provided. Authentication aborted.');

    const stateAnswer = (
      await rl.question('Paste the state value (or press Enter to skip CSRF check): ')
    ).trim();
    if (stateAnswer && stateAnswer !== expectedState) {
      throw new Error(
        `State mismatch — possible CSRF. Expected ${expectedState}, got ${stateAnswer}.`
      );
    }
    return code;
  } finally {
    rl.close();
  }
}

async function runInteractiveFlow() {
  const { clientId, clientSecret, redirectUri } = getConfig();
  console.log(`[soundcloud] redirect_uri sent to SoundCloud: ${redirectUri}`);
  const { verifier, challenge } = generatePkcePair();
  const state = base64UrlEncode(crypto.randomBytes(STATE_BYTES));
  const authorizeUrl = buildAuthorizeUrl({
    clientId,
    redirectUri,
    codeChallenge: challenge,
    state,
  });
  const code = await promptForCode({ authorizeUrl, expectedState: state });
  const tokenResponse = await exchangeCodeForToken({
    clientId,
    clientSecret,
    redirectUri,
    code,
    codeVerifier: verifier,
  });
  return writeStoredTokens(tokenResponse);
}

async function tryRefresh(stored) {
  const { clientId, clientSecret } = getConfig();
  const refreshed = await refreshAccessToken({
    clientId,
    clientSecret,
    refreshToken: stored.refresh_token,
  });
  return writeStoredTokens(refreshed);
}

/**
 * Returns a fresh `{access_token, refresh_token, expires_at}`. Will:
 *   - reuse the stored token if it's still fresh,
 *   - refresh it if expired,
 *   - fall back to the full interactive flow if refresh fails or no tokens exist.
 */
export async function getValidAccessToken() {
  const stored = readStoredTokens();
  if (stored && isTokenFresh(stored)) return stored;

  if (stored) {
    try {
      return await tryRefresh(stored);
    } catch (err) {
      console.warn(
        `[auth] Refresh failed (${err.message}). Falling back to interactive login.`
      );
    }
  }

  return runInteractiveFlow();
}

/**
 * Force a fresh interactive login regardless of what's stored. Used when the
 * caller wants to recover from a definitively-invalid token (e.g. 401 after
 * a fresh refresh).
 */
export async function forceReauth() {
  return runInteractiveFlow();
}
