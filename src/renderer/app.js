// 工位看盘 - 主窗口逻辑
let state = null;
let market = { stockQuotes: [], indexQuotes: [] };

const $ = (id) => document.getElementById(id);

function fmt(n, d = 2) {
  if (!Number.isFinite(Number(n))) return '--';
  return Number(n).toFixed(d);
}

function quoteOf(stockId) {
  return market.stockQuotes.find((q) => q.stockId === stockId)
    || market.indexQuotes.find((q) => q.stockId === stockId);
}

// 品种标签：股票不显示，基金/可转债/港美股给个小标记，避免把 ETF 当股票看
function typeLabel(item) {
  if (!item) return '';
  const t = item.securityType || 'stock';
  if (t === 'fund') return /^(16\d{4}|(?:501|502|506)\d{3})$/.test(item.code) ? 'LOF' : 'ETF';
  if (t === 'bond') return '债';
  if (t === 'index') return '指';
  if (item.market === 'HK') return '港';
  if (item.market === 'US') return '美';
  return '';
}

// 价格小数位：优先用行情给的精度（东财 f59），否则按品种兜底
function fmtQuotePrice(q, fallback = 2) {
  if (!q || !q.ok || !Number.isFinite(q.latestPrice)) return '--';
  return q.latestPrice.toFixed(Number.isInteger(q.decimals) ? q.decimals : fallback);
}

async function boot() {
  state = await window.gongwei.getStore();
  market = await window.gongwei.getMarket();
  try {
    $('appVer').textContent = 'v' + (await window.gongwei.getVersion());
  } catch { /* 忽略 */ }
  renderAll();
  window.gongwei.onMarket((m) => { market = m; updateMarketUI(); });
  window.gongwei.onStore((s) => { state = s; renderAll(); });
  window.gongwei.onUpdateState((u) => renderUpdateBadge(u));
  window.gongwei.onAlert((p) => {
    const channels = state.settings.alerts.channels || [];
    if (channels.includes('sound')) beep();
    renderStatus(`提醒：${p.hits.map((h) => h.stockName).join('、')}`);
  });

  $('btnRefresh').onclick = () => window.gongwei.refreshMarket();
  $('btnFloat').onclick = () => window.gongwei.toggleFloat();
  // 更多菜单：次要操作折叠，点击展开
  $('btnMore').onclick = (e) => {
    e.stopPropagation();
    $('moreMenu').hidden = !$('moreMenu').hidden;
  };
  document.addEventListener('click', (e) => {
    if (!$('moreMenu').hidden && !$('moreMenu').contains(e.target)) $('moreMenu').hidden = true;
  });
  const closeMore = () => { $('moreMenu').hidden = true; };
  $('btnOpenSettings').onclick = () => { closeMore(); openSettings(); };
  $('btnGoSelftest').onclick = () => { closeMore(); openSelftest(); };
  $('btnCheckUpdate').onclick = () => { closeMore(); checkUpdate(); };
  $('modalClose').onclick = closeModal;
  $('modalOverlay').addEventListener('mousedown', (e) => {
    if (e.target === $('modalOverlay')) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('modalOverlay').hidden) closeModal();
  });
  // 输入自动联想：停 400ms 自动搜（代码/名称/拼音缩写），上下键选择，回车添加
  let searchTimer = null;
  $('kw').addEventListener('input', () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { doSearch(); }, 400);
  });
  $('kw').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      if (searchTimer) clearTimeout(searchTimer);
      if (!$('suggest').hidden && suggestActive >= 0) pickSuggest(suggestActive);
      else doSearch();
    } else {
      onSuggestKey(e);
    }
  });
  $('kw').addEventListener('blur', () => { setTimeout(() => closeSuggest(), 150); });
  $('btnIndicesManage').onclick = toggleIndicesManage;
  applyTheme();
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  }
  fillSettings();
}

// 主题：system 跟随系统，light/dark 强制（深色最适合摸鱼）
function effectiveTheme() {
  const t = state && state.settings.main.theme;
  if (t === 'dark') return 'dark';
  if (t === 'light') return 'light';
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function applyTheme() {
  document.documentElement.dataset.theme = effectiveTheme();
}

// 指数管理：12 选 N，多选框即改即存
let indicesManageOpen = false;
function toggleIndicesManage() {
  indicesManageOpen = !indicesManageOpen;
  $('indicesManage').hidden = !indicesManageOpen;
  if (indicesManageOpen) paintIndicesManage();
}
function paintIndicesManage() {
  const box = $('indicesManage');
  box.innerHTML = '';
  const selected = new Set(state.settings.indices.selected || []);
  for (const id of Object.keys(INDEX_NAMES)) {
    const lab = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = selected.has(id);
    cb.onchange = async () => {
      // 直接调主进程原子切换，不在前端算集合（连点竞态已修）
      try {
        await window.gongwei.toggleIndex(id, cb.checked);
      } catch (e) {
        toast(`切换失败：${e.message}`);
      }
      state = await window.gongwei.getStore();
      renderAll();
      paintIndicesManage();
    };
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode(INDEX_NAMES[id]));
    box.appendChild(lab);
  }
}

let lastSelftest = null;
async function runSelftest() {
  const btn = $('btnSelftest');
  const box = $('selftestResult');
  btn.disabled = true;
  $('btnCopySelftest').disabled = true;
  box.innerHTML = '<p class="hint">自检中（9 条并行，约 10 秒）…</p>';
  try {
    lastSelftest = await window.gongwei.selftest();
    const pass = lastSelftest.results.filter((r) => r.ok).length;
    box.innerHTML = `<p class="hint">完成：${pass}/${lastSelftest.results.length} 通过 · ${new Date(lastSelftest.at).toLocaleTimeString('zh-CN', { hour12: false })}</p>`
      + lastSelftest.results.map((r) => `
        <div class="probe ${r.ok ? 'pass' : 'fail'}">
          <span class="dot"></span>
          <div><strong>${escapeHtml(r.name)}</strong><br/><small>${escapeHtml(r.detail)} · ${r.ms}ms</small></div>
        </div>`).join('');
    $('btnCopySelftest').disabled = false;
  } catch (e) {
    box.innerHTML = `<p class="hint">自检失败：${escapeHtml(e.message)}</p>`;
  } finally {
    btn.disabled = false;
  }
}

async function copySelftest() {
  if (!lastSelftest) return;
  const text = JSON.stringify(lastSelftest, null, 1);
  try {
    await navigator.clipboard.writeText(text);
    toast('自检结果已复制');
  } catch {
    toast('复制失败，请手动截图', 3000);
  }
}

function renderAll() {
  applyTheme();
  renderStocks();
  renderIndices();
  renderStatus();
  fillSettings();
  // 注意：管理面板只在打开/勾选时手动画，不跟随轮询重绘（否则复选框每 3 秒重建，点不开也关不上）
}

// 行情 tick 只原地更新数值，不重建 DOM（否则展开态/输入焦点每几秒就被冲掉）
function updateMarketUI() {
  updateStocksQuotes();
  updateIndicesValues();
  renderStatus();
}

function updateStocksQuotes() {
  if (!state) return;
  for (const s of state.stocks) {
    const el = document.querySelector(`[data-stock="${s.id}"]`);
    if (!el) continue;
    const q = quoteOf(s.id);
    const hasQ = q && q.ok;
    const pct = hasQ ? q.changePercent : 0;
    const priceEl = el.querySelector('.price');
    const pillEl = el.querySelector('.pill');
    if (priceEl) priceEl.textContent = fmtQuotePrice(q);
    if (pillEl) {
      pillEl.textContent = hasQ ? `${pct >= 0 ? '+' : ''}${fmt(pct)}%` : '--';
      pillEl.classList.toggle('pct-up', pct >= 0);
      pillEl.classList.toggle('pct-down', pct < 0);
    }
  }
}

function updateIndicesValues() {
  if (!state) return;
  const byId = new Map((market.indexQuotes || []).map((q) => [q.stockId, q]));
  document.querySelectorAll('#indices .idx-card').forEach((card) => {
    const id = card.getAttribute('data-index');
    const q = byId.get(id);
    if (!q || !q.ok) return;
    const up = q.changePercent >= 0;
    const priceEl = card.querySelector('.idx-price');
    const chgEl = card.querySelector('.idx-chg');
    if (priceEl) priceEl.textContent = fmt(q.latestPrice);
    if (chgEl) chgEl.innerHTML = `<span>${q.changeAmount >= 0 ? '+' : ''}${fmt(q.changeAmount)}</span><i>|</i><span class="${up ? 'pct-up' : 'pct-down'}">${q.changePercent >= 0 ? '+' : ''}${fmt(q.changePercent)}%</span>`;
  });
}

function renderStatus(text) {
  const el = $('status');
  if (text) { el.innerHTML = `<span class="live-dot warn"></span>${escapeHtml(text)}`; return; }
  const t = market.updatedAt ? new Date(market.updatedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '--:--:--';
  const nErr = (market.errors || []).length;
  const live = !market.updatedAt ? 'idle' : (nErr ? 'warn' : 'ok');
  el.innerHTML = `<span class="live-dot ${live}" id="btnStatusDot" role="button" tabindex="0" title="查看诊断"></span>更新 ${t} · ${escapeHtml(market.source || 'none')} · 共${state.stocks.length}只`;
  // 状态灯点击即可看诊断（不再单独放诊断按钮）
  const dot = document.getElementById('btnStatusDot');
  if (dot) {
    dot.onclick = () => showDiagnose();
    dot.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showDiagnose(); } };
  }
  // 有异常再挂一个黄色小喇叭，更醒目
  if (nErr) {
    const horn = document.createElement('button');
    horn.id = 'errHorn';
    horn.className = 'horn';
    horn.title = '有异常，点击查看';
    horn.textContent = `⚠${nErr}`;
    horn.onclick = (e) => { e.stopPropagation(); showDiagnose(); };
    el.appendChild(document.createTextNode(' '));
    el.appendChild(horn);
  }
}

// 行情全挂时给一句人话解释，避免用户面对一串 timeout 发懵
function diagnoseHint(d) {
  const errs = d.errors || [];
  if (!errs.length) return '';
  if (d.source && d.source !== 'none') return '';
  const allFail = errs.length >= 3;
  const timeouts = errs.filter((e) => /timeout/i.test(e)).length;
  if (allFail && timeouts >= 2) {
    return '三个通道同时超时，基本可以判定是网络问题：断网、切换网络中，或公司网络/代理拦截了行情站点。等网络恢复会自动重连，也可点「接口自检」逐条确认。';
  }
  if (errs.some((e) => /no ok rows|empty data/i.test(e))) {
    return '有通道能连上但没有数据，通常是非交易时段停牌/休市，或该指数只有单一通道支持。';
  }
  return '部分通道失败，其余通道会自动补上；若数字正常显示可忽略。';
}

async function showDiagnose() {
  let d;
  try {
    d = await window.gongwei.diagnose();
  } catch (e) {
    toast(`诊断失败：${e.message}`);
    return;
  }
  const errs = (d.errors && d.errors.length ? d.errors : ['各通道暂无报错'])
    .map((e) => `<div class="diag-err">${escapeHtml(e)}</div>`).join('');
  const hint = diagnoseHint(d);
  const px = d.proxy || {};
  const pxMode = { system: '跟随系统', direct: '不使用', manual: '手动' }[px.mode] || px.mode || '-';
  openModal('诊断', '', `
    <div class="diag-row"><span>行情来源</span><strong>${escapeHtml(d.source || 'none')}</strong></div>
    <div class="diag-row"><span>更新时间</span><strong>${d.updatedAt ? new Date(d.updatedAt).toLocaleString('zh-CN') : '无'}</strong></div>
    <div class="diag-row"><span>自选数量</span><strong>${d.stockCount}只</strong></div>
    <div class="diag-row"><span>代理模式</span><strong>${escapeHtml(pxMode)}</strong></div>
    <div class="diag-row"><span>实际走向</span><strong>${escapeHtml(px.resolved || '未知')}</strong></div>
    ${px.error ? `<div class="diag-err">代理配置有问题：${escapeHtml(px.error)}</div>` : ''}
    <div class="diag-errs">${errs}</div>
    ${hint ? `<p class="hint diag-hint">${escapeHtml(hint)}</p>` : ''}
    <button id="btnCopyDiagnose">复制结果</button>`);
  $('btnCopyDiagnose').onclick = async () => {
    const text = JSON.stringify(d, null, 1);
    try {
      await navigator.clipboard.writeText(text);
      toast('诊断结果已复制');
    } catch {
      toast('复制失败，请手动截图', 3000);
    }
  };
}

// ---- 二级弹窗（设置 / 自检统一入口，底部不再另起区） ----
function openModal(title, bodyClass, html) {
  $('modalTitle').textContent = title;
  const body = $('modalBody');
  body.className = 'modal-body ' + bodyClass;
  body.innerHTML = html;
  $('modalOverlay').hidden = false;
  document.body.classList.add('modal-open');
  const first = body.querySelector('input, select, button');
  if (first) first.focus();
}
function closeModal() {
  $('modalOverlay').hidden = true;
  document.body.classList.remove('modal-open');
}
function openSettings() {
  openModal('设置', 'settings', `
    <label>主题 <select id="setTheme"><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色（摸鱼）</option></select></label>
    <label>刷新间隔（秒，最小2） <input id="setInterval" type="number" min="2" max="60" step="1" /></label>
    <label>浮窗透明度 <input id="setOpacity" type="number" min="30" max="100" step="1" /></label>
    <label><input id="setFloatEnabled" type="checkbox" /> 启用浮窗</label>
    <label><input id="setEdgeSnap" type="checkbox" /> 浮窗拖到屏幕边缘自动贴边收成小球</label>
    <label><input id="setNotify" type="checkbox" /> 桌面通知提醒</label>
    <label><input id="setSound" type="checkbox" /> 声音提醒</label>
    <div class="settings-group">
      <label>网络代理 <select id="setProxyMode">
        <option value="system">跟随系统</option>
        <option value="direct">不使用</option>
        <option value="manual">手动指定</option>
      </select></label>
      <label id="proxyUrlRow">代理地址 <input id="setProxyUrl" type="text" placeholder="http://127.0.0.1:7890" /></label>
      <p class="hint" id="proxyHint"></p>
    </div>
    <div class="settings-test">
      <button id="btnTestSound">测试声音</button>
      <button id="btnTestNotify">测试通知</button>
    </div>
    <button id="btnSaveSettings" class="primary">保存设置</button>`);
  fillSettings(true);
  const syncProxyRow = () => {
    const manual = $('setProxyMode').value === 'manual';
    $('proxyUrlRow').hidden = !manual;
    $('proxyHint').textContent = manual
      ? '填代理软件里的 HTTP / SOCKS5 地址，保存后立即生效'
      : ($('setProxyMode').value === 'system'
        ? '自动使用 Windows 系统代理与 PAC，代理软件开启时通常选这个'
        : '直连，不走任何代理');
  };
  $('setProxyMode').onchange = syncProxyRow;
  syncProxyRow();
  $('btnTestSound').onclick = () => beep();
  $('btnTestNotify').onclick = async () => {
    const r = await window.gongwei.testNotify();
    toast(r && r.ok === false ? (r.message || '通知发送失败') : '通知已发送，看看右下角', 3000);
  };
  $('btnSaveSettings').onclick = async () => {
    const { proxyError } = await saveSettings();
    closeModal();
    toast(proxyError ? `代理未生效：${proxyError}` : '设置已保存', proxyError ? 5000 : 2200);
  };
}
function openSelftest() {
  openModal('接口自检', 'selftest', `
    <p class="hint">在你本机实测每条行情/搜索接口，通不通、慢不慢一目了然。没数据时先跑这个。</p>
    <div class="row">
      <button id="btnSelftest" class="primary">开始自检</button>
      <button id="btnCopySelftest" disabled>复制结果</button>
    </div>
    <div id="selftestResult"></div>`);
  $('btnSelftest').onclick = runSelftest;
  $('btnCopySelftest').onclick = copySelftest;
}

// ---- 检查更新 ----
function renderUpdateBadge(u) {
  const el = $('updateBadge');
  if (!el) return;
  if (u && u.hasUpdate) {
    el.hidden = false;
    el.textContent = `发现新版本 v${u.latest}`;
    el.onclick = () => showUpdateModal(u);
  } else {
    el.hidden = true;
    el.textContent = '';
  }
}

function showUpdateModal(u) {
  const rows = [
    `<div class="diag-row"><span>当前版本</span><strong>v${escapeHtml(u.current)}</strong></div>`,
    `<div class="diag-row"><span>最新版本</span><strong>v${escapeHtml(u.latest)}</strong></div>`,
  ].join('');
  const notes = u.notes
    ? `<pre class="update-notes">${escapeHtml(u.notes.split('\n').slice(0, 40).join('\n'))}</pre>`
    : '';
  openModal('发现新版本', '', `
    ${rows}
    ${notes}
    <div class="update-actions">
      <button id="btnOpenRelease" class="primary">打开发布页</button>
      <button id="btnOpenDownload" ${u.asset ? '' : 'hidden'}>直接下载</button>
    </div>`);
  $('btnOpenRelease').onclick = () => window.gongwei.openExternal(u.url);
  if (u.asset) {
    $('btnOpenDownload').onclick = () => window.gongwei.openExternal(u.asset.url);
  }
}

async function checkUpdate() {
  const el = $('updateBadge');
  if (el) { el.hidden = false; el.textContent = '正在检查更新…'; el.onclick = null; }
  let u;
  try {
    u = await window.gongwei.checkUpdate();
  } catch (e) {
    if (el) { el.hidden = true; el.textContent = ''; }
    toast(`检查更新失败：${e.message}`, 4000);
    return;
  }
  renderUpdateBadge(u);
  if (u.error) { toast(`检查更新失败：${u.error}`, 4000); return; }
  if (u.hasUpdate) showUpdateModal(u);
  else toast(`已是最新版本 v${u.current}`, 2500);
}

// ---- 拖拽排序 ----
// 指针事件实现：按住行首 ⠿ 拖动，实时把被拖行插到目标位置，松手后把新顺序写回主进程
let dragState = null;

function attachDrag(div, stock) {
  const handle = div.querySelector('.drag-handle');
  if (!handle) return;
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragState = { id: stock.id, div, handle, pointerId: e.pointerId, moved: false };
    div.classList.add('dragging');
    document.body.classList.add('dragging-active');
    try { handle.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
    handle.addEventListener('pointermove', onDragMove);
    handle.addEventListener('pointerup', onDragEnd);
    handle.addEventListener('pointercancel', onDragEnd);
  });
}

function onDragMove(e) {
  if (!dragState) return;
  dragState.moved = true;
  const box = $('stocks');
  const others = [...box.querySelectorAll('.stock:not(.dragging)')];
  const y = e.clientY;
  let target = null;
  for (const row of others) {
    const rect = row.getBoundingClientRect();
    if (y < rect.top + rect.height / 2) { target = row; break; }
  }
  // 直接搬 DOM，视觉上跟手；松手后再落库
  if (target) box.insertBefore(dragState.div, target);
  else box.appendChild(dragState.div);
}

function onDragEnd() {
  if (!dragState) return;
  const { div, handle, id, moved, pointerId } = dragState;
  handle.removeEventListener('pointermove', onDragMove);
  handle.removeEventListener('pointerup', onDragEnd);
  handle.removeEventListener('pointercancel', onDragEnd);
  try { handle.releasePointerCapture(pointerId); } catch { /* 忽略 */ }
  div.classList.remove('dragging');
  document.body.classList.remove('dragging-active');
  dragState = null;
  if (!moved) return; // 只是点了一下，不算排序

  const ids = [...$('stocks').querySelectorAll('.stock')].map((el) => el.getAttribute('data-stock'));
  window.gongwei.reorderStocks(ids)
    .then(async () => { state = await window.gongwei.getStore(); renderAll(); })
    .catch(async (err) => {
      toast(`排序失败：${err.message}`, 3000);
      state = await window.gongwei.getStore();
      renderAll();
    });
  void id;
}

// toast：替代原生 alert，不阻塞、不打断盯盘
function toast(msg, ms = 2200) {
  let box = document.getElementById('toast');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toast';
    document.body.appendChild(box);
  }
  box.textContent = msg;
  box.classList.add('show');
  clearTimeout(box._t);
  box._t = setTimeout(() => box.classList.remove('show'), ms);
}

function renderStocks() {
  const box = $('stocks');
  $('stockCount').textContent = `(${state.stocks.length})`;
  if (!state.stocks.length) {
    box.innerHTML = '<div class="empty">还没有自选<br/>上面输入代码 / 名称 / 拼音缩写，回车添加</div>';
    return;
  }
  // 首屏即时渲染真卡片（名字来自本地，数值填 -- 等行情），不等行情回来
  // 重建前先捞出用户态（展开/未保存输入），重建后还原：任何重建都不丢用户操作
  const prevOpen = new Set();
  const prevInputs = {};
  box.querySelectorAll('.stock').forEach((el) => {
    const id = el.getAttribute('data-stock');
    const cfg = el.querySelector('.aconfig');
    if (id && cfg && !cfg.hidden) prevOpen.add(id);
    el.querySelectorAll('input[data-k]').forEach((inp) => {
      if (!id) return;
      (prevInputs[id] = prevInputs[id] || {})[inp.dataset.k] = inp.value;
    });
  });
  box.innerHTML = '';
  const total = state.stocks.length;
  state.stocks.forEach((s, idx) => {
    const q = quoteOf(s.id);
    const hasQ = q && q.ok;
    const pct = hasQ ? q.changePercent : 0;
    const up = pct >= 0;
    const a = s.alert || {};
    const snoozed = a.snoozedUntil && Date.parse(a.snoozedUntil) > Date.now();
    const div = document.createElement('div');
    div.className = 'stock compact';
    div.setAttribute('data-stock', s.id);
    const tl = typeLabel(s);
    div.innerHTML = `
      <div class="srow">
        <span class="drag-handle" title="按住拖动排序">⠿</span>
        <span class="name" title="${escapeHtml(s.code)}">${escapeHtml(s.name)}<small>${escapeHtml(s.code)}</small>${tl ? `<i class="type-badge">${tl}</i>` : ''}</span>
        <span class="price">${fmtQuotePrice(q)}</span>
        <span class="pill ${up ? 'pct-up' : 'pct-down'}">${hasQ ? `${pct >= 0 ? '+' : ''}${fmt(pct)}%` : '--'}</span>
        <button class="icon-btn bell ${!a.enabled ? 'off' : (snoozed ? 'snooze' : 'on')}" data-act="bell" title="${!a.enabled ? '开启价格提醒' : (snoozed ? '提醒已暂停，点击恢复' : '关闭价格提醒')}">🔔</button>
        <button class="icon-btn chev" data-act="chev" title="展开条件设置">›</button>
      </div>
      <div class="aconfig" ${a.enabled ? '' : 'hidden'}>
        <div class="alert-grid">
          <label>上破价<input data-k="upperPrice" type="number" step="0.01" value="${a.upperPrice ?? ''}" /></label>
          <label>下跌价<input data-k="lowerPrice" type="number" step="0.01" value="${a.lowerPrice ?? ''}" /></label>
          <label>涨幅%<input data-k="upperChangePercent" type="number" step="0.1" value="${a.upperChangePercent ?? ''}" /></label>
          <label>跌幅%<input data-k="lowerChangePercent" type="number" step="0.1" value="${a.lowerChangePercent ?? ''}" /></label>
        </div>
        <div class="ops"></div>
      </div>`;
    const cfg = div.querySelector('.aconfig');
    const chev = div.querySelector('[data-act="chev"]');
    // 还原用户态：之前展开的保持展开，正在填的值原样写回
    if (prevOpen.has(s.id)) cfg.hidden = false;
    if (prevInputs[s.id]) {
      div.querySelectorAll('input[data-k]').forEach((inp) => {
        if (prevInputs[s.id][inp.dataset.k] !== undefined) inp.value = prevInputs[s.id][inp.dataset.k];
      });
    }
    const syncChev = () => chev.classList.toggle('open', !cfg.hidden);
    syncChev();
    chev.onclick = () => { cfg.hidden = !cfg.hidden; syncChev(); };
    div.querySelector('[data-act="bell"]').onclick = async () => {
      const patch = { enabled: !a.enabled };
      if (!a.enabled) patch.snoozedUntil = null;
      await window.gongwei.updateAlert(s.id, patch);
      state = await window.gongwei.getStore();
      renderAll();
    };
    const ops = div.querySelector('.ops');
    const mkBtn = (text, fn, cls) => {
      const b = document.createElement('button');
      b.textContent = text;
      if (cls) b.className = cls;
      b.onclick = fn;
      ops.appendChild(b);
      return b;
    };
    attachDrag(div, s);
    mkBtn('保存条件', async () => {
      const patch = {};
      div.querySelectorAll('input[data-k]').forEach((inp) => {
        const v = inp.value === '' ? null : Number(inp.value);
        patch[inp.dataset.k] = Number.isFinite(v) ? v : null;
      });
      await window.gongwei.updateAlert(s.id, patch);
      state = await window.gongwei.getStore();
      toast('提醒条件已保存');
      renderAll();
    });
    mkBtn('暂停30分钟', async () => {
      await window.gongwei.snoozeStock(s.id, 30);
      state = await window.gongwei.getStore();
      renderAll();
    });
    // 两击删除：第一击变确认态，第二击执行（替代原生 confirm 弹窗）
    const delBtn = mkBtn('删除', async () => {
      if (!delBtn.dataset.armed) {
        delBtn.dataset.armed = '1';
        delBtn.textContent = '确认删除？';
        delBtn.classList.add('danger');
        setTimeout(() => {
          if (delBtn.isConnected) {
            delete delBtn.dataset.armed;
            delBtn.textContent = '删除';
            delBtn.classList.remove('danger');
          }
        }, 3000);
        return;
      }
      await window.gongwei.removeStock(s.id);
      state = await window.gongwei.getStore();
      renderAll();
    });
    box.appendChild(div);
  });
}

// 指数中英文映射（前端内置兜底，名字显示不再依赖主进程推送）
const INDEX_NAMES = {
  shanghai: '上证指数', shenzhen: '深证成指', chinext: '创业板指',
  csi300: '沪深300', csi500: '中证500', csi1000: '中证1000', csi2000: '中证2000',
  sse50: '上证50', szse50: '深证50', bse50: '北证50',
  star50: '科创50', star100: '科创100', starcomposite: '科创综指', chinext50: '创业板50',
};
function indexName(id, meta) {
  const m = meta.get(`index:${id}`);
  if (m && m.name) return m.name;
  return INDEX_NAMES[id] || id;
}

function renderIndices() {
  const box = $('indices');
  box.innerHTML = '';
  const meta = new Map((market.indexMeta || []).map((m) => [m.stockId, m]));
  const byId = new Map((market.indexQuotes || []).map((q) => [q.stockId, q]));
  // 以「用户勾选」为准来决定显示哪些指数，行情只用来填数值。
  // 之前是以行情数组为准，导致新勾的指数要等下一次网络刷新才出现、取消的也等刷新才消失
  // （网络超时/失败时永远不变，看起来就是"关不掉/加不上"）
  const ids = state.settings.indices.selected || [];
  for (const id of ids) {
    const stockId = `index:${id}`;
    const q = byId.get(stockId);
    const ok = !!(q && q.ok);
    const name = (q && q.name) || indexName(id, meta);
    const pct = ok ? q.changePercent : 0;
    const up = pct >= 0;
    const chg = ok ? q.changeAmount : 0;
    const card = document.createElement('div');
    card.className = 'idx-card';
    card.setAttribute('data-index', stockId);
    card.innerHTML = `<div class="idx-name">${escapeHtml(name)}</div>
      <div class="idx-price">${ok ? fmt(q.latestPrice) : '--'}</div>
      <div class="idx-chg">${ok
        ? `<span>${chg >= 0 ? '+' : ''}${fmt(chg)}</span><i>|</i><span class="${up ? 'pct-up' : 'pct-down'}">${pct >= 0 ? '+' : ''}${fmt(pct)}%</span>`
        : '<span>--</span>'}</div>`;
    box.appendChild(card);
  }
  if (!ids.length) {
    box.innerHTML = '<div class="empty">还没有选择指数，点右上「管理」勾选</div>';
  }
}

let searchSeq = 0;
let suggestItems = [];
let suggestActive = -1;

function closeSuggest() {
  suggestItems = [];
  suggestActive = -1;
  $('suggest').hidden = true;
  $('suggest').innerHTML = '';
}

function paintSuggest() {
  const box = $('suggest');
  box.innerHTML = '';
  suggestItems.forEach((it, i) => {
    const div = document.createElement('div');
    div.className = 'suggest-item' + (i === suggestActive ? ' active' : '');
    const tl = typeLabel(it);
    div.innerHTML = `<strong>${escapeHtml(it.name)}</strong><span class="code">${escapeHtml(it.code)}</span><span class="ex">${tl ? `${tl} · ` : ''}${escapeHtml(it.exchange || '')}</span>`;
    div.onmousedown = (e) => { e.preventDefault(); pickSuggest(i); };
    box.appendChild(div);
  });
  box.hidden = suggestItems.length === 0;
}

async function pickSuggest(i) {
  const it = suggestItems[i];
  if (!it) return;
  try {
    await window.gongwei.addStock(it);
    state = await window.gongwei.getStore();
    $('kw').value = '';
    closeSuggest();
    renderAll();
    toast(`已添加 ${it.name}（${it.code}）`);
  } catch (e) { toast(e.message, 3000); }
}

async function doSearch() {
  const kw = $('kw').value.trim();
  if (!kw) { closeSuggest(); return; }
  const mySeq = ++searchSeq;
  // 下拉框内联提示，不再用单独消息行
  suggestItems = [];
  $('suggest').innerHTML = '<div class="suggest-item searching">搜索中…</div>';
  $('suggest').hidden = false;
  try {
    const items = await window.gongwei.search(kw);
    if (mySeq !== searchSeq) return; // 已有更新的搜索，丢弃旧结果
    suggestItems = items.slice(0, 10);
    suggestActive = suggestItems.length ? 0 : -1;
    paintSuggest();
    if (!suggestItems.length) toast('没搜到，换个关键词。');
  } catch (e) {
    if (mySeq !== searchSeq) return;
    closeSuggest();
    toast(`搜索失败：${e.message}`, 4000);
  }
}

function onSuggestKey(e) {
  if ($('suggest').hidden) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    suggestActive = (suggestActive + 1) % suggestItems.length;
    paintSuggest();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    suggestActive = (suggestActive - 1 + suggestItems.length) % suggestItems.length;
    paintSuggest();
  } else if (e.key === 'Escape') {
    closeSuggest();
  }
}

function fillSettings(force) {
  if (!state || !$('setTheme')) return;
  // 弹窗打开时不回填，避免轮询刷新冲掉用户正在填的值（打开瞬间 force 回填一次除外）
  if (!force && !$('modalOverlay').hidden) return;
  $('setTheme').value = state.settings.main.theme || 'system';
  $('setInterval').value = state.settings.main.refreshIntervalSeconds;
  $('setOpacity').value = state.settings.floating.opacity;
  $('setFloatEnabled').checked = !!state.settings.floating.enabled;
  if ($('setEdgeSnap')) $('setEdgeSnap').checked = state.settings.floating.edgeSnap !== false;
  $('setNotify').checked = (state.settings.alerts.channels || []).includes('notify');
  $('setSound').checked = (state.settings.alerts.channels || []).includes('sound');
  const net = state.settings.network || {};
  if ($('setProxyMode')) $('setProxyMode').value = net.proxyMode || 'system';
  if ($('setProxyUrl')) $('setProxyUrl').value = net.proxyUrl || '';
}

async function saveSettings() {
  const channels = [];
  if ($('setNotify').checked) channels.push('notify');
  if ($('setSound').checked) channels.push('sound');
  await window.gongwei.updateSettings({
    main: { theme: $('setTheme').value || 'system', refreshIntervalSeconds: Math.max(2, Number($('setInterval').value) || 3) },
    floating: {
      opacity: Number($('setOpacity').value) || 88,
      enabled: $('setFloatEnabled').checked,
      edgeSnap: $('setEdgeSnap') ? $('setEdgeSnap').checked : true,
    },
    alerts: { channels },
    network: {
      proxyMode: $('setProxyMode') ? $('setProxyMode').value : 'system',
      proxyUrl: $('setProxyUrl') ? $('setProxyUrl').value.trim() : '',
    },
  });
  state = await window.gongwei.getStore();
  // 代理配置错误时主进程会退回直连并记录原因，返回给调用方决定怎么提示
  const proxyError = await window.gongwei.applyProxy().then((s) => (s && s.error) || '').catch(() => '');
  renderAll();
  return { proxyError };
}

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = 880;
    g.gain.value = 0.12;
    o.start();
    setTimeout(() => { o.stop(); ctx.close(); }, 600);
  } catch { /* 忽略 */ }
}

function escapeHtml(s) {
  return String(s ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

boot();
