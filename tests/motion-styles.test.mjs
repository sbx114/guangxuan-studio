import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateAnimationPlan, validateAnimationBrand, validateSceneMotion, animationSchedule, animationFrameCount } from '../animation/schema.mjs';
import { ANIMATION_THEMES, animationPalette } from '../animation/styles.mjs';
import { findAnimationBrowser, renderAnimation } from '../animation/render.mjs';
import { createMotionPreviewService } from '../lib/motion-preview.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), execute = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const defaultPlan = () => ({ title: 'Gx default baseline', aspect: '16:9', fps: 30, theme: 'paper', scenes: [
  { type: 'title', duration: 3, title: '让想法成为画面', subtitle: 'Gx 原始模板', note: '保持默认效果' },
  { type: 'steps', duration: 3, title: '清晰的行动步骤', subtitle: '一步一步完成', note: '原始步骤模板', items: ['读取信息', '整理观点', '表达内容'] },
  { type: 'bars', duration: 3, title: '让数据易于理解', subtitle: '原始数据模板', note: '数值只来自输入', data: [{ label: '项目一', value: 42 }, { label: '项目二', value: 76 }, { label: '项目三', value: -25 }] },
  { type: 'quote', duration: 3, title: '好作品来自清晰的表达', subtitle: 'Gx 原始引用模板', note: '保持默认排版' },
  { type: 'outro', duration: 3, title: '从这里继续创作', subtitle: '让下一个想法落地', note: '原始结尾模板' },
] });
function styledPlan() {
  const plan = defaultPlan(); plan.aspect = '9:16'; plan.brand = { palette: 'ocean', font: 'serif', accent: '#168398' };
  plan.scenes.forEach((scene, index) => { scene.motion = { reveal: ['fade', 'rise', 'typewriter', 'mask', 'fade'][index], pace: index % 2 ? 'brisk' : 'calm', camera: ['push', 'pan-left', 'pan-right', 'none', 'push'][index], transition: ['fade', 'wipe', 'cut', 'fade', 'wipe'][index], transitionDuration: .4, easing: 'inOut', amount: .8 }; });
  return plan;
}
async function fixture(t) {
  const base = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(base, { recursive: true });
  const folder = await mkdtemp(path.join(base, 'gx-motion-')), closers = [];
  t.after(async () => {
    for (const close of closers.reverse()) await close();
    if (process.env.GUANGXUAN_KEEP_MOTION_TESTS === '1') { t.diagnostic(`Motion evidence: ${folder}`); return; }
    assert.equal(path.dirname(path.resolve(folder)), base); assert.ok(path.basename(folder).startsWith('gx-motion-')); await rm(folder, { recursive: true, force: true });
  });
  return { folder, closers };
}

test('motion plans retain bounded editable styles and source data without executable fields', () => {
  const plan = styledPlan(), original = structuredClone(plan); plan.brand.ink = '#AABBCC';
  const valid = validateAnimationPlan({ ...plan, executable: 'never-run' });
  assert.equal(valid.brand.ink, '#aabbcc'); assert.equal(valid.scenes[2].data[2].value, -25); assert.equal(Object.hasOwn(valid, 'executable'), false);
  delete plan.brand.ink; assert.deepEqual(plan, original);
  for (const value of [null, [], { font: 'remote-web-font' }, { background: 'url(https://example.test/)' }, { accent: '#abc' }, { arbitraryCss: 'position:fixed' }]) assert.throws(() => validateAnimationBrand(value));
  for (const value of [null, [], { easing: 'eval' }, { camera: 'unbounded' }, { amount: 1.01 }, { amount: '0.5' }, { transitionDuration: .01 }, { transitionDuration: Infinity }, { style: 'script' }]) assert.throws(() => validateSceneMotion(value));
  assert.deepEqual(validateSceneMotion({ transitionDuration: .35 }), { transitionDuration: 11 / 30 });
});

test('project time, total duration and original palette remain stable under style changes', () => {
  const plain = validateAnimationPlan(defaultPlan()), styled = validateAnimationPlan(styledPlan());
  assert.equal(animationFrameCount(plain), 450); assert.equal(animationFrameCount(styled), 450);
  assert.deepEqual(animationSchedule(plain).map(({ startFrame, endFrame }) => [startFrame, endFrame]), [[0, 90], [90, 180], [180, 270], [270, 360], [360, 450]]);
  assert.deepEqual(animationSchedule(styled), animationSchedule(plain));
  assert.strictEqual(animationPalette('paper'), ANIMATION_THEMES.paper); assert.strictEqual(animationPalette('dark', { palette: 'original', font: 'serif' }), ANIMATION_THEMES.dark);
  const brand = animationPalette('paper', { background: '#ffffff', ink: '#000000', accent: '#123456' });
  assert.equal(brand.background, '#ffffff'); assert.equal(brand.ink, '#000000'); assert.equal(brand.accent, '#123456'); assert.equal(brand.brass, '#123456');
  assert.equal(ANIMATION_THEMES.paper.background, '#e8e5e1');
});

test('preview rejects invalid samples before rendering and serves only completed registered PNG frames', async t => {
  const f = await fixture(t), service = await createMotionPreviewService({ dataDir: f.folder, root }); f.closers.push(() => service.close());
  for (const options of [{ times: [] }, { times: [-1] }, { times: [16] }, { times: Array(17).fill(1) }, { sceneIndexes: [0, 0] }, { sceneIndexes: [5] }, { sceneIndexes: [0], times: [1] }]) await assert.rejects(service.preview(defaultPlan(), options), { code: 'MOTION_PREVIEW_INVALID_SAMPLES' });
  const controller = new AbortController(); controller.abort(); await assert.rejects(service.preview(defaultPlan(), { signal: controller.signal }), { code: 'MOTION_PREVIEW_CANCELLED' });
  assert.deepEqual(await readdir(path.join(f.folder, 'video/previews')), []);
  const id = randomUUID(), target = path.join(f.folder, 'video/previews', id); await mkdir(target);
  await writeFile(path.join(target, 'frame-00.png'), PNG); await writeFile(path.join(target, 'frame-01.png'), PNG);
  await writeFile(path.join(target, 'manifest.json'), JSON.stringify({ id, frames: [{ file: 'frame-00.png' }, { file: 'frame-02.png' }], planHash: 'a'.repeat(64) }));
  assert.deepEqual((await service.file(id, 'frame-00.png')).bytes, PNG);
  await assert.rejects(service.file(id, 'frame-01.png'), { code: 'MOTION_PREVIEW_FILE_NOT_FOUND' });
  await assert.rejects(service.file(id, 'frame-02.png'), { code: 'MOTION_PREVIEW_FILE_NOT_FOUND' });
  await assert.rejects(service.file(id, '../manifest.json'), { code: 'MOTION_PREVIEW_FILE_NOT_FOUND' });
  await assert.rejects(service.file('../outside', 'frame-00.png'), { code: 'MOTION_PREVIEW_NOT_FOUND' });
  const server = http.createServer(async (req, res) => { try { if (!await service.handler(req, res, new URL(req.url, 'http://127.0.0.1'))) { res.writeHead(404); res.end(); } } catch (error) { res.writeHead(error.status || 500); res.end(error.code); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); f.closers.push(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}/api/video/previews/${id}`;
  const head = await fetch(`${base}/frame-00.png`, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(head.headers.get('content-type'), 'image/png'); assert.equal((await head.arrayBuffer()).byteLength, 0);
  const wrong = await fetch(`${base}/frame-01.png`); assert.equal(wrong.status, 404);
  await service.close(); await assert.rejects(service.preview(defaultPlan()), { code: 'MOTION_PREVIEW_CLOSED' });
});

// The old template-dialog browser chain is replaced by remotion-workspace-ui.test.mjs.

test('real Remotion storyboard uses absolute seek time and short render preserves the same frame', { skip: process.env.GUANGXUAN_TEST_ANIMATION !== '1', timeout: 240000 }, async t => {
  const f = await fixture(t), service = await createMotionPreviewService({ dataDir: f.folder, root }); f.closers.push(() => service.close());
  const plan = styledPlan(), progress = [], preview = await service.preview(plan, { times: [7.6, 0, 2.1, 7.6, 14.9, 3.4], onProgress: value => progress.push(value) });
  assert.deepEqual(preview.frames.map(frame => frame.index), [2, 0, 0, 2, 4, 1]); assert.equal(preview.width, 720); assert.equal(preview.height, 1280); assert.equal(preview.duration, 15); assert.equal(progress.at(-1), 1);
  const bytes = await Promise.all(preview.frames.map(frame => service.file(preview.id, frame.file).then(result => result.bytes)));
  assert.deepEqual(bytes[0], bytes[3], 'skipped, backward and repeated project times produce the same PNG'); assert.notDeepEqual(bytes[0], bytes[2]);
  const baseline = await service.preview(defaultPlan()); assert.equal(baseline.frames.length, 5); assert.deepEqual(baseline.frames.map(frame => frame.frame), [45, 135, 225, 315, 405]);
  const controller = new AbortController(), interrupted = service.preview(plan, { times: [1], signal: controller.signal, onProgress: value => { if (value >= .02) controller.abort(); } });
  await assert.rejects(interrupted, { code: 'MOTION_PREVIEW_CANCELLED' });
  const completedDirectories = await readdir(path.join(f.folder, 'video/previews')); assert.equal(completedDirectories.length, 2, 'cancelled previews remove their incomplete directory');
  const output = path.join(f.folder, 'styled-absolute-range.mp4'), range = [3.4, 4];
  const rendered = await renderAnimation({ plan, outputPath: output, range }); assert.deepEqual(rendered.range, range); assert.equal(rendered.duration, .6);
  const executable = name => process.env[`GUANGXUAN_${name.toUpperCase()}`] || (process.env.GUANGXUAN_BIN_DIR ? path.join(process.env.GUANGXUAN_BIN_DIR, name + (process.platform === 'win32' ? '.exe' : '')) : name);
  const probe = JSON.parse((await execute(executable('ffprobe'), ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output], { windowsHide: true })).stdout), video = probe.streams.find(stream => stream.codec_type === 'video');
  assert.equal(video.width, 720); assert.equal(video.height, 1280); assert.ok(Math.abs(Number(probe.format.duration) - .6) < .04);
  const referenceFile = path.join(f.folder, 'range-first-frame.png'); await writeFile(referenceFile, bytes[5]);
  const raw = async file => (await execute(executable('ffmpeg'), ['-v', 'error', '-i', file, '-frames:v', '1', '-vf', 'scale=128:228', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { windowsHide: true, encoding: 'buffer', maxBuffer: 1024 * 1024 })).stdout;
  const reference = await raw(referenceFile), encoded = await raw(output); assert.equal(reference.length, encoded.length);
  const rmse = Math.sqrt(reference.reduce((sum, value, index) => sum + (value - encoded[index]) ** 2, 0) / reference.length); assert.ok(rmse < 12, `The encoded range must start at the requested project frame; RMSE=${rmse}`);
  const report = { passed: true, dimensions: [video.width, video.height], duration: Number(probe.format.duration), range, repeatedSeekPngIdentical: true, rangeFrameRmse: rmse, defaultSceneFrames: baseline.frames, styledFrames: preview.frames, planHash: preview.planHash, encodedBytes: (await readFile(output)).length };
  await writeFile(path.join(f.folder, 'real-render-verification.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(f.folder, 'styled-plan.json'), JSON.stringify(plan, null, 2));
});
