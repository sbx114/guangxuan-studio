import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createProjectStore } from '../lib/store.mjs';
import { createVideoService } from '../lib/video.mjs';
import { createOpenFilmManager } from '../lib/openfilm.mjs';
import { readFilmFile, clipFade } from '../integrations/openfilm/packages/openfilm/src/film-doc.mjs';
import { readMotion } from '../integrations/openfilm/packages/openfilm/src/clip-motion.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), command = promisify(execFile);
const all = doc => doc.tracks.flatMap(track => track.clips || []);
const failure = (fn, code) => assert.rejects(fn, error => error.code === code);
test('real native range editing preserves outside curves, captions and locked music, and undoes atomically', { skip: process.env.GUANGXUAN_TEST_OPENFILM !== '1', timeout: 120000 }, async t => {
  const parent = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(parent, { recursive: true });
  const folder = await mkdtemp(path.join(parent, 'gx-range-native-')), dataDir = path.join(folder, 'data');
  let videoService, manager;
  t.after(async () => {
    await manager?.close(); await videoService?.close();
    if (!process.env.GUANGXUAN_KEEP_RANGE_TESTS) {
      assert.equal(path.dirname(path.resolve(folder)), parent); assert.ok(path.basename(folder).startsWith('gx-range-native-'));
      await rm(folder, { recursive: true, force: true });
    } else t.diagnostic('Native range evidence: ' + folder);
  });
  const bin = name => process.env['GUANGXUAN_' + name.toUpperCase()] || (process.env.GUANGXUAN_BIN_DIR ? path.join(process.env.GUANGXUAN_BIN_DIR, name + (process.platform === 'win32' ? '.exe' : '')) : name);
  async function ffmpeg(args) { await command(bin('ffmpeg'), ['-v', 'error', '-nostdin', ...args], { windowsHide: true, timeout: 30000 }); }
  const source = path.join(folder, 'source.mp4'), other = path.join(folder, 'later.mp4'), sound = path.join(folder, 'music.wav'), generated = path.join(folder, 'generated.mp4');
  await Promise.all([
    ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=15:d=12', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', source]),
    ffmpeg(['-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=15:d=4', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', other]),
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=12', '-c:a', 'pcm_s16le', sound]),
    ffmpeg(['-f', 'lavfi', '-i', 'color=c=orange:s=320x180:r=15:d=2', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', generated]),
  ]);
  const store = await createProjectStore(dataDir);
  videoService = await createVideoService({ dataDir, root, ffmpegPath: bin('ffmpeg'), ffprobePath: bin('ffprobe') });
  const [a, b, music, animation] = await Promise.all([source, other, sound, generated].map(file => videoService.importLocalFile(file)));
  const id = 'native-range-fixture', origin = 'http://127.0.0.1:49101';
  await store.save(id, { kind: 'video', title: 'range fixture', video: { timeline: [{ assetId: a.id, start: 0, end: 8 }, { assetId: b.id, start: 0, end: 4 }], captions: [{ start: 0, end: 12, text: 'Original caption' }], music: { assetId: music.id, volume: .2 }, aspect: '16:9', resolution: '720' } });
  manager = await createOpenFilmManager({ dataDir, root, store, resolveAsset: id => videoService.resolveAsset(id), registerOwnedAsset: (...args) => videoService.registerOwnedAsset(...args) });
  const opened = await manager.open(id, origin);
  let wrapper;
  manager.serveEditor({ method: 'GET' }, { writeHead() {}, end(value) { wrapper = String(value); } }, new URL('/openfilm/editor.html', origin));
  const nativeUrl = new URL(/id="openfilm-studio"[^>]+src="([^"]+)"/.exec(wrapper)[1].replaceAll('&amp;', '&'));
  const filmFile = path.join(dataDir, 'openfilm/projects', id, 'film.html');
  const read = async () => { const parsed = readFilmFile(await readFile(filmFile, 'utf8')); assert.deepEqual(parsed.problems, []); return parsed.doc; };
  const context = () => manager.context(id, origin);
  async function nativeEdit(ops, base) {
    const response = await fetch(nativeUrl.origin + '/api/projects/' + opened.nativeProjectId + '/edit', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-studio-key': nativeUrl.searchParams.get('key') }, body: JSON.stringify({ base, ops }) });
    const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value;
  }
  let current = await context(); const first = current.timeline[0].id, later = current.timeline[1].id;
  await nativeEdit([{ op: 'props', edits: [{ clip: first, prop: 'speed', value: 2 }, { clip: first, prop: 'volume', value: .35 }, { clip: first, prop: 'fade', value: [.25, .5] }, { clip: first, prop: 'motion', value: { opacity: [{ t: 0, v: .5 }, { t: 4, v: 1 }] } }] }], current.revision);
  current = await context();
  await writeFile(path.join(path.dirname(filmFile), 'pages/independent-overlay.html'), '<!doctype html><html><body>Unrelated overlay<script>window.film={duration:2,frame(){}};</script></body></html>');
  await writeFile(path.join(path.dirname(filmFile), 'pages/later-page.html'), '<!doctype html><html><body>Later page<script>window.film={duration:2,frame(){}};</script></body></html>');
  const pictureTrack = (await read()).tracks.findIndex(track => track.attrs?.id === 'guangxuan-picture');
  await nativeEdit([{ op: 'insert', track: pictureTrack, clip: { id: 'later-page', src: 'pages/later-page.html', at: 12, time: [0, 2], size: { w: 1280, h: 720 } } }, { op: 'insert', newTrack: 0, newTrackAttrs: { id: 'user-overlay' }, clip: { id: 'unmeasured-overlay', src: 'pages/independent-overlay.html', at: .5, size: { w: 1280, h: 720 } } }], current.revision);
  current = await context(); assert.equal(current.mainTrackEditable, false);
  const beforeLock = await read(), musicTrack = beforeLock.tracks.findIndex(track => track.attrs?.id === 'guangxuan-music');
  await nativeEdit([{ op: 'track', track: musicTrack, field: 'locked', value: true }], current.revision);
  const before = await read(), original = all(before), musicClip = original.find(clip => clip.src.endsWith('.wav')), subtitle = original.find(clip => clip.attrs?.['data-guangxuan-caption'] === 'true');
  const placement = { mode: 'range', start: 1, end: 3, clipIds: [first] }, scope = { placement };
  current = await context();
  const baseBytes = await readFile(filmFile, 'utf8');
  await failure(() => manager.applyPlan(id, { timeline: [{ assetId: current.timeline[0].assetId, clipId: first, start: 2, end: 6.2 }] }, origin, current.revision, { editScope: scope }), 'OPENFILM_RANGE_DURATION_MISMATCH');
  await failure(() => manager.applyPlan(id, { captions: [{ start: 0, end: 2.0011, text: 'outside' }] }, origin, current.revision, { editScope: scope }), 'OPENFILM_RANGE_PLAN_OUTSIDE');
  await failure(() => manager.applyPlan(id, { timeline: [{ assetId: current.timeline[1].assetId, clipId: later, start: 0, end: 2 }] }, origin, current.revision, { editScope: scope }), 'OPENFILM_RANGE_CLIP_FORBIDDEN');
  await failure(() => manager.applyPlan(id, { timeline: [{ assetId: current.timeline[0].assetId, start: 0, end: 2 }] }, origin, current.revision, { editScope: { placement: { ...placement, clipIds: ['missing'] } } }), 'OPENFILM_RANGE_SELECTION_STALE');
  assert.equal(await readFile(filmFile, 'utf8'), baseBytes);
  const plan = { timeline: [{ assetId: current.timeline[0].assetId, clipId: first, start: 2, end: 6 }], captions: [{ start: .25, end: 1.75, text: 'Local caption' }], captionMode: 'replace', look: { preset: 'mono', strength: 1 } };
  const applied = await manager.applyPlan(id, plan, origin, current.revision, { editScope: scope, keepUndo: true });
  assert.equal(applied.duration, 14); assert.equal(applied.placement.mode, 'range'); assert.equal(applied.placement.outsidePreserved, true); assert.ok(applied.undo.id);
  const changed = await read(), clips = all(changed);
  assert.deepEqual(clips.find(clip => clip.id === later), original.find(clip => clip.id === later));
  assert.deepEqual(clips.find(clip => clip.id === musicClip.id), musicClip);
  assert.deepEqual(changed.tracks.find(track => track.attrs?.id === 'guangxuan-music'), before.tracks.find(track => track.attrs?.id === 'guangxuan-music'));
  for (const id of ['later-page', 'unmeasured-overlay']) assert.deepEqual(clips.find(clip => clip.id === id), original.find(clip => clip.id === id));
  const left = clips.find(clip => clip.id === first), right = clips.find(clip => clip.src === left.src && clip.at === 3);
  assert.deepEqual(left.time, [0, 2]); assert.deepEqual(right.time, [6, 8]); assert.equal(left.speed, 2); assert.equal(right.speed, 2);
  assert.equal(left.volume, .35); assert.equal(right.volume, .35); assert.deepEqual(right.box, original.find(clip => clip.id === first).box);
  assert.deepEqual(clipFade(left), [.25, 0]); assert.deepEqual(clipFade(right), [0, .5]); assert.equal(readMotion(right, changed.keyframes).opacity[0].v, .875);
  const middle = clips.find(clip => clip.src === left.src && clip.at === 1);
  assert.equal(middle.speed, 2); assert.equal(middle.volume, .35); assert.match(middle.style, /grayscale/);
  assert.equal(readMotion(middle, changed.keyframes).opacity[0].v, .625);
  const oldCaptions = clips.filter(clip => clip.src === subtitle.src);
  assert.equal(oldCaptions.length, 2); assert.deepEqual(oldCaptions.find(clip => clip.id === subtitle.id).time, [0, 1]); assert.equal(oldCaptions.find(clip => clip.id !== subtitle.id).at, 3);
  assert.equal(clips.find(clip => clip.attrs?.['data-guangxuan-text'] === 'Local caption').at, 1.25);
  await failure(() => manager.applyPlan(id, plan, origin, current.revision, { editScope: scope }), 'OPENFILM_REVISION_CONFLICT');
  await manager.undoAssistant(id, applied.undo.id, origin); assert.deepEqual(await read(), before);
  current = await context();
  const captionOnly = await manager.applyPlan(id, { captions: [{ start: .1, end: .8, text: 'caption only' }], captionMode: 'append' }, origin, current.revision, { editScope: scope, keepUndo: true });
  const captionDoc = await read();
  for (const clip of original) assert.deepEqual(all(captionDoc).find(value => value.id === clip.id), clip);
  assert.equal(all(captionDoc).find(clip => clip.attrs?.['data-guangxuan-text'] === 'caption only').at, 1.1);
  await manager.undoAssistant(id, captionOnly.undo.id, origin);
  current = await context();
  const animationOptions = { editScope: scope, expectedRevision: current.revision, requestId: 'native-range-animation-once', keepUndo: true };
  const added = await manager.appendAsset(id, animation.id, origin, undefined, animationOptions);
  assert.equal(added.duration, 14); assert.equal(added.placement.mode, 'range');
  assert.equal((await manager.appendAsset(id, animation.id, origin, undefined, animationOptions)).revision, added.revision);
  for (const clip of original.filter(clip => clip.id !== first)) assert.deepEqual(all(await read()).find(value => value.id === clip.id), clip);
  await manager.undoAssistant(id, added.undo.id, origin); assert.deepEqual(await read(), before);
  const report = { passed: true, selectedRange: [1, 3], originalDuration: 14, finalDuration: 14, nativeSplitCurvesAndSpeedPreserved: true, lockedMusicAndLaterClipUnchanged: true, unrelatedUnmeasuredHtmlOverlayPreserved: true, complexMainTrackStillAllowsSafeVideoRange: true, captionsReplacedOnlyInsideRange: true, captionOnlyUsesLocalOrigin: true, invalidPlansAndStaleSelectionRejected: true, revisionConflictRejected: true, rangeAnimationIdempotent: true, nativeUndoRestoredOriginalDocument: true };
  await writeFile(path.join(folder, 'verification.json'), JSON.stringify(report, null, 2));
});
