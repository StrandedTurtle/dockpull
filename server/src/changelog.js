/**
 * Best-effort changelog resolver. Given an image's source label + current
 * version, fetch GitHub release notes newer than what's running, or fall back
 * to a "where to look" link (the source URL, Docker Hub tags, GHCR repo).
 *
 * The parsing/selection helpers are pure (unit-tested); only fetchGitHubReleases
 * touches the network.
 */

import { parseRef } from './reconcile.js';

/**
 * Extract {owner, repo} from a GitHub URL, or null.
 * @param {string|null} sourceUrl
 * @returns {{owner: string, repo: string}|null}
 */
export function parseGitHubRepo(sourceUrl) {
  if (typeof sourceUrl !== 'string') return null;
  const m = sourceUrl.match(/github\.com[/:]([^/]+)\/([^/#?]+)/i);
  if (!m) return null;
  const owner = m[1];
  const repo = m[2].replace(/\.git$/i, '');
  if (!owner || !repo) return null;
  return { owner, repo };
}

function normalizeVer(v) {
  return String(v || '').trim().replace(/^v/i, '');
}

function truncate(s, n) {
  if (typeof s !== 'string') return '';
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/**
 * From a newest-first list of releases, pick those newer than currentVersion.
 * Heuristic: walk from newest until we hit the release matching the running
 * version; if we never match, show the most recent few. Pure + testable.
 *
 * @param {Array<{tag_name?: string, name?: string}>} releases
 * @param {string|null} currentVersion
 * @returns {Array<object>}
 */
export function selectNewerReleases(releases, currentVersion) {
  if (!Array.isArray(releases)) return [];
  if (!currentVersion) return releases.slice(0, 5);
  const cur = normalizeVer(currentVersion);
  const out = [];
  for (const r of releases) {
    const tag = normalizeVer(r.tag_name || r.name || '');
    if (tag && tag === cur) break; // reached the running version
    out.push(r);
    if (out.length >= 10) break;
  }
  return out;
}

/**
 * Best-effort "where to look" link for an image with no GitHub source label.
 * @param {string} image
 * @returns {{url: string, label: string}|null}
 */
export function buildRegistryLink(image) {
  let parsed;
  try {
    parsed = parseRef(image);
  } catch {
    return null;
  }
  const { registry, repository } = parsed;
  if (registry === 'docker.io') {
    if (repository.startsWith('library/')) {
      return { url: `https://hub.docker.com/_/${repository.slice('library/'.length)}`, label: 'Docker Hub' };
    }
    return { url: `https://hub.docker.com/r/${repository}/tags`, label: 'Docker Hub' };
  }
  if (registry === 'ghcr.io') {
    return { url: `https://github.com/${repository}`, label: 'GitHub' };
  }
  return null;
}

// Optional token raises GitHub's unauthenticated 60/hr limit to 5000/hr.
function githubHeaders() {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'dockpull',
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function fetchGitHubReleases(owner, repo, timeoutMs = 10000) {
  const url = `https://api.github.com/repos/${owner}/${repo}/releases?per_page=30`;
  const res = await fetch(url, {
    headers: githubHeaders(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  return res.json();
}

/**
 * From a newest-first release list, pick the tag of the latest real release —
 * skipping drafts and prereleases. Pure + testable.
 *
 * @param {Array<{tag_name?: string, name?: string, draft?: boolean, prerelease?: boolean}>} releases
 * @returns {string|null}
 */
export function pickLatestReleaseTag(releases) {
  if (!Array.isArray(releases)) return null;
  for (const r of releases) {
    if (r && !r.draft && !r.prerelease) {
      const tag = (r.tag_name || r.name || '').trim();
      if (tag) return tag;
    }
  }
  return null;
}

// Conservative breaking-change signals. Word-bounded so prose like
// "unbreakable" never trips the flag.
const BREAKING_PATTERNS = [
  /\bbreaking\b/i, // "BREAKING CHANGE", "breaking changes"
  /\bmigration(s)? (required|needed|guide)\b/i,
  /\bdeprecated\b/i,
  /\bincompatible\b/i,
  /\baction required\b/i,
];

/**
 * True if any release's name or body mentions a breaking-change signal.
 * Pure + testable; feed it selectNewerReleases() output so only the notes
 * between the running version and the newest release are scanned.
 *
 * @param {Array<{name?: string, tag_name?: string, body?: string}>} releases
 * @returns {boolean}
 */
export function detectBreakingChanges(releases) {
  if (!Array.isArray(releases)) return false;
  return releases.some((r) => {
    const text = `${r?.name || ''}\n${r?.body || ''}`;
    return BREAKING_PATTERNS.some((re) => re.test(text));
  });
}

// Cache release lists so repeated checks don't re-hit the GitHub API.
const releasesCache = new Map(); // "owner/repo" -> { at, releases }
const RELEASES_TTL_MS = 30 * 60 * 1000;

/**
 * Best-effort release list for a GitHub repo (cached, 30-min TTL). Returns
 * null on any failure — never throws.
 *
 * @param {string} owner
 * @param {string} repo
 * @returns {Promise<Array<object>|null>}
 */
export async function getReleasesCached(owner, repo) {
  const key = `${owner}/${repo}`;
  const cached = releasesCache.get(key);
  if (cached && Date.now() - cached.at < RELEASES_TTL_MS) {
    return cached.releases;
  }
  try {
    const releases = await fetchGitHubReleases(owner, repo);
    releasesCache.set(key, { at: Date.now(), releases });
    return releases;
  } catch {
    return null;
  }
}

/**
 * Best-effort latest-release tag for a GitHub repo (cached). Returns null on
 * any failure — callers treat it as "no better version available".
 *
 * @param {string} owner
 * @param {string} repo
 * @returns {Promise<string|null>}
 */
export async function getLatestReleaseTag(owner, repo) {
  const releases = await getReleasesCached(owner, repo);
  return pickLatestReleaseTag(releases);
}

/**
 * Resolve a changelog payload for a container's image.
 *
 * @param {{ image: string, sourceUrl: string|null, currentVersion: string|null }} meta
 * @returns {Promise<object>}
 */
export async function getChangelog({ image, sourceUrl, currentVersion }) {
  const gh = parseGitHubRepo(sourceUrl);
  if (gh) {
    const releasesUrl = `https://github.com/${gh.owner}/${gh.repo}/releases`;
    try {
      const releases = await fetchGitHubReleases(gh.owner, gh.repo);
      const selected = selectNewerReleases(releases, currentVersion);
      return {
        type: 'github',
        repoUrl: `https://github.com/${gh.owner}/${gh.repo}`,
        releasesUrl,
        currentVersion: currentVersion || null,
        releases: selected.map((r) => ({
          tag: r.tag_name || r.name || '',
          name: r.name || r.tag_name || '',
          url: r.html_url,
          publishedAt: r.published_at,
          body: truncate(r.body || '', 1500),
        })),
      };
    } catch (err) {
      return {
        type: 'link',
        url: releasesUrl,
        label: 'Releases',
        note: `Couldn't fetch release notes (${err.message}).`,
      };
    }
  }
  if (sourceUrl) return { type: 'link', url: sourceUrl, label: 'Source' };
  const reg = buildRegistryLink(image);
  if (reg) return { type: 'link', url: reg.url, label: reg.label };
  return { type: 'none' };
}

export default {
  parseGitHubRepo,
  selectNewerReleases,
  buildRegistryLink,
  getChangelog,
  pickLatestReleaseTag,
  detectBreakingChanges,
  getReleasesCached,
  getLatestReleaseTag,
};
