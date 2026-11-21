import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { createVideoService } from '../lib/video.mjs';

const execute = promisify(execFile);
const binary = name => process.env['GUANGXUAN_' + name.toUpperCase()] || (process.env.GUANGXUAN_BIN_DIR ? path.join(process.env.GUANGXUAN_BIN_DIR, name + (process.platform === 'win32' ? '.exe' : '')) : name);

test('registered asset metadata contains actual rational FPS, codec and audio properties without file paths or raw tags', { timeout: 60000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gx-asset-metadata-')), source = path.join(directory, 'PRIVATE-local-source.mp4'); let service;
  t.after(async () => { await service?.close(); assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('gx-asset-metadata-')); await rm(directory, { recursive: true, force: true }); });
  await execute(binary('ffmpeg'), ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=30000/1001:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', '-metadata', 'comment=PRIVATE_raw_tag_must_not_leave', '-shortest', source], { windowsHide: true, timeout: 30000 });
  service = await createVideoService({ dataDir: path.join(directory, 'data'), ffmpegPath: binary('ffmpeg'), ffprobePath: binary('ffprobe') });
  const imported = await service.importLocalFile(source, { name: 'trusted video' }), asset = await service.resolveAsset(imported.id), result = await service.readAssetMetadata(imported.id);
  assert.equal(result.assetId, imported.id); assert.equal(result.name, 'trusted video'); assert.equal(result.type, 'video'); assert.equal(result.fpsKind, 'reported-average'); assert.ok(Math.abs(result.fps - 30000 / 1001) < .00001);
  const decoded = JSON.parse((await execute(binary('ffprobe'), ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,nb_read_frames', '-of', 'json', source], { windowsHide: true, timeout: 10000 })).stdout).streams.find(stream => stream.codec_type === 'video');
  assert.deepEqual(result.video.averageFrameRate, { numerator: 30000, denominator: 1001, rational: '30000/1001', value: 30000 / 1001 }); assert.equal(result.video.codec, 'h264'); assert.equal(result.video.pixelFormat, 'yuv420p'); assert.equal(result.video.width, 160); assert.equal(result.video.height, 90); assert.ok(result.video.timeBase.numerator > 0); assert.equal(result.video.frameCount, Number(decoded.nb_read_frames));
  assert.equal(result.hasAudio, true); assert.equal(result.audioTrackCount, 1); assert.equal(result.audioTracks[0].codec, 'aac'); assert.equal(result.audioTracks[0].sampleRate, 48000); assert.equal(result.audioTracks[0].channels, 2); assert.equal(result.audioTracks[0].channelLayout, 'stereo'); assert.ok(result.sourceDuration >= 2 && result.sourceDuration < 2.1);
  const expectedVersion = createHash('sha256').update(JSON.stringify([asset.id, asset.type, asset.size, asset.mtimeMs, asset.duration, asset.width, asset.height, asset.hasAudio])).digest('hex'); assert.equal(result.sourceVersion, expectedVersion);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false); assert.equal(JSON.stringify(result).includes(directory), false); assert.equal(Object.hasOwn(result, 'path'), false); assert.equal(Object.hasOwn(result, 'raw'), false); assert.equal(Object.hasOwn(result, 'tags'), false);
  const sound = path.join(directory, 'sound.wav'), image = path.join(directory, 'image.png');
  await execute(binary('ffmpeg'), ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=16000:duration=1', sound], { windowsHide: true, timeout: 10000 });
  await execute(binary('ffmpeg'), ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=c=red:s=160x90', '-frames:v', '1', '-update', '1', image], { windowsHide: true, timeout: 10000 });
  const soundAsset = await service.importLocalFile(sound), soundInfo = await service.readAssetMetadata(soundAsset.id); assert.equal(soundInfo.type, 'audio'); assert.equal(soundInfo.fps, null); assert.equal(soundInfo.video, null); assert.equal(soundInfo.audioTracks[0].sampleRate, 16000); assert.equal(soundInfo.audioTracks[0].channels, 1);
  const imageAsset = await service.importLocalFile(image), imageInfo = await service.readAssetMetadata(imageAsset.id); assert.equal(imageInfo.type, 'image'); assert.equal(imageInfo.fps, null); assert.equal(imageInfo.fpsKind, 'not-applicable'); assert.equal(imageInfo.sourceDuration, 4); assert.equal(imageInfo.hasAudio, false); assert.equal(imageInfo.video.codec, 'png');
  await assert.rejects(service.readAssetMetadata('C:/private/file.mp4'), { code: 'MEDIA_NOT_FOUND' });
  const cancelled = new AbortController(); cancelled.abort(); await assert.rejects(service.readAssetMetadata(asset.id, { signal: cancelled.signal }), { code: 'MEDIA_CANCELLED' });
  const active = new AbortController(), pending = service.readAssetMetadata(asset.id, { signal: active.signal }); setTimeout(() => active.abort(), 1); await assert.rejects(pending, { code: 'MEDIA_CANCELLED' });
  await appendFile(source, 'changed-fixture'); await assert.rejects(service.readAssetMetadata(asset.id), { code: 'MEDIA_FILE_CHANGED' });
});
