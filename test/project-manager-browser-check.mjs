// Run against an isolated Chrome with --enable-unsafe-extension-debugging,
// test/project-fixture.mjs and an idle service on 17378. Never uses a personal profile.
import { WebSocket } from 'ws';
import { once } from 'node:events';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const ws = new WebSocket(process.argv[2]); await once(ws, 'open');
let seq = 0; const pending = new Map();
ws.on('message', raw => { const m = JSON.parse(raw), task = pending.get(m.id); if (!task) return; pending.delete(m.id); clearTimeout(task.timer); m.error ? task.reject(new Error(m.error.message)) : task.resolve(m.result); });
function send(method, params = {}, sessionId) {
  const id = ++seq; return new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 65000); pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params, sessionId })); });
}
async function evaluate(sessionId, expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }, sessionId);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
async function until(check, label) {
  const deadline = Date.now() + 30000; let last;
  while (Date.now() < deadline) { try { const result = await check(); if (result) return result; } catch (e) { last = e; } await new Promise(r => setTimeout(r, 100)); }
  throw new Error(`等待超时 ${label}: ${last?.message || ''}`);
}
const root = fileURLToPath(new URL('../', import.meta.url)), runtime = process.env.BRIDGE_RUNTIME_DIR;
assert.ok(runtime, 'Use an isolated BRIDGE_RUNTIME_DIR');
const token = (await readFile(`${runtime}/token`, 'utf8')).trim();
async function api(path, body) {
  const response = await fetch(`http://127.0.0.1:17378${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
}
async function tool(...args) { const { stdout } = await promisify(execFile)(process.execPath, [`${root}/cli.mjs`, ...args], { env: { ...process.env, BRIDGE_RUNTIME_DIR: runtime }, timeout: 90000 }); return JSON.parse(stdout); }
const results = [], pass = message => { results.push(message); console.log(`✓ ${message}`); };
try {
  const { extensions } = await send('Extensions.getExtensions');
  let extension = extensions.find(e => e.path === `${root.replace(/\/$/, '')}/extension`);
  if (!extension) extension = await send('Extensions.loadUnpacked', { path: `${root}extension` });
  const list = (await send('Target.getTargets')).targetInfos.find(t => t.url === 'http://127.0.0.1:17374/work/list');
  assert.ok(list);
  const main = (await send('Target.attachToTarget', { targetId: list.targetId, flatten: true })).sessionId;
  const popup = await send('Target.createTarget', { url: `chrome-extension://${extension.id}/popup.html` });
  const panel = (await send('Target.attachToTarget', { targetId: popup.targetId, flatten: true })).sessionId;
  await until(() => evaluate(panel, 'Boolean(document.getElementById("pair-form"))'), '面板加载');
  await evaluate(panel, `document.getElementById('port').value='17378';document.getElementById('token').value=${JSON.stringify(token)};document.getElementById('pair-form').requestSubmit();`);
  await until(async () => (await api('/status')).connected, '配对');
  await send('Target.activateTarget', { targetId: list.targetId });
  await until(() => evaluate(panel, '!document.getElementById("show-new-project").disabled'), '项目按钮');
  assert.equal((await api('/status')).workspace.selectedProjectId, null);
  pass('服务启动与扩展配对后保持未选项目、未采集状态');
  async function createProject(name) {
    await evaluate(panel, `document.getElementById('show-new-project').click();document.getElementById('project-name').value=${JSON.stringify(name)};document.getElementById('project-form').requestSubmit();`);
    return until(async () => { const s = await api('/status'); return s.workspace.projects.find(p => p.name === name && p.projectId === s.workspace.selectedProjectId)?.projectId; }, '新建项目');
  }
  async function attachCurrent() {
    const url = await evaluate(main, 'location.href');
    await until(() => evaluate(panel, `document.getElementById('page-url').textContent===${JSON.stringify(url)} && !document.getElementById('capture').hidden && !document.getElementById('capture').disabled`), '当前页同步与接入按钮');
    await evaluate(panel, 'document.getElementById("capture").click()');
    return until(async () => { const s = await api('/status'); return s.extension?.trackedTabs?.find(t => !t.loading); }, '采集');
  }
  async function newScenario(name) {
    await until(() => evaluate(panel, '!document.getElementById("show-new-scenario").disabled'), '方案按钮');
    await evaluate(panel, `document.getElementById('show-new-scenario').click();document.getElementById('scenario-name').value=${JSON.stringify(name)};document.getElementById('scenario-form').requestSubmit();`);
    return until(async () => { const s = (await api('/status')).capture.activeScenario; return s?.name === name && s.id; }, '新建方案');
  }
  async function selectProject(id) {
    await until(() => evaluate(panel, '!document.getElementById("projects").disabled'), '项目切换可用');
    await evaluate(panel, `document.getElementById('projects').value=${JSON.stringify(id)};document.getElementById('projects').dispatchEvent(new Event('change'));`);
    await until(async () => (await api('/status')).workspace.selectedProjectId === id, '切换项目');
    await until(() => evaluate(panel, `document.getElementById('projects').value===${JSON.stringify(id)} && !document.getElementById('projects').disabled`), '面板项目同步');
  }
  async function navigate(url) { await send('Page.navigate', { url }, main); await until(() => evaluate(main, `location.href===${JSON.stringify(url)} && Boolean(document.getElementById('value'))`), '页面导航'); }
  const a = await createProject('Project Alpha');
  assert.equal((await api('/status')).extension?.active || false, false);
  assert.equal((await api('/status')).capture.activeScenario, null);
  await evaluate(main, 'document.getElementById("memo").value="unsaved-input"');
  const loads = await evaluate(main, 'sessionStorage.loads');
  let tab = await attachCurrent();
  assert.equal(await evaluate(main, 'sessionStorage.loads'), loads);
  assert.equal(await evaluate(main, 'document.getElementById("memo").value'), 'unsaved-input');
  await until(async () => (await api('/capture')).manifest.sources.length > 0, 'source map');
  pass('面板创建项目不会采集；首次接入补采资源和 source map，保留输入且不刷新');
  const sa = await newScenario('Blue scenario');
  assert.equal(await evaluate(main, 'sessionStorage.loads'), loads);
  const ra = (await api('/capture')).manifest.resources.find(r => r.url === 'http://127.0.0.1:17374/shared.js');
  const [draftA] = (await tool('stage', '--project', a, '--scenario', sa, '--tab', String(tab.id), ra.id)).files;
  const original = await readFile(draftA.overridePath, 'utf8');
  await writeFile(draftA.overridePath, original.replace('original-v1', 'alpha-blue'));
  await tool('apply', '--project', a, '--scenario', sa);
  await until(() => evaluate(main, 'document.getElementById("value").textContent==="alpha-blue"'), '首次应用');
  await writeFile(draftA.overridePath, original.replace('original-v1', 'alpha-blue-next'));
  await tool('apply', '--project', a, '--scenario', sa);
  await until(() => evaluate(main, 'document.getElementById("value").textContent==="alpha-blue-next"'), '连续应用');
  pass('AI 命令连续修改并应用，同一方案不需要再次接入或点击预览按钮');
  await navigate('http://127.0.0.1:17376/work/preview');
  await until(async () => (await api('/status')).extension?.pendingSites?.length, '跨域范围确认');
  await attachCurrent();
  assert.equal((await api('/status')).workspace.pages.length, 2);
  pass('跨域页面首次手动加入，页面记录保存在项目中');
  await navigate('http://127.0.0.1:17374/other/compare');
  const b = await createProject('Project Beta');
  await attachCurrent();
  await navigate('http://127.0.0.1:17374/work/list');
  await attachCurrent();
  const sb = await newScenario('Green scenario');
  tab = (await api('/status')).extension.trackedTabs.find(t => t.url.endsWith('/work/list'));
  const rb = (await api('/capture')).manifest.resources.find(r => r.url === 'http://127.0.0.1:17374/shared.js');
  const [draftB] = (await tool('stage', '--project', b, '--scenario', sb, '--tab', String(tab.id), rb.id)).files;
  assert.notEqual(draftA.overridePath, draftB.overridePath);
  await writeFile(draftB.overridePath, original.replace('original-v1', 'beta-green'));
  await tool('apply', '--project', b, '--scenario', sb);
  await until(() => evaluate(main, 'document.getElementById("value").textContent==="beta-green"'), '共享页面 B 修改');
  await selectProject(a);
  assert.equal((await api('/status')).workspace.pages.length, 2);
  assert.equal((await api('/status')).extension?.active || false, false);
  assert.equal(await evaluate(main, 'document.getElementById("value").textContent'), 'original-v1');
  await until(() => evaluate(panel, 'document.querySelectorAll("#pages li").length===2'), '保存页面清单');
  pass('切回项目恢复原页，保留已加入页面清单，未自动开始协作或混用另一项目草稿');
  await evaluate(panel, `document.getElementById('scenarios').value=${JSON.stringify(sa)};document.getElementById('scenarios').dispatchEvent(new Event('change'));`);
  await until(async () => (await api('/status')).capture.activeScenario?.id === sa, '恢复方案 A');
  assert.equal((await api('/status')).capture.editTarget, null);
  await attachCurrent();
  assert.equal((await api('/status')).capture.editTarget, null);
  await until(() => evaluate(panel, '!document.getElementById("apply").disabled && document.getElementById("apply").dataset.action==="preview"'), '无旧绑定时允许预览');
  await evaluate(panel, 'document.getElementById("apply").click()');
  await until(() => evaluate(main, 'document.getElementById("value").textContent==="alpha-blue-next"'), '手动预览恢复目标');
  await until(() => evaluate(panel, '!document.getElementById("apply").disabled && document.getElementById("apply").dataset.action==="restore"'), '预览验证完成');
  pass('先选历史方案再接入页面，预览按钮可用；点击后自动核对并关联当前页');
  assert.equal(await evaluate(main, 'document.getElementById("value").textContent'), 'alpha-blue-next');
  assert.match(await readFile(draftB.overridePath, 'utf8'), /beta-green/);
  await assert.rejects(tool('apply', '--project', b, '--scenario', sb), /项目已经改变/);
  pass('同一页面在两个项目中的修改独立保留；旧项目任务无法应用到新项目');
  await navigate('http://127.0.0.1:17374/work/detail?id=1');
  await until(async () => (await api('/status')).workspace.pages.some(p => p.url.includes('id=1')), '详情页记录');
  const count = (await api('/status')).workspace.pages.length;
  await navigate('http://127.0.0.1:17374/work/detail?id=2');
  await until(async () => (await api('/status')).workspace.pages.some(p => p.url.includes('id=2')), '详情参数更新');
  assert.equal((await api('/status')).workspace.pages.length, count);
  pass('详情 id 变化继续自动跟随，不重复登记页面');
  await tool('end');
  assert.equal((await api('/status')).workspace.pages.length, count);
  assert.equal((await api('/status')).extension.active, false);
  pass('结束协作保留页面、原始采集资料及方案');
  await navigate('http://127.0.0.1:17374/work/list');
  tab = await attachCurrent();
  await tool('scenario', 'use', sa, '--tab', String(tab.id));
  await tool('apply', '--project', a, '--scenario', sa);
  await until(() => evaluate(panel, '!document.getElementById("delete-scenario").hidden'), '方案删除入口');
  await evaluate(panel, 'document.getElementById("delete-scenario").click()');
  assert.equal(await evaluate(panel, 'document.getElementById("delete-dialog").open'), true);
  await evaluate(panel, 'document.getElementById("cancel-delete").click()');
  assert.equal((await api('/status')).capture.activeScenario.id, sa);
  assert.match(await readFile(draftA.overridePath, 'utf8'), /alpha-blue-next/);
  pass('删除有明确确认，取消不会改变方案或修改稿');
  await evaluate(panel, 'document.getElementById("delete-scenario").click();document.getElementById("confirm-delete").click()');
  await until(async () => !(await api('/status')).capture.scenarios.some(s => s.id === sa), '删除方案');
  assert.equal(await evaluate(main, 'document.getElementById("value").textContent'), 'original-v1');
  assert.equal((await api('/status')).extension.active, true);
  assert.match(await readFile(draftB.overridePath, 'utf8'), /beta-green/);
  pass('删除正在预览的方案先恢复原页，采集继续，另一项目的修改稿不受影响');
  const sharedKey = 'http://127.0.0.1:17374/work/list';
  await until(() => evaluate(panel, '!document.getElementById("delete-dialog").open'), '删除确认完成');
  await evaluate(panel, `const row=[...document.querySelectorAll('#pages li')].find(li=>li.querySelector('.page-title').textContent.includes('/work/list'));row.querySelector('.danger-link').click();document.getElementById('confirm-delete').click();`);
  await until(async () => !(await api('/status')).workspace.pages.some(p => p.key === sharedKey), '移出共享页面');
  assert.equal((await api('/status')).workspace.projects.find(p => p.projectId === b).savedPages.some(p => p.key === sharedKey), true);
  assert.match(await readFile(ra.path, 'utf8'), /original-v1/);
  pass('移出共享页面仅改变当前项目，保留原始资源和另一项目的页面记录');
  await navigate('http://127.0.0.1:17376/work/preview');
  await attachCurrent();
  await navigate(sharedKey);
  await until(async () => !(await api('/status')).extension.trackedTabs.some(t => t.url === sharedKey), '移出后停止跟随');
  assert.equal((await api('/status')).workspace.pages.some(p => p.key === sharedKey), false);
  pass('再次导航到已移出的页面，不会被自动跟随重新加入');
  await selectProject(b);
  tab = await attachCurrent();
  await tool('scenario', 'use', sb, '--tab', String(tab.id));
  await tool('apply', '--project', b, '--scenario', sb);
  await until(() => evaluate(panel, '!document.getElementById("end").hidden'), '结束按钮');
  const endButton = await evaluate(panel, `(() => {const b=document.getElementById('end'),style=getComputedStyle(b);return {last:b===document.querySelector('main').lastElementChild,height:b.getBoundingClientRect().height,width:b.getBoundingClientRect().width,background:style.backgroundImage,radius:style.borderRadius};})()`);
  assert.equal(endButton.last, true); assert.equal(endButton.height, 40); assert.ok(endButton.width >= 330); assert.match(endButton.background, /linear-gradient/); assert.ok(parseFloat(endButton.radius) >= 20);
  await send('Emulation.setDeviceMetricsOverride', { width: 380, height: 600, deviceScaleFactor: 1, mobile: false }, panel);
  await evaluate(panel, 'document.getElementById("end").scrollIntoView({block:"end"})');
  await mkdir(`${root}test/artifacts`, { recursive: true });
  const deleteShot = await send('Page.captureScreenshot', { format: 'png' }, panel);
  await writeFile(`${root}test/artifacts/deletion-panel.png`, Buffer.from(deleteShot.data, 'base64'));
  pass('结束协作位于面板最后，使用 40px 珊瑚红渐变胶囊按钮');
  await evaluate(panel, 'document.getElementById("delete-project").click();document.getElementById("confirm-delete").click()');
  await until(async () => !(await api('/status')).workspace.projects.some(p => p.projectId === b), '删除项目');
  assert.equal((await api('/status')).workspace.selectedProjectId, null);
  assert.equal(await evaluate(main, 'document.getElementById("value").textContent'), 'original-v1');
  assert.equal((await api('/status')).workspace.projects.some(p => p.projectId === a), true);
  pass('删除正在协作的项目先恢复原页，再移除其数据，保留其他项目');
  await mkdir(`${root}test/artifacts`, { recursive: true });
  await writeFile(`${root}test/artifacts/manager-browser-results.json`, JSON.stringify({ testedAt: new Date().toISOString(), browser: (await send('Browser.getVersion')).product, results }, null, 2));
  const shot = await send('Page.captureScreenshot', { format: 'png' }, panel);
  await writeFile(`${root}test/artifacts/manager-panel.png`, Buffer.from(shot.data, 'base64'));
} finally { ws.close(); }
