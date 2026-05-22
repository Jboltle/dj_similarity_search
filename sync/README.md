# sync/

Committed VirtualDJ data shared between machines. This folder IS tracked in git
(unlike `public/vdj-snapshot/`, which is a scratch workspace).

## Layout

- `mac/`     — raw snapshot of the Mac VirtualDJ folder (whoever pushed last).
- `windows/` — raw snapshot of the Windows VirtualDJ folder.
- `merged/`  — deterministically regenerated union of `mac/` + `windows/`.

Each subfolder holds `database.xml`, `extra.db`, `History/`, and a
`manifest.json` recording hostname, platform, generation timestamp, and SHA-256
fingerprints. The `merged/` folder additionally contains `merge-report.json`
with conflict counts and the source of every Song entry.

## Commands

- `npm run sync:push`  — write local VDJ data into `sync/<machine>/`, regenerate
                          `merged/`, then `git add/commit/push`.
- `npm run sync:pull`  — `git pull`, regenerate `merged/`, then apply
                          `merged/` back onto the local VDJ folder (additive,
                          with full backup).
- `npm run sync:merge` — local-only union of `mac/` + `windows/` into `merged/`
                          (useful to inspect conflicts before pushing).
- `npm run sync:restore -- --stamp <id>` — roll back the local VDJ folder from
                          a timestamped backup in `public/backups/`.

All write commands default to dry-run; pass `--write` to commit changes.

## What stays out of git

- `*.db-wal` / `*.db-shm` SQLite sidecars (transient).
- `public/backups/` (where pre-write backups live).
- `public/vdj-snapshot/` (legacy `clone:export` scratch).
