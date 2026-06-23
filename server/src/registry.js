/**
 * Minimal Docker Registry v2 client: resolve the current manifest digest for
 * an image tag WITHOUT pulling the image, so the app can actively check for
 * updates (independently of Diun webhooks).
 *
 * Supports anonymous access to registries that use the standard
 * `WWW-Authenticate: Bearer ...` token flow — Docker Hub, GHCR, lscr.io,
 * quay.io, etc. for public images. Private registries that need credentials
 * are not handled yet (those images are simply skipped by the checker).
 */

import { parseRef } from './reconcile.js';

const DOCKER_HUB_API_HOST = 'registry-1.docker.io';

// Accept manifest lists / OCI indexes first so we get the multi-arch index
// digest where applicable, matching what Diun typically reports.
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

async function fetchToken(wwwAuth, repository, timeoutMs) {
  if (!wwwAuth.realm) return null;
  const url = new URL(wwwAuth.realm);
  if (wwwAuth.service) url.searchParams.set('service', wwwAuth.service);
  url.searchParams.set('scope', wwwAuth.scope || `repository:${repository}:pull`);
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  return body?.token || body?.access_token || null;
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

  const host = apiHost(registry);
  const manifestUrl = `https://${host}/v2/${repository}/manifests/${encodeURIComponent(tag)}`;

  const headManifest = (token) =>
    fetch(manifestUrl, {
      method: 'HEAD',
      headers: {
        Accept: MANIFEST_ACCEPT,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

  let res = await headManifest(null);

  // Standard token handshake: on 401, read the realm/scope and retry.
  if (res.status === 401) {
    const wwwAuth = parseWwwAuthenticate(res.headers.get('www-authenticate'));
    if (wwwAuth) {
      const token = await fetchToken(wwwAuth, repository, timeoutMs);
      if (token) res = await headManifest(token);
    }
  }

  if (!res.ok) {
    throw new Error(`registry returned ${res.status} for ${imageRef}`);
  }

  return res.headers.get('docker-content-digest') || null;
}

export default { getRemoteDigest, parseWwwAuthenticate };
