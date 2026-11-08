const MAX_BYTES = 20 * 1024 * 1024;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const encode = (bytes) => {
  let output = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) output += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(output);
};
const headerValue = (value) => typeof value === 'string' && value.length <= 16000 ? value : undefined;

export function createCollector({ tabId, captureId, origin, allows = (url) => url.startsWith(`${origin}/`),
  pageURL = () => '', isOverridden = () => false, command, rpc, progress }) {
  let active = true;
  let lastActivity = Date.now();
  let jobs = 0;
  let queue = Promise.resolve();
  const requests = new Map();
  const inspected = new Set();
  const mapDownloads = new Set();
  const urls = new Set();
  const controller = new AbortController();
  const report = async (error) => {
    if (active) await rpc({ type: 'asset-report', captureId, error: String(error) }).catch(() => {});
  };
  async function upload(metadata, bytes) {
    if (!active) throw new Error('采集已停止');
    if (bytes.length > MAX_BYTES) throw new Error(`${metadata.url}: 超过 20 MB`);
    if (!bytes.length) return { neededMaps: [] };
    if (metadata.kind !== 'map') {
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('');
      const cached = await rpc({ type: 'asset-probe', captureId, metadata: { ...metadata, hash } });
      if (cached.found) { progress(cached.capture); return cached; }
    }
    const transferId = crypto.randomUUID();
    await rpc({ type: 'asset-start', captureId, transferId, metadata });
    for (let offset = 0, sequence = 0; offset < bytes.length; offset += 49152, sequence++) {
      if (!active) throw new Error('采集已停止');
      await rpc({ type: 'asset-chunk', captureId, transferId, sequence, data: encode(bytes.subarray(offset, offset + 49152)) });
    }
    const result = await rpc({ type: 'asset-end', captureId, transferId, bytes: bytes.length });
    progress(result.capture); return result;
  }
  async function fetchMap(item) {
    const key = `${item.resourceId}|${item.url}`;
    if (mapDownloads.has(key)) return;
    if (!allows(item.url)) throw new Error('map 站点未加入项目');
    mapDownloads.add(key);
    const response = await fetch(item.url, { credentials: 'include', redirect: 'error',
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]) });
    if (!response.ok) throw new Error(`map 获取失败：${response.status} ${item.url}`);
    const reader = response.body.getReader(); const parts = []; let bytes = 0;
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > MAX_BYTES) { await reader.cancel(); throw new Error('map 超过 20 MB'); }
      parts.push(chunk.value);
    }
    const output = new Uint8Array(bytes); let offset = 0;
    for (const part of parts) { output.set(part, offset); offset += part.length; }
    await upload({ kind: 'map', url: item.url, resourceId: item.resourceId }, output);
  }
  function enqueue(metadata, getBytes, original = false) {
    if (!active || !allows(metadata.url)) return;
    urls.add(metadata.url);
    if (!original && isOverridden(metadata.url)) return;
    jobs++; lastActivity = Date.now();
    queue = queue.then(async () => {
      if (!active || (!original && isOverridden(metadata.url))) return;
      const stored = await upload(metadata, await getBytes());
      for (const item of stored.neededMaps || []) {
        try { await fetchMap(item); } catch (error) { await report(`${item.url}: ${error.message}`); }
      }
    }).catch((error) => report(`${metadata.url}: ${error.message}`)).finally(() => { jobs--; lastActivity = Date.now(); });
  }
  return {
    urls,
    newDocument() { inspected.clear(); mapDownloads.clear(); },
    stop() { active = false; controller.abort(); requests.clear(); },
    original(url, type, bytes, sourceMapHeader) {
      enqueue({ kind: 'resource', url, type, sourceMapHeader: headerValue(sourceMapHeader), pageUrl: pageURL() }, async () => bytes, true);
    },
    onEvent(method, params) {
      if (!active) return;
      if (method === 'Network.responseReceived' && ['Script', 'Stylesheet'].includes(params.type)) {
        const response = params.response;
        if (!allows(response.url) || response.status !== 200 || isOverridden(response.url)) return;
        const headers = Object.entries(response.headers || {});
        const sourceMapHeader = headers.find(([name]) => name.toLowerCase() === 'sourcemap')?.[1] || headers.find(([name]) => name.toLowerCase() === 'x-sourcemap')?.[1];
        requests.set(params.requestId, { kind: 'resource', url: response.url, type: params.type,
          sourceMapHeader: headerValue(sourceMapHeader), pageUrl: pageURL(params.loaderId) });
        lastActivity = Date.now();
      }
      if (method === 'Network.loadingFinished' && requests.has(params.requestId)) {
        const metadata = requests.get(params.requestId); requests.delete(params.requestId);
        enqueue(metadata, async () => {
          const response = await command(tabId, 'Network.getResponseBody', { requestId: params.requestId });
          return response.base64Encoded ? Uint8Array.from(atob(response.body), (char) => char.charCodeAt(0)) : new TextEncoder().encode(response.body);
        });
      }
      if (method === 'Network.loadingFailed' && requests.has(params.requestId)) {
        const metadata = requests.get(params.requestId); requests.delete(params.requestId);
        void report(`${metadata.url}: ${params.errorText}`);
      }
      // Obtain already-loaded source through CDP; never reload an edit form to collect it.
      if (method === 'Debugger.scriptParsed' && params.startLine === 0 && params.startColumn === 0 &&
          allows(params.url) && !inspected.has(params.scriptId)) {
        inspected.add(params.scriptId);
        enqueue({ kind: 'resource', url: params.url, type: 'Script', sourceMapHeader: headerValue(params.sourceMapURL), pageUrl: pageURL() }, async () => {
          const { scriptSource } = await command(tabId, 'Debugger.getScriptSource', { scriptId: params.scriptId });
          return new TextEncoder().encode(scriptSource);
        });
      }
      if (method === 'CSS.styleSheetAdded') {
        const header = params.header;
        if (header.isInline || !allows(header.sourceURL) || inspected.has(header.styleSheetId)) return;
        inspected.add(header.styleSheetId);
        enqueue({ kind: 'resource', url: header.sourceURL, type: 'Stylesheet', sourceMapHeader: headerValue(header.sourceMapURL), pageUrl: pageURL() }, async () => {
          const { text } = await command(tabId, 'CSS.getStyleSheetText', { styleSheetId: header.styleSheetId });
          return new TextEncoder().encode(text);
        });
      }
    },
    async initialComplete() {
      const start = Date.now();
      while (active && Date.now() - start < 45000) {
        if (Date.now() - start > 1500 && jobs === 0 && requests.size === 0 && Date.now() - lastActivity > 800) return;
        await sleep(150);
      }
      if (!active) throw new Error('采集连接已结束');
      await report('部分资源仍在加载，后台将继续采集');
    },
  };
}
