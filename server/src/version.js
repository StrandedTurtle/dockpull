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

/**
 * Pure: split a version-like image tag into a comparable form.
 *
 *   "16.3"              -> nums [16, 3],         shape "|2|"
 *   "v1.2.3"            -> nums [1, 2, 3],       shape "v|3|"
 *   "16.3-alpine"       -> nums [16, 3],         shape "|2|-alpine"
 *   "4.0.14.2939-ls283" -> nums [4,0,14,2939, 283], shape "|4|-ls#"
 *
 * The "shape" (prefix, how many numeric parts, and the suffix with its digits
 * blanked) decides which tags are comparable: "16.3-alpine" only competes
 * with other "x.y-alpine" tags, and "-rc1"/"-beta" tags never match a stable
 * tag. Digits inside the suffix (linuxserver's "-ls283" build number) are
 * compared after the main version. Returns null for tags that aren't versions
 * (latest, main, a sha…).
 *
 * @param {string} tag
 * @returns {{ prefix: string, nums: number[], shape: string }|null}
 */
export function parseVersionTag(tag) {
  if (typeof tag !== 'string') return null;
  const m = /^([vV]?)(\d+(?:\.\d+)*)(.*)$/.exec(tag.trim());
  if (!m) return null;
  const [, prefix, core, suffix] = m;
  if (/^[0-9a-f]{7,}$/i.test(tag)) return null; // a bare sha that happens to start with digits
  if (suffix && !/^[-_.+]/.test(suffix)) return null; // "1abc" isn't a version
  const nums = core.split('.').map(Number);
  if (nums.some((n) => !Number.isSafeInteger(n))) return null;
  const suffixNums = (suffix.match(/\d+/g) || []).map(Number);
  return {
    prefix: prefix.toLowerCase(),
    nums: [...nums, ...suffixNums],
    major: nums[0],
    shape: `${prefix.toLowerCase()}|${nums.length}|${suffix.replace(/\d+/g, '#').toLowerCase()}`,
  };
}

function compareNums(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Pure: given the tag a container runs and the registry's tag list, find the
 * newest comparable tag within the same major version (`sameMajor`) and the
 * newest comparable tag overall when that's a higher major (`nextMajor`).
 * Either is null when there's nothing newer.
 *
 * @param {string} currentTag
 * @param {string[]} tags
 * @returns {{ sameMajor: string|null, nextMajor: string|null }}
 */
export function findNewerTags(currentTag, tags) {
  const cur = parseVersionTag(currentTag);
  const none = { sameMajor: null, nextMajor: null };
  if (!cur || !Array.isArray(tags)) return none;
  let bestSame = null;
  let bestAny = null;
  for (const t of tags) {
    const p = parseVersionTag(t);
    if (!p || p.shape !== cur.shape || compareNums(p.nums, cur.nums) <= 0) continue;
    if (p.major === cur.major && (!bestSame || compareNums(p.nums, bestSame.p.nums) > 0)) bestSame = { t, p };
    if (!bestAny || compareNums(p.nums, bestAny.p.nums) > 0) bestAny = { t, p };
  }
  return {
    sameMajor: bestSame?.t ?? null,
    nextMajor: bestAny && bestAny.p.major > cur.major ? bestAny.t : null,
  };
}

export default { isMeaningfulVersion, parseVersionTag, findNewerTags };
