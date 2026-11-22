const object = value => value && typeof value === 'object' && !Array.isArray(value);
const frameId = value => /^f\d{3}\.jpg$/.test(value || '');
const select = (value, allowed, fallback = 'unknown') => allowed.includes(value) ? value : fallback;
export function normalizeShotCues(raw, { shot, frames = [], clean = String } = {}) {
  if (!object(raw) || !shot) return undefined;
  const text = (value, limit = 500) => typeof value === 'string' ? clean(value).replace(/\0/g, '').trim().slice(0, limit) : '';
  const available = frames.filter(frame => frameId(frame.id) && frame.shotId === shot.id && Number.isFinite(frame.timestamp) && frame.timestamp >= shot.start && frame.timestamp <= shot.end);
  const known = new Map(available.map(frame => [frame.id, frame]));
  const evidence = [...new Set((Array.isArray(raw.evidence) ? raw.evidence : available.map(frame => frame.id)).filter(id => known.has(id)))].slice(0, 8);
  if (!evidence.length) return undefined;
  const motionRaw = object(raw.motion) ? raw.motion : {}, before = known.get(motionRaw.beforeFrame), after = known.get(motionRaw.afterFrame);
  const paired = before && after && evidence.includes(before.id) && evidence.includes(after.id) && before.timestamp < after.timestamp;
  const subjects = (Array.isArray(raw.subjects) ? raw.subjects : []).slice(0, 6).filter(object).map(subject => ({ label: text(subject.label, 120), role: select(subject.role, ['primary', 'secondary'], 'secondary'), position: select(subject.position, ['left', 'center', 'right', 'unknown']) })).filter(subject => subject.label);
  const compositionRaw = object(raw.composition) ? raw.composition : {};
  const usableSegments = (Array.isArray(raw.usableSegments) ? raw.usableSegments : []).slice(0, 8).filter(segment => object(segment) && ['establish', 'subject', 'action', 'detail', 'context', 'transition', 'hold'].includes(segment.purpose)
    && Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.start >= shot.start && segment.end <= shot.end && segment.end > segment.start).flatMap(segment => {
      const supporting = [...new Set((Array.isArray(segment.evidence) ? segment.evidence : []).filter(id => evidence.includes(id) && known.get(id).timestamp >= segment.start && known.get(id).timestamp <= segment.end))];
      if (!supporting.length || segment.purpose === 'action' && new Set(supporting.map(id => known.get(id).timestamp)).size < 2) return [];
      return [{ purpose: segment.purpose, start: segment.start, end: segment.end, evidence: supporting, rationale: text(segment.rationale), confidence: select(segment.confidence, ['low', 'medium'], 'low'), status: 'sample-based-candidate' }];
    });
  return { id: `${shot.id}:visual`, kind: 'visual-sampled', sourceRange: { start: shot.start, end: shot.end }, evidence, subjects,
    composition: { shotSize: select(compositionRaw.shotSize, ['wide', 'medium', 'close', 'detail', 'unknown']), negativeSpace: select(compositionRaw.negativeSpace, ['left', 'right', 'top', 'bottom', 'none', 'unknown']), focus: text(compositionRaw.focus) },
    motion: { status: paired ? 'paired-observation' : evidence.length === 1 ? 'single-frame' : 'unknown', ...(paired ? { beforeFrame: before.id, afterFrame: after.id } : {}),
      direction: paired ? select(motionRaw.direction, ['left', 'right', 'up', 'down', 'toward', 'away', 'static', 'unknown']) : 'unknown', camera: paired ? select(motionRaw.camera, ['static', 'pan', 'tilt', 'push', 'pull', 'unknown']) : 'unknown', description: paired ? text(motionRaw.description) : '', continuous: false },
    usableSegments, uncertainties: [...new Set([...(Array.isArray(raw.uncertainties) ? raw.uncertainties : []).filter(value => typeof value === 'string').slice(0, 8).map(value => text(value)), '离散抽样只支持所列帧观察；候选区间未逐帧验证，不证明完整连续动作、无瑕疵或音频内容。'])].filter(Boolean) };
}
