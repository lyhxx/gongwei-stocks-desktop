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

// 港股公众假期。
// 这张表需要逐年维护，而且宁可漏列也不要瞎填：
// - 漏列一个假期 → 假期里照发请求，数据不变，只是多几个包（无害）；
// - 误填一个交易日 → 那一整天都不请求，会真的漏掉当天数据（有害)。
// 所以只写把握大的日子，其余宁可放过。
const HK_HOLIDAYS = new Set([
  // 2025 年
  '2025-01-01',
  '2025-01-28', '2025-01-29', '2025-01-30', '2025-01-31',
  '2025-04-07',            // 清明节（4/5、4/6 是周末）
  '2025-04-18',            // 受难节
  '2025-04-21',            // 复活节星期一
  '2025-05-01',
  '2025-07-01',
  '2025-10-01', '2025-10-07',
  '2025-12-25', '2025-12-26',
  // 2026 年
  '2026-01-01',
  '2026-02-17', '2026-02-18', '2026-02-19',   // 农历年初一至初三
  '2026-04-03',            // 受难节
  '2026-04-06',            // 复活节星期一
  '2026-04-07',            // 清明节（4/5 是周日）
  '2026-05-01',
  '2026-06-19',            // 端午节
  '2026-07-01',
  '2026-09-26',            // 中秋节翌日
  '2026-10-01',
  '2026-12-25',            // 圣诞节（周五）
  '2026-12-28',            // 圣诞节后第一个平日（周六顺延到周一）
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

// 港股时段：09:30-12:00 / 13:00-16:00（比 A 股晚收一小时）
// 09:00-09:30 是「开市前时段」，只接受申报不撮合，现价不动，所以不抓。
const HK_T = {
  AUCTION_START: 9 * 60 + 30,  // 09:30 开始连续竞价
  MORNING_START: 9 * 60 + 30,
  MORNING_END: 12 * 60,         // 12:00 上午收市
  AFTERNOON_START: 13 * 60,     // 13:00 下午开盘
  CLOSE: 16 * 60,               // 16:00 收盘
  SNAPSHOT_END: 16 * 60 + 30,   // 16:30 之前补一次收盘快照
};

// ---------- 美股时段 ----------
// 美股 09:30-16:00 ET，换成北京时间要跟着夏令时走：
//   夏令时 EDT(UTC-4) → 21:30 – 次日 04:00
//   冬令时 EST(UTC-5) → 22:30 – 次日 05:00
// 夏令时切换规则（2007 年后）：3 月第二个周日 02:00 开始，11 月第一个周日 02:00 结束。
// 换算成北京时间：3 月第二个周日 15:00 开始，11 月第一个周日 14:00 结束。
//
// 「美股交易日」= 那一晚开盘到次日凌晨收盘的那一段，按**开始那天**算。
// 于是北京时间周六凌晨（美东周五下午）仍在交易，周六晚上开始就是周末了。
const US_DST_START_MIN = 15 * 60;   // 北京时间 15:00 (= 美东 02:00 EST)
const US_DST_END_MIN = 14 * 60;     // 北京时间 14:00 (= 美东 02:00 EDT)

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

function isHoliday(parts, market = 'CN') {
  return (market === 'HK' ? HK_HOLIDAYS : CN_HOLIDAYS).has(parts.dateStr);
}

function isTradingDay(date, market = 'CN') {
  const p = beijingParts(date);
  return !isWeekend(p) && !isHoliday(p, market);
}

// 找下一个交易日的开盘时刻（含当天之后）
function nextTradingDayOpenMs(from, market = 'CN') {
  const TT = market === 'HK' ? HK_T : T;
  for (let i = 0; i <= 30; i += 1) {
    const probe = new Date(from.getTime() + i * 86400000);
    const p = beijingParts(probe);
    if (isWeekend(p) || isHoliday(p, market)) continue;
    const openMs = beijingTimeToUtcMs(p.year, p.month, p.day, Math.floor(TT.AUCTION_START / 60), TT.AUCTION_START % 60);
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
// market: 'CN'（默认，A股）| 'HK'（港股，时段不同）
function sessionPhase(date = new Date(), market = 'CN') {
  const p = beijingParts(date);
  const day = p.dateStr;
  const isHK = market === 'HK';
  const TT = isHK ? HK_T : T;
  const base = { day, trading: false, snapshotDue: false, phase: 'closed', nextChangeAt: 0, market };

  if (isWeekend(p) || isHoliday(p, market)) {
    base.phase = isWeekend(p) ? 'weekend' : 'holiday';
    base.nextChangeAt = nextTradingDayOpenMs(date, market);
    return base;
  }

  const m = p.minutes;
  if (m < TT.AUCTION_START) {
    base.phase = 'before-open';
    base.nextChangeAt = todayAtMs(p, TT.AUCTION_START);
    return base;
  }
  if (m < TT.MORNING_END) {
    base.trading = true;
    base.phase = m < TT.MORNING_START ? 'auction' : 'morning';
    base.nextChangeAt = todayAtMs(p, TT.MORNING_END);
    return base;
  }
  if (m < TT.AFTERNOON_START) {
    base.phase = 'lunch';
    base.nextChangeAt = todayAtMs(p, TT.AFTERNOON_START);
    return base;
  }
  if (m < TT.CLOSE) {
    base.trading = true;
    base.phase = 'afternoon';
    base.nextChangeAt = todayAtMs(p, TT.CLOSE);
    return base;
  }
  if (m < TT.SNAPSHOT_END) {
    // 收盘后的快照窗口：抓一次当天最终数据
    base.phase = 'after-close';
    base.snapshotDue = true;
    base.nextChangeAt = todayAtMs(p, TT.SNAPSHOT_END);
    return base;
  }
  base.phase = 'closed';
  base.nextChangeAt = nextTradingDayOpenMs(date, market);
  return base;
}

// 给界面用的人话说明
function describePhase(phase, market = 'CN') {
  const weekend = market === 'US' ? '美股周末休市' : (market === 'HK' ? '港股周末休市' : '周末休市');
  const holiday = market === 'US' ? '美股节假日休市' : (market === 'HK' ? '港股节假日休市' : '节假日休市');
  return {
    auction: market === 'HK' ? '开市前时段' : '集合竞价',
    morning: '交易中',
    lunch: '午间休市',
    afternoon: '交易中',
    'after-close': '已收盘',
    closed: '已收盘',
    weekend,
    holiday,
    'before-open': '未开盘',
    'us-trading': '美股交易中',
    'us-after-close': '美股已收盘',
  }[phase] || '';
}

// ---------- 美股：夏令时 / 节假日 / 时段 ----------

// 某年某月第 n 个星期几，返回 'YYYY-MM-DD'（用 UTC 算，避免受本机时区影响）
function nthWeekday(year, month, nth, weekday) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const firstDow = first.getUTCDay();
  const day = 1 + ((weekday - firstDow + 7) % 7) + (nth - 1) * 7;
  const dt = new Date(Date.UTC(year, month - 1, day));
  return `${year}-${String(month).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}
// 某年某月最后一个星期几
function lastWeekday(year, month, weekday) {
  const last = new Date(Date.UTC(year, month, 0));
  const lastDow = last.getUTCDay();
  const day = last.getUTCDate() - ((lastDow - weekday + 7) % 7);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// 日期串加减天数
function shiftDateStr(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

// 复活节（公历）用的经典算法，Good Friday = 复活节前两天
function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// 周末的固定节日要顺延：周六提前到周五，周日顺延到周一
function observedDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (dow === 6) return shiftDateStr(dateStr, -1);
  if (dow === 0) return shiftDateStr(dateStr, 1);
  return dateStr;
}

// 美股休市日：规则能算的都算出来，不用年年维护表
function usHolidaySet(year) {
  return new Set([
    observedDate(`${year}-01-01`),                                  // 元旦
    nthWeekday(year, 1, 3, 1),                                     // 马丁路德金纪念日
    nthWeekday(year, 2, 3, 1),                                     // 华盛顿诞辰
    shiftDateStr(easterSunday(year), -2),                          // 耶稣受难日
    lastWeekday(year, 5, 1),                                       // 阵亡将士纪念日
    observedDate(`${year}-06-19`),                                 // 六月节
    observedDate(`${year}-07-04`),                                 // 独立日
    nthWeekday(year, 9, 1, 1),                                     // 劳动节
    nthWeekday(year, 11, 4, 4),                                    // 感恩节
    observedDate(`${year}-12-25`),                                 // 圣诞节
  ]);
}

// 美股是不是夏令时（EDT）。判断用北京时间：
// 3 月第二个周日 15:00 起进入夏令时，11 月第一个周日 14:00 起退出。
function isUsDst(p) {
  const marSun = nthWeekday(p.year, 3, 2, 0);
  const novSun = nthWeekday(p.year, 11, 1, 0);
  const d = p.dateStr;
  const m = p.minutes;
  if (d < marSun) return false;
  if (d > novSun) return false;
  if (d === marSun) return m >= US_DST_START_MIN;
  if (d === novSun) return m < US_DST_END_MIN;
  return true;
}

// 某个美股交易日（按开始那天算）是否开市；不开的话给出原因
function usTradingDayReason(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (dow === 0 || dow === 6) return 'weekend';
  if (usHolidaySet(y).has(dateStr)) return 'holiday';
  return '';
}

function isUsTradingDay(dateStr) {
  return !usTradingDayReason(dateStr);
}

// 下一个美股开盘时刻（北京时间当天的晚上）
function nextUsOpenMs(from) {
  for (let i = 0; i <= 15; i += 1) {
    const probe = new Date(from.getTime() + i * 86400000);
    const p = beijingParts(probe);
    if (!isUsTradingDay(p.dateStr)) continue;
    const dst = isUsDst(p);
    const open = dst ? 21 * 60 + 30 : 22 * 60 + 30;
    const openMs = beijingTimeToUtcMs(p.year, p.month, p.day, Math.floor(open / 60), open % 60);
    if (openMs > from.getTime()) return openMs;
  }
  return from.getTime() + 86400000;
}

// 美股时段状态。
// 关键：一个「美股交易日」横跨北京时间的两个日历日（当晚开盘 → 次日凌晨收盘），
// 所以凌晨那段要归属到前一天那个交易日；否则周六凌晨（美东周五下午）会被误判成休市。
function usSessionPhase(date = new Date()) {
  const p = beijingParts(date);
  const dst = isUsDst(p);
  const open = dst ? 21 * 60 + 30 : 22 * 60 + 30;   // 晚间开盘
  const close = dst ? 4 * 60 : 5 * 60;              // 次日凌晨收盘
  const snapEnd = close + 30;
  const m = p.minutes;

  const base = { day: '', trading: false, snapshotDue: false, phase: 'closed', nextChangeAt: 0, market: 'US' };

  // 凌晨段：归属到前一天开始的那个交易日
  if (m < close) {
    const sessionDay = shiftDateStr(p.dateStr, -1);
    base.day = sessionDay;
    const reason = usTradingDayReason(sessionDay);
    if (reason) {
      // 周末 / 节假日休市 —— 界面上要能区分，不能和「正常休市」混为一谈
      base.phase = reason;
      base.nextChangeAt = nextUsOpenMs(date);
      return base;
    }
    base.trading = true;
    base.phase = 'us-trading';
    base.nextChangeAt = beijingTimeToUtcMs(p.year, p.month, p.day, Math.floor(close / 60), close % 60);
    return base;
  }

  // 晚间段：归属到当天开始的交易日
  if (m >= open) {
    base.day = p.dateStr;
    const reason = usTradingDayReason(p.dateStr);
    if (reason) {
      base.phase = reason;
      base.nextChangeAt = nextUsOpenMs(date);
      return base;
    }
    base.trading = true;
    base.phase = 'us-trading';
    // 收盘在次日凌晨
    const tomorrow = shiftDateStr(p.dateStr, 1);
    const [ty, tm, td] = tomorrow.split('-').map(Number);
    base.nextChangeAt = beijingTimeToUtcMs(ty, tm, td, Math.floor(close / 60), close % 60);
    return base;
  }

  // 收盘后的快照窗口：抓一次当日最终价。
  // 刚收盘的那一段是从**昨晚**开始的，交易日归属昨晚那天
  if (m < snapEnd) {
    const sessionDay = shiftDateStr(p.dateStr, -1);
    base.day = sessionDay;
    if (isUsTradingDay(sessionDay)) {
      base.snapshotDue = true;
      base.phase = 'us-after-close';
      base.nextChangeAt = beijingTimeToUtcMs(p.year, p.month, p.day, Math.floor(snapEnd / 60), snapEnd % 60);
      return base;
    }
  }

  base.day = p.dateStr;
  base.phase = 'closed';
  base.nextChangeAt = beijingTimeToUtcMs(p.year, p.month, p.day, Math.floor(open / 60), open % 60);
  return base;
}

// 这次 tick 该干什么（抽成纯函数，主进程只负责执行，逻辑本身可单测）
// 返回 { action: 'fetch' | 'snapshot' | 'idle', reason, delay, info? }
//   fetch    : 正常请求行情
//   snapshot : 收盘后补抓一次当天最终价
//   idle     : 什么都不做，按 delay 睡到下一个状态变化
//
// state 可传：
//   closeSnapshotDay     A 股收盘快照已抓过的交易日
//   hkCloseSnapshotDay   港股收盘快照已抓过的交易日
//   usCloseSnapshotDay   美股收盘快照已抓过的交易日
//   hasHK                自选里有没有港股（没有就不必开港股这条轨）
//   hasUS                自选里有没有美股（没有就不必开美股这条轨）
function planTick(cfg, now, state = {}) {
  const refreshMs = Math.max(2, Number((cfg && cfg.refreshIntervalSeconds) || 3) || 3) * 1000;

  if (cfg && cfg.marketHoursOnly === false) {
    return { action: 'fetch', reason: 'always', delay: refreshMs };
  }

  const cn = sessionPhase(now, 'CN');
  const hk = state.hasHK ? sessionPhase(now, 'HK') : null;
  const us = state.hasUS ? usSessionPhase(now) : null;

  // 任一市场在交易就请求：三路并行本来就一次带全部标的（A股+港股+美股+板块），不拆成多次
  if (cn.trading || (hk && hk.trading) || (us && us.trading)) {
    return {
      action: 'fetch',
      reason: cn.trading ? cn.phase : (hk && hk.trading ? 'hk-trading' : 'us-trading'),
      delay: refreshMs,
      info: cn,
      hkInfo: hk,
      usInfo: us,
    };
  }

  // 收盘后补抓一次当日最终价（三个市场各记各的）
  if (cn.snapshotDue && state.closeSnapshotDay !== cn.day) {
    return { action: 'snapshot', reason: 'after-close', market: 'CN', delay: 5000, info: cn, hkInfo: hk, usInfo: us };
  }
  if (hk && hk.snapshotDue && state.hkCloseSnapshotDay !== hk.day) {
    return { action: 'snapshot', reason: 'after-close', market: 'HK', delay: 5000, info: cn, hkInfo: hk, usInfo: us };
  }
  if (us && us.snapshotDue && state.usCloseSnapshotDay !== us.day) {
    return { action: 'snapshot', reason: 'after-close', market: 'US', delay: 5000, info: cn, hkInfo: hk, usInfo: us };
  }

  // 睡觉：取各市场「下一个状态变化」里最早的那个
  const nowMs = now.getTime();
  const nexts = [cn.nextChangeAt];
  if (hk) nexts.push(hk.nextChangeAt);
  if (us) nexts.push(us.nextChangeAt);
  const next = Math.min(...nexts.filter((x) => Number.isFinite(x) && x > nowMs));
  const wait = Math.max(200, Math.min(next - nowMs, 60000));
  return { action: 'idle', reason: cn.phase, delay: wait, info: cn, hkInfo: hk, usInfo: us };
}

module.exports = {
  CN_HOLIDAYS, HK_HOLIDAYS, T, HK_T,
  beijingParts, beijingTimeToUtcMs, isWeekend, isHoliday, isTradingDay,
  nextTradingDayOpenMs, sessionPhase, describePhase, planTick,
  usSessionPhase, isUsDst, isUsTradingDay, usHolidaySet, nthWeekday, lastWeekday,
  easterSunday, observedDate, shiftDateStr,
};
