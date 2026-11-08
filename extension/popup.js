const $ = (id) => document.getElementById(id);
let busy = false;
let wasConnected = null;
let lastTabs = '';
let lastPending = '';
let lastHistory = '';
let lastScenarios = '', lastActiveScenario;
let state;
function renderScenarios() {
  const active = state.capture?.activeScenario;
  const scenarios = state.capture?.scenarios || [];
  $('current-scenario').textContent = active ? `当前方案：${active.name} · ${active.draftCount} 份稿件` : '连接新版服务后显示修改方案';
  const key = JSON.stringify(scenarios);
  if (key !== lastScenarios) {
    lastScenarios = key; const selected = $('scenarios').value;
    $('scenarios').replaceChildren();
    for (const item of scenarios) $('scenarios').add(new Option(`${item.name}${item.active ? ' · 当前' : ''}`, item.id));
    $('scenarios').value = lastActiveScenario !== active?.id ? active?.id || '' : scenarios.some((item) => item.id === selected) ? selected : active?.id || '';
    lastActiveScenario = active?.id;
  }
  const canManage = !busy && state.connected && state.active && active && $('tabs').value;
  $('create-scenario').disabled = !canManage;
  const same = $('scenarios').value === active?.id;
  $('switch-scenario').textContent = same ? '继续' : '切换';
  $('switch-scenario').disabled = !canManage || !$('scenarios').value || (same && state.binding?.tabId === Number($('tabs').value));
  $('scenarios').disabled = busy || !scenarios.length;
}
function readableURL(value) {
  try { const url = new URL(value); return `${url.host}${url.pathname}${url.search}${url.hash}`; }
  catch { return value; }
}
function renderFollowing() {
  const current = state.trackedTabs.find((tab) => tab.id === state.tabId);
  $('current-page').hidden = !current;
  $('current-page').textContent = current ? `当前跟随：${readableURL(current.url)}` : '';
  const recent = state.recentPages || [];
  $('follow-history').hidden = !recent.length;
  const key = JSON.stringify(recent);
  if (key === lastHistory) return;
  lastHistory = key; $('follow-events').replaceChildren();
  for (const item of recent) {
    const row = document.createElement('li');
    const label = document.createElement('span');
    const time = new Date(item.time).toLocaleTimeString('zh-CN', { hour12: false });
    label.textContent = `${time} · ${item.reason}`;
    const address = document.createElement('span'); address.textContent = readableURL(item.url);
    row.append(label, address); $('follow-events').append(row);
  }
  const latest = recent[0];
  $('follow-summary').textContent = latest ? `最近跟随记录 · ${new Date(latest.time).toLocaleTimeString('zh-CN', { hour12: false })}` : '最近跟随记录';
}
async function send(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error || '扩展后台未响应');
  return result.result;
}
async function render() {
  state = await send({ action: 'status' });
  $('status').textContent = state.message;
  $('project-name').textContent = state.project?.name || '尚未连接项目';
  $('project-permissions').hidden = !state.missingOrigins?.length;
  $('permission-hint').textContent = `允许采集这些项目站点：${(state.missingOrigins || []).join('、')}`;
  if (wasConnected !== state.connected) { $('connection-settings').open = !state.connected; wasConnected = state.connected; }
  $('service-step').classList.toggle('ready', state.connected);
  $('page-step').classList.toggle('ready', state.active);
  $('override-step').classList.toggle('ready', state.enabled && state.lastOutcome === 'applied');
  if (document.activeElement !== $('port')) $('port').value = state.port;
  $('pair-hint').textContent = state.paired ? '配对码已保存，可留空复用。' : '先启动本地工具，再输入配对码。';
  const signature = JSON.stringify({ tabs: state.tabs, current: state.tabId });
  if (signature !== lastTabs) {
    lastTabs = signature; const selected = $('tabs').value; $('tabs').replaceChildren();
    if (!state.tabs.length) $('tabs').add(new Option('请打开一个项目页面', ''));
    for (const tab of state.tabs) $('tabs').add(new Option(tab.title || tab.url, String(tab.id)));
    const active = state.tabs.find((tab) => tab.active);
    if (active) $('tabs').value = String(active.id);
    else if (state.tabId && state.tabs.some((tab) => tab.id === state.tabId)) $('tabs').value = String(state.tabId);
    else if (state.tabs.some((tab) => String(tab.id) === selected)) $('tabs').value = selected;
  }
  $('page-hint').textContent = state.active ? `已跟随 ${state.trackedTabs.length} 个标签页，项目内跳转将自动接入。` : '选择起始页面，开始一次项目协作。';
  renderFollowing();
  $('capture').disabled = busy || !state.connected || !$('tabs').value;
  $('capture').textContent = state.active ? '接入所选页面' : '开始项目协作';
  $('capture-status').textContent = state.capture ? `${state.capture.resources} 个资源 · ${state.capture.sources} 个源码 · ${state.capture.reusedResources || 0} 次跨地址复用` : '已加载的资源也会补充采集，不自动刷新表单。';
  const warnings = state.capture?.warnings || 0, missing = state.capture?.missingSources || 0;
  $('capture-warnings').hidden = !warnings && !missing;
  $('capture-warnings').textContent = `${missing} 个源码缺少内容，${warnings} 条采集提示；可让 AI 查看详情。`;
  renderScenarios();
  $('edit-target').textContent = state.binding ? `本次修改目标：${state.binding.title}` : '本次修改目标：AI 选取资源时绑定';
  $('apply').disabled = busy || !state.connected || !state.binding || !state.capture?.selected?.length;
  $('restore').disabled = busy || !state.active;
  $('end').disabled = busy || !state.active;
  $('connect').disabled = busy || state.active;
  const pendingKey = JSON.stringify(state.pendingSites);
  if (pendingKey !== lastPending) {
    lastPending = pendingKey; $('pending-sites').replaceChildren();
    for (const item of state.pendingSites) {
      const box = document.createElement('div'); box.className = 'pending-site';
      const label = document.createElement('p'); label.textContent = `新站点：${item.origin}`;
      const button = document.createElement('button'); button.className = 'secondary'; button.textContent = '加入当前项目';
      button.addEventListener('click', async () => {
        try {
          const granted = await chrome.permissions.request({ origins: [`${item.origin}/*`] });
          if (!granted) throw new Error('站点访问未授权，暂不接入该页面');
          await act({ action: 'join', tabId: item.tabId });
        } catch (error) { $('error').textContent = error.message; $('error').hidden = false; }
      });
      box.append(label, button); $('pending-sites').append(box);
    }
  }
}
async function act(message) {
  if (busy) return; busy = true; $('error').hidden = true;
  try { await render(); await send(message); }
  catch (error) { $('error').textContent = error.message; $('error').hidden = false; }
  finally { busy = false; await render(); }
}
$('pair-form').addEventListener('submit', async (event) => {
  event.preventDefault(); await act({ action: 'connect', port: $('port').value, token: $('token').value }); $('token').value = '';
});
$('authorize-project').addEventListener('click', async () => {
  try {
    const origins = (state.missingOrigins || []).map((origin) => `${origin}/*`);
    if (origins.length && !await chrome.permissions.request({ origins })) throw new Error('尚未获得项目站点授权');
    $('error').hidden = true; await render();
  } catch (error) { $('error').textContent = error.message; $('error').hidden = false; }
});
$('capture').addEventListener('click', () => act({ action: 'capture', tabId: $('tabs').value }));
$('apply').addEventListener('click', () => act({ action: 'apply', expectedScenarioId: state.capture?.activeScenario?.id }));
$('scenarios').addEventListener('change', renderScenarios);
$('switch-scenario').addEventListener('click', () => act({ action: 'scenario-use', scenarioId: $('scenarios').value,
  expectedScenarioId: state.capture?.activeScenario?.id, tabId: $('tabs').value }));
$('scenario-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const previous = state.capture?.activeScenario?.id;
  await act({ action: 'scenario-new', name: $('scenario-name').value, expectedScenarioId: previous, tabId: $('tabs').value });
  if (state.capture?.activeScenario?.id !== previous) { $('scenario-name').value = ''; $('new-scenario').open = false; }
});
$('restore').addEventListener('click', () => act({ action: 'restore', tabId: state.binding?.tabId || $('tabs').value }));
$('end').addEventListener('click', () => act({ action: 'end' }));
$('tabs').addEventListener('change', () => { $('capture').disabled = busy || !state.connected || !$('tabs').value; renderScenarios(); });
render().catch((error) => { $('status').textContent = error.message; });
setInterval(() => render().catch(() => {}), 1000);
