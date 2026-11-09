import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectSession, frameURL, matchesProject } from '../extension/project-session.js';

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
test('moving a page out cancels its in-flight attachment without ending other page collection', async t => {
  const previous = globalThis.chrome; t.after(() => { globalThis.chrome = previous; });
  let release, entered, attached = 0;
  const waiting = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { entered = resolve; });
  globalThis.chrome = {
    tabs: { get: async () => ({ id: 1, url: 'https://a.test/app/detail?id=1' }) },
    permissions: { contains: async () => true },
    debugger: { attach: async () => { attached++; entered(); await waiting; }, detach: async () => { attached--; } },
  };
  const session = new ProjectSession({ rpc: async () => ({}), change: () => {} });
  session.accept({ origin: 'https://a.test', pagePath: '/app', resources: [] });
  session.active = true; session.captureId = 'test';
  session.tabs.set(2, { id: 2, url: 'https://a.test/app/list', overrides: [], appliedURLs: new Set(), outcomes: new Map() });
  session.members.add(2);
  const pending = session.follow(1); await ready;
  await session.removePage('https://a.test/app/detail'); release(); await pending;
  assert.equal(attached, 0); assert.equal(session.active, true); assert.equal(session.tabs.has(2), true);
  assert.equal(matchesProject(session.project, 'https://a.test/app/detail?id=2'), false);
  assert.equal(matchesProject(session.project, 'https://a.test/app/list'), true);
});
