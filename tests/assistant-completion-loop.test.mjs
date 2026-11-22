import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import { createAssistantAgentService } from '../lib/assistant-agent.mjs';

const PROJECT = 'completion-fixture', SOURCE = 'existing-source';
const action = (tool, args = {}) => ({ type: 'tool', tool, arguments: args, summary: '执行当前已授权任务' });
const final = () => ({ type: 'final', message: '已保存产物；请以后自行修复建议。', sourceIds: [] });
const issue = { severity: 'blocking', frame: 30, evidenceFrames: [30, 60], category: 'motion', detail: '汇聚光迹方向相反', fix: '修正当前光迹的运动方向', action: { file: 'src/main.tsx', component: 'Trail', operation: 'adjust-source', instruction: '修正当前光迹的运动方向' } };
const need = { kind: 'ending', times: [28, 29.9], reason: '核对已要求的尾部淡出', required: true };
async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gx-completion-loop-'));
  const state = { revision: 4, scope: { placement: { mode: 'append' } }, calls: [], inputs: [], appendCount: 0, reviews: 0, modelCalls: 0,
    timeline: [{ id: 'protected-original', at: 0, duration: 15, revision: 1 }, { id: 'requested-result', at: 15, duration: 30, revision: 4 }] };
  const save = () => writeFile(path.join(directory, 'actual-fixture-state.json'), JSON.stringify({ revision: state.revision, timeline: state.timeline }));
  await save();
  const review = (verdict = 'revise', extra = {}) => ({ status: verdict === 'unknown' ? 'unavailable' : 'reviewed', verdict, revision: state.revision,
    frames: [{ frame: 30, time: 1 }, { frame: 60, time: 2 }, ...(verdict === 'pass' ? [{ frame: 840, time: 28 }, { frame: 897, time: 29.9 }] : [])],
    sampleGroups: verdict === 'pass' ? [{ kind: 'ending', frames: [840, 897] }] : [], summary: verdict === 'pass' ? '当前版本的所列必要检查通过' : '已看到需要修正的光迹问题，尾部需要补采样',
    issues: verdict === 'revise' ? [issue] : [], verificationNeeds: verdict === 'revise' ? [need] : [], limitations: ['只核验所列采样图，未听音频。'], ...extra });
  const schema = { type: 'object' };
  const sourceData = extra => ({ remotionId: SOURCE, revision: state.revision, ...extra });
  const tools = [
    { name: 'remotion_edit', mutating: true, inputSchema: schema, execute: async args => {
      state.calls.push(['remotion_edit', { ...args }]);
      if (state.calls.filter(call => call[0] === 'remotion_edit').length > 1) state.revision++;
      if (args.append === true) state.appendCount++;
      await save();
      return { summary: '已有产物和复核记录', data: sourceData({ review: review(options.unavailable ? 'unknown' : 'revise', options.initialReviewExtra) }), effects: [{ type: args.append === true ? 'native' : 'remotion', projectId: PROJECT, changed: true, label: '当前结果已保存' }] };
    } },
    { name: 'remotion_code_patch', mutating: true, inputSchema: schema, execute: async args => { state.calls.push(['remotion_code_patch', args]); state.revision++; await save(); return { summary: '当前源码已实际写入隔离夹具', data: sourceData(), effects: [{ type: 'remotion', changed: true, projectId: PROJECT }] }; } },
    { name: 'remotion_review', inputSchema: schema, execute: async args => { state.calls.push(['remotion_review', args]); state.reviews++; return { summary: '真实注册的复核接口结果', data: review(options.stillIssues ? 'revise' : 'pass', options.reviewExtra) }; } },
    { name: 'native_read', inputSchema: schema, execute: async () => ({ summary: '读取当前隔离时间线', data: { timeline: state.timeline, revision: 'native-1', duration: 45 } }) },
    { name: 'native_scope_set', inputSchema: schema, execute: async args => { state.scope = args; return { summary: '已定位当前结果的实际区间', data: { scope: args } }; } },
    { name: 'remotion_render', mutating: true, inputSchema: schema, execute: async args => {
      state.calls.push(['remotion_render', { ...args }]);
      if (args.append === true) { if (state.scope.placement.mode === 'range') state.timeline[1].revision = state.revision; else { state.appendCount++; state.timeline.push({ id: 'unwanted-duplicate', revision: state.revision }); } }
      await save();
      const jobId = 'render-' + state.revision;
      return { summary: '当前版本渲染结果', data: sourceData({ job: { id: jobId, projectId: PROJECT, remotionId: SOURCE, revision: state.revision, kind: 'video', status: 'complete', result: { videoUrl: `/api/projects/${PROJECT}/remotion/jobs/${jobId}/files/video.mp4` } } }), effects: args.append ? [{ type: 'native', projectId: PROJECT, changed: true }] : [] };
    } },
  ];
  tools.push({ name: 'remotion_append', mutating: true, inputSchema: schema, execute: async args => {
    state.calls.push(['remotion_append', args]);
    if (state.scope.placement.mode === 'range') state.timeline[1].revision = state.revision;
    else { state.appendCount++; state.timeline.push({ id: 'unwanted-duplicate', revision: state.revision }); }
    await save(); return { summary: '已更新对应区间的渲染结果', data: sourceData(), effects: [{ type: 'native', projectId: PROJECT, changed: true }] };
  } });
  tools.push({ name: 'remotion_read', inputSchema: schema, execute: async args => ({ summary: '读取另一份已登记源码', data: { id: args.remotionId, revision: args.remotionId === SOURCE ? state.revision : 7 } }) });
  const service = createAssistantAgentService({ dataDir: directory, appTools: tools, buildContext: async () => ({}), modelStep: async (_system, user) => {
    state.inputs.push(JSON.parse(user)); state.modelCalls++; return { data: await options.model(state) };
  } });
  const stateStarted = new Promise(resolve => { state.started = resolve; });
  t.after(async () => { await service.close(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); await rm(directory, { recursive: true, force: true }); });
  async function run() {
    const started = await service.start({ projectId: PROJECT, instruction: options.instruction || '增强动效和电影感', editScope: state.scope, settings: { baseUrl: 'https://fixture-never-contacted.invalid', model: 'injected-local-fixture', apiKey: 'fixture-not-a-real-key' } });
    state.started(started.runId);
    for (let count = 0; count < 1000; count++) { const job = await service.get(started.runId); if (['completed', 'failed', 'cancelled'].includes(job.status)) return job; await pause(5); }
    throw new Error('Completion fixture did not settle.');
  }
  return { state, service, run, stateStarted, readState: async () => JSON.parse(await readFile(path.join(directory, 'actual-fixture-state.json'), 'utf8')) };
}

test('a real-shaped issues result rejects early finals, patches, rechecks and replaces the existing result once', async t => {
  const sequence = [action('remotion_edit', { remotionId: SOURCE, append: true }), final(), action('remotion_code_patch', { remotionId: SOURCE }), final(), action('remotion_review', { remotionId: SOURCE, expectedRevision: 5 }), final(), action('native_read'), action('native_scope_set', { placement: { mode: 'range', start: 15, end: 45 } }), action('remotion_render', { remotionId: SOURCE, expectedRevision: 5, append: true }), final()];
  const f = await fixture(t, { model: state => sequence[state.modelCalls - 1] || final() }), job = await f.run();
  assert.equal(job.status, 'completed', JSON.stringify(job)); assert.equal(job.report.outcome, 'complete');
  assert.equal(f.state.modelCalls, sequence.length); assert.equal(f.state.appendCount, 1);
  assert.deepEqual((await f.readState()).timeline, [{ id: 'protected-original', at: 0, duration: 15, revision: 1 }, { id: 'requested-result', at: 15, duration: 30, revision: 5 }]);
  const recovery = f.state.inputs[2].taskState.completionRecovery;
  assert.equal(recovery.checks[0].remotionId, SOURCE); assert.equal(recovery.checks[0].revision, 4);
  assert.equal(recovery.checks[0].issues[0].action.component, 'Trail');
  assert.deepEqual(recovery.checks[0].samplingRequests, [{ kind: 'action', times: [1, 2], reason: issue.fix }, { kind: 'ending', times: [28, 29.9], reason: need.reason }]);
  assert.equal('required' in recovery.checks[0].samplingRequests[0], false);
});

test('a repeated repair call cannot append another copy while still in append placement', async t => {
  const sequence = [action('remotion_edit', { remotionId: SOURCE, append: true }), final(), action('remotion_edit', { remotionId: SOURCE, expectedRevision: 4, append: true }), action('remotion_review', { remotionId: SOURCE, expectedRevision: 5 }), action('native_scope_set', { placement: { mode: 'range', start: 15, end: 45 } }), action('remotion_render', { remotionId: SOURCE, expectedRevision: 5, append: true }), final()];
  const f = await fixture(t, { model: state => sequence[state.modelCalls - 1] || final() }), job = await f.run();
  assert.equal(job.report.outcome, 'complete', JSON.stringify(job)); assert.equal(f.state.appendCount, 1);
  assert.equal(f.state.calls.filter(call => call[0] === 'remotion_edit')[1][1].append, false);
});

test('the append reuse API must first target the existing result range during recovery', async t => {
  const sequence = [action('remotion_edit', { remotionId: SOURCE, append: true }), final(), action('remotion_code_patch', { remotionId: SOURCE }), action('remotion_review', { remotionId: SOURCE, expectedRevision: 5 }), action('remotion_render', { remotionId: SOURCE, expectedRevision: 5, append: false }), action('remotion_append', { remotionId: SOURCE, expectedRevision: 5, jobId: 'render-5' }), action('native_scope_set', { placement: { mode: 'range', start: 15, end: 45 } }), action('remotion_append', { remotionId: SOURCE, expectedRevision: 5, jobId: 'render-5' }), final()];
  const f = await fixture(t, { model: state => sequence[state.modelCalls - 1] || final() }), job = await f.run();
  assert.equal(job.report.outcome, 'complete', JSON.stringify(job)); assert.equal(f.state.appendCount, 1);
  assert.equal(f.state.calls.filter(call => call[0] === 'remotion_append').length, 1);
  assert.equal(job.steps.filter(step => step.tool === 'remotion_append')[0].status, 'failed');
  assert.equal((await f.readState()).timeline[1].revision, 5);
});

test('reading another source cannot hide the original repaired source delivery still pending', async t => {
  const sequence = [action('remotion_edit', { remotionId: SOURCE, append: true }), final(), action('remotion_code_patch', { remotionId: SOURCE }), action('remotion_review', { remotionId: SOURCE, expectedRevision: 5 }), action('remotion_read', { remotionId: 'another-source' }), final()];
  const f = await fixture(t, { model: state => sequence[state.modelCalls - 1] || final() }), job = await f.run();
  assert.equal(job.status, 'failed'); assert.equal(job.error.code, 'ASSISTANT_VERIFICATION_NO_PROGRESS');
  assert.equal(f.state.appendCount, 1); assert.equal((await f.readState()).timeline[1].revision, 4);
});

test('repeated finals with an unresolved actionable issue stop as explicit no-progress rather than completed partial', async t => {
  const f = await fixture(t, { model: state => state.modelCalls === 1 ? action('remotion_edit', { remotionId: SOURCE, append: true }) : final() }), job = await f.run();
  assert.equal(job.status, 'failed'); assert.equal(job.error.code, 'ASSISTANT_VERIFICATION_NO_PROGRESS'); assert.equal(job.report.outcome, 'partial'); assert.equal(f.state.modelCalls, 4); assert.equal(f.state.appendCount, 1);
});

test('a genuinely unavailable visual service remains partial without editing or replaying the saved result', async t => {
  const f = await fixture(t, { unavailable: true, model: state => state.modelCalls === 1 ? action('remotion_edit', { remotionId: SOURCE, append: true }) : final() }), job = await f.run();
  assert.equal(job.report.outcome, 'partial'); assert.equal(f.state.modelCalls, 2); assert.equal(f.state.calls.length, 1);
});

test('an actual review pass with ordinary sampling/audio limitations creates no repair obligation', async t => {
  const sequence = [action('remotion_edit', { remotionId: SOURCE, append: true }), action('remotion_review', { remotionId: SOURCE, expectedRevision: 4 }), final()];
  const f = await fixture(t, { model: state => sequence[state.modelCalls - 1] || final() }), job = await f.run();
  assert.equal(job.report.outcome, 'complete', JSON.stringify(job)); assert.equal(f.state.modelCalls, 3); assert.equal(f.state.reviews, 1);
});

test('four unchanged actionable reviews stop a repair loop even when source revision numbers keep changing', async t => {
  const f = await fixture(t, { stillIssues: true, model: state => state.modelCalls === 1 ? action('remotion_edit', { remotionId: SOURCE, append: true }) : state.modelCalls % 2 === 0 ? action('remotion_code_patch', { remotionId: SOURCE }) : action('remotion_review', { remotionId: SOURCE, expectedRevision: state.revision }) }), job = await f.run();
  assert.equal(job.status, 'failed'); assert.equal(job.error.code, 'ASSISTANT_VERIFICATION_NO_PROGRESS'); assert.equal(f.state.reviews, 3); assert.equal(f.state.appendCount, 1);
});

test('a concrete missing sample request is recoverable even when the reviewed verdict is unknown', async t => {
  const sequence = [action('remotion_edit', { remotionId: SOURCE, append: true }), final(), action('remotion_review', { remotionId: SOURCE, expectedRevision: 4, samplingRequests: [{ kind: 'ending', times: need.times, reason: need.reason }] }), final()];
  const f = await fixture(t, { initialReviewExtra: { status: 'reviewed', verdict: 'unknown', issues: [] }, model: state => sequence[state.modelCalls - 1] || final() }), job = await f.run();
  assert.equal(job.report.outcome, 'complete', JSON.stringify(job)); assert.equal(f.state.modelCalls, 4); assert.equal(f.state.calls.filter(call => call[0] === 'remotion_edit').length, 1);
});

test('a same-version pass from unrelated frames does not terminate the still-needed known-issue repair', async t => {
  const sequence = [action('remotion_edit', { remotionId: SOURCE, append: true }), action('remotion_review', { remotionId: SOURCE, expectedRevision: 4 }), final()];
  const f = await fixture(t, { reviewExtra: { frames: [{ frame: 180, time: 6 }, { frame: 210, time: 7 }], sampleGroups: [] }, model: state => sequence[state.modelCalls - 1] || final() }), job = await f.run();
  assert.equal(job.status, 'failed'); assert.equal(job.error.code, 'ASSISTANT_VERIFICATION_NO_PROGRESS');
  assert.equal(f.state.inputs[3].taskState.completionRecovery.checks.some(check => check.issues.some(item => item.frame === 30)), true);
});

test('large legal feedback retains resource/frame actions and marks model-input omissions while the ledger keeps full details', async t => {
  const issues = Array.from({ length: 24 }, () => ({ ...issue, detail: '已观察到的细节'.repeat(140), fix: '需修正此处'.repeat(160), action: { ...issue.action, instruction: '按源组件修正'.repeat(140) } }));
  const f = await fixture(t, { initialReviewExtra: { issues }, model: state => state.modelCalls === 1 ? action('remotion_edit', { remotionId: SOURCE, append: true }) : final() }), job = await f.run();
  const input = f.state.inputs[1], context = input.taskState.completionRecovery.checks[0];
  assert.equal(context.totalIssues, 24); assert.equal(context.issues.length, 8); assert.equal(context.detailsIncomplete, true); assert.equal(context.issues[0].action.file, 'src/main.tsx');
  assert.ok(f.state.inputs.every(value => JSON.stringify(value).length < 170000));
  assert.equal(job.evidence.entries.find(entry => entry.kind === 'visual_review').issues.length, 24);
});

test('stop during the recovery turn preserves the first receipt and performs no corrective write', async t => {
  let notifyRecovery; const recovering = new Promise(resolve => { notifyRecovery = resolve; });
  const f = await fixture(t, { model: state => { if (state.modelCalls === 1) return action('remotion_edit', { remotionId: SOURCE, append: true }); if (state.modelCalls === 2) return final(); notifyRecovery(); return new Promise(() => {}); } });
  const pending = f.run(), id = await f.stateStarted; await recovering; await f.service.cancel(id); const job = await pending;
  assert.equal(job.status, 'cancelled'); assert.equal(f.state.appendCount, 1); assert.equal(f.state.calls.length, 1); assert.ok(job.evidence.entries.some(entry => entry.role === 'execution'));
});
