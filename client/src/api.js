// Thin fetch wrapper around the server API (see API_CONTRACT.md).
// All requests are same-origin (dev proxy forwards /api to the server) and
// always send the session cookie.

// Honour a build-time subpath (Vite `base`), so `/api` is reached under the
// same prefix the app is served from (e.g. /dockpull/api). Exported for the
// SSE consumers (EventSource can't go through `request()`).
const BASE = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/api`;
export const API_BASE = BASE;

class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

async function parseBody(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// Global handler invoked when an authenticated request comes back 401 (an
// expired/cleared session mid-use). App registers this to drop the user back
// to the sign-in gate. Auth endpoints are excluded below so a wrong-password
// login (also 401) doesn't trigger it.
let onUnauthorized = null;
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

const AUTH_PATHS = ['/auth/login', '/auth/me'];

async function request(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const data = await parseBody(res);

  if (!res.ok) {
    if (res.status === 401 && !AUTH_PATHS.some((p) => path.startsWith(p))) {
      // Session is gone — bounce back to the login gate.
      if (onUnauthorized) onUnauthorized();
    }
    const errMessage =
      (data && typeof data === 'object' && data.error) ||
      (typeof data === 'string' && data) ||
      `${method} ${path} failed with ${res.status}`;
    throw new ApiError(errMessage, res.status, data);
  }

  return data;
}

export function get(path) {
  return request('GET', path);
}

export function post(path, body) {
  return request('POST', path, body !== undefined ? body : {});
}

export function del(path) {
  return request('DELETE', path);
}

// --- Auth ---

export function getMe() {
  return get('/auth/me');
}

export function login(password) {
  return post('/auth/login', { password });
}

export function logout() {
  return post('/auth/logout');
}

// --- Containers / updates ---

export function getContainers() {
  return get('/containers');
}

// Actively re-check registries for newer digests. Returns
// { total, checked, updatesFound, errors }.
export function checkNow() {
  return post('/check');
}

// App status: { version, lastCheck: { at, total, checked, updatesFound, errors, errored } | null }.
export function getStatus() {
  return get('/status');
}

export function startUpdate(name) {
  return post(`/update/${encodeURIComponent(name)}`);
}

export function revertUpdate(name) {
  return post(`/update/${encodeURIComponent(name)}/revert`);
}

// --- History ---

export function getHistory(params = {}) {
  const search = new URLSearchParams();
  if (params.container) search.set('container', params.container);
  if (params.limit !== undefined) search.set('limit', params.limit);
  if (params.offset !== undefined) search.set('offset', params.offset);
  const qs = search.toString();
  return get(`/history${qs ? `?${qs}` : ''}`);
}

export function clearHistory() {
  return del('/history');
}

// --- Maintenance ---

// Dry-run preview of a prune. Returns { count, totalSize, images }.
export function getDanglingImages() {
  return get('/images/dangling');
}

// Remove dangling image layers. Returns { ok, deleted, spaceReclaimed }.
export function pruneImages() {
  return post('/images/prune');
}

// --- Pinning ---

export function getPinned() {
  return get('/pinned');
}

export function pin(ref) {
  return post('/pin', { ref });
}

export function unpin(ref) {
  return del(`/pin/${encodeURIComponent(ref)}`);
}

// --- Settings ---

export function getSettings() {
  return get('/settings');
}

export function updateSettings(patch) {
  return request('PUT', '/settings', patch);
}

export function testNotify(url, type) {
  const body = {};
  if (url) body.url = url;
  if (type) body.type = type;
  return post('/notify/test', body);
}

export function getChangelog(name) {
  return get(`/changelog/${encodeURIComponent(name)}`);
}

export { ApiError };
