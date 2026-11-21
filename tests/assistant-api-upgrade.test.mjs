import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createProjectStore } from '../lib/store.mjs';
import { createAssistantAppTools } from '../lib/assistant-app-tools.mjs';
import { createAssistantFrameReader } from '../lib/assistant-frame-reader.mjs';

const ASSET = 'allowed-reference-video', UNSELECTED = 'unselected-native-video', FOREIGN = 'other-project-reference';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const sourceVersion = asset => createHash('sha256').update(JSON.stringify([asset.id, asset.type, asset.size, asset.mtimeMs, asset.duration, asset.width, asset.height, asset.hasAudio])).digest('hex');

async function fixture(t, { duration = 92, frameTools = true, instruction = '按参考视频完整逐镜对照重建', placement = { mode: 'append' }, inspectDurations, compareVerdict = 'pass' } = {}) {
  const testRoot = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()), directory = await mkdtemp(path.join(testRoot, 'gx-api-upgrade-'));
  const store = await createProjectStore(directory), project = await store.save('current-video', { kind: 'video', title: '隔离接口验证', video: { editScope: { assetIds: [ASSET], placement } } });
  const asset = { id: ASSET, type: 'video', name: '参考.mp4', duration, size: 1000, mtimeMs: 1, width: 1280, height: 720, hasAudio: true }, foreign = { ...asset, id: FOREIGN }, unselected = { ...asset, id: UNSELECTED };
  const calls = { native: [], frameReads: [], metadata: [], analyze: [], generate: [], inspect: [], review: [], compare: [], start: [], append: [], ai: 0 }, hooks = {};
  const native = { assets: [asset, unselected], duration: 10, aspect: '16:9', stage: { w: 1280, h: 720 }, timeline: [], mainTrackEditable: true, warnings: [], revision: 'native-r1' };
  let currentSource = { id: 'remotion-fixture', revision: 0, title: '自由工程', entryPoint: 'src/index.tsx', compositionId: 'Main', inputProps: {}, files: [{ path: 'src/index.tsx', content: 'export const Fixture = () => null;' }], assets: [], ownerCreatedAt: project.createdAt };
  const openFilm = { context: async (_projectId, _origin, options = {}) => {
    calls.native.push(structuredClone(options));
    const offset = options.inspection?.offset || 0, limit = options.inspection?.limit || 2;
    return { ...structuredClone(native), editorTimeline: { clips: Array.from({ length: Math.min(limit, 310 - offset) }, (_, i) => ({ id: 'clip-' + (offset + i), assetId: ASSET, track: 0, at: offset + i, end: offset + i + 1, start: 0, duration: 1, locked: false, editable: true })), tracks: [{ index: 0, name: '视频轨', clipCount: 310 }], offset, total: 310, nextOffset: offset + limit < 310 ? offset + limit : null, truncated: offset + limit < 310 } };
  } };
  const videoService = {
    resolveAsset: async id => { assert.ok([ASSET, FOREIGN, UNSELECTED].includes(id)); return structuredClone(id === ASSET ? asset : id === UNSELECTED ? unselected : foreign); },
    referenceFrames: async (_id, options) => { calls.frameReads.push({ timestamps: options.timestamps?.slice(), range: options.range }); return options.timestamps.map(timestamp => ({ dataUrl: PNG, timestamp })); },
    readAssetMetadata: async (id, options) => { calls.metadata.push({ id, signal: options.signal }); return { assetId: id, sourceVersion: sourceVersion(asset), sourceDuration: duration, catalogDuration: duration, fps: 30, fpsKind: 'reported-average', video: [{ codec: 'h264', width: 1280, height: 720 }], hasAudio: true, audioTrackCount: 1, audioTracks: [{ codec: 'aac', sampleRate: 48000, channels: 2 }] }; },
  };
  const reader = frameTools ? createAssistantFrameReader({ videoService, store, openFilm }) : undefined;
  const remotion = {
    read: async () => structuredClone(currentSource),
    generate: async (projectId, args, options) => {
      calls.generate.push({ projectId, args: structuredClone(args), options });
      if (options.assertReferenceEvidence) await options.assertReferenceEvidence();
      await hooks.generate?.(args, options);
      if (options.assertReferenceEvidence) await options.assertReferenceEvidence();
      currentSource = { ...currentSource, revision: currentSource.revision + 1 };
      return { project: structuredClone(currentSource) };
    },
    inspect: async (_projectId, _id, options) => { calls.inspect.push(options); const seconds = inspectDurations?.[Math.min(calls.inspect.length - 1, inspectDurations.length - 1)] ?? duration; return { compositions: [{ id: 'Main', fps: 30, width: 1280, height: 720, durationInFrames: Math.round(seconds * 30) }] }; },
    review: async (_projectId, _id, options) => { calls.review.push(options); return { status: 'reviewed', verdict: 'pass', revision: currentSource.revision, summary: '夹具输出采样检查', frames: [{ frame: 30 }], issues: [] }; },
    compareReference: async (_projectId, _id, options) => {
      calls.compare.push(options); await options.assertReferenceEvidence?.();
      return { status: 'reviewed', verdict: compareVerdict, summary: '夹具参考对照', revision: currentSource.revision, pairs: [{ pairId: 'pair-1', output: { frame: 30 } }], issues: compareVerdict === 'revise' ? [{ pairId: 'pair-1', severity: 'blocking', detail: '参考物体未出现', fix: '按原图补回主体' }] : [], coverage: { returnedPairs: options.referenceEvidence?.images.length || 0, nextOffset: options.referenceEvidence?.context.imagePagination?.nextOffset ?? null } };
    },
    start: async (...args) => { calls.start.push(args); return { jobId: 'fixture-render-job' }; },
    job: async () => ({ id: 'fixture-render-job', status: 'complete', kind: 'video', result: { duration } }),
    append: async (...args) => { calls.append.push(args); native.revision = 'native-r' + (calls.append.length + 1); return { revision: native.revision, duration, asset: { id: 'rendered-fixture' }, undo: { id: 'fixture-undo' }, placement }; },
    publicJob: (_projectId, job) => structuredClone(job), cancel: async () => ({ status: 'cancelled' }),
  };
  const sourceAnalysis = { analyze: async (_projectId, input) => { calls.analyze.push(input); return { items: [{ assetId: ASSET, range: { start: 0, end: duration }, shots: [{ id: 's000', start: 0, end: duration, evidence: [] }], keyframes: [], coverage: { sampledFrameCount: 0, frameByFrame: false }, summary: { kind: 'technical', text: '只有技术概览，未作画面语义判断' }, transcript: { status: 'error', text: '' }, warnings: ['夹具音频转写不可用'] }], warnings: [] }; } };
  const app = createAssistantAppTools({ store, openFilm, videoService, frameReader: reader, sourceAnalysis, remotion, ai: async () => { calls.ai++; throw new Error('Unexpected paid-model path in API fixture'); } });
  const ctx = { projectId: project.id, runId: randomUUID(), instruction, editScope: { assetIds: [ASSET], placement }, scopeAuthority: 'explicit-scope', origin: 'http://127.0.0.1:4417', mode: 'auto', signal: new AbortController().signal, settings: { model: 'fixture-model' }, update() {} };
  const tool = name => { const found = app.tools.find(item => item.name === name); assert.ok(found, name + ' should be registered'); return found; };
  const call = (name, args = {}, context = ctx) => tool(name).execute(args, context);
  t.after(async () => { await app.close(); await reader?.close(); await store.settle(); assert.ok(directory.startsWith(testRoot + path.sep)); await rm(directory, { recursive: true, force: true }); });
  return { app, ctx, store, project, asset, native, calls, hooks, reader, tool, call };
}
async function readNotes(f, options = {}) {
  const raw = await f.call('media_frames_read', { assetId: ASSET, ...options });
  await f.call('media_frame_notes', { inspectionId: raw.data.inspectionId, notes: raw.data.frames.map(frame => ({ frameIndex: frame.index, description: `第${frame.index}帧出现蓝色几何主体。`, visibleText: '仅夹具文字', layout: '主体居中', motion: '依据所列时刻，不假设未读运动' })) });
  return raw;
}

for (const instruction of ['模仿参考视频风格，制作3秒动画，不加入时间线', 'Replicate the reference video style in a new 3-second animation, without appending to the timeline']) {
  test('style-only reference keeps the requested animation duration: ' + instruction, async t => {
    const f = await fixture(t, { duration: 20, instruction, placement: { mode: 'free' }, inspectDurations: [3] });
    await readNotes(f, { timestamps: [0, 5, 10, 15, 19], pageSize: 5 });
    assert.equal((await f.app.progressContext(f.ctx)).referenceReady, true);
    await f.call('animation_create', { instruction, append: false });
    assert.equal(f.calls.generate.length, 1);
    assert.equal(f.calls.inspect.length, 1);
    assert.equal(f.calls.generate[0].options.referenceEvidence.context.assets[0].duration, 20);
    assert.equal(f.calls.generate[0].options.referenceEvidence.context.expectedDuration, undefined);
    assert.equal(f.calls.generate[0].args.instruction.includes('参考重建目标为20秒'), false);
    assert.equal(f.calls.compare.length, 0);
    assert.equal(f.calls.start.length, 1);
    assert.equal(f.calls.append.length, 0);
  });
}

test('explicit complete shot reconstruction still checks the full duration when style is mentioned', async t => {
  const instruction = '完整逐镜重建参考视频，保留原片风格';
  const f = await fixture(t, { duration: 20, instruction, inspectDurations: [20] });
  await readNotes(f, { timestamps: [0, 5, 10, 15, 19], pageSize: 5 });
  await f.call('animation_create', { instruction, append: false });
  assert.equal(f.calls.generate[0].options.referenceEvidence.context.expectedDuration, 20);
  assert.ok(f.calls.compare.length > 0);
  assert.equal(f.calls.start.length, 1);
});

test('frame packets stay out of JSON data and notes reach actual reference generation and comparison options', async t => {
  const f = await fixture(t), raw = await readNotes(f, { pageSize: 4 });
  assert.equal(raw.data.frames.length, 4); assert.ok(raw.imageBatch.every(image => image.detail === 'high'));
  assert.equal(typeof f.tool('media_frames_read').images, 'function');
  assert.equal(f.tool('media_frames_read').images(raw), raw.imageBatch);
  assert.ok(!JSON.stringify(raw.data).includes('data:image'));
  const recall = await f.call('media_frames_recall', { offset: 1, limit: 2 });
  assert.deepEqual(recall.data.selectedImageFrames.map(frame => frame.frameIndex), [2, 3]);
  assert.equal(recall.data.notes.length, 4); assert.equal(f.tool('media_frames_recall').images(recall), recall.imageBatch);
  const metadata = await f.call('media_asset_read', { assetId: ASSET }); assert.equal(metadata.data.fps, 30); assert.equal(metadata.data.audioTracks[0].sampleRate, 48000);
  const made = await f.call('animation_create', { instruction: '按真实画面完整制作' });
  const generation = f.calls.generate[0], evidence = generation.options.referenceEvidence;
  assert.equal(evidence.context.expectedDuration, 92); assert.equal(evidence.context.sourceAssetId, ASSET); assert.deepEqual(evidence.context.sourceRange, { start: 0, end: 92 });
  assert.equal(evidence.context.notes.length, 4); assert.ok(evidence.context.notes[0].description.includes('蓝色几何'));
  assert.ok(evidence.images.length > 0 && evidence.images.every(image => image.dataUrl === PNG && image.detail === 'high'));
  assert.ok(generation.args.instruction.includes('92秒')); assert.ok(generation.args.instruction.includes('48000'));
  assert.equal(typeof generation.options.assertReferenceEvidence, 'function');
  assert.equal(f.calls.review.length, 1); assert.equal(f.calls.compare.length, 1); assert.ok(f.calls.compare[0].referenceEvidence.images.length <= 6);
  assert.equal(made.data.review.referenceComparison.status, 'reviewed'); assert.equal(f.calls.start.length, 1); assert.equal(f.calls.append.length, 1); assert.equal(f.calls.ai, 0);
});

test('foreign assets and unrelated run receipts are refused before production or picture forwarding', async t => {
  const f = await fixture(t);
  await assert.rejects(f.call('media_frames_read', { assetId: FOREIGN }), { code: 'ASSISTANT_MEDIA_SCOPE' });
  await assert.rejects(f.call('media_asset_read', { assetId: FOREIGN }), { code: 'ASSISTANT_MEDIA_SCOPE' });
  assert.equal(f.calls.frameReads.length, 0); assert.equal(f.calls.metadata.length, 0);
  const raw = await readNotes(f, { pageSize: 2 });
  const other = { ...f.ctx, runId: randomUUID() };
  await assert.rejects(f.call('media_frame_notes', { inspectionId: raw.data.inspectionId, notes: [{ frameIndex: 1, description: '未在本轮读取' }] }, other), { code: 'ASSISTANT_REFERENCE_RECEIPT_REQUIRED' });
  await assert.rejects(f.call('media_frames_recall', { inspectionIds: [raw.data.inspectionId] }, other), { code: 'ASSISTANT_REFERENCE_RECEIPT_REQUIRED' });
  assert.equal(f.calls.generate.length, 0);
});

test('audio-transcription errors do not block later actual-frame visual production', async t => {
  const f = await fixture(t);
  const overview = await f.call('media_analyze', { assetIds: [ASSET], maxFrames: 12, maxShotSeconds: 4 });
  assert.equal(f.calls.analyze[0].options.transcribe, false); assert.equal(f.calls.analyze[0].options.maxFrames, 12); assert.equal(f.calls.analyze[0].options.maxShotSeconds, 4);
  assert.equal(overview.data.items[0].transcript.status, 'error'); assert.ok(Array.isArray(overview.data.items[0].shots));
  await f.call('media_analyze', { assetIds: [ASSET], transcribe: true, transcriptionModel: 'fixture-transcriber' });
  assert.equal(f.calls.analyze[1].options.transcribe, true); assert.equal(f.calls.analyze[1].options.transcriptionModel, 'fixture-transcriber');
  await readNotes(f, { pageSize: 2 }); await f.call('animation_create', { instruction: '先做纯视觉动画' });
  assert.equal(f.calls.generate.length, 1); assert.equal(f.calls.append.length, 1); assert.equal(f.calls.ai, 0);
});

test('reference recall remains available when the editing selection changes', async t => {
  const f = await fixture(t); await readNotes(f, { pageSize: 2 });
  await f.call('native_scope_set', { placement: { mode: 'append' }, assetIds: [UNSELECTED] });
  const recalled = await f.call('media_frames_recall');
  assert.equal(recalled.data.assets[0].id, ASSET);
  const metadata = await f.call('media_asset_read', { assetId: UNSELECTED });
  assert.equal(metadata.data.registration.nativeImported, true);
  assert.equal(f.calls.generate.length, 0);
});

test('full-project readable reference notes do not override an explicit human selected-only production request', async t => {
  const f = await fixture(t, { duration: 20, instruction: '只用所选素材制作3秒动画', inspectDurations: [3] });
  f.ctx.scopeAuthority = 'dialog';
  const excluded = await f.call('media_frames_read', { assetId: UNSELECTED, pageSize: 2 });
  await f.call('media_frame_notes', { inspectionId: excluded.data.inspectionId, notes: excluded.data.frames.map(frame => ({ frameIndex: frame.index, description: '整个工程可读的其他素材观察' })) });
  const recalled = await f.call('media_frames_recall'); assert.equal(recalled.data.assets[0].id, UNSELECTED);
  assert.equal((await f.app.progressContext(f.ctx)).referenceReady, false);
  await f.call('animation_create', { instruction: '只用所选素材制作3秒动画', append: false });
  assert.equal(f.calls.generate[0].options.referenceEvidence, undefined);
  assert.equal(f.calls.generate[0].args.instruction.includes('参考重建目标为20秒'), false);
  assert.equal(f.calls.start.length, 1); assert.equal(f.calls.append.length, 0);
  const g = await fixture(t, { duration: 20, instruction: '只用所选素材制作动画' }); g.ctx.scopeAuthority = 'dialog';
  const other = await g.call('media_frames_read', { assetId: UNSELECTED, pageSize: 2 });
  await g.call('media_frame_notes', { inspectionId: other.data.inspectionId, notes: other.data.frames.map(frame => ({ frameIndex: frame.index, description: '不作为此次主视觉' })) });
  await readNotes(g, { pageSize: 2 });
  await g.call('animation_create', { instruction: '只用所选素材制作动画', append: false });
  assert.deepEqual(g.calls.generate[0].options.referenceEvidence.context.assets.map(asset => asset.id), [ASSET]);
  assert.ok(g.calls.generate[0].options.referenceEvidence.context.notes.every(note => note.assetId === ASSET));
  assert.deepEqual(g.calls.generate[0].options.referenceEvidence.images.map(frame => frame.assetId), [ASSET, ASSET]);
});

test('registered pictures are checked against live sources before generation and inside its assert callback', async t => {
  const f = await fixture(t); await readNotes(f, { pageSize: 2 }); f.asset.mtimeMs++;
  await assert.rejects(f.call('animation_create', { instruction: '继续制作' }), error => /ASSET_CHANGED|SOURCE_CHANGED/.test(error.code));
  assert.equal(f.calls.generate.length, 0); assert.equal(f.calls.append.length, 0);
  const g = await fixture(t); await readNotes(g, { pageSize: 2 }); g.hooks.generate = () => { g.asset.mtimeMs++; };
  await assert.rejects(g.call('animation_create', { instruction: '继续制作' }), error => /ASSET_CHANGED|SOURCE_CHANGED|REFERENCE_CHANGED/.test(error.code));
  assert.equal(g.calls.generate.length, 1); assert.equal(g.calls.start.length, 0); assert.equal(g.calls.append.length, 0);
});

test('owner changes during production are detected by the reference assert callback', async t => {
  const f = await fixture(t); await readNotes(f, { pageSize: 2 });
  f.hooks.generate = async () => { await f.store.save(f.project.id, { kind: 'video', title: '人工更新过的工程', video: { timeline: [] } }); };
  await assert.rejects(f.call('animation_create', { instruction: '制作' }), { code: 'ASSISTANT_CONFLICT' });
  assert.equal(f.calls.start.length, 0); assert.equal(f.calls.append.length, 0);
});

test('a valid read page can enter generation before notes without fake semantic descriptions', async t => {
  const f = await fixture(t), raw = await f.call('media_frames_read', { assetId: ASSET, pageSize: 2 });
  const recalled = await f.call('media_frames_recall', { inspectionIds: [raw.data.inspectionId], limit: 2 });
  assert.equal(recalled.imageBatch.length, 2); assert.equal(recalled.data.notes.length, 0);
  await f.call('animation_create', { instruction: '根据实际图片制作' });
  assert.equal(f.calls.generate[0].options.referenceEvidence.context.notes.length, 0);
  assert.equal(f.calls.generate[0].options.referenceEvidence.images.length, 2);
  assert.equal(f.calls.ai, 0);
});

test('inspect duration mismatches are repaired before rendering or appending the reference reconstruction', async t => {
  const f = await fixture(t, { inspectDurations: [22.5, 92] }); await readNotes(f, { pageSize: 2 });
  const made = await f.call('animation_create', { instruction: '按视频逐镜重建' });
  assert.equal(f.calls.generate.length, 2); assert.ok(f.calls.generate[1].args.diagnostics.includes('92秒'));
  assert.equal(made.data.workflow.compileRepairs, 1); assert.equal(f.calls.start.length, 1); assert.equal(f.calls.append.length, 1);
  const g = await fixture(t, { inspectDurations: [22.5] }); await readNotes(g, { pageSize: 2 });
  await assert.rejects(g.call('animation_create', { instruction: '必须完整制作' }), error => error.code === 'REMOTION_COMPILE_FAILED' && error.message.includes('92秒'));
  assert.equal(g.calls.generate.length, 3); assert.equal(g.calls.start.length, 0); assert.equal(g.calls.append.length, 0);
});

test('blocking reference differences are repaired and retained as real issues before timeline changes', async t => {
  const f = await fixture(t, { compareVerdict: 'revise' }); await readNotes(f, { pageSize: 2 });
  const result = await f.call('animation_create', { instruction: '逐镜制作' });
  assert.equal(f.calls.compare.length, 3); assert.equal(f.calls.generate.length, 3);
  assert.equal(result.data.review.referenceComparison.verdict, 'revise'); assert.equal(result.data.review.issues[0].frame, 30);
  assert.equal(f.calls.start.length, 0); assert.equal(f.calls.append.length, 0);
});

test('native inspect forwards explicit pagination and returns objects beyond the previous 300-clip bound', async t => {
  const f = await fixture(t);
  const result = await f.call('native_inspect', { offset: 300, limit: 5 });
  assert.deepEqual(f.calls.native.at(-1).inspection, { offset: 300, limit: 5 });
  assert.deepEqual(result.data.clips.map(clip => clip.id), ['clip-300', 'clip-301', 'clip-302', 'clip-303', 'clip-304']);
  assert.equal(result.data.total, 310); assert.equal(result.data.nextOffset, 305);
});

test('reference comparison uses ordered offset pictures and preserves incomplete coverage', async t => {
  const f = await fixture(t); await readNotes(f, { pageSize: 12 });
  const result = await f.call('remotion_compare_reference', { id: 'remotion-fixture', expectedRevision: 1, offset: 6, limit: 6 });
  const evidence = f.calls.compare[0].referenceEvidence;
  assert.deepEqual(evidence.context.selectedImageFrames.map(frame => frame.frameIndex), [7, 8, 9, 10, 11, 12]);
  assert.equal(evidence.context.coverage.frameByFrame, false); assert.equal(result.data.coverage.returnedPairs, 6);
});

test('legacy animation flow works without a frame reader or registered reference packets', async t => {
  const f = await fixture(t, { frameTools: false, duration: 2, instruction: '制作自由动画' });
  assert.equal(f.app.tools.some(tool => tool.name === 'media_frames_read'), false);
  await f.call('animation_create', { instruction: '原创构图动画' });
  assert.equal(f.calls.generate[0].options.referenceEvidence, undefined); assert.equal(f.calls.compare.length, 0); assert.equal(f.calls.append.length, 1); assert.equal(f.calls.ai, 0);
});

test('validated finished reference metadata resumes in the same owned project without persisting picture bytes', async t => {
  const f = await fixture(t), raw = await readNotes(f, { pageSize: 2 });
  f.app.finishRun({ id: f.ctx.runId, status: 'completed' });
  const next = { ...f.ctx, runId: randomUUID() };
  const recalled = await f.call('media_frames_recall', { inspectionIds: [raw.data.inspectionId] }, next);
  assert.equal(recalled.data.notes.length, 2); assert.ok(!JSON.stringify(recalled.data).includes('data:image'));
  await f.call('animation_create', { instruction: '新请求制作' }, next);
  assert.equal(f.calls.generate[0].options.referenceEvidence.context.expectedDuration, 92);
});

test('a detail-reading range does not shorten an explicitly complete reference reconstruction', async t => {
  const f = await fixture(t, { instruction: '完整重建整个参考视频，逐镜对照' });
  await readNotes(f, { range: { start: 40, end: 52 }, pageSize: 2 });
  await f.call('animation_create', { instruction: '制作完整92秒参考动画' });
  assert.equal(f.calls.generate[0].options.referenceEvidence.context.expectedDuration, 92);
  assert.deepEqual(f.calls.generate[0].options.referenceEvidence.context.sourceRange, { start: 0, end: 92 });
});
