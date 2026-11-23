import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import { startServer } from '../server.mjs';

async function fixture(t) {
  const base = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(base, { recursive: true });
  const dataDir = await mkdtemp(path.join(base, 'gx-resume-completion-')); let app = await startServer({ dataDir, port: 0 });
  const call = async (route, body, method) => { const response = await fetch(app.url + route, { method: method || (body === undefined ? 'GET' : 'POST'), ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }); return { status: response.status, data: await response.json() }; };
  const output = { title: '已保存稿件', lead: '', body: '已有内容保留。', titles: [] };
  await call('/api/projects/writer', { kind: 'writing', title: '隔离恢复检查', source: { title: '材料', text: '材料正文。', url: '' }, outputs: { article: output }, writing: { draft: { channel: 'article', output } } }, 'PUT');
  t.after(async () => { await app.close(); assert.equal(path.dirname(dataDir), base); await rm(dataDir, { recursive: true, force: true }); });
  const restart = async mutate => { await app.close(); if (mutate) await mutate(); app = await startServer({ dataDir, port: 0 }); };
  const finish = async id => { for (let n = 0; n < 1000; n++) { const job = (await call('/api/assistant/runs/' + id)).data.job; if (['completed', 'failed', 'cancelled', 'interrupted'].includes(job.status)) return job; await pause(5); } throw Error('HTTP completion fixture timeout'); };
  return { dataDir, call, restart, finish };
}
async function localModel(t) {
  let requests = 0;
  const server = http.createServer(async (req, res) => {
    for await (const chunk of req) { void chunk; } requests++;
    const data = requests === 1 ? { type: 'tool', tool: 'project_read', arguments: {}, summary: '查看当前材料' } : { type: 'final', message: '材料正文已读取，当前稿件不需要修改。', sourceIds: [] };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(data) } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { requests: () => requests, settings: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'local-resume-protocol', apiKey: 'local-test-only', timeoutSeconds: 10 } };
}

for (const mode of ['ask', 'auto']) test(`completed answer in ${mode} mode cannot resume live or after legacy-checkpoint reload`, { timeout: 20000 }, async t => {
  const fx = await fixture(t), model = await localModel(t), instruction = '只查看材料并回答，不要修改稿件。';
  const started = await fx.call('/api/assistant/runs', { projectId: 'writer', instruction, mode, settings: model.settings });
  assert.equal(started.status, 202); const id = started.data.runId, finished = await fx.finish(id);
  assert.equal(finished.status, 'completed'); assert.equal(finished.report.outcome, 'answer'); assert.equal(finished.resumable, false); assert.equal(finished.resumeBlockReason, undefined);
  assert.equal((await fx.call('/api/assistant/runs')).data.jobs.find(job => job.id === id).resumable, false);
  assert.equal((await fx.call('/api/assistant/runs/' + id + '/resume', { settings: model.settings })).status, 409);
  const filename = path.join(fx.dataDir, 'assistant/runs.json');
  await fx.restart(async () => {
    const saved = JSON.parse(await readFile(filename, 'utf8')), job = saved.jobs.find(job => job.id === id);
    assert.equal(job.resumeProof, undefined); assert.equal(job.resumable, false);
    // Simulate an old valid-shaped private checkpoint left on an answered run.
    job.resumable = true; job.resumeBlockReason = '有未确认写入，需先核对当前工程状态。';
    job.resumeProof = { v: 1, projectId: job.projectId, userInstruction: job.instruction, mode: job.mode, checkpoint: { v: 1, runId: job.id, projectId: job.projectId } };
    await writeFile(filename, JSON.stringify(saved));
  });
  const restored = (await fx.call('/api/assistant/runs/' + id)).data.job;
  assert.equal(restored.status, 'completed'); assert.equal(restored.report.outcome, 'answer'); assert.equal(restored.resumable, false); assert.equal(restored.resumeBlockReason, undefined);
  assert.equal((await fx.call('/api/assistant/runs')).data.jobs.find(job => job.id === id).resumable, false);
  assert.equal((await fx.call('/api/assistant/runs/' + id + '/resume', { settings: model.settings })).status, 409);
  const migrated = JSON.parse(await readFile(filename, 'utf8')).jobs.find(job => job.id === id);
  assert.equal(migrated.resumeProof, undefined); assert.equal(migrated.resumable, false); assert.equal(migrated.resumeBlockReason, undefined);
  assert.equal(model.requests(), 2); assert.equal((await fx.call('/api/projects/writer')).data.project.writing.draft.output.body, '已有内容保留。');
});

test('legacy failed/interrupted jobs explain missing recovery proof and preserve specific reasons without writing or model calls', { timeout: 20000 }, async t => {
  const fx = await fixture(t), model = await localModel(t);
  const stamp = new Date().toISOString(), specific = '当前恢复记录损坏，需要先核对已保存结果。';
  const legacy = [
    { id: randomUUID(), status: 'failed' }, { id: randomUUID(), status: 'interrupted' },
    { id: randomUUID(), status: 'failed', resumeBlockReason: specific }, { id: randomUUID(), status: 'cancelled' },
  ].map(value => ({ projectId: 'writer', mode: 'auto', instruction: '修改稿件并保存。', message: '旧版模型服务未完成。', error: { code: 'UPSTREAM_HTTP_503', message: '旧版模型服务未完成。' }, steps: [], createdAt: stamp, updatedAt: stamp, finishedAt: stamp, ...value }));
  await fx.restart(async () => { await writeFile(path.join(fx.dataDir, 'assistant/runs.json'), JSON.stringify({ version: 1, jobs: legacy })); });
  const listed = (await fx.call('/api/assistant/runs')).data.jobs;
  for (const expected of legacy) {
    const job = (await fx.call('/api/assistant/runs/' + expected.id)).data.job;
    assert.equal(job.resumable, false); assert.equal(listed.find(row => row.id === job.id).resumeBlockReason, job.resumeBlockReason);
    if (expected.resumeBlockReason) assert.equal(job.resumeBlockReason, specific);
    else if (expected.status === 'cancelled') assert.equal(job.resumeBlockReason, undefined);
    else { assert.match(job.resumeBlockReason, /没有可核对的恢复记录/); assert.match(job.resumeBlockReason, /已有结果会保留/); assert.match(job.resumeBlockReason, /发送新要求/); }
    assert.equal((await fx.call('/api/assistant/runs/' + job.id + '/resume', { settings: model.settings })).status, 409);
  }
  const persisted = JSON.parse(await readFile(path.join(fx.dataDir, 'assistant/runs.json'), 'utf8')).jobs;
  assert.ok(persisted.filter(job => ['failed', 'interrupted'].includes(job.status)).every(job => typeof job.resumeBlockReason === 'string'));
  assert.equal(model.requests(), 0); assert.equal((await fx.call('/api/projects/writer')).data.project.writing.draft.output.body, '已有内容保留。');
});
