import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectRegion, replaceRegion, measureFilm } from '../lib/openfilm-placement.mjs';
import { normalizeEditScope, addsTimeline } from '../lib/edit-scope.mjs';
import { contextForEditScope, editScopeSnapshot, selectTimelineRange } from '../public/editor-scope.js';
import { MAX_TIME_SECONDS } from '../public/time-range.js';
import { applyOps } from '../integrations/openfilm/packages/openfilm/studio/server/ops.mjs';
import { readFilm, clipFade } from '../integrations/openfilm/packages/openfilm/src/film-doc.mjs';
import { readMotion, writeMotion } from '../integrations/openfilm/packages/openfilm/src/clip-motion.mjs';

const stage = { w: 1280, h: 720 }, all = value => value.tracks.flatMap(track => track.clips || []);
function fixture() {
  const picture = { id: 'picture', src: 'first.mp4', time: [0, 10], speed: 2, volume: .3, box: { x: 5, y: 7, w: 1000, h: 650 }, style: 'object-fit: cover', overrides: [{ fade: [.25, .75] }], attrs: { 'data-user-note': 'keep', title: 'original' } };
  const motion = writeMotion(picture, { opacity: [{ t: 0, v: .4 }, { t: 5, v: 1 }] }); picture.style = motion.style;
  return { stage, keyframes: motion.keyframes, tracks: [
    { attrs: { id: 'guangxuan-captions' }, clips: [{ id: 'caption', src: 'caption.html', at: 0, time: [0, 10], size: stage, attrs: { 'data-guangxuan-caption': 'true' } }] },
    { attrs: { id: 'guangxuan-picture' }, clips: [picture, { id: 'later', src: 'later.mp4', at: 8, time: [0, 2] }] },
    { locked: true, attrs: { id: 'music' }, clips: [{ id: 'music', src: 'music.wav', time: [1, 11], volume: .2 }] },
    { attrs: { id: 'user-overlay' }, clips: [{ id: 'overlay', src: 'overlay.html', at: .5, time: [0, 8], size: stage, attrs: { 'data-user-note': 'untouched' } }] },
  ] };
}
const range = { mode: 'range', start: 1, end: 3, clipIds: ['picture'] };
const segment = () => ({ stage, tracks: [
  { attrs: { id: 'guangxuan-captions' }, clips: [{ id: 'new-caption', src: 'new.html', at: .25, time: [0, 1.5], size: stage }] },
  { attrs: { id: 'guangxuan-picture' }, clips: [{ id: 'new-picture', src: 'replacement.mp4', time: [0, 2], box: { x: 0, y: 0, w: 1280, h: 720 } }] },
] });

test('range scope is explicit, bounded, and independent from append or asset selection', () => {
  const scoped = normalizeEditScope({ assetIds: ['one'], placement: range }, [{ id: 'one' }, { id: 'two' }]);
  assert.deepEqual(scoped.placement, range); assert.equal(addsTimeline(scoped), false);
  for (const bad of [{ start: 1, end: 1 }, { start: -1, end: 3 }, { start: 1, end: MAX_TIME_SECONDS + 1 }, { start: 1, end: Infinity }, { start: 1, end: 3, clipIds: ['../clip'] }]) assert.throws(() => normalizeEditScope({ placement: { mode: 'range', ...bad } }), error => error.code === 'INVALID_EDIT_RANGE');
  assert.deepEqual(normalizeEditScope({ placement: { mode: 'range', start: 86400, end: 90001 } }).placement, { mode: 'range', start: 86400, end: 90001 });
  assert.deepEqual(normalizeEditScope({ placement: { mode: 'range', start: 3900, end: 4000 } }).placement, { mode: 'range', start: 3900, end: 4000 });
  const project = { id: 'unit-range', video: {} };
  selectTimelineRange(project, { range: { start: 1, end: 3 }, clipIds: ['picture'] });
  assert.deepEqual(editScopeSnapshot(project, { duration: 10, assets: [] }).placement, range);
  assert.throws(() => editScopeSnapshot(project, { duration: 2, assets: [] }), /超出/);
  const context = { duration: 10, assets: [{ id: 'one' }, { id: 'two' }], timeline: [{ id: 'picture', assetId: 'one', at: 0, start: 0, end: 10, speed: 2 }, { id: 'later', assetId: 'two', at: 8, start: 0, end: 2, speed: 1 }] };
  const selected = contextForEditScope(context, { placement: range });
  assert.equal(selected.duration, 10); assert.equal(selected.timeline.length, 1);
  assert.deepEqual(selected.timeline[0], { id: 'picture', assetId: 'one', at: 1, start: 2, end: 6, speed: 2 });
  assert.equal(context.timeline[0].start, 0);
});

test('fixed region replacement splits only main picture boundaries and preserves other tracks', () => {
  const before = fixture(), original = structuredClone(before);
  const snapshot = inspectRegion(before, range, {}, { mainTrack: 1 });
  const plan = replaceRegion(snapshot, { stage, tracks: [segment().tracks[1]] }, { hasTimeline: true, hasCaptions: false });
  const after = applyOps(structuredClone(before), plan.ops), clips = all(after);
  assert.deepEqual(readFilm(after).problems, []); assert.deepEqual(before, original);
  for (const id of ['caption', 'later', 'music', 'overlay']) assert.deepEqual(clips.find(clip => clip.id === id), all(before).find(clip => clip.id === id));
  assert.deepEqual(after.tracks.find(track => track.attrs?.id === 'music'), before.tracks[2]);
  const left = clips.find(clip => clip.id === 'picture'), right = clips.find(clip => clip.src === 'first.mp4' && clip.at === 3);
  assert.deepEqual(left.time, [0, 2]); assert.deepEqual(right.time, [6, 10]);
  for (const clip of [left, right]) { assert.equal(clip.speed, 2); assert.equal(clip.volume, .3); assert.deepEqual(clip.box, before.tracks[1].clips[0].box); assert.deepEqual(clip.attrs, before.tracks[1].clips[0].attrs); }
  assert.deepEqual(clipFade(left), [.25, 0]); assert.deepEqual(clipFade(right), [0, .75]);
  assert.equal(readMotion(right, after.keyframes).opacity[0].v, .76);
  assert.equal(clips.find(clip => clip.id === 'new-picture').at, 1);
  assert.equal(measureFilm(after).duration, measureFilm(before).duration);
});

test('local captions replace only the chosen span and new captions use the local time origin', () => {
  const before = fixture();
  const snapshot = inspectRegion(before, range, {}, { mainTrack: 1, timeline: false, replaceCaptions: true });
  const plan = replaceRegion(snapshot, { stage, tracks: [segment().tracks[0]] }, { hasTimeline: false, hasCaptions: true });
  const after = applyOps(structuredClone(before), plan.ops), clips = all(after);
  for (const id of ['picture', 'later', 'music', 'overlay']) assert.deepEqual(clips.find(clip => clip.id === id), all(before).find(clip => clip.id === id));
  assert.equal(clips.find(clip => clip.id === 'new-caption').at, 1.25);
  const old = clips.filter(clip => clip.src === 'caption.html');
  assert.equal(old.length, 2); assert.deepEqual(old.find(clip => clip.id === 'caption').time, [0, 1]);
  assert.equal(old.find(clip => clip.id !== 'caption').at, 3); assert.deepEqual(old.find(clip => clip.id !== 'caption').time, [3, 10]);
  const append = inspectRegion(before, range, {}, { mainTrack: 1, timeline: false });
  const added = applyOps(structuredClone(before), replaceRegion(append, { stage, tracks: [segment().tracks[0]] }, { hasTimeline: false, hasCaptions: true }).ops);
  for (const clip of all(before)) assert.deepEqual(all(added).find(value => value.id === clip.id), clip);
});

test('unmeasured unrelated overlays and later pages are preserved without blocking a safe video range', () => {
  const before = fixture(); delete before.tracks[3].clips[0].time;
  before.tracks[1].clips.push({ id: 'later-page', src: 'later-page.html', at: 12, size: stage });
  const old = structuredClone(before);
  const snapshot = inspectRegion(before, range, {}, { mainTrack: 1 });
  const after = applyOps(structuredClone(before), replaceRegion(snapshot, { stage, tracks: [segment().tracks[1]] }, { hasTimeline: true, hasCaptions: false }).ops);
  assert.deepEqual(all(after).find(clip => clip.id === 'overlay'), all(old).find(clip => clip.id === 'overlay'));
  assert.deepEqual(all(after).find(clip => clip.id === 'later-page'), all(old).find(clip => clip.id === 'later-page'));
  assert.deepEqual(before, old);
});

test('out-of-range, stale, locked, unknown style and duration mismatches reject without changing the document', () => {
  const before = fixture(), original = structuredClone(before);
  for (const [placement, code] of [[{ ...range, end: 11 }, 'OPENFILM_RANGE_OUTSIDE_TIMELINE'], [{ ...range, clipIds: ['later'] }, 'OPENFILM_RANGE_SELECTION_STALE']]) assert.throws(() => inspectRegion(before, placement, {}, { mainTrack: 1 }), error => error.code === code);
  const snapshot = inspectRegion(before, range, {}, { mainTrack: 1 });
  const short = segment(); short.tracks[1].clips[0].time = [0, 1.9];
  assert.throws(() => replaceRegion(snapshot, short), error => error.code === 'OPENFILM_RANGE_DURATION_MISMATCH');
  const overflow = segment(); overflow.tracks[0].clips[0].at = 1;
  assert.throws(() => replaceRegion(snapshot, overflow, { hasCaptions: true }), error => error.code === 'OPENFILM_RANGE_PLAN_OUTSIDE');
  const locked = fixture(); locked.tracks[1].locked = true;
  assert.throws(() => inspectRegion(locked, range, {}, { mainTrack: 1 }), error => error.code === 'OPENFILM_TRACK_LOCKED');
  const custom = fixture(); custom.tracks[1].clips[0].style = 'animation: custom 5s both';
  assert.throws(() => inspectRegion(custom, range, {}, { mainTrack: 1 }), error => error.code === 'OPENFILM_SPLIT_STYLE_UNSUPPORTED');
  const vtt = fixture(); vtt.tracks.push({ captions: { src: 'captions.vtt' }, clips: [] });
  assert.throws(() => inspectRegion(vtt, range, {}, { mainTrack: 1, replaceCaptions: true }), error => error.code === 'OPENFILM_RANGE_CAPTIONS_UNSUPPORTED');
  assert.deepEqual(before, original);
});
