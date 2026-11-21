import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createProjectStore } from '../lib/store.mjs';
import { createReferenceService } from '../lib/references.mjs';
import { createVideoService } from '../lib/video.mjs';
import { buildPrompt } from '../lib/prompts.mjs';
import { parseTimecode, formatTimecode, normalizeTimeRange, rangesOverlap, MAX_TIME_SECONDS } from '../public/time-range.js';

const id = '00000000-0000-4000-8000-000000000001';
const jpeg = 'data:image/jpeg;base64,/9j/2Q==';
async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gx-reference-ranges-'));
  t.after(async () => { assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir(), 'gx-reference-ranges-'))); await rm(directory, { recursive: true, force: true }); });
  return directory;
}
test('timecodes preserve milliseconds and reject ambiguous or invalid ranges', () => {
  assert.equal(parseTimecode('01:02:03.125'), 3723.125);
  assert.equal(parseTimecode('00：12.500'), 12.5);
  assert.equal(formatTimecode(3723.125), '01:02:03.125');
  assert.equal(parseTimecode('25:00:01.125'), 90001.125);
  assert.equal(formatTimecode(90001.125), '25:00:01.125');
  for (const value of ['', '-1', '1e3', '00:60', '00:01.1234', Infinity, MAX_TIME_SECONDS + 1]) assert.throws(() => parseTimecode(value));
  assert.throws(() => normalizeTimeRange({ start: 5, end: 5 }));
  assert.throws(() => normalizeTimeRange({ start: 0, end: 11 }, { duration: 10 }));
  assert.throws(() => normalizeTimeRange({ start: 0, end: 1, path: 'elsewhere' }));
  assert.equal(rangesOverlap({ start: 0, end: 5 }, { start: 5, end: 10 }), false);
});

test('reference source and target bindings persist, validate duration, and clear independently', async t => {
  const dataDir = await temporary(t), store = await createProjectStore(dataDir);
  await store.save('range-project', { kind: 'video', title: '分段参考', video: { timeline: [], captions: [] } });
  const media = { async resolveAsset() { return { id, type: 'video', name: '参考.mp4', size: 1024, duration: 60 }; } };
  let service = await createReferenceService({ dataDir, store, videoService: media });
  const added = await service.add('range-project', { type: 'video', assetId: id, sourceRange: { start: 10, end: 20 }, targetRange: { start: 30, end: 45 } });
  await service.close(); service = await createReferenceService({ dataDir, store, videoService: media }); t.after(() => service.close());
  const item = (await service.list('range-project')).items[0];
  assert.deepEqual(item.sourceRange, { start: 10, end: 20 }); assert.deepEqual(item.targetRange, { start: 30, end: 45 });
  await assert.rejects(service.update('range-project', item.id, { sourceRange: { start: 50, end: 70 } }), { code: 'INVALID_REFERENCE_RANGE' });
  const cleared = await service.update('range-project', item.id, { sourceRange: null });
  assert.equal(cleared.items[0].sourceRange, undefined); assert.deepEqual(cleared.items[0].targetRange, { start: 30, end: 45 });
  assert.equal(added.items.length, 1);
});

test('only in-range frames and distinct bindings reach the model prompt', async t => {
  const dataDir = await temporary(t), store = await createProjectStore(dataDir), calls = [];
  await store.save('range-project', { kind: 'video', title: '分段参考', video: { timeline: [], captions: [] } });
  const media = {
    async resolveAsset() { return { id, type: 'video', name: '参考.mp4', size: 1024, duration: 60 }; },
    async referenceFrames(asset, { range, count }) { calls.push({ range, count }); return [{ dataUrl: jpeg, timestamp: range.start + 1 }]; },
  };
  const service = await createReferenceService({ dataDir, store, videoService: media }); t.after(() => service.close());
  await service.add('range-project', { type: 'video', assetId: id, sourceRange: { start: 12, end: 18 }, targetRange: { start: 40, end: 46 } });
  const context = await service.context('range-project');
  assert.deepEqual(calls[0].range, { start: 12, end: 18 }); assert.equal(context.images[0].timestamp, 13);
  const prompt = buildPrompt('edit-assistant', { instruction: '借鉴所选片段', context: { assets: [], timeline: [], duration: 60, mainTrackEditable: true }, references: context.references });
  assert.match(prompt.system, /sourceRange.*targetRange/s); assert.match(prompt.user, /"start":\s*40/); assert.match(prompt.user, /"start":\s*12/);
  media.referenceFrames = async () => [{ dataUrl: jpeg, timestamp: 0 }];
  await assert.rejects(service.context('range-project'), { code: 'REFERENCE_FRAME_OUTSIDE_RANGE' });
});

test('real FFmpeg reference frames come from the selected blue section', { skip: !process.env.GUANGXUAN_BIN_DIR, timeout: 60000 }, async t => {
  const dataDir = await temporary(t), fixture = path.join(dataDir, 'red-blue.mp4');
  const ffmpeg = path.join(process.env.GUANGXUAN_BIN_DIR, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:r=25:d=1', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=25:d=1', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', fixture], { windowsHide: true });
  const video = await createVideoService({ dataDir }); t.after(() => video.close());
  const asset = await video.importLocalFile(fixture);
  const frames = await video.referenceFrames(asset.id, { count: 3, range: { start: 1.1, end: 1.9 } });
  assert.equal(frames.length, 3);
  for (const frame of frames) {
    assert.ok(frame.timestamp >= 1.1 && frame.timestamp <= 1.9);
    const bytes = Buffer.from(frame.dataUrl.split(',')[1], 'base64');
    const pixel = execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { input: bytes, windowsHide: true });
    assert.ok(pixel[2] > pixel[0] + 100 && pixel[2] > pixel[1] + 100, 'selected frames are blue, never the red preceding section');
  }
});
