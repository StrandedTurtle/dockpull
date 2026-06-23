/**
 * Pure reconciliation helpers: parsing/normalizing Docker image references and
 * comparing digests. No DB access, no dockerode — kept dependency-free so
 * it is trivially unit-testable (see server/test/reconcile.test.js).
 */

const DEFAULT_REGISTRY = 'docker.io';
const DEFAULT_TAG = 'latest';
const OFFICIAL_NAMESPACE = 'library';

/**
 * Returns true if `host` looks like a registry host (has a dot or colon,
 * or is literally "localhost") as opposed to the first path segment of an
 * image name on Docker Hub (e.g. "library", "bitnami").
 */
function looksLikeRegistryHost(segment) {
  return segment === 'localhost' || segment.includes('.') || segment.includes(':');
}

/**
 * Parse a Docker image reference into its components.
 *
 * Rules:
 * - Default registry is `docker.io`; Docker Hub official images (no slash,
 *   or no registry-looking first segment) get the `library/` namespace.
 * - Default tag is `latest` when no tag is present.
 * - A colon that is part of a registry's port (e.g. `registry:5000/foo`) is
 *   never mistaken for a tag separator — only a colon in the final path
 *   segment can introduce a tag.
 * - An `@sha256:...` digest suffix is captured separately. If the ref had a
 *   digest, `tag` is null (digest-pinned refs have no meaningful tag to
 *   check against tag-keyed events).
 * - The registry + repository are lowercased; the tag is left as-is.
 *
 * @param {string} imageRef
 * @returns {{ registry: string, repository: string, tag: string|null, digest: string|null }}
 */
export function parseRef(imageRef) {
  if (typeof imageRef !== 'string') {
    throw new TypeError('parseRef: imageRef must be a string');
  }

  let ref = imageRef.trim();
  if (ref === '') {
    throw new TypeError('parseRef: imageRef must not be empty');
  }

  // 1. Strip a trailing @sha256:... digest, if present.
  let digest = null;
  const digestMatch = ref.match(/@sha256:[0-9a-fA-F]+$/);
  if (digestMatch) {
    digest = digestMatch[0].slice(1); // drop the leading '@' -> "sha256:..."
    ref = ref.slice(0, ref.length - digestMatch[0].length);
  }

  // 2. Split into registry+repo ("name") and an optional tag. A tag is only
  //    present if there's a colon in the LAST path segment, so registry:port
  //    is not confused with name:tag.
  const lastSlash = ref.lastIndexOf('/');
  const lastSegment = lastSlash === -1 ? ref : ref.slice(lastSlash + 1);
  const colonInLastSegment = lastSegment.lastIndexOf(':');

  let name;
  let tag = null;
  if (colonInLastSegment !== -1) {
    tag = lastSegment.slice(colonInLastSegment + 1);
    const namePrefix = lastSlash === -1 ? '' : ref.slice(0, lastSlash + 1);
    name = namePrefix + lastSegment.slice(0, colonInLastSegment);
  } else {
    name = ref;
  }

  if (digest) {
    // Digest-pinned: no tag, regardless of whether one was parsed above.
    tag = null;
  } else if (tag === null || tag === '') {
    tag = DEFAULT_TAG;
  }

  // 3. Determine registry vs repo path from `name`.
  const parts = name.split('/');
  let registry;
  let repoParts;

  if (parts.length === 1) {
    // e.g. "nginx" -> docker.io/library/nginx
    registry = DEFAULT_REGISTRY;
    repoParts = [OFFICIAL_NAMESPACE, parts[0]];
  } else if (looksLikeRegistryHost(parts[0])) {
    // e.g. "ghcr.io/foo/bar", "registry:5000/team/app", "localhost/foo"
    registry = parts[0];
    repoParts = parts.slice(1);
  } else {
    // e.g. "library/nginx" or two-segment Hub images like
    // "linuxserver/sonarr" -> docker.io/linuxserver/sonarr
    registry = DEFAULT_REGISTRY;
    repoParts = parts;
  }

  return {
    registry: registry.toLowerCase(),
    repository: repoParts.join('/').toLowerCase(),
    tag,
    digest,
  };
}

/**
 * Normalize a Docker image reference to a canonical `registry/repo:tag`
 * string (or `registry/repo` if the ref was digest-pinned with no tag).
 * Used as the matching key between Diun events and running containers.
 *
 * @param {string} imageRef
 * @returns {string}
 */
export function normalizeRef(imageRef) {
  const { registry, repository, tag } = parseRef(imageRef);
  const base = `${registry}/${repository}`;
  return tag === null ? base : `${base}:${tag}`;
}

/**
 * True iff both digests are non-empty `sha256:...` strings AND they differ.
 * Missing/empty/malformed digests are treated as "no info" -> false (we
 * can't claim an update is available without two real digests to compare).
 *
 * @param {string|null|undefined} currentDigest
 * @param {string|null|undefined} eventDigest
 * @returns {boolean}
 */
export function isUpdateAvailable(currentDigest, eventDigest) {
  const a = normalizeDigest(currentDigest);
  const b = normalizeDigest(eventDigest);
  if (!a || !b) return false;
  return a !== b;
}

/**
 * Compares two digest strings for equality, tolerant of surrounding
 * whitespace and case differences in the "sha256:" prefix. Returns false
 * if either side is missing/empty/not a sha256 digest.
 *
 * @param {string|null|undefined} a
 * @param {string|null|undefined} b
 * @returns {boolean}
 */
export function digestsEqual(a, b) {
  const na = normalizeDigest(a);
  const nb = normalizeDigest(b);
  if (!na || !nb) return false;
  return na === nb;
}

/**
 * @param {string|null|undefined} digest
 * @returns {string|null} trimmed, lowercased `sha256:...` string, or null
 *   if `digest` isn't a non-empty string of that shape. Deliberately
 *   permissive about the hex portion's length/content (beyond requiring
 *   at least one hex character) so this works with real 64-hex-char
 *   digests as well as shorter fixtures used in tests.
 */
function normalizeDigest(digest) {
  if (typeof digest !== 'string') return null;
  const trimmed = digest.trim();
  if (trimmed === '') return null;
  const lower = trimmed.toLowerCase();
  if (!/^sha256:[0-9a-f]+$/.test(lower)) return null;
  return lower;
}
