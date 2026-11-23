import { createHash } from 'node:crypto';
import { AppError } from './errors.mjs';

const EPS = 1e-8, COVERAGE_EPS = .001, MAX_CLIPS = 2000;
const fail = (code, message, status = 400) => new AppError(status, message, code);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const finite = (value, label, min = 0) => { if (!Number.isFinite(value) || value < min) throw fail('MUSIC_PLAN_INPUT', label + '需要有效非负秒数或数值。'); return value; };
const id = value => { if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 160 || /[\x00-\x1f/\\]/.test(value)) throw fail('MUSIC_PLAN_ASSET_ID', '素材ID必须来自当前已选素材，不接收文件路径。'); return value; };
const abort = signal => { if (signal?.aborted) throw fail('REQUEST_CANCELLED', '音乐剪辑规划已取消，未生成写入计划。', 499); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const quantile = (values, fraction) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor((sorted.length - 1) * fraction)] ?? 0; };

function normalizeAssets(input) {
  if (!Array.isArray(input) || !input.length || input.length > 256) throw fail('MUSIC_PLAN_ASSETS', '请选择1至256个视频/图片来源候选。');
  const metadata = new Map();
  return input.map((asset, index) => {
    if (!object(asset) || !['video', 'image'].includes(asset.type)) throw fail('MUSIC_PLAN_VISUAL_TYPE', '画面来源只能是明确选中的视频或图片，不能使用音频。');
    const assetId = id(asset.id);
    if (asset.type === 'image') {
      if (metadata.has(assetId) && metadata.get(assetId).type !== 'image') throw fail('MUSIC_PLAN_ASSET_CONFLICT', '同一素材ID的类型不同。');
      metadata.set(assetId, { type: 'image' });
      return { index, assetId, type: 'image', from: 0, to: Infinity };
    }
    const duration = finite(asset.duration, '视频时长', Number.MIN_VALUE);
    const from = asset.sourceRange == null ? 0 : finite(asset.sourceRange.start, '视频源起点');
    const to = asset.sourceRange == null ? duration : finite(asset.sourceRange.end, '视频源终点');
    if (to <= from || to > duration) throw fail('MUSIC_PLAN_SOURCE_RANGE', '视频候选区间必须位于该素材真实时长内。');
    const prior = metadata.get(assetId);
    if (prior && (prior.type !== 'video' || prior.duration !== duration)) throw fail('MUSIC_PLAN_ASSET_CONFLICT', '同一视频ID的类型或时长不同。');
    metadata.set(assetId, { type: 'video', duration });
    return { index, assetId, type: 'video', from, to };
  });
}

function normalizeBeats(rhythm, coverage) {
  if (!Array.isArray(rhythm.beats) || rhythm.beats.length > 50000) throw fail('MUSIC_PLAN_BEATS', '节拍记录需要有效且有界的真实拍点数组。');
  const byTime = new Map();
  for (const raw of rhythm.beats) {
    if (!object(raw) || typeof raw.inferred !== 'boolean') throw fail('MUSIC_PLAN_BEATS', '节拍记录需明确已观察或推断来源。');
    const time = finite(raw.time, '拍点源时间'), strength = finite(raw.strength, '拍点强度'), confidence = finite(raw.confidence, '拍点证据分数');
    if (strength > 1 || confidence > 1 || time < coverage.start - COVERAGE_EPS || time > coverage.end + COVERAGE_EPS) throw fail('MUSIC_PLAN_BEAT_COORDINATE', '拍点必须是实际分析覆盖内的源绝对秒数，不能使用片段相对时间或越界引用。');
    const beat = { time, strength, confidence, inferred: raw.inferred === true }, previous = byTime.get(time);
    if (!previous || previous.inferred && !beat.inferred || previous.inferred === beat.inferred && beat.confidence > previous.confidence) byTime.set(time, beat);
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

function autoCuts(times, start, end) {
  const cuts = []; let index = 0, previous = start;
  while (index < times.length) {
    const choices = [];
    for (let count = 1; count <= times.length - index; count *= 2) {
      const at = index + count - 1, duration = times[at] - previous;
      if (duration > EPS) choices.push({ at, score: Math.abs(duration - 1.5) + (duration < 1 ? (1 - duration) * 3 : duration > 2 ? (duration - 2) * 3 : 0) });
    }
    choices.sort((a, b) => a.score - b.score || a.at - b.at);
    if (!choices.length) break;
    const selected = choices[0]; cuts.push(times[selected.at]); previous = times[selected.at]; index = selected.at + 1;
  }
  // Merge a tiny tail by removing a measured cut; never invent a new boundary.
  while (cuts.length && end - cuts.at(-1) < .6) cuts.pop();
  return cuts;
}

function available(candidate, length, used, cursor) {
  if (candidate.type === 'image') return 0;
  let from = Math.max(candidate.from, cursor.get(candidate.index) ?? candidate.from);
  for (const interval of [...(used.get(candidate.assetId) || [])].sort((a, b) => a.start - b.start)) if (interval.end > from + EPS && interval.start < from + length - EPS) from = Math.max(from, interval.end);
  return from + length <= candidate.to + EPS ? from : null;
}

/**
 * Deterministic read-only planning. Beat times are source-absolute seconds;
 * visual start/end are source seconds, at/cutTimes are film seconds.
 * No BPM-derived timestamps, visual retiming, native writes, or asset lookup.
 */
export function buildMusicCutPlan({ rhythm, music, assets, placement, cadence = 'auto', allowUncertain = false, reuseSources = false, signal } = {}) {
  abort(signal);
  if (!object(rhythm) || !object(rhythm.coverage) || !object(music) || !object(placement)) throw fail('MUSIC_PLAN_INPUT', '需要真实节奏记录、所选音乐和明确作品区间。');
  const coverage = { start: finite(rhythm.coverage.start, '分析源起点'), end: finite(rhythm.coverage.end, '分析源终点') };
  if (coverage.end < coverage.start) throw fail('MUSIC_PLAN_COVERAGE', '分析覆盖区间无效。');
  const selectedMusic = { assetId: id(music.assetId), sourceStart: finite(music.sourceStart, '音乐源起点'), sourceEnd: finite(music.sourceEnd, '音乐源终点'), timelineAt: finite(music.timelineAt, '音乐作品位置'), speed: music.speed === undefined ? 1 : finite(music.speed, '音乐速度', .1), volume: music.volume === undefined ? 1 : finite(music.volume, '音乐音量') };
  if (selectedMusic.sourceEnd <= selectedMusic.sourceStart || selectedMusic.speed > 100) throw fail('MUSIC_PLAN_MUSIC_RANGE', '音乐源区间/固定速度无效（速度0.1至100倍）。');
  for (const sourceId of [rhythm.assetId, rhythm.sourceAssetId, rhythm.source?.assetId].filter(value => value != null)) if (sourceId !== selectedMusic.assetId) throw fail('MUSIC_PLAN_RHYTHM_ASSET', '节奏记录不属于所选音乐，不能使用其它素材的拍点。', 403);
  const range = { start: finite(placement.start, '作品起点'), end: finite(placement.end, '作品终点') };
  if (range.end <= range.start) throw fail('MUSIC_PLAN_PLACEMENT', '作品区间必须有正时长。');
  const requiredSource = { start: selectedMusic.sourceStart + (range.start - selectedMusic.timelineAt) * selectedMusic.speed, end: selectedMusic.sourceStart + (range.end - selectedMusic.timelineAt) * selectedMusic.speed };
  if (requiredSource.start < selectedMusic.sourceStart - EPS || requiredSource.end > selectedMusic.sourceEnd + EPS) throw fail('MUSIC_PLAN_MUSIC_COVERAGE', '所选音乐不能覆盖作品区间；不会拉伸音乐或扩大范围凑时长。');
  if (requiredSource.start < coverage.start - COVERAGE_EPS || requiredSource.end > coverage.end + COVERAGE_EPS) throw fail('MUSIC_PLAN_ANALYSIS_COVERAGE', '作品需要的音乐源区间未被实际分析覆盖。');
  if (!['auto', 'beat', 'half', 'strong', 'bar'].includes(cadence) || typeof allowUncertain !== 'boolean' || typeof reuseSources !== 'boolean') throw fail('MUSIC_PLAN_CADENCE', '节拍组或显式不确定/循环选项无效。');
  const candidates = normalizeAssets(assets), allBeats = normalizeBeats(rhythm, coverage);
  if (rhythm.tempoConfidence != null && (!Number.isFinite(rhythm.tempoConfidence) || rhythm.tempoConfidence < 0 || rhythm.tempoConfidence > 1)) throw fail('MUSIC_PLAN_INPUT', '整体节奏证据分数必须为0至1。');
  const sourceVersion = rhythm.sourceVersion ?? null;
  if (sourceVersion !== null && (typeof sourceVersion !== 'string' || !/^[a-f0-9]{64}$/.test(sourceVersion))) throw fail('MUSIC_PLAN_SOURCE_VERSION', '音乐源版本必须是可信服务提供的完整SHA256。');
  const warnings = (Array.isArray(rhythm.warnings) ? rhythm.warnings : []).filter(value => typeof value === 'string').slice(0, 24);
  const fingerprint = hash({ method: rhythm.method || null, version: rhythm.version || null, status: rhythm.status, bpm: rhythm.bpm ?? null, tempoConfidence: rhythm.tempoConfidence ?? null, coverage, beats: allBeats, sourceVersion, sourceHash: rhythm.sourceHash || rhythm.source?.sha256 || null, music: selectedMusic });
  const blocked = (code, message) => ({ version: 1, status: 'blocked', canApply: false, reason: { code, message }, timeline: [], cutTimes: [], boundaries: [], music: null, placement: range, sourceRangesUsed: [], sourceVersion, analysisFingerprint: fingerprint, warnings: [...warnings, message] });
  if (rhythm.status === 'cancelled') throw fail('REQUEST_CANCELLED', '节奏分析已取消，未生成写入计划。', 499);
  if (!['ready', 'uncertain', 'no-beat'].includes(rhythm.status)) return blocked('MUSIC_PLAN_ANALYSIS_UNAVAILABLE', '节奏分析未得到可核对结果。');
  if (rhythm.status === 'no-beat' || !allBeats.length) return blocked('MUSIC_PLAN_NO_BEAT', '没有可用的真实拍点；请换音乐、调整分析范围或明确提供节奏点。');
  const reliable = rhythm.status === 'ready' && Number.isFinite(rhythm.tempoConfidence) && rhythm.tempoConfidence >= .65;
  if (!reliable && !allowUncertain) return blocked('MUSIC_PLAN_UNCERTAIN', '节奏记录不够可靠，默认不自动写剪辑；请调整音乐/区间或明确允许使用现有不确定拍点。');
  if (!reliable) warnings.push('已显式允许不确定节奏，仅使用已观察拍点；证据分数不是准确率保证。');
  const observed = allBeats.filter(beat => !beat.inferred && (allowUncertain || beat.confidence >= .4));
  const excluded = allBeats.length - observed.length;
  if (excluded) warnings.push(`未使用${excluded}个推断或较弱拍点，没有按BPM补齐拍点。`);
  const inRange = observed.map(beat => ({ ...beat, filmTime: selectedMusic.timelineAt + (beat.time - selectedMusic.sourceStart) / selectedMusic.speed })).filter(beat => beat.filmTime >= range.start - EPS && beat.filmTime <= range.end + EPS);
  if (!inRange.length) return blocked('MUSIC_PLAN_NO_BEAT_IN_RANGE', '所选作品区间没有可用的已观察拍点，不会均分时长冒充卡点。');
  if (cadence === 'bar') return blocked('MUSIC_PLAN_METER_UNAVAILABLE', '当前记录没有拍号/小节首拍证据，不能把每4拍冒称强拍或小节。可选择auto、beat或half。');
  let selected = inRange.filter(beat => beat.filmTime > range.start + EPS && beat.filmTime < range.end - EPS);
  if (cadence === 'strong') {
    const strengths = inRange.map(beat => beat.strength);
    if (Math.max(...strengths) - Math.min(...strengths) < .12) return blocked('MUSIC_PLAN_ACCENTS_UNAVAILABLE', '没有明显强弱差异，不能把固定拍数组伪称强拍。');
    const threshold = Math.max(.55, quantile(strengths, .75)); selected = selected.filter(beat => beat.strength >= threshold);
    if (!selected.length) return blocked('MUSIC_PLAN_ACCENTS_UNAVAILABLE', '所选范围没有足够有证据的较强拍点。');
    warnings.push('strong仅按已测拍点强度选择较强落点，不表示拍号或小节首拍。');
  }
  let cutTimes = selected.map(beat => beat.filmTime);
  if (cadence === 'half') cutTimes = cutTimes.filter((_time, index) => (index + 1) % 2 === 0);
  if (cadence === 'auto') cutTimes = autoCuts(cutTimes, range.start, range.end);
  const boundaries = [range.start, ...cutTimes, range.end];
  if (boundaries.length - 1 > MAX_CLIPS) return blocked('MUSIC_PLAN_TOO_MANY_CLIPS', '本次计划超过2000片段容量，请拆分作品区间。');
  if (!cutTimes.length) warnings.push('范围不足一个可用拍组，保留单段，不插入人为等分切点。');
  const timeline = [], sourceRangesUsed = [], used = new Map(), history = new Map(), cursor = new Map(); let next = 0, reusedCount = 0;
  for (let index = 0; index < boundaries.length - 1; index++) {
    abort(signal); const at = boundaries[index], length = boundaries[index + 1] - at;
    let choice = null;
    for (let offset = 0; offset < candidates.length; offset++) { const candidate = candidates[(next + offset) % candidates.length], from = available(candidate, length, used, cursor); if (from !== null) { choice = { candidate, from, reset: false }; break; } }
    if (!choice && reuseSources) for (let offset = 0; offset < candidates.length; offset++) { const candidate = candidates[(next + offset) % candidates.length]; if (candidate.type === 'image' || candidate.to - candidate.from >= length - EPS) { choice = { candidate, from: candidate.from, reset: candidate.type === 'video' }; break; } }
    if (!choice) return blocked('MUSIC_PLAN_RESOURCES_INSUFFICIENT', `第${index + 1}段需要${length.toFixed(3)}秒画面，但已选视频剩余源段不足；不会改视觉速度或借用未选资源。可补素材、缩短范围或明确允许循环。`);
    const { candidate, from, reset } = choice, end = candidate.type === 'image' ? length : Math.min(candidate.to, from + length);
    if (reset) { used.delete(candidate.assetId); for (const entry of candidates) if (entry.assetId === candidate.assetId) cursor.set(entry.index, entry.from); }
    const prior = history.get(candidate.assetId) || [], reused = candidate.type === 'video' && prior.some(interval => interval.end > from + EPS && interval.start < end - EPS);
    next = (candidate.index + 1) % candidates.length;
    timeline.push({ assetId: candidate.assetId, start: from, end, at });
    sourceRangesUsed.push({ assetId: candidate.assetId, candidateIndex: candidate.index, type: candidate.type, sourceRange: candidate.type === 'image' ? null : { start: from, end }, allowedSourceRange: candidate.type === 'image' ? null : { start: candidate.from, end: candidate.to }, timelineRange: { start: at, end: boundaries[index + 1] }, ...(candidate.type === 'image' ? { holdSeconds: length } : {}), reused });
    if (candidate.type === 'video') { cursor.set(candidate.index, end); const interval = { start: from, end }, intervals = used.get(candidate.assetId) || []; intervals.push(interval); used.set(candidate.assetId, intervals); prior.push(interval); history.set(candidate.assetId, prior); if (reused) reusedCount++; }
  }
  if (reusedCount) warnings.push(`已显式循环复用${reusedCount}段所选视频，非新的连续动作或未选素材。`);
  if (cadence === 'auto' && boundaries.some((time, index) => index && time - boundaries[index - 1] > 2.5)) warnings.push('实际拍点较稀疏或尾段合并，部分画面长于2.5秒；没有制造等分拍点。');
  const croppedMusic = { assetId: selectedMusic.assetId, sourceStart: Math.max(selectedMusic.sourceStart, requiredSource.start), sourceEnd: Math.min(selectedMusic.sourceEnd, requiredSource.end), timelineAt: range.start, speed: selectedMusic.speed, volume: selectedMusic.volume };
  return { version: 1, status: 'ready', canApply: true, timeline, cutTimes, boundaries, music: croppedMusic, placement: range, cadence, sourceRangesUsed, sourceVersion, analysisFingerprint: fingerprint, warnings, observedBeatCount: inRange.length, excludedBeatCount: excluded, reusedVideoSegments: reusedCount, visualSpeed: 1 };
}
