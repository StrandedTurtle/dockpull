/**
 * SSRF guards for the user-supplied Discord webhook URL.
 *
 * The webhook URL is fetched server-side (scheduled notify + "send test"), so
 * an unrestricted URL would let an authenticated user probe the host's internal
 * network or cloud metadata endpoints. We defend in two layers:
 *
 *  - `isSafeWebhookUrl(url)` — synchronous, cheap. Requires https and rejects
 *    URLs whose host is a literal loopback/private/link-local/reserved IP or an
 *    obviously-internal name (localhost / *.local). Used when validating input
 *    before storing it and in the test endpoint.
 *  - `assertPublicWebhookUrl(url)` — async. Does the sync checks, then resolves
 *    the hostname via DNS and rejects if *any* resolved address is private.
 *    This closes the gap where a public hostname points at an internal IP (or a
 *    DNS-rebind). Called right before the network request in notify.js.
 */

import dns from 'node:dns/promises';
import net from 'node:net';

/** Strip brackets from a URL hostname (IPv6 literals are bracketed). */
function unbracket(host) {
  return host.replace(/^\[/, '').replace(/\]$/, '');
}

/**
 * Is this a private / loopback / link-local / otherwise-non-public IP literal?
 * Handles IPv4, IPv6, and IPv4-mapped IPv6 (::ffff:a.b.c.d).
 */
export function isPrivateIp(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) return isPrivateIpv4(ip);
  if (kind === 6) return isPrivateIpv6(ip);
  return false; // not an IP literal
}

function isPrivateIpv4(ip) {
  const parts = ip.split('.').map((n) => parseInt(n, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true; // malformed → treat as unsafe
  }
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10/8 private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 168) return true; // 192.168/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 192 && b === 0 && parts[2] === 0) return true; // 192.0.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18/15
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isPrivateIpv6(ip) {
  const addr = ip.toLowerCase();
  if (addr === '::1' || addr === '::') return true; // loopback / unspecified
  // IPv4-mapped (::ffff:a.b.c.d) — classify by the embedded v4 address.
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIpv4(mapped[1]);
  if (addr.startsWith('fe80')) return true; // link-local
  const first = addr.split(':')[0];
  if (/^f[cd]/.test(first)) return true; // unique-local fc00::/7
  return false;
}

/**
 * Validate a notification target URL: a well-formed http(s) URL with a host.
 * Unlike `isSafeWebhookUrl`, this intentionally ALLOWS private/LAN hosts — a
 * self-hosted ntfy/Gotify/webhook on your network is a normal, deliberate
 * target, and this field is admin-only (behind login).
 */
export function isValidNotifyUrl(value) {
  if (typeof value !== 'string') return false;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return Boolean(url.hostname);
}

/** Synchronous, network-free safety check. Requires https. */
export function isSafeWebhookUrl(value) {
  if (typeof value !== 'string') return false;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = unbracket(url.hostname).toLowerCase();
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    return false;
  }
  if (net.isIP(host) && isPrivateIp(host)) return false;
  return true;
}

/**
 * Async guard used right before fetching the webhook. Throws an Error with
 * `.code = 'unsafe_url'` if the URL fails the sync checks or resolves to a
 * private address.
 */
export async function assertPublicWebhookUrl(value) {
  if (!isSafeWebhookUrl(value)) {
    const err = new Error('webhook URL is not allowed');
    err.code = 'unsafe_url';
    throw err;
  }
  const host = unbracket(new URL(value.trim()).hostname);
  // If it's already an IP literal, the sync check covered it.
  if (net.isIP(host)) return;
  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    const err = new Error('could not resolve webhook host');
    err.code = 'unsafe_url';
    throw err;
  }
  if (addrs.some((a) => isPrivateIp(a.address))) {
    const err = new Error('webhook host resolves to a private address');
    err.code = 'unsafe_url';
    throw err;
  }
}

export default { isPrivateIp, isSafeWebhookUrl, assertPublicWebhookUrl, isValidNotifyUrl };
