/**
 * Minimal Docker Registry v2 client: resolve the current manifest digest for
 * an image tag WITHOUT pulling the image, so the app can actively check for
 * updates by querying registries directly.
 *
 * Supports anonymous access to registries that use the standard
 * `WWW-Authenticate: Bearer ...` token flow — Docker Hub, GHCR, lscr.io,
 * quay.io, etc. for public images. Private registries that need credentials
 * are not handled yet (those images are simply skipped by the checker).
 */

import { parseRef } from './reconcile.js';
import { basicAuthForRegistry } from './registry-auth.js';

const DOCKER_HUB_API_HOST = 'registry-1.docker.io';

// Accept manifest lists / OCI indexes first so we get the multi-arch index
// digest where applicable.
const MANIFEST_ACCEPT = [
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
].join(', ');

function apiHost(registry) {
  // `docker.io` is the canonical name but the v2 API lives on registry-1.
  return registry === 'docker.io' ? DOCKER_HUB_API_HOST : registry;
}

/**
 * Base URL for a registry's v2 API. Like Docker itself, registries on the
 * loopback address (localhost / 127.0.0.0/8 / ::1, any port) are spoken to over
 * plain http — that's where a local `registry:2` lives. Everything else: https.
 */
export function registryBaseUrl(registry) {
  const host = apiHost(registry);
  const bracketed = host.match(/^\[([^\]]+)\](?::\d+)?$/); // [ipv6]:port
  const hostname = bracketed ? bracketed[1] : host.replace(/:\d+$/, '');
  const loopback = hostname === 'localhost' || /^127\.\d+\.\d+\.\d+$/.test(hostname) || hostname === '::1';
  return `${loopback ? 'http' : 'https'}://${host}`;
}

/**
 * Parse a `WWW-Authenticate: Bearer realm="...",service="...",scope="..."`
 * header into its parameters.
 *
 * @param {string|null} header
 * @returns {{ realm?: string, service?: string, scope?: string }|null}
 */
export function parseWwwAuthenticate(header) {
  if (!header || !/^Bearer\s/i.test(header)) return null;
  const params = {};
  const re = /(\w+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(header)) !== null) {
    params[m[1]] = m[2];
  }
  return params;
}

async function fetchToken(wwwAuth, repository, timeoutMs, basicAuth) {
  if (!wwwAuth.realm) return null;
  const url = new URL(wwwAuth.realm);
  // Only hand stored credentials to an https token server — never send them
  // in clear text (an anonymous token request over http is still allowed).
  if (url.protocol !== 'https:') basicAuth = null;
  if (wwwAuth.service) url.searchParams.set('service', wwwAuth.service);
  url.searchParams.set('scope', wwwAuth.scope || `repository:${repository}:pull`);
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      // Authenticate the token request when we have creds, so the registry
      // grants pull scope for private repos (and a higher Docker Hub limit).
      ...(basicAuth ? { Authorization: `Basic ${basicAuth}` } : {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  return body?.token || body?.access_token || null;
}

/**
 * Resolve the `Authorization` header to use for registry requests after an
 * initial 401: a Bearer token (standard token flow, authenticated with our
 * Basic creds when available) or, for registries that want HTTP Basic directly,
 * the Basic header itself. Returns null if no auth could be established.
 */
async function resolveAuthHeader(res401, registry, repository, timeoutMs) {
  const basicAuth = basicAuthForRegistry(registry);
  const wwwAuth = parseWwwAuthenticate(res401.headers.get('www-authenticate'));
  if (wwwAuth?.realm) {
    const token = await fetchToken(wwwAuth, repository, timeoutMs, basicAuth);
    if (token) return `Bearer ${token}`;
  }
  if (basicAuth) return `Basic ${basicAuth}`;
  return null;
}

/**
 * Resolve the current registry digest for an image ref's tag.
 *
 * @param {string} imageRef e.g. "nginx:latest", "ghcr.io/foo/bar:v1"
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<string|null>} a `sha256:...` digest, or null if the ref is
 *   digest-pinned or the registry didn't return a digest.
 * @throws if the registry is unreachable or returns a non-OK status.
 */
export async function getRemoteDigest(imageRef, { timeoutMs = 10000 } = {}) {
  const { registry, repository, tag } = parseRef(imageRef);
  if (!tag) return null; // digest-pinned; nothing to check against a tag

  const base = registryBaseUrl(registry);
  const manifestUrl = `${base}/v2/${repository}/manifests/${encodeURIComponent(tag)}`;

  const headManifest = (authHeader) =>
    fetch(manifestUrl, {
      method: 'HEAD',
      headers: {
        Accept: MANIFEST_ACCEPT,
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

  let res = await headManifest(null);

  // On 401, establish auth (token flow, or HTTP Basic for private registries)
  // using any configured Docker credentials, then retry.
  if (res.status === 401) {
    const authHeader = await resolveAuthHeader(res, registry, repository, timeoutMs);
    if (authHeader) res = await headManifest(authHeader);
  }

  if (!res.ok) {
    throw new Error(`registry returned ${res.status} for ${imageRef}`);
  }

  return res.headers.get('docker-content-digest') || null;
}

/**
 * Picks which entry of a manifest list / OCI index to inspect for version
 * labels: prefer linux/amd64 (most images publish one), then any linux
 * platform, then whatever's first. Pure so it's unit-testable without a
 * registry round-trip.
 *
 * @param {Array<{ platform?: { os?: string, architecture?: string } }>} manifests
 * @returns {object|null}
 */
export function pickPlatformManifest(manifests) {
  if (!Array.isArray(manifests) || manifests.length === 0) return null;
  return (
    manifests.find((m) => m.platform?.os === 'linux' && m.platform?.architecture === 'amd64') ||
    manifests.find((m) => m.platform?.os === 'linux') ||
    manifests[0]
  );
}

async function authedJson(url, authHeader, timeoutMs) {
  const res = await fetch(url, {
    headers: {
      Accept: MANIFEST_ACCEPT,
      ...(authHeader ? { Authorization: authHeader } : {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

/**
 * Best-effort: resolve the `org.opencontainers.image.version` label baked
 * into the AVAILABLE (remote) image's config, without pulling it — fetches
 * the manifest, follows a manifest-list/OCI-index to one platform's
 * manifest, then reads its config blob. Used only when a check already
 * found a digest difference, so it's an extra cost paid only for images
 * that actually have an update, not on every check.
 *
 * @param {string} imageRef
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<string|null>} the version label, or null if unavailable
 *   for any reason (no label, auth failure, network error, etc.) — never
 *   throws.
 */
export async function getRemoteVersion(imageRef, { timeoutMs = 10000 } = {}) {
  try {
    const { registry, repository, tag } = parseRef(imageRef);
    if (!tag) return null;

    const base = registryBaseUrl(registry);
    const manifestUrl = `${base}/v2/${repository}/manifests/${encodeURIComponent(tag)}`;

    let authHeader = null;
    let res = await fetch(manifestUrl, {
      headers: { Accept: MANIFEST_ACCEPT },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401) {
      authHeader = await resolveAuthHeader(res, registry, repository, timeoutMs);
      if (authHeader) {
        res = await fetch(manifestUrl, {
          headers: { Accept: MANIFEST_ACCEPT, Authorization: authHeader },
          signal: AbortSignal.timeout(timeoutMs),
        });
      }
    }
    if (!res.ok) return null;
    const manifest = await res.json().catch(() => null);
    if (!manifest) return null;

    let imageManifest = manifest;
    if (Array.isArray(manifest.manifests) && manifest.manifests.length > 0) {
      const picked = pickPlatformManifest(manifest.manifests);
      if (!picked?.digest) return null;
      const subUrl = `${base}/v2/${repository}/manifests/${picked.digest}`;
      imageManifest = await authedJson(subUrl, authHeader, timeoutMs);
      if (!imageManifest) return null;
    }

    const configDigest = imageManifest.config?.digest;
    if (!configDigest) return null;

    const blobUrl = `${base}/v2/${repository}/blobs/${configDigest}`;
    const blobRes = await fetch(blobUrl, {
      headers: { ...(authHeader ? { Authorization: authHeader } : {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!blobRes.ok) return null;
    const imageConfig = await blobRes.json().catch(() => null);
    return imageConfig?.config?.Labels?.['org.opencontainers.image.version'] || null;
  } catch {
    return null;
  }
}

/**
 * Pure: the next-page URL from a registry `Link: <...>; rel="next"` header,
 * resolved against `base`, or null.
 */
export function nextPageUrl(linkHeader, base) {
  if (!linkHeader) return null;
  const m = /<([^>]+)>\s*;\s*rel="?next"?/i.exec(linkHeader);
  if (!m) return null;
  try {
    const next = new URL(m[1], base);
    // Never follow pagination to a different host (or downgrade the scheme).
    return next.origin === new URL(base).origin ? next.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Every tag of an image's repository (`GET /v2/<repo>/tags/list`), following
 * pagination up to `maxPages` × 1000 tags. Same auth flow as digest checks.
 *
 * @param {string} imageRef
 * @returns {Promise<string[]>}
 * @throws if the registry is unreachable or refuses.
 */
export async function listTags(imageRef, { timeoutMs = 15000, maxPages = 10 } = {}) {
  const { registry, repository } = parseRef(imageRef);
  const base = registryBaseUrl(registry);
  let url = `${base}/v2/${repository}/tags/list?n=1000`;
  let authHeader = null;
  const tags = [];
  for (let page = 0; url && page < maxPages; page += 1) {
    const get = () =>
      fetch(url, {
        headers: { Accept: 'application/json', ...(authHeader ? { Authorization: authHeader } : {}) },
        signal: AbortSignal.timeout(timeoutMs),
      });
    let res = await get();
    if (res.status === 401) {
      authHeader = await resolveAuthHeader(res, registry, repository, timeoutMs);
      if (authHeader) res = await get();
    }
    if (!res.ok) throw new Error(`registry returned ${res.status} listing tags for ${imageRef}`);
    const body = await res.json().catch(() => null);
    if (Array.isArray(body?.tags)) tags.push(...body.tags);
    url = nextPageUrl(res.headers.get('link'), base);
  }
  return tags;
}

export default { registryBaseUrl, listTags, nextPageUrl, getRemoteDigest, getRemoteVersion, parseWwwAuthenticate, pickPlatformManifest };
