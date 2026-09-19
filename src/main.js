// 工位看盘 - 主进程
const { app, BrowserWindow, ipcMain, Tray, Menu, Notification, globalShortcut, screen, nativeImage, net, session, shell, nativeTheme } = require('electron');
const path = require('path');
const Store = require('electron-store');
const { INDICES, defaultState, blankAlert } = require('./common/defaults');
const { fetchEastmoney, fetchSina, fetchTencent, searchStocks, selfTest, classifyCode, connectivityTest, mergeQuoteRows, fetchKline, fetchTrends, fetchStockDetail } = require('./common/providers');
const { setFetchImpl, fetchWithTimeout } = require('./common/http');
const { normalizeProxyMode, normalizeProxyRules, describeResolvedProxy } = require('./common/proxy');
const { isNewer, pickDownloadAsset } = require('./common/version');
const { describePhase, planTick } = require('./common/market-hours');
const { applyOrder, applyIndexOrder } = require('./common/order');
const { checkAlerts, fmtPct } = require('./common/alerts');

const store = new Store({ name: 'gongwei-stocks', defaults: defaultState() });
ensureDefaults();

let mainWin = null;
let floatWin = null;
let tray = null;
let lastQuotes = { stockQuotes: [], indexQuotes: [], indexMeta: [], updatedAt: null, source: 'none', errors: [] };
let badgeRotateTimer = null;
let badgeIndex = 0;
let stockSeq = 0;
const alertCooldown = new Map(); // stockId -> 上次提醒时间戳

function getState() {
  return store.store;
}

// ---------- 主题 ----------
// 界面里的深浅色只影响网页内部，Windows 的原生标题栏需要靠 nativeTheme 才会跟着变；
// 同时把窗口底色也同步，避免切主题时先闪一下白底
function effectiveTheme() {
  const t = (getState().settings.main && getState().settings.main.theme) || 'system';
  if (t === 'dark' || t === 'light') return t;
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

function themeBackground(theme) {
  return theme === 'dark' ? '#0f141b' : '#f1f5f9';
}

// 只给「有系统边框的主窗口」刷底色。
// 浮窗是 transparent 窗口，一旦被设成不透明底色，透明区就会被填实，
// Windows 会给它画一圈直角阴影，圆角外面就会露出直角（曾踩过）
function syncWindowBackground() {
  const bg = themeBackground(effectiveTheme());
  // 只给有系统边框的窗口刷底色（主窗口、K 线/提醒窗口）；透明浮窗不能设，否则圆角外露直角
  for (const w of [mainWin, chartWin, alertWin]) {
    if (w && !w.isDestroyed()) w.setBackgroundColor(bg);
  }
}

function applyNativeTheme() {
  const t = (getState().settings.main && getState().settings.main.theme) || 'system';
  nativeTheme.themeSource = t === 'dark' ? 'dark' : (t === 'light' ? 'light' : 'system');
  syncWindowBackground();
}

// 存量配置兜底：electron-store 的 defaults 只是浅合并，老版本写的 store 可能缺新字段，
// 这里在启动时补齐一次并落盘，避免界面各处 undefined 崩溃/功能失效
function ensureDefaults() {
  const d = defaultState();
  let raw;
  try {
    raw = store.store;
  } catch {
    store.store = d;
    return;
  }
  if (!raw || typeof raw !== 'object') {
    store.store = d;
    return;
  }
  let changed = false;
  if (!Array.isArray(raw.stocks)) { raw.stocks = []; changed = true; }
  if (!Array.isArray(raw.groups)) { raw.groups = d.groups; changed = true; }
  if (!raw.settings || typeof raw.settings !== 'object') { raw.settings = d.settings; changed = true; }
  for (const key of ['main', 'alerts', 'indices', 'floating', 'network', 'update']) {
    const cur = raw.settings[key];
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) {
      raw.settings[key] = d.settings[key];
      changed = true;
    }
  }
  if (!['system', 'direct', 'manual'].includes(raw.settings.network.proxyMode)) {
    raw.settings.network.proxyMode = d.settings.network.proxyMode;
    changed = true;
  }
  if (typeof raw.settings.network.proxyUrl !== 'string') {
    raw.settings.network.proxyUrl = '';
    changed = true;
  }
  if (Array.isArray(raw.settings.indices.selected)) {
    // 只保留已知指数 id，清掉历史脏数据
    const known = new Set(INDICES.map((i) => i.id));
    const clean = raw.settings.indices.selected.filter((id) => known.has(id));
    if (clean.length !== raw.settings.indices.selected.length) {
      raw.settings.indices.selected = clean;
      changed = true;
    }
  } else {
    raw.settings.indices.selected = d.settings.indices.selected;
    changed = true;
  }
  if (!Array.isArray(raw.settings.alerts.channels)) {
    raw.settings.alerts.channels = d.settings.alerts.channels;
    changed = true;
  }
  if (!Number.isFinite(Number(raw.settings.main.refreshIntervalSeconds))) {
    raw.settings.main.refreshIntervalSeconds = d.settings.main.refreshIntervalSeconds;
    changed = true;
  }
  if (typeof raw.settings.main.marketHoursOnly !== 'boolean') {
    raw.settings.main.marketHoursOnly = d.settings.main.marketHoursOnly;
    changed = true;
  }
  if (changed) store.set(raw);
  normalizeStocks(store.store);
}

// 逐只自选兜底：老数据可能缺 alert / badgeEnabled，补齐避免运行期崩溃
function normalizeStocks(st) {
  if (!st || !Array.isArray(st.stocks)) return;
  let changed = false;
  const blank = blankAlert();
  st.stocks = st.stocks.filter((s) => {
    if (!s || typeof s !== 'object' || !s.code) { changed = true; return false; }
    return true;
  });
  st.stocks.forEach((s, i) => {
    if (!s.alert || typeof s.alert !== 'object') { s.alert = { ...blank }; changed = true; }
    else {
      for (const k of Object.keys(blank)) {
        if (!(k in s.alert)) { s.alert[k] = blank[k]; changed = true; }
      }
    }
    if (typeof s.badgeEnabled !== 'boolean') { s.badgeEnabled = true; changed = true; }
    if (typeof s.order !== 'number') { s.order = i; changed = true; }
    if (!s.exchange) { s.exchange = 'SH'; changed = true; }
    if (!s.market) { s.market = 'CN'; changed = true; }
    // 品种类型：老数据没有，用代码前缀推断（基金/可转债/股票）
    if (!s.securityType) { s.securityType = classifyCode(s.code).securityType; changed = true; }
  });
  if (changed) store.set(st);
}

// ---------- 检查更新 ----------
const RELEASE_API = 'https://api.github.com/repos/lyhxx/gongwei-stocks-desktop/releases/latest';
const RELEASE_PAGE = 'https://github.com/lyhxx/gongwei-stocks-desktop/releases/latest';
let updateState = { checked: false, hasUpdate: false, current: '', latest: '', url: '', notes: '', asset: null, error: '', at: 0 };

// 只允许打开 github.com 的 https 链接，避免被远端数据带偏
function safeExternalUrl(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'https:') return '';
    if (!/(^|\.)github\.com$/.test(u.hostname) && !/(^|\.)githubusercontent\.com$/.test(u.hostname)) return '';
    return u.toString();
  } catch {
    return '';
  }
}

async function checkForUpdates() {
  const current = app.getVersion();
  try {
    const res = await fetchWithTimeout(RELEASE_API, {
      headers: { 'User-Agent': `gongwei-stocks-desktop/${current}`, Accept: 'application/vnd.github+json' },
    }, 8000);
    if (!res.ok) throw new Error(`GitHub 返回 ${res.status}`);
    const rel = await res.json();
    const latest = String(rel.tag_name || '').replace(/^v/i, '');
    const hasUpdate = isNewer(latest, current);
    const asset = pickDownloadAsset(rel);
    updateState = {
      checked: true,
      hasUpdate,
      current,
      latest,
      url: safeExternalUrl(rel.html_url) || RELEASE_PAGE,
      notes: String(rel.body || '').slice(0, 4000),
      asset: asset && safeExternalUrl(asset.url) ? asset : null,
      error: '',
      at: Date.now(),
    };
  } catch (e) {
    updateState = { ...updateState, checked: true, hasUpdate: false, current, error: e.message, at: Date.now() };
  }
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('update:state', updateState);
  return updateState;
}

// 启动后静默检查一次：距上次超过 20 小时才查，避免每次开都打接口
function maybeAutoCheckUpdate() {
  const cfg = (getState().settings.update) || {};
  if (cfg.autoCheck === false) return;
  const last = Number(cfg.lastCheckAt || 0);
  if (Date.now() - last < 20 * 60 * 60 * 1000) return;
  setTimeout(() => {
    checkForUpdates().then(() => {
      const st = getState();
      st.settings.update = { ...st.settings.update, lastCheckAt: Date.now() };
      store.set(st);
      broadcastStore();
    }).catch(() => { /* 静默失败 */ });
  }, 8000);
}

// ---------- 网络代理 ----------
// 请求统一走 Electron 的 net.fetch（Chromium 网络栈），因此这里只要把 session 的
// 代理策略设对，行情请求就会自动走系统代理/PAC 或用户手填的代理。
let proxyStatus = { mode: 'system', resolved: '', error: '' };

async function applyProxy() {
  const cfg = getState().settings.network || {};
  const mode = normalizeProxyMode(cfg.proxyMode);
  const ses = session.defaultSession;
  try {
    if (mode === 'direct') {
      await ses.setProxy({ mode: 'direct' });
    } else if (mode === 'manual') {
      const { ok, rules, error } = normalizeProxyRules(cfg.proxyUrl);
      if (!ok) throw new Error(error);
      await ses.setProxy({ proxyRules: rules });
    } else {
      await ses.setProxy({ mode: 'system' });
    }
    // 丢掉旧连接池，避免切换代理后仍复用旧通道
    if (typeof ses.closeAllConnections === 'function') await ses.closeAllConnections();
    const resolved = await ses.resolveProxy('https://push2.eastmoney.com');
    proxyStatus = { mode, resolved, error: '' };
  } catch (e) {
    proxyStatus = { mode, resolved: '', error: e.message };
    // 配置有问题时退回直连，至少不至于完全不可用
    try { await ses.setProxy({ mode: 'direct' }); } catch { /* 忽略 */ }
  }
  return proxyStatus;
}

async function setupNetwork() {
  // 让 providers 的请求走 Chromium 网络栈（自带系统代理、PAC、证书处理）
  setFetchImpl((url, init) => net.fetch(url, init));
  await applyProxy();
}

// 纯代码直加时 name 就是 code，行情回来后把真实名称回填（仅当 name 还没被改过时）
function backfillNames(stocks, quotes) {
  const byId = new Map(quotes.map((q) => [q.stockId, q]));
  let dirty = false;
  for (const s of stocks) {
    if (s.name !== s.code) continue;
    const q = byId.get(s.id);
    if (q && q.ok && q.name && q.name !== s.code && q.name !== s.name) {
      s.name = q.name;
      dirty = true;
    }
  }
  if (dirty) {
    const st = getState();
    st.updatedAt = new Date().toISOString();
    store.set(st);
    broadcastStore();
  }
}

// ---------- 告警判定 ----------
// 判定本身在 common/alerts.js（纯函数，有单测）；这里维护「N 分钟急涨急跌」用的价格采样
const priceHistory = new Map();
const HISTORY_MAX_MS = 120 * 60 * 1000;
function pruneHistory(now) {
  for (const [id, arr] of priceHistory) {
    while (arr.length && now - arr[0].t > HISTORY_MAX_MS) arr.shift();
    if (!arr.length) priceHistory.delete(id);
  }
}
function recordPriceHistory(quotes) {
  const now = Date.now();
  for (const q of quotes) {
    if (!q || !q.ok || !Number.isFinite(q.latestPrice)) continue;
    let arr = priceHistory.get(q.stockId);
    if (!arr) { arr = []; priceHistory.set(q.stockId, arr); }
    arr.push({ t: now, p: q.latestPrice });
  }
  pruneHistory(now);
}

function fmtPrice(v) {
  return Number.isFinite(v) ? v.toFixed(2) : '--';
}

function showNotification(title, body) {
  try {
    if (!Notification.isSupported()) return false;
    new Notification({ title, body }).show();
    return true;
  } catch {
    return false;
  }
}

function notifyHits(hits) {
  const st = getState();
  if (!st.settings.alerts.channels.includes('notify')) return;
  if (!hits.length) return;
  if (st.settings.alerts.mergeSameStock) {
    const h = hits[0];
    showNotification(
      `${h.stockName}触发价格提醒`,
      `${h.reasons.join('；')}，现价 ${fmtPrice(h.latestPrice)}（${fmtPct(h.changePercent)}）${hits.length > 1 ? `（另有${hits.length - 1}只同时触发）` : ''}`,
    );
  } else {
    for (const h of hits.slice(0, 3)) {
      showNotification(
        `${h.stockName}触发价格提醒`,
        `${h.reasons.join('；')}，现价 ${fmtPrice(h.latestPrice)}（${fmtPct(h.changePercent)}）`,
      );
    }
  }
}

// ---------- 行情轮询 ----------
let refreshing = false;
let refreshGen = 0;
async function refreshMarket(reason = 'auto') {
  // 上一轮没跑完就跳过（弱网超时时防止并发堆积、旧慢响应覆盖新数据）
  if (refreshing && reason === 'auto') return lastQuotes;
  refreshing = true;
  try {
    return await doRefreshMarket(reason);
  } finally {
    refreshing = false;
  }
}

// 渐进式行情：三路并行，每路回来立刻合并广播一次（谁快谁先画），
// 最后再收尾（补空错误、回填名称、告警、托盘）。弱网下首屏从等最慢变成等最快。
const QUOTE_PROVIDERS = [
  ['eastmoney', fetchEastmoney],
  ['sina', fetchSina],
  ['tencent', fetchTencent],
];

async function doRefreshMarket(reason = 'auto') {
  const gen = ++refreshGen;
  const st = getState();
  const stocks = st.stocks || [];
  const selectedIndices = (st.settings.indices && st.settings.indices.selected) || [];
  const indexStocks = INDICES.filter((i) => selectedIndices.includes(i.id))
    .map((i) => ({ id: `index:${i.id}`, code: i.code, name: i.name, market: i.market, exchange: i.exchange }));
  const all = [...stocks, ...indexStocks];
  const indexMeta = indexStocks.map((i) => ({ stockId: i.id, code: i.code, name: i.name }));
  if (!all.length) {
    lastQuotes = { stockQuotes: [], indexQuotes: [], indexMeta, updatedAt: lastQuotes.updatedAt, source: 'empty', errors: [] };
    broadcastMarket();
    return lastQuotes;
  }
  const outs = [[], [], []];
  const errors = [];
  const applyMerge = () => {
    if (gen !== refreshGen) return; // 有更新的一轮在跑，丢弃本轮结果，避免旧数据盖新数据
    const { rows, source } = mergeQuoteRows(all, outs);
    lastQuotes = {
      stockQuotes: rows.filter((r) => !String(r.stockId).startsWith('index:')),
      indexQuotes: rows.filter((r) => String(r.stockId).startsWith('index:')),
      indexMeta, updatedAt: Date.now(), source, errors: [...errors],
    };
    broadcastMarket();
  };
  await Promise.all(QUOTE_PROVIDERS.map(([pname, fn], i) =>
    fn(all).then((rows) => {
      if (!rows.some((r) => r.ok)) errors.push(`${pname}: no ok rows`);
      outs[i] = rows;
      applyMerge();
    }).catch((e) => {
      errors.push(`${pname}: ${e.message}`);
      applyMerge();
    })
  ));
  if (gen !== refreshGen) return lastQuotes; // 本轮已过期，收尾也别做
  backfillNames(stocks, lastQuotes.stockQuotes);
  recordPriceHistory(lastQuotes.stockQuotes); // 先留样，供「N 分钟急涨急跌」比对
  // 告警只对自选股做（同只 5 分钟内只提醒一次，避免每轮询一次轰炸一次）
  const hits = checkAlerts(stocks, lastQuotes.stockQuotes, { history: priceHistory }).filter((h) => {
    const last = alertCooldown.get(h.stockId) || 0;
    if (Date.now() - last < 5 * 60 * 1000) return false;
    alertCooldown.set(h.stockId, Date.now());
    return true;
  });
  if (hits.length && reason !== 'init') {
    notifyHits(hits);
    const payload = { hits, at: Date.now() };
    if (mainWin) mainWin.webContents.send('alert:trigger', payload);
    if (floatWin) floatWin.webContents.send('alert:trigger', payload);
  }
  updateTrayTooltip();
  return lastQuotes;
}

function broadcastMarket() {
  const payload = lastQuotes;
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('market:update', payload);
  if (floatWin && !floatWin.isDestroyed()) floatWin.webContents.send('market:update', payload);
}

// ---------- 轮询调度：只在交易时段打接口 ----------
// 收盘 / 午休 / 周末 / 节假日一律不发请求；15:00~15:30 留一个快照窗口，
// 保证收盘后仍能拿到当天最后一条数据。定时器最多睡 60 秒，便于设置变更后快速响应。
let smartTimer = null;
let closeSnapshotDay = '';              // 已经补抓过收盘快照的交易日
let sessionInfo = { phase: 'closed', day: '', nextChangeAt: 0 };

function broadcastSession() {
  const payload = { ...sessionInfo, label: describePhase(sessionInfo.phase) };
  for (const w of [mainWin, floatWin]) {
    if (w && !w.isDestroyed()) w.webContents.send('session:update', payload);
  }
}

function scheduleTick(ms) {
  if (smartTimer) clearTimeout(smartTimer);
  smartTimer = setTimeout(() => { tick().catch(() => { /* 出错也别停掉调度 */ }); }, Math.max(200, Math.min(Number(ms) || 0, 60000)));
}

async function tick() {
  const cfg = getState().settings.main || {};
  // 该不该请求、下一次睡多久，全部由纯函数决定（见 common/market-hours.js，有单测覆盖）
  const plan = planTick(cfg, new Date(), { closeSnapshotDay });

  if (plan.info) {
    const changed = plan.info.phase !== sessionInfo.phase || plan.info.day !== sessionInfo.day;
    sessionInfo = plan.info;
    if (changed) broadcastSession();
  } else if (sessionInfo.phase !== 'always') {
    // 关掉「仅交易时段请求」后 planTick 不再返回时段信息，这里主动清掉旧状态，
    // 否则状态栏会一直停在「已收盘 / 午间休市」，看起来像坏了
    sessionInfo = { phase: 'always', day: '', nextChangeAt: 0 };
    broadcastSession();
  }

  if (plan.action === 'fetch') {
    await refreshMarket('auto');
  } else if (plan.action === 'snapshot') {
    closeSnapshotDay = plan.info.day;   // 当天只补抓一次
    await refreshMarket('close');
  }
  scheduleTick(plan.delay);
}

function restartPoll() {
  if (smartTimer) clearTimeout(smartTimer);
  smartTimer = null;
  scheduleTick(0);
}

// ---------- 托盘提示轮播 ----------
function updateTrayTooltip() {
  if (!tray) return;
  const st = getState();
  if (!st.settings.alerts.badgeEnabled) {
    tray.setToolTip('工位看盘');
    return;
  }
  const ok = lastQuotes.stockQuotes.filter((q) => q.ok);
  if (!ok.length) {
    tray.setToolTip('工位看盘');
    return;
  }
  const q = ok[badgeIndex % ok.length];
  const s = (st.stocks.find((x) => x.id === q.stockId) || {}).name || q.name;
  if (!Number.isFinite(q.latestPrice) || !Number.isFinite(q.changePercent)) {
    tray.setToolTip('工位看盘');
    return;
  }
  const sign = q.changePercent >= 0 ? '+' : '';
  tray.setToolTip(`${s} ${q.latestPrice.toFixed(2)}（${sign}${q.changePercent.toFixed(2)}%）`);
}

function startBadgeRotate() {
  if (badgeRotateTimer) clearInterval(badgeRotateTimer);
  badgeRotateTimer = setInterval(() => { badgeIndex += 1; updateTrayTooltip(); }, 5000);
}

// ---------- 窗口 ----------
const APP_ICON = path.join(__dirname, '..', 'build', 'icon.png');

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 420,
    height: 640,
    title: '工位看盘',
    icon: APP_ICON,
    autoHideMenuBar: true,
    backgroundColor: themeBackground(effectiveTheme()),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  mainWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWin.on('close', (e) => {
    // 关闭进托盘，不退出（摸鱼刚需）
    if (!app.quitting) {
      e.preventDefault();
      mainWin.hide();
    }
  });
  mainWin.on('closed', () => { mainWin = null; });
}

function floatPosition(width, height) {
  const { workArea } = screen.getPrimaryDisplay();
  const pos = getState().settings.floating.position || 'bottom-right';
  const m = 18;
  const x = pos.includes('right') ? Math.round(workArea.x + workArea.width - width - m) : Math.round(workArea.x + m);
  const y = pos.includes('bottom') ? Math.round(workArea.y + workArea.height - height - m) : Math.round(workArea.y + m);
  return { x, y };
}

function floatSize() {
  const w = Math.max(200, Math.min(420, Number(getState().settings.floating.width) || 250));
  const h = 360; // 初始高度，渲染完成后浮窗会回报真实高度自适应
  return { w, h };
}

// ---------- 浮窗 ----------
let floatRevealed = false;     // 是否已经显示过
let floatReady = false;        // 首帧是否已经画完（ready-to-show）
let floatSized = false;        // 是否已收到过有效的高度回报
let floatPendingShow = false;  // 已请求渲染层同步、正等它回报高度后再显示

function workArea() {
  return screen.getPrimaryDisplay().workArea;
}

function doShowFloat() {
  if (!floatWin || floatWin.isDestroyed()) return;
  floatPendingShow = false;
  floatRevealed = true;
  if (!floatWin.isVisible()) floatWin.showInactive(); // 不抢焦点，摸鱼时不打断当前操作
}

// 首次显示要同时满足「首帧已绘制」+「尺寸已定好」再 show，否则会先出现空白/旧尺寸再跳一下
function revealFloat() {
  if (!floatWin || floatWin.isDestroyed() || floatRevealed) return;
  if (!(floatReady && floatSized)) return;
  doShowFloat();
}

// 显示一个已创建过的浮窗：先让渲染层用最新数据重算高度，等回报到了再 show。
// 直接在 show 后渲染/缩放会有一次可见跳动；先同步后显示则全程在隐藏状态下完成。
function showExistingFloat() {
  if (!floatWin || floatWin.isDestroyed() || floatWin.isVisible()) return;
  if (!floatRevealed) { revealFloat(); return; } // 首次走 ready-to-show 那套
  floatPendingShow = true;
  floatWin.webContents.send('float:sync');
  // 兜底：渲染层没回（异常）也不能一直不显示
  setTimeout(() => { if (floatPendingShow) doShowFloat(); }, 120);
}

// 统一的隐藏入口：顺手取消「等回报再显示」，避免刚请求显示又立刻隐藏时被重新弹出来
function hideFloatWindow() {
  floatPendingShow = false;
  if (floatWin && !floatWin.isDestroyed()) floatWin.hide();
}

function createFloatWindow() {
  const { w, h } = floatSize();
  const { x, y } = floatPosition(w, h);
  floatRevealed = false;
  floatReady = false;
  floatSized = false;
  floatPendingShow = false;
  floatWin = new BrowserWindow({
    width: w,
    height: h,
    x, y,
    show: false, // 关键：先别显示
    title: '工位看盘浮窗',
    icon: APP_ICON,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  floatWin.setOpacity(Number(getState().settings.floating.opacity ?? 88) / 100);
  floatWin.setMenu(null);                 // 无边框窗口不需要系统菜单
  floatWin.loadFile(path.join(__dirname, 'float', 'float.html'));
  // 右键给一套自己的菜单，而不是系统的默认菜单
  floatWin.webContents.on('context-menu', (e) => {
    e.preventDefault();
    showFloatMenu();
  });
  floatWin.once('ready-to-show', () => { floatReady = true; revealFloat(); });
  // 兜底：万一 ready-to-show 没触发或渲染层一直没回报高度，也不能让窗口一直不可见
  setTimeout(() => { floatReady = true; floatSized = true; revealFloat(); }, 800);
  floatWin.on('closed', () => {
    floatWin = null;
    floatRevealed = false;
    floatReady = false;
    floatSized = false;
    floatPendingShow = false;
  });
}

// 浮窗右键菜单
function showFloatMenu() {
  if (!floatWin || floatWin.isDestroyed()) return;
  const st = getState();
  const menu = Menu.buildFromTemplate([
    { label: '立即刷新', click: () => refreshMarket('manual') },
    { label: '显示主窗口', click: () => showMainWindow() },
    { label: '设置…', click: () => { showMainWindow(); if (mainWin) mainWin.webContents.send('ui:open-settings'); } },
    { type: 'separator' },
    { label: '隐藏浮窗（Ctrl+Shift+M）', click: () => hideFloatWindow() },
    {
      label: st.settings.floating.enabled ? '停用浮窗' : '启用浮窗',
      click: () => {
        const next = !getState().settings.floating.enabled;
        const cur = getState();
        cur.settings.floating.enabled = next;
        store.set(cur);
        if (!next) hideFloatWindow();
        broadcastStore();
        if (next && (!floatWin || floatWin.isDestroyed())) createFloatWindow();
        else if (next) showExistingFloat();
      },
    },
    { type: 'separator' },
    { label: '退出工位看盘', click: () => { app.quitting = true; app.quit(); } },
  ]);
  menu.popup({ window: floatWin });
}

function showMainWindow() {
  if (!mainWin || mainWin.isDestroyed()) createMainWindow();
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
}

function toggleFloat() {
  if (floatWin && !floatWin.isDestroyed()) {
    if (floatWin.isVisible()) {
      hideFloatWindow();
      return;
    }
    showExistingFloat();
    return;
  }
  // 显式点「浮窗」/热键时一律创建并显示（开启开关语义，不只受设置里的 enabled 限制）
  createFloatWindow();
  const st = getState();
  if (!st.settings.floating.enabled) {
    st.settings.floating.enabled = true;
    store.set(st);
  }
  broadcastStore();
}

// ---------- K 线独立窗口 ----------
// 独立 BrowserWindow，避免主窗口尺寸受限、出现滚动条；宽高可自由调整
let chartWin = null;
let chartStock = null;

function createChartWindow() {
  const win = new BrowserWindow({
    width: 780,
    height: 560,
    minWidth: 560,
    minHeight: 380,
    title: 'K线',
    icon: APP_ICON,
    autoHideMenuBar: true,
    backgroundColor: themeBackground(effectiveTheme()),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'chart', 'chart.html'));
  win.on('closed', () => { if (chartWin === win) chartWin = null; });
  return win;
}

function openChartWindow(stock) {
  chartStock = stock || null;
  if (!chartWin || chartWin.isDestroyed()) {
    chartWin = createChartWindow(); // 页面加载后由 chart.js 主动来取当前股票
    return;
  }
  if (chartWin.isMinimized()) chartWin.restore();
  chartWin.show();
  chartWin.focus();
  // 已加载完就直接推新数据；还在加载则等它自己取
  if (!chartWin.webContents.isLoading()) chartWin.webContents.send('chart:update', chartStock);
}

// ---------- 提醒独立窗口 ----------
let alertWin = null;
let alertStock = null;

function createAlertWindow() {
  const win = new BrowserWindow({
    width: 560,
    height: 740,
    minWidth: 460,
    minHeight: 480,
    title: '价格提醒',
    icon: APP_ICON,
    autoHideMenuBar: true,
    backgroundColor: themeBackground(effectiveTheme()),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'alert', 'alert.html'));
  win.on('closed', () => { if (alertWin === win) alertWin = null; });
  return win;
}

function openAlertWindow(stock) {
  alertStock = stock || null;
  if (!alertWin || alertWin.isDestroyed()) {
    alertWin = createAlertWindow(); // 页面加载后由 alert.js 主动来取当前股票
    return;
  }
  if (alertWin.isMinimized()) alertWin.restore();
  alertWin.show();
  alertWin.focus();
  if (!alertWin.webContents.isLoading()) alertWin.webContents.send('alert:update', alertStock);
}

function createTray() {
  let trayIcon = nativeImage.createEmpty();
  try {
    const img = nativeImage.createFromPath(APP_ICON);
    if (!img.isEmpty()) trayIcon = img.resize({ width: 16, height: 16 });
  } catch { /* 用默认空图标兜底 */ }
  tray = new Tray(trayIcon);
  const menu = Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => showMainWindow() },
    { label: '显示/隐藏浮窗（Ctrl+Shift+M）', click: toggleFloat },
    { type: 'separator' },
    { label: '立即刷新', click: () => refreshMarket('manual') },
    { type: 'separator' },
    {
      label: '退出', click: () => {
        app.quitting = true;
        app.quit();
      },
    },
  ]);
  tray.setToolTip('工位看盘');
  tray.setContextMenu(menu);
  tray.on('click', () => {
    if (mainWin && mainWin.isVisible()) mainWin.hide();
    else if (mainWin) mainWin.show();
    else createMainWindow();
  });
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.handle('store:get', () => getState());
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('market:get', () => lastQuotes);
  ipcMain.handle('market:refresh', () => refreshMarket('manual'));
  ipcMain.handle('diagnose', () => ({
    source: lastQuotes.source,
    updatedAt: lastQuotes.updatedAt,
    errors: lastQuotes.errors || [],
    stockCount: (getState().stocks || []).length,
    proxy: {
      mode: proxyStatus.mode,
      resolved: describeResolvedProxy(proxyStatus.resolved),
      error: proxyStatus.error,
    },
  }));
  ipcMain.handle('proxy:apply', () => applyProxy());
  // 连通性测试：真实请求三条行情通道（走当前代理设置），设置页里随手点一下就能知道通不通
  ipcMain.handle('proxy:test', async () => {
    const t0 = Date.now();
    const results = await connectivityTest();
    return {
      at: Date.now(),
      elapsedMs: Date.now() - t0,
      proxy: { mode: proxyStatus.mode, resolved: describeResolvedProxy(proxyStatus.resolved), error: proxyStatus.error },
      results,
    };
  });
  ipcMain.handle('update:check', () => checkForUpdates());
  // 更新状态是主进程单向推送（update:state），渲染层不主动拉取，所以这里不需要 handle
  ipcMain.handle('open:external', (_e, url) => {
    const safe = safeExternalUrl(url);
    if (!safe) throw new Error('只允许打开 github.com 的 https 链接');
    shell.openExternal(safe);
    return true;
  });
  ipcMain.handle('selftest', () => selfTest());
  ipcMain.handle('search', (_e, keyword) => searchStocks(String(keyword || '').trim(), 10));

  // K 线 / 分时：按前端传回的自选描述（含 secid 线索的 sourceIds）取历史数据
  ipcMain.handle('kline:get', (_e, { stock, period, limit } = {}) => fetchKline(stock || {}, period, limit));
  ipcMain.handle('trends:get', (_e, stock) => fetchTrends(stock || {}));
  ipcMain.handle('detail:get', (_e, stock) => fetchStockDetail(stock || {}));
  ipcMain.handle('chart:open', (_e, stock) => { openChartWindow(stock); return true; });
  ipcMain.handle('chart:stock', () => chartStock);
  ipcMain.handle('alert:open', (_e, stock) => { openAlertWindow(stock); return true; });
  ipcMain.handle('alert:stock', () => alertStock);

  ipcMain.handle('stocks:add', (_e, item) => {
    const st = getState();
    const code = String(item.code || '').trim();
    if (!code) throw new Error('代码为空');
    const exchange = item.exchange || 'SH';
    const market = item.market || 'CN';
    if (st.stocks.some((s) => s.code === code && s.exchange === exchange)) throw new Error('已在自选中');
    const stock = {
      id: `s${Date.now().toString(36)}${(stockSeq += 1).toString(36)}`,
      code,
      name: String(item.name || code),
      market,
      exchange,
      securityType: item.securityType || classifyCode(code).securityType,
      sourceIds: item.sourceIds || {},
      order: st.stocks.length,
      badgeEnabled: true,
      alert: blankAlert(),
    };
    st.stocks.push(stock);
    st.updatedAt = new Date().toISOString();
    store.set(st);
    refreshMarket('manual');
    broadcastStore();
    return stock;
  });

  ipcMain.handle('stocks:remove', (_e, id) => {
    const st = getState();
    st.stocks = st.stocks.filter((s) => s.id !== id);
    st.updatedAt = new Date().toISOString();
    store.set(st);
    // 彻底清残留：行情缓存 + 提醒冷却里的旧 id，否则界面/托盘还留着影子
    lastQuotes.stockQuotes = (lastQuotes.stockQuotes || []).filter((q) => q.stockId !== id);
    alertCooldown.delete(id);
    priceHistory.delete(id);
    broadcastStore();
    broadcastMarket();
    refreshMarket('manual');
    return true;
  });

  ipcMain.handle('stocks:update-alert', (_e, { id, alert }) => {
    const st = getState();
    const s = st.stocks.find((x) => x.id === id);
    if (!s) throw new Error('找不到股票');
    s.alert = { ...s.alert, ...alert };
    st.updatedAt = new Date().toISOString();
    store.set(st);
    broadcastStore();
    return s;
  });

  // 拖拽排序：前端给出新的 id 顺序，主进程校验后重排
  ipcMain.handle('stocks:reorder', (_e, ids) => {
    const st = getState();
    st.stocks = applyOrder(st.stocks || [], ids);
    st.updatedAt = new Date().toISOString();
    store.set(st);
    broadcastStore();
    return st.stocks.map((s) => s.id);
  });

  ipcMain.handle('float:toggle', () => { toggleFloat(); return true; });
  ipcMain.handle('float:hide', () => { hideFloatWindow(); return true; });

  // 浮窗高度自适应：渲染完后由浮窗回报内容高度，窗口贴合内容
  ipcMain.on('float:resize', (e, rawH) => {
    if (!floatWin || floatWin.isDestroyed() || e.sender !== floatWin.webContents) return;
    const raw = Number(rawH);
    // 0 / NaN 是渲染中途的无效回报，必须在夹紧之前挡掉：
    // 否则会被夹到 80px 把窗口先缩小，下一帧再撑开，看起来就是闪一下
    if (!Number.isFinite(raw) || raw <= 0) return;
    floatSized = true; // 收到真实高度，首次显示的前提条件之一
    const h = Math.max(80, Math.min(560, Math.round(raw)));
    const [w, curH] = floatWin.getContentSize();
    // 尺寸变化一律在「显示之前」应用：先按真实高度定好，再 show，避免"出现→跳一下"
    if (Math.abs(curH - h) > 2) {
      floatWin.setContentSize(w, h);
      // 只夹紧垂直位置，水平位置保持用户拖到的地方
      const b = floatWin.getBounds();
      const wa = workArea();
      floatWin.setPosition(b.x, Math.min(Math.max(b.y, wa.y), wa.y + wa.height - h));
    }
    if (floatPendingShow) doShowFloat();
    else revealFloat();
  });

  // 指数拖拽排序：selected 的顺序即展示顺序
  ipcMain.handle('indices:reorder', (_e, ids) => {
    const st = getState();
    st.settings.indices.selected = applyIndexOrder(st.settings.indices.selected || [], ids);
    st.updatedAt = new Date().toISOString();
    store.set(st);
    broadcastStore();
    return st.settings.indices.selected;
  });

  // 指数单选原子切换（主进程单线程读改写，前端连点再快也不丢操作；
  // 之前前端先 getStore 再算集合，连点两次必丢一次）
  ipcMain.handle('indices:toggle', (_e, { id, on }) => {
    if (!INDICES.some((i) => i.id === id)) throw new Error(`未知指数：${id}`);
    const st = getState();
    const cur = new Set(st.settings.indices.selected || []);
    if (on) cur.add(id);
    else cur.delete(id);
    st.settings.indices.selected = [...cur];
    st.updatedAt = new Date().toISOString();
    store.set(st);
    // 立刻把缓存里对应指数的行情/元数据同步掉，界面无需等下一次网络刷新
    const stockId = `index:${id}`;
    const keep = new Set([...cur].map((x) => `index:${x}`));
    lastQuotes = {
      ...lastQuotes,
      indexMeta: (lastQuotes.indexMeta || []).filter((m) => keep.has(m.stockId)),
      indexQuotes: (lastQuotes.indexQuotes || []).filter((q) => keep.has(q.stockId)),
    };
    if (on) {
      const def = INDICES.find((i) => i.id === id);
      if (def && !lastQuotes.indexMeta.some((m) => m.stockId === stockId)) {
        lastQuotes.indexMeta = [...lastQuotes.indexMeta, { stockId, code: def.code, name: def.name }];
      }
    }
    broadcastMarket();
    broadcastStore();
    refreshMarket('manual');
    return st.settings.indices.selected;
  });

  ipcMain.handle('settings:update', async (_e, patch) => {
    const st = getState();
    const old = st.settings;
    st.settings = {
      ...old,
      ...patch,
      main: { ...old.main, ...(patch.main || {}) },
      alerts: { ...old.alerts, ...(patch.alerts || {}) },
      indices: { ...old.indices, ...(patch.indices || {}) },
      floating: { ...old.floating, ...(patch.floating || {}) },
      network: { ...old.network, ...(patch.network || {}) },
    };
    st.updatedAt = new Date().toISOString();
    store.set(st);
    if (patch.network) await applyProxy();
    if (patch.main && 'theme' in patch.main) applyNativeTheme();
    if (floatWin && !floatWin.isDestroyed()) {
      floatWin.setOpacity(Number(st.settings.floating.opacity ?? 88) / 100);
      // 只有「位置/宽度」这类布局设置变了才把浮窗挪回设定角落；
      // 否则用户把浮窗拖到哪，改一下刷新间隔就被拽回右下角，很恼人
      const fl = patch.floating || {};
      if ('position' in fl || 'width' in fl) {
        const { x, y } = floatPosition(floatWin.getBounds().width, floatWin.getBounds().height);
        floatWin.setPosition(x, y);
      }
      const wasEnabled = !!(old.floating && old.floating.enabled);
      if (!st.settings.floating.enabled) hideFloatWindow();
      // 仅当「关→开」时才主动显示：临时隐藏过的浮窗（Esc/热键）不会因保存设置而弹回来
      else if (!wasEnabled) showExistingFloat();
    } else if (st.settings.floating.enabled) {
      // 之前关掉过浮窗（窗口未创建），这里重新打开设置要能把它建出来
      createFloatWindow();
    }
    restartPoll();
    broadcastStore();
    refreshMarket('manual');
    return st.settings;
  });

  ipcMain.handle('notify:test', () => {
    const ok = showNotification('工位看盘', '提醒通道正常，摸鱼继续，盯盘不误。');
    return { ok, message: ok ? '' : '当前系统不支持通知，请检查 Windows 通知设置' };
  });
}

function broadcastStore() {
  const st = getState();
  // 与 broadcastMarket 保持一致：窗口销毁瞬间（close 已触发但引用还没置空）send 会抛错
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('store:changed', st);
  if (floatWin && !floatWin.isDestroyed()) floatWin.webContents.send('store:changed', st);
  if (chartWin && !chartWin.isDestroyed()) chartWin.webContents.send('store:changed', st);
  if (alertWin && !alertWin.isDestroyed()) alertWin.webContents.send('store:changed', st);
}

// 启动时先把指数名单广播出去（不等慢速行情回来，界面秒出中文名）
function broadcastIndexMetaNow() {
  const selected = (getState().settings.indices && getState().settings.indices.selected) || [];
  lastQuotes.indexMeta = INDICES.filter((i) => selected.includes(i.id))
    .map((i) => ({ stockId: `index:${i.id}`, code: i.code, name: i.name }));
  broadcastMarket();
}

// ---------- 启动 ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWin) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.show();
    }
  });

  app.whenReady().then(async () => {
    // 去掉默认应用菜单：否则按 Alt 会弹出原生 File / Edit 菜单条，跟这个托盘小工具不搭
    Menu.setApplicationMenu(null);
    registerIpc();
    applyNativeTheme(); // 先定好深浅色，再开窗口，免得标题栏先白一下
    // 跟随系统时，Windows 切换深浅色要同步窗口底色（原生标题栏由 nativeTheme 自动跟）
    nativeTheme.on('updated', () => syncWindowBackground());
    // 先把网络层准备好（net.fetch + 代理策略），再发第一批行情
    await setupNetwork();
    createMainWindow();
    if (getState().settings.floating.enabled) createFloatWindow();
    createTray();
    globalShortcut.register('CommandOrControl+Shift+M', toggleFloat);
    startBadgeRotate();
    broadcastIndexMetaNow();
    // 先拉一次（哪怕已收盘，也让界面立刻有上一笔收盘价），再交给交易时段调度
    refreshMarket('init');
    restartPoll();
    maybeAutoCheckUpdate();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });

  app.on('window-all-closed', () => {
    // Windows：全关也不退出，留托盘
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (smartTimer) clearTimeout(smartTimer);
    if (badgeRotateTimer) clearInterval(badgeRotateTimer);
  });
}
