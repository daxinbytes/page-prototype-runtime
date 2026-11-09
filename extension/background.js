import { ProjectSession, matchesProject } from './project-session.js';
let settings = { port: 17373, token: '' };
let socket;
let connected = false;
let reconnectTimer;
let heartbeat;
let workspace = null;
let serial = Promise.resolve();
const uploads = new Map();
const exclusive = (operation) => { const result = serial.then(operation); serial = result.catch(() => {}); return result; };
const session = new ProjectSession({ rpc: uploadRPC, change: publish });
session.install();
function publish() {
  const state = { ...session.status(), connected };
  if (connected && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'state', state }));
  chrome.action.setBadgeText({ text: session.pending.size ? '?' : session.active ? String(session.tabs.size) : '' });
  chrome.action.setBadgeBackgroundColor({ color: session.pending.size ? '#b35d18' : '#10786d' });
}
function uploadRPC(message) {
  if (!connected || socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('本地服务已断开'));
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { uploads.delete(id); reject(new Error('上传超时')); }, 30000);
    uploads.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ ...message, id }));
  });
}
function connect() {
  clearTimeout(reconnectTimer); clearInterval(heartbeat);
  const previous = socket; socket = undefined; previous?.close();
  if (!settings.token) return;
  const current = new WebSocket(`ws://127.0.0.1:${settings.port}/ws`); socket = current;
  current.onopen = () => current.send(JSON.stringify({ type: 'hello', token: settings.token, protocolVersion: 4 }));
  current.onmessage = async ({ data }) => {
    if (socket !== current) return;
    try {
      const message = JSON.parse(data);
      if (message.type === 'upload-ack') {
        const task = uploads.get(message.id);
        if (task) { clearTimeout(task.timer); uploads.delete(message.id); if (message.ok) task.resolve(message.result); else task.reject(new Error(message.error)); }
        return;
      }
      if (message.type === 'welcome') {
        if (message.protocolVersion < 4) throw new Error('请先更新并重启本地服务');
        session.accept(message.snapshot); session.capture = message.capture; workspace = message.workspace; connected = true;
        session.emit('已连接本地服务，请选择项目');
        heartbeat = setInterval(() => { if (current.readyState === WebSocket.OPEN) current.send(JSON.stringify({ type: 'ping' })); }, 20000);
      }
      if (message.type === 'capture-state') {
        if (message.workspace) workspace = message.workspace;
        session.capture = message.capture;
        session.binding = message.capture?.editTarget || null;
        if (message.snapshot) { session.accept(message.snapshot); session.emit(`当前方案：${message.capture?.activeScenario?.name || '未选择'}，修改稿已保存`); }
        else session.emit();
      }
      if (message.type === 'command') {
        try {
          const result = await exclusive(async () => {
            switch (message.action) {
              case 'capture': session.accept(message.snapshot); return session.start(message.captureId, message.tabId);
              case 'page-info': return session.pageInfo(message.tabId, message.expectedURL);
              case 'follow': session.followEnabled = message.enabled; session.emit(); return { enabled: session.followEnabled };
              case 'bind': return session.bind(message.tabId);
              case 'authorize-site': return session.authorizeSite(message.tabId);
              case 'join': return session.join(message.snapshot, message.captureId, message.tabId);
              case 'apply': return session.apply(message.snapshot, message.binding, message.tabId);
              case 'preview': return session.preview(message.snapshot, message.tabId, message.expectedURL);
              case 'restore': return session.restore(message.tabId);
              case 'prepare-scenario': return session.prepareScenario(message.tabId);
              case 'clear-preview': return session.clearPreview();
              case 'remove-page': return session.removePage(message.key);
              case 'end': return session.end();
              default: throw new Error('未知操作');
            }
          });
          current.send(JSON.stringify({ type: 'result', id: message.id, ok: true, result }));
        } catch (error) { current.send(JSON.stringify({ type: 'result', id: message.id, ok: false, error: error.message })); }
      }
    } catch (error) { session.emit(error.message); current.close(); }
  };
  current.onclose = (event) => {
    if (socket !== current) return;
    connected = false; clearInterval(heartbeat);
    for (const record of session.tabs.values()) record.collector.stop();
    for (const task of uploads.values()) { clearTimeout(task.timer); task.reject(new Error('本地服务已断开')); }
    uploads.clear();
    void exclusive(() => session.end(false));
    if (event.code !== 1008) reconnectTimer = setTimeout(connect, 3000);
    else session.emit('配对失败或已有其他浏览器连接');
  };
  current.onerror = () => {};
}
const ready = (async () => {
  const saved = await chrome.storage.local.get('settings'); if (saved.settings) settings = saved.settings;
  const recovery = await chrome.storage.session.get(['attachedTab', 'attachedTabs']);
  const ids = new Set([...(recovery.attachedTabs || []), recovery.attachedTab].filter(Number.isInteger));
  for (const tabId of ids) {
    await chrome.debugger.sendCommand({ tabId }, 'Fetch.disable').catch(() => {});
    await chrome.debugger.detach({ tabId }).catch(() => {});
  }
  await chrome.storage.session.remove(['attachedTab', 'attachedTabs']); connect();
})();
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  (async () => {
    await ready;
    if (message.action === 'status') {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const currentTab = tabs.find(tab => /^https?:/.test(tab.url || '')) || null;
      return { ...session.status(), connected, port: settings.port, paired: Boolean(settings.token), workspace,
        currentTab: currentTab ? { id: currentTab.id, url: currentTab.url, title: currentTab.title } : null };
    }
    if (message.action === 'projects') {
      if (!connected) return null;
      const response = await fetch(`http://127.0.0.1:${settings.port}/projects`, { headers: { Authorization: `Bearer ${settings.token}` }, signal: AbortSignal.timeout(10000) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error); workspace = result; return result;
    }
    if (message.action === 'open-page') {
      const page = workspace?.pages.find(page => page.key === message.key);
      if (!page || !/^https?:/.test(page.url)) throw new Error('页面记录不存在');
      const tabs = await chrome.tabs.query({});
      const existing = tabs.find(tab => tab.url === page.url);
      if (existing) { await chrome.tabs.update(existing.id, { active: true }); await chrome.windows.update(existing.windowId, { focused: true }); }
      else await chrome.tabs.create({ url: page.url });
      return { opened: true };
    }
    if (message.action === 'connect') {
      if (session.active) throw new Error('请先结束当前项目会话');
      const port = Number(message.port), token = message.token?.trim() || settings.token;
      if (!Number.isInteger(port) || port < 1024 || port > 65535 || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('端口或配对码无效');
      settings = { port, token }; await chrome.storage.local.set({ settings }); connected = false; connect();
      return { connecting: true };
    }
    if (['capture', 'apply', 'preview', 'restore', 'end', 'target', 'join', 'scenario-new', 'scenario-use', 'scenario-delete', 'project-new', 'project-use', 'project-delete', 'page-attach', 'page-remove', 'follow'].includes(message.action)) {
      if (!connected) throw new Error('请先连接本地服务');
      const response = await fetch(`http://127.0.0.1:${settings.port}/command`, {
        method: 'POST', headers: { Authorization: `Bearer ${settings.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: message.action, tabId: message.tabId !== undefined ? Number(message.tabId) : undefined,
          name: message.name, scenarioId: message.scenarioId, expectedScenarioId: message.expectedScenarioId, expectedProjectId: message.expectedProjectId,
          projectId: message.projectId, url: message.url, enabled: message.enabled, key: message.key }), signal: AbortSignal.timeout(75000),
      });
      const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
    }
    throw new Error('未知操作');
  })().then((result) => respond({ ok: true, result }), (error) => respond({ ok: false, error: error.message }));
  return true;
});
