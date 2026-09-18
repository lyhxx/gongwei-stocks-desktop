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

  console.log('[10] 浮窗贴边吸附几何');
  const F = require(path.join(__dirname, '..', 'src', 'common', 'floatLayout.js'));
  const WA = { x: 0, y: 0, width: 1920, height: 1040 };
  ok('判定最近的边', () => {
    assert.strictEqual(F.nearestEdge({ x: 3, y: 500, width: 250, height: 400 }, WA, 20), 'left');
    assert.strictEqual(F.nearestEdge({ x: 1670, y: 300, width: 250, height: 400 }, WA, 20), 'right');
    assert.strictEqual(F.nearestEdge({ x: 800, y: 2, width: 250, height: 400 }, WA, 20), 'top');
    assert.strictEqual(F.nearestEdge({ x: 800, y: 638, width: 250, height: 400 }, WA, 20), 'bottom');
  });
  ok('超出阈值视为不贴边', () => {
    assert.strictEqual(F.nearestEdge({ x: 800, y: 300, width: 250, height: 400 }, WA, 20), null);
    assert.strictEqual(F.nearestEdge({ x: 40, y: 300, width: 250, height: 400 }, WA, 20), null);
  });
  ok('贴边位置对齐且不越界', () => {
    assert.deepStrictEqual(F.snapToEdge({ x: 1660, y: 500, width: 250, height: 400 }, WA, 'right'), { x: 1670, y: 500 });
    assert.deepStrictEqual(F.snapToEdge({ x: 12, y: 500, width: 250, height: 400 }, WA, 'left'), { x: 0, y: 500 });
    // 垂直方向超出时被夹回可用区域
    assert.deepStrictEqual(F.snapToEdge({ x: 12, y: 900, width: 250, height: 400 }, WA, 'left'), { x: 0, y: 640 });
  });
  ok('小球位置：水平贴边、垂直夹紧', () => {
    assert.deepStrictEqual(F.collapsedBounds(WA, 'right', 46, 500), { x: 1874, y: 500 });
    assert.deepStrictEqual(F.collapsedBounds(WA, 'left', 46, 500), { x: 0, y: 500 });
    assert.deepStrictEqual(F.collapsedBounds(WA, 'left', 46, 9999), { x: 0, y: 994 });
    assert.deepStrictEqual(F.collapsedBounds(WA, 'left', 46, -50), { x: 0, y: 0 });
  });
  ok('只有左右两侧能收成小球', () => {
    assert.strictEqual(F.canCollapse('left'), true);
    assert.strictEqual(F.canCollapse('right'), true);
    assert.strictEqual(F.canCollapse('top'), false);
    assert.strictEqual(F.canCollapse(null), false);
  });

  console.log('[11] 版本比较与更新资产挑选');
  const V = require(path.join(__dirname, '..', 'src', 'common', 'version.js'));
  ok('版本比较', () => {
    assert.strictEqual(V.compareVersions('1.0.1', '1.0.0'), 1);
    assert.strictEqual(V.compareVersions('1.0.0', '1.0.0'), 0);
    assert.strictEqual(V.compareVersions('v1.2.0', '1.10.0'), -1, '按数字比而不是字符串');
    assert.strictEqual(V.compareVersions('2.0.0', '1.9.9'), 1);
    assert.strictEqual(V.compareVersions('1.0', '1.0.0'), 0);
    assert.strictEqual(V.compareVersions('1.0.0-beta.1', '1.0.0'), -1, '预发布小于正式版');
    assert.strictEqual(V.compareVersions('1.0.0-beta.2', '1.0.0-beta.1'), 1);
  });
  ok('脏版本号不炸', () => {
    assert.strictEqual(V.compareVersions('bad', '1.0.0'), -1);
    assert.strictEqual(V.compareVersions('1.0.0', 'bad'), 1);
    assert.strictEqual(V.compareVersions(null, undefined), 0);
  });
  ok('isNewer', () => {
    assert.strictEqual(V.isNewer('1.0.1', '1.0.0'), true);
    assert.strictEqual(V.isNewer('1.0.0', '1.0.0'), false);
    assert.strictEqual(V.isNewer('0.9.9', '1.0.0'), false);
  });
  ok('挑下载资产优先绿色单文件', () => {
    const release = {
      assets: [
        { name: 'gongwei-stocks-desktop-1.1.0-setup-x64.exe', browser_download_url: 'https://github.com/a/setup', size: 1 },
        { name: 'gongwei-stocks-desktop-1.1.0-portable.exe', browser_download_url: 'https://github.com/a/portable', size: 2 },
      ],
    };
    assert.strictEqual(V.pickDownloadAsset(release).url, 'https://github.com/a/portable');
    assert.strictEqual(V.pickDownloadAsset({ assets: [] }), null);
    assert.strictEqual(V.pickDownloadAsset({}), null);
  });

  console.log('[12] 自选排序');
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

  console.log(`\nproviders: 共 ${passed} 项，${process.exitCode ? '有失败' : '全部通过'}`);
})();
