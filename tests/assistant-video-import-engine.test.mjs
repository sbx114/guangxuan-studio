import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createAssistantAgentService } from '../lib/assistant-agent.mjs';
import { AppError } from '../lib/errors.mjs';

const sourceUrl = 'https://video.hust.example/campus?id=2026', mediaUrl = 'https://media.hust.example/campus.mp4?quality=hd';
const urlSchema = { type: 'object', additionalProperties: false, required: ['url'], properties: { url: { type: 'string', minLength: 8, maxLength: 2000 } } };
const objectSchema = { type: 'object', additionalProperties: false };
const evidence = async (name, value) => { if (!process.env.GUANGXUAN_VIDEO_IMPORT_ENGINE_EVIDENCE) return; const directory = path.resolve(process.env.GUANGXUAN_VIDEO_IMPORT_ENGINE_EVIDENCE); await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, name + '.json'), JSON.stringify(value, null, 2)); };

async function fixture(t, responder, options = {}) {
  const requests = [], services = [];
  const server = http.createServer(async (req, res) => {
    try { const body = JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString()); const payload = JSON.parse(body.messages[1].content); requests.push({ body, payload }); const data = await responder(payload, requests.length - 1, body.messages[0].content); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(data) }, finish_reason: 'stop' }] })); }
    catch { if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'controlled model fixture failed' })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const directory = await mkdtemp(path.join(os.tmpdir(), 'gx-video-import-engine-'));
  const service = createAssistantAgentService({ dataDir: directory, ...options }); services.push(service);
  t.after(async () => { for (const item of services) await item.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); assert.equal(path.dirname(directory), os.tmpdir()); await rm(directory, { recursive: true, force: true }); });
  return { service, requests, directory, settings: { baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'http-fixture', apiKey: 'fixture-video-import-key', timeoutSeconds: 10 } };
}
async function finish(service, id) { const until = Date.now() + 10000; while (Date.now() < until) { const job = await service.get(id); if (['completed', 'failed', 'cancelled', 'interrupted'].includes(job.status)) return job; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail('Assistant video fixture did not finish.'); }

test('empty video projects can search, read an actual media candidate, import, inspect and edit a 20-second draft', async t => {
  const calls = [], assets = [], timeline = [], scope = { assetIds: [], placement: { mode: 'append' } }; let inspected = false;
  const sequence = [
    { type: 'tool', tool: 'web_search', arguments: { query: 'HUST 华中科技大学 校园 官方公开视频' }, summary: '寻找华科校园视频' },
    { type: 'tool', tool: 'web_read', arguments: { url: sourceUrl }, summary: '读取视频页面的真实媒体地址' },
    { type: 'tool', tool: 'video_import_url', arguments: { url: mediaUrl }, summary: '将视频导入当前剪辑素材库' },
    { type: 'tool', tool: 'native_read', arguments: {}, summary: '确认导入素材和当前时间线' },
    { type: 'tool', tool: 'native_edit', arguments: { instruction: '用本轮导入的华科素材制作20秒剪辑草稿，保持用户范围' }, summary: '制作20秒华科短片' },
    { type: 'final', message: '已导入华科校园视频并完成20秒剪辑草稿，工程时长20秒，尚未导出文件。[S1]', sourceIds: ['S1'] },
  ];
  const fx = await fixture(t, (_payload, index) => sequence[index], {
    buildContext: ctx => ({ id: ctx.projectId, kind: 'video', native: { assets: [], timeline: [], duration: 0 }, editScope: scope }),
    webTools: {
      search: async query => { calls.push('search'); assert.match(query, /HUST/); return { results: [{ title: '校园官方视频页面', url: sourceUrl }] }; },
      read: async url => { calls.push('read'); assert.equal(url, sourceUrl); return { title: '校园官方视频页面', url, text: '校园视频介绍，包含可获取的公开媒体链接。', links: [{ title: 'video source', url: mediaUrl }] }; },
    },
    appTools: [
      { name: 'video_import_url', description: '导入当前项目视频', inputSchema: urlSchema, mutating: true, execute: async ({ url }, ctx) => { calls.push('import'); assert.equal(url, mediaUrl); assert.equal(ctx.projectId, 'hust-video'); assert.deepEqual(ctx.editScope, scope); const asset = { id: 'canonical-hust-asset', name: 'campus.mp4', type: 'video', duration: 32, width: 1920, height: 1080 }; assets.push(asset); return { summary: '已导入视频素材，时间线尚未改变', data: { asset, timelineChanged: false }, effects: [{ type: 'media', label: '已导入视频素材 campus.mp4', projectId: ctx.projectId, changed: true }], sources: [{ title: '校园官方视频页面', url: sourceUrl }] }; } },
      { name: 'native_read', description: '读取当前原生工程', inputSchema: objectSchema, execute: async () => { calls.push('native_read'); inspected = true; assert.equal(assets.length, 1); return { summary: '已读取导入素材', data: { assets, timeline, duration: 0 } }; } },
      { name: 'native_edit', description: '实际剪辑', mutating: true, inputSchema: { type: 'object', required: ['instruction'], additionalProperties: false, properties: { instruction: { type: 'string' } } }, execute: async ({ instruction }, ctx) => { calls.push('native_edit'); assert.equal(inspected, true); assert.match(instruction, /20秒/); assert.equal(ctx.projectId, 'hust-video'); timeline.push({ assetId: assets[0].id, start: 0, end: 20, at: 0 }); return { summary: '已应用剪辑，工程时长20秒', data: { applied: true, duration: 20 }, effects: [{ type: 'native', label: '已完成20秒剪辑', projectId: ctx.projectId, changed: true }] }; } },
    ],
  });
  const { runId } = await fx.service.start({ projectId: 'hust-video', instruction: '找些HUST华科校园公开视频，做个20秒片子', editScope: scope, settings: fx.settings }); const job = await finish(fx.service, runId);
  assert.equal(job.status, 'completed', JSON.stringify(job)); assert.deepEqual(calls, ['search', 'read', 'import', 'native_read', 'native_edit']); assert.equal(timeline[0].end - timeline[0].start, 20); assert.deepEqual(job.effects.map(effect => effect.type), ['media', 'native']); assert.equal(job.steps.filter(step => step.type === 'tool').every(step => step.status === 'completed'), true); assert.equal(job.sources[0].url, sourceUrl);
  const system = fx.requests[0].body.messages[0].content; assert.match(system, /当前素材为空是工作起点/); assert.match(system, /视频必须使用视频媒体导入工具/); assert.match(system, /不得自行拼接下载接口、路径或查询参数/); assert.match(system, /不得伪造授权/); assert.match(system, /不要额外逐份索要素材授权确认/); assert.equal(fx.requests[0].payload.tools.some(tool => tool.name === 'video_import_url'), true); assert.equal(fx.requests[0].payload.projectContext.native.assets.length, 0); assert.match(job.message, /20秒/);
  await evidence('search-import-edit-20s', { controlledModelFixture: true, calls, initialAssetCount: 0, importedAssetId: assets[0].id, actualFixtureDuration: 20, status: job.status, steps: job.steps, effects: job.effects, message: job.message });
});

test('video import failures are observed without fabricated assets or a successful 20-second edit', async t => {
  let edited = 0;
  const fx = await fixture(t, (payload, index) => {
    if (!index) return { type: 'tool', tool: 'web_search', arguments: { query: 'HUST 官方校园视频' }, summary: '寻找公开视频' };
    if (index === 1) return { type: 'tool', tool: 'video_import_url', arguments: { url: sourceUrl }, summary: '尝试导入真实视频页面' };
    assert.equal(payload.observations[1].status, 'failed'); assert.equal(payload.observations[1].error.code, 'VIDEO_SOURCE_UNAVAILABLE');
    return { type: 'final', message: '已找到视频页面，但该来源导入失败，尚未取得可剪辑素材，也没有制作20秒短片。可以继续尝试其他公开来源。[S1]', sourceIds: ['S1'], effects: [{ type: 'native', label: '伪造的成片结果' }] };
  }, { buildContext: () => ({ kind: 'video', assets: [] }), webTools: { search: async () => ({ results: [{ title: '校园视频页', url: sourceUrl }] }) }, appTools: [
    { name: 'video_import_url', description: '真实导入', inputSchema: urlSchema, mutating: true, execute: async () => { throw new AppError(422, '这个来源暂未提供可导入的公开视频。', 'VIDEO_SOURCE_UNAVAILABLE'); } },
    { name: 'native_edit', description: '实际剪辑', mutating: true, execute: async () => { edited++; return { effects: [{ type: 'native', changed: true }] }; } },
  ] });
  const { runId } = await fx.service.start({ projectId: 'hust-video', instruction: '搜索HUST视频并制作20秒剪辑', settings: fx.settings }); const job = await finish(fx.service, runId); assert.equal(job.status, 'completed'); assert.equal(edited, 0); assert.deepEqual(job.effects, []); assert.equal(job.steps.find(step => step.tool === 'video_import_url').status, 'failed'); assert.match(job.message, /导入失败/); assert.match(job.message, /没有制作20秒/); assert.doesNotMatch(job.message, /已完成20秒|已生成20秒/);
  await evidence('import-failure-truthful-result', { controlledModelFixture: true, status: job.status, edited, effects: job.effects, steps: job.steps, message: job.message });
});

test('video import only accepts complete discovered URLs and cannot append queries or select another project', async t => {
  const imported = [], privateText = '当前项目中尚未公开的研究素材';
  const sequence = [
    { type: 'tool', tool: 'video_import_url', arguments: { url: 'https://unverified.example/invented.mp4' }, summary: '未经验证的地址应被拒绝' },
    { type: 'tool', tool: 'web_search', arguments: { query: '校园公开视频' }, summary: '搜索来源' },
    { type: 'tool', tool: 'video_import_url', arguments: { url: sourceUrl + '&download=1' }, summary: '模型新增参数应被拒绝' },
    { type: 'tool', tool: 'web_read', arguments: { url: sourceUrl }, summary: '读取真实媒体候选' },
    { type: 'tool', tool: 'video_import_url', arguments: { url: mediaUrl + '&note=' + encodeURIComponent(privateText) }, summary: '私有查询外发应被拒绝' },
    { type: 'tool', tool: 'video_import_url', arguments: { url: mediaUrl, projectId: 'foreign-project' }, summary: '切换目标项目应被拒绝' },
    { type: 'tool', tool: 'video_import_url', arguments: { url: mediaUrl }, summary: '只导入真实完整地址' },
    { type: 'final', message: '已将一个真实来源导入当前素材库，尚未修改时间线。', sourceIds: ['S1'] },
  ];
  const fx = await fixture(t, (_payload, index) => sequence[index], { buildContext: () => ({ text: privateText }), webTools: { search: async () => ({ results: [{ title: '来源页', url: sourceUrl }] }), read: async url => ({ title: '来源页', url, text: '真实视频页面', links: [{ title: 'og:video', url: mediaUrl }] }) }, appTools: [{ name: 'video_import_url', description: '导入视频', inputSchema: urlSchema, mutating: true, execute: async ({ url }, ctx) => { assert.equal(ctx.projectId, 'current-video'); imported.push(url); return { summary: '已导入素材', data: { timelineChanged: false }, effects: [{ type: 'media', projectId: ctx.projectId, changed: true }] }; } }] });
  const { runId } = await fx.service.start({ projectId: 'current-video', instruction: '请搜索并导入校园公开视频', settings: fx.settings }); const job = await finish(fx.service, runId); assert.equal(job.status, 'completed'); assert.deepEqual(imported, [mediaUrl]); assert.equal(job.steps.filter(step => step.tool === 'video_import_url' && step.status === 'failed').length, 4); const finalPayload = fx.requests.at(-1).payload;
  // The recent context is a rolling window. Verify each real rejection from
  // the snapshot that observed it, rather than requiring old raw errors to be
  // copied into every later model request.
  const rejected = new Map();
  for (const request of fx.requests) for (const item of request.payload.observations || []) if (item.tool === 'video_import_url' && item.status === 'failed') rejected.set(item.step, item);
  assert.deepEqual([...rejected.values()].map(item => item.error.code), ['ASSISTANT_VIDEO_IMPORT_SOURCE', 'ASSISTANT_VIDEO_IMPORT_SOURCE', 'ASSISTANT_VIDEO_IMPORT_SOURCE', 'ASSISTANT_TOOL_ARGUMENTS']); assert.equal(job.effects.length, 1);
  assert.ok(finalPayload.previousResults.some(item => item.step === 1 && item.tool === 'video_import_url' && item.status === 'failed'));
  await evidence('complete-url-project-gates', { imported, rejected: [...rejected.values()], effects: job.effects });
});

test('ask, how-to and explicit no-import requests cannot enable the new media mutation', async t => {
  for (const tool of ['video_import_url', 'media_import_url', 'media_prepare_import']) {
  for (const [mode, instruction] of [['ask', '请导入这个视频 ' + sourceUrl], ['auto', '如何把这个视频导入剪辑工程 ' + sourceUrl], ['auto', '不要导入这个视频，只解释它 ' + sourceUrl], ['auto', '不要制作20秒视频，只列出检索结果 ' + sourceUrl]]) {
    let imported = 0;
    const fx = await fixture(t, (_payload, index) => index ? { type: 'final', message: '仅说明操作方法，未导入或剪辑。', sourceIds: [] } : { type: 'tool', tool, arguments: { url: sourceUrl }, summary: '不应执行的导入' }, { appTools: [{ name: tool, description: '导入', inputSchema: urlSchema, execute: async () => { imported++; return { effects: [{ type: 'media', changed: true }] }; } }] });
    const { runId } = await fx.service.start({ projectId: 'current-video', instruction, mode, settings: fx.settings }); const job = await finish(fx.service, runId); assert.equal(imported, 0); assert.deepEqual(job.effects, []); assert.equal(job.steps.find(step => step.tool === tool).status, 'failed'); assert.equal(fx.requests[0].payload.tools.some(item => item.name === tool), false);
  }
  }
});

test('unified image imports share complete URL candidates while saved-media preparation accepts only its local ID', async t => {
  const image = 'https://school.example.org/diagram.png', imported = [], prepared = [], downloadId = '12345678-1234-4234-8234-123456789abc';
  const sequence = [
    { type: 'tool', tool: 'web_search', arguments: { query: '公开物理图示' }, summary: '查找图片来源' },
    { type: 'tool', tool: 'media_import_url', arguments: { url: image + '?invented=1', kind: 'image' }, summary: '拒绝拼改链接' },
    { type: 'tool', tool: 'media_import_url', arguments: { url: image, kind: 'image' }, summary: '识别图片后导入科普资料' },
    { type: 'tool', tool: 'media_prepare_import', arguments: { downloadId }, summary: '整理已经下载的图片' },
    { type: 'final', message: '图片已经识别整理并导入科普资料，原图文字仍需核对。', sourceIds: ['S1'] },
  ];
  const fx = await fixture(t, (_payload, index) => sequence[index], { webTools: { search: async () => ({ results: [{ title: '物理图示原图', url: image }] }) }, appTools: [
    { name: 'media_import_url', description: '统一媒体导入', mutating: true, inputSchema: { ...urlSchema, required: ['url', 'kind'], properties: { ...urlSchema.properties, kind: { type: 'string', enum: ['image', 'video'] } } }, execute: async (args, ctx) => { assert.equal(ctx.projectId, 'current-science'); imported.push(args); return { summary: '已识别图片并导入', effects: [{ type: 'document', changed: true, projectId: ctx.projectId }] }; } },
    { name: 'media_prepare_import', description: '准备已下载图片', mutating: true, inputSchema: { type: 'object', additionalProperties: false, required: ['downloadId'], properties: { downloadId: { type: 'string', maxLength: 36 } } }, execute: async (args, ctx) => { assert.equal(ctx.projectId, 'current-science'); prepared.push(args); return { summary: '已导入本机已下载图片的识别资料', effects: [{ type: 'document', changed: true, projectId: ctx.projectId }] }; } },
  ] });
  const { runId } = await fx.service.start({ projectId: 'current-science', instruction: '搜索图片并处理好后导入当前科普项目，也导入已经下载的这份图片', settings: fx.settings }); const job = await finish(fx.service, runId); assert.equal(job.status, 'completed'); assert.deepEqual(imported, [{ url: image, kind: 'image' }]); assert.deepEqual(prepared, [{ downloadId }]); const observations = fx.requests.at(-1).payload.observations; assert.equal(observations[1].error.code, 'ASSISTANT_MEDIA_IMPORT_SOURCE'); assert.equal(job.effects.length, 1, 'identical safe effect receipts are published once');
});
