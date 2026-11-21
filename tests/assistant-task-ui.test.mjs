import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAssistantJob, assistantDetails, assistantTaskDetails, assistantProgressText } from '../public/assistant-client.js';

const base = () => ({ id: 'fixture-run', status: 'completed', reportVersion: 1, totalToolCalls: 5, totalModelCalls: 6, steps: [], effects: [], sources: [], plan: { items: [
  { id: 'save', label: '保存源码', kind: 'change', status: 'completed', evidenceIds: ['E1'] },
  { id: 'verify', label: '编译并检查画面', kind: 'verify', status: 'in_progress' },
  { id: 'export', label: '导出视频', kind: 'deliver', status: 'pending' },
] }, evidence: { total: 3, entries: [
  { id: 'E1', role: 'execution', kind: 'source_saved', outcome: 'completed', label: '真实源码版本已保存' },
  { id: 'E2', role: 'verification', kind: 'compile_check', outcome: 'passed', label: '编译检查已通过', limitations: '只证明编译；未检查画面或音轨。' },
  { id: 'E3', role: 'verification', kind: 'visual_review', outcome: 'unavailable', label: '图片模型不可用' },
] }, report: { outcome: 'partial', executed: ['E1'], verified: ['E2', 'E3'], unfinished: [{ code: 'CHECK_NOT_PASSED', label: '画面尚未复核；视频尚未导出。' }] } });

test('shared client shows a live plan, then separates real executions, successful checks, and unfinished work', () => {
  const value = base(), message = {}; applyAssistantJob(message, value);
  const html = assistantDetails(message); assert.match(html, /任务计划/); assert.match(html, /is-completed/); assert.match(html, /is-in_progress/); assert.match(html, /is-pending/);
  assert.match(html, /本次结果 · 部分完成/); assert.match(html, />已执行</); assert.match(html, />已验证</); assert.match(html, />未完成</); assert.match(html, /data-evidence-kind="source_saved"/); assert.match(html, /data-evidence-kind="compile_check"/); assert.doesNotMatch(html, /data-evidence-kind="visual_review"/);
  assert.match(assistantProgressText(message), /尚有未完成项/); assert.doesNotMatch(assistantProgressText(message), /处理完成/);
  value.status = 'running'; applyAssistantJob(message, value); const live = assistantDetails(message); assert.match(live, /data-assistant-plan/); assert.doesNotMatch(live, /data-assistant-report/);
});

test('source saving, frame capture, visual review, video completion, and timeline apply retain distinct labels', () => {
  const value = base(); value.plan.items = [];
  const kinds = ['source_saved', 'compile_check', 'frame_render', 'visual_review', 'video_render', 'timeline_apply'];
  value.evidence.entries = kinds.map((kind, index) => ({ id: `E${index + 1}`, role: ['compile_check', 'frame_render', 'visual_review'].includes(kind) ? 'verification' : 'execution', kind, outcome: ['compile_check', 'frame_render', 'visual_review'].includes(kind) ? 'passed' : 'completed', label: `真实结果${index + 1}` }));
  value.report = { outcome: 'complete', executed: ['E1', 'E5', 'E6'], verified: ['E2', 'E3', 'E4'], unfinished: [] };
  const message = {}; applyAssistantJob(message, value); const html = assistantDetails(message);
  for (const label of ['源码保存', '编译检查', '实际取帧', '画面复核', '视频渲染', '加入或修改时间线']) assert.ok(html.includes(label));
});

test('labels are escaped and mismatched or stale verification references cannot become success badges', () => {
  const value = base(); value.plan.items[0].label = '<img src=x onerror=alert(1)>'; value.evidence.entries[1].superseded = true;
  value.evidence.entries[0].label = '<script>bad()</script>'; value.report.verified = ['E1', 'E2', 'E3', 'E999'];
  const message = {}; applyAssistantJob(message, value); const html = assistantDetails(message);
  assert.deepEqual(message.report.verified, []); assert.doesNotMatch(html, /<img |<script>|>已验证</); assert.match(html, /&lt;img/); assert.match(html, /&lt;script/);
});

test('new structured message survives JSON session storage and retains artifact cards', () => {
  const value = base(); value.effects = [{ type: 'artifact', projectId: 'fixture-project', label: '文件已生成', artifact: { name: 'result.txt', downloadUrl: '/api/assistant/exports/12345678-1234-4234-8234-123456789abc/file', kind: 'document' } }]; value.projectId = 'fixture-project';
  const message = {}; applyAssistantJob(message, value); const restored = JSON.parse(JSON.stringify(message));
  assert.equal(assistantDetails(restored), assistantDetails(message)); assert.deepEqual(restored.plan, message.plan); assert.deepEqual(restored.report, message.report); assert.match(assistantDetails(restored), /data-assistant-artifact/); assert.match(assistantDetails(restored), /result\.txt/);
});

test('legacy messages remain readable without invented empty execution reports', () => {
  for (const value of [
    { status: 'complete', content: '历史回复', steps: [], effects: [], sources: [] },
    { status: 'working', totalToolCalls: 14, batch: 2, steps: [{ type: 'tool', status: 'completed', label: '历史读取', message: '已读取' }], effects: [], sources: [] },
    { status: 'error', steps: [], effects: [{ type: 'project', label: '历史保存结果' }], sources: [{ id: 'S1', url: 'https://example.org/article', title: '历史来源' }] },
  ]) {
    const html = assistantDetails(value); assert.equal(assistantTaskDetails(value), ''); assert.doesNotMatch(html, /data-assistant-plan|data-assistant-report|暂无额外检查记录|尚无对应写入/);
    if (value.effects.length) assert.match(html, /历史保存结果/);
    if (value.sources.length) assert.match(html, /历史来源/);
    if (value.steps.length) assert.match(html, /历史读取/);
  }
});

test('pure answer has no unnecessary plan/report section', () => {
  const value = base(); value.plan.items = []; value.evidence.entries = []; value.report = { outcome: 'answer', executed: [], verified: [], unfinished: [] };
  const message = {}; applyAssistantJob(message, value); assert.equal(assistantTaskDetails(message), '');
});
