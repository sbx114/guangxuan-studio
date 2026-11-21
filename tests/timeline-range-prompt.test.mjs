import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, normalizeModelData } from '../lib/prompts.mjs';

const input = () => ({
  instruction: '仅修改所选片段并加标题，保持前后不变',
  script: '实验示意说明',
  context: { assets: [{ id: 'media', name: '实验.mp4', type: 'video', duration: 30 }], timeline: [{ id: 'inside', assetId: 'media', start: 0, end: 8, at: 2, speed: 2 }], duration: 12, mainTrackEditable: true, aspect: '16:9' },
  editScope: { placement: { mode: 'range', start: 2, end: 6, clipIds: ['inside'] } },
});
const response = () => ({ action: 'edit', message: '仅调整2至6秒', plan: { timeline: [{ clipId: 'inside', assetId: 'media', start: 0, end: 8 }], captions: [{ start: 0, end: 4, text: '局部标题', placement: 'title' }] } });

test('AI range prompt names fixed boundaries and local captions rather than expanding to the whole track', () => {
  const prompt = buildPrompt('edit-assistant', input());
  assert.equal(prompt.payload.editScope.placement.start, 2);
  assert.equal(prompt.payload.editScope.placement.end, 6);
  assert.match(prompt.system, /仅修改该区间/);
  assert.match(prompt.system, /captions无论是否同时有timeline都从本区间0秒起算/);
  assert.match(prompt.system, /0\.001秒/);
});
test('range response retains an existing clip identity and validates duration after its original speed', () => {
  const payload = buildPrompt('edit-assistant', input()).payload;
  const result = normalizeModelData('edit-assistant', response(), payload);
  assert.equal(result.plan.timeline[0].clipId, 'inside');
  assert.equal(result.plan.captions[0].end, 4);
  const wrong = response(); wrong.plan.timeline[0].end = 10;
  assert.throws(() => normalizeModelData('edit-assistant', wrong, payload), { code: 'MODEL_RANGE_DURATION_MISMATCH' });
});
test('an otherwise complex full track can submit a safe local range for backend validation', () => {
  const value = input(); value.context.mainTrackEditable = false;
  assert.equal(normalizeModelData('edit-assistant', response(), buildPrompt('edit-assistant', value).payload).action, 'edit');
});
test('caption-only range plans use the local span and reject whole-film timecodes', () => {
  const payload = buildPrompt('edit-assistant', input()).payload;
  const value = { action: 'edit', message: '仅改字幕', plan: { captions: [{ start: 0, end: 4, text: '所选区间字幕' }] } };
  assert.equal(normalizeModelData('edit-assistant', value, payload).plan.captions[0].end, 4);
  value.plan.captions[0].end = 6;
  assert.throws(() => normalizeModelData('edit-assistant', value, payload), { code: 'MODEL_CAPTIONS_INVALID' });
});
test('outdated ranges and out-of-scope clip IDs fail before a plan can be applied', () => {
  const value = input(); value.editScope.placement.end = 13;
  assert.throws(() => buildPrompt('edit-assistant', value), { code: 'EDIT_RANGE_OUTSIDE_TIMELINE' });
  const invalid = response(); invalid.plan.timeline[0].clipId = 'outside';
  assert.throws(() => normalizeModelData('edit-assistant', invalid, buildPrompt('edit-assistant', input()).payload), { code: 'MODEL_CLIP_INVALID' });
});
test('rough-cut range requests have a fixed duration and cannot accept a longer returned timeline', () => {
  const value = input();
  const payload = buildPrompt('edit-plan', { instruction: '局部重剪', assets: value.context.assets, editScope: value.editScope, durationTarget: 60 }).payload;
  assert.equal(payload.durationTarget, 4);
  assert.equal(normalizeModelData('edit-plan', { title: '局部', timeline: [{ assetId: 'media', start: 0, end: 4 }] }, payload).timeline[0].end, 4);
  assert.throws(() => normalizeModelData('edit-plan', { title: '局部', timeline: [{ assetId: 'media', start: 0, end: 5 }] }, payload), { code: 'MODEL_RANGE_DURATION_MISMATCH' });
});
test('template animation must fit the region and unsupported short regions are explicit', () => {
  const payload = buildPrompt('animation-plan', { instruction: '实验示意', editScope: { placement: { mode: 'range', start: 2, end: 6 } } }).payload;
  assert.equal(payload.durationTarget, 4);
  const plan = { title: '示意', scenes: [{ type: 'title', title: '示意', duration: 4 }] };
  assert.equal(normalizeModelData('animation-plan', plan, payload).scenes[0].duration, 4);
  plan.scenes[0].duration = 3;
  assert.throws(() => normalizeModelData('animation-plan', plan, payload), { code: 'MODEL_RANGE_DURATION_MISMATCH' });
  assert.throws(() => buildPrompt('animation-plan', { instruction: '示意', editScope: { placement: { mode: 'range', start: 0, end: 1 } } }), { code: 'ANIMATION_RANGE_UNSUPPORTED' });
});
test('rough-cut range reuse preserves clip identity and counts the captured native speed', () => {
  const value = input();
  const payload = buildPrompt('edit-plan', { instruction: '局部保留原速度修改', assets: value.context.assets, timeline: value.context.timeline, editScope: value.editScope }).payload;
  assert.equal(payload.timeline[0].speed, 2);
  assert.equal(payload.timeline[0].id, 'inside');
  const output = normalizeModelData('edit-plan', { title: '区间内', timeline: [{ clipId: 'inside', assetId: 'media', start: 0, end: 8 }], captions: [{ start: 0, end: 4, text: '局部' }] }, payload);
  assert.equal(output.timeline[0].clipId, 'inside');
  assert.throws(() => normalizeModelData('edit-plan', { title: '错误', timeline: [{ clipId: 'outside', assetId: 'media', start: 0, end: 4 }] }, payload), { code: 'MODEL_CLIP_INVALID' });
  assert.throws(() => normalizeModelData('edit-plan', { title: '越界字幕', timeline: [{ clipId: 'inside', assetId: 'media', start: 0, end: 8 }], captions: [{ start: 0, end: 4.03, text: '超出所选' }] }, payload), { code: 'MODEL_CAPTIONS_INVALID' });
});
