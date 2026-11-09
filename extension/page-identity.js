// Shared by the extension and the local registry. Only the data-record key `id`
// is ignored; routing parameters such as module/view remain part of identity.
export function httpURL(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('请选择 HTTP(S) 页面');
  return url;
}
function query(value) {
  const params = new URLSearchParams(value);
  for (const key of [...params.keys()]) if (key.toLowerCase() === 'id') params.delete(key);
  params.sort(); return params.toString();
}
function route(url) {
  const hash = url.hash.slice(1);
  if (!hash.startsWith('/') && !hash.startsWith('!/')) return { path: '', query: '' };
  const [path, search = ''] = hash.replace(/^!/, '').split('?');
  return { path, query: query(search) };
}
export function pageKey(value) {
  const url = httpURL(value), hash = route(url), search = query(url.search);
  return `${url.origin}${url.pathname}${search ? `?${search}` : ''}${hash.path ? `#${hash.path}${hash.query ? `?${hash.query}` : ''}` : ''}`;
}
export function scopeForPage(value) {
  const url = httpURL(value), hash = route(url), first = url.pathname.split('/').filter(Boolean)[0];
  const documentEntry = !first || /\.[a-z0-9]+$/i.test(first);
  const pagePath = documentEntry ? url.pathname : `/${first}`;
  return { origin: url.origin, pagePath, exactPath: documentEntry,
    hashPrefix: documentEntry && hash.path ? `/${hash.path.split('/').filter(Boolean)[0] || ''}` : '',
    // Query-controlled applications must not silently cross module boundaries.
    query: Object.fromEntries([...url.searchParams].filter(([key]) => ['app', 'module', 'view', 'page'].includes(key.toLowerCase()))) };
}
export function matchesScope(scope, value) {
  try {
    const url = httpURL(value);
    if (scope.origin !== url.origin) return false;
    if (scope.exactPath ? url.pathname !== scope.pagePath : !(scope.pagePath === '/' || url.pathname === scope.pagePath || url.pathname.startsWith(`${scope.pagePath}/`))) return false;
    const hash = route(url).path;
    if (scope.hashPrefix && !(hash === scope.hashPrefix || hash.startsWith(`${scope.hashPrefix}/`))) return false;
    return Object.entries(scope.query || {}).every(([key, value]) => url.searchParams.get(key) === value);
  } catch { return false; }
}
