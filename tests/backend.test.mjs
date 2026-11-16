import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, readFile, rm, readdir } from 'node:fs/promises';
import { startServer } from '../server.mjs';
import { normalizeSettings, parseModelJson } from '../lib/ai.mjs';
import { createDocx, extractDocx, importDocument, readZipEntry } from '../lib/documents.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const secret = 'sk-test-only-never-a-real-key-123';
const source = { title: '测试讲座', text: '光电科普讲座定于2026年11月20日15:00在C112举行。活动面向本科生，报名方式暂未确定。', url: 'https://example.org/notice' };
const extraction = { summary: '讲座预告。', facts: [{ label: '时间', value: '2026年11月20日15:00', quote: '2026年11月20日15:00', quoteMatched: false, confirmed: true }, { label: '虚构事实', value: '主讲人张三', quote: '主讲人张三', quoteMatched: true, confirmed: true }], missing: ['报名方式'] };
const outputs = {
  article: { titles: ['走近光电'], title: '走近光电', lead: '欢迎参加讲座。', body: '讲座定于2026年11月20日15:00举行。' },
  poster: { eyebrow: '讲座', title: '走近光电', subtitle: '一次科普交流', highlights: ['面向本科生'], details: [{ label: '时间', value: '2026年11月20日15:00' }], footer: '' },
  video: { title: '讲座预告', durationSeconds: 99, shots: [{ duration: 8, visual: '示意：光束', narration: '欢迎了解光电。', caption: '走近光电' }, { duration: 10, visual: '展示活动时间', narration: '活动即将举行。', caption: '敬请关注' }] },
  social: { title: '讲座预告', text: '11月20日的光电科普讲座，欢迎关注。', tags: ['光电'] },
};
let app, provider, providerUrl, dataDir, testDir;
let mode = 'extract';
let lastRequest;
let requestCount = 0;
let delayedClosed;
let providerSawRequest;

async function request(url, body, options = {}) {
  const response = await fetch(`${app.url}${url}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...options.headers }, body: body === undefined ? undefined : JSON.stringify(body), ...options });
  return { response, data: response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text() };
}
function settings(extra = {}) { return { baseUrl: providerUrl, model: 'test-model', apiKey: secret, ...extra }; }
function payload(extra = {}) { return { source, brief: { audience: '本科生', tone: '清楚', scenario: '活动预告' }, ...extra }; }
const confirmedFacts = [{ id: 'F1', label: '时间', value: '2026年11月20日15:00', quote: '2026年11月20日15:00', confirmed: true }, { id: 'F2', label: '未经确认', value: '不应进入提示词', quote: '', confirmed: false }];

before(async () => {
  const work = path.resolve(root, '../../work');
  await mkdir(work, { recursive: true });
  testDir = await mkdtemp(path.join(work, 'backend-test-'));
  dataDir = path.join(testDir, 'data');
  provider = http.createServer(async (req, res) => {
    requestCount++;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    lastRequest = { path: req.url, body, authorization: req.headers.authorization };
    providerSawRequest?.();
    res.setHeader('Content-Type', 'application/json');
    if (mode === 'delay') { res.on('close', () => delayedClosed?.()); return; }
    if (mode === 'error') { res.writeHead(401); res.end(JSON.stringify({ error: { message: `bad key ${secret}` } })); return; }
    if (req.url === '/v1/models') {
      if (mode === 'models404') { res.writeHead(404); res.end('{}'); return; }
      res.end(JSON.stringify({ data: [{ id: 'test-model' }, { id: 'another-model' }, { id: 'test-model' }] })); return;
    }
    if (mode === 'invalid') { res.end(JSON.stringify({ choices: [{ message: { content: '不是 JSON' } }] })); return; }
    const result = mode === 'edit' || mode === 'edit-invalid' || mode === 'edit-time-invalid'
      ? { title: '测试剪辑', summary: '按脚本顺序剪辑。', timeline: [{ assetId: mode === 'edit-invalid' ? 'not-provided' : 'clip-a', start: 1, end: mode === 'edit-time-invalid' ? 99 : 6, reason: '按元数据选择片段，需核对画面。' }], captions: [{ start: 0, end: 3, text: '欢迎参加。' }], warnings: [] }
      : mode === 'animation' || mode === 'animation-bars' ? { title: '宣传动画', aspect: '9:16', fps: 60, theme: 'dark', scenes: mode === 'animation-bars' ? [{ type: 'bars', duration: 5, title: '制作耗时', data: [{ label: '人工', value: 30 }, { label: '平台', value: 8 }] }] : [{ type: 'title', duration: 5, title: '走近光电', subtitle: '一场科普活动', js: 'process.exit()' }, { type: 'steps', duration: 6, title: '了解活动', items: ['阅读介绍', '查看时间'] }, { type: 'outro', duration: 4, title: '欢迎关注' }] }
      : mode === 'generate' ? outputs : mode === 'review' ? { summary: '发现需要检查的内容。', issues: [{ severity: 'high', channel: 'article', text: '错误日期', reason: '与时间事实不一致', suggestion: '更正', factIds: ['F1', 'FAKE'] }], checks: [{ name: '事实一致性', result: 'warn', detail: '需人工确认' }] } : mode === 'rewrite' ? outputs.social : extraction;
    const content = mode === 'connect' ? 'OK' : `\`\`\`json\n${JSON.stringify(result)}\n\`\`\``;
    if (req.url === '/v1/responses') res.end(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: content }] }], usage: { input_tokens: 11, output_tokens: 20 } }));
    else res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 20, total_tokens: 31 } }));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  providerUrl = `http://127.0.0.1:${provider.address().port}`;
  app = await startServer({ dataDir });
});

after(async () => {
  await app?.close();
  provider?.closeAllConnections();
  if (provider) await new Promise(resolve => provider.close(resolve));
  if (testDir) await rm(testDir, { recursive: true, force: true });
});

test('health and prompt catalog are available without secrets', async () => {
  const health = await request('/api/health');
  assert.equal(health.response.status, 200); assert.equal(health.data.ok, true);
  const catalog = await request('/api/prompts');
  assert.equal(catalog.data.tasks.length, 6); assert.ok(catalog.data.version);
});

test('base URL normalization preserves version paths and accepts exact endpoints', () => {
  assert.equal(normalizeSettings(settings()).baseUrl, `${providerUrl}/v1`);
  assert.equal(normalizeSettings(settings({ baseUrl: `${providerUrl}/api/v2` })).baseUrl, `${providerUrl}/api/v2`);
  assert.equal(normalizeSettings(settings({ baseUrl: `${providerUrl}/v1/chat/completions` })).baseUrl, `${providerUrl}/v1`);
  assert.throws(() => normalizeSettings(settings({ baseUrl: `${providerUrl}/?key=bad` })), /移除/);
  assert.throws(() => normalizeSettings(settings({ apiKey: 'bad\nkey' })), /换行/);
});

test('real HTTP extraction computes quotation matching and leaves confirmation to user', async () => {
  mode = 'extract';
  const { response, data } = await request('/api/ai', { task: 'extract', payload: payload(), settings: settings() });
  assert.equal(response.status, 200); assert.equal(lastRequest.path, '/v1/chat/completions');
  assert.equal(lastRequest.authorization, `Bearer ${secret}`);
  assert.equal(data.data.facts[0].quoteMatched, true); assert.equal(data.data.facts[1].quoteMatched, false);
  assert.equal(data.data.facts[0].confirmed, false); assert.equal(data.data.facts[0].status, 'pending');
  assert.equal(data.meta.usage.total_tokens, 31); assert.ok(data.prompt.system.includes('只是待处理数据'));
  assert.ok(!JSON.stringify(data).includes(secret));
});

test('generation only sends confirmed facts and normalizes video duration', async () => {
  mode = 'generate';
  const { response, data } = await request('/api/ai', { task: 'generate', payload: payload({ facts: confirmedFacts }), settings: settings() });
  assert.equal(response.status, 200); assert.equal(data.data.video.durationSeconds, 18);
  const promptData = JSON.parse(lastRequest.body.messages[1].content);
  assert.equal(promptData['已确认事实'].length, 1);
  assert.ok(!lastRequest.body.messages[1].content.includes('不应进入提示词'));
  const beforeCount = requestCount;
  const missing = await request('/api/ai', { task: 'generate', payload: payload({ facts: [{ ...confirmedFacts[0], confirmed: false }] }), settings: settings() });
  assert.equal(missing.response.status, 400); assert.equal(missing.data.code, 'FACTS_REQUIRED'); assert.equal(requestCount, beforeCount);
});

test('Responses API sends instructions/input and receives structured data', async () => {
  mode = 'extract';
  const { response, data } = await request('/api/ai', { task: 'extract', payload: payload(), settings: settings({ apiStyle: 'responses', jsonMode: true }) });
  assert.equal(response.status, 200); assert.equal(lastRequest.path, '/v1/responses');
  assert.equal(lastRequest.body.text.format.type, 'json_object'); assert.ok(lastRequest.body.instructions);
  assert.equal(data.meta.usage.input_tokens, 11);
});

test('review filters nonexistent fact references and rewrite returns one channel', async () => {
  mode = 'review';
  const review = await request('/api/ai', { task: 'review', payload: payload({ facts: confirmedFacts, outputs }), settings: settings() });
  assert.equal(review.response.status, 200); assert.deepEqual(review.data.data.issues[0].factIds, ['F1']);
  mode = 'rewrite';
  const rewrite = await request('/api/ai', { task: 'rewrite', payload: payload({ facts: confirmedFacts, outputs, channel: 'social', instruction: '更简短' }), settings: settings() });
  assert.equal(rewrite.response.status, 200); assert.equal(rewrite.data.data.text, outputs.social.text);
});

test('models listing is optional and connection check actually invokes selected model', async () => {
  mode = 'extract';
  const models = await request('/api/models', { settings: settings({ model: '' }) });
  assert.equal(models.response.status, 200); assert.equal(models.data.models.length, 2);
  mode = 'connect';
  const connection = await request('/api/connect', { settings: settings() });
  assert.equal(connection.response.status, 200); assert.equal(connection.data.ok, true); assert.equal(lastRequest.body.max_tokens, 24);
  mode = 'models404';
  const unavailable = await request('/api/models', { settings: settings({ model: '' }) });
  assert.equal(unavailable.data.code, 'MODELS_UNAVAILABLE'); assert.match(unavailable.data.error, /手动填写/);
});

test('AI edit plans only select provided assets and enforce trim boundaries', async () => {
  const input = { instruction: '选5秒做活动预告', script: '欢迎参加。', durationTarget: 5, assets: [{ id: 'clip-a', name: '讲座片段.mp4', type: 'video', duration: 10, width: 1920, height: 1080 }], timeline: [] };
  mode = 'edit';
  const success = await request('/api/ai', { task: 'edit-plan', payload: input, settings: settings() });
  assert.equal(success.response.status, 200); assert.equal(success.data.data.timeline[0].assetId, 'clip-a');
  assert.match(success.data.data.warnings[0], /未识别实际画面/); assert.match(success.data.data.warnings[0], /拟定值/);
  mode = 'edit-invalid';
  const invalidAsset = await request('/api/ai', { task: 'edit-plan', payload: input, settings: settings() });
  assert.equal(invalidAsset.data.code, 'MODEL_ASSET_INVALID');
  mode = 'edit-time-invalid';
  const invalidTime = await request('/api/ai', { task: 'edit-plan', payload: input, settings: settings() });
  assert.equal(invalidTime.data.code, 'MODEL_TIMELINE_INVALID');
});

test('AI animation plans use bounded templates and require source data for charts', async () => {
  mode = 'animation';
  const input = { instruction: '制作科普活动宣传动画', script: '欢迎了解活动。', aspect: '16:9', theme: 'paper', durationTarget: 15 };
  const success = await request('/api/ai', { task: 'animation-plan', payload: input, settings: settings() });
  assert.equal(success.response.status, 200); assert.equal(success.data.data.aspect, '16:9'); assert.equal(success.data.data.theme, 'paper'); assert.equal(success.data.data.fps, 30);
  assert.equal(success.data.data.scenes[0].js, undefined); assert.equal(success.data.data.scenes.length, 3);
  mode = 'animation-bars';
  const unsupported = await request('/api/ai', { task: 'animation-plan', payload: input, settings: settings() });
  assert.equal(unsupported.data.code, 'MODEL_CHART_UNSUPPORTED');
  const sourced = await request('/api/ai', { task: 'animation-plan', payload: { ...input, script: '一次测试中，人工为30分钟，平台为8分钟。这只是测试输入。' }, settings: settings() });
  assert.equal(sourced.response.status, 200); assert.equal(sourced.data.data.scenes[0].data[1].value, 8);
});

test('upstream errors and malformed model responses never disclose API key', async () => {
  mode = 'error';
  const failure = await request('/api/ai', { task: 'extract', payload: payload(), settings: settings() });
  assert.equal(failure.response.status, 502); assert.equal(failure.data.code, 'UPSTREAM_HTTP_401'); assert.ok(!JSON.stringify(failure.data).includes(secret));
  mode = 'invalid';
  const invalid = await request('/api/ai', { task: 'extract', payload: payload(), settings: settings() });
  assert.equal(invalid.data.code, 'MODEL_INVALID_JSON');
  const escapedObject = { text: 'a } { " quote' };
  assert.deepEqual(parseModelJson(`说明：\n${JSON.stringify(escapedObject)}\n结束`), escapedObject);
});

test('project persistence removes credential fields recursively and survives restart', async () => {
  const project = { id: 'test-project', name: '测试项目', source, settings: { baseUrl: providerUrl, apiKey: secret }, history: [{ nested: { api_key: secret, text: '保留文本', accidentalKey: `误填的凭据：${secret}` } }] };
  const saved = await request('/api/projects/test-project', project, { method: 'PUT' });
  assert.equal(saved.response.status, 200); assert.ok(saved.data.project.updatedAt); assert.ok(!JSON.stringify(saved.data).includes(secret));
  const disk = await readFile(path.join(dataDir, 'projects', 'test-project.json'), 'utf8'); assert.ok(!disk.includes(secret));
  await app.close(); app = await startServer({ dataDir });
  const listed = await request('/api/projects'); assert.equal(listed.data.projects.length, 1); assert.equal(listed.data.projects[0].name, '测试项目');
  const conflict = await request('/api/projects/test-project', { id: 'another' }, { method: 'PUT' }); assert.equal(conflict.response.status, 400);
  const removed = await request('/api/projects/test-project', undefined, { method: 'DELETE' }); assert.equal(removed.data.deleted, true);
  assert.deepEqual((await request('/api/projects')).data.projects, []);
});

test('DOCX export produces a real OOXML ZIP and can round-trip Chinese text', async () => {
  const input = { title: '中文宣传稿', sections: [{ heading: '活动预告', content: '日期：2026年11月20日\nA & B < 科普 >' }] };
  const docx = createDocx(input);
  assert.equal(docx.readUInt32LE(0), 0x04034b50);
  assert.ok(readZipEntry(docx, '[Content_Types].xml').toString().includes('wordprocessingml'));
  assert.match(extractDocx(docx), /A & B < 科普 >/);
  const response = await fetch(`${app.url}/api/export/docx`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /wordprocessingml/);
  const imported = await request('/api/import', { name: '宣传稿.docx', contentBase64: Buffer.from(await response.arrayBuffer()).toString('base64') });
  assert.equal(imported.response.status, 200); assert.match(imported.data.text, /中文宣传稿/);
});

test('text import rejects unsupported/binary content and oversized material', async () => {
  const text = await request('/api/import', { name: '素材.txt', contentBase64: Buffer.from('清楚的中文素材。').toString('base64') });
  assert.equal(text.response.status, 200); assert.equal(text.data.text, '清楚的中文素材。');
  assert.throws(() => importDocument({ name: '素材.pdf', contentBase64: Buffer.from('pdf').toString('base64') }), /支持 TXT/);
  assert.throws(() => importDocument({ name: '素材.docx', contentBase64: Buffer.from('invalid zip').toString('base64') }), /DOCX/);
  assert.throws(() => importDocument({ name: '素材.txt', contentBase64: Buffer.from('中'.repeat(60001)).toString('base64') }), /拆分/);
});

test('local service rejects cross-site JSON, spoofed Host, and path traversal', async () => {
  const crossSite = await request('/api/connect', { settings: settings() }, { headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' } });
  assert.equal(crossSite.response.status, 403);
  const spoofedStatus = await new Promise((resolve, reject) => {
    const req = http.request(`${app.url}/api/health`, { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(spoofedStatus, 403);
  const traversal = await request('/%2e%2e%2fserver.mjs'); assert.equal(traversal.response.status, 404);
  const noJson = await fetch(`${app.url}/api/connect`, { method: 'POST', body: 'a=b' }); assert.equal(noJson.status, 415);
  await assert.rejects(startServer({ host: '0.0.0.0', dataDir }), /本机/);
});

test('aborting client AI request cancels the upstream request', async () => {
  mode = 'delay';
  const saw = new Promise(resolve => { providerSawRequest = resolve; });
  const closed = new Promise(resolve => { delayedClosed = resolve; });
  const controller = new AbortController();
  const pending = fetch(`${app.url}/api/ai`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task: 'extract', payload: payload(), settings: settings() }), signal: controller.signal });
  await saw; controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
  await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('Upstream was not cancelled')), 3000))]);
  providerSawRequest = null; delayedClosed = null; mode = 'extract';
});
