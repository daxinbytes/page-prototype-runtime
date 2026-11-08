// Wait for a new main-frame commit and its completed load, never the old document's status.
export function reloadPage(tabId, timeout = 15000) {
  return new Promise((resolve, reject) => {
    let committed = false, settled = false;
    const finish = (error) => {
      if (settled) return; settled = true; clearTimeout(timer);
      chrome.webNavigation.onCommitted.removeListener(onCommit);
      chrome.webNavigation.onCompleted.removeListener(onComplete);
      chrome.webNavigation.onErrorOccurred.removeListener(onError);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      if (error) reject(error); else resolve();
    };
    const onCommit = (event) => { if (event.tabId === tabId && event.frameId === 0) committed = true; };
    const onComplete = (event) => { if (event.tabId === tabId && event.frameId === 0 && committed) finish(); };
    const onError = (event) => { if (event.tabId === tabId && event.frameId === 0) finish(new Error('页面重新加载失败，请检查网络后重试')); };
    const onRemoved = (id) => { if (id === tabId) finish(new Error('目标标签页已关闭')); };
    const timer = setTimeout(() => finish(new Error('等待原始页面加载超时，请检查页面后重试')), timeout);
    chrome.webNavigation.onCommitted.addListener(onCommit);
    chrome.webNavigation.onCompleted.addListener(onComplete);
    chrome.webNavigation.onErrorOccurred.addListener(onError);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.tabs.reload(tabId, { bypassCache: true }).catch(finish);
  });
}
