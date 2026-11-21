import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { createProjectStore } from '../lib/store.mjs';
import { startServer } from '../server.mjs';

async function temporaryData(t, beforeRemove = async () => {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'guangxuan-metadata-test-'));
  t.after(async () => {
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('guangxuan-metadata-test-')) throw new Error('Refusing unsafe cleanup target');
    await beforeRemove();
    await rm(resolved, { recursive: true, force: true });
  });
  return directory;
}

test('metadata PATCH and queued autosaves preserve rename, editing content, and other project fields', async t => {
  const store = await createProjectStore(await temporaryData(t));
  const original = await store.save('concurrent-project', {
    title: '原始项目', description: '旧简介', kind: 'video',
    source: { text: 'A source that must remain intact' },
    video: { timeline: [{ assetId: 'source-asset', start: 1, end: 4 }], captions: [{ start: 0, end: 2, text: '字幕' }] },
    outputs: { article: { body: '原稿' } }, history: [{ label: '原始记录' }],
  });
  const delayedAutosave = structuredClone(original);
  delayedAutosave.outputs.article.body = '编辑器中的新稿';
  const [renamed, saved] = await Promise.all([
    store.patchMetadata(original.id, { title: '用户的新标题' }),
    store.save(original.id, delayedAutosave),
  ]);
  assert.equal(renamed.metadataRevision, 1);
  assert.equal(saved.title, '用户的新标题');
  assert.equal(saved.outputs.article.body, '编辑器中的新稿');
  assert.deepEqual(saved.source, original.source);
  assert.deepEqual(saved.video, original.video);
  assert.deepEqual(saved.history, original.history);
  assert.equal(saved.createdAt, original.createdAt);

  const noRevisionClient = { ...original, outputs: { article: { body: '另一次自动保存' } } };
  delete noRevisionClient.metadataRevision;
  await Promise.all([
    store.patchMetadata(original.id, { description: '独立更新简介' }),
    store.save(original.id, noRevisionClient),
    store.patchMetadata(original.id, { title: '最终标题' }),
  ]);
  const final = await store.read(original.id);
  assert.equal(final.title, '最终标题');
  assert.equal(final.description, '独立更新简介');
  assert.equal(final.outputs.article.body, '另一次自动保存');
  assert.equal(final.metadataRevision, 3);
  assert.deepEqual(final.video, original.video);
  const beforeInvalid = JSON.stringify(final);
  await assert.rejects(store.patchMetadata(original.id, { title: ' ', kind: 'writing' }), error => error.code === 'INVALID_PROJECT_METADATA');
  assert.equal(JSON.stringify(await store.read(original.id)), beforeInvalid);
  await store.settle();
});

test('real metadata HTTP endpoints reject invalid patches and return only bounded project summaries', async t => {
  let app;
  const dataDir = await temporaryData(t, () => app?.close());
  app = await startServer({ dataDir, port: 0 });
  async function request(route, method = 'GET', body) {
    const response = await fetch(`${app.url}${route}`, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  }
  const created = await request('/api/projects/metadata-http', 'PUT', {
    title: '待改名', description: '简介', kind: 'video',
    source: { text: 'SOURCE_MUST_NOT_APPEAR_IN_SUMMARY' },
    runs: [{ prompt: 'PROMPT_MUST_NOT_APPEAR_IN_SUMMARY' }],
    settings: { apiKey: 'test-only-secret-not-real' },
    video: { timeline: [{ start: 2, end: 6.5 }, { start: 0, end: 2.25 }] },
    outputs: { article: { title: '甲乙', body: '中文 test' }, social: { text: 'abc' } },
  });
  assert.equal(created.status, 200);
  const changed = await request('/api/projects/metadata-http', 'PATCH', { title: ' 正式标题 ', description: '' });
  assert.equal(changed.status, 200);
  assert.equal(changed.data.project.title, '正式标题');
  assert.equal(changed.data.project.description, '');
  assert.deepEqual(changed.data.project.outputs, created.data.project.outputs);
  for (const invalid of [{}, { title: '' }, { title: 'x'.repeat(121) }, { description: 'x'.repeat(1001) }, { source: {} }, { title: '允许吗', kind: 'writing' }]) {
    assert.equal((await request('/api/projects/metadata-http', 'PATCH', invalid)).status, 400);
  }
  assert.equal((await request('/api/projects/not-created', 'PATCH', { title: '标题' })).status, 404);
  const noJson = await fetch(`${app.url}/api/projects/metadata-http`, { method: 'PATCH', body: 'title=wrong' });
  assert.equal(noJson.status, 415); await noJson.arrayBuffer();

  const summarized = await request('/api/projects/summary');
  assert.equal(summarized.status, 200);
  assert.equal(summarized.data.projects.length, 1);
  const summary = summarized.data.projects[0];
  assert.deepEqual(Object.keys(summary).sort(), ['id', 'title', 'kind', 'description', 'cover', 'coverAssetId', 'coverUrl', 'createdAt', 'updatedAt', 'duration', 'clipCount', 'wordCount', 'outputCount'].sort());
  assert.equal(summary.title, '正式标题');
  assert.equal(summary.duration, 6.75);
  assert.equal(summary.clipCount, 2);
  assert.equal(summary.outputCount, 2);
  assert.equal(summary.wordCount, 11);
  const serialized = JSON.stringify(summarized.data);
  assert.ok(!serialized.includes('SOURCE_MUST_NOT_APPEAR'));
  assert.ok(!serialized.includes('PROMPT_MUST_NOT_APPEAR'));
  assert.ok(!serialized.includes('test-only-secret'));
  const full = await request('/api/projects/metadata-http');
  assert.equal(full.status, 200);
  assert.equal(full.data.project.source.text, 'SOURCE_MUST_NOT_APPEAR_IN_SUMMARY');
});

test('archive covers persist per project and survive stale or cover-unaware editor autosaves', async t => {
  const store = await createProjectStore(await temporaryData(t));
  const original = await store.save('covered-project', { kind: 'science', title: '光的传播', outputs: { article: { body: '原稿' } } });
  await store.save('other-project', { kind: 'writing', title: '其他项目' });
  assert.equal(original.cover, 'classic');
  const patched = await store.patchMetadata(original.id, { cover: 'blueprint' });
  assert.equal(patched.cover, 'blueprint');
  assert.equal(patched.metadataRevision, 1);
  await store.save(original.id, { ...original, outputs: { article: { body: '新的科普内容' } } });
  let saved = await store.read(original.id);
  assert.equal(saved.cover, 'blueprint');
  assert.equal(saved.outputs.article.body, '新的科普内容');
  assert.equal(saved.kind, 'science');
  const coverUnaware = { ...saved };
  delete coverUnaware.cover;
  await store.save(original.id, coverUnaware);
  assert.equal((await store.read(original.id)).cover, 'blueprint');
  for (const cover of ['classic', 'blueprint', 'film', 'paper']) {
    await store.patchMetadata(original.id, { cover });
    assert.equal((await store.summary()).projects.find(project => project.id === original.id).cover, cover);
  }
  saved = await store.read(original.id);
  for (const cover of [null, '', 'not-a-cover', '../file', 'https://example.test/cover.png', { id: 'film' }]) {
    await assert.rejects(store.patchMetadata(original.id, { cover }), error => error.code === 'INVALID_PROJECT_COVER');
  }
  assert.deepEqual(await store.read(original.id), saved);
  assert.equal((await store.read('other-project')).cover, 'classic');
  await store.settle();
});
