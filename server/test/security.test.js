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

import { requireCsrfHeader } from '../src/security.js';

function runCsrf({ method, path, header }) {
  let status = null;
  let nextCalled = false;
  const req = { method, path, get: (h) => (h.toLowerCase() === 'x-dockpull' ? header : undefined) };
  const res = { status: (s) => ((status = s), { json: () => {} }) };
  requireCsrfHeader(req, res, () => (nextCalled = true));
  return { status, nextCalled };
}

test('requireCsrfHeader: blocks state-changing /api requests without the header', () => {
  assert.equal(runCsrf({ method: 'POST', path: '/api/update/web' }).status, 403);
  assert.equal(runCsrf({ method: 'DELETE', path: '/api/history' }).status, 403);
  assert.equal(runCsrf({ method: 'POST', path: '/api/auth/login', header: '0' }).status, 403);
});

test('requireCsrfHeader: allows the app client, safe methods, and non-API paths', () => {
  assert.equal(runCsrf({ method: 'POST', path: '/api/update/web', header: '1' }).nextCalled, true);
  assert.equal(runCsrf({ method: 'GET', path: '/api/containers' }).nextCalled, true);
  assert.equal(runCsrf({ method: 'POST', path: '/somewhere' }).nextCalled, true);
});

import { isValidContainerName } from '../src/security.js';

test('isValidContainerName: accepts Docker names, rejects path tricks', () => {
  for (const ok of ['web', 'my-app_1', 'stack.svc-2', 'a'.repeat(64)]) assert.equal(isValidContainerName(ok), true, ok);
  for (const bad of ['', '../../images/json', 'a/b', '-x', '.hidden', 'a b', 'x?y', null]) {
    assert.equal(isValidContainerName(bad), false, String(bad));
  }
});
