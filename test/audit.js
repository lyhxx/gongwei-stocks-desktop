// 静态审计：元素引用、IPC/桥接一致性、版本一致性
// 跑法：node test/audit.js（已并入 npm test）
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const rendererHtml = read('src/renderer/index.html');
const floatHtml = read('src/float/float.html');
const chartHtml = read('src/chart/chart.html');
const alertHtml = read('src/alert/alert.html');
const appJs = read('src/renderer/app.js');
const floatJs = read('src/float/float.js');
const chartJs = read('src/chart/chart.js');
const alertJs = read('src/alert/alert.js');
const preload = read('src/preload.js');
const mainJs = read('src/main.js');
const chromeJs = read('src/shared/chrome.js');
const themeCss = read('src/shared/theme.css');
const pkg = JSON.parse(read('package.json'));
const readme = read('README.md');

const problems = [];

// html 里的 id + js 动态模板里的 id（弹窗 / toast 等）
const idsFromHtml = (h) => [...h.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
const idsFromJs = (js) => [
  ...[...js.matchAll(/id="([^"]+)"/g)].map((m) => m[1]),
  ...[...js.matchAll(/\.id\s*=\s*'([^']+)'/g)].map((m) => m[1]),
];
const refsFromJs = (js) => [
  ...[...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]),
  ...[...js.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]),
];

function checkDom(label, html, js) {
  const known = new Set([...idsFromHtml(html), ...idsFromJs(js)]);
  for (const id of new Set(refsFromJs(js))) {
    if (!known.has(id)) problems.push(`${label} 引用了不存在的元素 #${id}`);
  }
}
checkDom('renderer', rendererHtml, appJs);
checkDom('float', floatHtml, floatJs);
checkDom('chart', chartHtml, chartJs);
checkDom('alert', alertHtml, alertJs);

// preload 暴露面 ↔ 业务代码调用面
const exposed = new Set([...preload.matchAll(/^\s{2}([a-zA-Z]\w*):/gm)].map((m) => m[1]));
for (const [label, js] of [['renderer', appJs], ['float', floatJs], ['chart', chartJs], ['alert', alertJs], ['chrome', chromeJs]]) {
  for (const m of js.matchAll(/window\.gongwei\.([a-zA-Z]\w*)/g)) {
    if (!exposed.has(m[1])) problems.push(`${label} 使用了未暴露的 window.gongwei.${m[1]}`);
  }
}

// preload ↔ ipcMain 通道一一对应
const channels = new Set([...mainJs.matchAll(/ipcMain\.(?:handle|on)\('([^']+)'/g)].map((m) => m[1]));
const invoked = new Set([...preload.matchAll(/ipcRenderer\.(?:invoke|send)\('([^']+)'/g)].map((m) => m[1]));
for (const c of channels) if (!invoked.has(c)) problems.push(`主进程注册但 preload 未使用：${c}`);
for (const c of invoked) if (!channels.has(c)) problems.push(`preload 调用但主进程未注册：${c}`);

// 版本 / 文档一致性
if (!readme.includes('CHANGELOG.md')) problems.push('README 未链接到 CHANGELOG.md');
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) problems.push(`package.json 版本号不是 x.y.z：${pkg.version}`);
const changelog = read('CHANGELOG.md');
if (!new RegExp(`^##\\s+\\[?v?${pkg.version.replace(/\./g, '\\.')}\\]?`, 'm').test(changelog)) {
  problems.push(`CHANGELOG.md 缺少 ${pkg.version} 的版本段落（CI 发版会因此失败）`);
}
if (!readme.includes('DEVELOPMENT.md')) problems.push('README 未链接到开发文档');

// Markdown 表格单元格别太长：渲染时会把列挤窄导致折行，长说明应放到表格外的列表
const displayWidth = (s) => [...s].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
for (const doc of ['README.md', 'CHANGELOG.md', 'docs/DEVELOPMENT.md']) {
  read(doc).split(/\r?\n/).forEach((line, i) => {
    if (line.startsWith('|') && displayWidth(line) > 110) {
      problems.push(`${doc}:${i + 1} 表格行过宽（${displayWidth(line)} 列），渲染会折行，请把长说明移到表格外`);
    }
  });
}

// 危险用法排查
for (const [label, js] of [['renderer', appJs], ['float', floatJs]]) {
  if (/innerHTML\s*=\s*[^`'"]*(?:stock|quote|search|\bname\b)/.test(js) && !js.includes('escapeHtml')) {
    problems.push(`${label} 可能有未转义的 innerHTML 注入`);
  }
}
if (/nodeIntegration\s*:\s*true/.test(mainJs)) problems.push('main.js 开启了 nodeIntegration');
if (/contextIsolation\s*:\s*false/.test(mainJs)) problems.push('main.js 关闭了 contextIsolation');

// 主题必须同时作用到原生窗口：只改网页内部的话，Windows 标题栏会一直是浅色
if (!/nativeTheme\.themeSource\s*=/.test(mainJs)) {
  problems.push('main.js 未同步 nativeTheme.themeSource，深色模式下渲染层不会跟着变');
}
// ---------- 无边框窗口（frameless）----------
// 四个窗口都是自绘标题栏：必须关掉系统边框，否则会又冒出一条系统标题栏
if (!/frame:\s*false/.test(mainJs)) {
  problems.push('main.js 未关闭系统边框（frame:false），窗口不是无边框的');
}
// 必须透明，否则圆角外会露出直角（不透明窗口按矩形绘制，CSS 圆角只裁内容）
if (!/transparent:\s*true/.test(mainJs)) {
  problems.push('main.js 未开启透明窗口（transparent:true），圆角外会露出直角');
}
// 透明窗口一旦被刷不透明底色，透明区会被填实、圆角外露直角（浮窗踩过这个坑）
for (const m of mainJs.matchAll(/setBackgroundColor\(/g)) {
  const ctx = mainJs.slice(Math.max(0, m.index - 220), m.index + 80);
  if (/(mainWin|floatWin|chartWin|alertWin)/.test(ctx)) {
    problems.push('main.js 给透明窗口设置了 backgroundColor：透明区会被填实，圆角外会露出直角');
  }
}
// 窗口外壳不要加外阴影：transparent 窗口的绘制范围就是窗口矩形，
// box-shadow 溢出部分会被裁掉，留边距当画布又会被裁成一圈生硬的暗边
const chromeCss = read('src/shared/chrome.css');
if (/\.win\s*\{[^}]*box-shadow/.test(chromeCss)) {
  problems.push('shared/chrome.css：窗口外壳不要加 box-shadow（会被窗口边界裁成一圈暗边）');
}
// 窗口 = 内容，不留透明边距（那圈边距会挡住点击，且没有阴影就纯属浪费）
if (/body\.framed\s*\{[^}]*padding/.test(chromeCss)) {
  problems.push('shared/chrome.css：body.framed 不应留 padding 边距（窗口应当等于内容）');
}
// 浮窗右键要给自己的一套菜单，而不是系统默认菜单
if (!/floatWin\.webContents\.on\('context-menu'/.test(mainJs) || !/function showFloatMenu\(/.test(mainJs)) {
  problems.push('浮窗右键菜单未实现（应拦截 context-menu 并弹出自己的菜单）');
}

// 请求必须走 common/http.js 统一出口，否则换成 net.fetch 后代理会失效
const providers = read('src/common/providers.js');
if (/(?<![\w.])fetch\s*\(/.test(providers.replace(/fetchWithTimeout\s*\(/g, ''))) {
  problems.push('providers.js 里有裸 fetch( 调用，应统一用 common/http.js 的 fetchWithTimeout（否则代理不生效）');
}

// 指数 id ↔ 前端中文名映射必须一一对应（漏一个界面就显示英文 id）
const defaults = require(path.join(root, 'src/common/defaults.js'));
const indexIds = defaults.INDICES.map((i) => i.id);
function nameKeys(js) {
  const block = js.match(/INDEX_NAMES\s*=\s*\{([\s\S]*?)\}/);
  if (!block) return [];
  return [...block[1].matchAll(/([a-zA-Z]\w*)\s*:/g)].map((m) => m[1]);
}
for (const [label, js] of [['renderer', appJs], ['float', floatJs]]) {
  const keys = new Set(nameKeys(js));
  for (const id of indexIds) if (!keys.has(id)) problems.push(`${label} 缺少指数名称映射：${id}`);
}
// 指数代码不能重复
const codes = defaults.INDICES.map((i) => `${i.exchange}.${i.code}`);
if (new Set(codes).size !== codes.length) problems.push('内置指数存在重复代码');

// hidden 兜底：任何带 display 的元素用 hidden 隐藏时都必须真的不显示
// 这条规则放在共享主题层（四个窗口都引用了它），保证到处都生效
if (!/\[hidden\]\s*\{\s*display:\s*none\s*!important/.test(themeCss)) {
  problems.push('shared/theme.css 缺少全局兜底规则：[hidden] { display: none !important; }');
}
// 被 JS 用 .hidden 控制的静态 id，其样式若声明了 display 就必须有 [hidden] 同伴
const styles = read('src/renderer/styles.css');
const hiddenIdClasses = {};
for (const m of rendererHtml.matchAll(/<[^>]*id="([^"]+)"[^>]*class="([^"]*)"[^>]*hidden[^>]*>/g)) {
  hiddenIdClasses[m[1]] = m[2].split(/\s+/).filter(Boolean);
}
for (const m of rendererHtml.matchAll(/<[^>]*class="([^"]*)"[^>]*id="([^"]+)"[^>]*hidden[^>]*>/g)) {
  hiddenIdClasses[m[2]] = m[1].split(/\s+/).filter(Boolean);
}
for (const [id, classes] of Object.entries(hiddenIdClasses)) {
  for (const cls of classes) {
    const displayRe = new RegExp(`\\.${cls}\\s*\\{[^}]*display:\\s*(grid|flex|block|inline-flex)`, 's');
    if (displayRe.test(styles) && !new RegExp(`\\.${cls}\\[hidden\\]`).test(styles)) {
      problems.push(`.${cls} 有 display 声明但无 .${cls}[hidden] 规则，hidden 会失效（#${id}）`);
    }
  }
}

console.log(`元素引用、桥接(${exposed.size} 个)、IPC(${channels.size} 条)、指数(${indexIds.length} 个)、版本 ${pkg.version} 检查完毕`);
console.log(problems.length ? '\n发现问题：\n- ' + problems.join('\n- ') : '静态审计：全部通过');
process.exitCode = problems.length ? 1 : 0;
