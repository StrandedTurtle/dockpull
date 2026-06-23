# Diun Web Updater

A small, self-hosted, mobile-first web UI for updating Docker containers that
are managed by `docker compose` (e.g. via [Dockge](https://github.com/louislam/dockge)),
with "update available" signals supplied by [Diun](https://crazymax.dev/diun/)
webhooks.

It exists to replace this workflow: *Diun pings Discord at 9am → you open
Dockge on your phone (which is awkward on mobile) → you cross-reference which
stack to update → you click update.* Instead you get one screen that lists your
containers, shows which have updates, and updates them with one tap — **manually,
never automatically** (no watchtower-style surprise upgrades).

![one container per card, badge when an update is available, tap Update to pull + recreate]

---

## Contents

- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Step-by-step setup](#step-by-step-setup)
  - [1. Get the code onto your server](#1-get-the-code-onto-your-server)
  - [2. Create your `.env`](#2-create-your-env)
  - [3. Configure the compose file](#3-configure-the-compose-file)
  - [4. Build and start](#4-build-and-start)
  - [5. Point Diun at the app (the webhook)](#5-point-diun-at-the-app-the-webhook)
  - [6. Put them on the same network](#6-put-them-on-the-same-network)
  - [7. (Optional) Expose it with a Cloudflare Tunnel](#7-optional-expose-it-with-a-cloudflare-tunnel)
- [Using the app](#using-the-app)
- [Configuration reference](#configuration-reference)
- [Security notes](#security-notes-read-this)
- [Troubleshooting](#troubleshooting)
- [Known limitations](#known-limitations)
- [Development](#development)

---

## How it works

1. **Diun watches your images.** When a tracked image gets a new digest, Diun
   POSTs a webhook event to `POST /api/diun/webhook` on this app (authenticated
   with a bearer token). The event (image, normalized ref, digest, status) is
   stored in SQLite. *Your existing Diun notifiers — Discord, etc. — keep
   working; this is just an additional notifier.*
2. **The dashboard reconciles against live Docker state.** When you open the
   app, it lists your containers from the Docker socket and reads each one's
   **currently-running image digest**. If there's an unresolved Diun event for
   that image whose digest differs from what's running, the container is flagged
   **Update available**. Because the running digest is the source of truth, the
   badge is self-correcting: if you update a container elsewhere (e.g. Dockge),
   the badge clears on the next refresh.
3. **You click Update.** The app runs `docker compose pull` then
   `docker compose up -d` for that one service, using the compose file recorded
   in the container's own labels, and streams the live output back to your
   browser. On success it records the update in history and clears the badge.
   **There is no scheduler and no auto-update** — nothing changes until you tap
   Update.

The full endpoint/payload reference is in [`API_CONTRACT.md`](./API_CONTRACT.md).

---

## Requirements

- A Linux host with **Docker** and the **`docker compose` v2** plugin.
- Your stacks are managed by `docker compose` (Dockge counts — it's compose
  under the hood). Containers must carry the standard
  `com.docker.compose.*` labels, which compose adds automatically.
- **Diun** already running (or willing to run) with a `docker` provider.
- Your compose stacks live in one directory on the host (e.g.
  `/home/youruser/docker/stacks` or Dockge's `/opt/stacks`).

> **One hard rule:** the stacks directory must be bind-mounted into this
> container at the **same absolute path** it has on the host. See
> [step 3](#3-configure-the-compose-file) and [security notes](#security-notes-read-this)
> for why.

---

## Quick start

```bash
# on your Docker host
git clone <your-fork-url> diupdater && cd diupdater
cp .env.example .env

# generate two secrets and a password, paste them into .env
openssl rand -hex 32   # -> SESSION_SECRET
openssl rand -hex 32   # -> DIUN_WEBHOOK_TOKEN
# set ADMIN_PASSWORD to something strong
# set STACKS_DIR to the absolute host path of your compose stacks

docker compose up -d --build
```

Then add the webhook notifier to Diun ([step 5](#5-point-diun-at-the-app-the-webhook)),
put both services on the same Docker network ([step 6](#6-put-them-on-the-same-network)),
and open `http://<host-ip>:5000`.

---

## Step-by-step setup

### 1. Get the code onto your server

Clone (or copy) this repository onto the Docker host. The whole app builds from
this directory.

```bash
git clone <your-fork-url> diupdater
cd diupdater
```

### 2. Create your `.env`

```bash
cp .env.example .env
```

Edit `.env` and set every required value:

```ini
# --- required ---
ADMIN_PASSWORD=choose-a-strong-password
SESSION_SECRET=<paste output of: openssl rand -hex 32>
DIUN_WEBHOOK_TOKEN=<paste output of: openssl rand -hex 32>

# Absolute host path of your compose stacks (Dockge users: usually /opt/stacks)
STACKS_DIR=/home/youruser/docker/stacks

# --- optional (defaults shown) ---
PORT=5000
DOCKER_SOCKET=/var/run/docker.sock
DATA_DIR=/data
SESSION_TTL=604800
BASE_URL=http://localhost:5000   # set to your real URL if behind a tunnel/proxy (https)
```

Generate the two secrets:

```bash
openssl rand -hex 32   # SESSION_SECRET  (signs the login cookie)
openssl rand -hex 32   # DIUN_WEBHOOK_TOKEN  (Diun must present this to post events)
```

> If `BASE_URL` starts with `https`, the login cookie is marked `Secure` (only
> sent over HTTPS). Keep it `http://...` for plain LAN access, set it to your
> `https://...` hostname when serving over a tunnel/reverse proxy.

### 3. Configure the compose file

The provided [`docker-compose.yml`](./docker-compose.yml) is ready to use. The
critical part is the **same-path stacks mount**:

```yaml
services:
  diun-updater:
    build:
      context: .
      dockerfile: server/Dockerfile
    container_name: diun-updater
    restart: unless-stopped
    ports:
      - "5000:5000"
    environment:
      - ADMIN_PASSWORD=${ADMIN_PASSWORD}
      - SESSION_SECRET=${SESSION_SECRET}
      - DIUN_WEBHOOK_TOKEN=${DIUN_WEBHOOK_TOKEN}
      - STACKS_DIR=${STACKS_DIR}
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      # ⚠️ SAME PATH on host and in container — do not change one side only:
      - ${STACKS_DIR}:${STACKS_DIR}
      - diun-updater-data:/data        # persistent SQLite (events/history/pins)

volumes:
  diun-updater-data:
```

**Why same-path?** This app calls `docker compose` against the *host* Docker
daemon over the socket. The daemon resolves relative paths in your stacks'
compose files (volumes like `./data:/data`, build contexts, `env_file`) against
the path it sees on the host. If this container saw the stacks at `/stacks` but
the host has them at `/home/youruser/docker/stacks`, every relative bind mount
would resolve to a path that doesn't exist on the host and your volumes would
break on recreate. Mounting at the identical path keeps them correct. (This is
the same constraint Dockge imposes, for the same reason.)

### 4. Build and start

```bash
docker compose up -d --build
```

Check it's healthy:

```bash
curl -s http://localhost:5000/api/health   # -> {"ok":true}
docker logs diun-updater                    # -> "...server listening at ..."
```

The SQLite database is created automatically in the `diun-updater-data` volume
on first start. The first time you load the UI you'll get the login screen —
enter `ADMIN_PASSWORD`.

### 5. Point Diun at the app (the webhook)

Add a `webhook` notifier to your Diun config (this is **in addition to** your
existing Discord notifier — keep both). In Diun's `diun.yml`:

```yaml
notif:
  # ... your existing discord notifier stays here ...
  webhook:
    endpoint: http://diun-updater:5000/api/diun/webhook
    method: POST
    headers:
      Authorization: "Bearer <your DIUN_WEBHOOK_TOKEN>"
```

Use the **same token** you put in `.env`. Then restart Diun
(`docker compose up -d diun`).

> Diun only fires a webhook **when a digest changes** — it does not re-send on a
> schedule. So a brand-new install won't show any badges until Diun next detects
> an update. To test immediately, see [Troubleshooting → "No badges appear"](#troubleshooting).

### 6. Put them on the same network

For `http://diun-updater:5000` to resolve from the Diun container, both
containers must share a Docker network. If they're in the same compose project,
that's automatic. If Diun is in a different project, attach both to a shared
external network, e.g.:

```yaml
# in both diun's and diun-updater's compose files
networks:
  default:
    name: management
    external: true
```

Alternatively, point Diun's `endpoint` at the host IP/port instead of the
service name (e.g. `http://192.168.1.10:5000/api/diun/webhook`).

### 7. (Optional) Expose it with a Cloudflare Tunnel

Add a hostname to your tunnel config pointing at the app, then set
`BASE_URL=https://updates.example.org` in `.env` and restart so the login cookie
is issued with `Secure`:

```yaml
- hostname: updates.example.org
  service: http://localhost:5000
```

For extra safety you can also put **Cloudflare Access** in front of it.

---

## Using the app

Open `http://<host>:5000` (or your tunnel URL) and log in with `ADMIN_PASSWORD`.

**Updates tab (home).** One card per container:
- **Update available** cards show a highlighted badge and the
  `Current → Available` short digests.
- Tap **Update** to pull the new image and recreate that service. The card shows
  a spinner; tap **Show logs** to watch the live `docker compose pull` / `up -d`
  output stream in. When it finishes you get a success/error message and the
  badge clears.
- **Update all** runs every eligible container one at a time (a failure on one
  doesn't stop the rest).
- **Refresh** re-reads live state from Docker.
- The **pin** icon hides a container's update badge (useful to "ignore this one
  for now"). Pinned items can still be updated manually; manage/unpin them from
  Settings.

**History tab.** A log of past updates (container, image, old→new digest,
success/failure, relative time). Tap a row to expand full details; "Load more"
pages through older entries.

**Settings tab.**
- **Appearance** — dark/light theme toggle (also in the header); the choice
  persists across reloads.
- **Pinned images** — list of pinned refs with an Unpin button.
- **About** — app info and a server-health indicator.

**Install as a mobile app (PWA).** In your phone's browser, use "Add to Home
Screen". It installs as a standalone, full-screen app with an icon — this is the
mobile experience that replaces fiddling with Dockge.

---

## Configuration reference

All configuration is via environment variables (see `.env.example`).

| Var | Default | Required | Notes |
|---|---|---|---|
| `ADMIN_PASSWORD` | — | ✅ | Single shared login password. |
| `SESSION_SECRET` | — | ✅ | Signs the session cookie. `openssl rand -hex 32`. |
| `DIUN_WEBHOOK_TOKEN` | — | ✅ | Bearer token Diun must present to post events. `openssl rand -hex 32`. |
| `STACKS_DIR` | `/stacks` | ✅ (effectively) | Host path of your compose stacks. **Must be mounted at the identical path in the container.** |
| `PORT` | `5000` | | Server listen port. |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | | Docker socket path. |
| `DATA_DIR` | `/data` | | SQLite (`app.db`) location; persist via a volume. |
| `SESSION_TTL` | `604800` | | Login cookie lifetime in seconds (7 days). |
| `BASE_URL` | `http://localhost:5000` | | Public URL; if `https`, the cookie is set `Secure`. |

The three required vars are enforced at startup — the server refuses to boot
without them (a `SKIP_CONFIG_CHECK=1` escape hatch exists for skeleton
smoke-tests only; never use it in production).

---

## Security notes (read this)

- **Docker socket access is root-equivalent.** Mounting `/var/run/docker.sock`
  gives this app full control over every container, image, network, and volume
  on the host — effectively root on the host. Run it only on hosts you trust,
  keep it on an internal network, and keep it behind the login (and ideally a
  reverse proxy with TLS or Cloudflare Access). Note that mounting the socket
  `:ro` does **not** restrict this — `:ro` only makes the socket *file*
  read-only; the Docker API still allows writes.
- **The webhook endpoint is the one public, cookie-less route.** It's protected
  by `DIUN_WEBHOOK_TOKEN` (constant-time compared). Treat that token like a
  password and don't expose the app publicly without a proxy if you can avoid it.
- **Auth** is a single password compared in constant time, issuing a signed,
  `httpOnly`, `SameSite=Lax` cookie (`Secure` when `BASE_URL` is https). There's
  intentionally no rate-limiting on login yet — keep the app off the open
  internet or front it with Access/basic-auth if that matters to you.

---

## Troubleshooting

**"No badges appear" / nothing shows as updatable.**
Diun only sends a webhook when a digest *changes*, so a fresh setup is quiet
until then. Confirm the pipe works by posting a fake event for an image you're
running an older version of (replace the token and image):

```bash
curl -i -X POST http://localhost:5000/api/diun/webhook \
  -H "Authorization: Bearer <DIUN_WEBHOOK_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"status":"update","image":"nginx:latest","digest":"sha256:deadbeef"}'
# -> HTTP/1.1 204
```

Refresh the dashboard; the matching container should now show **Update
available**. (Use a real newer digest, or just any different digest, to test the
indicator.)

**Webhook returns 401.** The `Authorization: Bearer ...` token in Diun's config
doesn't match `DIUN_WEBHOOK_TOKEN`. Re-copy it and restart Diun.

**`GET /api/containers` returns 503 `docker_unavailable`.** The app can't reach
the Docker daemon. Check the socket is mounted (`/var/run/docker.sock`) and the
path matches `DOCKER_SOCKET`.

**Update fails with "compose file not found" or volumes break after update.**
Almost always the **same-path mount**. Verify the stacks directory is mounted at
the identical absolute path on both sides (`${STACKS_DIR}:${STACKS_DIR}`), and
that `STACKS_DIR` matches where your compose files actually live on the host.

**Badge won't clear after a successful update.** A successful update resolves the
pending event automatically (this also covers multi-arch images, where the
registry digest and the running digest legitimately differ). If a badge sticks,
hit **Refresh**; if it persists, there may be a genuinely newer event — check
the History tab and `docker logs diun-updater`.

**Can't log in / cookie not sticking.** If you're on `https`, make sure
`BASE_URL` is your `https://` URL (otherwise the `Secure` cookie won't be set
appropriately). Clear the cookie and retry.

---

## Known limitations

- **Missed webhooks aren't re-sent.** If the app is down when Diun fires, that
  event is lost until the image changes again. The dashboard self-heals on the
  next change because it always reconciles against live Docker state, but there's
  no active "re-check registries now" button in this version.
- **Standalone (non-compose) containers** are updated on a best-effort basis
  (pull + recreate preserving config); compose-managed containers are the
  supported path and what you should rely on.
- **Stopped containers** are listed too; updating one will start it.

---

## Development

Run the server and client separately (two terminals):

```bash
# Terminal 1 — API on :5000
cd server
npm install
# provide the required env vars (or SKIP_CONFIG_CHECK=1 for a no-secrets boot)
ADMIN_PASSWORD=dev SESSION_SECRET=dev DIUN_WEBHOOK_TOKEN=dev DATA_DIR=./.data npm start

# Terminal 2 — Vite dev server on :5173 (proxies /api to :5000)
cd client
npm install
npm run dev
```

Open `http://localhost:5173`. Without a Docker daemon, `/api/containers` returns
`503` (expected) but auth, history, pins, and the UI all work.

Run the server test suite and build the client:

```bash
cd server && npm test         # node --test  (reconcile, containers-service, auth)
cd client && npm run build    # production bundle -> client/dist/
```

Build the production image manually (build context must be the repo root):

```bash
docker build -f server/Dockerfile -t diun-updater .
```
