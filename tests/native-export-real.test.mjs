import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createOpenFilmManager } from '../lib/openfilm.mjs';
import { findAnimationBrowser } from '../animation/render.mjs';
import { filmHtml } from '../integrations/openfilm/packages/openfilm/src/film-doc.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function wave() {
  const rate = 44100, count = rate / 2, bytes = Buffer.alloc(44 + count * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(count * 2, 40);
  for (let frame = 0; frame < count; frame++) bytes.writeInt16LE(Math.round(Math.sin(frame * Math.PI * 2 * 330 / rate) * 9000), 44 + frame * 2);
  return bytes;
}
function zipEntries(bytes) {
  const entries = new Map(); let offset = 0;
  while (offset + 30 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    const length = bytes.readUInt32LE(offset + 18), nameLength = bytes.readUInt16LE(offset + 26), extraLength = bytes.readUInt16LE(offset + 28), start = offset + 30 + nameLength + extraLength;
    entries.set(bytes.subarray(offset + 30, offset + 30 + nameLength).toString('utf8'), bytes.subarray(start, start + length)); offset = start + length;
  }
  return entries;
}

test('real native engine exports all nine kinds, downloads whole projects and keeps editor drafts in owned storage', { timeout: 240000, skip: process.env.GUANGXUAN_TEST_OPENFILM !== '1' }, async t => {
  const parent = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'gx-native-export-real-')), dataDir = path.join(directory, 'data'), externalApps = path.join(directory, 'external-apps');
  const browserPath = await findAnimationBrowser(), previousLocalAppData = process.env.LOCALAPPDATA, previousBrowser = process.env.OPENFILM_BROWSER_EXECUTABLE;
  let manager, server;
  t.after(async () => {
    if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = previousLocalAppData;
    if (previousBrowser === undefined) delete process.env.OPENFILM_BROWSER_EXECUTABLE; else process.env.OPENFILM_BROWSER_EXECUTABLE = previousBrowser;
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await manager?.close();
    assert.equal(path.dirname(directory), parent); assert.ok(path.basename(directory).startsWith('gx-native-export-real-'));
    await rm(directory, { recursive: true, force: true });
  });
  const externalFolders = ['JianyingPro', 'CapCut'].map(app => path.join(externalApps, app, 'User Data', 'Projects', 'com.lveditor.draft'));
  for (const folder of externalFolders) { await mkdir(folder, { recursive: true }); await writeFile(path.join(folder, 'sentinel.txt'), 'external app data must stay unchanged'); }
  process.env.LOCALAPPDATA = externalApps; process.env.OPENFILM_BROWSER_EXECUTABLE = browserPath;
  const projectId = 'export-all-kinds', project = { id: projectId, kind: 'video', title: 'Export capability', createdAt: '2026-11-19T00:00:00.000Z', video: { timeline: [], captions: [], aspect: '16:9' } };
  manager = await createOpenFilmManager({ dataDir, root, store: { read: async id => id === projectId ? structuredClone(project) : null } });
  server = http.createServer(async (req, res) => {
    try { await manager.download(req, res, projectId, req.url.slice(1)); }
    catch (error) { res.writeHead(error.status || 500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: error.message, code: error.code })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${server.address().port}`;
  assert.notEqual(new URL(origin).port, '4417');
  await manager.open(projectId, origin);
  const folder = path.join(dataDir, 'openfilm', 'projects', projectId); await mkdir(path.join(folder, 'pages'), { recursive: true }); await mkdir(path.join(folder, 'captions'), { recursive: true }); await mkdir(path.join(folder, 'assets', 'audio', 'music'), { recursive: true });
  await writeFile(path.join(folder, 'pages', 'subject.html'), '<!doctype html><body style="margin:0;background:#143243"><div id="hero" style="width:22px;height:22px;background:#64d5bf"></div><script>window.film={duration:.5,width:128,height:72,frame(t){document.querySelector("#hero").style.transform="translateX("+(t*80)+"px)"}}</script></body>');
  await writeFile(path.join(folder, 'assets', 'audio', 'music', 'tone.wav'), wave());
  await writeFile(path.join(folder, 'captions', 'line.vtt'), 'WEBVTT\n\n00:00:00.000 --> 00:00:00.500\nExport capability\n');
  const film = duration => filmHtml({ stage: { w: 128, h: 72 }, tracks: [{ clips: [], captions: { kind: 'captions', src: 'captions/line.vtt', label: 'Fixture caption' } }, { clips: [{ id: 'hero', src: 'pages/subject.html', at: 0, time: [0, duration], size: { w: 128, h: 72 } }] }, { clips: [{ id: 'tone', src: 'assets/audio/music/tone.wav', at: 0, time: [0, .5] }] }] });
  await writeFile(path.join(folder, 'film.html'), film(.5));
  const outputs = [];
  async function exported(spec) {
    const before = await manager.context(projectId, origin), submitted = await manager.exportNative(projectId, spec, origin, { expectedRevision: before.revision });
    let job; const deadline = Date.now() + 120000;
    do { job = (await manager.nativeExports(projectId)).exports.find(item => item.id === submitted.export.id); if (['done', 'failed', 'cancelled'].includes(job?.status)) break; await delay(50); } while (Date.now() < deadline);
    const diagnostics = job?.status === 'failed' ? (await readFile(path.join(dataDir, 'openfilm', 'state', 'logs', 'problems.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line).what).slice(-3) : [];
    assert.equal(job?.status, 'done', JSON.stringify({ spec, job, diagnostics })); assert.ok(job.downloadUrl);
    const response = await fetch(origin + '/' + job.id), bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, 200, bytes.toString().slice(0, 1000)); assert.ok(bytes.length > 10);
    assert.ok(!JSON.stringify(job).includes(directory));
    outputs.push({ kind: spec.kind, format: spec.format || spec.codec || '', contentType: response.headers.get('content-type'), bytes: bytes.length, outputCount: job.outputCount });
    return { bytes, response, entries: zipEntries(bytes) };
  }
  assert.ok((await exported({ kind: 'video', fps: 5, shortEdge: 64, range: [0, .2], audio: true })).bytes.includes(Buffer.from('ftyp')));
  assert.equal((await exported({ kind: 'gif', width: 64, fps: 5, range: [0, .2] })).bytes.subarray(0, 3).toString(), 'GIF');
  assert.equal((await exported({ kind: 'audio', format: 'wav', range: [0, .2] })).bytes.subarray(0, 4).toString(), 'RIFF');
  const stills = await exported({ kind: 'stills', format: 'png', as: 'files', shortEdge: 64, at: [0, .2] }); assert.equal(stills.entries.size, 2);
  assert.equal((await exported({ kind: 'poster', format: 'jpg', shortEdge: 64, at: 0 })).bytes.subarray(0, 2).toString('hex'), 'ffd8');
  assert.match((await exported({ kind: 'subtitles', format: 'srt' })).bytes.toString(), /Export capability/);
  assert.equal((await exported({ kind: 'slides', format: 'pdf', shortEdge: 64, at: [0] })).bytes.subarray(0, 5).toString(), '%PDF-');
  const nle = await exported({ kind: 'nle', format: 'xml', fps: 24, alpha: 'png' }); assert.ok([...nle.entries.keys()].some(name => name.endsWith('.xml'))); assert.ok([...nle.entries.keys()].some(name => name.includes('/media/')));
  const archived = await exported({ kind: 'project', as: 'folder' }); assert.ok([...archived.entries.keys()].some(name => name.endsWith('/film.html'))); assert.ok([...archived.entries.keys()].some(name => name.endsWith('/pages/subject.html')));
  const stems = await exported({ kind: 'audio', format: 'wav', mix: true, stems: true }); assert.ok(stems.entries.size >= 2);
  for (const format of ['jianying', 'capcut']) {
    const draft = await exported({ kind: 'nle', format, fps: 24, alpha: 'png' });
    assert.ok([...draft.entries.keys()].some(name => name.endsWith('/draft_content.json'))); assert.ok([...draft.entries.keys()].some(name => name.includes('/media/')));
  }
  for (const external of externalFolders) { assert.deepEqual(await readdir(external), ['sentinel.txt']); assert.equal(await readFile(path.join(external, 'sentinel.txt'), 'utf8'), 'external app data must stay unchanged'); }
  await writeFile(path.join(folder, 'film.html'), film(120));
  const context = await manager.context(projectId, origin), running = await manager.exportNative(projectId, { kind: 'video', fps: 60, shortEdge: 64, range: [0, 120] }, origin, { expectedRevision: context.revision });
  const cancellation = await manager.cancelNativeExport(projectId, running.export.id, origin); assert.equal(cancellation.cancellationRequested, true);
  let cancelled; const deadline = Date.now() + 30000;
  do { cancelled = (await manager.nativeExports(projectId)).exports.find(item => item.id === running.export.id); if (cancelled?.status === 'cancelled') break; await delay(50); } while (Date.now() < deadline);
  assert.equal(cancelled?.status, 'cancelled');
  const evidence = process.env.GUANGXUAN_NATIVE_EXPORT_EVIDENCE;
  if (evidence) { await mkdir(evidence, { recursive: true }); await writeFile(path.join(evidence, 'real-native-exports.json'), JSON.stringify({ status: 'passed', actualEngine: true, actualWorker: true, allNineKinds: true, userKeyUsed: false, requested4417: false, userDataUsed: false, externalAppDirectoriesUnchanged: true, cancelledStatus: cancelled.status, outputs }, null, 2)); }
});
