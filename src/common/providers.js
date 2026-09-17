// 工位看盘 - 行情 Provider（主进程用，Node fetch）
// 东方财富通道说明：
// - token: fa5fd1943c7b386f172d6893dbfba10b
// - 行情: https://push2.eastmoney.com/api/qt/stock/get?secid=..&fields=..&ut=..&fltt=1&invt=2
//   失败自动降级 push2delay.eastmoney.com
// - 搜索: https://searchapi.eastmoney.com/api/suggest/get?input=..&type=14&token=..&count=20
//   type=14 原生支持代码/名称/拼音缩写（如 gzmt -> 贵州茅台）
// - Node 发请求必须带浏览器 UA，否则东财直接拒掉

const EASTMONEY_UT = 'fa5fd1943c7b386f172d6893dbfba10b';
const EASTMONEY_HOSTS = ['push2.eastmoney.com', 'push2delay.eastmoney.com'];
const EASTMONEY_FIELDS = [
  'f43', 'f44', 'f45', 'f46', 'f60', 'f47', 'f48', 'f50',
  'f168', 'f169', 'f170', 'f117', 'f57', 'f58', 'f59', 'f152', 'f86',
].join(',');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// 报错信息里只留关键一行，避免诊断区被 URL 淹没
function firstLine(msg) {
  return String(msg == null ? 'unknown' : msg).split('\n')[0].slice(0, 120);
}
function shortUrl(u) {
  return String(u).replace(/^https?:\/\//, '').replace(/\?.*$/, '');
}

function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`timeout ${timeoutMs}ms @${shortUrl(url)}`)), timeoutMs);
  return fetch(url, { ...options, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

// ---- 东财数值换算：价格/涨跌额是放大后的整数，需按精度还原 ----
// f43/f60/f169 是放大后的整数，除以 10^精度（f59/f152，默认 100）
function numScale(v, scale) {
  if (typeof v === 'number') return v / scale;
  if (typeof v !== 'string') return NaN;
  const n = Number(v.replace(/,/g, ''));
  return Number.isFinite(n) ? n / scale : NaN;
}
function decimalsOf(v) {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').trim());
  return Number.isInteger(n) && n >= 0 && n <= 6 ? n : undefined;
}
function scaleFor(stock, f59, f152) {
  const a = decimalsOf(f59);
  if (a !== undefined) return 10 ** a;
  if (stock.market === 'HK') return 1000;
  return 100;
}
function pct100(v) {
  if (typeof v === 'number') return v / 100;
  const n = Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n / 100 : NaN;
}

// ---- secid / 市场映射 ----
function eastmoneySecid(stock) {
  if (stock.sourceIds && stock.sourceIds.eastmoney) return stock.sourceIds.eastmoney;
  const market = stock.market || guessMarket(stock.code);
  let prefix;
  if (market === 'HK') prefix = '116';
  else if (market === 'US') prefix = '100';
  else prefix = stock.exchange === 'SH' ? '1' : '0';
  return `${prefix}.${stock.code}`;
}

function guessMarket(code) {
  if (/^\d{5}$/.test(code)) return 'HK';
  if (/^(5|6|9)\d{5}$/.test(code) || /^(0|1|2|3)\d{5}$/.test(code) || /^(4|8)\d{5}$/.test(code)) return 'CN';
  return 'US';
}

// 用 QuoteID + Classify 反推市场（搜索结果必须用这个，不能靠代码前缀瞎猜）
function marketFromSuggest(item) {
  const quoteId = String(item.QuoteID || '');
  const head = Number(quoteId.split('.')[0]);
  const classify = String(item.Classify || '').toLowerCase();
  if (classify === 'hk') return { market: 'HK', exchange: 'HKEX' };
  if (head === 116) return { market: 'HK', exchange: 'HKEX' };
  if (head === 100 || head === 105 || head === 106 || head === 107) return { market: 'US', exchange: 'OTHER_US' };
  if (classify.includes('usstock')) return { market: 'US', exchange: 'OTHER_US' };
  const code = quoteId.split('.')[1] || item.Code || '';
  if (classify.includes('fund') && head === 1) return { market: 'CN', exchange: 'SH' };
  if (classify.includes('fund') && head === 0) return { market: 'CN', exchange: 'SZ' };
  if (code.startsWith('6')) return { market: 'CN', exchange: 'SH' };
  if (code.startsWith('8') || code.startsWith('4') || code.startsWith('9')) return { market: 'CN', exchange: 'BJ' };
  if (/^\d{6}$/.test(code)) return { market: 'CN', exchange: 'SZ' };
  return { market: 'US', exchange: 'OTHER_US' };
}

// 腾讯/新浪代码规则：sh600000 / sz000001 / bj899050 / hk00700
// 注意港股前缀是 hk（不是 hkex），美股是 us
const EXCHANGE_PREFIX = { SH: 'sh', SZ: 'sz', BJ: 'bj', HKEX: 'hk', HK: 'hk', OTHER_US: 'us' };
function tencentSymbol(stock) {
  const prefix = EXCHANGE_PREFIX[stock.exchange] || 'sh';
  return `${prefix}${stock.code}`.toLowerCase();
}
function sinaSymbol(stock) {
  return tencentSymbol(stock);
}

// ---- 东财单只行情 ----
async function fetchOneEastmoney(stock) {
  const secid = encodeURIComponent(eastmoneySecid(stock));
  let lastErr = null;
  for (const host of EASTMONEY_HOSTS) {
    const url = `https://${host}/api/qt/stock/get?secid=${secid}&fields=${EASTMONEY_FIELDS}&ut=${EASTMONEY_UT}&fltt=1&invt=2&_=${Date.now()}`;
    try {
      // 单 host 4 秒超时：被墙时双 host 最多卡 8 秒，不再 16 秒+
      const res = await fetchWithTimeout(url, {
        headers: { Referer: 'https://quote.eastmoney.com/', 'User-Agent': UA },
      }, 4000);
      if (!res.ok) throw new Error(`eastmoney http ${res.status}`);
      const data = await res.json();
      const r = data && data.data;
      if (!r || typeof r !== 'object' || r.f43 == null) throw new Error('eastmoney empty data');
      const scale = scaleFor(stock, r.f59, r.f152);
      const price = numScale(r.f43, scale);
      const preClose = numScale(r.f60, scale);
      const change = numScale(r.f169, scale);
      const changePercent = pct100(r.f170);
      const name = typeof r.f58 === 'string' && r.f58 ? r.f58 : stock.name;
      return {
        stockId: stock.id, code: stock.code, name,
        latestPrice: price, changePercent, changeAmount: change,
        preClose, open: numScale(r.f46, scale), high: numScale(r.f44, scale), low: numScale(r.f45, scale),
        ok: Number.isFinite(price), updatedAt: Date.now(),
      };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('eastmoney failed');
}

async function fetchEastmoney(stocks) {
  if (!stocks.length) return [];
  const errs = [];
  const rows = await Promise.all(stocks.map(async (s) => {
    try {
      return await fetchOneEastmoney(s);
    } catch (e) {
      errs.push(`${s.code}=${firstLine(e.message)}`);
      return { stockId: s.id, code: s.code, name: s.name, ok: false, updatedAt: Date.now() };
    }
  }));
  // 全挂时把真实原因抛出去，否则诊断只会看到没用的 "no ok rows"
  if (!rows.some((r) => r.ok)) throw new Error(errs.slice(0, 2).join(' / '));
  return rows;
}

function parseSinaLine(line) {
  const m = line.match(/hq_str_([a-z]{2}\d+)="([^"]*)"/);
  if (!m) return null;
  const symbol = m[1];
  const parts = m[2].split(',');
  if (parts.length < 4) return null;
  const name = parts[0];
  const latestPrice = parseFloat(parts[3]);
  const prevClose = parseFloat(parts[2]);
  if (!Number.isFinite(latestPrice) || !Number.isFinite(prevClose) || prevClose === 0) return null;
  const changeAmount = latestPrice - prevClose;
  return { symbol, name, latestPrice, changePercent: (changeAmount / prevClose) * 100, changeAmount };
}

async function fetchSina(stocks) {
  if (!stocks.length) return [];
  const symbols = stocks.map(sinaSymbol).join(',');
  // HTTPS 优先（部分网络封 80 端口），失败再回退 HTTP
  const urls = [
    `https://hq.sinajs.cn/list=${symbols}`,
    `http://hq.sinajs.cn/list=${symbols}`,
  ];
  let lastErr = null;
  let text = null;
  const errs = [];
  for (const url of urls) {
    try {
      const res = await fetchWithTimeout(url, {
        headers: { Referer: 'https://finance.sina.com.cn/', 'User-Agent': UA },
      });
      if (!res.ok) throw new Error(`http ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      text = buf.toString('latin1');
      break;
    } catch (e) {
      lastErr = e;
      errs.push(`${url.startsWith('https') ? 'https' : 'http'}:${firstLine(e.message)}`);
    }
  }
  if (text === null) throw new Error(errs.join(' / ') || 'sina failed');
  const parsed = new Map();
  for (const line of text.split(';')) {
    const p = parseSinaLine(line);
    if (p) parsed.set(p.symbol, p);
  }
  const now = Date.now();
  return stocks.map((s) => {
    const p = parsed.get(sinaSymbol(s));
    if (!p) return { stockId: s.id, code: s.code, name: s.name, ok: false, updatedAt: now };
    return {
      stockId: s.id, code: s.code, name: s.name,
      latestPrice: p.latestPrice, changePercent: p.changePercent,
      changeAmount: p.changeAmount, ok: true, updatedAt: now,
    };
  });
}

function parseTencentLine(line) {
  const m = line.match(/v_([a-z]{2}\d+)="([^"]*)"/);
  if (!m) return null;
  const symbol = m[1];
  const parts = m[2].split('~');
  if (parts.length < 6) return null;
  const latestPrice = parseFloat(parts[3]);
  const prevClose = parseFloat(parts[4]);
  if (!Number.isFinite(latestPrice) || !Number.isFinite(prevClose) || prevClose === 0) return null;
  const changeAmount = latestPrice - prevClose;
  return { symbol, latestPrice, changePercent: (changeAmount / prevClose) * 100, changeAmount };
}

async function fetchTencent(stocks) {
  if (!stocks.length) return [];
  const symbols = stocks.map(tencentSymbol).join(',');
  // HTTPS 优先（smartbox 走通的网络一般也通 qt 的 443），失败再回退 HTTP
  const urls = [
    `https://qt.gtimg.cn/q=${symbols}`,
    `http://qt.gtimg.cn/q=${symbols}`,
  ];
  let lastErr = null;
  let text = null;
  const errs = [];
  for (const url of urls) {
    try {
      const res = await fetchWithTimeout(url, {
        headers: { Referer: 'https://gu.qq.com/', 'User-Agent': UA },
      });
      if (!res.ok) throw new Error(`http ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      text = buf.toString('latin1');
      break;
    } catch (e) {
      lastErr = e;
      errs.push(`${url.startsWith('https') ? 'https' : 'http'}:${firstLine(e.message)}`);
    }
  }
  if (text === null) throw new Error(errs.join(' / ') || 'tencent failed');
  const parsed = new Map();
  for (const line of text.split(';')) {
    const p = parseTencentLine(line);
    if (p) parsed.set(p.symbol, p);
  }
  const now = Date.now();
  return stocks.map((s) => {
    const p = parsed.get(tencentSymbol(s));
    if (!p) return { stockId: s.id, code: s.code, name: s.name, ok: false, updatedAt: now };
    return {
      stockId: s.id, code: s.code, name: s.name,
      latestPrice: p.latestPrice, changePercent: p.changePercent,
      changeAmount: p.changeAmount, ok: true, updatedAt: now,
    };
  });
}

// 主入口：三通道并行拉取，按 stockId 合并（谁先 OK 用谁， complementary 补全）
// 串行降级太慢（东财双 host 超时能卡 16 秒），并行后整体只等最慢的一路
async function fetchQuotesWithFallback(stocks) {
  if (!stocks.length) return { rows: [], source: 'empty', errors: [] };
  const settled = await Promise.allSettled([
    fetchEastmoney(stocks),
    fetchSina(stocks),
    fetchTencent(stocks),
  ]);
  const names = ['fetchEastmoney', 'fetchSina', 'fetchTencent'];
  const errors = [];
  const byProvider = settled.map((s, i) => {
    if (s.status === 'fulfilled') {
      const okCount = s.value.filter((r) => r.ok).length;
      if (okCount === 0) errors.push(`${names[i]}: no ok rows`);
      return s.value;
    }
    errors.push(`${names[i]}: ${s.reason && s.reason.message ? s.reason.message : s.reason}`);
    return [];
  });
  const now = Date.now();
  const used = new Set();
  const rows = stocks.map((s) => {
    for (let i = 0; i < byProvider.length; i++) {
      const q = byProvider[i].find((r) => r.stockId === s.id);
      if (q && q.ok) {
        used.add(names[i].replace('fetch', '').toLowerCase());
        return q;
      }
    }
    return { stockId: s.id, code: s.code, name: s.name, ok: false, updatedAt: now };
  });
  const source = used.size ? [...used].join('+') : 'none';
  return { rows, source, errors };
}

// ---- 搜索 ----
// smartbox 回的是字面量 \uXXXX 转义串（6 个 ASCII 字符），必须先解码，否则界面显示 \u6d66…
function unescapeUnicode(s) {
  return String(s || '').replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}
// 主通道：腾讯 smartbox（免 token，实测支持代码/名称/拼音缩写，网络兼容最好）
// 格式：v_hint="sh~600000~浦发银行~pfyh~GP-A^sz~000600~建投能源~jtny~GP-A^..."
// 条目：market~code~name~pinyin~type（type: GP-A=A股，GP=港/美股，KJ=基金直接过滤）
function parseSmartbox(text) {
  const m = String(text || '').match(/v_hint="([^"]*)"/);
  if (!m || !m[1]) return [];
  return m[1].split('^').map((entry) => {
    const parts = entry.split('~');
    if (parts.length < 5) return null;
    const [mk, code, name, , type] = parts;
    if (!code || !name) return null;
    if (!/^GP/.test(type || '')) return null; // 过滤基金 KJ
    let market = 'CN';
    let exchange = 'SH';
    if (mk === 'sh') { market = 'CN'; exchange = 'SH'; }
    else if (mk === 'sz') { market = 'CN'; exchange = code.startsWith('8') || code.startsWith('4') || code.startsWith('9') ? 'BJ' : 'SZ'; }
    else if (mk === 'bj') { market = 'CN'; exchange = 'BJ'; }
    else if (mk === 'hk') { market = 'HK'; exchange = 'HKEX'; }
    else if (mk === 'us') { market = 'US'; exchange = 'OTHER_US'; }
    else return null;
    const cleanCode = market === 'US' ? code.split('.')[0].toUpperCase() : code;
    const realName = unescapeUnicode(name);
    return { code: cleanCode, name: realName, market, exchange, label: `${realName} ${cleanCode}`, sourceIds: {} };
  }).filter(Boolean);
}

async function searchTencent(keyword, count = 10) {
  const kw = String(keyword || '').trim();
  if (!kw) return [];
  const url = `https://smartbox.gtimg.cn/s3/?q=${encodeURIComponent(kw)}&t=all`;
  let res;
  try {
    res = await fetchWithTimeout(url, {
      headers: { Referer: 'https://gu.qq.com/', 'User-Agent': UA },
    }, 6000);
  } catch (e) {
    throw new Error(`腾讯搜索网络失败：${e.message}`);
  }
  if (!res.ok) throw new Error(`腾讯搜索返回 ${res.status}`);
  const text = await res.text();
  return parseSmartbox(text).slice(0, count);
}

// 备通道：东财搜索（type=14，同样支持代码/名称/拼音缩写）
async function searchEastmoney(keyword, count = 10) {
  const kw = String(keyword || '').trim();
  if (!kw) return [];
  const n = Math.min(Math.max(count || 10, 1), 20);
  const url = `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(kw)}&type=14&token=${EASTMONEY_UT}&count=${n}`;
  let res;
  try {
    res = await fetchWithTimeout(url, {
      headers: { Referer: 'https://www.eastmoney.com/', 'User-Agent': UA },
    }, 6000);
  } catch (e) {
    throw new Error(`东财搜索网络失败：${e.message}`);
  }
  if (!res.ok) throw new Error(`东财搜索返回 ${res.status}`);
  const data = await res.json();
  const list = (data && data.QuotationCodeTable && data.QuotationCodeTable.Data) || [];
  return list
    .filter((d) => d && d.QuoteID && d.Code)
    .slice(0, n)
    .map((d) => {
      const { market, exchange } = marketFromSuggest(d);
      const label = d.Name ? `${d.Name} ${d.Code}` : String(d.Code);
      return { code: d.Code, name: d.Name || d.Code, market, exchange, label, sourceIds: { eastmoney: d.QuoteID } };
    });
}

// 第三通道：新浪 suggest（免 token，支持代码/名称/拼音）
// 格式：var suggestvalue="贵州茅台,11,sh600519,600519,...;浦发银行,11,sh600000,...";
function parseSinaSuggest(text) {
  const m = String(text || '').match(/suggestvalue="([\s\S]*)"/);
  if (!m || !m[1]) return [];
  const out = [];
  const re = /([^,;"]+),\d+,((?:sh|sz|bj)\d{6})/gi;
  let g;
  while ((g = re.exec(m[1])) !== null) {
    const name = g[1].trim();
    const symbol = g[2].toLowerCase();
    const code = symbol.slice(2);
    const exchange = symbol.startsWith('sh') ? 'SH' : (symbol.startsWith('bj') ? 'BJ' : 'SZ');
    if (!name || !code) continue;
    out.push({ code, name, market: 'CN', exchange, label: `${name} ${code}`, sourceIds: {} });
  }
  return out;
}

async function searchSina(keyword, count = 10) {
  const kw = String(keyword || '').trim();
  if (!kw) return [];
  const url = `https://suggest3.sinajs.cn/suggest/type=11,12,13,14,15&key=${encodeURIComponent(kw)}`;
  let res;
  try {
    res = await fetchWithTimeout(url, {
      headers: { Referer: 'https://finance.sina.com.cn/', 'User-Agent': UA },
    }, 6000);
  } catch (e) {
    throw new Error(`新浪搜索网络失败：${e.message}`);
  }
  if (!res.ok) throw new Error(`新浪搜索返回 ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return parseSinaSuggest(decodeAuto(buf)).slice(0, count);
}

// 新浪部分接口回 GBK，且 GBK 字节可能恰好也是合法 UTF-8（茅台 GBK = C3 A9 CC A8，
// 按 UTF-8 解会得到「é + 组合符」而不是替换符）。判定规则：
// 1. UTF-8 解出替换符（解析失败）→ 用 GBK 版；
// 2. UTF-8 无中文但有其它非 ASCII，且 GBK 版有中文 → 用 GBK（针对上面那种恰好合法的情形）；
// 3. 其它一律 UTF-8（UTF-8 被按 GBK 解也会得到中文，不能只比中文数量）。
function decodeAuto(buf) {
  const u = buf.toString('utf8');
  let g;
  try {
    g = new TextDecoder('gbk').decode(buf);
  } catch {
    return u;
  }
  if (g === u) return u;
  const cjk = (s) => (s.match(/[\u4e00-\u9fa5]/g) || []).length;
  if (u.includes('\uFFFD')) return cjk(g) ? g : u;
  if (cjk(u) === 0 && cjk(g) > 0 && /[^\x00-\x7f]/.test(u)) return g;
  return u;
}

// 第四通道：雪球 suggest（免 token，作为补充搜索源）
function parseXueqiuSuggest(data) {
  const items = (data && data.data && data.data.items) || (data && data.items) || [];
  const out = [];
  for (const it of items) {
    if (!it || !it.symbol) continue;
    const sym = String(it.symbol).toUpperCase();
    const m = sym.match(/^(SH|SZ|BJ|HK|US)(.+)$/);
    if (!m) continue;
    const exMap = { SH: 'SH', SZ: 'SZ', BJ: 'BJ', HK: 'HKEX', US: 'OTHER_US' };
    const market = m[1] === 'HK' ? 'HK' : (m[1] === 'US' ? 'US' : 'CN');
    const code = m[1] === 'US' ? m[2].split('.')[0] : m[2];
    const name = it.name || it.code || code;
    if (!code) continue;
    out.push({ code, name, market, exchange: exMap[m[1]] || 'SH', label: `${name} ${code}`, sourceIds: {} });
  }
  return out;
}

async function searchXueqiu(keyword, count = 10) {
  const kw = String(keyword || '').trim();
  if (!kw) return [];
  const url = `https://xueqiu.com/query/v1/suggest.json?count=${Math.min(count || 10, 20)}&code=${encodeURIComponent(kw)}&type=&_=${Date.now()}`;
  let res;
  try {
    res = await fetchWithTimeout(url, {
      headers: { Referer: 'https://xueqiu.com/', 'User-Agent': UA },
    }, 6000);
  } catch (e) {
    throw new Error(`雪球搜索网络失败：${e.message}`);
  }
  if (!res.ok) throw new Error(`雪球搜索返回 ${res.status}`);
  const data = await res.json();
  if (data && data.success === false) throw new Error(`雪球需登录cookie，已跳过(${data.code || 'auth'})`);
  return parseXueqiuSuggest(data).slice(0, count);
}

// ---- 接口自检（App 内运行，跑出每条通道的真实证据） ----
// 每个探针：发真实请求 → 校验返回格式 → 记录耗时/结果摘要
async function probe(name, url, headers, validate, timeoutMs = 8000) {
  const t0 = Date.now();
  try {
    const res = await fetchWithTimeout(url, { headers }, timeoutMs);
    const ms = Date.now() - t0;
    if (!res.ok) return { name, url, ok: false, ms, detail: `http ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    const checked = validate(buf);
    return { name, url, ok: checked.ok, ms, detail: checked.detail };
  } catch (e) {
    return { name, url, ok: false, ms: Date.now() - t0, detail: `请求失败：${e.message}` };
  }
}

async function selfTest() {
  // 9 个探针相互独立，并行跑，总耗时只取决于最慢的一路（被墙网络下串行要 70 秒+）
  const jobs = [
    () => probe(
      '腾讯搜索(smartbox)', 'https://smartbox.gtimg.cn/s3/?q=600000&t=all',
      { Referer: 'https://gu.qq.com/', 'User-Agent': UA },
      (buf) => {
        const rows = parseSmartbox(buf.toString('utf8'));
        return rows.length
          ? { ok: true, detail: `通，${rows.length}条，首条=${rows[0].label}` }
          : { ok: false, detail: '通但 0 条结果（解析异常）' };
      },
    ),
    () => probe(
      '东财搜索(suggest)', `https://searchapi.eastmoney.com/api/suggest/get?input=600000&type=14&token=${EASTMONEY_UT}&count=3`,
      { Referer: 'https://www.eastmoney.com/', 'User-Agent': UA },
      (buf) => {
        let data;
        try { data = JSON.parse(buf.toString('utf8')); } catch { return { ok: false, detail: '通但 JSON 解析失败' }; }
        const n = ((data && data.QuotationCodeTable && data.QuotationCodeTable.Data) || []).length;
        return n ? { ok: true, detail: `通，${n}条` } : { ok: false, detail: '通但 0 条结果' };
      },
    ),
    () => probe(
      '东财行情(stock/get)', `https://push2.eastmoney.com/api/qt/stock/get?secid=1.600000&fields=${EASTMONEY_FIELDS}&ut=${EASTMONEY_UT}&fltt=1&invt=2&_=${Date.now()}`,
      { Referer: 'https://quote.eastmoney.com/', 'User-Agent': UA },
      (buf) => {
        let data;
        try { data = JSON.parse(buf.toString('utf8')); } catch { return { ok: false, detail: '通但 JSON 解析失败' }; }
        const r = data && data.data;
        return (r && r.f43 != null)
          ? { ok: true, detail: `通，现价=${r.f43}（原始值，需除精度）` }
          : { ok: false, detail: '通但无 f43 字段' };
      },
    ),
    () => probe(
      '腾讯行情(qt.gtimg.cn https)', 'https://qt.gtimg.cn/q=sh600000',
      { Referer: 'https://gu.qq.com/', 'User-Agent': UA },
      (buf) => {
        const p = parseTencentLine(buf.toString('latin1').split(';')[0] || '');
        return p ? { ok: true, detail: `通，现价=${p.latestPrice}` } : { ok: false, detail: '通但解析失败' };
      },
    ),
    () => probe(
      '腾讯行情(qt.gtimg.cn http)', 'http://qt.gtimg.cn/q=sh600000',
      { Referer: 'http://stockapp.finance.qq.com/', 'User-Agent': UA },
      (buf) => {
        const p = parseTencentLine(buf.toString('latin1').split(';')[0] || '');
        return p ? { ok: true, detail: `通，现价=${p.latestPrice}` } : { ok: false, detail: '通但解析失败' };
      },
    ),
    () => probe(
      '新浪行情(hq.sinajs.cn https)', 'https://hq.sinajs.cn/list=sh600000',
      { Referer: 'https://finance.sina.com.cn/', 'User-Agent': UA },
      (buf) => {
        const p = parseSinaLine(buf.toString('latin1').split(';')[0] || '');
        return p ? { ok: true, detail: `通，现价=${p.latestPrice}` } : { ok: false, detail: '通但解析失败' };
      },
    ),
    () => probe(
      '新浪行情(hq.sinajs.cn http)', 'http://hq.sinajs.cn/list=sh600000',
      { Referer: 'https://finance.sina.com.cn/', 'User-Agent': UA },
      (buf) => {
        const p = parseSinaLine(buf.toString('latin1').split(';')[0] || '');
        return p ? { ok: true, detail: `通，现价=${p.latestPrice}` } : { ok: false, detail: '通但解析失败' };
      },
    ),
    () => probe(
      '新浪搜索(suggest3)', 'https://suggest3.sinajs.cn/suggest/type=11,12,13,14,15&key=600000',
      { Referer: 'https://finance.sina.com.cn/', 'User-Agent': UA },
      (buf) => {
        const rows = parseSinaSuggest(decodeAuto(buf));
        return rows.length ? { ok: true, detail: `通，${rows.length}条` } : { ok: false, detail: '通但 0 条结果' };
      },
    ),
    () => probe(
      '雪球搜索(suggest)', `https://xueqiu.com/query/v1/suggest.json?count=5&code=600000&type=&_=${Date.now()}`,
      { Referer: 'https://xueqiu.com/', 'User-Agent': UA },
      (buf) => {
        let data;
        try { data = JSON.parse(buf.toString('utf8')); } catch { return { ok: false, detail: '通但 JSON 解析失败' }; }
        const rows = parseXueqiuSuggest(data);
        return rows.length ? { ok: true, detail: `通，${rows.length}条` } : { ok: false, detail: '通但 0 条结果' };
      },
    ),
  ];
  const results = await Promise.all(jobs.map((fn) => fn()));
  return { at: Date.now(), results };
}

// 纯 6 位代码直通：不依赖任何搜索接口，直接按前缀规则构造候选
// 6→SH，0/3→SZ，4/8/9→BJ
function directCodeCandidate(keyword) {
  const code = String(keyword || '').trim();
  if (!/^\d{6}$/.test(code)) return null;
  let exchange = 'SZ';
  if (code.startsWith('6')) exchange = 'SH';
  else if (code.startsWith('8') || code.startsWith('4') || code.startsWith('9')) exchange = 'BJ';
  return { code, name: code, market: 'CN', exchange, label: `${code}（直接添加）`, sourceIds: {} };
}

// 搜索总入口：腾讯 -> 东财 -> 新浪 -> 雪球 -> 纯代码直通，五层兜底
async function searchStocks(keyword, count = 10) {
  const kw = String(keyword || '').trim();
  if (!kw) return [];
  const errors = [];
  const direct = directCodeCandidate(kw);
  const channels = [
    ['腾讯', searchTencent],
    ['东财', searchEastmoney],
    ['新浪', searchSina],
    ['雪球', searchXueqiu],
  ];
  for (const [name, fn] of channels) {
    try {
      const rows = await fn(kw, count);
      if (rows.length) return rows;
      errors.push(`${name}0条`);
    } catch (e) {
      errors.push(`${name}失败(${e.message})`);
    }
  }
  if (direct) return [direct];
  throw new Error(`搜索失败：${errors.join('；') || '无结果'}`);
}

module.exports = {
  EASTMONEY_UT,
  eastmoneySecid, tencentSymbol, sinaSymbol,
  numScale, pct100, marketFromSuggest, unescapeUnicode, decodeAuto,
  parseSinaLine, parseTencentLine, parseSmartbox, parseSinaSuggest, parseXueqiuSuggest, directCodeCandidate,
  fetchEastmoney, fetchSina, fetchTencent,
  fetchQuotesWithFallback, searchEastmoney, searchTencent, searchSina, searchXueqiu, searchStocks,
  selfTest,
};
