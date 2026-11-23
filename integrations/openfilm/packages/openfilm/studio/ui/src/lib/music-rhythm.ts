/** Audio analysis coordinates are source seconds; timeline coordinates are milliseconds. */
export interface RhythmBeat { time: number; strength: number; confidence: number; inferred: boolean }
export interface MusicRhythm {
  version: 1; method: string; status: 'ready' | 'uncertain' | 'no-beat'; duration: number;
  sourceDuration: number; sourceVersion: string; bpm: number | null; tempoConfidence: number;
  beats: RhythmBeat[]; onsets: { time: number; strength: number }[];
  coverage: { start: number; end: number; completeSource?: boolean }; warnings: string[];
}
export interface RhythmState { status: 'loading' | 'error' | 'ready' | 'uncertain' | 'no-beat'; value?: MusicRhythm; error?: string }
export interface RhythmClip { startMs: number; endMs: number; inMs?: number; speed?: number; sourceDurMs?: number; loop?: boolean }
export interface PlacedBeat extends RhythmBeat { ms: number; sourceTime: number; cycle: number }
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const unit = (v: number) => Math.max(0, Math.min(1, v));
export function readMusicRhythm(raw: unknown): MusicRhythm {
  const r = raw as Partial<MusicRhythm>;
  if (!r || r.version !== 1 || !['ready', 'uncertain', 'no-beat'].includes(r.status || '') || !finite(r.duration) || !finite(r.sourceDuration) || r.sourceDuration <= 0 ||
    typeof r.sourceVersion !== 'string' || !/^[a-f0-9]{64}$/.test(r.sourceVersion) || !finite(r.coverage?.start) || !finite(r.coverage?.end) || r.coverage!.start < 0 || r.coverage!.end < r.coverage!.start || !Array.isArray(r.beats) || !finite(r.tempoConfidence)) throw new Error('节奏分析返回的数据不完整，请重新识别。');
  const beats = r.beats.filter(b => finite(b.time) && b.time >= r.coverage!.start && b.time <= r.coverage!.end + .001 && finite(b.strength) && finite(b.confidence)).map(b => ({ ...b, strength: unit(b.strength), confidence: unit(b.confidence), inferred: b.inferred === true }));
  return { ...r, beats, warnings: Array.isArray(r.warnings) ? r.warnings.filter(v => typeof v === 'string').slice(0, 12) : [] } as MusicRhythm;
}
/** One source may appear on many clips. Trim and speed are applied before its film offset; only explicit loops wrap. */
export function placeRhythmBeats(value: MusicRhythm, clip: RhythmClip): PlacedBeat[] {
  if (!finite(clip.startMs) || !finite(clip.endMs) || !Number.isSafeInteger(Math.round(clip.endMs)) || !(clip.endMs > clip.startMs) || !finite(clip.inMs ?? 0) || !finite(clip.speed ?? 1) || (clip.speed ?? 1) <= 0 || !finite(value.sourceDuration) || value.sourceDuration <= 0 || !value.beats.length || value.status === 'no-beat') return [];
  const speed = clip.speed && clip.speed > 0 ? clip.speed : 1, from = Math.max(0, clip.inMs || 0);
  const span = (clip.endMs - clip.startMs) * speed, sourceMs = (clip.sourceDurMs || value.sourceDuration * 1000);
  if (!finite(span) || !finite(sourceMs) || sourceMs <= 0) return [];
  const loop = clip.loop === true && sourceMs > 0, firstCycle = loop ? Math.floor(from / sourceMs) : 0, lastCycle = loop ? Math.floor((from + span) / sourceMs) : 0;
  if (!Number.isSafeInteger(firstCycle) || !Number.isSafeInteger(lastCycle) || lastCycle - firstCycle > 10000) return [];
  const output: PlacedBeat[] = [];
  for (let cycle = firstCycle; cycle <= lastCycle && output.length < 20000; cycle++) for (const beat of value.beats) {
    const source = beat.time * 1000 + (loop ? cycle * sourceMs : 0), relative = source - from;
    if (relative < -.001 || relative >= span - .001 || (!loop && source >= sourceMs + .001)) continue;
    output.push({ ...beat, ms: clip.startMs + relative / speed, sourceTime: beat.time, cycle });
  }
  return output.sort((a, b) => a.ms - b.ms);
}
/** Uncertain tempo remains visible with a warning, but cannot silently pull a drag or create automatic cuts. */
export function rhythmSnapTimes(state: RhythmState | undefined, clip: RhythmClip): number[] {
  return state?.status === 'ready' && state.value?.status === 'ready' && state.value.tempoConfidence >= .55 ? placeRhythmBeats(state.value, clip).filter(b => b.confidence >= .5 && !b.inferred).map(b => b.ms) : [];
}
export function rhythmStatusText(state: RhythmState | undefined): string {
  if (!state || state.status === 'loading') return '正在识别音乐节奏…';
  if (state.status === 'error') return state.error || '节奏分析未完成。';
  const value = state.value;
  if (!value || value.status === 'no-beat') return '未找到稳定节拍；保留波形，可手工剪辑。';
  const coverage = value.coverage.completeSource === false ? ` · 仅源区间 ${value.coverage.start.toFixed(2)}–${value.coverage.end.toFixed(2)} 秒` : '';
  if (value.status === 'uncertain') return `节奏不确定${value.bpm ? ` · 约 ${Math.round(value.bpm)} BPM` : ''}，不自动吸附或卡点${coverage}`;
  return `${value.bpm ? `${Math.round(value.bpm)} BPM · ` : ''}${value.beats.length} 个节奏点 · 置信度 ${Math.round(value.tempoConfidence * 100)}%${coverage}`;
}
