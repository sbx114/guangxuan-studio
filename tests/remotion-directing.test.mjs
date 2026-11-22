import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { normalizeRemotionInput, buildRemotionPrompt } from '../lib/remotion-authoring.mjs';
import { buildRemotionReferenceContext } from '../lib/remotion-reference-library.mjs';
import { createRemotionIntegration } from '../lib/remotion-integration.mjs';
import { createRemotionProjectsService } from '../lib/remotion-projects.mjs';
import { createRemotionQualityService } from '../lib/remotion-quality.mjs';
import { makeSpeedTrack, speedProgressAt, makePathTrack, pathPointAt, trajectoryStateAt, worldToScreen, cameraAt, shotTimingFrames, DIRECTING_MOTION_SOURCE } from '../lib/remotion-directing-motion.mjs';

const asset = { assetId: 'material-video', type: 'video', name: '独立已观察运动素材', publicPath: 'media/material-video.mp4', duration: 3, width: 320, height: 180 };
const observation = (frames = [{ id: 'f000.jpg', shotId: 'moving', timestamp: .5, sha256: 'a'.repeat(64), phase: 'before' }, { id: 'f001.jpg', shotId: 'moving', timestamp: 1.5, sha256: 'b'.repeat(64), phase: 'after' }]) => ({ version: 1, items: [{ assetId: asset.assetId, range: { start: 0, end: 3 }, name: asset.name, summary: { kind: 'visual-sampled', text: '受控夹具的白色标记向右移动。' }, coverage: { sampledFrameCount: frames.length }, frames,
  shots: [{ id: 'moving', start: 0, end: 3, evidence: frames.map(frame => frame.id), description: '受控片段标记前后位置有变化。', cues: { kind: 'visual-sampled', evidence: frames.map(frame => frame.id), subjects: [{ label: '白色标记', role: 'primary', position: 'left' }], composition: { shotSize: 'medium', negativeSpace: 'top', focus: '移动标记与落点的关系' }, motion: { beforeFrame: 'f000.jpg', afterFrame: 'f001.jpg', direction: 'right', camera: 'static', description: '同一标记从较左位置到较右位置。' }, usableSegments: [{ purpose: 'action', start: .4, end: 1.7, evidence: frames.map(frame => frame.id), rationale: '只以这两个帧的变化作为候选动作线索。', confidence: 'medium' }] } }], transcript: { status: 'unavailable', timing: 'none', segments: [] } }] });

test('typed material cues drive the current director brief with provenance, not material-name guesses', async () => {
  const sourceAnalysis = observation(); sourceAnalysis.items.push({ ...observation().items[0], assetId: 'foreign', summary: { kind: 'visual-sampled', text: 'PRIVATE FOREIGN CUE' } });
  const input = normalizeRemotionInput({ instruction: '改善画面安排与剪辑动效', assets: [asset], sourceAnalysis });
  assert.equal(input.directingContext.materialCues.length, 1);
  const cue = input.directingContext.materialCues[0];
  assert.equal(cue.id, 'material-video:moving:visual'); assert.equal(cue.motion.direction, 'right'); assert.equal(cue.motion.continuous, false);
  assert.deepEqual(cue.evidence, ['f000.jpg', 'f001.jpg']); assert.equal(cue.usableSegments[0].status, 'sample-based-candidate');
  assert.ok(!JSON.stringify(input).includes('PRIVATE FOREIGN'));
  const context = await buildRemotionReferenceContext(input);
  assert.equal(context.library.contextUsed.materialCues, true);
  for (const key of ['motion-signals', 'whip-brake', 'page-camera', 'manifest-tracks']) assert.ok(context.references.some(reference => reference.key === key), key);
  assert.ok(context.references.filter(reference => reference.selectionReasons.some(reason => /素材/.test(reason))).length >= 3);
  const prompt = buildRemotionPrompt({ ...input, references: context.references, referenceLibrary: context.library });
  assert.ok(prompt.payload.directingContext.mechanisms.some(mechanism => mechanism.key === 'whip-brake' && mechanism.sourceSupplied));
  assert.equal(prompt.payload.directingContext.materialCues[0].id, cue.id);
  assert.ok(prompt.payload.directingContext.reusableMotion.code.includes('function makeSpeedTrack'));
});

test('single-frame and technical cues cannot invent motion or continuous source quality', () => {
  const single = observation(observation().items[0].frames.slice(0, 1));
  const one = normalizeRemotionInput({ instruction: '安排主体', assets: [asset], sourceAnalysis: single });
  assert.equal(one.directingContext.materialCues[0].motion.status, 'single-frame'); assert.equal(one.directingContext.materialCues[0].motion.direction, 'unknown');
  assert.equal(one.directingContext.materialCues[0].usableSegments.length, 0, 'one frame does not establish an action candidate');
  single.items[0].summary.kind = 'technical';
  const technical = normalizeRemotionInput({ instruction: '自由设计', assets: [asset], sourceAnalysis: single });
  assert.deepEqual(technical.directingContext.materialCues, []);
  assert.equal(technical.directingContext.mode, 'design-from-material');
});

test('material source and next analysis page survive repeated authoring normalization', () => {
  const sourceAnalysis = observation();
  sourceAnalysis.items[0].pagination = { shotOffset: 6, shotLimit: 6, totalShots: 24, returnedShots: 6, hasMore: true, nextShotOffset: 12, privatePath: 'C:/do-not-send' };
  sourceAnalysis.items[0].omitted = { shots: 18, transcriptSegments: 4 };
  const first = normalizeRemotionInput({ instruction: '根据本页材料安排镜头', assets: [asset], sourceAnalysis }), repeated = normalizeRemotionInput(first);
  assert.equal(repeated.sourceAnalysis.items[0].pagination.nextShotOffset, 12);
  assert.equal(repeated.sourceAnalysis.items[0].omitted.shots, 18);
  assert.equal(repeated.directingContext.materialCues[0].assetId, asset.assetId);
  assert.equal(repeated.directingContext.materialCues[0].analysisPage.nextShotOffset, 12);
  assert.ok(!JSON.stringify(repeated).includes('do-not-send'));
});

test('large cue ledgers remain bounded and typography uses the shared layout schema without placeholder text', () => {
  const assets = Array.from({ length: 8 }, (_, i) => ({ ...asset, assetId: `material-${i}` }));
  const sourceAnalysis = { version: 1, items: assets.map(entry => {
    const item = observation().items[0]; item.assetId = entry.assetId;
    item.summary.text = '已有素材观察'.repeat(500); item.coverage.sampledFrameCount = 64;
    item.shots = []; item.frames = [];
    for (let i = 0; i < 32; i++) {
      const shot = structuredClone(observation().items[0].shots[0]); shot.id = `shot-${i}`;
      const ids = [`f${String(i * 2).padStart(3, '0')}.jpg`, `f${String(i * 2 + 1).padStart(3, '0')}.jpg`];
      shot.evidence = ids; shot.cues.evidence = ids; shot.cues.motion.beforeFrame = ids[0]; shot.cues.motion.afterFrame = ids[1];
      shot.cues.uncertainties = Array.from({ length: 8 }, () => '仅已列画面的有限观察。'.repeat(80));
      shot.cues.usableSegments[0].evidence = ids;
      item.shots.push(shot); item.frames.push(...ids.map((id, j) => ({ id, shotId: shot.id, timestamp: j ? 1.5 : .5, sha256: 'a'.repeat(64), phase: j ? 'after' : 'before' })));
    }
    return item;
  }) };
  const input = normalizeRemotionInput({ instruction: '按已有分析安排镜头', assets, sourceAnalysis });
  assert.ok(JSON.stringify(input.sourceAnalysis).length <= 34000);
  assert.ok(JSON.stringify(input.directingContext.materialCues).length <= 24000);
  assert.ok(input.directingContext.materialCues.length <= 24);
  assert.ok(input.productionBrief.typographyLayout.schema);
  assert.ok(input.productionBrief.typographyLayout.roleDefaults.every(role => !Object.hasOwn(role, 'lines')));
  assert.ok(!JSON.stringify(input.productionBrief.typographyLayout).includes('文字层级 Text'));
});

test('velocity-integrated curved motion keeps a bright advancing head, historical tail and stable arrival', () => {
  const track = makeSpeedTrack({ durationFrames: 60 }), path = makePathTrack([{ x: 20, y: 90 }, { x: 170, y: -40 }, { x: 280, y: 90 }]);
  const progress = Array.from({ length: 90 }, (_, frame) => speedProgressAt(track, frame));
  assert.equal(progress[0], 0); assert.equal(progress[60], 1); assert.ok(progress.every((value, i) => !i || value >= progress[i - 1]));
  const active = trajectoryStateAt(path, track, 18), held = trajectoryStateAt(path, track, 75);
  assert.ok(active.velocity.x > 0); assert.ok(active.trail.every(point => point.x <= active.head.x));
  assert.ok(active.trail[0].alpha < active.trail.at(-1).alpha);
  assert.deepEqual(held.head, { x: 280, y: 90 }); assert.equal(held.speed, 0); assert.equal(held.trailWeight, 0);
  assert.deepEqual(trajectoryStateAt(path, track, 18), active, 'reverse/random seek recalculates without frame history');
  const distances = Array.from({ length: 10 }, (_, i) => { const a = pathPointAt(path, i / 10), b = pathPointAt(path, (i + 1) / 10); return Math.hypot(b.x - a.x, b.y - a.y); });
  assert.ok(Math.max(...distances) / Math.min(...distances) < 1.1, 'curve travel is arc-length calibrated rather than raw Bezier parameter speed');
});

test('a shared source-space camera keeps target and annotation aligned and separates depth response', () => {
  const canvas = { width: 320, height: 180 }, keys = [{ frame: 0, cx: 160, cy: 90, zoom: 1 }, { frame: 60, cx: 220, cy: 90, zoom: 1 }];
  const a = cameraAt(0, keys), b = cameraAt(60, keys), point = { x: 240, y: 80 };
  const hero = worldToScreen(point, b, canvas), annotationAnchor = worldToScreen(point, b, canvas);
  assert.deepEqual(hero, annotationAnchor);
  const movement = depth => worldToScreen(point, b, { ...canvas, depth }).x - worldToScreen(point, a, { ...canvas, depth }).x;
  assert.ok(Math.abs(movement(.2)) < Math.abs(movement(1))); assert.ok(Math.abs(movement(1.3)) > Math.abs(movement(1)));
  assert.deepEqual(cameraAt(90, keys), b); assert.deepEqual(cameraAt(20, keys), cameraAt(20, keys));
});

test('one shot-plan timebase produces actual integer action, hold and transition frames', () => {
  const timing = shotTimingFrames({ start: 2, end: 8, actionEnd: 4, hold: { start: 4, duration: 1.5 }, transition: { duration: .5 } }, 30);
  assert.deepEqual(timing, { start: 60, end: 240, actionEnd: 120, holdStart: 120, holdEnd: 165, transitionStart: 225 });
  assert.ok(DIRECTING_MOTION_SOURCE.includes('WhipBrake')); assert.ok(!DIRECTING_MOTION_SOURCE.includes('Math.random'));
});

test('directing source generation and actual layouts render through an isolated local protocol with zero external models', { timeout: 240000, skip: process.env.GUANGXUAN_TEST_REMOTION_DIRECTING !== '1' }, async t => {
  const execute = promisify(execFile), hash = value => createHash('sha256').update(value).digest('hex');
  const parent = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'gx-directing-')), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const bin = process.env.GUANGXUAN_BIN_DIR, ffmpeg = path.join(bin, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'), ffprobe = path.join(bin, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  const projects = await createRemotionProjectsService({ dataDir: directory, root, resolveAsset: async () => ({ path: materialVideo, type: 'video' }) });
  let provider, materialVideo;
  t.after(async () => { await projects.close(); if (provider) await new Promise(resolve => { provider.close(resolve); provider.closeAllConnections(); }); if (process.env.GUANGXUAN_KEEP_REMOTION_DIRECTING !== '1') { assert.equal(path.dirname(directory), parent); await rm(directory, { recursive: true, force: true }); } });
  const wait = async (owner, id) => { for (;;) { const job = await projects.getJob(owner, id); if (job.status === 'complete') return job; if (['error', 'cancelled'].includes(job.status)) throw new Error(JSON.stringify(job.error)); await new Promise(resolve => setTimeout(resolve, 100)); } };
  const material = await projects.create('material-fixture', { title: '独立素材夹具', compositionId: 'Material', entryPoint: 'src/index.tsx', files: [{ path: 'src/index.tsx', content: "import React from'react';import{AbsoluteFill,Composition,registerRoot,useCurrentFrame}from'remotion';const Film=()=>{const f=useCurrentFrame();return <AbsoluteFill style={{background:'#102c3a'}}><svg width={320} height={180}><circle cx={40+f*2} cy={90} r={9} fill='white'/></svg></AbsoluteFill>};registerRoot(()=> <Composition id='Material' component={Film} width={320} height={180} fps={30} durationInFrames={90}/>);" }] });
  const materialJob = await projects.render('material-fixture', material.id, { expectedRevision: 1, kind: 'video' });
  const renderedMaterial = await wait('material-fixture', materialJob.jobId); materialVideo = renderedMaterial.result.outputPath;
  const actualFrames = [];
  for (const [i, time] of [[0, .5], [1, 1.5]]) {
    const file = path.join(directory, `f00${i}.jpg`);
    await execute(ffmpeg, ['-v', 'error', '-nostdin', '-ss', String(time), '-i', materialVideo, '-frames:v', '1', '-q:v', '3', '-y', file], { windowsHide: true });
    actualFrames.push({ id: `f00${i}.jpg`, shotId: 'moving', timestamp: time, sha256: hash(await readFile(file)), phase: i ? 'after' : 'before' });
  }
  const plan = { concept: '受控夹具：有方向的轨迹到落点、共享相机取景、稳定收尾', shots: [
    { id: 'arrival', start: 0, end: 3, actionEnd: 2, hold: { start: 2, duration: 1 }, transition: { duration: 0 }, implementation: { file: 'src/index.tsx', component: 'Film', mechanism: 'curved velocity-integrated arrival' } },
    { id: 'focus', start: 3, end: 5, actionEnd: 5, hold: { start: 5, duration: 0 }, transition: { duration: 0 }, implementation: { file: 'src/index.tsx', component: 'Film', mechanism: 'shared world camera with depth response' } },
    { id: 'rest', start: 5, end: 8, actionEnd: 5.3, hold: { start: 5.3, duration: 2.2 }, transition: { duration: .5 }, implementation: { file: 'src/index.tsx', component: 'Film', mechanism: 'held coordinates and terminal fade' } },
  ] };
  const code = "import React from'react';import{AbsoluteFill,Composition,registerRoot,useCurrentFrame}from'remotion';import plan from'../shot-plan.json';import{makeSpeedTrack,makePathTrack,trajectoryStateAt,worldToScreen,cameraAt,shotTimingFrames,smooth01}from'./production-motion.js';const times=plan.shots.map(s=>shotTimingFrames(s,30)),geometry=plan.shots[0].implementation.parameters,cameraPlan=plan.shots[1].implementation.parameters.camera;const track=makeSpeedTrack({durationFrames:times[0].actionEnd-geometry.delayFrames});const path=makePathTrack(geometry.pathPoints);const keys=[{frame:times[1].start,...cameraPlan.from},{frame:times[1].actionEnd,...cameraPlan.to}];const Film=()=>{const f=useCurrentFrame();const camera=cameraAt(f,keys),canvas={width:320,height:180};const s=trajectoryStateAt(path,track,f,{startFrame:geometry.delayFrames});const target=worldToScreen(geometry.focus,camera,canvas),head=worldToScreen(s.head,camera,canvas);const back=worldToScreen(geometry.layers[0].point,camera,{...canvas,depth:geometry.layers[0].depth}),front=worldToScreen(geometry.layers[2].point,camera,{...canvas,depth:geometry.layers[2].depth});const fade=1-smooth01((f-times[2].transitionStart)/(times[2].end-times[2].transitionStart));return <AbsoluteFill style={{background:'#102c3a'}}><svg width={320} height={180}><g opacity={fade}><circle cx={back.x} cy={back.y} r={17} fill='#23526b'/><circle cx={front.x} cy={front.y} r={7} fill='#37566a'/><rect x={target.x-15} y={target.y-15} width={30} height={30} rx={4} fill='#39cbd0'/><path d={'M'+target.x+' '+target.y+'l-30 -22'} stroke='white' fill='none'/><text x={target.x-54} y={target.y-22} fontSize={12} fill='white'>FOCUS</text>{s.trailWeight>0&&s.trail.map((p,i)=>{const q=worldToScreen(p,camera,canvas);return <circle key={i} cx={q.x} cy={q.y} r={3} fill='#d2a76f' opacity={p.alpha*s.trailWeight*.75}/>})}<circle cx={head.x} cy={head.y} r={6} fill='#ffe5a3'/></g></svg></AbsoluteFill>};registerRoot(()=> <Composition id='ProductionProbe' component={Film} width={320} height={180} fps={30} durationInFrames={240}/>);";
  const requests = [];
  provider = http.createServer(async (req, res) => {
    try {
      const body = JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString()), payload = JSON.parse(body.messages.find(message => message.role === 'user').content);
      assert.equal(payload.directingContext.materialCues.length, 1); assert.equal(payload.directingContext.materialCues[0].motion.direction, 'right');
      assert.equal(payload.referenceLibrary.contextUsed.materialCues, true); assert.ok(payload.references.some(reference => reference.key === 'page-camera'));
      const cue = payload.directingContext.materialCues[0]; plan.shots[0].materialEvidence = [{ cueId: cue.id, assetId: cue.assetId, sourceRange: cue.sourceRange, evidence: cue.evidence }];
      const x = cue.motion.direction === 'right' ? 255 : 65, focus = { x, y: 80 };
      plan.shots[0].implementation.parameters = { focus, delayFrames: 15, pathPoints: [{ x: x > 160 ? 40 : 280, y: 135 }, { x: 145, y: -10 }, focus], layers: [{ role: 'background', point: { x: x + 20, y: 80 }, depth: .2 }, { role: 'subject', point: focus, depth: 1 }, { role: 'foreground', point: { x: x + 35, y: 95 }, depth: 1.3 }] };
      plan.shots[1].implementation.parameters = { camera: { from: { cx: 160, cy: 90, zoom: 1 }, to: { cx: 205, cy: 90, zoom: 1.2 } } };
      requests.push({ directing: payload.directingContext, references: payload.references.map(reference => ({ key: reference.key, source: reference.sourceMetadata, partial: reference.partial })) });
      const result = { title: '受控导演能力夹具', entryPoint: 'src/index.tsx', compositionId: 'ProductionProbe', assetIds: [], inputProps: {}, notes: ['固定本地协议夹具，非外部AI审美评估'], files: [{ path: 'src/index.tsx', content: code }, { path: 'src/production-motion.js', content: payload.directingContext.reusableMotion.code }, { path: 'shot-plan.json', content: JSON.stringify(plan) }] };
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) }, finish_reason: 'stop' }] }));
    } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: String(error.message) })); }
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const owner = { id: 'director-probe', kind: 'video', createdAt: 'isolated-owner', title: '受控导演能力', video: { script: '以已有观察的方向安排曲线路径，到达后改变观察焦点再稳定收尾。' } };
  const integration = createRemotionIntegration({ projects, store: { read: async () => owner }, openFilm: { context: async () => ({ aspect: '16:9', assets: [{ ...asset, id: asset.assetId }] }) }, videoService: { resolveAsset: async () => ({ path: materialVideo }), runtimeTools: () => ({ ffmpeg }) }, sourceAnalysis: { context: async () => ({ sourceAnalysis: observation(actualFrames) }) } });
  const generated = await integration.generate(owner.id, { instruction: '由已观察的素材cue安排主焦点、分层取景与剪辑动效' }, { settings: { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, model: 'local-directing-fixture', apiKey: 'fixture-only-not-user-key' } });
  assert.equal(requests.length, 1); assert.equal(generated.directing.cueCount, 1);
  let reviewed;
  const quality = createRemotionQualityService({ projects, ffmpegPath: ffmpeg, ai: async (_task, payload) => { reviewed = payload; return { data: { verdict: 'unknown', summary: '本地回执，仅测试实际帧与来源，不作AI审美评分。', issues: [] } }; } });
  const preview = await quality.review(owner.id, generated.project.id, { expectedRevision: 1, instruction: '同轨迹方向、共享取景、落定与收尾' });
  assert.equal(preview.status, 'reviewed'); assert.ok(reviewed.pixelEvidence.pairs.find(pair => pair.kind === 'action').meanDifference > 0);
  assert.equal(reviewed.pixelEvidence.pairs.find(pair => pair.kind === 'hold').meanDifference, 0);
  assert.ok(reviewed.pixelEvidence.pairs.find(pair => pair.kind === 'ending').meanDifference > 0);
  const render = await projects.render(owner.id, generated.project.id, { expectedRevision: 1, kind: 'video' }), video = await wait(owner.id, render.jobId);
  const output = path.join(directory, 'production-probe.mp4'); await copyFile(video.result.outputPath, output);
  const probe = JSON.parse((await execute(ffprobe, ['-v', 'error', '-count_frames', '-show_entries', 'format=duration:stream=codec_type,width,height,avg_frame_rate,nb_read_frames', '-of', 'json', output], { windowsHide: true })).stdout);
  assert.equal(Number(probe.format.duration), 8); assert.equal(Number(probe.streams[0].nb_read_frames), 240);
  await execute(ffmpeg, ['-v', 'error', '-nostdin', '-i', output, '-f', 'null', '-'], { windowsHide: true });
  await writeFile(path.join(directory, 'directing-runtime-verification.json'), JSON.stringify({ status: 'passed', externalModelHttp: 0, localProtocolHttp: 1, actualMaterialFrames: actualFrames, materialCueMethod: 'controlled fixture observation of two actual JPEGs; not a live semantic-model assessment', sourceProject: generated.project.id, sourceFiles: generated.project.files.map(file => ({ path: file.path, sha256: hash(file.content) })), directing: generated.directing, requests, actualPreview: preview, actualPixelEvidence: reviewed.pixelEvidence, output, outputSha256: hash(await readFile(output)), probe, fullDecodePassed: true, userProjectModified: false }, null, 2));
});
