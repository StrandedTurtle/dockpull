import { test } from 'node:test';
import assert from 'node:assert/strict';
import { securityHeaders, CONTENT_SECURITY_POLICY } from '../src/security.js';

function fakeRes() {
  const headers = {};
  return {
    headers,
    set(k, v) {
      headers[k] = v;
    },
  };
}

function run(opts) {
  const res = fakeRes();
  let called = false;
  securityHeaders(opts)({}, res, () => {
    called = true;
  });
  return { headers: res.headers, called };
}

test('securityHeaders: sets the core headers and CSP, calls next', () => {
  const { headers, called } = run();
  assert.equal(called, true);
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(headers['X-Frame-Options'], 'DENY');
  assert.equal(headers['Referrer-Policy'], 'no-referrer');
  assert.equal(headers['Cross-Origin-Opener-Policy'], 'same-origin');
  assert.equal(headers['Content-Security-Policy'], CONTENT_SECURITY_POLICY);
  assert.match(headers['Content-Security-Policy'], /default-src 'self'/);
  assert.match(headers['Content-Security-Policy'], /frame-ancestors 'none'/);
});

test('securityHeaders: HSTS only when https', () => {
  assert.equal(run({ https: false }).headers['Strict-Transport-Security'], undefined);
  assert.match(run({ https: true }).headers['Strict-Transport-Security'], /max-age=31536000/);
});
