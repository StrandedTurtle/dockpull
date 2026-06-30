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

export default { securityHeaders, CONTENT_SECURITY_POLICY };
