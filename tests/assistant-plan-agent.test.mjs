import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createAssistantAgentService } from '../lib/assistant-agent.mjs';
import { createProjectStore } from '../lib/store.mjs';
import { createAssistantAppTools } from '../lib/assistant-app-tools.mjs';

const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const tool = (name, args = {}) => ({ type: 'tool', tool: name, arguments: args, summary: '执行当前要求' });
const final = (message = '处理结束。', extra = {}) => ({ type: 'final', message, sourceIds: [], ...extra });
const settings = { baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-only-not-real-key', model: 'no-network' };
async function until(read, predicate, milliseconds = 10000) { const end = Date.now() + milliseconds; while (Date.now() < end) { const result = await read(); if (predicate(result)) return result; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('Isolated agent fixture did not settle.'); }
async function setup(t, respond, { extraTools = [], transformTools = value => value } = {}) {
  const parent = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'gx-plan-agent-')), store = await createProjectStore(path.join(directory, 'store'));
  const project = await store.save('plan-project', { kind: 'writing', title: '原始标题', source: { text: 'PRIVATE_FIXTURE_SOURCE_BODY '.repeat(12) } });
  const app = createAssistantAppTools({ store }), requests = [], services = [];
  const service = createAssistantAgentService({ dataDir: path.join(directory, 'agent'), appTools: transformTools([...app.tools, ...extraTools]), buildContext: ctx => app.buildContext(ctx), modelStep: async (system, payload) => {
    const body = JSON.parse(payload); requests.push(body); return { data: await respond(body, requests.length - 1, { store, project, app, system }) };
  } }); services.push(service);
  t.after(async () => { await Promise.all(services.map(value => value.close())); await app.close(); await store.settle(); assert.equal(path.dirname(directory), parent); await rm(directory, { recursive: true, force: true }); });
  return { directory, store, project, app, service, requests, services, start: async (instruction, options = {}) => { const started = await service.start({ projectId: project.id, instruction, settings, ...options }); return { ...started, finish: () => until(() => service.get(started.runId), value => terminal.has(value.status)) }; } };
}

test('real agent and scoped project tools keep a plan across automatic batches and persist only real receipts', async t => {
  const plan = [
    { id: 'read', label: '读取当前项目', kind: 'read', status: 'in_progress' },
    { id: 'edit', label: '保存新标题', kind: 'change', status: 'pending' },
  ];
  const f = await setup(t, (body, index, { app }) => {
    if (index === 0) return tool('assistant_plan', { items: plan });
    assert.equal(body.taskState.plan.items[0].id, 'read');
    if (index === 1) return tool('project_read');
    if (index <= 10) return tool('app_tool_schema', { names: [app.tools[index].name] });
    if (index === 11) return tool('project_update', { title: '已完成的新标题' });
    if (index === 12) {
      const readId = body.taskState.evidence.find(entry => entry.tool === 'project_read').id, writeId = body.taskState.evidence.find(entry => entry.role === 'execution').id;
      return tool('assistant_plan', { items: [{ ...plan[0], status: 'completed', evidenceIds: [readId] }, { ...plan[1], status: 'completed', evidenceIds: [writeId] }] });
    }
    return final('已保存项目标题，尚未做内容检查。');
  });
  const run = await f.start('请把项目标题改成已完成的新标题，先读取当前项目。'), result = await run.finish();
  assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal((await f.store.read(f.project.id)).title, '已完成的新标题');
  assert.ok(result.batch >= 2); assert.equal(result.plan.items.every(item => item.status === 'completed'), true); assert.equal(result.report.outcome, 'complete'); assert.equal(result.report.verified.length, 0); assert.equal(result.report.executed.length, 1);
  await f.service.close(); const saved = await readFile(path.join(f.directory, 'agent/assistant/runs.json'), 'utf8');
  assert.doesNotMatch(saved, /PRIVATE_FIXTURE_SOURCE_BODY|fixture-only-not-real-key/);
  const reopened = createAssistantAgentService({ dataDir: path.join(f.directory, 'agent') }); f.services.push(reopened);
  const restored = await reopened.get(run.runId); assert.deepEqual(restored.plan, result.plan); assert.deepEqual(restored.report, result.report); assert.equal(restored.evidence.entries.length, result.evidence.entries.length);
});

test('ask mode may maintain a plan but cannot gain write tools or invent plan evidence', async t => {
  const f = await setup(t, (_body, index) => [
    tool('assistant_plan', { items: [{ id: 'edit', label: '修改项目', kind: 'change', status: 'completed', evidenceIds: ['E99'] }] }),
    tool('project_update', { title: '不应写入' }), final('当前没有执行修改。'),
  ][index] || final());
  const result = await (await f.start('把标题改成新标题', { mode: 'ask' })).finish();
  assert.equal((await f.store.read(f.project.id)).title, '原始标题'); assert.equal(f.requests[0].tools.some(value => value.mutating), false);
  assert.equal(result.evidence.entries.some(entry => entry.role === 'execution'), false); assert.ok(result.steps.some(step => step.tool === 'assistant_plan' && step.status === 'failed'));
});

test('pure answer has no forced plan, write, or validation', async t => {
  const f = await setup(t, () => final('可以先比较两个段落的主旨。'));
  const result = await (await f.start('怎么比较段落的主旨？')).finish(); assert.equal(result.totalToolCalls, 0); assert.equal(result.plan, undefined); assert.equal(result.report.outcome, 'answer'); assert.equal(result.report.executed.length, 0);
});

for (const [instruction, allowed] of [
  ['读取当前项目，并把标题改成明确的新标题。', true],
  ['先阅读当前材料，然后将项目标题修改为明确的新标题。', true],
  ['查看当前项目；接着把标题改成明确的新标题。', true],
  ['请讲解如何读取项目并把标题改成新标题。', false],
  ['请解释如何读取项目，并把标题改成新标题。', false],
  ['只读取当前项目，并把标题改成新标题。', false],
  ['读取当前项目，并把标题修改的方法告诉我。', false],
  ['读取当前项目，并把标题不要改成新标题。', false],
  ['请解释“读取当前项目，并把标题改成新标题”的意思。', false],
  ['请解释下面的代码：`读取当前项目，并把标题改成新标题`。', false],
]) test(`read followed by targeted edit respects the actual user intent: ${instruction}`, async t => {
  const f = await setup(t, (_body, index) => index ? final('隔离意图测试结束。') : tool('project_update', { title: '明确的新标题' }));
  const result = await (await f.start(instruction)).finish();
  assert.equal(f.requests[0].tools.some(value => value.name === 'project_update'), allowed);
  assert.equal((await f.store.read(f.project.id)).title, allowed ? '明确的新标题' : '原始标题');
  assert.equal(result.report.executed.length > 0, allowed);
});

test('ask mode keeps a separate read-then-edit imperative read-only', async t => {
  const f = await setup(t, (_body, index) => index ? final('仅问答模式没有修改工程。') : tool('project_update', { title: '不应写入' }));
  const result = await (await f.start('读取当前项目，并把标题改成新标题。', { mode: 'ask' })).finish();
  assert.equal(f.requests[0].tools.some(value => value.mutating), false); assert.equal((await f.store.read(f.project.id)).title, '原始标题'); assert.equal(result.report.executed.length, 0);
});

test('a recoverable source failure exposes exact URL candidates and grants just one final correction chance', async t => {
  const url = 'https://www.bilibili.com/zh-Hant/video/BV16MJY6yEKq/?vd_source=0019a92b5765c2a04ee70311c2909d89', calls = [];
  const f = await setup(t, (body, index) => {
    assert.ok(body.allowedUserUrls.includes(url));
    if (index === 0) return tool('video_import_url', { url: url + '&guessed=1' });
    if (index === 1) { assert.equal(body.taskState.recovery.code, 'ASSISTANT_VIDEO_IMPORT_SOURCE'); return final('全部完成。'); }
    if (index === 2) { assert.match(body.progress.notice, /尚未完成/); return tool('video_import_url', { url: body.allowedUserUrls.find(value => value === url) }); }
    return final('已导入素材，尚未剪辑。');
  }, { extraTools: [{ name: 'video_import_url', mutating: true, inputSchema: { type: 'object', additionalProperties: false, required: ['url'], properties: { url: { type: 'string' } } }, execute: async args => { calls.push(args.url); return { summary: '隔离fixture素材已登记', effects: [{ type: 'media', changed: true, importedAssetId: 'fixture-asset' }] }; } }] });
  const result = await (await f.start(`请导入${url}`)).finish(); assert.deepEqual(calls, [url]); assert.equal(result.report.outcome, 'complete'); assert.equal(result.totalModelCalls, 4); assert.equal(result.steps.filter(step => step.status === 'failed').length, 1);
});

test('invalid real project tool parameters can be corrected, while committed writes stay actual', async t => {
  const f = await setup(t, (_body, index) => [tool('project_update', { title: 42 }), final('已完成全部修改。'), tool('app_tool_schema', { names: ['project_update'] }), tool('project_update', { title: '修正参数后的标题' }), final('已保存标题。')][index] || final());
  const result = await (await f.start('把项目标题改成修正参数后的标题')).finish(); assert.equal(result.report.outcome, 'complete'); assert.equal((await f.store.read(f.project.id)).title, '修正参数后的标题'); assert.equal(result.effects.length, 1); assert.equal(result.report.executed.length, 1); assert.equal(result.totalModelCalls, 5);
});

test('concurrent human changes remain protected; a false success final gets an actual partial preface', async t => {
  const f = await setup(t, async (_body, index, { store, project }) => {
    if (index === 0) return tool('project_update', { title: 'AI标题' });
    if (index === 1) { await store.patchMetadata(project.id, { title: '用户的并发标题' }); return tool('project_update', { title: 'AI标题' }); }
    return final('所有要求已完成。');
  });
  const result = await (await f.start('把项目标题改成AI标题')).finish(); assert.equal((await f.store.read(f.project.id)).title, '用户的并发标题'); assert.equal(result.report.outcome, 'partial'); assert.match(result.message, /^本次尚未全部完成/); assert.equal(result.totalModelCalls, 4); assert.equal(result.effects.length, 1); assert.ok(result.report.unfinished.some(item => item.code === 'ASSISTANT_CONFLICT'));
});

test('actual reads allow a no-change conclusion without a fabricated write', async t => {
  const f = await setup(t, (body, index) => index ? final('当前标题已符合要求，无需修改。', { noChangeNeeded: { evidenceIds: [body.taskState.evidence.find(entry => entry.tool === 'project_read').id], reason: '实际读到的标题已是原始标题。' } }) : tool('project_read'));
  const result = await (await f.start('把标题保持为原始标题，已是这个名字则不用再写。')).finish(); assert.equal(result.report.outcome, 'unchanged'); assert.deepEqual(result.report.executed, []); assert.equal((await f.store.read(f.project.id)).assistantRevision || 0, 0);
});

test('Stop preserves a real late commit receipt and does not continue the next model step', async t => {
  let release, committed; const gate = new Promise(resolve => { release = resolve; }), didCommit = new Promise(resolve => { committed = resolve; }); let appRef;
  const f = await setup(t, () => tool('late_fixture_commit'), { extraTools: [{ name: 'late_fixture_commit', mutating: true, execute: async (_args, ctx) => {
    const result = await appRef.tools.find(value => value.name === 'project_update').execute({ title: '已提交但确认较晚' }, ctx); committed(); await gate; return result;
  } }] }); appRef = f.app;
  const run = await f.start('保存项目标题'); await didCommit; const stopped = await f.service.cancel(run.runId); assert.equal(stopped.status, 'cancelled');
  release(); const result = await until(() => f.service.get(run.runId), value => value.report?.executed.length > 0);
  assert.equal((await f.store.read(f.project.id)).title, '已提交但确认较晚'); assert.equal(result.report.outcome, 'stopped'); assert.equal(result.effects.length, 1); assert.equal(result.totalModelCalls, 1); assert.ok(result.effects[0].undo.id);
});

test('a broken optional evidence extractor cannot turn an actual successful write into failure', async t => {
  const f = await setup(t, (_body, index) => index ? final('标题已保存。') : tool('project_update', { title: '实际保存标题' }), { transformTools: values => values.map(value => value.name === 'project_update' ? { ...value, evidence() { throw new Error('test-only unavailable metadata'); } } : value) });
  const result = await (await f.start('保存标题为实际保存标题')).finish(); assert.equal(result.status, 'completed'); assert.equal(result.report.outcome, 'complete'); assert.equal((await f.store.read(f.project.id)).title, '实际保存标题');
});

test('legacy completed run remains readable without a new empty ledger/report', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gx-legacy-plan-')), id = randomUUID(), stamp = new Date().toISOString();
  await mkdir(path.join(directory, 'assistant')); await writeFile(path.join(directory, 'assistant/runs.json'), JSON.stringify({ version: 1, jobs: [{ id, status: 'completed', message: '历史修改已完成。', instruction: '历史请求', steps: [], sources: [], effects: [{ type: 'project', changed: true, label: '历史修改' }], createdAt: stamp, updatedAt: stamp }] }));
  const service = createAssistantAgentService({ dataDir: directory }); t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const result = await service.get(id); assert.equal(result.message, '历史修改已完成。'); assert.equal(result.evidence, undefined); assert.equal(result.report, undefined); assert.equal(result.effects[0].label, '历史修改');
});
