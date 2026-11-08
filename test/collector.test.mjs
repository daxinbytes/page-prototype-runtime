import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollector } from '../extension/collector.js';

test('late attachment reads external scripts but never treats inline page scripts as response overrides', async () => {
  const readIds = [];
  const uploads = [];
  let finished;
  const done = new Promise((resolve) => { finished = resolve; });
  const collector = createCollector({ tabId: 1, captureId: 'test', origin: 'https://a.test',
    command: async (tabId, method, params) => { readIds.push(params.scriptId); return { scriptSource: 'window.a = 1;' }; },
    rpc: async (message) => { uploads.push(message); return { found: true, neededMaps: [], capture: {} }; },
    progress: () => finished(),
  });
  collector.onEvent('Debugger.scriptParsed', { scriptId: 'inline', url: 'https://a.test/work/form', startLine: 8, startColumn: 14 });
  collector.onEvent('Debugger.scriptParsed', { scriptId: 'external', url: 'https://a.test/app.js', startLine: 0, startColumn: 0 });
  await done;
  assert.deepEqual(readIds, ['external']);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].metadata.url, 'https://a.test/app.js');
  collector.stop();
});
