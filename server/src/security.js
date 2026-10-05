/**
 * Security response headers. The app is fully same-origin — it serves its own
 * hashed JS/CSS bundles and talks only to its own /api — so a tight CSP holds.
 * `style-src` needs 'unsafe-inline' for React inline-style attributes and
 * Vite-injected styles; scripts are self-hosted bundles so `script-src 'self'`
 * is enough.
 */

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Build an Express middleware that sets security headers on every response.
 * HSTS is only emitted when the app is served over https.
 *
 * @param {{ https?: boolean }} [opts]
 */
export function securityHeaders({ https = false } = {}) {
  return function securityHeadersMiddleware(req, res, next) {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Cross-Origin-Opener-Policy', 'same-origin');
    res.set('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    if (https) {
      res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  };
}

// Docker container names (and IDs) — anything else is rejected before it
// reaches dockerode, which splices names into request paths unescaped (so a
// "name" like "../../images/x" would address a different API endpoint).
const CONTAINER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/;

export function isValidContainerName(name) {
  return typeof name === 'string' && CONTAINER_NAME_RE.test(name);
}

/** Express `router.param('name', …)` handler enforcing isValidContainerName. */
export function validateContainerNameParam(req, res, next, name) {
  if (isValidContainerName(name)) return next();
  return res.status(400).json({ error: 'invalid_container_name' });
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF guard for the API. The session cookie is SameSite=Lax, but "same site"
 * includes every port on the same host — and homelabs often run many apps on
 * one IP, any of which (or an XSS in one) could otherwise make the browser
 * POST to DockPull with the user's cookie. State-changing /api requests must
 * carry `X-DockPull: 1`: a cross-origin page can't set a custom header without
 * a CORS preflight, which this server never approves. The app's own client
 * always sends it.
 */
export function requireCsrfHeader(req, res, next) {
  if (SAFE_METHODS.has(req.method) || !req.path.startsWith('/api/')) return next();
  if (req.get('x-dockpull') === '1') return next();
  return res.status(403).json({ error: 'csrf_header_missing' });
}

export default { securityHeaders, requireCsrfHeader, isValidContainerName, validateContainerNameParam, CONTENT_SECURITY_POLICY };
