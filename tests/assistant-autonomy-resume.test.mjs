import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import { AppError } from '../lib/errors.mjs';
import { createAssistantAgentService } from '../lib/assistant-agent.mjs';
const settings = { baseUrl: 'https://never-called.invalid/v1', apiKey: 'SECRET-RESUME-FIXTURE', model: 'injected-no-network' };
const finish = async (service, id) => { for (let n = 0; n < 600; n++) { const job = await service.get(id); if (['completed', 'failed', 'cancelled', 'interrupted'].includes(job.status)) return job; await pause(5); } throw Error('resume timeout'); };
const until = async predicate => { while (!(await predicate())) await pause(5); };
async function fixture(t, pendingWrite = false) {
  const base = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'gx-autonomy-resume-')); let writes = 0, modelCalls = 0, currentHash = 'hash-0';
  const services = [], inputs = [];
  const tool = { name: 'commit_fixture', description: '改隔离目标', mutating: true, execute: async (_args, ctx) => {
    if (pendingWrite) return new Promise((_resolve, reject) => ctx.signal.addEventListener('abort', () => reject(new AppError(499, '中断', 'REQUEST_CANCELLED')), { once: true }));
    writes++; currentHash = 'hash-' + writes; return { summary: '隔离目标已更改', effects: [{ type: 'project', changed: true }] };
  } };
  function make(resuming = false, conflict = false) {
    const service = createAssistantAgentService({ dataDir: directory, appTools: [tool], checkpoint: ctx => ({ v: 1, runId: ctx.runId, projectId: ctx.projectId, createdAt: 'stable-owner', projectHash: currentHash, completedReceipts: [{ private: true, apiKey: settings.apiKey }] }), restoreCheckpoint: (_ctx, proof) => {
      if (conflict || proof.projectHash !== currentHash) throw new AppError(409, '工程已有其它修改', 'ASSISTANT_CONFLICT'); return { reconciled: false };
    }, modelStep: async (_system, user) => {
      inputs.push(JSON.parse(user)); modelCalls++;
      if (resuming) return { data: { type: 'final', message: '沿用已完成修改并结束原任务', sourceIds: [] } };
      if (modelCalls === 1) return { data: { type: 'tool', tool: 'commit_fixture', arguments: {}, summary: '保存修改' } };
      return new Promise(() => {});
    } }); services.push(service); return service;
  }
  t.after(async () => { await Promise.all(services.map(service => service.close())); assert.equal(path.dirname(directory), base); await rm(directory, { force: true, recursive: true }); });
  return { directory, make, inputs, writes: () => writes, calls: () => modelCalls };
}
test('service interruption resumes the same run with its original goal and receipts without replaying a write', async t => {
  const f = await fixture(t), first = f.make(); const { runId } = await first.start({ projectId: 'owned-project', instruction: '修改标题并保存', settings });
  await until(() => f.calls() >= 2); await first.close(); assert.equal((await first.get(runId)).status, 'interrupted');
  const stored = await readFile(path.join(f.directory, 'assistant/runs.json'), 'utf8'); assert.ok(!stored.includes(settings.apiKey)); assert.ok(stored.includes('resumeProof'));
  const next = f.make(true), before = await next.get(runId); assert.equal(before.resumable, true); assert.equal(before.resumeProof, undefined);
  await next.resume(runId, { settings }); const job = await finish(next, runId);
  assert.equal(job.status, 'completed', JSON.stringify(job)); assert.equal(f.writes(), 1); assert.equal(job.resumeCount, 1); assert.equal(job.totalToolCalls, 1); assert.equal(job.resumeProof, undefined); assert.equal(f.inputs.at(-1).request, '修改标题并保存');
});
test('an unconfirmed mutating operation is not replayed after restart', async t => {
  const f = await fixture(t, true), first = f.make(); const { runId } = await first.start({ projectId: 'owned-project', instruction: '修改标题', settings });
  await until(() => f.calls() >= 1); await pause(10); await first.close();
  const next = f.make(true); await next.resume(runId, { settings }); const job = await finish(next, runId);
  assert.equal(job.error.code, 'ASSISTANT_UNCONFIRMED_OPERATION'); assert.equal(f.writes(), 0); assert.equal(f.calls(), 1);
});
test('changed owner/content and explicit user stop block automatic continuation', async t => {
  const f = await fixture(t), first = f.make(); const { runId } = await first.start({ projectId: 'owned-project', instruction: '修改标题', settings });
  await until(() => f.calls() >= 2); await first.close(); const next = f.make(true, true); await next.resume(runId, { settings });
  assert.equal((await finish(next, runId)).error.code, 'ASSISTANT_CONFLICT'); assert.equal(f.writes(), 1);
  const g = await fixture(t), stopService = g.make(); const stopped = await stopService.start({ projectId: 'owned-project', instruction: '修改标题', settings });
  await until(() => g.calls() >= 2); await stopService.cancel(stopped.runId); await assert.rejects(stopService.resume(stopped.runId, { settings }), { code: 'ASSISTANT_RESUME_UNAVAILABLE' });
});
test('resume cannot change the task instruction or upgrade its permission mode', async t => {
  const f = await fixture(t), service = f.make(); const { runId } = await service.start({ projectId: 'owned-project', instruction: '修改标题', settings });
  await until(() => f.calls() >= 2); await service.close(); const next = f.make(true);
  await assert.rejects(next.resume(runId, { settings, mode: 'auto', instruction: '删除所有数据' }), { code: 'ASSISTANT_RESUME_INPUT' }); assert.equal(f.writes(), 1);
});

test('completed partial tasks remain resumable live and persisted, then drop their checkpoint only after actual recovery completes', async t => {
  const base = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'gx-autonomy-partial-')); let calls = 0, writes = 0, checkAvailable = false;
  const service = createAssistantAgentService({ dataDir: directory, checkpoint: ctx => ({ v: 1, runId: ctx.runId, projectId: ctx.projectId, projectHash: 'owned-' + writes }), restoreCheckpoint: () => ({ reconciled: false }),
    appTools: [
      { name: 'commit_fixture', description: '保存隔离目标', mutating: true, execute: () => { writes++; return { summary: '实际修改已保存', effects: [{ type: 'project', changed: true }] }; } },
      { name: 'check_fixture', description: '核对当前已保存结果', mutating: false, execute: () => { if (!checkAvailable) throw new AppError(503, '检查服务暂不可用', 'CHECK_UNAVAILABLE'); return { summary: '已实际核对当前结果' }; } },
    ], modelStep: () => ({ data: ++calls === 1 ? { type: 'tool', tool: 'commit_fixture', arguments: {}, summary: '保存' } : calls === 2 || calls === 4 ? { type: 'tool', tool: 'check_fixture', arguments: {}, summary: '实际核对' } : { type: 'final', message: checkAvailable ? '结果已经保存且完成核对。' : '结果已保存，检查服务暂不可用。', sourceIds: [] } }),
  });
  t.after(async () => { await service.close(); assert.equal(path.dirname(directory), base); await rm(directory, { recursive: true, force: true }); });
  const { runId } = await service.start({ projectId: 'owned-partial', instruction: '修改标题并保存、核对结果。', settings });
  const partial = await finish(service, runId);
  assert.equal(partial.status, 'completed'); assert.equal(partial.report.outcome, 'partial'); assert.equal(partial.resumable, true);
  assert.equal((await service.list()).find(job => job.id === runId).resumable, true);
  await until(async () => { const saved = JSON.parse(await readFile(path.join(directory, 'assistant/runs.json'), 'utf8')); return saved.jobs.find(job => job.id === runId)?.resumable; });
  const storedPartial = JSON.parse(await readFile(path.join(directory, 'assistant/runs.json'), 'utf8')).jobs.find(job => job.id === runId);
  assert.ok(storedPartial.resumeProof); checkAvailable = true;
  await service.resume(runId, { settings }); const recovered = await finish(service, runId);
  assert.equal(recovered.status, 'completed'); assert.equal(recovered.report.outcome, 'complete'); assert.equal(recovered.resumable, false); assert.equal(writes, 1);
  await assert.rejects(service.resume(runId, { settings }), { code: 'ASSISTANT_RESUME_UNAVAILABLE' });
  await service.close(); const storedComplete = JSON.parse(await readFile(path.join(directory, 'assistant/runs.json'), 'utf8')).jobs.find(job => job.id === runId);
  assert.equal(storedComplete.resumable, false); assert.equal(storedComplete.resumeProof, undefined);
});
