import { randomUUID } from 'node:crypto';
import { AppError } from './errors.mjs';
import { MAX_TIME_SECONDS } from '../public/time-range.js';
import { clipSpan, kindOf } from '../integrations/openfilm/packages/openfilm/src/film-doc.mjs';
import { animationsOf, motionName, MOTION_PROPS } from '../integrations/openfilm/packages/openfilm/src/clip-motion.mjs';
import { applyOps } from '../integrations/openfilm/packages/openfilm/studio/server/ops.mjs';

const round = value => Math.round(value * 1000) / 1000;
const failed = (message, code = 'OPENFILM_PLACEMENT_UNSUPPORTED') => new AppError(409, message, code);

function assertSplittable(item) {
  const ownNames = new Set(MOTION_PROPS.map(prop => motionName(item.clip.id, prop)));
  const customAnimation = animationsOf(item.clip.style).some(animation => !ownNames.has(animation.split(/\s+/)[0]));
  if (customAnimation || /(?:^|;)\s*animation-[a-z-]+\s*:/i.test(item.clip.style || '') || item.clip.class) throw failed('跨区间边界的片段含自定义样式动画，请先在编辑器分割边界片段后重新框选。', 'OPENFILM_SPLIT_STYLE_UNSUPPORTED');
}

/** Split only tracks explicitly owned by this local edit; outside timing never ripples. */
export function inspectRegion(doc, placement, known = {}, { mainTrack = -1, timeline = true, replaceCaptions = false } = {}) {
  const { start, end } = placement || {};
  if (placement?.mode !== 'range' || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end - start < .001 || end > MAX_TIME_SECONDS) throw new AppError(400, '请重新框选有效的时间轴区间。', 'INVALID_EDIT_RANGE');
  const measured = measureFilm(doc, known, { ignoreUnknown: (clip, trackIndex) => {
    const potentiallyInside = Number(clip.at || 0) < end;
    return !(potentiallyInside && ((timeline && trackIndex === mainTrack) || (replaceCaptions && (doc.tracks[trackIndex].attrs?.id === 'guangxuan-captions' || clip.attrs?.['data-guangxuan-caption'] === 'true'))));
  } });
  if (end > measured.duration + .001) throw failed('所选区间已超出当前工程，请重新框选后再发送。', 'OPENFILM_RANGE_OUTSIDE_TIMELINE');
  const intersects = item => item.at < end - .000001 && item.end > start + .000001;
  for (const id of placement.clipIds || []) if (!measured.clips.some(item => item.clip.id === id && intersects(item))) throw failed('框选时的片段已变化，请重新选择区间。', 'OPENFILM_RANGE_SELECTION_STALE');
  if (timeline && (mainTrack < 0 || !measured.clips.some(item => item.trackIndex === mainTrack && intersects(item)))) throw failed('所选区间没有可修改的主画面片段，请重新框选主时间线。', 'OPENFILM_RANGE_EMPTY');
  if (timeline && (doc.tracks[mainTrack]?.hidden || doc.tracks[mainTrack]?.muted)) throw failed('主画面轨已隐藏或静音，请先恢复该轨道。', 'OPENFILM_MAIN_TRACK_INACTIVE');
  if (replaceCaptions && doc.tracks.some(track => track.captions && !track.hidden)) throw failed('当前字幕使用WebVTT文件。请先使用“添加字幕”，或在原生字幕轨中修改所选区间，避免改动区间外字幕。', 'OPENFILM_RANGE_CAPTIONS_UNSUPPORTED');
  const target = measured.clips.filter(item => intersects(item) && ((timeline && item.trackIndex === mainTrack) || (replaceCaptions && (doc.tracks[item.trackIndex].attrs?.id === 'guangxuan-captions' || item.clip.attrs?.['data-guangxuan-caption'] === 'true'))));
  const ops = [], selectedIds = [], mainIds = new Map();
  for (const item of target) {
    const track = doc.tracks[item.trackIndex];
    if (track.locked || item.clip.locked) throw failed('所选区间涉及锁定片段或轨道，请先解锁。', 'OPENFILM_TRACK_LOCKED');
    if (item.clip.disabled) throw failed('所选区间含禁用片段，请先在编辑器处理后重新框选。', 'OPENFILM_RANGE_DISABLED');
    if (timeline && item.trackIndex === mainTrack && !['video', 'still'].includes(kindOf(item.clip))) throw failed('所选主画面含HTML或复合片段，请先在编辑器分解，或只让AI添加字幕。', 'OPENFILM_RANGE_UNSUPPORTED');
    let id = item.clip.id, from = item.from;
    if (item.at < start - .000001) {
      assertSplittable(item);
      const cut = round(item.from + (start - item.at) * item.speed), restId = 'gx-range-' + randomUUID();
      if (!(cut > item.from && cut < item.to) || Math.abs(item.at + (cut - item.from) / item.speed - start) > .001) throw failed('区间起点不符合当前变速片段的时间精度，请微调或先拆分片段。', 'OPENFILM_RANGE_PRECISION');
      ops.push({ op: 'split', clip: id, at: start, time: [item.from, cut], restTime: [cut, item.to], restId });
      id = restId; from = cut;
    }
    if (item.end > end + .000001) {
      assertSplittable(item);
      const cut = round(item.from + (end - item.at) * item.speed), restId = 'gx-range-' + randomUUID();
      if (!(cut > from && cut < item.to) || Math.abs(item.at + (cut - item.from) / item.speed - end) > .001) throw failed('区间终点不符合当前变速片段的时间精度，请微调或先拆分片段。', 'OPENFILM_RANGE_PRECISION');
      ops.push({ op: 'split', clip: id, at: end, time: [from, cut], restTime: [cut, item.to], restId });
    }
    selectedIds.push(id);
    if (item.trackIndex === mainTrack) mainIds.set(item.clip.id, id);
  }
  const sliced = ops.length ? applyOps(structuredClone(doc), ops) : structuredClone(doc);
  return { doc, sliced, ...measured, start: round(start), end: round(end), at: round(start), rangeDuration: round(end - start), ops, selectedIds, mainIds, mainTrack };
}

/** The replacement is local and fixed-length; unrelated tracks and their clips are untouched. */
export function replaceRegion(snapshot, segment, { known = {}, hasTimeline = true, hasCaptions = false } = {}) {
  const picture = segment.tracks.find(track => track.attrs?.id === 'guangxuan-picture');
  if (hasTimeline) {
    const duration = picture?.clips?.length ? measureFilm({ stage: segment.stage, tracks: [picture] }, known).duration : 0;
    if (Math.abs(duration - snapshot.rangeDuration) > .001) throw new AppError(400, '局部方案总时长必须等于所选区间' + snapshot.rangeDuration + '秒，区间外片段不会自动顺延。请重新生成或调整片段出入点。', 'OPENFILM_RANGE_DURATION_MISMATCH');
  }
  const ops = [...snapshot.ops, ...snapshot.selectedIds.map(clip => ({ op: 'remove', clip }))];
  const outsideIds = new Set(snapshot.doc.tracks.flatMap(track => (track.clips || []).map(clip => clip.id)).filter(id => !snapshot.selectedIds.includes(id)));
  for (const track of [picture, ...segment.tracks.filter(track => track !== picture)].filter(Boolean)) {
    const isPicture = track === picture;
    if ((isPicture && !hasTimeline) || (!isPicture && !hasCaptions) || !track.clips.length) continue;
    if (!isPicture && track.attrs?.id !== 'guangxuan-captions') throw new AppError(400, '所选区间模式保留配乐和其它轨道，请在原生编辑器调整这些轨道。', 'OPENFILM_RANGE_TRACK_UNSUPPORTED');
    const target = isPicture ? snapshot.mainTrack : 0;
    track.clips.forEach((clip, index) => {
      if (outsideIds.has(clip.id)) throw new AppError(400, '局部方案不能引用区间外片段编号。', 'OPENFILM_RANGE_CLIP_FORBIDDEN');
      const copy = { ...structuredClone(clip), at: round(snapshot.start + Number(clip.at || 0)) };
      const span = clipSpan(copy, known[copy.src]?.duration);
      if (copy.at < snapshot.start - .001 || copy.at + span.length > snapshot.end + .001) throw new AppError(400, '方案内容超出所选区间，请重新生成。', 'OPENFILM_RANGE_PLAN_OUTSIDE');
      ops.push({ op: 'insert', clip: copy, ...(!isPicture && index === 0 ? { newTrack: target, newTrackAttrs: track.attrs } : { track: target }) });
    });
  }
  return { ops, at: snapshot.start, start: snapshot.start, end: snapshot.end, duration: snapshot.rangeDuration };
}

/** Values are bounded by normalizeEditEffects; no model-supplied CSS enters this mapping. */
export function applyPictureEffects(clip, { look, fade } = {}) {
  if (!look && !fade) return clip;
  if (!['video', 'still'].includes(kindOf(clip))) throw new AppError(400, '滤镜仅用于画面片段。', 'INVALID_EDIT_EFFECT');
  if (look) {
    const s = look.strength, n = value => String(Math.round(value * 1000) / 1000);
    const filters = {
      none: 'none',
      warm: `sepia(${n(.22 * s)}) saturate(${n(1 + .15 * s)}) contrast(${n(1 + .04 * s)})`,
      cool: `saturate(${n(1 - .12 * s)}) contrast(${n(1 + .05 * s)}) brightness(${n(1 + .02 * s)}) hue-rotate(${n(8 * s)}deg)`,
      cinematic: `contrast(${n(1 + .18 * s)}) saturate(${n(1 - .18 * s)}) brightness(${n(1 - .04 * s)})`,
      soft: `contrast(${n(1 - .12 * s)}) brightness(${n(1 + .05 * s)}) saturate(${n(1 - .06 * s)})`,
      vivid: `saturate(${n(1 + .35 * s)}) contrast(${n(1 + .12 * s)})`,
      mono: `grayscale(${n(s)})`,
    };
    const filter = s === 0 ? 'none' : filters[look.preset];
    if (!filter) throw new AppError(400, '滤镜预设无效。', 'INVALID_EDIT_EFFECT');
    const style = String(clip.style || '').trim().replace(/;\s*$/, '');
    clip.style = `${style ? style + '; ' : ''}filter: ${filter}`;
  }
  if (fade) {
    const span = clipSpan(clip);
    const amount = Math.floor(Math.min(fade.duration, span.length / 2) * 1000) / 1000;
    const overrides = (Array.isArray(clip.overrides) ? structuredClone(clip.overrides) : []).filter(item => item.at !== undefined);
    if (amount > 0) overrides.unshift({ fade: [amount, amount] });
    if (overrides.length) clip.overrides = overrides; else delete clip.overrides;
  }
  return clip;
}

/** Use the native clip timing rules, including speed, explicit stills and page trims. */
export function measureFilm(doc, known = {}, { ignoreUnknown } = {}) {
  if (!Array.isArray(doc?.tracks)) throw failed('工程结构无法读取，请重新打开项目。');
  const clips = [], ids = new Set();
  let duration = 0;
  for (const [trackIndex, track] of doc.tracks.entries()) for (const clip of track.clips || []) {
    if (typeof clip.id !== 'string' || ids.has(clip.id) || !kindOf(clip)) throw failed('工程含重复编号或无法识别的片段，请先在编辑器修复。');
    ids.add(clip.id);
    const at = clip.at ?? 0;
    let span;
    try { span = clipSpan(clip, known[clip.src]?.duration); }
    catch { if (ignoreUnknown?.(clip, trackIndex)) continue; throw failed('有相关片段尚未确定时长，请先在编辑器设置明确的出入点。', 'OPENFILM_LENGTH_UNKNOWN'); }
    if (!Number.isFinite(at) || at < 0 || !Number.isFinite(span.length) || span.length < .001 || ![span.from, span.to, span.speed].every(Number.isFinite) || span.speed <= 0 || span.from < 0 || span.to > MAX_TIME_SECONDS || at + span.length > MAX_TIME_SECONDS) throw failed('工程含无法确定时间位置的片段。', 'OPENFILM_LENGTH_UNKNOWN');
    const end = at + span.length;
    clips.push({ clip, trackIndex, at, end, ...span });
    if (!track.hidden && !clip.disabled) duration = Math.max(duration, end);
  }
  return { clips, duration: round(duration) };
}

/** Reject before touching the document when a global time insertion cannot be faithful. */
export function inspectPlacement(doc, placement, known = {}) {
  if (!['append', 'insert'].includes(placement?.mode)) throw new AppError(400, '请选择末尾追加或指定位置插入。', 'INVALID_EDIT_PLACEMENT');
  if (doc.tracks.some(track => track.locked)) throw failed('项目含锁定轨道，请先解锁后再插入内容。', 'OPENFILM_TRACK_LOCKED');
  if (placement.mode === 'insert' && doc.tracks.some(track => track.captions)) throw failed('WebVTT字幕不能安全自动顺延，请改用末尾追加，或先在编辑器调整字幕。', 'OPENFILM_CAPTION_TRACK_UNSUPPORTED');
  const measured = measureFilm(doc, known);
  const at = placement.mode === 'append' ? measured.duration : placement.at;
  if (!Number.isFinite(at) || at < 0 || at > MAX_TIME_SECONDS) throw new AppError(400, '请输入可精确表示的非负插入时间。', 'INVALID_EDIT_PLACEMENT');
  if (placement.mode === 'insert') for (const item of measured.clips) {
    if (!(item.at < at && item.end > at + .000001)) continue;
    const ownNames = new Set(MOTION_PROPS.map(prop => motionName(item.clip.id, prop)));
    const animations = animationsOf(item.clip.style);
    const customAnimation = animations.some(animation => !ownNames.has(animation.split(/\s+/)[0]));
    const longhandAnimation = /(?:^|;)\s*animation-[a-z-]+\s*:/i.test(item.clip.style || '');
    if (customAnimation || longhandAnimation || item.clip.class) throw failed('跨插入点的片段含自定义样式动画，请先在编辑器分割该片段再插入。', 'OPENFILM_SPLIT_STYLE_UNSUPPORTED');
    const cut = round(item.from + (at - item.at) * item.speed);
    if (!(cut > item.from && cut < item.to) || Math.abs(item.at + (cut - item.from) / item.speed - at) > .001) throw failed('插入点过近或不符合当前变速片段的时间精度，请稍微调整位置。', 'OPENFILM_INSERT_PRECISION');
  }
  return { doc, ...measured, at: round(at), mode: placement.mode };
}

/** Emit native operations; never rebuild or reduce existing clips to a simpler schema. */
export function placeSegment(snapshot, segment, { known = {}, mainTrack = -1 } = {}) {
  const duration = measureFilm(segment, known).duration;
  if (!(duration > 0)) throw new AppError(400, '没有可插入的片段。', 'INVALID_OPENFILM_PLAN');
  const { doc, clips, at, mode } = snapshot;
  if (Math.max(snapshot.duration, at) + duration > MAX_TIME_SECONDS) throw new AppError(400, '插入后的时间无法精确表示。', 'OPENFILM_TIMELINE_TOO_LONG');
  const picture = segment.tracks.find(track => track.attrs?.id === 'guangxuan-picture');
  if (picture?.clips.length && mainTrack >= 0 && (doc.tracks[mainTrack]?.hidden || doc.tracks[mainTrack]?.muted)) throw failed('主画面轨已隐藏或静音，请先恢复该轨道后再插入。', 'OPENFILM_MAIN_TRACK_INACTIVE');
  const ops = [];
  if (mode === 'insert') for (const item of clips) {
    if (item.at >= at) {
      if (item.end + duration > MAX_TIME_SECONDS) throw new AppError(400, '顺延后的时间无法精确表示。', 'OPENFILM_TIMELINE_TOO_LONG');
      ops.push({ op: 'move', clip: item.clip.id, at: round(item.at + duration) });
    } else if (item.end > at + .000001) {
      if (item.end + duration > MAX_TIME_SECONDS) throw new AppError(400, '顺延后的时间无法精确表示。', 'OPENFILM_TIMELINE_TOO_LONG');
      const cut = round(item.from + (at - item.at) * item.speed), restId = `gx-split-${randomUUID()}`;
      // Split at the original time so native splitMotion preserves the animation phase.
      // Only then move the right half by the inserted segment's duration.
      ops.push({ op: 'split', clip: item.clip.id, at, time: [item.from, cut], restTime: [cut, item.to], restId });
      ops.push({ op: 'move', clip: restId, at: round(at + duration) });
    }
  }
  let trackCount = doc.tracks.length;
  const existingIds = new Set(clips.map(item => item.clip.id));
  const shifted = clip => {
    if (existingIds.has(clip.id)) throw new AppError(400, '插入片段必须使用新的编号。', 'OPENFILM_INSERT_ID_REUSED');
    return { ...structuredClone(clip), at: round(at + Number(clip.at || 0)) };
  };
  if (picture?.clips.length) {
    const target = mainTrack >= 0 ? mainTrack : trackCount++;
    picture.clips.forEach((clip, index) => ops.push({ op: 'insert', clip: shifted(clip), ...(mainTrack < 0 && index === 0 ? { newTrack: target, newTrackAttrs: picture.attrs } : { track: target }) }));
  }
  for (const track of segment.tracks.filter(track => track !== picture && track.clips.length)) {
    const target = track.attrs?.id === 'guangxuan-captions' ? 0 : trackCount;
    track.clips.forEach((clip, index) => ops.push({ op: 'insert', clip: shifted(clip), ...(index === 0 ? { newTrack: target, newTrackAttrs: track.attrs } : { track: target }) }));
    trackCount++;
  }
  return { ops, at, duration };
}
