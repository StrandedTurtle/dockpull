# Security

## Threat model

DockPull mounts the host **Docker socket** (`/var/run/docker.sock`). Anything that
can reach the Docker socket is effectively **root on the host** — it can start
privileged containers, mount the host filesystem, and read other containers'
secrets. Treat DockPull as a root-equivalent admin tool.

DockPull is built for a **trusted LAN / homelab** behind authentication. It is
**not** hardened to be exposed directly to the public internet.

## What DockPull does to protect you

- **Single-password login** with a signed, `httpOnly`, `SameSite=Lax` session
  cookie. The password is compared in **constant time**.
- **Login rate-limiting / lockout** per client IP (10 failures → 15-minute
  lockout) to blunt brute-force.
- **All `/api/*` routes require the session cookie** (only `GET /api/health`,
  login, and `me` are public).
- **No shell interpolation.** Docker actions run via `spawn(..., {shell:false})`
  with argument arrays — never a shell string — so container/label values can't
  inject commands.
- **Parameterized SQL** (better-sqlite3 prepared statements).
- **SSRF-guarded webhooks.** The Discord webhook URL must be `https` to a public
  host; loopback/private/link-local/metadata addresses are rejected, including
  hostnames that *resolve* to a private address.
- **Security headers** on every response: `Content-Security-Policy`,
  `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`,
  `Cross-Origin-Opener-Policy`, and `Strict-Transport-Security` when served over
  https.

## Recommendations for operators

- **Keep it off the open internet.** Put it on your LAN, a VPN (WireGuard /
  Tailscale), or behind an authenticating reverse proxy / tunnel.
- **Use a strong `ADMIN_PASSWORD`** and a random `SESSION_SECRET`
  (`openssl rand -hex 32`).
- **Serve it over HTTPS** (set `BASE_URL=https://…`) so the session cookie gets
  the `Secure` flag and HSTS is sent.
- **Behind a reverse proxy?** Set `TRUST_PROXY` (e.g. `TRUST_PROXY=1`) so login
  rate-limiting sees real client IPs and the `Secure` cookie is detected. Leave
  it unset when exposed directly, so `X-Forwarded-For` can't be spoofed.
- **Shorten the session** if you like: `SESSION_TTL` defaults to 7 days
  (604800s); lower it (e.g. `86400` = 1 day) for a tighter window.

## Reporting a vulnerability

Please open a private report via GitHub Security Advisories, or email the
maintainer rather than filing a public issue. We'll respond as soon as we can.
