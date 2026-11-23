import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { watch } from 'node:fs';
import { createProjectStore } from '../lib/store.mjs';
import { createVideoService } from '../lib/video.mjs';
import { createOpenFilmManager } from '../lib/openfilm.mjs';
import { buildMusicCutPlan } from '../lib/music-cut-plan.mjs';
import { makePcm, grid } from './fixtures/music-rhythm.mjs';

const root = path.resolve(import.meta.dirname, '..'), bin = process.env.GUANGXUAN_BIN_DIR, command = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const hasCode = value => error => error.code === value;
function wav(samples, rate) {
  const bytes = Buffer.alloc(44 + samples.length * 2); bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples.length * 2, 40); for (let i = 0; i < samples.length; i++) bytes.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2); return bytes;
}
async function fixture(t) {
  const parent = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(parent, { recursive: true }); const folder = await mkdtemp(path.join(parent, 'gx-music-native-')), dataDir = path.join(folder, 'data');
  const store = await createProjectStore(dataDir), video = await createVideoService({ dataDir, root, ffmpegPath: path.join(bin, 'ffmpeg.exe'), ffprobePath: path.join(bin, 'ffprobe.exe') }); let registrationHook;
  const manager = await createOpenFilmManager({ dataDir, root, store, resolveAsset: id => video.resolveAsset(id), registerOwnedAsset: async (...args) => { const asset = await video.registerOwnedAsset(...args); await registrationHook?.(); return asset; } });
  const server = http.createServer(async (req, res) => { try { if (req.url.startsWith('/api/openfilm/exports/')) { const parts = req.url.split('/'); await manager.download(req, res, parts[4], parts[5]); return; } if (await video.handler(req, res, new URL(req.url, 'http://127.0.0.1'))) return; res.writeHead(404); res.end(); } catch (error) { res.writeHead(error.status || 500); res.end(error.code); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${server.address().port}`; assert.notEqual(new URL(origin).port, '4417');
  t.after(async () => { await manager.close(); await video.close(); await store.settle(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); if (!process.env.GUANGXUAN_KEEP_MUSIC_NATIVE_TESTS) { assert.equal(path.dirname(path.resolve(folder)), parent); assert.ok(path.basename(folder).startsWith('gx-music-native-')); await rm(folder, { recursive: true, force: true }); } else t.diagnostic('Music native evidence: ' + folder); });
  const musicFile = path.join(folder, 'actual-120.wav'), redFile = path.join(folder, 'actual-video-with-original-audio.mp4'), blueFile = path.join(folder, 'blue.png'), ambienceFile = path.join(folder, 'independent.wav');
  const pcm = makePcm({ duration: 8, sampleRate: 48000, beats: grid(120, 8, .13) }); await writeFile(musicFile, wav(pcm.samples, pcm.sampleRate));
  await Promise.all([
    command(path.join(bin, 'ffmpeg.exe'), ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=red:s=320x180:r=25:d=8', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=8', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', redFile], { windowsHide: true }),
    command(path.join(bin, 'ffmpeg.exe'), ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=blue:s=320x180', '-frames:v', '1', '-threads', '1', blueFile], { windowsHide: true }),
    command(path.join(bin, 'ffmpeg.exe'), ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=1', '-c:a', 'pcm_s16le', ambienceFile], { windowsHide: true }),
  ]);
  const global = {}; for (const [name, file] of Object.entries({ music: musicFile, red: redFile, blue: blueFile, ambience: ambienceFile })) global[name] = await video.importLocalFile(file, { name: path.basename(file) });
  return { folder, dataDir, store, video, manager, origin, global, hook(value) { registrationHook = value; },
    async project(id) { await store.save(id, { kind: 'video', title: '实际音乐卡点隔离', video: { timeline: [], captions: [], aspect: '16:9', resolution: '720' } }); const native = await manager.context(id, origin), assets = {}; for (const [name, asset] of Object.entries(global)) assets[name] = (await manager.importAsset(id, asset.id, origin, { expectedRevision: native.revision, requestId: 'import-' + name })).asset; return { id, assets, revision: native.revision, film: path.join(dataDir, 'openfilm/projects', id, 'film.html') }; },
  };
}

test('real rhythm API uses owned canonical PCM and one-CAS region cut preserves existing music, outside picture, captions and independent audio; undo and render are real', { skip: !bin, timeout: 180000 }, async t => {
  const f = await fixture(t), p = await f.project('existing-music');
  let edited = await f.manager.applyPlan(p.id, { timeline: [{ assetId: p.assets.red.id, start: 0, end: 8 }], captions: [{ start: .2, end: .8, text: '外部标题' }, { start: 1, end: 7, text: '保留全片字幕' }] }, f.origin, p.revision);
  const musicAdded = await f.manager.operateClips(p.id, [
    { action: 'asset_insert', assetId: p.assets.music.id, at: 0, start: 0, end: 8, volume: .6 },
    { action: 'asset_insert', assetId: p.assets.ambience.id, at: 6.5, start: 0, end: 1, volume: .2 },
  ], f.origin, edited.revision), musicId = musicAdded.results[0].createdClipId, ambienceId = musicAdded.results[1].createdClipId;
  edited = await f.manager.adjustClips(p.id, [{ clipId: musicId, action: 'speed', value: 1.25 }], f.origin, musicAdded.revision);
  const rhythm = await f.manager.readMusicRhythm(p.id, undefined, f.origin, { clipId: musicId });
  assert.equal(rhythm.assetId, p.assets.music.id); assert.equal(rhythm.status, 'ready'); assert.ok(Math.abs(rhythm.bpm - 120) <= 1); assert.equal(rhythm.musicClip.speed, 1.25); assert.equal(rhythm.musicClip.fullSourceDuration, 8);
  assert.equal(rhythm.sourceVersion, hash(await readFile((await f.video.resolveAsset(p.assets.music.id)).path))); assert.equal(rhythm.nativeRevision, edited.revision);
  const ranged = await f.manager.readMusicRhythm(p.id, p.assets.music.id, f.origin, { range: { start: 1, end: 5 } }); assert.equal(ranged.coverage.start, 1); assert.ok(Math.abs(ranged.coverage.end - 5) <= .001); assert.ok(ranged.beats.every(beat => beat.time >= 1 && beat.time <= 5));
  await assert.rejects(f.manager.readMusicRhythm(p.id, f.global.music.id, f.origin, { clipId: musicId }), hasCode('OPENFILM_MUSIC_ASSET_SCOPE'));
  await assert.rejects(f.manager.readMusicRhythm(p.id, p.assets.blue.id, f.origin), hasCode('OPENFILM_MUSIC_NO_AUDIO'));
  const videoRhythm = await f.manager.readMusicRhythm(p.id, p.assets.red.id, f.origin, { range: { start: 0, end: 4 } }); assert.equal(videoRhythm.status, 'no-beat');
  const plan = buildMusicCutPlan({ rhythm, music: { assetId: rhythm.assetId, ...rhythm.musicClip }, assets: [p.assets.red, p.assets.blue], placement: { start: 1, end: 5 }, cadence: 'beat' }); assert.equal(plan.canApply, true);
  const before = await f.manager.preflightSnapshot(p.id), filmBefore = await readFile(p.film), originalMusic = before.document.tracks.flatMap(track => track.clips || []).find(clip => clip.id === musicId), originalAmbience = before.document.tracks.flatMap(track => track.clips || []).find(clip => clip.id === ambienceId), captions = before.document.tracks.filter(track => track.attrs?.id === 'guangxuan-captions');
  const applied = await f.manager.applyMusicCutPlan(p.id, plan, f.origin, rhythm.nativeRevision, { keepUndo: true, existingMusicClipId: musicId, editScope: { assetIds: Object.values(p.assets).map(asset => asset.id), placement: { mode: 'range', start: 1, end: 5 } } });
  assert.equal(applied.applied, true); assert.equal(applied.nativeUndoId, applied.undo.id); assert.equal(applied.existingMusicPreserved, true); assert.equal(applied.musicClipId, musicId); assert.equal(applied.outsidePreserved, true);
  const after = await f.manager.preflightSnapshot(p.id), all = after.document.tracks.flatMap(track => track.clips || []);
  assert.deepEqual(all.find(clip => clip.id === musicId), originalMusic); assert.deepEqual(all.find(clip => clip.id === ambienceId), originalAmbience); assert.deepEqual(after.document.tracks.filter(track => track.attrs?.id === 'guangxuan-captions'), captions);
  const native = await f.manager.context(p.id, f.origin, { inspectAll: true }), inside = native.timeline.filter(clip => clip.at >= 1 && clip.at < 5), outside = native.timeline.filter(clip => clip.at < 1 || clip.at >= 5);
  assert.equal(inside.length, plan.timeline.length); assert.ok(inside.every(clip => clip.speed === 1)); assert.ok(all.filter(clip => clip.id.startsWith('gx-music-cut-') && /\.mp4$/.test(clip.src)).every(clip => clip.volume === 0));
  assert.deepEqual(outside.map(clip => ({ at: clip.at, start: clip.start, end: clip.end })), [{ at: 0, start: 0, end: 1 }, { at: 5, start: 5, end: 8 }]);
  await assert.rejects(f.manager.applyMusicCutPlan(p.id, plan, f.origin, rhythm.nativeRevision, { existingMusicClipId: musicId }), hasCode('OPENFILM_REVISION_CONFLICT'));
  const start = await f.manager.exportNative(p.id, { kind: 'video', codec: 'h264', fps: 50, shortEdge: 180, audio: true, hardware: false, name: '实际自动卡点范围保留' }, f.origin, { expectedRevision: applied.revision }); let job; const deadline = Date.now() + 120000;
  do { job = (await f.manager.nativeExports(p.id)).exports.find(item => item.id === start.export.id); if (['done', 'failed', 'cancelled'].includes(job?.status)) break; await new Promise(resolve => setTimeout(resolve, 150)); } while (Date.now() < deadline); assert.equal(job.status, 'done', JSON.stringify(job));
  const response = await fetch(f.origin + job.downloadUrl); assert.equal(response.status, 200); const movie = path.join(f.folder, 'actual-music-cut.mp4'), movieBytes = Buffer.from(await response.arrayBuffer()); await writeFile(movie, movieBytes);
  await command(path.join(bin, 'ffmpeg.exe'), ['-v', 'error', '-nostdin', '-i', movie, '-f', 'null', '-'], { windowsHide: true });
  const raw = (await command(path.join(bin, 'ffmpeg.exe'), ['-v', 'error', '-nostdin', '-i', movie, '-an', '-vf', 'scale=160:90', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { windowsHide: true, encoding: null, maxBuffer: 32 * 1024 * 1024 })).stdout, stride = 160 * 90 * 3, colors = [], actualCuts = [];
  for (let frame = 0; frame < raw.length / stride; frame++) { const at = frame * stride + (10 * 160 + 80) * 3; colors.push(raw[at] > raw[at + 2] ? 'red' : 'blue'); if (frame && colors[frame] !== colors[frame - 1]) actualCuts.push(frame / 50); }
  const errors = applied.cutTimes.map(time => Math.min(...actualCuts.map(actual => Math.abs(actual - time) * 1000))); assert.ok(Math.max(...errors) <= 20.01, JSON.stringify({ actualCuts, expected: applied.cutTimes, errors }));
  await f.manager.undoAssistant(p.id, applied.nativeUndoId, f.origin); assert.deepEqual(await readFile(p.film), filmBefore); assert.deepEqual((await f.manager.preflightSnapshot(p.id)).document.tracks, before.document.tracks);
  await writeFile(path.join(f.folder, 'verification.json'), JSON.stringify({ passed: true, projectId: p.id, rhythm, plan, applied, movie, movieSha256: hash(movieBytes), fullDecodePassed: true, actualCuts, errorMs: errors, maxCutErrorMs: Math.max(...errors), existingMusicExactPreserved: true, outsidePictureSourceRangesPreserved: true, captionsAndIndependentAudioExactPreserved: true, undoRestoredFilmBytes: true, externalModelCalls: 0 }, null, 2));
});

test('empty picture creates music and visuals in one edit; range, source version, selection, cancellation, worker CAS and locked targets reject without a partial film', { skip: !bin, timeout: 120000 }, async t => {
  const f = await fixture(t), p = await f.project('new-music');
  let rhythm = await f.manager.readMusicRhythm(p.id, p.assets.music.id, f.origin), plan = buildMusicCutPlan({ rhythm, music: { assetId: rhythm.assetId, sourceStart: 0, sourceEnd: 8, timelineAt: 2, speed: 1, volume: .7 }, assets: [p.assets.red, p.assets.blue], placement: { start: 2, end: 6 }, cadence: 'half' }); assert.equal(plan.canApply, true);
  const before = await readFile(p.film), abort = new AbortController(); abort.abort();
  await assert.rejects(f.manager.applyMusicCutPlan(p.id, plan, f.origin, rhythm.nativeRevision, { signal: abort.signal }), hasCode('REQUEST_CANCELLED')); assert.deepEqual(await readFile(p.film), before);
  await assert.rejects(f.manager.applyMusicCutPlan(p.id, plan, f.origin, rhythm.nativeRevision, { editScope: { assetIds: [p.assets.red.id, p.assets.blue.id], placement: { mode: 'range', start: 2, end: 6 } } }), hasCode('OPENFILM_MUSIC_ASSET_SCOPE'));
  await assert.rejects(f.manager.applyMusicCutPlan(p.id, plan, f.origin, rhythm.nativeRevision, { editScope: { placement: { mode: 'range', start: 3, end: 6 } } }), hasCode('OPENFILM_MUSIC_SCOPE'));
  await assert.rejects(f.manager.applyMusicCutPlan(p.id, { ...plan, timeline: [{ ...plan.timeline[0], speed: 2 }, ...plan.timeline.slice(1)] }, f.origin, rhythm.nativeRevision), hasCode('OPENFILM_MUSIC_PLAN'));
  const sourceFile = (await f.video.resolveAsset(p.assets.music.id)).path, sourceBytes = await readFile(sourceFile), changed = Buffer.from(sourceBytes); changed[changed.length - 2] ^= 1; await writeFile(sourceFile, changed);
  await assert.rejects(f.manager.applyMusicCutPlan(p.id, plan, f.origin, rhythm.nativeRevision), hasCode('OPENFILM_MUSIC_SOURCE_CHANGED')); assert.deepEqual(await readFile(p.film), before); await writeFile(sourceFile, sourceBytes);
  // A touched/re-registered file can acquire a fresh canonical ID. As the UI
  // must do, re-read the actual project before building the subsequent plan.
  p.assets.music = (await f.manager.context(p.id, f.origin)).assets.find(asset => asset.name === p.assets.music.name);
  rhythm = await f.manager.readMusicRhythm(p.id, p.assets.music.id, f.origin);
  plan = buildMusicCutPlan({ rhythm, music: { assetId: rhythm.assetId, sourceStart: 0, sourceEnd: 8, timelineAt: 2, speed: 1, volume: .7 }, assets: [p.assets.red, p.assets.blue], placement: { start: 2, end: 6 }, cadence: 'half' });
  let raced = false; f.hook(async () => { if (!raced) { raced = true; await writeFile(p.film, Buffer.concat([before, Buffer.from('\n<!-- isolated manual edit -->')])); } });
  await assert.rejects(f.manager.applyMusicCutPlan(p.id, plan, f.origin, rhythm.nativeRevision), hasCode('OPENFILM_REVISION_CONFLICT')); f.hook(null);
  const manualFilm = await readFile(p.film), fresh = await f.manager.context(p.id, f.origin); assert.ok(manualFilm.toString().includes('isolated manual edit'));
  const stopOnCommit = new AbortController(), watcher = watch(p.film, () => stopOnCommit.abort());
  let applied; try { applied = await f.manager.applyMusicCutPlan(p.id, plan, f.origin, fresh.revision, { signal: stopOnCommit.signal }); } finally { watcher.close(); }
  assert.equal(stopOnCommit.signal.aborted, true); assert.equal(applied.applied, true); assert.equal(applied.existingMusicPreserved, false);
  const snapshot = await f.manager.preflightSnapshot(p.id), all = snapshot.document.tracks.flatMap(track => track.clips || []), music = all.find(clip => clip.id === applied.musicClipId);
  assert.equal(music.at, 2); assert.deepEqual(music.time, [0, 4]); assert.equal(music.volume, .7); assert.equal(music.speed ?? 1, 1);
  assert.equal(all.filter(clip => clip.id.startsWith('gx-music-cut-')).length, plan.timeline.length); assert.ok(all.filter(clip => clip.id.startsWith('gx-music-cut-')).every(clip => clip.at >= 2 && clip.at < 6));
  await f.manager.undoAssistant(p.id, applied.nativeUndoId, f.origin); assert.deepEqual(await readFile(p.film), manualFilm);
  const base = await f.manager.applyPlan(p.id, { timeline: [{ assetId: p.assets.red.id, start: 0, end: 8 }], captions: [] }, f.origin, (await f.manager.context(p.id, f.origin)).revision);
  const locked = await f.manager.operateClips(p.id, [{ action: 'track_set', track: 0, field: 'locked', value: true }], f.origin, base.revision), lockedFilm = await readFile(p.film);
  await assert.rejects(f.manager.applyMusicCutPlan(p.id, plan, f.origin, locked.revision), hasCode('OPENFILM_TRACK_LOCKED')); assert.deepEqual(await readFile(p.film), lockedFilm);
  const unlocked = await f.manager.operateClips(p.id, [{ action: 'track_set', track: 0, field: 'locked', value: false }, { action: 'asset_insert', assetId: p.assets.ambience.id, at: 6.5, start: 0, end: 1 }], f.origin, locked.revision);
  const mainId = (await f.manager.context(p.id, f.origin)).timeline[0].id, ambientId = unlocked.results.find(item => item.action === 'asset_insert').createdClipId;
  const linked = await f.manager.operateClips(p.id, [{ action: 'link', clipIds: [mainId, ambientId] }], f.origin, unlocked.revision), linkedFilm = await readFile(p.film);
  await assert.rejects(f.manager.applyMusicCutPlan(p.id, plan, f.origin, linked.revision), hasCode('OPENFILM_MUSIC_SCOPE')); assert.deepEqual(await readFile(p.film), linkedFilm);
  const unlinked = await f.manager.operateClips(p.id, [{ action: 'unlink', clipIds: [mainId, ambientId] }], f.origin, linked.revision);
  const animated = await f.manager.adjustClips(p.id, [{ clipId: mainId, action: 'motion', property: 'opacity', keys: [{ time: 0, value: 1 }, { time: 8, value: .5 }] }], f.origin, unlinked.revision), animatedFilm = await readFile(p.film);
  await assert.rejects(f.manager.applyMusicCutPlan(p.id, plan, f.origin, animated.revision), hasCode('OPENFILM_MUSIC_RANGE_COMPLEX')); assert.deepEqual(await readFile(p.film), animatedFilm);
  await writeFile(path.join(f.folder, 'guards-verification.json'), JSON.stringify({ passed: true, sourceVersionRejected: true, cancelBeforeCommitUnchanged: true, actualCommitStopKeptReceipt: true, selectedAssetsAndRangeRejected: true, visualRetimingRejected: true, workerActualCasRejectedManualRace: true, emptyPictureAndMusicSameEdit: true, undoRestoredManualFilm: true, lockedTargetRejected: true, linkedTargetRejected: true, crossBoundaryAnimationRejected: true, applied, externalModelCalls: 0 }, null, 2));
});
