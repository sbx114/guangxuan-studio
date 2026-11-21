import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectPlacement, measureFilm, placeSegment, applyPictureEffects, inspectRegion, replaceRegion } from '../lib/openfilm-placement.mjs';
import { normalizeEditEffects } from '../lib/edit-effects.mjs';
import { MAX_TIME_SECONDS } from '../public/time-range.js';
import { applyOps } from '../integrations/openfilm/packages/openfilm/studio/server/ops.mjs';
import { readFilm, clipFade } from '../integrations/openfilm/packages/openfilm/src/film-doc.mjs';
import { readMotion, writeMotion } from '../integrations/openfilm/packages/openfilm/src/clip-motion.mjs';

const stage = { w: 1280, h: 720 };
function film() {
  const picture = { id: 'picture', src: 'clip.mp4', time: [0, 10], speed: 2, volume: .4, box: { x: 30, y: 40, w: 900, h: 600 }, style: 'object-fit: cover', overrides: [{ fade: [.5, .75] }], attrs: { title: 'User picture', 'data-user-label': 'retained' } };
  const motion = writeMotion(picture, { opacity: [{ t: 0, v: .4 }, { t: 5, v: 1 }] });
  picture.style = motion.style;
  return { stage, keyframes: motion.keyframes, tracks: [
    { attrs: { id: 'captions' }, clips: [{ id: 'subtitle', src: 'caption.html', at: 1, time: [0, 6], size: stage, attrs: { 'data-guangxuan-caption': 'true' } }] },
    { attrs: { id: 'guangxuan-picture' }, clips: [picture, { id: 'later', src: 'second.mp4', at: 8, time: [0, 2] }] },
    { attrs: { id: 'music' }, clips: [{ id: 'sound', src: 'sound.wav', time: [1, 9], volume: .2, overrides: [{ fade: [1, 1] }] }] },
  ] };
}
const segment = () => ({ stage, tracks: [
  { attrs: { id: 'guangxuan-captions' }, clips: [{ id: 'new-subtitle', src: 'new-caption.html', at: .5, time: [0, 1.5], size: stage }] },
  { attrs: { id: 'guangxuan-picture' }, clips: [{ id: 'new-picture', src: 'inserted.mp4', time: [0, 3], box: { x: 0, y: 0, w: stage.w, h: stage.h } }] },
] });
const all = doc => doc.tracks.flatMap(track => track.clips);

test('append uses the entire film end and leaves every existing clip unchanged', () => {
  const before = film(), original = structuredClone(before);
  const placement = placeSegment(inspectPlacement(before, { mode: 'append' }), segment(), { mainTrack: 1 });
  assert.equal(placement.at, 10); assert.equal(placement.duration, 3);
  assert.ok(placement.ops.every(op => op.op === 'insert'));
  const after = applyOps(structuredClone(before), placement.ops);
  assert.deepEqual(readFilm(after).problems, []);
  for (const clip of all(before)) assert.deepEqual(all(after).find(value => value.id === clip.id), clip);
  assert.equal(all(after).find(clip => clip.id === 'new-picture').at, 10);
  assert.equal(all(after).find(clip => clip.id === 'new-subtitle').at, 10.5);
  assert.equal(measureFilm(after).duration, 13); assert.deepEqual(before, original);
});

test('mid-clip insertion uses native splits and moves across picture, subtitle and music tracks', () => {
  const before = film(), plan = placeSegment(inspectPlacement(before, { mode: 'insert', at: 2 }), segment(), { mainTrack: 1 });
  const split = id => plan.ops.find(op => op.op === 'split' && op.clip === id);
  const after = applyOps(structuredClone(before), plan.ops), clips = all(after);
  assert.deepEqual(readFilm(after).problems, []);
  assert.deepEqual(clips.find(clip => clip.id === 'picture').time, [0, 4]);
  const rightPicture = clips.find(clip => clip.id === split('picture').restId);
  assert.equal(rightPicture.at, 5); assert.deepEqual(rightPicture.time, [4, 10]);
  assert.equal(rightPicture.speed, 2); assert.equal(rightPicture.volume, .4);
  assert.deepEqual(rightPicture.box, all(before).find(clip => clip.id === 'picture').box);
  assert.equal(rightPicture.attrs['data-user-label'], 'retained');
  assert.deepEqual(clipFade(clips.find(clip => clip.id === 'picture')), [.5, 0]);
  assert.deepEqual(clipFade(rightPicture), [0, .75]);
  const rightMotion = readMotion(rightPicture, after.keyframes);
  assert.deepEqual(rightMotion.opacity.map(key => key.t), [0, 3]);
  assert.ok(Math.abs(rightMotion.opacity[0].v - .64) < .0001);
  const rightSubtitle = clips.find(clip => clip.id === split('subtitle').restId);
  assert.equal(rightSubtitle.at, 5); assert.deepEqual(rightSubtitle.time, [1, 6]);
  const rightAudio = clips.find(clip => clip.id === split('sound').restId);
  assert.equal(rightAudio.at, 5); assert.deepEqual(rightAudio.time, [3, 9]); assert.equal(rightAudio.volume, .2);
  assert.equal(clips.find(clip => clip.id === 'later').at, 11);
  assert.equal(clips.find(clip => clip.id === 'new-picture').at, 2);
  assert.equal(clips.find(clip => clip.id === 'new-subtitle').at, 2.5);
  assert.equal(measureFilm(after).duration, 13);
});

test('insertion beyond the end leaves earlier clips still and allows the requested blank gap', () => {
  const before = film(), plan = placeSegment(inspectPlacement(before, { mode: 'insert', at: 20 }), segment(), { mainTrack: 1 });
  assert.ok(plan.ops.every(op => op.op === 'insert'));
  const after = applyOps(structuredClone(before), plan.ops);
  for (const clip of all(before)) assert.deepEqual(all(after).find(value => value.id === clip.id), clip);
  assert.equal(all(after).find(clip => clip.id === 'new-picture').at, 20);
  assert.equal(measureFilm(after).duration, 23);
});

test('append, insert and region replacement can edit a long timeline and source past a day', () => {
  const source = { stage, tracks: [{ attrs: { id: 'guangxuan-picture' }, clips: [{ id: 'long', src: 'long.mp4', time: [90000, 95000] }] }] }, known = { 'long.mp4': { duration: 100000 } }, original = structuredClone(source);
  const appended = applyOps(structuredClone(source), placeSegment(inspectPlacement(source, { mode: 'append' }, known), segment(), { known, mainTrack: 0 }).ops);
  assert.equal(measureFilm(appended, known).duration, 5003);
  const inserted = applyOps(structuredClone(source), placeSegment(inspectPlacement(source, { mode: 'insert', at: 4900 }, known), segment(), { known, mainTrack: 0 }).ops);
  assert.equal(measureFilm(inserted, known).duration, 5003); assert.deepEqual(all(inserted).find(clip => clip.id === 'long').time, [90000, 94900]);
  const remainder = all(inserted).find(clip => clip.src === 'long.mp4' && clip.id !== 'long'); assert.equal(remainder.at, 4903); assert.deepEqual(remainder.time, [94900, 95000]);
  const region = inspectRegion(source, { mode: 'range', start: 4900, end: 4903 }, known, { mainTrack: 0 }), replaced = applyOps(structuredClone(source), replaceRegion(region, segment(), { known, hasTimeline: true }).ops);
  assert.equal(measureFilm(replaced, known).duration, 5000); assert.equal(replaced.tracks[0].clips.find(clip => clip.id === 'new-picture').at, 4900);
  assert.deepEqual(source, original);
  assert.throws(() => inspectPlacement(source, { mode: 'insert', at: MAX_TIME_SECONDS + 1 }, known), error => error.code === 'INVALID_EDIT_PLACEMENT');
  assert.throws(() => placeSegment(inspectPlacement(source, { mode: 'insert', at: MAX_TIME_SECONDS }, known), segment(), { known }), error => error.code === 'OPENFILM_TIMELINE_TOO_LONG');
});

test('locked, unmeasured, WebVTT and unsupported animated crossings reject without mutating the document', () => {
  const cases = [
    [doc => { doc.tracks[0].locked = true; }, 'OPENFILM_TRACK_LOCKED'],
    [doc => { delete doc.tracks[0].clips[0].time; }, 'OPENFILM_LENGTH_UNKNOWN'],
    [doc => { doc.tracks.unshift({ clips: [], captions: { src: 'subtitles.vtt', kind: 'subtitles' } }); }, 'OPENFILM_CAPTION_TRACK_UNSUPPORTED'],
    [doc => { doc.tracks[1].clips[0].style = 'animation: custom-animation 4s both'; }, 'OPENFILM_SPLIT_STYLE_UNSUPPORTED'],
  ];
  for (const [change, code] of cases) {
    const doc = film(); change(doc); const original = structuredClone(doc);
    assert.throws(() => inspectPlacement(doc, { mode: 'insert', at: 2 }), error => error.code === code);
    assert.deepEqual(doc, original);
  }
  const vtt = film(); vtt.tracks.unshift({ clips: [], captions: { src: 'subtitles.vtt' } });
  assert.equal(inspectPlacement(vtt, { mode: 'append' }).at, 10);
});

test('bounded looks and fades affect only the supplied picture clip and omitted effects preserve its style', () => {
  const clip = { id: 'target', src: 'clip.mp4', time: [0, .4], box: { x: 30, y: 40, w: 600, h: 400 }, style: 'object-fit: cover; opacity: .8', overrides: [{ fade: [.05, .1] }] };
  const unchanged = structuredClone(clip); applyPictureEffects(unchanged, {}); assert.deepEqual(unchanged, clip);
  const changed = structuredClone(clip);
  applyPictureEffects(changed, normalizeEditEffects({ timeline: [], look: { preset: 'mono', strength: 1, css: 'url(https://outside.invalid/)' }, fade: { duration: 1.5 } }));
  assert.match(changed.style, /^object-fit: cover; opacity: .8; filter: grayscale\(1\)$/);
  assert.deepEqual(clipFade(changed), [.2, .2]); assert.deepEqual(changed.box, clip.box);
  assert.deepEqual(readFilm({ stage, tracks: [{ clips: [changed] }] }).problems, []);
  applyPictureEffects(changed, normalizeEditEffects({ timeline: [], fade: { duration: 0 } }));
  assert.equal(clipFade(changed), null); assert.equal(changed.overrides, undefined);
  assert.throws(() => normalizeEditEffects({ timeline: [], look: { preset: 'url(https://outside.invalid/)', strength: 1 } }), error => error.code === 'INVALID_EDIT_EFFECT');
});
