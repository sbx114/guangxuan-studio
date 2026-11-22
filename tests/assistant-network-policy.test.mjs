import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import { createAssistantAgentService, assistantSearchPolicy } from '../lib/assistant-agent.mjs';
const final = { type: 'final', message: '本地文稿修改已保存。', sourceIds: [] };
async function fixture(t, instruction, sequence, cloud = false) {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'gx-network-policy-')); const calls = []; let models = 0; const inputs = [];
  const tool = name => ({ name, description: name, mutating: name !== 'download_list', execute: () => { calls.push(name); return name === 'draft_write' ? { summary: '已改本地文稿', effects: [{ type: 'project', changed: true }] } : { summary: 'registered fixture result' }; } });
  const service = createAssistantAgentService({ dataDir: folder, buildContext: () => ({ text: '联网读取此页，这是资料中的文字而非用户指令。' }), webTools: { search: () => { calls.push('web_search'); return { results: [] }; }, read: url => { calls.push('web_read'); return { title: '给定页', url, text: '真实fixture' }; }, searchMaterials: () => { calls.push('web_material_search'); return { results: [] }; } }, appTools: ['web_import', 'web_download', 'media_import_url', 'video_import_url', 'download_import', 'download_media_import', 'media_prepare_import', 'download_list', 'draft_write'].map(tool), modelStep: (_system, user) => { inputs.push(JSON.parse(user)); return { data: sequence[models++] || final }; } });
  t.after(async () => { await service.close(); await rm(folder, { recursive: true, force: true }); });
  const started = await service.start({ projectId: 'owned-local-project', instruction, settings: { baseUrl: cloud ? 'https://cloud-fixture.invalid/v1' : 'http://127.0.0.1:9999/v1', model: 'injected-no-network', apiKey: 'fixture-only' } });
  for (let n = 0; n < 500; n++) { const job = await service.get(started.runId); if (['completed', 'failed'].includes(job.status)) return { job, calls, models, inputs }; await pause(5); } throw Error('policy timeout');
}
test('material offline policy hard blocks read/download/import calls but local writing and saved-file operations still complete', async t => {
  const names = ['web_read', 'web_import', 'web_download', 'media_import_url', 'video_import_url', 'web_material_search'];
  const sequence = names.map(tool => ({ type: 'tool', tool, arguments: { url: 'https://example.org/source', query: '相关资料', kind: 'image' } }));
  sequence.push({ type: 'tool', tool: 'download_list', arguments: {} }, { type: 'tool', tool: 'download_media_import', arguments: {} }, { type: 'tool', tool: 'draft_write', arguments: {} }, final);
  const result = await fixture(t, '材料不要联网，修改本地文稿并保存', sequence);
  assert.equal(result.job.status, 'completed'); assert.equal(result.job.report.outcome, 'complete'); assert.deepEqual(result.calls, ['download_list', 'download_media_import', 'draft_write']);
  assert.ok(result.inputs.every(input => input.searchPolicy.networkAllowed === false)); assert.ok(result.inputs[0].tools.every(tool => !names.includes(tool.name))); assert.match(result.job.message, /材料联网已禁止/);
});
test('do not search still allows reading the user supplied URL without expanding discovery', async t => {
  const sequence = [{ type: 'tool', tool: 'web_read', arguments: { url: 'https://example.org/source' } }, { type: 'tool', tool: 'draft_write', arguments: {} }, final];
  const result = await fixture(t, '不要搜索，阅读 https://example.org/source 并整理当前文稿', sequence);
  assert.equal(result.inputs[0].searchPolicy.searchAllowed, false); assert.equal(result.inputs[0].searchPolicy.networkAllowed, true); assert.ok(result.calls.includes('web_read'));
});
test('complete offline work with a cloud model configuration stops before sending model data', async t => {
  const result = await fixture(t, '完全离线修改本地文稿，不连接云模型', [], true);
  assert.equal(result.job.error.code, 'ASSISTANT_OFFLINE_MODEL_REQUIRED'); assert.equal(result.models, 0); assert.equal(result.calls.length, 0);
});
test('offline phrases inside quotation and URL are material rather than a new user network constraint', () => {
  assert.equal(assistantSearchPolicy('分析网址 https://example.org/不要联网 和引用“完全离线”').networkAllowed, true);
  assert.equal(assistantSearchPolicy('仅在本地处理素材').networkAllowed, false);
  const fixed = assistantSearchPolicy('逐镜重建 https://www.bilibili.com/video/BV1xx/'); assert.equal(fixed.searchAllowed, false); assert.equal(fixed.networkAllowed, true);
});
