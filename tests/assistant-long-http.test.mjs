import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { startServer } from '../server.mjs';

test('real assistant HTTP automatically continues 32 committed operations in one run and preserves reverse undo', { timeout: 60000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gx-assistant-long-http-'));
  let modelCalls = 0;
  const requestLengths = [];
  const provider = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw), user = body.messages[1].content;
    requestLengths.push(user.length); modelCalls++;
    const answer = modelCalls <= 32 ? { type: 'tool', tool: 'project_update', arguments: { title: modelCalls === 32 ? '长任务已完成' : '阶段' + modelCalls }, summary: '保存阶段' + modelCalls } : { type: 'final', message: '32个阶段均已完成并保存。', sourceIds: [] };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(answer) } }] }));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const app = await startServer({ port: 0, dataDir: directory });
  t.after(async () => {
    await app.close(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
    if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('gx-assistant-long-http-')) throw new Error('Unsafe test cleanup');
    await rm(directory, { recursive: true, force: true });
  });
  async function api(route, input, method = input === undefined ? 'GET' : 'POST') {
    const response = await fetch(app.url + route, { method, ...(input === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }) });
    const body = await response.json(); assert.ok(response.ok, JSON.stringify(body)); return body;
  }
  const { project: before } = await api('/api/projects/long-project', { kind: 'writing', title: '初始项目', source: { text: '分阶段处理的真实项目内容。' } }, 'PUT');
  const settings = { baseUrl: 'http://127.0.0.1:' + provider.address().port, apiKey: 'fixture-no-user-key', model: 'long-fixture' };
  const started = await api('/api/assistant/runs', { projectId: before.id, instruction: '按32个阶段逐步更新并保存项目资料，最后把标题改为长任务已完成', settings });
  let job;
  const observedIds = new Set();
  for (let count = 0; count < 1000; count++) {
    ({ job } = await api('/api/assistant/runs/' + started.runId)); observedIds.add(job.id);
    if (['completed', 'failed', 'cancelled'].includes(job.status)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(job.status, 'completed', JSON.stringify(job)); assert.equal(job.id, started.runId);
  assert.equal(observedIds.size, 1); assert.equal(job.totalToolCalls, 32); assert.equal(job.totalModelCalls, 33);
  assert.ok(job.batch >= 4); assert.equal(job.effects.length, 32); assert.equal(modelCalls, 33);
  assert.ok(requestLengths.every(length => length <= 170000));
  const { project: after } = await api('/api/projects/' + before.id);
  assert.equal(after.title, '长任务已完成'); assert.equal(after.assistantRevision, 32);
  for (const effect of job.effects.toReversed()) await api('/api/assistant/undo', { projectId: before.id, undoId: effect.undo.id });
  assert.equal((await api('/api/projects/' + before.id)).project.title, before.title);
  const saved = await readFile(path.join(directory, 'assistant/runs.json'), 'utf8');
  assert.ok(!saved.includes(settings.apiKey)); assert.ok(!saved.includes(settings.baseUrl));
  assert.equal((await api('/api/assistant/runs')).jobs.filter(item => item.id === started.runId).length, 1);
});
