import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CaptureStore } from '../lib/captures.mjs';
import { sha256 } from '../lib/workspace.mjs';

const project = () => ({ projectId: 'demo', name: '演示项目', origin: 'https://a.test', pagePath: '/app',
  sites: [{ origin: 'https://a.test', pagePath: '/app' }, { origin: 'https://b.test', pagePath: '/app' }] });
const source = () => Buffer.from(`window.a = 1;\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify({ version: 3, sources: ['src/a.ts'], sourcesContent: ['export const a = 1;'], mappings: '', names: [] })).toString('base64')}`);
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'project-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new CaptureStore(root, project()); await store.load();
  return { root, store, add: (origin, bytes = source(), page = '/app') => store.ingest({ captureId: store.manifest.id, url: `${origin}/a.js`, type: 'Script', pageUrl: `${origin}${page}` }, bytes) };
}
test('project keeps one session, deduplicates content across domains and retains both resource owners', async (t) => {
  const { store, add } = await setup(t);
  const id = await store.begin(); const a = await add('https://a.test'); const b = await add('https://b.test');
  assert.equal(await store.begin(), id);
  assert.equal(store.manifest.resources.length, 2);
  assert.equal(store.manifest.resources[0].path, store.manifest.resources[1].path);
  assert.equal(store.manifest.bytes, source().length);
  assert.equal(store.manifest.sources.length, 1);
  assert.deepEqual(new Set(store.manifest.sources[0].resourceIds), new Set([a.resourceId, b.resourceId]));
  assert.equal(store.manifest.pages.length, 2);
  assert.equal(store.summary().reusedResources, 1);
});
test('hash probe reuses bytes, while a new version and existing draft remain separate', async (t) => {
  const { store, add } = await setup(t);
  const old = await add('https://a.test'); const [draft] = await store.stage([old.resourceId]);
  await writeFile(draft.overridePath, 'window.a = 2;');
  const probe = await store.probe({ captureId: store.manifest.id, url: 'https://b.test/a.js', type: 'Script', hash: sha256(source()), pageUrl: 'https://b.test/app' });
  assert.equal(probe.found, true);
  await add('https://a.test', Buffer.from('window.a = 3;'));
  assert.equal(store.manifest.resources.length, 3);
  assert.equal(await readFile(draft.overridePath, 'utf8'), 'window.a = 2;');
});
test('imports legacy captures and draft files without rewriting their originals', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'project-legacy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const legacy = new CaptureStore(root, { origin: 'https://a.test', pagePath: '/app' });
  const id = await legacy.begin();
  const record = await legacy.ingest({ captureId: id, url: 'https://a.test/a.js', type: 'Script' }, source());
  const [draft] = await legacy.stage([record.resourceId]); await writeFile(draft.overridePath, 'window.a = 9;');
  const before = await readFile(join(legacy.directory, 'manifest.json'), 'utf8');
  const store = new CaptureStore(root, project()); await store.load();
  assert.equal(store.manifest.imports.length, 1);
  assert.equal(await readFile(store.manifest.resources[0].overridePath, 'utf8'), 'window.a = 9;');
  assert.equal(await readFile(join(legacy.directory, 'manifest.json'), 'utf8'), before);
  const reopened = new CaptureStore(root, project()); await reopened.load();
  assert.equal(reopened.manifest.id, store.manifest.id);
  assert.equal(reopened.manifest.resources.length, 1);
});
test('new site must be joined before ingestion and survives a service restart', async (t) => {
  const { store, root, add } = await setup(t);
  await assert.rejects(add('https://new.test'), /授权/);
  await store.addSite({ origin: 'https://new.test', pagePath: '/' }); await add('https://new.test');
  const reopened = new CaptureStore(root, project()); await reopened.load();
  assert.equal(reopened.allows('https://new.test'), true);
});
