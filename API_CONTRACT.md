# API Contract

This document is the shared contract between the server and the client (and
between work packages). Any change here should be coordinated across both.

All request/response bodies are JSON unless noted otherwise.

## Auth model

- Auth is a single shared password (`ADMIN_PASSWORD`), compared in constant
  time, no user accounts/database.
- On successful login, the server sets a signed, httpOnly cookie named
  `diun_session` (`SameSite=Lax`, `Secure` when served over HTTPS,
  `Max-Age` = `SESSION_TTL` seconds).
- Protected routes (everything except `/api/auth/login` and `/api/health`)
  require a valid `diun_session` cookie. If it is missing, invalid, or
  expired, the server responds `401 Unauthorized` with
  `{ "error": "unauthorized" }`.

## Endpoints

### `POST /api/auth/login`

- Auth: none.
- Body: `{ "password": "string" }`
- Response:
  - `200 { "ok": true }` + `Set-Cookie: diun_session=...` on success.
  - `401 { "error": "invalid_password" }` on bad password.
  - `429 { "error": "too_many_attempts" }` after too many failed attempts
    from one client IP (temporary lockout).

### `POST /api/auth/logout`

- Auth: cookie.
- Body: none.
- Response: `200 { "ok": true }`, clears the `diun_session` cookie.

### `GET /api/auth/me`

- Auth: cookie (optional — never errors, reports status).
- Response: `200 { "authenticated": boolean }`

### `GET /api/containers`

- Auth: cookie.
- Response: `200` — array of container items (shape below).

### `GET /api/diagnostics`

- Auth: cookie.
- Response: `200 { "stacks": { "stacksDir": "/opt/stacks", "mounted": true } }`.
  `mounted` is `false` when the configured `STACKS_DIR` isn't present inside
  the container (the host stacks dir isn't mounted, or is mounted at a
  different path) — which breaks compose-based updates. The dashboard uses
  this to warn before an update is attempted.

### `POST /api/check`

- Auth: cookie.
- Body: none.
- Actively queries the registry for each running image's current digest
  (independent of Diun webhooks) and records/clears update events
  accordingly.
- Response:
  - `200 { "total": n, "checked": n, "updatesFound": n, "errors": n }`
  - `503 { "error": "docker_unavailable" }` if the Docker daemon is
    unreachable.

### `GET /api/events`

- Auth: cookie.
- Response: `text/event-stream` (SSE). Emits
  `data: {"type":"containers-changed"}` whenever server state changes (a Diun
  webhook arrived, a manual check ran, or an update finished) so dashboards
  can refresh without a manual reload. Comment lines (`: ...`) are sent as
  keepalives.

### `POST /api/update/:name`

- Auth: cookie.
- Path param: `name` — container name.
- Body: none.
- Response: `200 { "streamId": "string" }` — starts a pull + recreate
  operation for that container; use the returned `streamId` to subscribe to
  progress via the SSE endpoint below.
- Errors: `404` if no such container; `409` if an update is already in
  progress for that container.

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
      "status": "success",
      "message": "Updated successfully",
      "created_at": "2026-06-22 12:00:00"
    }
  ]
  ```

### `GET /api/history/:name`

- Auth: cookie.
- Path param: `name` — container name.
- Query params: `limit` (default `50`), `offset` (default `0`).
- Response: same shape as `GET /api/history`, filtered to that container.

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
normalized server-side (via the same `normalizeRef` used for Diun events)
before being stored/looked up, so e.g. raw `nginx` and
`docker.io/library/nginx:latest` are equivalent and `GET /api/pinned`
always returns normalized refs.

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
  "currentDigest": "sha256:...",
  "updateAvailable": true,
  "availableDigest": "sha256:...",
  "pinned": false,
  "state": "running",
  "composeFile": "/opt/stacks/web/compose.yaml",
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
- `currentDigest` — digest of the image the running container was created
  from.
- `updateAvailable` — `true` if the most recent unresolved update event
  (from the registry check) for this image's normalized ref reports a digest
  different from `currentDigest`.
- `availableDigest` — the digest from that unresolved event, if any (else
  `null`).
- `pinned` — `true` if the image ref is in the `pinned` table ("Pin Version":
  update indicator is suppressed and the container is grouped separately, but
  a manual update is still allowed).
- `state` — Docker container state (`running`, `exited`, etc.).
- `composeFile` / `workingDir` — derived from
  `com.docker.compose.project.config_files` /
  `com.docker.compose.project.working_dir` labels; used to run `docker
  compose` commands for that container.

## Update events

`update_events` rows are produced solely by the active registry check
(`POST /api/check` and the background scheduler). Each records the
`normalized_ref` and the registry-reported `digest`; a row is `resolved` once
the running container's digest matches it (the update was applied). There is
no external notifier — the app queries registries directly.
