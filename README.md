# VirtualDJ Link Map

Read-only desktop tool that visualizes the **real linked tracks** you've defined in VirtualDJ as an interactive Three.js graph, layered with your play-history transitions, and lets you mine the rest of your library on demand for compatible matches.

The tool **never writes** to VirtualDJ's data. Every read is either via copy-to-temp (SQLite) or `readFileSync` (XML / M3U).

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

## Project layout

```
vdj-link-map/
├── index.html
├── scripts/
│   ├── inspect-link-shape.js       # database.xml + extra.db structure report
│   ├── parse-vdj-db.js             # extra.db → vdj_link, History → history
│   ├── validate-graph.js
│   └── lib/
│       ├── relatedTracks.js        # SQLite reader (read-only, copy-to-temp)
│       ├── history.js              # M3U session log parser
│       ├── xml.js                  # database.xml parser
│       ├── paths.js                # path normalization + resolution
│       ├── bpm.js                  # VDJ BPM conversion + grouping
│       ├── key.js                  # Camelot detection + compatibility
│       └── id.js                   # stable hash IDs for nodes/edges
├── src/
│   ├── main.js                     # entry: load graph, wire UI, manage selection
│   ├── styles.css
│   ├── data/loadGraph.js
│   ├── graph/{layout, renderer, colors}.js
│   ├── match/findMatches.js        # on-demand BPM/key/genre scoring
│   └── ui/{search, filters, sidebar, tooltip}.js
└── public/                         # generated artifacts (git-ignored)
```
