#!/usr/bin/env node
// 从 CHANGELOG.md 截取指定版本的段落，生成 GitHub Release 的更新说明。
//
// 用法：
//   node scripts/release-notes.js               # 版本取 GITHUB_REF_NAME（如 v1.0.0）
//   node scripts/release-notes.js 1.0.0         # 指定版本
//   node scripts/release-notes.js --stdout      # 不写文件，直接打印
//
// CI 里写入 release-notes.md，再由 workflow 作为 Release body 上传。

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const changelogPath = path.join(root, 'CHANGELOG.md');
const outPath = path.join(root, 'release-notes.md');

function resolveVersion() {
  const args = process.argv.slice(2).filter((a) => a !== '--stdout');
  if (args[0]) return args[0];
  const fromEnv = process.env.GITHUB_REF_NAME || process.env.npm_package_version || '';
  return fromEnv;
}

function normalize(v) {
  return String(v).trim().replace(/^v/i, '');
}

// 支持 "## [1.0.0] - 2026-09-17"、"## [1.0.0]"、"## v1.0.0" 等写法
function extractSection(markdown, version) {
  const lines = markdown.split(/\r?\n/);
  const want = normalize(version);
  const head = new RegExp(`^##\\s+\\[?v?${want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]?\\b`);
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (head.test(lines[i])) { start = i; break; }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) { end = i; break; }
  }
  // 去掉标题行本身，只留内容
  return lines.slice(start + 1, end).join('\n').trim();
}

function main() {
  const version = resolveVersion();
  if (!version) {
    console.error('未能确定版本号：请传入参数或设置 GITHUB_REF_NAME');
    process.exit(1);
  }

  // tag 与 package.json 版本必须一致，避免发出版本号错乱的 Release
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (normalize(version) !== normalize(pkg.version)) {
    console.error(`版本不一致：tag/参数为 ${normalize(version)}，package.json 为 ${pkg.version}。请先同步版本号。`);
    process.exit(1);
  }

  if (!fs.existsSync(changelogPath)) {
    console.error(`找不到 ${changelogPath}`);
    process.exit(1);
  }
  const section = extractSection(fs.readFileSync(changelogPath, 'utf8'), version);
  if (!section) {
    console.error(`CHANGELOG.md 中找不到版本 ${version} 的段落，请在发版前补充该版本记录。`);
    process.exit(1);
  }
  const body = `## 工位看盘 ${normalize(version)}\n\n${section}\n`;
  if (process.argv.includes('--stdout')) {
    process.stdout.write(body);
    return;
  }
  fs.writeFileSync(outPath, body, 'utf8');
  console.log(`已生成 ${path.relative(root, outPath)}（版本 ${normalize(version)}，${body.length} 字符）`);
}

main();
