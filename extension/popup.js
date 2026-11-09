import { pageKey } from './page-identity.js';
const $ = id => document.getElementById(id);
let state, busy = false, projectSignature = '', pageSignature = '', scenarioSignature = '', connected;
let pendingDelete = null;
async function send(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error || '扩展未响应');
  return result.result;
}
const keyOf = url => { try { return pageKey(url); } catch { return ''; } };
const current = () => state?.currentTab;
const tracked = () => state?.trackedTabs?.find(tab => tab.id === current()?.id);
const selected = () => state?.workspace?.selectedProjectId || null;
function projectOptions() {
  const projects = state.workspace?.projects || [], signature = JSON.stringify(projects.map(p => [p.projectId, p.name, p.error]));
  if (signature !== projectSignature) {
    projectSignature = signature; $('projects').replaceChildren(new Option('请选择项目', ''));
    for (const project of projects.filter(p => !p.error)) $('projects').add(new Option(project.name, project.projectId));
  }
  $('project-count').textContent = `· ${projects.filter(p => !p.error).length}`;
  $('projects').value = selected() || '';
}
function renderPages() {
  const pages = state.workspace?.pages || [], tab = current(), live = tracked(), key = keyOf(tab?.url);
  const saved = pages.find(page => page.key === key);
  $('page-count').textContent = `已保存 ${pages.length} 个`;
  $('page-title').textContent = tab?.title || '请打开需要接入的网页';
  $('page-url').textContent = tab?.url || '';
  $('page-state').textContent = live ? '采集中' : saved ? '已保存 · 未采集' : '未加入本项目';
  $('page-state').classList.toggle('ok', Boolean(live));
  $('capture').hidden = Boolean(live);
  $('capture').disabled = busy || !state.connected || !selected() || !tab;
  $('capture').textContent = saved ? state.active ? '继续采集当前页' : '继续协作' : state.active ? '接入当前页面' : '接入并开始协作';
  $('capture-hint').textContent = live ? '' : saved?.needsReview ? '旧版页面记录已保留，接入时确认此页所属范围。' : saved ? '' : tab ? `将当前页面加入「${state.project?.name || ''}」。首次访问会请求站点权限。` : '';
  const others = (state.workspace?.projects || []).filter(project => project.projectId !== selected() && project.savedPages?.some(page => page.key === key));
  $('shared-page').hidden = !others.length;
  $('shared-page').textContent = `也已加入${others.map(p => `「${p.name}」`).join('、')}，各项目的修改独立保存。`;
  const signature = JSON.stringify(pages.map(page => [page.key, page.url, page.title, page.needsReview, state.trackedTabs.some(tab => keyOf(tab.url) === page.key)]));
  if (signature !== pageSignature) {
    pageSignature = signature; $('pages').replaceChildren();
    for (const page of pages) {
      const item = document.createElement('li'), button = document.createElement('button'), label = document.createElement('span'), remove = document.createElement('button');
      button.className = 'link page-title'; button.textContent = page.title || page.key;
      button.addEventListener('click', () => act({ action: 'open-page', key: page.key }));
      const active = state.trackedTabs.some(tab => keyOf(tab.url) === page.key);
      label.textContent = active ? '采集中' : page.needsReview ? '待确认' : '未采集';
      label.className = active ? 'ok' : '';
      remove.className = 'link danger-link'; remove.textContent = '移出'; remove.setAttribute('aria-label', `移出${page.title || page.key}`);
      remove.addEventListener('click', () => confirmDelete({ action: 'page-remove', key: page.key }, `移出「${page.title || page.key}」？`, '仅从当前项目移出此页面并停止跟随。已采集资源、方案和其他项目里的同一页面会保留。', '确认移出'));
      item.append(button, label, remove); $('pages').append(item);
    }
  }
  $('follow-label').hidden = !state.active; $('follow').checked = state.followEnabled;
  $('follow').disabled = busy;
}
function renderScenarios() {
  const capture = state.capture, active = capture?.activeScenario, scenarios = capture?.scenarios || [];
  const signature = JSON.stringify(scenarios);
  if (signature !== scenarioSignature) {
    scenarioSignature = signature; $('scenarios').replaceChildren(new Option('请选择方案', ''));
    for (const scenario of scenarios) $('scenarios').add(new Option(scenario.name, scenario.id));
  }
  $('scenarios').value = active?.id || '';
  $('scenarios').hidden = !scenarios.length;
  $('scenarios').disabled = busy;
  $('delete-scenario').hidden = !active;
  $('delete-scenario').disabled = busy || !state.connected;
  $('show-new-scenario').disabled = busy || !state.active || !tracked();
  $('create-scenario').disabled = busy || !state.active || !tracked();
  $('scenario-hint').textContent = active ? '直接向 AI 描述调整。修改完成后由 AI 应用，可连续修改。' : state.active ? '创建或选择一套方案，再开始修改。' : '页面与方案记录会保留；接入页面后可开始修改。';
  const target = tracked();
  const applied = Boolean(target?.overridden);
  $('apply').hidden = !active || !capture?.selected?.length;
  $('apply').disabled = busy || !state.connected || !target || Boolean(target.loading);
  $('apply').textContent = applied ? '查看原页面' : '查看修改效果';
  $('apply').dataset.action = applied ? 'restore' : 'preview';
  $('preview-source').textContent = !active || !capture?.selected?.length ? '' : !target ? '请先接入当前页面，再查看这个方案的修改。' : target.loading ? '正在准备页面，采集完成后即可预览。' : applied && target.lastOutcome !== 'applied' ? '修改尚未完整生效，可以先查看原页面。' : applied ? `预览来源：${state.project?.name} / ${active.name}` : '';
}
async function render() {
  state = await send({ action: 'status' });
  $('connection-status').textContent = state.connected ? '服务已连接' : '未连接';
  if (connected !== state.connected) { $('connection-settings').open = !state.connected; connected = state.connected; }
  if (document.activeElement !== $('port')) $('port').value = state.port;
  $('connect').disabled = busy || state.active;
  $('projects').disabled = busy || !state.connected;
  $('show-new-project').disabled = busy || !state.connected;
  $('delete-project').hidden = !selected(); $('delete-project').disabled = busy || !state.connected;
  $('end').hidden = !state.active; $('end').disabled = busy;
  projectOptions();
  $('empty').hidden = Boolean(selected()); $('project-content').hidden = !selected();
  if (!selected()) return;
  renderPages(); renderScenarios();
  $('session-status').textContent = state.active ? `协作中 · 正在采集 ${state.trackedTabs.length} 个页面` : '尚未开始协作';
  $('end').hidden = !state.active; $('end').disabled = busy;
  $('capture-status').textContent = state.capture ? `${state.capture.resources} 个资源 · ${state.capture.sources} 个源码` : '尚未采集';
  $('capture-warnings').textContent = state.capture ? `${state.capture.missingSources} 个源码缺少内容 · ${state.capture.warnings} 条采集提示` : '';
  $('status').textContent = state.message;
}
function fail(error) { $('error').textContent = error.message; $('error').hidden = false; }
async function act(message) {
  if (busy) return; busy = true; $('error').hidden = true;
  try {
    const expectedProjectId = Object.hasOwn(message, 'expectedProjectId') ? message.expectedProjectId : selected();
    await send({ ...message, expectedProjectId });
    if (['project-new', 'project-use', 'project-delete'].includes(message.action)) {
      $('project-form').hidden = true; $('scenario-form').hidden = true;
      pageSignature = ''; scenarioSignature = '';
    }
  } catch (error) { fail(error); }
  finally { busy = false; await render().catch(fail); }
}
function confirmDelete(command, title, description, label = '确认删除') {
  if (busy) return;
  pendingDelete = { ...command, expectedProjectId: selected() };
  $('delete-title').textContent = title; $('delete-description').textContent = description;
  $('confirm-delete').textContent = label; $('delete-dialog').showModal();
}
$('delete-project').addEventListener('click', () => confirmDelete({ action: 'project-delete', projectId: selected() }, `删除「${state.project?.name}」项目？`, '该项目的页面记录、采集资料和所有方案会从工作区移除，并暂存到本机回收目录。若正在协作，会先结束并恢复原页面。其他项目不受影响。'));
$('delete-scenario').addEventListener('click', () => {
  const scenario = state.capture?.activeScenario; if (!scenario) return;
  confirmDelete({ action: 'scenario-delete', scenarioId: scenario.id, expectedScenarioId: scenario.id }, `删除「${scenario.name}」方案？`, '删除这套修改稿，若正在预览会先恢复原页面。其他方案、页面记录和原始资源会保留。修改稿暂存到本机回收目录。');
});
$('cancel-delete').addEventListener('click', () => $('delete-dialog').close());
$('delete-dialog').addEventListener('close', () => { pendingDelete = null; });
$('confirm-delete').addEventListener('click', async () => {
  const command = pendingDelete; if (!command || busy) return;
  $('confirm-delete').disabled = true;
  try { await act(command); }
  finally { $('confirm-delete').disabled = false; $('delete-dialog').close(); }
});
$('pair-form').addEventListener('submit', event => { event.preventDefault(); void act({ action: 'connect', port: $('port').value, token: $('token').value }).then(() => { $('token').value = ''; }); });
$('projects').addEventListener('change', () => act({ action: 'project-use', projectId: $('projects').value || null }));
$('show-new-project').addEventListener('click', () => { $('project-form').hidden = false; $('project-name').focus(); });
$('cancel-project').addEventListener('click', () => { $('project-form').hidden = true; });
$('project-form').addEventListener('submit', event => { event.preventDefault(); void act({ action: 'project-new', name: $('project-name').value }); });
$('capture').addEventListener('click', async () => {
  const tab = current(); if (!tab || busy) return;
  const projectId = selected();
  try {
    const granted = await chrome.permissions.request({ origins: [`${new URL(tab.url).origin}/*`] });
    if (!granted) throw new Error('未获得站点权限，页面未接入');
    if (selected() !== projectId) throw new Error('项目已切换，请重新确认');
    await act({ action: 'page-attach', tabId: tab.id, url: tab.url });
  } catch (error) { fail(error); }
});
$('follow').addEventListener('change', () => act({ action: 'follow', enabled: $('follow').checked }));
$('show-new-scenario').addEventListener('click', () => { $('scenario-form').hidden = false; $('scenario-name').focus(); });
$('cancel-scenario').addEventListener('click', () => { $('scenario-form').hidden = true; });
$('scenario-form').addEventListener('submit', async event => {
  event.preventDefault(); const before = state.capture?.activeScenario?.id;
  await act({ action: 'scenario-new', name: $('scenario-name').value, tabId: current()?.id, expectedScenarioId: before });
  if (state.capture?.activeScenario?.id !== before) { $('scenario-form').hidden = true; $('scenario-name').value = ''; }
});
$('scenarios').addEventListener('change', () => {
  if (!$('scenarios').value) { void render(); return; }
  void act({ action: 'scenario-use', scenarioId: $('scenarios').value, tabId: tracked()?.id, expectedScenarioId: state.capture?.activeScenario?.id });
});
$('apply').addEventListener('click', () => {
  if (busy) return;
  const action = $('apply').dataset.action;
  $('apply').disabled = true;
  $('apply').textContent = action === 'preview' ? '正在加载修改…' : '正在恢复原页面…';
  void act({ action, expectedScenarioId: state.capture?.activeScenario?.id, tabId: current()?.id, url: current()?.url });
});
$('end').addEventListener('click', () => act({ action: 'end' }));
await render().catch(fail);
if (state?.connected) { await send({ action: 'projects' }).catch(fail); await render().catch(fail); }
setInterval(() => { if (!busy) void render().catch(fail); }, 1000);
