// 工位看盘 - 自选排序的纯逻辑（方便单测）
// 前端拖拽结束后把「新的 id 顺序」发过来，这里做校验并重排。

function applyOrder(stocks, ids) {
  if (!Array.isArray(stocks)) throw new Error('自选数据异常');
  if (!Array.isArray(ids)) throw new Error('排序参数必须是数组');

  const byId = new Map(stocks.map((s) => [s.id, s]));
  if (ids.length !== stocks.length) throw new Error('排序列表长度与自选不一致');
  const seen = new Set();
  for (const id of ids) {
    if (typeof id !== 'string' || !byId.has(id)) throw new Error(`排序列表含未知自选：${id}`);
    if (seen.has(id)) throw new Error(`排序列表含重复项：${id}`);
    seen.add(id);
  }
  return ids.map((id, i) => {
    const s = byId.get(id);
    return { ...s, order: i };
  });
}

module.exports = { applyOrder };
