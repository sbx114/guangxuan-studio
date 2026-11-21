import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAssistantAgentService } from '../lib/assistant-agent.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const DATA = `data:image/png;base64,${PNG.toString('base64')}`, SHA = createHash('sha256').update(PNG).digest('hex');
const KEY = 'sk-visual-agent-fixture-private-123456', OWNER = 'isolated-visual-project';
const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const final = (message = '已处理本次隔离测试。') => ({ type: 'final', message, sourceIds: [] });
const step = (tool, args = {}) => ({ type: 'tool', tool, arguments: args, summary: `受控调用 ${tool}` });
const imagePacket = overrides => ({ dataUrl: DATA, label: `真实受控PNG ${KEY} C:/private/never-read.png`, index: 1, timestamp: 2, sha256: SHA, detail: 'high', ...overrides });
function framesTool({ registered = true, timestamp = 2 } = {}) {
  return { name: 'media_frames_read', description: '读取当前允许素材的实际采样帧', inputSchema: { type: 'object', additionalProperties: false },
    execute: async (_args, ctx) => ({ summary: '已取得一张实际采样图。', data: { asset: { id: 'reference-local', duration: 92 }, frames: [{ index: 1, timestamp, sha256: SHA }], coverage: { sourceDuration: 92, frameByFrame: false, planComplete: false }, pagination: { offset: 0, nextOffset: 1, hasMore: true } }, imageBatch: [imagePacket({ timestamp })] }),
    ...(registered ? { images: (raw, ctx) => { assert.equal(ctx.projectId, OWNER); assert.ok(ctx.signal); return raw.imageBatch; } } : {}) };
}
async function serviceFixture(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'gx-visual-agent-'));
  const service = createAssistantAgentService({ dataDir: directory, ...options });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  return { service, directory, settings: { baseUrl: 'https://unused-controlled.example/v1', apiKey: KEY, model: 'injected-zero-network', timeoutSeconds: 10 } };
}
async function finish(service, id) {
  for (let index = 0; index < 300; index++) { const job = await service.get(id); if (terminal.has(job.status)) return job; await pause(5); }
  throw new Error('Controlled visual agent did not settle.');
}
async function until(testValue) { for (let index = 0; index < 300; index++) { if (testValue()) return; await pause(5); } throw new Error('Controlled transport did not reach expected state.'); }
async function providerFixture(t, responder) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const body = JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString()), responses = req.url.endsWith('/responses');
    const blocks = responses ? body.input : body.messages[1].content;
    const content = Array.isArray(blocks) ? responses ? blocks[0].content : blocks : null;
    const payload = JSON.parse(content ? content[0].text : blocks), images = content ? content.filter(item => ['input_image', 'image_url'].includes(item.type)) : [];
    const request = { body, payload, images, req, res }; requests.push(request);
    const result = await responder(request, requests.length - 1);
    if (result === undefined || res.destroyed) return;
    if (result.status) { res.writeHead(result.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result.body)); return; }
    const text = JSON.stringify(result);
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(responses ? { output: [{ content: [{ type: 'output_text', text }] }] } : { choices: [{ message: { content: text }, finish_reason: 'stop' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { requests, settings: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: KEY, model: 'controlled-visual-http', timeoutSeconds: 10 } };
}

test('registered image callbacks send only the latest batch to the next model step and archive only safe metadata', async t => {
  const calls = [], fx = await serviceFixture(t, { appTools: [framesTool(), { name: 'read_text', description: '读文字', execute: async () => ({ summary: '已读取文字。', data: { note: '文字资料' } }) }], modelStep: async (_system, user, _settings, options) => {
    const payload = JSON.parse(user); calls.push({ payload, options });
    assert.doesNotMatch(user, /base64|sk-visual-agent-fixture|never-read\.png/);
    return { data: [step('media_frames_read'), step('read_text'), final()][calls.length - 1] };
  } });
  const { runId } = await fx.service.start({ projectId: OWNER, instruction: '读取并分析当前图片', settings: fx.settings }), job = await finish(fx.service, runId);
  assert.equal(job.status, 'completed'); assert.equal(calls.length, 3);
  assert.equal(calls[0].options.images, undefined); assert.equal(calls[1].options.images.length, 1); assert.equal(calls[2].options.images, undefined);
  assert.equal(calls[1].options.images[0].dataUrl, DATA); assert.equal(calls[1].options.images[0].detail, 'high'); assert.doesNotMatch(calls[1].options.images[0].label, /sk-visual|C:\/private/);
  const visual = job.steps.find(item => item.type === 'model' && item.visualInput)?.visualInput;
  assert.equal(visual.frameCount, 1); assert.equal(visual.frames[0].sha256, SHA); assert.equal(visual.frames[0].timestamp, 2);
  assert.doesNotMatch(JSON.stringify(job), /base64|sk-visual-agent-fixture|never-read\.png/);
  await fx.service.close(); assert.doesNotMatch(await readFile(path.join(fx.directory, 'assistant', 'runs.json'), 'utf8'), /base64|sk-visual-agent-fixture|never-read\.png/);
});

for (const apiStyle of ['chat', 'responses']) test(`registered callback images reach actual ${apiStyle} assistant HTTP content blocks`, async t => {
  const http = await providerFixture(t, (_request, index) => index === 0 ? step('media_frames_read') : index === 1 ? step('read_text') : final());
  const fx = await serviceFixture(t, { appTools: [framesTool(), { name: 'read_text', description: '读文字', execute: async () => ({ summary: '文字已读。' }) }] });
  const { runId } = await fx.service.start({ projectId: OWNER, instruction: '分析这张当前参考图', settings: { ...http.settings, apiStyle } }), job = await finish(fx.service, runId);
  assert.equal(job.status, 'completed'); assert.equal(http.requests.length, 3); assert.deepEqual(http.requests.map(item => item.images.length), [0, 1, 0]);
  const image = http.requests[1].images[0]; assert.equal(apiStyle === 'chat' ? image.image_url.url : image.image_url, DATA); assert.equal(apiStyle === 'chat' ? image.image_url.detail : image.detail, 'high');
  for (const request of http.requests) assert.doesNotMatch(JSON.stringify(request.payload), /base64|sk-visual-agent-fixture|never-read\.png/);
  assert.doesNotMatch(JSON.stringify(job), /base64|sk-visual-agent-fixture/);
});

test('ordinary tool imageBatch fields and arbitrary paths cannot activate image transport or enter binary observations', async t => {
  const calls = [], fx = await serviceFixture(t, { appTools: [framesTool({ registered: false })], modelStep: async (_system, user, _settings, options) => { calls.push({ user, options }); return { data: calls.length === 1 ? step('media_frames_read') : final() }; } });
  const { runId } = await fx.service.start({ projectId: OWNER, instruction: '只读取当前素材资料', settings: fx.settings }), job = await finish(fx.service, runId);
  assert.equal(job.status, 'completed'); assert.ok(calls.every(item => !item.options.images?.length));
  assert.doesNotMatch(calls[1].user, /base64/); assert.doesNotMatch(JSON.stringify(job), /base64/);
});

for (const status of [400, 415, 422]) for (const apiStyle of ['chat', 'responses']) test(`HTTP ${status} rejects actual ${apiStyle} image inputs clearly without a text-only retry`, async t => {
  const http = await providerFixture(t, (_request, index) => index === 0 ? step('media_frames_read') : { status, body: { error: `controlled unsupported image ${KEY}` } });
  const fx = await serviceFixture(t, { appTools: [framesTool()] });
  const { runId } = await fx.service.start({ projectId: OWNER, instruction: '读取实际参考图', settings: { ...http.settings, apiStyle } }), job = await finish(fx.service, runId);
  assert.equal(job.status, 'failed'); assert.equal(job.error.code, 'ASSISTANT_VISION_REQUIRED'); assert.match(job.error.message, /支持视觉/);
  assert.equal(http.requests.length, 2); assert.equal(http.requests[1].images.length, 1); assert.doesNotMatch(JSON.stringify(job), /sk-visual-agent-fixture|base64/);
});

test('Stop cancels a real pending image HTTP request and retains no image data or success claim', async t => {
  let closed = false;
  const http = await providerFixture(t, (request, index) => { if (index === 0) return step('media_frames_read'); request.res.once('close', () => { closed = true; }); return undefined; });
  const fx = await serviceFixture(t, { appTools: [framesTool()] });
  const { runId } = await fx.service.start({ projectId: OWNER, instruction: '分析当前图片', settings: http.settings });
  await until(() => http.requests.length === 2); assert.equal(http.requests[1].images.length, 1);
  const job = await fx.service.cancel(runId); await until(() => closed);
  assert.equal(job.status, 'cancelled'); assert.equal(job.error.code, 'REQUEST_CANCELLED'); assert.equal(http.requests.length, 2);
  assert.doesNotMatch(JSON.stringify(job), /base64|sk-visual-agent-fixture/); assert.ok(job.steps.some(item => item.type === 'model' && item.visualInput?.frameCount === 1 && item.status === 'cancelled'));
});

test('a first final on a shot-by-shot rebuild continues into actual frame reading and an authorized mock write', async t => {
  let writes = 0; const calls = [];
  const fx = await serviceFixture(t, { buildContext: async () => ({ native: { assets: [{ id: 'reference-local', type: 'video', duration: 92 }] } }), appTools: [framesTool(), { name: 'animation_create', description: '隔离测试制作', mutating: true, execute: async () => { writes++; return { summary: '已取得隔离测试完成的视频任务。', data: { remotionId: 'fixture-source', revision: 1, job: { id: 'fixture-video-job', projectId: OWNER, remotionId: 'fixture-source', revision: 1, kind: 'video', status: 'complete', result: { videoUrl: `/api/projects/${OWNER}/remotion/jobs/fixture-video-job/files/video.mp4` } } }, effects: [{ type: 'remotion', projectId: OWNER, changed: true, label: '已写入隔离制作源码' }] }; } }], modelStep: async (_system, user, _settings, options) => {
    calls.push({ payload: JSON.parse(user), options }); return { data: [final('只有三帧，无法继续。'), step('assistant_plan', { items: [{ id: 'whole-reference-check', label: '核对全长参考与成品', kind: 'verify', status: 'pending' }] }), step('media_frames_read'), step('animation_create'), final('已取得隔离制作视频。')][calls.length - 1] };
  } });
  const { runId } = await fx.service.start({ projectId: OWNER, instruction: '按video逐镜对照重建', settings: fx.settings }), job = await finish(fx.service, runId);
  assert.equal(job.status, 'completed'); assert.equal(calls.length, 5); assert.equal(writes, 1);
  assert.match(calls[1].payload.progress.notice, /media_frames_read/); assert.equal(calls[3].options.images.length, 1);
  assert.ok(calls[0].payload.tools.some(item => item.name === 'animation_create')); assert.ok(job.evidence.entries.some(item => item.kind === 'video_render' && item.outcome === 'completed'));
  assert.equal(job.report.outcome, 'partial', 'The fixture wrote content but did not verify all 92 seconds.');
});

test('rebuild finals get at most two strategy continuations and then report the unfinished task', async t => {
  let calls = 0, reads = 0;
  const fx = await serviceFixture(t, { appTools: [{ ...framesTool(), execute: async () => { reads++; return {}; } }], modelStep: async () => { calls++; return { data: final('未执行制作。') }; } });
  const { runId } = await fx.service.start({ projectId: OWNER, instruction: '按视频逐镜重建', settings: fx.settings }), job = await finish(fx.service, runId);
  assert.equal(calls, 3); assert.equal(reads, 0); assert.equal(job.status, 'failed'); assert.equal(job.error.code, 'ASSISTANT_PRODUCTION_NOT_STARTED'); assert.equal(job.report.outcome, 'partial');
});

for (const instruction of ['如何模仿视频？', '不要完全模仿视频，只分析构图', '只是分析这个视频的逐镜结构', 'How do I rebuild the reference video?', 'Do not rebuild the reference video; only explain it.']) test(`read-only request does not grant rebuild writes: ${instruction}`, async t => {
  let writes = 0; const inputs = [];
  const fx = await serviceFixture(t, { appTools: [{ name: 'mock_write', description: '隔离写入', mutating: true, execute: async () => { writes++; return { effects: [{ type: 'project', changed: true }] }; } }], modelStep: async (_system, user) => { inputs.push(JSON.parse(user)); return { data: inputs.length === 1 ? step('mock_write') : final('仅分析。') }; } });
  const { runId } = await fx.service.start({ projectId: OWNER, instruction, settings: fx.settings }), job = await finish(fx.service, runId);
  assert.equal(job.status, 'completed'); assert.equal(writes, 0); assert.equal(inputs[0].tools.some(item => item.name === 'mock_write'), false); assert.equal(job.steps.find(item => item.tool === 'mock_write').status, 'failed');
});

test('English rebuild, reconstruct, replicate and imitate imperatives authorize actual isolated writes without the project fallback', async t => {
  for (const instruction of ['Rebuild the reference video shot by shot.', 'Reconstruct this video from its reference.', 'Replicate this reference video.', 'Imitate this video composition.']) {
    let writes = 0, calls = 0;
    const fx = await serviceFixture(t, { appTools: [{ name: 'mock_write', description: '隔离写入', mutating: true, execute: async () => { writes++; return { summary: '已写入隔离内容。', effects: [{ type: 'project', changed: true, label: '已执行测试写入' }] }; } }], modelStep: async () => ({ data: calls++ === 0 ? step('mock_write') : final() }) });
    const { runId } = await fx.service.start({ instruction, settings: fx.settings }), job = await finish(fx.service, runId);
    assert.equal(job.status, 'failed', instruction); assert.equal(job.error.code, 'ASSISTANT_PRODUCTION_NOT_STARTED'); assert.equal(writes, 1, instruction); assert.ok(job.evidence.entries.some(item => item.role === 'execution'), instruction);
  }
});

test('local reference rebuild keeps search disabled unless the user explicitly asks for reference searching', async t => {
  for (const [instruction, allowed] of [['按当前视频逐镜重建', false], ['按当前视频逐镜重建，并搜索类似参考', true]]) {
    let searches = 0, calls = 0; const inputs = [];
    const fx = await serviceFixture(t, { buildContext: async () => ({ native: { assets: [{ id: 'reference-local', type: 'video', duration: 92 }] } }), webTools: { search: async () => { searches++; return { results: [{ title: '受控参考', url: 'https://controlled.example/reference' }] }; }, read: async () => ({}) }, modelStep: async (_system, user) => { inputs.push(JSON.parse(user)); return { data: calls++ === 0 ? step('web_search', { query: '具体镜头参考', limit: 1 }) : final() }; } });
    const { runId } = await fx.service.start({ projectId: OWNER, instruction, settings: fx.settings }); await finish(fx.service, runId);
    assert.equal(searches, allowed ? 1 : 0); assert.equal(inputs[0].searchPolicy.searchAllowed, allowed); assert.equal(inputs[0].tools.some(item => item.name === 'web_search'), allowed);
  }
});

test('an explicit search still rejects long private project text and only sends a short public query', async t => {
  const privateText = 'PRIVATE_PROJECT_NOTE_'.repeat(12), queries = [], inputs = [];
  const fx = await serviceFixture(t, { buildContext: async () => ({ privateText }), webTools: { search: async query => { queries.push(query); return { results: [] }; }, read: async () => ({}) }, modelStep: async (_system, user) => { inputs.push(JSON.parse(user)); return { data: [step('web_search', { query: privateText, limit: 1 }), step('web_search', { query: '有机化学镜头参考', limit: 1 }), final()][inputs.length - 1] }; } });
  const { runId } = await fx.service.start({ projectId: OWNER, instruction: '请搜索公开资料', settings: fx.settings }), job = await finish(fx.service, runId);
  assert.equal(job.status, 'completed'); assert.deepEqual(queries, ['有机化学镜头参考']); assert.equal(inputs[1].observations[0].error.code, 'ASSISTANT_SEARCH_PRIVATE');
  assert.doesNotMatch(JSON.stringify(job), /PRIVATE_PROJECT_NOTE|sk-visual-agent-fixture/);
});
