// 工位看盘 - 提醒条件判定单测（纯函数，不联网）
const assert = require('assert');
const path = require('path');
const A = require(path.join(__dirname, '..', 'src', 'common', 'alerts.js'));

let passed = 0;
function ok(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

// 造一只自选 + 一条行情
function caseOf(alert, quote, stockExtra = {}) {
  const stock = { id: 's1', code: '600000', market: 'CN', exchange: 'SH', name: '测试股', alert: { enabled: true, ...alert }, ...stockExtra };
  const q = { stockId: 's1', ok: true, latestPrice: 10, changePercent: 0, ...quote };
  return { stock, q };
}
const run = (alert, quote, opts, stockExtra) => {
  const { stock, q } = caseOf(alert, quote, stockExtra);
  return A.checkAlerts([stock], [q], opts);
};

console.log('[涨跌停幅度]');
ok('主板 10 / 创业科创 20 / 北交 30 / 港美股不限', () => {
  assert.strictEqual(A.limitPctOf({ code: '600000', market: 'CN' }), 10);
  assert.strictEqual(A.limitPctOf({ code: '000001', market: 'CN' }), 10);
  assert.strictEqual(A.limitPctOf({ code: '300059', market: 'CN' }), 20);
  assert.strictEqual(A.limitPctOf({ code: '688981', market: 'CN' }), 20);
  assert.strictEqual(A.limitPctOf({ code: '899050', market: 'CN' }), 30);
  assert.strictEqual(A.limitPctOf({ code: '430047', market: 'CN' }), 30);
  assert.strictEqual(A.limitPctOf({ code: '00700', market: 'HK' }), 0);
  assert.strictEqual(A.limitPctOf({ code: 'AAPL', market: 'US' }), 0);
});

console.log('[价格 / 涨跌幅]');
ok('上破价触发', () => {
  assert.strictEqual(run({ upperPrice: 10 }, { latestPrice: 10.1 }).length, 1);
  assert.strictEqual(run({ upperPrice: 10 }, { latestPrice: 9.9 }).length, 0);
});
ok('下跌价触发', () => {
  assert.strictEqual(run({ lowerPrice: 10 }, { latestPrice: 9.9 }).length, 1);
  assert.strictEqual(run({ lowerPrice: 10 }, { latestPrice: 10.1 }).length, 0);
});
ok('涨幅触发；填 -5 也按 5% 处理', () => {
  assert.strictEqual(run({ upperChangePercent: 5 }, { changePercent: 5.1 }).length, 1);
  assert.strictEqual(run({ upperChangePercent: 5 }, { changePercent: 4.9 }).length, 0);
  assert.strictEqual(run({ upperChangePercent: -5 }, { changePercent: 6 }).length, 1);
});
ok('跌幅触发', () => {
  assert.strictEqual(run({ lowerChangePercent: 5 }, { changePercent: -5.1 }).length, 1);
  assert.strictEqual(run({ lowerChangePercent: 5 }, { changePercent: -4.9 }).length, 0);
});

console.log('[涨跌停]');
ok('主板 9.9% 算涨停附近，9.0% 不算', () => {
  assert.strictEqual(run({ limitUp: true }, { changePercent: 9.9 }).length, 1);
  assert.strictEqual(run({ limitUp: true }, { changePercent: 9.0 }).length, 0);
});
ok('创业板 9.9% 不算涨停（限 20%），19.9% 才算', () => {
  const st = { code: '300059' };
  assert.strictEqual(run({ limitUp: true }, { changePercent: 9.9 }, undefined, st).length, 0);
  assert.strictEqual(run({ limitUp: true }, { changePercent: 19.9 }, undefined, st).length, 1);
});
ok('北交所 -29.9% 算跌停附近', () => {
  assert.strictEqual(run({ limitDown: true }, { changePercent: -29.9 }, undefined, { code: '899050' }).length, 1);
});
ok('港美股不做涨跌停', () => {
  assert.strictEqual(run({ limitUp: true }, { changePercent: 9.9 }, undefined, { code: '00700', market: 'HK' }).length, 0);
});

console.log('[成交量异动]');
ok('量比达到阈值触发', () => {
  assert.strictEqual(run({ volumeAnomaly: true, volumeRatio: 2 }, { volumeRatio: 2.5 }).length, 1);
  assert.strictEqual(run({ volumeAnomaly: true, volumeRatio: 2 }, { volumeRatio: 1.5 }).length, 0);
});
ok('缺少量比（如新浪/腾讯通道）不触发', () => {
  assert.strictEqual(run({ volumeAnomaly: true, volumeRatio: 2 }, {}).length, 0);
});

console.log('[N 分钟急涨急跌]');
ok('5 分钟涨 4% 触发急涨', () => {
  const now = 1_000_000_000_000;
  const history = new Map([['s1', [{ t: now - 6 * 60 * 1000, p: 100 }]]]);
  const hits = run({ rapidEnabled: true, rapidMinutes: 5, rapidPercent: 3 }, { latestPrice: 104 }, { history, now });
  assert.strictEqual(hits.length, 1);
  assert.ok(hits[0].reasons.some((r) => r.includes('急涨')), hits[0].reasons.join());
});
ok('5 分钟跌 4% 触发急跌', () => {
  const now = 1_000_000_000_000;
  const history = new Map([['s1', [{ t: now - 6 * 60 * 1000, p: 100 }]]]);
  const hits = run({ rapidEnabled: true, rapidMinutes: 5, rapidPercent: 3 }, { latestPrice: 96 }, { history, now });
  assert.strictEqual(hits.length, 1);
  assert.ok(hits[0].reasons.some((r) => r.includes('急跌')), hits[0].reasons.join());
});
ok('幅度不到阈值不触发', () => {
  const now = 1_000_000_000_000;
  const history = new Map([['s1', [{ t: now - 6 * 60 * 1000, p: 100 }]]]);
  assert.strictEqual(run({ rapidEnabled: true, rapidMinutes: 5, rapidPercent: 3 }, { latestPrice: 102 }, { history, now }).length, 0);
});
ok('没有历史采样不触发', () => {
  assert.strictEqual(run({ rapidEnabled: true, rapidPercent: 3 }, { latestPrice: 200 }, { history: new Map() }).length, 0);
});
ok('rapidChangePct 取 N 分钟前最近一条', () => {
  const now = 1_000_000_000_000;
  const samples = [
    { t: now - 10 * 60 * 1000, p: 90 },
    { t: now - 6 * 60 * 1000, p: 100 },
    { t: now - 1 * 60 * 1000, p: 103 },
  ];
  const pct = A.rapidChangePct(samples, 104, 5, now); // 取 <= now-5min 的最近一条 = 100
  assert.ok(Math.abs(pct - 4) < 1e-9, String(pct));
});

console.log('[其它]');
ok('未启用 / 无行情 / 行情异常 都不触发', () => {
  const { stock, q } = caseOf({ enabled: false, upperPrice: 1 }, { latestPrice: 100 });
  assert.strictEqual(A.checkAlerts([stock], [q]).length, 0); // 关闭
  const on = caseOf({ upperPrice: 1 }, { latestPrice: 100 });
  assert.strictEqual(A.checkAlerts([on.stock], []).length, 0); // 无行情
  assert.strictEqual(A.checkAlerts([on.stock], [{ stockId: 's1', ok: false }]).length, 0); // 行情异常
});
ok('命中的 hit 带上名称/代码/多个原因', () => {
  const hits = run({ upperPrice: 10, lowerChangePercent: 5 }, { latestPrice: 10.2, changePercent: -5.5 });
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].stockCode, '600000');
  assert.ok(hits[0].reasons.length >= 2, hits[0].reasons.join());
});

console.log(`\nalerts: 共 ${passed} 项，${process.exitCode ? '有失败' : '全部通过'}`);
