import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import { createAssistantAgentService } from '../lib/assistant-agent.mjs';
import { assistantModelRetry } from '../lib/assistant-autonomy.mjs';
const final = { type: 'final', message: '任务已按原要求完成。', sourceIds: [] };
const change = { type: 'tool', tool: 'commit_fixture', arguments: {}, summary: '保存本次修改' };
async function fixture(t, respond) {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'gx-autonomy-')), requests = []; let writes = 0;
  const server = http.createServer(async (req, res) => {
    const body = JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString()); requests.push(JSON.parse(body.messages[1].content));
    const value = respond(requests.length - 1);
    res.writeHead(value.status || 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value.status ? { error: 'controlled transient service' } : { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const service = createAssistantAgentService({ dataDir: folder, appTools: [{ name: 'commit_fixture', description: '保存隔离修改', mutating: true, execute: async () => { writes++; return { summary: '隔离修改已保存', effects: [{ type: 'project', changed: true }] }; } }] });
  t.after(async () => { await service.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); assert.equal(path.dirname(folder), path.resolve(os.tmpdir())); await rm(folder, { force: true, recursive: true }); });
  const { runId } = await service.start({ projectId: 'owned-fixture', instruction: '修改当前项目标题并保存', settings: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'local-http-only', apiKey: 'fixture-not-real' } });
  const finish = async () => { for (let i = 0; i < 1000; i++) { const job = await service.get(runId); if (['completed', 'failed', 'cancelled'].includes(job.status)) return job; await pause(5); } throw Error('Fixture timeout'); };
  return { service, runId, finish, requests, writes: () => writes };
}
test('a transient model HTTP failure resumes the same task input without replaying a committed edit', async t => {
  const f = await fixture(t, index => index === 0 ? change : index === 1 ? { status: 503 } : final), job = await f.finish();
  assert.equal(job.status, 'completed'); assert.equal(f.writes(), 1); assert.equal(f.requests.length, 3);
  const normalize = value => ({ ...value, progress: { ...value.progress, totalModelCalls: 0 } });
  assert.deepEqual(normalize(f.requests[1]), normalize(f.requests[2])); assert.equal(job.totalToolCalls, 1); assert.equal(job.totalModelCalls, 3); assert.equal(job.transientRecovery.attempt, 1);
});
test('persistent transient failures stop after bounded retry with the real error and original goal intact', async t => {
  const f = await fixture(t, () => ({ status: 504 })), job = await f.finish();
  assert.equal(job.status, 'failed'); assert.equal(job.error.code, 'UPSTREAM_HTTP_504'); assert.equal(f.requests.length, 3); assert.equal(f.writes(), 0); assert.match(job.instruction, /修改当前项目标题/);
});
test('authentication and configuration failures are not blindly retried', async t => {
  const f = await fixture(t, () => ({ status: 401 })), job = await f.finish();
  assert.equal(job.error.code, 'UPSTREAM_HTTP_401'); assert.equal(f.requests.length, 1); assert.equal(job.transientRecovery, undefined);
  assert.equal(assistantModelRetry({ code: 'MODEL_OUTPUT_TRUNCATED' }), null); assert.equal(assistantModelRetry({ code: 'REFERENCE_VISION_REJECTED' }), null);
});
test('Stop during model retry backoff ends the same run before another request or write', async t => {
  const f = await fixture(t, () => ({ status: 503 }));
  while (!f.requests.length) await pause(5); const job = await f.service.cancel(f.runId);
  assert.equal(job.status, 'cancelled'); assert.equal(f.requests.length, 1); assert.equal(f.writes(), 0);
});
test('optional oversized checkpoints disable resume without interrupting a normally progressing task', async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'gx-autonomy-capacity-')); let models = 0, writes = 0;
  const { AppError } = await import('../lib/errors.mjs');
  const service = createAssistantAgentService({ dataDir: folder, checkpoint: () => { throw new AppError(413, '恢复容量不足', 'ASSISTANT_CHECKPOINT_TOO_LARGE'); }, appTools: [{ name: 'commit_fixture', mutating: true, description: '保存隔离内容', execute: () => { writes++; return { effects: [{ type: 'project', changed: true }] }; } }], modelStep: () => ({ data: ++models === 1 ? change : final }) });
  t.after(async () => { await service.close(); await rm(folder, { recursive: true, force: true }); });
  const started = await service.start({ projectId: 'owned-fixture', instruction: '修改并保存项目', settings: { baseUrl: 'https://unused.invalid', model: 'injected', apiKey: 'fixture-only' } });
  for (;;) { const job = await service.get(started.runId); if (['completed', 'failed'].includes(job.status)) { assert.equal(job.status, 'completed'); assert.equal(writes, 1); assert.equal(job.resumable, false); break; } await pause(5); }
});
