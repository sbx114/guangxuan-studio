import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeAssistantToolImages, ASSISTANT_TOOL_IMAGE_LIMITS } from '../lib/assistant-tool-images.mjs';
import { runStructuredAi } from '../lib/ai.mjs';
import { createAssistantAgentService } from '../lib/assistant-agent.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const DATA = `data:image/png;base64,${PNG.toString('base64')}`;
const SHA = createHash('sha256').update(PNG).digest('hex');
const KEY = 'sk-tool-images-fixture-secret-123456';
const packet = overrides => ({ dataUrl: DATA, label: '实际采样帧 · 00:02.000', index: 17, timestamp: 2, sha256: SHA, ...overrides });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function provider(t, responder) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const entry = { body: JSON.parse(raw || '{}'), req, res };
    requests.push(entry);
    const value = await responder(entry, requests.length - 1);
    if (value === undefined || res.destroyed) return;
    const content = JSON.stringify(value);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url.endsWith('/responses') ? { output: [{ content: [{ type: 'output_text', text: content }] }] } : { choices: [{ message: { content }, finish_reason: 'stop' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { requests, settings: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: KEY, model: 'controlled-vision', timeoutSeconds: 10 } };
}

test('trusted image packets produce separate multimodal inputs and source summaries without paths, keys or image bytes', () => {
  const { images, summary } = normalizeAssistantToolImages([packet({ label: `frame ${KEY} C:/private/source.png`, detail: 'high', extra: 'private-unused-value' })], { clean: value => value.replace(KEY, '[已隐藏]') });
  assert.deepEqual(images, [{ dataUrl: DATA, label: 'frame [已隐藏] [本机路径]', detail: 'high' }]);
  assert.equal(summary.frameCount, 1);
  assert.equal(summary.totalEncodedBytes, Buffer.byteLength(DATA));
  assert.deepEqual(summary.frames[0], { index: 17, timestamp: 2, label: images[0].label, mimeType: 'image/png', bytes: PNG.length, encodedBytes: DATA.length, sha256: SHA, detail: 'high' });
  assert.doesNotMatch(JSON.stringify(summary), /base64|private|sk-tool|source\.png/);
  assert.equal(Object.hasOwn(summary.frames[0], 'dataUrl'), false);
  assert.equal(images[0].extra, undefined);
  assert.equal(normalizeAssistantToolImages([packet({ timestamp: undefined, label: undefined, index: undefined })]).images[0].detail, 'low');
  assert.deepEqual(normalizeAssistantToolImages([]), { images: [], summary: { frameCount: 0, totalEncodedBytes: 0, frames: [] } });
});

test('only inline image data is accepted; MIME, source hash and actual time metadata are checked', () => {
  for (const dataUrl of ['C:/private/source.png', 'file:///C:/private/source.png', 'https://private.example/scan.png', `data:image/png;base64,${Buffer.from('not an actual image').toString('base64')}`, DATA.replace('image/png', 'image/jpeg')]) {
    assert.throws(() => normalizeAssistantToolImages([packet({ dataUrl })]), { code: 'ASSISTANT_TOOL_IMAGE_INVALID' });
  }
  for (const overrides of [{ index: 0 }, { index: 1.5 }, { timestamp: -1 }, { timestamp: Infinity }, { detail: 'download-file' }]) assert.throws(() => normalizeAssistantToolImages([packet(overrides)]), { code: 'ASSISTANT_TOOL_IMAGE_METADATA' });
  assert.throws(() => normalizeAssistantToolImages([packet({ sha256: '0'.repeat(64) })]), { code: 'ASSISTANT_TOOL_IMAGE_PROVENANCE' });
  assert.throws(() => normalizeAssistantToolImages([packet({ sha256: 'C:/private/source.png' })]), { code: 'ASSISTANT_TOOL_IMAGE_PROVENANCE' });
  assert.equal(normalizeAssistantToolImages([packet({ sha256: SHA.toUpperCase() })]).summary.frames[0].sha256, SHA);
});

test('per-call encoded budgets reject excessive frame count, oversized images and oversized batches', () => {
  assert.throws(() => normalizeAssistantToolImages(Array(13).fill(packet())), { code: 'ASSISTANT_TOOL_IMAGES_LIMIT' });
  const oversized = `data:image/png;base64,${'A'.repeat(ASSISTANT_TOOL_IMAGE_LIMITS.imageEncodedBytes)}`;
  assert.throws(() => normalizeAssistantToolImages([packet({ dataUrl: oversized })]), { code: 'ASSISTANT_TOOL_IMAGES_BYTES' });
  const raw = Buffer.alloc(1100000);
  PNG.subarray(0, 8).copy(raw);
  const large = { dataUrl: `data:image/png;base64,${raw.toString('base64')}`, index: 1 };
  assert.ok(large.dataUrl.length < ASSISTANT_TOOL_IMAGE_LIMITS.imageEncodedBytes);
  assert.throws(() => normalizeAssistantToolImages(Array(6).fill(large)), { code: 'ASSISTANT_TOOL_IMAGES_BYTES' });
});

for (const apiStyle of ['chat', 'responses']) test(`trusted batches send actual ${apiStyle} image blocks with high/auto detail and no image JSON in text`, async t => {
  const fx = await provider(t, () => ({ type: 'final', message: '已读取本批实际画面。' }));
  const batch = normalizeAssistantToolImages([packet({ detail: 'high' }), packet({ index: 18, timestamp: 4, detail: 'auto' }), packet({ index: 19, timestamp: 6 })]);
  const result = await runStructuredAi('只根据本批图片分析。', JSON.stringify({ imageBatch: batch.summary }), { ...fx.settings, apiStyle }, { images: batch.images });
  const body = fx.requests[0].body;
  const blocks = apiStyle === 'chat' ? body.messages[1].content : body.input[0].content;
  const parts = blocks.filter(block => block.type === (apiStyle === 'chat' ? 'image_url' : 'input_image'));
  assert.equal(parts.length, 3);
  assert.deepEqual(parts.map(part => apiStyle === 'chat' ? part.image_url.url : part.image_url), [DATA, DATA, DATA]);
  assert.deepEqual(parts.map(part => apiStyle === 'chat' ? part.image_url.detail : part.detail), ['high', 'auto', 'low']);
  const text = blocks.filter(block => block.type === (apiStyle === 'chat' ? 'text' : 'input_text')).map(block => block.text).join('\n');
  assert.doesNotMatch(text, /base64|sk-tool/);
  assert.equal(result.data.message, '已读取本批实际画面。');
  assert.doesNotMatch(JSON.stringify(result), /base64|sk-tool/);
  const previous = fx.requests.length;
  await assert.rejects(runStructuredAi('test', '{}', { ...fx.settings, apiStyle }, { images: [packet({ detail: 'bad' })] }), { code: 'REFERENCE_IMAGE_INVALID' });
  assert.equal(fx.requests.length, previous);
});

test('cancellation aborts pending real image HTTP transport and pre-aborted normalization never returns frames', async t => {
  let closed = false;
  const fx = await provider(t, entry => { entry.res.once('close', () => { closed = true; }); return undefined; });
  const controller = new AbortController();
  const batch = normalizeAssistantToolImages([packet()]);
  const pending = runStructuredAi('test', '{}', fx.settings, { images: batch.images, signal: controller.signal });
  for (let index = 0; index < 100 && !fx.requests.length; index++) await pause(5);
  assert.equal(fx.requests.length, 1);
  controller.abort();
  await assert.rejects(pending, { code: 'REQUEST_CANCELLED' });
  for (let index = 0; index < 100 && !closed; index++) await pause(5);
  assert.equal(closed, true);
  assert.throws(() => normalizeAssistantToolImages([packet()], { signal: controller.signal }), { code: 'REQUEST_CANCELLED' });
});

test('model arguments, project data and ordinary tool image fields cannot create unregistered image transport', async t => {
  const calls = [];
  const directory = await mkdtemp(path.join(tmpdir(), 'gx-unregistered-tool-images-'));
  const service = createAssistantAgentService({ dataDir: directory,
    buildContext: async () => ({ data: { images: [packet()], path: 'C:/private/model-path.png' } }),
    appTools: [{ name: 'read_material', description: '只读材料', execute: async () => ({ summary: '已读取文字。', imageBatch: [packet()], data: { images: [packet()], path: 'C:/private/project-path.png' } }) }],
    modelStep: async (_system, _user, _settings, options) => {
      calls.push(options);
      return { data: calls.length === 1 ? { type: 'tool', tool: 'read_material', arguments: { images: [packet()], path: 'C:/private/argument-path.png' }, summary: '读取材料' } : { type: 'final', message: '已读取材料。', sourceIds: [] } };
    },
  });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const { runId } = await service.start({ instruction: '请读取材料', settings: { baseUrl: 'https://unused-controlled.example/v1', apiKey: KEY, model: 'no-network-injected' } });
  let job;
  for (let index = 0; index < 100; index++) { job = await service.get(runId); if (['completed', 'failed', 'cancelled'].includes(job.status)) break; await pause(5); }
  assert.equal(job.status, 'completed');
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => !call.images?.length));
  await service.close();
  assert.doesNotMatch(await readFile(path.join(directory, 'assistant', 'runs.json'), 'utf8'), /sk-tool-images-fixture-secret/);
});
