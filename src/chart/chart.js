// 工位看盘 - K 线独立窗口
// 数据来自主进程 IPC（getKline / getTrends / getDetail），本页只负责画图。
let state = null;
let stock = null;
let period = 'day';
let chart = null;
let seq = 0;
let lastData = null;
let lastKind = 'kline';
let klineKlines = null;                       // 当前 K 线全量数据（缩放联动要用）
let klineZoom = { start: 55, end: 100 };      // 当前可见区间百分比

const $ = (id) => document.getElementById(id);
const PERIOD_LABEL = { trend: '分时', day: '日K', week: '周K', month: '月K' };
const MA_COLORS = ['#e8a33d', '#4a90e2', '#b06bd6', '#3bbf9a'];

// ---------- 主题 / 工具 ----------
function applyTheme() {
  const t = (state && state.settings && state.settings.main && state.settings.main.theme) || 'system';
  const dark = t === 'dark' || (t !== 'light' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

function chartColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (k, d) => (cs.getPropertyValue(k) || '').trim() || d;
  return {
    up: v('--up', '#d92d20'), down: v('--down', '#079455'),
    text: v('--text', '#1f2937'), muted: v('--muted', '#64748b'),
    border: v('--border', '#e2e8f0'), bg: v('--card', '#ffffff'),
    hover: v('--hover', '#f8fafc'), accent: v('--accent', '#336fff'), accentSoft: v('--accent-soft', '#eef2ff'),
  };
}

function fmtVol(v) {
  if (!Number.isFinite(v)) return '--';
  if (v >= 1e8) return (v / 1e8).toFixed(2) + '亿';
  if (v >= 1e4) return (v / 1e4).toFixed(2) + '万';
  return String(Math.round(v));
}

// 成交量副图 Y 轴刻度：紧凑写法，只标最大值（0 不标）
function fmtVolShort(v) {
  if (!Number.isFinite(v)) return '';
  if (v >= 1e8) return (v / 1e8).toFixed(1) + '亿';
  if (v >= 1e4) return (v / 1e4).toFixed(1) + '万';
  return String(Math.round(v));
}

function klineMa(values, n) {
  const out = [];
  for (let i = 0; i < values.length; i++) {
    if (i < n - 1) { out.push('-'); continue; }
    let sum = 0;
    for (let j = 0; j < n; j++) sum += values[i - j];
    out.push(+(sum / n).toFixed(3));
  }
  return out;
}

const setVolLabel = (text) => { const el = $('volLabel'); if (el) el.textContent = text; };

// 底部 X 轴：主图不显示日期、不显示指针时间标签，副图（最底部）才显示，
// 否则悬停时会在两张图各出现一个时间。
// 默认（日/周/月 K）只标首尾两个日期；alignMin/MaxLabel 防止首尾被贴边裁掉。
function catAxis(c, dates, gridIndex, isBottom, labelOpts) {
  const firstLast = {
    color: c.muted,
    interval: (i) => i === 0 || i === dates.length - 1,
    showMinLabel: true,
    showMaxLabel: true,
    alignMinLabel: 'left',
    alignMaxLabel: 'right',
    overflow: 'none', // 不截断首尾日期（曾出现 "2026-09-" 被截掉尾巴）
  };
  return {
    type: 'category',
    gridIndex,
    data: dates,
    scale: true,
    boundaryGap: false,
    axisLine: { lineStyle: { color: c.border } },
    axisTick: { show: false },
    splitLine: { show: false },
    axisLabel: isBottom ? (labelOpts || firstLast) : { show: false },
    axisPointer: { label: { show: !!isBottom } },
  };
}

// 当前缩放窗口对应的「可见第一根 / 最后一根」索引
function visibleBounds(n, zoom) {
  const vs = Math.max(0, Math.min(n - 1, Math.floor((n * zoom.start) / 100)));
  const ve = Math.max(vs, Math.min(n - 1, Math.ceil((n * zoom.end) / 100) - 1));
  return { vs, ve };
}

// 日/周/月 K 底部只标「可见区间首尾」两个日期。
// 注意不能标整段数据的首尾：默认缩放到 55%~100% 时，第 0 根在可视区外，根本不会显示。
function dateLabel(c, vs, ve) {
  return {
    color: c.muted,
    interval: (i) => i === vs || i === ve,
    showMinLabel: true,
    showMaxLabel: true,
    alignMinLabel: 'left',
    alignMaxLabel: 'right',
    overflow: 'none',
  };
}

// 板块涨跌停幅度（主板 10%、创业/科创 20%、北交所 30%；港美股不限）
function limitFracOf(s) {
  if (!s || s.market !== 'CN') return 0;
  const c = String(s.code || '');
  if (/^(30|68)/.test(c)) return 0.2;
  if (/^(4|8|9)/.test(c)) return 0.3;
  return 0.1;
}

// 以 base 为中轴、上下对称的区间（不做取整外扩）。
// 左右两条轴共用同一个 step，刻度严格对齐，且上/下沿正好是 half（分时就是板块涨跌停）。
function symmetricExtent(base, half, intervals = 4) {
  const b = Number.isFinite(base) && base ? base : 1;
  const h = half > 0 ? half : Math.abs(b) * 0.02;
  return { base: b, min: b - h, max: b + h, step: (h * 2) / intervals };
}

// 右侧涨跌幅轴：与左侧价格轴共用同一段 min/max/interval，只把刻度翻译成相对基准的百分比
function pctAxis(c, base, min, max, step) {
  return {
    position: 'right',
    gridIndex: 0,
    min,
    max,
    interval: step,
    axisLine: { show: false },
    axisTick: { show: false },
    splitLine: { show: false },
    axisLabel: {
      color: c.muted, fontSize: 10,
      // 0% 正好在中轴，不带正号
      formatter: (v) => {
        if (!base) return '';
        const p = ((v - base) / base) * 100;
        return Math.abs(p) < 0.005 ? '0.00%' : `${p > 0 ? '+' : ''}${p.toFixed(2)}%`;
      },
    },
  };
}

// 按「当前可见 K 线」算对称的涨跌幅轴：中轴 = 可见区间价格中点，默认 ±10%，
// 可见振幅超过 10%（如涨停板/长周期）时按实际放大，保证 K 线不被裁掉、0 永远居中
function klineVisibleExtent(klines, zoom) {
  const { vs, ve } = visibleBounds(klines.length, zoom);
  const vis = klines.slice(vs, ve + 1);
  const lo = Math.min(...vis.map((k) => k.low));
  const hi = Math.max(...vis.map((k) => k.high));
  const base = (lo + hi) / 2;
  // 默认至少「一个板块涨跌停」，可见振幅更大时按实际放大
  const half = Math.max(base * limitFracOf(stock), hi - base, base - lo);
  return symmetricExtent(base, half, 4);
}

function zoomSlider(c, start, end) {
  return {
    type: 'slider',
    xAxisIndex: [0, 1],
    bottom: 10,
    height: 18,
    start,
    end,
    borderColor: 'transparent',
    backgroundColor: c.hover,
    fillerColor: c.accentSoft,
    handleStyle: { color: c.accent, borderColor: c.accent },
    moveHandleStyle: { color: c.accent, opacity: 0.5 },
    dataBackground: { lineStyle: { color: c.border }, areaStyle: { color: c.hover } },
    selectedDataBackground: { lineStyle: { color: c.accent }, areaStyle: { color: c.accentSoft } },
    textStyle: { color: c.muted, fontSize: 9 },
  };
}

function tooltipBase(c) {
  return {
    trigger: 'axis',
    // 十字光标在两张图之间联动
    axisPointer: { type: 'cross', crossStyle: { color: c.muted }, label: { backgroundColor: 'rgba(0,0,0,.55)' } },
    borderWidth: 0,
    padding: [8, 11],
    backgroundColor: c.bg,
    extraCssText: `border-radius:9px;box-shadow:0 8px 24px rgba(15,23,42,.22);border:1px solid ${c.border}`,
    textStyle: { color: c.text, fontSize: 12 },
  };
}

const row = (label, val, cls) => `<div class="kt-row"><span>${label}</span><b class="${cls || ''}">${val}</b></div>`;

// ---------- 绘制 ----------
function renderKlineChart(data, keepZoom) {
  const c = chartColors();
  const d = data.decimals;
  klineKlines = data.klines;
  if (!keepZoom) klineZoom = { start: 55, end: 100 }; // 自动刷新时保留用户缩放位置
  const ax = klineVisibleExtent(klineKlines, klineZoom);
  const vb = visibleBounds(klineKlines.length, klineZoom);
  const dates = data.klines.map((k) => k.date);
  const closes = data.klines.map((k) => k.close);
  const values = data.klines.map((k) => [k.open, k.close, k.low, k.high]); // ECharts：开/收/低/高
  const vols = data.klines.map((k) => ({ value: k.volume, itemStyle: { color: k.close >= k.open ? c.up : c.down } }));
  chart.setOption({
    animation: false,
    backgroundColor: 'transparent',
    textStyle: { color: c.text, fontSize: 11 },
    legend: { top: 6, left: 'center', itemWidth: 14, itemHeight: 8, itemGap: 12, textStyle: { color: c.muted, fontSize: 11 }, data: ['K', 'MA5', 'MA10', 'MA20', 'MA30'] },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    tooltip: {
      ...tooltipBase(c),
      formatter: (ps) => {
        const k = ps.find((p) => p.seriesName === 'K');
        if (!k) return '';
        const r = data.klines[k.dataIndex];
        setVolLabel(`成交量 ${fmtVol(r.volume)}手`);
        const cls = r.changePercent >= 0 ? 'pct-up' : 'pct-down';
        const ma = (name) => { const s = ps.find((p) => p.seriesName === name); return s && s.value !== '-' ? Number(s.value).toFixed(d) : '--'; };
        return `<div class="kt-date">${r.date}</div>`
          + row('开', r.open.toFixed(d))
          + row('收', r.close.toFixed(d), cls)
          + row('高', r.high.toFixed(d))
          + row('低', r.low.toFixed(d))
          + row('涨跌', `${r.changePercent >= 0 ? '+' : ''}${r.changePercent.toFixed(2)}%`, cls)
          + row('量', `${fmtVol(r.volume)}手`)
          + row('额', fmtAmount(r.amount))
          + row('换手', Number.isFinite(r.turnover) ? `${r.turnover.toFixed(2)}%` : '--')
          + `<div class="kt-ma"><em style="color:${MA_COLORS[0]}">MA5 ${ma('MA5')}</em><em style="color:${MA_COLORS[1]}">MA10 ${ma('MA10')}</em><em style="color:${MA_COLORS[2]}">MA20 ${ma('MA20')}</em><em style="color:${MA_COLORS[3]}">MA30 ${ma('MA30')}</em></div>`;
      },
    },
    grid: [
      // 主图；副图用 bottom 预留固定像素给「底部日期 + 缩放条」，保证不会被裁
      { left: 74, right: 74, top: '5%', height: '60%' },
      { left: 74, right: 74, top: '69%', bottom: 48 },
    ],
    xAxis: [catAxis(c, dates, 0, false), catAxis(c, dates, 1, true, dateLabel(c, vb.vs, vb.ve))],
    yAxis: [
      // 价格轴与右侧涨跌幅轴共用同一 min/max/interval，刻度严格对齐；0% 在正中
      { min: ax.min, max: ax.max, interval: ax.step, splitLine: { lineStyle: { color: c.border, type: 'dashed' } }, axisLabel: { color: c.muted, formatter: (v) => (Number.isInteger(Number(v)) ? String(v) : Number(v).toFixed(d)) } },
      // 成交量不写死 max，避免把 1103 万标成 1000 万
      { gridIndex: 1, min: 0, splitNumber: 2, axisLabel: { show: true, color: c.muted, fontSize: 9, formatter: (v) => (v ? fmtVolShort(v) : '') }, axisLine: { show: false }, axisTick: { show: false }, splitLine: { show: false } },
      pctAxis(c, ax.base, ax.min, ax.max, ax.step),
    ],
    dataZoom: [
      { type: 'inside', xAxisIndex: [0, 1], start: klineZoom.start, end: klineZoom.end },
      zoomSlider(c, klineZoom.start, klineZoom.end),
    ],
    series: [
      { name: 'K', type: 'candlestick', data: values, itemStyle: { color: c.up, color0: c.down, borderColor: c.up, borderColor0: c.down } },
      { name: 'MA5', type: 'line', symbol: 'none', smooth: true, data: klineMa(closes, 5), lineStyle: { width: 1, color: MA_COLORS[0] } },
      { name: 'MA10', type: 'line', symbol: 'none', smooth: true, data: klineMa(closes, 10), lineStyle: { width: 1, color: MA_COLORS[1] } },
      { name: 'MA20', type: 'line', symbol: 'none', smooth: true, data: klineMa(closes, 20), lineStyle: { width: 1, color: MA_COLORS[2] } },
      { name: 'MA30', type: 'line', symbol: 'none', smooth: true, data: klineMa(closes, 30), lineStyle: { width: 1, color: MA_COLORS[3] } },
      { name: '成交量', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, barWidth: '60%', data: vols },
    ],
  }, true);
}

function renderTrendsChart(data) {
  const c = chartColors();
  const d = data.decimals;
  const times = data.trends.map((t) => String(t.time || '').split(' ')[1] || t.time);
  const prices = data.trends.map((t) => t.price);
  const pre = Number.isFinite(data.preClose) ? data.preClose : prices[0];
  const vols = data.trends.map((t, i) => ({ value: t.volume, itemStyle: { color: t.price >= (i ? data.trends[i - 1].price : pre) ? c.up : c.down } }));
  // 分时右侧涨跌幅轴固定以昨收为中轴：默认 ±10%（涨跌停），若当日振幅超过 10% 再按实际放大，
  // 这样 0% 永远在正中间，顶部 +10.00%、底部 -10.00%（超出时如 +20.00%）
  // 涨跌幅轴上下沿正好是板块涨跌停（主板 ±10%、创业/科创 ±20%、北交所 ±30%），
  // 当日振幅更大（新股等）才放大；港美股无涨跌停，至少 ±10% 便于观察
  const dev = Math.max(Math.abs(Math.max(...prices) - pre), Math.abs(pre - Math.min(...prices))) / (pre || 1);
  const halfFrac = Math.max(limitFracOf(stock) || 0.1, dev);
  const ext = symmetricExtent(pre, pre * halfFrac, 4);
  const timeLabel = {
    color: c.muted, fontSize: 10,
    // 整点 + 开盘/午休/收盘几个关键点；首尾（09:30 / 收盘）强制显示
    interval: (i, v) => i === 0 || i === times.length - 1 || /:00$/.test(v) || v === '11:30' || v === '15:00',
    formatter: (v) => (v === '11:30' ? '11:30/13:00' : (v === '13:00' ? '' : v)),
    showMinLabel: true,
    showMaxLabel: true,
    alignMinLabel: 'left',
    alignMaxLabel: 'right',
    overflow: 'none',
  };
  chart.setOption({
    animation: false,
    backgroundColor: 'transparent',
    textStyle: { color: c.text, fontSize: 11 },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    tooltip: {
      ...tooltipBase(c),
      formatter: (ps) => {
        const t = data.trends[ps[0].dataIndex];
        setVolLabel(`成交量 ${fmtVol(t.volume)}手`);
        const pct = pre ? ((t.price - pre) / pre) * 100 : 0;
        const cls = pct >= 0 ? 'pct-up' : 'pct-down';
        return `<div class="kt-date">${times[ps[0].dataIndex]}</div>`
          + row('价', t.price.toFixed(d), cls)
          + row('涨跌', `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`, cls)
          + row('量', `${fmtVol(t.volume)}手`);
      },
    },
    grid: [
      { left: 74, right: 74, top: '3%', height: '62%' },
      { left: 74, right: 74, top: '69%', bottom: 48 },
    ],
    xAxis: [catAxis(c, times, 0, false), catAxis(c, times, 1, true, timeLabel)],
    yAxis: [
      { min: ext.min, max: ext.max, interval: ext.step, splitLine: { lineStyle: { color: c.border, type: 'dashed' } }, axisLabel: { color: c.muted, formatter: (v) => Number(v).toFixed(d) } },
      // 同 K 线：不写死 max，交给 ECharts 取不小于最大成交量的整刻度
      { gridIndex: 1, min: 0, splitNumber: 2, axisLabel: { show: true, color: c.muted, fontSize: 9, formatter: (v) => (v ? fmtVolShort(v) : '') }, axisLine: { show: false }, axisTick: { show: false }, splitLine: { show: false } },
      pctAxis(c, pre, ext.min, ext.max, ext.step),
    ],
    series: [
      {
        name: '价格', type: 'line', data: prices, symbol: 'none', lineStyle: { width: 1.5, color: c.accent },
        markLine: { silent: true, symbol: 'none', label: { show: false }, lineStyle: { type: 'dashed', color: c.muted }, data: [{ yAxis: pre }] },
      },
      { name: '成交量', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, barWidth: '60%', data: vols },
    ],
  }, true);
}

function fmtAmount(v) {
  if (!Number.isFinite(v)) return '--';
  if (v >= 1e8) return (v / 1e8).toFixed(2) + '亿';
  if (v >= 1e4) return (v / 1e4).toFixed(2) + '万';
  return String(Math.round(v));
}

function draw(data, kind, keepZoom) {
  lastData = data;
  lastKind = kind;
  setVolLabel('成交量');
  // 先清空再画：切换周期/标的时彻底清掉旧坐标轴，避免残留脏刻度（曾出现 22.5205 / 9999999）
  if (chart) chart.clear();
  if (kind === 'kline') renderKlineChart(data, keepZoom);
  else renderTrendsChart(data);
}

// ---------- 数据 ----------
function selectPeriod(p) {
  period = p;
  [...document.querySelectorAll('#klineTabs button')].forEach((b) => b.classList.toggle('active', b.dataset.period === p));
  load();
}

async function load(opts = {}) {
  if (!stock) return;
  const my = ++seq;
  try {
    if (period === 'trend') {
      const data = await window.gongwei.getTrends(stock);
      if (my !== seq || !chart) return;
      setTitle();
      draw(data, 'trend');
    } else {
      const data = await window.gongwei.getKline(stock, period, 160);
      if (my !== seq || !chart) return;
      setTitle();
      draw(data, 'kline', opts.keepZoom);
    }
  } catch (e) {
    if (my !== seq) return;
    $('klineInfo').innerHTML = `<span class="ki ki-err"><i>${PERIOD_LABEL[period]}</i><b>${e.message}</b></span>`;
  }
}

function setTitle() {
  $('klineTitle').textContent = stock ? `${stock.name} ${stock.code}` : '';
}

async function loadDetail(s) {
  const box = $('klineInfo');
  try {
    const d = await window.gongwei.getDetail(s);
    const dec = Number.isInteger(d.decimals) ? d.decimals : 2;
    const num = (v) => (Number.isFinite(v) ? v.toFixed(dec) : '--');
    const cls = (v) => (Number.isFinite(v) && Number.isFinite(d.preClose) && v < d.preClose ? 'pct-down' : 'pct-up');
    const vol = Number.isFinite(d.volume) ? (d.volume / 1e4).toFixed(2) + '万手' : '--';
    const amt = Number.isFinite(d.amount) ? (d.amount / 1e8).toFixed(2) + '亿' : '--';
    const turn = Number.isFinite(d.turnover) ? d.turnover.toFixed(2) + '%' : '--';
    const cell = (label, val, klass) => `<span class="ki"><i>${label}</i><b class="${klass || ''}">${val}</b></span>`;
    box.innerHTML = cell('今开', num(d.open), cls(d.open))
      + cell('昨收', num(d.preClose), '')
      + cell('今高', num(d.high), cls(d.high))
      + cell('今低', num(d.low), cls(d.low))
      + cell('成交量', vol, '')
      + cell('成交额', amt, '')
      + cell('换手率', turn, '');
  } catch (e) {
    box.innerHTML = '<span class="ki ki-err"><i>明细</i><b>加载失败</b></span>';
  }
  // 明细填充后容器高度变了，等一帧等布局稳定再按像素重设
  setTimeout(() => sizeChartEl(), 0);
}

// 用容器像素尺寸显式设置图表 DOM 与 ECharts 画布，杜绝「画布比可视区高/宽 → 底部缩放条被裁」
function sizeChartEl() {
  const el = $('klineChart');
  const wrap = el && el.parentElement;
  if (!el || !wrap) return;
  const w = Math.max(200, wrap.clientWidth);
  const h = Math.max(120, wrap.clientHeight);
  el.style.width = `${w}px`;
  el.style.height = `${h}px`;
  if (chart) chart.resize({ width: w, height: h });
}

async function boot() {
  state = await window.gongwei.getStore();
  applyTheme();
  const el = $('klineChart');
  sizeChartEl(); // 先定死尺寸再 init
  chart = window.echarts && el ? window.echarts.init(el) : null;
  if (chart) chart.on('globalout', () => setVolLabel('成交量'));
  // 缩放时按可见区间重算对称涨跌幅轴（默认 ±10%，超出才放大）
  if (chart) {
    chart.on('dataZoom', () => {
      if (lastKind !== 'kline' || !klineKlines) return;
      const dz = (chart.getOption().dataZoom || [])[0] || {};
      klineZoom = {
        start: Number.isFinite(dz.start) ? dz.start : klineZoom.start,
        end: Number.isFinite(dz.end) ? dz.end : klineZoom.end,
      };
      const ax = klineVisibleExtent(klineKlines, klineZoom);
      const vb = visibleBounds(klineKlines.length, klineZoom);
      const c = chartColors();
      chart.setOption({
        xAxis: [{}, { axisLabel: dateLabel(c, vb.vs, vb.ve) }],
        yAxis: [{ min: ax.min, max: ax.max, interval: ax.step }, {}, pctAxis(c, ax.base, ax.min, ax.max, ax.step)],
      });
    });
  }
  // 明细条是异步填充的，会改变图表容器高度；容器一变就重设尺寸
  if (window.ResizeObserver && el.parentElement) {
    new window.ResizeObserver(() => sizeChartEl()).observe(el.parentElement);
  }
  $('klineTabs').onclick = (e) => {
    const b = e.target.closest('button[data-period]');
    if (b) selectPeriod(b.dataset.period);
  };
  window.gongwei.onStore((s) => { state = s; applyTheme(); if (lastData) draw(lastData, lastKind, true); });
  window.gongwei.onChartUpdate((s) => { if (s) { stock = s; load(); loadDetail(s); } });
  window.addEventListener('resize', () => { sizeChartEl(); });
  window.addEventListener('beforeunload', stopAutoRefresh);
  stock = await window.gongwei.getChartStock();
  if (!stock) { $('klineInfo').innerHTML = '<span class="ki ki-err"><i>提示</i><b>没有可显示的标的</b></span>'; return; }
  selectPeriod('trend'); // 默认打开分时
  loadDetail(stock);
  startAutoRefresh();
}

// 窗口开着时定时刷新：明细条 5s 一次，图表 30s 一次（保留缩放位置）
let detailTimer = null;
let chartTimer = null;
function startAutoRefresh() {
  stopAutoRefresh();
  detailTimer = setInterval(() => { if (!document.hidden && stock) loadDetail(stock); }, 5000);
  chartTimer = setInterval(() => { if (!document.hidden && stock) load({ keepZoom: true }); }, 30000);
}
function stopAutoRefresh() {
  if (detailTimer) clearInterval(detailTimer);
  if (chartTimer) clearInterval(chartTimer);
  detailTimer = null;
  chartTimer = null;
}

boot();
