import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as sse from '../src/sse.js';

function fakeRes() {
  const res = new EventEmitter();
  res.chunks = [];
  res.ended = false;
  res.writeHead = () => {};
  res.write = (c) => res.chunks.push(c);
  res.end = () => {
    res.ended = true;
  };
  return res;
}

test('a finished session\'s cleanup timer never deletes a newer session with the same name', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    sse.startSession('web');
    sse.finish('web', { success: false, message: 'unhealthy' });

    // Revert started within the grace period.
    assert.ok(sse.startSession('web'));
    mock.timers.tick(60_000);

    assert.equal(sse.isActive('web'), true, 'new session must survive the old timer');
    const res = fakeRes();
    sse.subscribe('web', res);
    sse.pushLog('web', 'reverting…');
    sse.finish('web', { success: true, message: 'Reverted' });
    const out = res.chunks.join('');
    assert.match(out, /reverting…/);
    assert.match(out, /"type":"result","success":true/);
    assert.equal(res.ended, true);
  } finally {
    mock.timers.reset();
  }
});

test('a finished session is still replayable during the grace period, then removed', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    sse.startSession('db');
    sse.pushLog('db', 'pulling');
    sse.finish('db', { success: true, message: 'ok' });

    const late = fakeRes();
    sse.subscribe('db', late);
    assert.match(late.chunks.join(''), /pulling[\s\S]*"success":true/);

    mock.timers.tick(31_000);
    const later = fakeRes();
    sse.subscribe('db', later);
    assert.match(later.chunks.join(''), /No active update/);
  } finally {
    mock.timers.reset();
  }
});
