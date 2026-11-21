import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createTaskService } from '../lib/tasks.mjs';
import { createTaskAdapters } from '../lib/task-adapters.mjs';
import { createVideoService } from '../lib/video.mjs';

const execute = promisify(execFile), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = name => process.env[`GUANGXUAN_${name.toUpperCase()}`] || (process.env.GUANGXUAN_BIN_DIR ? path.join(process.env.GUANGXUAN_BIN_DIR, name + (process.platform === 'win32' ? '.exe' : '')) : name);
async function fixture(t, secret = 'fixture-adapter-secret-123') {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'gx-task-adapters-')), closers = [];
  const tasks = await createTaskService({ dataDir: folder, projectName: async id => id === 'a' ? '甲项目' : '乙项目', sensitiveStrings: () => [secret] });
  t.after(async () => { for (const close of closers.reverse()) await close(); await tasks.close(); assert.equal(path.dirname(path.resolve(folder)), path.resolve(os.tmpdir())); assert.ok(path.basename(folder).startsWith('gx-task-adapters-')); await rm(folder, { recursive: true, force: true }); });
  return { folder, tasks, closers, own(value) { closers.push(() => value.close()); return value; } };
}
async function until(read, predicate, timeout = 10000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 15)); } assert.fail('state did not settle'); }
function fakeVideo(initial = []) {
  const jobs = new Map(initial.map(job => [job.id || job.jobId, structuredClone(job)])), listeners = new Set(), calls = [];
  return { jobs, calls, listJobs: () => [...jobs.values()].map(job => structuredClone(job)), subscribeJobs(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    getJob(id, filters = {}) { calls.push(['get', id, filters.projectId]); const job = jobs.get(id); if (!job || filters.projectId && job.projectId !== filters.projectId) throw Error('foreign job'); return structuredClone(job); },
    async cancelJob(id, filters = {}) { calls.push(['cancel', id, filters.projectId]); const job = jobs.get(id); if (!job || filters.projectId && job.projectId !== filters.projectId) throw Error('foreign job'); job.status = 'cancelled'; this.emit(job); return structuredClone(job); },
    emit(job) { jobs.set(job.id || job.jobId, structuredClone(job)); for (const listener of listeners) listener(structuredClone(job)); }, listenerCount: () => listeners.size,
  };
}

test('video adapters seed safe history, preserve project isolation, map progress and call the real source cancellation', async t => {
  const f = await fixture(t), video = fakeVideo([
    { id: 'video-active-0001', projectId: 'a', title: '项目导出', kind: 'export', status: 'running', progress: .37, prompt: 'never-persist-original-prompt', plan: { private: 'never-persist-plan' }, path: 'C:/private/export.mp4' },
    { id: 'video-history-0002', title: '旧历史', status: 'complete', progress: 1, downloadUrl: '/api/video/exports/video-history-0002/file', settings: { apiKey: 'fixture-adapter-secret-123' } },
  ]);
  const adapters = f.own(createTaskAdapters({ tasks: f.tasks, videoService: video })); await adapters.ready;
  const a = (await f.tasks.list({ projectId: 'a' })).items; assert.equal(a.length, 1); assert.equal(a[0].progress, 37); assert.equal(a[0].sourceJobId, 'video-active-0001'); assert.equal(a[0].canCancel, true);
  assert.equal((await f.tasks.list({ projectId: 'b' })).total, 0); await assert.rejects(f.tasks.cancel(a[0].id, { projectId: 'b' }), { code: 'TASK_NOT_FOUND' });
  await f.tasks.cancel(a[0].id); await adapters.flush(); assert.equal((await f.tasks.get(a[0].id)).status, 'cancelled');
  assert.ok(video.calls.some(call => call[0] === 'cancel' && call[1] === 'video-active-0001' && call[2] === 'a'));
  const history = (await f.tasks.list()).items.find(task => !task.projectId); assert.match(history.title, /素材库/); assert.equal(history.status, 'succeeded'); assert.equal(history.canRetry, false);
  const raw = await readFile(path.join(f.folder, 'tasks/index.json'), 'utf8'); assert.doesNotMatch(raw, /never-persist|private\/export|"prompt"|"plan"|"settings"|apiKey/);
  const count = (await f.tasks.list()).total; await adapters.close(); assert.equal(video.listenerCount(), 0);
  video.emit({ id: 'video-after-close', projectId: 'a', status: 'running', progress: 0 }); await adapters.flush(); assert.equal((await f.tasks.list()).total, count);
});

test('analysis callbacks map 0..1 progress, bind lazy services, cancel by owner and never persist result payloads', async t => {
  const f = await fixture(t); let source;
  const adapters = f.own(createTaskAdapters({ tasks: f.tasks, sourceAnalysis: () => source }));
  let job = { id: 'analysis-job-0001', projectId: 'a', status: 'running', progress: .625, phase: 'transcribe', result: { private: 'never-save-source-transcript' }, settings: { apiKey: 'fixture-adapter-secret-123' } };
  const calls = [];
  source = { get(projectId, id) { calls.push(['get', projectId, id]); assert.equal(projectId, 'a'); assert.equal(id, job.id); return structuredClone(job); }, cancel(projectId, id) { calls.push(['cancel', projectId, id]); assert.equal(projectId, 'a'); job.status = 'cancelled'; return structuredClone(job); } };
  await adapters.analysisJob(job, { projectId: 'a' });
  const task = (await f.tasks.list({ projectId: 'a' })).items[0]; assert.equal(task.progress, 62.5); assert.equal(task.phase, '转写原声'); assert.equal(task.type, 'source-analysis');
  await assert.rejects(adapters.analysisJob(job, { projectId: 'b' }), { code: 'TASK_ADAPTER_PROJECT_CONFLICT' });
  await f.tasks.cancel(task.id); assert.equal((await f.tasks.get(task.id)).status, 'cancelled'); assert.ok(calls.some(call => call[0] === 'cancel' && call[1] === 'a' && call[2] === job.id));
  assert.doesNotMatch(await readFile(path.join(f.folder, 'tasks/index.json'), 'utf8'), /never-save-source|fixture-adapter-secret|"settings"|"result"/);
});

test('native export discovery reads only watched/known active projects and shares each project RPC across tasks', async t => {
  const f = await fixture(t), calls = [], responses = new Map([
    ['a', [{ id: 'native-export-01', status: 'rendering', progress: .25 }, { id: 'native-export-02', status: 'running', progress: .5 }]], ['b', []],
  ]);
  let clock = Date.now(); t.mock.method(Date, 'now', () => clock);
  const openFilm = { async nativeExports(id) { calls.push(id); await new Promise(resolve => setTimeout(resolve, 20)); return { exports: structuredClone(responses.get(id) || []) }; }, status: () => ({ running: true }) };
  const adapters = f.own(createTaskAdapters({ tasks: f.tasks, openFilm })); await adapters.ready;
  assert.equal(calls.length, 0); await adapters.watchNativeProject('a'); assert.deepEqual(calls, ['a']);
  const tasks = (await f.tasks.list({ projectId: 'a' })).items; assert.equal(tasks.length, 2); assert.equal(tasks[0].canCancel, false);
  clock += 1100; await Promise.all(tasks.map(task => f.tasks.get(task.id))); assert.deepEqual(calls, ['a', 'a']);
  await adapters.watchNativeProject('b'); assert.equal(calls.at(-1), 'b');
  responses.set('a', responses.get('a').map(job => ({ ...job, status: 'done', progress: 1, downloadUrl: `/api/openfilm/exports/a/${job.id}/file` })));
  clock += 1100; await Promise.all(tasks.map(task => f.tasks.get(task.id))); assert.ok((await f.tasks.list({ projectId: 'a' })).items.every(task => task.status === 'succeeded'));
  const before = calls.length; await adapters.close(); clock += 2000; await f.tasks.list(); await adapters.watchNativeProject('c'); assert.equal(calls.length, before);
  assert.ok(calls.every(id => ['a', 'b'].includes(id))); assert.equal((await f.tasks.list({ projectId: 'b' })).total, 0);
});

test('native worker disappearance produces interrupted tasks without starting a replacement worker', async t => {
  const f = await fixture(t); let running = true, clock = Date.now(); t.mock.method(Date, 'now', () => clock);
  const openFilm = { nativeExports: async () => ({ exports: running ? [{ id: 'native-disappear', status: 'running', progress: .2 }] : [] }), status: () => ({ running }) };
  const adapters = f.own(createTaskAdapters({ tasks: f.tasks, openFilm })); await adapters.watchNativeProject('a'); const id = (await f.tasks.list()).items[0].id;
  running = false; clock += 1100; assert.equal((await f.tasks.get(id)).status, 'interrupted');
});

test('real video queue cancellation stops only the selected FFmpeg job, releases queued work and keeps observer snapshots private', { timeout: 90000 }, async t => {
  const ffmpeg = executable('ffmpeg'), ffprobe = executable('ffprobe');
  try { await Promise.all([ffmpeg, ffprobe].map(binary => execute(binary, ['-version'], { windowsHide: true, timeout: 5000 }))); } catch { t.skip('Existing FFmpeg/FFprobe required.'); return; }
  const f = await fixture(t), image = path.join(f.folder, 'fixture.png');
  await execute(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:size=160x90', '-frames:v', '1', '-update', '1', image], { windowsHide: true, timeout: 10000 });
  const video = f.own(await createVideoService({ dataDir: path.join(f.folder, 'video-data'), root, ffmpegPath: ffmpeg, ffprobePath: ffprobe, sensitiveStrings: () => ['fixture-adapter-secret-123'] }));
  const server = http.createServer(async (req, res) => { try { if (!await video.handler(req, res, new URL(req.url, 'http://127.0.0.1'))) { res.writeHead(404); res.end(); } } catch (error) { res.writeHead(error.status || 500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message, code: error.code })); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); f.closers.push(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const post = async (route, body, expected = 202) => { const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const data = await response.json(); assert.equal(response.status, expected, JSON.stringify(data)); return data; };
  const asset = (await post('/api/video/import-local', { paths: [image] }, 200)).assets[0];
  const seen = []; const unsubscribe = video.subscribeJobs(job => { seen.push(structuredClone(job)); job.status = 'observer-mutation'; });
  video.subscribeJobs(() => { throw Error('observer failure must not stop rendering'); });
  const adapters = f.own(createTaskAdapters({ tasks: f.tasks, videoService: video })); await adapters.ready;
  const spec = { timeline: [{ assetId: asset.id, start: 0, end: 120 }], resolution: '720', projectId: 'a', title: 'fixture-adapter-secret-123 render' };
  const first = await post('/api/video/export', spec);
  const queued = await post('/api/video/render-animation', { projectId: 'b', prompt: 'private-original-animation-prompt', model: 'private-original-model', plan: { title: 'private plan', aspect: '16:9', fps: 30, theme: 'paper', scenes: [{ type: 'title', duration: 3, title: 'private-original-plan' }] } });
  assert.equal(video.getJob(queued.jobId).status, 'queued');
  await assert.rejects(video.cancelJob(first.jobId, { projectId: 'b' }), { code: 'VIDEO_JOB_NOT_FOUND' });
  const cancelledQueued = await video.cancelJob(queued.jobId, { projectId: 'b' }); assert.equal(cancelledQueued.status, 'cancelled'); assert.equal(video.getJob(first.jobId).status, 'running');
  const third = await post('/api/video/export', { ...spec, title: 'surviving queued export', projectId: 'b', timeline: [{ assetId: asset.id, start: 0, end: .4 }] });
  await until(() => video.getJob(first.jobId), job => job.progress > 0);
  assert.equal((await video.cancelJob(first.jobId, { projectId: 'a' })).status, 'cancelled');
  const completed = await until(() => video.getJob(third.jobId), job => ['complete', 'error', 'cancelled'].includes(job.status), 20000); assert.equal(completed.status, 'complete', JSON.stringify(completed));
  assert.equal(completed.projectId, 'b'); assert.equal(completed.progress, 1); assert.equal(video.getJob(first.jobId).canRetry, false); assert.equal(video.getJob(queued.jobId).canRetry, false);
  assert.deepEqual(video.listJobs({ projectId: 'a' }).map(job => job.jobId), [first.jobId]);
  assert.doesNotMatch(JSON.stringify(video.listJobs()), /fixture-adapter-secret|private-original|"plan"|"prompt"|"model"|"path"|"spec"|observer-mutation/);
  assert.ok(seen.some(job => job.jobId === first.jobId && job.status === 'cancelled')); assert.ok(seen.some(job => job.jobId === queued.jobId && job.status === 'cancelled'));
  await adapters.flush(); const taskA = (await f.tasks.list({ projectId: 'a' })).items[0]; assert.equal(taskA.status, 'cancelled'); assert.ok((await f.tasks.list({ projectId: 'b' })).items.some(task => task.status === 'succeeded'));
  await assert.rejects(stat(path.join(f.folder, 'video-data/video/exports', `${first.jobId}.mp4`)), { code: 'ENOENT' });
  await assert.rejects(stat(path.join(f.folder, 'video-data/video/jobs', first.jobId)), { code: 'ENOENT' });
  await post('/api/video/export', { ...spec, projectId: '../private' }, 400);
  const before = seen.length; unsubscribe(); await video.close(); assert.equal(seen.length, before);
  let replayed = 0; video.subscribeJobs(() => { replayed += 1; }, { replay: true }); assert.equal(replayed, 0);
});
