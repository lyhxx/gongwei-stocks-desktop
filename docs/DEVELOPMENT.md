# 开发文档

面向二次开发与维护。阅读前建议先跑通 `npm install && npm start && npm test`。

## 1. 技术栈与约束

| 项 | 选择 | 说明 |
| --- | --- | --- |
| 运行时 | Electron 33 | 主进程 Node 22 / 渲染进程 Chromium |
| 持久化 | `electron-store` 8 | 主进程唯一写入口，落盘为 JSON |
| 打包 | `electron-builder` 25 | 一次产出 nsis / portable / zip |
| 测试 | Node + `jsdom` | 无框架，纯 `assert`，离线可跑 |
| 目标平台 | 仅 Windows x64 | 浮窗透明置顶、托盘、全局热键均按 Windows 调优 |

刻意不引入前端框架与打包器：渲染层是原生 ES + CSS，改完直接生效，方便长期单独维护。

## 2. 进程与窗口模型

```
┌──────────────────────── 主进程 src/main.js ────────────────────────┐
│  electron-store（唯一数据源）                                       │
│  轮询定时器 ─→ providers 三路并行 ─→ 合并 ─→ 广播 market:update     │
│  告警判定 ─→ 桌面通知 / 声音 / 渲染层高亮                            │
│  托盘（提示与轮播）· 全局热键 · 浮窗尺寸自适应                        │
└───────┬───────────────────────────┬────────────────────────────────┘
        │ preload.js (contextBridge)│
┌───────▼───────────┐     ┌─────────▼───────────┐
│ 主窗口 renderer/  │     │ 浮窗 float/          │
│ index.html+app.js │     │ float.html+float.js  │
└───────────────────┘     └─────────────────────┘
```

* **两个窗口共用同一个 `preload.js`**，暴露面收敛在 `window.gongwei`，渲染层没有任何 Node 能力（`contextIsolation: true`、`nodeIntegration: false`）。
* 主窗口关闭 = 隐藏到托盘（`app.quitting` 标记区分真正退出）。
* 单实例锁：第二次启动会唤醒已有窗口，不会起两个进程。

## 3. 数据流

### 3.1 行情轮询

```
setInterval(refreshMarket)            // 间隔取自 settings.main.refreshIntervalSeconds，最小 2s
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

### 3.2 搜索

五层兜底，任一层有结果即返回：

```
直接代码候选（6 位数字，按前缀推断市场，不依赖网络）
  → 腾讯 smartbox（免 token，支持拼音，网络兼容最好）
  → 东财 suggest type=14
  → 新浪 suggest3
  → 雪球 suggest（实测常需登录 cookie，会明确报错跳过）
```

全部失败时若输入是 6 位代码，返回直通候选；否则抛出带各层原因的异常。

## 4. Provider 层（`src/common/providers.js`）

### 4.1 代码 / secid 规则

| 目标 | 规则 | 示例 |
| --- | --- | --- |
| 东财 secid | SH→`1.`，SZ/BJ→`0.`，HK→`116.`，US→`100.` | `1.600000` |
| 腾讯 / 新浪 | `sh/sz/bj/hk/us` + 代码 | `hk00700`（注意不是 `hkex`） |

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
| `getVersion()` | `app:version` | 应用版本号（界面底部展示） |
| `getMarket()` | `market:get` | 取最近一次行情快照 |
| `refreshMarket()` | `market:refresh` | 主动刷新 |
| `search(kw)` | `search` | 五层兜底搜索 |
| `addStock(item)` / `removeStock(id)` | `stocks:add` / `stocks:remove` | 增删自选 |
| `updateAlert(id, alert)` | `stocks:update-alert` | 提醒条件（合并写入） |
| `updateStock(id, patch)` | `stocks:update` | 通用字段（`badgeEnabled` 等） |
| `moveStock(id, dir)` | `stocks:move` | 排序，`dir=-1` 上移 |
| `snoozeStock(id, min)` | `stocks:snooze` | 暂停提醒 |
| `toggleIndex(id, on)` | `indices:toggle` | **原子**启停指数（前端不算集合，避免连点竞态） |
| `updateSettings(patch)` | `settings:update` | 设置深合并，含浮窗透明度/宽度/位置 |
| `toggleFloat()` / `hideFloat()` | `float:toggle` / `float:hide` | 浮窗显隐 |
| `floatResize(h)` | `float:resize` | 浮窗回报内容高度（单向） |
| `testNotify()` | `notify:test` | 测试通知，返回 `{ok, message}` |
| `diagnose()` | `diagnose` | 通道状态与报错 |
| `selftest()` | `selftest` | 九探针并行实测 |
| `onMarket(cb)` / `onStore(cb)` / `onAlert(cb)` | `market:update` / `store:changed` / `alert:trigger` | 主进程推送 |

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
               "upperChangePercent": null, "lowerChangePercent": null, "snoozedUntil": null }
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
* **弹窗**：设置 / 自检 / 诊断共用一个 `#modalOverlay`，`openModal(title, bodyClass, html)` 渲染，遮罩点击、`✕`、`Esc` 均可关闭。

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
npm test    # = node test/audit.js && node test/providers.test.js && node test/dom.test.js
```

| 文件 | 覆盖 |
| --- | --- |
| `test/audit.js` | 静态审计：元素引用是否存在、桥接与 IPC 是否一一对应、指数 id 与中文名映射是否齐全、`hidden` 规则是否完整、是否误开 `nodeIntegration`、README 版本是否同步 |
| `test/providers.test.js` | 解析（smartbox 转义、GBK、新浪/腾讯行、secid、精度换算）与 mock 联调（三路合并、搜索兜底顺序） |
| `test/dom.test.js` | jsdom 真跑渲染与交互：卡片、折叠、指数勾选即时生效、管理面板开合、`getComputedStyle` 验证 `hidden` 真的不显示、弹窗、联想下拉、浮窗 |

添加用例的原则：**优先用能复现真实 bug 的输入**。例如测 `\uXXXX` 用 `String.raw`，测 GBK 用真实字节，测 `hidden` 用 `getComputedStyle`（只断言 `element.hidden` 属性会漏掉 CSS 覆盖问题）。

## 10. 编码约定

* 不引入 TypeScript / 打包器；CommonJS（主进程）+ 原生 ES（渲染层）。
* 中文注释，解释「为什么」而不是「是什么」；每个 tricky 处注明踩坑原因。
* 主进程是**唯一数据写入方**，渲染层只读 store + 发指令。
* 新增界面元素后跑 `npm test`，静态审计会校验引用与桥接一致性。

## 11. 已知问题与决策记录

| 问题 | 结论 / 处理 |
| --- | --- |
| 中证2000（932000）只有东方财富支持 | 保持内置；东财被拦时该指数显示 `--`，其余正常 |
| 雪球 suggest 需登录 cookie | 保留为兜底通道，返回 `success:false` 时明确报错跳过，不再当「0 条」 |
| 便携版数据仍写 `%APPDATA%` | 已知，长期计划改为跟随 exe 目录 |
| 未做代码签名 | 首次运行有 SmartScreen 提示，个人自用可接受 |
| 浮窗透明区域挡点击 | 已通过渲染后回报内容高度、窗口自适应解决 |
| 提醒每 5 分钟可能重复触发 | 有意设计：条件持续满足期间按冷却周期提醒，避免一次性错过 |
