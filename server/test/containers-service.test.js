import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildContainerItems } from '../src/containers-service.js';

function makeContainer(overrides = {}) {
  return {
    name: 'nginx',
    image: 'nginx:latest',
    tag: 'latest',
    currentVersion: null,
    sourceUrl: null,
    currentDigest: 'sha256:aaa',
    project: 'web',
    service: 'nginx',
    composeFile: '/stacks/web/docker-compose.yml',
    composeFileMissing: false,
    workingDir: '/stacks/web',
    state: 'running',
    normalizedRef: 'docker.io/library/nginx:latest',
    ...overrides,
  };
}

describe('buildContainerItems', () => {
  test('newer event digest -> updateAvailable true, availableDigest set', () => {
    const containers = [makeContainer({ currentDigest: 'sha256:aaa' })];
    const lookupEvent = () => ({ digest: 'sha256:bbb' });
    const isPinned = () => false;

    const { items, refsToResolve } = buildContainerItems({ containers, lookupEvent, isPinned });

    assert.equal(items.length, 1);
    assert.equal(items[0].updateAvailable, true);
    assert.equal(items[0].availableDigest, 'sha256:bbb');
    assert.deepEqual(refsToResolve, []);
  });

  test('event digest equals currentDigest -> updateAvailable false, ref pushed to refsToResolve', () => {
    const containers = [makeContainer({ currentDigest: 'sha256:aaa', normalizedRef: 'docker.io/library/nginx:latest' })];
    const lookupEvent = () => ({ digest: 'sha256:aaa' });
    const isPinned = () => false;

    const { items, refsToResolve } = buildContainerItems({ containers, lookupEvent, isPinned });

    assert.equal(items[0].updateAvailable, false);
    assert.equal(items[0].availableDigest, null);
    assert.deepEqual(refsToResolve, ['docker.io/library/nginx:latest']);
  });

  test('pinned ref -> pinned true in the item', () => {
    const containers = [makeContainer()];
    const lookupEvent = () => undefined;
    const isPinned = (ref) => ref === 'docker.io/library/nginx:latest';

    const { items } = buildContainerItems({ containers, lookupEvent, isPinned });

    assert.equal(items[0].pinned, true);
  });

  test('no event -> updateAvailable false, availableDigest null, not in refsToResolve', () => {
    const containers = [makeContainer()];
    const lookupEvent = () => undefined;
    const isPinned = () => false;

    const { items, refsToResolve } = buildContainerItems({ containers, lookupEvent, isPinned });

    assert.equal(items[0].updateAvailable, false);
    assert.equal(items[0].availableDigest, null);
    assert.deepEqual(refsToResolve, []);
  });

  test('passes through the API item shape fields unchanged', () => {
    const containers = [makeContainer()];
    const { items } = buildContainerItems({
      containers,
      lookupEvent: () => undefined,
      isPinned: () => false,
    });

    assert.deepEqual(items[0], {
      name: 'nginx',
      project: 'web',
      service: 'nginx',
      image: 'nginx:latest',
      tag: 'latest',
      currentVersion: null,
      sourceUrl: null,
      currentDigest: 'sha256:aaa',
      updateAvailable: false,
      availableDigest: null,
      pinned: false,
      hidden: false,
      state: 'running',
      composeFile: '/stacks/web/docker-compose.yml',
      composeFileMissing: false,
      workingDir: '/stacks/web',
    });
  });

  test('isHidden marks the item hidden', () => {
    const containers = [makeContainer()];
    const { items } = buildContainerItems({
      containers,
      lookupEvent: () => undefined,
      isPinned: () => false,
      isHidden: (name) => name === 'nginx',
    });
    assert.equal(items[0].hidden, true);
  });

  test('handles multiple containers independently', () => {
    const containers = [
      makeContainer({ name: 'a', normalizedRef: 'docker.io/library/a:latest', currentDigest: 'sha256:111' }),
      makeContainer({ name: 'b', normalizedRef: 'docker.io/library/b:latest', currentDigest: 'sha256:222' }),
    ];
    const events = {
      'docker.io/library/a:latest': { digest: 'sha256:999' },
      'docker.io/library/b:latest': { digest: 'sha256:222' },
    };
    const lookupEvent = (ref) => events[ref];
    const isPinned = () => false;

    const { items, refsToResolve } = buildContainerItems({ containers, lookupEvent, isPinned });

    assert.equal(items[0].updateAvailable, true);
    assert.equal(items[0].availableDigest, 'sha256:999');
    assert.equal(items[1].updateAvailable, false);
    assert.equal(items[1].availableDigest, null);
    assert.deepEqual(refsToResolve, ['docker.io/library/b:latest']);
  });
});
