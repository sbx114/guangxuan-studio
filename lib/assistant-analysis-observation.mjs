const privateKey = /^(?:settings|api_?key|authorization|access_?token|refresh_?token|password|secret|client_?secret|credentials|cookie|set-cookie)$/i;

/** Keep analysis paging usable when rich cues exceed the model's response budget. */
export function compactAnalysisObservation(value, { clean = String, budget = 22000 } = {}) {
  const source = value?.data || {}, originals = Array.isArray(source.items) ? source.items : [];
  const projectPage = source.assetPagination?.mode === 'project-page';
  const compact = (item, textLimit, arrayLimit, depth = 0) => {
    if (depth > 12) return { detailsIncomplete: true };
    if (typeof item === 'string') return clean(item).slice(0, textLimit);
    if (Array.isArray(item)) return item.slice(0, arrayLimit).map(entry => compact(entry, textLimit, arrayLimit, depth + 1));
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(Object.entries(item).filter(([key]) => !privateKey.test(key)).map(([key, entry]) => [key,
      typeof entry === 'string' && /^(?:id|assetId|shotId|frameId|sha256|sourceSha256|kind|status)$/.test(key) ? clean(entry) : compact(entry, textLimit, arrayLimit, depth + 1),
    ]));
  };
  const data = {
    assetPagination: compact(source.assetPagination, 200, 24),
    sourceWindows: compact(source.sourceWindows, 200, 24),
    items: originals.map(item => ({ ...compact(item, 140, 24), assetId: clean(item.assetId || ''), detailsIncomplete: true })),
    warnings: compact(source.warnings, 200, 5),
    responsePartial: true,
    sourceReturnedItems: originals.length,
    sourceNextAssetOffset: source.assetPagination?.nextAssetOffset ?? null,
    responseNote: '本轮上下文省略了部分分析细节。使用所列真实assetId按小批次读取同范围的分析；后端next页只表示处理进度，省略的细节尚未在本轮呈现。',
  };
  const result = { summary: clean(value.summary || '已读取素材分析页。').slice(0, 500), data };
  const size = () => JSON.stringify(result).length;
  if (size() > budget - 1000) data.items = originals.map(item => ({ ...compact(item, 70, 12), assetId: clean(item.assetId || ''), detailsIncomplete: true }));
  if (size() > budget - 1000) data.items = originals.map(item => ({ ...compact(item, 48, 6), assetId: clean(item.assetId || ''), detailsIncomplete: true }));
  while (data.items.length && size() > budget - 1000) data.items.pop();
  data.responseReturnedItems = data.items.length;
  data.responseOmittedAssetIds = originals.slice(data.items.length).map(item => clean(item.assetId || ''));
  data.responseNextAssetOffset = projectPage && data.items.length < originals.length ? source.assetPagination.offset + data.items.length : source.assetPagination?.nextAssetOffset ?? null;
  return result;
}
