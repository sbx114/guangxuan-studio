import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { assistantContentHash, createProjectStore } from '../lib/store.mjs';

async function fixture(t, project = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'gx-assistant-store-'));
  const store = await createProjectStore(dataDir, { sensitiveStrings: () => ['fixture-private-key-123456'] });
  t.after(async () => { await store.settle(); await rm(dataDir, { recursive: true, force: true }); });
  const saved = await store.save('test-project', { kind: 'video', title: '原项目', description: '简介', source: { title: '资料', text: '原文', url: '' }, outputs: { article: { body: '原文案' } }, video: { script: '原旁白', timeline: [], assistantScope: { placement: { mode: 'all' } } }, science: { novelConfig: { density: 'balanced' } }, ...project });
  return { dataDir, store, project: saved };
}
const inverse = before => before.map(item => ({ path: item.path, ...(item.exists ? { value: item.value } : { remove: true }) }));
const parents = before => before.flatMap(item => item.parents || []);

test('assistant hash sorts object keys and ignores only explicit revisions, chat and rendering records', () => {
  const project = { title: '标题', updatedAt: 'old', metadataRevision: 1, assistantRevision: 1, source: { text: '原文', title: '资料' }, outputs: { article: { body: '文案' } }, science: { novelConfig: { density: 'balanced' } }, video: { timeline: [{ id: 'one', start: 0, end: 3 }], assistantScope: { placement: { mode: 'range', start: 1, end: 2 } }, assistantMessages: [], assistantMode: 'auto', assistantDraft: '', assistantJob: { progress: 0 }, sourceSyncRevision: 1, lastExportJob: { progress: 0 }, lastAnimationJob: { progress: 0 } } };
  const shuffled = Object.fromEntries(Object.entries(project).reverse()); shuffled.source = { title: '资料', text: '原文' };
  assert.equal(assistantContentHash(project), assistantContentHash(shuffled));
  const transient = structuredClone(project); transient.updatedAt = 'new'; transient.metadataRevision = 100; transient.assistantRevision = 100;
  Object.assign(transient.video, { assistantMessages: [{ role: 'user', text: '对话' }], assistantMode: 'ask', assistantDraft: '输入中', assistantJob: { status: 'running' }, sourceSyncRevision: 99, lastExportJob: { status: 'complete', progress: 100 }, lastAnimationJob: { status: 'complete' } });
  assert.equal(assistantContentHash(project), assistantContentHash(transient));
  for (const change of [p => { p.source.text = '变更'; }, p => { p.outputs.article.body = '变更'; }, p => { p.science.novelConfig.density = 'dense'; }, p => { p.video.assistantScope.placement.end = 3; }, p => { p.video.timeline[0].end = 4; }, p => { p.title = '新标题'; }, p => { p.video.unknownJob = { progress: 1 }; }]) {
    const changed = structuredClone(project); change(changed); assert.notEqual(assistantContentHash(changed), assistantContentHash(project));
  }
});

test('atomic assistant patch returns exact before values and increments server revisions once', async t => {
  const { store, project, dataDir } = await fixture(t);
  const initialHash = assistantContentHash(project);
  const changed = await store.updateAssistant(project.id, { expectedHash: initialHash, patch: [
    { path: ['title'], value: ' 新标题 ' }, { path: ['description'], value: '新简介' },
    { path: ['outputs', 'article'], value: { title: '新稿', body: 'fixture-private-key-123456' } },
    { path: ['video', 'script'], value: '新旁白' },
    { path: ['science', 'novel'], value: { version: 2, scenes: [{ id: 'scene-1' }] } },
    { path: ['science', 'novelStale'], value: false },
  ] });
  assert.equal(changed.project.assistantRevision, 1); assert.equal(changed.project.metadataRevision, 1); assert.equal(changed.project.video.sourceSyncRevision, 1);
  assert.equal(changed.project.title, '新标题');
  assert.equal(changed.project.outputs.article.body, '[密钥已隐藏]');
  assert.equal(changed.before[0].value, '原项目'); assert.equal(changed.before[4].exists, false);
  assert.equal(changed.afterHash, assistantContentHash(await store.read(project.id)));
  const file = JSON.parse(await readFile(path.join(dataDir, 'projects', `${project.id}.json`), 'utf8'));
  assert.deepEqual(file, changed.project);
  const undone = await store.updateAssistant(project.id, { expectedHash: changed.afterHash, patch: inverse(changed.before), restoreParents: parents(changed.before) });
  assert.equal(undone.afterHash, initialHash); assert.equal(undone.project.assistantRevision, 2);
  assert.equal(undone.project.metadataRevision, 2); assert.equal(undone.project.video.sourceSyncRevision, 2);
});

test('two callers with the same hash serialize and exactly one commits', async t => {
  const { store, project } = await fixture(t);
  const expectedHash = assistantContentHash(project);
  const results = await Promise.allSettled([
    store.updateAssistant(project.id, { expectedHash, patch: [{ path: ['title'], value: '甲' }] }),
    store.updateAssistant(project.id, { expectedHash, patch: [{ path: ['title'], value: '乙' }] }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.equal(rejected.reason.status, 409); assert.equal(rejected.reason.code, 'ASSISTANT_CONFLICT');
  assert.equal((await store.read(project.id)).title, '甲');
});

test('CAS observes earlier asynchronous queued video changes before comparing', async t => {
  const { store, project } = await fixture(t);
  let enter; const entered = new Promise(resolve => { enter = resolve; }); let release; const gate = new Promise(resolve => { release = resolve; });
  const userWrite = store.updateVideoDraft(project.id, async () => { enter(); await gate; return { script: '用户的并发编辑' }; });
  await entered;
  const agentWrite = store.updateAssistant(project.id, { expectedHash: assistantContentHash(project), patch: [{ path: ['video', 'script'], value: '过期助手稿' }] });
  release(); await userWrite;
  await assert.rejects(agentWrite, error => error.status === 409 && error.code === 'ASSISTANT_CONFLICT');
  assert.equal((await store.read(project.id)).video.script, '用户的并发编辑');
  const fresh = await store.read(project.id);
  assert.equal((await store.updateAssistant(project.id, { expectedHash: assistantContentHash(fresh), patch: [{ path: ['video', 'script'], value: '重读后的助手稿' }] })).project.video.script, '重读后的助手稿');
});

test('multiple assistant changes can be undone in reverse order although revisions only increase', async t => {
  const { store, project } = await fixture(t);
  const initial = assistantContentHash(project);
  const first = await store.updateAssistant(project.id, { expectedHash: initial, patch: [{ path: ['outputs', 'article'], value: { body: '第一份修改' } }] });
  const second = await store.updateAssistant(project.id, { expectedHash: first.afterHash, patch: [{ path: ['title'], value: '第二份修改' }] });
  await assert.rejects(store.updateAssistant(project.id, { expectedHash: first.afterHash, patch: inverse(first.before) }), error => error.code === 'ASSISTANT_CONFLICT');
  const undoSecond = await store.updateAssistant(project.id, { expectedHash: second.afterHash, patch: inverse(second.before) });
  assert.equal(undoSecond.afterHash, first.afterHash);
  const undoFirst = await store.updateAssistant(project.id, { expectedHash: undoSecond.afterHash, patch: inverse(first.before) });
  assert.equal(undoFirst.afterHash, initial); assert.equal(undoFirst.project.assistantRevision, 4);
});

test('old autosaves cannot overwrite an assistant commit while current clients retain normal save behavior', async t => {
  const { store, project } = await fixture(t);
  const oldClient = structuredClone(project); oldClient.outputs.article.body = '旧界面内容';
  const changed = await store.updateAssistant(project.id, { expectedHash: assistantContentHash(project), patch: [{ path: ['outputs', 'article'], value: { body: '助手已提交' } }] });
  for (const version of [undefined, 0, 2, '1']) {
    const stale = { ...oldClient, assistantRevision: version };
    await assert.rejects(store.save(project.id, stale), error => error.status === 409 && error.code === 'ASSISTANT_STALE_PROJECT');
    assert.equal((await store.read(project.id)).outputs.article.body, '助手已提交');
  }
  const latest = structuredClone(changed.project); latest.outputs.article.body = '用户刷新后继续编辑';
  const saved = await store.save(project.id, latest);
  assert.equal(saved.assistantRevision, 1); assert.equal(saved.outputs.article.body, '用户刷新后继续编辑');
  await store.save('old-project', { kind: 'writing', title: '老项目', outputs: {} });
  assert.equal((await store.save('old-project', { kind: 'writing', title: '无版本客户端', outputs: {} })).title, '无版本客户端');
  assert.equal((await store.save('new-project', { kind: 'writing', title: '不能伪造版本', assistantRevision: 900 })).assistantRevision, 0);
});

test('assistant commit wins against a queued stale whole-project save', async t => {
  const { store, project } = await fixture(t);
  const [updated, stale] = await Promise.allSettled([
    store.updateAssistant(project.id, { expectedHash: assistantContentHash(project), patch: [{ path: ['description'], value: '助手简介' }] }),
    store.save(project.id, { ...project, description: '过期简介' }),
  ]);
  assert.equal(updated.status, 'fulfilled'); assert.equal(stale.status, 'rejected'); assert.equal(stale.reason.code, 'ASSISTANT_STALE_PROJECT');
  assert.equal((await store.read(project.id)).description, '助手简介');
});

test('remove and restoreParents undo preserve null or absent parent containers exactly', async t => {
  for (const [root, child, value] of [['outputs', 'article', { body: '内容' }], ['science', 'novel', { scenes: [] }], ['video', 'script', '旁白']]) {
    for (const initialParent of ['missing', null]) {
      const { store, project } = await fixture(t);
      if (initialParent === 'missing') delete project[root]; else project[root] = null;
      const original = await store.save(project.id, project), expected = assistantContentHash(original);
      const changed = await store.updateAssistant(project.id, { expectedHash: expected, patch: [{ path: [root, child], value }] });
      assert.deepEqual(changed.before[0].parents, [{ path: [root], exists: initialParent !== 'missing', ...(initialParent === null ? { value: null } : {}) }]);
      const restored = await store.updateAssistant(project.id, { expectedHash: changed.afterHash, patch: inverse(changed.before), restoreParents: parents(changed.before) });
      assert.equal(restored.afterHash, expected);
      assert.equal(Object.hasOwn(restored.project, root), initialParent !== 'missing');
      if (initialParent === null) assert.equal(restored.project[root], null);
    }
  }
});

test('invalid patch paths, unsafe payloads, schemas and parent restoration never write any bytes', async t => {
  const { store, project, dataDir } = await fixture(t);
  const file = path.join(dataDir, 'projects', `${project.id}.json`);
  const original = await readFile(file, 'utf8');
  const invalid = [
    [], [{ path: ['id'], value: 'other' }], [{ path: ['kind'], value: 'science' }], [{ path: ['outputs'], value: {} }],
    [{ path: ['source', 'text'], value: '不能任意子路径' }], [{ path: ['outputs.article'], value: {} }],
    [{ path: ['video', '__proto__'], value: {} }], [{ path: ['title'], value: '' }], [{ path: ['description'], value: 'x'.repeat(1001) }],
    [{ path: ['source'], value: { text: 'x'.repeat(60001) } }], [{ path: ['outputs', 'article'], value: { apiKey: 'secret' } }],
    [{ path: ['video', 'script'], value: 123 }], [{ path: ['science', 'novelStale'], value: 'false' }], [{ path: ['science', 'novelSettings'], value: {} }],
    [{ path: ['title'], value: '重复' }, { path: ['title'], value: '重复2' }], [{ path: ['title'], value: '同时删除', remove: true }],
  ];
  for (const patch of invalid) {
    await assert.rejects(store.updateAssistant(project.id, { expectedHash: assistantContentHash(project), patch }), error => error.status === 400);
    assert.equal(await readFile(file, 'utf8'), original);
  }
  const patch = [{ path: ['outputs', 'article'], remove: true }];
  for (const restoreParents of [[{ path: ['id'], exists: false }], [{ path: ['outputs'], exists: true, value: {} }], [{ path: ['outputs'], exists: false, value: null }]]) await assert.rejects(store.updateAssistant(project.id, { expectedHash: assistantContentHash(project), patch, restoreParents }), error => error.code === 'INVALID_ASSISTANT_PATCH');
  await assert.rejects(store.updateAssistant(project.id, { expectedHash: assistantContentHash(project), patch: [{ path: ['outputs', 'poster'], value: {} }], restoreParents: [{ path: ['outputs'], exists: false }] }), error => error.code === 'ASSISTANT_CONFLICT');
  assert.equal(await readFile(file, 'utf8'), original);
});
