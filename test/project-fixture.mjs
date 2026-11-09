import { createServer } from 'node:http';
const ports = [17374, 17376, 17377];
for (const port of ports) {
  let version = 1;
  createServer((request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    response.setHeader('Cache-Control', 'no-store');
    if (url.pathname === '/test/redeploy' && request.method === 'POST') {
      version = Number(url.searchParams.get('version')) || 1; response.end('ok'); return;
    }
    if (url.pathname === '/shared.js') {
      response.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      response.end(`window.demoValue = 'original-v${version}'; document.getElementById('value').textContent = window.demoValue;\n//# sourceMappingURL=shared.js.map`); return;
    }
    if (url.pathname === '/shared.js.map') {
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ version: 3, sources: ['src/shared.ts'], sourcesContent: [`export const value = 'original-v${version}';`], names: [], mappings: '' })); return;
    }
    if (url.pathname === '/late.js') {
      response.setHeader('Content-Type', 'application/javascript'); response.end('window.lateComponent = true;'); return;
    }
    if (url.pathname.startsWith('/work/') || url.pathname.startsWith('/other/')) {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(`<!doctype html><html lang="zh-CN"><head><title>${port} ${url.pathname}</title><style>body{font:16px/1.7 system-ui;background:#f2f6f8;color:#183044;padding:48px}main{background:white;max-width:700px;padding:32px;border-radius:16px}a{display:block;margin:12px 0}input{padding:8px;border:1px solid #ccc}#value{font-weight:bold;color:#10786d}</style></head><body><main>
      <h1>${url.pathname.includes('list') ? '列表页' : '详情 / 编辑页'}</h1><p>当前站点：${port}</p>
      <label>未保存的输入 <input id="memo" value="draft"></label><p id="value"></p>
      <a id="same" href="http://127.0.0.1:17376/work/preview">同标签页跨域预览</a>
      <a id="back" href="http://127.0.0.1:17374/work/list">返回列表</a>
      <a id="detail" target="_blank" rel="noopener" href="http://127.0.0.1:17376/work/detail?item=1">新标签页详情</a>
      <a id="unknown" target="_blank" rel="noopener" href="http://127.0.0.1:17377/work/extra">新站点详情</a>
      </main><script>sessionStorage.loads = Number(sessionStorage.loads || 0) + 1;</script><script src="/shared.js"></script></body></html>`); return;
    }
    response.writeHead(404); response.end();
  }).listen(port, '127.0.0.1', () => console.log(`测试站点 http://127.0.0.1:${port}/work/list`));
}
