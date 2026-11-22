import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import { startServer } from '../server.mjs';
import { assistantWritingFingerprint } from '../lib/assistant-writing-context.mjs';

test('real server restart resumes the same writing run with its completed receipt and forbids mode or goal overrides', { timeout: 30000 }, async () => {
  const base = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, 'gx-checkpoint-http-')); let app, requests = 0;
  const vendor = http.createServer(async (req, res) => {
    for await (const chunk of req) { void chunk; }
    requests++;
    if (requests === 2) return;
    const data = requests === 1 ? { type: 'tool', tool: 'draft_write', arguments: { channel: 'article', content: { title: '真实保存', lead: '', body: '材料正文', titles: [] } }, summary: '保存文案' } : { type: 'final', message: '文案已保存并核对。', sourceIds: [] };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(data) } }] }));
  });
  await new Promise(resolve => vendor.listen(0, '127.0.0.1', resolve));
  const settings = { baseUrl: `http://127.0.0.1:${vendor.address().port}/v1`, model: 'local-protocol', apiKey: 'checkpoint-private-test-key' };
  const call = async (route, body) => { const response = await fetch(app.url + route, { method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }); return { status: response.status, data: await response.json() }; };
  try {
    app = await startServer({ dataDir: dir, port: 0 });
    const response = await fetch(app.url + '/api/projects/writer', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'writing', title: '隔离文案', source: { title: '材料', text: '材料正文', url: '' }, outputs: {} }) });
    assert.equal(response.status, 200);
    const started = await call('/api/assistant/runs', { projectId: 'writer', instruction: '根据当前材料写一份文案并保存。', settings });
    assert.equal(started.status, 202); const id = started.data.runId;
    for (let i = 0; i < 500 && requests < 2; i++) await pause(10);
    assert.equal(requests, 2); await app.close(); app = null;
    const saved = JSON.parse(await readFile(path.join(dir, 'assistant/runs.json'), 'utf8'));
    assert.equal(JSON.stringify(saved).includes(settings.apiKey), false);
    app = await startServer({ dataDir: dir, port: 0 });
    const before = await call('/api/assistant/runs/' + id);
    assert.equal(before.data.job.status, 'interrupted'); assert.equal(before.data.job.resumable, true); assert.equal(before.data.job.resumeProof, undefined);
    const forged = await call('/api/assistant/runs/' + id + '/resume', { settings, mode: 'auto', instruction: '换个目标' });
    assert.ok(forged.status >= 400);
    const resumed = await call('/api/assistant/runs/' + id + '/resume', { settings, writingPreferences: {} });
    assert.equal(resumed.status, 202); assert.equal(resumed.data.runId, id);
    let finished;
    for (let i = 0; i < 500; i++) { finished = (await call('/api/assistant/runs/' + id)).data.job; if (['completed', 'failed', 'cancelled'].includes(finished.status)) break; await pause(10); }
    assert.equal(finished.status, 'completed'); assert.equal(finished.resumeCount, 1);
    const project = (await call('/api/projects/writer')).data.project;
    assert.equal(project.assistantRevision, 1); assert.equal(project.writing.draft.output.body, '材料正文');
    const stale = await call('/api/assistant/runs', { projectId: 'writer', instruction: '改写当前文案', settings, writingContext: { channel: 'article', writingRevision: (project.writingRevision || 0) + 1, outputFingerprint: assistantWritingFingerprint(project.writing.draft.output) } });
    assert.equal(stale.status, 409); assert.equal(requests, 3, 'stale writing context is rejected before a model request');
  } finally { await app?.close(); vendor.closeAllConnections(); await new Promise(resolve => vendor.close(resolve)); assert.equal(path.dirname(dir), base); await rm(dir, { recursive: true, force: true }); }
});
