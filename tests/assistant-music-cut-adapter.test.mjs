import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createProjectStore } from '../lib/store.mjs';
import { createAssistantAppTools } from '../lib/assistant-app-tools.mjs';
import { AppError } from '../lib/errors.mjs';

test('music adapter permission forwarding and source-time mapping stay bounded and preserve committed receipts (injected interfaces, not native quality)', async t => {
  const base = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'gx-music-adapter-')), store = await createProjectStore(directory), adapters = [];
  await store.save('adapter-video', { kind: 'video', title: '适配器权限夹具', source: { text: '' }, video: { timeline: [], editScope: { placement: { mode: 'append' } } } });
  t.after(async () => { await Promise.all(adapters.map(adapter => adapter.close())); await store.settle(); assert.equal(path.dirname(directory), base); await rm(directory, { recursive: true, force: true }); });
  async function run(overrides = {}, args = {}, cancelAfterCommit = false) {
    let revision = '1'.repeat(16), analyzes = 0; const writes = [];
    const controller = new AbortController();
    const ctx = { runId: randomUUID(), callId: randomUUID(), projectId: 'adapter-video', mode: 'auto', scopeAuthority: 'dialog', instruction: '按当前音乐自动卡点。', editScope: { placement: { mode: 'append' } }, origin: 'http://127.0.0.1:1', settings: {}, signal: controller.signal, update() {}, ...overrides };
    const assets = [{ id: 'visual-a', type: 'video', duration: 30 }, { id: 'visual-b', type: 'video', duration: 30 }, { id: 'music-canonical', type: 'audio', duration: 30 }];
    const adapter = createAssistantAppTools({ store, openFilm: { context: async () => ({ revision, duration: 30, timeline: [], assets: structuredClone(assets) }) }, musicCuts: {
      analyze: async () => { analyzes++; return { status: 'ready', bpm: 120, nativeRevision: revision, assetId: 'music-canonical', coverage: { start: 8, end: 16, requestedStart: 4, requestedEnd: 24 }, musicClip: { id: 'music-clip', sourceStart: 4, sourceEnd: 24, timelineAt: 10, speed: 2, volume: .5 } }; },
      cut: async (input, context) => {
        const permitted = context.editScope?.assetIds;
        if (permitted && input.assetIds?.some(id => !permitted.includes(id))) throw new AppError(403, '明确素材约束', 'MUSIC_CUT_ASSETS');
        writes.push({ input: structuredClone(input), scope: structuredClone(context.editScope), mode: context.mode }); revision = '2'.repeat(16);
        if (cancelAfterCommit) controller.abort();
        return { applied: true, revision, nativeUndoId: 'injected-undo', placement: { start: input.range.start, end: input.range.end }, summary: '注入接口的已提交回执', cancelledAfterCommit: cancelAfterCommit };
      },
    } }); adapters.push(adapter);
    const selected = adapter.tools.find(tool => tool.name === 'music_autocut'); assert.ok(selected);
    let result, error; try { result = await selected.execute({ musicClipId: 'music-clip', ...args }, ctx); } catch (caught) { error = caught; }
    return { adapter, ctx, result, error, analyzes, writes };
  }
  const defaults = await run(); assert.equal(defaults.error, undefined); assert.deepEqual(defaults.writes[0].input.range, { start: 12, end: 16 }); assert.equal(defaults.writes[0].scope.placement.mode, 'range');
  const narrow = await run({ instruction: '只修改10到15秒，按音乐自动卡点。' }); assert.equal(narrow.error, undefined); assert.deepEqual(narrow.writes[0].input.range, { start: 12, end: 15 });
  const widened = await run({ instruction: '只修改10到15秒，按音乐自动卡点。' }, { range: { start: 12, end: 16 } }); assert.equal(widened.error.code, 'MUSIC_CUT_RANGE'); assert.equal(widened.writes.length, 0);
  const assets = await run({ instruction: '只使用当前所选素材，按音乐自动卡点。', editScope: { assetIds: ['visual-a'], placement: { mode: 'append' } } }, { assetIds: ['visual-b'] }); assert.equal(assets.error.code, 'MUSIC_CUT_ASSETS'); assert.equal(assets.writes.length, 0);
  const asked = await run({ mode: 'ask' }); assert.equal(asked.error.code, 'ASSISTANT_READ_ONLY'); assert.equal(asked.analyzes, 0); assert.equal(asked.writes.length, 0);
  const stopped = await run({}, {}, true); assert.equal(stopped.error, undefined); assert.equal(stopped.result.data.cancelledAfterCommit, true); assert.equal(stopped.result.effects[0].changed, true);
  const clips = await run({ instruction: '只修改当前选中片段，其它片段不动，按音乐自动卡点。', editScope: { assetIds: ['visual-a'], placement: { mode: 'range', start: 10, end: 20, clipIds: ['clip-a'] } } });
  assert.equal(clips.error, undefined); assert.deepEqual(clips.writes[0].scope.placement.clipIds, ['clip-a']);
  const checkpoint = await clips.adapter.checkpoint(clips.ctx);
  assert.deepEqual(checkpoint.scope.placement.clipIds, ['clip-a'], 'a completed music receipt must not drop the selected-clip write constraint');
});
