import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createAssistantAppTools } from '../lib/assistant-app-tools.mjs';
import { createAssistantFrameReader } from '../lib/assistant-frame-reader.mjs';

const SOURCE = 'creation-reference-video', OTHER = 'creation-other-video';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const TIMESTAMPS = Array.from({ length: 50 }, (_, i) => Math.round((i + .5) * 92 / 50 * 1000) / 1000);

function fixture(t) {
  const project = { id: 'creation-progress-project', kind: 'video', title: '隔离进度夹具', createdAt: '2026-11-21T00:00:00.000Z', video: { editScope: { assetIds: [SOURCE], placement: { mode: 'free' } } } };
  const secondProject = { ...structuredClone(project), id: 'another-progress-project', createdAt: '2026-11-21T00:01:00.000Z' };
  const projects = new Map([[project.id, project], [secondProject.id, secondProject]]);
  const asset = { id: SOURCE, type: 'video', name: 'reference.mp4', path: 'C:/PRIVATE-host-file/reference.mp4', duration: 92, width: 1280, height: 720, size: 1000, mtimeMs: 1, hasAudio: false }, other = { ...asset, id: OTHER };
  const counts = { native: 0, decodeBatches: 0, decodedFrames: 0, modelCalls: 0, projectWrites: 0 }, hooks = {};
  const store = { read: async id => projects.has(id) ? structuredClone(projects.get(id)) : null, updateAssistant: async () => { counts.projectWrites++; throw new Error('Progress fixture must not write the project'); } };
  const native = { revision: 'native-r1', duration: 0, assets: [asset, other], timeline: [], aspect: '16:9', stage: { w: 1280, h: 720 }, mainTrackEditable: true, warnings: [], editorTimeline: { clips: [], tracks: [] } };
  const openFilm = { context: async () => { counts.native++; return structuredClone(native); } };
  const videoService = { resolveAsset: async id => { await hooks.resolveAsset?.(); return structuredClone(id === SOURCE ? asset : other); }, referenceFrames: async (_id, options) => { counts.decodeBatches++; counts.decodedFrames += options.timestamps.length; return options.timestamps.map(timestamp => ({ dataUrl: PNG, timestamp })); } };
  const reader = createAssistantFrameReader({ store, openFilm, videoService });
  const options = { store, openFilm, videoService, frameReader: reader, ai: async () => { counts.modelCalls++; throw new Error('Progress and cached reference do not invoke models'); } };
  const app = createAssistantAppTools(options), apps = [app];
  t.after(async () => { for (const value of apps) await value.close(); await reader.close(); });
  const context = overrides => ({ projectId: project.id, runId: randomUUID(), instruction: '按参考视频逐镜重建', editScope: { assetIds: [SOURCE], placement: { mode: 'free' } }, scopeAuthority: 'dialog', mode: 'auto', origin: 'http://127.0.0.1:4417', signal: new AbortController().signal, settings: { model: 'fixture-only' }, update() {}, ...overrides });
  const ctx = context();
  const call = (name, args = {}, selected = ctx, selectedApp = app) => { const tool = selectedApp.tools.find(tool => tool.name === name); assert.ok(tool, name); return tool.execute(args, selected); };
  async function readPage(offset, { annotate = true, selected = ctx, source = SOURCE } = {}) {
    const raw = await call('media_frames_read', { assetId: source, timestamps: TIMESTAMPS, pageSize: 10, offset }, selected);
    if (annotate) await call('media_frame_notes', { inspectionId: raw.data.inspectionId, notes: raw.data.frames.map(frame => ({ frameIndex: frame.index, description: `已验证第${frame.index}帧的夹具图像；语义未由真实模型审阅。` })) }, selected);
    return raw;
  }
  async function readAll(selected = ctx) { const pages = []; for (let offset = 0; offset < 50; offset += 10) pages.push(await readPage(offset, { selected })); return pages; }
  function freshApp() { const value = createAssistantAppTools(options); apps.push(value); return value; }
  return { app, reader, project, secondProject, asset, native, counts, hooks, ctx, context, call, readPage, readAll, freshApp };
}

test('partial and unannotated reference plans are not ready and do not imply creation on an empty free timeline', async t => {
  const f = fixture(t), initial = await f.app.progressContext(f.ctx);
  assert.equal(initial.referenceReady, false); assert.equal(initial.timelineEmpty, true); assert.equal(initial.scope.placement.mode, 'free');
  assert.equal(initial.creationStarted, false); assert.equal(initial.creationComplete, false);
  await f.readPage(0);
  const partial = await f.app.progressContext(f.ctx);
  assert.equal(partial.frameCount, 10); assert.equal(partial.noteCount, 10); assert.equal(partial.plannedFrameCount, 50); assert.equal(partial.referenceReady, false);
  await f.readPage(10, { annotate: false });
  const missingNotes = await f.app.progressContext(f.ctx);
  assert.equal(missingNotes.frameCount, 20); assert.equal(missingNotes.noteCount, 10); assert.equal(missingNotes.referenceReady, false);
  assert.equal(missingNotes.creationStarted, false); assert.equal(missingNotes.creationComplete, false); assert.equal(f.counts.projectWrites, 0); assert.equal(f.counts.modelCalls, 0);
});

test('all fifty bound notes make the stable reference plan ready without marking a movie complete', async t => {
  const f = fixture(t); await f.readAll();
  const progress = await f.app.progressContext(f.ctx);
  assert.equal(progress.referenceReady, true); assert.equal(progress.frameCount, 50); assert.equal(progress.noteCount, 50); assert.equal(progress.plannedFrameCount, 50); assert.equal(progress.sourceDuration, 92);
  assert.equal(progress.timelineEmpty, true); assert.equal(progress.scope.placement.mode, 'free'); assert.equal(progress.creationStarted, false); assert.equal(progress.creationComplete, false);
  assert.ok(progress.productionTools.includes('animation_create') && progress.productionTools.includes('native_scope_set'));
  assert.equal(JSON.stringify(progress).includes('data:image'), false); assert.equal(JSON.stringify(progress).includes('PRIVATE-host-file'), false);
  const decoded = f.counts.decodedFrames;
  await f.app.progressContext(f.ctx); await f.app.progressContext(f.ctx);
  assert.equal(f.counts.decodedFrames, decoded); assert.equal(f.counts.modelCalls, 0); assert.equal(f.counts.projectWrites, 0);
});

test('finishRun exports original verified metadata and a new run restores notes and known IDs without decoding fifty again', async t => {
  const f = fixture(t), pages = await f.readAll();
  assert.equal(f.counts.decodedFrames, 50);
  f.app.finishRun({ id: f.ctx.runId, status: 'completed' });
  const next = f.context({ instruction: '开始制作' }), progress = await f.app.progressContext(next);
  assert.equal(progress.referenceCacheRestored, true); assert.equal(progress.referenceReady, true); assert.equal(progress.frameCount, 50); assert.equal(progress.noteCount, 50);
  assert.equal(progress.creationStarted, false); assert.equal(progress.creationComplete, false); assert.equal(progress.timelineEmpty, true); assert.equal(progress.scope.placement.mode, 'free');
  assert.equal(f.counts.decodedFrames, 50); assert.equal(f.counts.modelCalls, 0);
  const recalled = await f.call('media_frames_recall', { inspectionIds: [pages[2].data.inspectionId], offset: 0, limit: 2 }, next);
  assert.equal(recalled.data.notes.length, 10); assert.deepEqual(recalled.data.selectedImageFrames.map(frame => frame.frameIndex), [21, 22]);
  assert.ok(recalled.imageBatch.every(image => image.detail === 'high')); assert.equal(JSON.stringify(recalled.data).includes('data:image'), false); assert.equal(JSON.stringify(recalled.data).includes('PRIVATE-host-file'), false);
  assert.equal(f.counts.decodedFrames, 50);
});

test('an unannotated last read does not discard earlier verified notes during finishRun cache export', async t => {
  const f = fixture(t); await f.readPage(0); await f.readPage(10); const unannotated = await f.readPage(20, { annotate: false });
  f.app.finishRun({ id: f.ctx.runId, status: 'cancelled' });
  const next = f.context({ instruction: '继续制作' }), progress = await f.app.progressContext(next);
  assert.equal(progress.referenceCacheRestored, true); assert.equal(progress.noteCount, 20); assert.equal(progress.frameCount, 20); assert.equal(progress.referenceReady, false); assert.equal(progress.plannedFrameCount, 50);
  await assert.rejects(f.call('media_frame_notes', { inspectionId: unannotated.data.inspectionId, notes: [{ frameIndex: 21, description: '未登记批次不能跨run冒认' }] }, next), { code: 'ASSISTANT_REFERENCE_RECEIPT_REQUIRED' });
});

test('current write scope narrowing retains readable current-project reference notes', async t => {
  const f = fixture(t); await f.readAll(); f.app.finishRun({ id: f.ctx.runId, status: 'completed' });
  const narrowed = f.context({ instruction: '开始制作，只用所选素材', editScope: { assetIds: [OTHER], placement: { mode: 'free' } } });
  const progress = await f.app.progressContext(narrowed);
  assert.equal(progress.referenceReady, false); assert.equal(progress.frameCount, 0); assert.equal(progress.noteCount, 0); assert.deepEqual(progress.scope.assetIds, [OTHER]);
  const recalled = await f.call('media_frames_recall', {}, narrowed); assert.equal(recalled.data.assets[0].id, SOURCE);
  const newPage = await f.readPage(0, { selected: narrowed, source: OTHER }); assert.equal(newPage.data.asset.id, OTHER);
  assert.equal(f.counts.modelCalls, 0);
});

test('project owner changes discard old cache while fresh frame reads remain available', async t => {
  const f = fixture(t); await f.readAll(); f.app.finishRun({ id: f.ctx.runId, status: 'completed' });
  f.project.createdAt = '2026-11-21T01:00:00.000Z';
  const next = f.context({ instruction: '开始制作' }), progress = await f.app.progressContext(next);
  assert.equal(progress.referenceCacheRestored, false); assert.equal(progress.referenceReady, false); assert.equal(progress.noteCount, 0); assert.equal(progress.ownerCreatedAt, f.project.createdAt);
  const current = await f.readPage(0, { selected: next }); assert.equal(current.data.frames.length, 10); assert.equal(f.counts.modelCalls, 0);
});

test('source fingerprint changes discard stale cache without blocking a fresh source reading', async t => {
  const f = fixture(t); await f.readAll(); f.app.finishRun({ id: f.ctx.runId, status: 'completed' }); f.asset.mtimeMs++;
  const next = f.context({ instruction: '开始制作' }), progress = await f.app.progressContext(next);
  assert.equal(progress.referenceCacheRestored, false); assert.equal(progress.referenceReady, false); assert.equal(progress.noteCount, 0);
  await f.readPage(0, { selected: next }); assert.equal((await f.app.progressContext(next)).noteCount, 10); assert.equal(f.counts.modelCalls, 0);
});

test('metadata TTL expiry prevents replay into a later run and allows fresh preparation', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const f = fixture(t); await f.readAll(); f.app.finishRun({ id: f.ctx.runId, status: 'completed' }); now += 61 * 60000;
  const next = f.context({ instruction: '开始制作' }), progress = await f.app.progressContext(next);
  assert.equal(progress.referenceCacheRestored, false); assert.equal(progress.referenceReady, false); assert.equal(progress.frameCount, 0);
  await f.readPage(0, { selected: next }); assert.equal((await f.app.progressContext(next)).noteCount, 10);
});

test('another project and another app instance do not receive the previous project memory cache', async t => {
  const f = fixture(t); await f.readAll(); f.app.finishRun({ id: f.ctx.runId, status: 'completed' });
  const other = f.context({ projectId: f.secondProject.id, instruction: '开始制作' });
  assert.equal((await f.app.progressContext(other)).referenceReady, false);
  const restarted = f.freshApp(), next = f.context({ instruction: '开始制作' });
  const fresh = await restarted.progressContext(next);
  assert.equal(fresh.referenceReady, false); assert.equal(fresh.noteCount, 0); assert.equal(fresh.referenceCacheRestored, false); assert.equal(f.counts.modelCalls, 0);
});

test('abort during cached state initialization does not convert cancellation into a ready reference', async t => {
  const f = fixture(t); await f.readAll(); f.app.finishRun({ id: f.ctx.runId, status: 'completed' });
  const controller = new AbortController(); controller.abort(); const stopped = f.context({ instruction: '开始制作', signal: controller.signal });
  await assert.rejects(f.app.progressContext(stopped), { code: 'REQUEST_CANCELLED' }); assert.equal(f.counts.projectWrites, 0); assert.equal(f.counts.modelCalls, 0);
});

test('concurrent progress readers wait for the same complete cache restoration instead of seeing half-initialized state', async t => {
  const f = fixture(t); await f.readAll(); f.app.finishRun({ id: f.ctx.runId, status: 'completed' });
  let entered, release; const entry = new Promise(resolve => { entered = resolve; }), blocked = new Promise(resolve => { release = resolve; });
  f.hooks.resolveAsset = async () => { entered(); await blocked; };
  const next = f.context({ instruction: '开始制作' }), first = f.app.progressContext(next); await entry;
  let settled = false; const second = f.app.progressContext(next); second.then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve)); const returnedBeforeRestore = settled;
  release(); f.hooks.resolveAsset = null; const values = await Promise.all([first, second]);
  assert.equal(returnedBeforeRestore, false, 'progress must wait for the pending source/cache initialization');
  assert.ok(values.every(value => value.referenceReady && value.referenceCacheRestored && value.noteCount === 50));
  assert.equal(f.counts.decodedFrames, 50); assert.equal(f.counts.modelCalls, 0);
});
