# VirtualDJ Link Map

Read-only desktop tool that visualizes the **real linked tracks** you've defined in VirtualDJ as an interactive Three.js graph, layered with your play-history transitions, and lets you mine the rest of your library on demand for compatible matches.

The default workflow (`parse` + `dev`) **never writes** to VirtualDJ's data. Every read is either via copy-to-temp (SQLite) or `readFileSync` (XML / M3U).

Two **opt-in** commands (`upload:soundcloud` and `merge:links`) can publish your linked-tracks set externally:

- `upload:soundcloud` makes outbound API calls to SoundCloud and creates a playlist named `Linked_DJ_Playlist`.
- `merge:links` is the only command that ever writes to a VirtualDJ `extra.db`, and only with all of: a timestamped backup, a WAL-sidecar guard, a single transaction, and `--write` explicitly passed (otherwise it dry-runs).

See [Sharing linked tracks](#sharing-linked-tracks-opt-in) below.

## Where the data comes from

| Source | What's in it | Used for |
|---|---|---|
| `extra.db` → `related_tracks` (SQLite) | The pairs of songs you marked as linked in VirtualDJ's UI | **Primary edges** (`type: "vdj_link"`) |
| `extra.db` → `track_data` (SQLite) | sid → `(file, artist, title)` for each linked song | Resolving sids to library entries |
| `database.xml` | All 511 of your songs with BPM, key, genre, etc. | Node metadata + library pool for compatible-match suggestions |
| `History/*.m3u` | Session-by-session play sequences | Secondary edges (`type: "history"`, weighted by frequency) |

## Pipeline

```
extra.db (related_tracks + track_data)
   │
database.xml (BPM, key, genre, file paths)            →   public/graph.json
   │                                                   →   public/unresolved-links.json
History/*.m3u (consecutive plays per session)
```

Compatible-match suggestions are **not** precomputed — they're scored in the browser when you click a node.

## Install

```bash
npm install
```

`better-sqlite3` is a native dep; it builds on first install (~10–30s).

## Configure

By default the parser looks for VirtualDJ files at the standard macOS location:

| File | Path |
|---|---|
| Library | `~/Library/Application Support/VirtualDJ/database.xml` |
| Linked tracks | `~/Library/Application Support/VirtualDJ/extra.db` |
| History | `~/Library/Application Support/VirtualDJ/History/` |

Override with environment variables (`.env.example`) or CLI flags:

```bash
VDJ_DB_PATH=/custom/database.xml
VDJ_EXTRA_DB_PATH=/custom/extra.db
VDJ_HISTORY_PATH=/custom/History
```

```bash
node scripts/parse-vdj-db.js --db <path> --extra-db <path> --history <path>
node scripts/parse-vdj-db.js --no-history     # skip history edges
```

## Run

```bash
npm run inspect    # report on database.xml + extra.db structure
npm run parse      # generate public/graph.json
npm run validate   # integrity check on graph.json
npm run dev        # http://localhost:5173
```

## What the parser produces

`public/graph.json`

```json
{
  "meta": {
    "totals": { "songs": 511, "inRelatedTrackPairs": 40, "everPlayed": 295, ... },
    "edges": { "vdjLink": 26, "history": 433 }
  },
  "nodes": [
    { "id": "track_…", "displayName": "Artist - Title", "bpm": 124, "camelotKey": "8A", "genre": "Hip-hop", "linkedCount": 4, "historyPlayCount": 12 }
  ],
  "edges": [
    { "id": "edge_vdj_link_…", "source": "trackA", "target": "trackB", "type": "vdj_link", "resolutionMethod": "exact_path+exact_path",
      "sourceTrackData": { "sid": -1920…, "file": "netsearch://sc…", "artist": "…", "title": "…" } },
    { "id": "edge_history_…", "source": "trackA", "target": "trackC", "type": "history", "weight": 3, "sessionCount": 3, "sessions": ["2026-04-11", …] }
  ]
}
```

## UI

### Tabs (top bar)

- **Related Tracks** (default) — only your real `extra.db.related_tracks` edges (green). Auto-isolates so you only see the ~40 songs you've linked.
- **History** — only play-sequence edges (orange). Auto-isolates to the ~295 songs you've ever played.
- **All edges** — both edge types overlaid; full library visible.

Each tab has a count badge that turns red when empty.

### Node click → sidebar

Three sections per selected song:

1. **Related Tracks** — the other end of every `extra.db.related_tracks` pair this song is part of.
2. **Played around this** — every track played adjacent to this one in history, sorted by transition weight (×N = N sessions had this transition).
3. **Find compatible matches** — *on-demand* search of your full 511-song library for new candidates that are **not yet linked**. Live controls:
   - **BPM tolerance** slider (±0–15)
   - Allow half/double-time
   - Compatible key only (Camelot wheel rules)
   - Same genre only

   Each candidate is scored: BPM proximity (40 pts) + key match (25) + genre (15) + same artist (10) + same folder (10).

### Graph visuals

- **Sphere size** = total linked degree (related + history).
- **Sphere color** = BPM gradient (default), genre, or Camelot key — pick from the "Color by" panel.
- **Edge color** = green for related-track, orange for history.
- **Drag** to pan, **scroll** to zoom, **search** (top bar) recenters the camera.

## File safety

- `database.xml` is opened with `fs.readFileSync('utf8')` only.
- `extra.db` (and any `-wal` / `-shm` sidecars) is **copied to a fresh temp directory** before being opened, then opened `readonly: true` via better-sqlite3, then the temp dir is deleted. The original is never even read-locked.
- All artifacts go to `public/`; nothing is written back to VirtualDJ.

## Sharing linked tracks (opt-in)

Two commands let you take the set of linked tracks you see in the graph and either (a) build a SoundCloud playlist from them, or (b) merge them into another machine's `extra.db` so a different DJ sees the same Linked Tracks in their VirtualDJ.

Both are opt-in — they do nothing until you run them.

### `npm run upload:soundcloud`

Creates a SoundCloud playlist titled `Linked_DJ_Playlist` containing every song in your linked pairs that originated from SoundCloud (the ones with a `netsearch://sc...` source).

```bash
npm run upload:soundcloud                     # default: private playlist
npm run upload:soundcloud -- --sharing public # public
npm run upload:soundcloud -- --title "My Set" --dry-run
npm run upload:soundcloud -- --playlist-id 1234567890   # update existing
```

**One-time setup** (because SoundCloud requires HTTPS redirect URIs since Oct 2024):

1. Create a public GitHub repo (e.g., `djlinker-callback`).
2. Copy `public/oauth-callback.html` from this project into the new repo as `index.html`, push it.
3. In the repo's *Settings → Pages*, enable Pages from the `main` branch. Note the URL (e.g., `https://YOURUSER.github.io/djlinker-callback/`).
4. Register a new app at [soundcloud.com/you/apps](https://soundcloud.com/you/apps). Use the GitHub Pages URL as the redirect URI.
5. Export the credentials in your shell (see [Environment variables](#environment-variables-for-soundcloud) below).

First run opens your browser to SoundCloud; you click Allow, the callback page shows a code with a Copy button, you paste it back into the terminal. Subsequent runs reuse the saved refresh token silently for the next ~hour each.

#### Environment variables for SoundCloud

| Var | Where to get it |
|---|---|
| `SOUNDCLOUD_CLIENT_ID` | SoundCloud app dashboard |
| `SOUNDCLOUD_CLIENT_SECRET` | SoundCloud app dashboard |
| `SOUNDCLOUD_REDIRECT_URI` | Your GitHub Pages URL (must match the app exactly) |

**macOS / Linux:**
```bash
export SOUNDCLOUD_CLIENT_ID=...
export SOUNDCLOUD_CLIENT_SECRET=...
export SOUNDCLOUD_REDIRECT_URI=https://YOURUSER.github.io/djlinker-callback/
```

**Windows (PowerShell):**
```powershell
$env:SOUNDCLOUD_CLIENT_ID="..."
$env:SOUNDCLOUD_CLIENT_SECRET="..."
$env:SOUNDCLOUD_REDIRECT_URI="https://YOURUSER.github.io/djlinker-callback/"
```

### `npm run merge:links` — sync linked tracks Mac ↔ Windows

Two roles in the same command:

1. **Source machine** (where you've curated your linked tracks): produces three portable export files.
2. **Destination machine** (e.g., your Windows laptop): reads one of those files and writes the pairs into its own `extra.db`.

#### Step 1 — On the source machine

```bash
npm run parse           # refresh public/graph.json with your current links
npm run merge:links     # DRY RUN: produces export files, doesn't write anywhere
```

This writes three portable artifacts to `public/`:

| File | Use |
|---|---|
| `linked-tracks-export.json` | Primary sync artifact (small, human-readable) |
| `linked-tracks-export.sql` | One-liner manual import: `sqlite3 extra.db < linked-tracks-export.sql` |
| `linked-tracks.db` | Standalone SQLite with the same two tables; openable in any DB tool |

These files are **not** in `.gitignore` — you can commit them to share between your machines, or copy them manually (USB stick, AirDrop, Dropbox, etc.).

#### Step 2 — Transfer to the destination machine

Easiest: commit and push, then pull on the other machine.

```bash
# on the Mac
git add public/linked-tracks-export.json
git commit -m "sync linked tracks $(date +%F)"
git push
```

```powershell
# on the Windows machine
git pull
npm install        # builds better-sqlite3 for Windows on first run
```

Or just AirDrop / scp the single JSON file.

#### Step 3 — On the destination machine

Close VirtualDJ first (this is non-negotiable). Then:

```powershell
# Windows
npm run merge:links -- --from public/linked-tracks-export.json --write
```

```bash
# macOS / Linux
npm run merge:links -- --from public/linked-tracks-export.json --write
```

The script picks `extra.db` from the platform default (or `$env:VDJ_EXTRA_DB_PATH` / `VDJ_EXTRA_DB_PATH`), makes a timestamped backup, opens it in a single transaction, and inserts only the rows that aren't already present.

#### Other useful invocations

```bash
npm run merge:links                                     # dry-run, default source = graph.json
npm run merge:links -- --write                          # write to own extra.db from graph.json
npm run merge:links -- --from path/to/export.json       # dry-run from an export file
npm run merge:links -- --from path/to/export.json --write   # full sync
npm run merge:links -- --target "/path/to/other/extra.db" --from ./export.json --write
```

**Always-on fallback.** If `--from` is not used, the export files are regenerated on every run regardless of whether the direct DB write succeeds. So if VirtualDJ is open and the script refuses to write, you still have the portable artifacts and a clear instruction printed for how to apply them manually.

**Safety rails on direct writes:**

1. **WAL guard.** If `extra.db-wal` or `extra.db-shm` exist next to the target, the script refuses to open it (VirtualDJ is likely running). Override with `--force-wal` only after closing VDJ.
2. **Timestamped backup** of the target written next to it AND mirrored into `public/backups/` before any write. Filenames are sanitized for Windows (`:` replaced with `-`).
3. **Single transaction** — any error rolls back automatically.
4. **Schema introspection** via `PRAGMA table_info` — tolerates future VDJ versions that add columns. Inserts use `INSERT OR IGNORE`.
5. **Dry-run is the default.** You must pass `--write` to commit anything.

### Cross-platform notes

| Concern | macOS | Windows |
|---|---|---|
| Default VDJ paths | `~/Library/Application Support/VirtualDJ/` | `%USERPROFILE%\Documents\VirtualDJ\` |
| Browser opener | `open <url>` | `cmd.exe /c start "" <url>` |
| Backup filenames | `extra.db.backup-2026-05-12T...` | Colons replaced with dashes — Windows-safe |
| `better-sqlite3` | Prebuilt for arm64 + x64 | Prebuilt for x64; if you hit a build error, install [VS Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) |

Tested commands work identically on both: `parse`, `validate`, `merge:links`, `upload:soundcloud`.

## Project layout

```
vdj-link-map/
├── index.html
├── scripts/
│   ├── inspect-link-shape.js       # database.xml + extra.db structure report
│   ├── parse-vdj-db.js             # extra.db → vdj_link, History → history
│   ├── validate-graph.js
│   ├── upload-to-soundcloud.js     # OPT-IN: create SC playlist from linked pairs
│   ├── merge-links-to-extra-db.js  # OPT-IN: merge linked pairs into a target extra.db
│   └── lib/
│       ├── relatedTracks.js        # SQLite reader (read-only, copy-to-temp)
│       ├── history.js              # M3U session log parser
│       ├── xml.js                  # database.xml parser
│       ├── paths.js                # path normalization + resolution
│       ├── bpm.js                  # VDJ BPM conversion + grouping
│       ├── key.js                  # Camelot detection + compatibility
│       ├── id.js                   # stable hash IDs for nodes/edges
│       ├── linkedSongs.js          # graph.json → vdj_link pairs + SC track IDs
│       ├── linkedTracksExport.js   # portable JSON + SQL + .db export (fallback)
│       ├── extraDbWriter.js        # WAL guard + backup + transactional writes
│       ├── openBrowser.js          # cross-platform default-browser launcher
│       ├── soundcloudAuth.js       # OAuth 2.1 + PKCE + paste-back flow
│       └── soundcloudClient.js     # POST/PUT /playlists wrapper
├── src/
│   ├── main.js                     # entry: load graph, wire UI, manage selection
│   ├── styles.css
│   ├── data/loadGraph.js
│   ├── graph/{layout, renderer, colors}.js
│   ├── match/findMatches.js        # on-demand BPM/key/genre scoring
│   └── ui/{search, filters, sidebar, tooltip}.js
└── public/                         # generated artifacts (git-ignored)
    ├── oauth-callback.html         # COMMITTED: deploy to GitHub Pages
    ├── graph.json
    ├── linked-tracks-export.{json,sql}
    ├── linked-tracks.db
    ├── soundcloud-playlist.json
    ├── merge-extra-db-report.json
    └── backups/                    # extra.db backups, never auto-deleted
```
