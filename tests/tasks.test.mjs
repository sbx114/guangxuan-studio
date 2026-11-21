import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createTaskService } from '../lib/tasks.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function fixture(t, options = {}) {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'gx-tasks-'));
  const services = [], service = await createTaskService({ dataDir: folder, projectName: async id => ({ a: '甲项目', b: '乙项目' })[id] || '测试项目', ...options });
  services.push(service);
  t.after(async () => {
    for (const value of services) await value.close();
    assert.equal(path.dirname(path.resolve(folder)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(folder).startsWith('gx-tasks-'));
    await rm(folder, { recursive: true, force: true });
  });
  return { service, folder, async reopen() { await service.close(); const next = await createTaskService({ dataDir: folder, ...options }); services.push(next); return next; } };
}
async function until(read, predicate, message = 'state did not settle') {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) { const result = await read(); if (predicate(result)) return result; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail(message);
}

test('tracked work returns the original result, records phases and keeps project lists isolated', async t => {
  const { service } = await fixture(t);
  const value = { answer: { text: '完成' }, downloadUrl: '/api/video/exports/video-1/file' };
  let taskId;
  const returned = await service.track({ type: 'export', title: '导出视频', projectId: 'a', payload: { mustNotPersist: 'raw-payload-123' } }, async ({ taskId: id, update, signal }) => {
    assert.equal(id, taskId); assert.equal(signal.aborted, false);
    await update({ phase: '生成字幕', progress: 33.333 });
    assert.equal((await service.get(id)).progress, 33.33);
    return value;
  }, { onTask: id => { taskId = id; } });
  assert.strictEqual(returned, value);
  const task = await service.get(taskId);
  assert.equal(task.status, 'succeeded'); assert.equal(task.progress, 100); assert.equal(task.projectName, '甲项目');
  assert.equal(task.outputs[0].url, value.downloadUrl); assert.equal(task.canCancel, false); assert.equal(task.canRetry, false);
  await service.create({ title: '另一个项目任务', projectId: 'b' });
  assert.equal((await service.list({ projectId: 'a' })).items.length, 1);
  assert.equal((await service.list({ projectId: 'b' })).items[0].projectId, 'b');
  await assert.rejects(service.get(taskId, { projectId: 'b' }), { code: 'TASK_NOT_FOUND' });
  await assert.rejects(service.update(taskId, { projectId: 'b' }), { code: 'TASK_PROJECT_CONFLICT' });
  assert.equal((await service.list({ status: 'complete' })).total, 1);
  await assert.rejects(service.list({ projectId: '../private' }), { code: 'INVALID_PROJECT_ID' });
  await assert.rejects(service.list({ status: 'surprise' }), { code: 'TASK_INVALID_STATUS' });
});

test('completed work preserves explicitly published outputs unless the result replaces or clears them', async t => {
  const { service } = await fixture(t);
  const preview = { label: '分镜预览', url: '/api/video/previews/preview-01/frame-01.jpg' };
  let first;
  const result = { frames: [{ url: preview.url }], revision: 'safe-preview-revision' };
  assert.strictEqual(await service.track({ projectId: 'a', type: 'motion-preview' }, async ({ update }) => {
    await update({ outputs: [preview, { label: '丢弃外部链接', url: 'https://example.invalid/frame.jpg' }] });
    return result;
  }, { onTask: id => { first = id; } }), result);
  assert.deepEqual((await service.get(first)).outputs, [preview]);
  let replaced;
  await service.track({ projectId: 'a' }, async ({ update }) => {
    await update({ outputs: [preview] });
    return { downloadUrl: '/api/video/exports/final-video/file', filename: '最终视频' };
  }, { onTask: id => { replaced = id; } });
  assert.deepEqual((await service.get(replaced)).outputs, [{ label: '最终视频', url: '/api/video/exports/final-video/file' }]);
  let cleared;
  await service.track({ projectId: 'a' }, async ({ update }) => {
    await update({ outputs: [preview] });
    return { outputs: [] };
  }, { onTask: id => { cleared = id; } });
  assert.deepEqual((await service.get(cleared)).outputs, []);
});

test('cancellation aborts actual runner and late completion cannot resurrect a cancelled task', async t => {
  const { service } = await fixture(t), entered = deferred(), release = deferred();
  let taskId, observedSignal, cancellations = 0;
  const work = service.track({ projectId: 'a', title: '长任务' }, async ({ signal }) => { observedSignal = signal; entered.resolve(); await release.promise; return { finished: true }; }, { onTask: id => { taskId = id; }, cancel: async () => { cancellations += 1; } });
  const outcome = assert.rejects(work, { name: 'AbortError' });
  await entered.promise;
  assert.equal((await service.get(taskId)).canCancel, true);
  const pending = await service.cancel(taskId);
  assert.equal(pending.status, 'cancelling'); assert.equal(observedSignal.aborted, true); assert.equal(cancellations, 1);
  release.resolve(); await outcome;
  assert.equal((await service.get(taskId)).status, 'cancelled');
  await service.update(taskId, { status: 'complete', outputs: [{ url: '/api/video/exports/late/file' }] });
  assert.equal((await service.get(taskId)).status, 'cancelled'); assert.deepEqual((await service.get(taskId)).outputs, []);
  await service.cancel(taskId); assert.equal(cancellations, 1);
});

test('caller abort signals reach the runner, including already-aborted requests', async t => {
  const { service } = await fixture(t), entered = deferred(), controller = new AbortController();
  let taskId;
  const work = service.track({ projectId: 'a' }, ({ signal }) => new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); entered.resolve(); }), { signal: controller.signal, onTask: id => { taskId = id; } });
  const outcome = assert.rejects(work, { name: 'AbortError' }); await entered.promise; controller.abort(); await outcome;
  assert.equal((await service.get(taskId)).status, 'cancelled');
  let called = false; const preAborted = new AbortController(); preAborted.abort();
  await assert.rejects(service.track({ projectId: 'a' }, async () => { called = true; }, { signal: preAborted.signal }), { name: 'AbortError' });
  assert.equal(called, false);
});

test('safe retries are explicit, serialized and never repeat completed writes', async t => {
  const { service } = await fixture(t), retryEntered = deferred(), release = deferred();
  let taskId, calls = 0;
  const runner = async () => { calls += 1; if (calls === 1) throw new Error('暂时失败'); retryEntered.resolve(); await release.promise; return { written: true }; };
  await assert.rejects(service.track({ projectId: 'a', type: 'restore' }, runner, { safeRetry: true, onTask: id => { taskId = id; }, idempotencyKey: 'restore-once' }), /暂时失败/);
  assert.equal((await service.get(taskId)).canRetry, true);
  await assert.rejects(service.track({ projectId: 'a', type: 'restore' }, runner, { safeRetry: true, idempotencyKey: 'restore-once' }), { code: 'TASK_RETRY_REQUIRED' });
  await service.retry(taskId); await retryEntered.promise;
  await assert.rejects(service.retry(taskId), { code: 'TASK_RETRY_UNAVAILABLE' });
  release.resolve(); await until(() => service.get(taskId), task => task.status === 'succeeded');
  assert.equal(calls, 2); assert.equal((await service.get(taskId)).attempt, 2);
  await assert.rejects(service.retry(taskId), { code: 'TASK_RETRY_UNAVAILABLE' }); assert.equal(calls, 2);
  let unsafeId; await assert.rejects(service.track({ projectId: 'a' }, async () => { throw Error('失败'); }, { onTask: id => { unsafeId = id; } }));
  assert.equal((await service.get(unsafeId)).canRetry, false); await assert.rejects(service.retry(unsafeId), { code: 'TASK_RETRY_UNAVAILABLE' });
});

test('idempotency joins concurrent callers, separates projects and persists completion receipts', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred(); let calls = 0, firstId, secondId;
  const result = { saved: true };
  const runner = async () => { calls += 1; entered.resolve(); await release.promise; return result; };
  const first = f.service.track({ projectId: 'a', type: 'backup' }, runner, { idempotencyKey: 'opaque-request-key', onTask: id => { firstId = id; } });
  const second = f.service.track({ projectId: 'a', type: 'backup' }, runner, { idempotencyKey: 'opaque-request-key', onTask: id => { secondId = id; } });
  await entered.promise; release.resolve(); assert.strictEqual(await first, result); assert.strictEqual(await second, result);
  assert.equal(firstId, secondId); assert.equal(calls, 1);
  assert.strictEqual(await f.service.track({ projectId: 'a', type: 'backup' }, runner, { idempotencyKey: 'opaque-request-key' }), result); assert.equal(calls, 1);
  await assert.rejects(f.service.track({ projectId: 'a', type: 'restore' }, runner, { idempotencyKey: 'opaque-request-key' }), { code: 'TASK_IDEMPOTENCY_CONFLICT' });
  await f.service.track({ projectId: 'b', type: 'backup' }, async () => { calls += 1; }, { idempotencyKey: 'opaque-request-key' }); assert.equal(calls, 2);
  const next = await f.reopen();
  await assert.rejects(next.track({ projectId: 'a', type: 'backup' }, runner, { idempotencyKey: 'opaque-request-key' }), { code: 'TASK_ALREADY_COMPLETED' }); assert.equal(calls, 2);
});

test('persistence uses a whitelist, redacts errors and only retains controlled internal output URLs', async t => {
  const secret = 'fixture-sensitive-token-123', f = await fixture(t, { sensitiveStrings: () => [secret] }); let taskId;
  await assert.rejects(f.service.track({ projectId: 'a', title: `导出 ${secret}`, payload: { raw: 'never-save-this-request' }, apiKey: secret }, async () => { throw Object.assign(new Error(`失败 ${secret} Bearer abcdef-secret sk-unknown-secret-key C:\\Users\\private\\file.txt https://provider.example/private?token=a`), { code: 'PROVIDER_FAILED', stack: 'private-stack-value' }); }, { onTask: id => { taskId = id; } }));
  const failed = await f.service.get(taskId);
  assert.equal(failed.error.code, 'PROVIDER_FAILED'); assert.doesNotMatch(failed.error.message, /fixture-sensitive|abcdef-secret|sk-unknown|Users|provider\.example/);
  const exported = await f.service.create({ projectId: 'a', title: '下载', sourceJobId: secret });
  await f.service.update(exported.id, { status: 'complete', outputs: [
    { label: '正确包', url: '/api/project-bundles/exports/bundle-1/file', payload: secret },
    { label: '正确视频', url: '/api/openfilm/exports/a/video-1/file' },
    { label: '分镜预览', url: '/api/video/previews/job-1/frame-001.jpg' },
    { url: '/api/openfilm/exports/b/video-1/file' }, { url: 'https://evil.example/steal' }, { url: 'file:///C:/private' },
    { url: '/api/video/exports/%2e%2e/file' }, { url: '//evil.example/file' }, { url: '/api/video/assets/private/file' },
    { url: '/api/video/exports/export-1/file?path=C:/private' }, { url: '/api/video/exports/export-1/file#x' },
    { url: `/api/video/exports/${secret}/file` },
  ], request: 'never-save-this-patch' });
  assert.equal((await f.service.get(exported.id)).outputs.length, 3);
  const raw = await readFile(path.join(f.folder, 'tasks', 'index.json'), 'utf8');
  assert.doesNotMatch(raw, /never-save-this|fixture-sensitive|abcdef-secret|sk-unknown|private-stack|provider\.example|evil\.example|payload|apiKey/);
  const snapshot = JSON.parse(raw);
  assert.ok(snapshot.items.every(item => !Object.hasOwn(item, 'canRetry') && !Object.hasOwn(item, 'canCancel')));
  assert.ok(!JSON.stringify(await f.service.list()).includes('dedupeHash'));
});

test('restart marks unfinished tasks interrupted and drops executable retry/cancel controls', async t => {
  const f = await fixture(t);
  const queued = await f.service.create({ projectId: 'a', title: '待处理' });
  const running = await f.service.create({ projectId: 'b' }); await f.service.update(running.id, { status: 'running', phase: '编码', progress: 45 });
  let failedId; await assert.rejects(f.service.track({ projectId: 'a' }, async () => { throw Error('失败'); }, { safeRetry: true, onTask: id => { failedId = id; } }));
  const next = await f.reopen();
  for (const id of [queued.id, running.id]) { const task = await next.get(id); assert.equal(task.status, 'interrupted'); assert.equal(task.error.code, 'TASK_INTERRUPTED'); assert.equal(task.canCancel, false); assert.equal(task.canRetry, false); }
  assert.equal((await next.get(failedId)).canRetry, false); await assert.rejects(next.retry(failedId), { code: 'TASK_RETRY_UNAVAILABLE' });
  // Simulate an unclean exit from an older process instead of calling close().
  await next.close(); const file = path.join(f.folder, 'tasks', 'index.json'), snapshot = JSON.parse(await readFile(file, 'utf8'));
  snapshot.items.find(item => item.id === queued.id).status = 'running'; await writeFile(file, JSON.stringify(snapshot));
  const crashed = await createTaskService({ dataDir: f.folder });
  assert.equal((await crashed.get(queued.id)).status, 'interrupted');
  await crashed.close();
});

test('attached sources refresh only registered active jobs, cancel their real source and stop polling terminal jobs', async t => {
  const { service } = await fixture(t); let reads = 0, cancels = 0;
  let job = { status: 'rendering', progress: 17 };
  const task = await service.create({ projectId: 'a', title: '源任务' });
  await service.create({ projectId: 'b', title: '没有来源' });
  const source = { read: async () => { reads += 1; return job; }, map: value => ({ status: value.status, phase: '渲染', progress: value.progress }), cancel: async () => { cancels += 1; job = { status: 'cancelled', progress: 17 }; return job; } };
  await service.attachSource(task.id, source); assert.equal(reads, 1); assert.equal((await service.get(task.id)).status, 'running');
  const before = reads; await service.list({ projectId: 'b' }); assert.equal(reads, before);
  assert.equal((await service.cancel(task.id)).status, 'cancelled'); assert.equal(cancels, 1);
  const terminalReads = reads; await service.list(); await service.get(task.id); assert.equal(reads, terminalReads);
  const completed = await service.create({ projectId: 'a' });
  job = { status: 'complete', progress: 100 }; await service.attachSource(completed.id, source); assert.equal((await service.get(completed.id)).status, 'succeeded');
});

test('external observers upsert one task, reject project collisions, and persist their identity', async t => {
  const f = await fixture(t); let cancelCalls = 0;
  const [a, b] = await Promise.all([
    f.service.upsertExternal('analysis:job-a', { projectId: 'a', title: '素材理解' }, { status: 'queued' }),
    f.service.upsertExternal('analysis:job-a', { projectId: 'a', title: '素材理解' }, { status: 'running', progress: 20 }, { cancel: async () => { cancelCalls += 1; } }),
  ]);
  assert.equal(a.id, b.id); assert.equal((await f.service.list()).total, 1); assert.equal((await f.service.get(a.id)).canCancel, true);
  await assert.rejects(f.service.upsertExternal('analysis:job-a', { projectId: 'b' }, { status: 'complete' }), { code: 'TASK_PROJECT_CONFLICT' });
  await f.service.cancel(a.id); assert.equal(cancelCalls, 1); assert.equal((await f.service.get(a.id)).status, 'cancelled');
  const next = await f.reopen(); const same = await next.upsertExternal('analysis:job-a', { projectId: 'a' }, { status: 'cancelled' }); assert.equal(same.id, a.id); assert.equal((await next.list()).total, 1);
});

test('HTTP handlers expose read/cancel/retry only and enforce project scope on task actions', async t => {
  const { service } = await fixture(t), task = await service.create({ projectId: 'a', title: 'HTTP任务' });
  await service.attachSource(task.id, { read: async () => ({ status: 'running', progress: 12 }), cancel: async () => ({ status: 'cancelled' }) });
  const server = http.createServer(async (req, res) => { if (!await service.handler(req, res, new URL(req.url, 'http://127.0.0.1'))) { res.writeHead(404); res.end(); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const request = async (route, method = 'GET') => { const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method }); return { status: response.status, data: await response.json() }; };
  assert.equal((await request('/api/tasks?projectId=a')).data.items.length, 1);
  assert.equal((await request('/api/tasks?projectId=b')).data.items.length, 0);
  assert.equal((await request(`/api/tasks/${task.id}?projectId=b`)).status, 404);
  assert.equal((await request(`/api/tasks/${task.id}/cancel?projectId=b`, 'POST')).status, 404);
  assert.equal((await request(`/api/tasks/${task.id}`)).data.task.progress, 12);
  assert.equal((await request('/api/tasks', 'POST')).status, 404);
  assert.equal((await request(`/api/tasks/${task.id}`, 'PUT')).status, 405);
  assert.equal((await request(`/api/tasks/${task.id}/cancel?projectId=a`, 'POST')).data.task.status, 'cancelled');
  assert.equal((await request(`/api/tasks/${task.id}/retry`, 'POST')).status, 409);
});
