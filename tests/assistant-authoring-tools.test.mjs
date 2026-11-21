import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { createProjectStore, assistantContentHash } from '../lib/store.mjs';
import { createAssistantAppTools } from '../lib/assistant-app-tools.mjs';
import { createReferenceService, referenceContentHash } from '../lib/references.mjs';
import { createNovelLibraryService } from '../lib/novel-library.mjs';
import { createScienceDocumentService } from '../lib/science-documents.mjs';
import { createAssistantArtifactService } from '../lib/assistant-artifacts.mjs';
import { extractDocx } from '../lib/documents.mjs';
import { normalizeNovelScript } from '../public/visual-novel-model.js';
import { singleGuideInput, singleGuideFixture } from './fixtures/single-guide.mjs';

const root = path.resolve(import.meta.dirname, '..');
const json = value => JSON.parse(JSON.stringify(value));
const article = { title: '当前稿件', lead: '导语', body: '必须真实导出的正文', titles: ['备选标题'] };
async function fixture(t, { kind = 'writing', patch = {}, services = {} } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'gx-assistant-authoring-')), store = await createProjectStore(dataDir);
  const project = await store.save('current-authoring', { kind, title: '当前项目', source: { title: '原材料', text: '第一份材料', url: '' }, facts: [{ id: 'F1', label: '信息', value: '旧事实', quote: '旧来源', confirmed: true, quoteMatched: true, status: 'confirmed' }], sourceChanged: false, review: { summary: '原审核' }, outputs: { article }, writing: { brief: { goal: '说明内容', channel: 'article' }, draft: { channel: 'article', output: article, sourceFingerprint: 'original' } }, ...patch });
  const references = await createReferenceService({ dataDir, store, videoService: { async resolveAsset(id) { return { id, type: 'image', size: 10, name: '图片' }; } } });
  const library = await createNovelLibraryService({ dataDir, store, videoService: process.env.GUANGXUAN_BIN_DIR ? { runtimeTools: () => ({ ffprobe: path.join(process.env.GUANGXUAN_BIN_DIR, 'ffprobe.exe') }) } : undefined });
  const documents = await createScienceDocumentService({ dataDir, root, store });
  const artifacts = await createAssistantArtifactService({ dataDir, root, store });
  const adapter = createAssistantAppTools({ store, root, references, novelLibrary: library, scienceDocuments: documents, artifacts, ...services });
  t.after(async () => { await adapter.close(); await references.close(); await documents.close(); await library.close(); await artifacts.close(); await store.settle(); await rm(dataDir, { recursive: true, force: true }); });
  const ctx = overrides => ({ projectId: project.id, runId: randomUUID(), instruction: '请修改当前项目并保存', origin: 'http://127.0.0.1:12345', mode: 'auto', signal: new AbortController().signal, update() {}, ...overrides });
  const call = (name, args, context = ctx()) => { const tool = adapter.tools.find(item => item.name === name); assert.ok(tool, `Missing ${name}`); return tool.execute(args, context); };
  return { dataDir, store, project, references, library, documents, artifacts, adapter, ctx, call };
}

test('writing material changes reset stale evidence, preserve outputs, deduplicate receipts and undo exactly', async t => {
  const fx = await fixture(t), ctx = fx.ctx(), before = assistantContentHash(fx.project);
  const args = { sourceMode: 'append', source: { text: '追加的真实材料' }, brief: { audience: '初次了解的读者', requiredPoints: ['保留条件'] } };
  const result = await fx.call('writing_material_update', args, ctx), repeat = await fx.call('writing_material_update', args, ctx);
  assert.deepEqual(result, repeat);
  const saved = await fx.store.read(fx.project.id);
  assert.equal(saved.source.text, '第一份材料\n\n追加的真实材料'); assert.equal(saved.source.title, '原材料');
  assert.equal(saved.sourceChanged, true); assert.equal(saved.review, null); assert.equal(saved.facts[0].confirmed, false); assert.equal(saved.facts[0].status, 'pending');
  assert.deepEqual(saved.outputs, fx.project.outputs); assert.deepEqual(saved.writing.draft, fx.project.writing.draft);
  assert.equal(saved.writing.brief.audience, '初次了解的读者'); assert.equal(saved.assistantRevision, 1);
  await fx.adapter.undo({ projectId: fx.project.id, undoId: result.effects[0].undo.id });
  assert.equal(assistantContentHash(await fx.store.read(fx.project.id)), before);
  await assert.rejects(fx.call('writing_material_update', { source: { text: '未明确追加或替换' } }), { status: 400 });
  await assert.rejects(fx.call('writing_material_update', args, fx.ctx({ mode: 'ask' })), { code: 'ASSISTANT_READ_ONLY' });
  await assert.rejects(fx.call('writing_material_update', args, fx.ctx({ signal: AbortSignal.abort() })), { code: 'REQUEST_CANCELLED' });
  assert.equal(assistantContentHash(await fx.store.read(fx.project.id)), before);
});

test('writing exports generate real local bytes and HTTP attachments that survive service restart', async t => {
  const fx = await fixture(t), initial = assistantContentHash(fx.project);
  for (const format of ['md', 'txt', 'docx']) {
    const result = await fx.call('writing_export', { format }), file = result.data.file;
    assert.ok(file.downloadUrl.startsWith('/api/assistant/exports/')); assert.equal(result.effects[0].artifact.downloadUrl, file.downloadUrl);
    const { buffer } = await fx.artifacts.read(file.id, { projectId: fx.project.id });
    const text = format === 'docx' ? extractDocx(buffer) : buffer.toString('utf8');
    assert.ok(text.includes(article.body)); assert.ok(!text.includes(fx.project.source.text));
    await assert.rejects(fx.artifacts.read(file.id, { projectId: 'other-project' }), { code: 'ASSISTANT_ARTIFACT_NOT_FOUND' });
    const restarted = await createAssistantArtifactService({ dataDir: fx.dataDir, root, store: fx.store });
    try { assert.deepEqual((await restarted.read(file.id)).buffer, buffer); } finally { await restarted.close(); }
    const server = http.createServer((req, res) => { void fx.artifacts.handler(req, res, new URL(req.url, 'http://127.0.0.1')).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }).catch(() => { res.writeHead(500); res.end(); }); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${file.downloadUrl}`);
      assert.equal(response.status, 200); assert.ok(response.headers.get('content-disposition').startsWith('attachment;')); assert.equal(response.headers.get('content-type'), file.contentType);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), buffer);
    } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
  }
  assert.equal(assistantContentHash(await fx.store.read(fx.project.id)), initial);
  await assert.rejects(fx.call('writing_export', { format: 'png' }), { code: 'ASSISTANT_WRITING_PNG_CHANNEL' });
  await assert.rejects(fx.artifacts.create({ projectId: fx.project.id, name: '../escape.txt', contentType: 'text/plain; charset=utf-8', buffer: Buffer.from('bad') }), { code: 'ASSISTANT_ARTIFACT_NAME' });
});

test('poster export runs the real fixed Canvas exporter and produces complete PNG pixels', { skip: process.env.GUANGXUAN_TEST_ANIMATION !== '1' }, async t => {
  const poster = { eyebrow: '本机导出', title: '完整海报', subtitle: '使用产品同一套Canvas排版', highlights: Array.from({ length: 18 }, (_, i) => `真实要点${i + 1}：文字必须完整保留。`), details: [{ label: '备注', value: '底部信息' }], footer: '最后一行也需要保留' };
  const fx = await fixture(t, { patch: { writing: { brief: { channel: 'poster' }, draft: { channel: 'poster', output: poster } }, outputs: { poster } } });
  const result = await fx.call('writing_export', { format: 'png' }), { buffer, file } = await fx.artifacts.read(result.data.file.id);
  assert.equal(file.contentType, 'image/png'); assert.equal(buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(buffer.readUInt32BE(16), 1080); assert.ok(buffer.readUInt32BE(20) > 1600); assert.ok(buffer.length > 20000);
});

test('reference tools keep current ownership, enforce media scope and undo several mutations in reverse', async t => {
  const fx = await fixture(t, { kind: 'video', patch: { video: { editScope: { assetIds: ['allowed-image'], placement: { mode: 'append' } } } } });
  const before = await fx.references.list(fx.project.id), ctx = fx.ctx({ editScope: { assetIds: ['allowed-image'], placement: { mode: 'append' } } });
  const first = await fx.call('reference_manage', { action: 'add', expectedRevision: 0, item: { type: 'text', name: '文字参考', text: '真实的参考文字' } }, ctx);
  const referenceId = first.data.items[0].id;
  const second = await fx.call('reference_manage', { action: 'update', expectedRevision: 1, referenceId, item: { focus: '字体和节奏', aspects: ['titles', 'editing'], targetRange: { start: 2, end: 4 } } }, ctx);
  const third = await fx.call('reference_manage', { action: 'configure', expectedRevision: 2, includeImages: false }, ctx);
  assert.equal(third.data.includeImages, false); assert.deepEqual(third.data.items[0].targetRange, { start: 2, end: 4 });
  for (const receipt of [third, second, first]) await fx.adapter.undo({ projectId: fx.project.id, undoId: receipt.effects[0].undo.id });
  assert.equal(referenceContentHash(await fx.references.list(fx.project.id)), referenceContentHash(before));
  const state = await fx.references.list(fx.project.id);
  await assert.rejects(fx.call('reference_manage', { action: 'add', expectedRevision: state.revision, item: { type: 'image', assetId: 'not-selected-image' } }, fx.ctx({ editScope: { assetIds: ['allowed-image'], placement: { mode: 'append' } } })), { code: 'ASSISTANT_REFERENCE_SCOPE' });
  const races = await Promise.allSettled([fx.references.add(fx.project.id, { type: 'text', text: '并发甲' }, { expectedRevision: state.revision }), fx.references.add(fx.project.id, { type: 'text', text: '并发乙' }, { expectedRevision: state.revision })]);
  assert.equal(races.filter(item => item.status === 'fulfilled').length, 1); assert.equal(races.find(item => item.status === 'rejected').reason.code, 'REFERENCE_REVISION_CONFLICT');
});

test('knowledge selection uses actual imported units and changes config only from explicit IDs', async t => {
  const fx = await fixture(t, { kind: 'science', patch: { science: {} } });
  const imported = await fx.call('knowledge_import_text', { title: '真实教材', text: '对照实验需要只改变待研究的因素，并保持其他条件相同。\n\n结论需要说明适用条件。' });
  const document = imported.data.document, unitIds = document.units.map(unit => unit.id);
  const selected = await fx.call('knowledge_select', { documentId: document.id, unitIds });
  const context = await fx.call('knowledge_context', {}); assert.equal(context.data.documentId, document.id); assert.ok(context.data.text.includes('对照实验'));
  const before = assistantContentHash(await fx.store.read(fx.project.id));
  await assert.rejects(fx.call('knowledge_select', { documentId: document.id, unitIds: ['nonexistent'] }), { status: 400 });
  assert.equal(assistantContentHash(await fx.store.read(fx.project.id)), before);
  const character = (await fx.library.saveCharacter({ name: '用户选择的人物' })).character, background = (await fx.library.saveBackground({ name: '用户选择的场景' })).background;
  const configured = await fx.call('knowledge_configure', { characterId: character.id, backgroundId: background.id, interactionDensity: 'dense' });
  const saved = await fx.store.read(fx.project.id); assert.equal(saved.science.novelConfig.selectedCharacterId, character.id); assert.equal(saved.science.novelConfig.selectedBackgroundId, background.id); assert.equal(saved.science.novelConfig.interactionDensity, 'dense'); assert.equal(saved.science.novel, undefined);
  await fx.adapter.undo({ projectId: fx.project.id, undoId: configured.effects[0].undo.id });
  await fx.adapter.undo({ projectId: fx.project.id, undoId: selected.effects[0].undo.id });
  await fx.adapter.undo({ projectId: fx.project.id, undoId: imported.effects[0].undo.id });
  assert.equal((await fx.documents.list(fx.project.id)).documents.length, 0);
});

test('novel edits retain exact evidence and validate the whole playable work before saving', async t => {
  const input = singleGuideInput(), novel = normalizeNovelScript(singleGuideFixture(input), input);
  const resources = { config: input.config, assetCatalog: input.assetCatalog };
  const fakeLibrary = { list: async () => ({ characters: input.config.characters, backgrounds: input.config.backgrounds, assets: [], revision: 'r' }), resolveSelection: async () => resources };
  const fx = await fixture(t, { kind: 'science', patch: { science: { novel } }, services: { novelLibrary: fakeLibrary } });
  const read = await fx.call('novel_read', { limit: 1 }); assert.equal(read.data.truncated, true); assert.equal(read.data.scene.lines[0].index, 0);
  const result = await fx.call('novel_text_update', { edits: [{ path: ['scenes', 0, 'lines', 0, 'text'], expectedText: novel.scenes[0].lines[0].text, value: '我们先把原文条件看清楚。' }] });
  const saved = await fx.store.read(fx.project.id); assert.equal(saved.science.novel.scenes[0].lines[0].text, '我们先把原文条件看清楚。'); assert.deepEqual(json(saved.science.novel.documentSnapshot), novel.documentSnapshot); assert.deepEqual(json(saved.science.novel.scenes[0].lines[1].citations), novel.scenes[0].lines[1].citations);
  await assert.rejects(fx.call('novel_text_update', { edits: [{ path: ['scenes', 0, 'lines', 1, 'citations', 0, 'quote'], expectedText: '', value: '伪造证据' }] }), { code: 'ASSISTANT_NOVEL_PATH' });
  await assert.rejects(fx.call('novel_text_update', { edits: [{ path: ['scenes', 0, 'lines', 0, 'text'], expectedText: '猜测文字', value: '覆盖' }] }), { code: 'ASSISTANT_CONFLICT' });
  await fx.adapter.undo({ projectId: fx.project.id, undoId: result.effects[0].undo.id }); assert.deepEqual(json((await fx.store.read(fx.project.id)).science.novel), novel);
});

test('global library changes require explicit public-library scope and exact deletion, with CAS and undo', async t => {
  const fx = await fixture(t), library = await fx.library.list();
  const args = { action: 'create', kind: 'character', expectedRevision: library.revision, profile: { name: '清风', tone: '亲切', portraits: [] } };
  await assert.rejects(fx.call('library_profile_manage', args, fx.ctx({ instruction: '把这段话改得亲切' })), { code: 'ASSISTANT_LIBRARY_SCOPE' });
  const created = await fx.call('library_profile_manage', args, fx.ctx({ instruction: '请在公用素材库创建清风人物' }));
  const id = created.data.character.id;
  const changed = await fx.call('library_profile_manage', { action: 'update', kind: 'character', id, expectedRevision: created.data.revision, profile: { tone: '严谨简洁' } }, fx.ctx({ instruction: '修改公用素材库中清风的语气为严谨简洁' }));
  assert.equal(changed.data.character.name, '清风'); assert.equal(changed.data.character.tone, '严谨简洁');
  await assert.rejects(fx.call('library_profile_manage', { action: 'remove', kind: 'character', id, expectedRevision: changed.data.revision }, fx.ctx({ instruction: '删除公用素材库里不用的东西' })), { code: 'ASSISTANT_LIBRARY_DELETE_SCOPE' });
  await fx.adapter.undo({ projectId: fx.project.id, undoId: changed.effects[0].undo.id });
  await fx.adapter.undo({ projectId: fx.project.id, undoId: created.effects[0].undo.id });
  assert.deepEqual((await fx.library.list()).characters, []);
  const current = await fx.library.list();
  const results = await Promise.allSettled([fx.library.saveCharacter({ name: '甲' }, { expectedRevision: current.revision }), fx.library.saveCharacter({ name: '乙' }, { expectedRevision: current.revision })]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1); assert.equal(results.find(item => item.status === 'rejected').reason.code, 'NOVEL_LIBRARY_REVISION_CONFLICT');
});

test('novel HTML and JSON exports embed actual images and the fixed offline reader without external requests', async t => {
  const input = singleGuideInput(), novel = normalizeNovelScript(singleGuideFixture(input), input);
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
  let reads = 0;
  const fakeLibrary = { resolveSelection: async () => ({ config: input.config, assetCatalog: input.assetCatalog }), file: async id => { assert.ok(['portrait1', 'portrait2', 'background1'].includes(id)); reads++; return { bytes: image, contentType: 'image/png' }; } };
  const fx = await fixture(t, { kind: 'science', patch: { science: { novel } }, services: { novelLibrary: fakeLibrary } });
  const exported = {};
  for (const format of ['html', 'json']) {
    const result = await fx.call('novel_export', { format }), { buffer, file } = await fx.artifacts.read(result.data.file.id);
    assert.ok(file.name.endsWith(format === 'html' ? '-视觉小说.html' : '.gxnovel.json')); assert.equal(result.effects[0].artifact.kind, 'novel');
    exported[format] = buffer.toString('utf8'); assert.ok(exported[format].includes('data:image/png;base64,'));
    if (format === 'html') { assert.ok(exported.html.includes('connect-src \'none\'')); assert.ok(exported.html.includes('createNovelPlayer')); const packed = JSON.parse(exported.html.match(/<script type="application\/json" id="novel-data">([\s\S]*?)<\/script>/)[1]); assert.ok(Object.values(packed.art.backgrounds).every(value => value.startsWith('data:image/png;base64,'))); }
    else { const value = JSON.parse(exported.json); assert.equal(value.format, 'gx-visual-novel'); assert.deepEqual(value.novel.documentSnapshot, novel.documentSnapshot); assert.equal(Object.keys(value.assets).length, 3); }
  }
  assert.equal(reads, 6);
  if (process.env.GUANGXUAN_TEST_ANIMATION === '1') {
    const [{ chromium }, { findAnimationBrowser }] = await Promise.all([import('playwright-core'), import('../animation/render.mjs')]);
    const browser = await chromium.launch({ executablePath: await findAnimationBrowser(), headless: true });
    try {
      const page = await browser.newPage();
      await page.route('**/*', route => route.abort());
      await page.setContent(exported.html, { waitUntil: 'domcontentloaded' });
      assert.equal(await page.locator('.vn-player').count(), 1);
      await page.waitForFunction(expected => document.querySelector('[data-vn-text]')?.textContent === expected, novel.scenes[0].lines[0].text, { timeout: 5000 });
      assert.equal(await page.locator('[data-vn-text]').innerText(), novel.scenes[0].lines[0].text);
    } finally { await browser.close(); }
  }
});

test('knowledge document deletion requires current source hash, clears selection explicitly, and preserves work snapshots', async t => {
  const fx = await fixture(t, { kind: 'science', patch: { science: {} } });
  const { document } = await fx.documents.importText(fx.project.id, { title: '要移除的资料', text: '真实的教材原文及其条件。' });
  await fx.call('knowledge_select', { documentId: document.id, unitIds: document.units.map(unit => unit.id) });
  await assert.rejects(fx.call('knowledge_document_remove', { documentId: document.id, expectedSourceHash: document.sourceHash }), { code: 'ASSISTANT_DOCUMENT_IN_USE' });
  await fx.call('knowledge_selection_clear', {});
  await assert.rejects(fx.call('knowledge_document_remove', { documentId: document.id, expectedSourceHash: '0'.repeat(64) }), { code: 'SCIENCE_DOCUMENT_CHANGED' });
  const result = await fx.call('knowledge_document_remove', { documentId: document.id, expectedSourceHash: document.sourceHash });
  assert.equal(result.data.removed, true); assert.equal((await fx.documents.list(fx.project.id)).documents.length, 0); assert.equal(result.effects[0].undo, undefined);
});

test('public library image tools import controlled download bytes, undo creation and protect referenced pictures', { skip: !process.env.GUANGXUAN_BIN_DIR }, async t => {
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'), seen = [];
  const fx = await fixture(t, { services: { downloads: { async read(id, options) { seen.push({ id, options }); return { buffer: image, download: { id, name: '下载图片.png' } }; } } } });
  const instruction = '请把下载的图片加入公用素材库，作为清风立绘';
  const args = { downloadId: randomUUID(), kind: 'portrait', name: '清风立绘.png', expectedRevision: (await fx.library.list()).revision };
  const first = await fx.call('library_asset_import', args, fx.ctx({ instruction }));
  assert.equal(first.data.asset.width, 1); assert.equal((await fx.library.list()).assets.length, 1); assert.deepEqual(seen[0], { id: args.downloadId, options: { projectId: fx.project.id } });
  await fx.adapter.undo({ projectId: fx.project.id, undoId: first.effects[0].undo.id }); assert.equal((await fx.library.list()).assets.length, 0);
  const second = await fx.call('library_asset_import', args, fx.ctx({ instruction })), asset = second.data.asset;
  const character = (await fx.library.saveCharacter({ name: '清风', portraits: [{ id: 'calm', name: '平静', assetId: asset.id }] })).character;
  let library = await fx.library.list();
  await assert.rejects(fx.call('library_asset_remove', { assetId: asset.id, expectedSha256: asset.sha256, expectedRevision: library.revision }, fx.ctx({ instruction: '删除公用素材库里的清风立绘.png' })), { code: 'NOVEL_ASSET_IN_USE' });
  await fx.library.removeCharacter(character.id); library = await fx.library.list();
  await assert.rejects(fx.call('library_asset_remove', { assetId: asset.id, expectedSha256: '0'.repeat(64), expectedRevision: library.revision }, fx.ctx({ instruction: '删除公用素材库里的清风立绘.png' })), { code: 'NOVEL_LIBRARY_REVISION_CONFLICT' });
  const removed = await fx.call('library_asset_remove', { assetId: asset.id, expectedSha256: asset.sha256, expectedRevision: library.revision }, fx.ctx({ instruction: '删除公用素材库里的清风立绘.png' }));
  assert.equal(removed.data.removed, true); assert.equal((await fx.library.list()).assets.length, 0); assert.equal(removed.effects[0].undo, undefined);
});

test('artifact integrity, cancellation, quota and project recreation protect prior files', async t => {
  const fx = await fixture(t), file = await fx.artifacts.create({ projectId: fx.project.id, name: '文件.txt', contentType: 'text/plain; charset=utf-8', buffer: Buffer.from('真实字节') });
  await assert.rejects(fx.artifacts.create({ projectId: fx.project.id, name: '取消.txt', contentType: 'text/plain; charset=utf-8', buffer: Buffer.from('不保存') }, { signal: AbortSignal.abort() }), { code: 'ASSISTANT_ARTIFACT_CANCELLED' });
  const payload = path.join(fx.dataDir, 'assistant', 'exports', file.id, 'payload'); await writeFile(payload, '替换字节');
  await assert.rejects(fx.artifacts.read(file.id), { code: 'ASSISTANT_ARTIFACT_CHANGED' });
  const quota = await createAssistantArtifactService({ dataDir: fx.dataDir, store: fx.store, maxFiles: 1 });
  try { await assert.rejects(quota.create({ projectId: fx.project.id, name: '超量.txt', contentType: 'text/plain; charset=utf-8', buffer: Buffer.from('超量') }), { code: 'ASSISTANT_ARTIFACT_QUOTA' }); } finally { await quota.close(); }
  const registry = path.join(fx.dataDir, 'assistant', 'exports', file.id, 'metadata.json'), metadata = JSON.parse(await readFile(registry, 'utf8')); metadata.projectCreatedAt = '2000-01-01T00:00:00.000Z'; await writeFile(registry, JSON.stringify(metadata));
  await assert.rejects(fx.artifacts.read(file.id), { code: 'ASSISTANT_ARTIFACT_PROJECT_CHANGED' });
});
