# DockPull

A small, self-hosted, **mobile-first** web UI for updating your `docker compose`
containers (works great with [Dockge](https://github.com/louislam/dockge)). It
checks your images' registries for newer versions and lets you apply updates
with one tap — **manually, never automatically**. No watchtower-style surprise
upgrades, and no Diun or external notifier required.

One screen lists your containers grouped by stack, shows which have updates, and
updates them with a tap.

---

## Quick start

Drop this into a compose file on your Docker host and start it:

```yaml
services:
  dockpull:
    image: ghcr.io/strandedturtle/dockpull:edge
    container_name: dockpull
    restart: unless-stopped
    ports:
      - "5000:5000"
    environment:
      - ADMIN_PASSWORD=change-me        # your login password
      - SESSION_SECRET=REPLACE_ME       # run: openssl rand -hex 32
      - STACKS_DIR=/opt/stacks          # absolute host path to your stacks
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /opt/stacks:/opt/stacks         # ⚠️ SAME path on host AND container (see below)
      - dockpull-data:/data

volumes:
  dockpull-data:
```

```bash
docker compose up -d
```

Then open `http://<host-ip>:5000` and log in with your `ADMIN_PASSWORD`. That's it —
the dashboard runs an update check automatically on first load.

> **Building from source instead?** `git clone` this repo, `cp .env.example .env`,
> fill in the three values above, and run `docker compose up -d --build`.

---

## ⚠️ The one rule: same-path stacks mount

Your stacks directory **must be bind-mounted at the same absolute path on the host
and inside the container**, and `STACKS_DIR` must equal that path:

```yaml
- /opt/stacks:/opt/stacks     # host path : identical container path
```

Why: DockPull runs `docker compose` against the host daemon, but the compose CLI
reads the compose file from *this container's* filesystem, and the daemon resolves
relative paths (`./data:/data`, build contexts, `env_file`) against the host path.
If the paths don't match you'll get `compose file not found` and broken bind mounts.
(Dockge imposes the same rule, for the same reason.) Dockge's default is
`/opt/stacks`. DockPull shows a banner if it detects the mount is wrong.

---

## Using the app

- **Updates tab** — containers grouped by stack, update-available ones on top.
  Defaults to showing only what needs updating; flip to **All** to see everything.
  Tap **Update** to pull + recreate that service (watch live logs), or **Update all**
  to run them one at a time. **Pin Version** holds a container at its current version.
- **History tab** — a log of past updates. **Clear history** wipes it (with a confirm).
- **Settings tab** — theme, default view, auto-check on open, the **daily background
  scan** + **Discord webhook** (with a "send test" button), and pinned-version
  management.
- **Install as an app (PWA)** — use your browser's "Add to Home Screen" / "Install"
  to get a standalone, full-screen icon.

The update check queries registries directly (Docker Hub, GHCR, lscr.io, quay.io, …).
Public images work anonymously. For **private** images (and to dodge Docker Hub's
anonymous rate limit), mount your Docker credentials read-only so DockPull can
authenticate:

```yaml
    volumes:
      - ~/.docker/config.json:/root/.docker/config.json:ro
```

This is the file `docker login` writes; only static `auths` entries are used (not
credential-helper stores).

---

## Configuration

All config is via environment variables (see [`.env.example`](./.env.example)).

| Var | Default | Required | Notes |
|---|---|---|---|
| `ADMIN_PASSWORD` | — | ✅ | Single shared login password. |
| `SESSION_SECRET` | — | ✅ | Signs the session cookie. `openssl rand -hex 32`. |
| `STACKS_DIR` | `/stacks` | ✅ | Host path of your stacks; **mount it at the identical path**. |
| `PORT` | `5000` | | Server listen port. |
| `DATA_DIR` | `/data` | | SQLite location; persist via a volume. |
| `SESSION_TTL` | `604800` | | Login cookie lifetime in seconds (7 days). |
| `BASE_URL` | `http://localhost:5000` | | Public URL; if `https`, the cookie is set `Secure`. |
| `TRUST_PROXY` | _off_ | | Set (e.g. `1`) when behind a reverse proxy so rate-limiting sees real client IPs. |
| `DISCORD_WEBHOOK_URL` | — | | Discord webhook for notifications (also editable in Settings). |
| `GITHUB_TOKEN` | — | | Optional read-only token; raises GitHub's 60/hr changelog/version API limit to 5000/hr. |
| `SCHEDULED_CHECK_TIME` | `09:00` | | Daily local time (HH:MM) for the background scan. |
| `BACKGROUND_CHECK_ENABLED` | `true` | | Whether the scheduled scan runs. |
| `SELF_CONTAINER_NAME` | `dockpull` | | This app's container, excluded so it can't update itself. |

The two required vars are enforced at startup — the server won't boot without them.

---

## Security

DockPull mounts the Docker socket, which is **root-equivalent on the host**. Run it
on a **trusted network behind its login** — don't expose it raw to the internet. It
ships with a constant-time password check, per-IP login lockout, SSRF-guarded
webhooks, and security headers. See **[SECURITY.md](./SECURITY.md)** for the threat
model and hardening tips (HTTPS/`BASE_URL`, `TRUST_PROXY`, `SESSION_TTL`).

To update DockPull itself: `docker compose pull dockpull && docker compose up -d dockpull`.

---

## Troubleshooting

- **`compose file not found` on update** → the [same-path mount](#️-the-one-rule-same-path-stacks-mount).
  `STACKS_DIR` must match the host path *and* the container mount path.
- **`503 docker_unavailable`** → the app can't reach the Docker daemon; check the
  socket is mounted and `DOCKER_SOCKET` matches.
- **Some images never flag / show under `errors`** → they're private and need
  credentials; the anonymous check can't query them.
- **Can't log in / cookie not sticking** → on HTTPS, set `BASE_URL` to your `https://`
  URL so the `Secure` cookie is issued; clear the cookie and retry.
- **Image tags:** `:edge` tracks `main`; release tags also publish `:latest` and semver
  (`:0.1.0`). If a host can't pull, the GHCR package may be private — make it public or
  `docker login ghcr.io`.

---

Endpoint/field reference: [`API_CONTRACT.md`](./API_CONTRACT.md) ·
Development setup: [`CONTRIBUTING.md`](./CONTRIBUTING.md) · License: MIT.
