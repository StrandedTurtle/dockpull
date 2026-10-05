import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isValidSession, requireAuth, sessionCookieValue } from '../src/auth.js';
import { config } from '../src/config.js';

function makeReq({ signedCookies = {}, path = '/api/containers' } = {}) {
  return { signedCookies, path };
}

describe('isValidSession', () => {
  test('returns false when there is no signed cookie', () => {
    assert.equal(isValidSession(makeReq({ signedCookies: {} })), false);
  });

  test('returns false when cookie-parser rejected the signature (false in signedCookies)', () => {
    assert.equal(isValidSession(makeReq({ signedCookies: { dockpull_session: false } })), false);
  });

  test('returns false when the expiry is in the past', () => {
    const expired = sessionCookieValue(Date.now() - 1000);
    assert.equal(isValidSession(makeReq({ signedCookies: { dockpull_session: expired } })), false);
  });

  test('returns false when the cookie value is not numeric', () => {
    assert.equal(isValidSession(makeReq({ signedCookies: { dockpull_session: 'not-a-number' } })), false);
  });

  test('returns false for a legacy expiry-only cookie', () => {
    const legacy = String(Date.now() + 1000 * 60);
    assert.equal(isValidSession(makeReq({ signedCookies: { dockpull_session: legacy } })), false);
  });

  test('changing ADMIN_PASSWORD invalidates existing sessions', () => {
    const before = config.ADMIN_PASSWORD;
    const cookie = sessionCookieValue(Date.now() + 60_000);
    try {
      config.ADMIN_PASSWORD = `${before}-changed`;
      assert.equal(isValidSession(makeReq({ signedCookies: { dockpull_session: cookie } })), false);
    } finally {
      config.ADMIN_PASSWORD = before;
    }
    assert.equal(isValidSession(makeReq({ signedCookies: { dockpull_session: cookie } })), true);
  });

  test('returns true when the expiry is in the future', () => {
    const future = sessionCookieValue(Date.now() + 1000 * 60);
    assert.equal(isValidSession(makeReq({ signedCookies: { dockpull_session: future } })), true);
  });
});

describe('requireAuth', () => {
  test('passes non-/api/ requests through regardless of session state', () => {
    const req = makeReq({ signedCookies: {}, path: '/some/static/asset.js' });
    let nextCalled = false;
    const res = { status: () => { throw new Error('should not respond'); } };
    requireAuth(req, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
  });

  test('responds 401 for /api/ requests with no valid session', () => {
    const req = makeReq({ signedCookies: {}, path: '/api/containers' });
    let statusCode = null;
    let body = null;
    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(payload) {
        body = payload;
        return this;
      },
    };
    let nextCalled = false;
    requireAuth(req, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false);
    assert.equal(statusCode, 401);
    assert.deepEqual(body, { error: 'unauthorized' });
  });

  test('calls next() for /api/ requests with a valid session', () => {
    const future = sessionCookieValue(Date.now() + 1000 * 60);
    const req = makeReq({ signedCookies: { dockpull_session: future }, path: '/api/containers' });
    const res = { status: () => { throw new Error('should not respond'); } };
    let nextCalled = false;
    requireAuth(req, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
  });
});

import { logoutAllHandler, setSessionGenerationStore } from '../src/auth.js';

test('sign out everywhere: old cookies stop working, the caller gets a fresh one', () => {
  let gen = 0;
  setSessionGenerationStore({ get: () => gen, set: (n) => (gen = n) });
  try {
    const before = sessionCookieValue(Date.now() + 60_000);
    let issued = null;
    let status = null;
    const res = {
      cookie: (_n, v) => (issued = v),
      status: (s) => ((status = s), { json: () => {} }),
    };
    logoutAllHandler(makeReq({ signedCookies: { dockpull_session: before } }), res);
    assert.equal(status, 200);
    assert.equal(gen, 1);
    assert.equal(isValidSession(makeReq({ signedCookies: { dockpull_session: before } })), false);
    assert.equal(isValidSession(makeReq({ signedCookies: { dockpull_session: issued } })), true);

    // Without a valid session it refuses and changes nothing.
    status = null;
    logoutAllHandler(makeReq({ signedCookies: { dockpull_session: before } }), res);
    assert.equal(status, 401);
    assert.equal(gen, 1);
  } finally {
    setSessionGenerationStore({ get: () => 0, set: () => {} });
  }
});
