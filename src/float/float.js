// 工位看盘 - 浮窗逻辑（透明置顶）
// 两种形态：展开（顶栏 + 指数横排 + 个股列表）/ 收起（贴边小球，鼠标移入展开）
let state = null;
let market = { stockQuotes: [], indexQuotes: [] };
let lastHeight = 0;
let collapsed = false;
let floatEdge = null;
let collapseTimer = null;

// 内容高度回报给主进程，让窗口贴合内容（否则底部透明区会挡住下方窗口的点击）
function syncHeight() {
  requestAnimationFrame(() => {
    const card = document.querySelector('.card');
    if (!card) return;
    const h = Math.ceil(card.getBoundingClientRect().height);
    if (h > 40 && Math.abs(h - lastHeight) > 2) {
      lastHeight = h;
      window.gongwei.floatResize(h);
    }
  });
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
  window.gongwei.onFloatState((s) => {
    collapsed = !!(s && s.collapsed);
    floatEdge = (s && s.edge) || null;
    applyCollapsedClass();
    render();
  });
  window.gongwei.onAlert(() => {
    const card = document.querySelector('.card');
    card.classList.remove('flash');
    void card.offsetWidth;
    card.classList.add('flash');
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') window.gongwei.hideFloat();
  });
  // 收起态：鼠标移入展开；展开态且贴边：鼠标移出后自动收回
  const card = document.querySelector('.card');
  card.addEventListener('mouseenter', () => {
    if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null; }
    if (collapsed) window.gongwei.collapseFloat(false);
  });
  card.addEventListener('mouseleave', () => {
    if (collapsed || !floatEdge) return;
    if (collapseTimer) clearTimeout(collapseTimer);
    collapseTimer = setTimeout(() => {
      collapseTimer = null;
      if (!collapsed && floatEdge) window.gongwei.collapseFloat(true);
    }, 1200);
  });
  // 双击切换收起/展开（不依赖鼠标悬停）
  card.addEventListener('dblclick', () => window.gongwei.toggleFloatCollapse());
}

function applyCollapsedClass() {
  const card = document.querySelector('.card');
  if (!card) return;
  card.classList.toggle('collapsed', collapsed);
  const wrap = document.getElementById('ball');
  if (wrap) wrap.hidden = !collapsed;
  const body = document.getElementById('expanded');
  if (body) body.hidden = collapsed;
}

// 收起态小球：显示涨跌家数，颜色表示强弱
function renderBall() {
  const byId = new Map((market.stockQuotes || []).map((q) => [q.stockId, q]));
  let up = 0;
  let down = 0;
  for (const s of (state && state.stocks) || []) {
    if (s.badgeEnabled === false) continue;
    const q = byId.get(s.id);
    if (q && q.ok) (q.changePercent >= 0 ? up++ : down++);
  }
  const ball = document.getElementById('ball');
  if (!ball) return;
  const tone = up === down ? 'flat' : (up > down ? 'up' : 'down');
  ball.className = `ball ${tone}`;
  ball.textContent = (up + down) ? `${up}/${down}` : '--';
  ball.title = `涨 ${up} 跌 ${down}（鼠标移入展开，双击收起/展开）`;
}

function pctText(v, ok) {
  if (!ok) return '--';
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

function render() {
  if (!state) return;
  applyFloatTheme();
  applyCollapsedClass();
  renderBall();
  if (collapsed) return; // 小球形态不需要渲染展开内容，也不做高度自适应
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
  syncHeight();
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
