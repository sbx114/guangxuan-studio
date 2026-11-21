import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { deflateSync, gzipSync, gunzipSync } from 'node:zlib';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createProjectStore } from '../lib/store.mjs';
import { createNovelLibraryService } from '../lib/novel-library.mjs';
import { createScienceDocumentService } from '../lib/science-documents.mjs';
import { createProjectBundleService, PROJECT_BUNDLE_MAGIC } from '../lib/project-bundles.mjs';
import { normalizeVisualNovel } from '../lib/visual-novel.mjs';
import { hydratePlayableNovel } from '../public/visual-novel-model.js';
import { singleGuideFixture, singleGuideQuote } from './fixtures/single-guide.mjs';

const bin = process.env.GUANGXUAN_BIN_DIR, hash = bytes => createHash('sha256').update(bytes).digest('hex');
function png() {
  const chunk = (name, data) => { const type = Buffer.from(name), payload = Buffer.concat([type, data]); let crc = 0xffffffff; for (const byte of payload) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } const length = Buffer.alloc(4), sum = Buffer.alloc(4); length.writeUInt32BE(data.length); sum.writeUInt32BE((crc ^ 0xffffffff) >>> 0); return Buffer.concat([length, payload, sum]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(8); ihdr.writeUInt32BE(8, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.alloc(8 * 25, 0))), chunk('IEND', Buffer.alloc(0))]);
}
async function setup(t, overrides = {}) {
  const base = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(base, { recursive: true });
  const dataDir = await mkdtemp(path.join(base, 'gx-library-bundle-')), store = await createProjectStore(dataDir), documents = await createScienceDocumentService({ dataDir, store });
  const library = await createNovelLibraryService({ dataDir, store, videoService: { runtimeTools: () => ({ ffprobe: path.join(bin || '', 'ffprobe.exe') }) } });
  const bundles = await createProjectBundleService({ dataDir, root: path.resolve('.'), store, scienceDocuments: documents, novelLibrary: library, ...overrides });
  const extras = [];
  t.after(async () => { for (const service of extras.reverse()) await service.close(); await bundles.close(); await documents.close(); await library.close(); await store.settle(); assert.equal(path.dirname(dataDir), base); await rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, store, documents, library, bundles, async other(options) { const result = await createProjectBundleService({ dataDir, root: path.resolve('.'), store, scienceDocuments: documents, novelLibrary: library, ...options }); extras.push(result); return result; } };
}
async function populate(env, { name = '讲解员', id = 'guide', projectId = 'science-one' } = {}) {
  const bytes = png(), portrait = (await env.library.importBytes(bytes, { name: '立绘.png', kind: 'portrait' })).asset, background = (await env.library.importBytes(bytes, { name: '场景.png', kind: 'background' })).asset;
  await env.library.saveCharacter({ id, name, role: '严谨的学生', tone: '亲切', personality: '耐心', color: '#789e9c', portraits: [{ id: 'explain', name: '讲解', assetId: portrait.id }, { id: 'think', name: '思考', assetId: portrait.id }] });
  await env.library.saveBackground({ id: 'room', name: '自定义场景', assetId: background.id, fit: 'cover' });
  const selection = { characterId: id, backgroundId: 'room' }, resources = await env.library.resolveSelection(selection);
  await env.store.save(projectId, { kind: 'science', title: '材料故事', science: {} });
  const imported = await env.documents.importText(projectId, { title: '实验教材', text: singleGuideQuote + '\n结论需要说明适用条件，不能把类比直接当成真实机制。' });
  const documentSelection = { documentId: imported.document.id, unitIds: [imported.document.units[0].id] }, document = await env.documents.context(projectId, documentSelection);
  const novel = normalizeVisualNovel(singleGuideFixture({ document, config: resources.config }), { ...resources, document });
  const project = await env.store.save(projectId, { kind: 'science', title: '材料故事', science: { documentSelection, novel, novelConfig: { librarySelection: selection, interactionDensity: 'balanced', instruction: '' } } });
  return { project, resources, selection, portrait, background, documentSelection, novel, bytes };
}
async function packageBytes(env, id = 'science-one') { const value = await env.bundles.prepareExport(id); return readFile(path.join(env.dataDir, 'project-bundles', value.token, 'project.gxproject')); }
function unpack(bytes) { const raw = gunzipSync(bytes), start = PROJECT_BUNDLE_MAGIC.length + 4, length = raw.readUInt32BE(PROJECT_BUNDLE_MAGIC.length), manifest = JSON.parse(raw.subarray(start, start + length)); let at = start + length; return { manifest, entries: new Map(manifest.files.map(file => { const bytes = raw.subarray(at, at + file.size); at += file.size; return [file.path, bytes]; })) }; }
function repack({ manifest, entries }) { const json = Buffer.from(JSON.stringify(manifest)), length = Buffer.alloc(4); length.writeUInt32BE(json.length); return gzipSync(Buffer.concat([PROJECT_BUNDLE_MAGIC, length, json, ...manifest.files.map(file => entries.get(file.path))])); }
async function serve(t, env) { const server = http.createServer((req, res) => { env.bundles.handler(req, res, new URL(req.url, 'http://localhost')).then(ok => { if (!ok) { res.writeHead(404); res.end(); } }); }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }); return 'http://127.0.0.1:' + server.address().port; }

test('explicit HTTP packages carry only selected shared resources once and restore to an empty global library', { skip: !bin, timeout: 60000 }, async t => {
  const origin = await setup(t), target = await setup(t), source = await populate(origin);
  await origin.library.importBytes(png(), { name: '未选择素材.png', kind: 'portrait' });
  await origin.store.save('science-two', { kind: 'science', title: '共享的另一项目', science: { novelConfig: { librarySelection: source.selection } } });
  const baseline = await readFile(path.join(origin.dataDir, 'projects/science-one.json'));
  const originUrl = await serve(t, origin), targetUrl = await serve(t, target);
  const exported = await (await fetch(originUrl + '/api/project-bundles/exports', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: 'science-one' }) })).json();
  assert.equal(exported.report.ok, true); assert.equal(exported.report.assetCount, 2);
  const bytes = Buffer.from(await (await fetch(originUrl + '/api/project-bundles/exports/' + exported.token + '/file')).arrayBuffer()), archive = unpack(bytes);
  assert.equal(archive.manifest.files.filter(file => /^novel-library\/assets\//.test(file.path)).length, 2);
  assert.ok(archive.entries.has('novel-library/science-one/novel.json')); assert.ok(archive.entries.has('novel-library/science-one/draft.json'));
  assert.ok(!gunzipSync(bytes).includes(Buffer.from('未选择素材'))); assert.ok(!archive.entries.get('project.json').includes(Buffer.from('characters')));
  const received = await fetch(targetUrl + '/api/project-bundles/imports', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bytes }); assert.equal(received.status, 201); const preview = await received.json();
  const response = await fetch(targetUrl + '/api/project-bundles/imports/' + preview.token + '/restore', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true }) }); assert.equal(response.status, 201); const restored = await response.json();
  const project = await target.store.read(restored.projectId), resolved = await target.library.resolveSelection(project.science.novel.librarySelection), runtime = hydratePlayableNovel(project.science.novel, resolved);
  assert.deepEqual(runtime.scenes[0].lines, source.novel.scenes[0].lines); assert.equal(JSON.stringify(project.science.novel.documentSnapshot), JSON.stringify(source.novel.documentSnapshot));
  assert.equal((await target.library.list()).assets.length, 2); assert.equal((await target.library.list()).characters.length, 1);
  assert.ok(!(await readdir(target.dataDir)).includes('novel-assets')); assert.equal('characters' in project.science.novel, false);
  const oldSource = path.join(origin.dataDir, 'science-documents/science-one', source.documentSelection.documentId, 'source.txt'), newSource = path.join(target.dataDir, 'science-documents', restored.projectId, source.documentSelection.documentId, 'source.txt');
  assert.deepEqual(await readFile(newSource), await readFile(oldSource)); assert.deepEqual(await readFile(path.join(origin.dataDir, 'projects/science-one.json')), baseline);
});

test('conflicting global profile IDs are remapped without replacing existing profiles or altering learning text', { skip: !bin, timeout: 60000 }, async t => {
  const origin = await setup(t), target = await setup(t), source = await populate(origin), existing = await populate(target, { name: '目标机器原有人物', projectId: 'existing' });
  source.novel.scenes[0].lines[0].text = source.project.id;
  await origin.store.save(source.project.id, { ...source.project, science: { ...source.project.science, novel: source.novel } });
  const before = await target.library.resolveSelection(existing.selection), preview = await target.bundles.receiveImport(Readable.from([await packageBytes(origin)])), restored = await target.bundles.restoreImport(preview.token);
  const project = await target.store.read(restored.projectId), selected = project.science.novel.librarySelection;
  assert.notEqual(selected.characterId, 'guide'); assert.deepEqual(project.science.novelConfig.librarySelection, selected);
  const runtime = hydratePlayableNovel(project.science.novel, await target.library.resolveSelection(selected)); assert.equal(runtime.characters[0].name, '讲解员');
  assert.deepEqual(runtime.scenes[0].lines.map(line => [line.text, line.question, line.card, line.citations, line.poseId]), source.novel.scenes[0].lines.map(line => [line.text, line.question, line.card, line.citations, line.poseId]));
  assert.equal(runtime.scenes[0].actors[0].characterId, selected.characterId); assert.ok(runtime.scenes[0].lines.filter(line => line.speakerId).every(line => line.speakerId === selected.characterId));
  assert.deepEqual(await target.library.resolveSelection(existing.selection), before); assert.equal((await target.library.list()).assets.length, 2, 'Identical picture bytes are reused in the shared library.');
});

test('failed project commit rolls back only newly imported shared resources after removing new projects', { skip: !bin, timeout: 60000 }, async t => {
  const origin = await setup(t), source = await populate(origin); await origin.store.save('dependency', { kind: 'writing', title: '依赖文稿' });
  await origin.store.save('science-one', { ...source.project, sourceProjectId: 'dependency' }); const bytes = await packageBytes(origin);
  for (const reuse of [false, true]) {
    const target = await setup(t); if (reuse) await populate(target, { projectId: 'existing' });
    const libraryBefore = await target.library.list(), projectsBefore = await target.store.list(); let saves = 0;
    const broken = await target.other({ store: { ...target.store, async save(id, project) { if (++saves === 2) throw new Error('Second project commit failed'); return target.store.save(id, project); } } });
    const preview = await broken.receiveImport(Readable.from([bytes])); await assert.rejects(broken.restoreImport(preview.token), /Second project commit failed/);
    assert.deepEqual(await target.library.list(), libraryBefore); assert.deepEqual(await target.store.list(), projectsBefore);
  }
});

test('missing shared files, mismatched metadata and changed project ownership are rejected before restore', { skip: !bin, timeout: 60000 }, async t => {
  const origin = await setup(t), target = await setup(t); await populate(origin); const bytes = await packageBytes(origin);
  for (const mutate of [
    archive => { const file = archive.manifest.files.find(file => file.path.startsWith('novel-library/assets/')); archive.manifest.files = archive.manifest.files.filter(item => item !== file); },
    archive => { const name = 'novel-library/science-one/novel.json', record = JSON.parse(archive.entries.get(name)); record.assets[0].metadata.sha256 = 'a'.repeat(64); const bytes = Buffer.from(JSON.stringify(record)); archive.entries.set(name, bytes); Object.assign(archive.manifest.files.find(file => file.path === name), { size: bytes.length, sha256: hash(bytes) }); },
    archive => { const file = archive.manifest.files.find(file => file.path === 'novel-library/science-one/novel.json'); file.path = 'novel-library/other-project/novel.json'; archive.entries.set(file.path, archive.entries.get('novel-library/science-one/novel.json')); },
  ]) { const archive = unpack(bytes); mutate(archive); await assert.rejects(target.bundles.receiveImport(Readable.from([repack(archive)])), { code: 'BUNDLE_NOVEL_LIBRARY_INVALID' }); }
  assert.deepEqual((await target.library.list()).assets, []); assert.deepEqual((await target.store.list()).projects, []);
});

test('export preflight refuses a corrupt shared image and preserves the source project', { skip: !bin, timeout: 60000 }, async t => {
  const env = await setup(t), source = await populate(env), baseline = await readFile(path.join(env.dataDir, 'projects/science-one.json'));
  await writeFile(path.join(env.dataDir, 'novel-library/novel-assets/shared-library', source.portrait.id, 'image.png'), Buffer.from('broken image'));
  const report = await env.bundles.inspectProject('science-one'); assert.equal(report.ok, false); assert.ok(report.issues.some(item => item.code === 'BUNDLE_NOVEL_LIBRARY_INVALID'));
  await assert.rejects(env.bundles.prepareExport('science-one'), { code: 'BUNDLE_PREFLIGHT_FAILED' }); assert.deepEqual(await readFile(path.join(env.dataDir, 'projects/science-one.json')), baseline);
});

test('a preparation-only project carries its selected profiles without inventing a generated story', { skip: !bin, timeout: 60000 }, async t => {
  const origin = await setup(t), target = await setup(t), source = await populate(origin);
  await origin.store.save('preparation', { kind: 'science', title: '尚未生成', science: { novelConfig: { selectedCharacterId: source.selection.characterId, selectedBackgroundId: source.selection.backgroundId, interactionDensity: 'sparse', instruction: '按材料安排练习' } } });
  const bytes = await packageBytes(origin, 'preparation'), archive = unpack(bytes);
  assert.ok(archive.entries.has('novel-library/preparation/draft.json')); assert.ok(!archive.entries.has('novel-library/preparation/novel.json'));
  const preview = await target.bundles.receiveImport(Readable.from([bytes])), restored = await target.bundles.restoreImport(preview.token), project = await target.store.read(restored.projectId);
  assert.equal(project.science.novel, undefined); assert.equal(project.science.novelConfig.interactionDensity, 'sparse'); assert.equal(project.science.novelConfig.instruction, '按材料安排练习');
  assert.equal((await target.library.resolveSelection(project.science.novelConfig.librarySelection)).config.characters[0].name, '讲解员');
  const partial = await origin.store.save('partial-preparation', { kind: 'science', title: '仅选一项', science: { novelConfig: { selectedCharacterId: source.selection.characterId } } });
  const report = await origin.bundles.inspectProject(partial.id); assert.equal(report.ok, false); assert.ok(report.issues.some(item => /选择尚未完整/.test(item.message)));
});
