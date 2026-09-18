// 工位看盘 - A 股交易时段与交易日判断（纯函数，方便单测）
//
// 目的：收盘、午休、周末、节假日别再无脑打接口，省流量也不给行情站添乱；
// 但必须保证「收盘后仍能拿到当天最后一条数据」，所以 15:00 后留一个快照窗口。
//
// 时间一律按北京时间算，跟用户本机时区无关。

const CN_HOLIDAYS = new Set([
  // 2025 年 A 股休市日（元旦/春节/清明/劳动/端午/国庆中秋）
  '2025-01-01',
  '2025-01-28', '2025-01-29', '2025-01-30', '2025-01-31', '2025-02-03', '2025-02-04',
  '2025-04-04', '2025-04-07',
  '2025-05-01', '2025-05-02', '2025-05-05',
  '2025-06-02',
  '2025-10-01', '2025-10-02', '2025-10-03', '2025-10-06', '2025-10-07', '2025-10-08',
  // 2026 年（国务院放假安排公布后如有调整，按实际替换；多列几天只会少发几个请求，不影响正确性）
  '2026-01-01', '2026-01-02',
  '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20',
  '2026-04-06',
  '2026-05-01', '2026-05-04', '2026-05-05',
  '2026-06-19',
  '2026-09-25',
  '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07',
]);

// 交易时段（分钟数，自 0 点起）
const T = {
  AUCTION_START: 9 * 60 + 15,  // 09:15 开盘集合竞价
  MORNING_START: 9 * 60 + 30,  // 09:30 连续竞价
  MORNING_END: 11 * 60 + 30,   // 11:30 上午收市
  AFTERNOON_START: 13 * 60,    // 13:00 下午开盘
  CLOSE: 15 * 60,              // 15:00 收盘
  SNAPSHOT_END: 15 * 60 + 30,  // 15:30 之前补一次收盘快照
};

const WEEKEND = new Set(['Sat', 'Sun']);

// 取北京时间的年月日时分秒与星期
function beijingParts(date) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    weekday: 'short', hour12: false,
  });
  const p = {};
  for (const { type, value } of fmt.formatToParts(date)) p[type] = value;
  const hour = Number(p.hour) % 24; // 某些实现午夜会给 24
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour,
    minute: Number(p.minute),
    second: Number(p.second),
    weekday: p.weekday,
    dateStr: `${p.year}-${p.month}-${p.day}`,
    minutes: hour * 60 + Number(p.minute),
  };
}

// 把北京时间的某个墙上时刻换成 UTC 毫秒（中国无夏令时，直接减 8 小时）
function beijingTimeToUtcMs(year, month, day, hour, minute) {
  return Date.UTC(year, month - 1, day, hour - 8, minute, 0, 0);
}

function isWeekend(parts) {
  return WEEKEND.has(parts.weekday);
}

function isHoliday(parts) {
  return CN_HOLIDAYS.has(parts.dateStr);
}

function isTradingDay(date) {
  const p = beijingParts(date);
  return !isWeekend(p) && !isHoliday(p);
}

// 找下一个交易日的开盘时刻（含当天之后）
function nextTradingDayOpenMs(from) {
  for (let i = 0; i <= 30; i += 1) {
    const probe = new Date(from.getTime() + i * 86400000);
    const p = beijingParts(probe);
    if (isWeekend(p) || isHoliday(p)) continue;
    const openMs = beijingTimeToUtcMs(p.year, p.month, p.day, Math.floor(T.AUCTION_START / 60), T.AUCTION_START % 60);
    if (openMs > from.getTime()) return openMs;
  }
  return from.getTime() + 86400000; // 兜底：一天后
}

// 当天的某个分钟数对应的 UTC 毫秒
function todayAtMs(parts, minutes) {
  return beijingTimeToUtcMs(parts.year, parts.month, parts.day, Math.floor(minutes / 60), minutes % 60);
}

// 核心：当前处于什么阶段、要不要请求、下一次状态变化在什么时候
// 返回 { trading, snapshotDue, phase, day, nextChangeAt }
function sessionPhase(date = new Date()) {
  const p = beijingParts(date);
  const day = p.dateStr;
  const base = { day, trading: false, snapshotDue: false, phase: 'closed', nextChangeAt: 0 };

  if (!isTradingDay(date)) {
    base.phase = isWeekend(p) ? 'weekend' : 'holiday';
    base.nextChangeAt = nextTradingDayOpenMs(date);
    return base;
  }

  const m = p.minutes;
  if (m < T.AUCTION_START) {
    base.phase = 'before-open';
    base.nextChangeAt = todayAtMs(p, T.AUCTION_START);
    return base;
  }
  if (m < T.MORNING_END) {
    base.trading = true;
    base.phase = m < T.MORNING_START ? 'auction' : 'morning';
    base.nextChangeAt = todayAtMs(p, T.MORNING_END);
    return base;
  }
  if (m < T.AFTERNOON_START) {
    base.phase = 'lunch';
    base.nextChangeAt = todayAtMs(p, T.AFTERNOON_START);
    return base;
  }
  if (m < T.CLOSE) {
    base.trading = true;
    base.phase = 'afternoon';
    base.nextChangeAt = todayAtMs(p, T.CLOSE);
    return base;
  }
  if (m < T.SNAPSHOT_END) {
    // 收盘后的快照窗口：抓一次当天最终数据
    base.phase = 'after-close';
    base.snapshotDue = true;
    base.nextChangeAt = todayAtMs(p, T.SNAPSHOT_END);
    return base;
  }
  base.phase = 'closed';
  base.nextChangeAt = nextTradingDayOpenMs(date);
  return base;
}

// 给界面用的人话说明
function describePhase(phase) {
  return {
    auction: '集合竞价',
    morning: '交易中',
    lunch: '午间休市',
    afternoon: '交易中',
    'after-close': '已收盘',
    closed: '已收盘',
    weekend: '周末休市',
    holiday: '节假日休市',
    'before-open': '未开盘',
  }[phase] || '';
}

// 这次 tick 该干什么（抽成纯函数，主进程只负责执行，逻辑本身可单测）
// 返回 { action: 'fetch' | 'snapshot' | 'idle', reason, delay, info? }
//   fetch    : 正常请求行情
//   snapshot : 收盘后补抓一次当天最终价
//   idle     : 什么都不做，按 delay 睡到下一个状态变化
function planTick(cfg, now, state = {}) {
  const refreshMs = Math.max(2, Number((cfg && cfg.refreshIntervalSeconds) || 3) || 3) * 1000;

  if (cfg && cfg.marketHoursOnly === false) {
    return { action: 'fetch', reason: 'always', delay: refreshMs };
  }
  const info = sessionPhase(now);
  if (info.trading) {
    return { action: 'fetch', reason: info.phase, delay: refreshMs, info };
  }
  if (info.snapshotDue && state.closeSnapshotDay !== info.day) {
    return { action: 'snapshot', reason: 'after-close', delay: 5000, info };
  }
  const wait = Math.max(200, Math.min(info.nextChangeAt - now.getTime(), 60000));
  return { action: 'idle', reason: info.phase, delay: wait, info };
}

module.exports = {
  CN_HOLIDAYS, T, beijingParts, beijingTimeToUtcMs, isWeekend, isHoliday, isTradingDay,
  nextTradingDayOpenMs, sessionPhase, describePhase, planTick,
};
