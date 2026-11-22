import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFile, copyFile, mkdir, mkdtemp, open, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { AppError } from '../lib/errors.mjs';
import { createSourceAnalysisService, sourceTimecode } from '../lib/source-analysis.mjs';

const execute = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const executable = name => process.env[`GUANGXUAN_${name.toUpperCase()}`] || (process.env.GUANGXUAN_BIN_DIR ? path.join(process.env.GUANGXUAN_BIN_DIR, `${name}${process.platform === 'win32' ? '.exe' : ''}`) : name);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test, timeout = 10000) { const start = Date.now(); while (!await test()) { if (Date.now() - start > timeout) throw new Error('test condition timed out'); await sleep(20); } }

test('source analysis: actual FFmpeg evidence, bounded provider protocol, cache and cancellation', { timeout: 240000 }, async t => {
  const ffmpeg = executable('ffmpeg'), ffprobe = executable('ffprobe');
  try { await execute(ffmpeg, ['-version'], { windowsHide: true, timeout: 10000 }); await execute(ffprobe, ['-version'], { windowsHide: true, timeout: 10000 }); }
  catch { t.skip('FFmpeg/FFprobe required. Set GUANGXUAN_BIN_DIR.'); return; }
  const temporary = await mkdtemp(path.join(process.env.GUANGXUAN_TEST_DIR || os.tmpdir(), 'gx-analysis-'));
  const dataDir = path.join(temporary, 'data'), video = path.join(temporary, 'three-scenes.mp4'), silent = path.join(temporary, 'silent.mp4'), audio = path.join(temporary, 'bounded-audio.wav');
  await mkdir(dataDir, { recursive: true });
  const command = args => execute(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-y', ...args], { windowsHide: true, timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
  await command(['-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=10:d=1.5', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=10:d=1.5', '-f', 'lavfi', '-i', 'color=c=lime:s=160x90:r=10:d=1.5', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=4.5', '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]', '-map', '[v]', '-map', '3:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video]);
  await command(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=30', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', silent]);
  await command(['-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=16000:duration=605', '-c:a', 'pcm_s16le', audio]);
  const projectId = 'analysis-project', project = { id: projectId, title: '隔离分析项目', kind: 'video', createdAt: '2026-11-17T00:00:00.000Z' };
  const projects = new Map([[projectId, project], ['other-project', { ...project, id: 'other-project' }]]);
  const assets = new Map(), membership = new Map([[projectId, []], ['other-project', []]]);
  const add = (filename, type, duration, width, height, hasAudio) => {
    const asset = { id: randomUUID(), path: filename, name: filename, type, duration, width, height, hasAudio };
    assets.set(asset.id, asset); membership.get(projectId).push(asset); return asset;
  };
  const visual = add(video, 'video', 4.5, 160, 90, true), noAudio = add(silent, 'video', 30, 640, 360, false), longAudio = add(audio, 'audio', 605, 0, 0, true);
  const store = { async read(id) { return projects.get(id) || null; } };
  const videoService = { async resolveAsset(id) { const asset = assets.get(id); if (!asset) throw new AppError(404, 'missing fixture asset', 'MEDIA_NOT_FOUND'); const info = await stat(asset.path); return { ...asset, size: info.size, mtimeMs: info.mtimeMs }; } };
  const openFilm = { async context(id) { return { projectId: id, revision: 'fixture-r1', assets: membership.get(id) || [] }; } };
  const events = [], speechRequests = [], visionRequests = [], pending = [];
  let speechMode = 'normal', cancelDecode = false, service, browser, uiServer;
  const upstream = http.createServer(async (req, res) => {
    try {
      const body = Buffer.concat(await Array.fromAsync(req));
      const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (req.url === '/v1/audio/transcriptions') {
        const form = await new Response(body, { headers: { 'Content-Type': req.headers['content-type'] } }).formData();
        const file = form.get('file'), bytes = Buffer.from(await file.arrayBuffer());
        speechRequests.push({ model: form.get('model'), format: form.get('response_format'), language: form.get('language'), granularity: form.get('timestamp_granularities[]'), contentType: req.headers['content-type'], auth: req.headers.authorization === 'Bearer fixture-secret-not-store', size: bytes.length, magic: bytes.subarray(0, 4).toString(), channels: bytes.readUInt16LE(22), sampleRate: bytes.readUInt32LE(24), filename: file.name });
        if (speechMode === 'delay') await new Promise(resolve => { pending.push(resolve); res.once('close', resolve); });
        if (res.destroyed) return;
        if (speechMode === 'unsupported') return json(404, { error: { message: 'provider does not expose transcription' } });
        if (speechMode === 'json' && form.get('response_format') === 'verbose_json') return json(400, { error: { message: 'response_format verbose_json unsupported; use json' } });
        if (speechMode === 'json') return json(200, { text: '分块范围转写协议夹具' });
        return json(200, { text: '协议夹具转写文字', language: 'zh', segments: [{ start: .1, end: .6, text: '协议夹具转写文字' }] });
      }
      if (req.url === '/v1/chat/completions' || req.url === '/v1/responses') {
        const value = JSON.parse(body), responses = req.url.endsWith('responses');
        const content = responses ? value.input[0].content : value.messages[1].content;
        const text = content[0].text, evidence = JSON.parse(text.slice(text.indexOf('\n') + 1));
        const pictures = content.filter(part => ['input_image', 'image_url'].includes(part.type));
        visionRequests.push({ model: value.model, responses, pictures: pictures.length, evidence, jpeg: pictures.every(part => Buffer.from((part.image_url?.url || part.image_url).split(',')[1], 'base64').subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))) });
        const answer = JSON.stringify({ summary: '基于提供的抽样关键帧与协议夹具转写生成的摘要。', shots: [...evidence.shots.map(shot => {
          const frames = evidence.sampledFrames.filter(frame => frame.shotId === shot.id);
          return { id: shot.id, description: `样本画面 ${shot.id}`, tags: ['测试帧'], ...(value.model === 'fixture-cues' ? { cues: { evidence: frames.map(frame => frame.id), subjects: [{ label: '当前色块', role: 'primary', position: 'center' }], composition: { shotSize: 'wide', negativeSpace: 'none', focus: '实际色块' }, motion: { beforeFrame: frames[0]?.id, afterFrame: frames[1]?.id, direction: 'static', camera: 'static', description: '此对实际帧显示静态色块' }, usableSegments: [{ purpose: 'hold', start: shot.start, end: shot.end, evidence: frames.map(frame => frame.id), rationale: '所列静态抽样候选' }] } } : {}) };
        }), { id: 's999', description: '不应接受的虚构镜头' }] });
        return json(200, responses ? { output_text: answer } : { choices: [{ message: { content: answer } }] });
      }
      json(404, {});
    } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const provider = `http://127.0.0.1:${upstream.address().port}/v1`;
  const settings = { baseUrl: provider, apiKey: 'fixture-secret-not-store', model: 'fixture-vision', apiStyle: 'chat', timeoutSeconds: 10 };
  const origin = 'http://127.0.0.1:4899';
  const create = () => createSourceAnalysisService({ dataDir, root, store, videoService, openFilm, ffmpegPath: ffmpeg, ffprobePath: ffprobe, onJob(job) { events.push({ id: job.id, status: job.status, phase: job.phase, progress: job.progress }); if (cancelDecode && job.phase === 'scenes') { cancelDecode = false; setTimeout(() => service.cancel(projectId, job.id), 10); } } });
  const offlineInput = { sources: [{ assetId: visual.id }], options: { sceneThreshold: .15, maxFrames: 4 } };
  let offline;
  try {
    service = await create();
    await t.test('offline scene cuts and keyframes are actual decoded source evidence', async () => {
      assert.equal(sourceTimecode(3661.234), '01:01:01.234');
      offline = (await service.analyze(projectId, offlineInput, { origin })).items[0];
      assert.equal(offline.summary.kind, 'technical'); assert.equal(offline.transcript.status, 'skipped');
      assert.equal(offline.name, path.basename(video));
      assert.ok(offline.shots.some(shot => shot.boundary === 'detected' && Math.abs(shot.start - 1.5) < .15), 'red-to-blue cut detected');
      assert.ok(offline.shots.some(shot => shot.boundary === 'detected' && Math.abs(shot.start - 3) < .15), 'blue-to-green cut detected');
      assert.equal(offline.shots[0].start, 0); assert.equal(offline.shots.at(-1).end, 4.5);
      for (let i = 1; i < offline.shots.length; i++) assert.equal(offline.shots[i].start, offline.shots[i - 1].end);
      assert.ok(offline.keyframes.length >= 3);
      const first = await service.frame(projectId, offline.cacheKey, offline.keyframes[0].id, { origin });
      assert.equal(first.contentType, 'image/jpeg'); assert.ok(first.bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xd8])));
      const decoded = path.join(temporary, 'decoded-keyframe.jpg'); await writeFile(decoded, first.bytes);
      const pixel = await execute(ffmpeg, ['-v', 'error', '-i', decoded, '-vf', 'scale=1:1', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { windowsHide: true, encoding: 'buffer' });
      assert.ok(pixel.stdout[0] > pixel.stdout[1] + 80 && pixel.stdout[0] > pixel.stdout[2] + 80, 'first keyframe really shows red');
      assert.ok(events.some(event => event.phase === 'keyframes') && events.some(event => event.status === 'complete'));
      assert.equal(speechRequests.length, 0); assert.equal(visionRequests.length, 0);
    });
    await t.test('selected ranges and controlled project membership are enforced', async () => {
      const item = (await service.analyze(projectId, { ...offlineInput, sources: [{ assetId: visual.id, start: 1, end: 3.25 }] }, { origin })).items[0];
      assert.deepEqual([item.range.start, item.range.end], [1, 3.25]); assert.equal(item.coverage.fullSource, false);
      assert.ok(item.keyframes.every(frame => frame.timestamp >= 1 && frame.timestamp <= 3.25));
      assert.ok(item.shots.some(shot => Math.abs(shot.start - 1.5) < .15));
      await assert.rejects(service.start(projectId, { sources: [{ assetId: randomUUID() }] }, { origin }), error => error.code === 'SOURCE_ANALYSIS_ASSET_OUTSIDE_PROJECT');
      await assert.rejects(service.start(projectId, { sources: [{ assetId: visual.id, start: 3, end: 1 }] }, { origin }), error => error.code === 'SOURCE_ANALYSIS_INVALID_RANGE');
      await assert.rejects(service.frame('other-project', offline.cacheKey, offline.keyframes[0].id, { origin }), error => error.status === 404);
      const tooLong = add(video, 'video', 3600, 160, 90, true);
      await assert.rejects(service.start(projectId, { sources: [{ assetId: tooLong.id }] }, { origin }), error => error.code === 'SOURCE_ANALYSIS_INVALID_RANGE');
      membership.set(projectId, membership.get(projectId).filter(asset => asset.id !== tooLong.id));
    });
    await t.test('actual cut pages carry paired JPEG evidence, cue provenance and later source windows without semantic guesses', async () => {
      const input = { sources: [{ assetId: visual.id }], options: { visualSummary: true, model: 'fixture-cues', maxFrames: 12, shotLimit: 1, sceneThreshold: .15 } };
      const first = (await service.analyze(projectId, input, { origin, settings })).items[0];
      assert.equal(first.keyframes.length, 2); assert.deepEqual(first.keyframes.map(frame => frame.phase), ['before', 'after']);
      assert.ok(first.keyframes.every(frame => /^[a-f0-9]{64}$/.test(frame.sha256))); assert.equal(first.pagination.nextShotOffset, 1);
      assert.ok(first.shots[0].cues.evidence.every(id => first.keyframes.some(frame => frame.id === id)));
      assert.equal(first.shots[0].cues.motion.status, 'paired-observation'); assert.equal(first.shots[0].cues.motion.continuous, false);
      assert.equal(first.shots[0].cues.subjects[0].role, 'primary'); assert.ok(first.shots.slice(1).every(shot => !shot.cues));
      const second = (await service.analyze(projectId, { ...input, options: { ...input.options, shotOffset: 1 } }, { origin, settings })).items[0];
      assert.ok(second.keyframes.every(frame => frame.timestamp > 1.5 && frame.timestamp < 3));
      assert.ok(second.keyframes.every(frame => !first.keyframes.some(old => old.id === frame.id))); assert.equal(second.pagination.nextShotOffset, 2);
      const context = (await service.context(projectId, { origin, assetIds: [visual.id] })).sourceAnalysis;
      assert.ok(context.items.some(item => item.pagination?.shotOffset === 1 && item.frames.length === 2 && item.shots.some(shot => shot.cues)));
      assert.ok(visionRequests.at(-1).jpeg && visionRequests.at(-1).pictures === 2);
    });
    await t.test('later shot pages reuse only exact-content successful ASR with the same speech profile', async () => {
      const input = { sources: [{ assetId: visual.id }], options: { transcribe: true, transcriptionModel: 'fixture-cue-asr-reuse', audioChunkSeconds: 1, maxFrames: 12, shotLimit: 1, sceneThreshold: .15 } };
      const first = (await service.analyze(projectId, input, { origin, settings })).items[0], count = speechRequests.length;
      const second = (await service.analyze(projectId, { ...input, options: { ...input.options, shotOffset: 1 } }, { origin, settings })).items[0];
      assert.equal(speechRequests.length, count); assert.equal(second.transcript.cacheReused, true); assert.equal(second.transcript.originalAnalyzedAt, first.analyzedAt);
      assert.equal(second.transcript.segments[0].timeBasis, 'source-absolute'); assert.deepEqual(second.transcript.segments[0].sourceChunk, { start: 0, end: 1 });
    });
    await t.test('real multipart ASR protocol and visual requests retain absolute source timecodes', async () => {
      const result = await service.analyze(projectId, { sources: [{ assetId: visual.id, start: .5, end: 3 }], options: { transcribe: true, transcriptionModel: 'fixture-speech', language: 'zh', audioChunkSeconds: 1, visualSummary: true, maxFrames: 2, sceneThreshold: .15 } }, { origin, settings });
      const item = result.items[0], speech = speechRequests.slice(-3), vision = visionRequests.at(-1);
      assert.equal(speech.length, 3); assert.ok(speech.every(call => call.model === 'fixture-speech' && call.format === 'verbose_json' && call.granularity === 'segment' && call.auth && call.contentType.startsWith('multipart/form-data; boundary=') && call.magic === 'RIFF' && call.channels === 1 && call.sampleRate === 16000 && call.size < 20 * 1024 * 1024));
      assert.deepEqual(item.transcript.chunks.map(chunk => [chunk.start, chunk.end]), [[.5, 1.5], [1.5, 2.5], [2.5, 3]]);
      assert.equal(item.transcript.status, 'complete'); assert.equal(item.transcript.segments[0].start, .6); assert.equal(item.transcript.segments.at(-1).end, 3);
      assert.equal(item.summary.kind, 'visual-sampled'); assert.ok(vision.jpeg && vision.pictures === 2);
      assert.ok(item.shots.filter(shot => shot.description).every(shot => item.keyframes.some(frame => frame.shotId === shot.id)), 'unseen shots do not acquire a visual description');
      assert.ok(!item.shots.some(shot => shot.id === 's999'));
      const saved = await readFile(path.join(dataDir, 'source-analysis', projectId, item.cacheKey, 'result.json'), 'utf8');
      assert.ok(!saved.includes('fixture-secret-not-store') && !saved.includes(temporary) && !saved.includes('apiKey') && !saved.includes('file://'));
      assert.ok(!JSON.stringify(result).includes(JSON.stringify(visual.path).slice(1, -1)));
    });
    await t.test('long source audio is locally limited to 600-second bounded WAV uploads', async () => {
      const before = speechRequests.length;
      const item = (await service.analyze(projectId, { sources: [{ assetId: longAudio.id }], options: { transcribe: true, transcriptionModel: 'fixture-speech', audioChunkSeconds: 600 } }, { origin, settings })).items[0];
      assert.deepEqual(item.transcript.chunks.map(chunk => [chunk.start, chunk.end]), [[0, 600], [600, 605]]);
      const uploaded = speechRequests.slice(before); assert.equal(uploaded.length, 2);
      assert.ok(uploaded[0].size > 19000000 && uploaded[0].size < 20 * 1024 * 1024); assert.ok(uploaded[1].size < 200000);
      assert.equal(item.shots.length, 0); assert.equal(item.keyframes.length, 0);
    });
    await t.test('JSON-only ASR is labelled by actual chunk ranges rather than invented precise timing', async () => {
      speechMode = 'json'; const before = speechRequests.length;
      const item = (await service.analyze(projectId, { sources: [{ assetId: visual.id, start: .2, end: 1.8 }], options: { transcribe: true, transcriptionModel: 'fixture-json', audioChunkSeconds: 10, maxFrames: 1 } }, { origin, settings })).items[0];
      assert.deepEqual(speechRequests.slice(before).map(call => call.format), ['verbose_json', 'json']);
      assert.equal(item.transcript.timing, 'chunk'); assert.deepEqual([item.transcript.segments[0].start, item.transcript.segments[0].end], [.2, 1.8]);
      assert.match(item.transcript.timingNote, /并非精确字幕/); speechMode = 'normal';
    });
    await t.test('missing/unsupported providers and silent media retain usable local shot results', async () => {
      speechMode = 'unsupported';
      const item = (await service.analyze(projectId, { sources: [{ assetId: visual.id, start: 0, end: 1 }], options: { transcribe: true, transcriptionModel: 'fixture-absent', maxFrames: 1 } }, { origin, settings })).items[0];
      assert.equal(item.transcript.status, 'error'); assert.ok(item.shots.length && item.keyframes.length); assert.match(item.warnings.join(' '), /转写未完成/);
      const missing = (await service.analyze(projectId, { sources: [{ assetId: visual.id, start: 1, end: 2 }], options: { transcribe: true, visualSummary: true, maxFrames: 1 } }, { origin })).items[0];
      assert.equal(missing.transcript.status, 'unavailable'); assert.equal(missing.summary.kind, 'technical'); assert.equal(missing.summary.requestedStatus, 'unavailable');
      speechMode = 'normal'; const count = speechRequests.length;
      const silentResult = (await service.analyze(projectId, { sources: [{ assetId: noAudio.id, start: 0, end: 1 }], options: { transcribe: true, maxFrames: 1 } }, { origin, settings })).items[0];
      assert.equal(silentResult.transcript.status, 'not-applicable'); assert.equal(speechRequests.length, count);
    });
    await t.test('Responses-style vision uses actual bounded images and known shot ids', async () => {
      const item = (await service.analyze(projectId, { sources: [{ assetId: visual.id, start: 0, end: 2 }], options: { visualSummary: true, maxFrames: 2, model: 'fixture-responses' } }, { origin, settings: { ...settings, apiStyle: 'responses' } })).items[0];
      const request = visionRequests.at(-1); assert.ok(request.responses && request.jpeg); assert.equal(request.model, 'fixture-responses'); assert.equal(item.summary.status, 'complete');
    });
    await t.test('provider work can be cancelled promptly without saving an unfinished analysis', async () => {
      speechMode = 'delay'; const count = speechRequests.length;
      const job = await service.start(projectId, { sources: [{ assetId: visual.id, start: 0, end: 2 }], options: { transcribe: true, transcriptionModel: 'fixture-cancel', maxFrames: 1 }, refresh: true }, { origin, settings });
      await until(() => speechRequests.length > count);
      const began = Date.now(); assert.equal(service.cancel(projectId, job.id).status, 'cancelled');
      const done = await service.wait(projectId, job.id); assert.equal(done.status, 'cancelled'); assert.ok(Date.now() - began < 4000);
      for (const resolve of pending.splice(0)) resolve();
      await assert.rejects(stat(path.join(dataDir, 'source-analysis', '.work', job.id)), error => error.code === 'ENOENT');
      speechMode = 'normal';
    });
    await t.test('active FFmpeg decode cancellation releases the queue for the next analysis', async () => {
      cancelDecode = true;
      await assert.rejects(service.analyze(projectId, { sources: [{ assetId: noAudio.id }], options: { maxFrames: 1 }, refresh: true }, { origin }), error => error.code === 'SOURCE_ANALYSIS_CANCELLED');
      assert.equal((await service.analyze(projectId, offlineInput, { origin })).items[0].cached, true);
    });
    await t.test('cache survives restart and ignores changed or removed controlled assets', async () => {
      await service.close(); service = await create();
      assert.equal((await service.analyze(projectId, offlineInput, { origin })).items[0].cached, true);
      assert.ok((await service.context(projectId, { origin })).sourceAnalysis.items.length);
      const originalKey = offline.cacheKey; visual.revision = 'fixture-source-r2';
      assert.ok(!(await service.list(projectId, { origin })).items.some(item => item.cacheKey === originalKey), 'asset revision invalidates otherwise unchanged evidence');
      offline = (await service.analyze(projectId, offlineInput, { origin })).items[0]; assert.notEqual(offline.cacheKey, originalKey);
      const oldKey = offline.cacheKey; await appendFile(video, Buffer.from([0]));
      const listed = await service.list(projectId, { origin }); assert.ok(!listed.items.some(item => item.cacheKey === oldKey));
      await assert.rejects(service.frame(projectId, oldKey, offline.keyframes[0].id, { origin }), error => error.code === 'SOURCE_ANALYSIS_CACHE_STALE');
      const updated = (await service.analyze(projectId, offlineInput, { origin })).items[0]; assert.notEqual(updated.cacheKey, oldKey); assert.equal(updated.cached, false);
      membership.set(projectId, membership.get(projectId).filter(asset => asset.id !== noAudio.id));
      assert.ok(!(await service.context(projectId, { origin })).sourceAnalysis.items.some(item => item.assetId === noAudio.id));
      const dirs = await readdir(path.join(dataDir, 'source-analysis', projectId)); assert.ok(dirs.some(name => /^[a-f0-9]{64}$/.test(name)));
    });
    await t.test('restored same-content analysis rebinds strict mapped assets without provider calls', async () => {
      const input = { sources: [{ assetId: visual.id, start: .5, end: 3 }], options: { transcribe: true, transcriptionModel: 'fixture-rebind', visualSummary: true, sceneThreshold: .15, maxFrames: 2 } };
      const original = (await service.analyze(projectId, input, { origin, settings })).items[0];
      assert.match(original.sourceSignature.contentSha256, /^[a-f0-9]{64}$/);
      const targetId = 'restored-analysis', targetProject = { ...project, id: targetId, createdAt: '2026-11-18T00:00:00.000Z' };
      projects.set(targetId, targetProject);
      const restoredFile = path.join(temporary, 'restored.mp4'); await copyFile(video, restoredFile); await utimes(restoredFile, new Date('2026-11-18'), new Date('2026-11-18'));
      const restoredAsset = { ...visual, id: randomUUID(), path: restoredFile, name: 'restored.mp4', revision: 'new-native-source-r1' };
      assets.set(restoredAsset.id, restoredAsset); membership.set(targetId, [restoredAsset]);
      const oldDirectory = path.join(dataDir, 'source-analysis', projectId, original.cacheKey), newDirectory = path.join(dataDir, 'source-analysis', targetId, original.cacheKey);
      await mkdir(newDirectory, { recursive: true });
      for (const filename of await readdir(oldDirectory)) await copyFile(path.join(oldDirectory, filename), path.join(newDirectory, filename));
      const raw = JSON.parse(await readFile(path.join(newDirectory, 'result.json'), 'utf8'));
      raw.projectId = targetId; raw.assetId = restoredAsset.id;
      raw.settings = { apiKey: 'bundle-injected-value' }; raw.transcript.path = 'C:/private/never-copy-this'; raw.summary.apiKey = 'nested-private-value';
      await writeFile(path.join(newDirectory, 'result.json'), JSON.stringify(raw));
      assert.equal((await service.list(targetId, { origin })).items.length, 0, 'copied cache is not trusted before controlled rebinding');
      const requestsBefore = [speechRequests.length, visionRequests.length], oldRecord = await readFile(path.join(oldDirectory, 'result.json'), 'utf8');
      const args = { assetMap: { [visual.id]: restoredAsset.id }, sourceOwnerCreatedAt: project.createdAt, newOwnerCreatedAt: targetProject.createdAt, origin };
      const report = await service.rebindCachedResults(targetId, args);
      assert.equal(report.rebound.length, 1); assert.equal(report.needsReanalysis.length, 0);
      const restored = (await service.list(targetId, { origin })).items[0];
      assert.equal(restored.assetId, restoredAsset.id); assert.equal(restored.analyzedAt, original.analyzedAt); assert.equal(restored.ownerCreatedAt, targetProject.createdAt);
      assert.equal(restored.provenance.imported, true); assert.equal(restored.provenance.verifiedContentSha256, original.sourceSignature.contentSha256);
      assert.equal(restored.transcript.text, original.transcript.text); assert.equal(restored.summary.text, original.summary.text);
      assert.notEqual(restored.cacheKey, original.cacheKey); assert.notEqual(restored.sourceSignature.mtimeMs, original.sourceSignature.mtimeMs);
      const stored = await readFile(path.join(dataDir, 'source-analysis', targetId, restored.cacheKey, 'result.json'), 'utf8');
      assert.ok(!stored.includes('bundle-injected-value') && !stored.includes('never-copy-this') && !stored.includes('nested-private-value') && !stored.includes('fixture-secret-not-store'));
      const reused = (await service.analyze(targetId, { ...input, sources: [{ ...input.sources[0], assetId: restoredAsset.id }] }, { origin, settings })).items[0];
      assert.equal(reused.cached, true, 'restored profile gets an ordinary cache hit');
      assert.deepEqual([speechRequests.length, visionRequests.length], requestsBefore, 'rebind and same-profile reuse never call a model');
      assert.equal(await readFile(path.join(oldDirectory, 'result.json'), 'utf8'), oldRecord, 'original project cache is untouched');
      const evidence = await service.context(targetId, { origin }); assert.equal(evidence.sourceAnalysis.items[0].provenance.imported, true);
      const again = await service.rebindCachedResults(targetId, args); assert.equal(again.rebound.length, 1); assert.equal(again.needsReanalysis.length, 0);
      await assert.rejects(service.rebindCachedResults(targetId, { ...args, newOwnerCreatedAt: 'wrong-owner' }), error => error.code === 'SOURCE_ANALYSIS_IMPORT_OWNER_MISMATCH');
      const controller = new AbortController(), interrupted = service.rebindCachedResults(targetId, { ...args, signal: controller.signal }); controller.abort();
      await assert.rejects(interrupted, error => error.code === 'SOURCE_ANALYSIS_CANCELLED');
    });
    await t.test('restored unsampled byte differences, missing full hashes and foreign mappings stay untrusted', async () => {
      const original = (await service.list(projectId, { origin })).items.find(item => item.assetId === longAudio.id && item.transcript.status === 'complete');
      assert.ok(original?.sourceSignature.contentSha256);
      const targetId = 'restored-mismatch', targetProject = { ...project, id: targetId, createdAt: '2026-11-19T00:00:00.000Z' };
      projects.set(targetId, targetProject);
      const filename = path.join(temporary, 'restored-modified.wav'); await copyFile(audio, filename);
      const handle = await open(filename, 'r+');
      try { const byte = Buffer.alloc(1); await handle.read(byte, 0, 1, 200000); byte[0] ^= 1; await handle.write(byte, 0, 1, 200000); } finally { await handle.close(); }
      const changed = { ...longAudio, id: randomUUID(), path: filename, name: 'restored-modified.wav' };
      assets.set(changed.id, changed); membership.set(targetId, [changed]);
      const directory = path.join(dataDir, 'source-analysis', targetId, original.cacheKey); await mkdir(directory, { recursive: true });
      const copied = { ...original, projectId: targetId, assetId: changed.id }; delete copied.cached;
      await writeFile(path.join(directory, 'result.json'), JSON.stringify(copied));
      const requestsBefore = [speechRequests.length, visionRequests.length];
      const args = { assetMap: { [longAudio.id]: changed.id }, sourceOwnerCreatedAt: project.createdAt, origin };
      const mismatch = await service.rebindCachedResults(targetId, args);
      assert.equal(mismatch.rebound.length, 0); assert.equal(mismatch.needsReanalysis[0].code, 'SOURCE_ANALYSIS_IMPORT_CONTENT_MISMATCH'); assert.match(mismatch.needsReanalysis[0].reason, /完整内容/);
      const notMapped = await service.rebindCachedResults(targetId, { ...args, assetMap: { [longAudio.id]: randomUUID() } });
      assert.equal(notMapped.needsReanalysis[0].code, 'SOURCE_ANALYSIS_IMPORT_ASSET_MISMATCH');
      delete copied.sourceSignature.contentSha256; await writeFile(path.join(directory, 'result.json'), JSON.stringify(copied));
      const legacy = await service.rebindCachedResults(targetId, args); assert.equal(legacy.needsReanalysis[0].code, 'SOURCE_ANALYSIS_IMPORT_DIGEST_MISSING');
      assert.equal((await service.context(targetId, { origin })).sourceAnalysis.items.length, 0);
      assert.deepEqual([speechRequests.length, visionRequests.length], requestsBefore);
    });
    await t.test('HTTP handler serves bounded results, cancellation and scoped keyframes', async () => {
      uiServer = http.createServer(async (req, res) => {
        try {
          const url = new URL(req.url, `http://${req.headers.host}`); let body;
          if (req.method === 'POST') body = JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString() || '{}');
          if (await service.handler(req, res, url, { body, settings: body?.settings, origin: url.origin })) return;
          const files = { '/source-analysis.js': 'public/source-analysis.js', '/source-analysis.css': 'public/source-analysis.css', '/styles.css': 'public/styles.css', '/ui.js': 'public/ui.js' };
          if (files[url.pathname]) { res.writeHead(200, { 'Content-Type': url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript' }); res.end(await readFile(path.join(root, files[url.pathname]))); return; }
          if (url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(`<!doctype html><html lang="zh"><head><link rel="stylesheet" href="/styles.css"></head><body><div id="app"><button id="open">分析</button></div><div id="modal-root"></div><div id="toast-region"></div><script type="module">import {createSourceAnalysis} from '/source-analysis.js';const client=createSourceAnalysis({getSettings:()=>(${JSON.stringify(settings)})});document.querySelector('#open').onclick=()=>client.show({id:'${projectId}',title:'隔离项目'});</script></body></html>`); return; }
          res.writeHead(404); res.end();
        } catch (error) { res.writeHead(error.status || 500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message, code: error.code })); }
      });
      await new Promise(resolve => uiServer.listen(0, '127.0.0.1', resolve));
      const base = `http://127.0.0.1:${uiServer.address().port}`;
      const list = await (await fetch(`${base}/api/projects/${projectId}/source-analysis`)).json(); assert.ok(list.assets.length && list.items.length);
      const frame = list.items.find(item => item.keyframes.length); assert.ok(frame);
      const bytes = await (await fetch(base + frame.keyframes[0].url)).arrayBuffer(); assert.ok(bytes.byteLength > 50);
      const invalid = await fetch(`${base}/api/projects/${projectId}/source-analysis/frames/${frame.cacheKey}/..%2fresult.json`); assert.ok(invalid.status >= 400);
      let chromium;
      try { ({ chromium } = await import(pathToFileURL(path.join(root, 'node_modules/playwright-core/index.mjs')))); browser = await chromium.launch({ channel: 'msedge', headless: true }); }
      catch { t.diagnostic('Edge not available; HTTP protocol assertions passed, UI check omitted.'); return; }
      const page = await browser.newPage({ viewport: { width: 1200, height: 900 } }), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(base); await page.locator('#open').click();
      await page.locator(`[data-sa-start="${visual.id}"]`).waitFor();
      assert.equal(await page.locator(`[data-sa-start="${visual.id}"]`).isEnabled(), true, 'range fields unlock after candidate load');
      await page.locator(`[data-sa-start="${visual.id}"]`).fill('0.5'); await page.locator(`[data-sa-end="${visual.id}"]`).fill('2.5');
      await page.locator('[data-sa-option="transcribe"]').check();
      await page.locator('[data-sa-option="transcriptionModel"]').fill('fixture-ui-speech');
      await page.locator('[data-sa-option="language"]').selectOption('zh');
      await page.locator('[data-sa-option="visualSummary"]').check();
      await page.getByRole('button', { name: '开始分析', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('[data-sa-progress-text]')?.textContent.includes('已完成'), null, { timeout: 20000 });
      assert.equal(await page.getByRole('button', { name: '取消分析', exact: true }).isVisible(), false);
      assert.ok((await page.locator('.sa-result').first().innerText()).includes('00:00:00.500–00:00:02.500'));
      assert.ok((await page.locator('.sa-result').first().innerText()).includes('协议夹具转写文字'));
      assert.equal(speechRequests.at(-1).model, 'fixture-ui-speech'); assert.equal(speechRequests.at(-1).language, 'zh');
      speechMode = 'delay'; const count = speechRequests.length;
      await page.getByRole('button', { name: '刷新所选分析', exact: true }).click();
      await until(() => speechRequests.length > count);
      await page.getByRole('button', { name: '取消分析', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('[data-sa-status]')?.textContent.includes('已取消'), null, { timeout: 10000 });
      for (const resolve of pending.splice(0)) resolve(); speechMode = 'normal';
      assert.equal(await page.locator(`[data-sa-start="${visual.id}"]`).isEnabled(), true);
      await page.locator('[data-sa-option="transcribe"]').uncheck(); await page.locator('[data-sa-option="visualSummary"]').uncheck();
      await page.getByRole('button', { name: '开始分析', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('[data-sa-progress-text]')?.textContent.includes('已完成'), null, { timeout: 20000 });
      assert.equal(await page.getByRole('button', { name: '取消分析', exact: true }).isVisible(), false);
      await page.screenshot({ path: path.join(temporary, 'source-analysis-ui.png'), fullPage: false });
      assert.deepEqual(errors, []); await browser.close(); browser = null;
    });
  } finally {
    for (const resolve of pending.splice(0)) resolve();
    await browser?.close();
    await service?.close();
    if (uiServer) { uiServer.closeAllConnections(); await new Promise(resolve => uiServer.close(resolve)); }
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    if (process.env.GUANGXUAN_KEEP_ANALYSIS_TESTS !== '1') {
      const base = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()), relative = path.relative(base, path.resolve(temporary));
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative)); await rm(temporary, { recursive: true, force: true });
    }
  }
});
