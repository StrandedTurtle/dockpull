# Diun Web Updater

A small, self-hosted web UI for updating Docker containers that are managed
by `docker compose`, with update signals supplied by
[Diun](https://crazymax.dev/diun/) webhooks.

## Overview

Diun Web Updater is a single Node/Express container that:

- Lists the Docker containers running on the host (via the Docker socket).
- Shows an "update available" indicator per container, driven by webhook
  events from Diun.
- Lets you trigger a one-click update (pull + recreate) for a container via
  its `docker compose` file, streaming logs back over SSE.
- Keeps a history of past updates and lets you pin specific image refs to
  exclude them from update checks.

It is protected by a single shared password (no user accounts, no external
auth provider) and serves both the API and the built React SPA from the same
process on port 5000.

## How it works

1. **Diun watches your images** and, on a new/updated digest, POSTs a
   webhook event to `POST /api/diun/webhook` on this app (authenticated with
   a bearer token). We store the event (image, normalized ref, digest,
   status) in SQLite.
2. **Reconciliation**: when listing containers (`GET /api/containers`), we
   compare each running container's live image digest (read from Docker)
   against the most recent unresolved Diun event for that image's ref. If
   they differ, `updateAvailable: true` is reported for that container.
3. **Manual, one-click update only** — there is no auto-update. Clicking
   "update" on a container (`POST /api/update/:name`) runs `docker compose
   pull` + `up -d` (or equivalent) against that container's compose file,
   streaming progress back to the browser via Server-Sent Events. On
   success, the matching Diun event(s) for that ref are marked resolved and
   the result is recorded in `update_history`.

See [`API_CONTRACT.md`](./API_CONTRACT.md) for the full endpoint and payload
reference shared by the server and client.

## Configuration

All configuration is via environment variables (see `.env.example`).

| Var | Default | Notes |
|---|---|---|
| `PORT` | `5000` | Port the server listens on. |
| `STACKS_DIR` | `/stacks` | Directory containing your compose stacks. **Must be mounted at the identical path on the host and in the container.** |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | Path to the Docker socket. |
| `DATA_DIR` | `/data` | Where the SQLite database (`app.db`) lives. Should be a persistent volume. |
| `ADMIN_PASSWORD` | _(none — required)_ | Single shared password for login. |
| `SESSION_SECRET` | _(none — required)_ | Secret used to sign the session cookie. Generate with `openssl rand -hex 32`. |
| `DIUN_WEBHOOK_TOKEN` | _(none — required)_ | Bearer token Diun must present when posting webhook events. Generate with `openssl rand -hex 32`. |
| `SESSION_TTL` | `604800` | Session cookie lifetime in seconds (default 7 days). |
| `BASE_URL` | `http://localhost:5000` | Public base URL, used for logging/links. |

`ADMIN_PASSWORD`, `SESSION_SECRET`, and `DIUN_WEBHOOK_TOKEN` are required at
runtime; the server refuses to start without them unless
`SKIP_CONFIG_CHECK=1` is set (useful for smoke-testing the skeleton without
secrets — do not use this in production).

## Deployment

This app ships as a single Docker image (multi-stage build: client SPA +
server). Use the provided `docker-compose.yml`:

```bash
cp .env.example .env
# edit .env: set ADMIN_PASSWORD, SESSION_SECRET, DIUN_WEBHOOK_TOKEN, STACKS_DIR
docker compose up -d --build
```

Build manually (context must be the repo root):

```bash
docker build -f server/Dockerfile -t diun-updater .
```

### Diun webhook notifier

Point your Diun installation's webhook notifier at this app:

```yaml
notif:
  webhook:
    endpoint: http://diun-updater:5000/api/diun/webhook
    method: POST
    headers:
      Authorization: "Bearer ${DIUN_WEBHOOK_TOKEN}"
```

### Important warnings

- **Same-path stacks mount.** The host directory containing your
  `docker-compose` stacks must be bind-mounted at the *exact same absolute
  path* inside the `diun-updater` container as it has on the host (e.g. host
  `/opt/stacks` → container `/opt/stacks`, not `/stacks`). This app calls
  `docker compose` against the host Docker daemon over the socket; the
  daemon resolves relative paths in your stacks' compose files (volumes,
  build contexts, env files) against what it sees on the *host* filesystem.
  If the paths inside this container don't match the host paths, those
  relative references will break.
- **Docker socket access is root-equivalent.** Mounting
  `/var/run/docker.sock` into this container gives it full control over
  every container, image, network, and volume on the host — equivalent to
  root access on the host. Only run this app on hosts/networks you trust,
  and keep it behind your own auth (the admin password) and, ideally, a
  reverse proxy with TLS.

## Development

Run the server and client separately in dev mode (two terminals):

```bash
# Terminal 1 — server (API on :5000)
cd server
npm install
cp ../.env.example ../.env   # fill in required vars, or use SKIP_CONFIG_CHECK=1
npm start

# Terminal 2 — client (Vite dev server on :5173, proxies /api to :5000)
cd client
npm install
npm run dev
```

Then open `http://localhost:5173`.

To build the production client bundle (output: `client/dist/`):

```bash
cd client
npm run build
```
