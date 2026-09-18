// 工位看盘 - 版本比较（纯函数，方便单测）
// 只处理发版实际会用到的形式：1.0.0 / v1.0.0 / 1.0.0-beta.1 / 1.0

function parseVersion(raw) {
  const s = String(raw == null ? '' : raw).trim().replace(/^v/i, '');
  if (!s) return null;
  const m = s.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+](.+))?$/);
  if (!m) return null;
  return {
    major: Number(m[1] || 0),
    minor: Number(m[2] || 0),
    patch: Number(m[3] || 0),
    pre: m[4] || '', // 预发布标识，如 beta.1
  };
}

// 返回 1 表示 a 更新，-1 表示 b 更新，0 表示相同
// 预发布版本小于同号的正式版（1.0.0-beta < 1.0.0），与 semver 一致
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  for (const k of ['major', 'minor', 'patch']) {
    if (pa[k] !== pb[k]) return pa[k] > pb[k] ? 1 : -1;
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre > pb.pre ? 1 : -1;
}

function isNewer(latest, current) {
  return compareVersions(latest, current) > 0;
}

// 从 GitHub Release 响应里挑出安装包等可直接下载的资产
function pickDownloadAsset(release) {
  const assets = (release && release.assets) || [];
  const prefer = ['portable.exe', 'setup-x64.exe', 'win-x64.zip'];
  for (const suffix of prefer) {
    const hit = assets.find((a) => a && typeof a.name === 'string' && a.name.endsWith(suffix));
    if (hit) return { name: hit.name, url: hit.browser_download_url, size: hit.size };
  }
  return null;
}

module.exports = { parseVersion, compareVersions, isNewer, pickDownloadAsset };
