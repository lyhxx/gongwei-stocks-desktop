// 工位看盘 - HTTP 层
// 统一出口，便于把请求实现换成 Electron 的 net.fetch（Chromium 网络栈，走系统代理/PAC）。
// 纯 Node 环境（如 npm test）下默认用全局 fetch，行为不变。

let impl = null; // (url, init) => Promise<Response-like>

function setFetchImpl(fn) {
  impl = typeof fn === 'function' ? fn : null;
}

function getFetchImpl() {
  return impl;
}

function httpFetch(url, options = {}) {
  return (impl || fetch)(url, options);
}

// 报错里只留关键一行，避免诊断区被完整 URL 淹没
function firstLine(msg) {
  return String(msg == null ? 'unknown' : msg).split('\n')[0].slice(0, 120);
}

function shortUrl(u) {
  return String(u).replace(/^https?:\/\//, '').replace(/\?.*$/, '');
}

function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(new Error(`timeout ${timeoutMs}ms @${shortUrl(url)}`)),
    timeoutMs,
  );
  return httpFetch(url, { ...options, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

module.exports = { setFetchImpl, getFetchImpl, httpFetch, fetchWithTimeout, firstLine, shortUrl };
