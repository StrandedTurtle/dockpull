/**
 * Where to find release notes for popular images that don't declare an
 * `org.opencontainers.image.source` label. Without it DockPull could only link
 * to Docker Hub; with it the card gets real GitHub release notes, version
 * fallbacks and breaking-change hints. Every entry was checked to be a real
 * GitHub repo with version tags.
 *
 * Keys are `registry/repository` as parseRef() normalizes them.
 */

import { parseRef } from './reconcile.js';

const KNOWN = {
  // Docker Hub official images whose upstream publishes GitHub releases.
  'docker.io/library/redis': 'redis/redis',
  'docker.io/library/traefik': 'traefik/traefik',
  'docker.io/library/nginx': 'nginx/nginx',
  'docker.io/library/caddy': 'caddyserver/caddy',
  'docker.io/library/nextcloud': 'nextcloud/server',
  'docker.io/library/ghost': 'TryGhost/Ghost',
  'docker.io/library/registry': 'distribution/distribution',
  'docker.io/library/eclipse-mosquitto': 'eclipse/mosquitto',
  'docker.io/library/influxdb': 'influxdata/influxdb',

  // Popular homelab images.
  'docker.io/jellyfin/jellyfin': 'jellyfin/jellyfin',
  'docker.io/portainer/portainer-ce': 'portainer/portainer',
  'docker.io/portainer/portainer-ee': 'portainer/portainer',
  'docker.io/louislam/uptime-kuma': 'louislam/uptime-kuma',
  'docker.io/louislam/dockge': 'louislam/dockge',
  'docker.io/homeassistant/home-assistant': 'home-assistant/core',
  'ghcr.io/home-assistant/home-assistant': 'home-assistant/core',
  'docker.io/vaultwarden/server': 'dani-garcia/vaultwarden',
  'docker.io/pihole/pihole': 'pi-hole/docker-pi-hole',
  'docker.io/adguard/adguardhome': 'AdguardTeam/AdGuardHome',
  'docker.io/containrrr/watchtower': 'containrrr/watchtower',
  'docker.io/grafana/grafana': 'grafana/grafana',
  'docker.io/grafana/grafana-oss': 'grafana/grafana',
  'docker.io/prom/prometheus': 'prometheus/prometheus',
  'docker.io/n8nio/n8n': 'n8n-io/n8n',
  'docker.io/jc21/nginx-proxy-manager': 'NginxProxyManager/nginx-proxy-manager',
  'docker.io/syncthing/syncthing': 'syncthing/syncthing',
  'docker.io/filebrowser/filebrowser': 'filebrowser/filebrowser',
  'docker.io/gitea/gitea': 'go-gitea/gitea',
  'ghcr.io/immich-app/immich-server': 'immich-app/immich',
  'ghcr.io/immich-app/immich-machine-learning': 'immich-app/immich',
  'docker.io/binwiederhier/ntfy': 'binwiederhier/ntfy',
  'docker.io/gotify/server': 'gotify/server',
  'docker.io/authelia/authelia': 'authelia/authelia',
  'docker.io/qmcgaw/gluetun': 'qdm12/gluetun',
  'docker.io/esphome/esphome': 'esphome/esphome',
  'docker.io/koenkk/zigbee2mqtt': 'Koenkk/zigbee2mqtt',
  'docker.io/nodered/node-red': 'node-red/node-red',
};

/**
 * Pure: a GitHub URL with release notes for `image`, or null.
 *
 * Besides the table: linuxserver.io images (lscr.io/linuxserver/x,
 * linuxserver/x on Docker Hub, ghcr.io/linuxserver/x) publish releases in
 * github.com/linuxserver/docker-x, matching their image tags.
 *
 * @param {string} image
 * @returns {string|null}
 */
export function knownSourceFor(image) {
  let parsed;
  try {
    parsed = parseRef(image);
  } catch {
    return null;
  }
  const { registry, repository } = parsed;
  const known = KNOWN[`${registry}/${repository}`];
  if (known) return `https://github.com/${known}`;

  const ls = /^linuxserver\/([a-z0-9._-]+)$/.exec(repository);
  if (ls && ['lscr.io', 'docker.io', 'ghcr.io'].includes(registry)) {
    return `https://github.com/linuxserver/docker-${ls[1]}`;
  }
  return null;
}

export default { knownSourceFor };
