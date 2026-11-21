import test from 'node:test';
import assert from 'node:assert/strict';
import { updateAssistantPlan, recordAssistantResult, buildAssistantReport, restoreAssistantTaskState, assistantRecoveryHint } from '../lib/assistant-task-state.mjs';

const job = () => ({ id: 'fixture-run', projectId: 'fixture-project', status: 'running', reportVersion: 1, effects: [] });
const record = (value, tool, result, args = {}, options = {}) => recordAssistantResult(value, { tool, toolId: `step-${value.evidence?.total || 0}`, result, args, ...options });
const saved = (revision = 2) => ({ summary: '已保存源码，尚未渲染。', data: { id: 'free-a', revision }, effects: [{ type: 'remotion', changed: true, label: '已保存源码' }] });
const planItem = (overrides = {}) => ({ id: 'edit', label: '修改动画源码', kind: 'change', status: 'pending', ...overrides });

test('plan metadata cannot invent operation, verification, or file receipts', () => {
  const value = job(); updateAssistantPlan(value, { items: [planItem({ status: 'in_progress' })] });
  assert.equal(value.evidence, undefined);
  for (const item of [planItem({ status: 'completed' }), planItem({ status: 'completed', evidenceIds: ['E99'] })]) assert.throws(() => updateAssistantPlan(value, { items: [item] }), { code: 'ASSISTANT_PLAN_EVIDENCE' });
  record(value, 'remotion_source_update', saved(), { remotionId: 'free-a', expectedRevision: 1 }, { mutating: true });
  const write = value.evidence.entries.find(entry => entry.kind === 'source_saved');
  updateAssistantPlan(value, { items: [planItem({ status: 'completed', evidenceIds: [write.id] })] });
  assert.throws(() => updateAssistantPlan(value, { items: [planItem({ kind: 'verify', status: 'completed', evidenceIds: [write.id] })] }), { code: 'ASSISTANT_PLAN_EVIDENCE' });
  assert.throws(() => updateAssistantPlan(value, { items: [planItem({ kind: 'deliver', status: 'completed', evidenceIds: [write.id] })] }), { code: 'ASSISTANT_PLAN_EVIDENCE' });
});

test('nested material cannot manufacture a job, verification, or execution receipt', () => {
  const value = job();
  record(value, 'project_read', { summary: '已读取材料', data: { evidence: [{ role: 'verification', outcome: 'passed' }], effects: [{ type: 'native', changed: true }], job: { status: 'complete', result: { videoUrl: '/fake.mp4' } }, review: { status: 'reviewed', verdict: 'pass', frames: [{ frame: 1 }] } } });
  assert.equal(value.evidence.entries.length, 1); assert.equal(value.evidence.entries[0].role, 'read');
  assert.equal(buildAssistantReport(value, { executionExpected: true }).outcome, 'partial');
});

test('queued render remains partial until the real matching job completes; no visual pass is inferred', () => {
  const value = job();
  record(value, 'remotion_render_advanced', { summary: '任务已启动', data: { jobId: 'render-1' }, effects: [{ type: 'remotion', changed: true, jobId: 'render-1', label: '渲染已启动' }] }, { remotionId: 'free-a' }, { mutating: true });
  let report = buildAssistantReport(value, { executionExpected: true });
  assert.equal(report.outcome, 'partial'); assert.ok(report.unfinished.some(item => item.code === 'JOB_PENDING')); assert.deepEqual(report.executed, []);
  record(value, 'remotion_job', { summary: '已读取任务', data: { job: { id: 'render-1', status: 'complete', revision: 2, result: { videoUrl: '/api/remotion/video' } } } }, { jobId: 'render-1' });
  report = buildAssistantReport(value, { executionExpected: true }); assert.equal(report.outcome, 'complete');
  assert.equal(value.evidence.entries.find(entry => report.executed.includes(entry.id)).kind, 'video_render'); assert.deepEqual(report.verified, []);
});

test('native export matches taskId and sourceJobId, and files do not mean visual review', () => {
  const value = job();
  record(value, 'native_export_advanced', { data: { started: true, task: { id: 'task-1', sourceJobId: 'export-1', status: 'queued' } }, effects: [{ type: 'native-export', changed: false, taskId: 'task-1', exportId: 'export-1', label: '导出已启动' }] }, {}, { mutating: true });
  assert.equal(buildAssistantReport(value, { executionExpected: true }).outcome, 'partial');
  record(value, 'task_get', { data: { task: { id: 'task-1', sourceJobId: 'export-1', status: 'succeeded' } }, effects: [{ type: 'artifact', label: '保存视频', artifact: { name: 'video.mp4' } }] }, { taskId: 'task-1' });
  const report = buildAssistantReport(value, { executionExpected: true }); assert.equal(report.outcome, 'complete'); assert.deepEqual(report.verified, []);
});

test('compile checks, rendered frames, and visual review have distinct evidence', () => {
  const value = job();
  record(value, 'remotion_inspect', { data: { compositions: [{ id: 'Main' }], revision: 2 } }, { remotionId: 'free-a' });
  assert.equal(value.evidence.entries.at(-1).kind, 'compile_check');
  record(value, 'remotion_review', { data: { status: 'unavailable', verdict: 'unknown', summary: '模型未接受图片', frames: [{ frame: 0 }], revision: 2 } }, { remotionId: 'free-a' });
  let report = buildAssistantReport(value); const kinds = report.verified.map(valueId => value.evidence.entries.find(entry => entry.id === valueId).kind);
  assert.deepEqual(kinds, ['compile_check', 'frame_render']); assert.equal(report.outcome, 'partial');
  record(value, 'remotion_review', { data: { status: 'reviewed', verdict: 'pass', summary: '采样图通过', frames: [{ frame: 0 }], revision: 2, limitations: '仅采样帧；未听音轨。' } }, { remotionId: 'free-a' });
  report = buildAssistantReport(value); assert.equal(report.outcome, 'answer'); assert.ok(report.verified.some(valueId => value.evidence.entries.find(entry => entry.id === valueId).kind === 'visual_review'));
});

test('later source edits expire earlier checks for the same source, preserving unrelated sources', () => {
  const value = job();
  record(value, 'remotion_inspect', { data: { compositions: [{ id: 'Main' }], revision: 1 } }, { remotionId: 'free-a' });
  const old = value.evidence.entries.at(-1);
  record(value, 'remotion_inspect', { data: { compositions: [{ id: 'Other' }], revision: 1 } }, { remotionId: 'free-b' });
  const other = value.evidence.entries.at(-1);
  updateAssistantPlan(value, { items: [planItem({ kind: 'verify', label: '检查源码', status: 'completed', evidenceIds: [old.id] })] });
  record(value, 'remotion_source_update', saved(2), { remotionId: 'free-a', expectedRevision: 1 }, { mutating: true });
  const report = buildAssistantReport(value, { executionExpected: true }); assert.equal(old.superseded, true); assert.equal(other.superseded, undefined);
  assert.ok(!report.verified.includes(old.id)); assert.ok(report.verified.includes(other.id)); assert.ok(report.unfinished.some(item => item.code === 'VERIFICATION_STALE'));
});

test('preflight blockage is an actual failed check even when the tool call returns normally', () => {
  const value = job(); record(value, 'native_export', { summary: '体检未通过', data: { started: false, report: { canExport: false, revision: 'r1', checks: { rendered: false } } } }, {}, { mutating: true });
  const report = buildAssistantReport(value, { executionExpected: true }); assert.equal(report.outcome, 'partial'); assert.ok(report.unfinished.some(item => item.code === 'CHECK_NOT_PASSED')); assert.deepEqual(report.executed, []);
});

test('pure answers need no tool or plan; no-change claims need actual state reads', () => {
  const value = job(); assert.equal(buildAssistantReport(value).outcome, 'answer');
  let report = buildAssistantReport(value, { executionExpected: true, final: { noChangeNeeded: { evidenceIds: ['E999'], reason: '已经符合' } } }); assert.equal(report.outcome, 'partial');
  record(value, 'app_capabilities', { summary: '能力目录' });
  report = buildAssistantReport(value, { executionExpected: true, final: { noChangeNeeded: { evidenceIds: [value.evidence.entries.at(-1).id] } } }); assert.equal(report.outcome, 'partial');
  record(value, 'native_read', { summary: '已读取当前60秒时间线', data: { duration: 60 } });
  report = buildAssistantReport(value, { executionExpected: true, final: { noChangeNeeded: { evidenceIds: [value.evidence.entries.at(-1).id], reason: '当前时长已是60秒' } } }); assert.equal(report.outcome, 'unchanged'); assert.deepEqual(report.executed, []);
});

test('real corrected errors clear, unrelated successes cannot hide failures', () => {
  const value = job(); recordAssistantResult(value, { tool: 'media_import_url', toolId: 'failed-1', error: { code: 'ASSISTANT_MEDIA_IMPORT_SOURCE', message: '地址不在候选内' } });
  record(value, 'project_read', { summary: '读到项目' }); assert.equal(buildAssistantReport(value).outcome, 'partial');
  record(value, 'media_import_url', { summary: '已导入', effects: [{ type: 'media', changed: true, importedAssetId: 'asset-1' }] }, {}, { mutating: true });
  assert.equal(buildAssistantReport(value, { executionExpected: true }).outcome, 'complete');
});

test('late receipt after Stop remains visible without marking the whole task completed', () => {
  const value = job(); value.status = 'cancelled'; value.error = { code: 'REQUEST_CANCELLED', message: '已停止后续操作' };
  record(value, 'native_adjust', { summary: '已修改', effects: [{ type: 'native', changed: true, undo: { id: 'undo-1' } }] }, {}, { mutating: true });
  const report = buildAssistantReport(value, { executionExpected: true }); assert.equal(report.outcome, 'stopped'); assert.equal(report.executed.length, 1);
});

test('bounded ledger preserves plan references, outstanding jobs, and execution checkpoints through long batches', () => {
  const value = job(); record(value, 'remotion_source_update', saved(), { remotionId: 'free-a' }, { mutating: true });
  const old = value.evidence.entries.find(entry => entry.kind === 'source_saved');
  updateAssistantPlan(value, { items: [planItem({ status: 'completed', evidenceIds: [old.id] })] });
  record(value, 'remotion_render_advanced', { data: { jobId: 'pending-job' }, effects: [{ type: 'remotion', jobId: 'pending-job', changed: true }] }, { remotionId: 'free-a' }, { mutating: true });
  for (let index = 0; index < 400; index++) record(value, 'project_read', { summary: `实际读取${index}` });
  assert.ok(value.evidence.entries.length <= 240); assert.ok(value.evidence.entries.some(entry => entry.id === old.id)); assert.ok(buildAssistantReport(value, { executionExpected: true }).unfinished.some(item => item.code === 'JOB_PENDING'));
  const restored = restoreAssistantTaskState(JSON.parse(JSON.stringify(value))); assert.equal(restored.plan.items[0].evidenceIds[0], old.id); assert.ok(restored.evidence.entries.some(entry => entry.id === old.id));
});

test('old completed jobs remain historical records, without invented new reports', () => {
  assert.deepEqual(restoreAssistantTaskState({ status: 'completed', effects: [{ type: 'native', changed: true }] }), {});
});

test('recovery hints use actual codes and never suggest altering URL parameters', () => {
  assert.match(assistantRecoveryHint({ code: 'ASSISTANT_MEDIA_IMPORT_SOURCE' }, 'media_import_url').action, /完整原样候选/);
  assert.match(assistantRecoveryHint({ code: 'REMOTION_REVISION_CONFLICT' }, 'remotion_source_update').action, /不能覆盖/);
  assert.equal(assistantRecoveryHint({ code: 'VIDEO_LOGIN_REQUIRED' }, 'media_import_url'), null);
});

test('a trusted source adapter can refine its receipt without duplicating a real source write', () => {
  const value = job(); recordAssistantResult(value, { tool: 'project_code_patch', toolId: 'actual-write', args: { remotionId: 'free-a' }, result: saved(2), mutating: true,
    trustedEvidence: [{ role: 'execution', kind: 'source_saved', outcome: 'completed', label: '已精确更新两处真实源代码', resourceKey: 'remotion:fixture-project:free-a', revision: 2, limitations: '源码已保存，尚未编译。', invalidates: true }] });
  const writes = value.evidence.entries.filter(entry => entry.role === 'execution'); assert.equal(writes.length, 1); assert.equal(writes[0].label, '已精确更新两处真实源代码'); assert.equal(writes[0].limitations, '源码已保存，尚未编译。');
});

test('a trusted no-op patch source read can support unchanged without inventing a write', () => {
  const value = job(); recordAssistantResult(value, { tool: 'remotion_code_patch', toolId: 'actual-readback', result: { data: { changed: false } }, mutating: true,
    trustedEvidence: [{ role: 'read', kind: 'source_read', outcome: 'completed', label: '实际源码已是目标内容', resourceKey: 'remotion:fixture-project:free-a', revision: 2 }] });
  const read = value.evidence.entries.find(entry => entry.kind === 'source_read'), report = buildAssistantReport(value, { executionExpected: true, final: { noChangeNeeded: { evidenceIds: [read.id], reason: '实际源码无需再写。' } } });
  assert.equal(report.outcome, 'unchanged'); assert.deepEqual(report.executed, []);
});

test('real undo acknowledgement expires earlier source checks and is an execution receipt', () => {
  const value = job(); record(value, 'remotion_inspect', { data: { compositions: [{ id: 'Main' }], revision: 2 } }, { remotionId: 'free-a' });
  const checked = value.evidence.entries.at(-1); record(value, 'assistant_undo_apply', { summary: '已撤销', data: { restored: true } }, {}, { mutating: true });
  const report = buildAssistantReport(value, { executionExpected: true }); assert.equal(checked.superseded, true); assert.deepEqual(report.verified, []); assert.equal(report.outcome, 'complete'); assert.equal(value.evidence.entries.at(-1).kind, 'undo_apply');
});

test('an unrelated project title change does not expire an immutable Remotion source check', () => {
  const value = job(); record(value, 'remotion_inspect', { data: { compositions: [{ id: 'Main' }], revision: 2 } }, { remotionId: 'free-a' }); const checked = value.evidence.entries.at(-1);
  record(value, 'project_update', { effects: [{ type: 'project', changed: true, label: '已修改项目标题' }] }, {}, { mutating: true });
  assert.equal(checked.superseded, undefined); assert.ok(buildAssistantReport(value, { executionExpected: true }).verified.includes(checked.id));
});

test('requested cancellation remains partial until the matching actual task reaches cancelled', () => {
  const value = job(); record(value, 'remotion_cancel', { data: { job: { id: 'render-1', status: 'running' } } }, { jobId: 'render-1' }, { mutating: true });
  assert.equal(buildAssistantReport(value, { executionExpected: true }).outcome, 'partial'); assert.ok(value.evidence.entries.some(entry => entry.kind === 'cancel_requested'));
  record(value, 'remotion_job', { data: { job: { id: 'render-1', status: 'cancelled' } } }, { jobId: 'render-1' });
  const report = buildAssistantReport(value, { executionExpected: true }); assert.equal(report.outcome, 'complete'); assert.deepEqual(report.verified, []); assert.ok(value.evidence.entries.some(entry => entry.kind === 'task_cancelled')); assert.equal(value.evidence.entries.some(entry => entry.kind === 'video_render'), false);
});

test('native and unified cancellation distinguish request acknowledgement from confirmed termination', () => {
  for (const [tool, data, args] of [
    ['native_export_cancel', { cancellationRequested: true, exportId: 'export-1', exports: [] }, { exportId: 'export-1' }],
    ['task_cancel', { task: { id: 'task-1', status: 'cancelling' } }, { taskId: 'task-1' }],
  ]) { const value = job(); record(value, tool, { data }, args, { mutating: true }); assert.equal(buildAssistantReport(value, { executionExpected: true }).outcome, 'partial'); }
  for (const [tool, data, args] of [
    ['native_export_cancel', { cancellationRequested: true, exportId: 'export-1', exports: [{ id: 'export-1', status: 'cancelled' }] }, { exportId: 'export-1' }],
    ['task_cancel', { task: { id: 'task-1', status: 'cancelled' } }, { taskId: 'task-1' }],
  ]) { const value = job(); record(value, tool, { data }, args, { mutating: true }); const report = buildAssistantReport(value, { executionExpected: true }); assert.equal(report.outcome, 'complete'); assert.deepEqual(report.verified, []); }
});

test('observing a new trusted source revision expires old compile and visual checks without rewriting a read plan', () => {
  const value = job(); record(value, 'remotion_code_read', { data: { remotionId: 'free-a', revision: 1 } }, { remotionId: 'free-a' }); const oldRead = value.evidence.entries.at(-1);
  updateAssistantPlan(value, { items: [planItem({ kind: 'read', label: '读取源码', status: 'completed', evidenceIds: [oldRead.id] })] });
  record(value, 'remotion_inspect', { data: { compositions: [{ id: 'Main' }], revision: 1 } }, { remotionId: 'free-a' }); const compile = value.evidence.entries.at(-1);
  record(value, 'remotion_review', { data: { status: 'reviewed', verdict: 'pass', frames: [{ frame: 0 }], revision: 1 } }, { remotionId: 'free-a' }); const visual = value.evidence.entries.at(-1);
  record(value, 'remotion_code_search', { data: { remotionId: 'free-a', revision: 2, matches: [] } }, { remotionId: 'free-a' }); const current = value.evidence.entries.at(-1);
  assert.equal(compile.superseded, true); assert.equal(visual.superseded, true); assert.equal(oldRead.stale, true); assert.equal(value.plan.items[0].status, 'completed');
  updateAssistantPlan(value, { items: value.plan.items });
  let report = buildAssistantReport(value, { executionExpected: true, final: { noChangeNeeded: { evidenceIds: [oldRead.id] } } }); assert.equal(report.outcome, 'partial'); assert.deepEqual(report.verified, []);
  report = buildAssistantReport(value, { executionExpected: true, final: { noChangeNeeded: { evidenceIds: [current.id], reason: '以实际新版本为准。' } } }); assert.equal(report.outcome, 'unchanged');
  const restored = restoreAssistantTaskState(JSON.parse(JSON.stringify(value))); assert.equal(restored.evidence.entries.find(entry => entry.id === oldRead.id).stale, true);
});

test('unversioned no-change claims require the latest state read while catalog access leaves it valid', () => {
  const value = job(); record(value, 'project_read', { summary: '旧标题' }); const old = value.evidence.entries.at(-1);
  record(value, 'project_read', { summary: '用户更新后的新标题' }); const current = value.evidence.entries.at(-1);
  assert.equal(old.stale, true); record(value, 'app_tool_schema', { summary: '真实工具schema' });
  assert.equal(buildAssistantReport(value, { executionExpected: true, final: { noChangeNeeded: { evidenceIds: [old.id] } } }).outcome, 'partial');
  assert.equal(buildAssistantReport(value, { executionExpected: true, final: { noChangeNeeded: { evidenceIds: [current.id] } } }).outcome, 'unchanged');
  record(value, 'project_update', { effects: [{ type: 'project', changed: true }] }, {}, { mutating: true }); assert.equal(current.stale, true);
  const report = buildAssistantReport(value, { final: { noChangeNeeded: { evidenceIds: [current.id] } } }); assert.equal(report.noChangeNeeded, undefined);
});

test('two actual reads of the same immutable source revision can both support the current state', () => {
  const value = job(); record(value, 'remotion_code_read', { data: { remotionId: 'free-a', revision: 2 } }, { remotionId: 'free-a' }); const first = value.evidence.entries.at(-1);
  record(value, 'remotion_code_search', { data: { remotionId: 'free-a', revision: 2 } }, { remotionId: 'free-a' });
  assert.equal(first.stale, undefined); assert.equal(buildAssistantReport(value, { executionExpected: true, final: { noChangeNeeded: { evidenceIds: [first.id] } } }).outcome, 'unchanged');
});
