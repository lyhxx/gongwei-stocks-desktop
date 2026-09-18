// 工位看盘 - 主窗口/浮窗 DOM 执行测试（jsdom 真跑渲染与交互，npm test 会跑）
const fs = require('fs');
const assert = require('assert');
const path = require('path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'src', 'renderer', 'app.js'), 'utf8');
const fhtml = fs.readFileSync(path.join(root, 'src', 'float', 'float.html'), 'utf8');
const fjs = fs.readFileSync(path.join(root, 'src', 'float', 'float.js'), 'utf8');
const chtml = fs.readFileSync(path.join(root, 'src', 'chart', 'chart.html'), 'utf8');
const cjs = fs.readFileSync(path.join(root, 'src', 'chart', 'chart.js'), 'utf8');

const store = {
  schemaVersion: 1,
  stocks: [
    { id: 's1', code: '600000', name: '浦发银行', market: 'CN', exchange: 'SH', securityType: 'stock', order: 0, badgeEnabled: true,
      alert: { enabled: true, upperPrice: 10, lowerPrice: null, upperChangePercent: null, lowerChangePercent: null, snoozedUntil: null } },
    { id: 's2', code: '000001', name: '平安银行', market: 'CN', exchange: 'SZ', securityType: 'stock', order: 1, badgeEnabled: false,
      alert: { enabled: false, upperPrice: null, lowerPrice: null, upperChangePercent: null, lowerChangePercent: null, snoozedUntil: null } },
    { id: 's3', code: '510300', name: '沪深300ETF华泰柏瑞', market: 'CN', exchange: 'SH', securityType: 'fund', order: 2, badgeEnabled: true,
      alert: { enabled: false, upperPrice: null, lowerPrice: null, upperChangePercent: null, lowerChangePercent: null, snoozedUntil: null } },
    { id: 's4', code: '113050', name: '南银转债', market: 'CN', exchange: 'SH', securityType: 'bond', order: 3, badgeEnabled: true,
      // 暂停态：提醒开着但 snoozedUntil 在未来
      alert: { enabled: true, upperPrice: null, lowerPrice: null, upperChangePercent: null, lowerChangePercent: null, snoozedUntil: new Date(Date.now() + 600000).toISOString() } },
  ],
  settings: {
    main: { theme: 'dark', refreshIntervalSeconds: 3, colors: {} },
    alerts: { channels: ['sound', 'notify'] },
    indices: { floatingVisible: true, selected: ['shanghai', 'shenzhen'] },
    floating: { opacity: 88, enabled: true },
    network: { proxyMode: 'system', proxyUrl: '' },
  },
};
const marketData = {
  stockQuotes: [
    { stockId: 's1', code: '600000', name: '浦发银行', latestPrice: 9.1, changePercent: 1.25, changeAmount: 0.11, decimals: 2, ok: true, updatedAt: Date.now() },
    { stockId: 's2', code: '000001', name: '平安银行', latestPrice: 11.66, changePercent: -0.34, changeAmount: -0.04, decimals: 2, ok: true, updatedAt: Date.now() },
    { stockId: 's3', code: '510300', name: '沪深300ETF华泰柏瑞', latestPrice: 3.8765, changePercent: 0.52, changeAmount: 0.02, decimals: 3, ok: true, updatedAt: Date.now() },
    { stockId: 's4', code: '113050', name: '南银转债', latestPrice: 118.365, changePercent: -0.21, changeAmount: -0.25, decimals: 3, ok: true, updatedAt: Date.now() },
  ],
  indexQuotes: [],
  indexMeta: [
    { stockId: 'index:shanghai', code: '000001', name: '上证指数' },
    { stockId: 'index:shenzhen', code: '399001', name: '深证成指' },
  ],
  updatedAt: Date.now(), source: 'eastmoney', errors: [],
};

const listeners = {};
let searchMock = [];
let proxyMock = { mode: 'system', resolved: 'HTTP 代理 127.0.0.1:7897', error: '' };
let updateMock = { checked: true, hasUpdate: false, current: '1.0.0', latest: '1.0.0', url: '', notes: '', asset: null, error: '', at: Date.now() };
let reorderCalls = [];
let indexReorderCalls = [];
let chartOpens = [];
const diagMock = {
  source: 'none',
  errors: [
    'eastmoney: 600000=timeout 4000ms @push2delay.eastmoney.com/api/qt/stock/get',
    'fetchSina: https:timeout 5000ms @hq.sinajs.cn/list=sh600000',
    'fetchTencent: https:timeout 5000ms @qt.gtimg.cn/q=sh600000',
  ],
};
const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only' });
const { window } = dom;
// 把样式表注入文档，才能用 getComputedStyle 验证 hidden 是否真的生效
// （jsdom 不解析外链 CSS，这一层专门用来抓「display:grid 盖掉 hidden」这类真实浏览器才有的 bug）
const css = fs.readFileSync(path.join(root, 'src', 'renderer', 'styles.css'), 'utf8');
const styleTag = window.document.createElement('style');
styleTag.textContent = css;
window.document.head.appendChild(styleTag);
window.gongwei = {
  getStore: async () => JSON.parse(JSON.stringify(store)),
  getVersion: async () => 'test',
  getMarket: async () => JSON.parse(JSON.stringify(marketData)),
  refreshMarket: async () => ({}),
  search: async () => searchMock,
  addStock: async () => ({}),
  removeStock: async () => true,
  updateAlert: async () => ({}),
  reorderStocks: async (ids) => { reorderCalls.push(ids); return ids; },
  reorderIndices: async (ids) => { indexReorderCalls.push(ids); return ids; },
  snoozeStock: async () => ({}),
  updateSettings: async (patch) => {
    if (patch && patch.network) store.settings.network = { ...store.settings.network, ...patch.network };
    if (patch && patch.floating) store.settings.floating = { ...store.settings.floating, ...patch.floating };
    if (patch && patch.main) store.settings.main = { ...store.settings.main, ...patch.main };
    return store.settings;
  },
  applyProxy: async () => proxyMock,
  toggleIndex: async (id, on) => {
    const cur = new Set(store.settings.indices.selected);
    if (on) cur.add(id); else cur.delete(id);
    store.settings.indices.selected = [...cur];
    return store.settings.indices.selected;
  },
  toggleFloat: async () => true,
  hideFloat: async () => true,
  floatResize: () => {},
  checkUpdate: async () => updateMock,
  openExternal: async () => true,
  onUpdateState: (cb) => { listeners.update = cb; },
  onSession: (cb) => { listeners.session = cb; },
  onOpenSettings: (cb) => { listeners.openSettings = cb; },
  testNotify: async () => ({ ok: true }),
  testProxy: async () => ({
    at: Date.now(),
    elapsedMs: 180,
    proxy: { mode: 'system', resolved: 'HTTP 代理 127.0.0.1:7897', error: '' },
    results: [
      { name: '腾讯', ok: true, ms: 131, detail: '正常' },
      { name: '东财', ok: false, ms: 126, detail: '请求失败：fetch failed' },
      { name: '新浪', ok: true, ms: 57, detail: '正常' },
    ],
  }),
  diagnose: async () => ({
    source: diagMock.source,
    updatedAt: Date.now(),
    stockCount: 2,
    errors: diagMock.errors,
    proxy: proxyMock,
  }),
  selftest: async () => ({ at: Date.now(), results: [] }),
  openChart: async (stock) => { chartOpens.push(stock); return true; },
  onMarket: (cb) => { listeners.market = cb; },
  onStore: (cb) => { listeners.store = cb; },
  onAlert: (cb) => { listeners.alert = cb; },
  onFloatSync: (cb) => { listeners.floatSync = cb; },
};
window.matchMedia = () => ({ matches: false, addEventListener: () => {} });
dom.window.eval(appJs);

let passed = 0;
let failed = 0;
const queued = []; // 异步用例排队，按注册顺序串行执行，避免互相重置弹窗/DOM
function report(name, err) {
  if (err) { failed += 1; process.exitCode = 1; console.error(`  FAIL ${name}: ${err.message}`); }
  else { passed += 1; console.log(`  PASS ${name}`); }
}
function t(name, fn) {
  // async 函数不立即执行，先入队，保证串行且顺序确定
  if (fn && fn.constructor && fn.constructor.name === 'AsyncFunction') {
    queued.push({ name, fn });
    return;
  }
  try { fn(); report(name); } catch (e) { report(name, e); }
}
// jsdom 不做布局：给一串元素按顺序打上矩形桩，让拖拽的落点计算能真正跑起来
function stubRows(nodes, itemHeight) {
  nodes.forEach((n, i) => {
    const top = i * itemHeight;
    n.getBoundingClientRect = () => ({
      top, bottom: top + itemHeight, left: 0, right: 200, width: 200, height: itemHeight, x: 0, y: top,
    });
  });
}
// 语法糖：querySelector 的短写
function props(el, sel) { return el.querySelector(sel); }

// 兜底清理：某条拖拽用例中途失败时，别把「拖拽中」状态留给下一条用例
function cleanupDrag() {
  for (const id of [1, 2, 5, 6, 9]) {
    window.dispatchEvent(new window.MouseEvent('pointerup', { bubbles: true, pointerId: id }));
  }
  const box = window.document.getElementById('stocks');
  if (box) box.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'));
  window.document.body.classList.remove('dragging-active');
}

async function runQueued() {  for (const item of queued) {
    item.done = true;
    try { await item.fn(); report(item.name); } catch (e) { report(item.name, e); }
  }
}

(async () => {
  await new Promise((r) => setTimeout(r, 60));
  const d = window.document;

  console.log('[自选卡片]');
  t('渲染全部自选卡片', () => assert.strictEqual(d.querySelectorAll('.stock').length, 4));
  t('涨跌胶囊', () => {
    const pills = d.querySelectorAll('.pill');
    assert.ok(pills[0].className.includes('pct-up') && pills[0].textContent.includes('+1.25%'));
    assert.ok(pills[1].className.includes('pct-down') && pills[1].textContent.includes('-0.34%'));
  });
  t('ETF / 可转债 有类型标签、股票没有、基金按 3 位小数', () => {
    const rows = [...d.querySelectorAll('.stock')];
    const byCode = (c) => rows.find((r) => r.querySelector('.name small').textContent === c);
    assert.strictEqual(byCode('600000').querySelector('.type-badge'), null, '股票不显示类型标签');
    assert.ok(byCode('510300').querySelector('.type-badge'), 'ETF 应有标签');
    assert.strictEqual(byCode('510300').querySelector('.type-badge').textContent, 'ETF');
    assert.strictEqual(byCode('113050').querySelector('.type-badge').textContent, '债');
    assert.strictEqual(byCode('510300').querySelector('.price').textContent, '3.877', '基金 3 位小数');
    assert.strictEqual(byCode('113050').querySelector('.price').textContent, '118.365', '可转债 3 位小数');
    assert.strictEqual(byCode('600000').querySelector('.price').textContent, '9.10', '股票 2 位小数');
  });
  t('展开态按提醒开关还原', () => {
    const cfgs = d.querySelectorAll('div.aconfig');
    assert.strictEqual(cfgs[0].hidden, false);
    assert.strictEqual(cfgs[1].hidden, true);
    assert.ok(d.querySelector('.bell.on'));
    assert.ok(d.querySelector('.bell.off'));
  });
  t('无「详情」字样（details 已换 div）', () => {
    assert.ok(!d.getElementById('stocks').textContent.includes('详情'));
    assert.strictEqual(d.querySelectorAll('details').length, 0);
  });
  t('一行式：无眼睛、有铃铛与展开箭头', () => {
    assert.strictEqual(d.querySelector('[data-act="eye"]'), null);
    assert.ok(d.querySelector('[data-act="bell"]'));
    assert.ok(d.querySelector('[data-act="chev"]'));
  });
  t('行情 tick 不冲展开态与输入值，数值原地更新', () => {
    const before = d.querySelectorAll('.stock');
    before[1].querySelector('[data-act="chev"]').click();
    before[1].querySelector('input[data-k="upperPrice"]').value = '12.5';
    listeners.market(JSON.parse(JSON.stringify(marketData)));
    const after = d.querySelectorAll('.stock');
    assert.strictEqual(after.length, 4);
    assert.strictEqual(after[1].querySelector('.aconfig').hidden, false, '展开态保持');
    assert.strictEqual(after[1].querySelector('input[data-k="upperPrice"]').value, '12.5', '输入值保持');
    assert.ok(after[0].querySelector('.price').textContent.includes('9.10'));
    // 原有的展开/收起初始态断言在下面这条里继续生效
    assert.strictEqual(after[2].querySelector('.aconfig').hidden, true, '未开的仍收起');
  });

  console.log('[指数]');
  t('中文名 + 卡片横排 + 排在自选前面', () => {
    const txt = d.getElementById('indices').textContent;
    assert.ok(txt.includes('上证指数') && txt.includes('深证成指'));
    assert.strictEqual(d.querySelectorAll('.idx-card').length, 2);
    const sections = [...d.querySelectorAll('.app-body > section')].map((s) => (s.querySelector('#indices') ? 'idx' : (s.querySelector('#stocks') ? 'stocks' : '?')));
    assert.ok(sections.indexOf('idx') < sections.indexOf('stocks'));
  });
  t('管理面板可开可合（轮询不重绘）', () => {
    d.getElementById('btnIndicesManage').click();
    assert.strictEqual(d.getElementById('indicesManage').hidden, false);
    const expected = require(path.join(root, 'src', 'common', 'defaults.js')).INDICES.length;
    assert.strictEqual(d.getElementById('indicesManage').children.length, expected, `应列出全部 ${expected} 个指数`);
    assert.ok([...d.getElementById('indicesManage').querySelectorAll('label')].some((l) => l.textContent.includes('科创综指')));
    d.getElementById('btnIndicesManage').click();
    assert.strictEqual(d.getElementById('indicesManage').hidden, true);
  });
  t('hidden 必须真的不显示（CSS 生效层，抓 display:grid 盖 hidden 的坑）', () => {
    const panel = d.getElementById('indicesManage');
    const cs = window.getComputedStyle(panel);
    // 初始 hidden
    assert.strictEqual(cs.display, 'none', `初始应不显示，实际 ${cs.display}`);
    d.getElementById('btnIndicesManage').click();
    assert.strictEqual(window.getComputedStyle(panel).display, 'grid', '展开应为 grid');
    d.getElementById('btnIndicesManage').click();
    assert.strictEqual(window.getComputedStyle(panel).display, 'none', `关闭后应不显示，实际 ${window.getComputedStyle(panel).display}`);
    const more = d.getElementById('moreMenu');
    assert.strictEqual(window.getComputedStyle(more).display, 'none', '更多菜单初始应不显示');
    const modal = d.getElementById('modalOverlay');
    assert.strictEqual(window.getComputedStyle(modal).display, 'none', '弹窗蒙层初始应不显示');
  });
  t('连点不丢操作（主进程原子切换）', async () => {
    d.getElementById('btnIndicesManage').click();
    const labels = [...d.getElementById('indicesManage').querySelectorAll('label')];
    const boxFor = (n) => labels.find((l) => l.textContent.includes(n)).querySelector('input');
    const sz = boxFor('深证成指');
    const sh = boxFor('上证指数');
    sz.checked = true; sz.dispatchEvent(new window.Event('change', { bubbles: true }));
    sh.checked = false; sh.dispatchEvent(new window.Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    const sel = store.settings.indices.selected;
    assert.ok(sel.includes('shenzhen') && !sel.includes('shanghai'), JSON.stringify(sel));
  });
  t('卡片跟着勾选即时变（不等网络刷新）', async () => {
    marketData.indexQuotes = [
      { stockId: 'index:shanghai', code: '000001', name: '上证指数', latestPrice: 3000, changePercent: -0.5, changeAmount: -15, ok: true },
      { stockId: 'index:shenzhen', code: '399001', name: '深证成指', latestPrice: 10000, changePercent: -0.3, changeAmount: -30, ok: true },
    ];
    listeners.market(JSON.parse(JSON.stringify(marketData)));
    const names = () => [...d.querySelectorAll('#indices .idx-card .idx-name')].map((e) => e.textContent);
    let labels = [...d.getElementById('indicesManage').querySelectorAll('label')];
    const boxFor = (n) => labels.find((l) => l.textContent.includes(n)).querySelector('input');
    const sh = boxFor('上证指数');
    sh.checked = false; sh.dispatchEvent(new window.Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(!names().includes('上证指数'), '取消的要立刻消失：' + names());
    labels = [...d.getElementById('indicesManage').querySelectorAll('label')];
    const kc = boxFor('科创综指');
    kc.checked = true; kc.dispatchEvent(new window.Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(names().includes('科创综指'), '新增的要立刻出现：' + names());
  });

  console.log('[顶栏 / 搜索 / 弹窗]');
  t('无大标题 H1', () => assert.strictEqual(d.querySelector('h1'), null));
  t('版本号显示', () => assert.ok(d.getElementById('appVer').textContent.includes('test')));
  t('状态灯 + 异常只挂黄喇叭', () => {
    listeners.market({ ...JSON.parse(JSON.stringify(marketData)), errors: ['eastmoney: timeout'] });
    assert.ok(!d.getElementById('status').textContent.includes('异常'));
    const horn = d.getElementById('errHorn');
    assert.ok(horn && horn.textContent.includes('1'));
  });
  t('搜索在标题行、无搜索按钮', () => {
    assert.strictEqual(d.getElementById('btnSearch'), null);
    assert.ok(d.querySelector('.section-head .search-inline #kw'));
  });
  t('输入联想出下拉', async () => {
    searchMock = [{ code: '600000', name: '浦发银行', market: 'CN', exchange: 'SH', label: '浦发银行 600000', sourceIds: {} }];
    const kw = d.getElementById('kw');
    kw.value = '600000';
    kw.dispatchEvent(new window.Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 600));
    const sug = d.getElementById('suggest');
    assert.strictEqual(sug.hidden, false);
    assert.ok(sug.textContent.includes('浦发银行'));
  });
  t('更多菜单结构 + 设置/自检进弹窗', () => {
    assert.ok(d.getElementById('moreMenu').hidden);
    assert.strictEqual(d.getElementById('settingsBox'), null);
    assert.strictEqual(d.getElementById('selftestBox'), null);
    assert.ok(d.getElementById('btnOpenSettings') && d.getElementById('btnGoSelftest'));
    assert.strictEqual(d.getElementById('btnSound'), null, '测试声音应从更多菜单移除');
    assert.strictEqual(d.getElementById('btnNotify'), null, '测试通知应从更多菜单移除');
    assert.strictEqual(d.getElementById('btnDiagnose'), null, '诊断按钮应移出菜单（改由状态灯/小喇叭进入）');
  });
  t('状态灯可点开诊断', async () => {
    listeners.market({ ...JSON.parse(JSON.stringify(marketData)), errors: [] });
    d.getElementById('btnStatusDot').click();
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(d.getElementById('modalTitle').textContent, '诊断');
    assert.ok(d.getElementById('modalBody').querySelector('.diag-row'));
    d.getElementById('modalClose').click();
  });
  t('测试声音/通知在设置弹窗内', () => {
    d.getElementById('btnOpenSettings').click();
    assert.ok(d.getElementById('btnTestSound'), '设置弹窗应有测试声音');
    assert.ok(d.getElementById('btnTestNotify'), '设置弹窗应有测试通知');
    d.getElementById('btnTestSound').click();
    d.getElementById('btnTestNotify').click();
    d.getElementById('modalClose').click();
    assert.strictEqual(d.getElementById('modalOverlay').hidden, true);
  });
  t('代理设置：默认跟随系统、手动才显示地址、保存写回', async () => {
    d.getElementById('btnOpenSettings').click();
    const mode = d.getElementById('setProxyMode');
    assert.strictEqual(mode.value, 'system', '默认跟随系统');
    assert.strictEqual(d.getElementById('proxyUrlRow').hidden, true, '非手动时地址行隐藏');
    mode.value = 'manual';
    mode.dispatchEvent(new window.Event('change', { bubbles: true }));
    assert.strictEqual(d.getElementById('proxyUrlRow').hidden, false, '手动时地址行显示');
    assert.ok(d.getElementById('proxyHint').textContent.includes('代理软件'));
    d.getElementById('setProxyUrl').value = '127.0.0.1:7890';
    d.getElementById('btnSaveSettings').click();
    await new Promise((r) => setTimeout(r, 30));
    assert.deepStrictEqual(store.settings.network, { proxyMode: 'manual', proxyUrl: '127.0.0.1:7890' });
  });
  t('代理配置错误会提示', async () => {
    proxyMock = { mode: 'manual', resolved: '', error: '代理地址不合法（检查主机与端口，端口范围 1-65535）：a' };
    d.getElementById('btnOpenSettings').click();
    d.getElementById('btnSaveSettings').click();
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(d.getElementById('toast').textContent.includes('代理未生效'), d.getElementById('toast').textContent);
  });
  t('诊断弹窗展示代理模式与实际走向', async () => {
    proxyMock = { mode: 'system', resolved: 'HTTP 代理 127.0.0.1:7897', error: '' };
    listeners.market({ ...JSON.parse(JSON.stringify(marketData)), errors: [] });
    d.getElementById('btnStatusDot').click();
    await new Promise((r) => setTimeout(r, 30));
    const txt = d.getElementById('modalBody').textContent;
    assert.ok(txt.includes('代理模式'), txt.slice(0, 80));
    assert.ok(txt.includes('HTTP 代理 127.0.0.1:7897'), txt.slice(0, 120));
    d.getElementById('modalClose').click();
  });
  t('设置弹窗开合 + 回填 + 保存', async () => {
    d.getElementById('btnOpenSettings').click();
    assert.strictEqual(d.getElementById('modalOverlay').hidden, false);
    assert.strictEqual(d.getElementById('setTheme').value, 'dark');
    d.getElementById('btnSaveSettings').click();
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(d.getElementById('modalOverlay').hidden, true);
  });
  t('自检弹窗打开/关闭', () => {
    d.getElementById('btnGoSelftest').click();
    assert.strictEqual(d.getElementById('modalTitle').textContent, '接口自检');
    d.getElementById('modalClose').click();
    assert.strictEqual(d.getElementById('modalOverlay').hidden, true);
  });
  t('诊断以弹窗展示（黄喇叭 + 人话提示）', async () => {
    listeners.market({ ...JSON.parse(JSON.stringify(marketData)), errors: ['a', 'b', 'c'] });
    d.getElementById('errHorn').click();
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(d.getElementById('modalTitle').textContent, '诊断');
    assert.ok(d.getElementById('modalBody').querySelector('.diag-hint'), '全通道失败应给人话提示');
    d.getElementById('modalClose').click();
  });
  t('检查更新：无新版提示、有新版出弹窗与徽标', async () => {
    // 点「检查更新」并等 IPC 回来
    const checkUpdateViaButton = async () => {
      d.getElementById('btnCheckUpdate').click();
      await new Promise((r) => setTimeout(r, 40));
    };
    // 无新版
    updateMock = { checked: true, hasUpdate: false, current: '1.0.0', latest: '1.0.0', url: '', notes: '', asset: null, error: '', at: Date.now() };
    await checkUpdateViaButton();
    assert.ok(d.getElementById('toast').textContent.includes('已是最新'), d.getElementById('toast').textContent);
    assert.strictEqual(d.getElementById('updateBadge').hidden, true, '无新版不显示徽标');
    // 有新版本
    updateMock = {
      checked: true, hasUpdate: true, current: '1.0.0', latest: '1.1.0',
      url: 'https://github.com/lyhxx/gongwei-stocks-desktop/releases/tag/v1.1.0',
      notes: '## 工位看盘 1.1.0\n\n- 新增 xxx', asset: { name: 'a.exe', url: 'https://github.com/x/a.exe' }, error: '', at: Date.now(),
    };
    await checkUpdateViaButton();
    assert.ok(d.getElementById('updateBadge').hidden === false, '有新版应显示徽标');
    assert.ok(d.getElementById('updateBadge').textContent.includes('1.1.0'));
    assert.strictEqual(d.getElementById('modalTitle').textContent, '发现新版本');
    assert.ok(d.getElementById('modalBody').textContent.includes('1.1.0'));
    assert.ok(d.getElementById('modalBody').querySelector('.update-notes'), '应显示更新说明');
    d.getElementById('modalClose').click();
  });
  t('启动时的推送也能更新徽标', () => {
    listeners.update({ hasUpdate: true, latest: '2.0.0' });
    assert.ok(d.getElementById('updateBadge').textContent.includes('2.0.0'));
    listeners.update({ hasUpdate: false });
    assert.strictEqual(d.getElementById('updateBadge').hidden, true);
  });

  t('自选拖拽：整行可拖、无 ↑↓ 按钮、拖动后写回新顺序', async () => {
    cleanupDrag();
    const rows = () => [...d.querySelectorAll('#stocks .stock')];
    assert.strictEqual(rows().length, 4);
    assert.ok(rows()[0].querySelector('.drag-handle'), '每行保留拖拽把手作为提示');
    const opsText = [...d.querySelectorAll('.stock .ops button')].map((b) => b.textContent);
    assert.ok(!opsText.some((x) => x.includes('上移') || x.includes('下移')), '旧的上下移按钮应移除：' + opsText.join(','));

    // jsdom 不做布局，getBoundingClientRect 恒为 0；这里按顺序打上矩形桩，
    // 才能真正走到落点计算（真实 Chromium 里的表现由拖拽测试台单独验证过）
    stubRows(rows(), 40);
    reorderCalls = [];
    const nameEl = props(rows()[0], '.name');
    const mk = (type, y, target) => {
      const Ctor = typeof window.PointerEvent === 'function' ? window.PointerEvent : window.MouseEvent;
      (target || nameEl).dispatchEvent(new Ctor(type, { bubbles: true, button: 0, clientY: y, clientX: 20, pointerId: 1, isPrimary: true, pointerType: "mouse" }));
    };
    mk('pointerdown', 10);
    // 按下即高亮（视觉反馈），但还没超过阈值，不算拖拽位移
    assert.ok(rows()[0].classList.contains('dragging'), '按下后应高亮提示');
    assert.strictEqual(reorderCalls.length, 0, '未移动不应结算排序');
    mk('pointermove', 60);
    assert.strictEqual(d.body.querySelector('.drag-ghost'), null, '不应生成脱离列表的幽灵元素');
    assert.strictEqual(d.getElementById('stocks').querySelectorAll('.drag-placeholder').length, 0, '不应有占位符');

    mk('pointermove', 200); // 拖到最后一行下方
    mk('pointerup', 200, nameEl);
    await new Promise((r) => setTimeout(r, 40));
    assert.strictEqual(reorderCalls.length, 1, '松手后应调用一次排序接口');
    // 注意：reorderCalls 里的数组来自 jsdom realm，原型与本文件不同，
    // deepStrictEqual 会因此判不等，先转成本 realm 的数组
    assert.deepStrictEqual([...reorderCalls[0]], ['s2', 's3', 's4', 's1'], '第一行应被拖到末尾');
    assert.strictEqual(d.getElementById('stocks').querySelectorAll('.stock').length, 4, '行数应保持 4');
    assert.ok(!d.body.classList.contains('dragging-active'), '拖拽结束要清掉全局态');

    // 按在 ⠿ 把手上也必须能拖（把手是最像"可以拖"的地方，不能被排除）
    // 注意：上一次拖完 renderAll 会重建 DOM，矩形桩要重新打
    stubRows(rows(), 40);
    reorderCalls = [];
    const handle = props(rows()[0], '.drag-handle');
    mk('pointerdown', 10, handle);
    mk('pointermove', 60, handle);
    mk('pointermove', 200, handle);
    mk('pointerup', 200, handle);
    await new Promise((r) => setTimeout(r, 40));
    assert.strictEqual(reorderCalls.length, 1, '按把手也要能拖');
    assert.deepStrictEqual([...reorderCalls[0]], ['s2', 's3', 's4', 's1'], '按把手拖到末尾');

    // 按在按钮上不应触发拖拽（否则点铃铛会变成排序）
    reorderCalls = [];
    const bell = props(rows()[0], '[data-act="bell"]');
    mk('pointerdown', 10, bell);
    mk('pointermove', 300, bell);
    mk('pointerup', 300, bell);
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(reorderCalls.length, 0, '按按钮不应触发排序');
  });

  t('指数卡片也能拖拽排序', async () => {
    cleanupDrag();
    const cards = () => [...d.querySelectorAll('#indices [data-drag-id]')];
    assert.ok(cards().length >= 2, '指数卡片数不足：' + cards().length);
    stubRows(cards(), 46);
    const before = cards().map((c) => c.getAttribute('data-drag-id'));
    indexReorderCalls = [];
    const first = cards()[0];
    const mk = (type, y) => new (typeof window.PointerEvent === 'function' ? window.PointerEvent : window.MouseEvent)(
      type, { bubbles: true, button: 0, clientY: y, clientX: 20, pointerId: 2, isPrimary: true, pointerType: "mouse" },
    );
    first.dispatchEvent(mk('pointerdown', 5));
    first.dispatchEvent(mk('pointermove', 60));
    first.dispatchEvent(mk('pointermove', 200));
    first.dispatchEvent(mk('pointerup', 200));
    await new Promise((r) => setTimeout(r, 40));
    assert.strictEqual(indexReorderCalls.length, 1, '指数拖拽应调用 reorderIndices');
    assert.strictEqual(indexReorderCalls[0].length, before.length, '应带上全部指数 id');
    assert.strictEqual(indexReorderCalls[0][indexReorderCalls[0].length - 1], before[0], '第一张应被拖到末尾');
  });

  t('铃铛开启/关闭/暂停 图标与颜色可区分', () => {
    const bells = [...d.querySelectorAll('.icon-btn.bell')];
    assert.strictEqual(bells.length, 4);
    // 用 SVG 而不是 emoji：彩色 emoji 不受 CSS color 影响，三种状态会长得一样
    bells.forEach((b) => assert.ok(b.querySelector('svg'), '铃铛必须是内联 SVG'));
    const stateOf = (b) => ['on', 'off', 'snooze'].find((c) => b.classList.contains(c));
    const on = bells[0];     // s1 浦发银行：开启
    const off = bells[1];    // s2 平安银行：关闭
    const snooze = bells[3]; // s4 南银转债：暂停
    assert.strictEqual(stateOf(on), 'on');
    assert.strictEqual(stateOf(off), 'off');
    assert.strictEqual(stateOf(snooze), 'snooze');
    const colorOf = (b) => window.getComputedStyle(b).color;
    assert.notStrictEqual(colorOf(on), colorOf(off), '开启与关闭颜色应不同');
    assert.notStrictEqual(colorOf(on), colorOf(snooze), '开启与暂停颜色应不同');
    // 关闭态用带斜杠的样式，图形本身也不同
    assert.ok(off.querySelector('svg line'), '关闭态铃铛应带斜杠');
    assert.ok(!on.querySelector('svg line'), '开启态铃铛不应有斜杠');
  });

  t('设置页：分组标题、开关样式、代理连通性测试', async () => {
    d.getElementById('btnOpenSettings').click();
    const body = d.getElementById('modalBody');
    // 分组标题
    const titles = [...body.querySelectorAll('.set-title')].map((x) => x.textContent.trim());
    assert.deepStrictEqual(titles, ['外观', '行情', '浮窗', '提醒通道', '网络代理'], '应分成五组：' + titles.join(','));
    // 开关代替原生 checkbox
    const switches = [...body.querySelectorAll('.switch input[type=checkbox]')];
    assert.strictEqual(switches.length, 4, '应有 4 个开关（浮窗/通知/声音/仅交易时段）');
    switches.forEach((s) => assert.ok(s.parentElement.querySelector('.track'), '开关要有可视轨道'));

    // 代理测试：点一下出结果 chip
    assert.ok(d.getElementById('btnTestProxy'), '代理应有测试按钮');
    d.getElementById('btnTestProxy').click();
    await new Promise((r) => setTimeout(r, 40));
    const box = d.getElementById('proxyTestResult');
    assert.ok(box.textContent.includes('2/3'), '应显示 2/3 通：' + box.textContent);
    assert.strictEqual(box.querySelectorAll('.probe-chip').length, 3, '每条通道一个 chip');
    assert.strictEqual(box.querySelectorAll('.probe-chip.ok').length, 2);
    assert.strictEqual(box.querySelectorAll('.probe-chip.bad').length, 1);
    assert.ok(box.textContent.includes('127.0.0.1:7897'), '应显示实际走向');
    assert.ok(box.className.includes('warn'), '部分不通应标 warn');
    d.getElementById('modalClose').click();
  });

  t('非交易时段在状态栏标出来', () => {
    listeners.market({ ...JSON.parse(JSON.stringify(marketData)), errors: [] });
    // 交易中：不显示额外的休市字样
    listeners.session({ phase: 'morning', trading: true, label: '交易中' });
    assert.ok(!d.getElementById('status').textContent.includes('午间休市'));
    assert.ok(!d.getElementById('status').textContent.includes('已收盘'));
    // 午休
    listeners.session({ phase: 'lunch', trading: false, label: '午间休市' });
    assert.ok(d.getElementById('status').textContent.includes('午间休市'), d.getElementById('status').textContent);
    // 已收盘
    listeners.session({ phase: 'after-close', trading: false, label: '已收盘' });
    assert.ok(d.getElementById('status').textContent.includes('已收盘'), d.getElementById('status').textContent);
    // 周末
    listeners.session({ phase: 'weekend', trading: false, label: '周末休市' });
    assert.ok(d.getElementById('status').textContent.includes('周末休市'), d.getElementById('status').textContent);
    listeners.session(null);
  });
  t('设置页有「仅交易时段请求」开关', async () => {
    d.getElementById('btnOpenSettings').click();
    const sw = d.getElementById('setMarketHours');
    assert.ok(sw, '应有仅交易时段开关');
    assert.strictEqual(sw.checked, true, '默认开启');
    assert.ok(d.getElementById('marketHoursHint').textContent.includes('09:15'), '应有说明文案');
    d.getElementById('btnSaveSettings').click();
    await new Promise((r) => setTimeout(r, 30));
  });



  t('拖拽健壮性：不接受第二根指针、触摸需从把手起、点击不排序', async () => {
    cleanupDrag();
    const rows = () => [...d.querySelectorAll('#stocks .stock')];
    stubRows(rows(), 40);
    const mk = (type, y, target, extra) => {
      const Ctor = typeof window.PointerEvent === 'function' ? window.PointerEvent : window.MouseEvent;
      const opts = Object.assign({ bubbles: true, button: 0, clientY: y, clientX: 20, pointerId: 1, isPrimary: true }, extra || {});
      const ev = new Ctor(type, opts);
      // jsdom 的 MouseEvent 不认 pointerType / isPrimary，手工补上，
      // 否则「触摸」这个场景根本模拟不出来（测试会假过）
      for (const k of ['pointerType', 'isPrimary', 'pointerId']) {
        if (ev[k] !== opts[k]) {
          try { Object.defineProperty(ev, k, { value: opts[k] }); } catch { /* 忽略 */ }
        }
      }
      (target || rows()[0].querySelector('.name')).dispatchEvent(ev);
      return ev;
    };

    // 1) 先按下一行开始拖，再用第二根手指按另一行：不应产生第二个拖拽
    reorderCalls = [];
    mk('pointerdown', 10);
    mk('pointermove', 60);
    assert.strictEqual(d.querySelectorAll('.stock.dragging').length, 1, '同时只能有一个拖拽中的元素');
    // 第二根手指（非主指针）按另一行
    mk('pointerdown', 10, rows()[1].querySelector('.name'), { pointerId: 2, isPrimary: false });
    assert.strictEqual(d.querySelectorAll('.stock.dragging').length, 1, '第二根指针不应再开一个拖拽');
    mk('pointerup', 60);
    await new Promise((r) => setTimeout(r, 40));
    assert.strictEqual(reorderCalls.length, 1, '只应结算一次排序');

    // 2) 触摸按在名字上不应起拖（触摸只允许从 ⠿ 把手起）
    stubRows(rows(), 40);
    reorderCalls = [];
    mk('pointerdown', 10, rows()[0].querySelector('.name'), { pointerType: 'touch' });
    mk('pointermove', 60, rows()[0].querySelector('.name'), { pointerType: 'touch' });
    mk('pointerup', 60, rows()[0].querySelector('.name'), { pointerType: 'touch' });
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(reorderCalls.length, 0, '触摸按名字不应触发排序');
    assert.strictEqual(d.querySelectorAll('.stock.dragging').length, 0);

    // 3) 只是点一下（位移没过阈值）不应排序
    reorderCalls = [];
    mk('pointerdown', 10, rows()[0].querySelector('.drag-handle'));
    mk('pointerup', 11, rows()[0].querySelector('.drag-handle'));
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(reorderCalls.length, 0, '点击不应触发排序');
  });

  t('K 线按钮：点击打开独立窗口（不再用主窗口弹窗）', async () => {
    chartOpens = [];
    const btn = d.querySelector('#stocks .stock [data-act="chart"]');
    assert.ok(btn, '自选行应有 K 线按钮');
    assert.strictEqual(d.getElementById('klineChart'), null, '主窗口不应内嵌图表容器');
    btn.click();
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(chartOpens.length, 1, '应调用 openChart');
    assert.strictEqual(chartOpens[0].code, '600000');
    assert.ok(!d.querySelector('.kline-modal'), '不应再弹主窗口弹窗');
  });

  // 所有用例注册完毕后再串行跑异步用例；queue 里若还有剩余说明有用例被漏跑，必须报错
  await runQueued();
  if (queued.some((q) => !q.done)) {
    console.error('  FAIL 有用例未被调度执行（请检查注册位置）');
    process.exitCode = 1;
  }

  console.log('[浮窗]');
  const fdom = new JSDOM(fhtml, { url: 'http://localhost/', runScripts: 'outside-only' });
  fdom.window.gongwei = window.gongwei;
  fdom.window.matchMedia = window.matchMedia;
  fdom.window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  fdom.window.eval(fjs);
  await new Promise((r) => setTimeout(r, 60));
  const fd = fdom.window.document;
  const ft = (name, fn) => {
    try { fn(); report(name); } catch (e) { report(name, e); }
  };
  ft('浮窗仅有更新时间与涨跌家数，无标题无页脚', () => {
    assert.ok(!fd.body.textContent.includes('工位看盘'));
    assert.ok(!fd.body.textContent.includes('Esc 隐藏'), '页脚提示应移除');
    assert.strictEqual(fd.querySelectorAll('footer').length, 0);
    assert.ok(fd.getElementById('time').textContent.startsWith('更新 '));
    assert.ok(fd.getElementById('stat').textContent.includes('涨2'), fd.getElementById('stat').textContent);
  });
  ft('浮窗指数横排卡片且跟随勾选', () => {
    assert.ok(fd.querySelectorAll('.idx-grid .idx-card').length >= 1, '指数应为卡片');
    assert.ok(!fd.querySelector('.idx-line'), '旧的行式指数已移除');
  });
  ft('浮窗没有左侧蓝条、没有收起小球', () => {
    assert.strictEqual(fd.getElementById('ball'), null, '小球元素应移除');
    assert.strictEqual(fd.getElementById('expanded'), null, '展开包裹层已拍平');
    assert.strictEqual(fd.querySelectorAll('.card').length, 1);
    // 左侧竖条是 .card::before，JS 侧只能确认样式表里不再定义它
    const css = fs.readFileSync(path.join(root, 'src', 'float', 'float.css'), 'utf8');
    assert.ok(!/\.card::before/.test(css), '左侧蓝色竖条样式应删除');
    assert.ok(!/\.ball\b/.test(css), '小球样式应删除');
    assert.ok(!/collapsed/.test(css), '收起态样式应删除');
  });
  ft('主界面只有一层滚动条、且提醒输入框不撑破网格', () => {
    const css = fs.readFileSync(path.join(root, 'src', 'renderer', 'styles.css'), 'utf8');
    // 自选不再自己滚动，滚动统一交给 .app-body，避免展开时出现两条滚动条
    assert.ok(/\.app-body\s*\{[^}]*overflow-y:\s*auto/.test(css), '.app-body 应是唯一滚动容器');
    assert.ok(/body\s*\{[^}]*overflow:\s*hidden/s.test(css), '页面本身不应滚动');
    assert.ok(!/#stocks\s*\{[^}]*overflow-y:\s*auto/.test(css), '#stocks 不应再自己滚动');
    // Chromium 里标准属性会让 ::-webkit-scrollbar 失效，所以不能出现
    assert.ok(!/scrollbar-width\s*:/.test(css), '不能写 scrollbar-width，否则自定义滚动条失效');
    assert.ok(!/scrollbar-color\s*:/.test(css), '不能写 scrollbar-color，否则自定义滚动条失效');
    assert.ok(/::-webkit-scrollbar\s*\{/.test(css), '应有自定义滚动条样式');
    assert.ok(/\.alert-grid\s*\{[^}]*minmax\(0,\s*1fr\)/.test(css), 'alert-grid 必须用 minmax(0,1fr) 才能被输入框压缩');
    assert.ok(/\.alert-grid input\s*\{[^}]*min-width:\s*0/.test(css), 'alert-grid 输入框需 min-width:0');
  });

  console.log('[K线窗口]');
  const cdom = new JSDOM(chtml, { url: 'http://localhost/', runScripts: 'outside-only' });
  const cwin = cdom.window;
  const chartOptions = [];
  cwin.echarts = { init: () => ({ setOption: (o) => chartOptions.push(o), resize: () => {}, clear: () => {}, on: () => {} }) };
  cwin.matchMedia = () => ({ matches: false });
  cwin.gongwei = {
    getStore: async () => JSON.parse(JSON.stringify(store)),
    getChartStock: async () => ({ id: 's1', code: '600000', name: '浦发银行', market: 'CN', exchange: 'SH' }),
    getKline: async () => ({
      code: '600000', name: '浦发银行', decimals: 2,
      klines: [
        { date: '2026-09-16', open: 10, close: 10.5, high: 10.6, low: 9.9, volume: 100000, amount: 1e8, changePercent: 5 },
        { date: '2026-09-17', open: 10.5, close: 10.2, high: 10.7, low: 10.1, volume: 80000, amount: 8e7, changePercent: -2.86 },
        { date: '2026-09-18', open: 10.2, close: 10.4, high: 10.5, low: 10.0, volume: 90000, amount: 9e7, changePercent: 1.96 },
      ],
    }),
    getTrends: async () => ({
      code: '600000', name: '浦发银行', preClose: 10, decimals: 2,
      trends: [
        { time: '2026-09-17 09:30', price: 10.1, volume: 1000, avgPrice: 10.1 },
        { time: '2026-09-17 09:31', price: 10.05, volume: 1200, avgPrice: 10.08 },
      ],
    }),
    getDetail: async () => ({ code: '600000', name: '浦发银行', decimals: 2, open: 10.0, preClose: 9.9, high: 10.2, low: 9.8, volume: 123456, amount: 1.2e8, turnover: 0.16 }),
    onStore: (cb) => { cwin.__onStore = cb; },
    onChartUpdate: (cb) => { cwin.__onChart = cb; },
  };
  cwin.eval(cjs);
  await new Promise((r) => setTimeout(r, 50));
  const cd = cwin.document;
  ft('K线窗口：默认打开分时，明细齐全，右侧 ±10% 且 0 居中', () => {
    assert.ok(chartOptions.length >= 1, '应已绘制');
    const t = chartOptions[chartOptions.length - 1];
    assert.strictEqual(t.series[0].type, 'line', '默认应为分时折线');
    assert.ok(cd.querySelector('#klineTabs button[data-period="trend"]').classList.contains('active'));
    const info = cd.getElementById('klineInfo').textContent;
    ['今开', '昨收', '今高', '今低', '成交量', '成交额', '换手率'].forEach((k) => assert.ok(info.includes(k), k));
    assert.ok(info.includes('0.16%'), '换手率应有值：' + info);
    assert.strictEqual(t.yAxis[2].position, 'right');
    assert.ok(Math.abs(t.yAxis[2].min - 9) < 1e-9, String(t.yAxis[2].min));
    assert.ok(Math.abs(t.yAxis[2].max - 11) < 1e-9, String(t.yAxis[2].max));
    assert.strictEqual(t.yAxis[2].axisLabel.formatter(10), '0.00%');
    assert.strictEqual(t.yAxis[2].axisLabel.formatter(11), '+10.00%');
    assert.strictEqual(t.yAxis[2].axisLabel.formatter(9), '-10.00%');
    const lbl = t.xAxis[1].axisLabel;
    assert.strictEqual(lbl.interval(0), true, '开盘时间应显示');
    assert.strictEqual(lbl.interval(t.xAxis[1].data.length - 1), true, '收盘时间应显示');
  });
  cd.querySelector('#klineTabs button[data-period="day"]').click();
  await new Promise((r) => setTimeout(r, 30));
  ft('K线窗口：日K含蜡烛/均线/成交量，十字光标联动，右侧 0 居中', () => {
    const o = chartOptions[chartOptions.length - 1];
    assert.strictEqual(o.series[0].type, 'candlestick');
    const maNames = o.series.filter((s) => s.type === 'line').map((s) => s.name);
    assert.deepStrictEqual([...maNames], ['MA5', 'MA10', 'MA20', 'MA30']);
    assert.ok(o.series.some((s) => s.name === '成交量' && s.type === 'bar'), '应有成交量副图');
    assert.ok(o.axisPointer && o.axisPointer.link, '应有 axisPointer.link 联动');
    // 悬停时间只在最底部 X 轴显示一次
    assert.strictEqual(o.xAxis[0].axisPointer.label.show, false, '主图不显示指针时间');
    assert.strictEqual(o.xAxis[1].axisPointer.label.show, true, '副图显示指针时间');
    // 右侧涨跌幅轴：0 居中
    assert.strictEqual(o.yAxis.length, 3, 'K线应有价格轴/成交量轴/右侧涨跌幅轴');
    assert.strictEqual(o.yAxis[2].position, 'right');
    const mid = (o.yAxis[2].min + o.yAxis[2].max) / 2;
    assert.strictEqual(o.yAxis[2].axisLabel.formatter(mid), '0.00%', '中轴应为 0');
    // 成交量轴不写死 max
    assert.strictEqual(o.yAxis[1].max, undefined);
    // 底部只标「可见区间」首尾两个日期（默认缩放到 55%~100%，第 0 根在可视区外）
    const dates = o.xAxis[1].data;
    const iv = o.xAxis[1].axisLabel.interval;
    const shown = dates.map((_, i) => i).filter((i) => iv(i));
    assert.strictEqual(shown.length, 2, '应只标两个日期：' + shown.join(','));
    assert.strictEqual(iv(0), false, '不可见区间的第 0 根不标');
    assert.strictEqual(iv(dates.length - 1), true, '可见末根要标');
    assert.strictEqual(cd.getElementById('volLabel').textContent, '成交量');
  });
  cwin.__onChart({ id: 's2', code: '000001', name: '平安银行', market: 'CN', exchange: 'SZ' });
  await new Promise((r) => setTimeout(r, 30));
  ft('K线窗口：收到 chart:update 会切换到新标的', () => {
    assert.ok(cd.getElementById('klineTitle').textContent.includes('000001'), cd.getElementById('klineTitle').textContent);
  });
  // 关闭窗口以清掉图表窗口里的自动刷新定时器，避免测试进程不退出
  if (typeof cwin.close === 'function') cwin.close();

  console.log(`\nDOM: 共 ${passed} 项，${process.exitCode ? '有失败' : '全部通过'}`);
})();
