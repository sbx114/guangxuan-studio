import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import { extractAssistantUserUrlCandidates } from '../lib/assistant-user-url-candidates.mjs';
import { createAssistantAgentService } from '../lib/assistant-agent.mjs';
import { createAssistantAppTools } from '../lib/assistant-app-tools.mjs';
import { createAssistantWebService } from '../lib/assistant-web.mjs';
import { createReferenceUrlImporter } from '../lib/reference-url.mjs';
import { createProjectStore } from '../lib/store.mjs';

const tracking = '00000000000000000000000000000000', supplied = 'https://www.bilibili.com/zh-Hant/video/BV16MJY6yEKq/?vd_source=' + tracking;
const canonical = value => new URL(value).href;
const settings = { baseUrl: 'http://127.0.0.1:1/v1', model: 'construction-only-fixture', apiKey: 'fixture-only-not-user-key' };
async function finish(service, runId) { for (let n = 0; n < 400; n++) { const job = await service.get(runId); if (['completed', 'failed', 'cancelled'].includes(job.status)) return job; await pause(5); } throw new Error('Candidate fixture did not finish.'); }

test('a typed Bilibili reference before an adjacent comma command gains its clean candidate without losing the exact one', () => {
  const raw = supplied + ',制作mv', candidates = extractAssistantUserUrlCandidates('模仿' + raw);
  assert.ok(candidates.includes(canonical(raw))); assert.ok(candidates.includes(supplied)); assert.equal(candidates.length, 2);
  for (const prefix of ['', 'zh-Hans/', 'zh-Hant/', 'pt/']) assert.ok(extractAssistantUserUrlCandidates('参考https://www.bilibili.com/' + prefix + 'video/BV16MJY6yEKq/?p=2,制作视频').includes('https://www.bilibili.com/' + prefix + 'video/BV16MJY6yEKq/?p=2'));
});

test('a typed Portuguese Bilibili URL before an explicit text-only edit command preserves both exact and clean sources', () => {
  const clean = 'https://www.bilibili.com/pt/video/BV1CMaf69EZu/?vd_source=0019a92b5765c2a04ee70311c2909d89';
  for (const tail of [',仅修改文字,其它完整复刻', ',只替换字幕,其它保留', ',仅改文本']) {
    const raw = clean + tail, candidates = extractAssistantUserUrlCandidates('参考' + raw);
    assert.ok(candidates.includes(canonical(raw))); assert.ok(candidates.includes(clean));
    assert.ok(!candidates.includes('https://www.bilibili.com/video/BV1CMaf69EZu'));
  }
  for (const raw of [clean.replace('vd_source=0019a92b5765c2a04ee70311c2909d89', 'text=仅修改文字') + ',仅修改文字,其它完整复刻', clean.replace('vd_source=0019a92b5765c2a04ee70311c2909d89', 'vd_source=short') + ',仅修改文字', clean.replace('/pt/video/', '/random/video/') + ',仅修改文字', clean + ',仅修改文字参数']) assert.deepEqual(extractAssistantUserUrlCandidates('参考' + raw), [canonical(raw)]);
});

test('comma list and free-text query values stay exact and never authorize a shortened or rewritten query', () => {
  for (const url of ['https://public.example.com/a?ids=1,2', 'https://www.bilibili.com/zh-Hant/video/BV16MJY6yEKq/?text=歌词,制作mv', 'https://public.example.com/a?text=歌词,制作mv']) {
    const candidates = extractAssistantUserUrlCandidates('模仿' + url); assert.deepEqual(candidates, [canonical(url)]);
  }
  const candidates = extractAssistantUserUrlCandidates('模仿' + supplied + ',制作mv');
  assert.ok(!candidates.includes(supplied + '&leak=private')); assert.ok(!candidates.includes('https://www.bilibili.com/video/BV16MJY6yEKq/'));
});

test('ambiguous values, unsupported routes and lookalike hosts do not gain comma-prefix permissions', () => {
  for (const url of [
    'https://www.bilibili.com/video/BV16MJY6yEKq/?vd_source=short',
    'https://www.bilibili.com/video/BV16MJY6yEKq/?text=lyrics',
    'https://www.bilibili.com/bangumi/play/ep123?vd_source=' + tracking,
    'https://www.bilibili.com.evil.example/video/BV16MJY6yEKq/?vd_source=' + tracking,
  ]) assert.ok(!extractAssistantUserUrlCandidates('模仿' + url + ',制作mv').includes(canonical(url)), url);
  assert.ok(!extractAssistantUserUrlCandidates('https://user:pass@www.bilibili.com/video/BV16MJY6yEKq/').length);
});

test('an actual agent reads URLs containing ordinary commas without editing their query values', async t => {
  const parent = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(parent, { recursive: true }); const directory = await mkdtemp(path.join(parent, 'gx-url-commas-'));
  const urls = ['https://public.example.com/a?ids=1,2', 'https://public.example.com/a?text=歌词,制作mv'], calls = []; let step = 0;
  const service = createAssistantAgentService({ dataDir: directory, webTools: { read: async url => { calls.push(url); return { title: 'Controlled fixture', url, text: 'Controlled response only.' }; } }, modelStep: async () => ({ data: step < urls.length ? { type: 'tool', tool: 'web_read', arguments: { url: urls[step++] }, summary: 'Read exact query' } : { type: 'final', message: 'Fixture complete', sourceIds: [] } }) });
  t.after(async () => { await service.close(); assert.equal(path.dirname(directory), parent); await rm(directory, { recursive: true, force: true }); });
  const { runId } = await service.start({ instruction: '读取' + urls.join(' 和 '), settings }); assert.equal((await finish(service, runId)).status, 'completed'); assert.deepEqual(calls, urls);
});

for (const candidateCase of [
  { url: supplied, tail: ',制作mv', id: 'BV16MJY6yEKq' },
  { url: 'https://www.bilibili.com/pt/video/BV1CMaf69EZu/?vd_source=0019a92b5765c2a04ee70311c2909d89', tail: ',仅修改文字,其它完整复刻', id: 'BV1CMaf69EZu' },
]) test('actual agent and application import cross the candidate gate and reach locale-aware Bilibili metadata: ' + candidateCase.id, async t => {
  const supplied = candidateCase.url, instruction = '模仿' + supplied + candidateCase.tail;
  const parent = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(parent, { recursive: true }); const directory = await mkdtemp(path.join(parent, 'gx-url-import-chain-'));
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(512, 7)]), requests = [], metadata = [], registered = [], assets = [];
  const server = http.createServer((req, res) => {
    if (/^\/(?:zh-Hant|pt)\/video\//.test(req.url)) { res.writeHead(200, { 'content-type': 'text/html;charset=utf-8' }); res.end('<!doctype html><title>Controlled Bilibili page</title><main><p>This page is an isolated fixture for URL candidate and locale metadata validation. It is not content fetched from the real Bilibili video.</p></main>'); }
    else if (req.url === '/fixture.mp4') { res.writeHead(200, { 'content-type': 'video/mp4' }); res.end(mp4); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = 'http://127.0.0.1:' + server.address().port; assert.notEqual(new URL(origin).port, '4417');
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const request = async (target, options) => {
    assert.equal(target.address, '93.184.216.34'); requests.push(target.url.href);
    return new Promise((resolve, reject) => { const req = http.request({ host: '127.0.0.1', port: server.address().port, path: target.url.pathname + target.url.search, agent: false, signal: options.signal }, resolve); req.once('error', reject); req.end(); });
  };
  const store = await createProjectStore(directory), projectId = 'candidate-video'; await store.save(projectId, { kind: 'video', title: 'Fixture project', video: { timeline: [], captions: [] } });
  const importer = createReferenceUrlImporter({ dataDir: directory, root: path.resolve(import.meta.dirname, '..'), importLocal: async (filename, info) => { assert.deepEqual(await readFile(filename), mp4); const asset = { id: 'controlled-video-asset', type: 'video', name: info.name, duration: 2, hasAudio: true }; registered.push(asset); return asset; }, dependencies: { lookup, request, extractMetadata: async target => { metadata.push(target); return { title: 'Controlled reference', formats: [{ url: 'https://cdn.bilivideo.com/fixture.mp4', ext: 'mp4', vcodec: 'avc1', acodec: 'mp4a', height: 360 }] }; } } });
  let nativeRevision = '0000000000000001';
  const openFilm = { context: async () => ({ projectId, assets: [...assets], timeline: [], duration: 0, aspect: '16:9', revision: nativeRevision, warnings: [] }), importAsset: async (owner, id, _origin, options) => { assert.equal(owner, projectId); assert.equal(options.expectedRevision, nativeRevision); const asset = registered.find(asset => asset.id === id); assets.push(asset); nativeRevision = '0000000000000002'; return { asset, revision: nativeRevision }; } };
  const webTools = createAssistantWebService({ dependencies: { lookup, request } }), app = createAssistantAppTools({ store, openFilm, videoImporter: () => importer }); let step = 0; const errors = [];
  const sequence = [{ type: 'tool', tool: 'web_read', arguments: { url: supplied }, summary: 'Read exact supplied page' }, { type: 'tool', tool: 'video_import_url', arguments: { url: supplied + '&leak=PRIVATE' }, summary: 'Must reject invented query' }, { type: 'tool', tool: 'video_import_url', arguments: { url: supplied }, summary: 'Import actual supplied reference' }, { type: 'final', message: 'Controlled diagnostic complete.', sourceIds: [] }];
  const service = createAssistantAgentService({ dataDir: directory, appTools: app.tools, webTools, buildContext: app.buildContext, modelStep: async (_system, input) => { const payload = JSON.parse(input); assert.equal(payload.request, instruction); const observation = payload.observations.at(-1); if (observation?.error?.code) errors.push(observation.error.code); return { data: sequence[step++] || sequence.at(-1) }; } });
  t.after(async () => { await service.close(); await app.close(); await webTools.close(); await importer.close(); await store.settle(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); assert.equal(path.dirname(directory), parent); await rm(directory, { recursive: true, force: true }); });
  const { runId } = await service.start({ projectId, instruction, mode: 'auto', settings }, { origin }); const job = await finish(service, runId);
  assert.equal(job.status, 'failed', JSON.stringify(job)); assert.equal(job.error.code, 'ASSISTANT_PRODUCTION_NOT_STARTED'); assert.equal(job.report.outcome, 'partial'); assert.deepEqual(errors, ['ASSISTANT_VIDEO_IMPORT_SOURCE']); assert.equal(metadata.length, 1); assert.deepEqual(metadata[0], { platform: 'bilibili', url: 'https://www.bilibili.com/video/' + candidateCase.id + '?p=1' });
  assert.equal(registered.length, 1); assert.equal(assets.length, 1); assert.equal(job.effects.some(effect => effect.importedAssetId === 'controlled-video-asset'), true); assert.equal(requests.length, 2); assert.ok(requests.every(url => !url.includes('leak=')));
});
