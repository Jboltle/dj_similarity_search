# VirtualDJ Link Map

A standalone desktop app for macOS and Windows that visualizes the tracks you've
manually **linked** inside VirtualDJ as a live 3D graph, layers your
play-history transitions on top, and — when you enable it — keeps your entire
library (including per-song markers, hot cues, saved loops, and beat grid) in
sync between machines.

## Install

1. Download the latest installer from the [Releases](../../releases) page:
   - **macOS** → `VirtualDJ Link Map-<version>.dmg`
   - **Windows** → `VirtualDJ Link Map Setup <version>.exe`
2. Open the installer.
3. On first launch, point the app at your VirtualDJ data folder. It usually
   auto-detects — you just click **Confirm**.
4. Done. The graph appears within a few seconds.

## What it does

- **Visualize your linked tracks** as a Three.js force-directed graph, colored
  by BPM, key, or genre.
- **Layer your play history** on top so you can see which tracks you actually
  mix in and out of together.
- **Find compatible matches** for any song on demand — BPM proximity, Camelot
  wheel, same genre, same folder — without ever precomputing them.
- **Keep every machine in sync**. Push the songs, links, and markers you edited
  on one machine to a shared library; pull down what everyone else added.
  Newest edit wins, per song, per marker.

## How to sync

The in-app **Sync** panel (top-right corner) shows three sections every time
you open it:

- **New here → shared library** — songs, linked pairs, and history files that
  exist on this machine but not in the shared library. Click **Push** to
  upload them.
- **New on shared library → this machine** — songs, links, and history files
  that other machines have added. Click **Pull** to apply them locally.
- **Conflicts** — songs edited on both sides since the last sync. The panel
  shows both `LastModified` timestamps and which side will win if you accept
  the merge (newest edit wins by default).

Every push and pull takes a timestamped backup of the files it's about to
touch. Use **Settings → Restore from backup…** to roll back to any previous
state.

**Song markers are preserved automatically.** Cue points, hot cues, saved
loops, beat grid, key overrides, and every other per-song setting live inside
`database.xml` (under each `<Song>` element's `<Infos>` / `<POIs>` /
`<Scan>` blocks). The sync engine merges at the song level using each song's
`LastModified` timestamp, so whichever machine last edited a given song wins
that whole song — markers and all. You never have to think about it.

Before you can push or pull, open **Settings** and pick a sync target:

- **Git** — point it at any private repo (GitHub, self-hosted Gitea, etc.). All
  push/pull happens over `git`, so history is fully auditable.
- **Local folder** — point it at a Dropbox / iCloud / SMB folder shared
  between machines.
- **None** — disables sync entirely. You can still use the app for
  visualization on a single machine.

## Where the app stores data

| OS      | Path                                                      |
|---------|-----------------------------------------------------------|
| macOS   | `~/Library/Application Support/VirtualDJ Link Map/`       |
| Windows | `%APPDATA%\VirtualDJ Link Map\`                           |

That folder contains:

- `settings.json` — your VDJ folder path, sync mode, machine identity, etc.
- `graph.json` — the current parsed graph the UI renders.
- `sync-repo/` — clone / local mirror of the shared library (only if sync is
  enabled).
- `backups/` — timestamped backups from every write. Never auto-pruned.

The app **never writes to your VirtualDJ folder** unless you explicitly click
**Pull** with a diff that includes remote changes, or restore from a backup.

## Building from source

Requires Node.js 18+.

```bash
npm install                 # installs Vite + Electron + parser deps
npm run dev:app             # launches Vite + Electron in dev mode
npm run dist:mac            # builds signed .dmg into dist/
npm run dist:win            # builds .exe installer into dist/
```

The Vite renderer alone (browser tab, no Electron shell) still runs with
`npm run dev` and hits `public/graph.json` via `fetch`. Sync and Settings
controls are hidden or disabled in browser mode because they require Node.

---

## Command-line tools

Everything below documents the underlying CLI scripts. They still work
standalone if you want to script parsing, syncing, or SoundCloud uploads
outside of the desktop app. The app calls the same scripts under the hood via
its Electron main process.

The default workflow (`parse` + `dev`) **never writes** to VirtualDJ's data.
Every read is either via copy-to-temp (SQLite) or `readFileSync` (XML / M3U).

Opt-in commands let you sync your VDJ data between machines, surface your
linked tracks as a VDJ sidebar folder, or publish them as a SoundCloud playlist:

- `sync:push` / `sync:pull` / `sync:merge` / `sync:restore` — **bidirectional
  union merge** of `database.xml`, `extra.db`, and `History/` between machines
  via git. Newest `<Infos LastModified>` wins for Song collisions; extra.db
  rows are unioned; history files are content-hash deduped. Every write takes
  a SHA-256-fingerprinted backup; `sync:restore` rolls back.
- `linked:folder` — writes `<VDJ_FOLDER>/Folders/Linked Tracks.vdjfolder` so
  every song with at least one linked pair appears as a static folder in
  VirtualDJ's sidebar. Runs automatically at the end of `sync:pull --write`.
- `upload:soundcloud` — creates a SoundCloud playlist named `Linked_DJ_Playlist`
  containing every linked song with a `netsearch://sc…` source.

See [Bidirectional sync](#bidirectional-sync-mac--windows-via-git),
[Linked-tracks folder](#linked-tracks-playlist-folder), and
[SoundCloud playlist](#soundcloud-playlist) below.

### Where the data comes from

| Source | What's in it | Used for |
|---|---|---|
| `extra.db` → `related_tracks` (SQLite) | The pairs of songs you marked as linked in VirtualDJ's UI | **Primary edges** (`type: "vdj_link"`) |
| `extra.db` → `track_data` (SQLite) | sid → `(file, artist, title)` for each linked song | Resolving sids to library entries |
| `database.xml` | Every song in your library with BPM, key, genre, etc. | Node metadata + library pool for compatible-match suggestions |
| `History/*.m3u` | Session-by-session play sequences | Secondary edges (`type: "history"`, weighted by frequency) |

### Pipeline

```
extra.db (related_tracks + track_data)
   │
database.xml (BPM, key, genre, file paths)            →   public/graph.json
   │                                                   →   public/unresolved-links.json
History/*.m3u (consecutive plays per session)
```

Compatible-match suggestions are **not** precomputed — they're scored in the
browser when you click a node.

### Install

```bash
npm install
```

`better-sqlite3` is a native dep; it builds on first install (~10–30s).

### Configure

By default the parser auto-locates VirtualDJ at the standard location for your OS
(including WSL → Windows `/mnt/c/Users/<you>/AppData/Local/VirtualDJ` translation).

| File | macOS | Windows |
|---|---|---|
| Library | `~/Library/Application Support/VirtualDJ/database.xml` | `%LOCALAPPDATA%\VirtualDJ\database.xml` |
| Linked tracks | `~/Library/Application Support/VirtualDJ/extra.db` | `%LOCALAPPDATA%\VirtualDJ\extra.db` |
| History | `~/Library/Application Support/VirtualDJ/History/` | `%LOCALAPPDATA%\VirtualDJ\History\` |

Override with environment variables (`.env.example`) or CLI flags. Set
**`VDJ_FOLDER`** once to the VirtualDJ data directory; individual paths still
override when set:

```bash
VDJ_FOLDER=/custom/VirtualDJ
VDJ_DB_PATH=/custom/database.xml
VDJ_EXTRA_DB_PATH=/custom/extra.db
VDJ_HISTORY_PATH=/custom/History
```

### Run

```bash
npm run parse      # generate public/graph.json
npm run validate   # integrity check on graph.json
npm run dev        # http://localhost:5173
npm run build      # build static site into dist/
npm run inspect    # one-off debug report on extra.db schema → public/link-shape-report.json
```

### What the parser produces

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

### UI

#### Tabs (top bar)

- **Related Tracks** (default) — only your real `extra.db.related_tracks` edges (green). Auto-isolates so you only see the songs you've linked.
- **History** — only play-sequence edges (orange). Auto-isolates to the songs you've ever played.
- **All edges** — both edge types overlaid; full library visible.

Each tab has a count badge that turns red when empty.

#### Node click → sidebar

Three sections per selected song:

1. **Related Tracks** — the other end of every `extra.db.related_tracks` pair this song is part of.
2. **Played around this** — every track played adjacent to this one in history, sorted by transition weight (×N = N sessions had this transition).
3. **Find compatible matches** — *on-demand* search of your full library for new candidates that are **not yet linked**. Live controls:
   - **BPM tolerance** slider (±0–15)
   - Allow half/double-time
   - Compatible key only (Camelot wheel rules)
   - Same genre only

   Each candidate is scored: BPM proximity (40 pts) + key match (25) + genre (15) + same artist (10) + same folder (10).

#### Graph visuals

- **Sphere size** = total linked degree (related + history).
- **Sphere color** = BPM gradient (default), genre, or Camelot key — pick from the "Color by" panel.
- **Edge color** = green for related-track, orange for history.
- **Drag** to pan, **scroll** to zoom, **search** (top bar) recenters the camera.

### File safety

- `database.xml` is opened with `fs.readFileSync('utf8')` only.
- `extra.db` (and any `-wal` / `-shm` sidecars) is **copied to a fresh temp directory** before being opened, then opened `readonly: true` via better-sqlite3, then the temp dir is deleted. The original is never even read-locked by the parser.
- Generated artifacts go to `public/`; nothing is written back to VirtualDJ unless you explicitly invoke `sync:pull --write` or `linked:folder --write`.
- Write commands take a SHA-256-fingerprinted backup into `public/backups/` and side-by-side `.backup-<stamp>` files before touching anything.

### Linked-tracks playlist folder

`npm run linked:folder` writes a static VirtualDJ folder (`.vdjfolder`) that
lists every song participating in at least one linked-tracks pair from your
local `extra.db`. It appears in VirtualDJ's sidebar under **Folders** as
"Linked Tracks" (rename via `--name "Whatever"`).

```bash
npm run linked:folder                              # dry-run (default)
npm run linked:folder -- --write                   # actually create / overwrite
npm run linked:folder -- --write --force-wal       # write even if VDJ sidecars present
npm run linked:folder -- --name "My Linked Set"    # custom folder name
```

The output file lands at `<VDJ_FOLDER>/Folders/<name>.vdjfolder`. Existing
files are backed up next to the original AND into
`public/backups/linked-folder-<stamp>/` before overwrite.

This command also runs automatically at the end of `sync:pull --write` so the
folder stays in sync with the merged link set across machines. Disable with
`--no-linked-folder` if you'd rather manage it yourself.

### Bidirectional sync (Mac ↔ Windows via git)

A true bidirectional union merge of `database.xml`, `extra.db`, and `History/`
between machines via a committed `sync/` folder in this repo. Two machines can
push and pull independently without anyone losing data.

#### Layout in the repo

```
sync/
  mac/         # raw VirtualDJ snapshot from the Mac (whoever pushed last)
  windows/     # raw VirtualDJ snapshot from the Windows machine
  merged/      # deterministically regenerated union of mac/ + windows/
```

Each subfolder holds `database.xml`, `extra.db`, `History/`, and a
`manifest.json`. `merged/` additionally carries `merge-report.json` with
per-Song conflict details.

#### Daily workflow

```bash
# On either machine:
npm run sync:pull -- --write    # git pull → re-merge → apply to local VDJ
                                # (additive, full pre-write backup, refreshes
                                # public/graph.json + Linked Tracks folder)
# ...VirtualDJ work, history accumulates, linked tracks change...
npm run sync:push               # snapshots local VDJ → sync/<machine>/,
                                # regenerates sync/merged/, commits, pushes.
```

VirtualDJ must be **closed** before `sync:push` and `sync:pull --write` — the
scripts check for `extra.db-wal`/`extra.db-shm` sidecars and refuse to proceed
otherwise (override at your own risk with `--force-wal`).

#### Conflict rules

- **database.xml** — union by `FilePath`. On collision, the Song element with
  the larger `<Infos LastModified="…">` epoch wins. Tie-breaker: streaming
  paths (`netsearch://…`) outrank OS-specific filesystem paths, then the
  local side wins. Output is sorted by FilePath so `git diff` shows real
  changes only.
- **extra.db** — union by `sid` for `track_data` (richer metadata wins on
  collision); union by unordered `(sid1, sid2)` pair for `related_tracks`.
- **History/** — keep both files when dates collide, suffixed
  `2026-05-12.mac.m3u` / `2026-05-12.windows.m3u`. Identical content
  (`SHA-256`) collapses to a single file.

#### Commands

```bash
npm run sync:push                      # snapshot + merge + commit + push (default ON)
npm run sync:push -- --no-git          # write sync/ only; commit manually
npm run sync:push -- --as mac          # override the auto-detected machine id
npm run sync:push -- --dry-run         # plan + backup, don't touch sync/

npm run sync:pull                      # dry run: shows what would change
npm run sync:pull -- --write           # actually apply sync/merged/ to local VDJ
npm run sync:pull -- --no-git          # skip `git pull`
npm run sync:pull -- --no-history      # leave local History/ alone
npm run sync:pull -- --no-parse        # don't regenerate public/graph.json after
npm run sync:pull -- --no-linked-folder # don't refresh "Linked Tracks" .vdjfolder
npm run sync:pull -- --linked-folder-name "My Set"  # use a custom folder name

npm run sync:merge                     # local-only re-merge of mac/ + windows/
npm run sync:merge -- --out /tmp/peek  # peek at the merge result somewhere else
npm run sync:merge -- --prefer-local   # bias tie-broken Songs toward this OS

npm run sync:restore                                           # list backups
npm run sync:restore -- --stamp 2026-05-21T...                 # dry-run validate
npm run sync:restore -- --stamp latest --write                 # restore newest pull-time backup
npm run sync:restore -- --stamp <id> --no-history --write      # restore DB + xml only
```

#### Backups

Every write goes through [scripts/lib/syncBackups.js](scripts/lib/syncBackups.js).
There is no `--write` path that doesn't take a backup first unless you also
pass `--force`.

- `sync:pull --write` backs up the **entire local VirtualDJ folder**
  (`database.xml`, `extra.db` + WAL sidecars, full `History/`) into
  `public/backups/sync-pull-<stamp>/` with a SHA-256 manifest, AND drops
  side-by-side `.backup-<stamp>` files next to the originals.
- `sync:push` backs up the **previous** `sync/<machine>/` and `sync/merged/`
  into `public/backups/sync-push-<label>-<stamp>/` before overwriting them.
- `linked:folder --write` backs up the previous `.vdjfolder` (if any) into
  `public/backups/linked-folder-<stamp>/`.
- `public/backups/` is `.gitignore`d and never auto-deleted unless you ask.

Uniform CLI flags on every write command:

| Flag | Effect |
|---|---|
| `--backup-dir <path>` | Override the default `public/backups/` location. |
| `--no-backup` | Skip backup. Requires `--force` to confirm intent. |
| `--backup-only` | Take the backup, then exit without writing. |
| `--keep-backups <N>` | After the run, prune the oldest backups of this kind beyond N. |

`sync:restore` reads the manifest, validates every file's SHA-256, then
atomically restores `database.xml`, `extra.db` (+ sidecars), and (unless
`--no-history`) the full `History/` tree. Default mode is dry-run; pass
`--write` to actually restore.

### SoundCloud playlist

`npm run upload:soundcloud` creates a SoundCloud playlist titled
`Linked_DJ_Playlist` containing every song in your linked pairs that
originated from SoundCloud (the ones with a `netsearch://sc...` source).

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
5. Export the credentials in your shell (see below).

First run opens your browser to SoundCloud; you click Allow, the callback page
shows a code with a Copy button, you paste it back into the terminal.
Subsequent runs reuse the saved refresh token silently for ~hour each.

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

### Cross-platform notes

| Concern | macOS | Windows / WSL |
|---|---|---|
| Default VDJ path | `~/Library/Application Support/VirtualDJ/` | `%LOCALAPPDATA%\VirtualDJ\` (auto-resolved from WSL via `/mnt/c/Users/<you>/AppData/Local/VirtualDJ/`) |
| Browser opener | `open <url>` | `cmd.exe /c start "" <url>` |
| Backup filenames | `extra.db.backup-2026-05-12T...` | Colons replaced with dashes — Windows-safe |
| `better-sqlite3` | Prebuilt for arm64 + x64 | Prebuilt for x64; if you hit a build error, install [VS Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) |

All commands work identically on both: `parse`, `validate`, `inspect`,
`sync:push`, `sync:pull`, `sync:merge`, `sync:restore`, `linked:folder`,
`upload:soundcloud`.

### Project layout

```
vdj-link-map/
├── index.html                          # Vite entry
├── vite.config.js
├── src/                                # Web app (renderer)
│   ├── main.js                         # entry: load graph, wire UI, manage selection
│   ├── styles.css
│   ├── data/loadGraph.js               # vdjApi.getGraph() with /graph.json fallback
│   ├── graph/{layout,renderer,colors}.js
│   ├── match/findMatches.js            # on-demand BPM/key/genre scoring
│   └── ui/{search,filters,sidebar,tooltip,drawer,sync,settings}.js
├── electron/                           # Electron main-process + preload (desktop shell)
├── scripts/
│   ├── parse-vdj-db.js                 # extra.db → vdj_link, History → history → public/graph.json
│   ├── validate-graph.js               # integrity check on graph.json
│   ├── inspect-link-shape.js           # one-off debug: database.xml + extra.db structure report
│   ├── sync-push.js                    # local VDJ → sync/<machine>/ → commit/push
│   ├── sync-pull.js                    # git pull → merge → apply to local VDJ (additive)
│   ├── sync-merge.js                   # local-only union of sync/mac/ + sync/windows/ → sync/merged/
│   ├── sync-restore.js                 # roll back local VDJ from a public/backups/ stamp
│   ├── build-linked-folder.js          # write <VDJ_FOLDER>/Folders/Linked Tracks.vdjfolder
│   ├── upload-to-soundcloud.js         # OPT-IN: SC playlist from linked pairs
│   └── lib/
│       ├── vdjPaths.js                 # resolve VDJ data folder (auto-detects WSL → Windows)
│       ├── paths.js                    # path normalization + cross-platform expansion
│       ├── env.js                      # load .env without dotenv dep
│       ├── xml.js                      # database.xml parser
│       ├── history.js                  # M3U session log parser
│       ├── relatedTracks.js            # extra.db reader (copy-to-temp, read-only)
│       ├── bpm.js, key.js, id.js       # parser helpers
│       ├── sqliteGuards.js             # WAL/SHM guard + integrity_check
│       ├── databaseXmlMerge.js         # newest-wins Song merge + stable sort
│       ├── extraDbMerge.js             # union of two extra.db files
│       ├── historyMerge.js             # file-level History/ union with SHA-256 dedupe
│       ├── syncBackups.js              # timestamped backups + restore + retention pruning
│       ├── machineId.js                # mac/windows folder selection + --as override
│       ├── linkedSongs.js              # graph.json → vdj_link pairs + SC track IDs
│       ├── openBrowser.js              # cross-platform default-browser launcher
│       ├── soundcloudAuth.js           # OAuth 2.1 + PKCE + paste-back flow
│       └── soundcloudClient.js         # POST/PUT /playlists wrapper
├── sync/                               # COMMITTED: bidirectional sync state
│   ├── mac/                            # raw VDJ snapshot from the Mac
│   ├── windows/                        # raw VDJ snapshot from the Windows machine
│   └── merged/                         # deterministic union (regenerated on every push/pull)
└── public/                             # generated artifacts (git-ignored except oauth-callback.html)
    ├── oauth-callback.html             # COMMITTED: deploy to GitHub Pages
    ├── graph.json                      # generated by `parse`
    ├── unresolved-links.json           # diagnostic from `parse`
    ├── soundcloud-playlist.json        # generated by `upload:soundcloud`
    └── backups/                        # sync + linked-folder backups, never auto-deleted
```
