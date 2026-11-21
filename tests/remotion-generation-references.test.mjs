import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createReferenceService } from '../lib/references.mjs';
import { createRemotionIntegration } from '../lib/remotion-integration.mjs';
import { buildPrompt } from '../lib/prompts.mjs';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const selectedId = 'selected-film-0001', foreignId = 'unselected-film-0002';
const sourceAnswer = () => ({ title: '按当前材料与参考创作', entryPoint: 'src/index.tsx', compositionId: 'Original', inputProps: {}, assetIds: [selectedId], files: [{ path: 'src/index.tsx', content: "import React from 'react';import{Composition,registerRoot}from'remotion';const Film=()=> <div/>;registerRoot(()=> <Composition id='Original' component={Film} durationInFrames={180} fps={30} width={1280} height={720}/>);" }] });
const evidence = assetId => ({ assetId, path: 'C:/PRIVATE/never-send.mp4', range: { start: 2, end: 4 }, summary: { kind: 'visual-sampled', text: assetId === selectedId ? '已有抽样画面可见蓝色演示器材。' : '未选素材的私密语义不能发送' }, shots: [{ id: 's000', start: 2, end: 4, description: '已有蓝色器材画面', evidence: ['f000.jpg'] }], coverage: { sampledFrameCount: 1, note: '只看过所列离散关键帧' }, transcript: { status: 'partial', timing: 'chunk', timingNote: '分块范围不是逐字时间', segments: [{ start: 2, end: 4, text: '已有转写文字', timing: 'chunk' }] } });

test('real free-animation provider requests retain advisory reference positions and existing selected analysis, with no new ASR', { timeout: 60000 }, async t => {
  const parent = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'gx-remotion-input-reference-'));
  const owner = { id: 'reference-owner', kind: 'video', createdAt: '2026-11-20T00:00:00.000Z', title: '真实受控参考链路', video: { script: '只使用当前材料', editScope: { assetIds: [selectedId], placement: { mode: 'range', start: 40, end: 46 } } } };
  const store = { read: async id => id === owner.id ? structuredClone(owner) : null };
  const media = new Map([
    [selectedId, { id: selectedId, type: 'video', name: '选中工程素材.mp4', duration: 30, width: 1280, height: 720, size: 100, path: 'C:/fixture-only/selected.mp4' }],
    [foreignId, { id: foreignId, type: 'video', name: '未选工程素材.mp4', duration: 30, size: 100, path: 'C:/fixture-only/foreign.mp4' }],
    ['reference-video-001', { id: 'reference-video-001', type: 'video', name: '用户参考视频.mp4', duration: 20, width: 640, height: 360, size: 100 }],
    ['reference-image-002', { id: 'reference-image-002', type: 'image', name: '另一区间参考.png', width: 640, height: 360, size: 100 }],
  ]);
  const grabs = [], cachedReads = [], requests = [], writes = [];
  let newAnalysisCalls = 0, onRequest = null, rejectImages = false;
  const videoService = { resolveAsset: async id => { assert.ok(media.has(id)); return structuredClone(media.get(id)); }, referenceFrames: async (id, options) => { grabs.push({ id, count: options.count, range: options.range }); return Array.from({ length: options.count }, (_, index) => ({ dataUrl: PNG, ...(id === 'reference-video-001' ? { timestamp: options.range.start + (options.range.end - options.range.start) * (index + 1) / (options.count + 1) } : {}) })); } };
  const references = await createReferenceService({ dataDir: directory, store, videoService });
  const provider = http.createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/v1/chat/completions'); const body = JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString());
      const content = body.messages.find(message => message.role === 'user').content, payload = JSON.parse(typeof content === 'string' ? content : content[0].text), pictures = Array.isArray(content) ? content.filter(item => item.type === 'image_url') : [];
      requests.push({ payload, pictures: pictures.map(item => item.image_url.url), system: body.messages[0].content });
      if (onRequest) { const call = onRequest; onRequest = null; await call(); }
      if (rejectImages) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'controlled unsupported vision fixture' })); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(sourceAnswer()) } }] }));
    } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await references.close(); await new Promise(resolve => { provider.close(resolve); provider.closeAllConnections(); }); assert.equal(path.dirname(directory), parent); await rm(directory, { recursive: true, force: true }); });
  await references.add(owner.id, { type: 'video', assetId: 'reference-video-001', focus: '只借鉴构图与剪辑节奏，不抄内容', aspects: ['composition', 'editing'], sourceUrl: 'https://example.test/style?DO_NOT_SEND_THIS_QUERY=1', sourceRange: { start: 6, end: 8 }, targetRange: { start: 40, end: 46 } });
  await references.add(owner.id, { type: 'image', assetId: 'reference-image-002', focus: '仅在后续80–90秒使用', targetRange: { start: 80, end: 90 }, aspects: ['color'] });
  await references.add(owner.id, { type: 'text', name: '结构意图', text: '先引出问题，再展示关系', aspects: ['structure'], targetRange: { start: 40, end: 46 } });
  const wrappedReferences = { ...references, context: async (...args) => { const result = await references.context(...args); result.images.push({ dataUrl: PNG, label: '不属于任何参考的图像', referenceId: 'foreign-reference' }); return result; } };
  const sourceAnalysis = { context: async (projectId, options) => { cachedReads.push({ projectId, options }); return { sourceAnalysis: { version: 1, items: [evidence(selectedId), evidence(foreignId)], settings: { apiKey: 'SHOULD_NOT_SEND' } } }; }, start: () => { newAnalysisCalls++; throw new Error('No new analysis allowed'); }, analyze: () => { newAnalysisCalls++; throw new Error('No new analysis allowed'); }, transcribe: () => { newAnalysisCalls++; throw new Error('No ASR allowed'); } };
  const integration = createRemotionIntegration({ projects: { create: async (projectId, input) => { writes.push({ projectId, input }); return { ...input, id: 'new-source-' + writes.length, revision: 1 }; } }, store, openFilm: { context: async () => ({ aspect: '16:9', revision: 'native1', assets: [media.get(selectedId), media.get(foreignId)] }) }, videoService, references: wrappedReferences, sourceAnalysis });
  const settings = { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, model: 'controlled-local-source-vision', apiKey: 'fixture-only-not-a-real-key' }, options = { settings, editScope: owner.video.editScope, origin: 'http://127.0.0.1:12345' };
  await integration.generate(owner.id, { instruction: '按当前素材与用户参考创作，不照搬代码演示' }, options);
  const enabled = requests[0]; assert.equal(enabled.pictures.length, 4); assert.ok(enabled.pictures.every(image => image === PNG));
  assert.equal(enabled.payload.visualReferences.includeImages, true); assert.equal(enabled.payload.visualReferences.items.length, 3); assert.equal(enabled.payload.visualReferences.rangeRole, 'advisory');
  const later = enabled.payload.visualReferences.items.find(item => item.type === 'image'); assert.deepEqual(later.targetRange, { start: 80, end: 90 }); assert.equal(later.compositionRange, undefined); assert.equal(later.bindingRole, 'advisory');
  const visual = enabled.payload.visualReferences.items.find(item => item.type === 'video'); assert.deepEqual(visual.sourceRange, { start: 6, end: 8 }); assert.deepEqual(visual.targetRange, { start: 40, end: 46 }); assert.deepEqual(visual.compositionRange, { start: 0, end: 6 }); assert.deepEqual(visual.aspects, ['composition', 'editing']); assert.equal(visual.sourceUrl, 'https://example.test/style');
  assert.ok(visual.frames.every(frame => frame.timestamp >= 6 && frame.timestamp <= 8)); assert.ok(Array.isArray(enabled.payload.references));
  assert.deepEqual(enabled.payload.assets.map(asset => asset.assetId), [selectedId]); assert.deepEqual(enabled.payload.sourceAnalysis.items.map(item => item.assetId), [selectedId]); assert.equal(enabled.payload.sourceAnalysis.items[0].summary.kind, 'visual-sampled'); assert.equal(enabled.payload.sourceAnalysis.items[0].transcript.timing, 'chunk');
  assert.ok(!JSON.stringify(enabled.payload).includes('PRIVATE')); assert.ok(!JSON.stringify(enabled.payload).includes('SHOULD_NOT_SEND')); assert.ok(!JSON.stringify(enabled.payload).includes('DO_NOT_SEND_THIS_QUERY')); assert.ok(!JSON.stringify(enabled.payload).includes('未选素材的私密语义'));
  assert.deepEqual(cachedReads[0].options.assetIds, [selectedId]); assert.equal(newAnalysisCalls, 0);
  await references.configure(owner.id, { includeImages: false }); const beforeDisable = grabs.length;
  await integration.generate(owner.id, { instruction: '沿用文字参考但不发送参考图' }, options);
  assert.equal(requests[1].pictures.length, 0); assert.equal(requests[1].payload.visualReferences.includeImages, false); assert.ok(requests[1].payload.visualReferences.items.every(item => item.frames.length === 0)); assert.equal(grabs.length, beforeDisable);
  await references.configure(owner.id, { includeImages: true }); onRequest = () => references.configure(owner.id, { includeImages: false });
  await assert.rejects(integration.generate(owner.id, { instruction: '等待返回期间用户关闭图像时不可保存旧上下文结果' }, options), { code: 'REMOTION_REFERENCE_CHANGED' }); assert.equal(writes.length, 2);
  await references.configure(owner.id, { includeImages: true }); rejectImages = true;
  await assert.rejects(integration.generate(owner.id, { instruction: '当前模型拒收图像要真实失败' }, options), { code: 'REFERENCE_VISION_REJECTED' }); assert.equal(writes.length, 2); assert.equal(newAnalysisCalls, 0);
  assert.ok(grabs.filter(grab => grab.id === 'reference-video-001').every(grab => grab.range.start === 6 && grab.range.end === 8));
  if (process.env.GUANGXUAN_REMOTION_INPUT_EVIDENCE) { await mkdir(process.env.GUANGXUAN_REMOTION_INPUT_EVIDENCE, { recursive: true }); await writeFile(path.join(process.env.GUANGXUAN_REMOTION_INPUT_EVIDENCE, 'reference-generation-verification.json'), JSON.stringify({ status: 'passed', actualReferenceService: true, actualOpenAiCompatibleHttp: true, enabledImageCount: enabled.pictures.length, disabledImageCount: requests[1].pictures.length, selectedAnalysisAssetIds: enabled.payload.sourceAnalysis.items.map(item => item.assetId), sourceRange: visual.sourceRange, targetRange: visual.targetRange, newAnalysisCalls, staleReferenceRefused: true, unsupportedVisionRefused: true, requested4417: false, externalModelUsed: false }, null, 2)); }
});

test('missing reference or analysis services keep free source generation available', async () => {
  let captured;
  const owner = { id: 'no-reference-owner', kind: 'video', createdAt: 'owner-version', video: {} };
  const integration = createRemotionIntegration({ projects: { create: async (_id, input) => ({ ...input, id: 'source', revision: 1 }) }, store: { read: async () => owner }, openFilm: { context: async () => ({ assets: [], aspect: '16:9' }) }, videoService: {}, ai: async (_task, payload, _settings, options) => { captured = { payload, options }; return { data: { ...sourceAnswer(), assetIds: [] } }; } });
  await integration.generate(owner.id, { instruction: '无参考也应可原创制作' }); assert.deepEqual(captured.options.images, []); assert.equal(captured.payload.visualReferences, undefined); assert.equal(captured.payload.sourceAnalysis, undefined);
});

test('source authoring drops unsupported semantic claims and unselected analysis paths', () => {
  const payload = buildPrompt('remotion-project', { instruction: '依据已有材料编排', assets: [{ assetId: selectedId, type: 'video', name: '选中片段', duration: 30 }], sourceAnalysis: { version: 1, items: [{ ...evidence(selectedId), coverage: { sampledFrameCount: 0 }, transcript: { status: 'error', timing: 'chunk', segments: [{ start: 2, end: 4, text: '失败不应冒充识别结果' }] } }, evidence(foreignId)] } }).payload;
  assert.equal(payload.sourceAnalysis.items.length, 1); assert.equal(payload.sourceAnalysis.items[0].summary.kind, 'technical'); assert.equal(payload.sourceAnalysis.items[0].shots[0].description, ''); assert.deepEqual(payload.sourceAnalysis.items[0].transcript.segments, []);
});

test('Stop during cached-analysis or reference reads prevents model requests and source writes', async () => {
  for (const stage of ['analysis', 'references']) {
    let release, entered, modelCalls = 0, writes = 0;
    const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { entered = resolve; }), controller = new AbortController();
    const pauseAtStage = async () => { entered(); await gate; };
    const integration = createRemotionIntegration({
      projects: { create: async () => { writes++; return {}; } },
      store: { read: async () => ({ id: 'cancel-reference-owner', kind: 'video', createdAt: 'owner-version', video: {} }) },
      openFilm: { context: async () => ({ assets: [], aspect: '16:9' }) }, videoService: {},
      sourceAnalysis: { context: async (_id, options) => { assert.deepEqual(options.assetIds, []); if (stage === 'analysis') await pauseAtStage(); return { sourceAnalysis: { version: 1, items: [] } }; } },
      references: { list: async () => ({ revision: 1, includeImages: true }), context: async (_id, options) => { assert.equal(options.signal, controller.signal); if (stage === 'references') await pauseAtStage(); return { references: { includeImages: true, items: [] }, images: [] }; } },
      ai: async () => { modelCalls++; return { data: sourceAnswer() }; },
    });
    const pending = integration.generate('cancel-reference-owner', { instruction: '取消不得继续生成' }, { signal: controller.signal });
    await ready; controller.abort(); release(); await assert.rejects(pending, { name: 'AbortError' }); assert.equal(modelCalls, 0); assert.equal(writes, 0);
  }
});
