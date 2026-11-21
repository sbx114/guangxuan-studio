import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { normalizeAssistantSourceChanges, assistantSourceChangeBytes, boundAssistantSourceChangeEffects } from '../public/assistant-source-diff-model.js';
import { assistantSourceDiffs, applyAssistantJob, assistantDetails } from '../public/assistant-client.js';
import { createAssistantAgentService } from '../lib/assistant-agent.mjs';
import { createProjectStore } from '../lib/store.mjs';
import { createRemotionProjectsService } from '../lib/remotion-projects.mjs';
import { createRemotionIntegration } from '../lib/remotion-integration.mjs';
import { createAssistantAppTools } from '../lib/assistant-app-tools.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const change = (before = '原始源码', after = '实际新源码', version = 1) => ({ version: 1, remotionId: 'actual-source', fromRevision: version, toRevision: version + 1, format: 'actual-before-after-line-hunks', files: [{ path: 'src/Main.tsx', beforeSHA256: digest(before), afterSHA256: digest(after), replacements: 1, addedLines: 1, removedLines: 1, hunks: [{ oldStartLine: 1, oldEndLine: 1, newStartLine: 1, newEndLine: 1, before, after }] }], truncated: false });
const wait = async (read, predicate) => { for (let count = 0; count < 1000; count++) { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('Diff fixture did not settle.'); };
const settings = { baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-only-not-real-secret', model: 'no-network' };

test('source differences have strict relative paths, hashes, versions and UTF-8 body bounds', () => {
  const raw = change('汉🙂'.repeat(8000), '改🙂'.repeat(8000)), safe = normalizeAssistantSourceChanges(raw);
  assert.ok(assistantSourceChangeBytes(safe) <= 12000); assert.ok(safe.files[0].hunks[0].before.length > 0 && safe.files[0].hunks[0].after.length > 0); assert.equal(safe.truncated, true); assert.doesNotMatch(JSON.stringify(safe), /�/);
  for (const value of ['C:/private/secret.tsx', '../outside.tsx', '/Users/private.tsx', 'src/../outside.tsx', 'node_modules/secret.ts', '.env.txt', 'package.json']) { const invalid = change(); invalid.files[0].path = value; assert.equal(normalizeAssistantSourceChanges(invalid), null); }
  const badHash = change(); badHash.files[0].beforeSHA256 = 'fake'; assert.equal(normalizeAssistantSourceChanges(badHash), null);
  assert.equal(normalizeAssistantSourceChanges({ ...change(), toRevision: 1 }), null);
});

test('all source text in one job stays bounded while old undo receipts and coordinates survive', () => {
  const effects = Array.from({ length: 5 }, (_, index) => ({ type: 'remotion', changed: true, undo: { kind: 'remotion-source', id: 'undo-' + index }, sourceChanges: change('甲'.repeat(3000), '乙'.repeat(3000), index + 1) }));
  const bounded = boundAssistantSourceChangeEffects(effects); assert.ok(bounded.reduce((sum, effect) => sum + assistantSourceChangeBytes(effect.sourceChanges), 0) <= 24000);
  assert.equal(bounded.length, effects.length); assert.deepEqual(bounded.map(effect => effect.undo), effects.map(effect => effect.undo)); assert.equal(bounded[0].sourceChanges.truncated, true); assert.equal(bounded[0].sourceChanges.files[0].hunks[0].oldStartLine, 1);
});

test('the client renders actual differences as escaped, collapsed text and retains long-line columns', () => {
  const diff = change('<script>window.diffInjected=1</script>', '<img src=x onerror=alert(1)>'); diff.files[0].hunks[0].oldStartColumn = 3001; diff.files[0].hunks[0].newStartColumn = 3001;
  const html = assistantSourceDiffs([{ type: 'remotion', sourceChanges: diff }]); assert.match(html, /查看改动/); assert.doesNotMatch(html, /data-assistant-source-diff open|<script>|<img /); assert.match(html, /&lt;script&gt;/); assert.match(html, /1:3001–1行/);
  assert.equal(assistantSourceDiffs([{ type: 'remotion', label: '旧修改记录' }]), '');
  const privateText = change('C:/Users/owner/private.tsx', 'Bearer abcdefghijklmnopq sk-abcdefghijklmnopq'); const safe = normalizeAssistantSourceChanges(privateText); assert.doesNotMatch(JSON.stringify(safe), /C:\/Users|abcdefghijklmnopq/);
});

test('the real agent retains bounded difference text, undo and secret redaction through persistence', async t => {
  const parent = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(parent, { recursive: true }); const directory = await mkdtemp(path.join(parent, 'gx-source-diff-'));
  let cursor = 0; const services = [], service = createAssistantAgentService({ dataDir: directory, modelStep: async () => ({ data: cursor < 4 ? { type: 'tool', tool: 'actual_fixture_write', arguments: { index: cursor++ }, summary: '保存隔离源码差异' } : { type: 'final', message: '源码已保存，尚未编译。', sourceIds: [] } }), appTools: [{ name: 'actual_fixture_write', mutating: true, execute: async ({ index }) => ({ summary: '已保存源码', effects: [{ type: 'remotion', projectId: 'fixture-project', changed: true, label: '已保存源码', undo: { kind: 'remotion-source', id: 'undo-' + index }, sourceChanges: change(settings.apiKey + '旧🙂'.repeat(3000), '新🙂'.repeat(3000), index + 1) }] }) }] }); services.push(service);
  t.after(async () => { await Promise.all(services.map(value => value.close())); assert.equal(path.dirname(directory), parent); await rm(directory, { recursive: true, force: true }); });
  const started = await service.start({ projectId: 'fixture-project', instruction: '修改当前源码', settings }), result = await wait(() => service.get(started.runId), value => value.status === 'completed');
  assert.equal(result.effects.length, 4); assert.ok(result.effects.every(effect => effect.undo?.id)); assert.ok(result.effects.reduce((sum, effect) => sum + assistantSourceChangeBytes(effect.sourceChanges), 0) <= 24000); assert.deepEqual(result.report.verified, []);
  await service.close(); const saved = await readFile(path.join(directory, 'assistant/runs.json'), 'utf8'); assert.doesNotMatch(saved, new RegExp(settings.apiKey));
  const reopened = createAssistantAgentService({ dataDir: directory }); services.push(reopened); const restored = await reopened.get(started.runId); assert.equal(restored.effects.length, 4); assert.deepEqual(restored.effects.map(value => value.undo), result.effects.map(value => value.undo)); assert.ok(restored.effects.reduce((sum, effect) => sum + assistantSourceChangeBytes(effect.sourceChanges), 0) <= 24000);
});

test('actual code patch → agent → persisted effect → shared client shows the committed source diff', async t => {
  const parent = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(parent, { recursive: true }); const directory = await mkdtemp(path.join(parent, 'gx-real-code-diff-')), root = path.resolve(import.meta.dirname, '..');
  const store = await createProjectStore(directory), project = await store.save('real-diff-project', { kind: 'video', title: '隔离差异工程', video: { timeline: [] } });
  const projects = await createRemotionProjectsService({ dataDir: directory, root }), remotion = createRemotionIntegration({ projects, store });
  const original = 'export const title = "原始标题";\r\nexport const opacity = 0.5;\r\n', source = await projects.create(project.id, { ownerCreatedAt: project.createdAt, files: [{ path: 'src/Main.tsx', content: original }] });
  const app = createAssistantAppTools({ store, remotion, remotionProjects: projects }); let cursor = 0;
  const service = createAssistantAgentService({ dataDir: path.join(directory, 'agent'), appTools: app.tools, buildContext: async () => ({ projectId: project.id }), modelStep: async () => ({ data: cursor++ === 0 ? { type: 'tool', tool: 'remotion_code_patch', arguments: { remotionId: source.id, expectedRevision: 1, patches: [{ path: 'src/Main.tsx', oldText: '"原始标题"', newText: '"真实提交的新标题"' }] }, summary: '精确修改标题文字' } : { type: 'final', message: '源码已保存，尚未编译或渲染。', sourceIds: [] } }) });
  const extraServices = []; t.after(async () => { await Promise.all([service, ...extraServices].map(value => value.close())); await app.close(); await remotion.close(); await projects.close(); await store.settle(); assert.equal(path.dirname(directory), parent); await rm(directory, { recursive: true, force: true }); });
  const started = await service.start({ projectId: project.id, instruction: '修改当前动画源码的标题文字，不用编译或渲染。', settings }), result = await wait(() => service.get(started.runId), value => ['completed', 'failed'].includes(value.status));
  assert.equal(result.status, 'completed', JSON.stringify(result)); const current = await projects.read(project.id, source.id); assert.equal(current.revision, 2); assert.equal(current.files[0].content, original.replace('原始标题', '真实提交的新标题'));
  const diff = result.effects[0].sourceChanges; assert.ok(diff); assert.equal(diff.fromRevision, 1); assert.equal(diff.toRevision, 2); assert.equal(diff.files[0].beforeSHA256, digest(original)); assert.equal(diff.files[0].afterSHA256, digest(current.files[0].content));
  const message = {}; applyAssistantJob(message, result); const html = assistantDetails(message); assert.match(html, /查看改动/); assert.match(html, /原始标题/); assert.match(html, /真实提交的新标题/); assert.deepEqual(result.report.verified, []); assert.ok(result.effects[0].undo.id);
  let undoCursor = 0; const undoService = createAssistantAgentService({ dataDir: path.join(directory, 'undo-agent'), appTools: app.tools, buildContext: async () => ({ projectId: project.id }), modelStep: async () => ({ data: undoCursor++ === 0 ? { type: 'tool', tool: 'assistant_undo_apply', arguments: { undoId: result.effects[0].undo.id }, summary: '撤销刚才的源码修改' } : { type: 'final', message: '源码已恢复。', sourceIds: [] } }) }); extraServices.push(undoService);
  const undoRun = await undoService.start({ projectId: project.id, instruction: '撤销刚才的源码修改', settings }), undoResult = await wait(() => undoService.get(undoRun.runId), value => ['completed', 'failed'].includes(value.status));
  assert.equal(undoResult.report.outcome, 'complete'); const restored = await projects.read(project.id, source.id); assert.equal(restored.revision, 3); assert.equal(restored.files[0].content, original); assert.ok(undoResult.evidence.entries.some(entry => entry.kind === 'undo_apply'));
});

test('a source difference arriving after Stop retains the real undo and text receipt', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gx-late-source-diff-')); let release, admitted; const gate = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { admitted = resolve; });
  const service = createAssistantAgentService({ dataDir: directory, modelStep: async () => ({ data: { type: 'tool', tool: 'late_source_write', arguments: {}, summary: '保存源码' } }), appTools: [{ name: 'late_source_write', mutating: true, execute: async () => { admitted(); await gate; return { effects: [{ type: 'remotion', changed: true, label: '源码已提交', undo: { kind: 'remotion-source', id: 'late-undo' }, sourceChanges: change() }] }; } }] });
  t.after(async () => { release(); await service.close(); await rm(directory, { recursive: true, force: true }); });
  const started = await service.start({ projectId: 'fixture-project', instruction: '修改源码', settings }); await entered; await service.cancel(started.runId); release(); const result = await wait(() => service.get(started.runId), value => value.effects.length === 1);
  assert.equal(result.report.outcome, 'stopped'); assert.equal(result.effects[0].undo.id, 'late-undo'); assert.equal(result.effects[0].sourceChanges.files[0].hunks[0].after, '实际新源码');
});
