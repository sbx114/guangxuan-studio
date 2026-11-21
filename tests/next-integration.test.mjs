import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createProjectStore } from '../lib/store.mjs';
import { createVideoService } from '../lib/video.mjs';
import { createOpenFilmManager } from '../lib/openfilm.mjs';
import { createReferenceService } from '../lib/references.mjs';
import { createSourceAnalysisService } from '../lib/source-analysis.mjs';
import { createProjectBundleService } from '../lib/project-bundles.mjs';
import { createTaskService } from '../lib/tasks.mjs';
import { createTaskAdapters } from '../lib/task-adapters.mjs';
import { createExportPreflight } from '../lib/export-preflight.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execute = promisify(execFile);
const binary = name => process.env[`GUANGXUAN_${name.toUpperCase()}`] || (process.env.GUANGXUAN_BIN_DIR ? path.join(process.env.GUANGXUAN_BIN_DIR, name + (process.platform === 'win32' ? '.exe' : '')) : name);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('real services preserve source analysis through a native project backup and restoration', { timeout: 120000 }, async t => {
  const ffmpeg = binary('ffmpeg'), ffprobe = binary('ffprobe');
  try { await execute(ffmpeg, ['-version'], { windowsHide: true, timeout: 5000 }); await execute(ffprobe, ['-version'], { windowsHide: true, timeout: 5000 }); }
  catch { t.skip('Set GUANGXUAN_BIN_DIR to a local FFmpeg runtime.'); return; }
  const testParent = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir());
  await mkdir(testParent, { recursive: true });
  const folder = await mkdtemp(path.join(testParent, 'gx-next-services-')), dataDir = path.join(folder, 'data');
  let video, openFilm, references, analysis, bundles, tasks, adapters, preflight, upstream;
  const evidence = { nativeWorker: false, providerRequests: 0, stages: [] };
  t.after(async () => {
    await bundles?.close(); await analysis?.close(); await adapters?.close(); await preflight?.close();
    await references?.close(); await openFilm?.close(); await video?.close(); await tasks?.close();
    if (upstream) { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); }
    assert.equal(path.dirname(path.resolve(folder)), testParent);
    assert.ok(path.basename(folder).startsWith('gx-next-services-'));
    await rm(folder, { recursive: true, force: true });
  });
  const secret = 'fixture-services-protocol-secret-123';
  const store = await createProjectStore(dataDir, { sensitiveStrings: () => [secret] });
  video = await createVideoService({ dataDir, root, ffmpegPath: ffmpeg, ffprobePath: ffprobe, sensitiveStrings: () => [secret] });
  openFilm = await createOpenFilmManager({ dataDir, root, store, resolveAsset: id => video.resolveAsset(id), registerOwnedAsset: (...args) => video.registerOwnedAsset(...args) });
  if (!(await openFilm.status()).available) { t.skip('Build the bundled native OpenFilm runtime before integration checks.'); return; }
  references = await createReferenceService({ dataDir, store, videoService: video });
  tasks = await createTaskService({ dataDir, projectName: async id => (await store.read(id))?.title || '已移除项目', sensitiveStrings: () => [secret] });
  adapters = createTaskAdapters({ tasks, videoService: video, sourceAnalysis: () => analysis, openFilm });
  analysis = await createSourceAnalysisService({ dataDir, root, store, videoService: video, openFilm, ffmpegPath: ffmpeg, ffprobePath: ffprobe, onJob: (job, meta) => adapters.analysisJob(job, meta) });
  bundles = await createProjectBundleService({ dataDir, root, store, videoService: video, openFilm, references, analysisService: analysis, sensitiveStrings: () => [secret] });
  preflight = await createExportPreflight({ dataDir, root, videoService: video, openFilm });
  const protocolText = '本机协议夹具的原声转写';
  upstream = http.createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/v1/audio/transcriptions');
      assert.equal(req.headers.authorization, `Bearer ${secret}`);
      const bytes = Buffer.concat(await Array.fromAsync(req));
      const form = await new Response(bytes, { headers: { 'Content-Type': req.headers['content-type'] } }).formData();
      assert.equal(form.get('model'), 'fixture-asr');
      assert.equal(Buffer.from(await form.get('file').arrayBuffer()).subarray(0, 4).toString(), 'RIFF');
      evidence.providerRequests++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text: protocolText, segments: [{ start: .1, end: 1.8, text: protocolText }] }));
    } catch { res.writeHead(500); res.end('{}'); }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${upstream.address().port}`;
  const settings = { baseUrl: origin + '/v1', apiKey: secret, model: 'fixture-asr', apiStyle: 'chat', timeoutSeconds: 10 };
  const source = path.join(folder, '中文 原素材.mp4');
  await execute(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=15:d=2', '-f', 'lavfi', '-i', 'sine=frequency=500:sample_rate=16000:duration=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source], { windowsHide: true, timeout: 20000 });
  const imported = await video.importLocalFile(source);
  const project = await store.save('next-services-original', { kind: 'video', title: '服务联动原项目', video: { aspect: '16:9', resolution: '720', timeline: [{ assetId: imported.id, start: 0, end: 2 }], captions: [], script: '原项目文字' } });
  const native = await openFilm.context(project.id, origin);
  evidence.nativeWorker = (await openFilm.status()).running;
  const asset = native.assets.find(item => item.type === 'video');
  assert.ok(asset);
  const analysisInput = { sources: [{ assetId: asset.id, start: .05, end: 1.95 }], options: { maxFrames: 3, transcribe: true, transcriptionModel: 'fixture-asr', language: 'zh' } };
  const originalResult = await analysis.analyze(project.id, analysisInput, { origin, settings });
  const originalItem = originalResult.items[0];
  assert.equal(originalItem.transcript.status, 'complete');
  assert.equal(originalItem.transcript.text, protocolText);
  assert.equal(evidence.providerRequests, 1);
  await references.add(project.id, { type: 'video', assetId: asset.id, name: '分段画面参考', sourceRange: { start: .25, end: 1.5 }, targetRange: { start: 0, end: 1.25 }, focus: '参考动作节奏' });
  await adapters.flush();
  const analyzedTask = (await tasks.list({ projectId: project.id })).items.find(item => item.type === 'source-analysis');
  assert.equal(analyzedTask.status, 'succeeded'); assert.equal(analyzedTask.progress, 100);
  evidence.stages.push('native-materialization-and-analysis');
  const originalProject = await readFile(path.join(dataDir, 'projects', project.id + '.json'));
  const filmFile = path.join(dataDir, 'openfilm/projects', project.id, 'film.html');
  const originalFilm = await readFile(filmFile);
  const originalCache = await readFile(path.join(dataDir, 'source-analysis', project.id, originalItem.cacheKey, 'result.json'));

  const exported = await tasks.track({ projectId: project.id, type: 'project-backup', title: '完整项目备份' }, ({ signal }) => bundles.prepareExport(project.id, { signal }));
  const backupTask = (await tasks.list({ projectId: project.id })).items.find(item => item.type === 'project-backup');
  assert.equal(backupTask.status, 'succeeded'); assert.equal(backupTask.outputs[0].url, exported.downloadUrl);
  const bytes = await readFile(path.join(dataDir, 'project-bundles', exported.token, 'project.gxproject'));
  const received = await tasks.track({ type: 'project-import', title: '检查完整包' }, ({ signal }) => bundles.receiveImport(Readable.from([bytes]), { signal }));
  // Metadata commit is deliberately tracked without a cancellation executor.
  const restoreTask = await tasks.create({ type: 'project-restore', title: '恢复完整包' });
  await tasks.update(restoreTask.id, { status: 'running', phase: '恢复并核验' });
  assert.equal((await tasks.get(restoreTask.id)).canCancel, false);
  const restored = await bundles.restoreImport(received.token, { title: '服务联动恢复副本', origin });
  await tasks.update(restoreTask.id, { projectId: restored.projectId, status: 'succeeded', phase: '已完成', progress: 100 });
  assert.notEqual(restored.projectId, project.id);
  assert.equal(restored.report.existingProjectsOverwritten, false);
  const newAssetId = restored.mapping.assets[asset.id];
  assert.ok(newAssetId); assert.notEqual(newAssetId, asset.id);
  assert.equal(restored.analysis.rebound.length, 1);
  assert.equal(restored.analysis.needsReanalysis.length, 0);
  assert.equal((await tasks.list({ projectId: restored.projectId })).items[0].id, restoreTask.id);
  assert.equal((await bundles.restoreImport(received.token, { origin })).projectId, restored.projectId);
  evidence.stages.push('tracked-package-and-new-project-restore');

  const restoredContext = await analysis.context(restored.projectId, { origin });
  assert.equal(restoredContext.sourceAnalysis.items.length, 1);
  const restoredList = await analysis.list(restored.projectId, { origin });
  assert.equal(restoredList.items.length, 1);
  const restoredItem = restoredList.items[0];
  assert.equal(restoredItem.assetId, newAssetId);
  assert.equal(restoredItem.analyzedAt, originalItem.analyzedAt);
  assert.equal(restoredItem.transcript.text, protocolText);
  assert.equal(restoredItem.provenance.imported, true);
  assert.deepEqual(restoredItem.range, originalItem.range);
  const frame = await analysis.frame(restored.projectId, restoredItem.cacheKey, restoredItem.keyframes[0].id, { origin });
  assert.equal(frame.bytes.subarray(0, 2).toString('hex'), 'ffd8');
  const repeated = await analysis.analyze(restored.projectId, { ...analysisInput, sources: [{ ...analysisInput.sources[0], assetId: newAssetId }] }, { origin, settings });
  assert.equal(repeated.items[0].analyzedAt, originalItem.analyzedAt);
  assert.equal(evidence.providerRequests, 1, 'Same-content restored analysis must not call a provider again');
  const restoredRefs = await references.list(restored.projectId);
  assert.equal(restoredRefs.items[0].assetId, newAssetId);
  assert.deepEqual(restoredRefs.items[0].sourceRange, { start: .25, end: 1.5 });
  assert.deepEqual(restoredRefs.items[0].targetRange, { start: 0, end: 1.25 });
  evidence.stages.push('rebound-analysis-frames-and-reference-ranges');

  const checked = await tasks.track({ projectId: restored.projectId, type: 'export-preflight', title: '导出体检' }, ({ signal }) => preflight.check(restored.projectId, { origin, signal }));
  assert.equal(checked.canExport, true, JSON.stringify(checked.issues));
  assert.equal(checked.checks.rendered, false);
  assert.equal(checked.checks.media.probed, 1);
  const restoredAsset = await video.resolveAsset(newAssetId), hidden = restoredAsset.path + '.missing-test';
  await rename(restoredAsset.path, hidden);
  try {
    const missing = await preflight.check(restored.projectId, { origin });
    assert.equal(missing.canExport, false);
    assert.ok(missing.issues.some(item => item.severity === 'error'));
  } finally { await rename(hidden, restoredAsset.path); }
  evidence.stages.push('preflight-uses-native-copy-and-blocks-missing-media');
  assert.deepEqual(await readFile(path.join(dataDir, 'projects', project.id + '.json')), originalProject);
  assert.deepEqual(await readFile(filmFile), originalFilm);
  assert.deepEqual(await readFile(path.join(dataDir, 'source-analysis', project.id, originalItem.cacheKey, 'result.json')), originalCache);
  await adapters.flush();
  const taskBytes = await readFile(path.join(dataDir, 'tasks/index.json'), 'utf8');
  assert.ok(!taskBytes.includes(secret)); assert.ok(!taskBytes.includes(protocolText));
  assert.ok(!taskBytes.includes('"settings"')); assert.ok(!taskBytes.includes('"result"'));
  evidence.stages.push('original-project-unchanged-and-task-persistence-bounded');
  evidence.originalFilmSha256 = hash(originalFilm);
  evidence.restoredAnalysis = { items: restoredList.items.length, rebound: restored.analysis.rebound.length, providerRequestsAfterRestore: evidence.providerRequests };
  if (process.env.GUANGXUAN_TEST_DIR) await writeFile(path.join(testParent, 'next-integration-result.json'), JSON.stringify(evidence, null, 2));
});
