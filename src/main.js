// 工位看盘 - 主进程
const { app, BrowserWindow, ipcMain, Tray, Menu, Notification, globalShortcut, screen, nativeImage } = require('electron');
const path = require('path');
const Store = require('electron-store');
const { INDICES, defaultState } = require('./common/defaults');
const { fetchEastmoney, fetchSina, fetchTencent, searchStocks, selfTest } = require('./common/providers');

const store = new Store({ name: 'gongwei-stocks', defaults: defaultState() });
ensureDefaults();

let mainWin = null;
let floatWin = null;
let tray = null;
let lastQuotes = { stockQuotes: [], indexQuotes: [], indexMeta: [], updatedAt: null, source: 'none', errors: [] };
let pollTimer = null;
let badgeRotateTimer = null;
let badgeIndex = 0;
let stockSeq = 0;
const alertCooldown = new Map(); // stockId -> 上次提醒时间戳

function getState() {
  return store.store;
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
  for (const key of ['main', 'alerts', 'indices', 'floating']) {
    const cur = raw.settings[key];
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) {
      raw.settings[key] = d.settings[key];
      changed = true;
    }
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
  if (changed) store.set(raw);
  normalizeStocks(store.store);
}

// 逐只自选兜底：老数据可能缺 alert / badgeEnabled，补齐避免运行期崩溃
function normalizeStocks(st) {
  if (!st || !Array.isArray(st.stocks)) return;
  let changed = false;
  const blank = { enabled: false, upperPrice: null, lowerPrice: null, upperChangePercent: null, lowerChangePercent: null, snoozedUntil: null };
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
  });
  if (changed) store.set(st);
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
function isSnoozed(alert) {
  if (!alert || !alert.snoozedUntil) return false;
  return Date.parse(alert.snoozedUntil) > Date.now();
}

function checkAlerts(stocks, quotes) {
  const byId = new Map(quotes.map((q) => [q.stockId, q]));
  const hits = [];
  for (const s of stocks) {
    const a = s.alert;
    if (!a || !a.enabled || isSnoozed(a)) continue;
    const q = byId.get(s.id);
    if (!q || !q.ok) continue;
    const reasons = [];
    if (typeof a.upperPrice === 'number' && q.latestPrice >= a.upperPrice) reasons.push(`价格达到 ${a.upperPrice}`);
    if (typeof a.lowerPrice === 'number' && q.latestPrice <= a.lowerPrice) reasons.push(`价格跌至 ${a.lowerPrice}`);
    if (typeof a.upperChangePercent === 'number' && q.changePercent >= a.upperChangePercent) reasons.push(`涨幅达到 ${a.upperChangePercent}%`);
    if (typeof a.lowerChangePercent === 'number' && q.changePercent <= -a.lowerChangePercent) reasons.push(`跌幅达到 ${a.lowerChangePercent}%`);
    if (reasons.length) {
      hits.push({ stockId: s.id, stockName: s.name, stockCode: s.code, latestPrice: q.latestPrice, changePercent: q.changePercent, reasons });
    }
  }
  return hits;
}

function fmtPct(v) {
  return Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}%` : '--';
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

function mergeQuoteRows(stocks, outs) {
  const used = new Set();
  const rows = stocks.map((s) => {
    for (let i = 0; i < outs.length; i++) {
      const q = (outs[i] || []).find((r) => r.stockId === s.id);
      if (q && q.ok) {
        used.add(QUOTE_PROVIDERS[i][0]);
        return q;
      }
    }
    return { stockId: s.id, code: s.code, name: s.name, ok: false, updatedAt: Date.now() };
  });
  return { rows, source: used.size ? [...used].join('+') : 'none' };
}

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
  // 告警只对自选股做（同只 5 分钟内只提醒一次，避免每轮询一次轰炸一次）
  const hits = checkAlerts(stocks, lastQuotes.stockQuotes).filter((h) => {
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

function restartPoll() {
  if (pollTimer) clearInterval(pollTimer);
  const secs = Math.max(2, Number(getState().settings.main.refreshIntervalSeconds) || 3);
  pollTimer = setInterval(() => refreshMarket('auto'), secs * 1000);
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

function createFloatWindow() {
  const { w, h } = floatSize();
  const { x, y } = floatPosition(w, h);
  floatWin = new BrowserWindow({
    width: w,
    height: h,
    x, y,
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
  floatWin.loadFile(path.join(__dirname, 'float', 'float.html'));
  floatWin.on('closed', () => { floatWin = null; });
}

function toggleFloat() {
  if (floatWin && !floatWin.isDestroyed()) {
    if (floatWin.isVisible()) floatWin.hide();
    else { floatWin.show(); broadcastMarket(); }
  } else {
    // 显式点「浮窗」/热键时一律创建并显示（开启开关语义，不只受设置里的 enabled 限制）
    createFloatWindow();
    const st = getState();
    if (!st.settings.floating.enabled) {
      st.settings.floating.enabled = true;
      store.set(st);
    }
  }
  broadcastStore();
}

function createTray() {
  let trayIcon = nativeImage.createEmpty();
  try {
    const img = nativeImage.createFromPath(APP_ICON);
    if (!img.isEmpty()) trayIcon = img.resize({ width: 16, height: 16 });
  } catch { /* 用默认空图标兜底 */ }
  tray = new Tray(trayIcon);
  const menu = Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => { if (!mainWin) createMainWindow(); mainWin.show(); } },
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
  }));
  ipcMain.handle('selftest', () => selfTest());
  ipcMain.handle('search', (_e, keyword) => searchStocks(String(keyword || '').trim(), 10));

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
      sourceIds: item.sourceIds || {},
      order: st.stocks.length,
      badgeEnabled: true,
      alert: { enabled: false, upperPrice: null, lowerPrice: null, upperChangePercent: null, lowerChangePercent: null, snoozedUntil: null },
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

  // 通用字段更新：badgeEnabled（是否上浮窗）等
  ipcMain.handle('stocks:update', (_e, { id, patch }) => {
    const st = getState();
    const s = st.stocks.find((x) => x.id === id);
    if (!s) throw new Error('找不到股票');
    if (typeof patch.badgeEnabled === 'boolean') s.badgeEnabled = patch.badgeEnabled;
    if (typeof patch.name === 'string' && patch.name.trim()) s.name = patch.name.trim();
    st.updatedAt = new Date().toISOString();
    store.set(st);
    broadcastStore();
    return s;
  });

  // 排序：dir=-1 上移，+1 下移（数组物理换位，order 顺手重排）
  ipcMain.handle('stocks:move', (_e, { id, dir }) => {
    const st = getState();
    const i = st.stocks.findIndex((x) => x.id === id);
    const j = i + (dir > 0 ? 1 : -1);
    if (i < 0 || j < 0 || j >= st.stocks.length) return false;
    const [s] = st.stocks.splice(i, 1);
    st.stocks.splice(j, 0, s);
    st.stocks.forEach((x, k) => { x.order = k; });
    st.updatedAt = new Date().toISOString();
    store.set(st);
    broadcastStore();
    return true;
  });

  ipcMain.handle('stocks:snooze', (_e, { id, minutes = 30 }) => {
    const st = getState();
    const s = st.stocks.find((x) => x.id === id);
    if (!s) throw new Error('找不到股票');
    if (!s.alert || typeof s.alert !== 'object') s.alert = { enabled: false };
    s.alert.snoozedUntil = new Date(Date.now() + minutes * 60 * 1000).toISOString();
    st.updatedAt = new Date().toISOString();
    store.set(st);
    broadcastStore();
    return s;
  });

  ipcMain.handle('float:toggle', () => { toggleFloat(); return true; });
  ipcMain.handle('float:hide', () => { if (floatWin) floatWin.hide(); return true; });

  // 浮窗高度自适应：渲染完后由浮窗回报内容高度，窗口贴合内容（避免透明区域挡住下方点击）
  ipcMain.on('float:resize', (e, rawH) => {
    if (!floatWin || floatWin.isDestroyed() || e.sender !== floatWin.webContents) return;
    const h = Math.max(80, Math.min(560, Math.round(Number(rawH) || 0)));
    if (!h) return;
    const [w, curH] = floatWin.getContentSize();
    if (Math.abs(curH - h) <= 2) return;
    floatWin.setContentSize(w, h);
    const { x, y } = floatPosition(w, h);
    floatWin.setPosition(x, y);
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

  ipcMain.handle('settings:update', (_e, patch) => {
    const st = getState();
    const old = st.settings;
    st.settings = {
      ...old,
      ...patch,
      main: { ...old.main, ...(patch.main || {}) },
      alerts: { ...old.alerts, ...(patch.alerts || {}) },
      indices: { ...old.indices, ...(patch.indices || {}) },
      floating: { ...old.floating, ...(patch.floating || {}) },
    };
    st.updatedAt = new Date().toISOString();
    store.set(st);
    if (floatWin) {
      floatWin.setOpacity(Number(st.settings.floating.opacity ?? 88) / 100);
      const { x, y } = floatPosition(floatWin.getBounds().width, floatWin.getBounds().height);
      floatWin.setPosition(x, y);
      if (!st.settings.floating.enabled) floatWin.hide();
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
  if (mainWin) mainWin.webContents.send('store:changed', st);
  if (floatWin) floatWin.webContents.send('store:changed', st);
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

  app.whenReady().then(() => {
    registerIpc();
    createMainWindow();
    if (getState().settings.floating.enabled) createFloatWindow();
    createTray();
    globalShortcut.register('CommandOrControl+Shift+M', toggleFloat);
    restartPoll();
    startBadgeRotate();
    broadcastIndexMetaNow();
    refreshMarket('init');

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });

  app.on('window-all-closed', () => {
    // Windows：全关也不退出，留托盘
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (pollTimer) clearInterval(pollTimer);
    if (badgeRotateTimer) clearInterval(badgeRotateTimer);
  });
}
