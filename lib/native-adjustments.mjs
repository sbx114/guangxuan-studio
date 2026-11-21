import { createHash, randomUUID } from 'node:crypto';
import { AppError } from './errors.mjs';
import { normalizeEditScope } from './edit-scope.mjs';
import { MAX_TIME_SECONDS } from '../public/time-range.js';
import { applyPictureEffects } from './openfilm-placement.mjs';
import { clipSpan, clipFade, kindOf, declarations, readFilm } from '../integrations/openfilm/packages/openfilm/src/film-doc.mjs';
import { MOTION_PROPS, EASES, animationsOf, withAnimations, motionName, readMotion } from '../integrations/openfilm/packages/openfilm/src/clip-motion.mjs';
import { applyOps } from '../integrations/openfilm/packages/openfilm/studio/server/ops.mjs';

const round = value => Math.round(value * 1000) / 1000;
const failure = (message, code = 'NATIVE_ADJUST_INVALID', status = 400) => new AppError(status, message, code);
export const NATIVE_ADJUST_ACTIONS = ['split', 'trim', 'move', 'remove', 'duplicate', 'speed', 'volume', 'fade', 'transform', 'look', 'motion', 'caption'];
export const NATIVE_MAX_TIME_SECONDS = MAX_TIME_SECONDS;
const fields = {
  split: ['at'], trim: ['start', 'end'], move: ['at'], remove: [], duplicate: ['at'], speed: ['value'], volume: ['value'],
  fade: ['in', 'out'], transform: ['x', 'y', 'width', 'height', 'scale', 'rotation', 'opacity'], look: ['preset', 'strength'],
  motion: ['property', 'keys', 'mode', 'replaceAll', 'expectedMotionHash'], caption: ['text', 'fontSize', 'color', 'fontWeight', 'align', 'placement'],
};
function finite(value, label, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw failure(`${label}须在${min}至${max}之间。`);
  return round(value);
}
function localSource(src) { return typeof src === 'string' && !/^[a-z][a-z0-9+.-]*:|^[\\/]/i.test(src) && !src.split(/[\\/]/).some(part => part === '..' || part.startsWith('.')); }
function allItems(doc, known) {
  return (doc.tracks || []).flatMap((track, trackIndex) => (track.clips || []).map(clip => {
    let span;
    try { span = clipSpan(clip, known[clip.src]?.duration); } catch { span = null; }
    const at = Number(clip.at || 0), kind = kindOf(clip);
    return { clip, track, trackIndex, at, kind, span, end: span ? round(at + span.length) : null, assetId: known[clip.src]?.assetId };
  }));
}
export function nativeTimelineDuration(doc, known = {}) {
  return round(allItems(doc, known).reduce((duration, item) => !item.track.hidden && !item.clip.disabled && Number.isFinite(item.end) ? Math.max(duration, item.end) : duration, 0));
}
export function nativeTimelineEditLimits(doc, known = {}) {
  const existingTimelineSeconds = nativeTimelineDuration(doc, known);
  return { existingTimelineSeconds, newTimelineMaxSeconds: NATIVE_MAX_TIME_SECONDS, maxEditedTimelineSeconds: NATIVE_MAX_TIME_SECONDS, maxSourceTimeSeconds: NATIVE_MAX_TIME_SECONDS, maxScopeCoordinateSeconds: NATIVE_MAX_TIME_SECONDS, maxSelectedRangeSeconds: NATIVE_MAX_TIME_SECONDS, legacyExportRangeMaxSeconds: NATIVE_MAX_TIME_SECONDS, maxOperations: 40, maxExplicitGroupClipIds: 200, maxMotionKeysPerEdit: 40, maxMotionReadKeys: 200, note: '时间范围依据实际素材、工程结构及本轮明确要求核对；数值上限只用于保证毫秒精度。操作和关键帧可分批继续处理。' };
}
export const nativeMotionHash = keys => createHash('sha256').update(JSON.stringify(keys.map(key => ({ t: key.t, v: key.v, ease: key.ease || 'linear' })))).digest('hex');
function motionView(item, doc, page) {
  const original = readMotion(item.clip, doc.keyframes), properties = page.motionProperty ? [page.motionProperty] : Object.keys(original), motion = {}, coverage = {};
  const offset = page.motionKeyOffset || 0, limit = page.motionKeyLimit || 40;
  for (const property of properties) {
    const keys = original[property] || [], selected = keys.slice(offset, offset + limit), hasMore = offset + selected.length < keys.length;
    motion[property] = selected.map(key => ({ time: key.t, ...(Array.isArray(key.v) ? { x: key.v[0], y: key.v[1] } : { value: key.v }), ...(key.ease ? { easing: key.ease } : {}) }));
    coverage[property] = { totalKeys: keys.length, returnedKeys: selected.length, offset, limit, hasMore, nextOffset: hasMore ? offset + selected.length : null, truncated: selected.length < keys.length, sha256: nativeMotionHash(keys) };
  }
  const motionTruncated = Object.values(coverage).some(value => value.truncated);
  return { motion, motionCoverage: coverage, motionComplete: !motionTruncated, motionTruncated };
}
function scopeReason(item, scope, { structuralSplit = false } = {}) {
  if (item.track.locked || item.clip.locked) return '轨道或片段已锁定';
  if (item.track.hidden || item.clip.disabled) return '轨道隐藏或片段已禁用';
  if (!localSource(item.clip.src) || !item.kind || !item.span) return '素材路径或时长不可安全编辑';
  if (scope?.assetIds && !scope.assetIds.includes(item.assetId) && item.clip.attrs?.['data-guangxuan-caption'] !== 'true') return '素材未在本次选择范围内';
  const place = scope?.placement;
  if (place?.mode === 'range') {
    if (place.clipIds?.length && !place.clipIds.includes(item.clip.id)) return '片段不在当前框选的片段中';
    if (!structuralSplit && (item.at < place.start - .001 || item.end > place.end + .001)) return '片段跨越所选区间边界；普通媒体可先在本轮范围边界保真分割，再修改区间内片段';
  }
  return '';
}
function scopedSplitIssue(item, doc, at) {
  if (!['video', 'sound', 'still'].includes(item.kind)) return '自定义页面片段不能保证跨区间分割后画面相同，请保留原片段。';
  try { safeSplit(item); } catch (error) { return error.message; }
  if (Object.keys(readMotion(item.clip, doc.keyframes)).length) return '该片段含时序关键帧，不能保证跨区间分割保真，请保留原片段。';
  if (at !== undefined) {
    const fade = clipFade(item.clip) || [0, 0];
    if (at < item.at + fade[0] - 1e-8 || at > item.end - fade[1] + 1e-8) return '分割点位于淡入淡出过程中，无法保留区间外的原始音画包络。';
    const exactCut = item.span.from + (at - item.at) * item.span.speed;
    if (Math.abs(exactCut - round(exactCut)) > 1e-8) return '当前变速无法在毫秒精度下保真分割，请保留原片段。';
  }
  return '';
}
function scopedSplitDescription(item, scope, doc) {
  const place = scope?.placement;
  if (place?.mode !== 'range' || item.at >= place.start - .001 && item.end <= place.end + .001 || scopeReason(item, scope, { structuralSplit: true }) || scopedSplitIssue(item, doc)) return {};
  const fade = clipFade(item.clip) || [0, 0], start = Math.ceil(Math.max(place.start, item.at + .001, item.at + fade[0]) * 1000) / 1000, end = Math.floor(Math.min(place.end, item.end - .001, item.end - fade[1]) * 1000) / 1000;
  return end >= start ? { canSplitInScope: true, splitRange: [start, end], splitNote: '仅保真结构分割例外；范围外内容仍不可调整。新片段ID从分割结果读取。' } : {};
}
function numericOpacity(style) {
  const raw = declarations(style || '').find(([name]) => name === 'opacity')?.[1];
  return raw !== undefined && Number.isFinite(Number(raw)) ? Number(raw) : 1;
}

/** An explicit page narrows the authoritative scope before slicing the real document. */
export function normalizeNativeTimelinePage(value = {}, maximumTime = NATIVE_MAX_TIME_SECONDS) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['offset', 'limit', 'trackOffset', 'trackLimit', 'clipIds', 'trackIndices', 'range', 'motionProperty', 'motionKeyOffset', 'motionKeyLimit'].includes(key))) throw failure('时间线分页参数格式不正确。', 'NATIVE_INSPECT_PAGE');
  const number = (key, fallback, max, min = 0) => {
    const result = value[key] === undefined ? fallback : value[key];
    if (!Number.isSafeInteger(result) || result < min || result > max) throw failure(`时间线分页${key}不在有效范围内。`, 'NATIVE_INSPECT_PAGE');
    return result;
  };
  const page = { offset: number('offset', 0, 1000000), limit: number('limit', 100, 300, 1), trackOffset: number('trackOffset', 0, 1000000), trackLimit: number('trackLimit', 100, 100, 1) };
  if (value.clipIds !== undefined) {
    if (!Array.isArray(value.clipIds) || value.clipIds.length > 200 || value.clipIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(id))) throw failure('查询片段编号不正确。', 'NATIVE_INSPECT_PAGE');
    page.clipIds = [...new Set(value.clipIds)];
  }
  if (value.trackIndices !== undefined) {
    if (!Array.isArray(value.trackIndices) || value.trackIndices.length > 100 || value.trackIndices.some(index => !Number.isSafeInteger(index) || index < 0 || index > 1000000)) throw failure('查询轨道编号不正确。', 'NATIVE_INSPECT_PAGE');
    page.trackIndices = [...new Set(value.trackIndices)];
  }
  if (value.range !== undefined) {
    const range = value.range;
    if (!range || typeof range !== 'object' || Array.isArray(range) || Object.keys(range).some(key => !['start', 'end'].includes(key)) || typeof range.start !== 'number' || typeof range.end !== 'number' || !Number.isFinite(range.start) || !Number.isFinite(range.end) || range.start < 0 || range.end > maximumTime || range.end <= range.start) throw failure(`查询区间须在0至${maximumTime}秒内，终点晚于起点。`, 'NATIVE_INSPECT_PAGE');
    page.range = { start: round(range.start), end: round(range.end) };
    if (page.range.end <= page.range.start) throw failure('查询区间过短。', 'NATIVE_INSPECT_PAGE');
  }
  if (['motionProperty', 'motionKeyOffset', 'motionKeyLimit'].some(key => value[key] !== undefined)) {
    if (page.clipIds?.length !== 1 || page.offset !== 0 || !MOTION_PROPS.includes(value.motionProperty)) throw failure('关键帧分页须指定一个实际clipId和属性，不能扩大整页片段的返回量。', 'NATIVE_INSPECT_PAGE');
    page.limit = 1; page.motionProperty = value.motionProperty; page.motionKeyOffset = number('motionKeyOffset', 0, 1000000); page.motionKeyLimit = number('motionKeyLimit', 100, 200, 1);
  }
  return page;
}

const pageSummary = (total, offset, limit, totalInDocument) => ({ total, offset, limit, hasMore: offset + limit < total, nextOffset: offset + limit < total ? offset + limit : null, totalInDocument });
function visibleInPage(item, scope, page) {
  const overlaps = range => item.span ? item.at < range.end && item.end > range.start : item.at >= range.start && item.at < range.end;
  if (scope?.assetIds && !scope.assetIds.includes(item.assetId) && item.clip.attrs?.['data-guangxuan-caption'] !== 'true') return false;
  if (scope?.placement?.mode === 'range' && (!overlaps(scope.placement) || scope.placement.clipIds?.length && !scope.placement.clipIds.includes(item.clip.id))) return false;
  if (page.clipIds && !page.clipIds.includes(item.clip.id) || page.trackIndices && !page.trackIndices.includes(item.trackIndex) || page.range && !overlaps(page.range)) return false;
  return true;
}
/** No paths, CSS, executable document contents, or native capability tokens leave this view. */
export function describeNativeTimeline(doc, known = {}, editScope, pageOptions, { inspectAll = false } = {}) {
  const scope = editScope ? normalizeEditScope(editScope) : undefined;
  const readScope = inspectAll ? undefined : scope;
  const items = allItems(doc, known), limits = nativeTimelineEditLimits(doc, known), page = pageOptions === undefined ? { offset: 0, limit: 300, trackOffset: 0, trackLimit: 100 } : normalizeNativeTimelinePage(pageOptions, limits.maxEditedTimelineSeconds);
  const filtered = pageOptions === undefined ? items : items.filter(item => visibleInPage(item, readScope, page));
  const clips = filtered.slice(page.offset, page.offset + page.limit).map(item => ({
    id: item.clip.id, clipId: item.clip.id, track: item.trackIndex, kind: item.kind,
    caption: item.clip.attrs?.['data-guangxuan-caption'] === 'true',
    ...(item.clip.attrs?.['data-guangxuan-caption'] === 'true' ? { captionText: String(item.clip.overrides?.find(override => override.at === '#caption')?.text ?? item.clip.attrs?.['data-guangxuan-text'] ?? '').slice(0, 2000) } : {}),
    name: String(item.clip.attrs?.title || known[item.clip.src]?.name || (item.kind === 'page' ? '图文片段' : '未命名片段')).slice(0, 180),
    ...(item.assetId ? { assetId: item.assetId } : {}), at: item.at, end: item.end,
    ...(item.span ? { sourceStart: item.span.from, sourceEnd: item.span.to, speed: item.span.speed, duration: round(item.span.length) } : {}),
    volume: Number(item.clip.volume ?? 1), fade: clipFade(item.clip) || [0, 0],
    ...(item.kind !== 'sound' ? { box: item.clip.box ? structuredClone(item.clip.box) : { x: 0, y: 0, w: doc.stage?.w, h: doc.stage?.h }, opacity: numericOpacity(item.clip.style) } : {}),
    ...(item.kind !== 'sound' ? motionView(item, doc, page) : {}),
    locked: Boolean(item.track.locked || item.clip.locked), hidden: Boolean(item.track.hidden), disabled: item.clip.disabled === true, editable: !scopeReason(item, scope),
    ...scopedSplitDescription(item, scope, doc),
    ...(scopeReason(item, scope) ? { unavailableReason: scopeReason(item, scope) } : {}),
  }));
  const selectedTracks = new Set(filtered.map(item => item.trackIndex)), scopedCounts = new Map();
  for (const item of filtered) scopedCounts.set(item.trackIndex, (scopedCounts.get(item.trackIndex) || 0) + 1);
  const narrowed = Boolean(readScope?.assetIds || readScope?.placement?.mode === 'range' || page.clipIds || page.range);
  const tracks = (doc.tracks || []).map((track, index) => ({ index, name: String(track.attrs?.title || track.attrs?.id || `轨道${index + 1}`).slice(0, 100), clipCount: track.clips?.length || 0, matchingClipCount: scopedCounts.get(index) || 0, locked: Boolean(track.locked), hidden: Boolean(track.hidden), muted: Boolean(track.muted) }))
    .filter(track => pageOptions === undefined || (!page.trackIndices || page.trackIndices.includes(track.index)) && (!narrowed || selectedTracks.has(track.index)));
  const pagination = pageSummary(filtered.length, page.offset, page.limit, items.length), trackPagination = pageSummary(tracks.length, page.trackOffset, page.trackLimit, (doc.tracks || []).length);
  const motionTruncated = clips.some(clip => clip.motionTruncated), truncated = motionTruncated || clips.length < filtered.length || Math.min(page.trackLimit, Math.max(0, tracks.length - page.trackOffset)) < tracks.length;
  return { clips, tracks: tracks.slice(page.trackOffset, page.trackOffset + page.trackLimit), pagination, trackPagination, limits, motionTruncated, total: pagination.total, offset: pagination.offset, limit: pagination.limit, hasMore: pagination.hasMore, nextOffset: pagination.nextOffset, truncated, scopeFiltered: pageOptions !== undefined && !inspectAll, ...(truncated ? { truncationNote: '片段和轨道可按nextOffset/trackPagination继续分页；关键帧截断时用native_motion_read按单片段完整读取，不能把本页快照整体覆盖原曲线。' } : {}), supportedActions: NATIVE_ADJUST_ACTIONS, timing: 'at/split为作品绝对秒数，trim start/end为源素材秒数；移动、删除、修剪和变速均不顺延其它片段。' };
}
function safeSplit(item) {
  const own = new Set(MOTION_PROPS.map(prop => motionName(item.clip.id, prop)));
  if (item.clip.class || /(?:^|;)\s*animation-[a-z-]+\s*:/i.test(item.clip.style || '') || animationsOf(item.clip.style).some(animation => !own.has(animation.split(/\s+/)[0]))) throw failure('该片段含自定义动画，请先在原生编辑器分割。', 'NATIVE_ADJUST_COMPLEX_CLIP', 409);
}
function checkDestination(item, at, length, scope, items, exclude, maximumTime) {
  if (!Number.isFinite(length) || length < .001 || at < 0 || at + length > maximumTime) throw failure('调整结果的时间无法精确表示。');
  if (scope?.placement.mode === 'range' && (at < scope.placement.start - .001 || at + length > scope.placement.end + .001)) throw failure('调整后会超出用户所选区间，未修改工程。', 'NATIVE_ADJUST_OUTSIDE_SCOPE', 403);
  if (items.some(other => other.trackIndex === item.trackIndex && !exclude.has(other.clip.id) && other.span && other.at < at + length - .001 && other.end > at + .001)) throw failure('目标位置与同轨其它片段重叠，请先选择空位或显式调整其它片段。', 'NATIVE_ADJUST_COLLISION', 409);
}
function withStyle(style, values) {
  const pairs = declarations(style || '').filter(([name]) => !Object.hasOwn(values, name));
  return [...pairs.map(([name, value]) => `${name}: ${value}`), ...Object.entries(values).map(([name, value]) => `${name}: ${value}`)].join('; ');
}
/** Plan a bounded transaction; validate the entire batch before any real file is written. */
export function planNativeAdjustments(doc, edits, { known = {}, editScope, timelineLimit, idFactory = () => 'gx-adjust-' + randomUUID() } = {}) {
  if (!Array.isArray(edits) || !edits.length || edits.length > 40) throw failure('每次请提供1至40项精确编辑。');
  const scope = editScope ? normalizeEditScope(editScope) : undefined;
  // A trusted caller may narrow a transaction, but cannot exceed numeric precision.
  if (timelineLimit !== undefined && (!Number.isFinite(timelineLimit) || timelineLimit < .001 || timelineLimit > NATIVE_MAX_TIME_SECONDS)) throw failure('本批时间线数值范围无效。');
  const maximumTime = timelineLimit ?? nativeTimelineEditLimits(doc, known).maxEditedTimelineSeconds;
  let value = structuredClone(doc); const ops = [], results = [], touched = new Set();
  for (const edit of edits) {
    if (!edit || typeof edit !== 'object' || Array.isArray(edit) || !NATIVE_ADJUST_ACTIONS.includes(edit.action) || typeof edit.clipId !== 'string') throw failure('请选择有效的操作及当前片段编号。');
    const unexpected = Object.keys(edit).filter(key => !['action', 'clipId', ...fields[edit.action]].includes(key));
    if (unexpected.length) throw failure('精确编辑包含不支持的参数：' + unexpected.join('、'));
    const items = allItems(value, known), item = items.find(row => row.clip.id === edit.clipId);
    if (!item) throw failure('片段已变化，请重新读取时间线后再操作。', 'NATIVE_ADJUST_CLIP_STALE', 409);
    const place = scope?.placement, crossing = place?.mode === 'range' && (item.at < place.start - .001 || item.end > place.end + .001);
    const structuralSplit = edit.action === 'split' && crossing && typeof edit.at === 'number' && Number.isFinite(edit.at) && edit.at >= place.start && edit.at <= place.end && item.at < place.end && item.end > place.start;
    const reason = scopeReason(item, scope, { structuralSplit }); if (reason) throw failure(reason, 'NATIVE_ADJUST_SCOPE', 403);
    if (structuralSplit) { const issue = scopedSplitIssue(item, value, edit.at); if (issue) throw failure(issue, 'NATIVE_ADJUST_COMPLEX_CLIP', 409); }
    const clip = item.clip, step = [], prop = (name, value) => step.push({ op: 'props', edits: [{ clip: clip.id, prop: name, value }] }); let motionResult;
    const timing = ['split', 'trim', 'move', 'remove', 'duplicate', 'speed'].includes(edit.action);
    if (timing && clip.attrs?.['data-link'] && items.some(other => other.clip.id !== clip.id && other.clip.attrs?.['data-link'] === clip.attrs['data-link'])) throw failure('此片段与音画片段联动，请先在原生编辑器处理联动后再精确调整时间。', 'NATIVE_ADJUST_LINKED', 409);
    if (edit.action === 'remove') step.push({ op: 'remove', clip: clip.id });
    else if (edit.action === 'split') {
      safeSplit(item); const at = finite(edit.at, '分割位置', 0, maximumTime), cut = round(item.span.from + (at - item.at) * item.span.speed);
      if (at <= item.at + .001 || at >= item.end - .001 || cut <= item.span.from || cut >= item.span.to) throw failure('分割点须严格位于片段内部。');
      const newId = idFactory(); step.push({ op: 'split', clip: clip.id, at, time: [item.span.from, cut], restTime: [cut, item.span.to], restId: newId });
      results.push({ action: edit.action, clipId: clip.id, createdClipId: newId, at });
    } else if (edit.action === 'move' || edit.action === 'duplicate') {
      const at = finite(edit.at, '放置位置', 0, maximumTime); checkDestination(item, at, item.span.length, scope, items, edit.action === 'move' ? new Set([clip.id]) : new Set(), maximumTime);
      if (edit.action === 'move') prop('at', at);
      else {
        const copied = structuredClone(clip), motion = readMotion(clip, value.keyframes), names = new Set(MOTION_PROPS.map(property => motionName(clip.id, property)));
        copied.id = idFactory(); copied.at = at;
        if (Object.keys(motion).length) copied.style = withAnimations(copied.style, animationsOf(copied.style).filter(entry => !names.has(entry.split(/\s+/)[0])));
        step.push({ op: 'insert', clip: copied, track: item.trackIndex });
        if (Object.keys(motion).length) step.push({ op: 'props', edits: [{ clip: copied.id, prop: 'motion', value: motion }] });
        results.push({ action: edit.action, clipId: clip.id, createdClipId: copied.id, at });
      }
    } else if (edit.action === 'trim') {
      const start = edit.start === undefined ? item.span.from : finite(edit.start, '源素材起点', 0, NATIVE_MAX_TIME_SECONDS), end = edit.end === undefined ? item.span.to : finite(edit.end, '源素材终点', 0, NATIVE_MAX_TIME_SECONDS);
      if (end <= start + .001) throw failure('源素材终点须晚于起点。');
      if (edit.start === undefined && edit.end === undefined) throw failure('请提供修剪起点或终点。');
      const nativeDuration = known[clip.src]?.duration;
      if (['video', 'sound'].includes(item.kind) && (!Number.isFinite(nativeDuration) || end > nativeDuration + .001)) throw failure('修剪范围超过素材实际时长，或时长尚不可核对。');
      if (item.kind === 'page' && (start < item.span.from || end > item.span.to)) throw failure('图文片段只支持在原有内容时间内修剪。');
      checkDestination(item, item.at, (end - start) / item.span.speed, scope, items, new Set([clip.id]), maximumTime); prop('start', start); prop('end', end);
    } else if (edit.action === 'speed') {
      if (!['video', 'sound'].includes(item.kind)) throw failure('仅视频或音频片段支持变速。');
      const speed = finite(edit.value, '播放速度', .1, 16); checkDestination(item, item.at, (item.span.to - item.span.from) / speed, scope, items, new Set([clip.id]), maximumTime); prop('speed', speed);
    } else if (edit.action === 'volume') {
      if (!['video', 'sound'].includes(item.kind)) throw failure('仅视频或音频片段有音量。'); prop('volume', finite(edit.value, '音量倍数（0为静音）', 0, 4));
    } else if (edit.action === 'fade') {
      const current = clipFade(clip) || [0, 0], fin = edit.in === undefined ? current[0] : finite(edit.in, '淡入秒数', 0, 30), fout = edit.out === undefined ? current[1] : finite(edit.out, '淡出秒数', 0, 30);
      if (edit.in === undefined && edit.out === undefined || fin + fout > item.span.length + .001) throw failure('请设置淡入或淡出，且合计不能超过片段时长。'); prop('fade', [fin, fout]);
    } else if (edit.action === 'transform') {
      if (item.kind === 'sound') throw failure('音频片段没有画面位置。');
      if (!fields.transform.some(name => edit[name] !== undefined)) throw failure('请提供至少一个画面调整参数。');
      const stage = value.stage || { w: 1920, h: 1080 }, base = { x: 0, y: 0, w: stage.w, h: stage.h, ...(clip.box || {}) };
      const scale = edit.scale === undefined ? 1 : finite(edit.scale, '相对缩放倍数', .1, 4);
      const w = edit.width === undefined ? round(base.w * scale) : finite(edit.width, '宽度', 1, stage.w * 4), h = edit.height === undefined ? round(base.h * scale) : finite(edit.height, '高度', 1, stage.h * 4);
      const box = { ...base, x: edit.x === undefined ? round(base.x + (base.w - w) / 2) : finite(edit.x, '横向位置', -stage.w * 2, stage.w * 2), y: edit.y === undefined ? round(base.y + (base.h - h) / 2) : finite(edit.y, '纵向位置', -stage.h * 2, stage.h * 2), w, h };
      if (edit.rotation !== undefined) box.r = finite(edit.rotation, '旋转角度', -360, 360);
      if (box.x + box.w <= 0 || box.y + box.h <= 0 || box.x >= stage.w || box.y >= stage.h) throw failure('调整后画面会完全移出画布，未应用。');
      prop('box', box); if (edit.opacity !== undefined) prop('style', withStyle(clip.style, { opacity: finite(edit.opacity, '不透明度', 0, 1) }));
      const motion = readMotion(clip, value.keyframes); let clear = false;
      if (edit.opacity !== undefined && motion.opacity) { delete motion.opacity; clear = true; }
      if (edit.rotation !== undefined && motion.rotate) { delete motion.rotate; clear = true; }
      if (clear) prop('motion', motion);
    } else if (edit.action === 'look') {
      if (!['video', 'still'].includes(item.kind) || !['none', 'warm', 'cool', 'cinematic', 'soft', 'vivid', 'mono'].includes(edit.preset)) throw failure('请选择画面片段及有效的调色预设。');
      const adjusted = applyPictureEffects(structuredClone(clip), { look: { preset: edit.preset, strength: edit.strength === undefined ? .5 : finite(edit.strength, '调色强度', 0, 1) } }); prop('style', adjusted.style);
    } else if (edit.action === 'motion') {
      if (item.kind === 'sound' || !MOTION_PROPS.includes(edit.property) || !Array.isArray(edit.keys) || edit.keys.length > 40) throw failure('请选择画面关键帧属性及最多40个关键帧；空列表可移除该属性动画。');
      const mode = edit.mode || 'replace', motion = readMotion(clip, value.keyframes), originalKeys = motion[edit.property] || [], originalHash = nativeMotionHash(originalKeys);
      if (!['patch', 'replace'].includes(mode) || edit.replaceAll !== undefined && typeof edit.replaceAll !== 'boolean' || mode === 'patch' && edit.replaceAll !== undefined) throw failure('关键帧mode需为patch或replace，replaceAll仅用于显式整体替换。');
      if (edit.expectedMotionHash !== undefined && (typeof edit.expectedMotionHash !== 'string' || edit.expectedMotionHash !== originalHash)) throw failure('关键帧曲线已有变化，请重新读取当前完整曲线。', 'NATIVE_ADJUST_MOTION_STALE', 409);
      if (mode === 'replace' && (originalKeys.length > 40 || edit.replaceAll === true) && (edit.replaceAll !== true || edit.expectedMotionHash !== originalHash)) throw failure('原曲线超过本次快照；请分页读取后用patch保留未改关键帧，或显式replaceAll并提供当前完整曲线hash。', 'NATIVE_ADJUST_MOTION_INCOMPLETE', 409);
      if (mode === 'patch' && !edit.keys.length) throw failure('patch至少提供一个关键帧，不会借空列表删除原曲线。');
      const stage = value.stage || { w: 1920, h: 1080 }, keys = edit.keys.map(key => {
        if (!key || typeof key !== 'object' || Array.isArray(key) || Object.keys(key).some(name => !['time', 'value', 'x', 'y', 'easing'].includes(name))) throw failure('关键帧参数格式不正确。');
        const time = finite(key.time, '片段内关键帧秒数', 0, item.span.length), existing = mode === 'patch' ? originalKeys.find(original => original.t === time) : null;
        const easing = key.easing === undefined ? existing?.ease || 'linear' : key.easing;
        if (key.easing !== undefined && !Object.hasOwn(EASES, easing)) throw failure('关键帧缓动只支持linear/ease-in/ease-out/ease-in-out/hold。');
        let number;
        if (edit.property === 'translate') {
          if (key.value !== undefined) throw failure('平移关键帧请使用x和y。');
          number = [finite(key.x, '关键帧横向偏移', -stage.w * 2, stage.w * 2), finite(key.y, '关键帧纵向偏移', -stage.h * 2, stage.h * 2)];
        } else {
          if (key.x !== undefined || key.y !== undefined) throw failure('此关键帧属性请使用value。');
          number = finite(key.value, '关键帧值', edit.property === 'rotate' ? -360 : edit.property === 'scale' ? .1 : 0, edit.property === 'rotate' ? 360 : edit.property === 'scale' ? 4 : 1);
        }
        return { t: time, v: number, ease: easing };
      }).sort((a, b) => a.t - b.t);
      if (keys.some((key, index) => index > 0 && key.t <= keys[index - 1].t)) throw failure('同一属性的关键帧时间不可重复。');
      const nextKeys = mode === 'patch' ? [...new Map([...originalKeys, ...keys].map(key => [key.t, key])).values()].sort((a, b) => a.t - b.t) : keys;
      if (nextKeys.length) motion[edit.property] = nextKeys; else delete motion[edit.property]; prop('motion', motion); motionResult = { mode, previousKeys: originalKeys.length, submittedKeys: keys.length, property: edit.property };
    } else if (edit.action === 'caption') {
      if (clip.attrs?.['data-guangxuan-caption'] !== 'true' || item.kind !== 'page') throw failure('精确文字调整仅用于Gx生成的标题或字幕；WebVTT或自定义网页请在原生编辑器处理。');
      if (!fields.caption.some(name => edit[name] !== undefined)) throw failure('请提供字幕文字或样式。');
      const overrides = structuredClone(clip.overrides || []);
      const get = selector => { let found = overrides.find(override => override.at === selector); if (!found) { found = { at: selector }; overrides.push(found); } if (found.lock) throw failure('字幕内部文字图层已锁定。', 'NATIVE_ADJUST_SCOPE', 403); return found; };
      const caption = get('#caption'), attrs = { ...clip.attrs }; caption.style = { ...(caption.style || {}) };
      if (edit.text !== undefined) { if (typeof edit.text !== 'string' || !edit.text.trim() || edit.text.length > 2000) throw failure('字幕需为1至2000字的纯文本。'); caption.text = edit.text; attrs['data-guangxuan-text'] = edit.text; attrs.title = '字幕 · ' + edit.text.slice(0, 30); }
      if (edit.fontSize !== undefined) caption.style.fontSize = finite(edit.fontSize, '字幕字号', 8, 200) + 'px';
      if (edit.color !== undefined) { if (typeof edit.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(edit.color)) throw failure('字幕颜色请使用#RRGGBB。'); caption.style.color = edit.color; }
      if (edit.fontWeight !== undefined) { if (![400, 500, 600, 700, 800].includes(edit.fontWeight)) throw failure('字幕字重无效。'); caption.style.fontWeight = String(edit.fontWeight); }
      if (edit.align !== undefined) { if (!['left', 'center', 'right'].includes(edit.align)) throw failure('字幕对齐方式无效。'); caption.style.textAlign = edit.align; }
      if (edit.placement !== undefined) {
        if (!['title', 'center', 'bottom'].includes(edit.placement)) throw failure('字幕位置无效。'); const body = get('body'); body.style = { ...(body.style || {}), alignItems: { title: 'flex-start', center: 'center', bottom: 'flex-end' }[edit.placement], padding: { title: '12% 7% 0', center: '7%', bottom: '0 7% 7%' }[edit.placement] };
        attrs['data-guangxuan-placement'] = edit.placement;
      }
      if (edit.text !== undefined || edit.placement !== undefined) prop('attrs', attrs);
      prop('overrides', overrides);
    }
    value = applyOps(value, step); ops.push(...step); touched.add(clip.id);
    if (motionResult) { const actualClip = allItems(value, known).find(item => item.clip.id === clip.id).clip, actualKeys = readMotion(actualClip, value.keyframes)[edit.property] || []; results.push({ action: edit.action, clipId: clip.id, ...motionResult, totalKeys: actualKeys.length, sha256: nativeMotionHash(actualKeys) }); }
    else if (!['split', 'duplicate'].includes(edit.action)) results.push({ action: edit.action, clipId: clip.id });
  }
  const checked = readFilm(value);
  if (!checked.doc) throw failure('这组参数无法安全应用到当前工程，未作修改。请调整参数后重试。');
  if (nativeTimelineDuration(value, known) > maximumTime) throw failure('编辑结果的时间无法精确表示，尚未修改工程。', 'NATIVE_ADJUST_TIMELINE_LIMIT');
  return { ops, document: value, results, touchedClipIds: [...touched], summary: `已完成${edits.length}项精确剪辑；其它片段未顺延。` };
}
