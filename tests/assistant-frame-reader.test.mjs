import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { createAssistantFrameReader, ASSISTANT_FRAME_LIMITS } from '../lib/assistant-frame-reader.mjs';
import { createVideoService } from '../lib/video.mjs';
import { createSourceAnalysisService } from '../lib/source-analysis.mjs';

const execute = promisify(execFile);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=', 'base64');
const DATA = 'data:image/png;base64,' + PNG.toString('base64');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) { for (let index = 0; index < 200; index++) { if (await predicate()) return; await pause(5); } assert.fail('Fixture did not reach expected state.'); }
function fixture(t, { duration = 92, type = 'video', referenceFrames, sourceAnalysis } = {}) {
  const project = { id: 'current-video', kind: 'video', createdAt: '2026-11-21T00:00:00.000Z' };
  const asset = { id: randomUUID(), type, name: 'PRIVATE/folder/reference.mp4', path: 'PRIVATE-local-file.mp4', duration, size: 1000, mtimeMs: 1, width: 640, height: 360, hasAudio: false };
  let member = true;
  const calls = [], store = { read: async id => id === project.id ? { ...project } : null }, openFilm = { context: async () => ({ assets: member ? [{ ...asset }] : [] }) };
  const videoService = { resolveAsset: async id => { assert.equal(id, asset.id); return { ...asset }; }, referenceFrames: async (id, options) => { calls.push(options); if (referenceFrames) return referenceFrames(id, options); return type === 'image' ? [{ dataUrl: DATA }] : options.timestamps.map(timestamp => ({ dataUrl: DATA, timestamp })); } };
  const service = createAssistantFrameReader({ store, openFilm, videoService, sourceAnalysis });
  t.after(() => service.close());
  return { service, project, asset, calls, store, openFilm, videoService, removeMember: () => { member = false; } };
}

test('92-second references paginate across the whole source with actual image packets and honest coverage', async t => {
  const fx = fixture(t), all = [];
  let offset = 0, pages = 0, planId;
  do {
    const result = await fx.service.read(fx.project.id, fx.asset.id, { offset }); pages++;
    const { data, images } = result;
    assert.equal(images.length, data.frames.length); assert.ok(images.length <= 12);
    assert.deepEqual(data.coverage.requestedRange, { start: 0, end: 92 });
    assert.equal(data.coverage.frameByFrame, false); assert.equal(data.coverage.pageComplete, true); assert.equal(data.coverage.planComplete, false);
    assert.equal(data.pagination.totalFrames, 46); assert.equal(data.asset.name, 'reference.mp4'); assert.match(data.asset.sourceVersion, /^[a-f0-9]{64}$/); assert.match(data.ownerVersion, /^[a-f0-9]{64}$/);
    planId ||= data.pagination.planId; assert.equal(data.pagination.planId, planId);
    assert.equal(JSON.stringify(data).includes('data:image'), false); assert.equal(JSON.stringify(data).includes('PRIVATE'), false);
    for (const [index, frame] of data.frames.entries()) {
      assert.equal(frame.index, offset + index + 1); assert.equal(frame.timestamp, (offset + index) * 2 + 1);
      assert.equal(frame.bytes, PNG.length); assert.equal(frame.sha256, createHash('sha256').update(PNG).digest('hex')); assert.equal(images[index].detail, 'high');
    }
    assert.equal(data.coverage.encodedBytes, images.reduce((total, frame) => total + frame.dataUrl.length, 0)); all.push(...data.frames); offset = data.pagination.nextOffset;
  } while (offset !== null);
  assert.equal(pages, 4); assert.deepEqual(all.map(frame => frame.timestamp), Array.from({ length: 46 }, (_, index) => index * 2 + 1)); assert.equal(fx.calls.length, 4);
  assert.ok(fx.calls.every(call => call.count === undefined && call.timestamps.length <= 12));
});

test('explicit timestamps, interval, range and page use real source positions rather than guessed files', async t => {
  const fx = fixture(t);
  const explicit = await fx.service.read(fx.project.id, fx.asset.id, { timestamps: [91.9, 0, 45], pageSize: 2 });
  assert.deepEqual(fx.calls[0].timestamps, [0, 45]); assert.equal(explicit.data.pagination.nextOffset, 2); assert.equal(explicit.data.pagination.mode, 'timestamps');
  const final = await fx.service.read(fx.project.id, fx.asset.id, { timestamps: [91.9, 0, 45], pageSize: 2, page: 1 });
  assert.deepEqual(final.data.coverage.timestamps, [91.9]); assert.equal(final.data.pagination.hasMore, false);
  assert.equal(explicit.data.pagination.planId, final.data.pagination.planId);
  const otherPlan = await fx.service.read(fx.project.id, fx.asset.id, { timestamps: [0, 30, 91.9], pageSize: 2 }); assert.notEqual(otherPlan.data.pagination.planId, explicit.data.pagination.planId);
  const ranged = await fx.service.read(fx.project.id, fx.asset.id, { range: { start: 40, end: 52 }, intervalSeconds: .5, pageSize: 4, page: 2 });
  assert.deepEqual(ranged.data.coverage.timestamps, [44.25, 44.75, 45.25, 45.75]); assert.equal(ranged.data.pagination.totalFrames, 24);
  for (const options of [{ timestamps: [92] }, { timestamps: [-1] }, { timestamps: [1, 1] }, { timestamps: [1], intervalSeconds: 2 }, { range: { start: 0, end: 93 } }, { pageSize: 13 }, { offset: 46 }, { intervalSeconds: .001 }, { page: 1, offset: 1 }, { mode: 'unknown' }]) {
    await assert.rejects(fx.service.read(fx.project.id, fx.asset.id, options), error => error.code.startsWith('ASSISTANT_FRAMES_'));
  }
  const short = fixture(t, { duration: .001 }); const tiny = await short.service.read(short.project.id, short.asset.id); assert.ok(tiny.data.frames[0].timestamp < .001);
});

test('receipts reuse only trusted decoded pictures and reject wrong project, invented IDs and stale assets', async t => {
  const fx = fixture(t), result = await fx.service.read(fx.project.id, fx.asset.id, { pageSize: 4 });
  result.images[0].dataUrl = 'untrusted-mutated-output';
  const receipt = await fx.service.receipt(result.data.inspectionId, { projectId: fx.project.id, assetId: fx.asset.id, frameIndices: [2, 4] });
  assert.deepEqual(receipt.data.frames.map(frame => frame.index), [2, 4]); assert.equal(receipt.images[0].dataUrl, DATA); assert.equal(receipt.data.coverage.receiptSubset, true); assert.equal(fx.calls.length, 1);
  await assert.rejects(fx.service.receipt(result.data.inspectionId, { projectId: 'other-project' }), { code: 'ASSISTANT_FRAMES_RECEIPT' });
  await assert.rejects(fx.service.receipt(randomUUID(), { projectId: fx.project.id }), { code: 'ASSISTANT_FRAMES_RECEIPT' });
  await assert.rejects(fx.service.receipt(result.data.inspectionId, { projectId: fx.project.id, frameIndices: [500] }), { code: 'ASSISTANT_FRAMES_RECEIPT_FRAMES' });
  fx.asset.mtimeMs++; await assert.rejects(fx.service.receipt(result.data.inspectionId, { projectId: fx.project.id }), { code: 'ASSISTANT_FRAMES_ASSET_CHANGED' });
});

test('receipt count eviction prevents unbounded retained image batches', async t => {
  const fx = fixture(t); let first;
  for (let index = 0; index < 9; index++) { const result = await fx.service.read(fx.project.id, fx.asset.id, { offset: index, pageSize: 1 }); first ||= result.data.inspectionId; }
  await assert.rejects(fx.service.receipt(first, { projectId: fx.project.id }), { code: 'ASSISTANT_FRAMES_RECEIPT' });
});

test('images have no video time options and still return a trusted picture receipt', async t => {
  const fx = fixture(t, { type: 'image' }), result = await fx.service.read(fx.project.id, fx.asset.id);
  assert.equal(result.data.coverage.mode, 'image'); assert.equal(result.data.coverage.planComplete, true); assert.equal(result.data.frames[0].timestamp, undefined); assert.equal(fx.calls[0].count, 1);
  await assert.rejects(fx.service.read(fx.project.id, fx.asset.id, { timestamps: [0] }), { code: 'ASSISTANT_FRAMES_OPTIONS' });
});

test('project ownership, membership and original asset changes invalidate pending picture reads', async t => {
  for (const change of ['owner', 'membership', 'source']) {
    let fx; fx = fixture(t, { referenceFrames: async (_id, options) => { if (change === 'owner') fx.project.createdAt = '2099-01-01T00:00:00.000Z'; else if (change === 'membership') fx.removeMember(); else fx.asset.mtimeMs++; return options.timestamps.map(timestamp => ({ dataUrl: DATA, timestamp })); } });
    await assert.rejects(fx.service.read(fx.project.id, fx.asset.id), { code: change === 'owner' ? 'ASSISTANT_FRAMES_OWNER_CHANGED' : change === 'membership' ? 'ASSISTANT_FRAMES_ASSET_SCOPE' : 'ASSISTANT_FRAMES_ASSET_CHANGED' });
  }
  const fx = fixture(t); fx.removeMember(); await assert.rejects(fx.service.read(fx.project.id, fx.asset.id), { code: 'ASSISTANT_FRAMES_ASSET_SCOPE' }); assert.equal(fx.calls.length, 0);
  await assert.rejects(fx.service.read(fx.project.id, 'C:/private/source.mp4'), { code: 'ASSISTANT_FRAMES_ASSET_ID' });
});

test('missing, mismatched, invalid or oversized pictures never become successful coverage', async t => {
  const cases = [
    { expected: 'INCOMPLETE', make: () => [] },
    { expected: 'IMAGE', make: options => options.timestamps.map(timestamp => ({ timestamp, dataUrl: 'https://untrusted/picture.png' })) },
    { expected: 'TIME', make: options => options.timestamps.map(() => ({ timestamp: 0, dataUrl: DATA })) },
    { expected: 'IMAGE', make: options => options.timestamps.map(timestamp => ({ timestamp, dataUrl: 'data:image/jpeg;base64,' + Buffer.alloc(ASSISTANT_FRAME_LIMITS.maxFrameBytes + 10).toString('base64') })) },
    { expected: 'BYTES', make: options => { const bytes = Buffer.alloc(600000, 1); bytes.set([255, 216], 0); bytes.set([255, 217], bytes.length - 2); return options.timestamps.map(timestamp => ({ timestamp, dataUrl: 'data:image/jpeg;base64,' + bytes.toString('base64') })); } },
  ];
  for (const entry of cases) {
    const fx = fixture(t, { referenceFrames: async (_id, options) => entry.make(options) });
    await assert.rejects(fx.service.read(fx.project.id, fx.asset.id), { code: 'ASSISTANT_FRAMES_' + entry.expected });
  }
});

test('abort, service close and total timeout cancel the actual decoder request', async t => {
  for (const mode of ['external', 'close', 'timeout']) {
    let stopped = false;
    const fx = fixture(t, { referenceFrames: async (_id, options) => new Promise((_resolve, reject) => { const stop = () => { stopped = true; reject(new Error('fixture decode cancelled')); }; options.signal.addEventListener('abort', stop, { once: true }); if (options.signal.aborted) stop(); }) });
    const controller = new AbortController(), pending = fx.service.read(fx.project.id, fx.asset.id, { signal: controller.signal, timeoutMs: mode === 'timeout' ? 100 : 90000 });
    await until(() => fx.calls.length === 1);
    if (mode === 'external') controller.abort(); else if (mode === 'close') void fx.service.close();
    await assert.rejects(pending, { code: mode === 'timeout' ? 'ASSISTANT_FRAMES_TIMEOUT' : 'ASSISTANT_FRAMES_CANCELLED' }); assert.equal(stopped, true);
  }
});

test('shots use bounded local detection windows and continue across the full source automatically', async t => {
  const detections = [], sourceAnalysis = { analyze: async (_projectId, input, options) => {
    detections.push({ input, options }); assert.equal(input.options.visualSummary, false); assert.equal(input.options.transcribe, false);
    const source = input.sources[0], total = Math.ceil((source.end - source.start) / 4);
    return { items: [{ assetId: source.assetId, shots: Array.from({ length: total }, (_, index) => ({ id: 's' + index, start: source.start + index * 4, end: Math.min(source.end, source.start + (index + 1) * 4), boundary: 'interval' })), coverage: { sceneDetection: 'ffmpeg-scene-estimate' }, warnings: [] }] };
  } };
  const fx = fixture(t, { duration: 610, sourceAnalysis });
  const first = await fx.service.read(fx.project.id, fx.asset.id, { mode: 'shots', pageSize: 12 }); assert.deepEqual(first.data.coverage.shotWindow, { index: 0, start: 0, end: 300, nextWindowIndex: 1 }); assert.equal(first.data.pagination.totalFrames, 75);
  const tail = await fx.service.read(fx.project.id, fx.asset.id, { mode: 'shots', offset: 72 }); assert.equal(tail.data.frames.length, 3); assert.equal(tail.data.pagination.nextOffset, null); assert.equal(tail.data.pagination.nextWindowIndex, 1); assert.equal(tail.data.pagination.nextWindowOffset, 0); assert.equal(tail.data.pagination.hasMore, true);
  const final = await fx.service.read(fx.project.id, fx.asset.id, { mode: 'shots', windowIndex: 2 }); assert.deepEqual(final.data.coverage.timestamps, [602, 606, 609]); assert.equal(final.data.pagination.hasMore, false); assert.equal(final.data.coverage.planComplete, false); assert.equal(final.data.coverage.shotWindowPageIsLast, true);
  assert.ok(detections.every(({ input }) => input.sources[0].end - input.sources[0].start <= 300));
});

for (const apiStyle of ['chat', 'responses']) test(`per-page visual descriptions use real image blocks in ${apiStyle} and reject invented frame evidence`, async t => {
  const fx = fixture(t); let invalid = false, requests = 0;
  const server = http.createServer(async (req, res) => {
    const body = JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString()), content = apiStyle === 'chat' ? body.messages[1].content : body.input[0].content;
    const payload = JSON.parse(content[0].text), pictures = content.filter(part => ['image_url', 'input_image'].includes(part.type));
    assert.equal(pictures.length, 4); assert.equal(payload.coverage.frameByFrame, false); assert.deepEqual(payload.frames.map(frame => frame.index), [5, 6, 7, 8]);
    assert.equal(JSON.stringify(body).includes('fixture-frame-secret'), false); requests++;
    const answer = { summary: '这批可見原素材画面', frames: payload.frames.map(frame => ({ index: invalid ? 99 : frame.index, visibleText: '实际文字', description: '可见构图', animationNotes: '按可见层次制作' })), changes: [{ fromIndex: 5, toIndex: 8, description: '两帧间位置改变，中间运动是推断。' }], uncertainties: [] };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(apiStyle === 'chat' ? { choices: [{ message: { content: JSON.stringify(answer) }, finish_reason: 'stop' }] } : { output: [{ content: [{ type: 'output_text', text: JSON.stringify(answer) }] }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const settings = { apiStyle, baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', apiKey: 'fixture-frame-secret', model: 'controlled-frame-vision', timeoutSeconds: 10 };
  const result = await fx.service.analyze(fx.project.id, fx.asset.id, { settings, offset: 4, pageSize: 4, instruction: '继续制作 fixture-frame-secret' }); assert.equal(result.data.analysis.status, 'complete'); assert.equal(result.data.analysis.frames.length, 4); assert.equal(result.data.analysis.changes.length, 1);
  invalid = true; await assert.rejects(fx.service.analyze(fx.project.id, fx.asset.id, { settings, offset: 4, pageSize: 4 }), { code: 'ASSISTANT_FRAMES_MODEL_FORMAT' }); assert.equal(requests, 2);
});

test('real FFmpeg decodes more than three explicit frames, validates legacy limits and detects actual shots', { timeout: 120000 }, async t => {
  const executable = name => process.env['GUANGXUAN_' + name.toUpperCase()] || (process.env.GUANGXUAN_BIN_DIR ? path.join(process.env.GUANGXUAN_BIN_DIR, name + (process.platform === 'win32' ? '.exe' : '')) : name);
  const ffmpeg = executable('ffmpeg'), ffprobe = executable('ffprobe');
  try { await execute(ffmpeg, ['-version'], { windowsHide: true, timeout: 10000 }); await execute(ffprobe, ['-version'], { windowsHide: true, timeout: 10000 }); }
  catch { t.skip('Actual FFmpeg and FFprobe are required.'); return; }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gx-frame-reader-')), dataDir = path.join(directory, 'data'), source = path.join(directory, 'real-three-scenes.mp4');
  let videoService, sourceAnalysis, reader;
  t.after(async () => { await reader?.close(); await sourceAnalysis?.close(); await videoService?.close(); assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('gx-frame-reader-')); await rm(directory, { recursive: true, force: true }); });
  await execute(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=10:d=2', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=10:d=2', '-f', 'lavfi', '-i', 'color=c=lime:s=160x90:r=10:d=2', '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]', '-map', '[v]', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', source], { windowsHide: true, timeout: 60000 });
  videoService = await createVideoService({ dataDir, ffmpegPath: ffmpeg, ffprobePath: ffprobe });
  const asset = await videoService.importLocalFile(source), project = { id: 'real-frame-project', kind: 'video', createdAt: '2026-11-21T00:00:00.000Z' };
  const store = { read: async id => id === project.id ? { ...project } : null }, openFilm = { context: async () => ({ assets: [asset], revision: 'fixture' }) };
  sourceAnalysis = await createSourceAnalysisService({ dataDir, store, openFilm, videoService, ffmpegPath: ffmpeg, ffprobePath: ffprobe });
  reader = createAssistantFrameReader({ store, openFilm, videoService, sourceAnalysis });
  const result = await reader.read(project.id, asset.id, { intervalSeconds: .5 }); assert.equal(result.images.length, 12); assert.equal(result.data.pagination.hasMore, false); assert.equal(result.data.coverage.planComplete, true);
  for (const [index, expected] of [[0, 0], [4, 2], [8, 1]]) {
    const filename = path.join(directory, 'frame-' + index + '.jpg'); await writeFile(filename, Buffer.from(result.images[index].dataUrl.split(',')[1], 'base64'));
    const { stdout } = await execute(ffmpeg, ['-v', 'error', '-i', filename, '-vf', 'scale=1:1', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer', windowsHide: true, timeout: 10000 });
    assert.ok(stdout[expected] > stdout[(expected + 1) % 3] + 80 && stdout[expected] > stdout[(expected + 2) % 3] + 80, 'Decoded frame must show its actual red, blue or green scene.');
  }
  const cached = await reader.receipt(result.data.inspectionId, { projectId: project.id, frameIndices: [1, 5, 9] }); assert.equal(cached.images.length, 3);
  await assert.rejects(videoService.referenceFrames(asset.id, { count: 4 }), { code: 'INVALID_REFERENCE_FRAME_COUNT' });
  assert.equal((await videoService.referenceFrames(asset.id, { count: 3 })).length, 3);
  const nearEnd = await reader.read(project.id, asset.id, { timestamps: [5.999] }); assert.equal(nearEnd.data.frames[0].requestedTimestamp, 5.999); assert.equal(nearEnd.data.frames[0].seekAdjusted, true); assert.ok(nearEnd.data.frames[0].timestamp < 5.999); assert.ok(nearEnd.data.warnings.length);
  await assert.rejects(videoService.referenceFrames(asset.id, { timestamps: [0, 6] }), { code: 'INVALID_REFERENCE_TIMESTAMPS' });
  await assert.rejects(videoService.referenceFrames(asset.id, { timestamps: Array.from({ length: 13 }, (_, index) => index / 10) }), { code: 'INVALID_REFERENCE_TIMESTAMPS' });
  const controller = new AbortController(); controller.abort(); await assert.rejects(videoService.referenceFrames(asset.id, { timestamps: [0], signal: controller.signal }), { code: 'MEDIA_CANCELLED' });
  const active = new AbortController(), pending = videoService.referenceFrames(asset.id, { timestamps: Array.from({ length: 12 }, (_, index) => index * .5 + .25), signal: active.signal });
  setTimeout(() => active.abort(), 10); await assert.rejects(pending, { code: 'MEDIA_CANCELLED' });
  const shots = await reader.read(project.id, asset.id, { mode: 'shots' }); assert.ok(shots.data.shots.some(shot => shot.boundary === 'detected' && Math.abs(shot.start - 2) < .15)); assert.ok(shots.data.shots.some(shot => shot.boundary === 'detected' && Math.abs(shot.start - 4) < .15)); assert.equal(shots.images.length, shots.data.shots.length);
});
