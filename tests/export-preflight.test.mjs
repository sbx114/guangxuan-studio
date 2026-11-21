import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createExportPreflight } from '../lib/export-preflight.mjs';

const execute = promisify(execFile);
const ffmpeg = process.env.GUANGXUAN_FFMPEG || (process.env.GUANGXUAN_BIN_DIR ? path.join(process.env.GUANGXUAN_BIN_DIR, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg') : 'ffmpeg');
const ffprobe = process.env.GUANGXUAN_FFPROBE || (process.env.GUANGXUAN_BIN_DIR ? path.join(process.env.GUANGXUAN_BIN_DIR, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe') : 'ffprobe');
const mediaReady = await Promise.all([ffmpeg, ffprobe].map(binary => execute(binary, ['-version'], { windowsHide: true, timeout: 5000 }).then(() => true).catch(() => false))).then(values => values.every(Boolean));
const mediaTest = (name, fn) => test(name, { skip: mediaReady ? false : 'Set GUANGXUAN_BIN_DIR to an existing local FFmpeg runtime.' }, fn);
const document = (clips = [{ id: 'picture', src: 'media/normal.mp4', time: [0, 2] }]) => ({ stage: { w: 1280, h: 720 }, tracks: [{ attrs: { id: 'guangxuan-picture' }, clips }] });
async function fixture(t, doc = document(), options = {}) {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'gx-preflight-')), media = path.join(folder, 'native', 'media');
  await mkdir(media, { recursive: true });
  const state = { doc, revision: 'sha256:fixture-version-a', calls: 0, sources: [], ...options.state };
  const openFilm = { async preflightSnapshot(projectId) { state.calls += 1; return { projectId, document: structuredClone(state.doc), revision: typeof state.revision === 'function' ? state.revision(state.calls) : state.revision, sources: state.sources, runtime: { available: true } }; } };
  const service = await createExportPreflight({ dataDir: folder, openFilm, videoService: { runtimeTools: () => ({ ffmpeg: mediaReady ? ffmpeg : null, ffprobe: mediaReady ? ffprobe : null }) }, capabilities: { ffmpeg: mediaReady ? ffmpeg : false, ffprobe: mediaReady ? ffprobe : false, browserAvailable: true, ...options.capabilities }, ...options.service });
  t.after(async () => { await service.close(); assert.equal(path.dirname(path.resolve(folder)), path.resolve(os.tmpdir())); assert.ok(path.basename(folder).startsWith('gx-preflight-')); await rm(folder, { recursive: true, force: true }); });
  const source = (src, filename, extra = {}) => { const value = { src, controlled: true, exists: true, readable: true, path: filename, ...extra }; state.sources.push(value); return value; };
  async function movie(name, { black = false, silent = false, duration = 2 } = {}) {
    const filename = path.join(media, name);
    await execute(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${black ? 'black' : 'red'}:size=160x90:rate=10:duration=${duration}`, '-f', 'lavfi', '-i', silent ? 'anullsrc=r=16000:cl=mono' : 'sine=frequency=900:sample_rate=16000', '-t', String(duration), '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', filename], { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 });
    source(`media/${name}`, filename); return filename;
  }
  return { service, state, folder, media, source, movie };
}
const codes = report => report.issues.map(issue => issue.code);

mediaTest('quick preflight probes real referenced media without claiming to render or detect black frames', async t => {
  const f = await fixture(t); await f.movie('normal.mp4');
  const original = JSON.stringify(f.state.doc), report = await f.service.check('project-a');
  assert.equal(report.canExport, true); assert.equal(report.ok, true); assert.equal(report.revision, 'sha256:fixture-version-a'); assert.equal(report.summary.duration, 2);
  assert.equal(report.checks.media.probed, 1); assert.equal(report.checks.runtime.exportAvailable, true); assert.equal(report.checks.rendered, false);
  assert.equal(report.checks.deep.enabled, false); assert.equal(report.checks.deep.samples.length, 0); assert.equal(report.checks.audio.mixedOutputMeasured, false);
  assert.equal(JSON.stringify(f.state.doc), original); assert.equal(f.state.calls, 2); assert.deepEqual(report.issues, []);
});

mediaTest('real source blackdetect and silencedetect produce warnings, preserve intentional output and map used trim times', async t => {
  const f = await fixture(t, document([{ id: 'black-clip', src: 'media/black.mp4', time: [0, 2], speed: 2 }])); await f.movie('black.mp4', { black: true, silent: true });
  const quick = await f.service.check('project-a'); assert.ok(!codes(quick).includes('SOURCE_BLACK_DETECTED')); assert.ok(!codes(quick).includes('SOURCE_SILENCE_DETECTED'));
  const report = await f.service.check('project-a', { deep: true, range: [.25, .75] });
  assert.equal(report.canExport, true); assert.equal(report.ok, false); assert.ok(codes(report).includes('SOURCE_BLACK_DETECTED')); assert.ok(codes(report).includes('SOURCE_SILENCE_DETECTED'));
  assert.equal(report.checks.deep.finalCompositeChecked, false); assert.equal(report.checks.audio.sourceSilenceMeasured, true); assert.match(report.checks.deep.note, /源素材.*有限采样.*没有渲染最终/);
  assert.equal(report.checks.deep.samples[0].sourceStart, .5); assert.equal(report.checks.deep.samples[0].sourceEnd, 1.5);
  for (const issue of report.issues.filter(issue => /SOURCE_(?:BLACK|SILENCE)_DETECTED/.test(issue.code))) { assert.equal(issue.severity, 'warning'); assert.equal(issue.clipId, 'black-clip'); assert.ok(issue.start >= .249 && issue.end <= .751); }
});

mediaTest('missing native files, invalid media and out-of-bounds trims block export', async t => {
  const f = await fixture(t); f.source('media/normal.mp4', path.join(f.media, 'absent.mp4'));
  const missing = await f.service.check('project-a'); assert.equal(missing.canExport, false); assert.ok(codes(missing).includes('SOURCE_MISSING'));
  await writeFile(path.join(f.media, 'absent.mp4'), 'not a video');
  const invalid = await f.service.check('project-a'); assert.equal(invalid.canExport, false); assert.ok(codes(invalid).includes('MEDIA_UNREADABLE'));
  f.state.sources = []; await f.movie('normal.mp4'); f.state.doc.tracks[0].clips[0].time = [0, 8];
  const trim = await f.service.check('project-a'); assert.equal(trim.canExport, false); assert.ok(codes(trim).includes('MEDIA_TRIM_OUT_OF_BOUNDS'));
});

mediaTest('deep checks stay within the advertised source-sample count and duration limits', async t => {
  const f = await fixture(t); const filename = await f.movie('normal.mp4');
  f.state.sources = []; f.state.doc.tracks[0].clips = [];
  for (let index = 0; index < 8; index += 1) {
    const src = `media/alias-${index}.mp4`; f.source(src, filename);
    f.state.doc.tracks[0].clips.push({ id: `clip-${index}`, src, at: index * 2, time: [0, 2] });
  }
  const report = await f.service.check('project-a', { deep: true });
  assert.equal(report.canExport, true); assert.equal(report.checks.deep.samples.length, 6);
  assert.ok(report.checks.deep.sampledSourceSeconds <= 60);
  assert.ok(report.checks.deep.samples.every(sample => sample.sourceEnd - sample.sourceStart <= 12));
  assert.equal(report.checks.rendered, false); assert.equal(report.checks.deep.finalCompositeChecked, false);
});

mediaTest('gaps, caption end/safe boxes and explicit muted tracks are useful warnings, not hard failures', async t => {
  const f = await fixture(t, document([{ id: 'picture', src: 'media/normal.mp4', at: 1, time: [0, 2], volume: 0 }])); await f.movie('normal.mp4');
  const captionPath = path.join(f.folder, 'caption.html'); await writeFile(captionPath, '<!doctype html><p>测试字幕</p>'); f.source('caption.html', captionPath);
  f.state.doc.tracks.unshift({ attrs: { id: 'guangxuan-captions' }, clips: [{ id: 'caption', src: 'caption.html', time: [0, 4], box: { x: -12, y: 680, w: 1100, h: 60 }, attrs: { 'data-guangxuan-caption': 'true' } }] });
  const report = await f.service.check('project-a');
  assert.equal(report.canExport, true); for (const code of ['TIMELINE_GAP', 'CAPTION_AFTER_PICTURE', 'CAPTION_OUTSIDE_STAGE', 'ALL_AUDIO_MUTED']) assert.ok(codes(report).includes(code), code);
  assert.equal(report.checks.captions.finalTextPixelsChecked, false); assert.equal(report.checks.captions.status, 'partial');
  assert.deepEqual(report.issues.find(issue => issue.code === 'TIMELINE_GAP').start, 0);
});

mediaTest('WebVTT timing and export ranges are checked without echoing subtitle contents', async t => {
  const f = await fixture(t); await f.movie('normal.mp4');
  const filename = path.join(f.folder, 'subtitles.vtt'); await writeFile(filename, 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000 position:120%\nprivate-subtitle-content-never-returned\n');
  f.source('subtitles.vtt', filename); f.state.doc.tracks.unshift({ clips: [], captions: { src: 'subtitles.vtt', kind: 'captions' } });
  const report = await f.service.check('project-a', { range: [0, 4] });
  assert.equal(report.canExport, false); assert.ok(codes(report).includes('EXPORT_RANGE_OUTSIDE_TIMELINE')); assert.ok(codes(report).includes('CAPTION_AFTER_PICTURE')); assert.ok(codes(report).includes('CAPTION_POSITION_INVALID'));
  assert.equal(report.summary.captionCount, 1); assert.ok(!JSON.stringify(report).includes('private-subtitle-content'));
});

test('unavailable runtime, empty film and revision changes are hard errors', async t => {
  const f = await fixture(t, document([]), { capabilities: { ffmpeg: false, ffprobe: false, browserAvailable: false } });
  const report = await f.service.check('project-a'); assert.equal(report.canExport, false); assert.ok(codes(report).includes('EXPORT_RUNTIME_UNAVAILABLE')); assert.ok(codes(report).includes('EXPORT_BROWSER_UNAVAILABLE')); assert.ok(codes(report).includes('EMPTY_TIMELINE'));
  f.state.revision = call => `sha256:revision-${call}`; const changed = await f.service.check('project-a'); assert.ok(codes(changed).includes('PROJECT_CHANGED_DURING_CHECK')); assert.equal(changed.canExport, false);
});

mediaTest('native copies are the authority even if a stale media catalog asset cannot resolve', async t => {
  const f = await fixture(t, document(), { service: { videoService: { resolveAsset: async () => { throw Error('catalog stale'); }, runtimeTools: () => ({ ffmpeg, ffprobe }) } } });
  await f.movie('normal.mp4'); f.state.sources[0].assetId = 'catalog-stale-asset'; const report = await f.service.check('project-a'); assert.equal(report.canExport, true); assert.equal(report.checks.media.probed, 1);
});

test('uncontrolled external paths and report privacy never expose files, URLs, request settings or raw native text', async t => {
  const f = await fixture(t, document([{ id: 'outside', src: 'https://secret.example/private.mp4?token=sk-secret-value', time: [0, 2] }]), { capabilities: { ffmpeg: false, ffprobe: false } });
  f.state.sources = [{ src: f.state.doc.tracks[0].clips[0].src, exists: true, readable: true, controlled: false, path: 'C:/private/secret-file.mp4' }];
  f.state.doc.tracks[0].clips[0].attrs = { prompt: 'private-original-request-payload', apiKey: 'sk-private-key' };
  const report = await f.service.check('project-a'); assert.equal(report.canExport, false); assert.ok(codes(report).includes('SOURCE_OUTSIDE_PROJECT'));
  const text = JSON.stringify(report); assert.doesNotMatch(text, /secret\.example|sk-secret|C:\/private|private-original-request|sk-private-key|"path"|"document"|"settings"/);
  await assert.rejects(f.service.check('../project-a'), { code: 'INVALID_PROJECT_ID' });
  await assert.rejects(f.service.check('project-a', { range: [2, 1] }), { code: 'EXPORT_PREFLIGHT_INVALID_RANGE' });
  await assert.rejects(f.service.check('project-a', { fps: 0 }), { code: 'EXPORT_PREFLIGHT_INVALID_FPS' });
});

mediaTest('cancelling a real media preflight aborts promptly and a later check still succeeds', async t => {
  const f = await fixture(t); await f.movie('normal.mp4'); await f.service.check('project-a');
  const controller = new AbortController(), started = Date.now();
  const running = f.service.check('project-a', { signal: controller.signal, deep: true });
  setTimeout(() => controller.abort(), 12);
  await assert.rejects(running, { code: 'EXPORT_PREFLIGHT_CANCELLED' }); assert.ok(Date.now() - started < 2500);
  assert.equal((await f.service.check('project-a')).canExport, true);
  const preAborted = new AbortController(); preAborted.abort(); await assert.rejects(f.service.check('project-a', { signal: preAborted.signal }), { code: 'EXPORT_PREFLIGHT_CANCELLED' });
});

test('HTTP preflight only reads controlled project snapshots, validates JSON and does not create exports', async t => {
  const f = await fixture(t, document([]), { capabilities: { ffmpeg: false, ffprobe: false } });
  const server = http.createServer(async (req, res) => { if (!await f.service.handler(req, res, new URL(req.url, 'http://127.0.0.1'))) { res.writeHead(404); res.end(); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const request = async (body, method = 'POST') => { const response = await fetch(`http://127.0.0.1:${server.address().port}/api/projects/project-a/export-preflight`, { method, headers: { 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body } : {}) }); return { status: response.status, data: await response.json() }; };
  assert.equal((await request('{}')).data.canExport, false); assert.equal((await request('{invalid')).status, 400); assert.equal((await request('[]')).status, 400); assert.equal((await request('{}', 'PUT')).status, 405);
  assert.equal((await request(JSON.stringify({ range: [0, 1], settings: { apiKey: 'do-not-echo' }, filename: 'C:/private' }))).status, 200);
});
