import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createAssistantAgentService } from '../lib/assistant-agent.mjs';
import { resolveAssistantScope } from '../lib/assistant-permissions.mjs';
import { AppError } from '../lib/errors.mjs';

const KEY = 'fixture-long-task-private-key-123456';
const settings = { baseUrl: 'http://127.0.0.1:1/v1', apiKey: KEY, model: 'fixture', timeoutSeconds: 10 };
const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t, responder) {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'gx-assistant-long-')), services = [], requests = [];
  let server;
  if (responder) {
    server = http.createServer(async (req, res) => {
      try {
        const body = JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString());
        const entry = { body, context: JSON.parse(body.messages[1].content), req, res }; requests.push(entry);
        const result = await responder(entry, requests.length - 1);
        if (result === undefined || res.destroyed) return;
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] }));
      } catch (error) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'controlled fixture failed', message: error.message })); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  }
  t.after(async () => { for (const service of services) await service.close(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } assert.equal(path.dirname(folder), os.tmpdir()); await rm(folder, { recursive: true, force: true }); });
  return { folder, requests, settings: { ...settings, ...(server ? { baseUrl: `http://127.0.0.1:${server.address().port}/v1` } : {}) }, service(options = {}) { const value = createAssistantAgentService({ dataDir: folder, ...options }); services.push(value); return value; } };
}
async function finish(service, id) { for (let n = 0; n < 2000; n++) { const job = await service.get(id); if (terminal.has(job.status)) return job; await pause(5); } throw new Error('long assistant fixture did not finish'); }

test('45 real HTTP tool steps cross automatic batches with bounded rolling input, old IDs/URLs and large restart receipts intact', async t => {
  const instruction = '只使用当前所选素材生成45条不同记录，最后核对第1条编号与早期来源。';
  const editScope = { assetIds: ['selected-asset'], placement: { mode: 'append' } }, executed = [], webReads = [];
  const f = await fixture(t, ({ context, body }) => {
    assert.equal(context.request, instruction); assert.deepEqual(context.editScope, editScope); assert.deepEqual(context.uiSelection, editScope); assert.equal(context.scopeAuthority, 'dialog'); assert.equal(context.remainingSteps, null);
    assert.ok(body.messages[0].content.length + body.messages[1].content.length <= 170000);
    const calls = context.progress.totalToolCalls;
    if (calls > 10 && calls < 45) assert.equal(context.observations.at(-1).result.data.index, calls - 1, 'Recent real results stay available after cumulative data exceeds 80k');
    if (calls < 45) return { type: 'tool', tool: 'write_record', arguments: { index: calls }, summary: '保存第' + (calls + 1) + '条记录' };
    if (calls === 45) return { type: 'tool', tool: 'assistant_recall', arguments: { fromStep: 1, limit: 1 }, summary: '核对最早的真实编号' };
    if (calls === 46) {
      const recall = context.observations.at(-1).result.data.records[0]; assert.equal(recall.step, 1); assert.ok(recall.keys.some(fact => fact.value === 'record-0'));
      return { type: 'tool', tool: 'web_read', arguments: { url: 'https://sources.example/item/0' }, summary: '重新核对早期真实来源' };
    }
    return { type: 'final', message: '45条记录已完成，并已核对最早与最后来源。[S1] [S45]', sourceIds: [] };
  });
  const service = f.service({ buildContext: async ctx => { const chosen = resolveAssistantScope({ instruction: ctx.instruction, uiScope: ctx.editScope, authority: ctx.scopeAuthority }); assert.equal(chosen.authority, 'dialog-selection'); return { text: '大型原始项目资料。'.repeat(6000), editScope: chosen.scope }; }, webTools: { search: async () => ({ results: [] }), read: async url => { webReads.push(url); return { title: '早期真实来源', url, text: '已核对原始来源。' }; } }, appTools: [{ name: 'write_record', description: '保存指定记录', mutating: true, inputSchema: { type: 'object', additionalProperties: false, required: ['index'], properties: { index: { type: 'integer' } } }, execute: async ({ index }, ctx) => {
    assert.equal(ctx.instruction, instruction); assert.deepEqual(ctx.editScope, editScope); executed.push(index);
    return { summary: '已保存记录' + index, data: { index, text: '真实工具结果。'.repeat(1900), id: 'record-' + index }, sources: [{ title: '来源' + index, url: 'https://sources.example/item/' + index }], effects: [{ type: 'project', projectId: 'long-project', changed: true, label: '记录' + index, undo: { kind: 'record', id: 'receipt-' + index }, note: '安全收据说明。'.repeat(200) }] };
  } }] });
  const { runId } = await service.start({ projectId: 'long-project', instruction, editScope, settings: f.settings, history: Array.from({ length: 10 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: '此前已授权内容。'.repeat(500) })) });
  const job = await finish(service, runId);
  assert.equal(job.status, 'completed', JSON.stringify(job)); assert.deepEqual(executed, Array.from({ length: 45 }, (_, index) => index));
  assert.equal(job.totalToolCalls, 47); assert.equal(job.totalModelCalls, 48); assert.equal(job.batch, 6); assert.equal(f.requests.length, 48);
  assert.equal(job.sources.length, 45); assert.equal(job.sources.at(-1).id, 'S45'); assert.deepEqual(webReads, ['https://sources.example/item/0']);
  assert.equal(job.effects.length, 45); assert.ok(f.requests.some(request => request.context.previousResults.length > 0));
  assert.ok(f.requests.every(request => request.context.observations.length <= 6));
  await service.close();
  const saved = await readFile(path.join(f.folder, 'assistant', 'runs.json'), 'utf8'); assert.ok(saved.length > 80000); assert.ok(!saved.includes(KEY));
  const restored = await f.service().get(runId); assert.equal(restored.id, runId); assert.equal(restored.status, 'completed'); assert.equal(restored.effects.length, 45); assert.equal(restored.effects[0].undo.id, 'receipt-0'); assert.equal(restored.sources.length, 45); assert.equal(restored.totalToolCalls, 47);
});

test('120 distinct meaningful tool operations retain only the last 200 logs with correct lifetime counters', async t => {
  const f = await fixture(t); let performed = 0;
  const service = f.service({ maxSteps: 130, modelStep: async (_system, user) => { const context = JSON.parse(user); return { data: context.progress.totalToolCalls < 120 ? { type: 'tool', tool: 'read_page', arguments: { page: context.progress.totalToolCalls }, summary: '读取下一页' } : { type: 'final', message: '已完成120页。', sourceIds: [] } }; }, appTools: [{ name: 'read_page', description: '分页读取', execute: async ({ page }) => { performed++; return { summary: '页' + page, data: { page, id: 'page-' + page } }; } }] });
  const { runId } = await service.start({ instruction: '逐页读取120页资料', settings: f.settings }); const job = await finish(service, runId);
  assert.equal(job.status, 'completed'); assert.equal(performed, 120); assert.equal(job.totalToolCalls, 120); assert.equal(job.totalModelCalls, 121);
  assert.equal(job.steps.length, 200); assert.equal(job.compactedSteps, 41); assert.equal(job.batch, 16);
  await service.close(); const restored = await f.service().get(runId); assert.equal(restored.steps.length, 200); assert.equal(restored.compactedSteps, 41); assert.equal(restored.totalToolCalls, 120);
});

test('same arguments with genuinely new result data continue beyond 30 operations', async t => {
  const f = await fixture(t); let pages = 0;
  const service = f.service({ modelStep: async () => ({ data: pages < 35 ? { type: 'tool', tool: 'next', arguments: {}, summary: '读取下一条实际结果' } : { type: 'final', message: '新结果已读取。', sourceIds: [] } }), appTools: [{ name: 'next', description: '读取下一条', execute: async () => ({ data: { id: 'result-' + pages, content: '真实新内容' + pages++ }, retrievedAt: new Date().toISOString() }) }] });
  const started = await service.start({ instruction: '连续读取新结果', settings: f.settings }); const job = await finish(service, started.runId);
  assert.equal(job.status, 'completed'); assert.equal(pages, 35); assert.equal(job.totalToolCalls, 35);
});

test('Stop after several batches aborts the real waiting model connection and keeps completed receipts', async t => {
  let waiting = false, disconnected = false, writes = 0;
  const f = await fixture(t, ({ context, res }) => {
    if (context.progress.totalToolCalls >= 18) { waiting = true; res.on('close', () => { disconnected = true; }); return undefined; }
    return { type: 'tool', tool: 'save_one', arguments: { index: context.progress.totalToolCalls }, summary: '保存下一条' };
  });
  const service = f.service({ appTools: [{ name: 'save_one', description: '保存', mutating: true, execute: async ({ index }) => { writes++; return { data: { index }, effects: [{ type: 'project', label: '记录' + index, undo: { id: 'undo-' + index } }] }; } }] });
  const started = await service.start({ instruction: '请保存多条记录', settings: f.settings });
  for (let n = 0; n < 1000 && !waiting; n++) await pause(5); assert.equal(waiting, true);
  const job = await service.cancel(started.runId); assert.equal(job.status, 'cancelled'); assert.equal(job.totalToolCalls, 18); assert.equal(writes, 18); assert.equal(job.effects.length, 18); assert.ok(job.batch > 1);
  for (let n = 0; n < 100 && !disconnected; n++) await pause(5); assert.equal(disconnected, true);
});

test('volatile timestamps, revision counters and new undo UUIDs cannot fake progress; strategy warning precedes stopping', async t => {
  const f = await fixture(t); let calls = 0, warned = false;
  const service = f.service({ modelStep: async (_system, user) => { const context = JSON.parse(user); if (context.progress.notice.includes('请改变')) warned = true; return { data: { type: 'tool', tool: 'same_write', arguments: calls % 2 ? { a: 1, b: 2 } : { b: 2, a: 1 }, summary: '重复相同修改' } }; }, appTools: [{ name: 'same_write', description: '修改', mutating: true, execute: async () => ({ summary: '已处理', retrievedAt: new Date(Date.now() + calls).toISOString(), updatedAt: String(calls), data: { assistantRevision: ++calls }, effects: [{ type: 'project', changed: true, label: '同一标题', undo: { id: randomUUID() } }] }) }] });
  const started = await service.start({ instruction: '修改同一标题', settings: f.settings }); const job = await finish(service, started.runId);
  assert.equal(job.status, 'failed'); assert.equal(job.error.code, 'ASSISTANT_NO_PROGRESS'); assert.equal(calls, 6); assert.equal(warned, true); assert.equal(job.effects.length, 6);
});

test('alternating repeated tool outcomes and eight consecutive distinct failures stop safely', async t => {
  for (const failure of [false, true]) {
    const f = await fixture(t); let calls = 0, warned = false;
    const service = f.service({ modelStep: async (_system, user) => { const context = JSON.parse(user); if (context.progress.notice.includes('请改变')) warned = true; const index = context.progress.totalToolCalls; return { data: { type: 'tool', tool: failure ? 'bad' : index % 2 ? 'b' : 'a', arguments: failure ? { index } : {}, summary: '尝试下一步' } }; }, appTools: (failure ? ['bad'] : ['a', 'b']).map(name => ({ name, description: '测试', execute: async () => { calls++; if (failure) throw new AppError(422, '真实工具失败', 'FIXTURE_TOOL_FAILED'); return { data: { value: '同一结果' }, retrievedAt: randomUUID() }; } })) });
    const started = await service.start({ instruction: '读取所需信息', settings: f.settings }); const job = await finish(service, started.runId);
    assert.equal(job.status, 'failed'); assert.equal(job.error.code, 'ASSISTANT_NO_PROGRESS'); assert.equal(warned, true);
    assert.equal(calls, failure ? 8 : 7);
  }
});

test('explicit construction limits still apply beyond the former twelve-step ceiling', async t => {
  const f = await fixture(t); let calls = 0;
  const service = f.service({ maxSteps: 25, modelStep: async () => ({ data: { type: 'tool', tool: 'read', arguments: { index: calls }, summary: '读取不同记录' } }), appTools: [{ name: 'read', description: '读', execute: async () => ({ data: { index: calls++ } }) }] });
  const started = await service.start({ instruction: '读取数据', settings: f.settings }); const job = await finish(service, started.runId);
  assert.equal(job.status, 'failed'); assert.equal(job.error.code, 'ASSISTANT_STEP_LIMIT'); assert.equal(calls, 25); assert.equal(job.totalModelCalls, 25);
});

test('changing empty recall queries cannot manufacture progress or recursively expand task memory', async t => {
  const f = await fixture(t); let models = 0;
  const service = f.service({ modelStep: async (_system, user) => {
    const context = JSON.parse(user); models++;
    return { data: { type: 'tool', tool: 'assistant_recall', arguments: { query: 'missing-' + context.progress.totalToolCalls }, summary: '查找一个不存在的编号' } };
  } });
  const started = await service.start({ instruction: '查找之前的记录', settings: f.settings }); const job = await finish(service, started.runId);
  assert.equal(job.status, 'failed'); assert.equal(job.error.code, 'ASSISTANT_NO_PROGRESS'); assert.equal(models, 6); assert.equal(job.totalToolCalls, 6);
});

test('a large persisted active job restores independently bounded fields without losing identity or receipt IDs', async t => {
  const f = await fixture(t), id = randomUUID(), stamp = new Date().toISOString();
  await mkdir(path.join(f.folder, 'assistant'), { recursive: true });
  const input = { id, runId: id, projectId: null, status: 'running', instruction: '长任务', message: '已完成部分结果。'.repeat(4000), mode: 'auto', createdAt: stamp, updatedAt: stamp, totalToolCalls: 120, totalModelCalls: 120, batch: 15, compactedSteps: 0,
    steps: Array.from({ length: 240 }, (_, index) => ({ id: 'step-' + index, type: index % 2 ? 'tool' : 'model', label: '日志'.repeat(100), message: '安全日志'.repeat(100), status: index === 239 ? 'running' : 'completed', startedAt: stamp })),
    effects: Array.from({ length: 60 }, (_, index) => ({ type: 'project', label: '已保存' + index, note: '较长的安全收据说明。'.repeat(180), undo: { id: 'receipt-' + index } })),
    sources: Array.from({ length: 60 }, (_, index) => ({ id: 'S' + (index + 1), title: '真实来源' + index, url: 'https://sources.example/' + 'a'.repeat(1600) + '/' + index })),
  };
  await writeFile(path.join(f.folder, 'assistant', 'runs.json'), JSON.stringify({ version: 1, jobs: [input] }));
  const service = f.service(), job = await service.get(id);
  assert.equal(job.id, id); assert.equal(job.status, 'interrupted'); assert.equal(job.error.code, 'ASSISTANT_INTERRUPTED'); assert.equal(job.steps.length, 200); assert.equal(job.compactedSteps, 40);
  assert.equal(job.effects.length, 60); assert.equal(job.effects.at(-1).undo.id, 'receipt-59'); assert.equal(job.sources.length, 60); assert.equal(job.sources.at(-1).id, 'S60');
  assert.equal(job.totalToolCalls, 120); assert.equal(job.message.length, 24000); await service.close();
  const persisted = JSON.parse(await readFile(path.join(f.folder, 'assistant', 'runs.json'))).jobs[0]; assert.equal(persisted.id, id); assert.equal(persisted.status, 'interrupted');
});

test('an older active run cannot be evicted by more than eighty newer completed runs', async t => {
  const f = await fixture(t); let entered = false;
  const service = f.service({ modelStep: async (_system, user, _settings, { signal }) => {
    if (JSON.parse(user).request === '长期等待') { entered = true; await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); }
    return { data: { type: 'final', message: '完成', sourceIds: [] } };
  } });
  const long = await service.start({ instruction: '长期等待', settings: f.settings }); for (let n = 0; n < 100 && !entered; n++) await pause(5);
  for (let index = 0; index < 81; index++) { const short = await service.start({ instruction: '短任务' + index, settings: f.settings }); await finish(service, short.runId); }
  const saved = JSON.parse(await readFile(path.join(f.folder, 'assistant', 'runs.json'))).jobs;
  assert.ok(saved.some(job => job.id === long.runId && job.status === 'running')); assert.ok((await service.list()).length <= 80);
  assert.equal((await service.cancel(long.runId)).status, 'cancelled');
});
