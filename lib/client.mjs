import { readFile } from 'node:fs/promises';

export function createClient(runtime) {
  return async (path, body) => {
    let connection, token;
    try {
      connection = JSON.parse(await readFile(`${runtime}/connection.json`, 'utf8'));
      token = (await readFile(`${runtime}/token`, 'utf8')).trim();
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('本地服务尚未启动，请先运行 start。');
      throw error;
    }
    let response;
    try {
      response = await fetch(`http://127.0.0.1:${connection.port}${path}`, {
        method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(75000),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch { throw new Error('无法连接本地服务，请运行 doctor 查看状态，或运行 start 启动。'); }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '服务请求失败');
    return result;
  };
}

export async function verifyApplication(call, { tabId, revision, expectedURLs, timeout = 15000 }) {
  const deadline = Date.now() + timeout;
  let target;
  do {
    const state = await call('/status');
    target = state.extension?.trackedTabs?.find((tab) => tab.id === tabId);
    if (!state.connected || !target) throw new Error('目标页已断开，未确认修改生效');
    if (target.revision === revision) {
      const failure = Object.values(target.outcomes || {}).find((outcome) => ['mismatch', 'error', 'timeout'].includes(outcome));
      if (failure) throw new Error(`修改未完整生效：${failure}。请检查版本或恢复页面。`);
      if (expectedURLs.every((url) => target.appliedURLs?.includes(url))) return { verified: true, tabId, revision, appliedURLs: target.appliedURLs };
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  } while (Date.now() < deadline);
  throw new Error('等待覆盖结果超时，尚未确认全部资源生效；请查看页面和 status，不要重复宣称成功。');
}
