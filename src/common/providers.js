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
// 只请求真正会用到的字段（现价/开高低/昨收/名称/精度/涨跌/量/量比），字段越少响应体越小
const EASTMONEY_FIELDS = [
  'f43', 'f44', 'f45', 'f46', 'f47', 'f50', 'f58', 'f59', 'f60', 'f152', 'f169', 'f170',
].join(',');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// 请求统一走 common/http.js：应用内会被换成 Electron 的 net.fetch（走系统代理/PAC），
// 单测里则用全局 fetch，两边行为一致
const { fetchWithTimeout, firstLine } = require('./http');

// ---- 东财数值换算：价格/涨跌额是放大后的整数，需按精度还原 ----
// f43/f60/f169 是放大后的整数，除以 10^精度（f59/f152，默认 100）
function numScale(v, scale) {
  if (typeof v === 'number') return v / scale;
  if (typeof v !== 'string') return NaN;
  const n = Number(v.replace(/,/g, ''));
  return Number.isFinite(n) ? n / scale : NaN;
}
function decimalsOf(v) {
  // 注意：空值必须返回 undefined。Number('') === 0 是合法整数，
  // 若不先挡掉，缺失的 f59 会被当成「0 位小数」，价格直接被放大 100 倍
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  return Number.isInteger(n) && n >= 0 && n <= 6 ? n : undefined;
}
// 精度优先取 f59，缺省时退回 f152，再退回港股 1000 / 其余 100
// （f152 是东财的备用精度字段，早年只写了签名没用上，导致缺 f59 时精度会算错）
function scaleFor(stock, f59, f152) {
  const a = decimalsOf(f59);
  if (a !== undefined) return 10 ** a;
  const b = decimalsOf(f152);
  if (b !== undefined) return 10 ** b;
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
  // 少数标的的东财市场号不能按交易所推（中证2000 就是 2.932000，不是 1.932000），
  // 内置表里显式写了 secid 的优先用它
  if (stock.secid) return stock.secid;
  if (stock.sourceIds && stock.sourceIds.eastmoney) return stock.sourceIds.eastmoney;
  const market = stock.market || guessMarket(stock.code);
  let prefix;
  if (market === 'BOARD') prefix = '90';       // 东方财富板块：90.BK0475
  else if (market === 'HK') prefix = '116';
  // 美股：市场号跟着交易所走（105 纳斯达克 / 106 纽交所 / 107 AMEX）。
  // 写死 100 是错的 —— 东财根本没有 100 这个美股市场号，请求会返回 rc:100 空数据
  else if (market === 'US') prefix = US_SECID_PREFIX[usSuffixOf(stock)] || '105';
  else prefix = stock.exchange === 'SH' ? '1' : '0';
  return `${prefix}.${stock.code}`;
}

function guessMarket(code) {
  const c = String(code || '').trim();
  if (/^bk\d{4}$/i.test(c)) return 'BOARD';
  if (/^\d{5}$/.test(c)) return 'HK';
  if (/^(5|6|9)\d{5}$/.test(c) || /^(0|1|2|3)\d{5}$/.test(c) || /^(4|8)\d{5}$/.test(c)) return 'CN';
  return 'US';
}

// 用 QuoteID + Classify 反推市场（搜索结果必须用这个，不能靠代码前缀瞎猜）
function marketFromSuggest(item) {
  const quoteId = String(item.QuoteID || '');
  const head = Number(quoteId.split('.')[0]);
  const classify = String(item.Classify || '').toLowerCase();
  if (classify === 'hk') return { market: 'HK', exchange: 'HKEX' };
  // 东方财富板块：QuoteID 形如 90.BK0475，Classify=BK
  if (classify === 'bk' || head === 90) return { market: 'BOARD', exchange: 'BOARD' };
  if (head === 116) return { market: 'HK', exchange: 'HKEX' };
  // 美股：105 纳斯达克 / 106 纽交所 / 107 AMEX / 153 OTCBB(场外)
  if (head === 100 || head === 105 || head === 106 || head === 107 || head === 153) {
    return { market: 'US', exchange: 'OTHER_US' };
  }
  if (classify.includes('usstock')) return { market: 'US', exchange: 'OTHER_US' };
  const code = quoteId.split('.')[1] || item.Code || '';
  if (classify.includes('fund') && head === 1) return { market: 'CN', exchange: 'SH' };
  if (classify.includes('fund') && head === 0) return { market: 'CN', exchange: 'SZ' };
  if (code.startsWith('6')) return { market: 'CN', exchange: 'SH' };
  if (code.startsWith('8') || code.startsWith('4') || code.startsWith('9')) return { market: 'CN', exchange: 'BJ' };
  if (/^\d{6}$/.test(code)) return { market: 'CN', exchange: 'SZ' };
  // 指数：QuoteID 形如 2.H30184（沪市指数是 1.H…）
  if (/^h\d{5}$/i.test(code)) return { market: 'CN', exchange: head === 1 ? 'SH' : 'SZ' };
  if (/^\d{5}$/.test(code)) return { market: 'HK', exchange: 'HKEX' };
  return { market: 'US', exchange: 'OTHER_US' };
}

// 腾讯/新浪代码规则：sh600000 / sz000001 / bj899050 / hk00700
// 注意港股前缀是 hk（不是 hkex），美股是 us
const EXCHANGE_PREFIX = { SH: 'sh', SZ: 'sz', BJ: 'bj', HKEX: 'hk', HK: 'hk', OTHER_US: 'us' };

// 美股交易所后缀 → 东方财富 secid 前缀
// 东财美股市场号：105=纳斯达克 106=纽交所 107=美国交易所(AMEX/ARCA) 153=OTCBB(场外)
// 腾讯 smartbox 的美股代码自带交易所后缀（aapl.oq / baba.n / amdc.am / tctzf.ps），
// 正好能和东财的市场号对上：.oq→105、.n→106、.am→107、.ps→153。
const US_SECID_PREFIX = { OQ: '105', N: '106', A: '107', AM: '107', PS: '153' };
const US_DEFAULT_SUFFIX = 'OQ'; // 没带后缀时按纳斯达克算（多数美股在纳斯达克）
// 东财 QuoteID 的市场号 → 交易所后缀（反着推，用于 sourceIds 缺失时兜底）
const US_HEAD_SUFFIX = { 105: 'OQ', 106: 'N', 107: 'AM', 153: 'PS' };
// 猜错时的候选 secid（按顺序试）
const US_SECID_CANDIDATES = ['105', '106', '107', '153'];

function usSuffixOf(stock) {
  const raw = (stock && (stock.usSuffix
    || (stock.sourceIds && stock.sourceIds.usExchange)
    || '')) || '';
  return String(raw).replace(/^\./, '').toUpperCase() || US_DEFAULT_SUFFIX;
}

function tencentSymbol(stock) {
  // 腾讯的美股要带交易所后缀：usAAPL.OQ
  if (stock.market === 'US') {
    return `us${String(stock.code).toUpperCase()}.${usSuffixOf(stock)}`;
  }
  const prefix = EXCHANGE_PREFIX[stock.exchange] || 'sh';
  return `${prefix}${stock.code}`.toLowerCase();
}

function sinaSymbol(stock) {
  // 新浪的美股前缀是 gb_（不是 us_），且不带交易所后缀
  if (stock.market === 'US') {
    return `gb_${String(stock.code).toLowerCase()}`;
  }
  return tencentSymbol(stock);
}

// ---- 东财单只行情 ----
// 美股在东财的市场号有 105/106/107 三个，猜错了就取不到数据。
// 这里按「推断值优先、其余兜底」给出候选序列，逐个试到有数据为止。
const usSecidCache = new Map(); // code -> 已确认可用的 secid（如 107.TCTZF）

function eastmoneySecidCandidates(stock) {
  if (stock.sourceIds && stock.sourceIds.eastmoney) return [stock.sourceIds.eastmoney];
  const market = stock.market || guessMarket(stock.code);
  if (market !== 'US') return [eastmoneySecid(stock)];
  const cached = usSecidCache.get(String(stock.code).toUpperCase());
  const primary = cached || eastmoneySecid(stock);
  const others = US_SECID_CANDIDATES
    .map((p) => `${p}.${stock.code}`)
    .filter((s) => s !== primary);
  return [primary, ...others];
}

// 「请求通了但没数据」要和其它错误区分开：前者说明 secid 的市场号猜错了，换一个候选；
// 后者是网络/接口挂了，换主机也没用。
function emptyDataError(msg) {
  const e = new Error(msg);
  e.emptyData = true;
  return e;
}

// 依次尝试候选 secid（只对「空数据」重试，网络错误直接抛）
async function withSecidFallback(stock, fn) {
  const candidates = eastmoneySecidCandidates(stock);
  let lastErr = null;
  for (const secid of candidates) {
    try {
      return await fn(secid);
    } catch (e) {
      lastErr = e;
      if (!e || !e.emptyData) throw e;
    }
  }
  throw lastErr || new Error('no secid candidate worked');
}

async function fetchOneEastmoney(stock) {
  const candidates = eastmoneySecidCandidates(stock);
  let lastErr = null;
  for (const host of EASTMONEY_HOSTS) {
    for (const secid of candidates) {
      const url = `https://${host}/api/qt/stock/get?secid=${encodeURIComponent(secid)}&fields=${EASTMONEY_FIELDS}&ut=${EASTMONEY_UT}&fltt=1&invt=2&_=${Date.now()}`;
      try {
        // 单 host 4 秒超时：被墙时双 host 最多卡 8 秒，不再 16 秒+
        const res = await fetchWithTimeout(url, {
          headers: { Referer: 'https://quote.eastmoney.com/', 'User-Agent': UA },
        }, 4000);
        if (!res.ok) throw new Error(`eastmoney http ${res.status}`);
        const data = await res.json();
        const r = data && data.data;
        // 请求通了但没数据 → 多半是美股市场号猜错了，换下一个候选继续试
        if (!r || typeof r !== 'object' || r.f43 == null) {
          lastErr = emptyDataError('eastmoney empty data');
          continue;
        }
        if (stock.market === 'US') usSecidCache.set(String(stock.code).toUpperCase(), secid);
        const scale = scaleFor(stock, r.f59, r.f152);
        const price = numScale(r.f43, scale);
        const preClose = numScale(r.f60, scale);
        const change = numScale(r.f169, scale);
        const changePercent = pct100(r.f170);
        const name = typeof r.f58 === 'string' && r.f58 ? r.f58 : stock.name;
        // 展示精度同样优先 f59，其次 f152，最后按品种兜底（基金/可转债 3 位）
        const f59 = decimalsOf(r.f59);
        const f152 = decimalsOf(r.f152);
        const decimals = f59 !== undefined ? f59 : (f152 !== undefined ? f152 : classifyCode(stock.code).decimals);
        const vr = toNum(r.f50); // 量比（×100）
        return {
          stockId: stock.id, code: stock.code, name,
          latestPrice: price, changePercent, changeAmount: change,
          preClose, open: numScale(r.f46, scale), high: numScale(r.f44, scale), low: numScale(r.f45, scale),
          volume: toNum(r.f47), volumeRatio: Number.isFinite(vr) ? vr / 100 : NaN,
          decimals,
          ok: Number.isFinite(price), updatedAt: Date.now(),
        };
      } catch (e) {
        lastErr = e;
        // 网络/接口错误：换备用域名（同一主机下换 secid 也没用）
        break;
      }
    }
  }
  throw lastErr || new Error('eastmoney failed');
}

// ---- 东财批量接口（ulist.np） ----
// stock/get 是一只一个请求：自选十几只时每轮要发十几个请求，全压在 push2.eastmoney.com
// 一个域名上容易触发限流。ulist.np 能用 secids 一次拿全部，实测 7 个标的（A股/ETF/港股/
// 美股/板块/指数）批量与逐只的数值 100% 一致，单次可带 150 个 secid。
//
// 字段口径和 stock/get 不同（注意对照）：
//   f2=最新价 f3=涨跌幅% f4=涨跌额 f5=成交量 f6=成交额
//   f12=代码 f13=市场 f14=名称 f15=最高 f16=最低 f17=今开 f18=昨收
// 批量接口**没有** f59（精度）和 f50（量比）：
//   - 精度用 classifyCode 兜底（A股 2 / 港美股 3 / 基金债 3 / 板块 2，与 f59 一致）
//   - 量比只有开了「成交量异动」提醒的股票才单独再取一次单只接口
const ULIST_FIELDS = 'f2,f3,f4,f5,f6,f12,f13,f14,f15,f16,f17,f18';
const ULIST_CHUNK = 60;   // 每个请求带的 secid 数（URL 长度约 800 字符，很宽裕）

async function fetchEastmoneyBatch(stocks) {
  const now = Date.now();
  // 每个标的的候选 secid：美股市场号可能猜错，候选全放进同一个批量请求，
  // 接口只会返回有数据的那一行，天然完成「猜错→换候选」的自愈
  const wanted = new Map();       // secid -> stock
  const order = [];               // 保持请求顺序，便于分块
  for (const s of stocks) {
    for (const secid of eastmoneySecidCandidates(s)) {
      if (!wanted.has(secid)) { wanted.set(secid, s); order.push(secid); }
    }
  }
  const picked = new Map();       // stockId -> 行数据
  for (let i = 0; i < order.length; i += ULIST_CHUNK) {
    const chunk = order.slice(i, i + ULIST_CHUNK);
    const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?secids=${encodeURIComponent(chunk.join(','))}`
      + `&fltt=2&invt=2&ut=${EASTMONEY_UT}&fields=${ULIST_FIELDS}`;
    const res = await fetchWithTimeout(url, {
      headers: { Referer: 'https://quote.eastmoney.com/', 'User-Agent': UA },
    }, 6000);
    if (!res.ok) throw new Error(`eastmoney batch http ${res.status}`);
    const data = await res.json();
    for (const row of ((data && data.data && data.data.diff) || [])) {
      const key = `${row.f13}.${row.f12}`;
      const stock = wanted.get(key);
      if (!stock) continue;
      const price = toNum(row.f2);
      if (!Number.isFinite(price)) continue;      // 这行没数据 → 交给下一个候选
      if (picked.has(stock.id)) continue;          // 已经拿到能用的行了
      picked.set(stock.id, row);
      if (stock.market === 'US') usSecidCache.set(String(stock.code).toUpperCase(), key);
    }
  }
  return stocks.map((s) => {
    const row = picked.get(s.id);
    if (!row) return { stockId: s.id, code: s.code, name: s.name, ok: false, updatedAt: now };
    const price = toNum(row.f2);
    return {
      stockId: s.id, code: s.code, name: row.f14 || s.name,
      latestPrice: price,
      changePercent: toNum(row.f3),
      changeAmount: toNum(row.f4),
      preClose: toNum(row.f18),
      open: toNum(row.f17), high: toNum(row.f15), low: toNum(row.f16),
      volume: toNum(row.f5),
      volumeRatio: NaN,          // 批量接口没有量比，需要时单独再取
      decimals: classifyCode(s.code).decimals,
      ok: Number.isFinite(price), updatedAt: now,
    };
  });
}

// 批量接口挂了时的退路：逐只请求（自带备用域名）
async function fetchEastmoneyOneByOne(stocks) {
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

// opts.volumeRatioIds: 需要量比的股票 id 集合（只有开了「成交量异动」提醒的才有）
async function fetchEastmoney(stocks, opts = {}) {
  if (!stocks.length) return [];
  let rows;
  try {
    rows = await fetchEastmoneyBatch(stocks);
  } catch (e) {
    rows = await fetchEastmoneyOneByOne(stocks);
  }
  // 量比：批量接口拿不到，单独再取一次单只接口（通常 0~1 只）
  const need = stocks.filter((s) => opts.volumeRatioIds && opts.volumeRatioIds.has(s.id));
  if (need.length) {
    const extra = await Promise.all(need.map((s) => fetchOneEastmoney(s).catch(() => null)));
    for (const e of extra) {
      if (!e) continue;
      const r = rows.find((x) => x.stockId === e.stockId);
      if (!r) continue;
      if (Number.isFinite(e.volumeRatio)) r.volumeRatio = e.volumeRatio;
      if (Number.isInteger(e.decimals)) r.decimals = e.decimals;
      if (e.name) r.name = e.name;
    }
  }
  return rows;
}

// ---- K 线 / 分时（东财历史行情，与实时行情同一套 secid 规则） ----
// klt: 101 日K / 102 周K / 103 月K；fqt=1 前复权；lmt 取最近 N 根。
// 历史接口的 ut 与实时接口不同，沿用东财公开的常量即可。
const KLINE_UT = 'f057cbcbce2a86e2866ab8877db1d059';
const KLINE_PERIODS = { day: 101, week: 102, month: 103 };

// 严格转数字：空串/缺失返回 NaN，避免 Number('')===0 把缺值当成 0
function toNum(v) {
  if (v === undefined || v === null || v === '') return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

async function fetchKline(stock, period = 'day', limit = 160) {
  const klt = KLINE_PERIODS[period] || 101;
  const n = Math.min(Math.max(Number(limit) || 160, 30), 800);
  // 美股的市场号可能猜错，逐个候选 secid 试到有数据为止
  return withSecidFallback(stock, async (secid) => {
    // 关键：必须带 end（一个足够远的日期即可），否则东财返回 rc:102 / data:null，
    // 表现就是「分时能看、日周月K全空」（分时走的是另一个 trends2 接口）
    const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${encodeURIComponent(secid)}&klt=${klt}&fqt=1&lmt=${n}&end=20500101&iscca=1`
      + `&fields1=f1,f2,f3,f4,f5&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f61&ut=${KLINE_UT}`;
    const res = await fetchWithTimeout(url, {
      headers: { Referer: 'https://quote.eastmoney.com/', 'User-Agent': UA },
    }, 8000);
    if (!res.ok) throw new Error(`kline http ${res.status}`);
    const data = await res.json();
    const d = data && data.data;
    if (!d || !Array.isArray(d.klines) || !d.klines.length) {
      throw emptyDataError(`无${period === 'day' ? '日' : period === 'week' ? '周' : '月'}K数据`);
    }
    // 每行：日期,开,收,高,低,量,额,振幅,涨跌幅,换手率（f51..f59,f61）
    const klines = d.klines.map((line) => {
      const p = String(line).split(',');
      return {
        date: p[0],
        open: toNum(p[1]), close: toNum(p[2]), high: toNum(p[3]), low: toNum(p[4]),
        volume: toNum(p[5]), amount: toNum(p[6]), amplitude: toNum(p[7]), changePercent: toNum(p[8]),
        turnover: toNum(p[9]), // 换手率 %
      };
    }).filter((k) => Number.isFinite(k.close) && Number.isFinite(k.open));
    const dec = decimalsOf(d.decimal);
    return {
      code: stock.code,
      name: d.name || stock.name || stock.code,
      decimals: dec !== undefined ? dec : classifyCode(stock.code).decimals,
      klines,
    };
  });
}

// 分时：f51 时间, f53 现价, f56 成交量, f58 均价
async function fetchTrends(stock) {
  return withSecidFallback(stock, async (secid) => {
    const url = 'https://push2.eastmoney.com/api/qt/stock/trends2/get?secid=' + encodeURIComponent(secid)
      + `&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13&fields2=f51,f53,f56,f58&iscr=0&iscca=0&ndays=1&ut=${KLINE_UT}`;
    const res = await fetchWithTimeout(url, {
      headers: { Referer: 'https://quote.eastmoney.com/', 'User-Agent': UA },
    }, 8000);
    if (!res.ok) throw new Error(`trends http ${res.status}`);
    const data = await res.json();
    const d = data && data.data;
    if (!d || !Array.isArray(d.trends) || !d.trends.length) throw emptyDataError('无分时数据');
    const trends = d.trends.map((line) => {
      const p = String(line).split(',');
      return { time: p[0], price: toNum(p[1]), volume: toNum(p[2]), avgPrice: toNum(p[3]) };
    }).filter((t) => Number.isFinite(t.price));
    const dec = decimalsOf(d.decimal);
    return {
      code: stock.code,
      name: d.name || stock.name || stock.code,
      preClose: toNum(d.prePrice),
      decimals: dec !== undefined ? dec : classifyCode(stock.code).decimals,
      trends,
    };
  });
}

// 单只实时明细：今开/昨收/今高/今低/成交量/成交额/换手率（K线窗口顶部信息条用）
// f44 高 / f45 低 / f46 开 / f47 成交量(手) / f48 成交额(元) / f60 昨收 / f168 换手率(×100)
async function fetchStockDetail(stock) {
  return withSecidFallback(stock, async (secid) => {
    const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${encodeURIComponent(secid)}&fields=f43,f44,f45,f46,f47,f48,f58,f59,f60,f152,f168,f169,f170`
      + `&ut=${EASTMONEY_UT}&fltt=1&invt=2&_=${Date.now()}`;
    const res = await fetchWithTimeout(url, {
      headers: { Referer: 'https://quote.eastmoney.com/', 'User-Agent': UA },
    }, 6000);
    if (!res.ok) throw new Error(`detail http ${res.status}`);
    const data = await res.json();
    const r = data && data.data;
    if (!r || r.f43 == null) throw emptyDataError('detail empty data');
    const scale = scaleFor(stock, r.f59, r.f152);
    const dec = decimalsOf(r.f59);
    const dec152 = decimalsOf(r.f152);
    return {
      code: stock.code,
      name: typeof r.f58 === 'string' && r.f58 ? r.f58 : (stock.name || stock.code),
      latestPrice: numScale(r.f43, scale),
      preClose: numScale(r.f60, scale),
      open: numScale(r.f46, scale),
      high: numScale(r.f44, scale),
      low: numScale(r.f45, scale),
      changeAmount: numScale(r.f169, scale),
      changePercent: pct100(r.f170),
      volume: toNum(r.f47), // 手
      amount: toNum(r.f48), // 元
      turnover: Number.isFinite(toNum(r.f168)) ? toNum(r.f168) / 100 : NaN, // 换手率 %
      decimals: dec !== undefined ? dec : (dec152 !== undefined ? dec152 : classifyCode(stock.code).decimals),
    };
  });
}

// 新浪行情行解析
// 注意：港股的字段布局和 A 股不一样！
//   A 股：名称,今开,昨收,现价,最高,最低,...        → 现价在 parts[3]
//   港股：英文名,中文名,今开,昨收,最高,最低,现价,... → 现价在 parts[6]
// 之前没分派，取 parts[3] 会把「昨收」当成现价显示，港股价格整个是错的。
function parseSinaLine(line) {
  const m = line.match(/hq_str_([a-z]{2}_?[a-z0-9]*)="([^"]*)"/);
  if (!m) return null;
  const symbol = m[1];
  const parts = m[2].split(',');
  if (parts.length < 4) return null;

  // 新浪美股（前缀 gb_）：名称,现价,涨跌幅%,时间,涨跌额,买价,卖价,最低,最高,...
  // 又是另一套布局，和 A 股 / 港股都不一样
  if (symbol.startsWith('gb_')) {
    if (parts.length < 5) return null;
    const latestPrice = parseFloat(parts[1]);
    const changePercent = parseFloat(parts[2]);
    const changeAmount = parseFloat(parts[4]);
    if (!Number.isFinite(latestPrice)) return null;
    return {
      symbol,
      name: parts[0],
      latestPrice,
      changePercent: Number.isFinite(changePercent) ? changePercent : NaN,
      changeAmount: Number.isFinite(changeAmount) ? changeAmount : NaN,
    };
  }

  if (symbol.startsWith('hk')) {
    if (parts.length < 7) return null;
    const name = parts[1] || parts[0];
    const latestPrice = parseFloat(parts[6]);
    const prevClose = parseFloat(parts[3]);
    if (!Number.isFinite(latestPrice) || !Number.isFinite(prevClose) || prevClose === 0) return null;
    const changeAmount = latestPrice - prevClose;
    return { symbol, name, latestPrice, changePercent: (changeAmount / prevClose) * 100, changeAmount };
  }

  const name = parts[0];
  const latestPrice = parseFloat(parts[3]);
  const prevClose = parseFloat(parts[2]);
  if (!Number.isFinite(latestPrice) || !Number.isFinite(prevClose) || prevClose === 0) return null;
  const changeAmount = latestPrice - prevClose;
  return { symbol, name, latestPrice, changePercent: (changeAmount / prevClose) * 100, changeAmount };
}

async function fetchSina(stocks) {
  if (!stocks.length) return [];
  // 新浪没有东方财富板块（BKxxxx），板块只能由东财提供，这里先过滤掉，
  // 否则会拼出 shbk0475 这种不存在的 symbol 白白发一次请求
  const supported = stocks.filter((s) => s.market !== 'BOARD');
  if (!supported.length) {
    return stocks.map((s) => ({ stockId: s.id, code: s.code, name: s.name, ok: false, updatedAt: Date.now() }));
  }
  const symbols = supported.map(sinaSymbol).join(',');
  // HTTPS 优先（部分网络封 80 端口），失败再回退 HTTP
  const urls = [
    `https://hq.sinajs.cn/list=${symbols}`,
    `http://hq.sinajs.cn/list=${symbols}`,
  ];
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
      changeAmount: p.changeAmount, decimals: classifyCode(s.code).decimals, ok: true, updatedAt: now,
    };
  });
}

// 注：腾讯行情通道（qt.gtimg.cn）已下线 —— 行情只走东财（批量）+ 新浪（备份）。
// 腾讯 smartbox 仍在用，但只作搜索通道。

// 按 stockId 逐只取第一个 ok 的结果（谁先成功用谁，可相互补全），并记录实际用到的通道。
// outGroups 与 names 一一对应，索引顺序即优先级。主进程的渐进式合并也复用这个函数，
// 避免「主进程一套、Provider 一套」两份合并逻辑逐渐漂移。
const PROVIDER_NAMES = ['eastmoney', 'sina', 'tencent'];
function mergeQuoteRows(stocks, outGroups, names = PROVIDER_NAMES) {
  const used = new Set();
  const now = Date.now();
  const rows = stocks.map((s) => {
    for (let i = 0; i < outGroups.length; i++) {
      const q = (outGroups[i] || []).find((r) => r.stockId === s.id);
      if (q && q.ok) {
        used.add(names[i]);
        return q;
      }
    }
    return { stockId: s.id, code: s.code, name: s.name, ok: false, updatedAt: now };
  });
  return { rows, source: used.size ? [...used].join('+') : 'none' };
}

// ---- 搜索 ----
// smartbox 回的是字面量 \uXXXX 转义串（6 个 ASCII 字符），必须先解码，否则界面显示 \u6d66…
function unescapeUnicode(s) {
  return String(s || '').replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}
// ---- 品种归类（股票 / 基金 / 可转债 / 指数 / 港美股） ----
// 用途：1) 纯代码添加时推断交易所（5xxxxx 是沪市基金，11xxxx 是沪市可转债，不能一律当深市）
//       2) 界面区分 ETF / LOF / 可转债，不把基金当股票看
//       3) 决定价格小数位（基金、可转债是 3 位）
const FUND_PREFIX_SH = /^(5)\d{5}$/;            // 50/51/52/53/56/58xxxx 沪市基金
const FUND_PREFIX_SZ = /^(15|16|18)\d{4}$/;     // 15/16/18xxxx 深市基金
const BOND_PREFIX_SH = /^(110|111|113|132)\d{3}$/; // 沪市可转债/可交换债
const BOND_PREFIX_SZ = /^(12)\d{4}$/;           // 123/127/128/120 深市可转债

function classifyCode(code) {
  const c = String(code || '').trim();
  // 东方财富板块：BK + 4 位数字（BK0475 银行Ⅱ）。显示的是指数点位，2 位小数
  if (/^bk\d{4}$/i.test(c)) return { exchange: 'BOARD', securityType: 'board', decimals: 2 };
  // 港股：5 位数字（00700 腾讯控股），报价 3 位小数
  if (/^\d{5}$/.test(c)) return { exchange: 'HKEX', securityType: 'stock', decimals: 3 };
  // 美股：字母代码（AAPL / NVDA），报价 3 位小数
  if (/^[A-Z]{1,6}$/.test(c)) return { exchange: 'OTHER_US', securityType: 'stock', decimals: 3 };
  if (!/^\d{6}$/.test(c)) return { exchange: 'SH', securityType: 'stock', decimals: 2 };

  if (BOND_PREFIX_SH.test(c)) return { exchange: 'SH', securityType: 'bond', decimals: 3 };
  if (BOND_PREFIX_SZ.test(c)) return { exchange: 'SZ', securityType: 'bond', decimals: 3 };
  if (FUND_PREFIX_SH.test(c)) return { exchange: 'SH', securityType: 'fund', decimals: 3 };
  if (FUND_PREFIX_SZ.test(c)) return { exchange: 'SZ', securityType: 'fund', decimals: 3 };

  if (c.startsWith('6')) return { exchange: 'SH', securityType: 'stock', decimals: 2 };
  if (c.startsWith('0') || c.startsWith('3')) return { exchange: 'SZ', securityType: 'stock', decimals: 2 };
  if (c.startsWith('4') || c.startsWith('8') || c.startsWith('9')) return { exchange: 'BJ', securityType: 'stock', decimals: 2 };
  return { exchange: 'SZ', securityType: 'stock', decimals: 2 };
}

// 主通道：腾讯 smartbox（免 token，实测支持代码/名称/拼音缩写，网络兼容最好）
// 格式：v_hint="sh~600000~浦发银行~pfyh~GP-A^sz~000600~建投能源~jtny~GP-A^..."
// 条目：market~code~name~pinyin~type
// type 实测取值：GP-A=A股、GP=港/美股、ETF=场内基金、KJ*=场外基金（不可交易，过滤掉）
function parseSmartbox(text) {
  const m = String(text || '').match(/v_hint="([^"]*)"/);
  if (!m || !m[1]) return [];
  return m[1].split('^').map((entry) => {
    const parts = entry.split('~');
    if (parts.length < 5) return null;
    const [mk, code, name, , rawType] = parts;
    if (!code || !name) return null;
    const type = String(rawType || '').toUpperCase();
    // 场外基金（KJ*）和场外基金市场（jj）不能交易，直接排除
    if (mk === 'jj' || type.startsWith('KJ')) return null;
    // 只收：A/B股、港美股、场内基金、债券/可转债
    const tradable = type.startsWith('GP') || type === 'ETF' || type === 'LOF' || type.startsWith('ZQ');
    if (!tradable) return null;

    let market = 'CN';
    let exchange = 'SH';
    if (mk === 'sh') { market = 'CN'; exchange = 'SH'; }
    else if (mk === 'sz') { market = 'CN'; exchange = 'SZ'; }
    else if (mk === 'bj') { market = 'CN'; exchange = 'BJ'; }
    else if (mk === 'hk') { market = 'HK'; exchange = 'HKEX'; }
    else if (mk === 'us') { market = 'US'; exchange = 'OTHER_US'; }
    else return null;

    let securityType = 'stock';
    if (type === 'ETF' || type === 'LOF') securityType = 'fund';
    else if (type.startsWith('ZQ')) securityType = 'bond';
    if (securityType === 'stock' && market === 'CN') {
      // 兜底：smartbox 偶尔把基金标成 GP，用代码前缀再核一次
      securityType = classifyCode(code).securityType;
    }

    const cleanCode = market === 'US' ? code.split('.')[0].toUpperCase() : code;
    // 美股要记住交易所后缀（.oq=纳斯达克 .n=纽交所 .am=AMEX）：
    // 腾讯 smartbox 不给东财的 secid，得靠它反推市场号，否则请求会落空
    const usSuffix = market === 'US' ? String(code.split('.')[1] || '').toUpperCase() : '';
    const realName = unescapeUnicode(name);
    return {
      code: cleanCode, name: realName, market, exchange, securityType,
      usSuffix, label: `${realName} ${cleanCode}`, sourceIds: {},
    };
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
      const securityType = typeFromSuggest(d);
      // 美股：东财的 QuoteID 自带市场号（105/106/107），顺手转成交易所后缀，
      // 这样即使 sourceIds 丢了也能反推出正确的 secid
      const usSuffix = market === 'US'
        ? (US_HEAD_SUFFIX[Number(String(d.QuoteID).split('.')[0])] || US_DEFAULT_SUFFIX)
        : '';
      const label = d.Name ? `${d.Name} ${d.Code}` : String(d.Code);
      return { code: d.Code, name: d.Name || d.Code, market, exchange, securityType, usSuffix, label, sourceIds: { eastmoney: d.QuoteID } };
    });
}

// 东财 suggest 的品种归类：Classify / SecurityType / SecurityTypeName 任一能看出来即可
function typeFromSuggest(item) {
  const c = String(item.Classify || '').toLowerCase();
  const sn = String(item.SecurityTypeName || '').toLowerCase();
  const st = String(item.SecurityType || '').toLowerCase();
  const all = `${c} ${sn} ${st}`;
  // 板块：Classify=BK / SecurityTypeName=板块
  if (c === 'bk' || sn.includes('板块')) return 'board';
  if (all.includes('index') || all.includes('指数')) return 'index';
  if (all.includes('fund') || all.includes('etf') || all.includes('lof') || all.includes('基金')) return 'fund';
  if (all.includes('bond') || all.includes('债')) return 'bond';
  if (all.includes('usstock') || all.includes('美股') || all.includes('hk') || all.includes('港股')) return 'stock';
  return 'stock';
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
    // 新浪 suggest 的品种字段不统一，用代码前缀兜底判定
    out.push({ code, name, market: 'CN', exchange, securityType: classifyCode(code).securityType, label: `${name} ${code}`, sourceIds: {} });
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
    const securityType = market === 'CN' ? classifyCode(code).securityType : 'stock';
    out.push({ code, name, market, exchange: exMap[m[1]] || 'SH', securityType, label: `${name} ${code}`, sourceIds: {} });
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

// 连通性测试：三条行情通道各打一发，用来判断「当前网络/代理到底通不通」
// 与自检的区别：只测 3 条、超时更短（4s），适合在设置里随手点一下
async function connectivityTest() {
  const jobs = [
    () => probe(
      '腾讯',
      'https://smartbox.gtimg.cn/s3/?q=600000&t=all',
      { Referer: 'https://gu.qq.com/', 'User-Agent': UA },
      (buf) => (parseSmartbox(buf.toString('utf8')).length ? { ok: true, detail: '正常' } : { ok: false, detail: '无结果' }),
      4000,
    ),
    () => probe(
      '东财',
      `https://push2.eastmoney.com/api/qt/stock/get?secid=1.600000&fields=f43,f58&ut=${EASTMONEY_UT}&fltt=1&invt=2&_=${Date.now()}`,
      { Referer: 'https://quote.eastmoney.com/', 'User-Agent': UA },
      (buf) => {
        try {
          const d = JSON.parse(buf.toString('utf8'));
          return (d && d.data && d.data.f43 != null) ? { ok: true, detail: '正常' } : { ok: false, detail: '无数据' };
        } catch { return { ok: false, detail: '解析失败' }; }
      },
      4000,
    ),
    () => probe(
      '新浪',
      'https://hq.sinajs.cn/list=sh600000',
      { Referer: 'https://finance.sina.com.cn/', 'User-Agent': UA },
      (buf) => (parseSinaLine(buf.toString('latin1').split(';')[0] || '') ? { ok: true, detail: '正常' } : { ok: false, detail: '无数据' }),
      4000,
    ),
  ];
  const results = await Promise.all(jobs.map((f) => f()));
  return results;
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
      '东财行情(批量 ulist.np)', `https://push2.eastmoney.com/api/qt/ulist.np/get?secids=${encodeURIComponent('1.600000,0.000001')}&fltt=2&invt=2&ut=${EASTMONEY_UT}&fields=${ULIST_FIELDS}`,
      { Referer: 'https://quote.eastmoney.com/', 'User-Agent': UA },
      (buf) => {
        try {
          const d = JSON.parse(buf.toString('utf8'));
          const rows = (d && d.data && d.data.diff) || [];
          return rows.length
            ? { ok: true, detail: `通，${rows.length}条，首条=${rows[0].f14}` }
            : { ok: false, detail: '通但 0 条结果' };
        } catch { return { ok: false, detail: '通但 JSON 解析失败' }; }
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

// 纯 6 位代码直通：不依赖任何搜索接口，按代码前缀推断交易所与品种
// 6→沪股，0/3→深股，4/8/9→北交所，5→沪市基金，15/16/18→深市基金，110/113→沪债，12→深债
function directCodeCandidate(keyword) {
  const code = String(keyword || '').trim();
  // 东方财富板块
  if (/^bk\d{4}$/i.test(code)) {
    const c = code.toUpperCase();
    return { code: c, name: c, market: 'BOARD', exchange: 'BOARD', securityType: 'board', label: `${c}（板块，直接添加）`, sourceIds: {} };
  }
  // 港股
  if (/^\d{5}$/.test(code)) {
    return { code, name: code, market: 'HK', exchange: 'HKEX', securityType: 'stock', label: `${code}（港股，直接添加）`, sourceIds: {} };
  }
  // 美股：字母代码。按纳斯达克算（多数美股在纳斯达克），精确值交给东财 suggest 校正。
  // 只认全大写：小写串多半是拼音缩写（gzmt=贵州茅台），不能当美股代码
  if (/^[A-Z]{1,6}$/.test(code)) {
    return { code, name: code, market: 'US', exchange: 'OTHER_US', securityType: 'stock', usSuffix: 'OQ', label: `${code}（美股，直接添加）`, sourceIds: {} };
  }
  if (!/^\d{6}$/.test(code)) return null;
  const { exchange, securityType } = classifyCode(code);
  return { code, name: code, market: 'CN', exchange, securityType, label: `${code}（直接添加）`, sourceIds: {} };
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
  classifyCode, typeFromSuggest,
  parseSinaLine, parseSmartbox, parseSinaSuggest, parseXueqiuSuggest, directCodeCandidate,
  fetchEastmoney, fetchSina, fetchOneEastmoney, mergeQuoteRows,
  KLINE_PERIODS, fetchKline, fetchTrends, fetchStockDetail,
  searchEastmoney, searchTencent, searchSina, searchXueqiu, searchStocks,
  selfTest, connectivityTest,
};

