import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { applyAssistantJob, assistantDetails, assistantTaskDetails } from '../public/assistant-client.js';
import { createProjectStore } from '../lib/store.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
function longJob(run = 0) {
  const entries = Array.from({ length: 240 }, (_, index) => ({ id: 'E' + (index + 1), role: ['read', 'execution', 'verification'][index % 3], kind: ['source_read', 'source_saved', 'compile_check'][index % 3], outcome: index % 3 === 2 ? 'passed' : 'completed', label: ['已读取当前工程中的真实源码和相关内容。', '已精确保存源文件修改，保留其余画面和素材。', '实际编译已经通过，检查仅代表对应源码版本。'][index % 3], revision: Math.floor(index / 3) + 1 }));
  const before = 'export const title = "旧标题";\n', after = 'export const title = "新标题";\n';
  return { id: 'test-run-' + run, projectId: 'history-budget-owner', status: 'completed', message: '已修改并检查当前工程。', totalToolCalls: 120, totalModelCalls: 121,
    steps: Array.from({ length: 120 }, (_, index) => ({ id: `step-${run}-${index}`, type: 'tool', tool: 'remotion_code_read', label: '读取实际源码，核对本次修改所需内容。', status: 'completed', startedAt: '2026-11-20T05:00:00Z', finishedAt: '2026-11-20T05:00:01Z' })), sources: [],
    effects: [{ type: 'remotion', projectId: 'history-budget-owner', label: '已修改源码', changed: true, undo: { kind: 'remotion-source', id: randomUUID() }, sourceChanges: { version: 1, remotionId: 'source-' + run, fromRevision: 1, toRevision: 2, format: 'actual-before-after-line-hunks', files: [{ path: 'src/Main.tsx', beforeSHA256: digest(before), afterSHA256: digest(after), replacements: 1, hunks: [{ oldStartLine: 1, oldEndLine: 1, newStartLine: 1, newEndLine: 1, before, after }] }], truncated: false } }],
    reportVersion: 1, evidence: { version: 1, total: 240, entries }, plan: { version: 1, items: [{ id: 'read', kind: 'read', label: '读取工程', status: 'completed', evidenceIds: ['E238'] }, { id: 'edit', kind: 'change', label: '修改工程', status: 'completed', evidenceIds: ['E239'] }, { id: 'check', kind: 'verify', label: '编译检查', status: 'completed', evidenceIds: ['E240'] }] },
    report: { version: 1, outcome: 'complete', executed: entries.filter(item => item.role === 'execution').slice(-20).map(item => item.id), verified: entries.filter(item => item.role === 'verification').slice(-20).map(item => item.id), unfinished: [] } };
}
const references = value => [...(value.plan?.items || []).flatMap(item => item.evidenceIds || []), ...(value.report?.executed || []), ...(value.report?.verified || []), ...(value.report?.noChangeNeeded?.evidenceIds || []), ...(value.report?.unfinished || []).map(item => item.evidenceId).filter(Boolean)];

test('a legal sixty-message history with thirty long jobs still saves in the real project store', async t => {
  const parent = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(parent, { recursive: true }); const directory = await mkdtemp(path.join(parent, 'gx-history-projection-')), store = await createProjectStore(directory), messages = [], originals = [];
  t.after(async () => { await store.settle(); assert.equal(path.dirname(directory), parent); await rm(directory, { recursive: true, force: true }); });
  for (let index = 0; index < 30; index++) {
    const job = longJob(index), reply = { id: 'reply-' + index, role: 'assistant', content: '', at: '2026-11-20T05:00:02Z' }; originals.push(job); applyAssistantJob(reply, job);
    messages.push({ id: 'user-' + index, role: 'user', content: '继续修改并检查当前工程。' }, reply);
  }
  const project = { kind: 'video', title: '隔离历史容量测试', source: { text: '' }, video: { timeline: [], captions: [], aspect: '16:9', script: '', assistantMessages: messages } };
  assert.ok(Buffer.byteLength(JSON.stringify(project, null, 2)) < 3 * 1024 * 1024);
  await store.save('history-budget-owner', project); const saved = JSON.parse(JSON.stringify(await store.read('history-budget-owner'))); assert.equal(saved.video.assistantMessages.length, 60);
  for (let index = 0; index < 30; index++) {
    const reply = saved.video.assistantMessages[index * 2 + 1], original = originals[index], ids = new Set(reply.evidence.entries.map(entry => entry.id));
    assert.ok(reply.evidence.entries.length <= 45); assert.equal(reply.evidence.total, 240); assert.equal(reply.evidence.omitted, 240 - reply.evidence.entries.length); assert.ok(references(original).every(id => ids.has(id)));
    assert.equal(reply.steps.length, 120); assert.deepEqual(reply.plan, original.plan); assert.deepEqual(reply.report.executed, original.report.executed); assert.deepEqual(reply.report.verified, original.report.verified);
    assert.equal(reply.effects[0].undo.id, original.effects[0].undo.id); assert.deepEqual(reply.effects[0].sourceChanges, messages[index * 2 + 1].effects[0].sourceChanges);
    const html = assistantDetails(reply); assert.match(html, /任务计划|已验证/); assert.match(html, /查看改动/); assert.match(html, /旧标题/); assert.match(html, /新标题/);
    assert.equal(original.evidence.entries.length, 240, 'Projection must not modify the backend job ledger');
  }
});

test('old plan, report, no-change and unfinished references survive independently of the recent tail', () => {
  const job = longJob(); job.evidence.entries[4] = { id: 'E5', role: 'failure', kind: 'tool_error', outcome: 'failed', label: '这项检查未完成' };
  job.plan.items = [{ id: 'read', kind: 'read', label: '已读取早期源码', status: 'completed', evidenceIds: ['E1'] }];
  job.report = { outcome: 'partial', executed: ['E2'], verified: ['E3'], noChangeNeeded: { evidenceIds: ['E4'], reason: '这部分源码已符合要求。' }, unfinished: [{ code: 'CHECK_FAILED', label: '这项检查未完成', evidenceId: 'E5', planId: 'read' }] };
  const before = JSON.stringify(job), message = {}; applyAssistantJob(message, job);
  const known = new Set(message.evidence.entries.map(entry => entry.id)); assert.ok(references(job).every(id => known.has(id))); assert.ok(message.evidence.entries.length <= 9);
  assert.deepEqual(message.report.noChangeNeeded, job.report.noChangeNeeded); assert.deepEqual(message.report.unfinished, job.report.unfinished); assert.equal(JSON.stringify(job), before);
  const restored = JSON.parse(JSON.stringify(message)), html = assistantTaskDetails(message); assert.equal(assistantTaskDetails(restored), html);
  const projectedAgain = {}; applyAssistantJob(projectedAgain, { ...message, id: job.id, status: 'completed' }); assert.deepEqual(projectedAgain.evidence, message.evidence); assert.deepEqual(projectedAgain.plan, message.plan); assert.deepEqual(projectedAgain.report, message.report);
});

test('live projection keeps a small tail and a later backend update can restore any newly referenced record', () => {
  const job = longJob(); job.status = 'running'; delete job.plan; delete job.report; const message = {}; applyAssistantJob(message, job);
  assert.deepEqual(message.evidence.entries.map(entry => entry.id), ['E237', 'E238', 'E239', 'E240']);
  job.plan = { items: [{ id: 'read-old', label: '核对早期真实读取', kind: 'read', status: 'completed', evidenceIds: ['E1'] }] }; applyAssistantJob(message, job);
  assert.ok(message.evidence.entries.some(entry => entry.id === 'E1')); assert.equal(message.evidence.entries.length, 5); assert.equal(job.evidence.entries.length, 240);
});
