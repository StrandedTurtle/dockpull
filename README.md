# Diun Web Updater

A small, self-hosted, mobile-first web UI for updating Docker containers that
are managed by `docker compose` (e.g. via [Dockge](https://github.com/louislam/dockge)).
It checks your images' registries for newer versions and lets you apply updates
with one tap — **manually, never automatically** (no watchtower-style surprise
upgrades).

It exists to replace this workflow: *something pings you that an update exists →
you open Dockge on your phone (which is awkward on mobile) → you cross-reference
which stack to update → you click update.* Instead you get one screen that lists
your containers grouped by stack, shows which have updates, and updates them with
one tap.

> **Self-contained.** This app talks to your Docker socket and queries image
> registries directly. It does **not** require Diun (or any external notifier).

![one card per container, grouped by stack, badge when an update is available, tap Update to pull + recreate]

---

## Contents

- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Add to an existing Compose stack](#add-to-an-existing-compose-stack)
- [Step-by-step setup](#step-by-step-setup)
  - [1. Get the code onto your server](#1-get-the-code-onto-your-server)
  - [2. Create your `.env`](#2-create-your-env)
  - [3. Configure the compose file (the same-path mount)](#3-configure-the-compose-file-the-same-path-mount)
  - [4. Build and start](#4-build-and-start)
  - [5. (Optional) Expose it with a Cloudflare Tunnel](#5-optional-expose-it-with-a-cloudflare-tunnel)
- [Using the app](#using-the-app)
- [Configuration reference](#configuration-reference)
- [Security notes](#security-notes-read-this)
- [Troubleshooting](#troubleshooting)
- [Known limitations](#known-limitations)
- [Development](#development)

---

## How it works

1. **You open the app and it checks.** On load (and whenever you tap **Check for
   updates**), the app lists your containers from the Docker socket, reads each
   one's **currently-running image digest**, and asks each image's registry for
   the current digest of its tag — without pulling anything. Anything whose
   registry digest differs from what's running is flagged **Update available**.
2. **Live Docker state is the source of truth.** The badge is self-correcting:
   if you update a container elsewhere (e.g. Dockge), the badge clears on the
   next check, because the app always reconciles against the digest that's
   actually running.
3. **You click Update.** The app runs `docker compose pull` then
   `docker compose up -d` for that one service, using the compose file recorded
   in the container's own labels, and streams the live output back to your
   browser. On success it records the update in history and clears the badge.
   **There is no auto-update** — nothing changes until you tap Update.

The full endpoint/field reference is in [`API_CONTRACT.md`](./API_CONTRACT.md).

---

## Requirements

- A Linux host with **Docker** and the **`docker compose` v2** plugin.
- Your stacks are managed by `docker compose` (Dockge counts — it's compose
  under the hood). Containers must carry the standard `com.docker.compose.*`
  labels, which compose adds automatically.
- Your compose stacks live in one directory on the host (Dockge's default is
  `/opt/stacks`).

> **One hard rule:** the stacks directory must be bind-mounted into this
> container at the **same absolute path** it has on the host. See
> [step 3](#3-configure-the-compose-file-the-same-path-mount) and
> [security notes](#security-notes-read-this) for why.

---

## Quick start

```bash
# on your Docker host
git clone <your-fork-url> diupdater && cd diupdater
cp .env.example .env

# fill in .env:
openssl rand -hex 32          # -> paste as SESSION_SECRET
# set ADMIN_PASSWORD to something strong
# set STACKS_DIR to the absolute host path of your compose stacks (e.g. /opt/stacks)

docker compose up -d --build
```

Then open `http://<host-ip>:5000` and log in with `ADMIN_PASSWORD`.

---

## Add to an existing Compose stack

If you already manage stacks with Docker Compose (or Dockge), the quickest path
is the **prebuilt image** — no cloning, no building. Drop this service into an
existing compose file (e.g. a `management` stack) and fill in the two secrets.
**Set both the `STACKS_DIR` env and the stacks volume to your real stacks path**
(Dockge users: `/opt/stacks`):

```yaml
services:
  diun-updater:
    image: ghcr.io/strandedturtle/diupdater:edge
    container_name: diun-updater
    restart: unless-stopped
    ports:
      - "5000:5000"
    environment:
      - ADMIN_PASSWORD=change-me        # your login password
      - SESSION_SECRET=REPLACE_ME       # openssl rand -hex 32
      - STACKS_DIR=/opt/stacks          # absolute host path to your stacks
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      # ⚠️ SAME absolute path on the host AND inside the container. This MUST
      #    match STACKS_DIR above, or updates fail with "compose file not found"
      #    and relative bind mounts in your other stacks break on recreate.
      - /opt/stacks:/opt/stacks
      - diun-updater-data:/data

volumes:
  diun-updater-data:
```

Generate the secret (`openssl rand -hex 32`), then start just this service:

```bash
docker compose up -d diun-updater
```

Then open `http://<host-ip>:5000`.

**Image tags:** `:edge` tracks the latest commit on `main`; cutting a release
tag (`git tag v0.1.0 && git push origin v0.1.0`) also publishes `:latest` and
semver tags (`:0.1.0`, `:0.1`). Pin to a version for stability.

> **Can't pull the image?** The GHCR package inherits the repo's visibility. To
> let other hosts pull it without auth, make the package public: GitHub → your
> avatar → **Packages** → `diupdater` → **Package settings** → **Change
> visibility** → *Public*. Otherwise run `docker login ghcr.io` (with a PAT that
> has `read:packages`) on each host first.

The [same-path mount](#3-configure-the-compose-file-the-same-path-mount) and
[Docker-socket](#security-notes-read-this) warnings apply here too. Prefer to
build from source? Use [Step-by-step setup](#step-by-step-setup) below instead.

---

## Step-by-step setup

### 1. Get the code onto your server

```bash
git clone <your-fork-url> diupdater
cd diupdater
```

### 2. Create your `.env`

```bash
cp .env.example .env
```

Edit `.env` and set the required values:

```ini
# --- required ---
ADMIN_PASSWORD=choose-a-strong-password
SESSION_SECRET=<paste output of: openssl rand -hex 32>

# Absolute host path of your compose stacks (Dockge users: /opt/stacks)
STACKS_DIR=/opt/stacks

# --- optional (defaults shown) ---
PORT=5000
DOCKER_SOCKET=/var/run/docker.sock
DATA_DIR=/data
SESSION_TTL=604800
BASE_URL=http://localhost:5000   # set to your real https URL if behind a tunnel/proxy
```

> If `BASE_URL` starts with `https`, the login cookie is marked `Secure` (only
> sent over HTTPS). Keep it `http://...` for plain LAN access; set it to your
> `https://...` hostname when serving over a tunnel/reverse proxy.

### 3. Configure the compose file (the same-path mount)

The provided [`docker-compose.yml`](./docker-compose.yml) is ready to use. The
critical part is the **same-path stacks mount**:

```yaml
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      # ⚠️ SAME PATH on host and in container — do not change one side only:
      - ${STACKS_DIR}:${STACKS_DIR}
      - diun-updater-data:/data        # persistent SQLite (events/history/pins)
```

**Why same-path?** This app calls `docker compose` against the *host* Docker
daemon over the socket, but the `docker compose` CLI reads the compose file from
*this container's* filesystem, and the daemon resolves relative paths in your
stacks' compose files (volumes like `./data:/data`, build contexts, `env_file`)
against the path it sees on the host. If this container saw the stacks at
`/stacks` but the host has them at `/opt/stacks`, the CLI couldn't find the
compose file (you'd get `open /opt/stacks/<stack>/compose.yaml: no such file or
directory`) and any relative bind mount would resolve to a non-existent host
path. Mounting at the identical path keeps both correct. (This is the same
constraint Dockge imposes, for the same reason.)

> If the stacks dir isn't mounted at the right path, the app shows a warning
> banner at the top of the dashboard so you can fix it before an update fails.

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
enter `ADMIN_PASSWORD`, and the dashboard will run an initial update check.

> **Prefer a prebuilt image?** Releases publish a multi-arch image
> (`linux/amd64` + `linux/arm64`) to GHCR. Instead of `build:`, point the
> compose service at `image: ghcr.io/strandedturtle/diupdater:edge` (keep the
> same environment + volumes) and `docker compose up -d` (no `--build`).

### 5. (Optional) Expose it with a Cloudflare Tunnel

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

**Updates tab (home).** Containers are **grouped by stack** (their compose
project / Dockge folder) in collapsible sections, with anything that has an
update sorted to the top. By default the list shows **only containers that need
an update**; flip the filter to **All** to see everything.

- When you open the app it automatically runs a check. **Check for updates**
  re-runs it on demand (queries each image's registry for a newer digest).
- Each card shows the image, its **version** (from the image's
  `org.opencontainers.image.version` label when present, otherwise its tag), and
  whether an update is available.
- Tap **Update** to pull the new image and recreate that service. Tap **Show
  logs** to watch the live `docker compose pull` / `up -d` output. When it
  finishes you get a success/error message and the badge clears.
- **Update all** runs every eligible container one at a time (a failure on one
  doesn't stop the rest).
- The dashboard **updates itself live** — when a check runs or an update
  finishes, the list refreshes automatically.
- **Pin Version** holds a container at its current version (it stops being
  flagged for updates and moves to a separate section). You can still update it
  manually.

**History tab.** A log of past updates (container, image, old→new digest,
success/failure, relative time). Tap a row to expand; "Load more" pages older
entries.

**Settings tab.** Theme (dark/light), pinned-version management, and a
server-health indicator.

**Install as a mobile app (PWA).** In your phone's browser, use "Add to Home
Screen". It installs as a standalone, full-screen app with an icon.

### About the update check

The check queries registries directly for each running image's current digest
and flags anything out of date. It supports registries reachable **anonymously**
over the standard token flow — Docker Hub, GHCR, lscr.io, quay.io, etc. for
public images. Private images that require credentials are skipped (counted
under `errors`).

---

## Configuration reference

All configuration is via environment variables (see `.env.example`).

| Var | Default | Required | Notes |
|---|---|---|---|
| `ADMIN_PASSWORD` | — | ✅ | Single shared login password. |
| `SESSION_SECRET` | — | ✅ | Signs the session cookie. `openssl rand -hex 32`. |
| `STACKS_DIR` | `/stacks` | ✅ (effectively) | Host path of your compose stacks. **Must be mounted at the identical path in the container.** |
| `PORT` | `5000` | | Server listen port. |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | | Docker socket path. |
| `DATA_DIR` | `/data` | | SQLite (`app.db`) location; persist via a volume. |
| `SESSION_TTL` | `604800` | | Login cookie lifetime in seconds (7 days). |
| `BASE_URL` | `http://localhost:5000` | | Public URL; if `https`, the cookie is set `Secure`. |
| `SELF_CONTAINER_NAME` | `diun-updater` | | This app's own container name, excluded from the dashboard so it can't update itself. |

The two required vars are enforced at startup — the server refuses to boot
without them (a `SKIP_CONFIG_CHECK=1` escape hatch exists for skeleton
smoke-tests only; never use it in production).

---

## Security notes (read this)

- **Docker socket access is root-equivalent.** Mounting `/var/run/docker.sock`
  gives this app full control over every container, image, network, and volume
  on the host — effectively root on the host. Run it only on hosts you trust,
  keep it on an internal network, and keep it behind the login (and ideally a
  reverse proxy with TLS or Cloudflare Access). Mounting the socket `:ro` does
  **not** restrict this — `:ro` only makes the socket *file* read-only; the
  Docker API still allows writes.
- **Auth** is a single password compared in constant time, issuing a signed,
  `httpOnly`, `SameSite=Lax` cookie (`Secure` when `BASE_URL` is https). Failed
  logins are rate-limited per client IP (lockout after repeated failures) to
  blunt brute-force — but this is not a substitute for keeping the app off the
  open internet or fronting it with Cloudflare Access if exposure matters.
- **The app excludes its own container** from the dashboard (it can't safely
  update itself). Update the updater the normal way:
  `docker compose pull diun-updater && docker compose up -d diun-updater`.

---

## Troubleshooting

**Update fails with `compose file not found` / `no such file or directory`.**
This is the **same-path mount**. The `docker compose` CLI runs inside this
container and reads your compose file from this container's filesystem, so your
stacks dir must be mounted at the identical absolute path on both sides
(`${STACKS_DIR}:${STACKS_DIR}`), and `STACKS_DIR` must match where your compose
files actually live on the host (Dockge: `/opt/stacks`). The dashboard shows a
warning banner when it detects the stacks dir isn't mounted.

**`GET /api/containers` returns 503 `docker_unavailable`.** The app can't reach
the Docker daemon. Check the socket is mounted (`/var/run/docker.sock`) and the
path matches `DOCKER_SOCKET`.

**A check reports updates under `errors` / some images never flag.** Those
images are on registries that need credentials (private images), which the
anonymous check can't query. Public images on Docker Hub / GHCR / lscr.io /
quay.io work.

**Badge won't clear after a successful update.** A successful update resolves the
pending event automatically (this also covers multi-arch images, where the
registry digest and the running digest legitimately differ). If a badge sticks,
tap **Check for updates** again; if it persists, there may be a genuinely newer
image — check the History tab and `docker logs diun-updater`.

**Can't log in / cookie not sticking.** If you're on `https`, make sure
`BASE_URL` is your `https://` URL (otherwise the `Secure` cookie won't be set
appropriately). Clear the cookie and retry.

---

## Known limitations

- **The update check needs registries reachable anonymously.** Private images
  that require credentials are skipped for now.
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
ADMIN_PASSWORD=dev SESSION_SECRET=dev DATA_DIR=./.data npm start

# Terminal 2 — Vite dev server on :5173 (proxies /api to :5000)
cd client
npm install
npm run dev
```

Open `http://localhost:5173`. Without a Docker daemon, `/api/containers` returns
`503` (expected) but auth, history, pins, and the UI all work.

Run the server test suite and build the client:

```bash
cd server && npm test         # node --test  (reconcile, containers-service, auth, registry)
cd client && npm run build    # production bundle -> client/dist/
```

Build the production image manually (build context must be the repo root):

```bash
docker build -f server/Dockerfile -t diun-updater .
```
