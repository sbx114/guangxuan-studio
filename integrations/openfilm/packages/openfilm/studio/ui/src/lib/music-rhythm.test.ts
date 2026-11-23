import test from 'node:test';
import assert from 'node:assert/strict';
import { placeRhythmBeats, rhythmSnapTimes, readMusicRhythm, type MusicRhythm } from './music-rhythm.ts';
const value = (duration = 4): MusicRhythm => ({ version: 1, method: 'fixture-measured-points', status: 'ready', duration, sourceDuration: duration, sourceVersion: 'a'.repeat(64), bpm: 120, tempoConfidence: .9, beats: Array.from({ length: duration * 2 }, (_, i) => ({ time: .25 + i * .5, strength: .8, confidence: .9, inferred: false })), onsets: [], coverage: { start: 0, end: duration, completeSource: true }, warnings: [] });
test('source beats follow trim and film offset, with the end excluded instead of repeated at an adjacent cut', () => {
  const raw = value(); const before = JSON.stringify(raw);
  assert.deepEqual(placeRhythmBeats(raw, { startMs: 1000, endMs: 3000, inMs: 500 }).map(b => b.ms), [1250, 1750, 2250, 2750]);
  assert.equal(JSON.stringify(raw), before);
});
test('1.25x retiming and an explicit source loop use source phase, not a stretched film grid', () => {
  assert.deepEqual(placeRhythmBeats(value(), { startMs: 5000, endMs: 7000, inMs: 250, speed: 1.25 }).map(b => b.ms), [5000, 5400, 5800, 6200, 6600]);
  const looped = { startMs: 10000, endMs: 14000, inMs: 1750, speed: 2, sourceDurMs: 2000, loop: true };
  assert.deepEqual(placeRhythmBeats(value(2), looped).map(b => b.ms), Array.from({ length: 16 }, (_, i) => 10000 + i * 250));
  assert.deepEqual(placeRhythmBeats(value(2), { ...looped, loop: false }).map(b => b.ms), [10000]);
});
test('uncertain, no-beat and inferred points do not automatically snap edits', () => {
  const raw = value(), clip = { startMs: 0, endMs: 4000 };
  assert.deepEqual(rhythmSnapTimes({ status: 'uncertain', value: { ...raw, status: 'uncertain' } }, clip), []);
  assert.deepEqual(rhythmSnapTimes({ status: 'no-beat', value: { ...raw, status: 'no-beat' } }, clip), []);
  assert.deepEqual(rhythmSnapTimes({ status: 'error', value: raw }, clip), []);
  assert.deepEqual(rhythmSnapTimes({ status: 'loading', value: raw }, clip), []);
  assert.deepEqual(placeRhythmBeats(raw, { ...clip, endMs: Infinity, loop: true }), []);
  assert.deepEqual(placeRhythmBeats(raw, { ...clip, speed: 0 }), []);
  raw.beats[0].inferred = true; raw.beats[1].confidence = .1;
  assert.deepEqual(rhythmSnapTimes({ status: 'ready', value: raw }, clip), [1250, 1750, 2250, 2750, 3250, 3750]);
});
test('partial source coverage stays at its source coordinates and invalid version evidence is rejected', () => {
  const partial = { ...value(), coverage: { start: 2, end: 4, completeSource: false }, beats: value().beats.filter(b => b.time >= 2) };
  assert.deepEqual(placeRhythmBeats(readMusicRhythm(partial), { startMs: 1000, endMs: 3000, inMs: 2000 }).map(b => b.ms), [1250, 1750, 2250, 2750]);
  assert.throws(() => readMusicRhythm({ ...partial, sourceVersion: 'old' }), /不完整/);
});
