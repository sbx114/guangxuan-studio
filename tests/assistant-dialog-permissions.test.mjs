import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as pause } from 'node:timers/promises';
import { createProjectStore } from '../lib/store.mjs';
import { createAssistantAppTools } from '../lib/assistant-app-tools.mjs';
import { createAssistantAgentService } from '../lib/assistant-agent.mjs';
import { describeNativeTimeline, planNativeAdjustments } from '../lib/native-adjustments.mjs';
import { AppError } from '../lib/errors.mjs';

const oldUiScope = { assetIds: ['asset-a'], placement: { mode: 'range', start: 0, end: 2, clipIds: ['clip-a'] } };
const toolStep = (tool, args = {}) => ({ type: 'tool', tool, arguments: args, summary: '执行本轮请求' });
const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
async function fixture(t, { kind = 'video', uiScope = oldUiScope, storedScope = oldUiScope } = {}) {
  const parent = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()), dataDir = await mkdtemp(path.join(parent, 'gx-dialog-permissions-'));
  const store = await createProjectStore(dataDir);
  const project = await store.save('dialog-project', { kind, title: '原项目标题', source: { text: '真实材料' }, outputs: { article: { title: '原稿件标题', lead: '导语', body: '原正文', titles: ['原标题'] } }, ...(kind === 'video' ? { video: { timeline: [], editScope: storedScope } } : {}) });
  const assets = [{ id: 'asset-a', name: '旧选素材.mp4', type: 'video', duration: 30 }, { id: 'asset-b', name: '对话要求修改.mp4', type: 'video', duration: 30 }];
  const known = { 'a.mp4': { assetId: 'asset-a', duration: 30 }, 'b.mp4': { assetId: 'asset-b', duration: 30 } };
  let doc = { stage: { w: 1280, h: 720 }, tracks: [{ clips: [{ id: 'clip-a', src: 'a.mp4', time: [0, 2], at: 0 }] }, { clips: [{ id: 'clip-b', src: 'b.mp4', time: [0, 4], at: 12 }] }] };
  const revision = () => createHash('sha256').update(JSON.stringify(doc)).digest('hex').slice(0, 16);
  const contexts = [], writes = [], requests = [], services = [];
  const openFilm = {
    async context(projectId, _origin, { editScope } = {}) { assert.equal(projectId, project.id); contexts.push(structuredClone(editScope)); return { assets: structuredClone(assets), timeline: doc.tracks.flatMap(track => track.clips).map(clip => ({ id: clip.id, assetId: known[clip.src].assetId, start: clip.time[0], end: clip.time[1], at: clip.at || 0 })), editorTimeline: describeNativeTimeline(doc, known, editScope), duration: 16, stage: doc.stage, mainTrackEditable: true, aspect: '16:9', revision: revision(), warnings: [] }; },
    async adjustClips(projectId, edits, _origin, expectedRevision, options) {
      assert.equal(projectId, project.id); if (expectedRevision !== revision()) throw new AppError(409, '原生并发修改', 'OPENFILM_REVISION_CONFLICT');
      const planned = planNativeAdjustments(doc, edits, { known, editScope: options.editScope }); doc = planned.document;
      writes.push({ edits: structuredClone(edits), scope: structuredClone(options.editScope) }); return { ...planned, revision: revision(), undo: { id: 'native-undo' } };
    },
    async syncMetadata() {},
  };
  const adapter = createAssistantAppTools({ store, openFilm, references: { list: async () => ({ revision: 0, items: [] }) } });
  t.after(async () => { await Promise.all(services.map(service => service.close())); await adapter.close(); await store.settle(); assert.equal(path.dirname(path.resolve(dataDir)), parent); await rm(dataDir, { recursive: true, force: true }); });
  async function run(instruction, sequence, { mode = 'auto' } = {}) {
    let cursor = 0;
    const service = createAssistantAgentService({ dataDir: path.join(dataDir, 'agent-' + services.length), appTools: adapter.tools, buildContext: async ctx => { assert.equal(ctx.scopeAuthority, 'dialog'); return adapter.buildContext(ctx); }, modelStep: async (_system, user) => {
      const payload = JSON.parse(user); requests.push(payload);
      return { data: sequence[cursor++] || { type: 'final', message: '受控测试结束。', sourceIds: [] } };
    } }); services.push(service);
    const started = await service.start({ projectId: project.id, instruction, mode, ...(uiScope === undefined ? {} : { editScope: uiScope }), settings: { baseUrl: 'https://fixture.invalid/v1', model: 'fixture-no-network', apiKey: 'fixture-only-not-real' } }, { origin: 'http://127.0.0.1:49101' });
    let job;
    for (let count = 0; count < 500; count++) { job = await service.get(started.runId); if (terminal.has(job.status)) return job; await pause(5); }
    throw new Error('dialog fixture did not finish');
  }
  return { store, project, adapter, contexts, writes, requests, run, clip: id => doc.tracks.flatMap(track => track.clips).find(clip => clip.id === id) };
}

test('real agent default dialogue authority edits current project beyond stale UI assets and range', async t => {
  const fx = await fixture(t), job = await fx.run('把全片声音统一调低，并把第二段静音。', [toolStep('native_adjust', { edits: [{ action: 'volume', clipId: 'clip-b', value: 0 }] })]);
  assert.equal(job.status, 'completed', JSON.stringify(job)); assert.equal(fx.writes.length, 1);
  assert.deepEqual(fx.writes[0].scope, { placement: { mode: 'append' } }); assert.equal(fx.clip('clip-b').volume, 0);
  assert.deepEqual(JSON.parse(JSON.stringify((await fx.store.read(fx.project.id)).video.editScope)), oldUiScope, 'dialogue scope is ephemeral and does not rewrite old UI selection');
});

test('default dialogue scope does not require the words full project to ignore old UI selection', async t => {
  const fx = await fixture(t); await fx.run('把第二段静音。', [toolStep('native_adjust', { edits: [{ action: 'volume', clipId: 'clip-b', value: 0 }] })]);
  assert.equal(fx.writes.length, 1); assert.equal(fx.writes[0].scope.assetIds, undefined); assert.equal(fx.clip('clip-b').volume, 0);
});

test('an explicit dialogue 10–20 second limit replaces stale UI scope and cannot be enlarged', async t => {
  const fx = await fixture(t), job = await fx.run('只改10–20秒，把里面的第二段静音。', [toolStep('native_scope_set', { placement: { mode: 'replace' } }), toolStep('native_adjust', { edits: [{ action: 'volume', clipId: 'clip-b', value: 0 }] })]);
  assert.equal(job.status, 'completed', JSON.stringify(job)); assert.equal(job.steps.filter(step => step.type === 'tool')[0].status, 'failed');
  assert.equal(fx.writes.length, 1); assert.deepEqual(fx.writes[0].scope, { placement: { mode: 'range', start: 10, end: 20 } }); assert.equal(fx.clip('clip-b').volume, 0);
});

test('dialogue selected-only request adopts UI asset IDs, time and clips and prevents expansion', async t => {
  const fx = await fixture(t); const job = await fx.run('只改当前所选片段，音量减半。', [toolStep('native_scope_set', { placement: { mode: 'range', start: 0, end: 20 } }), toolStep('native_adjust', { edits: [{ action: 'volume', clipId: 'clip-b', value: 0 }] }), toolStep('native_adjust', { edits: [{ action: 'volume', clipId: 'clip-a', value: .5 }] })]);
  const steps = job.steps.filter(step => step.type === 'tool'); assert.equal(steps[0].status, 'failed'); assert.equal(steps[1].status, 'failed'); assert.equal(fx.writes.length, 1); assert.equal(fx.clip('clip-a').volume, .5); assert.equal(fx.clip('clip-b').volume, undefined);
  assert.deepEqual(fx.writes[0].scope, oldUiScope);
});

test('scope placement changes can revisit an earlier state after intermediate narrowing', async t => {
  const fx = await fixture(t); await fx.run('根据需要重新安排当前工程并调整声音。', [toolStep('native_scope_set', { placement: { mode: 'append' } }), toolStep('native_scope_set', { placement: { mode: 'range', start: 0, end: 2 } }), toolStep('native_scope_set', { placement: { mode: 'append' } }), toolStep('native_adjust', { edits: [{ action: 'volume', clipId: 'clip-b', value: 0 }] })]);
  assert.equal(fx.writes.length, 1); assert.deepEqual(fx.writes[0].scope, { placement: { mode: 'append' } });
});

test('scope placement can revisit replace after append and the actual backend receives replace', async t => {
  const fx = await fixture(t); await fx.run('重新安排整个工程并调整声音。', [toolStep('native_scope_set', { placement: { mode: 'replace' } }), toolStep('native_scope_set', { placement: { mode: 'append' } }), toolStep('native_scope_set', { placement: { mode: 'replace' } }), toolStep('native_adjust', { edits: [{ action: 'volume', clipId: 'clip-b', value: 0 }] })]);
  assert.equal(fx.writes.length, 1); assert.deepEqual(fx.writes[0].scope, { placement: { mode: 'replace' } });
});

test('a prefix-only explicit time restriction never falls back to the whole project', async t => {
  const fx = await fixture(t); await fx.run('只修改前10秒的声音，其他不要动。', [toolStep('native_adjust', { edits: [{ action: 'volume', clipId: 'clip-b', value: 0 }] })]);
  assert.equal(fx.writes.length, 0); assert.notEqual(fx.contexts[0]?.placement.mode, 'append');
});
test('a trailing duration restriction resolves from the actual native timeline before any edit', async t => {
  const fx = await fixture(t); await fx.run('只修改最后4秒的声音，其他不要动。', [toolStep('native_read')]);
  const scope = fx.contexts.find(value => value.placement.mode === 'range');
  assert.ok(scope, 'Actual duration must resolve the pending tail constraint');
  assert.equal(scope.placement.end - scope.placement.start, 4);
});

test('a count/index interval is never interpreted as a seconds-based dialogue constraint', async t => {
  const fx = await fixture(t); await fx.run('只修改第10–20条字幕的措辞。', [toolStep('native_read')]);
  assert.equal(fx.contexts[0].placement.mode, 'append');
});

test('selected request without a usable UI selection never grants whole-project mutation', async t => {
  const fx = await fixture(t, { uiScope: null, storedScope: null });
  const job = await fx.run('修改当前所选片段的音量。', [toolStep('native_adjust', { edits: [{ action: 'volume', clipId: 'clip-b', value: 0 }] })]);
  assert.equal(fx.writes.length, 0); assert.equal(job.status, 'failed'); assert.equal(job.error?.code, 'ASSISTANT_SELECTION_REQUIRED');
});

for (const instruction of ['怎么调整当前工程的剪辑节奏？', '只给我调整建议，不要修改工程。', '只读取当前项目资料。', '当前视频节奏怎么样？', '列出当前工程的所有素材并说明内容。', '参考如何制作动画，只给建议，先不要修改当前工程。', '精修应该怎么做？这次仅提供方案。', '读取参考，先别做，只分析。']) test(`real project agent keeps question/read-only request immutable: ${instruction}`, async t => {
  const fx = await fixture(t); await fx.run(instruction, [toolStep('native_adjust', { edits: [{ action: 'volume', clipId: 'clip-b', value: 0 }] })]);
  assert.equal(fx.requests[0].tools.some(tool => tool.mutating), false, 'read-only request must withhold every write tool'); assert.equal(fx.writes.length, 0);
});

test('ask mode remains immutable even for an explicit full-project edit request', async t => {
  const fx = await fixture(t); await fx.run('修改整个工程，把第二段静音。', [toolStep('native_adjust', { edits: [{ action: 'volume', clipId: 'clip-b', value: 0 }] })], { mode: 'ask' });
  assert.equal(fx.requests[0].tools.some(tool => tool.mutating), false); assert.equal(fx.writes.length, 0);
});

test('mixed restriction and actual edit exposes writers and saves only the requested article body', async t => {
  const fx = await fixture(t, { kind: 'writing' }), job = await fx.run('不要改标题，但改正文，让解释更直接。', [toolStep('draft_write', { channel: 'article', content: { title: '原稿件标题', lead: '导语', body: '新的直接解释正文', titles: ['原标题'] } })]);
  assert.equal(job.status, 'completed', JSON.stringify(job)); assert.ok(fx.requests[0].tools.some(tool => tool.name === 'draft_write'));
  const project = await fx.store.read(fx.project.id); assert.equal(project.title, '原项目标题'); assert.equal(project.outputs.article.title, '原稿件标题'); assert.equal(project.outputs.article.body, '新的直接解释正文');
});

test('real free-placement agent selects concrete timing without requiring a UI interval or widening selected assets', async t => {
  const freeScope = { assetIds: ['asset-a'], placement: { mode: 'free' } };
  const fx = await fixture(t, { uiScope: freeScope, storedScope: freeScope });
  const job = await fx.run('只用所选素材自由创作，把第一段音量减半。', [
    toolStep('native_scope_set', { placement: { mode: 'insert', at: 6 } }),
    toolStep('native_adjust', { edits: [{ action: 'volume', clipId: 'clip-b', value: 0 }] }),
    toolStep('native_adjust', { edits: [{ action: 'volume', clipId: 'clip-a', value: .5 }] }),
  ]);
  assert.equal(job.status, 'completed', JSON.stringify(job));
  const steps = job.steps.filter(step => step.type === 'tool'); assert.equal(steps[0].status, 'completed'); assert.equal(steps[1].status, 'failed');
  assert.equal(fx.writes.length, 1); assert.equal(fx.clip('clip-a').volume, .5); assert.equal(fx.clip('clip-b').volume, undefined);
  assert.deepEqual(fx.writes[0].scope, { assetIds: ['asset-a'], placement: { mode: 'insert', at: 6 } });
  assert.deepEqual(JSON.parse(JSON.stringify((await fx.store.read(fx.project.id)).video.editScope)), freeScope, 'The model-selected operation position must not replace the UI free preference');
});

test('free-placement explicit whole-project dialogue retains the existing ability to override stale material selection', async t => {
  const freeScope = { assetIds: ['asset-a'], placement: { mode: 'free' } }, fx = await fixture(t, { uiScope: freeScope, storedScope: freeScope });
  const job = await fx.run('把全片声音统一调低，并把第二段静音。', [toolStep('native_adjust', { edits: [{ action: 'volume', clipId: 'clip-b', value: 0 }] })]);
  assert.equal(job.status, 'completed', JSON.stringify(job)); assert.equal(fx.writes.length, 1); assert.equal(fx.clip('clip-b').volume, 0);
  assert.deepEqual(fx.writes[0].scope, { placement: { mode: 'free' } });
  assert.deepEqual(JSON.parse(JSON.stringify((await fx.store.read(fx.project.id)).video.editScope)), freeScope);
});

test('free-placement UI assets are advisory when the dialogue asks to refine a different project clip', async t => {
  const freeScope = { assetIds: ['asset-a'], placement: { mode: 'free' } }, fx = await fixture(t, { uiScope: freeScope, storedScope: freeScope });
  const job = await fx.run('按所选素材作参考，精修第二段，让音量减半。', [toolStep('native_scope_set', { placement: { mode: 'insert', at: 8 } }), toolStep('native_adjust', { edits: [{ action: 'volume', clipId: 'clip-b', value: .5 }] })]);
  assert.equal(job.status, 'completed', JSON.stringify(job)); assert.equal(fx.writes.length, 1); assert.equal(fx.clip('clip-b').volume, .5);
  assert.deepEqual(fx.writes[0].scope, { placement: { mode: 'insert', at: 8 } });
  assert.deepEqual(JSON.parse(JSON.stringify((await fx.store.read(fx.project.id)).video.editScope)), freeScope);
});

for (const instruction of ['读取参考并精修现有动画', '读取当前工程，然后精修第二段', '先检查素材，再把第二段静音', '增强当前工程的声音层次', '让第二段的音量更小一些']) test(`Chinese action requests retain the complete project tool interface: ${instruction}`, async t => {
  const fx = await fixture(t), job = await fx.run(instruction, [toolStep('native_adjust', { edits: [{ action: 'volume', clipId: 'clip-b', value: .5 }] })]);
  assert.equal(job.status, 'completed', JSON.stringify(job)); assert.ok(fx.requests[0].tools.some(tool => tool.name === 'native_adjust')); assert.equal(fx.writes.length, 1);
  assert.equal(job.productionGoal?.instruction, instruction); assert.equal(fx.clip('clip-b').volume, .5);
});

test('restoring a conversation after refresh completes as a reply without a project production goal', async t => {
  const fx = await fixture(t), job = await fx.run('刷新恢复这轮问答', [{ type: 'final', message: '刷新后已恢复本轮回复。', sourceIds: [] }]);
  assert.equal(job.status, 'completed', JSON.stringify(job)); assert.equal(job.message, '刷新后已恢复本轮回复。');
  assert.equal(job.productionGoal, undefined); assert.equal(fx.writes.length, 0); assert.equal(fx.requests[0].tools.some(tool => tool.mutating), false);
});

test('project restoration remains an authorized edit with a real receipt', async t => {
  const instruction = '恢复整个工程，把第二段音量恢复为一半。', fx = await fixture(t), job = await fx.run(instruction, [toolStep('native_adjust', { edits: [{ action: 'volume', clipId: 'clip-b', value: .5 }] })]);
  assert.equal(job.status, 'completed', JSON.stringify(job)); assert.equal(job.productionGoal?.instruction, instruction);
  assert.equal(fx.writes.length, 1); assert.equal(fx.clip('clip-b').volume, .5); assert.equal(fx.requests[0].tools.some(tool => tool.name === 'native_adjust'), true);
});
