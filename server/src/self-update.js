/**
 * "A newer DockPull is available" — read-only. DockPull deliberately never
 * updates its own container (recreating the container running this process
 * mid-update breaks it), so this only tells the user, shows what changed, and
 * gives them the command to run.
 *
 * Uses the GitHub releases of the DockPull repo (cached 30 min by
 * changelog.js, and optional GITHUB_TOKEN applies). Any failure means "no
 * banner", never an error in the UI.
 */

import { getReleasesCached } from './changelog.js';
import { parseVersionTag } from './version.js';

export const SELF_REPO = { owner: 'StrandedTurtle', repo: 'dockpull' };

function cmp(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Pure: the releases newer than `currentVersion` (stable only, newest first).
 * Empty when current is unknown/unparseable (e.g. a dev build) — no banner.
 */
export function newerSelfReleases(releases, currentVersion) {
  const cur = parseVersionTag(String(currentVersion || ''));
  if (!cur || !Array.isArray(releases)) return [];
  return releases
    .filter((r) => r && !r.draft && !r.prerelease)
    .map((r) => ({ r, v: parseVersionTag(String(r.tag_name || '')) }))
    .filter(({ v }) => v && v.nums.length >= 2 && cmp(v.nums, cur.nums) > 0)
    .sort((a, b) => cmp(b.v.nums, a.v.nums))
    .map(({ r }) => r);
}

/**
 * @param {string} currentVersion - this build's version (package.json).
 * @returns {Promise<{ current: string, available: boolean, latest?: string, releaseUrl?: string, releases?: Array<object> }>}
 */
export async function getSelfUpdate(currentVersion) {
  const base = { current: currentVersion, available: false };
  const releases = await getReleasesCached(SELF_REPO.owner, SELF_REPO.repo);
  const newer = newerSelfReleases(releases, currentVersion);
  if (newer.length === 0) return base;
  return {
    ...base,
    available: true,
    latest: newer[0].tag_name.replace(/^v/i, ''),
    releaseUrl: newer[0].html_url,
    releases: newer.slice(0, 10).map((r) => ({
      tag: r.tag_name,
      url: r.html_url,
      publishedAt: r.published_at,
      body: String(r.body || '').slice(0, 3000),
    })),
  };
}

export default { getSelfUpdate, newerSelfReleases, SELF_REPO };
