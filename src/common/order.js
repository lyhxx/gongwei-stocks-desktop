// 工位看盘 - 拖拽排序的纯逻辑（方便单测）
// 前端拖完把「新的 id 顺序」发过来，这里校验是不是原集合的重排，然后落库。

// 校验 next 是 current 的一个完整排列，返回校验后的新数组
function reorderIds(current, next, label = '项') {
  if (!Array.isArray(current)) throw new Error(`${label}数据异常`);
  if (!Array.isArray(next)) throw new Error('排序参数必须是数组');
  if (next.length !== current.length) throw new Error(`排序列表长度与${label}数量不一致`);

  const pool = new Set(current);
  const seen = new Set();
  for (const id of next) {
    if (typeof id !== 'string' || !pool.has(id)) throw new Error(`排序列表含未知${label}：${id}`);
    if (seen.has(id)) throw new Error(`排序列表含重复${label}：${id}`);
    seen.add(id);
  }
  return next.slice();
}

// 自选排序：重排数组并重写 order 字段
function applyOrder(stocks, ids) {
  if (!Array.isArray(stocks)) throw new Error('自选数据异常');
  const byId = new Map(stocks.map((s) => [s.id, s]));
  return reorderIds(stocks.map((s) => s.id), ids, '自选')
    .map((id, i) => ({ ...byId.get(id), order: i }));
}

// 指数排序：selected 就是一个 id 数组
function applyIndexOrder(selected, ids) {
  return reorderIds(selected, ids, '指数');
}

module.exports = { reorderIds, applyOrder, applyIndexOrder };
