// 工位看盘 - 浮窗贴边吸附的纯几何计算（不依赖 Electron，方便单测）
//
// 坐标含义与 Electron BrowserWindow.getBounds() 一致：x/y 为窗口左上角，
// workArea 为当前显示器去掉任务栏后的可用区域。

const EDGES = ['left', 'right', 'top', 'bottom'];

// 找出离哪条边最近；超出阈值返回 null（表示没有贴边，需要自由浮动）
function nearestEdge(bounds, workArea, threshold = 20) {
  if (!bounds || !workArea) return null;
  const dist = {
    left: bounds.x - workArea.x,
    right: (workArea.x + workArea.width) - (bounds.x + bounds.width),
    top: bounds.y - workArea.y,
    bottom: (workArea.y + workArea.height) - (bounds.y + bounds.height),
  };
  let best = null;
  let bestV = Infinity;
  for (const e of EDGES) {
    if (dist[e] < bestV) { bestV = dist[e]; best = e; }
  }
  return bestV <= threshold ? best : null;
}

// 贴边：垂直于该边的那条轴不动（但要夹在可用区域内）
function snapToEdge(bounds, workArea, edge) {
  if (!edge) return { x: bounds.x, y: bounds.y };
  const out = { x: bounds.x, y: bounds.y };
  if (edge === 'left') out.x = workArea.x;
  else if (edge === 'right') out.x = workArea.x + workArea.width - bounds.width;
  else if (edge === 'top') out.y = workArea.y;
  else if (edge === 'bottom') out.y = workArea.y + workArea.height - bounds.height;
  // 另一条轴别跑出屏幕
  out.x = Math.min(Math.max(out.x, workArea.x), workArea.x + workArea.width - bounds.width);
  out.y = Math.min(Math.max(out.y, workArea.y), workArea.y + workArea.height - bounds.height);
  return { x: Math.round(out.x), y: Math.round(out.y) };
}

// 收起成小球时贴在左右侧边的位置：水平贴边，垂直保持原位置（夹紧）
function collapsedBounds(workArea, edge, size, currentY) {
  const side = edge === 'left' ? 'left' : 'right';
  const x = side === 'left' ? workArea.x : workArea.x + workArea.width - size;
  const maxY = workArea.y + workArea.height - size;
  const y = Math.min(Math.max(Math.round(currentY), workArea.y), maxY);
  return { x: Math.round(x), y };
}

// 只有左右两侧才适合收成小球（上下边收起来还得留一条，意义不大）
function canCollapse(edge) {
  return edge === 'left' || edge === 'right';
}

module.exports = { EDGES, nearestEdge, snapToEdge, collapsedBounds, canCollapse };
