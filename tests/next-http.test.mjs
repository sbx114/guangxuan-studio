import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { startServer } from '../server.mjs';

const execute = promisify(execFile);
const binary = name => process.env[`GUANGXUAN_${name.toUpperCase()}`] || (process.env.GUANGXUAN_BIN_DIR ? path.join(process.env.GUANGXUAN_BIN_DIR, name + (process.platform === 'win32' ? '.exe' : '')) : name);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await read(); if (predicate(result)) return result; await sleep(10); }
  assert.fail('The HTTP integration did not settle in time.');
}

test('new HTTP workflows track native analysis, stream a complete project and commit restoration without a cancel action', { timeout: 90000 }, async t => {
  const ffmpeg = binary('ffmpeg');
  try { await execute(ffmpeg, ['-version'], { windowsHide: true, timeout: 5000 }); }
  catch { t.skip('Set GUANGXUAN_BIN_DIR to a local FFmpeg runtime.'); return; }
  const testParent = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir());
  await mkdir(testParent, { recursive: true });
  const folder = await mkdtemp(path.join(testParent, 'gx-next-http-')), dataDir = path.join(folder, 'data');
  let app;
  t.after(async () => {
    await app?.close();
    assert.equal(path.dirname(path.resolve(folder)), testParent); assert.ok(path.basename(folder).startsWith('gx-next-http-'));
    await rm(folder, { recursive: true, force: true });
  });
  app = await startServer({ dataDir });
  const request = async (route, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(app.url + route, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json();
    return { status: response.status, data };
  };
  assert.equal((await request('/api/tasks')).data.total, 0);
  const nativeStatus = await request('/api/openfilm/status');
  if (!nativeStatus.data.available) { t.skip('Build the bundled native OpenFilm runtime before integration checks.'); return; }
  const source = path.join(folder, '原片段.mp4');
  await execute(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=15:d=2', '-f', 'lavfi', '-i', 'sine=frequency=600:sample_rate=16000:duration=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source], { windowsHide: true, timeout: 20000 });
  const upload = await fetch(app.url + '/api/video/upload', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-file-name': encodeURIComponent(path.basename(source)) }, body: await readFile(source) });
  assert.equal(upload.status, 200);
  const asset = (await upload.json()).assets[0], id = 'next-http-original';
  assert.equal((await request('/api/projects/' + id, { kind: 'video', title: 'HTTP联动项目', video: { timeline: [{ assetId: asset.id, start: 0, end: 2 }], captions: [], aspect: '16:9' } }, 'PUT')).status, 200);
  const opened = await request('/api/openfilm/open', { projectId: id }); assert.equal(opened.status, 200, JSON.stringify(opened.data));
  const native = await request('/api/openfilm/context', { projectId: id }); assert.equal(native.status, 200);
  const nativeAsset = native.data.assets.find(item => item.type === 'video'); assert.ok(nativeAsset);
  const analysisRoute = '/api/projects/' + id + '/source-analysis';
  const queued = await request(analysisRoute, { sources: [{ assetId: nativeAsset.id, start: .1, end: 1.9 }], options: { maxFrames: 2 } });
  assert.equal(queued.status, 202, JSON.stringify(queued.data));
  const completed = await until(() => request(analysisRoute + '/jobs/' + queued.data.id), result => ['complete', 'error'].includes(result.data.status));
  assert.equal(completed.data.status, 'complete', JSON.stringify(completed.data));
  const observed = await until(() => request('/api/tasks?projectId=' + id), result => result.data.items.some(item => item.sourceJobId === queued.data.id && item.status === 'succeeded'));
  assert.equal(observed.status, 200);
  const analysisItem = (await request(analysisRoute)).data.items[0];
  assert.equal((await fetch(app.url + analysisRoute + '/frames/' + analysisItem.cacheKey + '/' + analysisItem.keyframes[0].id)).status, 200);
  assert.equal((await request('/api/projects/another-project/source-analysis/jobs/' + queued.data.id)).status, 404);
  const checked = await request('/api/projects/' + id + '/export-preflight', {});
  assert.equal(checked.status, 200); assert.equal(checked.data.canExport, true, JSON.stringify(checked.data.issues));
  assert.equal(checked.data.checks.rendered, false);

  // Extra project pages exercise streamed many-file restore and make the commit observable.
  const nativeHome = path.join(dataDir, 'openfilm/projects', id), pages = path.join(nativeHome, 'pages');
  await mkdir(pages, { recursive: true });
  await Promise.all(Array.from({ length: 48 }, (_, index) => writeFile(path.join(pages, `support-${index}.html`), `<!doctype html><body>项目页面 ${index}</body>`)));
  const originalFilm = await readFile(path.join(nativeHome, 'film.html'));
  const exported = await request('/api/project-bundles/exports', { projectId: id });
  assert.equal(exported.status, 201, JSON.stringify(exported.data));
  const file = await fetch(app.url + exported.data.downloadUrl); assert.equal(file.status, 200);
  const bytes = Buffer.from(await file.arrayBuffer()); assert.ok(bytes.length > 1000);
  const head = await fetch(app.url + exported.data.downloadUrl, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(Number(head.headers.get('content-length')), bytes.length);
  const received = await fetch(app.url + '/api/project-bundles/imports', { method: 'POST', headers: { 'Content-Type': 'application/x-gxproject' }, body: bytes });
  assert.equal(received.status, 201);
  const preview = await received.json(), restoreRoute = '/api/project-bundles/imports/' + preview.token + '/restore';
  assert.equal((await request(restoreRoute, {})).data.code, 'BUNDLE_CONFIRM_REQUIRED');
  let restoredFinished = false;
  const restoring = request(restoreRoute, { confirm: true, title: 'HTTP恢复副本' }).then(value => { restoredFinished = true; return value; });
  let activeRestore;
  while (!restoredFinished) {
    const listed = await request('/api/tasks?status=running');
    activeRestore = listed.data.items.find(item => item.type === 'project-restore');
    if (activeRestore) break;
    await sleep(2);
  }
  assert.ok(activeRestore, 'The restore commit must be observable in the task center');
  assert.equal(activeRestore.canCancel, false); assert.equal(activeRestore.canRetry, false);
  const cancelled = await request('/api/tasks/' + activeRestore.id + '/cancel', {});
  assert.equal(cancelled.status, 409); assert.equal(cancelled.data.code, 'TASK_CANCEL_UNAVAILABLE');
  const restored = await restoring;
  assert.equal(restored.status, 201, JSON.stringify(restored.data)); assert.notEqual(restored.data.projectId, id);
  assert.equal(restored.data.analysis.rebound.length, 1);
  const targetId = restored.data.projectId;
  const restoredTask = (await request('/api/tasks?projectId=' + targetId)).data.items.find(item => item.id === activeRestore.id);
  assert.equal(restoredTask.status, 'succeeded'); assert.equal(restoredTask.projectName, 'HTTP恢复副本');
  assert.equal((await request('/api/tasks/' + restoredTask.id + '?projectId=' + id)).status, 404);
  assert.deepEqual(await readFile(path.join(nativeHome, 'film.html')), originalFilm);
  assert.equal((await request('/api/projects/' + targetId + '/source-analysis')).data.items.length, 1);
  const tasks = (await request('/api/tasks')).data.items;
  assert.ok(['source-analysis', 'export-preflight', 'project-backup', 'project-verify', 'project-restore'].every(type => tasks.some(task => task.type === type && task.status === 'succeeded')));
  assert.ok(tasks.find(task => task.type === 'project-backup').outputs.some(output => output.url === exported.data.downloadUrl));
  const closingAt = Date.now();
  await app.close();
  const closeMs = Date.now() - closingAt; assert.ok(closeMs < 5000, 'Shutdown should stop observers and the native worker promptly');
  if (process.env.GUANGXUAN_TEST_DIR) await writeFile(path.join(testParent, 'next-http-result.json'), JSON.stringify({ tasks: tasks.map(task => ({ type: task.type, status: task.status, canCancel: task.canCancel })), streamedBytes: bytes.length, restoreObservedUncancellable: true, restoredAnalysisCount: 1, originalFilmUnchanged: true, closeMs }, null, 2));
});
