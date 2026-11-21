import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import { createAssistantAgentService, assistantSearchPolicy } from '../lib/assistant-agent.mjs';
import { AppError } from '../lib/errors.mjs';

const url = 'https://www.bilibili.com/pt/video/BV1CMaf69EZu/';
test('only the current human search request can authorize searching beyond a supplied video', () => {
  for (const text of ['参考' + url + '制作MV', '不要乱搜索网页，参考 ' + url, 'Read ' + url + ' without searching', '参考 ' + url + '?q=search', '参考 ' + url + ' “搜索医学网页”', '参考 `' + url + '` 制作动画']) assert.deepEqual(assistantSearchPolicy(text), { directVideoFirst: true, searchAllowed: false });
  for (const text of ['参考 ' + url + ' 并搜索相似视频', 'Search references for ' + url, '查询最新资料，并结合 ' + url, '帮我搜索素材视频']) assert.equal(assistantSearchPolicy(text).searchAllowed, true);
});

async function run(t, { instruction, failedImport = false, explicitSearch = false }) {
  const parent = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(parent, { recursive: true }); const dataDir = await mkdtemp(path.join(parent, 'gx-video-search-'));
  let searched = 0, imported = 0, index = 0; const inputs = [];
  const steps = explicitSearch ? [{ type: 'tool', tool: 'web_search', arguments: { query: '相似视频参考' } }] : failedImport ? [{ type: 'tool', tool: 'video_import_url', arguments: { url } }, { type: 'tool', tool: 'web_search', arguments: { query: '无关网页' } }] : [{ type: 'tool', tool: 'web_search', arguments: { query: '无关网页' } }, { type: 'tool', tool: 'video_import_url', arguments: { url } }];
  const service = createAssistantAgentService({ dataDir, webTools: { search: async () => { searched++; return { results: [] }; } }, appTools: [{ name: 'video_import_url', mutating: true, inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }, execute: async args => { imported++; assert.equal(args.url, url); if (failedImport) throw new AppError(422, 'Controlled source unavailable', 'REFERENCE_DOWNLOAD_FAILED'); return { summary: '已读取测试视频', data: { assetId: 'fixture-asset' } }; } }], modelStep: async (_system, user) => { inputs.push(JSON.parse(user)); return { data: steps[index++] || { type: 'final', message: '测试结束' } }; } });
  t.after(async () => { await service.close(); assert.equal(path.dirname(dataDir), parent); await rm(dataDir, { recursive: true, force: true }); });
  const { runId } = await service.start({ instruction, settings: { baseUrl: 'https://fixture.invalid/v1', model: 'fixture', apiKey: 'synthetic-search-fixture-key' } });
  let job; for (let i = 0; i < 300; i++) { job = await service.get(runId); if (['completed','failed','cancelled'].includes(job.status)) break; await pause(5); }
  assert.equal(job.status, 'completed'); return { searched, imported, inputs, job };
}
test('an unrequested search has no network call and the agent can continue with the original video', async t => {
  const result = await run(t, { instruction: '导入 ' + url + ' 并制作视频' });
  assert.equal(result.searched, 0); assert.equal(result.imported, 1);
  assert.equal(result.inputs[0].tools.some(tool => tool.name === 'web_search'), false);
  assert.ok(result.job.steps.some(step => step.tool === 'web_search' && step.status === 'failed'));
});
test('a failed video import does not enable unrelated searching on the next step', async t => {
  const result = await run(t, { instruction: '导入 ' + url + ' 并制作视频', failedImport: true });
  assert.equal(result.imported, 1); assert.equal(result.searched, 0);
  assert.ok(result.inputs.every(input => input.searchPolicy.searchAllowed === false));
});
test('explicit related search remains available for a supplied video', async t => {
  const result = await run(t, { instruction: '搜索相似视频参考，结合 ' + url, explicitSearch: true });
  assert.equal(result.searched, 1); assert.equal(result.inputs[0].tools.some(tool => tool.name === 'web_search'), true);
});
