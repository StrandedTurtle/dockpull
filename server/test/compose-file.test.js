import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteServiceImageTag, restoreServiceImage, findServiceImage } from '../src/compose-file.js';

const file = `# my stack
services:
  db:
    image: postgres:16.3   # keep this comment
    environment:
      web: not-a-service
      POSTGRES_PASSWORD: x
  web:
    image: "ghcr.io/acme/web:1.2.0"
    depends_on: [db]

volumes:
  data:
`;

test('rewrites only the target service tag, preserving everything else', () => {
  const r = rewriteServiceImageTag(file, 'db', 'docker.io/library/postgres:16.3', '16.4');
  assert.equal(r.oldValue, 'postgres:16.3');
  assert.equal(r.newValue, 'postgres:16.4');
  assert.equal(r.text, file.replace('postgres:16.3', 'postgres:16.4'));
});

test('keeps quotes and finds the real service, not a nested key with the same name', () => {
  const r = rewriteServiceImageTag(file, 'web', 'ghcr.io/acme/web:1.2.0', '1.3.0');
  assert.equal(r.text, file.replace('"ghcr.io/acme/web:1.2.0"', '"ghcr.io/acme/web:1.3.0"'));
});

test('refuses variables, digests, mismatches and missing image lines', () => {
  const v = 'services:\n  app:\n    image: app:${TAG}\n';
  assert.throws(() => rewriteServiceImageTag(v, 'app', 'app:1', '2'), { code: 'image_uses_variable' });
  const d = `services:\n  app:\n    image: app@sha256:${'a'.repeat(64)}\n`;
  assert.throws(() => rewriteServiceImageTag(d, 'app', 'app:1', '2'), { code: 'image_pinned_by_digest' });
  assert.throws(() => rewriteServiceImageTag(file, 'db', 'postgres:15', '16.4'), { code: 'image_mismatch' });
  const anchor = 'x-base: &base\n  image: app:1\nservices:\n  app:\n    <<: *base\n';
  assert.throws(() => rewriteServiceImageTag(anchor, 'app', 'app:1', '2'), { code: 'image_not_found' });
  assert.throws(() => rewriteServiceImageTag(file, 'nope', 'postgres:16.3', '16.4'), { code: 'image_not_found' });
});

test('handles registries with ports and tabs-free 4-space indentation', () => {
  const f = 'services:\n    reg:\n        image: localhost:5000/team/app:1.0\n';
  const r = rewriteServiceImageTag(f, 'reg', 'localhost:5000/team/app:1.0', '1.1');
  assert.equal(r.text, 'services:\n    reg:\n        image: localhost:5000/team/app:1.1\n');
});

test('restoreServiceImage: undoes the switch, but never clobbers a later edit', () => {
  const switched = rewriteServiceImageTag(file, 'db', 'postgres:16.3', '16.4').text;
  assert.equal(restoreServiceImage(switched, 'db', 'postgres:16.4', 'postgres:16.3'), file);
  const handEdited = switched.replace('postgres:16.4', 'postgres:17');
  assert.equal(restoreServiceImage(handEdited, 'db', 'postgres:16.4', 'postgres:16.3'), null);
  assert.equal(findServiceImage(file, 'db').value, 'postgres:16.3');
});
