// 工位看盘 - 默认数据与内置指数
// 存储键由 electron-store 管理，文件为 %APPDATA%\工位看盘\gongwei-stocks.json

const INDICES = [
  { id: 'shanghai', name: '上证指数', code: '000001', market: 'CN', exchange: 'SH' },
  { id: 'shenzhen', name: '深证成指', code: '399001', market: 'CN', exchange: 'SZ' },
  { id: 'chinext', name: '创业板指', code: '399006', market: 'CN', exchange: 'SZ' },
  { id: 'csi300', name: '沪深300', code: '000300', market: 'CN', exchange: 'SH' },
  { id: 'csi500', name: '中证500', code: '000905', market: 'CN', exchange: 'SH' },
  { id: 'csi1000', name: '中证1000', code: '000852', market: 'CN', exchange: 'SH' },
  { id: 'csi2000', name: '中证2000', code: '932000', market: 'CN', exchange: 'SH' },
  { id: 'sse50', name: '上证50', code: '000016', market: 'CN', exchange: 'SH' },
  { id: 'szse50', name: '深证50', code: '399850', market: 'CN', exchange: 'SZ' },
  { id: 'bse50', name: '北证50', code: '899050', market: 'CN', exchange: 'BJ' },
  { id: 'star50', name: '科创50', code: '000688', market: 'CN', exchange: 'SH' },
  { id: 'star100', name: '科创100', code: '000698', market: 'CN', exchange: 'SH' },
  { id: 'starcomposite', name: '科创综指', code: '000680', market: 'CN', exchange: 'SH' },
  { id: 'chinext50', name: '创业板50', code: '399673', market: 'CN', exchange: 'SZ' },
];

function defaultSettings() {
  return {
    schemaVersion: 1,
    main: {
      theme: 'system',
      refreshIntervalSeconds: 3,
      // 只在 A 股交易时段请求：收盘/午休/周末/节假日不打接口，收盘后补一次快照
      marketHoursOnly: true,
      colors: { up: '#d92d20', down: '#079455' },
    },
    alerts: {
      badgeEnabled: true,
      channels: ['sound', 'notify'],
      requireInteraction: false,
      mergeSameStock: true,
    },
    indices: {
      floatingVisible: true,
      selected: ['shanghai', 'shenzhen', 'chinext', 'sse50'],
    },
    floating: {
      enabled: true,
      opacity: 88,
      width: 250,
      position: 'bottom-right',
      hotkey: 'Ctrl+Shift+M',
      escapeToHideEnabled: true,
    },
    network: {
      // system=跟随系统代理（默认，能自动吃到代理软件/PAC）；direct=直连；manual=手动填地址
      proxyMode: 'system',
      proxyUrl: '',
    },
    update: {
      autoCheck: true,
      lastCheckAt: 0,
    },
  };
}

function defaultState() {
  return {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    groups: [{ id: 'default', name: '默认分组' }],
    stocks: [],
    settings: defaultSettings(),
  };
}

module.exports = { INDICES, defaultSettings, defaultState };
