import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { startServer } from '../server.mjs';

const KEY = 'sk-assistant-http-isolated-fixture-123456';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t, responder) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'gx-assistant-http-'));
  const calls = [];
  const provider = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); calls.push({ req, res, body });
    const answer = await responder(body, calls.length - 1, req, res);
    if (answer === undefined || res.destroyed) return;
    res.writeHead(200, { 'content-type': 'application/json' });
    const content = JSON.stringify(answer);
    res.end(JSON.stringify(req.url.endsWith('/responses') ? { output: [{ content: [{ type: 'output_text', text: content }] }] } : { choices: [{ finish_reason: 'stop', message: { content } }] }));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const app = await startServer({ port: 0, dataDir });
  t.after(async () => {
    await app.close(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
    if (path.dirname(path.resolve(dataDir)) !== path.resolve(os.tmpdir()) || !path.basename(dataDir).startsWith('gx-assistant-http-')) throw new Error('Unsafe test cleanup');
    await rm(dataDir, { recursive: true, force: true });
  });
  const settings = { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: KEY, model: 'http-fixture' };
  async function request(url, body, method = body === undefined ? 'GET' : 'POST', headers = {}) {
    const response = await fetch(app.url + url, { method, headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  }
  async function finish(id) {
    for (let index = 0; index < 600; index++) {
      const { data: { job } } = await request('/api/assistant/runs/' + id);
      if (['completed', 'failed', 'cancelled', 'interrupted'].includes(job?.status)) return job;
      await pause(10);
    }
    throw new Error('HTTP assistant did not settle');
  }
  return { app, calls, dataDir, settings, request, finish };
}
const createWriting = (fx, id = 'writing-fixture') => fx.request('/api/projects/' + id, { id, title: '材料项目', kind: 'writing', source: { title: '原始材料', text: '讲座定于周五举行，主题是实验设计。', url: '' }, facts: [], outputs: null }, 'PUT');

test('real assistant HTTP writes a scoped draft, tracks the run and rejects old autosaves; undo restores null outputs', async t => {
  const sequence = [
    { type: 'tool', tool: 'project_read', arguments: {}, summary: '查看项目材料' },
    { type: 'tool', tool: 'draft_write', arguments: { channel: 'social', content: { title: '实验设计讲座', text: '周五一起学习实验设计。', tags: ['实验设计'] } }, summary: '保存社群草稿' },
    { type: 'final', message: '已根据材料保存社群草稿，可以继续修改。', sourceIds: [] },
  ];
  const fx = await fixture(t, (_body, i) => sequence[i]);
  const original = (await createWriting(fx)).data.project;
  const started = await fx.request('/api/assistant/runs', { projectId: original.id, instruction: '根据当前材料生成社群文案并保存', settings: fx.settings });
  assert.equal(started.status, 202); assert.ok(started.data.runId);
  const job = await fx.finish(started.data.runId);
  assert.equal(job.status, 'completed', JSON.stringify(job)); assert.equal(job.effects.length, 1);
  assert.equal(job.steps.filter(step => step.type === 'tool').length, 2);
  const next = (await fx.request('/api/projects/' + original.id)).data.project;
  assert.equal(next.outputs.social.text, '周五一起学习实验设计。'); assert.equal(next.assistantRevision, 1);
  const stale = await fx.request('/api/projects/' + original.id, original, 'PUT');
  assert.equal(stale.status, 409); assert.equal(stale.data.code, 'ASSISTANT_STALE_PROJECT');
  let task;
  for (let i = 0; i < 80; i++) { task = (await fx.request('/api/tasks')).data.items.find(task => task.sourceJobId === job.id); if (task?.status === 'succeeded') break; await pause(10); }
  assert.equal(task.type, 'assistant'); assert.equal(task.status, 'succeeded'); assert.equal(task.projectId, original.id);
  const undone = await fx.request('/api/assistant/undo', { projectId: original.id, undoId: job.effects[0].undo.id });
  assert.equal(undone.status, 200); assert.equal(undone.data.restored, true); assert.equal(undone.data.project.outputs, null);
  assert.equal((await fx.request('/api/assistant/undo', { projectId: original.id, undoId: job.effects[0].undo.id })).status, 410);
  const persisted = await readFile(path.join(fx.dataDir, 'assistant', 'runs.json'), 'utf8');
  assert.ok(!persisted.includes(KEY)); assert.ok(!persisted.includes('讲座定于周五举行'));
  const sent = JSON.parse(fx.calls[0].body.messages[1].content);
  assert.equal(sent.projectContext.id, original.id); assert.ok(sent.tools.some(tool => tool.name === 'web_search'));
});

test('real HTTP no-project ask works through Responses without creating a project or permitting writes', async t => {
  const fx = await fixture(t, body => {
    const sent = JSON.parse(body.input);
    assert.ok(sent.tools.some(tool => tool.name === 'web_read'));
    assert.ok(!sent.tools.some(tool => tool.mutating));
    return { type: 'final', message: '可以搜索公开资料，也可以在打开项目后处理文案和剪辑。', sourceIds: [] };
  });
  const start = await fx.request('/api/assistant/runs', { instruction: '这个软件支持生成文案吗', mode: 'ask', settings: { ...fx.settings, apiStyle: 'responses' } });
  const job = await fx.finish(start.data.runId);
  assert.equal(job.status, 'completed', JSON.stringify(job)); assert.equal(job.projectId, null);
  assert.equal((await fx.request('/api/projects')).data.projects.length, 0);
  assert.equal((await fx.request('/api/assistant/runs')).data.jobs[0].id, job.id);
});

test('task-centre cancellation stops the actual background assistant provider request', async t => {
  let connected = false, disconnected = false;
  const fx = await fixture(t, async (_body, _i, _req, res) => { connected = true; res.once('close', () => { disconnected = true; }); });
  const started = await fx.request('/api/assistant/runs', { instruction: '请联网整理实验设计资料', settings: fx.settings });
  let task;
  for (let i = 0; i < 100; i++) { task = (await fx.request('/api/tasks')).data.items.find(task => task.sourceJobId === started.data.runId); if (task?.canCancel && connected) break; await pause(10); }
  assert.equal(connected, true); assert.equal(task.canCancel, true);
  const cancelled = await fx.request('/api/tasks/' + task.id + '/cancel', {});
  assert.equal(cancelled.status, 200); assert.equal((await fx.finish(started.data.runId)).status, 'cancelled');
  for (let i = 0; i < 40 && !disconnected; i++) await pause(10);
  assert.equal(disconnected, true);
});

test('assistant HTTP keeps origin, project and undo ownership checks in force', async t => {
  const fx = await fixture(t, () => ({ type: 'final', message: '完成', sourceIds: [] }));
  assert.equal((await fx.request('/api/assistant/runs', { projectId: '../private', instruction: '读取项目', settings: fx.settings })).status, 400);
  assert.equal((await fx.request('/api/assistant/runs', { projectId: 'missing', instruction: '读取项目', settings: fx.settings })).status, 404);
  assert.equal((await fx.request('/api/assistant/runs', { instruction: '联网问答', settings: fx.settings }, 'POST', { origin: 'https://other.invalid' })).status, 403);
  assert.equal((await fx.request('/api/assistant/undo', { projectId: 'missing', undoId: '../../secret' })).status, 400);
  assert.equal(fx.calls.length, 0);
});
