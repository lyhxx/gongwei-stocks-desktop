// 工位看盘 - 价格提醒独立窗口
// 读取/保存某只自选的 alert 条件。改动即时保存（防抖），保存按钮可立即落库。
let state = null;
let stock = null;
let saveTimer = null;

const $ = (id) => document.getElementById(id);

function applyTheme() {
  const t = (state && state.settings && state.settings.main && state.settings.main.theme) || 'system';
  const dark = t === 'dark' || (t !== 'light' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

function alertOf() {
  const s = (state && Array.isArray(state.stocks) ? state.stocks : []).find((x) => x.id === (stock && stock.id));
  return (s && s.alert) || {};
}

function numOrNull(id) {
  const v = $(id).value.trim();
  if (v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function fill() {
  if (!stock) return;
  const a = alertOf();
  $('alertTitle').textContent = `${stock.name} ${stock.code}`;
  $('alEnabled').checked = !!a.enabled;
  $('alUpper').value = a.upperPrice ?? '';
  $('alLower').value = a.lowerPrice ?? '';
  $('alUpPct').value = a.upperChangePercent ?? '';
  $('alDownPct').value = a.lowerChangePercent ?? '';
  $('alLimitUp').checked = !!a.limitUp;
  $('alLimitDown').checked = !!a.limitDown;
  $('alVolAnomaly').checked = !!a.volumeAnomaly;
  $('alVolRatio').value = a.volumeRatio ?? 2;
  $('alRapid').checked = !!a.rapidEnabled;
  $('alRapidMin').value = a.rapidMinutes ?? 5;
  $('alRapidPct').value = a.rapidPercent ?? 3;
  $('alStatus').textContent = '';
}

function collect() {
  const patch = {
    enabled: $('alEnabled').checked,
    upperPrice: numOrNull('alUpper'),
    lowerPrice: numOrNull('alLower'),
    upperChangePercent: numOrNull('alUpPct'),
    lowerChangePercent: (() => { const v = numOrNull('alDownPct'); return v === null ? null : Math.abs(v); })(),
    limitUp: $('alLimitUp').checked,
    limitDown: $('alLimitDown').checked,
    volumeAnomaly: $('alVolAnomaly').checked,
    volumeRatio: numOrNull('alVolRatio') ?? 2,
    rapidEnabled: $('alRapid').checked,
    rapidPercent: (() => { const v = numOrNull('alRapidPct'); return v === null ? 3 : Math.abs(v); })(),
    rapidMinutes: numOrNull('alRapidMin') ?? 5,
  };
  return patch;
}

async function save(silent) {
  if (!stock) return;
  try {
    await window.gongwei.updateAlert(stock.id, collect());
    state = await window.gongwei.getStore();
    fill();
    if (!silent) $('alStatus').textContent = '已保存';
  } catch (e) {
    $('alStatus').textContent = `保存失败：${e.message}`;
  }
}

function scheduleSave() {
  $('alStatus').textContent = '';
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => save(true), 400);
}

async function boot() {
  state = await window.gongwei.getStore();
  applyTheme();
  stock = await window.gongwei.getAlertStock();
  if (!stock) { $('alStatus').textContent = '没有可设置的标的'; return; }
  fill();

  // 任意改动即时保存
  document.querySelectorAll('input').forEach((el) => {
    el.addEventListener('input', scheduleSave);
    el.addEventListener('change', scheduleSave);
  });
  $('alSave').onclick = () => save(false);
  $('alDelete').onclick = async () => {
    try {
      await window.gongwei.removeStock(stock.id);
      window.close();
    } catch (e) { $('alStatus').textContent = `删除失败：${e.message}`; }
  };

  window.gongwei.onStore((s) => { state = s; applyTheme(); });
  window.gongwei.onAlertUpdate((s) => { if (s) { stock = s; fill(); } });
}

boot();
