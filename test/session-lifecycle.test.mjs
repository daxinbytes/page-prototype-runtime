import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectSession, frameURL } from '../extension/project-session.js';

test('CDP frame URLs retain hash routes for collection and bound override reloads', () => {
  assert.equal(frameURL({ url: 'https://a.test/app', urlFragment: '#/detail?id=1' }), 'https://a.test/app#/detail?id=1');
  assert.equal(frameURL({ url: 'https://a.test/app#/list' }), 'https://a.test/app#/list');
  assert.equal(frameURL({ url: 'https://a.test/app' }), 'https://a.test/app');
});

test('ending a session while a child is attaching cannot leave a late debugger attached', async (t) => {
  const previous = globalThis.chrome;
  t.after(() => { globalThis.chrome = previous; });
  let release;
  const attaching = new Promise((resolve) => { release = resolve; });
  let entered;
  const didEnter = new Promise((resolve) => { entered = resolve; });
  let attached = 0;
  globalThis.chrome = {
    tabs: { get: async () => ({ id: 1, url: 'https://a.test/app' }) },
    permissions: { contains: async () => true },
    debugger: { attach: async () => { attached++; entered(); await attaching; }, detach: async () => { attached--; } },
  };
  const session = new ProjectSession({ rpc: async () => ({}), change: () => {} });
  session.accept({ origin: 'https://a.test', pagePath: '/app', resources: [] });
  session.active = true; session.captureId = 'test';
  const previousEpoch = session.epoch;
  const follow = session.follow(1);
  await didEnter;
  const end = session.end(false);
  release();
  await Promise.all([follow, end]);
  assert.equal(attached, 0);
  assert.equal(session.tabs.size, 0);
  assert.equal(session.active, false);
  assert.notEqual(session.epoch, previousEpoch);
});
