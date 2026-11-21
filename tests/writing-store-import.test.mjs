import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { createProjectStore, assistantContentHash } from '../lib/store.mjs';
import { importWritingDocument } from '../lib/writing-import.mjs';

async function setup(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gx-writing-store-'));
  const store = await createProjectStore(directory);
  t.after(async () => { await store.settle(); if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('gx-writing-store-')) throw Error('Unsafe cleanup'); await rm(directory, { recursive: true, force: true }); });
  const project = await store.save('writing-a', { kind: 'writing', title: '旧文案', source: { title: '', text: '真实材料', url: '' }, outputs: { social: { title: '旧稿', text: '保留这份原稿', tags: [] } } });
  return { store, project };
}
test('writing revisions opt in without breaking legacy saves, then serialize concurrent editing safely', async t => {
  const f = await setup(t);
  const legacy = await f.store.save(f.project.id, { ...f.project, title: '旧编辑器依然能保存' });
  assert.equal(legacy.writingRevision, undefined);
  const first = await f.store.save(legacy.id, { ...legacy, writingRevision: 0 }, { requireExisting: true });
  assert.equal(first.writingRevision, 1);
  const one = structuredClone(first), two = structuredClone(first); one.source.text = '窗口一的新材料'; two.source.text = '窗口二的旧分支';
  const results = await Promise.allSettled([f.store.save(first.id, one), f.store.save(first.id, two)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'WRITING_STALE_PROJECT');
  const current = await f.store.read(first.id); assert.equal(current.writingRevision, 2); assert.equal(current.source.text, '窗口一的新材料');
  assert.equal(current.outputs.social.text, '保留这份原稿');
});

test('writing revisions coexist with assistant CAS and undo without allowing stale autosaves', async t => {
  const f = await setup(t), first = await f.store.save(f.project.id, { ...f.project, writingRevision: 0 });
  const hash = assistantContentHash(first);
  assert.equal(assistantContentHash({ ...first, writingRevision: 999 }), hash);
  const edited = await f.store.updateAssistant(first.id, { expectedHash: hash, patch: [{ path: ['outputs', 'social'], value: { title: '新稿', text: '助手已保存的新稿', tags: [] } }] });
  assert.equal(edited.project.writingRevision, 2);
  await assert.rejects(f.store.save(first.id, first), error => error.status === 409);
  const restored = await f.store.updateAssistant(first.id, { expectedHash: edited.afterHash, patch: edited.before.map(item => ({ path: item.path, value: item.value })) });
  assert.equal(restored.project.outputs.social.text, first.outputs.social.text);
  assert.equal(assistantContentHash(restored.project), hash); assert.equal(restored.project.writingRevision, 3);
});

test('late writing saves cannot recreate a removed project, while internal new-ID bundle restoration remains compatible', async t => {
  const f = await setup(t), edited = await f.store.save(f.project.id, { ...f.project, writingRevision: 0 });
  await f.store.remove(edited.id);
  await assert.rejects(f.store.save(edited.id, edited, { requireExisting: true }), { code: 'PROJECT_NOT_FOUND' });
  assert.equal(await f.store.read(edited.id), null);
  const restored = await f.store.save('restored-writing', { ...edited, id: 'restored-writing' });
  assert.equal(restored.writingRevision, 1); assert.equal(restored.source.text, edited.source.text);
});

test('writing import extracts original PDF and Unicode text locally without truncating materials', async () => {
  const buffer = await readFile(new URL('./fixtures/science-documents/bilingual-paper.pdf', import.meta.url));
  const pdf = await importWritingDocument({ name: '原始论文.pdf', contentBase64: buffer.toString('base64') });
  assert.equal(pdf.pageCount, 3); assert.match(pdf.text, /力矩等于力/); assert.match(pdf.text, /Torque is the product/); assert.ok(pdf.warnings.length);
  const text = '周五下午举办公开讲座，地点与报名方式尚待确定。';
  const value = await importWritingDocument({ name: '材料.md', contentBase64: Buffer.from(text).toString('base64') });
  assert.equal(value.text, text); assert.equal(value.characterCount, text.length);
});

test('writing import refuses empty scans, unsupported files and oversized text instead of inventing or clipping', async () => {
  const scan = await readFile(new URL('./fixtures/science-documents/scan-only.pdf', import.meta.url));
  await assert.rejects(async () => importWritingDocument({ name: '扫描.pdf', contentBase64: scan.toString('base64') }), { code: 'WRITING_IMPORT_NO_TEXT' });
  await assert.rejects(async () => importWritingDocument({ name: '材料.xlsx', contentBase64: Buffer.from('not a workbook').toString('base64') }), { code: 'WRITING_IMPORT_FORMAT' });
  await assert.rejects(async () => importWritingDocument({ name: '过长.txt', contentBase64: Buffer.from('长'.repeat(60001)).toString('base64') }), { code: 'WRITING_IMPORT_TOO_LONG' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(async () => importWritingDocument({ name: '正文.txt', contentBase64: Buffer.from('正文材料').toString('base64') }, { signal: controller.signal }), { code: 'WRITING_IMPORT_CANCELLED' });
});
