import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CaptureStore } from '../lib/captures.mjs';
import { inspectJavaScript, decodeInlineMap, mapSources } from '../lib/source-maps.mjs';

const map = (sources = ['src/Button.vue'], sourcesContent = ['<template>搜索</template>']) => ({ version: 3, sources, sourcesContent, names: [], mappings: '' });
const inline = (value) => `data:application/json;base64,${Buffer.from(JSON.stringify(value)).toString('base64')}`;
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'capture-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new CaptureStore(root, { origin: 'https://beta.test', pagePath: '/app' });
  const captureId = await store.begin();
  return { store, captureId, add: (url, bytes, type = 'Script', extra = {}) => store.ingest({ captureId, url: `https://beta.test/${url}`, type, ...extra }, Buffer.from(bytes)) };
}

test('extracts 42 synthetic eval maps without executing downloaded code', () => {
  const source = `throw new Error('downloaded code must not execute');\n` + Array.from({ length: 42 }, (_, i) => `eval(${JSON.stringify(`window.sample = ${i};\n//# sourceMappingURL=${inline(map([`src/Button${i}.vue`], ['<template>Preview</template>']))}`)});`).join('\n');
  const result = inspectJavaScript(source);
  assert.equal(result.references.length, 42);
  assert.equal(result.warnings.length, 0);
  const sources = result.references.flatMap(({ ref }) => mapSources(decodeInlineMap(ref)));
  assert.ok(sources.some((source) => source.label.includes('Button0.vue') && source.content.includes('Preview')));
});

test('map discovery ignores annotations in ordinary strings, supports eval literals and header precedence', () => {
  const fake = JSON.stringify('//# sourceMappingURL=fake.map');
  const evalCode = JSON.stringify(`window.x = 1;\n//# sourceMappingURL=${inline(map())}`);
  const result = inspectJavaScript(`const decoy = ${fake}; eval(${evalCode});\n//# sourceMappingURL=outer.map`, { header: 'header.map' });
  assert.equal(result.references.length, 2);
  assert.equal(result.references[0].ref, 'header.map');
  assert.ok(result.references[1].ref.startsWith('data:'));
  assert.throws(() => inspectJavaScript('eval("function {")', { validate: true }), /语法错误/);
});

test('external and missing-content maps produce a versioned, traversal-safe source index', async (t) => {
  const { store, captureId, add } = await setup(t);
  const captured = await add('app.js', 'window.test = 1;\n//# sourceMappingURL=app.js.map');
  assert.equal(captured.neededMaps[0].url, 'https://beta.test/app.js.map');
  await store.ingest({ captureId, kind: 'map', url: captured.neededMaps[0].url, resourceId: captured.resourceId },
    Buffer.from(JSON.stringify(map(['../../../../escape.vue', 'src/Empty.vue'], ['source content', null]))));
  assert.equal(store.manifest.sources.length, 2);
  assert.ok(store.manifest.sources[0].path.startsWith(store.directory));
  assert.equal(store.manifest.sources[1].path, null);
  assert.equal(store.manifest.maps[0].status, 'missing_sourcesContent');
  const restored = new CaptureStore(store.root, store.config); await restored.load();
  assert.equal(restored.summary().missingSources, 1);
});

test('indexed and percent-encoded maps are decoded; duplicate source names retain distinct contents', async (t) => {
  const { store, add } = await setup(t);
  const nested = { version: 3, sections: [
    { offset: { line: 0, column: 0 }, map: map(['src/Button.vue'], ['one']) },
    { offset: { line: 1, column: 0 }, map: map(['src/Button.vue'], ['two']) },
  ] };
  const ref = `data:application/json,${encodeURIComponent(JSON.stringify(nested))}`;
  await add('style.css', `button{color:red}/*# sourceMappingURL=${ref} */`, 'Stylesheet');
  assert.equal(store.manifest.sources.length, 2);
  assert.notEqual(store.manifest.sources[0].path, store.manifest.sources[1].path);
});

test('staging preserves edits, supports JS + CSS, rejects modified originals and invalid inner eval', async (t) => {
  const { store, add } = await setup(t);
  const js = await add('app.js', 'eval("window.flag=1");');
  const css = await add('app.css', 'button{color:red}', 'Stylesheet');
  const staged = await store.stage([js.resourceId, css.resourceId]);
  await writeFile(staged[0].overridePath, 'eval("window.flag=2");');
  await store.stage([js.resourceId]);
  assert.match(await readFile(staged[0].overridePath, 'utf8'), /flag=2/);
  const result = await store.snapshot(2); assert.equal(result.resources.length, 2);
  assert.equal(result.resources[1].type, 'Stylesheet');
  await writeFile(staged[0].overridePath, 'eval("function {");');
  await assert.rejects(store.snapshot(3), /语法错误/);
  await writeFile(store.manifest.resources[0].path, 'tampered');
  await assert.rejects(store.snapshot(3), /原始快照/);
});

test('expired captures, cross-origin assets, unreferenced maps and unknown resource IDs are rejected', async (t) => {
  const { store, captureId } = await setup(t);
  await assert.rejects(store.ingest({ captureId: 'old', url: 'https://beta.test/app.js' }, Buffer.from('x')), /过期/);
  await assert.rejects(store.ingest({ captureId, url: 'https://evil.test/app.js' }, Buffer.from('x')), /站点/);
  await assert.rejects(store.ingest({ captureId, kind: 'map', url: 'https://beta.test/app.map', resourceId: 'unknown' }, Buffer.from('{}')), /引用/);
  await assert.rejects(store.stage(['unknown']), /不存在/);
});
