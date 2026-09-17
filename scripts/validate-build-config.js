// 校验 package.json 里 electron-builder 的配置是否符合 schema（不下载任何二进制，秒级完成）
// 用法：node scripts/validate-build-config.js
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const validate = require('@develar/schema-utils');
const schema = require('app-builder-lib/scheme.json');

const problems = [];
const config = pkg.build || {};

// 1. 顶层不允许出现未定义的键（build.zip 这种踩坑点在这里就会被拦下）
const allowed = new Set(Object.keys(schema.properties || {}));
for (const key of Object.keys(config)) {
  if (!allowed.has(key)) problems.push(`build.${key} 不是合法的 electron-builder 字段`);
}

// 2. 交给官方 schema 做完整校验
try {
  validate(schema, config, { name: 'electron-builder', allowUnknown: false });
} catch (e) {
  problems.push(String(e.message).split('\n').slice(0, 8).join('\n'));
}

// 3. 产物命名不能重复（撞名会互相覆盖）
const names = [
  config.win && config.win.artifactName,
  config.nsis && config.nsis.artifactName,
  config.portable && config.portable.artifactName,
].filter(Boolean);
if (new Set(names).size !== names.length) problems.push('artifactName 存在重复，产物会互相覆盖');

// 4. 打包文件清单里引用的资源必须真实存在
for (const pattern of (config.files || [])) {
  if (pattern.includes('*')) continue;
  if (!fs.existsSync(path.join(root, pattern))) problems.push(`build.files 引用了不存在的文件：${pattern}`);
}
if (config.win && config.win.icon && !fs.existsSync(path.join(root, config.win.icon))) {
  problems.push(`图标不存在：${config.win.icon}`);
}

console.log(problems.length
  ? '构建配置有问题：\n- ' + problems.join('\n- ')
  : `构建配置校验通过（${names.length} 个产物命名，打包清单与图标齐全）`);
process.exitCode = problems.length ? 1 : 0;
