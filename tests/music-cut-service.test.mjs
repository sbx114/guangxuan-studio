import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import { createMusicCutService } from '../lib/music-cut-service.mjs';
import { createProjectStore } from '../lib/store.mjs';
import { AppError } from '../lib/errors.mjs';

const until = async read => { for (let i = 0; i < 1000; i++) { if (await read()) return; await pause(5); } throw Error('service fixture did not settle'); };
async function fixture(t, options = {}) {
  const base = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'gx-music-service-')), store = await createProjectStore(directory);
  const project = await store.save('owned-video', { kind: 'video', title: '策略隔离工程', source: { text: '' }, video: { timeline: [] } });
  const state = { revision: '0000000000000001', reads: [], applies: [], undos: [], sequence: 1, contextHook: null };
  const scope = { assetIds: ['visual-a', 'visual-b'], placement: { mode: 'range', start: 0, end: 12 } };
  const assets = [{ id: 'visual-a', type: 'video', duration: 40 }, { id: 'visual-b', type: 'video', duration: 40 }, { id: 'still', type: 'image', duration: 4 }, { id: 'canonical-music', type: 'audio', duration: 40 }];
  const rhythm = () => { const start = options.coverageStart ?? 0, end = options.coverageEnd ?? 12; return { status: 'ready', bpm: 120, tempoConfidence: .9, coverage: { start, end, requestedStart: options.requestedStart ?? start, requestedEnd: end }, assetId: 'canonical-music', sourcePath: 'assets/canonical-music.wav', sourceVersion: 'c'.repeat(64), nativeRevision: state.revision, beats: Array.from({ length: Math.floor((end - start) * 2) + 1 }, (_, i) => ({ time: start + i / 2, strength: .8, confidence: .9, inferred: false })), warnings: [], ...(options.clip ? { musicClip: structuredClone(options.clip) } : {}) }; };
  const native = {
    async readMusicRhythm(projectId, assetId, origin, args) { state.reads.push({ projectId, assetId, args }); return options.read ? options.read({ state, rhythm, args }) : rhythm(); },
    async context() { await state.contextHook?.(); return { revision: state.revision, duration: 12, assets: structuredClone(assets), timeline: [{ assetId: 'visual-a', start: 5, end: 25, at: 0, speed: 1 }] }; },
    async applyMusicCutPlan(projectId, plan, origin, beforeRevision, args) {
      state.applies.push({ projectId, plan: structuredClone(plan), beforeRevision, args });
      if (options.apply) return options.apply({ state, plan, args });
      state.revision = (++state.sequence).toString(16).padStart(16, '0');
      return { revision: state.revision, nativeUndoId: 'native-undo-' + state.sequence, cutTimes: plan.cutTimes.map(time => time + .001), outsidePreserved: true };
    },
    async undoAssistant(projectId, undoId) { state.undos.push({ projectId, undoId }); state.revision = (++state.sequence).toString(16).padStart(16, '0'); return { revision: state.revision, restored: true }; },
  };
  const services = []; let service;
  const open = async () => { service = await createMusicCutService({ dataDir: directory, store, openFilm: native, dependencies: options.dependencies }); services.push(service); return service; };
  await open();
  t.after(async () => { await Promise.all(services.map(value => value.close())); await store.settle(); assert.equal(path.dirname(directory), base); await rm(directory, { recursive: true, force: true }); });
  return { directory, store, project, state, scope, native, rhythm, request: () => ({ projectId: project.id, requestId: randomUUID(), musicAssetId: 'canonical-music', assetIds: ['visual-a'] }), service: () => service, reopen: async () => { await service.close(); return open(); } };
}

test('full music clip intersects partial analysis coverage and retains affine placement without requiring a full-clip scan', async t => {
  const clip = { id: 'music-clip', sourceStart: 4, sourceEnd: 24, timelineAt: 10, speed: 2, volume: .6 };
  const fx = await fixture(t, { clip, coverageStart: 8, coverageEnd: 16 });
  const request = fx.request(); delete request.musicAssetId; request.musicClipId = clip.id; request.sourceRange = { start: 8, end: 16 };
  await fx.service().cut(request, { scope: { assetIds: ['visual-a'], placement: { mode: 'range', start: 11, end: 17 } } });
  const call = fx.state.applies[0]; assert.equal(fx.state.reads[0].assetId, undefined); assert.equal(fx.state.reads[0].args.clipId, clip.id);
  assert.deepEqual(call.plan.music, { assetId: 'canonical-music', sourceStart: 8, sourceEnd: 16, timelineAt: 12, speed: 2, volume: .6 });
  assert.deepEqual(call.plan.placement, { start: 12, end: 16 }); assert.equal(call.args.existingMusicClipId, clip.id); assert.deepEqual(clip, { id: 'music-clip', sourceStart: 4, sourceEnd: 24, timelineAt: 10, speed: 2, volume: .6 });
});

test('new music partial coverage shifts from the requested source origin rather than relabeling time zero', async t => {
  const fx = await fixture(t, { coverageStart: 6, coverageEnd: 14, requestedStart: 4 });
  const request = { ...fx.request(), sourceRange: { start: 4, end: 14 }, timelineAt: 3, musicSpeed: 2, musicVolume: .4 };
  await fx.service().cut(request); assert.deepEqual(fx.state.applies[0].plan.music, { assetId: 'canonical-music', sourceStart: 6, sourceEnd: 14, timelineAt: 4, speed: 2, volume: .4 });
});

test('explicit range cannot extend past observed music or permission scope and no native write is dispatched', async t => {
  const fx = await fixture(t);
  await assert.rejects(fx.service().cut({ ...fx.request(), range: { start: 0, end: 13 } }), { code: 'MUSIC_CUT_RANGE' });
  await assert.rejects(fx.service().cut({ ...fx.request(), range: { start: 0, end: 10 } }, { scope: { placement: { mode: 'range', start: 2, end: 10 } } }), { code: 'MUSIC_CUT_RANGE' });
  assert.equal(fx.state.applies.length, 0);
});

test('scope alias/key order are canonical, UUID case is stable, and completed same-input replay does not analyze again', async t => {
  const fx = await fixture(t), request = fx.request(); const result = await fx.service().cut(request, { editScope: fx.scope });
  const repeated = await fx.service().cut({ assetIds: request.assetIds, musicAssetId: request.musicAssetId, requestId: request.requestId.toUpperCase(), projectId: request.projectId }, { scope: { placement: { end: 12, mode: 'range', start: 0 }, assetIds: ['visual-b', 'visual-a'] }, origin: 'http://127.0.0.1:9999' });
  assert.equal(repeated.requestId, result.requestId); assert.equal(repeated.reusedOperation, true); assert.equal(fx.state.reads.length, 1); assert.equal(fx.state.applies.length, 1);
});

test('replay/readback cannot cross a newly narrowed scope or readonly mode', async t => {
  const fx = await fixture(t), request = fx.request(); await fx.service().cut(request, { editScope: fx.scope });
  const narrow = { scope: { assetIds: ['visual-a'], placement: { mode: 'range', start: 2, end: 10 } } };
  await assert.rejects(fx.service().cut(request, narrow), { code: 'MUSIC_CUT_OPERATION_CHANGED' });
  await assert.rejects(fx.service().status(request.projectId, request.requestId, narrow), { code: 'MUSIC_CUT_OPERATION_SCOPE' });
  await assert.rejects(fx.service().cut(fx.request(), { mode: 'ask' }), { code: 'MUSIC_CUT_READ_ONLY' }); assert.equal(fx.state.applies.length, 1);
});

test('same running request shares its analysis and commit; captured inputs and scope do not mutate while awaiting', async t => {
  let release, entered = false; const gate = new Promise(resolve => { release = resolve; });
  const fx = await fixture(t, { read: async ({ rhythm }) => { entered = true; await gate; return rhythm(); } }), request = fx.request(), copied = structuredClone(request), context = { scope: structuredClone(fx.scope) };
  const first = fx.service().cut(request, context); await until(() => entered);
  const second = fx.service().cut(copied, { editScope: structuredClone(fx.scope) });
  request.assetIds[0] = 'outside-project'; context.scope.assetIds.length = 0; release();
  const [a, b] = await Promise.all([first, second]); assert.equal(a.requestId, b.requestId); assert.equal(fx.state.reads.length, 1); assert.equal(fx.state.applies.length, 1); assert.equal(fx.state.applies[0].plan.timeline[0].assetId, 'visual-a');
});

test('analysis failure frees a never-dispatched request ID for a real retry', async t => {
  let failRead = true; const fx = await fixture(t, { read: ({ rhythm }) => { if (failRead) throw new AppError(503, '分析暂不可用', 'TEST_ANALYSIS_UNAVAILABLE'); return rhythm(); } }), request = fx.request();
  await assert.rejects(fx.service().cut(request), { code: 'TEST_ANALYSIS_UNAVAILABLE' }); assert.equal(fx.state.applies.length, 0);
  await assert.rejects(fx.service().status(request.projectId, request.requestId), { code: 'MUSIC_CUT_OPERATION_NOT_FOUND' });
  failRead = false; await fx.service().cut(request); assert.equal(fx.state.reads.length, 2); assert.equal(fx.state.applies.length, 1);
});

test('no-beat and uncertain inputs do not create durable write intents or dispatch native writes', async t => {
  let variant = 'no-beat'; const fx = await fixture(t, { read: ({ rhythm }) => ({ ...rhythm(), status: variant, ...(variant === 'no-beat' ? { beats: [], bpm: null, tempoConfidence: 0 } : { tempoConfidence: .5 }) }) });
  await assert.rejects(fx.service().cut(fx.request()), { code: 'MUSIC_PLAN_NO_BEAT' }); variant = 'uncertain';
  await assert.rejects(fx.service().cut(fx.request()), { code: 'MUSIC_PLAN_UNCERTAIN' }); assert.equal(fx.state.applies.length, 0);
  const filename = path.join(fx.directory, 'music-cuts/operations.json'); await assert.rejects(readFile(filename), error => error.code === 'ENOENT');
});

test('durable completed replay preserves native returned cut times and shields private cache from caller mutation', async t => {
  const fx = await fixture(t), request = fx.request(), result = await fx.service().cut(request);
  const nativeTime = result.cutTimes[0]; assert.notEqual(nativeTime, result.plannedCutTimes[0]); result.cutTimes.length = 0;
  const status = await fx.service().status(request.projectId, request.requestId); assert.equal(status.result.cutTimes[0], nativeTime); status.result.cutTimes.length = 0;
  await fx.reopen(); const repeated = await fx.service().cut(request); assert.equal(repeated.cutTimes[0], nativeTime); assert.equal(fx.state.applies.length, 1);
});

test('after dispatch a lost receipt stays pending even if observed native revision is unchanged; restart never replays it', async t => {
  const fx = await fixture(t, { apply: () => { throw new AppError(503, '回执连接丢失', 'TEST_UNKNOWN_WRITE'); } }), request = fx.request();
  await assert.rejects(fx.service().cut(request), { code: 'TEST_UNKNOWN_WRITE' }); assert.equal((await fx.service().status(request.projectId, request.requestId)).status, 'pending');
  await fx.reopen(); await assert.rejects(fx.service().cut(request), { code: 'MUSIC_CUT_UNCONFIRMED' }); assert.equal(fx.state.applies.length, 1);
});

test('more than 200 result caches cannot evict an old unknown intent or its no-replay identity', async t => {
  let unknown = true; const fx = await fixture(t, { apply: ({ state, plan }) => { if (unknown) throw new AppError(503, '回执未知', 'TEST_UNKNOWN_WRITE'); state.revision = (++state.sequence).toString(16).padStart(16, '0'); return { revision: state.revision, nativeUndoId: 'fresh-undo', cutTimes: plan.cutTimes }; } }), request = fx.request();
  await assert.rejects(fx.service().cut(request), { code: 'TEST_UNKNOWN_WRITE' }); await fx.service().close();
  const filename = path.join(fx.directory, 'music-cuts/operations.json'), saved = JSON.parse(await readFile(filename, 'utf8'));
  for (let index = 0; index < 201; index++) saved.operations.push({ id: randomUUID(), projectId: fx.project.id, ownerCreatedAt: fx.project.createdAt, signature: 'a'.repeat(64), status: 'completed', result: { revision: fx.state.revision, nativeUndoId: 'old-' + index } });
  await writeFile(filename, JSON.stringify(saved)); await fx.reopen(); unknown = false; await fx.service().cut(fx.request());
  const persisted = JSON.parse(await readFile(filename, 'utf8')); assert.equal(persisted.operations.find(row => row.id === request.requestId).status, 'pending'); assert.ok(persisted.operations.some(row => row.status === 'completed-pruned'));
  await fx.reopen(); await assert.rejects(fx.service().cut(request), { code: 'MUSIC_CUT_UNCONFIRMED' }); assert.equal(fx.state.applies.length, 2);
});

test('replay checks fresh native revision and owner both before and after native context reads', async t => {
  const fx = await fixture(t), request = fx.request(); await fx.service().cut(request); const completedRevision = fx.state.revision;
  fx.state.revision = 'f'.repeat(16); await assert.rejects(fx.service().cut(request), { code: 'MUSIC_CUT_CHANGED' }); fx.state.revision = completedRevision;
  fx.state.contextHook = async () => { fx.state.contextHook = null; await fx.store.remove(fx.project.id); await pause(2); await fx.store.save(fx.project.id, { kind: 'video', title: '新实例', source: { text: '' }, video: { timeline: [] } }); };
  await assert.rejects(fx.service().cut(request), { code: 'MUSIC_CUT_OWNER_CHANGED' }); assert.equal(fx.state.applies.length, 1);
});

test('undo requires the current affected scope and native revision, then prevents resurrection under the same request ID', async t => {
  const fx = await fixture(t), request = fx.request(), result = await fx.service().cut(request);
  await assert.rejects(fx.service().undo({ projectId: fx.project.id, undoId: result.nativeUndoId }, { scope: { placement: { mode: 'range', start: 2, end: 10 } } }), { code: 'MUSIC_CUT_UNDO_SCOPE' });
  const revision = fx.state.revision; fx.state.revision = 'f'.repeat(16); await assert.rejects(fx.service().undo({ projectId: fx.project.id, undoId: result.nativeUndoId }), { code: 'MUSIC_CUT_CHANGED' }); fx.state.revision = revision;
  await fx.service().undo({ projectId: fx.project.id, undoId: result.nativeUndoId }); assert.equal(fx.state.undos.length, 1); assert.equal((await fx.service().status(fx.project.id, request.requestId)).status, 'undone');
  await assert.rejects(fx.service().cut(request), { code: 'MUSIC_CUT_UNCONFIRMED' });
});

test('cancel after acknowledged commit preserves the completed persistent receipt instead of retrying a write', async t => {
  const controller = new AbortController(); const fx = await fixture(t, { apply: ({ state, plan }) => { state.revision = (++state.sequence).toString(16).padStart(16, '0'); controller.abort(); return { revision: state.revision, nativeUndoId: 'committed-before-cancel', cutTimes: plan.cutTimes }; } }), request = fx.request();
  const result = await fx.service().cut(request, { signal: controller.signal }); assert.equal(result.nativeUndoId, 'committed-before-cancel'); assert.equal((await fx.service().status(fx.project.id, request.requestId)).status, 'completed');
  await fx.reopen(); await fx.service().cut(request); assert.equal(fx.state.applies.length, 1);
});

test('close aborts never-dispatched analysis and clears its ephemeral request so a fresh service can continue', async t => {
  let wait = true; const fx = await fixture(t, { read: ({ rhythm, args }) => wait ? new Promise((_resolve, reject) => args.signal.addEventListener('abort', () => reject(new AppError(499, '已取消', 'REQUEST_CANCELLED')), { once: true })) : rhythm() }), request = fx.request();
  const operation = fx.service().cut(request); await until(() => fx.state.reads.length === 1); const stopped = fx.service().close(); await assert.rejects(operation, { code: 'REQUEST_CANCELLED' }); await stopped;
  assert.equal(fx.state.applies.length, 0); wait = false; await fx.reopen(); await fx.service().cut(request); assert.equal(fx.state.applies.length, 1);
});

test('sourcePath only checks native-derived identity and malformed opt-ins are rejected before a write', async t => {
  const fx = await fixture(t); await assert.rejects(fx.service().analyze({ ...fx.request(), sourcePath: 'C:/not-authorized.wav' }), { code: 'MUSIC_CUT_SOURCE_CHANGED' });
  assert.equal(fx.state.reads[0].assetId, 'canonical-music'); assert.equal(Object.hasOwn(fx.state.reads[0].args, 'sourcePath'), false);
  const count = fx.state.reads.length; await assert.rejects(fx.service().cut({ ...fx.request(), allowUncertain: 'true' }), { code: 'MUSIC_CUT_INPUT' }); await assert.rejects(fx.service().cut({ ...fx.request(), originalVolume: -1 }), { code: 'MUSIC_CUT_INPUT' }); assert.equal(fx.state.reads.length, count); assert.equal(fx.state.applies.length, 0);
});

test('conflicting permission aliases are rejected and an append constraint never overwrites the old timeline', async t => {
  const fx = await fixture(t);
  await assert.rejects(fx.service().cut(fx.request(), { scope: fx.scope, editScope: { placement: { mode: 'range', start: 2, end: 10 } } }), { code: 'MUSIC_CUT_CONTEXT_CONFLICT' });
  await fx.service().cut(fx.request(), { scope: { placement: { mode: 'append' } } }); assert.equal(fx.state.applies[0].plan.placement.start, 12);
  await assert.rejects(fx.service().cut({ ...fx.request(), timelineAt: 0 }, { scope: { placement: { mode: 'append' } } }), { code: 'MUSIC_CUT_RANGE' }); assert.equal(fx.state.applies.length, 1);
});

test('cancellation at the last pre-dispatch progress leaves no native call and a known failed-before-write intent', async t => {
  const fx = await fixture(t), request = fx.request(), controller = new AbortController();
  await assert.rejects(fx.service().cut(request, { signal: controller.signal, update: message => { if (message.startsWith('正在将')) controller.abort(); } }), { code: 'REQUEST_CANCELLED' });
  assert.equal(fx.state.applies.length, 0); assert.equal((await fx.service().status(fx.project.id, request.requestId)).status, 'failed-before-write');
});

test('a journal failure after native acknowledgement returns its real receipt and preserves pending disk identity across restart', async t => {
  let stateWrites = 0;
  const fx = await fixture(t, { dependencies: { writeFile: async (...args) => { if (++stateWrites === 2) throw Object.assign(new Error('controlled full disk'), { code: 'ENOSPC' }); return writeFile(...args); } } }), request = fx.request();
  const result = await fx.service().cut(request); assert.equal(result.operationRecordPersisted, false); assert.match(result.warnings.join(' '), /原生卡点已经提交/); assert.ok(result.nativeUndoId);
  assert.equal((await fx.service().status(fx.project.id, request.requestId)).status, 'completed');
  const disk = JSON.parse(await readFile(path.join(fx.directory, 'music-cuts/operations.json'), 'utf8')); assert.equal(disk.operations[0].status, 'pending');
  await fx.reopen(); await assert.rejects(fx.service().cut(request), { code: 'MUSIC_CUT_UNCONFIRMED' }); assert.equal(fx.state.applies.length, 1);
});
