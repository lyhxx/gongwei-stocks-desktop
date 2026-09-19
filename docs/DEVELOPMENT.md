# 开发文档

面向二次开发与维护。阅读前建议先跑通 `npm install && npm start && npm test`。

**目录** ：[技术栈](#1-技术栈与约束) · [进程模型](#2-进程与窗口模型) · [数据流](#3-数据流) · [Provider 层](#4-provider-层srccommonprovidersjs) · [IPC 契约](#5-ipc-契约) · [存储 schema](#6-存储-schema) · [渲染层要点](#7-渲染层要点) · [构建与发布](#8-构建与发布) · [测试](#9-测试) · [编码约定](#10-编码约定) · [已知问题](#11-已知问题与决策记录)

## 1. 技术栈与约束

| 项 | 选择 | 说明 |
| --- | --- | --- |
| 运行时 | Electron 33 | 主进程 Node 20 / 渲染进程 Chromium |
| HTTP | Electron `net.fetch` | Chromium 网络栈，天然走系统代理 / PAC |
| 持久化 | `electron-store` 8 | 主进程唯一写入口，落盘 JSON |
| 打包 | `electron-builder` 25 | 一次产出 nsis / portable / zip |
| 测试 | Node + `jsdom` | 无框架，纯 `assert`，离线可跑 |
| 目标平台 | 仅 Windows x64 | 浮窗、托盘、热键按 Windows 调优 |

刻意不引入前端框架与打包器：渲染层是原生 ES + CSS，改完直接生效，方便长期单独维护。
也不引入 `undici` 等代理依赖——Electron 33 内置 Node 20.18，undici 6.28+ 会因 `webidl.util.markAsUncloneable` 直接 `require` 失败，用 `net.fetch` + `session.setProxy` 更省事且能吃到 PAC。

## 2. 进程与窗口模型

```
┌──────────────────────── 主进程 src/main.js ────────────────────────┐
│  electron-store（唯一数据源）                                       │
│  轮询定时器 ─→ providers 三路并行 ─→ 合并 ─→ 广播 market:update     │
│  告警判定 ─→ 桌面通知 / 声音 / 渲染层高亮                            │
│  托盘（提示与轮播）· 全局热键 · 浮窗尺寸自适应                        │
└───┬────────────┬───────────┬───────────┬──────────────────────┐
    │ preload.js │           │           │
    │            │           │           │
┌───▼────────┐ ┌─▼─────────┐ ┌▼──────────┐ ┌▼─────────────────┐
│ 主窗口     │ │ 浮窗      │ │ K线窗口   │ │ 提醒窗口 alert/   │
│ renderer/  │ │ float/    │ │ chart/    │ │ alert.html        │
│ index.html │ │ float.html│ │ chart.html│ │ +alert.js         │
│ +app.js    │ │ +float.js │ │ +echarts  │ │                  │
└────────────┘ └───────────┘ └───────────┘ └──────────────────┘
```

* **四个窗口共用同一个 `preload.js`**，暴露面收敛在 `window.gongwei`，渲染层没有任何 Node 能力（`contextIsolation: true`、`nodeIntegration: false`）。
* K 线窗口独立于主窗口：主窗口只发 `chart:open`，窗口自己用 `chart:stock` 取当前标的、监听 `chart:update` 切换；这样图表不受主窗口尺寸/滚动限制，可自由缩放。
* 提醒窗口同理：主窗口只发 `alert:open`，窗口用 `alert:stock` 取标的、监听 `alert:update`；改动防抖即时保存（`stocks:update-alert`），行内不再展开配置。
* 主窗口关闭 = 隐藏到托盘（`app.quitting` 标记区分真正退出）。
* 单实例锁：第二次启动会唤醒已有窗口，不会起两个进程。

## 3. 数据流

### 3.0 公共模块一览

与 Electron 解耦、可单独单测的小模块，改动它们请同步补 `test/providers.test.js`：

| 文件 | 职责 |
| --- | --- |
| `common/http.js` | 统一请求出口，可注入实现，带超时 |
| `common/proxy.js` | 代理模式兜底、手工代理地址校验、`resolveProxy` 结果转人话 |
| `common/market-hours.js` | 交易时段 / 交易日判断，以及「这次 tick 做什么」的调度决策 |
| `common/version.js` | 版本号解析比较、从 Release 里挑下载资产 |
| `common/order.js` | 自选与指数排序校验（拖拽落库前调用） |

### 3.1 行情调度

```
scheduleTick → tick()
  └─ planTick(cfg, now, { closeSnapshotDay })     // 纯函数，见 market-hours.js
       ├─ action=fetch    → refreshMarket('auto')     // 交易时段内，按设定间隔
       ├─ action=snapshot → refreshMarket('close')    // 15:00~15:30 补抓当日最终价（当天一次）
       └─ action=idle     → 不发请求，睡到下一个状态变化
```

* 调度用 `setTimeout` 链而非 `setInterval`，睡多久由 `planTick` 决定，且**上限 60 秒**——休市期间每 60 秒只醒来判断一次状态（不发网络请求），这样改设置或系统时间变化能快速生效。
* 交易时段与交易日一律按**北京时间**判断（`Intl.DateTimeFormat` + `timeZone: 'Asia/Shanghai'`），与本机时区无关。
* 法定节假日表在 `market-hours.js` 的 `CN_HOLIDAYS`，每年官方安排公布后更新该处即可；多列几天只是少发几个请求，漏列只是多发几个请求（数据本身不变），不会漏数据。
* 冷启动会先 `refreshMarket('init')` 拉一次，保证已收盘时界面也有上一笔收盘价。

### 3.2 行情取数

```
refreshMarket(reason)
  └─ doRefreshMarket(gen++)
       ├─ 组装 stocks + 勾选的 indexStocks
       ├─ 三路并行：fetchEastmoney / fetchSina / fetchTencent
       │    每路 resolve 就 mergeQuoteRows 合并并广播一次   ← 谁快谁先画（渐进式首屏）
       ├─ 丢弃过期轮次（gen !== refreshGen 时直接 return）
       ├─ backfillNames 回填纯代码添加的股票名称
       ├─ checkAlerts + 5 分钟冷却 → 通知 / 声音 / 渲染层高亮
       └─ updateTrayTooltip
```

**关键点**

* `refreshing` 防止自动轮询叠加；`refreshGen` 防止手动刷新的旧响应覆盖新数据。
* `mergeQuoteRows` 按 `stockId` 逐只取第一个 `ok` 的结果，所以来源可能是 `eastmoney+tencent` 混合。
* 合并结果与 `indexMeta` 一起放进 `lastQuotes`，通过 `market:update` 推给两个窗口。

### 3.3 搜索

五层兜底，任一层有结果即返回：

```
直接代码候选（6 位数字，按前缀推断市场，不依赖网络）
  → 腾讯 smartbox（免 token，支持拼音，网络兼容最好）
  → 东财 suggest type=14
  → 新浪 suggest3
  → 雪球 suggest（实测常需登录 cookie，会明确报错跳过）
```

全部失败时若输入是 6 位代码，返回直通候选；否则抛出带各层原因的异常。

### 3.4 K 线 / 分时

自选行点 K 线图标 → `openChart(stock)`（`chart:open`）打开**独立窗口** `chart/` → 窗口启动时 `chart:stock` 取标的、调 `kline:get` / `trends:get` / `detail:get` → 用 ECharts 绘制。**按需请求**：只有打开图表窗口才拉数据，不参与轮询。

| 周期 | 接口 | 关键参数 |
| --- | --- | --- |
| 分时 | `push2.eastmoney.com/api/qt/stock/trends2/get` | `ndays=1`，`fields2=f51,f53,f56,f58` |
| 日K | `push2his.eastmoney.com/api/qt/stock/kline/get` | `klt=101` |
| 周K | 同上 | `klt=102` |
| 月K | 同上 | `klt=103` |

* 一律 `fqt=1`（前复权），复用 `eastmoneySecid()` 生成 `secid`。
* **`kline/get` 必须带 `end` 参数**（取一个足够远的日期，如 `20500101`）。不带 `end` 时东财返回 `rc:102` / `data:null`，表现就是「分时能看、日周月 K 全空」——分时走的是另一个 `trends2` 接口，所以更容易误判成网络问题。
* K 线每行：`日期,开,收,高,低,量,额,振幅,涨跌幅`。注意 **ECharts `candlestick` 的数据顺序是 `[开, 收, 低, 高]`**（不是 `[开,收,高,低]`，网上不少示例是错的，会让影线上下颠倒）。
* 顶部明细另走 `push2.eastmoney.com/api/qt/stock/get`（`f44` 高 / `f45` 低 / `f46` 开 / `f47` 量(手) / `f48` 额(元) / `f60` 昨收 / `f168` 换手率(×100)），只在打开窗口时取一次。
* ECharts 不做打包，`src/vendor/echarts.min.js` 是 vendor 文件；升级时 `npm i -D echarts@5` 后把 `node_modules/echarts/dist/echarts.min.js` 覆盖过去即可，由 `chart/chart.html` 在 `chart.js` 之前引入。
* 主图与成交量副图用 `axisPointer.link: [{ xAxisIndex: 'all' }]` 联动十字光标；**只让最底部 X 轴显示指针时间标签**（`catAxis(..., false)` 关掉主图那份），否则悬停会出现两个时间。
* **分时右侧涨跌幅轴**上下沿正好是「板块涨跌停」（主板 ±10%、创业/科创 ±20%、北交所 ±30%，`limitFracOf()`），以昨收为中轴；当日振幅超过涨跌停（新股等）才放大。**不要对区间取整**——曾把 ±10% 取整外扩成 ±10.81%。左右两轴共用同一 `interval`，刻度严格对齐。
* 日/周/月 K 的右侧轴相对「可见区间中点」，默认也至少一个涨跌停幅度，随缩放联动（`dataZoom` 事件里重算）。
* 图表高度靠 flex 占满窗口，`window.resize` 时调 `chart.resize()`；换标的用 `chart:update` 推送，切周期用 `seq` 丢弃过期响应。

### 3.5 价格提醒

条件存在每只自选的 `alert` 对象里（见默认值 `common/defaults.js` 的 `blankAlert()`），提醒窗口改动即时写入。判定在 `main.js` 的 `checkAlerts()`：

| 条件 | 字段 | 判定 |
| --- | --- | --- |
| 上破价 / 下跌价 | `upperPrice` / `lowerPrice` | 现价 ≥ / ≤ 阈值 |
| 涨幅 / 跌幅 | `upperChangePercent` / `lowerChangePercent` | 涨跌幅 ≥ / ≤ ∓ 阈值 |
| 涨跌停 | `limitUp` / `limitDown` | 涨跌幅接近板块幅度（主板 10%、创业/科创 20%、北交所 30%） |
| 成交量异动 | `volumeAnomaly` / `volumeRatio` | 东财「量比」(f50) ≥ 阈值 |
| N 分钟急涨急跌 | `rapidEnabled` / `rapidPercent` / `rapidMinutes` | 相对 N 分钟前采样价涨跌幅 ≥ 阈值 |

* 量比来自东财实时接口 `f50`（×100）；新浪/腾讯通道没有该字段，缺失时不触发。
* 急涨急跌靠主进程维护的内存采样 `priceHistory`（每只保留 120 分钟），删自选时一并清理。
* 同一只 5 分钟冷却一次，避免每轮询重复轰炸；`reason !== 'init'` 才通知。

## 4. Provider 层（`src/common/providers.js`）
### 4.1 代码 / secid 规则

| 目标 | 规则 | 示例 |
| --- | --- | --- |
| 东财 secid | SH→`1.`，SZ/BJ→`0.`，HK→`116.`，US→`100.` | `1.600000` |
| 腾讯 / 新浪 | `sh/sz/bj/hk/us` + 代码 | `hk00700`（不是 `hkex`） |

搜索结果的 `sourceIds.eastmoney` 优先于推断，添加自选时一并保存，避免北证/港股/美股漂移。

### 4.2 东财字段与精度（易错）

* 请求：`/api/qt/stock/get?secid=..&fields=f43,f44,...&ut=<token>&fltt=1&invt=2`
* `f43` 现价 / `f60` 昨收 / `f169` 涨跌额是**放大后的整数**，需除以 `10^f59`（`f59` 缺省时用 `f152`，再缺省 A 股 `100`、港股 `1000`）
* `f170` 涨跌幅是百分数 ×100，除以 100
* 备用域名 `push2delay.eastmoney.com`，首个失败自动切
* 必须在 header 带 `Referer: https://quote.eastmoney.com/` 与浏览器 UA

### 4.3 腾讯 smartbox 的坑

返回体里的中文是**字面量 `\uXXXX` 转义串**（6 个 ASCII 字符），必须 `unescapeUnicode` 解码，否则界面显示 `\u6d66...`。单测用 `String.raw` 还原 wire 数据，不要直接写 `\u6d66`（JS 会提前解析，掩盖 bug）。

### 4.4 新浪 GBK

`hq.sinajs.cn` 与 `suggest3` 可能返回 GBK。`decodeAuto` 的处理顺序：UTF-8 解出替换符 → 用 GBK；UTF-8 无中文但有非 ASCII 且 GBK 有中文 → 用 GBK；否则 UTF-8。原因见代码注释（部分 GBK 字节恰好也是合法 UTF-8）。

### 4.5 新增一个行情通道

1. 在 `providers.js` 写 `fetchXxx(stocks)`，返回 `{ stockId, code, name, latestPrice, changePercent, changeAmount, ok, updatedAt }[]`
2. 至少实现全失败时抛错（用于诊断），部分成功返回 `ok:false` 行即可
3. `src/main.js` 的 `QUOTE_PROVIDERS` 数组追加 `['xxx', fetchXxx]`
4. `selfTest()` 里加一个探针，界面上就能看到这条通道通不通
5. `test/providers.test.js` 加解析用例

## 5. IPC 契约

渲染层只能通过 `window.gongwei.*` 调用；主进程用 `ipcMain.handle`（请求/响应）与 `ipcMain.on`（单向）。

| 桥接方法 | 通道 | 说明 |
| --- | --- | --- |
| `getStore()` | `store:get` | 读取完整 store |
| `getVersion()` | `app:version` | 应用版本号（界面底部） |
| `getMarket()` | `market:get` | 取最近行情快照 |
| `refreshMarket()` | `market:refresh` | 主动刷新 |
| `search(kw)` | `search` | 五层兜底搜索 |
| `getKline(stock, period, limit)` | `kline:get` | 日/周/月 K 线（东财 `push2his`） |
| `getTrends(stock)` | `trends:get` | 当日分时（东财 `trends2`） |
| `getDetail(stock)` | `detail:get` | 实时明细（今开/昨收/今高/今低/量/额） |
| `openChart(stock)` | `chart:open` | 打开 K 线独立窗口并载入标的 |
| `getChartStock()` | `chart:stock` | K 线窗口启动时取当前标的 |
| `openAlert(stock)` | `alert:open` | 打开价格提醒窗口并载入标的 |
| `getAlertStock()` | `alert:stock` | 提醒窗口启动时取当前标的 |
| `addStock` / `removeStock` | `stocks:add` / `stocks:remove` | 增删自选 |
| `updateAlert(id, alert)` | `stocks:update-alert` | 提醒条件（合并写入） |
| `reorderStocks(ids)` / `reorderIndices(ids)` | `stocks:reorder` / `indices:reorder` | 拖拽排序落库 |
| `toggleIndex(id, on)` | `indices:toggle` | **原子**启停指数，避免连点竞态 |
| `updateSettings(patch)` | `settings:update` | 设置深合并 |
| `toggleFloat` / `hideFloat` | `float:toggle` / `float:hide` | 浮窗显隐 |
| `floatResize(h)` | `float:resize` | 浮窗回报内容高度（单向） |
| `testNotify()` | `notify:test` | 测试通知，返回 `{ok, message}` |
| `diagnose()` | `diagnose` | 通道状态与报错 |
| `selftest()` | `selftest` | 九探针并行实测 |
| `onMarket` / `onStore` / `onAlert` | `market:update` / `store:changed` / `alert:trigger` | 主进程推送 |

另有 `applyProxy()`（`proxy:apply`）、`testProxy()`（`proxy:test`）、`checkUpdate()`（`update:check`）、
`openExternal(url)`（`open:external`）；单向推送还有 `onSession`（`session:update`）、
`onOpenSettings`（`ui:open-settings`）、`onUpdateState`（`update:state`）、
`onChartUpdate`（`chart:update`，主进程通知 K 线窗口换标的）、`onAlertUpdate`（`alert:update`，提醒窗口换标的）。

新增通道时 **preload 与 main 必须同步改**，否则 `test/audit.js` 会报「注册了但未使用 / 调用了但未注册」。

## 6. 存储 schema

文件：`%APPDATA%\工位看盘\gongwei-stocks.json`（`new Store({ name: 'gongwei-stocks' })`）

```jsonc
{
  "schemaVersion": 1,
  "updatedAt": "ISO 时间",
  "groups": [{ "id": "default", "name": "默认分组" }],
  "stocks": [{
    "id": "s...", "code": "600000", "name": "浦发银行",
    "market": "CN", "exchange": "SH", "sourceIds": {},
    "order": 0, "badgeEnabled": true,
    "alert": { "enabled": false, "upperPrice": null, "lowerPrice": null,
               "upperChangePercent": null, "lowerChangePercent": null,
               "limitUp": false, "limitDown": false,
               "volumeAnomaly": false, "volumeRatio": 2,
               "rapidEnabled": false, "rapidPercent": 3, "rapidMinutes": 5 }
  }],
  "settings": {
    "main":    { "theme": "system", "refreshIntervalSeconds": 3, "colors": { "up": "#d92d20", "down": "#079455" } },
    "alerts":  { "badgeEnabled": true, "channels": ["sound", "notify"], "mergeSameStock": true },
    "indices": { "floatingVisible": true, "selected": ["shanghai", "shenzhen", "chinext", "sse50"] },
    "floating":{ "enabled": true, "opacity": 88, "width": 250, "position": "bottom-right",
                 "hotkey": "Ctrl+Shift+M", "escapeToHideEnabled": true }
  }
}
```

**迁移策略**：`electron-store` 的 `defaults` 只做浅合并，因此 `ensureDefaults()`（启动时）补齐缺失的设置分区并清理未知指数 id；`normalizeStocks()` 逐只补齐 `alert` / `badgeEnabled` / `order` / `exchange`，并丢弃无 `code` 的脏数据。新增配置项时，同步更新 `defaultState()` 与这两处兜底。

## 7. 渲染层要点

* **不重建 DOM 的原地更新**：`onMarket` 走 `updateMarketUI()`，只改价格/涨跌文本；只有 store 变化（增删股票、改设置）才 `renderAll()` 重建。否则用户展开的提醒条件、正在输入的数字会被每几秒冲掉。
* **重建时保存用户态**：`renderStocks()` 先记录哪些卡片是展开的、输入框里是什么，重建后写回。
* **指数列表以勾选为准**：`renderIndices()` 遍历 `settings.indices.selected` 生成卡片，行情只负责填数值。曾经以行情数组为准，导致取消/新增指数要等下一次网络刷新才生效（网络失败时永远不生效）。
* **管理面板不跟随轮询重绘**：只在打开和勾选时手动画，否则复选框每几秒重建，点不动。
* **`hidden` 必须真的不显示**：`.foo { display: grid }` 会盖掉浏览器默认的 `[hidden]`，所以 `styles.css` 里有全局 `[hidden] { display: none !important }`，并且每个声明了 `display` 又用 `hidden` 控制的类都补了 `.foo[hidden]`；`test/audit.js` 会静态检查这一点。
* **弹窗**：设置 / 自检 / 诊断 / 更新共用一个 `#modalOverlay`，`openModal(title, bodyClass, html)` 渲染，遮罩点击、`✕`、`Esc` 均可关闭。
* **拖拽排序**：`attachDrag()` 一套逻辑同时服务自选列表与指数网格。四个坑都踩过，改这段务必留意：
  1. `pointermove/up` 必须挂 **`window`**（捕获阶段），不要挂被拖元素、也不要用 `setPointerCapture`。列表随时可能被 store 变化重建，挂在元素上的监听会随之失效，`pointerup` 收不到就会让 `dragState` 永久卡住，之后所有拖拽都失效。
  2. 拖拽期间在 `renderStocks` / `renderIndices` 开头 `if (isDragging()) return`，绝不重建列表。
  3. 落点判定用**拖拽开始时冻结的槽位坐标**（`captureSlots` + `resolveTarget`），不能每帧读实时坐标：网格里换位会让整片元素挪动，指针会不断落到刚换过去的元素附近，形成「换位 → 坐标变 → 再换回」的来回抖动。
  4. 换位动画用 `element.animate()`，并在重排前统一 `cancel()` 掉容器内所有在播动画后再测量坐标，避免动画偏移被叠加进下一次测量。
  另外：同一时刻只允许一个拖拽、只认主指针（`isPrimary === false` 才拒绝，缺省放行以便测试环境只有 `MouseEvent`）、触摸必须从 `.drag-handle` 起拖（触摸事件的 `button` 也是 0，光靠 button 判断拦不住）。
* **请求一律走 `common/http.js`**：`test/audit.js` 会拦截 `providers.js` 里的裸 `fetch(`，否则换成 `net.fetch` 后代理就不生效了。
* **主题要同时改原生层**：只改 CSS 变量的话，Windows 标题栏不会变。`applyNativeTheme()` 设置 `nativeTheme.themeSource`，并只给**有系统边框的主窗口**刷 `backgroundColor`——透明浮窗一旦被设成不透明底色，透明区会被填实、圆角外露出直角（`test/audit.js` 有静态检查）。
* **浮窗先定尺寸再显示**：`show: false` 创建，等渲染层回报内容高度、尺寸设好后再 `showInactive()`，否则会先出现再跳一下；另有 800ms 兜底防止渲染异常时窗口不可见。
* **浮窗右键菜单**：拦截 `floatWin.webContents` 的 `context-menu` 事件，弹出自己的菜单（刷新 / 显示主窗口 / 设置 / 隐藏 / 停用 / 退出）。

## 8. 构建与发布

### 本地

```bash
npm run dist          # nsis + portable + zip
npm run dist:dir      # 只出解包目录，便于快速验证
npm run pack:nsis     # 单个目标
```

产物在 `dist/`，命名由 `package.json#build` 控制（含中文产品名）。

### CI / Release

`.github/workflows/build-win.yml`：`windows-latest` 上 `npm ci → npm test → npm run dist`，随后

1. 上传 `windows-packages` artifact（保留每次构建产物）
2. 若是 tag 推送，调用 `scripts/release-notes.js` 从 `CHANGELOG.md` 截取该版本段落写入 `release-notes.md`，作为 Release 说明上传

**发版流程**

```bash
# 1. 更新 CHANGELOG.md：把 [未发布] 内容整理到新版本段落
# 2. 同步 package.json 的 version（两处必须一致，否则 CI 会因找不到 changelog 段落而失败）
npm test
git add -A && git commit -m "chore(release): v1.0.0"
git tag v1.0.0 && git push origin main --tags
```

## 9. 测试

```bash
npm test
# = node scripts/validate-build-config.js
#   && node test/audit.js
#   && node test/providers.test.js
#   && node test/alerts.test.js
#   && node test/dom.test.js
```

| 文件 | 侧重 |
| --- | --- |
| `scripts/validate-build-config.js` | 打包配置是否符合官方 schema |
| `test/audit.js` | 引用与桥接一致性等静态检查 |
| `test/providers.test.js` | 行情 / 搜索解析与降级联调 |
| `test/alerts.test.js` | 提醒条件判定（涨跌停/量比/急涨急跌等） |
| `test/dom.test.js` | 主窗口 / 浮窗 / K线 / 提醒窗口的真实渲染交互 |

各文件具体覆盖：

* **`scripts/validate-build-config.js`** — 用 electron-builder 官方 schema 校验 `build` 字段，拦截非法字段（如曾经的 `build.zip`）、重复或含非 ASCII 的产物命名、清单里不存在的资源与图标
* **`test/audit.js`** — `$('id')` 引用的元素是否存在、桥接方法与 IPC 通道是否一一对应、内置指数 id 与前端中文名映射是否齐全、声明了 `display` 的元素是否有 `[hidden]` 同伴、是否误开 `nodeIntegration`、README 是否链接到文档
* **`test/providers.test.js`** — smartbox `\uXXXX` 转义、GBK 自动识别、新浪/腾讯行解析、secid 与精度换算、品种归类（股票/基金/可转债）、版本比较，以及 mock fetch 下的三路合并、搜索兜底顺序、K线/分时/明细解析、交易时段与调度决策
* **`test/alerts.test.js`** — 提醒判定：上破/下跌价、涨幅/跌幅（含负值取绝对值）、各板块涨跌停（10/20/30）、量比异动、N 分钟急涨急跌（注入历史采样）、未启用/无行情不触发
* **`test/dom.test.js`** — jsdom 真跑：卡片渲染、铃铛开/关、指数勾选即时生效、管理面板开合、`getComputedStyle` 验证 `hidden` 真的不显示、弹窗开合、设置页分组与开关、联想下拉、拖拽（含多指针与触摸场景）、状态栏休市文案、浮窗、K线窗口、提醒窗口回填与保存

添加用例的原则：**优先用能复现真实 bug 的输入**。

* 测 `\uXXXX` 转义要用 `String.raw` 还原 wire 数据，直接写 `\u6d66` 会被 JS 提前解析、掩盖 bug
* 测 GBK 要用真实字节，不能用 UTF-8 字符串
* 测 `hidden` 要用 `getComputedStyle`，只断言 `element.hidden` 属性会漏掉 CSS 覆盖问题
* 测触摸/多指针要手工补 `pointerType` / `isPrimary`：jsdom 没有 `PointerEvent`，回退到 `MouseEvent` 后这两个字段不会生效，不补就会**假过**
* 拖拽用例末尾统一 `cleanupDrag()`，避免一条失败把「拖拽中」状态留给后面的用例

## 10. 编码约定

* 不引入 TypeScript / 打包器；CommonJS（主进程）+ 原生 ES（渲染层）
* 中文注释，解释「为什么」而不是「是什么」；每个易错点注明踩坑原因
* 主进程是**唯一数据写入方**，渲染层只读 store + 发指令
* 界面元素或 IPC 有改动后跑 `npm test`，静态审计会校验引用与桥接一致性
* Markdown 表格单元格保持短句，长说明放到表格外的列表，避免渲染时折行

## 11. 已知问题与决策记录

* **中证2000（932000）只有东方财富支持** — 保持内置；东财被拦时该指数显示 `--`，其余正常
* **雪球 suggest 需登录 cookie** — 保留为兜底通道，返回 `success:false` 时明确报错跳过，不再当「0 条」
* **便携版数据仍写 `%APPDATA%`** — 已知，长期计划改为跟随 exe 目录
* **未做代码签名** — 首次运行有 SmartScreen 提示，个人自用可接受
* **浮窗透明区域挡点击** — 已通过渲染后回报内容高度、窗口自适应解决
* **提醒每 5 分钟可能重复触发** — 有意设计：条件持续满足期间按冷却周期提醒，避免一次性错过
* **产物文件名必须是 ASCII** — GitHub Release 会抹掉非 ASCII 字符，导致 `-1.0.0-.-x64.exe` 这种废名；`validate-build-config.js` 已加静态拦截
* **节假日表需要逐年维护** — `CN_HOLIDAYS` 目前覆盖 2025–2026；漏列只会多发几个请求，不会漏数据
* **指数在非交易日仍显示上一交易日收盘价** — 属预期行为，状态栏会标注「周末休市 / 节假日休市」
* **Release 只由 `action-gh-release` 发布** — `npm run dist` 带 `--publish never`，避免 electron-builder 与 action 各发一次导致资产重复、说明被清空
* **不要引入 `undici` 做代理** — Electron 33 内置 Node 20.18，`require('undici')`（6.28+）直接抛 `webidl.util.markAsUncloneable is not a function`；ProxyAgent 也不能跨版本喂给全局 fetch。用 `net.fetch` + `session.setProxy`
* **浮窗收起/展开靠程序化 `setContentSize`** — `resizable:false` 的无边框透明窗口在 Windows 上仍可被程序缩放（已实测 46×46 ↔ 250×360）
* **搜索主通道 smartbox 的类型字段** — A股是 `GP-A`、港美股是 `GP`、场内基金是 `ETF`、场外基金是 `KJ*`（`jj` 市场），早期只放行 `/^GP/` 会把 ETF 全部丢掉

