import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createProjectStore } from '../lib/store.mjs';
import { createVideoService } from '../lib/video.mjs';
import { createOpenFilmManager } from '../lib/openfilm.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), command = promisify(execFile);
const bin = process.env.GUANGXUAN_BIN_DIR;
const digest = value => createHash('sha256').update(value).digest('hex');

test('real native import exposes a stable canonical asset without changing an empty timeline and supports later editing', { skip: !bin, timeout: 120000 }, async t => {
  const parent = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(parent, { recursive: true });
  const folder = await mkdtemp(path.join(parent, 'gx-native-import-')), dataDir = path.join(folder, 'data');
  let video, manager, server, resolveHook, registerHook;
  const report = { passed: false, folder, stages: [], hashes: {} };
  const store = await createProjectStore(dataDir);
  t.after(async () => {
    await manager?.close(); await video?.close(); await store.settle();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (!process.env.GUANGXUAN_KEEP_IMPORT_TESTS) { assert.equal(path.dirname(path.resolve(folder)), parent); assert.ok(path.basename(folder).startsWith('gx-native-import-')); await rm(folder, { recursive: true, force: true }); }
    else t.diagnostic('Native import evidence: ' + folder);
  });
  const source = path.join(folder, 'source.mp4'), other = path.join(folder, 'other.mp4'), image = path.join(folder, 'picture.png');
  await Promise.all([[source, 'red'], [other, 'blue']].map(([file, color]) => command(path.join(bin, 'ffmpeg.exe'), ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=320x180:r=15:d=4`, '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', file], { windowsHide: true, timeout: 30000 })));
  await command(path.join(bin, 'ffmpeg.exe'), ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=320x180', '-frames:v', '1', image], { windowsHide: true, timeout: 30000 });
  video = await createVideoService({ dataDir, root, ffmpegPath: path.join(bin, 'ffmpeg.exe'), ffprobePath: path.join(bin, 'ffprobe.exe') });
  const asset = await video.importLocalFile(source, { name: '华中科技大学宣传片-隔离演示素材.mp4' }), second = await video.importLocalFile(other, { name: '第二份隔离素材.mp4' }), picture = await video.importLocalFile(image, { name: '图片导入隔离演示.png' });
  server = http.createServer(async (req, res) => { try { if (!await video.handler(req, res, new URL(req.url, 'http://127.0.0.1'))) { res.writeHead(404); res.end(); } } catch (error) { res.writeHead(error.status || 500); res.end(error.code); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${server.address().port}`; assert.notEqual(new URL(origin).port, '4417');
  manager = await createOpenFilmManager({ dataDir, root, store,
    resolveAsset: async id => { const result = await video.resolveAsset(id); await resolveHook?.(id, result); return result; },
    registerOwnedAsset: async (...args) => { const result = await video.registerOwnedAsset(...args); await registerHook?.(args, result); return result; },
  });
  assert.equal((await manager.status()).available, true);
  const empty = { kind: 'video', title: '隔离空工程', video: { timeline: [], captions: [], aspect: '16:9', resolution: '720' } };
  await store.save('empty-import', empty);
  const before = await manager.context('empty-import', origin); assert.equal(before.assets.length, 0); assert.equal(before.duration, 0); assert.equal(before.timeline.length, 0);
  const film = path.join(dataDir, 'openfilm/projects/empty-import/film.html'), originalFilm = await readFile(film);
  const imported = await manager.importAsset('empty-import', asset.id, origin, { expectedRevision: before.revision, requestId: 'native-import-once' });
  assert.equal(imported.imported, true); assert.equal(imported.asset.type, 'video'); assert.notEqual(imported.asset.id, asset.id); assert.equal(imported.revision, before.revision);
  assert.ok(!JSON.stringify(imported).includes(folder)); assert.match(imported.asset.name, /华中科技大学/);
  const canonical = await video.resolveAsset(imported.asset.id); assert.ok(canonical.path.startsWith(path.join(dataDir, 'openfilm/projects/empty-import') + path.sep));
  assert.equal(digest(await readFile(canonical.path)), digest(await readFile(source)));
  const after = await manager.context('empty-import', origin);
  assert.equal(after.assets.length, 1); assert.equal(after.assets[0].id, imported.asset.id); assert.equal(after.timeline.length, 0); assert.equal(after.duration, 0); assert.equal(after.revision, before.revision);
  assert.deepEqual(await readFile(film), originalFilm, 'Importing only files never edits film.html');
  const repeated = await manager.importAsset('empty-import', asset.id, origin, { expectedRevision: after.revision, requestId: 'native-import-once' });
  assert.equal(repeated.alreadyImported, true); assert.equal(repeated.asset.id, imported.asset.id);
  assert.equal((await manager.context('empty-import', origin)).assets.length, 1);
  await assert.rejects(manager.importAsset('empty-import', second.id, origin, { expectedRevision: after.revision, requestId: 'native-import-once' }), error => error.code === 'INVALID_ASSISTANT_OPERATION');
  await assert.rejects(manager.importAsset('empty-import', '../private.mp4', origin, { expectedRevision: after.revision }), error => error.code === 'INVALID_OPENFILM_ASSET');
  await assert.rejects(manager.importAsset('empty-import', second.id, origin, {}), error => error.code === 'OPENFILM_REVISION_REQUIRED');
  report.stages.push('canonical-project-file-import-without-timeline-change');
  report.hashes.source = digest(await readFile(source)); report.hashes.imported = digest(await readFile(canonical.path)); report.hashes.emptyFilm = digest(originalFilm);

  const edited = await manager.applyPlan('empty-import', { timeline: Array.from({ length: 5 }, () => ({ assetId: imported.asset.id, start: 0, end: 4 })), captions: [{ start: 0, end: 3, text: '20秒剪辑链隔离演示' }] }, origin, after.revision, { keepUndo: true, editScope: { assetIds: [imported.asset.id], placement: { mode: 'append' } } });
  assert.equal(edited.duration, 20); assert.equal((await manager.context('empty-import', origin)).timeline.length, 5);
  await assert.rejects(manager.importAsset('empty-import', second.id, origin, { expectedRevision: after.revision, requestId: 'stale-revision' }), error => error.code === 'OPENFILM_REVISION_CONFLICT');
  assert.equal((await manager.context('empty-import', origin)).assets.length, 1);
  await manager.undoAssistant('empty-import', edited.undo.id, origin);
  const restored = await manager.context('empty-import', origin); assert.equal(restored.timeline.length, 0); assert.equal(restored.assets[0].id, imported.asset.id); assert.deepEqual(await readFile(film), originalFilm);
  report.stages.push('canonical-import-then-real-20-second-plan-and-undo');

  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(manager.importAsset('empty-import', second.id, origin, { expectedRevision: restored.revision, signal: cancelled.signal }), error => error.code === 'REQUEST_CANCELLED');
  const duringResolve = new AbortController(); resolveHook = async id => { if (id === second.id) duringResolve.abort(); };
  await assert.rejects(manager.importAsset('empty-import', second.id, origin, { expectedRevision: restored.revision, signal: duringResolve.signal }), error => error.code === 'REQUEST_CANCELLED'); resolveHook = null;
  assert.equal((await manager.context('empty-import', origin)).assets.length, 1);
  const lateStop = new AbortController(); let stoppedAtRegistration = false;
  registerHook = async () => { if (!stoppedAtRegistration) { stoppedAtRegistration = true; lateStop.abort(); } };
  const late = await manager.importAsset('empty-import', second.id, origin, { expectedRevision: restored.revision, signal: lateStop.signal, requestId: 'late-stop-receipt' }); registerHook = null;
  assert.equal(lateStop.signal.aborted, true); assert.equal(late.imported, true);
  const withLate = await manager.context('empty-import', origin); assert.ok(withLate.assets.some(item => item.id === late.asset.id)); assert.equal(withLate.duration, 0); assert.equal(withLate.timeline.length, 0);
  assert.deepEqual(await readFile(film), originalFilm); report.stages.push('cancel-before-copy-and-keep-receipt-after-completed-copy');

  const importedPicture = await manager.importAsset('empty-import', picture.id, origin, { expectedRevision: withLate.revision, requestId: 'native-image-import' });
  assert.equal(importedPicture.asset.type, 'image'); assert.notEqual(importedPicture.asset.id, picture.id);
  const pictureContext = await manager.context('empty-import', origin); assert.equal(pictureContext.assets.length, 3); assert.ok(pictureContext.assets.some(item => item.id === importedPicture.asset.id && item.type === 'image'));
  assert.equal(pictureContext.timeline.length, 0); assert.equal(pictureContext.duration, 0); assert.equal(pictureContext.revision, withLate.revision);
  assert.deepEqual(await readFile(film), originalFilm);
  const canonicalPicture = await video.resolveAsset(importedPicture.asset.id); assert.equal(digest(await readFile(canonicalPicture.path)), digest(await readFile(image)));
  report.stages.push('real-png-import-canonical-id-and-empty-timeline-preserved'); report.hashes.sourcePicture = digest(await readFile(image)); report.hashes.importedPicture = digest(await readFile(canonicalPicture.path));

  await store.save('owner-before-copy', { ...empty, createdAt: '2026-01-01T00:00:00.000Z' });
  const ownerBefore = await manager.context('owner-before-copy', origin); let swapped = false;
  resolveHook = async id => { if (id === asset.id && !swapped) { swapped = true; await store.remove('owner-before-copy'); await store.save('owner-before-copy', { ...empty, createdAt: '2026-02-01T00:00:00.000Z' }); } };
  await assert.rejects(manager.importAsset('owner-before-copy', asset.id, origin, { expectedRevision: ownerBefore.revision, requestId: 'owner-swap' }), error => error.code === 'OPENFILM_OWNER_CHANGED'); resolveHook = null;
  assert.equal((await manager.context('owner-before-copy', origin)).assets.length, 0);
  await assert.rejects(manager.importAsset('owner-before-copy', asset.id, origin, { expectedRevision: ownerBefore.revision, requestId: 'different-request' }), error => error.code === 'OPENFILM_OWNER_CHANGED');
  assert.equal((await manager.context('empty-import', origin)).assets.length, 3, 'Other project files stay intact');
  report.stages.push('owner-recreation-and-stale-native-revision-rejected');
  report.canonicalAssetId = imported.asset.id; report.originalAssetId = asset.id; report.finalDuration = withLate.duration; report.timelineUnchangedByImport = true; report.passed = true;
  await writeFile(path.join(folder, 'verification.json'), JSON.stringify(report, null, 2));
});
