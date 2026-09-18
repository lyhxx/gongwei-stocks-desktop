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

  console.log('[6] 联调：三通道分别取数 + 合并（mock fetch）');
  const realFetch = global.fetch;
  await okAsync('东财补 A、腾讯补 B，新浪挂掉不影响整体', async () => {
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes('push2')) {
        const secid = (u.match(/secid=([^&]*)/) || [])[1] || '';
        if (secid.includes('600000')) {
          return { ok: true, status: 200, json: async () => ({ data: { f43: 785, f60: 780, f169: 5, f170: 64, f58: '浦发银行', f59: 2 } }) };
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
    // 主进程就是「三通道并行 + mergeQuoteRows 按只合并」，这里用同一套纯函数复现
    const settled = await Promise.allSettled([
      P.fetchEastmoney(stocks), P.fetchSina(stocks), P.fetchTencent(stocks),
    ]);
    assert.strictEqual(settled[1].status, 'rejected', '新浪应失败');
    const groups = settled.map((s) => (s.status === 'fulfilled' ? s.value : []));
    const { rows, source } = P.mergeQuoteRows(stocks, groups);
    assert.strictEqual(rows.length, 2);
    assert.ok(rows.every((r) => r.ok), '两只都应有值');
    assert.ok(source.includes('eastmoney') && source.includes('tencent'), '来源应合并：' + source);
  });
  await okAsync('全部通道挂掉：合并后 ok=false、来源 none', async () => {
    global.fetch = async () => { throw new Error('net down'); };
    const stocks = [{ id: 'a', code: '600000', name: 'X', market: 'CN', exchange: 'SH' }];
    const settled = await Promise.allSettled([
      P.fetchEastmoney(stocks), P.fetchSina(stocks), P.fetchTencent(stocks),
    ]);
    const groups = settled.map((s) => (s.status === 'fulfilled' ? s.value : []));
    const { rows, source } = P.mergeQuoteRows(stocks, groups);
    assert.strictEqual(source, 'none');
    assert.strictEqual(rows[0].ok, false);
  });
  await okAsync('东财缺 f59 时用 f152 定精度', async () => {
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: { f43: 7850, f60: 7800, f169: 50, f170: 64, f58: 'X', f152: 3 } }) });
    const [row] = await P.fetchEastmoney([{ id: 'a', code: '600000', name: 'X', market: 'CN', exchange: 'SH' }]);
    assert.strictEqual(row.latestPrice, 7.85, '应按 f152=3 除以 1000');
    assert.strictEqual(row.decimals, 3);
  });
  await okAsync('f59/f152 都缺时按 A 股默认除以 100（空值不能被当成 0 位小数）', async () => {
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: { f43: 785, f60: 780, f169: 5, f170: 64, f58: 'X' } }) });
    const [row] = await P.fetchEastmoney([{ id: 'a', code: '600000', name: 'X', market: 'CN', exchange: 'SH' }]);
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
  ok('ETF / LOF 区分', () => {
    assert.strictEqual(P.fundKind('510300'), 'ETF');
    assert.strictEqual(P.fundKind('159915'), 'ETF');
    assert.strictEqual(P.fundKind('161725'), 'LOF');
    assert.strictEqual(P.fundKind('501050'), 'LOF');
  });
  ok('品种标签', () => {
    assert.strictEqual(P.securityTypeLabel({ code: '510300', securityType: 'fund' }), 'ETF');
    assert.strictEqual(P.securityTypeLabel({ code: '161725', securityType: 'fund' }), 'LOF');
    assert.strictEqual(P.securityTypeLabel({ code: '113050', securityType: 'bond' }), '债');
    assert.strictEqual(P.securityTypeLabel({ code: '600000', securityType: 'stock' }), '');
    assert.strictEqual(P.securityTypeLabel({ code: '00700', securityType: 'stock', market: 'HK' }), '港');
    assert.strictEqual(P.securityTypeLabel({ code: 'AAPL', securityType: 'stock', market: 'US' }), '美');
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

  console.log(`\nproviders: 共 ${passed} 项，${process.exitCode ? '有失败' : '全部通过'}`);
})();
