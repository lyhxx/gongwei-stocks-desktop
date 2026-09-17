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
    { id: 's1', code: '600000', name: '浦发银行', market: 'CN', exchange: 'SH', order: 0, badgeEnabled: true,
      alert: { enabled: true, upperPrice: 10, lowerPrice: null, upperChangePercent: null, lowerChangePercent: null, snoozedUntil: null } },
    { id: 's2', code: '000001', name: '平安银行', market: 'CN', exchange: 'SZ', order: 1, badgeEnabled: false,
      alert: { enabled: false, upperPrice: null, lowerPrice: null, upperChangePercent: null, lowerChangePercent: null, snoozedUntil: null } },
  ],
  settings: {
    main: { theme: 'dark', refreshIntervalSeconds: 3, colors: {} },
    alerts: { channels: ['sound', 'notify'] },
    indices: { floatingVisible: true, selected: ['shanghai', 'shenzhen'] },
    floating: { opacity: 88, enabled: true },
  },
};
const marketData = {
  stockQuotes: [
    { stockId: 's1', code: '600000', name: '浦发银行', latestPrice: 9.1, changePercent: 1.25, changeAmount: 0.11, ok: true, updatedAt: Date.now() },
    { stockId: 's2', code: '000001', name: '平安银行', latestPrice: 11.66, changePercent: -0.34, changeAmount: -0.04, ok: true, updatedAt: Date.now() },
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
  snoozeStock: async () => ({}),
  updateSettings: async () => ({}),
  toggleIndex: async (id, on) => {
    const cur = new Set(store.settings.indices.selected);
    if (on) cur.add(id); else cur.delete(id);
    store.settings.indices.selected = [...cur];
    return store.settings.indices.selected;
  },
  toggleFloat: async () => true,
  hideFloat: async () => true,
  floatResize: () => {},
  testNotify: async () => ({ ok: true }),
  diagnose: async () => ({
    source: diagMock.source,
    updatedAt: Date.now(),
    stockCount: 2,
    errors: diagMock.errors,
  }),
  selftest: async () => ({ at: Date.now(), results: [] }),
  onMarket: (cb) => { listeners.market = cb; },
  onStore: (cb) => { listeners.store = cb; },
  onAlert: (cb) => { listeners.alert = cb; },
};
window.matchMedia = () => ({ matches: false, addEventListener: () => {} });
dom.window.eval(appJs);

let passed = 0;
const pending = [];
function t(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      pending.push(r.then(() => { passed += 1; console.log(`  PASS ${name}`); })
        .catch((e) => { console.error(`  FAIL ${name}: ${e.message}`); process.exitCode = 1; }));
    } else { passed += 1; console.log(`  PASS ${name}`); }
  } catch (e) {
    console.error(`  FAIL ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

(async () => {
  await new Promise((r) => setTimeout(r, 60));
  const d = window.document;

  console.log('[自选卡片]');
  t('渲染 2 只', () => assert.strictEqual(d.querySelectorAll('.stock').length, 2));
  t('涨跌胶囊', () => {
    const pills = d.querySelectorAll('.pill');
    assert.ok(pills[0].className.includes('pct-up') && pills[0].textContent.includes('+1.25%'));
    assert.ok(pills[1].className.includes('pct-down') && pills[1].textContent.includes('-0.34%'));
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
    assert.strictEqual(after.length, 2);
    assert.strictEqual(after[1].querySelector('.aconfig').hidden, false, '展开态保持');
    assert.strictEqual(after[1].querySelector('input[data-k="upperPrice"]').value, '12.5', '输入值保持');
    assert.ok(after[0].querySelector('.price').textContent.includes('9.10'));
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
  await Promise.all(pending);

  console.log('[浮窗]');
  const fdomHeights = [];
  const fdom = new JSDOM(fhtml, { url: 'http://localhost/', runScripts: 'outside-only' });
  fdom.window.gongwei = window.gongwei;
  fdom.window.matchMedia = window.matchMedia;
  fdom.window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  fdom.window.eval(fjs);
  await new Promise((r) => setTimeout(r, 60));
  const fd = fdom.window.document;
  const ft = (name, fn) => {
    try { fn(); passed += 1; console.log(`  PASS ${name}`); }
    catch (e) { console.error(`  FAIL ${name}: ${e.message}`); process.exitCode = 1; }
  };
  ft('浮窗仅有更新时间与涨跌家数，无标题无页脚', () => {
    assert.ok(!fd.body.textContent.includes('工位看盘'));
    assert.ok(!fd.body.textContent.includes('Esc 隐藏'), '页脚提示应移除');
    assert.strictEqual(fd.querySelectorAll('footer').length, 0);
    assert.ok(fd.getElementById('time').textContent.startsWith('更新 '));
    assert.ok(fd.getElementById('stat').textContent.includes('涨1'), fd.getElementById('stat').textContent);
  });
  ft('浮窗指数横排卡片且跟随勾选', () => {
    assert.ok(fd.querySelectorAll('.idx-grid .idx-card').length >= 1, '指数应为卡片');
    assert.ok(!fd.querySelector('.idx-line'), '旧的行式指数已移除');
  });

  console.log(`\nDOM: 共 ${passed} 项，${process.exitCode ? '有失败' : '全部通过'}`);
})();
