import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRemotionIntegration } from '../lib/remotion-integration.mjs';
import { createRemotionProjectsService } from '../lib/remotion-projects.mjs';
import { runAi } from '../lib/ai.mjs';
import { buildRemotionReferenceReviewPrompt, normalizeRemotionReferenceReviewResult, normalizeRemotionReferenceEvidence } from '../lib/remotion-reference-review.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const DATA = `data:image/png;base64,${PNG.toString('base64')}`, SHA = createHash('sha256').update(PNG).digest('hex'), SOURCE = '1'.repeat(64), KEY = 'sk-reference-fixture-private-123456';
const sourceCode = duration => `import React from 'react';import{AbsoluteFill,Composition,registerRoot,useCurrentFrame}from'remotion';const Film=()=>{const f=useCurrentFrame();return <AbsoluteFill style={{background:'#14333b'}}><svg width={320} height={180}><circle cx={40+f/3} cy={90} r={24} fill='#b9e8cf'/></svg></AbsoluteFill>};registerRoot(()=> <Composition id='Main' component={Film} width={320} height={180} fps={30} durationInFrames={${Math.round(duration*30)}}/>);`;
const answer = duration => ({ title: '参考重建', entryPoint: 'src/index.tsx', compositionId: 'Main', inputProps: {}, assetIds: [], files: [{ path: 'src/index.tsx', content: sourceCode(duration) }], notes: [] });
function snapshot(times = [0, 10, 30, 60, 80, 91.9], duration = 92) {
  const selectedImageFrames = times.map((timestamp, index) => ({ inspectionId: 'inspection-a', assetId: 'asset-reference', sourceVersion: SOURCE, frameIndex: index + 1, timestamp, sha256: SHA }));
  return { context: { version: 1, kind: 'assistant-frame-notes', sourceAssetId: 'asset-reference', sourceRange: { start: 0, end: duration }, expectedDuration: duration, assets: [{ id: 'asset-reference', name: '实际参考.mp4', type: 'video', duration, sourceVersion: SOURCE, ownerVersion: 'owner-stamp' }], inspections: [{ inspectionId: 'inspection-a', assetId: 'asset-reference', sourceVersion: SOURCE, ownerVersion: 'owner-stamp', frames: selectedImageFrames.map(({ frameIndex, ...item }) => ({ ...item, index: frameIndex })), coverage: { requestedRange: { start: 0, end: duration }, pageComplete: true, planComplete: false }, pagination: { planId: 'plan-a', offset: 0, totalFrames: 46, nextOffset: times.length, hasMore: true } }], notes: selectedImageFrames.map(item => ({ ...item, description: `登记观察 ${item.timestamp}秒`, visibleText: `样例 ${KEY} C:/private/path.png` })), selectedImageFrames, coverage: { sampledFrameCount: times.length, noteCount: times.length, frameByFrame: false } }, images: times.map(() => ({ dataUrl: DATA, label: '原视频实际采样', detail: 'high' })) };
}

async function fixture(t, changes = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'gx-reference-compare-'));
  const owner = { id: 'owner-reference', kind: 'video', createdAt: 'owner-stamp', title: '参考重建测试', video: {} };
  const source = { id: 'source-animation', revision: 1, ownerCreatedAt: owner.createdAt, compositionId: 'Main', inputProps: {}, files: [{ path: 'src/index.tsx', content: sourceCode(92) }] };
  const state = { duration: changes.duration ?? 92, calls: [], writes: [], revision: 1, checks: 0, cancelled: 0, job: null };
  const filename = path.join(directory, 'owned-frame.png'); await writeFile(filename, PNG);
  const projects = {
    read: async () => ({ ...source, revision: state.revision }),
    create: async (_ownerId, input) => { state.writes.push(input); return { ...input, id: source.id, revision: 1 }; },
    update: async (_ownerId, _id, input) => { state.writes.push(input); return { ...input, id: source.id, revision: state.revision + 1 }; },
    inspect: async () => ({ compositions: [{ id: 'Main', fps: 30, durationInFrames: Math.round(state.duration * 30), width: 320, height: 180 }] }),
    render: async (_ownerId, id, options) => { state.calls.push(['render', options]); state.job = { id: 'preview-reference', projectId: owner.id, remotionId: id, revision: state.revision, ownerCreatedAt: owner.createdAt, status: 'complete', result: { frames: options.frames.map((frame, index) => ({ frame, file: `frame-${String(index).padStart(2, '0')}.png` })) } }; await changes.renderStarted?.(state); return { jobId: state.job.id }; },
    getJob: async () => structuredClone(state.job),
    cancelJob: async () => { state.cancelled++; return state.job; },
    file: async (_ownerId, jobId, file) => { assert.equal(jobId, state.job.id); assert.ok(state.job.result.frames.some(frame => frame.file === file)); state.calls.push(['file', file]); return { path: filename }; },
  };
  const ai = changes.ai || (async (task, payload, settings, options) => { state.calls.push(['ai', task, payload, options]); return { data: task === 'remotion-project' ? answer(state.duration) : { verdict: 'pass', summary: '受控模型已对照本批图片。', issues: [] } }; });
  const integration = createRemotionIntegration({ projects, store: { read: async () => structuredClone(owner) }, openFilm: { context: async () => ({ assets: changes.assets || [{ id: 'asset-reference', name: '参考源视频', type: 'video', duration: 92 }], aspect: '16:9' }) }, videoService: { resolveAsset: changes.resolveAsset || (async () => ({ path: 'C:/fixture-only/reference.mp4' })) }, ai });
  t.after(async () => { await integration.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, integration, state, source, owner, filename, projects, settings: { baseUrl: 'https://unused-controlled.example/v1', apiKey: KEY, model: 'injected-no-network' }, assertReferenceEvidence: async () => { state.checks++; await changes.assertReferenceEvidence?.(state); } };
}

test('trusted generation supplies actual selected images, prior bound notes and the full target duration', async t => {
  const fx = await fixture(t), evidence = snapshot();
  await fx.integration.generate(fx.owner.id, { instruction: '按视频逐镜对照重建' }, { settings: fx.settings, referenceEvidence: evidence, assertReferenceEvidence: fx.assertReferenceEvidence });
  const call = fx.state.calls.find(item => item[0] === 'ai');
  assert.equal(call[1], 'remotion-project'); assert.equal(call[3].images.length, 6); assert.ok(call[3].images.every(item => item.dataUrl === DATA && item.detail === 'high'));
  assert.match(call[2].instruction, /目标时长92秒/); assert.match(call[2].instruction, /不得压缩/);
  assert.equal(call[2].referenceFrameAnalysis.selectedImageFrames.length, 6); assert.equal(call[2].referenceFrameAnalysis.expectedDuration, 92); assert.equal(call[2].referenceFrameAnalysis.coverage.frameByFrame, false);
  assert.doesNotMatch(JSON.stringify(call[2].referenceFrameAnalysis), /base64|sk-reference-fixture|C:\/private/);
  assert.ok(fx.state.checks >= 3); assert.equal(fx.state.writes.length, 1);
});

test('trusted full-reference generation reaches real Chat and Responses provider bodies with the frame observations intact', async t => {
  const requests = [], server = createServer(async (req, res) => {
    const body = JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString());
    const blocks = req.url.endsWith('/responses') ? body.input[0].content : body.messages[1].content;
    const payload = JSON.parse(blocks[0].text), images = blocks.filter(item => ['input_image', 'image_url'].includes(item.type));
    requests.push({ payload, imageCount: images.length });
    const content = JSON.stringify(answer(92));
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(req.url.endsWith('/responses') ? { output: [{ content: [{ type: 'output_text', text: content }] }] } : { choices: [{ message: { content } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const fx = await fixture(t, { ai: runAi });
  for (const apiStyle of ['chat', 'responses']) await fx.integration.generate(fx.owner.id, { instruction: '逐镜重建全片' }, { referenceEvidence: snapshot(), assertReferenceEvidence: fx.assertReferenceEvidence, settings: { ...fx.settings, apiStyle, baseUrl: `http://127.0.0.1:${server.address().port}/v1` } });
  assert.equal(requests.length, 2);
  for (const request of requests) { assert.equal(request.imageCount, 6); assert.equal(request.payload.referenceFrameAnalysis.expectedDuration, 92); assert.equal(request.payload.referenceFrameAnalysis.selectedImageFrames.length, 6); assert.match(request.payload.instruction, /目标时长92秒/); assert.doesNotMatch(JSON.stringify(request.payload), /base64|sk-reference-fixture|C:\/private/); }
});

test('real static PNG references without timestamps or with zero reach controlled generation without inferred duration', async t => {
  const requests = [], server = createServer(async (req, res) => {
    const body = JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString()), responses = req.url.endsWith('/responses');
    const blocks = responses ? body.input[0].content : body.messages[1].content, payload = JSON.parse(blocks[0].text), pictures = blocks.filter(item => item.type === (responses ? 'input_image' : 'image_url'));
    requests.push({ payload, pictures });
    const content = JSON.stringify(answer(3));
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(responses ? { output: [{ content: [{ type: 'output_text', text: content }] }] } : { choices: [{ message: { content } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  let fx;
  fx = await fixture(t, { ai: runAi, assets: [{ id: 'static-reference', name: '真实静态.png', type: 'image', width: 1, height: 1 }], resolveAsset: async id => { assert.equal(id, 'static-reference'); return { path: fx.filename }; } });
  const bytes = await readFile(fx.filename), dataUrl = `data:image/png;base64,${bytes.toString('base64')}`, sha256 = createHash('sha256').update(bytes).digest('hex');
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  for (const timestamp of [undefined, 0]) {
    const frame = { inspectionId: 'static-inspection', assetId: 'static-reference', sourceVersion: sha256, frameIndex: 1, sha256, timestampKind: 'static-image', ...(timestamp === undefined ? {} : { timestamp }) };
    const evidence = { context: { version: 1, kind: 'assistant-frame-notes', assets: [{ id: 'static-reference', name: '真实静态.png', type: 'image', width: 1, height: 1, sourceVersion: sha256, ownerVersion: fx.owner.createdAt }], inspections: [{ inspectionId: frame.inspectionId, assetId: frame.assetId, sourceVersion: sha256, ownerVersion: fx.owner.createdAt, frames: [{ ...frame, index: 1 }], coverage: { pageComplete: true, planComplete: true, frameByFrame: false }, pagination: { offset: 0, totalFrames: 1, hasMore: false } }], notes: [{ ...frame, description: '静态PNG参考，未提供音频或时长。' }], selectedImageFrames: [frame], coverage: { sampledFrameCount: 1, noteCount: 1, frameByFrame: false } }, images: [{ dataUrl, label: '已读取静态PNG', sha256, ...(timestamp === undefined ? {} : { timestamp }), detail: 'high' }] };
    const normalized = normalizeRemotionReferenceEvidence(evidence, [{ id: frame.assetId }]);
    assert.equal(Object.hasOwn(normalized.context.selectedImageFrames[0], 'timestamp'), timestamp !== undefined);
    const alias = structuredClone(evidence); alias.images[0].timestamp = timestamp === undefined ? 0 : undefined;
    assert.equal(normalizeRemotionReferenceEvidence(alias, [{ id: frame.assetId }]).context.selectedImageFrames[0].timestamp, timestamp);
    for (const apiStyle of ['chat', 'responses']) await fx.integration.generate(fx.owner.id, { instruction: '借鉴这张静态PNG构图创作动画' }, { referenceEvidence: evidence, assertReferenceEvidence: fx.assertReferenceEvidence, settings: { ...fx.settings, apiStyle, baseUrl: `http://127.0.0.1:${server.address().port}/v1` } });
  }
  assert.equal(requests.length, 4); assert.equal(fx.state.writes.length, 4);
  for (let index = 0; index < requests.length; index++) {
    const request = requests[index], frame = request.payload.referenceFrameAnalysis.selectedImageFrames[0];
    assert.equal(request.pictures.length, 1); assert.equal(request.pictures[0].image_url.url || request.pictures[0].image_url, dataUrl);
    assert.equal(Object.hasOwn(frame, 'timestamp'), index >= 2); if (index >= 2) assert.equal(frame.timestamp, 0);
    assert.equal(frame.timestampKind, 'static-image'); assert.equal(request.payload.referenceFrameAnalysis.assets[0].type, 'image');
    assert.equal(request.payload.referenceFrameAnalysis.assets[0].duration, undefined); assert.equal(request.payload.referenceFrameAnalysis.expectedDuration, undefined); assert.equal(request.payload.referenceFrameAnalysis.sourceRange, undefined);
    assert.doesNotMatch(request.payload.instruction, /本轮已绑定实际参考目标/); assert.doesNotMatch(JSON.stringify(request.payload), /base64|sk-reference-fixture|fixture-only/);
  }
  const invalidVideo = snapshot([0]); delete invalidVideo.context.selectedImageFrames[0].timestamp;
  assert.throws(() => normalizeRemotionReferenceEvidence(invalidVideo, [{ id: 'asset-reference' }]), { code: 'REMOTION_REFERENCE_EVIDENCE_INVALID' });
});

test('HTTP-style args cannot inject trusted reference packets and foreign or stale references stop source writes', async t => {
  const fx = await fixture(t), evidence = snapshot();
  await fx.integration.generate(fx.owner.id, { instruction: '普通原创', referenceEvidence: evidence, referenceFrameAnalysis: evidence.context }, { settings: fx.settings });
  assert.equal(fx.state.calls.find(item => item[0] === 'ai')[2].referenceFrameAnalysis, undefined); assert.deepEqual(fx.state.calls.find(item => item[0] === 'ai')[3].images, []);
  const foreign = snapshot(); foreign.context.assets[0].id = 'foreign'; foreign.context.selectedImageFrames.forEach(item => { item.assetId = 'foreign'; });
  await assert.rejects(fx.integration.generate(fx.owner.id, { instruction: '使用不允许参考' }, { referenceEvidence: foreign }), { code: 'REMOTION_ASSET_SCOPE' });
  let checks = 0;
  await assert.rejects(fx.integration.generate(fx.owner.id, { instruction: '源变化不得写入' }, { referenceEvidence: evidence, assertReferenceEvidence: async () => { if (++checks === 3) throw Object.assign(new Error('source changed'), { status: 409, code: 'ASSISTANT_FRAME_SOURCE_CHANGED' }); } }), { code: 'ASSISTANT_FRAME_SOURCE_CHANGED' });
  assert.equal(fx.state.writes.length, 1);
  const bad = snapshot(); bad.images[0].dataUrl = 'file:///private.png'; assert.throws(() => normalizeRemotionReferenceEvidence(bad, [{ id: 'asset-reference' }]), { code: 'ASSISTANT_TOOL_IMAGE_INVALID' });
});

test('reference comparison renders time-aligned actual pairs, never rescales a short output, and exposes missing coverage', async t => {
  const fx = await fixture(t, { duration: 22.5 }), result = await fx.integration.compareReference(fx.owner.id, fx.source.id, { expectedRevision: 1, settings: fx.settings, referenceEvidence: snapshot(), assertReferenceEvidence: fx.assertReferenceEvidence });
  assert.equal(result.status, 'reviewed'); assert.equal(result.verdict, 'revise'); assert.equal(result.coverage.durationMismatch, true); assert.equal(result.coverage.omittedFrames.length, 4);
  assert.deepEqual(fx.state.calls.find(item => item[0] === 'render')[1].frames, [0, 300]);
  assert.deepEqual(result.pairs.map(item => [item.source.time, item.output.time]), [[0, 0], [10, 10]]);
  const ai = fx.state.calls.find(item => item[0] === 'ai'); assert.equal(ai[1], 'remotion-reference-review'); assert.equal(ai[3].images.length, 4);
  assert.ok(result.frames.every(item => item.url.includes('/files/frame-'))); assert.doesNotMatch(JSON.stringify(result), /base64|fixture-only|C:\/private/); assert.match(result.summary, /22.500秒.*92.000秒/); assert.match(result.limitations, /未逐帧/);
});

test('source range start maps to output zero and batches are capped to six actual pairs', async t => {
  const fx = await fixture(t, { duration: 10 }), evidence = snapshot([40, 41, 42, 43, 44, 45, 46, 47], 92);
  evidence.context.sourceRange = { start: 40, end: 50 }; evidence.context.expectedDuration = 10;
  const result = await fx.integration.compareReference(fx.owner.id, fx.source.id, { expectedRevision: 1, referenceEvidence: evidence });
  assert.equal(result.pairs.length, 6); assert.equal(fx.state.calls.find(item => item[0] === 'ai')[3].images.length, 12); assert.deepEqual(result.pairs.map(item => item.output.time), [0, 1, 2, 3, 4, 5]); assert.equal(result.coverage.hasMore, true); assert.equal(result.nextOffset, 6);
});

test('review hooks reject invented pairs and inability to see pictures, while structural duration mismatch prevents pass', () => {
  const input = { revision: 1, composition: { id: 'Main', fps: 30, durationInFrames: 60, width: 320, height: 180 }, pairs: [{ pairId: 'P1', source: { assetId: 'asset-reference', frameIndex: 1, time: 0, sha256: SHA }, output: { frame: 0, sha256: SHA } }], coverage: { sourceRange: { start: 0, end: 92 }, expectedDuration: 92, durationMismatch: true }, referenceFrameAnalysis: snapshot().context };
  const prompt = buildRemotionReferenceReviewPrompt(input); assert.match(prompt.system, /禁止偷偷按比例压缩/); assert.doesNotMatch(prompt.user, /base64|C:\/private/);
  assert.equal(normalizeRemotionReferenceReviewResult({ verdict: 'pass', summary: '仅当前图片对相似', issues: [] }, prompt.payload).verdict, 'revise');
  assert.throws(() => normalizeRemotionReferenceReviewResult({ verdict: 'revise', summary: '问题', issues: [{ severity: 'blocking', pairId: 'P999', category: 'content', detail: '假证据', fix: '改' }] }, prompt.payload), { code: 'REMOTION_REFERENCE_REVIEW_FORMAT' });
  assert.throws(() => normalizeRemotionReferenceReviewResult({ verdict: 'pass', summary: '无法查看这些图片', issues: [] }, prompt.payload), { code: 'REMOTION_REFERENCE_REVIEW_VISION_UNAVAILABLE' });
});

test('reference or animation changes and Stop during preview never return a stale visual pass', async t => {
  const controller = new AbortController(), cancelled = await fixture(t, { renderStarted: async () => controller.abort() });
  await assert.rejects(cancelled.integration.compareReference(cancelled.owner.id, cancelled.source.id, { expectedRevision: 1, signal: controller.signal, referenceEvidence: snapshot() }), { name: 'AbortError' }); assert.equal(cancelled.state.cancelled, 1); assert.equal(cancelled.state.calls.some(item => item[0] === 'ai'), false);
  const changed = await fixture(t, { renderStarted: async state => { state.revision = 2; } });
  await assert.rejects(changed.integration.compareReference(changed.owner.id, changed.source.id, { expectedRevision: 1, referenceEvidence: snapshot() }), { code: 'REMOTION_REVISION_CONFLICT' });
  const stale = await fixture(t, { assertReferenceEvidence: async state => { if (state.checks === 4) throw Object.assign(new Error('source changed'), { status: 409, code: 'ASSISTANT_FRAME_SOURCE_CHANGED' }); } });
  await assert.rejects(stale.integration.compareReference(stale.owner.id, stale.source.id, { expectedRevision: 1, referenceEvidence: snapshot(), assertReferenceEvidence: stale.assertReferenceEvidence }), { code: 'ASSISTANT_FRAME_SOURCE_CHANGED' });
});

test('invalid owned PNG files and rejected vision cannot become a successful reference review', async t => {
  const fx = await fixture(t, { ai: async () => { throw Object.assign(new Error('controlled unsupported vision'), { code: 'REFERENCE_VISION_REJECTED' }); } });
  const result = await fx.integration.compareReference(fx.owner.id, fx.source.id, { expectedRevision: 1, referenceEvidence: snapshot() }); assert.equal(result.status, 'unavailable'); assert.equal(result.verdict, 'unknown');
  await writeFile(fx.filename, 'not an image');
  await assert.rejects(fx.integration.compareReference(fx.owner.id, fx.source.id, { expectedRevision: 1, referenceEvidence: snapshot() }), { code: 'ASSISTANT_TOOL_IMAGE_INVALID' });
});

test('real small Remotion compilation and PNG pairs reach a controlled provider without charging a model', { timeout: 180000, skip: process.env.GUANGXUAN_TEST_REFERENCE_REVIEW !== '1' }, async t => {
  const parent = path.resolve(process.env.GUANGXUAN_TEST_DIR || tmpdir()); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'gx-real-reference-review-')), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), requests = [];
  const provider = createServer(async (req, res) => {
    const body = JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString()), content = body.messages[1].content;
    const payload = JSON.parse(content[0].text), images = content.filter(item => item.type === 'image_url');
    requests.push({ payload, imageCount: images.length });
    assert.equal(images.length, payload.pairs.length * 2); assert.ok(payload.pairs.every(item => item.output.time === item.source.time));
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ verdict: 'pass', summary: '受控本机接口已收到真实配对图；不是外部模型质量判定。', issues: [] }) } }] }));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const projects = await createRemotionProjectsService({ dataDir: directory, root });
  t.after(async () => { await projects.close(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); if (process.env.GUANGXUAN_KEEP_REFERENCE_REVIEW !== '1') await rm(directory, { recursive: true, force: true }); });
  const owner = { id: 'real-reference-owner', kind: 'video', createdAt: 'real-owner', video: {} }, created = await projects.create(owner.id, { ...answer(2), ownerCreatedAt: owner.createdAt });
  const integration = createRemotionIntegration({ projects, store: { read: async () => owner }, openFilm: { context: async () => ({ assets: [{ id: 'asset-reference', type: 'video', duration: 2 }], aspect: '16:9' }) }, videoService: { resolveAsset: async () => ({ path: 'C:/fixture-only/source.mp4' }) }, ai: runAi });
  const result = await integration.compareReference(owner.id, created.id, { expectedRevision: 1, referenceEvidence: snapshot([0, .5, 1, 1.5], 2), settings: { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, model: 'controlled-local-vision', apiKey: KEY } });
  assert.equal(result.status, 'reviewed', JSON.stringify(result)); assert.equal(result.pairs.length, 4); assert.equal(result.coverage.durationMismatch, false); assert.equal(requests.length, 1);
  for (const frame of result.frames) { const found = await projects.file(owner.id, result.previewJobId, frame.file), png = await readFile(found.path); assert.equal(png.readUInt32BE(16), 320); assert.equal(png.readUInt32BE(20), 180); }
  await writeFile(path.join(directory, 'reference-review-verification.json'), JSON.stringify({ status: 'passed', actualRemotionCompiler: true, actualRenderedPNG: true, controlledHttpProvider: true, externalPaidModelUsed: false, requested4417: false, pairCount: result.pairs.length, imageCount: requests[0].imageCount, result }, null, 2));
});
