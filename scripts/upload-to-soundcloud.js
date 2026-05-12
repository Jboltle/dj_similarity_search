#!/usr/bin/env node
/**
 * Build a SoundCloud playlist from every song that participates in a vdj_link
 * edge AND has a `sc<id>` netSearchRef (i.e. originated from SoundCloud).
 *
 * Default title: `Linked_DJ_Playlist`. Override with --title.
 *
 * Auth is via OAuth 2.1 + PKCE with a user-hosted HTTPS callback page (see
 * public/oauth-callback.html). See scripts/lib/soundcloudAuth.js for details.
 *
 * Output:
 *   - On success: writes public/soundcloud-playlist.json with the playlist URL,
 *     included track IDs, and a list of skipped songs (e.g. Deezer-sourced).
 *   - On API failure: rethrows so the CLI exits non-zero, but the playlist
 *     skip-list is still helpful for debugging.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLinkedSongs, SKIP_REASON } from './lib/linkedSongs.js';
import { getValidAccessToken, forceReauth } from './lib/soundcloudAuth.js';
import { createPlaylist, updatePlaylistTracks, SoundCloudApiError } from './lib/soundcloudClient.js';

const DEFAULT_TITLE = 'Linked_DJ_Playlist';
const DEFAULT_SHARING = 'private';
const SHARING_VALUES = new Set(['public', 'private']);

function parseArgs(argv) {
  const args = {
    title: DEFAULT_TITLE,
    description: null,
    sharing: DEFAULT_SHARING,
    playlistId: null,
    dryRun: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--title' && argv[i + 1]) {
      args.title = argv[i + 1];
      i += 1;
    } else if (arg === '--description' && argv[i + 1]) {
      args.description = argv[i + 1];
      i += 1;
    } else if (arg === '--sharing' && argv[i + 1]) {
      const value = argv[i + 1];
      if (!SHARING_VALUES.has(value)) {
        throw new Error(`--sharing must be one of: ${[...SHARING_VALUES].join(', ')}`);
      }
      args.sharing = value;
      i += 1;
    } else if (arg === '--playlist-id' && argv[i + 1]) {
      args.playlistId = argv[i + 1];
      i += 1;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    }
  }
  return args;
}

function buildDefaultDescription({ pairCount, trackCount }) {
  return (
    `Auto-generated from djLinker on ${new Date().toISOString().slice(0, 10)}. ` +
    `${trackCount} SoundCloud tracks across ${pairCount} manually linked pairs from my VirtualDJ library.`
  );
}

function summarizeSkipped(skipped) {
  const counts = new Map();
  for (const entry of skipped) {
    counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + 1);
  }
  return [...counts.entries()].map(([reason, count]) => ({ reason, count }));
}

function getPublicDir() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(here, '..');
  return path.join(projectRoot, 'public');
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

async function callApiWithRetry({ args, trackIds, token }) {
  try {
    if (args.playlistId) {
      return {
        action: 'updated',
        result: await updatePlaylistTracks({
          playlistId: args.playlistId,
          trackIds,
          token: token.access_token,
        }),
      };
    }
    return {
      action: 'created',
      result: await createPlaylist({
        title: args.title,
        description: args.description ?? buildDefaultDescription({
          pairCount: 0,
          trackCount: trackIds.length,
        }),
        sharing: args.sharing,
        trackIds,
        token: token.access_token,
      }),
    };
  } catch (err) {
    if (err instanceof SoundCloudApiError && err.status === 401) {
      console.warn('[upload] Token rejected with 401. Forcing re-auth and retrying once...');
      const freshToken = await forceReauth();
      if (args.playlistId) {
        return {
          action: 'updated',
          result: await updatePlaylistTracks({
            playlistId: args.playlistId,
            trackIds,
            token: freshToken.access_token,
          }),
        };
      }
      return {
        action: 'created',
        result: await createPlaylist({
          title: args.title,
          description: args.description ?? buildDefaultDescription({
            pairCount: 0,
            trackCount: trackIds.length,
          }),
          sharing: args.sharing,
          trackIds,
          token: freshToken.access_token,
        }),
      };
    }
    throw err;
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const { pairs, soundcloudTracks, meta } = loadLinkedSongs();

  if (args.description == null) {
    args.description = buildDefaultDescription({
      pairCount: pairs.length,
      trackCount: soundcloudTracks.included.length,
    });
  }

  const trackIds = soundcloudTracks.included.map((entry) => entry.trackId);
  const includedSongs = soundcloudTracks.included.map((entry) => ({
    trackId: entry.trackId,
    displayName: entry.node.displayName,
    artist: entry.node.artist,
    title: entry.node.title,
  }));
  const skippedSongs = soundcloudTracks.skipped.map((entry) => ({
    reason: entry.reason,
    displayName: entry.node.displayName,
    netSearchRef: entry.netSearchRef ?? null,
    filePath: entry.node.filePath ?? null,
  }));

  console.log('[upload] ─── SoundCloud playlist upload ───');
  console.log(`[upload] vdj_link pairs:               ${pairs.length}`);
  console.log(`[upload] SoundCloud-sourced tracks:    ${trackIds.length}`);
  console.log(`[upload] Skipped (not SC-sourced):     ${skippedSongs.length}`);
  for (const summary of summarizeSkipped(soundcloudTracks.skipped)) {
    console.log(`[upload]   - ${summary.reason}: ${summary.count}`);
  }

  if (trackIds.length === 0) {
    throw new Error(
      'No SoundCloud-sourced tracks among your linked pairs. ' +
        'Make sure you have linked songs in VirtualDJ that came from SoundCloud netsearch.'
    );
  }

  if (args.dryRun) {
    console.log('\n[upload] --dry-run: payload that would be sent:');
    console.log(
      JSON.stringify(
        {
          action: args.playlistId ? 'PUT' : 'POST',
          title: args.title,
          description: args.description,
          sharing: args.sharing,
          playlistId: args.playlistId,
          trackIds,
        },
        null,
        2
      )
    );
    writeJson(path.join(getPublicDir(), 'soundcloud-playlist.json'), {
      dryRun: true,
      generatedAt: new Date().toISOString(),
      sourceGraph: meta?.databasePath ?? null,
      title: args.title,
      description: args.description,
      sharing: args.sharing,
      playlistId: args.playlistId,
      includedTrackIds: trackIds,
      includedSongs,
      skippedSongs,
    });
    return;
  }

  console.log('\n[upload] Acquiring SoundCloud access token...');
  const token = await getValidAccessToken();

  console.log(
    args.playlistId
      ? `[upload] Updating existing playlist ${args.playlistId}...`
      : `[upload] Creating playlist "${args.title}"...`
  );
  const { action, result } = await callApiWithRetry({ args, trackIds, token });

  console.log(`[upload] Playlist ${action}.`);
  console.log(`[upload] URL: ${result?.permalink_url ?? '(no URL returned)'}`);

  writeJson(path.join(getPublicDir(), 'soundcloud-playlist.json'), {
    dryRun: false,
    generatedAt: new Date().toISOString(),
    sourceGraph: meta?.databasePath ?? null,
    action,
    title: args.title,
    description: args.description,
    sharing: args.sharing,
    playlistId: result?.id ?? args.playlistId ?? null,
    playlistUrl: result?.permalink_url ?? null,
    includedTrackIds: trackIds,
    includedSongs,
    skippedSongs,
    rawResponseSummary: {
      id: result?.id ?? null,
      title: result?.title ?? null,
      track_count: result?.track_count ?? null,
      sharing: result?.sharing ?? null,
    },
  });
  console.log('[upload] Wrote → public/soundcloud-playlist.json');
}

main().catch((error) => {
  console.error(`[upload] ERROR: ${error.message}`);
  if (error.body && process.env.DEBUG) {
    console.error('[upload] Response body:', error.body);
  }
  process.exitCode = 1;
});
