import { matchesScope, pageKey, httpURL } from './page-identity.js';
import { createCollector } from './collector.js';
import { reloadPage } from './reload-page.js';

export function normalizeProject(value) {
  if (!value || (value.projectId === null && !value.origin)) return null;
  const sites = (value.sites || [{ origin: value.origin, pagePath: value.pagePath }]).map((site) => {
    const url = new URL(site.origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== site.origin || !site.pagePath?.startsWith('/')) throw new Error('项目站点配置无效');
    return { origin: url.origin, pagePath: site.pagePath };
  });
  if ((!sites.length && !value.managedProject) || sites.length > 30) throw new Error('项目站点数量无效');
  return { id: value.projectId || 'legacy', name: value.projectName || '页面协作', sites,
    pageRules: value.managedProject ? value.pageRules || [] : undefined, excludedPageKeys: value.excludedPageKeys || [], contextId: value.contextId };
}
export function matchesProject(project, url) {
  try { return Boolean(project && !project.excludedPageKeys?.includes(pageKey(url)) && (project.pageRules || project.sites).some(site => matchesScope(site, url))); }
  catch { return false; }
}
export function frameURL(frame) {
  try {
    const url = new URL(frame.url);
    if (typeof frame.urlFragment === 'string') url.hash = frame.urlFragment;
    return url.href;
  } catch { return frame.url || ''; }
}
const command = (tabId, method, params = {}) => chrome.debugger.sendCommand({ tabId }, method, params);

export class ProjectSession {
  constructor({ rpc, change }) {
    this.rpc = rpc; this.change = change; this.project = null; this.snapshot = null;
    this.captureId = null; this.capture = null; this.active = false;
    this.tabs = new Map(); this.members = new Set(); this.pending = new Map(); this.attaching = new Map();
    this.selectedTabId = null; this.binding = null; this.epoch = crypto.randomUUID();
    this.runId = 0;
    this.transitionTabs = new Set();
    this.recent = []; this.followEnabled = true;
    this.message = '请先连接本地服务';
  }
  accept(value) {
    const project = normalizeProject(value);
    if (!project) { this.project = null; this.snapshot = value; this.binding = null; this.capture = null; return; }
    const resources = value.resources || (value.resourceUrl ? [{ ...value, type: 'Script' }] : []);
    if (resources.length > 20) throw new Error('覆盖资源过多');
    for (const item of resources) {
      if (!project.sites.some((site) => new URL(item.resourceUrl).origin === site.origin) ||
          !['Script', 'Stylesheet'].includes(item.type) || !/^[a-f0-9]{64}$/.test(item.originalHash) ||
          typeof item.body !== 'string' || item.body.length > 28 * 1024 * 1024) throw new Error('覆盖资源无效');
    }
    this.project = project; this.snapshot = { ...value, resources };
  }
  emit(message) { if (message) this.message = message; this.change(this.status()); }
  status() {
    const target = this.tabs.get(this.binding?.tabId ?? this.selectedTabId);
    return { version: '0.8.2', capabilities: ['verified-apply', 'scenarios', 'projects', 'deletion'], contextId: this.project?.contextId, followEnabled: this.followEnabled, project: this.project, active: this.active, tabId: this.selectedTabId,
      enabled: Boolean(target?.overrides.length), observing: this.active, capturing: Boolean(target?.loading),
      capture: this.capture, binding: this.binding, message: this.message, covered: target?.covered || 0,
      lastOutcome: target?.lastOutcome || null, revision: this.snapshot?.revision,
      trackedTabs: [...this.tabs.values()].map((tab) => ({ id: tab.id, title: tab.title, url: tab.url, loading: tab.loading,
        overridden: Boolean(tab.overrides.length), covered: tab.covered, lastOutcome: tab.lastOutcome,
        revision: tab.revision, appliedURLs: [...(tab.appliedURLs || [])], outcomes: Object.fromEntries(tab.outcomes || []) })),
      pendingSites: [...this.pending.values()], recentPages: this.recent, resourceCount: this.snapshot?.resources.length || 0 };
  }
  notePage(record, reason) {
    const last = this.recent[0];
    if (last?.tabId === record.id && last.url === record.url) return;
    this.recent.unshift({ tabId: record.id, title: record.title, url: record.url, reason, time: new Date().toISOString() });
    this.recent = this.recent.slice(0, 5);
  }
  allows(url) { try { return this.project.sites.some((site) => new URL(url).origin === site.origin); } catch { return false; } }
  async choose(requested) {
    if (Number.isInteger(requested)) return requested;
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (active && this.members.has(active.id) && matchesProject(this.project, active.url)) return active.id;
    if (this.selectedTabId !== null && this.tabs.has(this.selectedTabId)) return this.selectedTabId;
    const tabs = (await chrome.tabs.query({ url: this.project.sites.map((site) => `${site.origin}/*`) })).filter((tab) => matchesProject(this.project, tab.url));
    if (tabs.length !== 1) throw new Error('请在扩展面板选择本次操作的页面');
    return tabs[0].id;
  }
  async rememberAttached() { await chrome.storage.session.set({ attachedTabs: [...this.tabs.keys()] }); }
  async detach(tabId) {
    const record = this.tabs.get(tabId);
    if (!record) return;
    this.tabs.delete(tabId); record.collector.stop();
    for (const timer of record.paused.values()) clearTimeout(timer);
    await command(tabId, 'Fetch.disable').catch(() => {});
    await command(tabId, 'Network.setCacheDisabled', { cacheDisabled: false }).catch(() => {});
    await command(tabId, 'Network.setBypassServiceWorker', { bypass: false }).catch(() => {});
    await chrome.debugger.detach({ tabId }).catch(() => {});
    await this.rememberAttached();
  }
  async follow(tabId, hintURL) {
    if (!this.active || this.transitionTabs.has(tabId)) return;
    if (this.attaching.has(tabId)) return this.attaching.get(tabId);
    const job = this.attach(tabId, hintURL).finally(() => this.attaching.delete(tabId));
    this.attaching.set(tabId, job); return job;
  }
  async attach(tabId, hintURL) {
    const runId = this.runId;
    const tab = await chrome.tabs.get(tabId);
    const url = hintURL || tab.pendingUrl || tab.url;
    if (!/^https?:/.test(url || '')) return;
    if (this.project.excludedPageKeys?.includes(pageKey(url))) {
      this.pending.delete(tabId); this.members.delete(tabId); await this.detach(tabId);
      this.emit('此页面已移出项目，可手动重新接入'); return;
    }
    if (!matchesProject(this.project, url) || !await chrome.permissions.contains({ origins: [`${new URL(url).origin}/*`] })) {
      if (!this.active || runId !== this.runId) return;
      this.pending.set(tabId, { tabId, title: tab.title || '新页面', origin: new URL(url).origin, url });
      await this.detach(tabId);
      this.emit('发现新的站点，请在面板中选择是否加入项目'); return;
    }
    this.pending.delete(tabId);
    if (!this.active || runId !== this.runId) return;
    const existing = this.tabs.get(tabId);
    if (existing) return existing;
    if (this.tabs.size >= 8) throw new Error('当前会话最多跟随 8 个标签页');
    await chrome.debugger.attach({ tabId }, '1.3');
    if (!this.active || runId !== this.runId || !matchesProject(this.project, url)) { await chrome.debugger.detach({ tabId }).catch(() => {}); return; }
    const record = { id: tabId, url, title: tab.title || url, overrides: [], covered: 0, lastOutcome: null,
      loading: true, loaderURLs: new Map(), paused: new Map() };
    record.collector = createCollector({ tabId, captureId: this.captureId,
      allows: (resource) => this.allows(resource),
      pageURL: (loaderId) => record.loaderURLs.get(loaderId) || record.url,
      isOverridden: (resource) => record.overrides.some((item) => item.resourceUrl === resource),
      command, rpc: ((contextId) => message => this.rpc({ ...message, contextId }))(this.project.contextId),
      progress: (summary) => { if (summary?.id === this.captureId) { this.capture = summary; this.emit(); } },
    });
    this.tabs.set(tabId, record); await this.rememberAttached();
    try {
      await command(tabId, 'Page.enable');
      const tree = await command(tabId, 'Page.getFrameTree');
      const frame = tree.frameTree.frame;
      const initialURL = frameURL(frame);
      if (matchesProject(this.project, initialURL)) { record.url = initialURL; record.loaderURLs.set(frame.loaderId, initialURL); }
      await command(tabId, 'Network.enable', { maxTotalBufferSize: 100 * 1024 * 1024, maxResourceBufferSize: 25 * 1024 * 1024 });
      await command(tabId, 'Debugger.enable');
      await command(tabId, 'Debugger.setSkipAllPauses', { skip: true });
      await command(tabId, 'DOM.enable');
      await command(tabId, 'CSS.enable').catch(() => {});
      if (!this.active || runId !== this.runId || !matchesProject(this.project, record.url)) { await this.detach(tabId); return; }
      await this.rpc({ type: 'asset-page', captureId: this.captureId, contextId: this.project.contextId, url: record.url, title: record.title });
      if (tab.active || this.selectedTabId === null) this.selectedTabId = tabId;
      this.notePage(record, '接入');
      this.emit(`已接入 ${record.title}，正在补充页面资源`);
      void record.collector.initialComplete().then(() => {
        if (this.tabs.get(tabId) !== record) return;
        record.loading = false; this.emit(`正在跟随 ${this.tabs.size} 个标签页`);
      }).catch((error) => { if (this.tabs.has(tabId)) this.emit(error.message); });
      return record;
    } catch (error) { await this.detach(tabId); throw error; }
  }
  async start(captureId, requested) {
    const tabId = await this.choose(requested);
    const tab = await chrome.tabs.get(tabId);
    if (!matchesProject(this.project, tab.url)) throw new Error('请选择当前项目页面');
    if (!this.active) this.recent = [];
    this.active = true; this.captureId = captureId; this.members.add(tabId); this.selectedTabId = tabId;
    const record = await this.follow(tabId);
    if (record) await record.collector.initialComplete();
    this.emit(`项目会话已开始，正在跟随 ${this.tabs.size} 个标签页`);
    return { captureId, tabId, following: this.tabs.size };
  }
  async bind(requested) {
    const tabId = await this.choose(requested);
    const tab = await chrome.tabs.get(tabId);
    const record = this.tabs.get(tabId);
    if (!this.active || !record || !matchesProject(this.project, tab.url)) throw new Error('目标页尚未接入当前项目会话');
    if (tab.pendingUrl && tab.pendingUrl !== tab.url) throw new Error('页面正在跳转，请稍后再绑定');
    this.binding = { tabId, url: tab.url, title: tab.title || record.title, epoch: this.epoch };
    this.emit(`修改目标已固定：${this.binding.title}`); return this.binding;
  }
  async apply(value, binding, requested) {
    if (value.scenarioId && value.scenarioId !== this.capture?.activeScenario?.id) throw new Error('方案状态已变化，请重新确认当前方案');
    this.accept(value);
    const fixed = binding || await this.bind(requested);
    if (fixed.epoch !== this.epoch) throw new Error('修改目标会话已过期，请重新 stage 或 target');
    if (Number.isInteger(requested) && requested !== fixed.tabId) throw new Error('当前选择与已绑定的修改目标不同');
    const tab = await chrome.tabs.get(fixed.tabId).catch(() => null);
    const record = this.tabs.get(fixed.tabId);
    if (!tab || !record || tab.url !== fixed.url || (tab.pendingUrl && tab.pendingUrl !== tab.url)) throw new Error('修改目标已关闭或已跳转，请重新绑定目标页');
    const resources = this.snapshot.resources;
    if (!resources.length) throw new Error('请先选择并编辑要覆盖的资源');
    const unknown = resources.filter((item) => !record.collector.urls.has(item.resourceUrl));
    if (unknown.length) throw new Error('部分修改资源未在目标页加载，请核对资源 ID 与目标标签页');
    await command(record.id, 'Fetch.disable').catch(() => {});
    record.overrides = resources; record.covered = 0; record.lastOutcome = null;
    record.revision = this.snapshot.revision; record.appliedURLs = new Set(); record.outcomes = new Map();
    record.overrideTargetURL = fixed.url;
    await command(record.id, 'Network.setCacheDisabled', { cacheDisabled: true });
    await command(record.id, 'Network.setBypassServiceWorker', { bypass: true });
    await command(record.id, 'Fetch.enable', { patterns: resources.map((item) => ({ urlPattern: item.resourceUrl, resourceType: item.type, requestStage: 'Response' })) });
    this.binding = fixed;
    this.emit(`正在应用到 ${fixed.title}`);
    await chrome.tabs.reload(record.id, { bypassCache: true });
    return { reloadRequested: true, tabId: record.id, revision: this.snapshot.revision, binding: fixed };
  }
  async preview(value, tabId, expectedURL) {
    if (!Number.isInteger(tabId) || typeof expectedURL !== 'string') throw new Error('请明确选择要预览的页面');
    const tab = await chrome.tabs.get(tabId).catch(() => null), record = this.tabs.get(tabId);
    if (!this.active || !tab || !record || !matchesProject(this.project, tab.url)) throw new Error('请先接入当前页面，再预览方案');
    if (tab.url !== expectedURL || (tab.pendingUrl && tab.pendingUrl !== tab.url)) throw new Error('页面已跳转，请在当前页面重新点击预览');
    if (!value.resources?.length || value.resources.some(item => !record.collector.urls.has(item.resourceUrl))) throw new Error('这个方案的部分修改资源未在当前页面加载。请回到对应页面，或让 AI 适配当前页面。');
    // Manual preview explicitly targets the page shown in the popup. Background
    // Agent apply commands still require their original, guarded binding.
    const target = { tabId, url: tab.url, title: tab.title || record.title, epoch: this.epoch };
    return this.apply(value, target, tabId);
  }
  async restore(requested) {
    const tabId = Number.isInteger(requested) ? requested : this.binding?.tabId ?? await this.choose();
    const record = this.tabs.get(tabId);
    if (!record) throw new Error('目标页面已结束跟随');
    const hadChanges = record.overrides.length > 0 || record.needsRestore;
    await command(tabId, 'Fetch.disable').catch(() => {});
    record.overrides = []; record.lastOutcome = null;
    record.appliedURLs?.clear(); record.outcomes?.clear(); record.revision = null;
    await command(tabId, 'Network.setCacheDisabled', { cacheDisabled: false }).catch(() => {});
    await command(tabId, 'Network.setBypassServiceWorker', { bypass: false }).catch(() => {});
    if (hadChanges) await chrome.tabs.reload(tabId, { bypassCache: true });
    this.emit('修改已恢复，项目采集继续运行'); return { restored: true, tabId };
  }
  async prepareScenario(requested) {
    if (!this.active) throw new Error('请先开始项目协作，再新建或切换方案');
    const tabId = await this.choose(requested);
    if (!this.tabs.has(tabId)) throw new Error('请先接入所选页面');
    const ids = [...this.tabs.values()].filter((record) => record.overrides.length || record.needsRestore).map((record) => record.id);
    this.binding = null; this.epoch = crypto.randomUUID();
    for (const id of ids) this.transitionTabs.add(id);
    this.emit('正在恢复原始页面，原方案修改稿已保留');
    const outcomes = await Promise.allSettled(ids.map(async (id) => {
      await this.detach(id);
      await reloadPage(id);
      this.transitionTabs.delete(id);
      const record = await this.follow(id);
      if (!record) throw new Error('页面已跳到项目范围之外，请先接入后重试');
      await record.collector.initialComplete();
    }));
    for (const id of ids) this.transitionTabs.delete(id);
    const failed = outcomes.find((result) => result.status === 'rejected');
    if (failed) { this.emit('页面恢复未完成，方案尚未切换'); throw failed.reason; }
    this.selectedTabId = tabId;
    const target = await this.bind(tabId);
    this.emit('原始页面 已恢复，正在准备方案');
    return { target, refreshedTabs: ids };
  }
  async clearPreview() {
    const ids = [...this.tabs.values()].filter(record => record.overrides.length || record.needsRestore).map(record => record.id);
    this.binding = null; this.epoch = crypto.randomUUID();
    for (const id of ids) this.transitionTabs.add(id);
    try {
      for (const id of ids) {
        await this.detach(id); await reloadPage(id);
        this.transitionTabs.delete(id);
        if (this.active) { const record = await this.follow(id); if (record) await record.collector.initialComplete(); }
      }
    } finally { for (const id of ids) this.transitionTabs.delete(id); }
    this.emit('修改已停用，原页面已恢复'); return { restored: true, refreshedTabs: ids };
  }
  async removePage(key) {
    this.project.excludedPageKeys = [...new Set([...(this.project.excludedPageKeys || []), key])];
    const records = [...this.tabs.values()].filter(record => pageKey(record.url) === key);
    for (const record of records) {
      const changed = record.overrides.length || record.needsRestore;
      this.members.delete(record.id);
      await this.detach(record.id);
      if (changed) await reloadPage(record.id);
    }
    for (const [id, page] of this.pending) if (pageKey(page.url) === key) { this.pending.delete(id); this.members.delete(id); }
    if (this.binding && pageKey(this.binding.url) === key) this.binding = null;
    if (!this.tabs.has(this.selectedTabId)) this.selectedTabId = this.tabs.keys().next().value ?? null;
    if (!this.tabs.size && !this.attaching.size) { this.active = false; this.members.clear(); this.pending.clear(); }
    this.emit('页面已停止跟随，其他页面和方案保留'); return { removedTabs: records.map(record => record.id) };
  }
  async end(reload = true) {
    this.active = false; this.runId++;
    let settleTimer;
    await Promise.race([Promise.allSettled([...this.attaching.values()]), new Promise((resolve) => { settleTimer = setTimeout(resolve, 3000); })]);
    clearTimeout(settleTimer);
    const records = [...this.tabs.values()];
    for (const record of records) {
      const hadChanges = record.overrides.length > 0 || record.needsRestore;
      await this.detach(record.id);
      if (reload && hadChanges) await reloadPage(record.id);
    }
    this.members.clear(); this.pending.clear(); this.selectedTabId = null; this.binding = null; this.epoch = crypto.randomUUID();
    this.emit(reload ? '项目会话已结束，资料和修改稿已保留' : '连接已断开，已停止跟随；刷新可恢复原页面');
    return { ended: true };
  }
  async pageInfo(requested, expectedURL) {
    const tabId = Number.isInteger(requested) ? requested : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id;
    if (!Number.isInteger(tabId)) throw new Error('请打开需要接入的网页');
    const tab = await chrome.tabs.get(tabId), url = httpURL(tab.url);
    if (expectedURL && url.href !== expectedURL) throw new Error('页面已跳转，请重新确认后接入');
    if (!await chrome.permissions.contains({ origins: [`${url.origin}/*`] })) throw new Error('请在扩展中授权该站点后接入');
    return { tabId, url: url.href, title: tab.title || url.href };
  }
  async authorizeSite(tabId) {
    const pending = this.pending.get(tabId);
    if (!this.active || !pending || !this.members.has(tabId)) throw new Error('该页面没有来自当前会话的导航关系');
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url || new URL(tab.url).origin !== pending.origin) throw new Error('页面地址已变化，请重新打开面板');
    if (!await chrome.permissions.contains({ origins: [`${pending.origin}/*`] })) throw new Error('需要先在面板中授权该站点');
    return { origin: pending.origin, pagePath: '/' };
  }
  async join(value, captureId, tabId) {
    this.accept(value); this.captureId = captureId;
    const record = await this.follow(tabId);
    if (record) await record.collector.initialComplete();
    this.emit('新站点已加入项目，后续将自动跟随'); return { joined: true, tabId };
  }
  navigation(tabId, url, title) {
    if (!this.active || !this.members.has(tabId) || this.transitionTabs.has(tabId)) return;
    const record = this.tabs.get(tabId);
    if (!this.followEnabled && (!record || pageKey(record.url) !== pageKey(url))) {
      if (record?.overrides.length) this.stopCoverForNavigation(record);
      void this.detach(tabId); this.emit('自动跟随已关闭，可手动接入当前页面'); return;
    }
    if (record?.overrides.length && url !== record.overrideTargetURL) this.stopCoverForNavigation(record);
    if (record && url) {
      const changed = record.url !== url;
      record.url = url; record.title = title || record.title;
      if (changed && matchesProject(this.project, url)) {
        this.notePage(record, '自动跟随');
        void this.rpc({ type: 'asset-page', captureId: this.captureId, contextId: this.project.contextId, url, title: record.title }).catch(error => this.emit(error.message));
        this.emit(`已自动跟随到 ${new URL(url).host}`);
      }
    }
    void this.follow(tabId, url).catch((error) => this.emit(error.message));
  }
  stopCoverForNavigation(record) {
    record.overrides = []; record.lastOutcome = null;
    record.appliedURLs?.clear(); record.outcomes?.clear(); record.revision = null;
    void command(record.id, 'Fetch.disable').catch(() => {});
    this.emit('目标页已跳转，后续覆盖已停止；已载入的修改可刷新恢复');
  }
  child(sourceTabId, tabId, url) {
    if (!this.active || !this.followEnabled || !this.members.has(sourceTabId)) return;
    this.members.add(tabId);
    void this.follow(tabId, url).catch((error) => this.emit(error.message));
  }
  async paused(source, request) {
    const record = this.tabs.get(source.tabId);
    if (!record) { await command(source.tabId, 'Fetch.continueRequest', { requestId: request.requestId }).catch(() => {}); return; }
    const resource = record.overrides.find((item) => item.resourceUrl === request.request.url);
    let done = false;
    const finish = async (method, params = {}) => {
      if (done) return false; done = true;
      clearTimeout(record.paused.get(request.requestId)); record.paused.delete(request.requestId);
      try { await command(record.id, method, { requestId: request.requestId, ...params }); return true; }
      catch { if (method !== 'Fetch.continueRequest') await command(record.id, 'Fetch.continueRequest', { requestId: request.requestId }).catch(() => {}); return false; }
    };
    record.paused.set(request.requestId, setTimeout(() => { record.lastOutcome = 'timeout'; record.outcomes?.set(request.request.url, 'timeout'); void finish('Fetch.continueRequest'); this.emit('覆盖校验超时，已保留原响应'); }, 3000));
    try {
      if (!resource || request.responseStatusCode !== 200) {
        if (resource) { record.lastOutcome = 'error'; record.outcomes?.set(request.request.url, 'error'); this.emit(`资源响应状态为 ${request.responseStatusCode || '失败'}，已保留原响应`); }
        await finish('Fetch.continueRequest'); return;
      }
      const raw = await command(record.id, 'Fetch.getResponseBody', { requestId: request.requestId });
      const bytes = raw.base64Encoded ? Uint8Array.from(atob(raw.body), (char) => char.charCodeAt(0)) : new TextEncoder().encode(raw.body);
      const header = (request.responseHeaders || []).find((item) => item.name.toLowerCase() === 'sourcemap')?.value;
      record.collector.original(resource.resourceUrl, resource.type, bytes, header);
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
      if (done || this.tabs.get(record.id) !== record || !record.overrides.includes(resource)) { await finish('Fetch.continueRequest'); return; }
      if (hash !== resource.originalHash) {
        await finish('Fetch.continueRequest'); record.lastOutcome = 'mismatch'; record.outcomes?.set(resource.resourceUrl, 'mismatch'); this.emit('资源已发布新版本，保留原页面，请基于新版本修改'); return;
      }
      const removed = new Set(['content-length', 'content-encoding', 'transfer-encoding', 'etag', 'last-modified', 'cache-control', 'expires', 'content-type']);
      const headers = (request.responseHeaders || []).filter((header) => !removed.has(header.name.toLowerCase()));
      headers.push({ name: 'Content-Type', value: resource.type === 'Stylesheet' ? 'text/css; charset=utf-8' : 'application/javascript; charset=utf-8' }, { name: 'Cache-Control', value: 'no-store' });
      if (await finish('Fetch.fulfillRequest', { responseCode: 200, responseHeaders: headers, body: resource.body })) {
        record.needsRestore = true; record.covered++; record.lastOutcome = 'applied'; record.appliedURLs?.add(resource.resourceUrl); record.outcomes?.set(resource.resourceUrl, 'applied'); this.emit(`已应用到 ${record.title} · 第 ${record.revision} 版`);
      }
    } catch (error) { await finish('Fetch.continueRequest'); record.lastOutcome = 'error'; record.outcomes?.set(request.request.url, 'error'); this.emit(`已保留原响应：${error.message}`); }
  }
  install() {
    chrome.debugger.onEvent.addListener((source, method, params) => {
      const record = this.tabs.get(source.tabId);
      if (method === 'Fetch.requestPaused') { void this.paused(source, params); return; }
      if (!record) return;
      if (method === 'Page.frameNavigated' && !params.frame.parentId) {
        record.collector.newDocument();
        record.needsRestore = false;
        record.appliedURLs?.clear(); record.outcomes?.clear();
        const url = frameURL(params.frame);
        record.loaderURLs.set(params.frame.loaderId, url);
        if (record.loaderURLs.size > 20) record.loaderURLs.delete(record.loaderURLs.keys().next().value);
        this.navigation(record.id, url);
      }
      if (matchesProject(this.project, record.url)) record.collector.onEvent(method, params);
    });
    chrome.debugger.onDetach.addListener(({ tabId }) => {
      const record = this.tabs.get(tabId);
      if (!record) return;
      record.collector.stop(); for (const timer of record.paused.values()) clearTimeout(timer);
      this.tabs.delete(tabId); this.members.delete(tabId);
      void this.rememberAttached(); this.emit('一个页面结束了调试连接，可选择该页重新接入');
    });
    chrome.webNavigation.onBeforeNavigate.addListener(({ tabId, frameId, url }) => {
      if (frameId !== 0 || !this.members.has(tabId)) return;
      const record = this.tabs.get(tabId);
      if (record?.overrides.length && url !== record.overrideTargetURL) this.stopCoverForNavigation(record);
      if (!matchesProject(this.project, url)) this.navigation(tabId, url);
    });
    chrome.webNavigation.onCommitted.addListener(({ tabId, frameId, url }) => { if (frameId === 0) this.navigation(tabId, url); });
    chrome.webNavigation.onHistoryStateUpdated.addListener(({ tabId, frameId, url }) => { if (frameId === 0) this.navigation(tabId, url); });
    chrome.webNavigation.onReferenceFragmentUpdated.addListener(({ tabId, frameId, url }) => { if (frameId === 0) this.navigation(tabId, url); });
    chrome.webNavigation.onCreatedNavigationTarget.addListener(({ sourceTabId, tabId, url }) => this.child(sourceTabId, tabId, url));
    chrome.tabs.onCreated.addListener((tab) => { if (tab.openerTabId !== undefined) this.child(tab.openerTabId, tab.id, tab.pendingUrl || tab.url); });
    chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
      if (change.url) this.navigation(tabId, change.url, tab.title);
      const record = this.tabs.get(tabId); if (record && change.title) { record.title = change.title; this.emit(); }
    });
    chrome.tabs.onActivated.addListener(({ tabId }) => {
      if (this.tabs.has(tabId)) { this.selectedTabId = tabId; this.emit(); }
    });
    chrome.tabs.onRemoved.addListener((tabId) => {
      this.members.delete(tabId); this.pending.delete(tabId); void this.detach(tabId);
      if (this.selectedTabId === tabId) this.selectedTabId = null;
      if (this.binding?.tabId === tabId) this.emit('本次修改目标已关闭，请重新绑定目标'); else this.emit();
    });
  }
}
