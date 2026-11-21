import { AppError, boundedString, requireObject } from './errors.mjs';
import { MAX_TIME_SECONDS } from '../public/time-range.js';

/** Concrete user placement stays authoritative; free delegates it to the current request. */
export function normalizeEditScope(input, assets) {
  if (input === undefined) return undefined;
  const value = requireObject(input, '剪辑范围');
  const scope = {};
  if (value.assetIds !== undefined) {
    if (!Array.isArray(value.assetIds) || value.assetIds.length > 100) throw new AppError(400, '最多选择100份素材。', 'INVALID_EDIT_SCOPE');
    scope.assetIds = [...new Set(value.assetIds.map(id => boundedString(id, '所选素材', 200)))];
    if (assets && scope.assetIds.some(id => !assets.some(asset => asset.id === id))) throw new AppError(400, '所选素材已变化，请重新选择。', 'EDIT_SCOPE_ASSET_MISSING');
  }
  const placement = requireObject(value.placement, '放置位置');
  if (!['append', 'insert', 'replace', 'range', 'free'].includes(placement.mode)) throw new AppError(400, '请选择放置位置或所选区间。', 'INVALID_EDIT_PLACEMENT');
  scope.placement = { mode: placement.mode };
  if (placement.mode === 'insert') {
    if (typeof placement.at !== 'number' || !Number.isFinite(placement.at) || placement.at < 0 || placement.at > MAX_TIME_SECONDS) throw new AppError(400, '请输入可精确表示的非负插入时间。', 'INVALID_EDIT_PLACEMENT');
    scope.placement.at = Math.round(placement.at * 1000) / 1000;
  }
  if (placement.mode === 'range') {
    if (typeof placement.start !== 'number' || typeof placement.end !== 'number' || !Number.isFinite(placement.start) || !Number.isFinite(placement.end) || placement.start < 0 || placement.end > MAX_TIME_SECONDS || placement.end - placement.start < .001) throw new AppError(400, '请框定有效区间，终点至少晚于起点1毫秒。', 'INVALID_EDIT_RANGE');
    scope.placement.start = Math.round(placement.start * 1000) / 1000;
    scope.placement.end = Math.round(placement.end * 1000) / 1000;
    if (scope.placement.end <= scope.placement.start) throw new AppError(400, '所选区间过短，请至少保留1毫秒。', 'INVALID_EDIT_RANGE');
    if (placement.clipIds !== undefined) {
      if (!Array.isArray(placement.clipIds) || placement.clipIds.length > 200 || placement.clipIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(id))) throw new AppError(400, '所选片段编号不正确，请重新框选。', 'INVALID_EDIT_RANGE');
      scope.placement.clipIds = [...new Set(placement.clipIds)];
    }
  }
  if (placement.mode === 'replace' && assets && scope.assetIds && assets.some(asset => !scope.assetIds.includes(asset.id))) throw new AppError(400, '选择部分素材时请使用末尾或指定位置插入，避免覆盖其它素材。', 'EDIT_SCOPE_REPLACE_REQUIRES_ALL');
  return scope;
}

export function scopedAssets(assets, scope) {
  return scope?.assetIds ? assets.filter(asset => scope.assetIds.includes(asset.id)) : assets;
}

export const addsTimeline = scope => Boolean(scope && ['append', 'insert'].includes(scope.placement.mode));

/** Only an explicit free choice lets a generated plan select concrete placement. */
export function resolveFreeEditScope(scope, placement, assets) {
  if (scope?.placement?.mode !== 'free') return scope;
  if (!placement || placement.mode === 'free') throw new AppError(400, '自由创作时请先为本次操作选择具体放置方式。', 'EDIT_PLACEMENT_UNRESOLVED');
  return normalizeEditScope({ ...scope, placement }, assets);
}
