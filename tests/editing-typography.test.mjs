import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, normalizeModelData } from '../lib/prompts.mjs';
import { fitTypography, wrapTypographyText, normalizeTypographyLayout, buildCaptionPage } from '../lib/typography-layout.mjs';
import { normalizeClipEffects } from '../lib/edit-effects.mjs';
import { applyPictureEffects } from '../lib/openfilm-placement.mjs';
import { readMotion, valueAt, writeMotion } from '../integrations/openfilm/packages/openfilm/src/clip-motion.mjs';

const payload = () => ({ instruction: '按真实动作片段精剪并配清楚标题', script: '已知画面安排', assets: [{ id: 'a', name: 'a.mp4', type: 'video', duration: 8 }], timeline: [],
  sourceAnalysis: { items: [{ assetId: 'a', frames: [{ id: 'f001.jpg', shotId: 's1', timestamp: 2 }, { id: 'f002.jpg', shotId: 's1', timestamp: 4 }],
    shots: [{ id: 's1', cues: { id: 's1:visual', kind: 'visual-sampled', sourceRange: { start: 1, end: 6 }, evidence: ['f001.jpg', 'f002.jpg'] } }] }] } });

test('editorial source choices drive real speed and subtitle source-to-output timing', () => {
  const data = normalizeModelData('edit-plan', { title: '剪辑', timeline: [{ assetId: 'a', start: 1, end: 5, speed: 2, purpose: 'action', cueIds: ['s1:visual'], reason: '保留实际动作前后',
    framing: { mode: 'cover', focusX: .35, focusY: .5 }, motion: { preset: 'push-in', duration: .6, amount: .08 } }],
    captions: [{ text: '标题', start: 0, end: 2, placement: 'title', layout: { role: 'headline', align: 'left' } },
      { text: '源字幕', source: { clipIndex: 0, start: 2, end: 4 }, layout: { role: 'subtitle' } }] }, payload());
  assert.equal(data.timeline[0].speed, 2); assert.deepEqual(data.timeline[0].cueIds, ['s1:visual']);
  assert.deepEqual([data.captions[1].start, data.captions[1].end], [.5, 1.5]); assert.equal(data.captions[0].layout.align, 'left');
  assert.throws(() => normalizeModelData('edit-plan', { title: 'x', timeline: data.timeline, captions: [{ text: '错误时基', source: { clipIndex: 0, start: 2, end: 4 }, start: 2, end: 4 }] }, payload()), { code: 'MODEL_EDITORIAL_INVALID' });
});

test('cue IDs cannot cross assets, sampled ranges or become a motion claim from one frame', () => {
  for (const timeline of [
    [{ assetId: 'a', start: 1, end: 5, cueIds: ['invented'] }],
    [{ assetId: 'a', start: 0, end: 5, cueIds: ['s1:visual'] }],
    [{ assetId: 'a', start: 1, end: 3, cueIds: ['s1:visual'], purpose: 'action' }],
  ]) assert.throws(() => normalizeModelData('edit-plan', { title: 'x', timeline }, payload()), { code: 'MODEL_EDITORIAL_INVALID' });
  const other = payload(); other.assets.push({ id: 'b', type: 'video', duration: 8 });
  assert.throws(() => normalizeModelData('edit-plan', { title: 'x', timeline: [{ assetId: 'b', start: 1, end: 5, cueIds: ['s1:visual'] }] }, other), { code: 'MODEL_EDITORIAL_INVALID' });
});

test('multilingual line wrapping preserves text and typography never silently drops words or shrinks below readable bounds', () => {
  const text = '光电研究：从实验到应用。Optical Research';
  const fit = fitTypography(text, { width: 720, height: 1280, layout: { role: 'headline', maxLines: 3 } });
  assert.equal(fit.overflow, false); assert.equal(fit.lines.join(''), text); assert.ok(fit.fontSize >= 720 * .052 - .001);
  assert.ok(fit.lines.every(line => !/^[，。！？）]/.test(line))); assert.ok(fit.box.x >= 720 * .075 - .001);
  const crowded = fitTypography('完整文字不可截断'.repeat(80), { width: 1280, height: 720, layout: { role: 'headline', maxLines: 2 } });
  assert.equal(crowded.overflow, true); assert.equal(crowded.lines.join(''), '完整文字不可截断'.repeat(80));
  assert.throws(() => buildCaptionPage('完整文字不可截断'.repeat(80), { w: 1280, h: 720 }, 5, { role: 'headline' }), { code: 'TYPOGRAPHY_INVALID' });
  assert.equal(wrapTypographyText('WWW Optical', 100, 20, (value, size) => value.length * size).join(''), 'WWW Optical');
  assert.throws(() => normalizeTypographyLayout({ css: 'url(file:///secret)' }), { code: 'TYPOGRAPHY_INVALID' });
});

test('per-clip native motion creates actual keyframes with a stable hold, leaving source and unrelated effects intact', () => {
  const clip = { id: 'picture', src: 'a.mp4', time: [1, 5], speed: 2, box: { x: 0, y: 0, w: 1280, h: 720 }, style: 'object-fit: contain; opacity: .8' }, keyframes = {};
  applyPictureEffects(clip, normalizeClipEffects({ motion: { preset: 'pan-left', amount: .08, duration: .6 }, framing: { mode: 'cover', focusX: .25, focusY: .5 } }), { stage: { w: 1280, h: 720 }, keyframes });
  const motion = readMotion(clip, keyframes);
  assert.deepEqual(clip.time, [1, 5]); assert.equal(clip.speed, 2); assert.match(clip.style, /opacity: .8/); assert.match(clip.style, /object-position: 25% 50%/);
  assert.ok(valueAt('translate', motion.translate, .1)[0] > valueAt('translate', motion.translate, .5)[0]);
  assert.deepEqual(valueAt('translate', motion.translate, 1), valueAt('translate', motion.translate, 1.9));
  assert.equal(valueAt('scale', motion.scale, 1.9), 1.16); assert.equal(motion.scale.at(-1).t, 2);
  assert.throws(() => applyPictureEffects({ ...clip }, normalizeClipEffects({ motion: { preset: 'push-in', duration: 3 } }), { stage: { w: 1280, h: 720 }, keyframes: {} }), { code: 'INVALID_EDIT_EFFECT' });
  const sourceTime = [...clip.time]; applyPictureEffects(clip, normalizeClipEffects({ motion: { preset: 'none' } }), { stage: { w: 1280, h: 720 }, keyframes });
  assert.deepEqual(readMotion(clip, keyframes), {}); assert.deepEqual(clip.time, sourceTime); assert.equal(clip.speed, 2); assert.match(clip.style, /opacity: .8/);
});

test('editorial cue matching uses the correct page and cannot combine colliding frame IDs across pages', () => {
  const page = (start, end, id, timestamps) => ({ assetId: 'a', frames: timestamps.map((timestamp, index) => ({ id: `f00${index + 1}.jpg`, shotId: id, timestamp })),
    shots: [{ id, cues: { id: `${id}:visual`, kind: 'visual-sampled', sourceRange: { start, end }, evidence: timestamps.map((_, index) => `f00${index + 1}.jpg`) } }] });
  const data = payload(); data.assets[0].duration = 16; data.sourceAnalysis.items = [page(10, 13, 'later', [10.2, 12.2]), page(0, 3, 'early', [.2, 2.2])];
  const first = normalizeModelData('edit-plan', { title: 'x', timeline: [{ assetId: 'a', start: 0, end: 3, purpose: 'action', cueIds: ['early:visual'] }] }, data);
  assert.deepEqual(first.timeline[0].cueIds, ['early:visual']);
  assert.doesNotThrow(() => normalizeModelData('edit-plan', { title: 'x', timeline: [{ assetId: 'a', start: 10, end: 13, purpose: 'action', cueIds: ['later:visual'] }] }, data));
  data.sourceAnalysis.items = [page(0, 3, 'same', [.2]), page(0, 3, 'same', [2.2])];
  assert.throws(() => normalizeModelData('edit-plan', { title: 'x', timeline: [{ assetId: 'a', start: 0, end: 3, purpose: 'action', cueIds: ['same:visual'] }] }, data), { code: 'MODEL_EDITORIAL_INVALID' });
});

test('camera presets replace the camera combination while retaining unrelated rotation and opacity', () => {
  const clip = { id: 'camera', src: 'a.mp4', time: [0, 2], box: { x: 20, y: 10, w: 1280, h: 720 }, style: 'object-fit: cover' };
  const extras = writeMotion(clip, { rotate: [{ t: 0, v: 0 }, { t: 2, v: 5 }], opacity: [{ t: 0, v: .8 }, { t: 2, v: .8 }] });
  clip.style = extras.style; const keyframes = Object.fromEntries(Object.entries(extras.keyframes).filter(([, body]) => body !== null));
  applyPictureEffects(clip, normalizeClipEffects({ motion: { preset: 'pan-left', amount: .08, duration: .6 } }), { stage: { w: 1280, h: 720 }, keyframes });
  const pan = readMotion(clip, keyframes);
  applyPictureEffects(clip, normalizeClipEffects({ motion: { preset: 'push-in', amount: .12, duration: .6 } }), { stage: { w: 1280, h: 720 }, keyframes });
  const push = readMotion(clip, keyframes); assert.equal(push.translate, undefined); assert.equal(push.scale.at(-1).v, 1.12); assert.deepEqual(push.rotate, pan.rotate); assert.deepEqual(push.opacity, pan.opacity);
  applyPictureEffects(clip, normalizeClipEffects({ motion: { preset: 'none' } }), { stage: { w: 1280, h: 720 }, keyframes });
  const stopped = readMotion(clip, keyframes); assert.equal(stopped.scale, undefined); assert.equal(stopped.translate, undefined); assert.deepEqual(stopped.rotate, pan.rotate); assert.deepEqual(stopped.opacity, pan.opacity);
  applyPictureEffects(clip, normalizeClipEffects({ motion: { preset: 'pan-right', amount: .08, duration: .6 } }), { stage: { w: 1280, h: 720 }, keyframes });
  applyPictureEffects(clip, normalizeClipEffects({ motion: { preset: 'push-in', amount: 0, duration: .6 } }), { stage: { w: 1280, h: 720 }, keyframes });
  const zero = readMotion(clip, keyframes); assert.equal(zero.scale, undefined); assert.equal(zero.translate, undefined); assert.deepEqual(zero.rotate, pan.rotate); assert.deepEqual(zero.opacity, pan.opacity);
  assert.deepEqual(clip.box, { x: 20, y: 10, w: 1280, h: 720 });
});
