# Contributing / Development

## Local dev (two terminals)

```bash
# Terminal 1 — API on :5000
cd server
npm install
# provide the required env vars (or SKIP_CONFIG_CHECK=1 for a no-secrets boot)
ADMIN_PASSWORD=dev SESSION_SECRET=dev DATA_DIR=./.data npm start

# Terminal 2 — Vite dev server on :5173 (proxies /api to :5000)
cd client
npm install
npm run dev
```

Open `http://localhost:5173`. Without a Docker daemon, `/api/containers` returns
`503` (expected), but auth, history, pins, settings, and the UI all work.

## Tests & build

```bash
cd server && npm test         # node --test (reconcile, containers-service, auth, registry, urlguard, …)
cd client && npm run build    # production bundle -> client/dist/ (includes the PWA service worker)
```

## Build the production image

The build context must be the repo root:

```bash
docker build -f server/Dockerfile -t dockpull .
```

## Project layout

- `server/` — Express API. Talks to the Docker socket (`dockerode` + `docker compose`
  via `spawn`, never a shell string), checks registries, stores state in SQLite
  (`better-sqlite3`). Entry point `server/src/index.js`.
- `client/` — React + Vite SPA (mobile-first, installable PWA). Same-origin `/api`.
- `API_CONTRACT.md` — the authoritative endpoint/field reference. Keep it in sync
  with route changes.
- `SECURITY.md` — threat model and operator hardening guidance.

## Commit message convention

PR titles / squash-merge commit subjects use a `type: description` prefix —
this drives the automated release below (which commits count as releasable,
which changelog section they land in, and whether it's a patch or minor bump):

| Prefix | Meaning | Bump |
|---|---|---|
| `feat:` | user-facing feature | minor |
| `fix:` | bug fix | patch |
| `perf:` | performance fix | patch |
| `deps:` | dependency bump | patch |
| `security:` | security fix | patch |
| `docs:`, `chore:`, `refactor:`, `test:`, `build:`, `ci:` | no user-facing change | none — no release |

A commit with no recognized prefix doesn't count as releasable either. If the
*only* changes since the last release are unprefixed or in the "no release"
row, no Release PR gets opened — that's intentional (e.g. a docs typo fix
shouldn't ping every user's DockPull with "update available").

## Images / releases — fully automated

Releases are **not** cut by hand. [`release-please`](https://github.com/googleapis/release-please)
(`.github/workflows/release-please.yml`) watches every push to `main` and
maintains one standing "Release PR" with the next version + a changelog
generated from `feat:`/`fix:`/`deps:`/etc. commits since the last release. That
PR is set to auto-merge the moment required CI passes — merging it is what
actually cuts the release: release-please creates the git tag + GitHub Release,
which triggers `release.yml`'s tag-triggered build of pinned `:X.Y.Z` / `:X.Y`
images (`:latest` already tracks every `main` push independently of this).

Nothing to run by hand: no `npm version`, no `git tag`, no manually editing
`server/package.json` / `client/package.json` (the release PR does that too,
via `release-please-config.json`'s `extra-files`).

Want a manual gate instead of full auto-merge (e.g. to batch a few fixes into
one release, or review the changelog before it ships)? Delete the "Auto-merge
the release PR" step in `release-please.yml` — the Release PR still opens and
updates itself automatically, it'll just wait for a manual click on Merge.
