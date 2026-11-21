import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { createAssistantDownloadService } from '../lib/assistant-downloads.mjs';
import { createAssistantAppTools } from '../lib/assistant-app-tools.mjs';
import { createProjectStore, assistantContentHash } from '../lib/store.mjs';
import { createScienceDocumentService } from '../lib/science-documents.mjs';

const sourceUrl = 'https://papers.example.org/paper.pdf';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const text = Buffer.from('对照实验需要只改变待研究的因素，并保持其他条件相同。原始资料必须保持完整，不能用摘要替换原文。'.repeat(3));
async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'gx-assistant-downloads-'));
  const store = await createProjectStore(dataDir), docs = await createScienceDocumentService({ dataDir, store });
  const science = await store.save('science-a', { kind: 'science', title: '科普材料', science: {}, source: { text: '' } });
  const others = [], calls = [];
  const buffer = options.buffer || text;
  const webTools = { download: options.download || (async (url, opts) => { calls.push({ url, opts }); opts.onProgress?.({ receivedBytes: buffer.length, totalBytes: buffer.length }); return { url, buffer, fileName: options.fileName || '自定义教材.txt', contentType: options.contentType || 'text/plain', size: buffer.length, sha256: sha(buffer), warnings: [] }; }) };
  const service = await createAssistantDownloadService({ dataDir, store, scienceDocuments: docs, webTools, ...options.limits });
  t.after(async () => {
    for (const closer of others.toReversed()) await closer(); await service.close(); await docs.close(); await store.settle();
    if (path.dirname(path.resolve(dataDir)) !== path.resolve(os.tmpdir()) || !path.basename(dataDir).startsWith('gx-assistant-downloads-')) throw new Error('Unsafe test cleanup');
    await rm(dataDir, { recursive: true, force: true });
  });
  return { dataDir, store, docs, science, service, webTools, buffer, calls, own(fn) { others.push(fn); } };
}

test('download stores the exact original bytes, exposes an attachment and survives a service restart', async t => {
  const buffer = await readFile(new URL('./fixtures/science-documents/bilingual-paper.pdf', import.meta.url));
  const f = await fixture(t, { buffer, fileName: '双语原始论文.pdf', contentType: 'application/pdf' });
  const result = await f.service.download(sourceUrl, { runId: randomUUID() });
  assert.equal(result.download.name, '双语原始论文.pdf'); assert.equal(result.download.sha256, sha(buffer));
  assert.deepEqual((await f.service.read(result.download.id)).buffer, buffer);
  const server = http.createServer(async (req, res) => { try { if (!await f.service.handler(req, res, new URL(req.url, 'http://127.0.0.1'))) { res.writeHead(404); res.end(); } } catch (error) { res.writeHead(error.status || 500); res.end(error.code); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  f.own(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}${result.download.downloadUrl}`;
  const response = await fetch(url);
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  assert.match(response.headers.get('content-disposition'), /attachment;.*filename\*=UTF-8''/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), buffer);
  assert.equal((await fetch(url, { method: 'HEAD' })).headers.get('content-length'), String(buffer.length));
  const registry = await readFile(path.join(f.dataDir, 'assistant/downloads/index.json'), 'utf8');
  assert.ok(!registry.includes('%PDF-')); assert.ok(!registry.includes(f.dataDir));
  await f.service.close();
  const restored = await createAssistantDownloadService({ dataDir: f.dataDir, store: f.store, scienceDocuments: f.docs, webTools: f.webTools }); f.own(() => restored.close());
  assert.equal((await restored.list()).downloads[0].sha256, sha(buffer));
  assert.deepEqual((await restored.read(result.download.id)).buffer, buffer);
});

test('download tools work with no project and can later import the actual original into the selected science project', async t => {
  const f = await fixture(t), apps = createAssistantAppTools({ store: f.store, scienceDocuments: f.docs, webTools: f.webTools, downloads: f.service }); f.own(() => apps.close());
  const ctx = { projectId: null, runId: randomUUID(), callId: randomUUID(), instruction: '下载这份教材原文件', mode: 'auto', signal: new AbortController().signal, update() {} };
  const tool = id => apps.tools.find(tool => tool.name === id);
  const result = await tool('web_download').execute({ url: 'https://papers.example.org/book.txt' }, ctx);
  assert.equal(result.effects[0].type, 'download'); assert.equal(result.effects[0].download.size, text.length); assert.equal(result.effects[0].projectId, null);
  assert.equal((await f.store.list()).projects.length, 1, 'No hidden project is created for downloads');
  const list = await tool('download_list').execute({}, { ...ctx, runId: randomUUID() });
  assert.equal(list.effects[0].changed, false); assert.equal(list.effects[0].download.id, result.effects[0].download.id);
  const importCtx = { ...ctx, projectId: f.science.id, runId: randomUUID(), instruction: '把刚下载的原文件导入当前科普项目' };
  const projectHash = assistantContentHash(await f.store.read(f.science.id));
  const imported = await tool('download_import').execute({ downloadId: result.effects[0].download.id }, importCtx);
  const document = await f.docs.get(f.science.id, imported.data.documentId);
  assert.equal(document.sourceHash, sha(text)); assert.ok(document.units.some(unit => unit.text.includes('不能用摘要替换原文')));
  assert.deepEqual(await readFile(path.join(f.dataDir, 'science-documents', f.science.id, document.id, 'source.txt')), text);
  assert.equal(assistantContentHash(await f.store.read(f.science.id)), projectHash, 'Import does not change selected pages or profiles');
  await apps.undo({ projectId: f.science.id, undoId: imported.effects[0].undo.id });
  assert.equal((await f.docs.list(f.science.id)).documents.length, 0);
  assert.deepEqual((await f.service.read(result.effects[0].download.id)).buffer, text, 'Undoing import keeps the downloaded original');
});

test('project download scope, ask mode and missing projects prevent unauthorized writes or imports', async t => {
  const f = await fixture(t), apps = createAssistantAppTools({ store: f.store, scienceDocuments: f.docs, webTools: f.webTools, downloads: f.service }); f.own(() => apps.close());
  await f.store.save('science-b', { kind: 'science', title: '另一个项目', science: {} });
  const result = await f.service.download(sourceUrl, { projectId: f.science.id });
  assert.equal((await f.service.list({ projectId: 'science-b' })).downloads.length, 0);
  await assert.rejects(f.service.read(result.download.id, { projectId: 'science-b' }), { code: 'ASSISTANT_DOWNLOAD_NOT_FOUND' });
  await assert.rejects(f.service.importFile(result.download.id, { projectId: 'science-b' }), { code: 'ASSISTANT_DOWNLOAD_NOT_FOUND' });
  await assert.rejects(f.service.download(sourceUrl, { projectId: 'missing' }), { code: 'ASSISTANT_DOWNLOAD_PROJECT' });
  await assert.rejects(apps.tools.find(tool => tool.name === 'web_download').execute({ url: sourceUrl }, { mode: 'ask', signal: new AbortController().signal }), { code: 'ASSISTANT_READ_ONLY' });
  assert.equal(f.calls.length, 1);
});

test('same-run requests join and unchanged originals deduplicate without losing their working file link', async t => {
  const f = await fixture(t), runId = randomUUID();
  const [a, b] = await Promise.all([f.service.download(sourceUrl, { runId }), f.service.download(sourceUrl, { runId })]);
  assert.equal(a.download.id, b.download.id); assert.equal(f.calls.length, 1);
  const c = await f.service.download(sourceUrl, { runId: randomUUID() });
  assert.equal(c.duplicate, true); assert.equal(c.download.id, a.download.id); assert.equal((await f.service.list()).downloads.length, 1);
});

test('cancelled or corrupt downloads never produce a saved file, completion card or registry record', async t => {
  let started;
  const begun = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { download: async (_url, { signal }) => { started(); await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('stopped'), { status: 499 })), { once: true })); } });
  const controller = new AbortController(), downloading = f.service.download(sourceUrl, { signal: controller.signal });
  await begun; controller.abort(); await assert.rejects(downloading);
  assert.equal((await f.service.list()).downloads.length, 0); assert.deepEqual(await readdir(path.join(f.dataDir, 'assistant/downloads')), []);
  const broken = await fixture(t, { download: async () => ({ url: sourceUrl, buffer: text, fileName: 'book.txt', contentType: 'text/plain', size: text.length, sha256: '0'.repeat(64) }) });
  await assert.rejects(broken.service.download(sourceUrl), { code: 'ASSISTANT_DOWNLOAD_INTEGRITY' }); assert.equal((await broken.service.list()).downloads.length, 0);
});

test('download quotas, immutable file hashes, names and path traversal are enforced', async t => {
  const f = await fixture(t, { limits: { maxFiles: 1 } });
  const saved = await f.service.download(sourceUrl);
  await assert.rejects(f.service.download('https://papers.example.org/other.txt'), { code: 'ASSISTANT_DOWNLOAD_QUOTA' });
  await assert.rejects(f.service.read('../private'), { code: 'ASSISTANT_DOWNLOAD_NOT_FOUND' });
  const filename = path.join(f.dataDir, 'assistant/downloads', saved.download.id, 'payload');
  await writeFile(filename, Buffer.alloc(text.length, 65)); await assert.rejects(f.service.read(saved.download.id), { code: 'ASSISTANT_DOWNLOAD_CHANGED' });
  const bad = await fixture(t, { fileName: '../escape.pdf' });
  await assert.rejects(bad.service.download(sourceUrl), { code: 'ASSISTANT_DOWNLOAD_NAME' });
  assert.deepEqual(await readdir(path.join(bad.dataDir, 'assistant/downloads')), []);
});
