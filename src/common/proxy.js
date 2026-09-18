// 工位看盘 - 代理相关纯函数（不依赖 Electron，方便单测）
//
// 代理的实际生效交给 Electron：session.setProxy() 决定 Chromium 网络栈怎么走，
// 请求统一用 net.fetch（见 common/http.js）。这里只负责输入校验与状态描述。

const PROXY_MODES = ['system', 'direct', 'manual'];

function normalizeProxyMode(v) {
  return PROXY_MODES.includes(v) ? v : 'system';
}

// 把用户输入的代理地址规整成 Chromium 的 proxyRules 格式。
// 接受：127.0.0.1:7890 / http://127.0.0.1:7890 / socks5://127.0.0.1:1080
// 返回 { ok, rules, error }
function normalizeProxyRules(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { ok: false, rules: '', error: '代理地址为空' };

  // 没写协议时默认 http
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`;

  let u;
  try {
    u = new URL(withScheme);
  } catch {
    return { ok: false, rules: '', error: `代理地址不合法（检查主机与端口，端口范围 1-65535）：${s}` };
  }

  const scheme = u.protocol.replace(':', '').toLowerCase();
  const allowed = ['http', 'https', 'socks4', 'socks5'];
  if (!allowed.includes(scheme)) {
    return { ok: false, rules: '', error: `不支持的代理协议：${scheme}（支持 http / https / socks4 / socks5）` };
  }
  if (!u.hostname || !u.port) {
    return { ok: false, rules: '', error: '代理地址需要包含主机和端口，例如 127.0.0.1:7890' };
  }
  const port = Number(u.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, rules: '', error: `端口不合法：${u.port}` };
  }

  // Chromium 的 proxyRules 写成 scheme://host:port 即可
  return { ok: true, rules: `${scheme}://${u.hostname}:${port}`, error: '' };
}

// 把 session.resolveProxy() 的结果翻译成人话，用于诊断显示。
// 输入形如："PROXY 127.0.0.1:7897" / "DIRECT" / "SOCKS5 1.2.3.4:1080; DIRECT"
function describeResolvedProxy(resolved) {
  const s = String(resolved == null ? '' : resolved).trim();
  if (!s || /^direct$/i.test(s)) return '直连（未使用代理）';

  const first = s.split(';')[0].trim();
  const m = first.match(/^([A-Z0-9]+)\s+(.+)$/i);
  if (!m) return first;

  const kind = m[1].toUpperCase();
  const target = m[2].trim();
  const label = kind === 'PROXY' ? 'HTTP 代理' : (kind === 'SOCKS5' ? 'SOCKS5 代理' : `${kind} 代理`);
  return `${label} ${target}`;
}

module.exports = { PROXY_MODES, normalizeProxyMode, normalizeProxyRules, describeResolvedProxy };
