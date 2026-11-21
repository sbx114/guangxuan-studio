import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEditScope, resolveFreeEditScope } from '../lib/edit-scope.mjs';
import { resolveAssistantScope, setAssistantScope } from '../lib/assistant-permissions.mjs';
import { planNativeAdjustments } from '../lib/native-adjustments.mjs';
import { createRemotionIntegration } from '../lib/remotion-integration.mjs';

const assets = [{ id: 'asset-a' }, { id: 'asset-b' }];
const free = { assetIds: ['asset-a'], placement: { mode: 'free' } };

test('free placement retains selected assets and drops stale time and clip constraints', () => {
  const normalized = normalizeEditScope({ assetIds: ['asset-a', 'asset-a'], placement: { mode: 'free', at: 'unfinished', start: 8, end: 2, clipIds: ['old-clip'] } }, assets);
  assert.deepEqual(normalized, free);
  assert.throws(() => normalizeEditScope({ ...free, assetIds: ['missing'] }, assets), { code: 'EDIT_SCOPE_ASSET_MISSING' });
  assert.throws(() => normalizeEditScope({ placement: { mode: 'insert' } }), { code: 'INVALID_EDIT_PLACEMENT' });
  assert.throws(() => normalizeEditScope({ placement: { mode: 'range' } }), { code: 'INVALID_EDIT_RANGE' });
});

test('only free allows a plan to choose a validated concrete placement', () => {
  assert.deepEqual(resolveFreeEditScope(free, { mode: 'insert', at: 5.1234 }, assets), { assetIds: ['asset-a'], placement: { mode: 'insert', at: 5.123 } });
  assert.deepEqual(resolveFreeEditScope(free, { mode: 'append' }, assets), { assetIds: ['asset-a'], placement: { mode: 'append' } });
  assert.throws(() => resolveFreeEditScope(free, undefined, assets), { code: 'EDIT_PLACEMENT_UNRESOLVED', status: 400 });
  assert.throws(() => resolveFreeEditScope(free, { mode: 'free' }, assets), { code: 'EDIT_PLACEMENT_UNRESOLVED' });
  assert.throws(() => resolveFreeEditScope(free, { mode: 'insert', at: -1 }, assets), { code: 'INVALID_EDIT_PLACEMENT' });
  assert.throws(() => resolveFreeEditScope(free, { mode: 'range', start: 4, end: 2 }, assets), { code: 'INVALID_EDIT_RANGE' });
  assert.throws(() => resolveFreeEditScope(free, { mode: 'replace' }, assets), { code: 'EDIT_SCOPE_REPLACE_REQUIRES_ALL' });
  const user = { placement: { mode: 'append' } };
  assert.deepEqual(resolveFreeEditScope(user, { mode: 'replace' }, assets), user, 'A model cannot override a concrete user placement');
});

test('free dialogue authority treats UI materials as advisory and retains only placement preference', () => {
  const chosen = resolveAssistantScope({ instruction: '按这些素材自由安排节奏。', uiScope: free });
  assert.deepEqual(chosen.scope, { placement: { mode: 'free' } }); assert.equal(chosen.constraint, null);
  const state = { scope: chosen.scope, dialogueConstraint: chosen.constraint };
  assert.deepEqual(setAssistantScope(state, { placement: { mode: 'insert', at: 7 } }, assets), { placement: { mode: 'insert', at: 7 } });
  assert.deepEqual(setAssistantScope(state, { assetIds: ['asset-b'], placement: { mode: 'append' } }, assets), { assetIds: ['asset-b'], placement: { mode: 'append' } });
  assert.deepEqual(free, { assetIds: ['asset-a'], placement: { mode: 'free' } });
  const whole = resolveAssistantScope({ instruction: '重新剪辑整个工程，全部素材可以使用。', uiScope: free });
  assert.deepEqual(whole.scope, { placement: { mode: 'free' } }); assert.equal(whole.constraint, null);
  assert.equal(resolveAssistantScope({ instruction: '用所选素材创作', uiScope: { placement: { mode: 'free' } } }).scope.placement.mode, 'free');
});

test('explicit dialogue time limits still override free and cannot be enlarged', () => {
  const chosen = resolveAssistantScope({ instruction: '只改10到20秒，其他不要动。', uiScope: free });
  assert.deepEqual(chosen.scope, { placement: { mode: 'range', start: 10, end: 20 } });
  const state = { scope: chosen.scope, dialogueConstraint: chosen.constraint };
  assert.throws(() => setAssistantScope(state, { assetIds: ['asset-a'], placement: { mode: 'append' } }, assets), { code: 'ASSISTANT_DIALOG_SCOPE' });
  assert.throws(() => setAssistantScope(state, { assetIds: ['asset-a'], placement: { mode: 'range', start: 9, end: 20 } }, assets), { code: 'ASSISTANT_DIALOG_SCOPE' });
});

test('decimal output limits preserve the decimal point while separating source and edit clauses', () => {
  for (const [instruction, start, end] of [
    ['只改0–0.5秒。', 0, .5],
    ['只改0.25到0.75秒，其他不动。', .25, .75],
    ['only edit 0.25-0.75 s. Keep the rest.', .25, .75],
    ['只参考原片12.5–18.75秒。仅改作品40.25–45.5秒。', 40.25, 45.5],
  ]) {
    const chosen = resolveAssistantScope({ instruction, uiScope: free });
    assert.deepEqual(chosen.scope, { placement: { mode: 'range', start, end } });
    assert.deepEqual(chosen.constraint, chosen.scope);
    assert.throws(() => setAssistantScope({ scope: chosen.scope, dialogueConstraint: chosen.constraint }, { placement: { mode: 'replace' } }, assets), { code: 'ASSISTANT_DIALOG_SCOPE' });
  }
});

test('only the current dialogue can make selected materials an exclusive constraint', () => {
  const chosen = resolveAssistantScope({ instruction: '只用所选素材，位置由你自由安排。', uiScope: free });
  assert.deepEqual(chosen.scope, free); assert.deepEqual(chosen.constraint, free);
  assert.throws(() => setAssistantScope({ scope: chosen.scope, dialogueConstraint: chosen.constraint }, { assetIds: ['asset-b'], placement: { mode: 'append' } }, assets), { code: 'ASSISTANT_DIALOG_SCOPE' });
});

test('borrowing a source interval does not restrict edits to the same output interval', () => {
  const chosen = resolveAssistantScope({ instruction: '只参考原片12–18秒的动效，重剪全片。', uiScope: free });
  assert.deepEqual(chosen.scope, { placement: { mode: 'free' } }); assert.equal(chosen.constraint, null); assert.equal(chosen.pending, undefined);
});

test('borrowing a source ending never creates a pending output tail restriction', () => {
  for (const duration of [undefined, 92]) {
    const chosen = resolveAssistantScope({ instruction: '只借鉴结尾10秒，精修现有动画。', uiScope: free, duration });
    assert.deepEqual(chosen.scope, { placement: { mode: 'free' } }); assert.equal(chosen.constraint, null); assert.equal(chosen.pending, undefined);
  }
});

test('a source interval and a separate exclusive output interval retain the output restriction', () => {
  for (const instruction of ['只参考原片12–18秒的动效，并仅改作品40–45秒，其他不动。', '只参考12–18秒并只在作品40–45秒修改，其他不要动。']) {
    const chosen = resolveAssistantScope({ instruction, uiScope: free });
    assert.deepEqual(chosen.scope, { placement: { mode: 'range', start: 40, end: 45 } }); assert.deepEqual(chosen.constraint, chosen.scope);
    assert.throws(() => setAssistantScope({ scope: chosen.scope, dialogueConstraint: chosen.constraint }, { placement: { mode: 'range', start: 12, end: 18 } }, assets), { code: 'ASSISTANT_DIALOG_SCOPE' });
  }
});

test('exclusive source assets remain restricted while full-project editing ignores stale UI time', () => {
  const chosen = resolveAssistantScope({ instruction: '只用所选素材重剪全片。', uiScope: { assetIds: ['asset-a'], placement: { mode: 'range', start: 12, end: 18, clipIds: ['old-clip'] } } });
  assert.deepEqual(chosen.scope, { assetIds: ['asset-a'], placement: { mode: 'append' } }); assert.deepEqual(chosen.constraint, chosen.scope);
  assert.throws(() => setAssistantScope({ scope: chosen.scope, dialogueConstraint: chosen.constraint }, { assetIds: ['asset-b'], placement: { mode: 'append' } }, assets), { code: 'ASSISTANT_DIALOG_SCOPE' });
});

test('precise native operations use their own concrete timing in free without granting other assets', () => {
  const doc = { stage: { w: 1280, h: 720 }, tracks: [{ clips: [{ id: 'clip-a', src: 'a.mp4', time: [0, 4], at: 9 }, { id: 'clip-b', src: 'b.mp4', time: [0, 4], at: 20 }] }] };
  const known = { 'a.mp4': { assetId: 'asset-a', duration: 30 }, 'b.mp4': { assetId: 'asset-b', duration: 30 } };
  const result = planNativeAdjustments(doc, [{ action: 'move', clipId: 'clip-a', at: 2 }], { known, editScope: free });
  assert.equal(result.document.tracks[0].clips[0].at, 2); assert.deepEqual(result.document.tracks[0].clips[1], doc.tracks[0].clips[1]);
  assert.throws(() => planNativeAdjustments(doc, [{ action: 'volume', clipId: 'clip-b', value: 0 }], { known, editScope: free }), error => error.status === 403);
});

test('Remotion free append validates planned placement before importing and forwards resolved position', async () => {
  const project = { id: 'owner-a', kind: 'video', createdAt: 'version', video: { editScope: { placement: { mode: 'free' } } } };
  let imported = 0; const appended = [];
  const integration = createRemotionIntegration({
    store: { read: async () => structuredClone(project) },
    projects: { read: async () => ({ id: 'source', ownerCreatedAt: project.createdAt, revision: 1, title: 'Free' }), getJob: async () => ({ id: 'job', status: 'complete', remotionId: 'source', revision: 1, ownerCreatedAt: project.createdAt, result: { outputPath: 'synthetic.mp4' } }) },
    openFilm: { context: async () => ({ assets: [], revision: 'native1' }), appendAsset: async (...args) => { appended.push(args); return { revision: 'native2' }; } },
    videoService: { importLocalFile: async () => { imported++; return { id: 'generated' }; } },
  });
  await assert.rejects(() => integration.append(project.id, 'source', { jobId: 'job' }), { code: 'EDIT_PLACEMENT_UNRESOLVED', status: 400 }); assert.equal(imported, 0); assert.equal(appended.length, 0);
  const result = await integration.append(project.id, 'source', { jobId: 'job', placement: { mode: 'insert', at: 6 } });
  assert.equal(result.appended, true); assert.equal(imported, 1); assert.deepEqual(appended[0][4].editScope, { placement: { mode: 'free' } }); assert.deepEqual(appended[0][4].placement, { mode: 'insert', at: 6 });
  assert.deepEqual(project.video.editScope, { placement: { mode: 'free' } });
});
