import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readFile, writeFile, rm, copyFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { chromium } from 'playwright-core';
import { createProjectStore } from '../lib/store.mjs';
import { createVideoService } from '../lib/video.mjs';
import { createOpenFilmManager } from '../lib/openfilm.mjs';
import { findAnimationBrowser } from '../animation/render.mjs';
import { buildCaptionPage } from '../lib/typography-layout.mjs';
import { normalizeModelData } from '../lib/prompts.mjs';
import { normalizeShotCues } from '../lib/source-analysis-cues.mjs';
import { readFilmFile } from '../integrations/openfilm/packages/openfilm/src/film-doc.mjs';
import { readMotion, valueAt } from '../integrations/openfilm/packages/openfilm/src/clip-motion.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), command = promisify(execFile);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const bin = name => process.env.GUANGXUAN_BIN_DIR ? path.join(process.env.GUANGXUAN_BIN_DIR, name + (process.platform === 'win32' ? '.exe' : '')) : name;
const all = doc => doc.tracks.flatMap(track => track.clips || []);

test('actual browser typography fits landscape and portrait, supports native looks, and retains first-frame manual text edits', { skip: process.env.GUANGXUAN_TEST_OPENFILM !== '1', timeout: 45000 }, async t => {
  const browser = await chromium.launch({ executablePath: await findAnimationBrowser(), headless: true }); t.after(() => browser.close());
  const evidence = process.env.GUANGXUAN_TYPOGRAPHY_EVIDENCE; if (evidence) await mkdir(evidence, { recursive: true });
  const results = [];
  for (const stage of [{ w: 1280, h: 720 }, { w: 720, h: 1280 }]) {
    const page = await browser.newPage({ viewport: { width: stage.w, height: stage.h } });
    const text = '光电研究：从实验到应用。Optical Research';
    const built = buildCaptionPage(text, stage, 4, { role: 'headline', anchor: 'top', align: 'left', maxLines: 3, background: 'panel', lookId: 'text/looks/white-black', motionId: 'text/motions/in-rise' }, 'title');
    await page.setContent(built.html); await page.evaluate(() => window.film.frame(1));
    const actual = await page.locator('#caption').evaluate(node => { const rect = node.getBoundingClientRect(), style = getComputedStyle(node); return { text: node.textContent, overflow: node.dataset.overflow, x: rect.x, y: rect.y, width: rect.width, height: rect.height, fontSize: parseFloat(style.fontSize), stroke: style.webkitTextStrokeWidth, bodyPadding: getComputedStyle(document.body).padding }; });
    assert.equal(actual.text.replace(/\n/g, ''), text); assert.equal(actual.overflow, 'false');
    assert.ok(actual.fontSize >= Math.min(stage.w, stage.h) * .052 - .01); assert.ok(actual.x >= stage.w * .04 && actual.y >= stage.h * .04);
    assert.ok(actual.x + actual.width <= stage.w * .96 && actual.y + actual.height <= stage.h * .96); assert.ok(parseFloat(actual.stroke) > 0);
    if (evidence) await page.screenshot({ path: path.join(evidence, `typography-${stage.w}x${stage.h}.png`) });
    // Native overrides are applied before the page's first requested frame.
    await page.setContent(built.html); await page.locator('#caption').evaluate(node => { node.textContent = '人工修改 <b>仍是纯文本</b>'; node.style.fontSize = '42px'; });
    await page.evaluate(() => window.film.frame(1));
    const edited = await page.locator('#caption').evaluate(node => ({ text: node.textContent, size: getComputedStyle(node).fontSize, elementChildren: node.children.length }));
    assert.equal(edited.text.replace(/\n/g, ''), '人工修改 <b>仍是纯文本</b>'); assert.equal(edited.size, '42px'); assert.equal(edited.elementChildren, 0);
    results.push({ stage, actual, edited }); await page.close();
  }
  if (evidence) await writeFile(path.join(evidence, 'browser-typography-verification.json'), JSON.stringify({ status: 'passed', actualBrowserCanvasMetrics: true, actualLayouts: results, externalModelsUsed: false }, null, 2));
});

test('actual native edit plan renders speed, settled camera movement and mapped captions while preserving CAS and undo', { skip: process.env.GUANGXUAN_TEST_OPENFILM !== '1', timeout: 150000 }, async t => {
  const parent = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(parent, { recursive: true });
  const folder = await mkdtemp(path.join(parent, 'gx-editorial-native-')), dataDir = path.join(folder, 'data');
  let manager, videoService; t.after(async () => { await manager?.close(); await videoService?.close(); assert.equal(path.dirname(folder), parent); await rm(folder, { recursive: true, force: true }); });
  process.env.OPENFILM_BROWSER_EXECUTABLE = await findAnimationBrowser();
  const source = path.join(folder, 'source.mp4');
  await command(bin('ffmpeg'), ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=15:d=6', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', source], { windowsHide: true });
  const frames = [];
  for (const [index, timestamp] of [1.25, 2.5].entries()) {
    const filename = path.join(folder, `f00${index + 1}.jpg`); await command(bin('ffmpeg'), ['-v', 'error', '-nostdin', '-ss', String(timestamp), '-i', source, '-frames:v', '1', filename], { windowsHide: true });
    frames.push({ id: `f00${index + 1}.jpg`, shotId: 's1', timestamp, sha256: digest(await readFile(filename)) });
  }
  const store = await createProjectStore(dataDir); videoService = await createVideoService({ dataDir, root, ffmpegPath: bin('ffmpeg'), ffprobePath: bin('ffprobe') });
  const a = await videoService.importLocalFile(source), b = await videoService.importLocalFile(path.join(folder, 'f002.jpg'));
  const id = 'editorial-typography-fixture', origin = 'http://127.0.0.1:49204';
  await store.save(id, { kind: 'video', title: 'Independent typography fixture', video: { timeline: [{ assetId: a.id, start: 0, end: 4 }, { assetId: b.id, start: 0, end: 1 }], captions: [], aspect: '16:9', resolution: '720' } });
  manager = await createOpenFilmManager({ dataDir, root, store, resolveAsset: assetId => videoService.resolveAsset(assetId), registerOwnedAsset: (...args) => videoService.registerOwnedAsset(...args) });
  const current = await manager.context(id, origin), aid = current.timeline[0].assetId, bid = current.timeline[1].assetId;
  const filmFile = path.join(dataDir, 'openfilm/projects', id, 'film.html'), before = readFilmFile(await readFile(filmFile, 'utf8')).doc;
  const cue = normalizeShotCues({ evidence: frames.map(frame => frame.id), subjects: [{ label: '测试色块', role: 'primary', position: 'center' }], motion: { beforeFrame: frames[0].id, afterFrame: frames[1].id, direction: 'unknown', camera: 'static' } }, { shot: { id: 's1', start: 1, end: 4 }, frames });
  const planned = normalizeModelData('edit-plan', { title: '有依据的实际剪辑', timeline: [
    { assetId: aid, start: 1, end: 4, speed: 2, purpose: 'action', cueIds: ['s1:visual'], framing: { mode: 'cover', focusX: .5, focusY: .5 }, motion: { preset: 'push-in', amount: .1, duration: .6 } },
    { assetId: bid, start: 0, end: 2, purpose: 'hold', framing: { mode: 'cover', focusX: .5, focusY: .5 }, motion: { preset: 'pan-left', amount: .08, duration: .7 } },
  ], captions: [{ text: '结构清晰的中文主标题 Layout', start: 0, end: 3.5, placement: 'title', layout: { role: 'headline', align: 'left', background: 'panel', maxWidth: .7, lookId: 'text/looks/white-black', motionId: 'text/motions/in-rise' } },
    { text: '源时基', source: { clipIndex: 0, start: 1.4, end: 2.6 }, layout: { role: 'subtitle' } }],
  }, { assets: current.assets, timeline: current.timeline, sourceAnalysis: { items: [{ assetId: aid, frames, shots: [{ id: 's1', cues: cue }] }] } });
  const applied = await manager.applyPlan(id, planned, origin, current.revision, { keepUndo: true });
  const changed = readFilmFile(await readFile(filmFile, 'utf8')).doc, picture = changed.tracks.find(track => track.attrs?.id === 'guangxuan-picture').clips;
  assert.deepEqual(picture[0].time, [1, 4]); assert.equal(picture[0].speed, 2); assert.equal(picture[1].at, 1.5);
  const pan = readMotion(picture[1], changed.keyframes); assert.equal(valueAt('scale', pan.scale, 1.8), 1.16);
  assert.deepEqual(valueAt('translate', pan.translate, 1), valueAt('translate', pan.translate, 1.8));
  const subtitle = all(changed).find(clip => clip.attrs?.['data-guangxuan-text'] === '源时基'); assert.equal(subtitle.at, .2); assert.deepEqual(subtitle.time, [0, .6]);
  const stable = await readFile(filmFile, 'utf8'); await assert.rejects(() => manager.applyPlan(id, planned, origin, current.revision), { code: 'OPENFILM_REVISION_CONFLICT' }); assert.equal(await readFile(filmFile, 'utf8'), stable);
  const rendered = await manager.exportVideo(id, { fps: 15, name: 'Editorial native result' }, origin, { expectedRevision: applied.revision });
  let job;
  for (let count = 0; count < 300; count++) { job = (await manager.nativeExports(id)).exports.find(item => item.id === rendered.export.id); if (['done', 'error', 'failed', 'cancelled'].includes(job?.status)) break; await new Promise(resolve => setTimeout(resolve, 200)); }
  assert.equal(job?.status, 'done', JSON.stringify(job));
  const sink = new PassThrough(), chunks = []; sink.writeHead = () => {}; sink.on('data', chunk => chunks.push(chunk)); await manager.download({ method: 'GET' }, sink, id, rendered.export.id);
  const output = path.join(folder, 'editorial-native.mp4'); await writeFile(output, Buffer.concat(chunks));
  const probe = JSON.parse((await command(bin('ffprobe'), ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output], { windowsHide: true })).stdout);
  assert.ok(Math.abs(Number(probe.format.duration) - 3.5) < .09); assert.equal(probe.streams.find(stream => stream.codec_type === 'video').width, 1280);
  const sample = async time => (await command(bin('ffmpeg'), ['-v', 'error', '-nostdin', '-ss', String(time), '-i', output, '-frames:v', '1', '-vf', 'scale=96:54', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { windowsHide: true, encoding: 'buffer' })).stdout;
  const [early, settled, held] = await Promise.all([sample(1.6), sample(2.6), sample(3.2)]);
  const difference = (a, b) => [...a].reduce((sum, value, index) => sum + Math.abs(value - b[index]), 0) / a.length / 255;
  const movement = difference(early, settled), hold = difference(settled, held); assert.ok(movement > .005, String(movement)); assert.ok(hold < .005, String(hold));
  const evidence = process.env.GUANGXUAN_TYPOGRAPHY_EVIDENCE;
  if (evidence) {
    await mkdir(evidence, { recursive: true }); await copyFile(output, path.join(evidence, 'editorial-native.mp4'));
    await command(bin('ffmpeg'), ['-v', 'error', '-nostdin', '-ss', '2.6', '-i', output, '-frames:v', '1', path.join(evidence, 'editorial-native-settled.png')], { windowsHide: true });
    await writeFile(path.join(evidence, 'native-editorial-verification.json'), JSON.stringify({ status: 'passed', actualNativeExport: true, actualFrameCues: frames, mappedSubtitle: { at: subtitle.at, time: subtitle.time }, duration: probe.format.duration, movementDifference: movement, restingDifference: hold, casRejected: true, externalModelsUsed: false, userProjectsUsed: false }, null, 2));
  }
  const cancel = await manager.applyPlan(id, { timeline: [{ assetId: aid, clipId: picture[0].id, start: 1, end: 4 }, { assetId: bid, clipId: picture[1].id, start: 0, end: 2, motion: { preset: 'none' } }] }, origin, applied.revision, { keepUndo: true });
  const stopped = readFilmFile(await readFile(filmFile, 'utf8')).doc, stoppedPicture = stopped.tracks.find(track => track.attrs?.id === 'guangxuan-picture').clips;
  assert.deepEqual(readMotion(stoppedPicture[1], stopped.keyframes), {}); assert.deepEqual(readMotion(stoppedPicture[0], stopped.keyframes), readMotion(picture[0], changed.keyframes));
  assert.equal(stopped.keyframes[picture[1].id + '--translate'], undefined); assert.equal(stopped.keyframes[picture[1].id + '--scale'], undefined);
  const cancelledRender = await manager.exportVideo(id, { fps: 15, range: [1.5, 3.5], name: 'Camera movement cancelled' }, origin, { expectedRevision: cancel.revision });
  for (let count = 0; count < 300; count++) { job = (await manager.nativeExports(id)).exports.find(item => item.id === cancelledRender.export.id); if (['done', 'error', 'failed', 'cancelled'].includes(job?.status)) break; await new Promise(resolve => setTimeout(resolve, 200)); }
  assert.equal(job?.status, 'done', JSON.stringify(job));
  const cancelledSink = new PassThrough(), cancelledChunks = []; cancelledSink.writeHead = () => {}; cancelledSink.on('data', chunk => cancelledChunks.push(chunk)); await manager.download({ method: 'GET' }, cancelledSink, id, cancelledRender.export.id);
  const cancelledOutput = path.join(folder, 'editorial-camera-cancelled.mp4'); await writeFile(cancelledOutput, Buffer.concat(cancelledChunks));
  const stoppedSample = async time => (await command(bin('ffmpeg'), ['-v', 'error', '-nostdin', '-ss', String(time), '-i', cancelledOutput, '-frames:v', '1', '-vf', 'scale=96:54', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { windowsHide: true, encoding: 'buffer' })).stdout;
  const cancelledDifference = difference(await stoppedSample(.1), await stoppedSample(1.7)); assert.ok(cancelledDifference < .005, String(cancelledDifference));
  if (evidence) { await copyFile(cancelledOutput, path.join(evidence, 'editorial-camera-cancelled.mp4')); await writeFile(path.join(evidence, 'camera-cancellation-verification.json'), JSON.stringify({ status: 'passed', actualNativeSecondExport: true, cameraMotionAbsent: true, unrelatedClipMotionPreserved: true, frameDifference: cancelledDifference, sourceAndSpeedPreserved: true, externalModelsUsed: false }, null, 2)); }
  await manager.undoAssistant(id, cancel.undo.id, origin); assert.deepEqual(readFilmFile(await readFile(filmFile, 'utf8')).doc, changed);
  await manager.undoAssistant(id, applied.undo.id, origin); assert.deepEqual(readFilmFile(await readFile(filmFile, 'utf8')).doc, before);
});
