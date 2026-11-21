import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { setTimeout as pause } from 'node:timers/promises';
import { createProjectStore } from '../lib/store.mjs';
import { createVideoService } from '../lib/video.mjs';
import { createOpenFilmManager } from '../lib/openfilm.mjs';
import { createAssistantAppTools } from '../lib/assistant-app-tools.mjs';
import { filmHtml, readFilmFile } from '../integrations/openfilm/packages/openfilm/src/film-doc.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), command = promisify(execFile), hash = bytes => createHash('sha256').update(bytes).digest('hex');
function zipImages(bytes) {
  const files = []; let offset = 0;
  while (offset + 30 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    const length = bytes.readUInt32LE(offset + 18), nameLength = bytes.readUInt16LE(offset + 26), extraLength = bytes.readUInt16LE(offset + 28), start = offset + 30 + nameLength + extraLength;
    assert.equal(bytes.readUInt16LE(offset + 8), 0); files.push(bytes.subarray(start, start + length)); offset = start + length;
  }
  return files;
}
test('real range split isolates a crossing media clip, preserves outside pixels/audio and precisely undoes all changes', { skip: process.env.GUANGXUAN_TEST_OPENFILM !== '1', timeout: 120000 }, async t => {
  const parent = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(parent, { recursive: true });
  const folder = await mkdtemp(path.join(parent, 'gx-native-range-split-')), dataDir = path.join(folder, 'data'), origin = 'http://127.0.0.1:49103';
  let videoService, manager, adapter;
  t.after(async () => { await adapter?.close(); await manager?.close(); await videoService?.close(); assert.equal(path.dirname(path.resolve(folder)), parent); await rm(folder, { recursive: true, force: true }); });
  const bin = name => process.env['GUANGXUAN_' + name.toUpperCase()] || (process.env.GUANGXUAN_BIN_DIR ? path.join(process.env.GUANGXUAN_BIN_DIR, name + (process.platform === 'win32' ? '.exe' : '')) : name);
  const mediaFile = path.join(folder, 'tone-video.mp4');
  await command(bin('ffmpeg'), ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'testsrc2=s=128x72:r=10:d=6', '-f', 'lavfi', '-i', 'sine=frequency=600:duration=6', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', mediaFile], { windowsHide: true });
  const store = await createProjectStore(dataDir); videoService = await createVideoService({ dataDir, root, ffmpegPath: bin('ffmpeg'), ffprobePath: bin('ffprobe') });
  const asset = await videoService.importLocalFile(mediaFile), id = 'range-crossing-fixture';
  await store.save(id, { kind: 'video', title: 'range crossing fixture', video: { timeline: [{ assetId: asset.id, start: 0, end: 6 }], aspect: '16:9', resolution: '720', sourceVolume: .7, editScope: { assetIds: [], placement: { mode: 'range', start: 0, end: 1 } } } });
  manager = await createOpenFilmManager({ dataDir, root, store, resolveAsset: id => videoService.resolveAsset(id), registerOwnedAsset: (...args) => videoService.registerOwnedAsset(...args) });
  let current = await manager.context(id, origin); const filmFile = path.join(dataDir, 'openfilm/projects', id, 'film.html');
  const initial = readFilmFile(await readFile(filmFile, 'utf8')).doc; initial.stage = { w: 128, h: 72 }; initial.tracks.forEach(track => track.clips.forEach(clip => { clip.box = { x: 0, y: 0, w: 128, h: 72 }; }));
  await writeFile(filmFile, filmHtml(initial)); current = await manager.context(id, origin); const before = readFilmFile(await readFile(filmFile, 'utf8')).doc, firstId = current.timeline[0].id;
  async function exported(spec) {
    const native = await manager.context(id, origin), started = await manager.exportNative(id, spec, origin, { expectedRevision: native.revision });
    let job; const deadline = Date.now() + 45000;
    do { job = (await manager.nativeExports(id)).exports.find(job => job.id === started.export.id); if (['done', 'failed', 'error', 'cancelled'].includes(job?.status)) break; await pause(80); } while (Date.now() < deadline);
    assert.equal(job?.status, 'done', JSON.stringify(job));
    const sink = new PassThrough(), chunks = []; sink.writeHead = () => {}; sink.on('data', chunk => chunks.push(chunk)); await manager.download({ method: 'GET' }, sink, id, started.export.id); return Buffer.concat(chunks);
  }
  const beforePictures = zipImages(await exported({ kind: 'stills', format: 'png', as: 'files', shortEdge: 72, at: [.5, 5.5] })).map(hash).sort(); assert.equal(beforePictures.length, 2);
  adapter = createAssistantAppTools({ store, openFilm: manager });
  const ctx = { projectId: id, runId: 'range-split-dialogue', instruction: '只改2–4秒，把这段声音静音，其他内容保持。', scopeAuthority: 'dialog', editScope: { assetIds: [], placement: { mode: 'range', start: 0, end: 1 } }, origin, mode: 'auto', signal: new AbortController().signal, update() {} };
  const call = (name, args = {}) => adapter.tools.find(tool => tool.name === name).execute(args, ctx);
  const inspection = await call('native_inspect'); assert.equal(inspection.data.clips[0].canSplitInScope, true); assert.deepEqual(inspection.data.editScope.placement, { mode: 'range', start: 2, end: 4 });
  const split1 = await call('native_adjust', { edits: [{ action: 'split', clipId: firstId, at: 2 }] }), middleId = split1.data.results[0].createdClipId;
  const split2 = await call('native_adjust', { edits: [{ action: 'split', clipId: middleId, at: 4 }] }), tailId = split2.data.results[0].createdClipId;
  const muted = await call('native_adjust', { edits: [{ action: 'volume', clipId: middleId, value: 0 }] });
  const changed = readFilmFile(await readFile(filmFile, 'utf8')).doc, clips = changed.tracks.flatMap(track => track.clips);
  assert.deepEqual(clips.map(clip => clip.time), [[0, 2], [2, 4], [4, 6]]); assert.equal(clips.find(clip => clip.id === firstId).volume, .7); assert.equal(clips.find(clip => clip.id === tailId).volume, .7); assert.equal(clips.find(clip => clip.id === middleId).volume, 0);
  const afterPictures = zipImages(await exported({ kind: 'stills', format: 'png', as: 'files', shortEdge: 72, at: [.5, 5.5] })).map(hash).sort(); assert.deepEqual(afterPictures, beforePictures, 'Actual PNG pixels before and after the allowed range are byte-identical');
  const audio = await exported({ kind: 'audio', format: 'wav', ranges: [[0, .5], [2.5, 3], [5, 5.5]] }), audioFile = path.join(folder, 'range-check.wav'); await writeFile(audioFile, audio);
  const decoded = (await command(bin('ffmpeg'), ['-v', 'error', '-i', audioFile, '-ac', '1', '-ar', '8000', '-f', 'f32le', 'pipe:1'], { windowsHide: true, encoding: 'buffer', maxBuffer: 1024 * 1024 })).stdout;
  const rms = (start, end) => { let sum = 0, count = 0; for (let frame = Math.floor(start * 8000); frame < Math.min(decoded.length / 4, end * 8000); frame++) { const value = decoded.readFloatLE(frame * 4); sum += value * value; count++; } return Math.sqrt(sum / count); };
  assert.ok(rms(.05, .4) > .02); assert.ok(rms(.55, .9) < .001); assert.ok(rms(1.05, 1.4) > .02, 'Outside source sound remains while only the isolated middle is muted');
  await adapter.undo({ projectId: id, undoId: muted.effects[0].undo.id }, { origin }); await adapter.undo({ projectId: id, undoId: split2.effects[0].undo.id }, { origin }); await adapter.undo({ projectId: id, undoId: split1.effects[0].undo.id }, { origin });
  assert.deepEqual(readFilmFile(await readFile(filmFile, 'utf8')).doc, before, 'All three actual native edits undo in reverse order to the original document');
});
