import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CaptureStore } from '../lib/captures.mjs';

const config = () => ({ projectId: 'example', name: '项目', sites: [{ origin: 'https://a.test', pagePath: '/app' }], origin: 'https://a.test', pagePath: '/app' });
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'beta-scenarios-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new CaptureStore(root, config()); await store.load();
  const added = await store.ingest({ captureId: store.manifest.id, url: 'https://a.test/index.js', type: 'Script' }, Buffer.from('window.button = "red";'));
  return { root, store, id: added.resourceId };
}
test('new scenarios use original bytes and never share writable drafts with existing scenarios', async (t) => {
  const { store, root, id } = await setup(t);
  const a = store.scenarios.active.id;
  const [draftA] = await store.stage([id]); await writeFile(draftA.overridePath, 'window.button = "blue";');
  const b = await store.scenarios.create('全新方案', { tabId: 8 });
  assert.deepEqual(store.manifest.selected, []); assert.equal(store.manifest.resources[0].overridePath, undefined);
  const [draftB] = await store.stage([id]);
  assert.notEqual(draftB.overridePath, draftA.overridePath); assert.match(await readFile(draftB.overridePath, 'utf8'), /red/);
  await writeFile(draftB.overridePath, 'window.button = "green";');
  await store.scenarios.use(a);
  assert.equal(store.manifest.resources[0].overridePath, draftA.overridePath);
  assert.match(Buffer.from((await store.snapshot(2)).resources[0].body, 'base64').toString(), /blue/);
  await store.scenarios.use(b.id, { tabId: 9 });
  const reopened = new CaptureStore(root, config()); await reopened.load();
  assert.equal(reopened.manifest.activeScenarioId, b.id); assert.equal(reopened.manifest.editTarget, null);
  assert.match(Buffer.from((await reopened.snapshot(3)).resources[0].body, 'base64').toString(), /green/);
  assert.match(await readFile(store.manifest.resources[0].path, 'utf8'), /red/);
});
test('0.4 migration copies drafts and keeps both legacy draft and pre-migration manifest intact', async (t) => {
  const { store, root, id } = await setup(t);
  const legacyPath = join(store.directory, 'overrides', `${id}.js`);
  await writeFile(legacyPath, 'window.button = "blue";');
  delete store.manifest.scenarios; delete store.manifest.activeScenarioId;
  store.manifest.resources[0].overridePath = legacyPath; store.manifest.selected = [id]; await store.save();
  const before = await readFile(join(store.directory, 'manifest.json'), 'utf8');
  const migrated = new CaptureStore(root, config()); await migrated.load();
  const draft = migrated.manifest.resources[0].overridePath;
  assert.notEqual(draft, legacyPath); assert.equal(await readFile(draft, 'utf8'), await readFile(legacyPath, 'utf8'));
  assert.equal(await readFile(join(store.directory, 'manifest.pre-scenarios.json'), 'utf8'), before);
  assert.equal(migrated.scenarios.list().length, 1); assert.equal(migrated.scenarios.active.name, '升级前的修改');
  const reopened = new CaptureStore(root, config()); await reopened.load(); assert.equal(reopened.scenarios.list().length, 1);
});
test('continuing a scenario retains accumulated selection and refuses original baseline tampering', async (t) => {
  const { store, id } = await setup(t);
  const second = await store.ingest({ captureId: store.manifest.id, url: 'https://a.test/styles.css', type: 'Stylesheet' }, Buffer.from('.button {color:red}'));
  await store.stage([id]); await store.stage([second.resourceId]);
  assert.deepEqual(store.scenarios.active.selected, [id, second.resourceId]);
  await writeFile(store.manifest.resources[0].path, 'changed baseline');
  await assert.rejects(store.snapshot(2), /原始快照/);
});
test('invalid names and foreign IDs cannot change the active scenario or destroy drafts', async (t) => {
  const { store } = await setup(t); const before = store.manifest.activeScenarioId;
  await assert.rejects(store.scenarios.create(' '), /名称/);
  await assert.rejects(store.scenarios.create('方案 1'), /同名/);
  await assert.rejects(store.scenarios.use('../another-project'), /没有这个方案/);
  assert.equal(store.manifest.activeScenarioId, before);
  await store.scenarios.rename(before, '蓝色按钮'); assert.equal(store.scenarios.summary().name, '蓝色按钮');
});
test('accumulated resource selection observes the same limit as a single stage', async (t) => {
  const { store, id } = await setup(t); const ids = [id];
  for (let i = 1; i <= 20; i++) ids.push((await store.ingest({ captureId: store.manifest.id, url: `https://a.test/${i}.js`, type: 'Script' }, Buffer.from(`window.value = ${i};`))).resourceId);
  await store.stage(ids.slice(0, 20));
  await assert.rejects(store.stage([ids[20]]), /最多同时选中 20/);
  assert.equal(store.manifest.selected.length, 20);
  assert.equal(store.scenarios.active.drafts[ids[20]], undefined);
});
