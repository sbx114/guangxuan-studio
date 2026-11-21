import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createProjectStore } from '../lib/store.mjs';
import { createScienceDocumentService } from '../lib/science-documents.mjs';
import { makeZip } from '../lib/documents.mjs';

const fixtures = fileURLToPath(new URL('./fixtures/science-documents/', import.meta.url));
async function setup(t, options = {}) {
  const parent = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(parent, { recursive: true });
  const dataDir = await mkdtemp(path.join(parent, 'gx-scidoc-')), store = await createProjectStore(dataDir);
  for (const id of ['science-one', 'science-two']) await store.save(id, { kind: 'science', title: id, source: { title: '', text: '', url: '' }, facts: [], brief: {}, science: {} });
  await store.save('writing-one', { kind: 'writing', title: '不属于科普', source: { title: '', text: '', url: '' }, facts: [] });
  const service = await createScienceDocumentService({ dataDir, store, ...options });
  let server;
  t.after(async () => { if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } await service.close(); await store.settle(); assert.ok(path.basename(dataDir).startsWith('gx-scidoc-')); await rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, store, service, async http({ signal, onRequest } = {}) { server = http.createServer(async (req, res) => { onRequest?.(req); if (!await service.handler(req, res, new URL(req.url, 'http://' + req.headers.host), { signal })) { res.writeHead(404); res.end(); } }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return 'http://127.0.0.1:' + server.address().port; } };
}
const file = name => readFile(path.join(fixtures, name));

test('real bilingual PDF preserves page IDs, Chinese and formulas in explicitly selected context', async t => {
  const { service, dataDir } = await setup(t);
  const result = await service.importBuffer('science-one', { name: '双语力学论文.pdf', buffer: await file('bilingual-paper.pdf') }), document = result.document;
  assert.equal(document.pageCount, 3); assert.equal(document.units.length, 3); assert.equal(document.readableUnitCount, 3);
  assert.match(document.units[0].text, /Torque is the product/); assert.match(document.units[0].text, /力矩等于力/);
  assert.match(document.units[1].text, /F = m a/); assert.equal(document.units[1].page, 2);
  const context = await service.context('science-one', { documentId: document.id, unitIds: [document.units[1].id] });
  assert.equal(context.units.length, 1); assert.equal(context.units[0].page, 2); assert.equal(context.units[0].label, '第2页');
  assert.match(context.text, /牛顿第二定律/); assert.ok(!context.text.includes('Torque is the product'));
  assert.match(context.hash, /^[a-f0-9]{64}$/); assert.ok(!JSON.stringify(context).includes(dataDir));
  const restored = await service.get('science-one', document.id); assert.deepEqual(restored.units, document.units);
  await assert.rejects(service.context('science-one', { documentId: document.id, unitIds: [] }), { code: 'SCIENCE_DOCUMENT_SELECTION_REQUIRED' });
  await assert.rejects(service.context('science-one', { documentId: document.id, unitIds: [document.units[0].id, document.units[0].id] }), { code: 'SCIENCE_DOCUMENT_SELECTION_REQUIRED' });
});

test('matching local PDF.js CMaps extract nonembedded Chinese CID fonts without network resources', async t => {
  const { service } = await setup(t);
  const { document } = await service.importBuffer('science-one', { name: '中文CID教材.pdf', buffer: await file('chinese-cid.pdf') });
  assert.equal(document.pageCount, 1); assert.match(document.units[0].text, /第二章 力矩与杠杆/); assert.match(document.units[0].text, /垂直力臂/);
  assert.ok(!document.warnings.some(warning => warning.code === 'PAGE_WITHOUT_TEXT'));
});

test('long text, Markdown and DOCX are segmented without truncation and context budgets reject oversize selections', async t => {
  const { service } = await setup(t);
  const first = '# 第一章 力学\n' + '第一章原文。'.repeat(6500) + '\n第一章结尾标识。',
    second = '\n\n# 第二章 测量\n' + '第二章内容。'.repeat(6500) + '\n教材末尾唯一标识。';
  const { document } = await service.importBuffer('science-one', { name: '长教材.md', buffer: Buffer.from(first + second) });
  assert.ok(document.characterCount > 60000); assert.ok(document.units.length > 10);
  assert.ok(document.units.every(unit => unit.text.length <= 6000)); assert.ok(document.units.at(-1).text.endsWith('教材末尾唯一标识。'));
  assert.ok(document.units.some(unit => unit.label.startsWith('第二章')));
  await assert.rejects(service.context('science-one', { documentId: document.id, unitIds: document.units.map(unit => unit.id) }), { code: 'SCIENCE_DOCUMENT_SELECTION_TOO_LARGE' });
  const one = await service.context('science-one', { documentId: document.id, unitIds: [document.units[0].id] }); assert.equal(one.units.length, 1);
  const docx = makeZip({ 'word/document.xml': '<w:document xmlns:w="urn:test"><w:body><w:p><w:r><w:t>Chapter 1 Motion</w:t></w:r></w:p><w:p><w:r><w:t>牛顿第二定律与教材原文。</w:t></w:r></w:p></w:body></w:document>' });
  const imported = await service.importBuffer('science-one', { name: '教材.docx', buffer: docx });
  assert.match(imported.document.units[0].text, /牛顿第二定律/); assert.ok(imported.document.warnings.some(item => item.code === 'DOCX_TEXT_ONLY'));
  const plain = await service.importText('science-one', { title: '粘贴原文', text: '第一章 学术方法\n科学假设应当可以检验。\n\n第二章 观察\n记录观察结果。' });
  assert.equal(plain.document.sourceType, 'text'); assert.equal(plain.document.units.length, 2);
});

test('encrypted PDFs, scan-only pages, malformed files and unsupported or oversized inputs are explicit errors', async t => {
  const { service } = await setup(t);
  for (const [name, code] of [['encrypted.pdf', 'SCIENCE_PDF_PASSWORD_REQUIRED'], ['scan-only.pdf', 'SCIENCE_PDF_NO_TEXT']]) await assert.rejects(service.importBuffer('science-one', { name, buffer: await file(name) }), { code });
  await assert.rejects(service.importBuffer('science-one', { name: '假的.pdf', buffer: Buffer.from('not a PDF') }), { code: 'SCIENCE_PDF_INVALID' });
  await assert.rejects(service.importBuffer('science-one', { name: '../paper.pdf', buffer: Buffer.from('x') }), { code: 'SCIENCE_DOCUMENT_NAME_INVALID' });
  await assert.rejects(service.importBuffer('science-one', { name: 'paper.exe', buffer: Buffer.from('x') }), { code: 'SCIENCE_DOCUMENT_FORMAT' });
  await assert.rejects(service.importBuffer('science-one', { name: 'large.docx', buffer: Buffer.alloc(10 * 1024 * 1024 + 1) }), { code: 'SCIENCE_DOCUMENT_FILE_LIMIT' });
  assert.equal((await service.list('science-one')).documents.length, 0);
});

test('source integrity, cross-project scope and recreated-owner checks prevent stale or foreign evidence', async t => {
  const { service, store, dataDir } = await setup(t);
  const { document } = await service.importText('science-one', { title: '原文', text: '力矩是力与垂直力臂的乘积。' });
  await assert.rejects(service.get('science-two', document.id), { code: 'SCIENCE_DOCUMENT_NOT_FOUND' });
  await assert.rejects(service.list('writing-one'), { code: 'SCIENCE_DOCUMENT_PROJECT_NOT_FOUND' });
  const directory = path.join(dataDir, 'science-documents', 'science-one', document.id);
  const source = path.join(directory, 'source.txt'), previous = await readFile(source);
  await writeFile(source, '被改变的原文件'); await assert.rejects(service.get('science-one', document.id), { code: 'SCIENCE_DOCUMENT_CHANGED' });
  await writeFile(source, previous);
  const unitsFile = path.join(directory, 'units.json'), rawUnits = await readFile(unitsFile); await writeFile(unitsFile, '[]');
  await assert.rejects(service.get('science-one', document.id), { code: 'SCIENCE_DOCUMENT_CHANGED' }); await writeFile(unitsFile, rawUnits);
  const current = await store.read('science-one'); await store.remove('science-one');
  await store.save('science-one', { ...current, createdAt: '2026-01-01T00:00:00.000Z' });
  await assert.rejects(service.get('science-one', document.id), { code: 'SCIENCE_DOCUMENT_OWNER_MISMATCH' });
  assert.equal((await service.list('science-one')).documents.length, 0);
});

test('portable restoration rewrites only the document owner while preserving source and unit IDs', async t => {
  const { service, store, dataDir } = await setup(t);
  const { document } = await service.importBuffer('science-one', { name: 'paper.pdf', buffer: await file('bilingual-paper.pdf') });
  const original = path.join(dataDir, 'science-documents', 'science-one', document.id), prior = await readFile(path.join(original, 'document.json'));
  const destination = path.join(dataDir, 'science-documents', 'science-two', document.id); await cp(original, destination, { recursive: true });
  const metadata = JSON.parse(prior.toString('utf8')); metadata.projectId = 'science-two'; metadata.ownerCreatedAt = (await store.read('science-two')).createdAt;
  await writeFile(path.join(destination, 'document.json'), JSON.stringify(metadata));
  const imported = await service.get('science-two', document.id); assert.equal(imported.sourceHash, document.sourceHash); assert.deepEqual(imported.units, document.units);
  const context = await service.context('science-two', { documentId: document.id, unitIds: [document.units[0].id] }); assert.match(context.text, /力矩/);
  assert.deepEqual(await readFile(path.join(original, 'document.json')), prior);
});

test('real worker cancellation releases the queue and duplicate imports are serialized without duplicate records', async t => {
  const { service } = await setup(t), controller = new AbortController();
  const running = service.importBuffer('science-one', { name: 'cancel.pdf', buffer: await file('bilingual-paper.pdf') }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(running, { code: 'SCIENCE_IMPORT_CANCELLED' });
  const text = { title: '去重', text: '同一段资料只保留一份稳定记录。' };
  const results = await Promise.all([service.importText('science-one', text), service.importText('science-one', text), service.importText('science-one', text)]);
  assert.equal(new Set(results.map(value => value.document.id)).size, 1); assert.equal(results.filter(value => value.duplicate).length, 2);
  assert.equal((await service.list('science-one')).documents.length, 1);
});

test('HTTP raw PDF upload, page context, source download and deletion use controlled project routes', async t => {
  const env = await setup(t), base = await env.http();
  const response = await fetch(base + '/api/projects/science-one/science-documents/upload', { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent('中文论文.pdf') }, body: await file('bilingual-paper.pdf') });
  assert.equal(response.status, 201); const { document } = await response.json();
  const selected = await fetch(base + '/api/projects/science-one/science-documents/context', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ documentId: document.id, unitIds: [document.units[2].id] }) });
  assert.equal(selected.status, 200); assert.equal((await selected.json()).units[0].page, 3);
  const foreign = await fetch(base + '/api/projects/science-two/science-documents/' + document.id); assert.equal(foreign.status, 404); assert.ok(!JSON.stringify(await foreign.json()).includes(env.dataDir));
  const head = await fetch(base + '/api/projects/science-one/science-documents/' + document.id + '/source', { method: 'HEAD' });
  assert.equal(head.status, 200); assert.match(head.headers.get('content-disposition'), /attachment/); assert.ok(Number(head.headers.get('content-length')) > 1000);
  const raw = await fetch(base + '/api/projects/science-one/science-documents/' + document.id + '/source'); assert.deepEqual(Buffer.from(await raw.arrayBuffer()), await file('bilingual-paper.pdf'));
  const removed = await fetch(base + '/api/projects/science-one/science-documents/' + document.id, { method: 'DELETE' }); assert.equal(removed.status, 200);
  assert.equal((await env.service.list('science-one')).documents.length, 0);
  const remaining = await readdir(path.join(env.dataDir, 'science-documents', 'science-one')); assert.deepEqual(remaining, []);
});

async function waitingBody(base, onReady) {
  let finish;
  const settled = new Promise(resolve => { finish = resolve; });
  const request = http.request(base + '/api/projects/science-one/science-documents/upload', { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-file-name': 'slow.pdf', 'content-length': '1000000' } }, response => { response.resume(); response.once('end', () => finish({ status: response.statusCode })); });
  request.once('error', value => finish({ code: value.code }));
  request.write('%PDF-1.7\n');
  await onReady();
  return { request, settled };
}
async function waitForBodyReader(read) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const incoming = read();
    if (incoming && incoming.listenerCount('readable') > 0) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('The isolated HTTP body reader did not begin.');
}
test('aborting a real stalled HTTP body wakes the reader without waiting for another chunk or EOF', { timeout: 5000 }, async t => {
  const env = await setup(t), controller = new AbortController(); let incoming;
  const base = await env.http({ signal: controller.signal, onRequest: value => { incoming = value; } });
  const upload = await waitingBody(base, () => waitForBodyReader(() => incoming));
  t.after(() => upload.request.destroy());
  const started = Date.now(); controller.abort();
  const result = await Promise.race([upload.settled, new Promise(resolve => setTimeout(() => resolve('timed-out'), 1000))]);
  assert.notEqual(result, 'timed-out'); assert.ok(Date.now() - started < 1000);
  assert.equal(incoming.destroyed, true); assert.equal((await env.service.list('science-one')).documents.length, 0);
  assert.equal((await env.service.importText('science-one', { title: '取消后继续', text: '已取消的上传不会阻塞下一份资料。' })).document.readableUnitCount, 1);
});
test('closing the service interrupts a real stalled upload and does not leave a body reader alive', { timeout: 5000 }, async t => {
  const env = await setup(t); let incoming;
  const base = await env.http({ onRequest: value => { incoming = value; } });
  const upload = await waitingBody(base, () => waitForBodyReader(() => incoming));
  t.after(() => upload.request.destroy());
  const started = Date.now(); await env.service.close();
  const result = await Promise.race([upload.settled, new Promise(resolve => setTimeout(() => resolve('timed-out'), 1000))]);
  assert.notEqual(result, 'timed-out'); assert.ok(Date.now() - started < 1000); assert.equal(incoming.destroyed, true);
});
