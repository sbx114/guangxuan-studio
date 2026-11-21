import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRemotionProjectsService, remotionSourcePath } from '../lib/remotion-projects.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execute = promisify(execFile);
const source = () => ({ title: '自由Remotion工程', ownerCreatedAt: '2026-11-19T00:00:00.000Z', entryPoint: 'src/index.tsx', compositionId: 'CustomFilm', inputProps: { title: '自由组件 · 实际渲染' }, files: [
  { path: 'src/index.tsx', content: "import React from 'react'; import {Composition,registerRoot} from 'remotion'; import {Main} from './Main'; const Root=()=> <Composition id='CustomFilm' component={Main} width={640} height={360} fps={24} durationInFrames={3000} defaultProps={{title:'Default'}}/>; registerRoot(Root);" },
  { path: 'src/Main.tsx', content: "import React from 'react'; import {AbsoluteFill,Sequence,interpolate,spring,useCurrentFrame,useVideoConfig} from 'remotion'; import './style.css'; import content from './content.json'; import shader from './shape.glsl'; export const Main=({title}:{title:string})=>{const frame=useCurrentFrame(),{fps}=useVideoConfig();return <AbsoluteFill className='canvas'><svg width='640' height='360' style={{position:'absolute'}}><circle cx={140+interpolate(frame,[0,100],[0,200])} cy='180' r={60+spring({frame,fps})*12} fill='#b9f1d0'/></svg><Sequence from={0}><div className='label'>{title}<small>{content.caption} · {shader.length}</small></div></Sequence></AbsoluteFill>};" },
  { path: 'src/style.css', content: '.canvas{background:#102e36;color:#fff;justify-content:center;align-items:center;font-family:Arial,sans-serif}.label{position:relative;font-size:34px;font-weight:700;text-align:center}.label small{display:block;font-size:17px;margin-top:18px}' },
  { path: 'src/content.json', content: JSON.stringify({ caption: 'React · TSX · CSS · SVG · shader module' }) },
  { path: 'src/shape.glsl', content: 'void main(){gl_FragColor=vec4(0.1,0.6,0.5,1.0);}' },
] });
async function fixture(t, options = {}) {
  const parent = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'gx-free-remotion-')), service = await createRemotionProjectsService({ dataDir: directory, root, ...options });
  t.after(async () => { await service.close(); if (process.env.GUANGXUAN_KEEP_REMOTION_TESTS !== '1') { assert.equal(path.dirname(directory), parent); await rm(directory, { recursive: true, force: true }); } });
  return { service, directory };
}
async function complete(service, owner, id, timeout = 120000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const job = await service.getJob(owner, id); if (['complete', 'error', 'cancelled'].includes(job.status)) return job; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('Remotion fixture did not finish.');
}

test('free Remotion sources are owned, versioned, merge edits, and preserve the original source on CAS conflicts', async t => {
  const { service } = await fixture(t), created = await service.create('owner-a', source());
  assert.equal(created.revision, 1); assert.equal(created.files.length, 5); assert.equal(created.ownerCreatedAt, source().ownerCreatedAt);
  await assert.rejects(service.read('owner-b', created.id), { code: 'REMOTION_PROJECT_NOT_FOUND' });
  const changed = await service.update('owner-a', created.id, { expectedRevision: 1, files: [{ path: 'src/content.json', content: '{"caption":"修改后保留其他源码"}' }] });
  assert.equal(changed.revision, 2); assert.equal(changed.files.length, 5); assert.equal(changed.files.find(file => file.path === 'src/Main.tsx').content, source().files[1].content);
  await assert.rejects(service.update('owner-a', created.id, { expectedRevision: 1, files: [{ path: 'src/Main.tsx', content: 'stale overwrite' }] }), { code: 'REMOTION_REVISION_CONFLICT' });
  assert.equal((await service.read('owner-a', created.id)).revision, 2); assert.equal((await service.list('owner-a')).length, 1);
  await assert.rejects(service.render('owner-a', created.id, { expectedRevision: 1 }), { code: 'REMOTION_REVISION_CONFLICT' });
});

test('source storage rejects traversal, runtime configuration, links, duplicate paths and executable input shapes', async t => {
  const { service } = await fixture(t);
  for (const relative of ['../outside.tsx', 'C:/outside.tsx', 'src\\outside.tsx', 'node_modules/evil.js', 'package.json', 'remotion.config.js', 'public/media/owned.svg', 'src/con.tsx', '.env.local']) assert.throws(() => remotionSourcePath(relative));
  for (const files of [[{ path: '../outside.tsx', content: 'x' }], [{ path: 'src/A.tsx', content: 'x' }, { path: 'src/a.tsx', content: 'y' }], [{ path: 'src/index.tsx', content: 'x'.repeat(205000) }]]) await assert.rejects(service.create('owner-a', { ...source(), files }));
  await assert.rejects(service.create('owner-a', { ...source(), inputProps: JSON.parse('{"__proto__":{"polluted":true}}') }));
  assert.deepEqual(await service.list('owner-a'), []);
});

test('trusted revision transactions allow reads and hold concurrent source updates until the host commit finishes', async t => {
  const { service } = await fixture(t), created = await service.create('owner-a', source());
  let release, entered, updated = false, callbackRan = false;
  const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { entered = resolve; });
  const commit = service.withRevision('owner-a', created.id, 1, async record => {
    callbackRan = true; assert.equal(record.revision, 1);
    assert.equal((await service.read('owner-a', created.id)).revision, 1, 'read is not a recursive lock acquisition');
    entered(); await gate; return { committedSourceRevision: record.revision };
  });
  await ready;
  const mutation = service.update('owner-a', created.id, { expectedRevision: 1, files: [{ path: 'src/content.json', content: '{}' }] }).then(value => { updated = true; return value; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(updated, false); release();
  assert.equal((await commit).committedSourceRevision, 1); assert.equal((await mutation).revision, 2); assert.equal(callbackRan, true);
  let staleCallback = false; await assert.rejects(service.withRevision('owner-a', created.id, 1, () => { staleCallback = true; }), { code: 'REMOTION_REVISION_CONFLICT' }); assert.equal(staleCallback, false);
});

test('controlled project assets are copied under staticFile paths without exposing source paths', async t => {
  let owned;
  const { service, directory } = await fixture(t, { resolveAsset: async (projectId, assetId) => { assert.equal(projectId, 'owner-a'); assert.equal(assetId, 'image-owned'); return { path: owned, type: 'image', name: '本人素材.svg' }; } });
  owned = path.join(directory, 'owned.svg'); await writeFile(owned, '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>');
  const created = await service.create('owner-a', { ...source(), assets: [{ assetId: 'image-owned' }] });
  assert.equal(created.assets[0].publicPath, 'media/image-owned.svg'); assert.equal(Object.hasOwn(created.assets[0], 'path'), false);
  const updated = await service.update('owner-a', created.id, { expectedRevision: 1, files: [{ path: 'src/content.json', content: '{}' }] }); assert.deepEqual(updated.assets, created.assets);
});

test('complete source archives restore safely without compiling, preserve static paths, and permit only fresh restore rollback', async t => {
  let owned;
  const first = await fixture(t, { resolveAsset: async () => ({ path: owned, type: 'image', name: '原素材.svg' }) }), second = await fixture(t);
  owned = path.join(first.directory, 'owned.svg'); await writeFile(owned, '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const original = await first.service.create('owner-a', { ...source(), assets: [{ assetId: 'original-asset' }] }), archived = await first.service.exportArchive('owner-a', original.id);
  assert.equal(archived.assets.length, 1); assert.ok(path.isAbsolute(archived.assets[0].filename));
  const restored = await second.service.importArchive('owner-b', archived, { ownerCreatedAt: 'new-owner-time', entriesRoot: archived.assets[0].scope });
  assert.notEqual(restored.id, original.id); assert.equal(restored.ownerCreatedAt, 'new-owner-time'); assert.equal(restored.revision, 1); assert.equal(restored.assets[0].publicPath, original.assets[0].publicPath); assert.deepEqual(restored.files, original.files);
  await assert.rejects(first.service.discardArchive('owner-a', original.id));
  await second.service.discardArchive('owner-b', restored.id); assert.deepEqual(await second.service.list('owner-b'), []);
  const tampered = structuredClone(archived); tampered.assets[0].sha256 = 'f'.repeat(64);
  await assert.rejects(second.service.importArchive('owner-b', tampered, { entriesRoot: archived.assets[0].scope }), /哈希/);
  const outside = structuredClone(archived); outside.assets[0].filename = owned;
  await assert.rejects(second.service.importArchive('owner-b', outside, { entriesRoot: archived.assets[0].scope }));
  assert.equal((await first.service.read('owner-a', original.id)).revision, 1);
});

test('worker environment excludes secrets, progress is observable, queued and running jobs cancel without replay', async t => {
  const parent = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(parent, { recursive: true });
  const helper = path.join(await mkdtemp(path.join(parent, 'gx-remotion-worker-fixture-')), 'worker.mjs');
  await writeFile(helper, "process.on('message',message=>{if(message.type==='cancel'){process.send({type:'error',message:'cancelled'});process.disconnect();return;} if(message.type==='run'){if(message.kind==='inspect'){process.send({type:'result',result:{compositions:[],secretPresent:!!process.env.GX_REMOTION_TEST_SECRET}});process.disconnect();}else process.send({type:'progress',progress:.4});}});");
  t.after(() => rm(path.dirname(helper), { recursive: true, force: true }));
  const previous = process.env.GX_REMOTION_TEST_SECRET; process.env.GX_REMOTION_TEST_SECRET = 'fixture-secret-not-a-real-key'; t.after(() => { if (previous === undefined) delete process.env.GX_REMOTION_TEST_SECRET; else process.env.GX_REMOTION_TEST_SECRET = previous; });
  const observations = [], { service } = await fixture(t, { workerPath: helper, onJob: job => { observations.push(job); } }), project = await service.create('owner-a', source());
  const inspected = await service.inspect('owner-a', project.id, { expectedRevision: 1 }); assert.equal(inspected.secretPresent, false);
  const first = await service.render('owner-a', project.id, { expectedRevision: 1 }), queued = await service.render('owner-a', project.id, { expectedRevision: 1 });
  await service.cancelJob('owner-a', queued.jobId);
  for (let attempt = 0; attempt < 100; attempt++) { if ((await service.getJob('owner-a', first.jobId)).progress >= .4) break; await new Promise(resolve => setTimeout(resolve, 10)); }
  await service.cancelJob('owner-a', first.jobId); assert.equal((await complete(service, 'owner-a', first.jobId)).status, 'cancelled'); assert.equal((await complete(service, 'owner-a', queued.jobId)).status, 'cancelled');
  assert.ok(observations.some(job => job.progress === .4)); assert.ok(observations.every(job => !Object.hasOwn(job.result || {}, 'outputPath')));
});

test('service shutdown joins actual worker exit and cleanup after success, failure and cancellation IPC', async t => {
  for (const mode of ['success', 'failure', 'cancellation']) {
    const parent = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(path.join(parent, 'gx-remotion-drain-')), helper = path.join(directory, 'worker.mjs'), marker = path.join(directory, 'cleanup-finished.json');
    await writeFile(helper, `import {writeFile} from 'node:fs/promises';import {setTimeout as delay} from 'node:timers/promises';const mode=${JSON.stringify(mode)},marker=${JSON.stringify(marker)};let cleaning=false;async function finish(){if(cleaning)return;cleaning=true;await delay(220);await writeFile(marker,JSON.stringify({pid:process.pid,cleaned:true}));if(process.connected)process.disconnect();setTimeout(()=>process.exit(0),100)}process.on('message',async message=>{if(message.type==='run'){await writeFile(marker+'.started',JSON.stringify({pid:process.pid,sourceRoot:message.sourceRoot}));if(mode==='cancellation'){process.send({type:'progress',progress:.4});return}process.send(mode==='success'?{type:'result',result:{compositions:[]}}:{type:'error',message:'fixture failure after acknowledgement'});void finish()}else if(message.type==='cancel'){process.send({type:'error',message:'fixture cancellation acknowledged'});void finish()}});`);
    const service = await createRemotionProjectsService({ dataDir: directory, root, workerPath: helper });
    t.after(async () => { await service.close(); assert.equal(path.dirname(directory), parent); await rm(directory, { recursive: true, force: true }); });
    const record = await service.create('owner-a', source());
    if (mode === 'success') await service.inspect('owner-a', record.id, { expectedRevision: 1 });
    else if (mode === 'failure') await assert.rejects(service.inspect('owner-a', record.id, { expectedRevision: 1 }), /fixture failure/);
    else {
      const { jobId } = await service.render('owner-a', record.id, { expectedRevision: 1 });
      for (let attempt = 0; attempt < 200; attempt++) { if ((await service.getJob('owner-a', jobId)).progress >= .4) break; await new Promise(resolve => setTimeout(resolve, 5)); }
      await service.cancelJob('owner-a', jobId);
    }
    await service.close();
    const started = JSON.parse(await readFile(marker + '.started', 'utf8'));
    assert.throws(() => process.kill(started.pid, 0), error => error.code === 'ESRCH', `${mode}: close must wait until the worker PID has actually exited`);
    assert.equal(JSON.parse(await readFile(marker, 'utf8')).cleaned, true, `${mode}: cleanup must finish before close resolves`);
    const moved = started.sourceRoot + '-released'; await rename(started.sourceRoot, moved); await rename(moved, started.sourceRoot);
  }
});

test('a worker that acknowledges completion but refuses to exit is forcibly drained and reported as failed', async t => {
  const parent = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'gx-remotion-stuck-drain-')), helper = path.join(directory, 'worker.mjs'), marker = path.join(directory, 'started.json');
  await writeFile(helper, `import {writeFile}from'node:fs/promises';process.on('message',async message=>{if(message.type==='run'){await writeFile(${JSON.stringify(marker)},JSON.stringify({pid:process.pid}));process.send({type:'result',result:{compositions:[]}});setInterval(()=>{},1000)}});`);
  const service = await createRemotionProjectsService({ dataDir: directory, root, workerPath: helper, workerExitTimeoutMs: 200 });
  t.after(async () => { await service.close(); assert.equal(path.dirname(directory), parent); await rm(directory, { recursive: true, force: true }); });
  const record = await service.create('owner-a', source());
  await assert.rejects(service.inspect('owner-a', record.id, { expectedRevision: 1 }), { code: 'REMOTION_WORKER_DRAIN_TIMEOUT' });
  await service.close(); const { pid } = JSON.parse(await readFile(marker, 'utf8')); assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
});

test('close waits for accepted render admission and prevents a delayed enqueue from starting a late worker', async t => {
  const parent = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'gx-remotion-admission-')), helper = path.join(directory, 'worker.mjs'), marker = path.join(directory, 'unexpected-worker.json');
  await writeFile(helper, `import {writeFile}from'node:fs/promises';process.on('message',async()=>{await writeFile(${JSON.stringify(marker)},'started');process.disconnect()});`);
  let release, entered, blocked = false, didClose = false;
  const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { entered = resolve; });
  const service = await createRemotionProjectsService({ dataDir: directory, root, workerPath: helper, onJob: job => { if (!blocked && job.status === 'queued') { blocked = true; entered(); return gate; } } });
  t.after(async () => { release(); await service.close(); assert.equal(path.dirname(directory), parent); await rm(directory, { recursive: true, force: true }); });
  const record = await service.create('owner-a', source()), starting = service.render('owner-a', record.id, { expectedRevision: 1 });
  await ready; const closing = service.close().then(() => { didClose = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(didClose, false, 'accepted admission must settle before close returns');
  release(); await starting; await closing;
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('real free Remotion inspection, PNG and MP4 accept custom multi-file code and a duration over ninety seconds', { timeout: 240000, skip: process.env.GUANGXUAN_TEST_REMOTION !== '1' }, async t => {
  let ownedVideo, ownedAudio;
  const { service, directory } = await fixture(t, { resolveAsset: async (_projectId, assetId) => assetId === 'local-audio' ? { path: ownedAudio, type: 'audio', name: '本机测试正弦音.wav' } : { path: ownedVideo, type: 'video', name: '本机受控视频.mp4' } });
  const binary = name => process.env[`GUANGXUAN_${name.toUpperCase()}`] || (process.env.GUANGXUAN_BIN_DIR ? path.join(process.env.GUANGXUAN_BIN_DIR, name + (process.platform === 'win32' ? '.exe' : '')) : name);
  ownedAudio = path.join(directory, 'owned-sine.wav');
  await execute(binary('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=1', '-c:a', 'pcm_s16le', ownedAudio], { windowsHide: true });
  const authored = source(); authored.assets = [{ assetId: 'local-audio' }];
  authored.files[1].content = authored.files[1].content.replace('useVideoConfig}', 'useVideoConfig,Audio,staticFile}').replace("<AbsoluteFill className='canvas'>", "<AbsoluteFill className='canvas'><Audio src={staticFile('media/local-audio.wav')}/>");
  const created = await service.create('owner-a', authored);
  const inspected = await service.inspect('owner-a', created.id, { expectedRevision: 1 });
  assert.equal(inspected.compositions[0].id, 'CustomFilm'); assert.equal(inspected.compositions[0].duration, 125); assert.equal(inspected.compositions[0].fps, 24);
  const { jobId } = await service.render('owner-a', created.id, { expectedRevision: 1, kind: 'preview', frames: [0, 60] }), preview = await complete(service, 'owner-a', jobId);
  assert.equal(preview.status, 'complete', JSON.stringify(preview.error)); assert.equal(preview.result.frames.length, 2);
  const pictures = await Promise.all(preview.result.frames.map(async frame => readFile((await service.file('owner-a', jobId, frame.file)).path)));
  assert.equal(pictures[0].readUInt32BE(16), 640); assert.equal(pictures[0].readUInt32BE(20), 360); assert.notDeepEqual(pictures[0], pictures[1]);
  const video = await service.render('owner-a', created.id, { expectedRevision: 1, kind: 'video', range: [0, 24] }), rendered = await complete(service, 'owner-a', video.jobId);
  assert.equal(rendered.status, 'complete', JSON.stringify(rendered.error)); assert.equal(rendered.result.duration, 1); assert.equal((await service.file('owner-a', video.jobId, 'video.mp4')).mimeType, 'video/mp4');
  ownedVideo = (await service.file('owner-a', video.jobId, 'video.mp4')).path;
  const probe = JSON.parse((await execute(binary('ffprobe'), ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', ownedVideo], { windowsHide: true })).stdout);
  assert.ok(probe.streams.some(stream => stream.codec_type === 'audio'), 'The same real MP4 includes the local Remotion Audio sine track');
  const media = await service.create('owner-a', { title: '当前工程视频组件', entryPoint: 'src/index.tsx', compositionId: 'LocalMedia', assets: [{ assetId: 'local-video' }], files: [{ path: 'src/index.tsx', content: "import React from 'react'; import {Composition,OffthreadVideo,staticFile,registerRoot} from 'remotion'; const Clip=()=> <OffthreadVideo src={staticFile('media/local-video.mp4')}/>; registerRoot(()=> <Composition id='LocalMedia' component={Clip} width={640} height={360} fps={24} durationInFrames={24}/>);" }] });
  const mediaJob = await service.render('owner-a', media.id, { expectedRevision: 1, kind: 'preview', frames: [12] }), mediaResult = await complete(service, 'owner-a', mediaJob.jobId);
  assert.equal(mediaResult.status, 'complete', JSON.stringify(mediaResult.error)); assert.ok((await readFile((await service.file('owner-a', mediaJob.jobId, 'frame-00.png')).path)).length > 1000);
  await assert.rejects(service.getJob('owner-b', video.jobId), { code: 'REMOTION_JOB_NOT_FOUND' });
  await writeFile(path.join(directory, 'real-verification.json'), JSON.stringify({ status: 'passed', compositions: inspected.compositions, pngs: preview.result.frames, video: rendered.result, controlledOffthreadVideoPassed: true, controlledLocalAudioPassed: true, audioStreamCount: probe.streams.filter(stream => stream.codec_type === 'audio').length }, null, 2));
});

test('free source compilation refuses Node builtins, inline loaders and files outside the current project', { timeout: 180000, skip: process.env.GUANGXUAN_TEST_REMOTION !== '1' }, async t => {
  const { service } = await fixture(t);
  for (const statement of ["import fs from 'node:fs'; console.log(fs);", "import value from '!!raw-loader!C:/Windows/win.ini'; console.log(value);", "import value from '../../../../outside-secret.js'; console.log(value);"]) {
    const input = source(); input.files[0].content = statement + '\n' + input.files[0].content;
    const created = await service.create('owner-a', input);
    await assert.rejects(service.inspect('owner-a', created.id, { expectedRevision: 1 }), /不能|超出|外部|loader|Node|resolve|Module/i, statement);
  }
});

test('render browser blocks external localhost services instead of giving generated code application access', { timeout: 120000, skip: process.env.GUANGXUAN_TEST_REMOTION !== '1' }, async t => {
  let contacts = 0;
  const outside = http.createServer((_req, res) => { contacts++; res.writeHead(200, { 'Access-Control-Allow-Origin': '*' }); res.end('{}'); });
  await new Promise(resolve => outside.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => outside.close(resolve)));
  const { service } = await fixture(t), input = source(); input.files[1].content = input.files[1].content.replace("import React from 'react';", `import React from 'react'; fetch('http://127.0.0.1:${outside.address().port}/private').catch(()=>{});`);
  const created = await service.create('owner-a', input); await service.inspect('owner-a', created.id, { expectedRevision: 1 }); assert.equal(contacts, 0);
});
