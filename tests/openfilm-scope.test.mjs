import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createProjectStore } from '../lib/store.mjs';
import { createVideoService } from '../lib/video.mjs';
import { createOpenFilmManager } from '../lib/openfilm.mjs';
import { readFilmFile, clipFade } from '../integrations/openfilm/packages/openfilm/src/film-doc.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const command = promisify(execFile);
const all = doc => doc.tracks.flatMap(track => track.clips);
const fails = (fn, code) => assert.rejects(async () => fn(), error => error.code === code);

test('native scoped edits enforce chosen assets, preserve other content, insert in sync and undo atomically', { timeout: 120000, skip: process.env.GUANGXUAN_TEST_OPENFILM !== '1' }, async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'guangxuan-scope-test-'));
  let videoService, manager;
  t.after(async () => {
    await manager?.close(); await videoService?.close();
    const target = path.resolve(folder);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('guangxuan-scope-test-')) throw new Error('Unsafe test cleanup');
    await rm(target, { recursive: true, force: true });
  });
  const binary = name => process.env[`GUANGXUAN_${name.toUpperCase()}`] || (process.env.GUANGXUAN_BIN_DIR ? path.join(process.env.GUANGXUAN_BIN_DIR, name + (process.platform === 'win32' ? '.exe' : '')) : name);
  const run = args => command(binary('ffmpeg'), ['-hide_banner', '-nostdin', '-v', 'error', ...args], { windowsHide: true, timeout: 30000 });
  const aFile = path.join(folder, 'A.mp4'), bFile = path.join(folder, 'B.mp4'), generatedFile = path.join(folder, 'generated.mp4'), musicFile = path.join(folder, 'music.wav');
  await Promise.all([
    run(['-f', 'lavfi', '-i', 'color=c=navy:s=320x180:r=15:d=10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', aFile]),
    run(['-f', 'lavfi', '-i', 'color=c=lime:s=320x180:r=15:d=10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', bFile]),
    run(['-f', 'lavfi', '-i', 'color=c=orange:s=320x180:r=15:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', generatedFile]),
    run(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=10', '-c:a', 'pcm_s16le', musicFile]),
  ]);
  const dataDir = path.join(folder, 'data'), store = await createProjectStore(dataDir);
  videoService = await createVideoService({ dataDir, root, ffmpegPath: binary('ffmpeg'), ffprobePath: binary('ffprobe') });
  const [a, b, generated, music] = await Promise.all([aFile, bFile, generatedFile, musicFile].map(filename => videoService.importLocalFile(filename)));
  const id = 'scope-fixture', origin = 'http://127.0.0.1:49100';
  await store.save(id, { kind: 'video', title: 'Scoped fixture', video: { timeline: [{ assetId: a.id, start: 0, end: 4 }, { assetId: b.id, start: 0, end: 4 }], captions: [{ start: 0, end: 8, text: 'Original caption' }], music: { assetId: music.id, volume: .2 }, aspect: '16:9', resolution: '720' } });
  manager = await createOpenFilmManager({ dataDir, root, store, resolveAsset: id => videoService.resolveAsset(id), registerOwnedAsset: (...args) => videoService.registerOwnedAsset(...args) });
  const opened = await manager.open(id, origin);
  let wrapper = '';
  manager.serveEditor({ method: 'GET' }, { writeHead() {}, end(value) { wrapper = String(value); } }, new URL('/openfilm/editor.html', origin));
  const nativeUrl = new URL(/id="openfilm-studio"[^>]+src="([^"]+)"/.exec(wrapper)[1].replaceAll('&amp;', '&'));
  const filmPath = path.join(dataDir, 'openfilm/projects', id, 'film.html');
  const read = async () => { const result = readFilmFile(await readFile(filmPath, 'utf8')); assert.deepEqual(result.problems, []); return result.doc; };
  const context = () => manager.context(id, origin);
  async function nativeEdit(ops, base) {
    const response = await fetch(`${nativeUrl.origin}/api/projects/${opened.nativeProjectId}/edit`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-studio-key': nativeUrl.searchParams.get('key') }, body: JSON.stringify({ base, ops }) });
    const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value;
  }
  let current = await context();
  const firstId = current.timeline[0].id;
  await nativeEdit([{ op: 'props', edits: [{ clip: firstId, prop: 'volume', value: .35 }, { clip: firstId, prop: 'fade', value: [.5, .5] }, { clip: firstId, prop: 'motion', value: { opacity: [{ t: 0, v: .5 }, { t: 4, v: 1 }] } }] }], current.revision);
  current = await context();
  const before = await read(), bytesBefore = await readFile(filmPath, 'utf8');
  const chosen = current.timeline[0].assetId, other = current.timeline[1].assetId;
  const append = { assetIds: [chosen], placement: { mode: 'append' } };
  const plan = { timeline: [{ assetId: chosen, clipId: firstId, start: 1, end: 3 }], captions: [{ start: 0, end: 1, text: 'Segment caption' }], captionMode: 'replace' };
  const free = { assetIds: [chosen], placement: { mode: 'free' } };
  await fails(() => manager.applyPlan(id, plan, origin, current.revision, { editScope: free }), 'EDIT_PLACEMENT_UNRESOLVED');
  await fails(() => manager.applyPlan(id, { ...plan, placement: { mode: 'replace' } }, origin, current.revision, { editScope: free }), 'EDIT_SCOPE_REPLACE_REQUIRES_ALL');
  await fails(() => manager.applyPlan(id, { ...plan, placement: { mode: 'range', start: 0, end: 8 } }, origin, current.revision, { editScope: free }), 'EDIT_SCOPE_ASSET_FORBIDDEN');
  await fails(() => manager.appendAsset(id, generated.id, origin, undefined, { expectedRevision: current.revision, editScope: free }), 'EDIT_PLACEMENT_UNRESOLVED');
  assert.equal(await readFile(filmPath, 'utf8'), bytesBefore, 'Unresolved or out-of-selection free placement must not change the project');
  const freelyPlaced = await manager.applyPlan(id, { ...plan, placement: { mode: 'insert', at: 8 } }, origin, current.revision, { editScope: free, keepUndo: true });
  assert.equal(freelyPlaced.placement.mode, 'insert'); assert.equal(freelyPlaced.placement.at, 8);
  for (const clip of all(before)) assert.deepEqual(all(await read()).find(value => value.id === clip.id), clip);
  await manager.undoAssistant(id, freelyPlaced.undo.id, origin); assert.deepEqual(await read(), before);
  current = await context();
  await fails(() => manager.applyPlan(id, { timeline: [{ assetId: other, start: 0, end: 1 }] }, origin, current.revision, { editScope: append }), 'EDIT_SCOPE_ASSET_FORBIDDEN');
  await fails(() => manager.applyPlan(id, { timeline: [{ assetId: generated.id, start: 0, end: 1 }] }, origin, current.revision, { editScope: append }), 'EDIT_SCOPE_ASSET_FORBIDDEN');
  await fails(() => manager.applyPlan(id, plan, origin, current.revision, { editScope: { ...append, placement: { mode: 'replace' } } }), 'EDIT_SCOPE_REPLACE_REQUIRES_ALL');
  await fails(() => manager.applyPlan(id, { ...plan, look: { preset: 'url(https://outside.invalid/)', strength: 1 } }, origin, current.revision, { editScope: append }), 'INVALID_EDIT_EFFECT');
  assert.equal(await readFile(filmPath, 'utf8'), bytesBefore);
  const appended = await manager.applyPlan(id, plan, origin, current.revision, { keepUndo: true, editScope: append });
  assert.equal(appended.placement.at, 8); assert.equal(appended.duration, 10); assert.ok(appended.undo.id);
  const afterAppend = await read(), originalIds = new Set(all(before).map(clip => clip.id));
  for (const clip of all(before)) assert.deepEqual(all(afterAppend).find(value => value.id === clip.id), clip);
  const newPicture = all(afterAppend).find(clip => !originalIds.has(clip.id) && clip.src.endsWith('.mp4'));
  assert.notEqual(newPicture.id, firstId); assert.equal(newPicture.at, 8); assert.deepEqual(newPicture.time, [1, 3]);
  assert.equal(all(afterAppend).find(clip => !originalIds.has(clip.id) && clip.src.endsWith('.html')).at, 8);
  await fails(() => manager.applyPlan(id, plan, origin, current.revision, { editScope: append }), 'OPENFILM_REVISION_CONFLICT');
  await manager.undoAssistant(id, appended.undo.id, origin); assert.deepEqual(await read(), before);

  current = await context();
  const insert = { ...append, placement: { mode: 'insert', at: 2 } };
  const inserted = await manager.applyPlan(id, plan, origin, current.revision, { keepUndo: true, editScope: insert });
  assert.equal(inserted.placement.at, 2); assert.equal(inserted.duration, 10);
  const afterInsert = await read();
  assert.deepEqual(all(afterInsert).find(clip => clip.id === firstId).time, [0, 2]);
  const originalPicture = all(before).find(clip => clip.id === firstId);
  const rightPicture = all(afterInsert).find(clip => !originalIds.has(clip.id) && clip.src === originalPicture.src && clip.time[0] === 2);
  assert.equal(rightPicture.at, 4); assert.equal(rightPicture.volume, .35); assert.deepEqual(clipFade(rightPicture), [0, .5]);
  for (const source of all(before).filter(clip => clip.src.endsWith('.html') || clip.src.endsWith('.wav'))) {
    const right = all(afterInsert).find(clip => clip.id !== source.id && clip.src === source.src);
    assert.ok(right); assert.equal(right.at, 4); assert.deepEqual(right.time, [2, 8]);
  }
  assert.equal(all(afterInsert).find(clip => clip.id === current.timeline[1].id).at, 6);
  await manager.undoAssistant(id, inserted.undo.id, origin); assert.deepEqual(await read(), before);

  current = await context();
  const captionOnly = await manager.applyPlan(id, { captions: [{ start: 1, end: 2, text: 'Absolute caption' }], captionMode: 'append' }, origin, current.revision, { keepUndo: true, editScope: insert });
  const captionDoc = await read();
  for (const clip of all(before)) assert.deepEqual(all(captionDoc).find(value => value.id === clip.id), clip);
  assert.equal(all(captionDoc).find(clip => !originalIds.has(clip.id)).at, 1);
  await manager.undoAssistant(id, captionOnly.undo.id, origin);

  current = await context();
  const mainTrack = before.tracks.findIndex(track => track.attrs?.id === 'guangxuan-picture');
  await nativeEdit([{ op: 'track', track: mainTrack, field: 'locked', value: true }], current.revision);
  current = await context(); const locked = await readFile(filmPath, 'utf8');
  await fails(() => manager.applyPlan(id, plan, origin, current.revision, { editScope: insert }), 'OPENFILM_TRACK_LOCKED');
  assert.equal(await readFile(filmPath, 'utf8'), locked);
  await nativeEdit([{ op: 'track', track: mainTrack, field: 'locked', value: false }], current.revision);
  current = await context();
  await writeFile(path.join(path.dirname(filmPath), 'pages/unknown.html'), '<!doctype html><html><body>Fixture<script>window.film={duration:3,frame(){}};</script></body></html>');
  await nativeEdit([{ op: 'insert', newTrack: 0, clip: { id: 'unknown-page', src: 'pages/unknown.html', size: { w: 1280, h: 720 } } }], current.revision);
  current = await context(); const unknown = await readFile(filmPath, 'utf8');
  await fails(() => manager.applyPlan(id, plan, origin, current.revision, { editScope: append }), 'OPENFILM_LENGTH_UNKNOWN');
  assert.equal(await readFile(filmPath, 'utf8'), unknown);
  await nativeEdit([{ op: 'remove', clip: 'unknown-page' }], current.revision);

  current = await context();
  const request = { keepUndo: true, expectedRevision: current.revision, requestId: 'fixture-animation-once', editScope: { ...append, placement: { mode: 'insert', at: 12 } } };
  const animation = await manager.appendAsset(id, generated.id, origin, undefined, request);
  const retry = await manager.appendAsset(id, generated.id, origin, undefined, request);
  assert.equal(animation.revision, retry.revision); assert.equal(animation.placement.at, 12);
  const animationDoc = await read();
  assert.equal(all(animationDoc).filter(clip => clip.attrs?.['data-guangxuan-operation'] === request.requestId).length, 1);
  for (const clip of all(before)) assert.deepEqual(all(animationDoc).find(value => value.id === clip.id), clip);
  await manager.undoAssistant(id, animation.undo.id, origin); assert.deepEqual(await read(), before);

  current = await context();
  const withLook = await manager.applyPlan(id, { timeline: [{ assetId: chosen, start: 0, end: 1 }], look: { preset: 'mono', strength: 1 }, fade: { duration: .2 } }, origin, current.revision, { keepUndo: true, editScope: append });
  const effectDoc = await read();
  for (const clip of all(before)) assert.deepEqual(all(effectDoc).find(value => value.id === clip.id), clip);
  const effectClip = all(effectDoc).find(clip => !originalIds.has(clip.id));
  assert.match(effectClip.style, /filter: grayscale\(1\)/); assert.deepEqual(clipFade(effectClip), [.2, .2]);
  const started = await manager.exportVideo(id, { name: 'filter-fixture', fps: 10, range: [8.4, 8.6] }, origin);
  let exported;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    exported = (await manager.nativeExports(id)).exports.find(job => job.id === started.export.id);
    assert.notEqual(exported?.status, 'error', 'Native effect export failed');
    if (exported?.status === 'done') break;
    await delay(150);
  }
  assert.equal(exported?.status, 'done');
  const response = await fetch(`${nativeUrl.origin}/api/projects/${opened.nativeProjectId}/exports/${started.export.id}/file`, { headers: { 'x-studio-key': nativeUrl.searchParams.get('key') } });
  assert.equal(response.status, 200);
  const rendered = path.join(folder, 'actual-filter.mp4'); await writeFile(rendered, Buffer.from(await response.arrayBuffer()));
  const pixels = await command(binary('ffmpeg'), ['-v', 'error', '-i', rendered, '-frames:v', '1', '-vf', 'scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer', windowsHide: true, timeout: 30000 });
  assert.equal(pixels.stdout.length, 3);
  assert.ok(Math.max(...pixels.stdout) - Math.min(...pixels.stdout) <= 3, 'The exported navy clip is actually grayscale');
  await manager.undoAssistant(id, withLook.undo.id, origin); assert.deepEqual(await read(), before);
});
