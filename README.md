# 工位看盘 · gongwei-stocks-desktop

> 余光一扫，涨跌了然。隐蔽、轻量的 Windows 桌面股票行情提醒助手。

基于 Electron 构建，常驻系统托盘，提供自选行情、指数看板、桌面浮窗、价格提醒与全局热键。不登录、不上传、无 C 端账号体系，行情直连公开接口。

[![build-win](https://github.com/lyhxx/gongwei-stocks-desktop/actions/workflows/build-win.yml/badge.svg)](https://github.com/lyhxx/gongwei-stocks-desktop/actions/workflows/build-win.yml)
![platform](https://img.shields.io/badge/platform-Windows-0078d4)
![license](https://img.shields.io/badge/license-MIT-green)

---

## 功能

| 模块 | 说明 |
| --- | --- |
| **自选** | 输入代码 / 名称 / 拼音缩写（`600000` / `茅台` / `gzmt`）即时联想添加，一行式卡片，价格、涨跌胶囊一眼可读 |
| **指数** | 内置 14 个常用指数（上证、深证、创业板、沪深300、中证系列、科创50/100/综指、北证50 等），卡片横排，点「管理」勾选启停 |
| **浮窗** | 透明置顶小窗：顶栏只有更新时间和涨跌家数，指数横排卡片在上、个股在下；高度自适应内容，不挡下方窗口点击 |
| **提醒** | 上破价 / 下跌价 / 涨幅% / 跌幅% 四种条件，铃铛一键开关，支持暂停 30 分钟，同只 5 分钟冷却防轰炸 |
| **通道** | Windows 桌面通知 + 声音提醒，可分别测试 |
| **外观** | 跟随系统 / 浅色 / 深色，深色最适合摸鱼；全站定制细滚动条 |
| **常驻** | 托盘图标常驻，关闭窗口不退出；`Ctrl+Shift+M` 全局切换浮窗，`Esc` 隐藏 |
| **诊断** | 状态灯 / 黄色小喇叭一键看诊断，说明当前数据来源与各通道报错；另有「接口自检」在本机实测每条接口 |

## 快速开始

### 直接使用（普通用户）

到 [Releases](https://github.com/lyhxx/gongwei-stocks-desktop/releases) 下载任意一种：

| 文件 | 说明 |
| --- | --- |
| `工位看盘-x.y.z-安装版-x64.exe` | 安装包，带开始菜单 / 桌面快捷方式 |
| `工位看盘-x.y.z-绿色单文件.exe` | 免安装单文件，双击即用 |
| `工位看盘-x.y.z-绿色解压版-x64.zip` | 免安装解压版 |

> 未购买代码签名证书，首次运行 Windows 会提示「未知发布者」，点「更多信息 → 仍要运行」即可。

### 从源码运行

```bash
git clone https://github.com/lyhxx/gongwei-stocks-desktop.git
cd gongwei-stocks-desktop
npm install
npm start
```

### 自测

```bash
npm test
```

包含静态审计、行情解析与降级联调、主窗口与浮窗的 DOM 交互回归，共 3 组、60+ 项断言，全部离线可跑。

### 打包

```bash
npm run dist
```

一次产出安装包、绿色单文件、绿色解压版三种（详见 `docs/DEVELOPMENT.md`）。

## 使用说明

| 操作 | 方式 |
| --- | --- |
| 添加自选 | 自选标题右侧输入框输入代码 / 名称 / 拼音，回车或点下拉项添加 |
| 开关浮窗 | `Ctrl+Shift+M`，或主界面顶栏「浮窗」按钮 |
| 隐藏浮窗 | `Esc`（浮窗获得焦点时） |
| 开关提醒 | 股票行尾的 🔔 铃铛 |
| 展开提醒条件 | 股票行尾的 `›` 箭头 |
| 退出程序 | 托盘图标右键 → 退出（关闭窗口只是隐藏到托盘） |

## 数据来源与容错

行情按 **东方财富 → 新浪 → 腾讯** 三路并行拉取、按只合并：谁先回来先用谁，还能互补（这只东财回、那只腾讯回）；任一通道挂掉不影响其他。搜索按 **腾讯 → 东财 → 新浪 → 雪球 → 纯代码直通** 五层兜底。

| 通道 | 地址 | 覆盖 |
| --- | --- | --- |
| 东方财富 | `push2.eastmoney.com` / `push2delay.eastmoney.com` | A股 / 港股 / 美股 / 指数（主力） |
| 新浪 | `hq.sinajs.cn` | A股 / 指数（HTTPS 优先） |
| 腾讯 | `qt.gtimg.cn` | A股 / 指数（HTTPS 优先） |

桌面端无 CORS 限制，直接请求，需带 `Referer` 与浏览器 UA。所有请求指向公开行情接口，仅用于个人学习与自用。

## 路线图

### 近期

- [ ] **ETF / 场内基金适配**：自选支持 ETF、LOF、可转债，区分品种类型，补充折溢价率与 IOPV
- [ ] **浮窗贴边吸附**：拖到屏幕边缘自动吸附，可收起成一个小圆圈，鼠标移入再展开
- [ ] **检查更新**：应用内检查 GitHub Releases 新版本，提示并一键下载（打通当前 CI 产物）
- [ ] **代理设置**：支持 HTTP / SOCKS5 代理，解决公司网络拦截行情站点导致的「全通道超时」
- [ ] **自选拖拽排序**：替换现在的 `↑ ↓` 按钮，支持跨分组拖动

### 中期

- [ ] **K 线 / 分时图**：接入日线与分时数据，浮窗和详情页都可看图
- [ ] **分组管理**：多自选列表（如「持仓」「观察」），浮窗按分组切换
- [ ] **持仓与盈亏**：记录成本价与数量，统计今日盈亏、持仓盈亏、总资产
- [ ] **提醒增强**：成交量异动、涨跌停、N 分钟急涨急跌、分时均线突破
- [ ] **老板键**：一键隐藏所有窗口（含浮窗），托盘图标可切换伪装样式
- [ ] **数据备份**：自选与设置导出 / 导入 JSON，换机迁移

### 长期

- [ ] **绿色版数据本地化**：便携版把配置写在 exe 同级目录，真正 U 盘可用
- [ ] **自动更新**：接入 `electron-updater`，静默增量更新
- [ ] **多显示器与位置记忆**：浮窗记忆所在屏幕与坐标
- [ ] **跨平台**：macOS / Linux 适配（当前仅 Windows）
- [ ] **CI 覆盖率看板**：测试覆盖率阈值与 PR 检查

> 有想加的功能或遇到问题，欢迎开 [Issue](https://github.com/lyhxx/gongwei-stocks-desktop/issues)。

## 常见问题

**Q：状态显示「来源 none / 异常 3 条」？**
三个通道同时超时，基本是网络问题：断网、切换网络中，或公司网络 / 代理拦截了行情站点。点状态灯看诊断详情，网络恢复后会自动重连。

**Q：个别指数一直显示 `--`？**
少数指数只有单一通道支持（例如中证2000 依赖东方财富）。若该通道被拦截，该指数会显示 `--`，其余正常。

**Q：关掉窗口后程序去哪了？**
在系统托盘。单击托盘图标显示 / 隐藏主窗口，右键可退出。

**Q：数据会上传吗？**
不会。程序不联网上传任何用户数据，所有配置仅存本机（`%APPDATA%\工位看盘\gongwei-stocks.json`）。

## 目录结构

```
src/
  main.js            主进程：窗口、托盘、热键、轮询、告警、IPC
  preload.js         contextBridge 桥（渲染层唯一入口）
  common/
    defaults.js      默认配置与内置指数清单
    providers.js     行情 / 搜索 Provider，含解析与多通道降级合并
  renderer/          主窗口（index.html / app.js / styles.css）
  float/             浮窗（float.html / float.js / float.css）
test/                自测脚本（npm test）
scripts/             构建辅助脚本（如从 CHANGELOG 生成 Release 说明）
docs/                开发文档
build/               应用图标（icon.ico / icon.png / icon.svg 源稿）
```

## 开发

架构、IPC 契约、存储 schema、Provider 扩展方式、编码约定与踩坑记录见 **[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)**。
版本变更见 **[CHANGELOG.md](CHANGELOG.md)**。

## 许可

[MIT](LICENSE)
