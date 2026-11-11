// 工位看盘 - 行情/搜索解析与联调自测（不联网，全部用 mock，可直接 npm test）
const assert = require('assert');
const path = require('path');
const P = require(path.join(__dirname, '..', 'src', 'common', 'providers.js'));
const X = require(path.join(__dirname, '..', 'src', 'common', 'proxy.js'));
const H = require(path.join(__dirname, '..', 'src', 'common', 'http.js'));

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

  console.log('[4] 新浪行解析');
  ok('新浪行', () => {
    const p = P.parseSinaLine('var hq_str_sh600000="PF,7.79,7.80,7.85,7.90,7.78,0";');
    assert.ok(Math.abs(p.latestPrice - 7.85) < 1e-9);
  });
  ok('新浪脏数据', () => {
    assert.strictEqual(P.parseSinaLine('var hq_str_sh600000="";'), null);
    assert.strictEqual(P.parseSinaLine('nope'), null);
  });

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

  console.log('[6] 联调：东财批量 + 新浪备份（mock fetch）');
  const realFetch = global.fetch;
  await okAsync('新浪挂掉不影响整体，东财批量一次拿全', async () => {
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes('ulist.np')) {
        // 批量接口：一次返回全部标的（f2=最新价 f3=涨跌幅 f4=涨跌额 f18=昨收）
        return { ok: true, status: 200, json: async () => ({ data: { diff: [
          { f13: 1, f12: '600000', f14: '浦发银行', f2: 7.85, f3: 0.64, f4: 0.05, f5: 100, f6: 1000, f15: 7.9, f16: 7.78, f17: 7.79, f18: 7.80 },
          { f13: 0, f12: '000001', f14: '平安银行', f2: 10.0, f3: 1.01, f4: 0.1, f5: 200, f6: 2000, f15: 10.1, f16: 9.9, f17: 9.95, f18: 9.9 },
        ] } }) };
      }
      if (u.includes('stock/get')) {
        return { ok: true, status: 200, json: async () => ({ data: { f43: 785, f60: 780, f169: 5, f170: 64, f58: '浦发银行', f59: 2 } }) };
      }
      if (u.includes('sinajs')) throw new Error('mock sina down');
      throw new Error('unexpected url ' + u);
    };
    const stocks = [
      { id: 'a', code: '600000', name: '浦发银行', market: 'CN', exchange: 'SH' },
      { id: 'b', code: '000001', name: '平安银行', market: 'CN', exchange: 'SZ' },
    ];
    // 主进程就是「两通道并行 + mergeQuoteRows 按只合并」，这里用同一套纯函数复现
    const settled = await Promise.allSettled([P.fetchEastmoney(stocks), P.fetchSina(stocks)]);
    assert.strictEqual(settled[1].status, 'rejected', '新浪应失败');
    const groups = settled.map((s) => (s.status === 'fulfilled' ? s.value : []));
    const { rows, source } = P.mergeQuoteRows(stocks, groups);
    assert.strictEqual(rows.length, 2);
    assert.ok(rows.every((r) => r.ok), '两只都应有值');
    assert.ok(source.includes('eastmoney'), '来源应合并：' + source);
    assert.strictEqual(rows[0].latestPrice, 7.85, '批量接口 f2 才是最新价');
    assert.strictEqual(rows[0].changePercent, 0.64);
    assert.strictEqual(rows[0].decimals, 2, '小数位按品种兜底');
  });
  await okAsync('批量接口挂了会自动退回逐只请求', async () => {
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes('ulist.np')) throw new Error('batch down');
      return { ok: true, status: 200, json: async () => ({ data: { f43: 785, f60: 780, f169: 5, f170: 64, f58: '浦发银行', f59: 2 } }) };
    };
    const [row] = await P.fetchEastmoney([{ id: 'a', code: '600000', name: '浦发银行', market: 'CN', exchange: 'SH' }]);
    assert.strictEqual(row.ok, true, '退回逐只后仍应有数据');
    assert.strictEqual(row.latestPrice, 7.85);
  });
  await okAsync('全部通道挂掉：合并后 ok=false、来源 none', async () => {
    global.fetch = async () => { throw new Error('net down'); };
    const stocks = [{ id: 'a', code: '600000', name: 'X', market: 'CN', exchange: 'SH' }];
    const settled = await Promise.allSettled([P.fetchEastmoney(stocks), P.fetchSina(stocks)]);
    const groups = settled.map((s) => (s.status === 'fulfilled' ? s.value : []));
    const { rows, source } = P.mergeQuoteRows(stocks, groups);
    assert.strictEqual(source, 'none');
    assert.strictEqual(rows[0].ok, false);
  });
  await okAsync('东财缺 f59 时用 f152 定精度（单只接口）', async () => {
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: { f43: 7850, f60: 7800, f169: 50, f170: 64, f58: 'X', f152: 3 } }) });
    const row = await P.fetchOneEastmoney({ id: 'a', code: '600000', name: 'X', market: 'CN', exchange: 'SH' });
    assert.strictEqual(row.latestPrice, 7.85, '应按 f152=3 除以 1000');
    assert.strictEqual(row.decimals, 3);
  });
  await okAsync('f59/f152 都缺时按 A 股默认除以 100（空值不能被当成 0 位小数）', async () => {
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: { f43: 785, f60: 780, f169: 5, f170: 64, f58: 'X' } }) });
    const row = await P.fetchOneEastmoney({ id: 'a', code: '600000', name: 'X', market: 'CN', exchange: 'SH' });
    assert.strictEqual(row.latestPrice, 7.85, '应按默认 100 换算，而不是除以 1');
    assert.strictEqual(row.decimals, 2);
  });

  console.log('[6.5] K 线 / 分时（mock 东财历史接口）');
  await okAsync('K 线解析：日期/开收高低/量额/涨跌幅', async () => {
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({
      data: {
        code: '600000', name: '浦发银行', decimal: 2,
        klines: [
          '2026-09-16,10.00,10.50,10.60,9.90,100000,105000000,7.00,5.00,3.21',
          '2026-09-17,10.50,10.20,10.70,10.10,80000,82000000,5.71,-2.86,2.55',
        ],
      },
    }) });
    const r = await P.fetchKline({ code: '600000', exchange: 'SH', market: 'CN' }, 'day', 160);
    assert.strictEqual(r.decimals, 2);
    assert.strictEqual(r.klines.length, 2);
    assert.deepStrictEqual(
      { o: r.klines[0].open, c: r.klines[0].close, h: r.klines[0].high, l: r.klines[0].low },
      { o: 10, c: 10.5, h: 10.6, l: 9.9 },
    );
    assert.strictEqual(r.klines[0].volume, 100000);
    assert.strictEqual(r.klines[1].changePercent, -2.86);
    assert.strictEqual(r.klines[0].turnover, 3.21, 'f61 是换手率');
  });
  await okAsync('周/月 K 使用 klt=102/103', async () => {
    let seen = '';
    global.fetch = async (url) => { seen = String(url); return { ok: true, status: 200, json: async () => ({ data: { decimal: 2, klines: ['2026-09-18,1,1,1,1,1,1,0,0'] } }) }; };
    await P.fetchKline({ code: '600000', exchange: 'SH' }, 'week');
    assert.ok(seen.includes('klt=102'), seen);
    await P.fetchKline({ code: '600000', exchange: 'SH' }, 'month');
    assert.ok(seen.includes('klt=103'), seen);
  });
  await okAsync('K 线空数据要报错', async () => {
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: { klines: [] } }) });
    let threw = false;
    try { await P.fetchKline({ code: '600000', exchange: 'SH' }, 'day'); } catch (e) { threw = /K数据/.test(e.message); }
    assert.ok(threw, '空 klines 应抛错');
  });
  await okAsync('K 线请求必须带 end（否则东财返回 rc:102 / 空数据）', async () => {
    let seen = '';
    global.fetch = async (url) => { seen = String(url); return { ok: true, status: 200, json: async () => ({ data: { decimal: 2, klines: ['2026-09-18,1,1,1,1,1,1,0,0'] } }) }; };
    await P.fetchKline({ code: '600000', exchange: 'SH' }, 'day');
    assert.ok(seen.includes('end='), '缺少 end 会拿不到数据：' + seen);
  });
  await okAsync('实时明细解析：今开/昨收/今高/今低/量/额/换手率', async () => {
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: { f43: 907, f44: 915, f45: 900, f46: 905, f47: 517593, f48: 469969405, f58: '浦发银行', f59: 2, f60: 906, f168: 16, f169: 1, f170: 11 } }) });
    const d = await P.fetchStockDetail({ code: '600000', exchange: 'SH', market: 'CN' });
    assert.strictEqual(d.open, 9.05);
    assert.strictEqual(d.preClose, 9.06);
    assert.strictEqual(d.high, 9.15);
    assert.strictEqual(d.low, 9.0);
    assert.strictEqual(d.volume, 517593);
    assert.strictEqual(d.amount, 469969405);
    assert.strictEqual(d.turnover, 0.16, 'f168 是换手率×100');
    assert.strictEqual(d.decimals, 2);
  });
  await okAsync('分时解析：prePrice + 价格/量', async () => {
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({
      data: {
        code: '600000', name: '浦发银行', decimal: 2, prePrice: 10.00,
        trends: ['2026-09-17 09:30,10.10,1000,10.10', '2026-09-17 09:31,10.05,1200,10.08'],
      },
    }) });
    const r = await P.fetchTrends({ code: '600000', exchange: 'SH', market: 'CN' });
    assert.strictEqual(r.preClose, 10);
    assert.strictEqual(r.trends.length, 2);
    assert.strictEqual(r.trends[1].price, 10.05);
    assert.strictEqual(r.trends[0].time, '2026-09-17 09:30');
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

  console.log('[8] HTTP 层与代理');
  ok('默认实现回落到全局 fetch', () => {
    assert.strictEqual(typeof H.httpFetch, 'function');
    assert.strictEqual(H.getFetchImpl(), null, '未注入时应为 null，走全局 fetch');
  });
  await okAsync('注入的实现会被使用（模拟 net.fetch）', async () => {
    const realFetch2 = global.fetch;
    global.fetch = async () => { throw new Error('should not be called'); };
    H.setFetchImpl(async (url) => ({ ok: true, status: 200, url }));
    const r = await H.fetchWithTimeout('https://example.com/x', {}, 1000);
    assert.strictEqual(r.status, 200);
    H.setFetchImpl(null);
    global.fetch = realFetch2;
  });
  ok('代理模式兜底', () => {
    assert.strictEqual(X.normalizeProxyMode('manual'), 'manual');
    assert.strictEqual(X.normalizeProxyMode('direct'), 'direct');
    assert.strictEqual(X.normalizeProxyMode('乱填'), 'system');
    assert.strictEqual(X.normalizeProxyMode(undefined), 'system');
  });
  ok('代理地址规整', () => {
    assert.strictEqual(X.normalizeProxyRules('127.0.0.1:7890').rules, 'http://127.0.0.1:7890');
    assert.strictEqual(X.normalizeProxyRules('  http://127.0.0.1:7890 ').rules, 'http://127.0.0.1:7890');
    assert.strictEqual(X.normalizeProxyRules('socks5://127.0.0.1:1080').rules, 'socks5://127.0.0.1:1080');
    assert.strictEqual(X.normalizeProxyRules('socks4://a.b:1080').rules, 'socks4://a.b:1080');
  });
  ok('非法代理地址给出人话原因', () => {
    assert.match(X.normalizeProxyRules('').error, /为空/);
    assert.match(X.normalizeProxyRules('ftp://a:21').error, /不支持的代理协议/);
    assert.match(X.normalizeProxyRules('a').error, /主机和端口/);
    assert.match(X.normalizeProxyRules('a:99999').error, /不合法/);
    assert.strictEqual(X.normalizeProxyRules('a').ok, false);
  });
  ok('resolveProxy 结果转人话', () => {
    assert.match(X.describeResolvedProxy('DIRECT'), /直连/);
    assert.strictEqual(X.describeResolvedProxy('PROXY 127.0.0.1:7897'), 'HTTP 代理 127.0.0.1:7897');
    assert.strictEqual(X.describeResolvedProxy('SOCKS5 1.2.3.4:1080; DIRECT'), 'SOCKS5 代理 1.2.3.4:1080');
    assert.strictEqual(X.describeResolvedProxy(''), '直连（未使用代理）');
  });

  console.log('[9] 品种归类（股票 / 基金 / 可转债）');
  ok('代码前缀推断交易所与品种', () => {
    const t = (c) => { const k = P.classifyCode(c); return `${k.exchange}/${k.securityType}/${k.decimals}`; };
    // 股票
    assert.strictEqual(t('600000'), 'SH/stock/2');
    assert.strictEqual(t('000001'), 'SZ/stock/2');
    assert.strictEqual(t('300059'), 'SZ/stock/2');
    assert.strictEqual(t('688981'), 'SH/stock/2');
    assert.strictEqual(t('430047'), 'BJ/stock/2');
    assert.strictEqual(t('899050'), 'BJ/stock/2');
    // 场内基金：5xxxxx 在沪市（曾错判成深市），15/16/18 在深市
    assert.strictEqual(t('510300'), 'SH/fund/3');
    assert.strictEqual(t('588000'), 'SH/fund/3');
    assert.strictEqual(t('159915'), 'SZ/fund/3');
    assert.strictEqual(t('161725'), 'SZ/fund/3');
    assert.strictEqual(t('180101'), 'SZ/fund/3');
    // 可转债：110/113 在沪市，12xxxx 在深市
    assert.strictEqual(t('113050'), 'SH/bond/3');
    assert.strictEqual(t('110043'), 'SH/bond/3');
    assert.strictEqual(t('123456'), 'SZ/bond/3');
    assert.strictEqual(t('128123'), 'SZ/bond/3');
  });
  ok('smartbox 收 ETF/可转债、剔除场外基金', () => {
    const raw = String.raw`v_hint="sh~510300~\u6caa\u6df1300ETF~x~ETF^sh~600000~\u6d66\u53d1~x~GP-A^jj~007005~\u573a\u5916\u57fa\u91d1~x~KJ^sh~113050~\u5357\u94f6\u8f6c\u503a~x~ZQ"`;
    const r = P.parseSmartbox(raw);
    assert.strictEqual(r.length, 3, '场外基金(KJ/jj)应被剔除，ETF 应保留');
    assert.strictEqual(r[0].securityType, 'fund');
    assert.strictEqual(r[1].securityType, 'stock');
    assert.strictEqual(r[2].securityType, 'bond');
  });
  ok('纯代码直通带品种（基金不再误判深市）', () => {
    assert.deepStrictEqual(
      { e: P.directCodeCandidate('510300').exchange, t: P.directCodeCandidate('510300').securityType },
      { e: 'SH', t: 'fund' },
    );
    assert.strictEqual(P.directCodeCandidate('113050').exchange, 'SH');
    assert.strictEqual(P.directCodeCandidate('123456').exchange, 'SZ');
    assert.strictEqual(P.directCodeCandidate('161725').securityType, 'fund');
  });
  ok('东财 suggest 品种归类', () => {
    assert.strictEqual(P.typeFromSuggest({ Classify: 'AStock' }), 'stock');
    assert.strictEqual(P.typeFromSuggest({ Classify: 'Fund', SecurityTypeName: 'ETF' }), 'fund');
    assert.strictEqual(P.typeFromSuggest({ Classify: 'Index' }), 'index');
    assert.strictEqual(P.typeFromSuggest({ Classify: 'Bond', SecurityTypeName: '可转债' }), 'bond');
  });

  console.log('[10] 自选排序');
  const O = require(path.join(__dirname, '..', 'src', 'common', 'order.js'));
  const mkStocks = () => [
    { id: 'a', code: '600000', order: 0 },
    { id: 'b', code: '000001', order: 1 },
    { id: 'c', code: '510300', order: 2 },
  ];
  ok('按新顺序重排并重写 order', () => {
    const out = O.applyOrder(mkStocks(), ['c', 'a', 'b']);
    assert.deepStrictEqual(out.map((s) => s.id), ['c', 'a', 'b']);
    assert.deepStrictEqual(out.map((s) => s.order), [0, 1, 2]);
    assert.strictEqual(out[0].code, '510300', '数据要跟着走');
  });
  ok('长度不一致要报错', () => {
    assert.throws(() => O.applyOrder(mkStocks(), ['a', 'b']), /长度/);
    assert.throws(() => O.applyOrder(mkStocks(), ['a', 'b', 'c', 'd']), /长度/);
  });
  ok('未知 id / 重复 id 要报错', () => {
    assert.throws(() => O.applyOrder(mkStocks(), ['a', 'b', 'x']), /未知/);
    assert.throws(() => O.applyOrder(mkStocks(), ['a', 'a', 'b']), /重复/);
  });
  ok('非法入参要报错', () => {
    assert.throws(() => O.applyOrder(mkStocks(), null), /数组/);
    assert.throws(() => O.applyOrder(null, ['a']), /异常/);
  });
  ok('指数排序：selected 就是 id 数组', () => {
    assert.deepStrictEqual(O.applyIndexOrder(['shanghai', 'shenzhen', 'chinext'], ['chinext', 'shanghai', 'shenzhen']), ['chinext', 'shanghai', 'shenzhen']);
    assert.throws(() => O.applyIndexOrder(['shanghai', 'shenzhen'], ['shanghai']), /长度/);
    assert.throws(() => O.applyIndexOrder(['shanghai', 'shenzhen'], ['shanghai', 'nope']), /未知指数/);
    assert.throws(() => O.applyIndexOrder(['shanghai', 'shenzhen'], ['shanghai', 'shanghai']), /重复指数/);
  });

  console.log('[11] A 股交易时段与交易日');
  const M = require(path.join(__dirname, '..', 'src', 'common', 'market-hours.js'));
  // 北京时间 = UTC + 8，下面统一用 UTC 串构造
  const at = (iso) => M.sessionPhase(new Date(iso));
  ok('盘前不发请求，下一次变化是 09:15', () => {
    const s = at('2026-09-18T01:00:00Z'); // 周五 09:00
    assert.strictEqual(s.trading, false);
    assert.strictEqual(s.phase, 'before-open');
    assert.strictEqual(new Date(s.nextChangeAt).toISOString(), '2026-09-18T01:15:00.000Z');
  });
  ok('集合竞价与上午盘中都请求', () => {
    assert.strictEqual(at('2026-09-18T01:20:00Z').phase, 'auction');   // 09:20
    assert.strictEqual(at('2026-09-18T01:20:00Z').trading, true);
    assert.strictEqual(at('2026-09-18T02:00:00Z').phase, 'morning');   // 10:00
    assert.strictEqual(at('2026-09-18T02:00:00Z').trading, true);
  });
  ok('11:30 整点收上午，午休不发请求', () => {
    assert.strictEqual(at('2026-09-18T03:29:00Z').trading, true);      // 11:29
    const s = at('2026-09-18T04:00:00Z');                              // 12:00
    assert.strictEqual(s.trading, false);
    assert.strictEqual(s.phase, 'lunch');
    assert.strictEqual(new Date(s.nextChangeAt).toISOString(), '2026-09-18T05:00:00.000Z'); // 13:00
  });
  ok('下午盘中请求，15:00 收盘', () => {
    assert.strictEqual(at('2026-09-18T06:00:00Z').phase, 'afternoon'); // 14:00
    assert.strictEqual(at('2026-09-18T06:00:00Z').trading, true);
    assert.strictEqual(at('2026-09-18T07:00:00Z').trading, false);     // 15:00 整
  });
  ok('收盘后有快照窗口，保证拿到最终价', () => {
    const s = at('2026-09-18T07:10:00Z'); // 15:10
    assert.strictEqual(s.snapshotDue, true);
    assert.strictEqual(s.trading, false);
    assert.strictEqual(s.phase, 'after-close');
  });
  ok('快照窗口结束后不再请求，下次是下一个交易日开盘', () => {
    const s = at('2026-09-18T08:00:00Z'); // 周五 16:00
    assert.strictEqual(s.phase, 'closed');
    assert.strictEqual(s.snapshotDue, false);
    assert.strictEqual(new Date(s.nextChangeAt).toISOString(), '2026-09-21T01:15:00.000Z'); // 下周一 09:15
  });
  ok('周末整天不请求', () => {
    const s = at('2026-09-19T02:00:00Z'); // 周六 10:00
    assert.strictEqual(s.trading, false);
    assert.strictEqual(s.phase, 'weekend');
    assert.strictEqual(s.snapshotDue, false);
    assert.strictEqual(new Date(s.nextChangeAt).toISOString(), '2026-09-21T01:15:00.000Z');
  });
  ok('节假日不请求，跨过整段假期', () => {
    const s = at('2026-10-01T02:00:00Z'); // 国庆 10:00
    assert.strictEqual(s.phase, 'holiday');
    assert.strictEqual(s.trading, false);
    assert.strictEqual(new Date(s.nextChangeAt).toISOString(), '2026-10-08T01:15:00.000Z');
  });
  ok('交易日判断', () => {
    assert.strictEqual(M.isTradingDay(new Date('2026-09-18T02:00:00Z')), true);  // 周五
    assert.strictEqual(M.isTradingDay(new Date('2026-09-19T02:00:00Z')), false); // 周六
    assert.strictEqual(M.isTradingDay(new Date('2026-10-01T02:00:00Z')), false); // 国庆
    assert.strictEqual(M.isTradingDay(new Date('2026-02-17T02:00:00Z')), false); // 春节
  });
  ok('北京时间解析与本机时区无关', () => {
    const p = M.beijingParts(new Date('2026-09-18T01:00:00Z'));
    assert.strictEqual(p.dateStr, '2026-09-18');
    assert.strictEqual(p.hour, 9);
    assert.strictEqual(p.weekday, 'Fri');
  });
  ok('时段有人话说明', () => {
    assert.strictEqual(M.describePhase('morning'), '交易中');
    assert.strictEqual(M.describePhase('lunch'), '午间休市');
    assert.strictEqual(M.describePhase('weekend'), '周末休市');
    assert.strictEqual(M.describePhase('holiday'), '节假日休市');
  });
  ok('调度决策 planTick：何时请求、何时睡觉', () => {
    const cfg = { marketHoursOnly: true, refreshIntervalSeconds: 3 };
    const plan = (iso, state) => M.planTick(cfg, new Date(iso), state || {});
    // 盘中按间隔请求
    assert.strictEqual(plan('2026-09-18T02:00:00Z').action, 'fetch');
    assert.strictEqual(plan('2026-09-18T02:00:00Z').delay, 3000);
    // 午休只睡不发
    assert.strictEqual(plan('2026-09-18T04:00:00Z').action, 'idle');
    // 收盘后补抓一次快照
    assert.strictEqual(plan('2026-09-18T07:10:00Z').action, 'snapshot');
    // 同一天已经抓过快照就不再抓
    assert.strictEqual(plan('2026-09-18T07:10:00Z', { closeSnapshotDay: '2026-09-18' }).action, 'idle');
    // 收盘后、周末都不请求
    assert.strictEqual(plan('2026-09-18T08:00:00Z').action, 'idle');
    assert.strictEqual(plan('2026-09-19T02:00:00Z').action, 'idle');
    // 睡多久不会超过 60 秒（便于设置变更后快速响应）
    assert.ok(plan('2026-09-19T02:00:00Z').delay <= 60000);
    // 手动关掉限制后，休市也照常请求
    const off = M.planTick({ marketHoursOnly: false, refreshIntervalSeconds: 5 }, new Date('2026-09-19T02:00:00Z'), {});
    assert.strictEqual(off.action, 'fetch');
    assert.strictEqual(off.delay, 5000);
  });

  console.log('[12] 版本比较与发布资源挑选');
  const V = require(path.join(__dirname, '..', 'src', 'common', 'version.js'));
  ok('版本解析', () => {
    assert.deepStrictEqual(V.parseVersion('v1.2.3'), { major: 1, minor: 2, patch: 3, pre: '' });
    assert.deepStrictEqual(V.parseVersion('1.2'), { major: 1, minor: 2, patch: 0, pre: '' });
    assert.strictEqual(V.parseVersion('abc'), null);
  });
  ok('比较与 isNewer', () => {
    assert.strictEqual(V.compareVersions('1.2.0', '1.1.9'), 1);
    assert.strictEqual(V.compareVersions('1.2.0', '1.2.0'), 0);
    assert.strictEqual(V.compareVersions('1.2.0', '1.10.0'), -1);
    assert.strictEqual(V.isNewer('1.2.0', '1.1.0'), true);
    assert.strictEqual(V.isNewer('1.1.0', '1.2.0'), false);
    assert.strictEqual(V.isNewer('v1.2.0', '1.2.0'), false);
    // 预发布小于同号正式版
    assert.strictEqual(V.isNewer('1.2.0', '1.2.0-beta.1'), true);
  });
  ok('从 Release 挑选下载资源（优先 portable）', () => {
    const rel = { assets: [
      { name: 'gongwei-1.2.0-setup-x64.exe', browser_download_url: 'u1', size: 1 },
      { name: 'gongwei-1.2.0-portable.exe', browser_download_url: 'u2', size: 2 },
    ] };
    assert.strictEqual(V.pickDownloadAsset(rel).name, 'gongwei-1.2.0-portable.exe');
    assert.strictEqual(V.pickDownloadAsset({ assets: [] }), null);
  });

  console.log('[13] 港股与东财板块');
  ok('新浪港股行：现价在 parts[6]（A 股是 parts[3]）', () => {
    // 港股：英文名,中文名,今开,昨收,最高,最低,现价,涨跌额,涨跌幅,...
    const p = P.parseSinaLine('var hq_str_hk00700="TENCENT,腾讯控股,423.000,418.400,424.400,415.400,418.000,-0.400,-0.096";');
    assert.strictEqual(p.latestPrice, 418, '现价应取 parts[6]；取 parts[3] 会把昨收当现价');
    assert.ok(Math.abs(p.changePercent - (-0.0957)) < 0.01);
  });
  ok('新浪 A 股行：仍然是 parts[3]=现价', () => {
    const p = P.parseSinaLine('var hq_str_sh600000="PF,7.79,7.80,7.85,7.90,7.78,0";');
    assert.ok(Math.abs(p.latestPrice - 7.85) < 1e-9);
  });
  ok('港股代码：5 位数字、3 位小数', () => {
    const t = (c) => { const k = P.classifyCode(c); return `${k.exchange}/${k.securityType}/${k.decimals}`; };
    assert.strictEqual(t('00700'), 'HKEX/stock/3');
    assert.strictEqual(t('09988'), 'HKEX/stock/3');
  });
  ok('板块代码：BK+4 位', () => {
    const t = (c) => { const k = P.classifyCode(c); return `${k.exchange}/${k.securityType}/${k.decimals}`; };
    assert.strictEqual(t('BK0475'), 'BOARD/board/2');
    assert.strictEqual(t('bk0475'), 'BOARD/board/2');
  });
  ok('东财 secid：板块 90.、港股 116.', () => {
    assert.strictEqual(P.eastmoneySecid({ code: 'BK0475', market: 'BOARD', exchange: 'BOARD' }), '90.BK0475');
    assert.strictEqual(P.eastmoneySecid({ code: '00700', market: 'HK', exchange: 'HKEX' }), '116.00700');
    assert.strictEqual(
      P.eastmoneySecid({ code: 'BK0475', market: 'BOARD', sourceIds: { eastmoney: '90.BK0475' } }),
      '90.BK0475',
    );
  });
  ok('东财 suggest：板块识别成 BOARD/board、港股识别成 HK', () => {
    const b = P.marketFromSuggest({ QuoteID: '90.BK0475', Classify: 'BK', Code: 'BK0475' });
    assert.strictEqual(b.market, 'BOARD');
    assert.strictEqual(b.exchange, 'BOARD');
    assert.strictEqual(P.typeFromSuggest({ Classify: 'BK', SecurityTypeName: '板块' }), 'board');
    assert.strictEqual(P.marketFromSuggest({ QuoteID: '116.00700', Classify: 'HK', Code: '00700' }).market, 'HK');
  });
  ok('纯代码直通：BK 板块 / 5 位港股', () => {
    const b = P.directCodeCandidate('BK0475');
    assert.strictEqual(b.market, 'BOARD');
    assert.strictEqual(b.securityType, 'board');
    const h = P.directCodeCandidate('00700');
    assert.strictEqual(h.market, 'HK');
    assert.strictEqual(h.exchange, 'HKEX');
  });
  await okAsync('新浪通道跳过板块（它没有 BK 标的）', async () => {
    const urls = [];
    global.fetch = async (url) => {
      urls.push(String(url));
      return { ok: true, status: 200, arrayBuffer: async () => Buffer.from('', 'latin1') };
    };
    const boards = [{ id: 'b1', code: 'BK0475', name: '银行Ⅱ', market: 'BOARD', exchange: 'BOARD' }];
    const rows = await P.fetchSina(boards);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].ok, false, '板块不该从新浪取到值');
    assert.ok(!urls.some((u) => /bk0475/i.test(u)), '不该为板块拼 symbol：' + urls.join(','));
  });

  console.log('[14] 港股交易时段');
  const hkAt = (iso) => M.sessionPhase(new Date(iso), 'HK');
  ok('港股 10:00 在交易', () => {
    assert.strictEqual(hkAt('2026-09-18T02:00:00Z').trading, true);
  });
  ok('港股 15:30 还在交易（A 股已经收市）', () => {
    const s = hkAt('2026-09-18T07:30:00Z');
    assert.strictEqual(s.trading, true);
    assert.strictEqual(s.phase, 'afternoon');
  });
  ok('港股 16:10 进收盘快照窗口', () => {
    const s = hkAt('2026-09-18T08:10:00Z');
    assert.strictEqual(s.snapshotDue, true);
    assert.strictEqual(s.phase, 'after-close');
  });
  ok('港股节假日休市', () => {
    assert.strictEqual(hkAt('2026-01-01T02:00:00Z').phase, 'holiday');
    assert.strictEqual(M.isTradingDay(new Date('2026-01-01T02:00:00Z'), 'HK'), false);
    assert.strictEqual(M.isTradingDay(new Date('2026-01-01T02:00:00Z'), 'CN'), false);
  });
  ok('调度：港股 15:30 继续请求（A 股已收）', () => {
    const cfg = { marketHoursOnly: true, refreshIntervalSeconds: 3 };
    assert.strictEqual(M.planTick(cfg, new Date('2026-09-18T07:30:00Z'), { hasHK: true }).action, 'fetch');
    assert.strictEqual(M.planTick(cfg, new Date('2026-09-18T07:30:00Z'), {}).action, 'idle', '没有港股自选就不开港股轨');
  });
  ok('调度：港股收盘快照单独记一次', () => {
    const cfg = { marketHoursOnly: true, refreshIntervalSeconds: 3 };
    const p1 = M.planTick(cfg, new Date('2026-09-18T08:10:00Z'), { hasHK: true });
    assert.strictEqual(p1.action, 'snapshot');
    assert.strictEqual(p1.market, 'HK');
    const p2 = M.planTick(cfg, new Date('2026-09-18T08:10:00Z'), { hasHK: true, hkCloseSnapshotDay: '2026-09-18' });
    assert.strictEqual(p2.action, 'idle', '同一天不重复抓');
  });

  console.log('[15] 美股');
  ok('smartbox 美股：剥掉交易所后缀并记住它', () => {
    const r = P.parseSmartbox('v_hint="us~aapl.oq~苹果~pg~GP"');
    assert.strictEqual(r[0].code, 'AAPL');
    assert.strictEqual(r[0].market, 'US');
    assert.strictEqual(r[0].usSuffix, 'OQ', '要记住交易所后缀，否则推不出东财 secid');
  });
  ok('东财 secid：美股按交易所映射市场号（100 是不存在的）', () => {
    assert.strictEqual(P.eastmoneySecid({ code: 'AAPL', market: 'US', usSuffix: 'OQ' }), '105.AAPL');
    assert.strictEqual(P.eastmoneySecid({ code: 'BABA', market: 'US', usSuffix: 'N' }), '106.BABA');
    assert.strictEqual(P.eastmoneySecid({ code: 'AMDC', market: 'US', usSuffix: 'AM' }), '107.AMDC');
    // 没有后缀时按纳斯达克兜底
    assert.strictEqual(P.eastmoneySecid({ code: 'AAPL', market: 'US' }), '105.AAPL');
    // 有 sourceIds 时优先用它（东财搜索来的最准）
    assert.strictEqual(
      P.eastmoneySecid({ code: 'BABA', market: 'US', usSuffix: 'OQ', sourceIds: { eastmoney: '106.BABA' } }),
      '106.BABA',
    );
  });
  ok('腾讯 / 新浪的美股代码格式', () => {
    assert.strictEqual(P.tencentSymbol({ code: 'AAPL', market: 'US', usSuffix: 'OQ' }), 'usAAPL.OQ');
    assert.strictEqual(P.tencentSymbol({ code: 'BABA', market: 'US', usSuffix: 'N' }), 'usBABA.N');
    // 新浪美股前缀是 gb_（不是 us_），且不带交易所后缀
    assert.strictEqual(P.sinaSymbol({ code: 'AAPL', market: 'US', usSuffix: 'OQ' }), 'gb_aapl');
  });
  ok('新浪美股行：现价在 parts[1]、涨跌幅在 parts[2]', () => {
    const p = P.parseSinaLine('var hq_str_gb_aapl="苹果,350.6900,2.43,2026-11-10 09:42:58,8.3200,344.9950";');
    assert.strictEqual(p.latestPrice, 350.69);
    assert.strictEqual(p.changePercent, 2.43);
    assert.strictEqual(p.changeAmount, 8.32);
  });
  ok('美股代码识别：字母代码、3 位小数', () => {
    const t = (c) => { const k = P.classifyCode(c); return `${k.exchange}/${k.securityType}/${k.decimals}`; };
    assert.strictEqual(t('AAPL'), 'OTHER_US/stock/3');
    assert.strictEqual(t('NVDA'), 'OTHER_US/stock/3');
  });
  ok('纯代码直通：美股字母代码', () => {
    const u = P.directCodeCandidate('AAPL');
    assert.strictEqual(u.market, 'US');
    assert.strictEqual(u.usSuffix, 'OQ');
  });
  ok('东财 suggest 的美股：QuoteID 反推交易所后缀', () => {
    const m = P.marketFromSuggest({ QuoteID: '106.BABA', Classify: 'UsStock', Code: 'BABA' });
    assert.strictEqual(m.market, 'US');
    assert.strictEqual(m.exchange, 'OTHER_US');
  });
  ok('场外美股（OTCBB）用 153 市场号', () => {
    // 腾讯 ADR TCTZF 在东财是 153.TCTZF，Classify=OTCBB
    const m = P.marketFromSuggest({ QuoteID: '153.TCTZF', Classify: 'OTCBB', Code: 'TCTZF' });
    assert.strictEqual(m.market, 'US');
    assert.strictEqual(P.eastmoneySecid({ code: 'TCTZF', market: 'US', usSuffix: 'PS' }), '153.TCTZF');
    // smartbox 的 .ps 后缀也对应 153
    const r = P.parseSmartbox('v_hint="us~tctzf.ps~腾讯控股~txkg~GP"');
    assert.strictEqual(r[0].usSuffix, 'PS');
    assert.strictEqual(P.eastmoneySecid(r[0]), '153.TCTZF');
  });
  await okAsync('美股市场号猜错时会自动换候选重试', async () => {
    const seen = [];
    global.fetch = async (url) => {
      const u = String(url);
      // 批量接口一次带全部候选 secid，只有有数据的那行会返回
      const m = u.match(/secids=([^&]*)/);
      const ids = m ? decodeURIComponent(m[1]).split(',') : [];
      ids.forEach((id) => seen.push(id));
      const diff = ids
        .filter((id) => id === '153.TCTZF')
        .map((id) => ({ f13: 153, f12: 'TCTZF', f14: '腾讯控股', f2: 52.674, f3: -0.85, f4: -0.452, f18: 53.126 }));
      return { ok: true, status: 200, json: async () => ({ data: { diff } }) };
    };
    const [row] = await P.fetchEastmoney([{ id: 'x', code: 'TCTZF', name: '腾讯控股', market: 'US', exchange: 'OTHER_US' }]);
    assert.strictEqual(row.ok, true, '应该换候选后取到数据');
    assert.strictEqual(row.latestPrice, 52.674);
    assert.ok(seen.includes('105.TCTZF') && seen.includes('153.TCTZF'), '应一次带全部候选：' + seen.join(','));
    global.fetch = realFetch;
  });

  console.log('[16] 美股交易时段（夏令时 + 节假日）');
  const usAt = (iso) => M.usSessionPhase(new Date(iso));
  const usParts = (iso) => M.beijingParts(new Date(iso));
  ok('夏令时区间：3 月第二个周日 15:00 进、11 月第一个周日 14:00 出（北京时间）', () => {
    assert.strictEqual(M.isUsDst(usParts('2026-03-08T06:59:00Z')), false, '切换前 15:00 还是冬令时');
    assert.strictEqual(M.isUsDst(usParts('2026-03-08T07:00:00Z')), true, '15:00 起进入夏令时');
    assert.strictEqual(M.isUsDst(usParts('2026-11-01T05:59:00Z')), true, '切换前 14:00 还是夏令时');
    assert.strictEqual(M.isUsDst(usParts('2026-11-01T06:00:00Z')), false, '14:00 起退出夏令时');
    assert.strictEqual(M.isUsDst(usParts('2026-06-15T06:00:00Z')), true, '6 月是夏令时');
    assert.strictEqual(M.isUsDst(usParts('2026-12-15T06:00:00Z')), false, '12 月是冬令时');
  });
  ok('夏令时时段：21:30-次日 04:00', () => {
    // 2026-06-15 是周一，夏令时 → 北京 21:30 开盘
    assert.strictEqual(usAt('2026-06-15T13:00:00Z').trading, false, '21:00 还没开盘');
    assert.strictEqual(usAt('2026-06-15T13:30:00Z').trading, true, '21:30 开盘');
    assert.strictEqual(usAt('2026-06-15T13:30:00Z').phase, 'us-trading');
    assert.strictEqual(usAt('2026-06-15T18:00:00Z').trading, true, '次日凌晨 02:00 还在交易');
    assert.strictEqual(usAt('2026-06-15T20:00:00Z').trading, false, '04:00 收盘');
  });
  ok('冬令时时段：22:30-次日 05:00', () => {
    // 2026-12-15 是周二，冬令时
    assert.strictEqual(usAt('2026-12-15T13:30:00Z').trading, false, '21:30 还没开盘（冬令时 22:30 才开）');
    assert.strictEqual(usAt('2026-12-15T14:30:00Z').trading, true, '22:30 开盘');
    assert.strictEqual(usAt('2026-12-15T20:30:00Z').trading, true, '次日凌晨 04:30 还在交易');
    assert.strictEqual(usAt('2026-12-15T21:00:00Z').trading, false, '05:00 收盘');
  });
  ok('凌晨那段归属前一天：周六凌晨是美东周五下午，仍在交易', () => {
    // 2026-06-13 是周六，北京时间凌晨 01:00 = 美东周五 13:00 → 应该还在交易
    const s = usAt('2026-06-12T17:00:00Z');
    assert.strictEqual(s.trading, true, '周六凌晨仍是周五的盘');
    assert.strictEqual(s.day, '2026-06-12', '交易日归属周五（开始那天）');
    // 周六晚上就是周末了
    assert.strictEqual(usAt('2026-06-13T14:00:00Z').trading, false, '周六晚上不开盘');
  });
  ok('收盘后有快照窗口', () => {
    const s = usAt('2026-06-15T20:10:00Z'); // 04:10 北京时间
    assert.strictEqual(s.snapshotDue, true);
    assert.strictEqual(s.phase, 'us-after-close');
    assert.strictEqual(s.day, '2026-06-15');
  });
  ok('美股节假日休市（规则算出来的，不用维护表）', () => {
    assert.strictEqual(M.isUsTradingDay('2026-12-25'), false, '圣诞节');
    assert.strictEqual(M.isUsTradingDay('2026-07-03'), false, '独立日落在周六，提前到周五');
    assert.strictEqual(M.isUsTradingDay('2026-11-26'), false, '感恩节');
    assert.strictEqual(M.isUsTradingDay('2026-05-25'), false, '阵亡将士纪念日');
    assert.strictEqual(M.isUsTradingDay('2026-04-03'), false, '耶稣受难日');
    assert.strictEqual(M.isUsTradingDay('2026-01-19'), false, '马丁路德金纪念日');
    assert.strictEqual(M.isUsTradingDay('2026-06-15'), true, '普通交易日');
  });
  ok('美股的休市状态细分周末/节假日（界面上要能区分，不能和正常休市混为一谈）', () => {
    // 周六晚上（美东周五收盘后）
    assert.strictEqual(usAt('2026-06-13T14:00:00Z').phase, 'weekend', '周六晚上是周末休市');
    // 周一凌晨（美东周日）
    assert.strictEqual(usAt('2026-06-14T17:00:00Z').phase, 'weekend', '周一凌晨对应美东周日');
    // 圣诞节
    assert.strictEqual(usAt('2026-12-25T14:30:00Z').phase, 'holiday', '圣诞节是节假日休市');
    // 文案带上市场名，界面上才说得清是谁在休市
    assert.strictEqual(M.describePhase('weekend', 'US'), '美股周末休市');
    assert.strictEqual(M.describePhase('holiday', 'HK'), '港股节假日休市');
    assert.strictEqual(M.describePhase('weekend'), '周末休市');
  });
  ok('调度：美股盘中继续请求（A 股已收）', () => {
    const cfg = { marketHoursOnly: true, refreshIntervalSeconds: 3 };
    assert.strictEqual(M.planTick(cfg, new Date('2026-06-15T18:00:00Z'), { hasUS: true }).action, 'fetch');
    assert.strictEqual(M.planTick(cfg, new Date('2026-06-15T18:00:00Z'), {}).action, 'idle', '没有美股自选就不开美股轨');
    const snap = M.planTick(cfg, new Date('2026-06-15T20:10:00Z'), { hasUS: true });
    assert.strictEqual(snap.action, 'snapshot');
    assert.strictEqual(snap.market, 'US');
    assert.strictEqual(
      M.planTick(cfg, new Date('2026-06-15T20:10:00Z'), { hasUS: true, usCloseSnapshotDay: '2026-06-15' }).action,
      'idle', '同一天不重复抓',
    );
  });

  console.log(`\nproviders: 共 ${passed} 项，${process.exitCode ? '有失败' : '全部通过'}`);
})();
