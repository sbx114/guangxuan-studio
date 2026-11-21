import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { startServer } from '../server.mjs';
import { writingSourceFingerprint } from '../public/writing-model.js';

test('global assistant applies the current writing habits but stores only the resulting draft and real evidence', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gx-writing-assistant-'));
  const sample = 'PRIVATE_STYLE_SAMPLE_NEVER_COPY_TO_PROJECT_OR_RUNS';
  const material = '周五下午举办实验设计讲座，欢迎感兴趣的同学参加。';
  let planners = 0, drafting = 0;
  const provider = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw), system = body.messages[0].content, input = JSON.parse(body.messages[1].content);
    let answer;
    if (system.includes('你是 Gx 软件内')) {
      planners++;
      assert.equal(input.projectContext.writingPreferences.styleSample, sample);
      answer = planners === 1 ? { type: 'tool', tool: 'writing_create', arguments: { channel: 'social' }, summary: '按当前习惯起草社群短文' } : { type: 'final', message: '已按材料保存一份社群短文。', sourceIds: [] };
    } else {
      drafting++; assert.equal(input.个人表达偏好.styleSample, sample); assert.equal(input.原始材料.text, material);
      answer = { channel: 'social', output: { title: '一起听场讲座', text: '周五下午有一场实验设计讲座，感兴趣的话，一起参加吧。', tags: [] }, evidence: [{ quote: material, label: '讲座信息' }], notes: [] };
    }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(answer) } }] }));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const app = await startServer({ port: 0, dataDir: directory });
  t.after(async () => { await app.close(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('gx-writing-assistant-')) throw Error('Unsafe cleanup'); await rm(directory, { recursive: true, force: true }); });
  async function api(route, input, method = input ? 'POST' : 'GET') { const response = await fetch(app.url + route, { method, ...(input ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) } : {}) }); const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value; }
  const { project: original } = await api('/api/projects/personal-writing', { kind: 'writing', title: '写作资料', source: { title: '讲座', text: material, url: '' }, outputs: { article: { title: '已有文章', body: '这份旧稿必须保留。' } } }, 'PUT');
  const start = await api('/api/assistant/runs', { projectId: original.id, instruction: '按我现在的习惯写一份社群短文并保存', writingPreferences: { voice: '自然、像朋友提醒', styleSample: sample, avoidWords: ['赋能'] }, settings: { baseUrl: 'http://127.0.0.1:' + provider.address().port, apiKey: 'fixture-no-real-key', model: 'writing-fixture' } });
  let job;
  for (let count = 0; count < 300; count++) { ({ job } = await api('/api/assistant/runs/' + start.runId)); if (['completed', 'failed', 'cancelled'].includes(job.status)) break; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal(job.status, 'completed', JSON.stringify(job)); assert.equal(drafting, 1); assert.equal(planners, 2);
  const { project } = await api('/api/projects/' + original.id);
  assert.equal(project.writing.draft.channel, 'social'); assert.equal(project.outputs.article.body, original.outputs.article.body);
  assert.equal(project.writing.draft.evidence[0].quote, material); assert.equal(project.writing.draft.sourceFingerprint, writingSourceFingerprint(project.source));
  assert.ok(!JSON.stringify(project).includes(sample)); assert.ok(!(await readFile(path.join(directory, 'assistant/runs.json'), 'utf8')).includes(sample));
  const restored = await api('/api/assistant/undo', { projectId: original.id, undoId: job.effects[0].undo.id });
  assert.equal(restored.project.outputs.social, undefined); assert.equal(restored.project.writing, undefined);
});
