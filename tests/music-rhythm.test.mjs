import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRhythm } from '../integrations/openfilm/packages/openfilm/lib/music-rhythm.mjs';
import { makePcm, grid, rhythmScenarios } from './fixtures/music-rhythm.mjs';

const scenarios = rhythmScenarios();
function accuracy(result, expected, tolerance = .02) {
  const times = result.beats.map(beat => beat.time), matched = expected.filter(time => times.some(actual => Math.abs(actual - time) <= tolerance));
  return matched.length / expected.length;
}
for (const fixture of scenarios.filter(item => item.id.startsWith('regular-'))) test(`actual PCM ${fixture.bpm} BPM has observed phases and accurate beat times`, () => {
  const result = analyzeRhythm(fixture.samples, fixture.sampleRate);
  assert.equal(result.status, 'ready'); assert.ok(Math.abs(result.bpm - fixture.bpm) <= 1, JSON.stringify(result.tempoCandidates));
  assert.ok(accuracy(result, fixture.beats) >= .98); assert.equal(result.beats.filter(beat => beat.inferred).length, 0);
  assert.ok(result.beats.every(beat => result.onsets.some(onset => onset.time === beat.time)), 'observed beats must reference detected attacks');
});
test('different rates and a source offset retain absolute source phase without altering PCM', () => {
  for (const sampleRate of [16000, 48000]) {
    const fixture = makePcm({ sampleRate, duration: 12, beats: grid(90, 12, .413) }), before = fixture.samples.slice(), result = analyzeRhythm(fixture.samples, sampleRate, { offsetSeconds: 25.75 });
    assert.equal(result.status, 'ready'); assert.ok(Math.abs(result.bpm - 90) <= 1); assert.deepEqual(result.coverage, { start: 25.75, end: 37.75 });
    assert.ok(accuracy(result, fixture.beats.map(time => time + 25.75)) >= .98); assert.deepEqual(fixture.samples, before);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result); assert.ok(result.beats.every(beat => beat.time >= result.coverage.start && beat.time <= result.coverage.end));
  }
});
test('accents and different attack frequencies preserve the underlying pulse and measured strength differences', () => {
  const fixture = scenarios.find(item => item.id === 'accented-120'), result = analyzeRhythm(fixture.samples, fixture.sampleRate);
  assert.ok(Math.abs(result.bpm - 120) <= 1); assert.equal(result.status, 'ready'); assert.ok(accuracy(result, fixture.beats) >= .95);
  assert.ok(Math.max(...result.onsets.map(item => item.strength)) - Math.min(...result.onsets.map(item => item.strength)) > .1);
});
test('syncopated actual attacks retain plausible tempo candidates and explicitly mark missing pulses without asserting meter', () => {
  const fixture = scenarios.find(item => item.id === 'syncopated-120'), result = analyzeRhythm(fixture.samples, fixture.sampleRate);
  assert.ok(Math.abs(result.bpm - 120) <= 1, 'do not default to the old 80 BPM interpretation'); assert.equal(result.status, 'uncertain');
  assert.ok(result.tempoCandidates.some(item => Math.abs(item.bpm - 60) <= 2)); assert.ok(accuracy(result, fixture.beats) >= .95);
  assert.ok(result.beats.some(beat => beat.inferred));
  assert.ok(result.beats.filter(beat => !beat.inferred).every(beat => result.onsets.some(onset => onset.time === beat.time)));
  assert.equal(Object.hasOwn(result, 'downbeats'), false); assert.equal(Object.hasOwn(result, 'meter'), false);
});
test('noise and incidental off-grid attacks do not pull the beat path onto each transient', () => {
  const fixture = scenarios.find(item => item.id === 'noise-and-off-grid-attacks'), result = analyzeRhythm(fixture.samples, fixture.sampleRate);
  assert.ok(Math.abs(result.bpm - 120) <= 2, JSON.stringify(result.tempoCandidates)); assert.ok(accuracy(result, fixture.beats) >= .9);
  assert.ok(result.beats.filter(beat => !beat.inferred).length < result.onsets.length, 'some detected incidental attacks should be excluded from the pulse');
});
test('tempo changes track actual local intervals and remain uncertain for unattended global cutting', () => {
  const fixture = scenarios.find(item => item.id === 'tempo-change'), result = analyzeRhythm(fixture.samples, fixture.sampleRate);
  assert.equal(result.status, 'uncertain'); assert.ok(accuracy(result, fixture.beats) >= .9);
  const observed = result.beats.filter(beat => !beat.inferred).map(beat => beat.time), gaps = observed.slice(1).map((time, index) => time - observed[index]);
  assert.ok(gaps.some(gap => Math.abs(gap - .5) < .02)); assert.ok(gaps.some(gap => Math.abs(gap - .4) < .02));
  assert.ok(result.warnings.some(warning => /changes|irregular/i.test(warning)));
});
test('weak periodic PCM and irregular/non-periodic noise are not ready for automatic cuts', () => {
  for (const name of ['weak-120', 'irregular-attacks', 'unmodulated-noise']) {
    const fixture = scenarios.find(item => item.id === name), result = analyzeRhythm(fixture.samples, fixture.sampleRate);
    assert.notEqual(result.status, 'ready', name);
    if (name === 'weak-120') { assert.equal(result.status, 'uncertain'); assert.ok(result.warnings.some(warning => /weak|low-level/i.test(warning))); }
  }
});
test('silence, held tones and short windows never claim an automatic rhythm grid', () => {
  const rate = 22050, tone = Float32Array.from({ length: rate * 8 }, (_, i) => .3 * Math.sin(2 * Math.PI * 330 * i / rate));
  for (const samples of [new Float32Array(rate * 8), tone, new Float32Array(0)]) { const result = analyzeRhythm(samples, rate); assert.equal(result.status, 'no-beat'); assert.equal(result.bpm, null); assert.deepEqual(result.beats, []); }
  const fixture = makePcm({ duration: 2, beats: grid(120, 2) }); assert.notEqual(analyzeRhythm(fixture.samples, rate).status, 'ready');
});
test('invalid PCM/rate/source offsets fail explicitly', () => {
  assert.throws(() => analyzeRhythm([0, 1], 22050), TypeError);
  assert.throws(() => analyzeRhythm(Float32Array.of(NaN), 22050), TypeError);
  assert.throws(() => analyzeRhythm(new Float32Array(20), 0), RangeError);
  assert.throws(() => analyzeRhythm(new Float32Array(20), 22050, { offsetSeconds: -1 }), RangeError);
});
