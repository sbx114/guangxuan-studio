import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { deflateSync, crc32 } from 'node:zlib';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createProjectStore, assistantContentHash } from '../lib/store.mjs';
import { createProjectLinkService } from '../lib/project-links.mjs';
import { createProjectCovers, validateCoverPng } from '../lib/project-covers.mjs';
import { createAssistantAppTools } from '../lib/assistant-app-tools.mjs';
import { createAssistantArtifactService } from '../lib/assistant-artifacts.mjs';

const plain = value => JSON.parse(JSON.stringify(value));
const root = path.resolve(import.meta.dirname, '..');
const shot = { narration: '旧旁白', caption: '旧字幕', visual: '旧画面', duration: 6 };
const image = (width = 4, height = 3) => {
  const chunk = (type, bytes) => { const result = Buffer.alloc(bytes.length + 12); result.writeUInt32BE(bytes.length); result.write(type, 4); bytes.copy(result, 8); result.writeUInt32BE(crc32(result.subarray(4, bytes.length + 8)), bytes.length + 8); return result; };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc((width * 4 + 1) * height, 180); for (let row = 0; row < height; row++) pixels[row * (width * 4 + 1)] = 0;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
};
async function fixture(t, { project = {}, download, wrapStore, artifactSupport = false, services = {} } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'gx-assistant-project-')), store = await createProjectStore(dataDir);
  const initial = await store.save('current-project', { kind: 'video', title: '当前工程', video: { script: shot.narration, openfilmDraftCaptions: [{ start: 0, end: 6, text: shot.caption }], timeline: [{ id: 'human-clip', assetId: 'human-source', at: 1, start: 2, end: 8, speed: 1.5 }] }, ...project });
  await store.save('source-doc', { kind: 'writing', title: '已有来源', source: { text: '真实原始材料' }, outputs: { video: { shots: [shot] } } });
  const film = path.join(dataDir, 'openfilm', 'projects', initial.id, 'film.html'); await mkdir(path.dirname(film), { recursive: true }); await writeFile(film, 'manual native timeline exact bytes');
  const sourceLinks = await createProjectLinkService({ dataDir, store: wrapStore ? wrapStore(store, dataDir) : store }), projectCovers = await createProjectCovers(dataDir), downloadsSeen = [];
  const artifacts = artifactSupport ? await createAssistantArtifactService({ dataDir, root, store }) : undefined;
  const downloads = { async read(id, options) { downloadsSeen.push({ id, options }); return download ? download(id, options, store) : { download: { id, name: '封面.png', projectId: initial.id }, buffer: image() }; } };
  let nativeCalls = 0;
  const adapter = createAssistantAppTools({ store, sourceLinks, projectCovers, downloads, artifacts, root, openFilm: { async context() { nativeCalls++; throw new Error('Project draft/cover operations must not open the native editor'); } }, ...services });
  t.after(async () => { await adapter.close(); await artifacts?.close(); await sourceLinks.close(); await store.settle(); assert.equal(path.dirname(dataDir), os.tmpdir()); await rm(dataDir, { recursive: true, force: true }); });
  const ctx = overrides => ({ projectId: initial.id, runId: randomUUID(), instruction: '按我的对话要求修改当前工程', mode: 'auto', signal: new AbortController().signal, origin: 'http://127.0.0.1:12345', update() {}, ...overrides });
  const call = (name, args = {}, context = ctx()) => { const tool = adapter.tools.find(item => item.name === name); assert.ok(tool, 'Missing ' + name); return tool.execute(args, context); };
  const sourceUpdate = async changes => { const source = await store.read('source-doc'); Object.assign(source.outputs.video.shots[0], changes); await store.save(source.id, source); };
  return { dataDir, store, initial, film, sourceLinks, projectCovers, downloadsSeen, artifacts, adapter, ctx, call, sourceUpdate, nativeCalls: () => nativeCalls };
}
const syncArgs = (status, selectedIds, extra = {}) => ({ action: 'sync', expectedLinkHash: status.linkHash, sourceHash: status.sourceHash, targetHash: status.targetHash, revision: status.revision, selectedIds, ...extra });
async function bind(fx, ctx) { const read = await fx.call('source_link_inspect', { sourceProjectId: 'source-doc' }, ctx); return fx.call('source_link_manage', { action: 'bind', expectedLinkHash: read.data.linkHash, sourceProjectId: 'source-doc', sourceHash: read.data.preview.sourceHash }, ctx); }

test('real source tools bind, compare and sync only selected drafts, then undo several steps without touching native film', async t => {
  const fx = await fixture(t), context = fx.ctx(), initialHash = assistantContentHash(fx.initial), film = await readFile(fx.film);
  const linked = await bind(fx, context); assert.equal(linked.data.timelineChanged, false); assert.equal(linked.data.sourceProjectId, 'source-doc');
  assert.equal((await fx.store.read(fx.initial.id)).video.script, shot.narration);
  await fx.sourceUpdate({ narration: '新旁白', caption: '新字幕', visual: '新画面', duration: 9 });
  const state = (await fx.call('source_link_inspect', {}, context)).data; assert.equal(state.status, 'changed'); assert.equal(state.candidates.length, 1);
  const args = syncArgs(state, ['0:narration', '0:caption']), synced = await fx.call('source_link_manage', args, context), repeated = await fx.call('source_link_manage', args, context);
  assert.deepEqual(repeated, synced); assert.deepEqual(synced.data.applied, ['0:narration', '0:caption']); assert.equal(synced.data.timelineChanged, false);
  const saved = await fx.store.read(fx.initial.id); assert.equal(saved.video.script, '新旁白'); assert.equal(saved.video.openfilmDraftCaptions[0].text, '新字幕'); assert.equal(saved.video.sourceStoryboard[0].visual, '旧画面'); assert.equal(saved.video.sourceStoryboard[0].duration, 6);
  assert.deepEqual(saved.video.timeline, fx.initial.video.timeline); assert.deepEqual(await readFile(fx.film), film); assert.equal(fx.nativeCalls(), 0);
  await fx.adapter.undo({ projectId: fx.initial.id, undoId: synced.effects[0].undo.id });
  await fx.adapter.undo({ projectId: fx.initial.id, undoId: linked.effects[0].undo.id });
  assert.equal(assistantContentHash(await fx.store.read(fx.initial.id)), initialHash); assert.equal((await fx.sourceLinks.status(fx.initial.id)).status, 'unlinked'); assert.deepEqual(await readFile(fx.film), film);
});

test('source unlink is reversible and obsolete source/target/link comparisons cannot overwrite new edits', async t => {
  const fx = await fixture(t); await bind(fx, fx.ctx());
  const before = await fx.sourceLinks.assistantSnapshot(fx.initial.id), linked = await fx.call('source_link_inspect');
  const unlinked = await fx.call('source_link_manage', { action: 'unlink', expectedLinkHash: linked.data.linkHash }); assert.equal(unlinked.data.status, 'unlinked');
  await fx.adapter.undo({ projectId: fx.initial.id, undoId: unlinked.effects[0].undo.id });
  assert.equal((await fx.sourceLinks.assistantSnapshot(fx.initial.id)).linkHash, before.linkHash);
  const state = (await fx.call('source_link_inspect')).data; await fx.sourceUpdate({ narration: '来源已变' });
  await assert.rejects(fx.call('source_link_manage', syncArgs(state, ['0:narration'])), { code: 'SOURCE_VERSION_CHANGED' });
  const fresh = (await fx.call('source_link_inspect')).data, changed = await fx.store.read(fx.initial.id); changed.video.script = '保留人工草稿'; await fx.store.save(changed.id, changed);
  await assert.rejects(fx.call('source_link_manage', syncArgs(fresh, ['0:narration'])), { code: 'TARGET_DRAFT_CHANGED' });
  assert.equal((await fx.store.read(changed.id)).video.script, '保留人工草稿');
  const preview = await fx.call('source_link_inspect', { sourceProjectId: 'source-doc' }); await fx.sourceUpdate({ visual: '又更新画面' });
  await assert.rejects(fx.call('source_link_manage', { action: 'bind', sourceProjectId: 'source-doc', sourceHash: preview.data.preview.sourceHash, expectedLinkHash: preview.data.linkHash }), { code: 'SOURCE_VERSION_CHANGED' });
});

test('manual source sync conflicts preserve the draft and explicit merged script preserves exact whitespace', async t => {
  const fx = await fixture(t); await bind(fx, fx.ctx());
  const project = await fx.store.read(fx.initial.id); project.video.script = '人工改过的旁白'; await fx.store.save(project.id, project); await fx.sourceUpdate({ narration: '新的来源旁白' });
  const status = (await fx.call('source_link_inspect')).data, conflict = await fx.call('source_link_manage', syncArgs(status, ['0:narration']));
  assert.equal(conflict.data.conflicts.length, 1); assert.equal((await fx.store.read(project.id)).video.script, '人工改过的旁白'); assert.match(conflict.summary, /冲突/);
  const latest = (await fx.call('source_link_inspect')).data, mergedScript = '  人工保留前言\n\n新的来源旁白  ';
  const merged = await fx.call('source_link_manage', syncArgs(latest, ['0:narration'], { manualScript: mergedScript }));
  assert.deepEqual(merged.data.conflicts, []); assert.equal((await fx.store.read(project.id)).video.script, mergedScript);
  assert.equal(await readFile(fx.film, 'utf8'), 'manual native timeline exact bytes');
});

test('source writes serialize CAS, remain project-owned and preserve drafts when link record publication fails', async t => {
  const fx = await fixture(t), before = await fx.sourceLinks.assistantSnapshot(fx.initial.id), preview = await fx.sourceLinks.preview('source-doc');
  const options = { expectedHash: before.expectedHash, expectedCreatedAt: before.createdAt, expectedLinkHash: before.linkHash };
  const results = await Promise.allSettled([fx.sourceLinks.bind(fx.initial.id, { sourceProjectId: 'source-doc', sourceHash: preview.sourceHash }, options), fx.sourceLinks.bind(fx.initial.id, { sourceProjectId: 'source-doc', sourceHash: preview.sourceHash }, options)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1); assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
  await assert.rejects(fx.call('source_link_inspect', { sourceProjectId: fx.initial.id }), { code: 'SOURCE_PROJECT_NOT_FOUND' });
  const broken = await fixture(t, { wrapStore: (store, dataDir) => ({ ...store, async updateVideoDraft(...args) { const result = await store.updateVideoDraft(...args); await mkdir(path.join(dataDir, 'project-links', 'current-project.json')); return result; } }) });
  const initial = assistantContentHash(broken.initial), read = (await broken.call('source_link_inspect', { sourceProjectId: 'source-doc' })).data;
  await assert.rejects(broken.call('source_link_manage', { action: 'bind', sourceProjectId: 'source-doc', sourceHash: read.preview.sourceHash, expectedLinkHash: read.linkHash }), { code: 'SOURCE_LINK_WRITE_FAILED' });
  assert.equal(assistantContentHash(await broken.store.read(broken.initial.id)), initial); assert.equal(await readFile(broken.film, 'utf8'), 'manual native timeline exact bytes');
});

test('project presets use metadata CAS, retain unrelated content and undo multiple cover edits in reverse', async t => {
  const fx = await fixture(t), context = fx.ctx(), initial = assistantContentHash(fx.initial), first = await fx.call('project_cover_set', { preset: 'film', expectedMetadataRevision: 0 }, context);
  const second = await fx.call('project_cover_set', { preset: 'paper', expectedMetadataRevision: 1 }, context);
  const current = await fx.store.read(fx.initial.id); assert.equal(current.cover, 'paper'); assert.deepEqual(current.video, fx.initial.video); assert.equal(current.metadataRevision, 2);
  await fx.adapter.undo({ projectId: current.id, undoId: second.effects[0].undo.id }); await fx.adapter.undo({ projectId: current.id, undoId: first.effects[0].undo.id });
  assert.equal(assistantContentHash(await fx.store.read(current.id)), initial);
  const latest = await fx.store.read(current.id), results = await Promise.allSettled([fx.store.patchMetadata(current.id, { cover: 'film' }, { expectedMetadataRevision: latest.metadataRevision }), fx.store.patchMetadata(current.id, { cover: 'paper' }, { expectedMetadataRevision: latest.metadataRevision })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1); assert.equal(results.find(result => result.status === 'rejected').reason.code, 'PROJECT_METADATA_CONFLICT');
  await assert.rejects(fx.call('project_cover_set', { preset: 'blueprint', expectedMetadataRevision: 0 }), { code: 'PROJECT_METADATA_CONFLICT' });
});

test('custom project cover actually decodes a controlled download, scales like the UI and binds validated PNG bytes', async t => {
  const fx = await fixture(t, { download: async id => ({ download: { id, name: '真实封面.png', projectId: 'current-project' }, buffer: image(2560, 1600) }) }), downloadId = randomUUID();
  const result = await fx.call('project_cover_set', { downloadId, expectedMetadataRevision: 0 });
  assert.equal(result.data.cover, 'custom'); assert.deepEqual(result.data.image, { width: 1280, height: 800, originalWidth: 2560, originalHeight: 1600 });
  assert.deepEqual(fx.downloadsSeen, [{ id: downloadId, options: { projectId: fx.initial.id } }]);
  const bytes = await fx.projectCovers.read(result.data.coverAssetId), validated = validateCoverPng(bytes);
  assert.equal(validated.width, 1280); assert.equal(validated.height, 800); assert.equal(result.data.coverUrl, '/api/project-covers/' + result.data.coverAssetId);
  const saved = await fx.store.read(fx.initial.id); assert.equal(saved.coverAssetId, result.data.coverAssetId); assert.equal(saved.metadataRevision, 1); assert.deepEqual(saved.video, fx.initial.video);
  if (process.env.GUANGXUAN_PROJECT_CAPABILITY_EVIDENCE) {
    const evidence = path.resolve(process.env.GUANGXUAN_PROJECT_CAPABILITY_EVIDENCE); await mkdir(evidence, { recursive: true });
    await writeFile(path.join(evidence, 'actual-scaled-cover.png'), bytes);
    await writeFile(path.join(evidence, 'actual-cover-result.json'), JSON.stringify({ width: validated.width, height: validated.height, originalWidth: result.data.image.originalWidth, originalHeight: result.data.image.originalHeight, metadataRevision: saved.metadataRevision, nativeFilmUntouched: await readFile(fx.film, 'utf8') === 'manual native timeline exact bytes', nativeServiceCalls: fx.nativeCalls() }, null, 2));
  }
  await fx.adapter.undo({ projectId: saved.id, undoId: result.effects[0].undo.id }); assert.equal((await fx.store.read(saved.id)).cover, 'classic'); assert.deepEqual(await fx.projectCovers.read(result.data.coverAssetId), bytes, 'Undo only changes project metadata; immutable image remains available');
});

test('cover/source tools reject ask mode, cancellation, foreign downloads and corrupt images without metadata or film edits', async t => {
  const fx = await fixture(t), initial = assistantContentHash(fx.initial);
  await assert.rejects(fx.call('project_cover_set', { preset: 'paper', expectedMetadataRevision: 0 }, fx.ctx({ mode: 'ask' })), { code: 'ASSISTANT_READ_ONLY' });
  await assert.rejects(fx.call('project_cover_set', { preset: 'paper', expectedMetadataRevision: 0 }, fx.ctx({ signal: AbortSignal.abort() })), { code: 'REQUEST_CANCELLED' });
  await assert.rejects(fx.call('source_link_manage', { action: 'unlink', expectedLinkHash: (await fx.sourceLinks.status(fx.initial.id)).linkHash }, fx.ctx({ mode: 'ask' })), { code: 'ASSISTANT_READ_ONLY' });
  assert.equal(assistantContentHash(await fx.store.read(fx.initial.id)), initial);
  const foreign = await fixture(t, { download: async id => ({ download: { id, projectId: 'foreign-project' }, buffer: image() }) });
  await assert.rejects(foreign.call('project_cover_set', { downloadId: randomUUID(), expectedMetadataRevision: 0 }), { code: 'ASSISTANT_COVER_SCOPE' });
  const corrupt = await fixture(t, { download: async id => ({ download: { id, projectId: 'current-project' }, buffer: Buffer.from('<svg onload="bad()"></svg>') }) });
  await assert.rejects(corrupt.call('project_cover_set', { downloadId: randomUUID(), expectedMetadataRevision: 0 }), { code: 'INVALID_COVER_IMAGE' });
  assert.equal((await corrupt.store.read(corrupt.initial.id)).metadataRevision, 0); assert.equal(await readFile(corrupt.film, 'utf8'), 'manual native timeline exact bytes');
});

test('source restore removes fields and empty parents exactly when the original video container was absent', async t => {
  const fx = await fixture(t, { project: { video: null } }), initial = assistantContentHash(fx.initial), result = await bind(fx, fx.ctx());
  await fx.adapter.undo({ projectId: fx.initial.id, undoId: result.effects[0].undo.id });
  const saved = await fx.store.read(fx.initial.id); assert.equal(saved.video, null); assert.equal(Object.hasOwn(saved, 'sourceProjectId'), false); assert.equal(assistantContentHash(saved), initial);
});

test('real writing PNG export becomes its current project cover directly from the managed artifact without any web requests', async t => {
  const poster = { eyebrow: '直接制作闭环', title: '刚生成的海报', subtitle: '不需要用户手工下载上传', highlights: ['真实生成PNG', '直接设置当前工程封面'], details: [{ label: '用途', value: '项目封面' }], footer: '保留完整文字' };
  const fx = await fixture(t, { artifactSupport: true, project: { kind: 'writing', video: null, outputs: { poster }, writing: { brief: { channel: 'poster' }, draft: { channel: 'poster', output: poster } } } });
  const network = []; t.mock.method(globalThis, 'fetch', async (...args) => { network.push(String(args[0])); throw new Error('The local artifact-to-cover chain must not request the web'); });
  const context = fx.ctx({ instruction: '把刚生成的海报直接设成当前工程封面' });
  const exported = await fx.call('writing_export', { channel: 'poster', format: 'png' }, context), original = await fx.artifacts.read(exported.data.file.id, { projectId: fx.initial.id });
  assert.equal(original.file.contentType, 'image/png'); assert.equal(original.buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const cover = await fx.call('project_cover_set', { artifactId: exported.data.file.id, expectedMetadataRevision: 0 }, context);
  const saved = await fx.store.read(fx.initial.id), png = validateCoverPng(await fx.projectCovers.read(cover.data.coverAssetId));
  assert.equal(saved.cover, 'custom'); assert.equal(saved.coverAssetId, cover.data.coverAssetId); assert.equal(saved.metadataRevision, 1);
  assert.equal(cover.data.image.originalWidth, original.buffer.readUInt32BE(16)); assert.equal(cover.data.image.originalHeight, original.buffer.readUInt32BE(20)); assert.equal(Math.max(png.width, png.height), 1280);
  assert.deepEqual(network, []); assert.deepEqual(fx.downloadsSeen, []); assert.equal(fx.nativeCalls(), 0);
  if (process.env.GUANGXUAN_PROJECT_CAPABILITY_EVIDENCE) {
    const evidence = path.resolve(process.env.GUANGXUAN_PROJECT_CAPABILITY_EVIDENCE); await mkdir(evidence, { recursive: true });
    await writeFile(path.join(evidence, 'generated-poster-artifact.png'), original.buffer); await writeFile(path.join(evidence, 'generated-poster-as-cover.png'), await fx.projectCovers.read(cover.data.coverAssetId));
    await writeFile(path.join(evidence, 'poster-artifact-cover-verification.json'), JSON.stringify({ realWritingExport: true, artifactOwnedByCurrentProject: original.file.projectId === fx.initial.id, originalWidth: cover.data.image.originalWidth, originalHeight: cover.data.image.originalHeight, coverWidth: png.width, coverHeight: png.height, nodeWebFetches: network.length, downloadReads: fx.downloadsSeen.length, nativeCalls: fx.nativeCalls(), metadataRevision: saved.metadataRevision }, null, 2));
  }
  await fx.adapter.undo({ projectId: saved.id, undoId: cover.effects[0].undo.id }); assert.equal((await fx.store.read(saved.id)).cover, 'classic');
  assert.deepEqual((await fx.artifacts.read(exported.data.file.id)).buffer, original.buffer, 'Cover undo preserves the original generated poster');
});

test('artifact cover input rejects actual foreign artifacts and non-image outputs before changing metadata', async t => {
  const fx = await fixture(t, { artifactSupport: true }), before = assistantContentHash(fx.initial);
  await fx.store.save('foreign-cover-owner', { kind: 'writing', title: '另一个工程' });
  const foreign = await fx.artifacts.create({ projectId: 'foreign-cover-owner', name: '外项目图片.png', contentType: 'image/png', buffer: image() });
  await assert.rejects(fx.call('project_cover_set', { artifactId: foreign.id, expectedMetadataRevision: 0 }), { code: 'ASSISTANT_ARTIFACT_NOT_FOUND' });
  const document = await fx.artifacts.create({ projectId: fx.initial.id, name: '当前稿件.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('not an image') });
  await assert.rejects(fx.call('project_cover_set', { artifactId: document.id, expectedMetadataRevision: 0 }), error => { assert.equal(error.code, 'ASSISTANT_COVER_IMAGE_REQUIRED'); assert.match(error.message, /poster/); return true; });
  await assert.rejects(fx.call('project_cover_set', { artifactId: foreign.id, downloadId: randomUUID(), expectedMetadataRevision: 0 }), { code: 'ASSISTANT_COVER_INPUT' });
  assert.equal(assistantContentHash(await fx.store.read(fx.initial.id)), before); assert.deepEqual(fx.downloadsSeen, []);
});

test('asset cover input checks real current native membership before resolving and reading its trusted image path', async t => {
  let trustedFile, resolutions = 0, nativeReads = 0;
  const fx = await fixture(t, { project: { video: { timeline: [], editScope: { assetIds: [], placement: { mode: 'append' } } } }, services: {
    openFilm: { async context() { nativeReads++; return { revision: 'cover-native-revision', duration: 4, assets: [{ id: 'current-image', type: 'image', name: '当前工程图片.png', duration: 4 }, { id: 'current-video', type: 'video', name: '当前工程视频.mp4', duration: 4 }], timeline: [] }; } },
    videoService: { async resolveAsset(id) { resolutions++; assert.equal(id, 'current-image'); return { id, type: 'image', path: trustedFile, name: '当前工程图片.png' }; } },
  } });
  trustedFile = path.join(fx.dataDir, 'managed-current-image.png'); await writeFile(trustedFile, image(1600, 1000));
  const ctx = () => fx.ctx({ scopeAuthority: 'dialog', instruction: '使用整个工程素材库中的当前图片直接设封面' });
  await assert.rejects(fx.call('project_cover_set', { assetId: 'foreign-image', expectedMetadataRevision: 0 }, ctx()), { code: 'ASSISTANT_COVER_SCOPE' }); assert.equal(resolutions, 0);
  await assert.rejects(fx.call('project_cover_set', { assetId: 'current-video', expectedMetadataRevision: 0 }, ctx()), { code: 'ASSISTANT_COVER_IMAGE_REQUIRED' }); assert.equal(resolutions, 0);
  const result = await fx.call('project_cover_set', { assetId: 'current-image', expectedMetadataRevision: 0, path: 'C:/ignored-model-path/secret.png' }, ctx());
  assert.equal(resolutions, 1); assert.equal(nativeReads, 3); assert.equal(result.data.image.width, 1280); assert.equal(result.data.image.height, 800);
  assert.equal(validateCoverPng(await fx.projectCovers.read(result.data.coverAssetId)).width, 1280); assert.equal((await fx.store.read(fx.initial.id)).metadataRevision, 1);
});

test('native poster export becomes a cover through its fixed current-project loopback API and rejects redirect, ZIP, video and oversized responses', async t => {
  const fx = await fixture(t), bytes = image(1600, 900), requests = [], rejectedTargets = [];
  const trap = http.createServer((req, res) => { rejectedTargets.push(req.url); res.writeHead(200, { 'content-type': 'image/png' }); res.end(bytes); }); await new Promise(resolve => trap.listen(0, '127.0.0.1', resolve));
  const trapOrigin = `http://127.0.0.1:${trap.address().port}`; let origin;
  const server = http.createServer((req, res) => {
    res.on('error', () => {}); requests.push(req.url); assert.equal(req.method, 'GET'); assert.equal(req.headers.origin, origin);
    const match = /^\/api\/openfilm\/exports\/current-project\/([A-Za-z0-9_-]+)\/file$/.exec(req.url); if (!match) { res.writeHead(404); res.end(); return; }
    if (match[1] === 'poster-done') { res.writeHead(200, { 'content-type': 'image/png', 'content-length': bytes.length }); res.end(bytes); }
    else if (match[1] === 'joined-zip') { res.writeHead(200, { 'content-type': 'application/zip' }); res.end('PK-batch'); }
    else if (match[1] === 'video-done') { res.writeHead(200, { 'content-type': 'video/mp4' }); res.end('video'); }
    else if (match[1] === 'redirect-job') { res.writeHead(302, { location: trapOrigin + '/outside-the-current-service' }); res.end(); }
    else if (match[1] === 'huge-declared') { res.writeHead(200, { 'content-type': 'image/png', 'content-length': 20 * 1024 * 1024 + 1 }); res.flushHeaders(); }
    else if (match[1] === 'huge-chunked') { res.writeHead(200, { 'content-type': 'image/png' }); res.write(bytes); res.end(Buffer.alloc(20 * 1024 * 1024)); }
    else { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'PRIVATE_EXPORT_ERROR_PATH C:/private/never-surface' })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`; assert.notEqual(server.address().port, 4417);
  t.after(async () => { for (const service of [server, trap]) { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); } });
  const ctx = () => fx.ctx({ origin, scopeAuthority: 'dialog', instruction: '把当前工程已经导出的poster图片直接设封面' });
  for (const nativeExportId of ['joined-zip', 'video-done']) await assert.rejects(fx.call('project_cover_set', { nativeExportId, expectedMetadataRevision: 0 }, ctx()), error => { assert.equal(error.code, 'ASSISTANT_COVER_IMAGE_REQUIRED'); assert.match(error.message, /poster/); return true; });
  for (const nativeExportId of ['huge-declared', 'huge-chunked']) await assert.rejects(fx.call('project_cover_set', { nativeExportId, expectedMetadataRevision: 0 }, ctx()), { code: 'COVER_TOO_LARGE' });
  for (const nativeExportId of ['redirect-job', 'foreign-project-job']) await assert.rejects(fx.call('project_cover_set', { nativeExportId, expectedMetadataRevision: 0 }, ctx()), error => { assert.equal(error.code, 'ASSISTANT_COVER_EXPORT_UNAVAILABLE'); assert.doesNotMatch(error.message, /PRIVATE_EXPORT_ERROR_PATH|C:\/private/); return true; });
  const count = requests.length;
  await assert.rejects(fx.call('project_cover_set', { nativeExportId: '../foreign-project/poster-done', expectedMetadataRevision: 0 }, ctx()), { code: 'ASSISTANT_COVER_INPUT' });
  await assert.rejects(fx.call('project_cover_set', { nativeExportId: 'poster-done', expectedMetadataRevision: 0 }, fx.ctx({ origin: 'https://outside.example' })), { code: 'ASSISTANT_COVER_ORIGIN' });
  assert.equal(requests.length, count); assert.equal((await fx.store.read(fx.initial.id)).metadataRevision, 0);
  const result = await fx.call('project_cover_set', { nativeExportId: 'poster-done', expectedMetadataRevision: 0, projectId: 'foreign-project', url: trapOrigin + '/ignored-model-url' }, ctx());
  assert.equal(result.data.cover, 'custom'); assert.equal(result.data.image.width, 1280); assert.equal(result.data.image.height, 720); assert.equal((await fx.store.read(fx.initial.id)).metadataRevision, 1);
  assert.deepEqual(rejectedTargets, []); assert.equal(requests.at(-1), '/api/openfilm/exports/current-project/poster-done/file'); assert.equal(await readFile(fx.film, 'utf8'), 'manual native timeline exact bytes');
  await fx.adapter.undo({ projectId: fx.initial.id, undoId: result.effects[0].undo.id }); assert.equal((await fx.store.read(fx.initial.id)).cover, 'classic');
});
