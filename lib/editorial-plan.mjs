import { AppError } from './errors.mjs';

const round = value => Math.round(value * 1000) / 1000;
export const EDIT_PURPOSES = ['establish', 'subject', 'action', 'detail', 'context', 'transition', 'hold'];
const invalid = (model, message) => { throw new AppError(model ? 502 : 400, message, model ? 'MODEL_EDITORIAL_INVALID' : 'EDITORIAL_PLAN_INVALID'); };

export function normalizeEditorialClip(input, { start, end, assetId, sourceAnalysis, model = false } = {}) {
  const value = {};
  if (input.purpose !== undefined) {
    if (!EDIT_PURPOSES.includes(input.purpose)) invalid(model, '片段用途不在剪辑目录中。');
    value.purpose = input.purpose;
  }
  if (input.speed !== undefined) {
    if (typeof input.speed !== 'number' || !Number.isFinite(input.speed) || input.speed < .1 || input.speed > 16) invalid(model, '片段速度应为0.1至16。');
    value.speed = input.speed;
  }
  if (input.cueIds !== undefined) {
    if (!Array.isArray(input.cueIds) || input.cueIds.length > 8 || input.cueIds.some(id => typeof id !== 'string' || !id || id.length > 160)) invalid(model, '剪辑依据编号无效。');
    const pages = (sourceAnalysis?.items || []).filter(item => item.assetId === assetId);
    value.cueIds = [...new Set(input.cueIds)];
    for (const id of value.cueIds) {
      const matches = pages.flatMap(page => {
        const frames = new Map((page.frames || []).map(frame => [frame.id, frame]));
        return (page.shots || []).filter(shot => shot.cues?.id === id).flatMap(shot => {
          const cue = shot.cues, range = cue.sourceRange;
          if (cue.kind !== 'visual-sampled' || !range || start < range.start - .001 || end > range.end + .001) return [];
          const selected = (cue.evidence || []).map(frameId => frames.get(frameId)).filter(frame => frame && (frame.shotId === undefined || frame.shotId === shot.id) && Number.isFinite(frame.timestamp) && frame.timestamp >= start - .001 && frame.timestamp <= end + .001);
          return selected.length ? [selected] : [];
        });
      });
      if (!matches.length) invalid(model, '剪辑依据必须来自当前素材和所选源区间的真实抽样帧。');
      if (value.purpose === 'action' && !matches.some(selected => new Set(selected.map(frame => frame.timestamp)).size >= 2)) invalid(model, '动作片段需同一分析页所选源区间内至少两张真实帧支持，不能拼混不同页。');
    }
  }
  return value;
}

export function editorialTiming(timeline, { originals = new Map(), preservePositions = false, offset = 0 } = {}) {
  let cursor = 0;
  return timeline.map((clip, index) => {
    const speed = Number(clip.speed ?? (clip.clipId ? originals.get(clip.clipId)?.speed : undefined) ?? 1), at = preservePositions ? Number(clip.at || 0) - offset : cursor;
    const duration = (clip.end - clip.start) / speed;
    if (![speed, at, duration].every(Number.isFinite) || speed <= 0 || duration <= 0) invalid(false, '片段时长或源时基无效。');
    cursor = round(cursor + duration);
    return { index, ...(clip.id || clip.clipId ? { clipId: clip.id || clip.clipId } : {}), assetId: clip.assetId, start: clip.start, end: clip.end, speed, at: round(at), duration: round(duration) };
  });
}

/** Source intervals are mapped once through actual trim, speed and placement; no word timing is invented. */
export function resolveCaptionTiming(caption, timing, { model = false } = {}) {
  if (!caption || typeof caption !== 'object' || Array.isArray(caption)) invalid(model, '字幕需要有效的文字与时间对象。');
  if (caption.source === undefined) return { start: Number(caption.start), end: Number(caption.end) };
  const source = caption.source;
  if (!source || typeof source !== 'object' || Array.isArray(source) || Object.keys(source).some(key => !['clipIndex', 'clipId', 'start', 'end'].includes(key)) || (source.clipIndex === undefined) === (source.clipId === undefined)) invalid(model, '源时基字幕需选择本次片段序号或当前真实clipId。');
  const clip = source.clipIndex !== undefined ? Number.isInteger(source.clipIndex) && source.clipIndex >= 0 ? timing[source.clipIndex] : null : timing.find(clip => clip.clipId === source.clipId);
  if (!clip || ![source.start, source.end].every(time => typeof time === 'number' && Number.isFinite(time)) || source.end <= source.start || source.start < clip.start - .001 || source.end > clip.end + .001) invalid(model, '源字幕区间必须完整位于对应片段入出点内，不能跨越剪切。');
  const mapped = { start: round(clip.at + (source.start - clip.start) / clip.speed), end: round(clip.at + (source.end - clip.start) / clip.speed) };
  for (const edge of ['start', 'end']) if (caption[edge] !== undefined && (typeof caption[edge] !== 'number' || Math.abs(caption[edge] - mapped[edge]) > .001)) invalid(model, '字幕最终时间与源区间、速度和放置位置不一致。');
  return mapped;
}
