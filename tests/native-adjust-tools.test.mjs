import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createProjectStore } from '../lib/store.mjs';
import { createAssistantAppTools } from '../lib/assistant-app-tools.mjs';

const selected = { assetIds: ['allowed'], placement: { mode: 'range', start: 0, end: 4, clipIds: ['clip-a'] } };
async function fixture(t) {
  const parent = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'gx-native-adjust-tools-')), store = await createProjectStore(directory);
  const project = await store.save('current-video', { kind: 'video', video: { timeline: [], editScope: selected } });
  let revision = 'rev-one'; const calls = [], undos = [];
  const openFilm = {
    async context(_id, _origin, options) { calls.push(['context', options]); return { revision, assets: [{ id: 'allowed', name: 'selected.mp4', type: 'video', duration: 10 }], timeline: [], duration: 4, aspect: '16:9', stage: { w: 1280, h: 720 }, editorTimeline: { clips: [{ id: 'clip-a', assetId: 'allowed', track: 0, at: 0, end: 2, editable: true }, { id: 'new-half', assetId: 'allowed', track: 0, at: 2, end: 4, editable: true }, { id: 'private-clip', assetId: 'outside', track: 1, at: 0, end: 4 }], tracks: [{ index: 0 }, { index: 1 }], supportedActions: ['split', 'volume'] } }; },
    async adjustClips(...args) { calls.push(['adjust', args]); revision = revision === 'rev-one' ? 'rev-two' : 'rev-three'; return { revision, applied: true, undo: { id: 'native-' + revision }, results: args[1][0].action === 'split' ? [{ clipId: 'clip-a', action: 'split', createdClipId: 'new-half' }] : [{ clipId: args[1][0].clipId, action: 'volume' }], summary: '已精确调整片段', duration: 4 }; },
    async undoAssistant(...args) { undos.push(args); return { restored: true }; },
  };
  const adapter = createAssistantAppTools({ store, openFilm });
  t.after(async () => { await adapter.close(); await store.settle(); assert.equal(path.dirname(path.resolve(directory)), parent); await rm(directory, { recursive: true, force: true }); });
  const ctx = { projectId: project.id, runId: randomUUID(), callId: randomUUID(), instruction: '把选中片段分割，并把右半段静音', editScope: selected, origin: 'http://127.0.0.1:49101', mode: 'auto', signal: new AbortController().signal, update() {} };
  const call = (name, args, context = ctx) => adapter.tools.find(tool => tool.name === name).execute(args || {}, context);
  return { adapter, store, project, ctx, call, calls, undos, manualEdit: () => { revision = 'external-user-edit'; } };
}

test('native_inspect reads current unselected clips while describing the actual write scope', async t => {
  const f = await fixture(t), read = await f.call('native_inspect');
  assert.deepEqual(read.data.clips.map(clip => clip.id), ['clip-a', 'new-half', 'private-clip']); assert.deepEqual(read.data.editScope, selected);
  assert.equal(read.data.clips.find(clip => clip.id === 'private-clip').withinEditScope, false); assert.deepEqual(f.calls[0][1].editScope, selected); assert.equal(f.calls[0][1].inspectAll, true);
  assert.equal(f.adapter.tools.find(tool => tool.name === 'native_inspect').mutating, false);
});

test('precise edits reuse CAS, pass only the user scope, continue with newly split IDs and undo through native receipts', async t => {
  const f = await fixture(t), edits = [{ action: 'split', clipId: 'clip-a', at: 2 }];
  const first = await f.call('native_adjust', { edits, editScope: { placement: { mode: 'replace' } } });
  const firstArgs = f.calls.find(call => call[0] === 'adjust')[1]; assert.equal(firstArgs[3], 'rev-one'); assert.deepEqual(firstArgs[4].editScope.placement.clipIds, ['clip-a']); assert.equal(firstArgs[4].signal, f.ctx.signal);
  assert.equal(first.data.results[0].createdClipId, 'new-half');
  const repeated = await f.call('native_adjust', { edits, editScope: { placement: { mode: 'replace' } } }); assert.deepEqual(repeated, first); assert.equal(f.calls.filter(call => call[0] === 'adjust').length, 1);
  const read = await f.call('native_inspect'); assert.deepEqual(read.data.clips.filter(clip => clip.withinEditScope).map(clip => clip.id), ['clip-a', 'new-half']);
  const second = await f.call('native_adjust', { edits: [{ action: 'volume', clipId: 'new-half', value: 0 }] }); assert.equal(second.data.revision, 'rev-three');
  const secondArgs = f.calls.filter(call => call[0] === 'adjust')[1][1]; assert.equal(secondArgs[3], 'rev-two');
  await f.adapter.undo({ projectId: f.project.id, undoId: second.effects[0].undo.id }, { origin: f.ctx.origin }); assert.equal(f.undos[0][1], 'native-rev-three');
});

test('ask mode, stopped requests and stale native revisions cannot reach precise writes', async t => {
  const f = await fixture(t);
  await assert.rejects(() => f.call('native_adjust', { edits: [{ action: 'remove', clipId: 'clip-a' }] }, { ...f.ctx, mode: 'ask' }), { code: 'ASSISTANT_READ_ONLY' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => f.call('native_adjust', { edits: [{ action: 'remove', clipId: 'clip-a' }] }, { ...f.ctx, runId: randomUUID(), signal: controller.signal }), { code: 'REQUEST_CANCELLED' });
  await f.call('native_inspect'); f.manualEdit();
  await assert.rejects(() => f.call('native_adjust', { edits: [{ action: 'remove', clipId: 'clip-a' }] }), { code: 'ASSISTANT_CONFLICT' });
  assert.equal(f.calls.filter(call => call[0] === 'adjust').length, 0);
});
