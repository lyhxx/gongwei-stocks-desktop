// 工位看盘 - 提醒条件判定（纯函数，可单测；主进程只负责提供行情与历史采样）
//
// 条件字段见 common/defaults.js 的 blankAlert()。

// 涨跌停幅度：创业板/科创板 20%、北交所 30%、其余 A 股 10%；港美股不做涨跌停
function limitPctOf(stock) {
  if (!stock || stock.market !== 'CN') return 0;
  const c = String(stock.code || '');
  if (/^(30|68)/.test(c)) return 20;
  if (/^(4|8|9)/.test(c)) return 30;
  return 10;
}

function fmtPct(v) {
  return Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}%` : '--';
}

// 相对 N 分钟前（samples 中不晚于该时刻的最近一条）的涨跌幅 %
function rapidChangePct(samples, cur, minutes, now = Date.now()) {
  if (!samples || !samples.length) return NaN;
  const target = now - Math.max(1, Number(minutes) || 5) * 60 * 1000;
  let ref = null;
  for (const s of samples) { if (s.t <= target) ref = s; else break; }
  if (!ref) ref = samples[0];
  if (!ref || !ref.p) return NaN;
  return ((cur - ref.p) / ref.p) * 100;
}

// stocks: 自选数组；quotes: 行情行（含 ok/latestPrice/changePercent/volumeRatio）
// opts.history: Map<stockId, [{t,p}]> 供急涨急跌比对；opts.now: 当前时间戳
function checkAlerts(stocks, quotes, opts = {}) {
  const byId = new Map((quotes || []).map((q) => [q.stockId, q]));
  const history = opts.history;
  const now = opts.now || Date.now();
  const hits = [];
  for (const s of stocks || []) {
    const a = s.alert;
    if (!a || !a.enabled) continue;
    const q = byId.get(s.id);
    if (!q || !q.ok) continue;
    const reasons = [];
    if (typeof a.upperPrice === 'number' && q.latestPrice >= a.upperPrice) reasons.push(`价格达到 ${a.upperPrice}`);
    if (typeof a.lowerPrice === 'number' && q.latestPrice <= a.lowerPrice) reasons.push(`价格跌至 ${a.lowerPrice}`);
    // 涨幅/跌幅统一取绝对值，用户填 -5 也不会误触发
    if (typeof a.upperChangePercent === 'number' && q.changePercent >= Math.abs(a.upperChangePercent)) reasons.push(`涨幅达到 ${Math.abs(a.upperChangePercent)}%`);
    if (typeof a.lowerChangePercent === 'number' && q.changePercent <= -Math.abs(a.lowerChangePercent)) reasons.push(`跌幅达到 ${Math.abs(a.lowerChangePercent)}%`);
    // 涨跌停（接近即算）
    const lim = limitPctOf(s);
    if (lim && a.limitUp && q.changePercent >= lim - 0.15) reasons.push(`涨停附近（${fmtPct(q.changePercent)}）`);
    if (lim && a.limitDown && q.changePercent <= -(lim - 0.15)) reasons.push(`跌停附近（${fmtPct(q.changePercent)}）`);
    // 成交量异动（量比）
    if (a.volumeAnomaly && Number.isFinite(q.volumeRatio) && q.volumeRatio >= (Number(a.volumeRatio) || 2)) {
      reasons.push(`成交量异动（量比 ${q.volumeRatio.toFixed(2)}）`);
    }
    // N 分钟急涨急跌
    if (a.rapidEnabled && history) {
      const mins = Number(a.rapidMinutes) || 5;
      const pct = rapidChangePct(history.get(s.id), q.latestPrice, mins, now);
      const need = Number(a.rapidPercent) || 3;
      if (Number.isFinite(pct) && Math.abs(pct) >= need) {
        reasons.push(`${mins}分钟${pct > 0 ? '急涨' : '急跌'} ${Math.abs(pct).toFixed(2)}%`);
      }
    }
    if (reasons.length) {
      hits.push({ stockId: s.id, stockName: s.name, stockCode: s.code, latestPrice: q.latestPrice, changePercent: q.changePercent, reasons });
    }
  }
  return hits;
}

module.exports = { limitPctOf, rapidChangePct, checkAlerts, fmtPct };
