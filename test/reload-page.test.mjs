import test from 'node:test';
import assert from 'node:assert/strict';
import { reloadPage } from '../extension/reload-page.js';
function event() { const listeners = new Set(); return { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn), emit: (data) => { for (const fn of listeners) fn(data); }, get size() { return listeners.size; } }; }
function setup(t) {
  const old = globalThis.chrome; t.after(() => { globalThis.chrome = old; });
  const onCommitted = event(), onCompleted = event(), onErrorOccurred = event(), onRemoved = event();
  globalThis.chrome = { webNavigation: { onCommitted, onCompleted, onErrorOccurred }, tabs: { onRemoved, reload: async () => {} } };
  return globalThis.chrome;
}
test('fresh-page wait ignores old completion and iframe commits and removes listeners on success', async (t) => {
  const chrome = setup(t); let completed = false;
  const waiting = reloadPage(9).then(() => { completed = true; });
  chrome.webNavigation.onCompleted.emit({ tabId: 9, frameId: 0 });
  chrome.webNavigation.onCommitted.emit({ tabId: 9, frameId: 1 });
  chrome.webNavigation.onCompleted.emit({ tabId: 9, frameId: 1 });
  await Promise.resolve(); assert.equal(completed, false);
  chrome.webNavigation.onCommitted.emit({ tabId: 9, frameId: 0 });
  chrome.webNavigation.onCompleted.emit({ tabId: 9, frameId: 0 }); await waiting;
  assert.ok(Object.values(chrome.webNavigation).every((value) => value.size === 0));
});
test('failed reload rejects without leaving navigation listeners behind', async (t) => {
  const chrome = setup(t); const waiting = reloadPage(9);
  chrome.webNavigation.onErrorOccurred.emit({ tabId: 9, frameId: 0 });
  await assert.rejects(waiting, /加载失败/);
  assert.ok(Object.values(chrome.webNavigation).every((value) => value.size === 0));
  assert.equal(chrome.tabs.onRemoved.size, 0);
});
