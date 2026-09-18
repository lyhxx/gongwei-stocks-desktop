// 工位看盘 - 主窗口逻辑
let state = null;
let market = { stockQuotes: [], indexQuotes: [] };
let session = null; // 交易时段状态（交易中/午休/已收盘/周末/节假日）

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
  window.gongwei.onSession((s) => { session = s; renderStatus(); });
  window.gongwei.onOpenSettings(() => openSettings());
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
  // 非交易时段直接标出来，用户就知道"数据不动是正常的"，而不是以为软件坏了
  const stopped = session && session.label && !session.trading;
  const sessionText = stopped ? ` · ${escapeHtml(session.label)}` : '';
  el.innerHTML = `<span class="live-dot ${live}" id="btnStatusDot" role="button" tabindex="0" title="查看诊断"></span>更新 ${t} · ${escapeHtml(market.source || 'none')}${sessionText} · 共${state.stocks.length}只`;
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
    <div class="set-group">
      <div class="set-title">外观</div>
      <div class="set-row">
        <span class="set-label">主题</span>
        <select id="setTheme">
          <option value="system">跟随系统</option>
          <option value="light">浅色</option>
          <option value="dark">深色（摸鱼）</option>
        </select>
      </div>
      <div class="set-row">
        <span class="set-label">浮窗透明度</span>
        <span class="set-ctl"><input id="setOpacity" type="number" min="30" max="100" step="1" /><i class="set-unit">%</i></span>
      </div>
    </div>

    <div class="set-group">
      <div class="set-title">行情</div>
      <div class="set-row">
        <span class="set-label">刷新间隔</span>
        <span class="set-ctl"><input id="setInterval" type="number" min="2" max="60" step="1" /><i class="set-unit">秒</i></span>
      </div>
      <div class="set-row">
        <span class="set-label">仅交易时段请求</span>
        <label class="switch"><input id="setMarketHours" type="checkbox" /><span class="track"></span></label>
      </div>
      <p class="hint" id="marketHoursHint"></p>
    </div>

    <div class="set-group">
      <div class="set-title">浮窗</div>
      <div class="set-row">
        <span class="set-label">显示浮窗</span>
        <label class="switch"><input id="setFloatEnabled" type="checkbox" /><span class="track"></span></label>
      </div>
    </div>

    <div class="set-group">
      <div class="set-title">提醒通道</div>
      <div class="set-row">
        <span class="set-label">桌面通知</span>
        <label class="switch"><input id="setNotify" type="checkbox" /><span class="track"></span></label>
      </div>
      <div class="set-row">
        <span class="set-label">声音提醒</span>
        <label class="switch"><input id="setSound" type="checkbox" /><span class="track"></span></label>
      </div>
      <div class="set-actions">
        <button id="btnTestSound">试听声音</button>
        <button id="btnTestNotify">发条通知</button>
      </div>
    </div>

    <div class="set-group">
      <div class="set-title">网络代理</div>
      <div class="set-row">
        <span class="set-label">模式</span>
        <select id="setProxyMode">
          <option value="system">跟随系统</option>
          <option value="direct">不使用</option>
          <option value="manual">手动指定</option>
        </select>
      </div>
      <div class="set-row" id="proxyUrlRow">
        <span class="set-label">代理地址</span>
        <input id="setProxyUrl" type="text" placeholder="http://127.0.0.1:7890" />
      </div>
      <p class="hint" id="proxyHint"></p>
      <div class="set-actions">
        <button id="btnTestProxy">测试连通性</button>
        <span class="test-result" id="proxyTestResult"></span>
      </div>
    </div>

    <div class="set-footer">
      <button id="btnSaveSettings" class="primary">保存设置</button>
    </div>`);
  fillSettings(true);
  const syncProxyRow = () => {
    const mode = $('setProxyMode').value;
    $('proxyUrlRow').hidden = mode !== 'manual';
    $('proxyHint').textContent = mode === 'manual'
      ? '填代理软件里的 HTTP / SOCKS5 地址，例如 127.0.0.1:7890，保存后立即生效'
      : (mode === 'system'
        ? '自动使用 Windows 系统代理与 PAC，代理软件开着时一般选这个'
        : '直连，不走任何代理');
  };
  $('setProxyMode').onchange = () => { syncProxyRow(); $('proxyTestResult').textContent = ''; };
  syncProxyRow();
  const syncMarketHoursHint = () => {
    $('marketHoursHint').textContent = $('setMarketHours').checked
      ? '只在 09:15–11:30、13:00–15:00 请求，收盘后补抓一次最终价；午休/周末/节假日不发请求'
      : '全天按间隔请求（休市时数据不会变，只是多耗流量）';
  };
  $('setMarketHours').onchange = syncMarketHoursHint;
  syncMarketHoursHint();
  $('btnTestSound').onclick = () => beep();
  $('btnTestNotify').onclick = async () => {
    const r = await window.gongwei.testNotify();
    toast(r && r.ok === false ? (r.message || '通知发送失败') : '通知已发送，看看右下角', 3000);
  };
  $('btnTestProxy').onclick = async () => {
    const btn = $('btnTestProxy');
    const box = $('proxyTestResult');
    btn.disabled = true;
    box.className = 'test-result';
    box.textContent = '测试中…';
    try {
      const r = await window.gongwei.testProxy();
      const pass = r.results.filter((x) => x.ok).length;
      const tone = pass === r.results.length ? 'ok' : (pass ? 'warn' : 'bad');
      box.className = `test-result ${tone}`;
      box.innerHTML = `<strong>${pass}/${r.results.length} 通</strong>`
        + r.results.map((x) => `<span class="probe-chip ${x.ok ? 'ok' : 'bad'}" title="${escapeHtml(x.detail)}">${escapeHtml(x.name)} ${x.ok ? x.ms + 'ms' : '✗'}</span>`).join('')
        + `<em>${escapeHtml(r.proxy.resolved)}</em>`;
    } catch (e) {
      box.className = 'test-result bad';
      box.textContent = `测试失败：${e.message}`;
    } finally {
      btn.disabled = false;
    }
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

// ---- 拖拽排序（自选列表 + 指数卡片共用）----
// 要点（都是踩过的坑）：
//   1. pointermove/up 挂在 window 上，不用 setPointerCapture。
//      之前挂在被拖元素上，列表一旦重建（名称回填/改设置等 broadcastStore）元素就被换掉，
//      pointerup 收不到 → dragState 永远卡住 → 之后所有拖拽都失效（"有时拖不动"）。
//   2. 拖拽期间不重建列表（见 renderStocks 里的 guard），避免拖到一半元素被替换。
//   3. 同一时刻只允许一个拖拽；只认主指针；触摸必须从 ⠿ 把手起拖。
//   4. 换位动画用 Web Animations，各自独立可取消，不会互相清 transform。
let dragState = null;
const DRAG_THRESHOLD = 4; // 小于这个位移视为点击
const flipAnims = new WeakMap();

// 拖拽时不要抢这些元素自己的交互。
// 注意：不要把 .drag-handle 排除掉，把手反而是最该能拖的地方
const NO_DRAG_SELECTOR = 'button, input, select, textarea, a, .aconfig';

function dragItemsOf(container) {
  return [...container.querySelectorAll('[data-drag-id]')];
}

function isDragging() {
  return !!dragState;
}

// 把 dragged 移到 ref 之前，并让因此位移的元素平滑滑过去
function moveWithFlip(container, dragged, ref) {
  // 先把还在播的动画收掉：否则 getBoundingClientRect 读到的含动画偏移，
  // 连点两次会误差叠加，元素看起来乱跳
  for (const n of container.children) {
    const a = flipAnims.get(n);
    if (a) { a.cancel(); flipAnims.delete(n); }
  }

  const kids = [...container.children];
  const before = new Map();
  for (const n of kids) before.set(n, n.getBoundingClientRect()); // 先统一读

  container.insertBefore(dragged, ref);

  for (const n of container.children) {                            // 再统一写
    const b = before.get(n);
    if (!b) continue;
    const a = n.getBoundingClientRect();
    const dx = b.left - a.left;
    const dy = b.top - a.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    if (typeof n.animate === 'function') {
      flipAnims.set(n, n.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
        { duration: 140, easing: 'cubic-bezier(.2, .8, .2, 1)' },
      ));
    } else {
      // 退路（jsdom 等没有 Web Animations 的环境）
      n.style.transition = 'none';
      n.style.transform = `translate(${dx}px, ${dy}px)`;
      requestAnimationFrame(() => {
        n.style.transition = 'transform 140ms ease';
        n.style.transform = '';
      });
    }
  }
}

// 拖拽开始时冻结每个槽位的几何。
// 关键：网格里换位会让整片元素挪动，如果每次都按实时坐标找目标，指针会不断落到
// 刚换过去的元素附近，形成"换位 → 坐标变 → 再换回"的来回抖动（表现为几个卡片瞬移乱窜）。
// 用冻结的槽位决策后，同一指针位置永远得出同一结果，天然稳定。
function captureSlots(container) {
  return dragItemsOf(container).map((el) => {
    const r = el.getBoundingClientRect();
    return {
      el,
      cx: r.left + r.width / 2,
      cy: r.top + r.height / 2,
      top: r.top,
      bottom: r.bottom,
      empty: r.width === 0 && r.height === 0,
    };
  });
}

// 依据冻结槽位算出「插到哪个元素的前/后」
function resolveTarget(slots, dragged, x, y) {
  let best = null;
  let bestDist = Infinity;
  for (const s of slots) {
    if (s.el === dragged || s.empty) continue;
    const d = Math.hypot(x - s.cx, y - s.cy);
    if (d < bestDist) { bestDist = d; best = s; }
  }
  if (!best) return null;
  const sameRow = y >= best.top && y <= best.bottom;
  const before = sameRow ? x < best.cx : y < best.cy;
  return { el: best.el, before };
}

function attachDrag(el) {
  el.addEventListener('pointerdown', onDragStart);
}

function onDragStart(e) {
  if (dragState) return;                        // 已有拖拽在进行，忽略新的指针
  // 只拒绝「明确标记为非主指针」的；缺省视为可用（测试环境只有 MouseEvent）
  if (e.isPrimary === false) return;
  if (e.pointerType === 'touch' && !e.target.closest('.drag-handle')) return; // 触摸只允许从把手起拖
  if (e.button !== 0) return;
  if (e.target.closest(NO_DRAG_SELECTOR)) return; // 让按钮/输入框照常工作
  e.preventDefault();

  const el = e.currentTarget;
  dragState = {
    el,
    container: el.parentElement,
    startX: e.clientX,
    startY: e.clientY,
    pointerId: e.pointerId,
    moved: false,
    slots: captureSlots(el.parentElement), // 冻结槽位，拖拽期间不再读实时坐标
    kind: el.classList.contains('idx-card') ? 'index' : 'stock',
  };
  el.classList.add('dragging');
  document.body.classList.add('dragging-active');
  // 挂在 window 上：元素后续被移动/重建也不影响收尾
  window.addEventListener('pointermove', onDragMove, true);
  window.addEventListener('pointerup', onDragEnd, true);
  window.addEventListener('pointercancel', onDragEnd, true);
  window.addEventListener('blur', onDragEnd, true);
  window.addEventListener('keydown', onDragKey, true);
}

function detachDragListeners() {
  window.removeEventListener('pointermove', onDragMove, true);
  window.removeEventListener('pointerup', onDragEnd, true);
  window.removeEventListener('pointercancel', onDragEnd, true);
  window.removeEventListener('blur', onDragEnd, true);
  window.removeEventListener('keydown', onDragKey, true);
}

function onDragKey(e) {
  if (e.key === 'Escape') onDragEnd();
}

function onDragMove(e) {
  const st = dragState;
  if (!st) return;
  if (st.pointerId !== undefined && e.pointerId !== undefined && e.pointerId !== st.pointerId) return;
  if (!st.moved) {
    if (Math.hypot(e.clientX - st.startX, e.clientY - st.startY) < DRAG_THRESHOLD) return;
    st.moved = true;
  }
  const target = resolveTarget(st.slots, st.el, e.clientX, e.clientY);
  if (!target) return;
  const ref = target.before ? target.el : target.el.nextSibling;
  if (st.el.nextSibling === ref || st.el === ref) return;   // 已在正确位置
  moveWithFlip(st.container, st.el, ref);
}

function onDragEnd(e) {
  const st = dragState;
  if (!st) return;
  if (e && e.pointerId !== undefined && st.pointerId !== undefined && e.pointerId !== st.pointerId) return;
  detachDragListeners();
  st.el.classList.remove('dragging');
  document.body.classList.remove('dragging-active');
  dragState = null;
  if (!st.moved) return; // 只是点了一下，不算排序

  const ids = dragItemsOf(st.container).map((node) => node.getAttribute('data-drag-id'));
  const call = st.kind === 'index' ? window.gongwei.reorderIndices(ids) : window.gongwei.reorderStocks(ids);
  call
    .then(async () => { state = await window.gongwei.getStore(); renderAll(); })
    .catch(async (err) => {
      toast(`排序失败：${err.message}`, 3000);
      state = await window.gongwei.getStore();
      renderAll();
    });
}

// 价格提醒铃铛：用内联 SVG 而不是 emoji —— 彩色 emoji 不受 CSS color 影响，
// 开启/关闭/暂停会看起来一模一样。SVG 用 currentColor 才能真正变色。
const BELL_ON = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M12 2.2a5.6 5.6 0 0 0-5.6 5.6v3.3l-1.5 3a1 1 0 0 0 .9 1.45h12.4a1 1 0 0 0 .9-1.45l-1.5-3V7.8A5.6 5.6 0 0 0 12 2.2Z"/><path fill="currentColor" d="M9.7 17.6a2.3 2.3 0 0 0 4.6 0H9.7Z"/></svg>';
const BELL_OFF = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.7" d="M12 3.4a4.6 4.6 0 0 0-4.6 4.6v3.2l-1.3 2.6a.8.8 0 0 0 .7 1.2h10.4a.8.8 0 0 0 .7-1.2l-1.3-2.6V8A4.6 4.6 0 0 0 12 3.4Z"/><path fill="none" stroke="currentColor" stroke-width="1.7" d="M10 18.1a2 2 0 0 0 4 0"/><line x1="4.2" y1="4.2" x2="19.8" y2="19.8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';

function bellLabel(a, snoozed) {
  if (!a.enabled) return '开启价格提醒';
  return snoozed ? '提醒已暂停，点击恢复' : '关闭价格提醒';
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
  // 拖拽进行中绝不动 DOM：否则被拖元素会被替换，指针事件与位置全乱
  // （数值仍会通过 updateMarketUI 原地刷新，不影响盯盘）
  if (isDragging()) return;
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
    div.setAttribute('data-drag-id', s.id);
    const tl = typeLabel(s);
    div.innerHTML = `
      <div class="srow">
        <span class="drag-handle" title="按住任意位置拖动可排序">⠿</span>
        <span class="name" title="${escapeHtml(s.code)}">${escapeHtml(s.name)}<small>${escapeHtml(s.code)}</small>${tl ? `<i class="type-badge">${tl}</i>` : ''}</span>
        <span class="price">${fmtQuotePrice(q)}</span>
        <span class="pill ${up ? 'pct-up' : 'pct-down'}">${hasQ ? `${pct >= 0 ? '+' : ''}${fmt(pct)}%` : '--'}</span>
        <button class="icon-btn bell ${!a.enabled ? 'off' : (snoozed ? 'snooze' : 'on')}" data-act="bell" title="${bellLabel(a, snoozed)}">${!a.enabled ? BELL_OFF : BELL_ON}</button>
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
    attachDrag(div);
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
  if (isDragging()) return; // 同上：拖拽指数卡片时不要重建
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
    card.setAttribute('data-drag-id', id);
    card.title = '按住拖动可调整指数顺序';
    card.innerHTML = `<div class="idx-name">${escapeHtml(name)}</div>
      <div class="idx-price">${ok ? fmt(q.latestPrice) : '--'}</div>
      <div class="idx-chg">${ok
        ? `<span>${chg >= 0 ? '+' : ''}${fmt(chg)}</span><i>|</i><span class="${up ? 'pct-up' : 'pct-down'}">${pct >= 0 ? '+' : ''}${fmt(pct)}%</span>`
        : '<span>--</span>'}</div>`;
    attachDrag(card);
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
  if ($('setMarketHours')) $('setMarketHours').checked = state.settings.main.marketHoursOnly !== false;
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
    main: {
      theme: $('setTheme').value || 'system',
      refreshIntervalSeconds: Math.max(2, Number($('setInterval').value) || 3),
      marketHoursOnly: $('setMarketHours') ? $('setMarketHours').checked : true,
    },
    floating: {
      opacity: Number($('setOpacity').value) || 88,
      enabled: $('setFloatEnabled').checked,
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
