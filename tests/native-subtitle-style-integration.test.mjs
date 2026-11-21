import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { setTimeout as pause } from 'node:timers/promises';
import { createProjectStore } from '../lib/store.mjs';
import { createOpenFilmManager } from '../lib/openfilm.mjs';
import { createAssistantAppTools } from '../lib/assistant-app-tools.mjs';
import { filmHtml, readFilmFile } from '../integrations/openfilm/packages/openfilm/src/film-doc.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
test('real subtitle UI styles render changed pixels, preserve source/timing and undo through actual assistant tools', { skip: process.env.GUANGXUAN_TEST_OPENFILM !== '1', timeout: 90000 }, async t => {
  const parent = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(parent, { recursive: true });
  const folder = await mkdtemp(path.join(parent, 'gx-native-subtitle-style-')), dataDir = path.join(folder, 'data'), origin = 'http://127.0.0.1:49105', projectId = 'subtitle-style-fixture';
  const store = await createProjectStore(dataDir); let manager, adapter;
  t.after(async () => { await adapter?.close(); await manager?.close(); await store.settle(); assert.equal(path.dirname(path.resolve(folder)), parent); await rm(folder, { recursive: true, force: true }); });
  await store.save(projectId, { kind: 'video', title: 'subtitle style', video: { timeline: [], captions: [], aspect: '16:9' } });
  manager = await createOpenFilmManager({ dataDir, root, store }); await manager.open(projectId, origin);
  const home = path.join(dataDir, 'openfilm/projects', projectId), src = 'captions/original.vtt', original = 'WEBVTT\n\nNOTE keep this note\n\nSTYLE\n::cue { font-size: 10px; color: red; --unknown: retained; }\n\nc1\n00:00:00.000 --> 00:00:01.500\n<00:00:00.000>Hello <00:00:00.700>world\n';
  await mkdir(path.join(home, 'pages'), { recursive: true }); await mkdir(path.join(home, 'captions'), { recursive: true });
  await writeFile(path.join(home, 'pages/scene.html'), '<!doctype html><body style="margin:0;background:#143243"><script>window.film={duration:2,width:128,height:72,frame(t){}};</script></body>');
  await writeFile(path.join(home, src), original);
  const filmFile = path.join(home, 'film.html'); await writeFile(filmFile, filmHtml({ stage: { w: 128, h: 72 }, tracks: [{ clips: [], captions: { src, kind: 'subtitles' } }, { clips: [{ id: 'scene', src: 'pages/scene.html', time: [0, 2], size: { w: 128, h: 72 } }] }] }));
  const before = readFilmFile(await readFile(filmFile, 'utf8')).doc;
  async function poster() {
    const current = await manager.context(projectId, origin), submitted = await manager.exportNative(projectId, { kind: 'poster', format: 'png', at: .4, shortEdge: 144, burnSubtitles: true }, origin, { expectedRevision: current.revision });
    let job; const deadline = Date.now() + 30000;
    do { job = (await manager.nativeExports(projectId)).exports.find(job => job.id === submitted.export.id); if (['done', 'failed', 'error', 'cancelled'].includes(job?.status)) break; await pause(80); } while (Date.now() < deadline);
    assert.equal(job?.status, 'done', JSON.stringify(job)); const sink = new PassThrough(), chunks = []; sink.writeHead = () => {}; sink.on('data', chunk => chunks.push(chunk)); await manager.download({ method: 'GET' }, sink, projectId, submitted.export.id); return Buffer.concat(chunks);
  }
  const oldPicture = await poster();
  adapter = createAssistantAppTools({ store, openFilm: manager });
  const ctx = { projectId, runId: 'native-subtitle-style', instruction: '把当前字幕设为大号金字黑边，逐字变色，保留原始时间。', scopeAuthority: 'dialog', origin, mode: 'auto', signal: new AbortController().signal, update() {} };
  const call = (name, args = {}) => adapter.tools.find(tool => tool.name === name).execute(args, ctx);
  const catalog = await call('native_subtitles_style_catalog'); assert.equal(catalog.data.wordEffects.length, 12);
  const read = await call('native_subtitles_read', { track: 0 }); assert.equal(read.data.style.trackRule['font-size'], '10px');
  const applied = await call('native_operation', { operations: [{ action: 'subtitles_style', track: 0, style: { variables: { '--font': 'Arial', '--size': '15cqmin', '--color': '#FFD700', '--weight': '700', '--stroke': '.08em', '--stroke-color': '#000000', '--box': 'transparent' }, css: { 'line-height': '1.2' }, wordEffect: 'color', wordColor: '#22AAFF', line: 80, align: 'center' } }] });
  const after = await call('native_subtitles_read', { track: 0 }); assert.equal(after.data.cues[0].text, read.data.cues[0].text); assert.equal(after.data.style.wordEffect.id, 'color'); assert.equal(after.data.style.trackRule['--unknown'], 'retained');
  assert.equal(await readFile(path.join(home, src), 'utf8'), original, 'The original VTT is retained byte-for-byte');
  const changedPicture = await poster(); assert.notDeepEqual(changedPicture, oldPicture, 'Actual native renderer displays the requested style change');
  await call('assistant_undo_apply', { undoId: applied.effects[0].undo.id }); assert.deepEqual(readFilmFile(await readFile(filmFile, 'utf8')).doc, before);
  assert.deepEqual(await poster(), oldPicture, 'Actual rendered PNG returns byte-for-byte after undo');
});
