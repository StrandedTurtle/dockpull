/**
 * Registry credentials from the host's Docker config.
 *
 * Reads `auths` out of `$DOCKER_CONFIG/config.json` (or `~/.docker/config.json`)
 * — the file `docker login` writes — so the checker can query private images
 * and avoid Docker Hub's anonymous rate limit. Only the static base64
 * `auths[host].auth` form is supported (the common headless-server case);
 * credential *helpers* / stores (Docker Desktop keychains) are not, since they
 * require running external `docker-credential-*` binaries. Operators using a
 * cred store should provide a plain config.json instead.
 *
 * No secrets are stored by the app — credentials live only in the mounted
 * Docker config, exactly like Watchtower/Diun.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// All the spellings Docker Hub appears under in a config.json `auths` map.
const DOCKER_HUB_ALIASES = new Set([
  'index.docker.io',
  'docker.io',
  'registry-1.docker.io',
  'registry.hub.docker.com',
]);

let cache; // memoized Map<host, base64> ; undefined until first load

function configPath() {
  if (process.env.DOCKER_CONFIG) {
    return path.join(process.env.DOCKER_CONFIG, 'config.json');
  }
  return path.join(os.homedir() || '/root', '.docker', 'config.json');
}

// Strip scheme + any path so "https://index.docker.io/v1/" -> "index.docker.io".
function normalizeAuthHost(key) {
  return String(key)
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
}

function load() {
  if (cache) return cache;
  const map = new Map();
  try {
    const json = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    const auths = json && typeof json.auths === 'object' ? json.auths : {};
    for (const [key, val] of Object.entries(auths)) {
      let b64 = typeof val?.auth === 'string' ? val.auth : null;
      if (!b64 && val?.username && val?.password) {
        b64 = Buffer.from(`${val.username}:${val.password}`).toString('base64');
      }
      if (b64) map.set(normalizeAuthHost(key), b64);
    }
  } catch {
    // No config, unreadable, or malformed — just means no creds available.
  }
  cache = map;
  return cache;
}

/**
 * Base64 `user:pass` for a registry host, or null if none is configured.
 * @param {string} registry e.g. "docker.io", "ghcr.io"
 * @returns {string|null}
 */
export function basicAuthForRegistry(registry) {
  const auths = load();
  if (DOCKER_HUB_ALIASES.has(registry)) {
    for (const alias of DOCKER_HUB_ALIASES) {
      if (auths.has(alias)) return auths.get(alias);
    }
    return null;
  }
  return auths.get(registry) || null;
}

/** Test hook: drop the memoized config so a fresh DOCKER_CONFIG is re-read. */
export function _resetAuthCache() {
  cache = undefined;
}

export default { basicAuthForRegistry, _resetAuthCache };
