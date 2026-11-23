import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { startServer } from '../server.mjs';
import { makePcm, grid } from './fixtures/music-rhythm.mjs';

const bin = process.env.GUANGXUAN_BIN_DIR, command = promisify(execFile), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
function wav(samples, rate) { const bytes = Buffer.alloc(44 + samples.length * 2); bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples.length * 2, 40); for (let i = 0; i < samples.length; i++) bytes.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2); return bytes; }

async function fixture(t) {
  const parent = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(parent, { recursive: true }); const folder = await mkdtemp(path.join(parent, 'gx-assistant-music-http-')), dataDir = path.join(folder, 'data');
  let app, provider; const calls = [], errors = []; let sequence = () => ({ type: 'final', message: '本地协议夹具就绪。', sourceIds: [] });
  t.after(async () => { await app?.close(); if (provider) { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); } if (!process.env.GUANGXUAN_KEEP_ASSISTANT_MUSIC_TESTS) { assert.equal(path.dirname(path.resolve(folder)), parent); assert.ok(path.basename(folder).startsWith('gx-assistant-music-http-')); await rm(folder, { recursive: true, force: true }); } else t.diagnostic('Assistant music HTTP evidence: ' + folder); });
  const report = { status: 'preparing', folder, externalModelCalls: 0, externalNetworkUsed: false, userDataTouched: false, productionPortUsed: false, uploads: [], imports: [] }, save = () => writeFile(path.join(folder, 'fixture-progress.json'), JSON.stringify(report, null, 2));
  const pcm = makePcm({ duration: 6, sampleRate: 48000, beats: grid(120, 6, .13) }), music = path.join(folder, 'provided-music.wav'), red = path.join(folder, 'provided-footage.mp4'), image = path.join(folder, 'provided-picture.png'); await writeFile(music, wav(pcm.samples, pcm.sampleRate));
  await Promise.all([
    command(path.join(bin, 'ffmpeg.exe'), ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=red:s=320x180:r=25:d=6', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', red], { windowsHide: true }),
    command(path.join(bin, 'ffmpeg.exe'), ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=blue:s=320x180', '-frames:v', '1', '-threads', '1', image], { windowsHide: true }),
  ]);
  provider = http.createServer(async (req, res) => { try { assert.equal(req.url, '/v1/chat/completions'); const body = JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString()), content = body.messages[1].content, payload = JSON.parse(Array.isArray(content) ? content.find(part => part.type === 'text').text : content); calls.push(payload); const output = await sequence(payload); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] })); } catch (error) { errors.push(error.stack || error.message); res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'Local protocol fixture rejected an unexpected input' })); } });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve)); app = await startServer({ dataDir, port: 0 }); assert.notEqual(new URL(app.url).port, '4417');
  const request = async (route, body, method = body === undefined ? 'GET' : 'POST') => { const response = await fetch(app.url + route, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }); return { status: response.status, data: await response.json() }; };
  const json = async (...args) => { const result = await request(...args); assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data; };
  const projectId = 'music-http'; await json('/api/projects/' + projectId, { kind: 'video', title: '本地音乐卡点协议隔离', video: { timeline: [], captions: [], aspect: '16:9', resolution: '720' } }, 'PUT');
  let native = await json('/api/openfilm/context?projectId=' + projectId); const assets = {};
  for (const [type, file] of [['music', music], ['video', red], ['image', image]]) {
    const bytes = await readFile(file), response = await fetch(app.url + '/api/video/upload', { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(path.basename(file)) }, body: bytes }); assert.equal(response.status, 200); const uploaded = (await response.json()).assets[0]; report.uploads.push({ type, assetId: uploaded.id, sha256: hash(bytes), bytes: bytes.length }); await save();
    const imported = await json('/api/openfilm/import-asset', { projectId, assetId: uploaded.id, expectedRevision: native.revision, requestId: randomUUID() }); report.imports.push(imported); await save();
    assert.equal(imported.imported, true, 'HTTP import must register a canonical asset, without appending music first.'); assert.notEqual(imported.asset.id, uploaded.id); assets[type] = imported.asset;
    native = await json('/api/openfilm/context?projectId=' + projectId); assert.equal(native.timeline.length, 0); assert.equal(native.duration, 0);
  }
  const settings = { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'synthetic-local-music-protocol', model: 'music-protocol-only', timeoutSeconds: 20 };
  const run = async (instruction, mode = 'auto') => {
    const started = await request('/api/assistant/runs', { projectId, instruction, mode, settings }); assert.equal(started.status, 202);
    const limit = Date.now() + 90000;
    while (Date.now() < limit) { const job = (await json('/api/assistant/runs/' + started.data.runId)).job; if (terminal.has(job.status)) return job; await new Promise(resolve => setTimeout(resolve, 20)); }
    throw Error('Assistant music HTTP fixture timed out');
  };
  const film = path.join(dataDir, 'openfilm/projects', projectId, 'film.html'); report.status = 'ready'; await save();
  return { folder, dataDir, projectId, assets, film, native, calls, errors, report, json, request, run, setSequence(fn) { sequence = fn; } };
}
const step = (tool, arguments_ = {}, summary = tool) => ({ type: 'tool', tool, arguments: arguments_, summary });

test('real assistant HTTP analyzes provided canonical music, applies one native music cut and verifies actual film with timeline_apply completion evidence', { skip: !bin, timeout: 120000 }, async t => {
  const f = await fixture(t), before = await readFile(f.film); let analysis, applied;
  f.setSequence(payload => {
    const count = payload.observations.length;
    if (count === 0) { assert.ok(payload.tools.some(tool => tool.name === 'music_analyze')); assert.ok(payload.tools.some(tool => tool.name === 'music_autocut')); return step('native_read', {}, '读取真实音乐和画面素材'); }
    if (count === 1) { const read = payload.observations[0]; assert.equal(read.status, 'completed'); assert.ok(read.result.data.assets.some(asset => asset.id === f.assets.music.id)); return step('music_analyze', { musicAssetId: f.assets.music.id }, '分析所提供音乐的真实拍点'); }
    if (count === 2) { analysis = payload.observations[1].result.data; assert.equal(analysis.status, 'ready'); assert.ok(Math.abs(analysis.bpm - 120) <= 1); assert.match(analysis.sourceVersion, /^[a-f0-9]{64}$/); assert.ok(analysis.beats.length >= 10); return step('music_autocut', { musicAssetId: f.assets.music.id, assetIds: [f.assets.video.id, f.assets.image.id], range: { start: 0, end: 6 }, cadence: 'beat', musicVolume: .7 }, '实际写入音乐卡点剪辑'); }
    if (count === 3) { const result = payload.observations[2]; assert.equal(result.status, 'completed'); applied = result.result.data; assert.equal(applied.applied, true); assert.ok(applied.nativeUndoId); assert.ok(applied.cutTimes.length >= 8); assert.ok(result.result.effects.some(effect => effect.type === 'native' && effect.changed)); return step('native_read', {}, '复读实际剪辑和音乐结果'); }
    assert.equal(count, 4); const result = payload.observations[3].result.data; assert.equal(result.duration, 6); assert.ok(result.timeline.length >= 8); return { type: 'final', message: '已根据真实音乐拍点完成6秒原生剪辑，并复读时间线确认。', sourceIds: [] };
  });
  const job = await f.run('按提供音乐自动剪辑这份工程的画面素材卡点，整段6秒，保留音乐。禁止联网。');
  assert.equal(job.status, 'completed', JSON.stringify({ job, fixtureErrors: f.errors })); assert.deepEqual(f.errors, []); assert.equal(job.report.outcome, 'complete'); assert.deepEqual(job.report.unfinished, []);
  assert.equal(f.calls.length, 5); assert.deepEqual(job.steps.filter(row => row.type === 'tool').map(row => row.tool), ['native_read', 'music_analyze', 'music_autocut', 'native_read']);
  const entries = job.evidence.entries, execution = entries.find(entry => entry.tool === 'music_autocut' && entry.kind === 'timeline_apply' && entry.role === 'execution' && entry.outcome === 'completed'); assert.ok(execution); assert.ok(job.report.executed.includes(execution.id));
  const current = await f.json('/api/openfilm/context?projectId=' + f.projectId); assert.equal(current.duration, 6); assert.equal(current.timeline.length, applied.cutTimes.length + 1); assert.notEqual(hash(await readFile(f.film)), hash(before));
  const music = current.editorTimeline.clips.find(clip => clip.id === applied.musicClipId); assert.ok(music); assert.equal(music.kind, 'sound'); assert.equal(music.assetId, f.assets.music.id); assert.equal(music.at, 0); assert.equal(music.sourceStart, 0); assert.equal(music.sourceEnd, 6); assert.equal(music.speed, 1); assert.equal(music.volume, .7);
  assert.ok(current.editorTimeline.clips.filter(clip => clip.kind === 'video').every(clip => clip.volume === 0));
  assert.deepEqual(current.timeline.slice(1).map(clip => clip.at), applied.cutTimes);
  const persisted = JSON.parse(await readFile(path.join(f.dataDir, 'music-cuts/operations.json'), 'utf8')).operations.find(record => record.id === applied.requestId); assert.equal(persisted.status, 'completed'); assert.equal(persisted.result.revision, current.revision);
  await writeFile(path.join(f.folder, 'verification.json'), JSON.stringify({ passed: true, externalModelCalls: 0, localModelCalls: f.calls.length, actualToolChain: ['native_read', 'music_analyze', 'music_autocut', 'native_read', 'final'], beforeFilmSha256: hash(before), actualFilmSha256: hash(await readFile(f.film)), canonicalAssets: f.assets, actualAnalysis: analysis, applied, music, actualTimeline: current.timeline, executionEvidence: execution, finalReport: job.report, nativeRevision: current.revision, durableOperationStatus: persisted.status, noMusicAppendedDuringImport: true, modelPurpose: 'controlled HTTP tool protocol, not an external creative model' }, null, 2));
});

test('assistant ask mode analyzes real music but cannot write; HTTP rejects invented beat arrays and unknown BPM fields', { skip: !bin, timeout: 90000 }, async t => {
  const f = await fixture(t), before = await readFile(f.film); f.setSequence(payload => {
    const count = payload.observations.length;
    assert.equal(payload.tools.some(tool => tool.name === 'music_autocut'), false, 'ask mode does not offer a writing tool');
    if (!count) return step('native_read');
    if (count === 1) return step('music_analyze', { musicAssetId: f.assets.music.id });
    if (count === 2) { assert.equal(payload.observations[1].result.data.status, 'ready'); return step('native_read'); }
    return { type: 'final', message: '实际音乐分析完成，只读模式保持时间线不变。', sourceIds: [] };
  });
  const job = await f.run('只分析提供音乐的节奏，不要修改或生成剪辑，禁止联网。', 'ask'); assert.equal(job.status, 'completed'); assert.equal(job.report.outcome, 'answer'); assert.deepEqual(f.errors, []);
  assert.equal(job.steps.some(row => row.type === 'tool' && row.tool === 'music_autocut'), false); assert.equal(job.evidence.entries.some(entry => entry.role === 'execution' && entry.kind === 'timeline_apply'), false);
  const guards = [];
  for (const extra of [{ beats: [{ time: .5, strength: 1 }] }, { bpm: 120 }]) { const result = await f.request('/api/projects/' + f.projectId + '/music-cut', { musicAssetId: f.assets.music.id, assetIds: [f.assets.video.id], ...extra }); assert.equal(result.status, 400); assert.equal(result.data.code, 'MUSIC_CUT_INPUT'); guards.push(result); }
  assert.deepEqual(await readFile(f.film), before); assert.equal((await f.json('/api/openfilm/context?projectId=' + f.projectId)).timeline.length, 0);
  await writeFile(path.join(f.folder, 'readonly-verification.json'), JSON.stringify({ passed: true, localModelCalls: f.calls.length, externalModelCalls: 0, actualMusicAnalysisRead: true, readonlyToolCatalogExcludesAutocut: true, jobOutcome: job.report.outcome, jobEvidence: job.evidence.entries, finalReport: job.report, filmSha256: hash(before), unknownBeatAndBpmGuards: guards, noTimelineWrite: true }, null, 2));
});
