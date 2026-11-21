import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, normalizeModelData, validatePayload } from '../lib/prompts.mjs';

const assets = [{ id: 'a', name: '画面A', type: 'video', duration: 20 }];
const context = { assets, timeline: [{ id: 'c', assetId: 'a', start: 0, end: 4, at: 0, speed: 1 }], duration: 12, mainTrackEditable: true, aspect: '16:9' };
const free = { assetIds: ['a'], placement: { mode: 'free', start: 'old-invalid', at: 'old-invalid' } };
const plan = { title: '新片段', timeline: [{ assetId: 'a', start: 4, end: 8 }], captions: [{ start: 0, end: 2, text: '新字幕' }], placement: { mode: 'insert', at: 10 } };

test('free coarse-cut response chooses a concrete position within the full work duration, without user time input', () => {
  const prompt = buildPrompt('edit-plan', { instruction: '自由编排这些素材', assets, timeline: context.timeline, timelineDuration: 12, editScope: free });
  assert.deepEqual(prompt.payload.editScope, { assetIds: ['a'], placement: { mode: 'free' } });
  assert.equal(prompt.payload.timeline[0].id, 'c'); assert.equal(prompt.payload.timeline[0].at, 0);
  const result = normalizeModelData('edit-plan', plan, prompt.payload);
  assert.deepEqual(result.placement, { mode: 'insert', at: 10 }); assert.equal(result.timeline[0].start, 4);
  assert.throws(() => normalizeModelData('edit-plan', { ...plan, placement: undefined }, prompt.payload), { code: 'MODEL_PLACEMENT_INVALID' });
  assert.throws(() => normalizeModelData('edit-plan', { ...plan, placement: { mode: 'insert', at: 13 } }, prompt.payload), { code: 'MODEL_PLACEMENT_INVALID' });
});

test('existing fixed placement cannot be overwritten by a model free-placement field', () => {
  const payload = validatePayload('edit-plan', { instruction: '追加片段', assets, timeline: [], editScope: { placement: { mode: 'append' } } });
  const result = normalizeModelData('edit-plan', { ...plan, placement: { mode: 'replace' } }, payload);
  assert.equal(Object.hasOwn(result, 'placement'), false); assert.equal(payload.editScope.placement.mode, 'append');
});

test('free native edits retain selected placement while replies and absolute caption-only edits need no interval', () => {
  const payload = validatePayload('edit-assistant', { instruction: '自行安排片段位置', context, editScope: free });
  const edited = normalizeModelData('edit-assistant', { action: 'edit', message: '已编排建议', plan }, payload);
  assert.deepEqual(edited.plan.placement, plan.placement); assert.equal(edited.plan.timeline[0].start, 4);
  assert.deepEqual(normalizeModelData('edit-assistant', { action: 'reply', message: '说明' }, payload), { action: 'reply', message: '说明' });
  const captions = normalizeModelData('edit-assistant', { action: 'edit', message: '加标题', plan: { captions: [{ start: 8, end: 10, text: '标题' }] } }, payload);
  assert.equal(captions.plan.captions[0].start, 8); assert.equal(Object.hasOwn(captions.plan, 'placement'), false);
});

test('already-rendered media placement validates actual length and existing work bounds', () => {
  const prompt = buildPrompt('edit-placement', { instruction: '把成片放在合适位置', context, editScope: free, contentDuration: 4 });
  assert.equal(JSON.parse(prompt.user)['待加入内容秒数'], 4);
  assert.deepEqual(normalizeModelData('edit-placement', { placement: { mode: 'range', start: 4, end: 8 } }, prompt.payload), { placement: { mode: 'range', start: 4, end: 8 } });
  for (const placement of [{ mode: 'free' }, { mode: 'insert', at: 13 }, { mode: 'range', start: 4, end: 9 }, { mode: 'range', start: 10, end: 14 }, { mode: 'insert', at: '4' }]) assert.throws(() => normalizeModelData('edit-placement', { placement }, prompt.payload), { code: 'MODEL_PLACEMENT_INVALID' });
  assert.throws(() => validatePayload('edit-placement', { instruction: '加入', context, editScope: free, contentDuration: -1 }), { code: 'INVALID_FREE_PLACEMENT' });
});
