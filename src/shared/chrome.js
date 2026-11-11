// 工位看盘 - 共享窗口装饰层行为（主界面 / K线 / 提醒窗口共用）
//
// 负责：无边框窗口的标题栏按钮、双击最大化、铺满状态同步、8 向缩放手柄。
//
// 约束（别改）：
// 1. 这里一律用属性选择器（[data-win-btn] / [data-resize]），不要用 $('#id')：
//    同一份代码要跑在四个窗口里，用 id 会和每个窗口自己的元素冲突，
//    也会让 test/audit.js 的「元素引用存在性」检查误报。
// 2. 桥接方法要判空再调：测试环境的 mock 桥接不一定有窗口控制方法。

(function () {
  const api = window.gongwei;
  if (!api) return;

  const doc = document;
  const root = doc.documentElement;

  // ---------- 最大化 / 铺满状态 ----------
  function setMaximized(on) {
    root.classList.toggle('win-maximized', !!on);
  }
  if (typeof api.onWinState === 'function') {
    api.onWinState((s) => setMaximized(s && s.maximized));
  }
  if (typeof api.winState === 'function') {
    api.winState().then((s) => setMaximized(s && s.maximized)).catch(() => {});
  }

  // ---------- 窗口按钮 ----------
  const BTN_ACTIONS = {
    minimize: () => api.winMinimize && api.winMinimize(),
    close: () => api.winClose && api.winClose(),
  };
  doc.querySelectorAll('[data-win-btn]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const fn = BTN_ACTIONS[btn.getAttribute('data-win-btn')];
      if (fn) fn();
    });
  });

  // 注：标题栏只有「最小化 / 关闭」两个按钮，没有最大化（对这种小工具用处不大）。
  // 要铺满用 Windows 自己的 Win+↑ 或拖到屏幕顶部，系统最大化后会自动去掉圆角。

  // ---------- 缩放手柄 ----------
  // 手柄元素是静态的（不会像自选列表那样被重建），所以可以用 setPointerCapture
  // 保证指针移出窗口后仍能收到 move/up。
  const raf = window.requestAnimationFrame || ((cb) => setTimeout(cb, 16));
  const caf = window.cancelAnimationFrame || ((id) => clearTimeout(id));
  let rs = null;
  let pending = null;
  let rafId = 0;

  function onResizeMove(e) {
    if (!rs) return;
    if (rs.pointerId != null && e.pointerId != null && e.pointerId !== rs.pointerId) return;
    pending = { dir: rs.dir, dx: e.clientX - rs.x, dy: e.clientY - rs.y };
    if (rafId) return;
    rafId = raf(() => {
      rafId = 0;
      if (pending && typeof api.winResize === 'function') {
        try { api.winResize(pending); } catch { /* 忽略 */ }
      }
    });
  }

  function onResizeEnd() {
    if (!rs) return;
    rs = null;
    if (rafId) { caf(rafId); rafId = 0; }
    doc.body.classList.remove('resizing-active');
    window.removeEventListener('pointermove', onResizeMove, true);
    window.removeEventListener('pointerup', onResizeEnd, true);
    window.removeEventListener('pointercancel', onResizeEnd, true);
  }

  doc.querySelectorAll('[data-resize]').forEach((handle) => {
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      rs = {
        dir: handle.getAttribute('data-resize'),
        x: e.clientX,
        y: e.clientY,
        pointerId: e.pointerId,
      };
      doc.body.classList.add('resizing-active');
      try { handle.setPointerCapture(e.pointerId); } catch { /* jsdom 没有就算了 */ }
      window.addEventListener('pointermove', onResizeMove, true);
      window.addEventListener('pointerup', onResizeEnd, true);
      window.addEventListener('pointercancel', onResizeEnd, true);
    });
  });
})();
