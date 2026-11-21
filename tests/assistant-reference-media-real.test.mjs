import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createVideoService } from '../lib/video.mjs';
import { createProjectStore, assistantContentHash } from '../lib/store.mjs';
import { createReferenceService } from '../lib/references.mjs';
import { createSourceAnalysisService } from '../lib/source-analysis.mjs';
import { createOpenFilmManager } from '../lib/openfilm.mjs';
import { createAssistantFrameReader } from '../lib/assistant-frame-reader.mjs';
import { createAssistantAppTools } from '../lib/assistant-app-tools.mjs';

const command = promisify(execFile), root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const executable = name => process.env['GUANGXUAN_' + name.toUpperCase()] || (process.env.GUANGXUAN_BIN_DIR ? path.join(process.env.GUANGXUAN_BIN_DIR, name + (process.platform === 'win32' ? '.exe' : '')) : name);

test('actual FFmpeg and native manager read a reference-only video, analyse its shots and import its canonical editable copy', { timeout: 120000 }, async t => {
  const ffmpeg = executable('ffmpeg'), ffprobe = executable('ffprobe');
  try { await command(ffmpeg, ['-version'], { windowsHide: true, timeout: 10000 }); await command(ffprobe, ['-version'], { windowsHide: true, timeout: 10000 }); }
  catch { t.skip('FFmpeg and FFprobe are required.'); return; }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gx-real-reference-media-')), source = path.join(directory, 'three-scenes.mp4'), dataDir = path.join(directory, 'data');
  let app, reader, analysis, openFilm, references, videoService, store;
  t.after(async () => {
    await app?.close(); await reader?.close(); await analysis?.close(); await openFilm?.close(); await references?.close(); await videoService?.close(); await store?.settle();
    assert.equal(path.dirname(directory), os.tmpdir()); assert.ok(path.basename(directory).startsWith('gx-real-reference-media-')); await rm(directory, { recursive: true, force: true });
  });
  await command(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=10:d=1', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=10:d=1', '-f', 'lavfi', '-i', 'color=c=lime:s=160x90:r=10:d=1', '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]', '-map', '[v]', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', source], { windowsHide: true, timeout: 30000 });
  store = await createProjectStore(dataDir);
  const project = await store.save('real-reference-owner', { kind: 'video', title: '隔离真实参考验证', video: { timeline: [], captions: [], editScope: { assetIds: [], placement: { mode: 'free' } }, aspect: '16:9', resolution: '720' } });
  videoService = await createVideoService({ dataDir, root });
  const imported = await videoService.importLocalFile(source, { name: '实际三镜参考.mp4' });
  const asset = imported.asset || imported;
  references = await createReferenceService({ dataDir, store, videoService });
  const registered = await references.add(project.id, { type: 'video', name: '实际三镜参考', assetId: asset.id });
  openFilm = await createOpenFilmManager({ dataDir, root, store, resolveAsset: id => videoService.resolveAsset(id), registerOwnedAsset: (...args) => videoService.registerOwnedAsset(...args) });
  analysis = await createSourceAnalysisService({ dataDir, root, store, videoService, openFilm, references, ffmpegPath: ffmpeg, ffprobePath: ffprobe });
  reader = createAssistantFrameReader({ videoService, store, openFilm, references, sourceAnalysis: analysis });
  app = createAssistantAppTools({ store, openFilm, videoService, references, sourceAnalysis: analysis, frameReader: reader });
  const ctx = { projectId: project.id, runId: randomUUID(), callId: randomUUID(), mode: 'auto', instruction: '读取参考并精修现有动画', editScope: project.video.editScope, scopeAuthority: 'dialog', settings: {}, origin: 'http://127.0.0.1:12345', signal: new AbortController().signal, update() {} };
  const call = (name, args = {}) => app.tools.find(tool => tool.name === name).execute(args, ctx);
  const beforeNative = await openFilm.context(project.id, ctx.origin), beforeHash = assistantContentHash(await store.read(project.id));
  assert.equal(beforeNative.assets.length, 0);
  const metadata = await call('media_asset_read', { assetId: asset.id });
  assert.equal(metadata.data.registration.nativeImported, false); assert.ok(Math.abs(metadata.data.sourceDuration - 3) < .1);
  const frames = await call('media_frames_read', { assetId: asset.id, timestamps: [.5, 1.5, 2.5], pageSize: 3 });
  assert.equal(frames.imageBatch.length, 3); assert.equal(frames.data.asset.registration.nativeImported, false);
  assert.equal(new Set(frames.data.frames.map(frame => frame.sha256)).size, 3, 'Real three different coloured source frames');
  await call('media_frame_notes', { inspectionId: frames.data.inspectionId, notes: frames.data.frames.map(frame => ({ frameIndex: frame.index, description: '真实FFmpeg解码参考画面' })) });
  assert.equal((await call('media_frames_recall')).data.notes.length, 3);
  const overview = await call('media_analyze', { assetIds: [asset.id], maxFrames: 3, maxShotSeconds: 2 });
  assert.equal(overview.data.items[0].assetId, asset.id); assert.equal(overview.data.items[0].transcript.status, 'skipped'); assert.ok(overview.data.items[0].shots.length > 0);
  const shotFrames = await call('media_frames_read', { assetId: asset.id, mode: 'shots', pageSize: 3 });
  assert.ok(shotFrames.data.shots.length > 0); assert.equal(shotFrames.data.asset.registration.nativeImported, false);
  assert.equal((await openFilm.context(project.id, ctx.origin)).assets.length, 0, 'Reading reference never silently imports it');
  const nativeImport = await call('media_asset_import', { assetId: asset.id });
  assert.equal(nativeImport.data.imported, true); assert.notEqual(nativeImport.data.asset.id, asset.id); assert.equal(nativeImport.data.timelineChanged, false);
  const actualNative = await openFilm.context(project.id, ctx.origin);
  assert.equal(actualNative.assets.length, 1); assert.equal(actualNative.assets[0].id, nativeImport.data.asset.id); assert.equal(actualNative.timeline.length, 0); assert.equal(actualNative.duration, 0);
  assert.equal(assistantContentHash(await store.read(project.id)), beforeHash);
  assert.equal((await references.list(project.id)).items[0].id, registered.items[0].id);
  assert.equal((await call('media_asset_read', { assetId: nativeImport.data.asset.id })).data.registration.nativeImported, true);
  await assert.rejects(analysis.transcribeAsset(project.id, randomUUID(), { range: { start: 0, end: 1 } }), { code: 'SOURCE_ANALYSIS_ASSET_SCOPE' });
});
