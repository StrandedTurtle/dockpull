/**
 * Decide whether a version string is actually useful to show a user.
 *
 * Some images set `org.opencontainers.image.version` to a branch name, a
 * channel, or a git sha (e.g. homarr labels every build `main` and ships
 * `:latest`). Those are not versions — surfacing them produces misleading
 * "main → main" cards. This predicate lets callers fall back to something
 * better (a GitHub release tag, the image tag, or the digest).
 */

// Channel / branch words that are never a meaningful version.
const STOPWORDS = new Set([
  'latest',
  'edge',
  'stable',
  'nightly',
  'rolling',
  'dev',
  'devel',
  'develop',
  'development',
  'main',
  'master',
  'head',
  'release',
  'releases',
  'snapshot',
  'canary',
  'prod',
  'production',
  'current',
  'beta',
  'alpha',
  'rc',
]);

/**
 * @param {unknown} v
 * @returns {boolean} true if `v` looks like a real version worth displaying.
 */
export function isMeaningfulVersion(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (!s) return false;
  if (STOPWORDS.has(s.toLowerCase())) return false;
  if (/^sha-?256[:-]/i.test(s)) return false; // a digest, not a version
  if (/^[0-9a-f]{7,64}$/i.test(s)) return false; // bare git/image sha
  return true;
}

export default { isMeaningfulVersion };
