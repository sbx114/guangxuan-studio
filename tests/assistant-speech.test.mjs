import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createProjectStore } from '../lib/store.mjs';
import { createVideoService } from '../lib/video.mjs';
import { createSourceAnalysisService } from '../lib/source-analysis.mjs';
const exec = promisify(execFile), root = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const bin = process.env.GUANGXUAN_BIN_DIR;
async function setup(t, respond) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gx-assistant-speech-'));
  const dataDir = path.join(directory, 'data'), store = await createProjectStore(dataDir);
  await store.save('science-speech', { kind: 'science', title: '音视频材料', createdAt: '2026-01-01T00:00:00Z', science: {} });
  const provider = http.createServer(async (req, res) => {
    let raw = Buffer.alloc(0); for await (const chunk of req) raw = Buffer.concat([raw, chunk]);
    await respond({ req, res, raw, store });
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const ffmpeg = path.join(bin, 'ffmpeg.exe'), ffprobe = path.join(bin, 'ffprobe.exe');
  const file = path.join(directory, 'lecture.mp4');
  await exec(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=160x90:r=15:d=1.2', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=1.2', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', file], { windowsHide: true, timeout: 15000 });
  const video = await createVideoService({ dataDir, root, ffmpegPath: ffmpeg, ffprobePath: ffprobe });
  const asset = await video.importLocalFile(file);
  const analysis = await createSourceAnalysisService({ dataDir, root, store, videoService: video, ffmpegPath: ffmpeg, ffprobePath: ffprobe });
  t.after(async () => { await analysis.close(); await video.close(); await store.settle(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('gx-assistant-speech-')) throw Error('Unsafe cleanup'); await rm(directory, { recursive: true, force: true }); });
  return { dataDir, store, asset, analysis, settings: { baseUrl: 'http://127.0.0.1:' + provider.address().port, apiKey: 'fixture-no-real-key', model: 'vision-fixture', timeoutSeconds: 10 } };
}
const success = res => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ text: '对照实验需要保持其他条件相同。', segments: [{ start: 0, end: 1.1, text: '对照实验需要保持其他条件相同。' }], language: 'zh' })); };

test('assistant science media reuses real bounded WAV extraction and multipart ASR with genuine segment text', { skip: !bin }, async t => {
  let observed;
  const f = await setup(t, ({ req, res, raw }) => { observed = { url: req.url, headers: req.headers, raw }; success(res); });
  const result = await f.analysis.transcribeAsset('science-speech', f.asset.id, { settings: f.settings, range: { start: 0, end: 1.2 } });
  assert.equal(result.status, 'complete'); assert.match(result.text, /保持其他条件相同/);
  assert.equal(observed.url, '/v1/audio/transcriptions'); assert.match(observed.headers['content-type'], /^multipart\/form-data/);
  assert.ok(observed.raw.includes(Buffer.from('RIFF')) && observed.raw.includes(Buffer.from('WAVE')));
  assert.ok(observed.raw.includes(Buffer.from('whisper-1'))); assert.equal(result.segments[0].start, 0); assert.ok(result.segments[0].end <= 1.2);
  assert.deepEqual(await readdir(path.join(f.dataDir, 'source-analysis', '.work')), []);
});

test('unsupported transcription is reported as a real failure without invented speech', { skip: !bin }, async t => {
  const f = await setup(t, ({ res }) => { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'not supported' } })); });
  const result = await f.analysis.transcribeAsset('science-speech', f.asset.id, { settings: f.settings });
  assert.equal(result.status, 'error'); assert.equal(result.text, ''); assert.deepEqual(result.segments, []); assert.ok(result.warning);
});

test('assistant transcription cancellation stops the actual provider connection and removes audio chunks', { skip: !bin }, async t => {
  let entered, disconnected = false; const connected = new Promise(resolve => { entered = resolve; });
  const f = await setup(t, ({ res }) => { res.once('close', () => { disconnected = true; }); entered(); });
  const controller = new AbortController(), pending = f.analysis.transcribeAsset('science-speech', f.asset.id, { settings: f.settings, signal: controller.signal });
  await connected; controller.abort(); await assert.rejects(pending, error => error.status === 499);
  for (let n = 0; n < 30 && !disconnected; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(disconnected, true); assert.deepEqual(await readdir(path.join(f.dataDir, 'source-analysis', '.work')), []);
});

test('assistant transcription cannot import results across same-ID project recreation', { skip: !bin }, async t => {
  const f = await setup(t, async ({ res, store }) => { await store.remove('science-speech'); await store.save('science-speech', { kind: 'science', title: '新项目', createdAt: '2026-02-01T00:00:00Z', science: {} }); success(res); });
  await assert.rejects(f.analysis.transcribeAsset('science-speech', f.asset.id, { settings: f.settings }), { code: 'SOURCE_ANALYSIS_OWNER_CHANGED' });
  assert.deepEqual(await readdir(path.join(f.dataDir, 'source-analysis', '.work')), []);
});
