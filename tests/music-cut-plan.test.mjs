import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMusicCutPlan } from '../lib/music-cut-plan.mjs';
import { analyzeRhythm } from '../integrations/openfilm/packages/openfilm/lib/music-rhythm.mjs';

const beat = (time, strength = .9, confidence = .9, inferred = false) => ({ time, strength, confidence, inferred });
function input(times = Array.from({ length: 21 }, (_, i) => i / 2)) {
  return { rhythm: { version: 1, method: 'actual-fixture-attacks', status: 'ready', bpm: 120, tempoConfidence: .9, coverage: { start: 0, end: 10 }, beats: times.map(time => beat(time)), warnings: [] }, music: { assetId: 'selected-music', sourceStart: 0, sourceEnd: 10, timelineAt: 0, speed: 1, volume: .7 }, assets: [{ id: 'selected-video', type: 'video', duration: 40 }], placement: { start: 0, end: 10 }, cadence: 'auto' };
}
const ready = data => { const plan = buildMusicCutPlan(data); assert.equal(plan.status, 'ready', JSON.stringify(plan)); assert.equal(plan.canApply, true); return plan; };
const code = (run, expected) => assert.throws(run, error => error.code === expected);

test('music trim, timeline offset and fixed speed map actual source beats into only the chosen film range', () => {
  const data = input([5, 6, 8, 11, 15, 19, 23, 25]);
  data.rhythm.coverage = { start: 4, end: 26 }; data.music = { ...data.music, sourceStart: 5, sourceEnd: 25, timelineAt: 10, speed: 2 }; data.placement = { start: 11, end: 18 }; data.cadence = 'beat';
  const plan = ready(data);
  assert.deepEqual(plan.cutTimes, [11.5, 13, 15, 17]); assert.deepEqual(plan.boundaries, [11, 11.5, 13, 15, 17, 18]);
  assert.deepEqual(plan.music, { assetId: 'selected-music', sourceStart: 7, sourceEnd: 21, timelineAt: 11, speed: 2, volume: .7 });
  assert.equal(plan.timeline[0].at, 11); assert.equal(plan.timeline.at(-1).at + plan.timeline.at(-1).end - plan.timeline.at(-1).start, 18);
});

test('irregular measured times are preserved; BPM never manufactures uniform cut times', () => {
  const data = input([0, .41, 1.03, 1.77, 2.34, 4.08, 5.16, 7.61, 9.1, 10]); data.cadence = 'beat'; data.rhythm.bpm = 999;
  const plan = ready(data); assert.deepEqual(plan.cutTimes, [.41, 1.03, 1.77, 2.34, 4.08, 5.16, 7.61, 9.1]);
  for (const entry of plan.timeline) assert.equal(Object.hasOwn(entry, 'speed'), false);
});

test('auto chooses actual multi-beat groups near 1–2s and merges a short tail without inventing a boundary', () => {
  const data = input(); const plan = ready(data), actual = new Set(data.rhythm.beats.map(item => item.time));
  assert.ok(plan.cutTimes.length < data.rhythm.beats.length / 2); assert.ok(plan.cutTimes.every(time => actual.has(time)));
  assert.ok(plan.timeline.every((entry, index) => plan.boundaries[index + 1] - entry.at >= .6));
  assert.deepEqual(plan.boundaries.slice(0, 2), [0, 1]);
});

test('half means groups of two observed beats, not synthesized half-beat intervals', () => {
  const data = input([0, .3, .9, 1.4, 2.1, 3, 4, 6, 8, 10]); data.cadence = 'half';
  assert.deepEqual(ready(data).cutTimes, [.9, 2.1, 4, 8]);
});

test('no beat from actual PCM and no-beat records block all native-writing plan fields', () => {
  const data = input(); data.rhythm = analyzeRhythm(new Float32Array(11025 * 10), 11025);
  const plan = buildMusicCutPlan(data); assert.equal(plan.reason.code, 'MUSIC_PLAN_NO_BEAT'); assert.equal(plan.canApply, false); assert.deepEqual(plan.timeline, []); assert.equal(plan.music, null);
});

test('uncertain evidence is blocked by default and opt-in uses only already observed points', () => {
  const data = input(); data.rhythm.status = 'uncertain'; data.rhythm.tempoConfidence = .5;
  assert.equal(buildMusicCutPlan(data).reason.code, 'MUSIC_PLAN_UNCERTAIN'); data.allowUncertain = true;
  const plan = ready(data); assert.match(plan.warnings.join(' '), /显式允许不确定/); assert.equal(plan.music.speed, 1);
});

test('inferred missing pulses never become a cut, including under explicit uncertain opt-in', () => {
  const data = input([0, .5, 1, 1.5, 2, 3, 4, 6, 8, 10]); data.cadence = 'beat'; data.rhythm.beats[2].inferred = true; data.allowUncertain = true;
  const plan = ready(data); assert.equal(plan.cutTimes.includes(1), false); assert.equal(plan.excludedBeatCount, 1); assert.match(plan.warnings.join(' '), /没有按BPM补齐/);
});

test('bar and flat strengths do not create an unsupported meter or strong-beat claim', () => {
  const data = input(); data.cadence = 'bar'; assert.equal(buildMusicCutPlan(data).reason.code, 'MUSIC_PLAN_METER_UNAVAILABLE');
  data.cadence = 'strong'; assert.equal(buildMusicCutPlan(data).reason.code, 'MUSIC_PLAN_ACCENTS_UNAVAILABLE');
});

test('strong chooses measured accent strengths while explicitly refusing meter attribution', () => {
  const data = input(); data.cadence = 'strong'; data.rhythm.beats.forEach((item, index) => { item.strength = index % 4 === 0 ? 1 : .3; });
  const plan = ready(data); assert.deepEqual(plan.cutTimes, [2, 4, 6, 8]); assert.match(plan.warnings.join(' '), /不表示拍号或小节首拍/);
});

test('wrong music asset, beat coverage and relative-time substitutions cannot cross references', () => {
  let data = input(); data.rhythm.assetId = 'unselected-other-music'; code(() => buildMusicCutPlan(data), 'MUSIC_PLAN_RHYTHM_ASSET');
  data = input(); data.rhythm.coverage = { start: 20, end: 30 }; data.music.sourceStart = 20; data.music.sourceEnd = 30;
  code(() => buildMusicCutPlan(data), 'MUSIC_PLAN_BEAT_COORDINATE');
});

test('scope must be covered by both the chosen music and the actual decoded analysis window', () => {
  let data = input(); data.placement.end = 11; code(() => buildMusicCutPlan(data), 'MUSIC_PLAN_MUSIC_COVERAGE');
  data = input(); data.rhythm.coverage.end = 9; data.rhythm.beats = data.rhythm.beats.filter(item => item.time <= 9); code(() => buildMusicCutPlan(data), 'MUSIC_PLAN_ANALYSIS_COVERAGE');
});

test('visual clips use lawful selected source trims, and audio or out-of-bounds candidate ranges are rejected', () => {
  const data = input(); data.assets = [{ id: 'v-a', type: 'video', duration: 30, sourceRange: { start: 10, end: 20 } }, { id: 'v-b', type: 'video', duration: 30, sourceRange: { start: 2, end: 12 } }];
  const plan = ready(data); assert.equal(plan.timeline[0].assetId, 'v-a'); assert.equal(plan.timeline[0].start, 10); assert.equal(plan.timeline[1].assetId, 'v-b');
  assert.ok(plan.sourceRangesUsed.every(item => item.sourceRange.start >= item.allowedSourceRange.start && item.sourceRange.end <= item.allowedSourceRange.end));
  data.assets = [{ id: 'only-audio', type: 'audio', duration: 30 }]; code(() => buildMusicCutPlan(data), 'MUSIC_PLAN_VISUAL_TYPE');
  data.assets = [{ id: 'v-a', type: 'video', duration: 5, sourceRange: { start: 3, end: 8 } }]; code(() => buildMusicCutPlan(data), 'MUSIC_PLAN_SOURCE_RANGE');
});

test('short visual source never silently stretches or loops; explicit reuse is bounded and reported', () => {
  const data = input(); data.assets[0].duration = 2;
  const blocked = buildMusicCutPlan(data); assert.equal(blocked.reason.code, 'MUSIC_PLAN_RESOURCES_INSUFFICIENT'); assert.deepEqual(blocked.timeline, []);
  data.reuseSources = true; const plan = ready(data); assert.ok(plan.reusedVideoSegments > 0); assert.match(plan.warnings.join(' '), /显式循环复用/); assert.ok(plan.timeline.every(item => item.end <= 2));
  assert.deepEqual(plan.timeline.slice(0, 6).map(item => item.start), [0, 1, 0, 1, 0, 1], 'explicit loops consume the entire selected range instead of repeating just its first slice');
});

test('still images can hold longer than their artificial four-second metadata duration', () => {
  const data = input([0, 5, 10]); data.assets = [{ id: 'selected-image', type: 'image', duration: 4 }];
  const plan = ready(data); assert.ok(plan.timeline.some(item => item.end - item.start > 4)); assert.ok(plan.sourceRangesUsed.every(item => item.sourceRange === null && item.holdSeconds > 0));
});

test('multiple source candidates of one selected asset do not silently reuse overlapping footage', () => {
  const data = input(); data.assets = [{ id: 'same-video', type: 'video', duration: 20, sourceRange: { start: 0, end: 6 } }, { id: 'same-video', type: 'video', duration: 20, sourceRange: { start: 4, end: 12 } }];
  const plan = ready(data); const ranges = plan.sourceRangesUsed.map(item => item.sourceRange).sort((a, b) => a.start - b.start);
  assert.ok(ranges.every((range, index) => !index || range.start >= ranges[index - 1].end - 1e-8));
});

test('identical calls are deterministic and do not mutate input; cancellation returns no plan', () => {
  const data = input(), before = structuredClone(data), first = ready(data), second = ready(data);
  assert.deepEqual(first, second); assert.deepEqual(data, before); assert.match(first.analysisFingerprint, /^[a-f0-9]{64}$/);
  const controller = new AbortController(); controller.abort(); code(() => buildMusicCutPlan({ ...data, signal: controller.signal }), 'REQUEST_CANCELLED'); assert.deepEqual(data, before);
});

test('trusted sourceVersion is forwarded without a file path and changes the analysis fingerprint', () => {
  const data = input(); data.rhythm.sourceVersion = 'a'.repeat(64); const first = ready(data);
  assert.equal(first.sourceVersion, data.rhythm.sourceVersion); assert.equal(Object.hasOwn(first.music, 'path'), false);
  data.rhythm.sourceVersion = 'b'.repeat(64); assert.notEqual(ready(data).analysisFingerprint, first.analysisFingerprint);
  data.rhythm.sourceVersion = 'client-file-path'; code(() => buildMusicCutPlan(data), 'MUSIC_PLAN_SOURCE_VERSION');
});

test('failed or unavailable analysis is never treated as an uncertainty opt-in', () => {
  const data = input(); data.allowUncertain = true; data.rhythm.status = 'failed'; data.rhythm.beats = [];
  const plan = buildMusicCutPlan(data); assert.equal(plan.reason.code, 'MUSIC_PLAN_ANALYSIS_UNAVAILABLE'); assert.equal(plan.canApply, false); assert.deepEqual(plan.timeline, []);
});

test('actual PCM-derived source-offset beats pass through a 2x music mapping without a manufactured grid', () => {
  const rate = 11025, samples = Float32Array.from({ length: rate * 10 }, (_, index) => {
    const t = index / rate, phase = t - .1;
    return phase < 0 ? 0 : .7 * Math.sin(2 * Math.PI * 1100 * t) * Math.exp(-(phase % .5) * 40);
  });
  const rhythm = analyzeRhythm(samples, rate, { offsetSeconds: 8 });
  assert.ok(rhythm.beats.some(item => !item.inferred), 'the controlled PCM fixture must yield actual attack anchors');
  const data = input(); data.rhythm = rhythm; data.music = { ...data.music, sourceStart: 8, sourceEnd: 18, timelineAt: 20, speed: 2 }; data.placement = { start: 20, end: 25 }; data.cadence = 'beat';
  if (rhythm.status === 'uncertain') assert.equal(buildMusicCutPlan(data).canApply, false);
  data.allowUncertain = true; const plan = ready(data);
  const observed = new Set(rhythm.beats.filter(item => !item.inferred).map(item => 20 + (item.time - 8) / 2));
  assert.ok(plan.cutTimes.length > 2); assert.ok(plan.cutTimes.every(time => observed.has(time))); assert.equal(plan.boundaries[0], 20); assert.equal(plan.boundaries.at(-1), 25);
});
