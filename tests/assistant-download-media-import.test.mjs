import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, fork } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createProjectStore } from '../lib/store.mjs';
import { createVideoService } from '../lib/video.mjs';
import { createOpenFilmManager } from '../lib/openfilm.mjs';
import { createAssistantWebService } from '../lib/assistant-web.mjs';
import { createAssistantDownloadService } from '../lib/assistant-downloads.mjs';
import { createAssistantAppTools } from '../lib/assistant-app-tools.mjs';

const root = path.resolve(import.meta.dirname, '..'), bin = process.env.GUANGXUAN_BIN_DIR, command = promisify(execFile);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const code = expected => error => error.code === expected;

async function fixture(t) {
  const parent = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(parent, { recursive: true });
  const folder = await mkdtemp(path.join(parent, 'gx-media-operation-')), dataDir = path.join(folder, 'data');
  const store = await createProjectStore(dataDir), projectId = 'media-operation';
  await store.save(projectId, { kind: 'video', title: '隔离素材链', video: { timeline: [], captions: [], aspect: '16:9', resolution: '720' } });
  const files = { video: path.join(folder, 'original.mp4'), image: path.join(folder, 'original.png'), audio: path.join(folder, 'original.wav') };
  await Promise.all([
    command(path.join(bin, 'ffmpeg.exe'), ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=15:d=1', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', files.video], { windowsHide: true }),
    command(path.join(bin, 'ffmpeg.exe'), ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=green:s=320x180', '-frames:v', '1', '-threads', '1', files.image], { windowsHide: true }),
    command(path.join(bin, 'ffmpeg.exe'), ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=1', '-c:a', 'pcm_s16le', files.audio], { windowsHide: true }),
  ]);
  const bytes = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([type, file]) => [type, await readFile(file)])));
  const video = await createVideoService({ dataDir, root, ffmpegPath: path.join(bin, 'ffmpeg.exe'), ffprobePath: path.join(bin, 'ffprobe.exe') });
  let resolveHook, registerHook;
  let manager = await createOpenFilmManager({ dataDir, root, store,
    resolveAsset: async id => { const result = await video.resolveAsset(id); await resolveHook?.(id); return result; },
    registerOwnedAsset: async (...args) => { const result = await video.registerOwnedAsset(...args); await registerHook?.(); return result; },
  });
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1'), type = { '/original.mp4': 'video', '/original.png': 'image', '/original.wav': 'audio' }[url.pathname];
      if (type) { res.writeHead(200, { 'content-type': { video: 'video/mp4', image: 'image/png', audio: 'audio/wav' }[type] }); res.end(bytes[type]); return; }
      if (await video.handler(req, res, url)) return;
      res.writeHead(404); res.end();
    } catch (error) { res.writeHead(error.status || 500); res.end(error.code); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`; assert.notEqual(new URL(origin).port, '4417');
  const web = createAssistantWebService({ dependencies: { lookup: async () => [{ address: '93.184.216.34', family: 4 }], request: (target, options) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: target.url.pathname, signal: options.signal, headers: { Host: target.url.host } }, resolve); req.once('error', reject); req.end();
  }) } });
  const downloads = await createAssistantDownloadService({ dataDir, store, videoService: video, webTools: web });
  const apps = [], children = [];
  const app = () => { const value = createAssistantAppTools({ store, openFilm: manager, videoService: video, downloads }); apps.push(value); return value; };
  const ctx = (patch = {}) => ({ projectId, runId: randomUUID(), callId: randomUUID(), instruction: '登记媒体，不修改时间线', scopeAuthority: 'dialog', mode: 'auto', origin, signal: new AbortController().signal, update() {}, ...patch });
  const call = (adapter, name, args, context) => adapter.tools.find(tool => tool.name === name).execute(args, { ...context, callId: randomUUID() });
  t.after(async () => {
    for (const child of children) if (child.connected) { const ended = new Promise(resolve => child.once('exit', resolve)); child.send('close'); await ended; }
    await Promise.all(apps.map(value => value.close())); await manager.close(); await downloads.close(); await web.close(); await video.close(); await store.settle();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    if (!process.env.GUANGXUAN_KEEP_MEDIA_OPERATION_TESTS) { assert.equal(path.dirname(folder), parent); assert.ok(path.basename(folder).startsWith('gx-media-operation-')); await rm(folder, { recursive: true, force: true }); }
    else t.diagnostic('Media operation evidence: ' + folder);
  });
  return { folder, dataDir, store, projectId, video, downloads, files, bytes, origin, app, ctx, call, children,
    get manager() { return manager; },
    async restartManager() { await manager.close(); manager = await createOpenFilmManager({ dataDir, root, store, resolveAsset: async id => { const result = await video.resolveAsset(id); await resolveHook?.(id); return result; }, registerOwnedAsset: async (...args) => { const result = await video.registerOwnedAsset(...args); await registerHook?.(); return result; } }); },
    resolveHook(fn) { resolveHook = fn; }, registerHook(fn) { registerHook = fn; },
  };
}

test('downloaded PNG MP4 WAV import through actual manager CAS with canonical scope, provenance, reuse and cancellation', { skip: !bin, timeout: 120000 }, async t => {
  const f = await fixture(t), adapter = f.app(), context = f.ctx({ scopeAuthority: 'explicit-scope', editScope: { assetIds: [], placement: { mode: 'append' } } }), receipts = {}, downloaded = {};
  const before = await f.manager.context(f.projectId, f.origin), film = path.join(f.dataDir, 'openfilm/projects', f.projectId, 'film.html'), filmBefore = await readFile(film);
  for (const [type, extension] of [['video', 'mp4'], ['image', 'png'], ['audio', 'wav']]) {
    const saved = await f.downloads.download(`https://materials.example.com/original.${extension}`, { projectId: f.projectId, runId: context.runId }); downloaded[type] = saved.download;
    receipts[type] = await f.call(adapter, 'download_media_import', { downloadId: saved.download.id }, context);
    const actual = (await f.manager.context(f.projectId, f.origin)).assets.find(asset => asset.id === receipts[type].data.assetId);
    assert.ok(actual); assert.equal(actual.type, type); assert.notEqual(receipts[type].data.sourceAssetId, actual.id); assert.equal(receipts[type].data.asset.id, actual.id);
    assert.equal(receipts[type].effects[0].importedAssetId, actual.id); assert.equal(receipts[type].effects[0].changed, true);
    assert.equal(receipts[type].data.asset.provenance.requestedUrl, `https://materials.example.com/original.${extension}`);
    assert.equal(receipts[type].data.asset.provenance.sha256, sha(f.bytes[type]));
    assert.equal(sha(await readFile((await f.video.resolveAsset(actual.id)).path)), sha(f.bytes[type]));
  }
  assert.deepEqual((await adapter.progressContext(context)).scope.assetIds.sort(), Object.values(receipts).map(receipt => receipt.data.assetId).sort());
  assert.deepEqual(await readFile(film), filmBefore); assert.equal((await f.manager.context(f.projectId, f.origin)).revision, before.revision);
  await adapter.close(); await f.restartManager();
  const restored = f.app(), restoredContext = f.ctx();
  const repeated = await f.call(restored, 'download_media_import', { downloadId: downloaded.video.id }, restoredContext);
  assert.equal(repeated.data.assetId, receipts.video.data.assetId); assert.equal(repeated.data.alreadyImported, true); assert.equal(repeated.effects[0].changed, false);
  assert.equal((await f.manager.context(f.projectId, f.origin)).assets.length, 3);
  const abort = new AbortController(); f.resolveHook(() => abort.abort());
  // A fresh prepared download triggers real resolution in import, not an old
  // adapter receipt. Stop must reach manager's signal and retain its scope.
  const pendingContext = f.ctx({ signal: abort.signal });
  await assert.rejects(f.call(restored, 'download_media_import', { downloadId: downloaded.audio.id }, pendingContext), code('REQUEST_CANCELLED'));
  f.resolveHook(null); assert.deepEqual(await readFile(film), filmBefore);
  const edited = await f.manager.applyPlan(f.projectId, { timeline: [{ assetId: receipts.video.data.assetId, start: 0, end: 1 }], captions: [] }, f.origin, before.revision, { keepUndo: true });
  await assert.rejects(f.call(restored, 'download_media_import', { downloadId: downloaded.image.id }, restoredContext), code('ASSISTANT_CONFLICT'));
  assert.equal((await f.manager.context(f.projectId, f.origin)).duration, 1);
  await writeFile(path.join(f.folder, 'import-verification.json'), JSON.stringify({ passed: true, externalModelCalls: 0, receipts, repeated, cancelledBeforeCopy: true, staleNativeRevisionRejected: true, actualEditDuration: edited.duration }, null, 2));
});

test('real completed native export downloads after cold server restart; invalid, recreated-owner, overwritten and absent files reject without killing Node', { skip: !bin, timeout: 180000 }, async t => {
  const f = await fixture(t), asset = await f.video.importLocalFile(f.files.video, { name: '一秒实际视频.mp4' }), empty = await f.manager.context(f.projectId, f.origin);
  const imported = await f.manager.importAsset(f.projectId, asset.id, f.origin, { expectedRevision: empty.revision, requestId: 'export-source' });
  const planned = await f.manager.applyPlan(f.projectId, { timeline: [{ assetId: imported.asset.id, start: 0, end: 1 }], captions: [] }, f.origin, empty.revision);
  const started = await f.manager.exportNative(f.projectId, { kind: 'video', codec: 'h264', fps: 15, shortEdge: 180, audio: false, hardware: false, name: '冷重启一秒验证' }, f.origin, { expectedRevision: planned.revision });
  let job; const deadline = Date.now() + 120000;
  do { job = (await f.manager.nativeExports(f.projectId)).exports.find(item => item.id === started.export.id); if (['done', 'failed', 'cancelled'].includes(job?.status)) break; await new Promise(resolve => setTimeout(resolve, 100)); } while (Date.now() < deadline);
  assert.equal(job.status, 'done');
  const film = path.join(f.dataDir, 'openfilm/projects', f.projectId, 'film.html'), filmBefore = await readFile(film), manifestFile = path.join(path.dirname(film), '.guangxuan-exports.json');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8')), receipt = manifest.exports.find(item => item.id === job.id), bytes = await readFile(receipt.path); assert.equal(receipt.sha256, sha(bytes));
  await command(path.join(bin, 'ffmpeg.exe'), ['-v', 'error', '-nostdin', '-i', receipt.path, '-f', 'null', '-'], { windowsHide: true });
  await f.manager.close();
  const child = fork(fileURLToPath(new URL('./fixtures/native-download-server.mjs', import.meta.url)), [], { execArgv: [], windowsHide: true, env: { ...process.env, GX_MEDIA_OPERATION_DATA: f.dataDir }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }); f.children.push(child);
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const origin = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('Cold server startup timeout')), 30000); child.once('message', message => { clearTimeout(timer); resolve(message.origin); }); child.once('exit', value => { clearTimeout(timer); reject(Error('Cold server exited ' + value + ': ' + stderr)); }); });
  assert.notEqual(new URL(origin).port, '4417');
  const head = await fetch(origin + job.downloadUrl, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(Number(head.headers.get('content-length')), bytes.length);
  const fresh = await fetch(origin + job.downloadUrl); assert.equal(fresh.status, 200); assert.equal(sha(Buffer.from(await fresh.arrayBuffer())), sha(bytes));
  const saved = path.join(f.folder, 'cold-restart-saved.mp4'); await writeFile(saved, bytes);
  const bad = await fetch(origin + job.downloadUrl.replace(job.id, 'not-a-real-job')); assert.equal(bad.status, 404); assert.equal(child.exitCode, null);
  const owner = await f.store.read(f.projectId); await f.store.remove(f.projectId); await f.store.save(f.projectId, { ...owner, createdAt: '2099-01-01T00:00:00.000Z' });
  const changedOwner = await fetch(origin + job.downloadUrl); assert.equal(changedOwner.status, 409); assert.equal((await changedOwner.json()).code, 'OPENFILM_OWNER_CHANGED');
  await f.store.remove(f.projectId); await f.store.save(f.projectId, owner);
  const changed = Buffer.from(bytes); changed[0] ^= 1; await writeFile(receipt.path, changed);
  const overwritten = await fetch(origin + job.downloadUrl); assert.equal(overwritten.status, 409); assert.equal((await overwritten.json()).code, 'OPENFILM_EXPORT_CHANGED');
  await rm(receipt.path); const missing = await fetch(origin + job.downloadUrl); assert.equal(missing.status, 404);
  assert.equal((await fetch(origin + '/api/tasks')).status, 200); assert.equal(child.exitCode, null); assert.equal(stderr, ''); assert.deepEqual(await readFile(film), filmBefore);
  await writeFile(path.join(f.folder, 'cold-download-verification.json'), JSON.stringify({ passed: true, externalModelCalls: 0, defaultNodeUnhandledPolicy: true, noExceptionListener: true, job, sha256: sha(bytes), saved, head: head.status, coldGet: fresh.status, invalid: bad.status, ownerChanged: changedOwner.status, overwritten: overwritten.status, missing: missing.status, processAlive: child.exitCode === null, timelineUnchanged: true, fullDecodePassed: true }, null, 2));
});
