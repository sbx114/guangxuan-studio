import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createProjectStore, assistantContentHash } from '../lib/store.mjs';
import { createRemotionProjectsService } from '../lib/remotion-projects.mjs';
import { createRemotionIntegration } from '../lib/remotion-integration.mjs';
import { createTaskService } from '../lib/tasks.mjs';
import { createProductionCapabilityTools, restoreProductionUndo } from '../lib/assistant-production-tools.mjs';
import { createAssistantAppTools } from '../lib/assistant-app-tools.mjs';
import { AppError } from '../lib/errors.mjs';

const code = wanted => error => error.code === wanted;
async function fixture(t, { undoBytes = Infinity } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'gx-production-tools-'));
  const store = await createProjectStore(dataDir), project = await store.save('current-project', { kind: 'video', title: '当前工程', video: { timeline: [] } });
  const state = { hash: assistantContentHash(project), createdAt: project.createdAt, scope: { assetIds: ['allowed'], placement: { mode: 'range', start: 2, end: 4 } } };
  const assetFile = path.join(dataDir, 'fixture.png'); await writeFile(assetFile, Buffer.from([137, 80, 78, 71]));
  const projects = await createRemotionProjectsService({ dataDir, root: process.cwd(), resolveAsset: async (_projectId, assetId) => ({ id: assetId, name: 'fixture.png', path: assetFile, type: 'image' }) });
  const tasks = await createTaskService({ dataDir });
  const calls = [], undos = [], native = { revision: '0123456789abcdef', assets: [{ id: 'allowed', name: '可用.png', type: 'image' }, { id: 'other', name: '未选.png', type: 'image' }], timeline: [], duration: 10 };
  const owner = async ctx => { const value = await store.read(ctx.projectId); if (!value) throw new AppError(404, '不存在', 'PROJECT_NOT_FOUND'); return value; };
  const current = async ctx => { const value = await owner(ctx); if (state.conflicted || assistantContentHash(value) !== state.hash) throw new AppError(409, '并发修改', 'ASSISTANT_CONFLICT'); return value; };
  const readNative = async ctx => { await current(ctx); if (state.nativeRevision && state.nativeRevision !== native.revision) throw new AppError(409, '时间线已变', 'OPENFILM_REVISION_CONFLICT'); state.nativeRevision = native.revision; return native; };
  const openFilm = { context: async () => native, exportVideo: async (...args) => { calls.push(['export', ...args]); return { export: { id: 'native-job', status: 'waiting', progress: 0 } }; }, exportNative: async (...args) => { calls.push(['advanced-export', ...args]); return { export: { id: 'advanced-job', kind: args[1].kind, status: 'waiting', progress: 0 } }; }, cancelNativeExport: async (...args) => { calls.push(['cancel-native-export', ...args]); return { projectId: args[0], exportId: args[1], cancellationRequested: true, exports: [] }; }, operateClips: async (...args) => { calls.push(['operations', ...args]); return { revision: 'abcdef0123456789', undo: { id: 'native-operation-undo' }, results: [{ action: args[1][0].action }] }; } };
  const integration = createRemotionIntegration({ projects, store, openFilm });
  const remotion = { ...integration, inspect: async (...args) => { calls.push(['inspect', ...args]); return { compositions: [{ id: 'Main', fps: 24, durationInFrames: 240 }] }; }, start: async (...args) => { calls.push(['render', ...args]); return { jobId: 'render-job' }; }, job: async () => ({ id: 'render-job', kind: 'video', status: 'complete', result: { outputPath: 'C:/private/video.mp4' } }), cancel: async (...args) => { calls.push(['cancel', ...args]); return { id: 'render-job', status: 'cancelled' }; }, append: async (...args) => { calls.push(['append', ...args]); return { revision: 'abcdef0123456789', undo: { id: 'native-undo' }, asset: { id: 'rendered-asset' } }; } };
  const preflight = { check: async (...args) => { calls.push(['preflight', ...args]); return { canExport: true, issues: [], samples: [] }; } };
  const bundles = { prepareExport: async (...args) => { calls.push(['backup', ...args]); return { filename: '当前工程.gxproject', bytes: 42, report: { ok: true }, downloadUrl: '/api/project-bundles/exports/11111111-1111-1111-1111-111111111111/file' }; } };
  const ctx = { projectId: project.id, runId: randomUUID(), instruction: '请制作并导出', origin: 'http://127.0.0.1:12345', mode: 'auto', signal: new AbortController().signal, update() {} };
  const tools = createProductionCapabilityTools({
    tool: (name, description, inputSchema, mutating, execute) => ({ name, description, inputSchema, mutating, execute: async (args, context) => { if (mutating && context.mode === 'ask') throw new AppError(403, '只读', 'ASSISTANT_READ_ONLY'); return execute(args, context, state); } }),
    owner, current, readNative, rememberUndo: record => { if (Buffer.byteLength(JSON.stringify(record)) > undoBytes) throw new AppError(413, '撤销记录过大', 'ASSISTANT_UNDO_TOO_LARGE'); undos.push(record); return { id: randomUUID(), kind: record.kind }; }, prepareUndo: record => { if (Buffer.byteLength(JSON.stringify(record)) > undoBytes) throw new AppError(413, '撤销记录过大', 'ASSISTANT_UNDO_TOO_LARGE'); let committed = false; return { undo: { id: randomUUID(), kind: record.kind }, commit: patch => { Object.assign(record, patch); undos.push(record); committed = true; }, cancel: () => { if (committed) undos.splice(undos.indexOf(record), 1); } }; }, remotion, remotionProjects: projects, preflight, openFilm, tasks, bundles,
  });
  t.after(async () => { await integration.close(); await projects.close(); await tasks.close(); await store.settle(); await rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, project, store, state, native, calls, undos, ctx, remotion, projects, tasks, preflight, tools, call: (name, args = {}, context = ctx) => tools.find(tool => tool.name === name).execute(args, context) };
}
const files = () => [{ path: 'src/index.tsx', content: 'export const original = 1;' }, { path: 'src/style.css', content: 'body { color: red; }' }];

test('direct source authoring uses real saved revisions, scoped assets and guarded undo', async t => {
  const fx = await fixture(t);
  await assert.rejects(fx.call('remotion_create', { files: files(), assets: [{ assetId: 'other' }] }), code('ASSISTANT_MEDIA_SCOPE'));
  const created = await fx.call('remotion_create', { title: '原创工程', files: files(), assets: [{ assetId: 'allowed' }], compositionId: 'Main' });
  const id = created.data.id;
  assert.equal(created.data.revision, 1); assert.equal((await fx.projects.read(fx.project.id, id)).files[0].content, files()[0].content);
  assert.equal(JSON.stringify(created).includes(fx.dataDir), false); assert.equal(fx.calls.length, 0, 'saving sources never invokes model or renderer');
  const updated = await fx.call('remotion_update', { remotionId: id, expectedRevision: 1, title: '新标题', files: [{ path: 'src/new.ts', content: 'export const extra = true;' }], deletedFiles: ['src/style.css'] });
  assert.equal(updated.data.revision, 2);
  await restoreProductionUndo(fx.undos[0], { remotion: fx.remotion, remotionProjects: fx.projects });
  const restored = await fx.projects.read(fx.project.id, id);
  assert.equal(restored.revision, 3); assert.equal(restored.title, '原创工程'); assert.deepEqual(restored.files, files());
  await assert.rejects(restoreProductionUndo(fx.undos[0], { remotion: fx.remotion, remotionProjects: fx.projects }), code('REMOTION_REVISION_CONFLICT'));
});

test('direct authoring rejects stale revisions, escaping paths and parent conflicts without overwriting', async t => {
  const fx = await fixture(t), created = await fx.call('remotion_create', { files: files() }), id = created.data.id;
  await assert.rejects(fx.call('remotion_update', { remotionId: id, expectedRevision: 2, title: '过期' }), code('REMOTION_REVISION_CONFLICT'));
  await assert.rejects(fx.call('remotion_update', { remotionId: id, expectedRevision: 1, files: [{ path: '../escape.tsx', content: 'unsafe' }] }), code('REMOTION_PROJECT_INVALID'));
  assert.equal((await fx.projects.read(fx.project.id, id)).revision, 1);
  await fx.store.patchMetadata(fx.project.id, { title: '用户已更新' });
  await assert.rejects(fx.call('remotion_update', { remotionId: id, expectedRevision: 1, title: '不可覆盖' }), code('ASSISTANT_CONFLICT'));
  assert.equal((await fx.projects.read(fx.project.id, id)).revision, 1);
});

test('source edits reserve undo capacity before publishing any source revision', async t => {
  const fx = await fixture(t, { undoBytes: 1 }), created = await fx.call('remotion_create', { files: files() });
  await assert.rejects(fx.call('remotion_update', { remotionId: created.data.id, expectedRevision: 1, title: '不应提交' }), code('ASSISTANT_UNDO_TOO_LARGE'));
  assert.equal((await fx.projects.read(fx.project.id, created.data.id)).revision, 1);
});

test('a concurrent source CAS failure cancels its pending undo and keeps the user revision intact', async t => {
  const fx = await fixture(t), created = await fx.call('remotion_create', { files: files() }), update = fx.projects.update.bind(fx.projects);
  fx.projects.update = async (projectId, id, input) => {
    assert.equal(fx.undos.length, 0, 'pending reservation must not be visible as an executable undo');
    await update(projectId, id, { expectedRevision: 1, title: 'User concurrent version' });
    return update(projectId, id, input);
  };
  await assert.rejects(fx.call('remotion_update', { remotionId: created.data.id, expectedRevision: 1, title: 'Stale assistant change' }), code('REMOTION_REVISION_CONFLICT'));
  assert.equal(fx.undos.length, 0); const saved = await fx.projects.read(fx.project.id, created.data.id); assert.equal(saved.revision, 2); assert.equal(saved.title, 'User concurrent version');
});

test('actual assistant undo_list cannot expose a pending or failed source reservation', async t => {
  const fx = await fixture(t), app = createAssistantAppTools({ store: fx.store, remotion: fx.remotion, remotionProjects: fx.projects });
  const call = (name, args = {}) => app.tools.find(tool => tool.name === name).execute(args, fx.ctx);
  let release, entered;
  const pauseCommit = new Promise(resolve => { release = resolve; }), admitted = new Promise(resolve => { entered = resolve; });
  let pending;
  try {
    const created = await call('remotion_create', { files: files() }), update = fx.projects.update.bind(fx.projects);
    fx.projects.update = async (...args) => { entered(); await pauseCommit; return update(...args); };
    pending = call('remotion_update', { remotionId: created.data.id, expectedRevision: 1, title: 'Assistant stale title' });
    await admitted;
    assert.deepEqual((await call('assistant_undo_list')).data.items, []);
    await update(fx.project.id, created.data.id, { expectedRevision: 1, title: 'Concurrent user title' });
    release(); await assert.rejects(pending, code('REMOTION_REVISION_CONFLICT'));
    assert.deepEqual((await call('assistant_undo_list')).data.items, []);
    assert.equal((await fx.projects.read(fx.project.id, created.data.id)).title, 'Concurrent user title');
  } finally { release(); await pending?.catch(() => {}); await app.close(); }
});

test('advanced inspect/render forwards actual props and seconds while job DTO hides filesystem output', async t => {
  const fx = await fixture(t), created = await fx.call('remotion_create', { files: files() }), remotionId = created.data.id;
  await fx.call('remotion_inspect_advanced', { remotionId, expectedRevision: 1, inputProps: { title: '标题', duration: 4 } });
  await fx.call('remotion_render_advanced', { remotionId, expectedRevision: 1, inputProps: { duration: 4 }, range: [1, 2], kind: 'video' });
  const render = fx.calls.find(row => row[0] === 'render');
  assert.deepEqual(render[3].range, [1, 2]); assert.deepEqual(render[3].inputProps, { duration: 4 });
  await assert.rejects(fx.call('remotion_render_advanced', { remotionId, expectedRevision: 1, frames: [0] }), code('ASSISTANT_REMOTION_RENDER_OPTIONS'));
  const job = await fx.call('remotion_job', { jobId: 'render-job' });
  assert.equal(JSON.stringify(job).includes('C:/private'), false); assert.match(job.effects[0].artifact.downloadUrl, /\/video\.mp4$/);
  await fx.call('remotion_cancel', { jobId: 'render-job' }); assert.equal(fx.calls.at(-1)[1], fx.project.id);
});

test('append uses current timeline revision/scope and records actual native undo receipt', async t => {
  const fx = await fixture(t), created = await fx.call('remotion_create', { files: files() });
  await fx.call('remotion_append', { remotionId: created.data.id, expectedRevision: 1, jobId: 'render-job' });
  const call = fx.calls.find(row => row[0] === 'append');
  assert.equal(call[3].expectedNativeRevision, '0123456789abcdef'); assert.deepEqual(call[4].editScope, fx.state.scope);
  assert.equal(fx.state.nativeRevision, 'abcdef0123456789'); assert.equal(fx.undos[0].nativeUndoId, 'native-undo');
});

test('native export enforces selected range, blocks failed preflight and catches concurrent edits', async t => {
  const fx = await fixture(t);
  await assert.rejects(fx.call('native_export', { range: [1, 4] }), code('ASSISTANT_EXPORT_SCOPE'));
  fx.preflight.check = async () => ({ canExport: false, issues: [{ message: '缺少素材' }] });
  const blocked = await fx.call('native_export'); assert.equal(blocked.data.started, false); assert.equal(fx.calls.length, 0);
  fx.preflight.check = async () => { fx.native.revision = 'abcdef0123456789'; return { canExport: true }; };
  await assert.rejects(fx.call('native_export'), code('OPENFILM_REVISION_CONFLICT')); assert.equal(fx.calls.length, 0);
});

test('native export admits real scope and CAS options, never marks a started job complete', async t => {
  const fx = await fixture(t), result = await fx.call('native_export', { fps: 24, name: '当前选段' });
  const call = fx.calls.find(row => row[0] === 'export');
  assert.deepEqual(call[2], { fps: 24, name: '当前选段', range: [2, 4] }); assert.equal(call[4].expectedRevision, '0123456789abcdef');
  assert.equal(result.data.started, true); assert.equal(result.data.export.status, 'waiting'); assert.match(result.summary, /尚需/);
});

test('task controls are project-scoped, prohibit self cancellation and use real registered controls', async t => {
  const fx = await fixture(t), cancelled = [];
  const own = await fx.tasks.upsertExternal('fixture:own', { projectId: fx.project.id, type: 'analysis', sourceJobId: 'analysis-job', title: '真实分析' }, { status: 'running' }, { cancel: () => { cancelled.push('own'); return { status: 'cancelled' }; } });
  const other = await fx.tasks.upsertExternal('fixture:other', { projectId: 'other-project', title: '其他项目' }, { status: 'running' }, { cancel: () => cancelled.push('other') });
  const ownAssistant = await fx.tasks.upsertExternal('fixture:self', { projectId: fx.project.id, type: 'assistant', sourceJobId: fx.ctx.runId, title: '自身' }, { status: 'running' }, { cancel: () => cancelled.push('self') });
  await assert.rejects(fx.call('task_cancel', { taskId: other.id }), code('TASK_NOT_FOUND'));
  await assert.rejects(fx.call('task_cancel', { taskId: ownAssistant.id }), code('ASSISTANT_TASK_SELF_CONTROL'));
  await fx.call('task_cancel', { taskId: own.id }); assert.deepEqual(cancelled, ['own']);
  const listed = await fx.call('task_list'); assert.equal(listed.data.items.some(item => item.id === other.id), false);
  await assert.rejects(fx.call('task_retry', { taskId: own.id }), code('TASK_RETRY_UNAVAILABLE'));
});

test('backup uses managed project package service and produces an actual bounded download card', async t => {
  const fx = await fixture(t), result = await fx.call('project_backup');
  assert.equal(fx.calls[0][1], fx.project.id); assert.equal(result.data.bytes, 42); assert.equal(result.effects[0].type, 'artifact');
  assert.match(result.effects[0].artifact.downloadUrl, /^\/api\/project-bundles\/exports\//);
  await assert.rejects(fx.call('project_backup', {}, { ...fx.ctx, mode: 'ask' }), code('ASSISTANT_READ_ONLY'));
});

test('expanded native operation invokes one CAS transaction and permits requested unlock without raw endpoint access', async t => {
  const fx = await fixture(t);
  const result = await fx.call('native_operation', { operations: [{ action: 'track_set', track: 0, field: 'locked', value: false }] });
  const call = fx.calls.find(row => row[0] === 'operations');
  assert.equal(call[1], fx.project.id); assert.equal(call[4], '0123456789abcdef'); assert.deepEqual(call[5].editScope, fx.state.scope);
  assert.equal(fx.state.nativeRevision, 'abcdef0123456789'); assert.equal(fx.undos[0].nativeUndoId, 'native-operation-undo'); assert.equal(result.effects[0].undo.kind, 'native');
});

test('advanced export clamps sampling and joined ranges to dialogue scope and defaults to actual scoped output', async t => {
  const fx = await fixture(t), catalog = await fx.call('native_export_catalog'); assert.equal(catalog.data.exports.length, 9);
  await assert.rejects(fx.call('native_export_advanced', { spec: { kind: 'nle', format: 'xml' } }), code('ASSISTANT_EXPORT_SCOPE'));
  await assert.rejects(fx.call('native_export_advanced', { spec: { kind: 'video', ranges: [[2, 3], [3, 5]] } }), code('ASSISTANT_EXPORT_SCOPE'));
  await assert.rejects(fx.call('native_export_advanced', { spec: { kind: 'poster', at: 1 } }), code('ASSISTANT_EXPORT_SCOPE'));
  const poster = await fx.call('native_export_advanced', { spec: { kind: 'poster', format: 'png' } }); assert.equal(poster.data.started, true);
  assert.equal(fx.calls.find(row => row[0] === 'advanced-export')[2].at, 3);
  await fx.call('native_export_advanced', { spec: { kind: 'audio', ranges: [[2, 2.5], [3, 4]], stems: true } });
  assert.equal(fx.calls.filter(row => row[0] === 'preflight').length, 3, 'one poster check plus each joined audio range');
  await fx.call('native_export_cancel', { exportId: 'advanced-job' }); assert.equal(fx.calls.at(-1)[1], fx.project.id);
});
