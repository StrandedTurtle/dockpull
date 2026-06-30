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

## Images / releases

`:edge` is published from `main`. Cutting a release tag
(`git tag v0.1.0 && git push origin v0.1.0`) publishes the multi-arch
(`linux/amd64` + `linux/arm64`) image as `:latest` and semver tags.
