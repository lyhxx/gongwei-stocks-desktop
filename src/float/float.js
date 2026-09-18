// 工位看盘 - 浮窗逻辑（透明置顶）
// 结构：顶栏（更新时间 + 涨跌家数）→ 指数横排卡片 → 个股列表
let state = null;
let market = { stockQuotes: [], indexQuotes: [] };
let lastHeight = 0;

// 内容高度回报给主进程，让窗口贴合内容（否则底部透明区会挡住下方窗口的点击）。
// 必须同步测量，不能包在 requestAnimationFrame 里：窗口隐藏时 Chromium 会节流/暂停 rAF，
// 隐藏期间的高度就不会上报，重新显示时才补一次 resize —— 表现就是「打开浮窗闪一下」。
// innerHTML 写完后 getBoundingClientRect 会强制同步布局，读到的就是最新高度。
// force=true 时无条件回报（主进程在「显示前」会主动要一次高度，用来把尺寸定好再 show）
function syncHeight(force) {
  const card = document.querySelector('.card');
  if (!card) return;
  const h = Math.ceil(card.getBoundingClientRect().height);
  if (h > 40 && (force || Math.abs(h - lastHeight) > 2)) {
    lastHeight = h;
    window.gongwei.floatResize(h);
  }
}

// 指数中英文映射（前端内置兜底，名字显示不再依赖主进程推送）
const INDEX_NAMES = {
  shanghai: '上证指数', shenzhen: '深证成指', chinext: '创业板指',
  csi300: '沪深300', csi500: '中证500', csi1000: '中证1000', csi2000: '中证2000',
  sse50: '上证50', szse50: '深证50', bse50: '北证50',
  star50: '科创50', star100: '科创100', starcomposite: '科创综指', chinext50: '创业板50',
};

async function boot() {
  state = await window.gongwei.getStore();
  market = await window.gongwei.getMarket();
  render();
  window.gongwei.onMarket((m) => { market = m; render(); });
  window.gongwei.onStore((s) => { state = s; render(); });
  // 主进程在「显示前」要一次同步：先重算 DOM，再无条件回报高度，
  // 让窗口在隐藏状态下就调到最终尺寸，show 之后不会再 resize（消除打开时的闪动）
  window.gongwei.onFloatSync(() => render(true));
  window.gongwei.onAlert(() => {
    const card = document.querySelector('.card');
    card.classList.remove('flash');
    void card.offsetWidth;
    card.classList.add('flash');
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') window.gongwei.hideFloat();
  });
}

function pctText(v, ok) {
  if (!ok) return '--';
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

function render(forceSync) {
  if (!state) return;
  applyFloatTheme();
  document.getElementById('time').textContent = '更新 ' + (market.updatedAt
    ? new Date(market.updatedAt).toLocaleTimeString('zh-CN', { hour12: false })
    : '--:--:--');

  const stockById = new Map((market.stockQuotes || []).map((q) => [q.stockId, q]));
  const metaById = new Map((market.indexMeta || []).map((m) => [m.stockId, m]));
  const idxById = new Map((market.indexQuotes || []).map((q) => [q.stockId, q]));

  // 顶栏右侧：涨跌家数
  let up = 0;
  let down = 0;
  for (const s of state.stocks) {
    if (s.badgeEnabled === false) continue;
    const q = stockById.get(s.id);
    if (q && q.ok) (q.changePercent >= 0 ? up++ : down++);
  }
  document.getElementById('stat').textContent = (up + down) ? `涨${up} 跌${down}` : '';

  // 指数：以勾选为准横排渲染（与主界面同一套逻辑，行情只负责填数值）
  const idxBox = document.getElementById('idx');
  idxBox.innerHTML = '';
  if (state.settings.indices.floatingVisible) {
    const selected = (state.settings.indices.selected || []).slice(0, 8);
    for (const id of selected) {
      const stockId = `index:${id}`;
      const q = idxById.get(stockId);
      const meta = metaById.get(stockId);
      const ok = !!(q && q.ok);
      const name = (q && q.name) || (meta && meta.name) || INDEX_NAMES[id] || id;
      const pct = ok ? q.changePercent : 0;
      const card = document.createElement('div');
      card.className = 'idx-card';
      card.innerHTML = `<div class="idx-name">${escapeHtml(name)}</div>
        <div class="idx-price">${ok ? q.latestPrice.toFixed(Number.isInteger(q.decimals) ? q.decimals : 2) : '--'}</div>
        <div class="idx-pct ${pct >= 0 ? 'up' : 'down'}">${pctText(pct, ok)}</div>`;
      idxBox.appendChild(card);
    }
  }

  // 个股
  const list = document.getElementById('list');
  list.innerHTML = '';
  const stocks = state.stocks.filter((s) => s.badgeEnabled !== false).slice(0, 10);
  if (!stocks.length) {
    list.innerHTML = `<div class="empty">${state.stocks.length ? '个股还没开启浮窗显示' : '还没有自选股'}</div>`;
  }
  for (const s of stocks) {
    const q = stockById.get(s.id);
    const ok = !!(q && q.ok);
    const pct = ok ? q.changePercent : 0;
    const div = document.createElement('div');
    div.className = 'line';
    div.innerHTML = `<span class="name">${escapeHtml(s.name)}</span>
      <strong>${ok ? q.latestPrice.toFixed(Number.isInteger(q.decimals) ? q.decimals : 2) : '--'}</strong>
      <em class="${pct >= 0 ? 'up' : 'down'}">${pctText(pct, ok)}</em>`;
    list.appendChild(div);
  }
  syncHeight(forceSync);
}

function applyFloatTheme() {
  const t = state.settings.main.theme;
  const dark = t === 'dark' || (t !== 'light' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('.card').dataset.theme = dark ? 'dark' : 'light';
}

function escapeHtml(s) {
  return String(s ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

boot();
