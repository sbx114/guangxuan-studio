import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createVideoService } from '../lib/video.mjs';

const execute = promisify(execFile);
const command = (binary, args) => execute(binary, args, { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
const binary = name => process.env[`GUANGXUAN_${name.toUpperCase()}`] || (process.env.GUANGXUAN_BIN_DIR ? path.join(process.env.GUANGXUAN_BIN_DIR, name + (process.platform === 'win32' ? '.exe' : '')) : name);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function jpegSize(dataUrl) {
  assert.match(dataUrl, /^data:image\/jpeg;base64,/);
  const bytes = Buffer.from(dataUrl.split(',')[1], 'base64');
  assert.equal(bytes.readUInt16BE(0), 0xffd8);
  for (let offset = 2; offset + 8 < bytes.length;) {
    assert.equal(bytes[offset++], 255);
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if ([0xc0, 0xc1, 0xc2].includes(marker)) return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
    if (marker === 0xda || marker === 0xd9) break;
    offset += bytes.readUInt16BE(offset);
  }
  assert.fail('JPEG lacks frame dimensions');
}

test('real reference media yields bounded JPEG samples, survives restart, rejects audio and cancels work', { timeout: 120000 }, async t => {
  const ffmpeg = binary('ffmpeg'), ffprobe = binary('ffprobe');
  try { await Promise.all([command(ffmpeg, ['-version']), command(ffprobe, ['-version'])]); }
  catch { t.skip('FFmpeg/FFprobe required. Set GUANGXUAN_BIN_DIR.'); return; }
  const folder = await mkdtemp(path.join(os.tmpdir(), 'guangxuan-reference-frames-'));
  let service;
  t.after(async () => {
    await service?.close();
    const resolved = path.resolve(folder);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('guangxuan-reference-frames-')) throw new Error('Unsafe test cleanup');
    await rm(resolved, { recursive: true, force: true });
  });
  const videoFile = path.join(folder, 'reference.mp4'), imageFile = path.join(folder, 'portrait.png'), audioFile = path.join(folder, 'sound.wav');
  await Promise.all([
    command(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=20:duration=2', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', videoFile]),
    command(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:size=1200x1800', '-frames:v', '1', '-update', '1', imageFile]),
    command(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.25', '-c:a', 'pcm_s16le', audioFile]),
  ]);
  const original = hash(await readFile(imageFile));
  const options = { dataDir: path.join(folder, 'data'), ffmpegPath: ffmpeg, ffprobePath: ffprobe };
  service = await createVideoService(options);
  const image = await service.importLocalFile(imageFile, { name: 'Portrait reference', expectedType: 'image' });
  const video = await service.importLocalFile(videoFile, { name: 'Video reference', expectedType: 'video' });
  assert.equal(image.path, undefined); assert.equal(video.path, undefined);
  const catalogFile = path.join(options.dataDir, 'video', 'catalog.json');
  await assert.rejects(service.importLocalFile(audioFile, { expectedType: 'video' }), error => error.code === 'MEDIA_TYPE_MISMATCH');
  assert.equal(JSON.parse(await readFile(catalogFile, 'utf8')).assets.length, 2);
  const picture = await service.referenceFrames(image.id);
  assert.equal(picture.length, 1); assert.equal(picture[0].timestamp, undefined);
  assert.deepEqual(jpegSize(picture[0].dataUrl), { width: 640, height: 960 });
  const frames = await service.referenceFrames(video.id);
  assert.equal(frames.length, 3);
  assert.deepEqual(frames.map(frame => frame.timestamp), [.2, 1, 1.8]);
  assert.ok(frames.every(frame => { const size = jpegSize(frame.dataUrl); return size.width === 960 && size.height === 540; }));
  assert.equal(new Set(frames.map(frame => frame.dataUrl)).size, 3);
  assert.deepEqual((await service.referenceFrames(video.id, { count: 1 })).map(frame => frame.timestamp), [1]);
  assert.deepEqual((await service.referenceFrames(video.id, { count: 2 })).map(frame => frame.timestamp), [.2, 1.8]);
  await assert.rejects(service.referenceFrames(video.id, { count: 4 }), error => error.code === 'INVALID_REFERENCE_FRAME_COUNT');
  const sound = await service.importLocalFile(audioFile);
  await assert.rejects(service.referenceFrames(sound.id), error => error.code === 'INVALID_REFERENCE_MEDIA');
  const before = await readFile(catalogFile, 'utf8');
  const preAborted = new AbortController(); preAborted.abort();
  await assert.rejects(service.referenceFrames(video.id, { signal: preAborted.signal }), error => error.code === 'MEDIA_CANCELLED');
  const active = new AbortController();
  const running = service.referenceFrames(video.id, { signal: active.signal });
  const rejection = assert.rejects(running, error => error.code === 'MEDIA_CANCELLED');
  setTimeout(() => active.abort(), 15);
  await rejection;
  assert.equal(await readFile(catalogFile, 'utf8'), before);
  assert.equal(hash(await readFile(imageFile)), original);
  assert.deepEqual(await readdir(path.join(options.dataDir, 'video', 'generated')), []);
  assert.equal((await service.resolveAsset(video.id)).id, video.id);
  await service.close();
  service = await createVideoService(options);
  const restored = await service.referenceFrames(image.id);
  assert.equal(restored.length, 1); assert.deepEqual(jpegSize(restored[0].dataUrl), { width: 640, height: 960 });
});
