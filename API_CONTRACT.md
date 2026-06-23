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
- Protected routes (everything except `/api/auth/login`, `/api/health`, and
  `/api/diun/webhook`) require a valid `diun_session` cookie. If it is
  missing, invalid, or expired, the server responds `401 Unauthorized` with
  `{ "error": "unauthorized" }`.
- The Diun webhook route uses a separate auth mechanism: a static bearer
  token (`DIUN_WEBHOOK_TOKEN`) in the `Authorization` header. It does not
  use the session cookie.

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

### `POST /api/diun/webhook`

- Auth: token — header `Authorization: Bearer <DIUN_WEBHOOK_TOKEN>`. `401`
  if missing/invalid.
- Body: Diun webhook payload (see below).
- Response: `204 No Content` on successful ingest. `400` if the payload is
  malformed.

### `GET /api/containers`

- Auth: cookie.
- Response: `200` — array of container items (shape below).

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
  "currentDigest": "sha256:...",
  "updateAvailable": true,
  "availableDigest": "sha256:...",
  "pinned": false,
  "state": "running",
  "composeFile": "/stacks/web/docker-compose.yml",
  "workingDir": "/stacks/web"
}
```

Field notes:

- `name` — Docker container name.
- `project` / `service` — derived from the `com.docker.compose.project` /
  `com.docker.compose.service` labels.
- `image` — image ref as configured (tag, not digest).
- `currentDigest` — digest of the image the running container was created
  from.
- `updateAvailable` — `true` if the most recent unresolved Diun event for
  this image's normalized ref reports a digest different from
  `currentDigest`.
- `availableDigest` — the digest from that unresolved event, if any (else
  `null`).
- `pinned` — `true` if the image ref is in the `pinned` table (update
  indicator is suppressed, but manual update is still allowed).
- `state` — Docker container state (`running`, `exited`, etc.).
- `composeFile` / `workingDir` — derived from
  `com.docker.compose.project.config_files` /
  `com.docker.compose.project.working_dir` labels; used to run `docker
  compose` commands for that container.

## Diun webhook payload

Diun's webhook notifier posts a JSON body shaped roughly like:

```json
{
  "status": "update",
  "image": "nginx:latest",
  "digest": "sha256:abc123...",
  "provider": "docker",
  "hub_link": "https://hub.docker.com/_/nginx",
  "platform": "linux/amd64",
  "metadata": {
    "hostname": "docker-host-1",
    "container": "nginx",
    "...": "additional Diun metadata fields"
  }
}
```

Fields we read:

- `status` — `"new"` (first time Diun sees this image) or `"update"` (a
  newer digest was found). Both are recorded; only `"update"` events are
  meaningful for the update indicator.
- `image` — the image ref Diun checked, used to derive `normalized_ref`
  (registry/repo without tag-specific noise, used to key
  `update_events.normalized_ref`).
- `digest` — the new digest Diun observed.
- `provider` — Diun provider (`docker`, `swarm`, etc.) — stored for
  reference.
- `hub_link` — informational link, stored for reference.
- `platform` — image platform string, stored for reference.
- `metadata` — passthrough object with additional Diun-provided context;
  stored as part of `raw_json`, not parsed individually.

The full raw payload is stored as `raw_json` in `update_events` for
debugging/audit, regardless of which fields are explicitly parsed.
