import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createProjectStore } from '../lib/store.mjs';
import { createScienceDocumentService } from '../lib/science-documents.mjs';
import { createAssistantMediaUnderstanding } from '../lib/assistant-media-understanding.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=', 'base64');
const DATA = 'data:image/png;base64,' + PNG.toString('base64'), KEY = 'fixture-vision-private-key';
const answer = (count = 1) => ({ usable: true, title: '受力与加速度', frames: Array.from({ length: count }, (_, index) => ({ index: index + 1, visibleText: `第${index + 1}幅：F=ma。保持质量不变时，加速度随合力增大。`, description: '扫描教材中可见受力关系和加速度的说明。', keyPoints: ['依据识别文字整理合力、质量和加速度关系。'], uncertainties: ['公式及符号需要对照原图核对。'] })), warnings: [] });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, predicate) { for (let index = 0; index < 300; index++) { const result = await read(); if (predicate(result)) return result; await pause(5); } assert.fail('Fixture did not reach expected state.'); }
async function report(name, data) { if (!process.env.GUANGXUAN_MEDIA_UNDERSTANDING_EVIDENCE) return; const directory = path.resolve(process.env.GUANGXUAN_MEDIA_UNDERSTANDING_EVIDENCE); await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, name + '.json'), JSON.stringify(data, null, 2)); }
async function fixture(t, responder, { kind = 'image', apiStyle = 'chat', referenceFrames, transcribeAsset } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gx-media-understanding-')), store = await createProjectStore(directory), scienceDocuments = await createScienceDocumentService({ dataDir: directory, store });
  const project = await store.save('science-current', { kind: 'science', title: '当前科普项目', science: { documentSelection: null }, source: { text: '已有材料' } });
  const source = path.join(directory, 'PRIVATE-original-input.png'); await writeFile(source, PNG);
  const asset = { id: 'trusted-asset', type: kind, name: kind === 'image' ? '扫描教材.png' : '实验讲解.mp4', path: source, size: PNG.length, mtimeMs: 1, duration: kind === 'image' ? 4 : 900, width: 640, height: 480, hasAudio: kind === 'video' };
  const requests = [], frameCalls = [], videoService = { resolveAsset: async id => { assert.equal(id, asset.id); return structuredClone(asset); }, referenceFrames: async (id, options) => { assert.equal(id, asset.id); frameCalls.push(options); if (referenceFrames) return referenceFrames(id, options); return kind === 'image' ? [{ dataUrl: DATA }] : [30, 150, 270].map(timestamp => ({ dataUrl: DATA, timestamp })); } };
  const server = http.createServer(async (req, res) => {
    try { const body = JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString()); const content = req.url.endsWith('/responses') ? body.input[0].content : body.messages[1].content; const entry = { body, req, res, content, payload: JSON.parse(content[0].text), images: content.filter(part => ['image_url', 'input_image'].includes(part.type)).map(part => part.image_url?.url || part.image_url) }; requests.push(entry); const result = await responder(entry, requests.length - 1); if (result === undefined || res.destroyed) return; if (result.status) { res.writeHead(result.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(result.body)); return; } res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(req.url.endsWith('/responses') ? { output: [{ content: [{ type: 'output_text', text: JSON.stringify(result) }] }] } : { choices: [{ message: { content: JSON.stringify(result) }, finish_reason: 'stop' }] })); }
    catch { if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }); if (!res.writableEnded) res.end(JSON.stringify({ error: 'controlled vision fixture failed' })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const service = createAssistantMediaUnderstanding({ videoService, scienceDocuments, store, transcribeAsset });
  t.after(async () => { await service.close(); await scienceDocuments.close(); await store.settle(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); assert.equal(path.dirname(directory), os.tmpdir()); await rm(directory, { recursive: true, force: true }); });
  const settings = { baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', apiKey: KEY, model: 'vision-fixture', apiStyle, timeoutSeconds: 10 };
  return { directory, source, service, store, scienceDocuments, project, asset, requests, frameCalls, settings };
}

for (const apiStyle of ['chat', 'responses']) test(`scanned-image ${apiStyle} recognition sends actual image blocks and persists labeled OCR as a science document`, async t => {
  const fx = await fixture(t, entry => { assert.deepEqual(entry.images, [DATA]); assert.deepEqual(Buffer.from(entry.images[0].split(',')[1], 'base64'), PNG); assert.equal(entry.req.headers.authorization, 'Bearer ' + KEY); assert.equal(JSON.stringify(entry.body).includes(KEY), false); assert.equal(JSON.stringify(entry.body).includes('PRIVATE-original-input'), false); assert.equal(entry.payload.source.name, '扫描教材.png'); const result = answer(); result.warnings.push('不应泄露连接凭据 ' + KEY); return result; }, { apiStyle, transcribeAsset: () => assert.fail('Still-image preparation cannot call ASR.') });
  const result = await fx.service.prepare(fx.project.id, fx.asset.id, { settings: fx.settings, instruction: '识别扫描教材并导入 ' + KEY, sourceUrl: 'https://school.example.org/physics.png' });
  assert.equal(result.duplicate, false); assert.equal(result.analysis.kind, 'image'); assert.equal(result.analysis.transcriptStatus, 'not-applicable'); assert.equal(fx.frameCalls[0].count, 1); assert.equal(fx.frameCalls[0].range, undefined); const saved = await fx.scienceDocuments.get(fx.project.id, result.document.id); const text = saved.units.map(unit => unit.text).join('\n'); assert.match(text, /AI图片文字识别/); assert.match(text, /F=ma/); assert.match(text, /原文件：扫描教材.png/); assert.match(text, /原始来源：https:\/\/school.example.org\/physics.png/); assert.match(text, /AI OCR，非人工校对/); assert.equal(text.includes(KEY), false); assert.equal(text.includes('PRIVATE-original-input'), false); assert.equal((await fx.store.read(fx.project.id)).science.documentSelection, null);
  const duplicate = await fx.service.prepare(fx.project.id, fx.asset.id, { settings: fx.settings, instruction: '识别扫描教材并导入 ' + KEY, sourceUrl: 'https://school.example.org/physics.png' }); assert.equal(duplicate.duplicate, true); assert.equal(duplicate.document.id, result.document.id); assert.equal((await fx.scienceDocuments.list(fx.project.id)).documents.length, 1); assert.deepEqual(await readFile(fx.source), PNG);
  await report('scan-' + apiStyle, { controlledVisionHttpFixture: true, actualImageBlocks: fx.requests.map(item => item.images.length), originalImageBytes: PNG.length, persistedDocumentId: saved.id, units: saved.totalUnitCount, analysis: result.analysis, duplicate: duplicate.duplicate });
});

test('videos send only actual first-300-second sample frames and label missing audio and incomplete coverage', async t => {
  const fx = await fixture(t, entry => { assert.deepEqual(entry.images, [DATA, DATA, DATA]); assert.deepEqual(entry.payload.frames.map(frame => frame.timestamp), [30, 150, 270]); assert.equal(entry.payload.coverage.end, 300); assert.equal(entry.payload.coverage.sourceDuration, 900); assert.equal(entry.payload.transcriptStatus, 'unavailable'); assert.equal(entry.content.some(part => part.type === 'input_audio'), false); return answer(3); }, { kind: 'video' });
  const result = await fx.service.prepare(fx.project.id, fx.asset.id, { settings: fx.settings, instruction: '处理视频画面后导入科普' }); assert.deepEqual(fx.frameCalls[0].range, { start: 0, end: 300 }); assert.ok(fx.frameCalls[0].count <= 6); assert.equal(result.analysis.coverage.frameByFrame, false); assert.equal(result.analysis.coverage.truncated, true); assert.equal(result.analysis.transcriptStatus, 'unavailable'); const text = result.document.units.map(unit => unit.text).join('\n'); assert.match(text, /00:30.000/); assert.match(text, /04:30.000/); assert.match(text, /05:00.000之后的视频未分析/); assert.match(text, /未逐帧/); assert.match(text, /未转写，未识别音频/); await report('video-sampled-unavailable-audio', { controlledVisionHttpFixture: true, frameTimestamps: [30, 150, 270], analysis: result.analysis, documentId: result.document.id });
});

test('blank or unrecognized images are retained without importing an empty substitute document', async t => {
  const fx = await fixture(t, () => ({ usable: false, title: '未识别', frames: [{ index: 1, visibleText: '', description: '', keyPoints: [] }], warnings: ['空白或无法辨认'] }));
  await assert.rejects(fx.service.prepare(fx.project.id, fx.asset.id, { settings: fx.settings }), { code: 'ASSISTANT_MEDIA_NO_CONTENT' }); assert.equal((await fx.scienceDocuments.list(fx.project.id)).documents.length, 0); assert.deepEqual(await readFile(fx.source), PNG);
});

test('a visual image with no readable words is labeled as observation rather than fabricated OCR', async t => {
  const fx = await fixture(t, () => ({ usable: true, title: '无文字图示', frames: [{ index: 1, visibleText: '', description: '图中可见一个带箭头的实验装置示意结构，具体数值没有标注。', keyPoints: [], uncertainties: ['装置名称需人工核对。'] }], warnings: [] }));
  const result = await fx.service.prepare(fx.project.id, fx.asset.id, { settings: fx.settings }); const text = result.document.units.map(unit => unit.text).join('\n'); assert.match(text, /未识别到可引用文字；以下仅为可见画面描述/); assert.match(text, /具体数值没有标注/);
});

test('provider vision rejection fails clearly without a metadata-only retry or a fake imported document', async t => {
  const fx = await fixture(t, () => ({ status: 400, body: { error: 'image inputs unsupported by this fixture' } }));
  await assert.rejects(fx.service.prepare(fx.project.id, fx.asset.id, { settings: fx.settings }), error => { assert.equal(error.code, 'ASSISTANT_MEDIA_VISION_REJECTED'); assert.match(error.message, /原文件已保留/); return true; }); assert.equal(fx.requests.length, 1); assert.equal((await fx.scienceDocuments.list(fx.project.id)).documents.length, 0); assert.deepEqual(await readFile(fx.source), PNG);
});

test('missing actual frames cannot silently become metadata-based recognition', async t => {
  const fx = await fixture(t, () => answer(), { referenceFrames: async () => [{ timestamp: 0, name: 'only-metadata' }] });
  await assert.rejects(fx.service.prepare(fx.project.id, fx.asset.id, { settings: fx.settings }), { code: 'ASSISTANT_MEDIA_FRAMES' }); assert.equal(fx.requests.length, 0); assert.equal((await fx.scienceDocuments.list(fx.project.id)).documents.length, 0);
});

test('cancellation stops the real pending model HTTP request and never imports partial recognition', async t => {
  let closed = false; const fx = await fixture(t, entry => { entry.res.once('close', () => { closed = true; }); return undefined; }); const controller = new AbortController(); const pending = fx.service.prepare(fx.project.id, fx.asset.id, { settings: fx.settings, signal: controller.signal });
  await until(() => Promise.resolve(fx.requests.length), value => value === 1); controller.abort(); await assert.rejects(pending, { code: 'ASSISTANT_MEDIA_CANCELLED' }); await until(() => Promise.resolve(closed), Boolean); assert.equal((await fx.scienceDocuments.list(fx.project.id)).documents.length, 0);
});

test('owner recreation and source changes during vision prevent importing results into a different owner or changed asset', async t => {
  for (const change of ['owner', 'asset']) {
    let fx; fx = await fixture(t, async () => { if (change === 'owner') { await fx.store.remove(fx.project.id); await fx.store.save(fx.project.id, { kind: 'science', title: '重新创建的项目', createdAt: '2099-01-01T00:00:00.000Z' }); } else fx.asset.mtimeMs++; return answer(); });
    await assert.rejects(fx.service.prepare(fx.project.id, fx.asset.id, { settings: fx.settings }), { code: change === 'owner' ? 'ASSISTANT_MEDIA_OWNER_CHANGED' : 'ASSISTANT_MEDIA_ASSET_CHANGED' }); assert.equal((await fx.scienceDocuments.list(fx.project.id)).documents.length, 0); assert.deepEqual(await readFile(fx.source), PNG);
  }
});

test('only current science owners and trusted IDs can start recognition; a model cannot invent unseen frame numbers', async t => {
  const fx = await fixture(t, () => ({ ...answer(), frames: [{ ...answer().frames[0], index: 2 }] }));
  await fx.store.save('writing-project', { kind: 'writing', title: '文案项目' }); await assert.rejects(fx.service.prepare('writing-project', fx.asset.id, { settings: fx.settings }), { code: 'ASSISTANT_MEDIA_SCIENCE_PROJECT' }); await assert.rejects(fx.service.prepare(fx.project.id, 'C:/private/source.png', { settings: fx.settings }), { code: 'ASSISTANT_MEDIA_ASSET_ID' }); assert.equal(fx.requests.length, 0); await assert.rejects(fx.service.prepare(fx.project.id, fx.asset.id, { settings: fx.settings }), { code: 'ASSISTANT_MEDIA_MODEL_FORMAT' }); assert.equal((await fx.scienceDocuments.list(fx.project.id)).documents.length, 0);
});

test('real ASR callback text and timing are sent to vision and persisted separately without filling missing audio', async t => {
  const transcript = '实际转写：在实验中保持质量不变，比较不同合力产生的加速度。'; let called = 0;
  const fx = await fixture(t, entry => { assert.equal(entry.payload.transcript.status, 'partial'); assert.equal(entry.payload.transcript.text, transcript); assert.deepEqual(entry.payload.transcript.segments, [{ start: 1, end: 6, text: transcript, timing: 'segment' }]); assert.deepEqual(entry.images, [DATA, DATA, DATA]); return answer(3); }, { kind: 'video', transcribeAsset: async (projectId, assetId, options) => { called++; assert.equal(projectId, 'science-current'); assert.equal(assetId, 'trusted-asset'); assert.deepEqual(options.range, { start: 0, end: 300 }); assert.equal(options.settings.apiKey, KEY); assert.ok(options.signal); options.onProgress('正在返回实际转写'); return { status: 'partial', text: transcript, segments: [{ start: 1, end: 6, text: transcript, timing: 'segment' }], chunks: [{ start: 0, end: 60 }], warning: '仅第一段转写成功。' }; } });
  const result = await fx.service.prepare(fx.project.id, fx.asset.id, { settings: fx.settings }); assert.equal(called, 1); assert.equal(result.analysis.transcriptStatus, 'partial'); const text = result.document.units.map(unit => unit.text).join('\n'); assert.match(text, /实际音频转写（AI ASR，非人工校对）/); assert.ok(text.includes(transcript)); assert.match(text, /00:01.000—00:06.000；逐句时间/); assert.match(text, /00:00.000—01:00.000/); assert.match(text, /缺失内容未补写/); assert.match(text, /仅第一段转写成功/); await report('video-real-asr-callback', { controlledAsrCallback: true, callbackCalls: called, transcriptStatus: result.analysis.transcriptStatus, documentId: result.document.id, actualReturnedChunk: { start: 0, end: 60 } });
});

test('failed ASR callback output is excluded while actual visual recognition can still import with a clear warning', async t => {
  const fx = await fixture(t, entry => { assert.equal(entry.payload.transcript.status, 'error'); assert.equal(entry.payload.transcript.text, ''); assert.deepEqual(entry.payload.transcript.segments, []); assert.deepEqual(entry.images, [DATA, DATA, DATA]); return answer(3); }, { kind: 'video', transcribeAsset: async () => ({ status: 'error', text: '不应导入的失败转写占位内容', segments: [{ start: 0, end: 20, text: '伪转写', timing: 'segment' }], warning: '本机受控ASR服务未能完成转写。' }) });
  const result = await fx.service.prepare(fx.project.id, fx.asset.id, { settings: fx.settings }); assert.equal(result.analysis.transcriptStatus, 'error'); const text = result.document.units.map(unit => unit.text).join('\n'); assert.match(text, /F=ma/); assert.match(text, /未转写，未识别音频/); assert.match(text, /ASR服务未能完成/); assert.doesNotMatch(text, /失败转写占位内容|伪转写|实际音频转写（AI ASR/); assert.equal((await fx.scienceDocuments.list(fx.project.id)).documents.length, 1);
});
