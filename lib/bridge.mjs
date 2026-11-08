import { createServer } from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { readSnapshot, publicSnapshot, projectInfo } from './workspace.mjs';
import { CaptureStore } from './captures.mjs';
import { dirname, resolve } from 'node:path';

const sameSecret = (a, b) => {
  const left = Buffer.from(a || '');
  const right = Buffer.from(b || '');
  return left.length === right.length && timingSafeEqual(left, right);
};

export async function createBridge({ config, token, captureRoot, onShutdown = () => {} }) {
  const captures = new CaptureStore(captureRoot || resolve(config.directory || dirname(config.originalFile), 'captures'), config);
  await captures.load();
  let snapshot = config.projectId ? { ...projectInfo(config), revision: 1, resources: [], scenarioId: captures.manifest.activeScenarioId }
    : await captures.snapshot(1) || await readSnapshot(config, 1);
  let peer = null;
  let peerProtocol = 1;
  let extensionState = null;
  let busy = false;
  let lastSeen = null;
  const pending = new Map();
  const sockets = new Set();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });

  const status = () => ({
    connected: peer?.readyState === WebSocket.OPEN,
    resource: publicSnapshot(snapshot), extension: extensionState, lastSeen, capture: captures.summary(), protocolVersion: 3,
  });
  const send = (socket, message) => socket.send(JSON.stringify(message));
  const publishCapture = (nextSnapshot) => {
    if (peer?.readyState === WebSocket.OPEN) send(peer, { type: 'capture-state', capture: captures.summary(), snapshot: nextSnapshot });
  };
  const reply = (response, code, data) => {
    response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(data));
  };
  function askExtension(action, nextSnapshot, parameters = {}) {
    if (peer?.readyState !== WebSocket.OPEN) throw new Error('扩展未连接，请先完成配对');
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('扩展响应超时，请检查浏览器状态'));
      }, ['capture', 'join', 'prepare-scenario'].includes(action) ? 65000 : 15000);
      pending.set(id, { resolve, reject, timer });
      send(peer, { type: 'command', id, action, snapshot: nextSnapshot, ...parameters });
    });
  }

  const server = createServer(async (request, response) => {
    // Browser pages cannot call the control API, even if they discover the port.
    if ((request.headers.origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(request.headers.origin)) ||
        request.headers.host !== `127.0.0.1:${server.address().port}`) {
      reply(response, 403, { error: '不允许此来源' }); return;
    }
    if (request.url === '/health' && request.method === 'GET') {
      reply(response, 200, { service: 'page-prototype-bridge', version: 3 }); return;
    }
    if (!sameSecret(request.headers.authorization, `Bearer ${token}`)) {
      reply(response, 401, { error: '需要配对凭据' }); return;
    }
    try {
      if (request.url === '/status' && request.method === 'GET') {
        reply(response, 200, status()); return;
      }
      if (request.url === '/capture' && request.method === 'GET') {
        reply(response, 200, { directory: captures.directory, manifest: captures.manifest }); return;
      }
      if (request.url === '/scenarios' && request.method === 'GET') {
        reply(response, 200, { active: captures.scenarios.summary(), scenarios: captures.scenarios.list() }); return;
      }
      if (request.url === '/shutdown' && request.method === 'POST') {
        reply(response, 200, { stopping: true });
        setImmediate(onShutdown); return;
      }
      if (request.url === '/command' && request.method === 'POST') {
        let body = '';
        for await (const chunk of request) {
          body += chunk;
          if (body.length > 4096) { reply(response, 413, { error: '请求过大' }); return; }
        }
        const { action, tabId, resourceIds, name, scenarioId, expectedScenarioId } = JSON.parse(body);
        if (!['apply', 'restore', 'capture', 'stage', 'end', 'join', 'target', 'scenario-new', 'scenario-use', 'scenario-rename'].includes(action)) { reply(response, 400, { error: '未知操作' }); return; }
        if (busy) { reply(response, 409, { error: '上一操作尚未完成' }); return; }
        busy = true;
        try {
          if (expectedScenarioId !== undefined && expectedScenarioId !== captures.manifest?.activeScenarioId) throw new Error('当前方案已经改变，请重新核对方案后操作');
          if (action.startsWith('scenario-')) {
            if (!config.projectId) throw new Error('请使用项目配置后再管理方案');
            if (action === 'scenario-rename') {
              const scenario = await captures.run(() => captures.scenarios.rename(scenarioId, name)); publishCapture();
              reply(response, 200, { scenario, capture: captures.summary() }); return;
            }
            if (action === 'scenario-new') captures.scenarios.validateNew(name);
            else {
              captures.scenarios.find(scenarioId);
              if (scenarioId === captures.manifest.activeScenarioId) {
                const target = await askExtension('bind', undefined, { tabId });
                await captures.run(() => captures.scenarios.use(scenarioId, target)); publishCapture();
                reply(response, 200, { continued: true, target, capture: captures.summary() }); return;
              }
            }
            if (!extensionState?.capabilities?.includes('scenarios')) throw new Error('请重新加载 0.5 或更新版本的扩展，并开始项目协作');
            await captures.run(async () => { captures.manifest.editTarget = null; await captures.save(); }); publishCapture();
            const prepared = await askExtension('prepare-scenario', undefined, { tabId });
            const scenario = await captures.run(() => action === 'scenario-new' ? captures.scenarios.create(name, prepared.target) : captures.scenarios.use(scenarioId, prepared.target));
            snapshot = { ...projectInfo(config), revision: snapshot.revision + 1, resources: [], scenarioId: scenario.id };
            publishCapture(snapshot);
            reply(response, 200, { scenario, refreshedTabs: prepared.refreshedTabs, target: prepared.target, capture: captures.summary() }); return;
          }
          if (action === 'stage') {
            const target = config.projectId ? await askExtension('bind', undefined, { tabId }) : undefined;
            const files = await captures.run(() => captures.stage(resourceIds, { replace: false, target }));
            publishCapture();
            reply(response, 200, { files, target, capture: captures.summary() }); return;
          }
          if (action === 'target') {
            const target = await askExtension('bind', undefined, { tabId });
            if (!captures.manifest) throw new Error('请先开始项目会话');
            await captures.run(async () => { captures.manifest.editTarget = target; await captures.save(); });
            publishCapture();
            reply(response, 200, { target }); return;
          }
          if (action === 'join') {
            const site = await askExtension('authorize-site', undefined, { tabId });
            await captures.run(() => captures.addSite(site));
            snapshot = { ...snapshot, ...projectInfo(config) };
            const result = await askExtension('join', snapshot, { captureId: captures.manifest.id, tabId });
            reply(response, 200, { ...status(), result }); return;
          }
          if (action === 'capture') {
            if (!peer) throw new Error('扩展未连接');
            if (peerProtocol < 3) throw new Error('请在 chrome://extensions 重新加载 0.3 版扩展');
            const captureId = await captures.run(() => captures.begin());
            try {
              const result = await askExtension('capture', snapshot, { captureId, tabId });
              await captures.run(async () => { captures.manifest.status = 'watching'; await captures.save(); });
              reply(response, 200, { ...status(), result });
            } catch (error) {
              await captures.run(async () => { captures.manifest.status = 'interrupted'; await captures.warn(error.message); });
              throw error;
            }
            return;
          }
          if (action === 'apply') {
            if (captures.manifest && !captures.manifest.selected.length) throw new Error('请先用 stage 选择采集到的资源，再应用修改');
            if (config.projectId && !captures.manifest?.editTarget) throw new Error('请先 stage 或 target，绑定本次修改的目标页');
            if (config.projectId && tabId !== undefined && tabId !== captures.manifest.editTarget.tabId) throw new Error('与本次修改绑定的标签页不同，请显式重新绑定目标');
            const next = await captures.run(async () => await captures.snapshot(snapshot.revision + 1) || await readSnapshot(config, snapshot.revision + 1));
            // Validate the complete file before publishing one immutable revision.
            snapshot = next;
          }
          const result = await askExtension(action, action === 'apply' ? snapshot : undefined, {
            tabId, binding: action === 'apply' ? captures.manifest?.editTarget : undefined,
          });
          if (captures.manifest) await captures.run(async () => {
            captures.manifest.status = action === 'end' ? 'captured' : 'watching';
            if (action === 'end') captures.manifest.editTarget = null;
            await captures.save();
          });
          publishCapture();
          reply(response, 200, { ...status(), result });
        } finally { busy = false; }
        return;
      }
      reply(response, 404, { error: '接口不存在' });
    } catch (error) { reply(response, 400, { error: error.message }); }
  });
  server.requestTimeout = 70000;
  server.headersTimeout = 10000;
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/ws' || request.headers.host !== `127.0.0.1:${server.address().port}` ||
        !/^chrome-extension:\/\/[a-p]{32}$/.test(request.headers.origin || '')) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws));
  });
  wss.on('connection', (socket) => {
    let authenticated = false;
    let messages = Promise.resolve();
    const transfers = new Map();
    const releaseTransfer = (id) => { clearTimeout(transfers.get(id)?.timer); transfers.delete(id); };
    const touchTransfer = (id) => {
      const upload = transfers.get(id); clearTimeout(upload.timer);
      upload.timer = setTimeout(() => transfers.delete(id), 30000);
    };
    const timeout = setTimeout(() => socket.close(1008, 'pairing required'), 5000);
    socket.on('error', () => {});
    socket.on('message', (raw) => {
      messages = messages.then(async () => {
      try {
        const message = JSON.parse(raw.toString());
        if (!authenticated) {
          if (message.type !== 'hello' || !sameSecret(message.token, token)) {
            socket.close(1008, 'invalid pairing'); return;
          }
          if (peer && peer !== socket && peer.readyState === WebSocket.OPEN) {
            socket.close(1008, 'another browser is connected'); return;
          }
          clearTimeout(timeout);
          authenticated = true; peer = socket; peerProtocol = message.protocolVersion || 1; extensionState = null;
          lastSeen = new Date().toISOString();
          send(socket, { type: 'welcome', snapshot, capture: captures.summary(), protocolVersion: 3 }); return;
        }
        lastSeen = new Date().toISOString();
        if (message.type?.startsWith('asset-')) {
          try {
            let result = {};
            if (message.captureId !== captures.manifest?.id) throw new Error('采集会话已过期');
            if (message.type === 'asset-probe') {
              result = await captures.run(() => captures.probe({ ...message.metadata, captureId: message.captureId }));
            } else if (message.type === 'asset-page') {
              await captures.run(() => captures.recordPage({ pageUrl: message.url }));
              result = { capture: captures.summary() };
            } else if (message.type === 'asset-start') {
              if (transfers.size >= 12 || transfers.has(message.transferId)) throw new Error('上传并发超限');
              transfers.set(message.transferId, { metadata: { ...message.metadata, captureId: message.captureId }, chunks: [], bytes: 0, sequence: 0 });
              touchTransfer(message.transferId);
            } else if (message.type === 'asset-chunk') {
              const upload = transfers.get(message.transferId);
              if (!upload || message.sequence !== upload.sequence++) throw new Error('上传分块顺序错误');
              if (typeof message.data !== 'string' || message.data.length > 65536 || !/^[A-Za-z0-9+/]*={0,2}$/.test(message.data)) throw new Error('上传分块无效');
              const chunk = Buffer.from(message.data, 'base64'); upload.bytes += chunk.length;
              if (upload.bytes > 20 * 1024 * 1024) throw new Error('资源超过 20 MB');
              upload.chunks.push(chunk);
              touchTransfer(message.transferId);
            } else if (message.type === 'asset-end') {
              const upload = transfers.get(message.transferId); releaseTransfer(message.transferId);
              if (!upload || upload.bytes !== message.bytes) throw new Error('上传不完整');
              result = await captures.run(() => captures.ingest(upload.metadata, Buffer.concat(upload.chunks)));
            } else if (message.type === 'asset-report') {
              await captures.run(() => captures.warn(message.error));
            } else throw new Error('未知上传消息');
            send(socket, { type: 'upload-ack', id: message.id, ok: true, result });
          } catch (error) {
            releaseTransfer(message.transferId);
            send(socket, { type: 'upload-ack', id: message.id, ok: false, error: error.message });
          }
          return;
        }
        if (message.type === 'ping') send(socket, { type: 'pong' });
        if (message.type === 'state') extensionState = message.state;
        if (message.type === 'result') {
          const task = pending.get(message.id);
          if (task) {
            clearTimeout(task.timer); pending.delete(message.id);
            if (message.ok) task.resolve(message.result);
            else task.reject(new Error(message.error || '扩展操作失败'));
          }
        }
      } catch { socket.close(1008, 'invalid message'); }
      }).catch(() => socket.close(1011, 'upload failed'));
    });
    socket.on('close', () => {
      clearTimeout(timeout);
      for (const id of transfers.keys()) releaseTransfer(id);
      if (peer !== socket) return;
      peer = null; extensionState = null;
      for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error('扩展连接已断开')); }
      pending.clear();
    });
  });
  return {
    server, status,
    async close() {
      for (const client of wss.clients) client.terminate();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      wss.close();
    },
  };
}
