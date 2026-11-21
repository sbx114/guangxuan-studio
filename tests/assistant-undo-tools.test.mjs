import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createProjectStore, assistantContentHash } from '../lib/store.mjs';
import { createAssistantAppTools } from '../lib/assistant-app-tools.mjs';
import { createRemotionProjectsService } from '../lib/remotion-projects.mjs';
import { createRemotionIntegration } from '../lib/remotion-integration.mjs';

const root = path.resolve(import.meta.dirname, '..');
const privateSource = 'PRIVATE_UNDO_SOURCE_SENTINEL C:/private/never-surface.tsx';
const files = () => [{ path: 'src/private-source.tsx', content: `export const privateSource=${JSON.stringify(privateSource)};` }, { path: 'src/style.css', content: 'body { color: red; }' }];
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t, { kind = 'writing', services = {}, undoLimit = 64, remotion = false } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'gx-assistant-undo-')), store = await createProjectStore(dataDir);
  const project = await store.save('undo-current', { kind, title: '原项目标题', description: '原项目简介', source: { title: '材料', text: privateSource, url: '' }, outputs: { article: { title: '原稿', lead: '原导语', body: privateSource, titles: [] } }, ...(kind === 'video' ? { video: { script: '原旁白', timeline: [] } } : {}) });
  let projects, integration, jobs = 0;
  if (remotion) {
    projects = await createRemotionProjectsService({ dataDir, root, onJob: () => { jobs++; } });
    integration = createRemotionIntegration({ projects, store });
  }
  const adapter = createAssistantAppTools({ store, undoLimit, ...(projects ? { remotion: integration, remotionProjects: projects } : {}), ...services });
  t.after(async () => { await adapter.close(); await integration?.close(); await projects?.close(); await store.settle(); assert.equal(path.dirname(dataDir), os.tmpdir()); await rm(dataDir, { recursive: true, force: true }); });
  const ctx = overrides => ({ projectId: project.id, runId: randomUUID(), instruction: '按当前对话修改整个工程，然后按要求撤销', mode: 'auto', scopeAuthority: 'dialog', origin: 'http://127.0.0.1:12345', signal: new AbortController().signal, update() {}, ...overrides });
  const call = (name, args = {}, context = ctx()) => { const selected = adapter.tools.find(tool => tool.name === name); assert.ok(selected, 'Missing ' + name); return selected.execute(args, context); };
  return { dataDir, store, project, adapter, projects, integration, ctx, call, jobs: () => jobs };
}
function safeList(result) {
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /PRIVATE_UNDO_SOURCE_SENTINEL|C:\/private|src\/private-source|body \{|export const|before|outputPath|sourceRoot/);
  for (const item of result.data.items) {
    assert.deepEqual(Object.keys(item).sort(), ['at', 'id', 'kind', 'label', 'runId']);
    assert.match(item.id, /^[a-f0-9-]{36}$/); assert.ok(Number.isFinite(Date.parse(item.at)));
    assert.match(item.label, /[\u3400-\u9fff]/, 'Undo descriptions must use the completed business action');
  }
  return result.data.items;
}

test('real undo tools list Chinese business receipts, restore two writes by ID and continue in the same run', async t => {
  const fx = await fixture(t), initialHash = assistantContentHash(fx.project), writer = fx.ctx();
  const first = await fx.call('draft_write', { channel: 'article', content: { title: '已保存的新稿', lead: '新的导语', body: '实际写入新正文', titles: [] } }, writer);
  const second = await fx.call('project_update', { title: '第二笔项目标题' }, writer);
  assert.equal((await fx.store.read(fx.project.id)).outputs.article.body, '实际写入新正文');
  const undoRun = fx.ctx({ instruction: '撤销刚才两次修改，然后更新简介' });
  const items = safeList(await fx.call('assistant_undo_list', {}, undoRun));
  assert.deepEqual(items.map(item => item.id), [second.effects[0].undo.id, first.effects[0].undo.id]);
  assert.equal(items[0].label, second.effects[0].label); assert.equal(items[1].label, first.effects[0].label);
  await fx.call('assistant_undo_apply', { undoId: items[0].id }, undoRun);
  assert.equal((await fx.store.read(fx.project.id)).title, fx.project.title);
  assert.equal((await fx.store.read(fx.project.id)).outputs.article.body, '实际写入新正文');
  await fx.call('assistant_undo_apply', { undoId: items[1].id }, undoRun);
  assert.equal(assistantContentHash(await fx.store.read(fx.project.id)), initialHash);
  assert.deepEqual(safeList(await fx.call('assistant_undo_list', {}, undoRun)), []);
  const third = await fx.call('project_update', { description: '撤销之后继续保存的新简介' }, undoRun);
  assert.equal((await fx.store.read(fx.project.id)).description, '撤销之后继续保存的新简介');
  // This receipt belongs to the undo run itself. Internal undo invalidation
  // must be cleared after its own successful inverse, rather than blocking it.
  await fx.call('assistant_undo_apply', { undoId: third.effects[0].undo.id }, undoRun);
  await fx.call('project_update', { title: '本轮撤销之后还可以继续编辑' }, undoRun);
  const final = await fx.store.read(fx.project.id); assert.equal(final.title, '本轮撤销之后还可以继续编辑'); assert.equal(final.description, fx.project.description);
});

test('undo list is read only in ask mode and apply rejects foreign, consumed, invalid and restarted-session IDs', async t => {
  const fx = await fixture(t), written = await fx.call('project_update', { title: '可撤销的标题' }), undoId = written.effects[0].undo.id;
  const after = assistantContentHash(await fx.store.read(fx.project.id));
  assert.equal(safeList(await fx.call('assistant_undo_list', {}, fx.ctx({ mode: 'ask' })))[0].id, undoId);
  await assert.rejects(fx.call('assistant_undo_apply', { undoId }, fx.ctx({ mode: 'ask' })), { code: 'ASSISTANT_READ_ONLY' });
  await fx.store.save('undo-foreign', { kind: 'writing', title: '另一个工程', source: { text: '另一工程保留' } });
  const foreign = fx.ctx({ projectId: 'undo-foreign' });
  assert.deepEqual(safeList(await fx.call('assistant_undo_list', {}, foreign)), []);
  await assert.rejects(fx.call('assistant_undo_apply', { undoId }, foreign), { code: 'ASSISTANT_UNDO_PROJECT' });
  await assert.rejects(fx.call('assistant_undo_apply', { undoId: randomUUID() }), { code: 'ASSISTANT_UNDO_EXPIRED' });
  await assert.rejects(fx.call('assistant_undo_apply', { undoId: '../private-file' }), { code: 'INVALID_ASSISTANT_UNDO' });
  assert.equal(assistantContentHash(await fx.store.read(fx.project.id)), after); assert.equal((await fx.store.read('undo-foreign')).title, '另一个工程');
  await fx.call('assistant_undo_apply', { undoId });
  await assert.rejects(fx.call('assistant_undo_apply', { undoId }), { code: 'ASSISTANT_UNDO_EXPIRED' });
  const another = await fx.call('project_update', { description: '软件会话结束前已保存的简介' });
  await fx.adapter.close();
  const restarted = createAssistantAppTools({ store: fx.store });
  try {
    const call = (name, args = {}) => restarted.tools.find(tool => tool.name === name).execute(args, fx.ctx());
    assert.deepEqual(safeList(await call('assistant_undo_list')), []);
    await assert.rejects(call('assistant_undo_apply', { undoId: another.effects[0].undo.id }), { code: 'ASSISTANT_UNDO_EXPIRED' });
    assert.equal((await fx.store.read(fx.project.id)).description, '软件会话结束前已保存的简介');
  } finally { await restarted.close(); }
});

test('native undo refreshes the actual adapter revision cache before further same-run native and project edits', async t => {
  const native = { revision: 'native-r1', volume: 1 }, records = new Map(), expectedRevisions = [], contexts = [];
  const openFilm = {
    async context(projectId) { contexts.push(native.revision); return { projectId, revision: native.revision, assets: [{ id: 'existing-media', name: '当前工程素材.mp4', type: 'video', duration: 10 }], timeline: [{ id: 'clip-a', assetId: 'existing-media', at: 0, start: 0, end: 4, speed: 1 }], duration: 4, aspect: '16:9', mainTrackEditable: true }; },
    async adjustClips(projectId, edits, _origin, expectedRevision) {
      assert.equal(projectId, 'undo-current'); assert.equal(expectedRevision, native.revision); expectedRevisions.push(expectedRevision);
      assert.equal(edits.length, 1); assert.equal(edits[0].action, 'volume');
      const id = randomUUID(); records.set(id, { volume: native.volume, revision: native.revision });
      native.volume = edits[0].value; native.revision = native.revision === 'native-r1' ? 'native-r2' : 'native-r4';
      return { revision: native.revision, duration: 4, results: [{ clipId: 'clip-a' }], undo: { id }, summary: '已修改片段音量' };
    },
    async undoAssistant(projectId, undoId) { assert.equal(projectId, 'undo-current'); const before = records.get(undoId); assert.ok(before); assert.equal(native.revision, 'native-r2'); native.volume = before.volume; native.revision = 'native-r3'; records.delete(undoId); return { restored: true }; },
    async syncMetadata() {},
  };
  const fx = await fixture(t, { kind: 'video', services: { openFilm } }), writer = fx.ctx();
  const written = await fx.call('native_adjust', { edits: [{ action: 'volume', clipId: 'clip-a', value: 0.4 }] }, writer); assert.equal(native.volume, 0.4);
  const undoRun = fx.ctx({ instruction: '撤销音量修改，再把整个工程这个片段音量改为25%，并更新项目简介' });
  await fx.call('native_read', {}, undoRun); assert.equal(contexts.at(-1), 'native-r2');
  const listed = safeList(await fx.call('assistant_undo_list', {}, undoRun)); assert.equal(listed[0].id, written.effects[0].undo.id); assert.equal(listed[0].label, '已修改片段音量');
  await fx.call('assistant_undo_apply', { undoId: listed[0].id }, undoRun); assert.equal(native.volume, 1); assert.equal(contexts.at(-1), 'native-r3');
  await fx.call('native_adjust', { edits: [{ action: 'volume', clipId: 'clip-a', value: 0.25 }] }, undoRun);
  assert.deepEqual(expectedRevisions, ['native-r1', 'native-r3']); assert.equal(native.volume, 0.25);
  await fx.call('project_update', { description: '音量撤销后已继续精确编辑' }, undoRun); assert.equal((await fx.store.read(fx.project.id)).description, '音量撤销后已继续精确编辑');
});

test('a successful real source edit exposes only its business receipt and undo restores its private source exactly', async t => {
  const fx = await fixture(t, { kind: 'video', remotion: true }), writer = fx.ctx();
  const created = await fx.call('remotion_create', { files: files(), title: '真实自由源码' }, writer);
  const updated = await fx.call('remotion_update', { remotionId: created.data.id, expectedRevision: 1, title: '已更新源码标题', files: [{ path: 'src/style.css', content: 'body { color: blue; }' }] }, writer);
  const undoRun = fx.ctx(), items = safeList(await fx.call('assistant_undo_list', {}, undoRun));
  assert.equal(items.length, 1); assert.equal(items[0].kind, 'remotion-source'); assert.equal(items[0].id, updated.effects[0].undo.id); assert.equal(items[0].label, '已更新动画源码与参数');
  await fx.call('assistant_undo_apply', { undoId: items[0].id }, undoRun);
  const restored = await fx.projects.read(fx.project.id, created.data.id); assert.equal(restored.revision, 3); assert.equal(restored.title, '真实自由源码'); assert.deepEqual(restored.files, files());
  await fx.call('project_update', { description: '源码撤销后继续编辑项目' }, undoRun); assert.equal((await fx.store.read(fx.project.id)).description, '源码撤销后继续编辑项目'); assert.equal(fx.jobs(), 0);
});

test('pending source undo is hidden, failed CAS removes it and a concurrent committed project write keeps its receipt', async t => {
  const fx = await fixture(t, { kind: 'video', remotion: true, undoLimit: 1 }), writer = fx.ctx(), ready = deferred(), release = deferred();
  const created = await fx.call('remotion_create', { files: files(), title: '原源码' }, writer), update = fx.projects.update.bind(fx.projects);
  fx.projects.update = async (...args) => { ready.resolve(); await release.promise; return update(...args); };
  let pending;
  try {
    pending = fx.call('remotion_update', { remotionId: created.data.id, expectedRevision: 1, title: '过期助手修改' }, writer);
    await ready.promise;
    assert.deepEqual(safeList(await fx.call('assistant_undo_list', {}, fx.ctx())), []);
    const concurrentRun = fx.ctx({ instruction: '同时更新当前工程简介' });
    const committed = await fx.call('project_update', { description: '已真正提交的并发简介' }, concurrentRun);
    assert.equal((await fx.store.read(fx.project.id)).description, '已真正提交的并发简介'); assert.ok(committed.effects[0].undo.id);
    const pendingList = safeList(await fx.call('assistant_undo_list', {}, fx.ctx()));
    assert.deepEqual(pendingList.map(item => item.id), [committed.effects[0].undo.id]); assert.equal(pendingList[0].kind, 'project');
    await update(fx.project.id, created.data.id, { expectedRevision: 1, title: '必须保留的用户源码版本' });
    release.resolve(); await assert.rejects(pending, { code: 'REMOTION_REVISION_CONFLICT' });
    const afterFailure = safeList(await fx.call('assistant_undo_list', {}, fx.ctx()));
    assert.deepEqual(afterFailure.map(item => item.id), [committed.effects[0].undo.id]); assert.equal(afterFailure.some(item => item.kind === 'remotion-source'), false);
    assert.equal((await fx.projects.read(fx.project.id, created.data.id)).title, '必须保留的用户源码版本');
    await fx.call('assistant_undo_apply', { undoId: committed.effects[0].undo.id }, concurrentRun);
    assert.equal((await fx.store.read(fx.project.id)).description, fx.project.description); assert.equal(fx.jobs(), 0);
  } finally { release.resolve(); await pending?.catch(() => {}); fx.projects.update = update; }
});
