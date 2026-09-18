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
      alert: { enabled: false, upperPrice: null, lowerPrice: null, upperChangePercent: null, lowerChangePercent: null, snoozedUntil: null } },
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
  updateStock: async () => ({}),
  moveStock: async () => true,
  reorderStocks: async (ids) => { reorderCalls.push(ids); return ids; },
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
  collapseFloat: async () => true,
  toggleFloatCollapse: async () => true,
  onFloatState: (cb) => { listeners.float = cb; },
  checkUpdate: async () => updateMock,
  getUpdateState: async () => updateMock,
  openExternal: async () => true,
  onUpdateState: (cb) => { listeners.update = cb; },
  testNotify: async () => ({ ok: true }),
  diagnose: async () => ({
    source: diagMock.source,
    updatedAt: Date.now(),
    stockCount: 2,
    errors: diagMock.errors,
    proxy: proxyMock,
  }),
  selftest: async () => ({ at: Date.now(), results: [] }),
  onMarket: (cb) => { listeners.market = cb; },
  onStore: (cb) => { listeners.store = cb; },
  onAlert: (cb) => { listeners.alert = cb; },
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
async function runQueued() {
  for (const item of queued) {
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
    const sections = [...d.querySelectorAll('body > section')].map((s) => (s.querySelector('#indices') ? 'idx' : (s.querySelector('#stocks') ? 'stocks' : '?')));
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

  t('拖拽排序：有拖拽把手、无 ↑↓ 按钮，拖动后写回新顺序', async () => {
    const rows = () => [...d.querySelectorAll('#stocks .stock')];
    assert.strictEqual(rows().length, 4);
    assert.ok(rows()[0].querySelector('.drag-handle'), '每行应有拖拽把手');
    const opsText = [...d.querySelectorAll('.stock .ops button')].map((b) => b.textContent);
    assert.ok(!opsText.some((t) => t.includes('上移') || t.includes('下移')), '旧的上下移按钮应移除：' + opsText.join(','));

    reorderCalls = [];
    const handle = rows()[0].querySelector('.drag-handle');
    const mk = (type, y) => {
      const Ctor = typeof window.PointerEvent === 'function' ? window.PointerEvent : window.MouseEvent;
      return new Ctor(type, { bubbles: true, button: 0, clientY: y, pointerId: 1 });
    };
    handle.dispatchEvent(mk('pointerdown', 10));
    assert.ok(rows()[0].classList.contains('dragging'), '按下后进入拖拽态');
    handle.dispatchEvent(mk('pointermove', 300)); // jsdom 里 getBoundingClientRect 全是 0，会落到末尾
    handle.dispatchEvent(mk('pointerup', 300));
    await new Promise((r) => setTimeout(r, 40));
    assert.strictEqual(reorderCalls.length, 1, '松手后应调用一次排序接口');
    assert.strictEqual(reorderCalls[0][0], 's2', '被拖到末尾的应是原第一行：' + JSON.stringify(reorderCalls[0]));
    assert.strictEqual(reorderCalls[0][3], 's1');
    assert.ok(!d.body.classList.contains('dragging-active'), '拖拽结束要清掉全局态');
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
  ft('收起态显示小球、展开态显示内容', () => {
    const card = fd.querySelector('.card');
    assert.strictEqual(fd.getElementById('ball').hidden, true, '默认展开，不显示小球');
    assert.strictEqual(fd.getElementById('expanded').hidden, false);
    // 模拟主进程下发「已收起」
    listeners.float({ collapsed: true, edge: 'right' });
    assert.strictEqual(card.classList.contains('collapsed'), true);
    assert.strictEqual(fd.getElementById('ball').hidden, false, '收起后显示小球');
    assert.strictEqual(fd.getElementById('expanded').hidden, true, '收起后隐藏内容');
    assert.ok(fd.getElementById('ball').textContent.includes('/'), '小球显示涨跌家数：' + fd.getElementById('ball').textContent);
    assert.ok(fd.getElementById('ball').className.includes('up'), '涨多时小球红色');
    // 再展开
    listeners.float({ collapsed: false, edge: 'right' });
    assert.strictEqual(card.classList.contains('collapsed'), false);
    assert.strictEqual(fd.getElementById('expanded').hidden, false);
  });

  console.log(`\nDOM: 共 ${passed} 项，${process.exitCode ? '有失败' : '全部通过'}`);
})();
