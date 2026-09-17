// 工位看盘 - 行情/搜索解析与联调自测（不联网，全部用 mock，可直接 npm test）
const assert = require('assert');
const path = require('path');
const P = require(path.join(__dirname, '..', 'src', 'common', 'providers.js'));

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
async function okAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}: ${e && e.message}`);
    process.exitCode = 1;
  }
}

(async () => {
  console.log('[1] unicode 转义与 smartbox 解析');
  ok('unescape 保留 ascii', () => assert.strictEqual(P.unescapeUnicode('abc600'), 'abc600'));
  ok('unescape 解中文', () => assert.strictEqual(P.unescapeUnicode(String.raw`\u6d66\u53d1\u94f6\u884c`), '浦发银行'));
  ok('smartbox 单条', () => {
    const r = P.parseSmartbox(String.raw`v_hint="sh~600000~\u6d66\u53d1\u94f6\u884c~pfyh~GP-A"`);
    assert.strictEqual(r[0].name, '浦发银行');
    assert.strictEqual(r[0].exchange, 'SH');
  });
  ok('smartbox 过滤基金', () => {
    const r = P.parseSmartbox(String.raw`v_hint="sh~600000~\u6d66\u53d1~pfyh~GP-A^jj~007005~X~x~KJ"`);
    assert.strictEqual(r.length, 1);
  });
  ok('smartbox 港股/美股', () => {
    const r = P.parseSmartbox('v_hint="hk~00700~T~tx~GP^us~aapl.oq~A~pg~GP"');
    assert.strictEqual(r[0].exchange, 'HKEX');
    assert.strictEqual(r[1].code, 'AAPL');
  });
  ok('smartbox 空', () => assert.deepStrictEqual(P.parseSmartbox('v_hint=""'), []));

  console.log('[2] 代码规则与 secid');
  ok('港股前缀 hk（不是 hkex）', () => assert.strictEqual(P.tencentSymbol({ code: '00700', exchange: 'HKEX' }), 'hk00700'));
  ok('A 股前缀', () => {
    assert.strictEqual(P.tencentSymbol({ code: '600000', exchange: 'SH' }), 'sh600000');
    assert.strictEqual(P.tencentSymbol({ code: '899050', exchange: 'BJ' }), 'bj899050');
  });
  ok('东财 secid', () => {
    assert.strictEqual(P.eastmoneySecid({ code: '600000', exchange: 'SH' }), '1.600000');
    assert.strictEqual(P.eastmoneySecid({ code: '000001', exchange: 'SZ' }), '0.000001');
  });
  ok('纯代码直通', () => {
    assert.strictEqual(P.directCodeCandidate('600000').exchange, 'SH');
    assert.strictEqual(P.directCodeCandidate('000001').exchange, 'SZ');
    assert.strictEqual(P.directCodeCandidate('899050').exchange, 'BJ');
    assert.strictEqual(P.directCodeCandidate('gzmt'), null);
  });

  console.log('[3] 数值换算');
  ok('除以精度', () => {
    assert.strictEqual(P.numScale(785, 100), 7.85);
    assert.strictEqual(P.pct100(123), 1.23);
    assert.ok(Number.isNaN(P.numScale(undefined, 100)));
  });

  console.log('[4] 新浪 / 腾讯行解析');
  ok('新浪行', () => {
    const p = P.parseSinaLine('var hq_str_sh600000="PF,7.79,7.80,7.85,7.90,7.78,0";');
    assert.ok(Math.abs(p.latestPrice - 7.85) < 1e-9);
  });
  ok('新浪脏数据', () => {
    assert.strictEqual(P.parseSinaLine('var hq_str_sh600000="";'), null);
    assert.strictEqual(P.parseSinaLine('nope'), null);
  });
  ok('腾讯行', () => {
    const p = P.parseTencentLine('v_sh600000="1~N~600000~7.85~7.79~0.06~0~0~0~";');
    assert.ok(Math.abs(p.latestPrice - 7.85) < 1e-9);
  });
  ok('腾讯脏数据', () => assert.strictEqual(P.parseTencentLine('v_sh600000="1~x";'), null));

  console.log('[5] 新浪 / 雪球搜索解析');
  ok('新浪 suggest', () => {
    const r = P.parseSinaSuggest('var suggestvalue="MT,11,sh600519,600519,X;PF,11,sh600000,600000,Y;";');
    assert.strictEqual(r.length, 2);
    assert.strictEqual(r[0].code, '600519');
  });
  ok('雪球 suggest', () => {
    const r = P.parseXueqiuSuggest({ data: { items: [{ symbol: 'SH600519', name: 'MT' }, { symbol: 'bad' }] } });
    assert.strictEqual(r.length, 1);
  });
  ok('GBK 自动识别', () => {
    const gbk = Buffer.from([0xC3, 0xA9, 0xCC, 0xA8]);
    assert.strictEqual(P.decodeAuto(gbk), '茅台');
    assert.strictEqual(P.decodeAuto(Buffer.from('hello茅台', 'utf8')), 'hello茅台');
  });

  console.log('[6] 联调：三通道并行合并（mock fetch）');
  const realFetch = global.fetch;
  await okAsync('东财补 A、腾讯补 B，新浪挂掉被记录', async () => {
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes('push2')) {
        const secid = (u.match(/secid=([^&]*)/) || [])[1] || '';
        if (secid.includes('600000')) {
          return { ok: true, status: 200, json: async () => ({ data: { f43: 785, f60: 780, f169: 5, f170: 64, f58: '浦发银行', f59: 2, f152: 2 } }) };
        }
        return { ok: true, status: 200, json: async () => ({ data: {} }) };
      }
      if (u.includes('sinajs')) throw new Error('mock sina down');
      if (u.includes('qt.gtimg')) {
        return { ok: true, status: 200, arrayBuffer: async () => Buffer.from('v_sh600000="1~N~600000~7.85~7.79~0.06~0~0~0~";v_sz000001="1~N~000001~10.00~9.90~0.10~0~0~0~";', 'latin1') };
      }
      throw new Error('unexpected url ' + u);
    };
    const stocks = [
      { id: 'a', code: '600000', name: '浦发银行', market: 'CN', exchange: 'SH' },
      { id: 'b', code: '000001', name: '平安银行', market: 'CN', exchange: 'SZ' },
    ];
    const { rows, source, errors } = await P.fetchQuotesWithFallback(stocks);
    assert.strictEqual(rows.length, 2);
    assert.ok(rows.every((r) => r.ok), '两只都应有值');
    assert.ok(source.includes('eastmoney') && source.includes('tencent'), '来源应合并：' + source);
    assert.ok(errors.some((e) => e.includes('sina')), '新浪报错应被记录');
  });
  await okAsync('全部通道挂掉', async () => {
    global.fetch = async () => { throw new Error('net down'); };
    const { rows, source } = await P.fetchQuotesWithFallback([{ id: 'a', code: '600000', name: 'X', market: 'CN', exchange: 'SH' }]);
    assert.strictEqual(source, 'none');
    assert.strictEqual(rows[0].ok, false);
  });

  console.log('[7] 联调：搜索多层兜底（mock fetch）');
  await okAsync('腾讯空 -> 东财挂 -> 落到新浪', async () => {
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes('smartbox')) return { ok: true, status: 200, text: async () => 'v_hint=""' };
      if (u.includes('searchapi')) throw new Error('eastmoney down');
      if (u.includes('suggest3')) return { ok: true, status: 200, arrayBuffer: async () => Buffer.from('var suggestvalue="MT,11,sh600519,600519,X;";', 'utf8') };
      throw new Error('unexpected ' + u);
    };
    const rows = await P.searchStocks('mt', 5);
    assert.strictEqual(rows[0].code, '600519');
  });
  await okAsync('全挂时纯代码直通兜底', async () => {
    global.fetch = async () => { throw new Error('all down'); };
    const rows = await P.searchStocks('600000', 5);
    assert.strictEqual(rows[0].code, '600000');
    let threw = false;
    try { await P.searchStocks('gzmt', 5); } catch (e) { threw = /搜索失败/.test(e.message); }
    assert.ok(threw, '非代码且全挂应抛错');
  });
  global.fetch = realFetch;

  console.log(`\nproviders: 共 ${passed} 项，${process.exitCode ? '有失败' : '全部通过'}`);
})();
