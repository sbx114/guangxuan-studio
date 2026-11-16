import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import os from 'node:os';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createVideoService } from '../lib/video.mjs';

function executable(name) {
  return process.env[`GUANGXUAN_${name.toUpperCase()}`] || (process.env.GUANGXUAN_BIN_DIR ? path.join(process.env.GUANGXUAN_BIN_DIR, `${name}${process.platform === 'win32' ? '.exe' : ''}`) : name);
}

function command(binary, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let stderr = '';
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-10000); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`Media command failed (${code}): ${stderr}`)));
  });
}

async function serve(dataDir, ffmpegPath, ffprobePath, root) {
  const service = await createVideoService({ dataDir, ffmpegPath, ffprobePath, root });
  const server = http.createServer(async (req, res) => {
    try {
      if (!await service.handler(req, res, new URL(req.url, 'http://127.0.0.1'))) { res.writeHead(404); res.end(); }
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(error.status || 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message, code: error.code }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      await service.close();
      await new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
    },
  };
}

test('real FFmpeg export trims and joins video/image clips, burns captions, mixes music, serves ranges and survives restart', { timeout: 180000 }, async t => {
  const ffmpeg = executable('ffmpeg');
  const ffprobe = executable('ffprobe');
  try { await Promise.all([command(ffmpeg, ['-version']), command(ffprobe, ['-version'])]); }
  catch { t.skip('Real FFmpeg/FFprobe required. Set GUANGXUAN_BIN_DIR or GUANGXUAN_FFMPEG/GUANGXUAN_FFPROBE.'); return; }
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'guangxuan-video-test-'));
  let app;
  t.after(async () => {
    await app?.close();
    const resolved = path.resolve(temporary);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('guangxuan-video-test-')) throw new Error('Refusing unsafe cleanup target');
    await rm(resolved, { recursive: true, force: true });
  });
  const red = path.join(temporary, '红色素材 with spaces.mp4');
  const blue = path.join(temporary, 'blue portrait.mp4');
  const music = path.join(temporary, 'music.wav');
  const image = path.join(temporary, 'green.png');
  const common = ['-hide_banner', '-loglevel', 'error', '-y'];
  await command(ffmpeg, [...common, '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=30:d=2.4', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2.4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', red]);
  await command(ffmpeg, [...common, '-f', 'lavfi', '-i', 'color=c=blue:s=180x320:r=30:d=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', blue]);
  await command(ffmpeg, [...common, '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=0.8', music]);
  await command(ffmpeg, [...common, '-f', 'lavfi', '-i', 'color=c=lime:s=320x180', '-frames:v', '1', '-update', '1', image]);
  const dataDir = path.join(temporary, 'data');
  app = await serve(dataDir, ffmpeg, ffprobe);

  async function post(route, body, expected = 200) {
    const response = await fetch(`${app.url}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    assert.equal(response.status, expected, JSON.stringify(result));
    return result;
  }

  const status = await (await fetch(`${app.url}/api/video/status`)).json();
  assert.equal(status.ready, true);
  const imported = await post('/api/video/import-local', { paths: [red, blue, music] });
  assert.deepEqual(imported.assets.map(asset => asset.type), ['video', 'video', 'audio']);
  assert.equal(imported.assets[0].hasAudio, true);
  assert.equal(imported.assets[1].hasAudio, false);
  assert.equal(Object.hasOwn(imported.assets[0], 'path'), false, 'The browser does not receive arbitrary local file paths');
  const png = await readFile(image);
  const generated = await post('/api/video/import-generated', { name: 'Synthetic fixture', dataBase64: png.toString('base64'), mimeType: 'image/png', prompt: 'Synthetic green image used only by the integration test', model: 'test-fixture-not-ai' });
  assert.equal(generated.assets[0].type, 'image');
  assert.equal(generated.assets[0].duration, 4);
  assert.equal(generated.assets[0].generated, true);
  assert.equal(generated.assets[0].model, 'test-fixture-not-ai');

  const range = await fetch(`${app.url}${imported.assets[0].url}`, { headers: { Range: 'bytes=0-31' } });
  assert.equal(range.status, 206);
  assert.match(range.headers.get('content-range'), /^bytes 0-31\/\d+$/);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), (await readFile(red)).subarray(0, 32));
  const invalidRange = await fetch(`${app.url}${imported.assets[0].url}`, { headers: { Range: 'bytes=99999999999-' } });
  assert.equal(invalidRange.status, 416);
  await invalidRange.arrayBuffer();
  await post('/api/video/export', { timeline: [{ assetId: imported.assets[0].id, start: 0, end: 999 }], captions: [] }, 400);

  const submitted = await post('/api/video/export', {
    title: 'Real integration export', aspect: '9:16', resolution: '720', sourceVolume: 0.8,
    timeline: [
      { id: 'one', assetId: imported.assets[0].id, start: 0.4, end: 1.4 },
      { id: 'two', assetId: imported.assets[1].id, start: 0.2, end: 1.2 },
      { id: 'three', assetId: generated.assets[0].id, start: 0, end: 1 },
    ],
    captions: [{ start: 0.1, end: 0.9, text: '光宣测试 {\\an8} 中文字幕' }],
    music: { assetId: imported.assets[2].id, volume: 0.2 },
  }, 202);
  let job;
  const deadline = Date.now() + 130000;
  do {
    job = await (await fetch(`${app.url}/api/video/jobs/${submitted.jobId}`)).json();
    assert.notEqual(job.status, 'error', JSON.stringify(job));
    if (job.status === 'complete') break;
    await delay(200);
  } while (Date.now() < deadline);
  assert.equal(job.status, 'complete', JSON.stringify(job));
  assert.equal(job.progress, 1);
  const download = await fetch(`${app.url}${job.downloadUrl}`);
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition'), /attachment/);
  const output = path.join(temporary, 'verified-output.mp4');
  await writeFile(output, Buffer.from(await download.arrayBuffer()));
  const metadata = JSON.parse((await command(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output])).toString());
  const video = metadata.streams.find(stream => stream.codec_type === 'video');
  assert.equal(video.width, 720);
  assert.equal(video.height, 1280);
  assert.ok(Math.abs(Number(metadata.format.duration) - 3) < 0.15, `Expected three trimmed seconds, got ${metadata.format.duration}`);
  assert.ok(metadata.streams.some(stream => stream.codec_type === 'audio'));

  async function centerColor(seconds) {
    return command(ffmpeg, [...common, '-ss', String(seconds), '-i', output, '-frames:v', '1', '-vf', 'crop=40:40:340:620,scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
  }
  const first = await centerColor(0.5);
  const second = await centerColor(1.5);
  const third = await centerColor(2.5);
  assert.ok(first[0] > first[2] + 100, 'First clip should be red');
  assert.ok(second[2] > second[0] + 100, 'Second clip should be blue');
  assert.ok(third[1] > third[0] + 100, 'Third clip should show the imported image');
  const subtitlePixels = await command(ffmpeg, [...common, '-ss', '0.5', '-i', output, '-frames:v', '1', '-vf', 'crop=600:200:60:1040', '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1']);
  assert.ok(subtitlePixels.filter(value => value > 200).length > 50, 'Subtitles should produce bright text in the lower black letterbox, with ASS overrides escaped');
  const audio = await command(ffmpeg, [...common, '-ss', '1.25', '-i', output, '-t', '0.4', '-map', '0:a:0', '-ac', '1', '-ar', '8000', '-f', 'f32le', 'pipe:1']);
  let power = 0;
  for (let offset = 0; offset + 4 <= audio.length; offset += 4) power += audio.readFloatLE(offset) ** 2;
  assert.ok(Math.sqrt(power / (audio.length / 4)) > 0.001, 'Music must remain audible over the video clip with no original audio');

  await app.close();
  app = await serve(dataDir, ffmpeg, ffprobe);
  const restored = await (await fetch(`${app.url}/api/video/assets`)).json();
  assert.equal(restored.assets.length, 4);
  const restoredJob = await (await fetch(`${app.url}/api/video/jobs/${submitted.jobId}`)).json();
  assert.equal(restoredJob.status, 'complete');
  const restoredDownload = await fetch(`${app.url}${restoredJob.downloadUrl}`, { method: 'HEAD' });
  assert.equal(restoredDownload.status, 200);
  assert.equal(restoredDownload.headers.get('content-type'), 'video/mp4');
});

test('Remotion API produces a real asset that can be trimmed and exported again', { timeout: 180000, skip: process.env.GUANGXUAN_TEST_ANIMATION !== '1' }, async t => {
  const ffmpeg = executable('ffmpeg');
  const ffprobe = executable('ffprobe');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'guangxuan-video-test-'));
  const app = await serve(path.join(temporary, 'data'), ffmpeg, ffprobe, root);
  t.after(async () => {
    await app.close();
    const resolved = path.resolve(temporary);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('guangxuan-video-test-')) throw new Error('Refusing unsafe cleanup target');
    await rm(resolved, { recursive: true, force: true });
  });
  async function post(route, body) {
    const response = await fetch(`${app.url}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    assert.equal(response.status, 202, JSON.stringify(result));
    return result;
  }
  async function waitJob(id) {
    const deadline = Date.now() + 140000;
    let result;
    do {
      result = await (await fetch(`${app.url}/api/video/jobs/${id}`)).json();
      assert.notEqual(result.status, 'error', JSON.stringify(result));
      if (result.status === 'complete') return result;
      await delay(500);
    } while (Date.now() < deadline);
    assert.fail(`Animation/export job did not complete: ${JSON.stringify(result)}`);
  }
  const animated = await post('/api/video/render-animation', {
    plan: { title: 'API pipeline fixture', aspect: '16:9', fps: 30, theme: 'paper', scenes: [{ type: 'title', duration: 3, title: '来源与事实', subtitle: '集成测试用动画，非实时AI生成' }] },
    prompt: 'Integration fixture, not an AI request', model: 'test-fixture-not-ai',
  });
  const completed = await waitJob(animated.jobId);
  assert.equal(completed.asset.generated, true);
  assert.equal(completed.asset.generatedType, 'animation');
  assert.equal(completed.asset.plan.scenes.length, 1);
  assert.equal(completed.asset.width, 1280);
  assert.equal(completed.asset.height, 720);
  assert.ok(Math.abs(completed.asset.duration - 3) < 0.15);
  const cut = await post('/api/video/export', {
    title: 'Animation edited output', timeline: [{ assetId: completed.asset.id, start: 0.5, end: 2.5 }],
    captions: [{ start: 0.2, end: 1.7, text: '动画素材可以继续剪辑' }], aspect: '1:1', resolution: '720', sourceVolume: 1,
  });
  const final = await waitJob(cut.jobId);
  const download = await fetch(`${app.url}${final.downloadUrl}`);
  assert.equal(download.status, 200);
  const filename = path.join(temporary, 'edited-animation.mp4');
  await writeFile(filename, Buffer.from(await download.arrayBuffer()));
  const probed = JSON.parse((await command(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filename])).toString());
  const video = probed.streams.find(stream => stream.codec_type === 'video');
  assert.equal(video.width, 720);
  assert.equal(video.height, 720);
  assert.ok(Math.abs(Number(probed.format.duration) - 2) < 0.15);
});

test('browser binary upload creates a real probed asset with Range preview', { timeout: 45000 }, async t => {
  const ffmpeg = executable('ffmpeg');
  const ffprobe = executable('ffprobe');
  try { await Promise.all([command(ffmpeg, ['-version']), command(ffprobe, ['-version'])]); }
  catch { t.skip('Real FFmpeg/FFprobe required. Set GUANGXUAN_BIN_DIR.'); return; }
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'guangxuan-video-test-'));
  let app;
  t.after(async () => {
    await app?.close();
    const resolved = path.resolve(temporary);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('guangxuan-video-test-')) throw new Error('Refusing unsafe cleanup target');
    await rm(resolved, { recursive: true, force: true });
  });
  const filename = path.join(temporary, 'small-upload.mp4');
  await command(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=30:d=0.5', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', filename]);
  app = await serve(path.join(temporary, 'data'), ffmpeg, ffprobe);
  const response = await fetch(`${app.url}/api/video/upload`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent('上传片段 + 1.mp4') },
    body: createReadStream(filename), duplex: 'half',
  });
  const uploaded = await response.json();
  assert.equal(response.status, 200, JSON.stringify(uploaded));
  assert.equal(uploaded.assets.length, 1);
  const asset = uploaded.assets[0];
  assert.equal(asset.name, '上传片段 + 1.mp4');
  assert.equal(asset.type, 'video');
  assert.equal(asset.width, 160);
  assert.equal(asset.height, 90);
  assert.ok(Math.abs(asset.duration - 0.5) < 0.1);
  assert.equal(Object.hasOwn(asset, 'path'), false);
  const preview = await fetch(`${app.url}${asset.url}`, { headers: { Range: 'bytes=0-31' } });
  assert.equal(preview.status, 206);
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), (await readFile(filename)).subarray(0, 32));
});
