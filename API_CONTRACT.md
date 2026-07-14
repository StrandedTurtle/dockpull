# API Contract

This document is the shared contract between the server and the client (and
between work packages). Any change here should be coordinated across both.

All request/response bodies are JSON unless noted otherwise.

## Auth model

- Auth is a single shared password (`ADMIN_PASSWORD`), compared in constant
  time, no user accounts/database.
- On successful login, the server sets a signed, httpOnly cookie named
  `dockpull_session` (`SameSite=Lax`, `Secure` when served over HTTPS,
  `Max-Age` = `SESSION_TTL` seconds).
- Protected routes (everything except `/api/auth/login` and `/api/health`)
  require a valid `dockpull_session` cookie. If it is missing, invalid, or
  expired, the server responds `401 Unauthorized` with
  `{ "error": "unauthorized" }`.

## Endpoints

### `POST /api/auth/login`

- Auth: none.
- Body: `{ "password": "string" }`
- Response:
  - `200 { "ok": true }` + `Set-Cookie: dockpull_session=...` on success.
  - `401 { "error": "invalid_password" }` on bad password.
  - `429 { "error": "too_many_attempts" }` after too many failed attempts
    from one client IP (temporary lockout).

### `POST /api/auth/logout`

- Auth: cookie.
- Body: none.
- Response: `200 { "ok": true }`, clears the `dockpull_session` cookie.

### `GET /api/auth/me`

- Auth: cookie (optional — never errors, reports status).
- Response: `200 { "authenticated": boolean }`

### `GET /api/containers`

- Auth: cookie.
- Response: `200` — array of container items (shape below). Each item carries
  a `composeFileMissing` flag the dashboard uses to warn when a stack's
  compose file isn't reachable inside the container (mount misconfigured).

### `POST /api/check`

- Auth: cookie.
- Body: none.
- Actively queries the registry for each running image's current digest and
  records/clears update events accordingly.
- Response:
  - `200 { "total": n, "checked": n, "updatesFound": n, "errors": n }`
  - `503 { "error": "docker_unavailable" }` if the Docker daemon is
    unreachable.

### `GET /api/events`

- Auth: cookie.
- Response: `text/event-stream` (SSE). Emits
  `data: {"type":"containers-changed"}` whenever server state changes (a check
  ran, an update finished, or a pin changed) so dashboards can refresh
  without a manual reload. Comment lines (`: ...`) are sent as keepalives.

### `POST /api/update/:name`

- Auth: cookie.
- Path param: `name` — container name.
- Body: none.
- Response: `200 { "streamId": "string" }` — starts a pull + recreate
  operation for that container; use the returned `streamId` to subscribe to
  progress via the SSE endpoint below.
- Errors: `404` if no such container; `409` if an update is already in
  progress for that container.
- Note: after `up -d`, the container is health-checked; if it doesn't come up
  healthy the result is reported as `success:false` with an actionable message
  (and a rollback point is recorded).

### `POST /api/update/:name/revert`

- Auth: cookie.
- Path param: `name` — container name.
- Recreates the container from the image it ran before its last update (the
  rollback point), then starts it. Same SSE streaming + result shape as an
  update; subscribe via `GET /api/update/:name/stream`.
- Response: `200 { "streamId": "string" }`.
- Errors: `404 no_rollback` if there's nothing to revert to; `404 not_found`
  if no such container; `409` if an update/revert is already in progress.

### `GET /api/update/:name/stream`

- Auth: cookie.
- Path param: `name` — container name (same as used to start the update).
- Response: `text/event-stream` (SSE). Events:
  - `data: {"type":"log","line":"..."}` — zero or more, streamed as the
    update runs (`docker compose pull` / `up -d` output).
  - `data: {"type":"result","success":boolean,"message":"..."}` — exactly
    one, final event; the stream closes after this.

### `GET /api/history`

- Auth: cookie.
- Query params: `container` (optional, filter by container name), `limit`
  (default `50`), `offset` (default `0`).
- Response: `200` — array of update history rows, newest first:
  ```json
  [
    {
      "id": 1,
      "container_name": "nginx",
      "image": "nginx:latest",
      "old_digest": "sha256:...",
      "new_digest": "sha256:...",
      "old_version": "1.27.3",
      "new_version": "1.27.4",
      "status": "success",
      "message": "Updated successfully",
      "created_at": "2026-06-22 12:00:00"
    }
  ]
  ```
- `old_version` / `new_version` are human-readable versions resolved from the
  per-digest version store (learned during update checks), best-effort — `null`
  when a digest's version was never learned; clients should fall back to
  showing the digest.

### `GET /api/history/:name`

- Auth: cookie.
- Path param: `name` — container name.
- Query params: `limit` (default `50`), `offset` (default `0`).
- Response: same shape as `GET /api/history`, filtered to that container.

### `DELETE /api/history`

- Auth: cookie.
- Deletes **all** update-history rows.
- Response: `200` — `{ "ok": true }`.

### `GET /api/pinned`

- Auth: cookie.
- Response: `200` — array of pinned refs, e.g. `["nginx:latest", "redis:7"]`.

### `POST /api/pin`

- Auth: cookie.
- Body: `{ "ref": "string" }`
- Response: `200 { "ok": true }`. Idempotent.

### `DELETE /api/pin/:ref`

- Auth: cookie.
- Path param: `ref` — the image ref to unpin (URL-encoded).
- Response: `200 { "ok": true }`. Idempotent.

Note: refs passed to `POST /api/pin` and `DELETE /api/pin/:ref` are
normalized server-side (via the same `normalizeRef` used elsewhere) before
being stored/looked up, so e.g. raw `nginx` and
`docker.io/library/nginx:latest` are equivalent and `GET /api/pinned`
always returns normalized refs. Pinning ("Pin Version") holds a container at
its current version: it's never flagged for updates and is grouped into a
separate section, but can still be updated by hand.

### `GET /api/settings`

- Auth: cookie.
- Response: `200` — current settings, fully populated with defaults:
  ```json
  {
    "defaultFilter": "updates",
    "autoCheckOnOpen": true,
    "backgroundCheckEnabled": true,
    "scheduledCheckTime": "09:00",
    "discordEnabled": false,
    "discordWebhookUrl": ""
  }
  ```
  - `defaultFilter` — `"updates"` or `"all"`; the view the dashboard opens in.
  - `autoCheckOnOpen` — whether the dashboard runs a check automatically on
    first open.
  - `backgroundCheckEnabled` — whether the server runs a scheduled check.
  - `scheduledCheckTime` — daily local time (HH:MM) for the scheduled scan.
  - `discordEnabled` — whether to send Discord notifications on new updates.
  - `discordWebhookUrl` — Discord (or compatible) webhook URL, or `""`.

### `PUT /api/settings`

- Auth: cookie.
- Body: a partial patch of the settings object, e.g. `{ "defaultFilter":
  "all" }`. Unknown keys are ignored; invalid values for known keys return
  `400 { "error": "invalid_value" }`. Changing the time/enable re-arms the
  background scheduler immediately.
- Response: `200` — the full, updated settings object.

### `POST /api/notify/test`

- Auth: cookie.
- Body: `{ "url": "string" }` (optional) — a webhook URL to test; falls back to
  the configured `discordWebhookUrl`.
- Sends a one-off test message to the webhook.
- Response: `200 { "ok": true }` on success; `400 { "error": "no_webhook" }` if
  no URL is configured; `502 { "error": "webhook_failed" }` if the webhook
  rejected the message.

### `GET /api/health`

- Auth: none.
- Response: `200 { "ok": true }`.

## `/api/containers` item shape

```json
{
  "name": "nginx",
  "project": "web",
  "service": "nginx",
  "image": "nginx:latest",
  "tag": "latest",
  "currentVersion": "1.27.3",
  "sourceUrl": "https://github.com/nginx/nginx",
  "currentDigest": "sha256:...",
  "updateAvailable": true,
  "availableDigest": "sha256:...",
  "availableVersion": "1.27.4",
  "pinned": false,
  "state": "running",
  "composeFile": "/opt/stacks/web/compose.yaml",
  "composeFileMissing": false,
  "workingDir": "/opt/stacks/web"
}
```

Field notes:

- `name` — Docker container name.
- `project` / `service` — derived from the `com.docker.compose.project` /
  `com.docker.compose.service` labels.
- `image` — image ref as configured (tag, not digest).
- `tag` — the tag portion of `image` (e.g. `latest`, `1.27`), or `null` if
  the ref is digest-pinned.
- `currentVersion` — human-readable version from the running image's
  `org.opencontainers.image.version` label, if it sets one (else `null`).
- `sourceUrl` — source/project URL from the image's
  `org.opencontainers.image.source` (or `.url`) label, normalized to an
  https web URL (else `null`); used for the per-card changelog/source link.
- `currentDigest` — digest of the image the running container was created
  from.
- `updateAvailable` — `true` if the most recent unresolved update event
  (from the registry check) for this image's normalized ref reports a digest
  different from `currentDigest`.
- `availableDigest` — the digest from that unresolved event, if any (else
  `null`).
- `availableVersion` — a human version for the AVAILABLE (remote) image,
  resolved when the update was found (best-effort, else `null`). Prefers the
  image's `org.opencontainers.image.version` label; when that isn't a usable
  version (e.g. `main`/`latest`/a sha) but the image declares a GitHub source,
  falls back to that repo's latest release tag.
- `breakingRisk` — `true` when `updateAvailable` and the release notes between
  the running and available versions mention breaking changes (best-effort,
  GitHub-sourced images only; scanned when the update event is recorded).
  `false` otherwise, including when no update is available.
- `pinned` — `true` if the image ref is in the `pinned` table ("Pin Version":
  update indicator is suppressed and the container is grouped separately, but
  a manual update is still allowed).
- `canRevert` — `true` if a rollback point exists (the container was updated and
  its previous image is remembered), so the UI can offer a one-click revert.
- `rollbackVersion` — the previous version label for that rollback point, or
  `null`.
- `state` — Docker container state (`running`, `exited`, etc.).
- `composeFile` / `workingDir` — derived from
  `com.docker.compose.project.config_files` /
  `com.docker.compose.project.working_dir` labels; used to run `docker
  compose` commands for that container.
- `composeFileMissing` — `true` when `composeFile` is set but not present
  inside the updater container (the same-path stacks mount is missing/wrong),
  so a compose update would fail; the dashboard surfaces a warning banner.

## Update events

`update_events` rows are produced solely by the active registry check
(`POST /api/check` and the background scheduler). Each records the
`normalized_ref` and the registry-reported `digest`; a row is `resolved` once
the running container's digest matches it (the update was applied). There is
no external notifier — the app queries registries directly.
