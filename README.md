# 工位看盘 · gongwei-stocks-desktop

> 余光一扫，涨跌了然。隐蔽、轻量的 Windows 桌面股票行情提醒助手。

基于 Electron 构建，常驻系统托盘，提供自选行情、指数看板、桌面浮窗、价格提醒与全局热键。不登录、不上传、无账号体系，行情直连公开接口，配置只存本机。

[![build-win](https://github.com/lyhxx/gongwei-stocks-desktop/actions/workflows/build-win.yml/badge.svg)](https://github.com/lyhxx/gongwei-stocks-desktop/actions/workflows/build-win.yml)
![platform](https://img.shields.io/badge/platform-Windows-0078d4)
![license](https://img.shields.io/badge/license-MIT-green)

---

**目录** ：[功能](#功能) · [快速开始](#快速开始) · [使用说明](#使用说明) · [数据来源](#数据来源与容错) · [路线图](#路线图) · [常见问题](#常见问题) · [开发](#开发)

## 功能

| 模块 | 一句话 |
| --- | --- |
| 自选 | 代码 / 名称 / 拼音联想添加 |
| 指数 | 14 个内置指数，勾选启停 |
| 浮窗 | 透明置顶，指数在上个股在下 |
| 提醒 | 价格 / 涨跌幅共四种条件 |
| 通道 | 桌面通知 + 声音 |
| 外观 | 明暗主题 + 定制滚动条 |
| 常驻 | 托盘图标 + 全局热键 |
| 诊断 | 通道状态 + 接口自检 |

几个做得比较细的地方：

- **联想搜索**：输入 `600000` / `茅台` / `gzmt` 都能命中，停 400ms 自动出下拉，回车即加
- **三通道容错**：东财、新浪、腾讯并行取数、按只合并，一家挂了另外两家自动补上
- **浮窗自适应**：高度贴合内容，不留透明死区挡住下方窗口的点击
- **提醒不轰炸**：同一只股票 5 分钟内只提醒一次，支持暂停 30 分钟
- **诊断说人话**：状态灯一点即知数据来自哪条通道、哪个通道为什么失败

## 快速开始

### 直接使用

到 [Releases](https://github.com/lyhxx/gongwei-stocks-desktop/releases) 任选：

| 类型 | 文件名 | 用途 |
| --- | --- | --- |
| 安装版 | `*-setup-x64.exe` | 安装到系统，带开始菜单与桌面快捷方式 |
| 绿色单文件 | `*-portable.exe` | 免安装，双击即用 |
| 绿色解压版 | `*-win-x64.zip` | 免安装，解压后运行 |

> 完整文件名形如 `gongwei-stocks-desktop-1.0.0-setup-x64.exe`。文件名用 ASCII 是为了兼容 GitHub Releases 的资产命名限制，程序内显示名与快捷方式仍是「工位看盘」。
>
> 未购买代码签名证书，首次运行 Windows 会提示「未知发布者」，点「更多信息 → 仍要运行」即可。

### 从源码运行

```bash
git clone https://github.com/lyhxx/gongwei-stocks-desktop.git
cd gongwei-stocks-desktop
npm install
npm start
```

### 自测与打包

```bash
npm test     # 静态审计 + 行情解析联调 + DOM 交互回归，共 3 组 60+ 项断言，离线可跑
npm run dist # 一次产出安装版 / 绿色单文件 / 绿色解压版
```

构建与发版细节见 [开发文档](docs/DEVELOPMENT.md)。

## 使用说明

| 操作 | 方式 |
| --- | --- |
| 添加自选 | 自选标题右侧输入框，回车或点下拉项 |
| 切换浮窗 | `Ctrl+Shift+M`，或顶栏「浮窗」 |
| 隐藏浮窗 | `Esc` |
| 开关提醒 | 股票行尾的 🔔 |
| 展开提醒条件 | 股票行尾的 `›` |
| 查看诊断 | 点状态灯，或异常时的黄色小喇叭 |
| 退出程序 | 托盘图标右键 → 退出 |

> 关闭窗口只是隐藏到托盘，不会退出程序。

## 数据来源与容错

行情按 **东方财富 → 新浪 → 腾讯** 三路并行拉取、按只合并：谁先回来先用谁，还能互补；任一通道挂掉不影响其他。搜索按 **腾讯 → 东财 → 新浪 → 雪球 → 纯代码直通** 五层兜底。

| 通道 | 地址 | 覆盖 |
| --- | --- | --- |
| 东方财富 | `push2.eastmoney.com` | A股 / 港股 / 美股 / 指数（主力） |
| 新浪 | `hq.sinajs.cn` | A股 / 指数 |
| 腾讯 | `qt.gtimg.cn` | A股 / 指数 |

东财备用域名 `push2delay.eastmoney.com`，新浪与腾讯优先走 HTTPS。桌面端无 CORS 限制，直接请求，需带 `Referer` 与浏览器 UA。所有请求指向公开行情接口，仅用于个人学习与自用。

## 路线图

### 近期

- [ ] **ETF / 场内基金适配** — 自选支持 ETF、LOF、可转债，区分品种类型，补充折溢价率与 IOPV
- [ ] **浮窗贴边吸附** — 拖到屏幕边缘自动吸附，可收起成小圆圈，鼠标移入再展开
- [ ] **检查更新** — 应用内检查 Releases 新版本并提示下载
- [ ] **代理设置** — HTTP / SOCKS5 代理，解决公司网络拦截行情站点导致的全通道超时
- [ ] **自选拖拽排序** — 替换现在的 `↑ ↓` 按钮，支持跨分组拖动

### 中期

- [ ] **K 线 / 分时图** — 接入日线与分时数据，浮窗与详情页都可看图
- [ ] **分组管理** — 多自选列表（持仓 / 观察），浮窗按分组切换
- [ ] **持仓与盈亏** — 记录成本价与数量，统计今日盈亏、持仓盈亏、总资产
- [ ] **提醒增强** — 成交量异动、涨跌停、N 分钟急涨急跌、分时均线突破
- [ ] **老板键** — 一键隐藏全部窗口（含浮窗），托盘图标可切换伪装样式
- [ ] **数据备份** — 自选与设置导出 / 导入 JSON，方便换机

### 长期

- [ ] **绿色版数据本地化** — 便携版把配置写在 exe 同级目录，U 盘可用
- [ ] **自动更新** — 接入 `electron-updater` 静默增量更新
- [ ] **多显示器与位置记忆** — 浮窗记忆所在屏幕与坐标
- [ ] **跨平台** — macOS / Linux 适配（当前仅 Windows）
- [ ] **覆盖率看板** — 测试覆盖率阈值与 PR 检查

有想加的功能或遇到问题，欢迎开 [Issue](https://github.com/lyhxx/gongwei-stocks-desktop/issues)。

## 常见问题

### 状态显示「来源 none / 异常 3 条」？

三个通道同时超时，基本是网络问题：断网、切换网络中，或公司网络 / 代理拦截了行情站点。点状态灯看诊断详情，网络恢复后会自动重连。

### 个别指数一直显示 `--`？

少数指数只有单一通道支持（例如中证2000 依赖东方财富）。该通道被拦截时这几个指数会显示 `--`，其余正常。

### 关掉窗口后程序去哪了？

在系统托盘。单击托盘图标显示 / 隐藏主窗口，右键可退出。

### 数据会上传吗？

不会。程序不联网上传任何用户数据，配置仅存本机 `%APPDATA%\工位看盘\gongwei-stocks.json`。

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
scripts/             构建辅助脚本（打包配置校验、Release 说明生成）
docs/                开发文档
build/               应用图标（icon.ico / icon.png / icon.svg 源稿）
```

## 开发

* 架构、IPC 契约、存储 schema、Provider 扩展方式、编码约定与踩坑记录：[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)
* 版本变更记录：[CHANGELOG.md](CHANGELOG.md)
* 发版流程：改 `CHANGELOG.md` 与 `package.json` 版本 → 打 tag → CI 自动构建并发布

## 许可

[MIT](LICENSE)
