import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createProjectStore } from '../lib/store.mjs';
import { createVideoService } from '../lib/video.mjs';
import { createReferenceService } from '../lib/references.mjs';
import { createProjectCovers } from '../lib/project-covers.mjs';
import { createProjectBundleService, PROJECT_BUNDLE_MAGIC } from '../lib/project-bundles.mjs';
import { createRemotionProjectsService } from '../lib/remotion-projects.mjs';
import { filmHtml, readFilmFile } from '../integrations/openfilm/packages/openfilm/src/film-doc.mjs';
import { assistantDetails } from '../public/assistant-client.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = promisify(execFile);
const digest = value => createHash('sha256').update(value).digest('hex');
const knownSecret = 'sk-project-bundle-test-secret-01234567890123456789';
const binary = name => process.env[`GUANGXUAN_${name.toUpperCase()}`] || (process.env.GUANGXUAN_BIN_DIR ? path.join(process.env.GUANGXUAN_BIN_DIR, name + (process.platform === 'win32' ? '.exe' : '')) : name);
async function fixture(t, { media = false, ...options } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'guangxuan-bundles-test-')), dataDir = path.join(directory, '数据');
  const store = await createProjectStore(dataDir, { sensitiveStrings: () => [knownSecret] });
  const videoService = media ? await createVideoService({ dataDir, root, ffmpegPath: binary('ffmpeg'), ffprobePath: binary('ffprobe') }) : undefined;
  const references = await createReferenceService({ dataDir, store, videoService });
  const bundles = await createProjectBundleService({ dataDir, root, store, videoService, references, sensitiveStrings: () => [knownSecret], ...options });
  const services = [bundles];
  t.after(async () => {
    for (const service of services.reverse()) await service.close();
    await references.close(); await videoService?.close();
    const target = path.resolve(directory);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('guangxuan-bundles-test-')) throw new Error('Unsafe project bundle test cleanup');
    await rm(target, { recursive: true, force: true });
  });
  return { directory, dataDir, store, videoService, references, bundles, services, async other(options = {}) { const next = await createProjectBundleService({ dataDir, root, store, videoService, references, sensitiveStrings: () => [knownSecret], ...options }); services.push(next); return next; } };
}
async function packaged(f, id) { const result = await f.bundles.prepareExport(id); return { ...result, bytes: await readFile(path.join(f.dataDir, 'project-bundles', result.token, 'project.gxproject')) }; }
function unpack(bytes) {
  const raw = gunzipSync(bytes), length = raw.readUInt32BE(PROJECT_BUNDLE_MAGIC.length), start = PROJECT_BUNDLE_MAGIC.length + 4;
  const manifest = JSON.parse(raw.subarray(start, start + length).toString()); let offset = start + length;
  const entries = manifest.files.map(file => { const bytes = raw.subarray(offset, offset + file.size); offset += file.size; return { path: file.path, bytes }; });
  return { manifest, entries };
}
function repack(manifest, entries) { const value = Buffer.from(JSON.stringify(manifest)), length = Buffer.alloc(4); length.writeUInt32BE(value.length); return gzipSync(Buffer.concat([PROJECT_BUNDLE_MAGIC, length, value, ...manifest.files.map(file => entries.find(entry => entry.path === file.path)?.bytes || Buffer.alloc(0))])); }
const code = expected => error => error.code === expected;

test('one project package restores writing and a direct source as new IDs without overwriting existing names', async t => {
  const f = await fixture(t);
  const source = await f.store.save('source-document', { kind: 'writing', title: '同名项目', outputs: { article: { body: '中文正文' } }, videoProjectId: 'original-video' });
  const original = await f.store.save('original-video', { kind: 'video', title: '同名项目', sourceProjectId: source.id, video: { timeline: [], captions: [], script: '中文旁白' } });
  await mkdir(path.join(f.dataDir, 'project-links'), { recursive: true });
  const baseline = { title: source.title, body: '中文正文', shots: [], hash: digest(Buffer.from('original-baseline')), updatedAt: source.updatedAt };
  await writeFile(path.join(f.dataDir, 'project-links', original.id + '.json'), JSON.stringify({ version: 1, targetCreatedAt: original.createdAt, sourceProjectId: source.id, videoProjectId: original.id, baseline, sourceSnapshot: { text: '来源快照' }, revision: 1 }));
  const before = JSON.stringify(await f.store.list());
  const exported = await packaged(f, original.id), preview = await f.bundles.receiveImport(Readable.from([exported.bytes]));
  assert.equal(preview.report.dependencies.length, 1);
  const restored = await f.bundles.restoreImport(preview.token, { title: '同名项目' });
  assert.notEqual(restored.projectId, original.id); assert.equal(restored.report.existingProjectsOverwritten, false);
  assert.equal(restored.project.title, '同名项目');
  assert.equal(restored.project.sourceProjectId, restored.mapping.projects[source.id]);
  assert.equal((await f.store.read(restored.project.sourceProjectId)).videoProjectId, restored.projectId);
  const link = JSON.parse(await readFile(path.join(f.dataDir, 'project-links', restored.projectId + '.json')));
  assert.equal(link.videoProjectId, restored.projectId); assert.equal(link.sourceSnapshot.text, '来源快照');
  assert.equal(link.targetCreatedAt, restored.project.createdAt); assert.deepEqual(link.baseline, baseline);
  assert.equal(JSON.stringify({ projects: (await f.store.list()).projects.filter(item => [source.id, original.id].includes(item.id)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) }), before);
  assert.equal((await f.bundles.restoreImport(preview.token)).projectId, restored.projectId, 'Repeat confirmation must not create another project');
});

test('restored assistant results keep their content while dropping old run and effect undo handles', async t => {
  const f = await fixture(t);
  const message = { id: 'completed-message', role: 'assistant', content: '已完成原项目修改', status: 'complete', runId: randomUUID(), runStatus: 'completed', totalToolCalls: 21, batch: 3, result: '旁白已经更新', sources: [{ title: '材料来源', url: 'https://example.test/source' }], effects: [{ type: 'project', projectId: 'session-copy', label: '已保存旁白', changed: true, undo: { kind: 'project', id: randomUUID() } }, { type: 'native', projectId: 'session-copy', label: '动画已加入', jobId: randomUUID(), changed: true }] };
  await f.store.save('session-copy', { kind: 'video', title: '保留结果', video: { timeline: [], captions: [], assistantMessages: [message] } });
  const before = await readFile(path.join(f.dataDir, 'projects/session-copy.json'));
  const exported = await packaged(f, 'session-copy'), originalMessage = JSON.parse(unpack(exported.bytes).entries.find(entry => entry.path === 'project.json').bytes).video.assistantMessages[0];
  assert.equal(originalMessage.runId, message.runId, 'The saved source conversation remains available in the package');
  const preview = await f.bundles.receiveImport(Readable.from([exported.bytes])), result = await f.bundles.restoreImport(preview.token);
  const restored = result.project.video.assistantMessages[0];
  assert.equal(restored.content, message.content); assert.equal(restored.result, message.result); assert.equal(restored.status, 'complete');
  assert.deepEqual(JSON.parse(JSON.stringify(restored.sources)), message.sources); assert.equal(restored.totalToolCalls, 21); assert.equal(restored.batch, 3);
  for (const field of ['jobId', 'undo', 'runId', 'runStatus', 'retryWatch', 'scopeImportedAssetIds']) assert.equal(Object.hasOwn(restored, field), false, field);
  assert.deepEqual(JSON.parse(JSON.stringify(restored.effects)), [{ type: 'project', projectId: result.projectId, label: '已保存旁白', changed: true }, { type: 'native', projectId: result.projectId, label: '动画已加入', changed: true }]);
  assert.ok(result.report.warnings.some(item => item.code === 'BUNDLE_SESSION_RESTORED'));
  assert.deepEqual(await readFile(path.join(f.dataDir, 'projects/session-copy.json')), before, 'Restoring a copy must not rewrite the original conversation');
});

test('restored interrupted assistant conversations cannot watch old runs and keep useful partial results', async t => {
  const f = await fixture(t);
  const runId = randomUUID(), undoId = randomUUID();
  const pending = { id: 'working-message', role: 'assistant', content: '已导入资料，正在整理剩余部分。', status: 'working', instruction: '继续整理资料', runId, runStatus: 'running', retryWatch: true, jobId: randomUUID(), undo: { id: undoId }, scopeImportedAssetIds: ['old-imported-id'], result: '已保存第一部分', steps: [{ type: 'tool', label: '导入资料', status: 'completed' }, { type: 'tool', label: '整理资料', status: 'running' }], effects: [{ type: 'project', label: '已保存第一部分', undo: { kind: 'project', id: undoId } }] };
  await f.store.save('session-source', { kind: 'writing', title: '来源', video: { assistantMessages: [{ id: 'lost-message', role: 'assistant', content: '进度暂时无法读取', status: 'error', retryWatch: true, runId, runStatus: 'running' }] } });
  await f.store.save('session-video', { kind: 'video', sourceProjectId: 'session-source', title: '待完成任务', video: { timeline: [], captions: [], assistantJob: { jobId: pending.jobId }, assistantMessages: [pending] } });
  const exported = await packaged(f, 'session-video'), preview = await f.bundles.receiveImport(Readable.from([exported.bytes])), result = await f.bundles.restoreImport(preview.token);
  const restored = result.project.video.assistantMessages[0], restoredSource = await f.store.read(result.mapping.projects['session-source']);
  assert.equal(result.project.video.assistantJob, undefined); assert.equal(restored.status, 'error');
  assert.ok(restored.content.startsWith(pending.content), 'Useful partial work stays in the conversation'); assert.match(restored.content, /恢复前的后台请求未继续执行/);
  assert.equal(restored.instruction, pending.instruction); assert.equal(restored.result, pending.result);
  assert.equal(restored.steps[0].status, 'completed'); assert.equal(restored.steps[1].status, 'cancelled');
  for (const message of [restored, restoredSource.video.assistantMessages[0]]) for (const field of ['jobId', 'undo', 'runId', 'runStatus', 'retryWatch', 'scopeImportedAssetIds']) assert.equal(Object.hasOwn(message, field), false, field);
  assert.equal(restored.effects[0].undo, undefined); assert.equal(restored.effects[0].label, '已保存第一部分');
  assert.equal(restoredSource.video.assistantMessages[0].content, '进度暂时无法读取');
  assert.ok(result.report.warnings.some(item => item.code === 'BUNDLE_SESSION_RESTORED'));
  assert.equal((await f.store.read('session-video')).video.assistantMessages[0].runId, runId);
});

test('restoring on another computer keeps download history without unavailable local file actions', async t => {
  const source = await fixture(t), destination = await fixture(t);
  const file = { id: randomUUID(), name: '原始论文.pdf', size: 10, sha256: 'a'.repeat(64), url: 'https://example.test/paper.pdf', canImport: true };
  file.downloadUrl = `/api/assistant/downloads/${file.id}/file`;
  const quickFile = { ...file, id: randomUUID(), name: '补充资料.pdf', url: 'https://example.test/supplement.pdf' }; quickFile.downloadUrl = `/api/assistant/downloads/${quickFile.id}/file`;
  const content = '之前保存过两份资料；保留这段说明。', existingSource = { title: '材料上下文', url: 'https://example.test/context' };
  const original = await source.store.save('download-session', { kind: 'video', video: { timeline: [], captions: [], assistantMessages: [{ id: 'download-message', role: 'assistant', status: 'complete', content, result: '已经读过这些资料', sources: [existingSource], effects: [{ type: 'download', label: '已下载原始论文', changed: true, download: file }], downloads: [quickFile] }] } });
  const originalFile = path.join(source.dataDir, 'assistant/downloads', file.id, 'original.pdf'); await mkdir(path.dirname(originalFile), { recursive: true }); await writeFile(originalFile, 'pdfFixture');
  const originalBytes = await readFile(path.join(source.dataDir, 'projects', original.id + '.json'));
  const exported = await packaged(source, original.id), bundle = unpack(exported.bytes);
  assert.ok(bundle.manifest.files.every(item => !item.path.includes('assistant/downloads')), 'Global download originals do not migrate in a project package');
  const preview = await destination.bundles.receiveImport(Readable.from([exported.bytes])), result = await destination.bundles.restoreImport(preview.token);
  const message = result.project.video.assistantMessages[0], markup = assistantDetails(message);
  assert.equal(message.content, content); assert.equal(message.result, '已经读过这些资料');
  assert.ok(!markup.includes('data-assistant-download-save')); assert.ok(!markup.includes('/api/assistant/downloads/')); assert.ok(!markup.includes('可继续让我导入'));
  for (const name of [file.name, quickFile.name]) assert.ok(markup.includes(name), 'The readable history retains ' + name);
  for (const url of [existingSource.url, file.url, quickFile.url]) assert.ok(markup.includes(url), 'The original public source remains available');
  assert.equal(Object.hasOwn(message, 'downloads'), false);
  for (const effect of message.effects) { assert.notEqual(effect.type, 'download'); assert.equal(effect.download, undefined); assert.equal(effect.downloadUrl, undefined); assert.equal(effect.canImport, undefined); }
  assert.ok(result.report.warnings.some(item => item.code === 'BUNDLE_SESSION_RESTORED'));
  await assert.rejects(() => readFile(path.join(destination.dataDir, 'assistant/downloads', file.id, 'original.pdf')), { code: 'ENOENT' });
  assert.deepEqual(await readFile(path.join(source.dataDir, 'projects', original.id + '.json')), originalBytes);
});

test('cross-computer restore archives old artifact handles while preserving completed text, native media and current Remotion sources', async t => {
  const source = await fixture(t), destination = await fixture(t), projectId = 'artifact-session', exportedFile = randomUUID(), remotionJob = randomUUID(), backupFile = randomUUID();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'), pngFile = path.join(source.directory, 'source-image.png'); await writeFile(pngFile, png);
  let sourceJobs = 0, targetJobs = 0;
  const remotionProjects = await createRemotionProjectsService({ dataDir: source.dataDir, root, onJob: () => { sourceJobs++; }, resolveAsset: async () => ({ path: pngFile, name: '真实资源.png', type: 'image' }) }); source.services.push(remotionProjects);
  const restoredRemotion = await createRemotionProjectsService({ dataDir: destination.dataDir, root, onJob: () => { targetJobs++; } }); destination.services.push(restoredRemotion);
  const sourceBundles = await source.other({ remotionProjects }), targetBundles = await destination.other({ remotionProjects: restoredRemotion });
  let project = await source.store.save(projectId, { kind: 'video', title: '已完成制作的工程', video: { timeline: [], captions: [], script: '旁白和完成结果需要保留。' } });
  const currentSource = await remotionProjects.create(projectId, { ownerCreatedAt: project.createdAt, title: '真实自由源码', entryPoint: 'src/index.tsx', compositionId: 'CurrentSource', inputProps: { title: '保留当前输入' }, files: [{ path: 'src/index.tsx', content: "import React from 'react'; import {registerRoot} from 'remotion'; export const label='preserve actual authoring source'; registerRoot(()=>null);" }, { path: 'public/diagram.svg', content: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30"/></svg>' }], assets: [{ assetId: 'kept-public-image-0001' }] });
  const files = [
    { id: exportedFile, projectId, name: '已导出的文案.docx', downloadUrl: `/api/assistant/exports/${exportedFile}/file`, kind: 'writing' },
    { projectId, name: '已导出的原生成片.mp4', downloadUrl: `/api/openfilm/exports/${projectId}/finished-native-job/file`, kind: 'native' },
    { projectId, name: '已渲染的自由动画.mp4', downloadUrl: `/api/projects/${projectId}/remotion/jobs/${remotionJob}/files/video.mp4`, kind: 'remotion' },
    { id: backupFile, projectId, name: '原电脑完整工程.gxproject', downloadUrl: `/api/project-bundles/exports/${backupFile}/file`, kind: 'backup' },
  ];
  const shortcut = { id: randomUUID(), projectId, name: '离线互动作品.html', kind: 'novel' }; shortcut.downloadUrl = `/api/assistant/exports/${shortcut.id}/file`;
  const content = `原工程的剪辑和动画已经完成。\n[保存文案](${files[0].downloadUrl})\n[保存原生成片](http://127.0.0.1:4417${files[1].downloadUrl})\n已导出的结果说明继续保留。`;
  const mediaUrl = '/api/video/media/kept-native-media-001';
  const message = { id: 'completed-artifact-message', role: 'assistant', projectId, status: 'complete', content, result: `处理完成，可保存${files[2].downloadUrl}`, remotionId: currentSource.id, revision: currentSource.revision, steps: [{ type: 'tool', status: 'completed', label: '已完成导出', message: files[3].downloadUrl }], sources: [{ title: '公开创作依据', url: 'https://example.test/actual-reference' }, { title: '旧本机制作文件', url: 'http://localhost:4417' + files[0].downloadUrl }], effects: [...files.map(artifact => ({ type: 'artifact', projectId, label: '已完成：' + artifact.name, changed: false, artifact })), { type: 'native', projectId, changed: true, label: '实际已加入的片段保留', asset: { id: 'kept-native-media-001', url: mediaUrl } }], artifacts: [...files.map(artifact => ({ artifact })), shortcut] };
  project = await source.store.save(projectId, { ...project, video: { ...project.video, remotionProjectId: currentSource.id, remotionRevision: currentSource.revision, assistantMessages: [message] } });
  const native = path.join(source.dataDir, 'openfilm/projects', projectId); await mkdir(path.join(native, 'assets'), { recursive: true });
  const film = Buffer.from(filmHtml({ stage: { w: 320, h: 180 }, tracks: [{ clips: [{ id: 'finished-frame', src: 'assets/已完成画面.png', time: [0, 1] }] }] }));
  await writeFile(path.join(native, 'film.html'), film); await writeFile(path.join(native, 'assets/已完成画面.png'), png);
  // These private old exports really exist on the source side but are not part
  // of a project archive; restoring their cards must not pretend otherwise.
  const oldExport = path.join(source.dataDir, 'assistant/exports', exportedFile, 'payload'); await mkdir(path.dirname(oldExport), { recursive: true }); await writeFile(oldExport, 'old computer DOCX bytes');
  const before = await readFile(path.join(source.dataDir, 'projects', projectId + '.json')), sourceArchive = await remotionProjects.exportArchive(projectId, currentSource.id);
  const exported = await packaged({ ...source, bundles: sourceBundles }, projectId), packageData = unpack(exported.bytes);
  assert.ok(packageData.manifest.files.every(file => !/^assistant\/exports\/|\/jobs\/|project-bundles\/exports\//.test(file.path)));
  const preview = await targetBundles.receiveImport(Readable.from([exported.bytes])), result = await targetBundles.restoreImport(preview.token);
  const restored = result.project.video.assistantMessages[0], markup = assistantDetails(restored), history = restored.effects.filter(effect => effect.type === 'artifact-history');
  assert.equal(restored.status, 'complete'); assert.ok(restored.content.includes('原工程的剪辑和动画已经完成。')); assert.ok(restored.content.includes('已导出的结果说明继续保留。')); assert.match(restored.result, /处理完成/);
  assert.ok(!markup.includes('data-assistant-artifact-save')); assert.ok(!markup.includes('/api/assistant/exports/')); assert.ok(!markup.includes('/api/openfilm/exports/')); assert.ok(!markup.includes('/remotion/jobs/')); assert.ok(!markup.includes('/api/project-bundles/exports/')); assert.ok(!markup.includes('127.0.0.1:4417')); assert.ok(!markup.includes('localhost:4417'));
  for (const file of [...files, shortcut]) assert.ok(markup.includes(file.name), 'Readable production history preserves ' + file.name);
  assert.equal(Object.hasOwn(restored, 'artifacts'), false); assert.ok(history.length >= files.length + 1);
  for (const effect of restored.effects) { assert.notEqual(effect.type, 'artifact'); assert.equal(effect.artifact, undefined); assert.equal(effect.downloadUrl, undefined); }
  assert.ok(restored.sources.some(item => item.url === 'https://example.test/actual-reference')); assert.equal(restored.sources.some(item => /4417/.test(item.url)), false);
  const nativeEffect = restored.effects.find(effect => effect.type === 'native'); assert.equal(nativeEffect.asset.url, mediaUrl); assert.equal(nativeEffect.label, '实际已加入的片段保留');
  const copiedSource = await restoredRemotion.read(result.projectId, result.project.video.remotionProjectId), copiedArchive = await restoredRemotion.exportArchive(result.projectId, copiedSource.id);
  assert.deepEqual(copiedSource.files, currentSource.files); assert.deepEqual(copiedSource.inputProps, currentSource.inputProps); assert.equal(restored.remotionId, copiedSource.id); assert.deepEqual(await readFile(copiedArchive.assets[0].filename), png); assert.deepEqual(await readFile(sourceArchive.assets[0].filename), png);
  assert.deepEqual(await readFile(path.join(destination.dataDir, 'openfilm/projects', result.projectId, 'assets/已完成画面.png')), png); assert.deepEqual(readFilmFile(await readFile(path.join(destination.dataDir, 'openfilm/projects', result.projectId, 'film.html'), 'utf8')).doc.tracks, readFilmFile(film.toString('utf8')).doc.tracks);
  assert.ok(result.report.warnings.some(item => item.code === 'BUNDLE_SESSION_RESTORED')); assert.ok(result.report.warnings.some(item => item.code === 'BUNDLE_REMOTION_SOURCE_RESTORED'));
  assert.equal(sourceJobs, 0); assert.equal(targetJobs, 0); await assert.rejects(() => readFile(path.join(destination.dataDir, 'assistant/exports', exportedFile, 'payload')), { code: 'ENOENT' });
  assert.deepEqual(await readFile(path.join(source.dataDir, 'projects', projectId + '.json')), before); assert.deepEqual(await readFile(path.join(native, 'film.html')), film); assert.equal(await readFile(oldExport, 'utf8'), 'old computer DOCX bytes');
  if (process.env.GUANGXUAN_BUNDLE_HISTORY_EVIDENCE) {
    const evidence = path.resolve(process.env.GUANGXUAN_BUNDLE_HISTORY_EVIDENCE); await mkdir(evidence, { recursive: true });
    await writeFile(path.join(evidence, 'restored-artifact-message.json'), JSON.stringify(restored, null, 2));
    await writeFile(path.join(evidence, 'restored-artifact-details.html'), '<!doctype html><meta charset="utf-8"><title>恢复后的制作文件历史</title>' + markup);
    await writeFile(path.join(evidence, 'artifact-history-verification.json'), JSON.stringify({ separateDataDirectories: source.dataDir !== destination.dataDir, restoredHistoryCount: history.length, fileNamesPreserved: [...files, shortcut].map(file => file.name), activeArtifactButtons: (markup.match(/data-assistant-artifact-save/g) || []).length, currentRemotionFilesPreserved: true, currentRemotionAssetBytesPreserved: true, nativeFilmAndImagePreserved: true, sourceProjectBytesUnchanged: true, sourceJobs, targetJobs, sessionWarning: true }, null, 2));
  }
});

test('ID collisions retry instead of overwriting an existing project and missing source links are reported', async t => {
  const f = await fixture(t);
  const original = await f.store.save('existing-record', { kind: 'writing', title: '保留', sourceProjectId: 'missing-source', source: { text: '正文' } });
  const bytesBefore = await readFile(path.join(f.dataDir, 'projects/existing-record.json'));
  const exported = await packaged(f, original.id);
  const candidates = ['existing-record', 'restored-safe-id'];
  const restore = await f.other({ idFactory: () => candidates.shift() || randomUUID() });
  const preview = await restore.receiveImport(Readable.from([exported.bytes]));
  assert.ok(preview.report.warnings.some(item => item.code === 'BUNDLE_SOURCE_MISSING'));
  const result = await restore.restoreImport(preview.token);
  assert.equal(result.projectId, 'restored-safe-id'); assert.equal(result.project.sourceProjectId, undefined);
  assert.deepEqual(await readFile(path.join(f.dataDir, 'projects/existing-record.json')), bytesBefore);
});

test('legacy metadata without kind exports as the inferred project type', async t => {
  const f = await fixture(t);
  await f.store.save('legacy-bundle-fixture', { title: '旧项目', videoProject: { timeline: [], script: '旧旁白' } });
  const exported = await packaged(f, 'legacy-bundle-fixture');
  const preview = await f.bundles.receiveImport(Readable.from([exported.bytes]));
  const restored = await f.bundles.restoreImport(preview.token);
  assert.equal(restored.project.kind, 'video'); assert.equal(restored.project.videoProject.script, '旧旁白');
});

test('packages reject corrupt hashes, missing files, truncated payload, traversal, version and expansion bombs before restore', async t => {
  const f = await fixture(t); await f.store.save('validation-fixture', { kind: 'writing', title: '清单校验', source: { text: '有效正文' } });
  const exported = await packaged(f, 'validation-fixture');
  const check = async (change, expected) => { const { manifest, entries } = unpack(exported.bytes); change(manifest, entries); await assert.rejects(() => f.bundles.receiveImport(Readable.from([repack(manifest, entries)])), code(expected)); };
  await check((manifest, entries) => { entries[0].bytes = Buffer.from(entries[0].bytes); entries[0].bytes[8] ^= 1; }, 'BUNDLE_HASH_MISMATCH');
  await check(manifest => { manifest.files = []; }, 'BUNDLE_LIMIT_EXCEEDED');
  await check(manifest => { manifest.version = 100; }, 'BUNDLE_VERSION_UNSUPPORTED');
  for (const unsafe of ['../outside.json', 'native/C:escape', 'native/assets/CON.mp4', 'native/assets/file:stream', 'native/../../escape']) await check(manifest => { manifest.files[0].path = unsafe; }, 'BUNDLE_UNSAFE_PATH');
  await check(manifest => { manifest.files[0].size = 300 * 1024 ** 3; }, 'BUNDLE_LIMIT_EXCEEDED');
  const raw = gunzipSync(exported.bytes);
  await assert.rejects(() => f.bundles.receiveImport(Readable.from([gzipSync(raw.subarray(0, -4))])), code('BUNDLE_TRUNCATED'));
  const corrupt = Buffer.from(exported.bytes); corrupt[corrupt.length - 7] ^= 255;
  await assert.rejects(() => f.bundles.receiveImport(Readable.from([corrupt])), code('BUNDLE_CORRUPT'));
  assert.equal((await f.store.list()).projects.length, 1);
});

test('a project package excludes global settings and credentials and rejects credential-bearing imports', async t => {
  const f = await fixture(t);
  await f.store.save('private-fixture', { kind: 'writing', title: '隐私检查', apiKey: knownSecret, source: { text: `合法正文 ${knownSecret}` } });
  await writeFile(path.join(f.dataDir, 'connection-settings.json'), JSON.stringify({ apiKey: knownSecret, marker: 'GLOBAL-SETTINGS-MUST-NOT-BE-PACKAGED' }));
  await f.store.save('other-private-project', { kind: 'science', title: 'OTHER-PROJECT-MUST-NOT-BE-PACKAGED' });
  const exported = await packaged(f, 'private-fixture'), raw = gunzipSync(exported.bytes).toString();
  assert.ok(!raw.includes(knownSecret)); assert.ok(!raw.includes('GLOBAL-SETTINGS-MUST-NOT-BE-PACKAGED')); assert.ok(!raw.includes('OTHER-PROJECT-MUST-NOT-BE-PACKAGED'));
  const { manifest, entries } = unpack(exported.bytes);
  const project = JSON.parse(entries[0].bytes); project.password = 'must-never-restore'; entries[0].bytes = Buffer.from(JSON.stringify(project)); manifest.files[0].size = entries[0].bytes.length; manifest.files[0].sha256 = digest(entries[0].bytes);
  await assert.rejects(() => f.bundles.receiveImport(Readable.from([repack(manifest, entries)])), code('BUNDLE_PRIVATE_CONTENT'));
});

test('external native media aliases and missing timeline files produce explicit collect and missing-file reports', async t => {
  const f = await fixture(t); await f.store.save('native-links-fixture', { kind: 'video', title: '外链检查', video: { timeline: [], captions: [] } });
  const native = path.join(f.dataDir, 'openfilm/projects/native-links-fixture'); await mkdir(path.join(native, '.film'), { recursive: true });
  await writeFile(path.join(native, 'film.html'), filmHtml({ stage: { w: 320, h: 180 }, tracks: [{ clips: [{ id: 'outside', src: 'assets/中文素材.mp4', time: [0, 1] }] }] }));
  await writeFile(path.join(native, '.film/media-links.json'), JSON.stringify([{ name: 'assets/中文素材.mp4', to: path.join(f.directory, 'outside.mp4'), directory: false, added: Date.now() }]));
  const report = await f.bundles.inspectProject('native-links-fixture');
  assert.equal(report.ok, false); assert.ok(report.issues.some(item => item.code === 'BUNDLE_EXTERNAL_LINK' && /收集/.test(item.message))); assert.ok(report.issues.some(item => item.code === 'BUNDLE_FILM_MEDIA_MISSING'));
  await assert.rejects(() => f.bundles.prepareExport('native-links-fixture'), error => error.code === 'BUNDLE_PREFLIGHT_FAILED' && error.report.issues.length >= 2);
});

test('native page dependencies cannot silently disappear from an otherwise valid movie package', async t => {
  const f = await fixture(t); await f.store.save('page-resources-fixture', { kind: 'video', title: '页面依赖', video: { timeline: [] } });
  const native = path.join(f.dataDir, 'openfilm/projects/page-resources-fixture'); await mkdir(path.join(native, 'pages'), { recursive: true });
  await writeFile(path.join(native, 'film.html'), filmHtml({ stage: { w: 320, h: 180 }, tracks: [{ clips: [{ id: 'page', src: 'pages/scene.html', time: [0, 1] }] }] }));
  await writeFile(path.join(native, 'pages/scene.html'), '<!doctype html><script src="./motion.js"></script><body>画面</body>');
  const missing = await f.bundles.inspectProject('page-resources-fixture'); assert.equal(missing.ok, false); assert.ok(missing.issues.some(item => item.code === 'BUNDLE_PAGE_RESOURCE_MISSING'));
  await writeFile(path.join(native, 'pages/motion.js'), 'window.film={duration:1,frame(){}};');
  const exported = await packaged(f, 'page-resources-fixture'), { manifest, entries } = unpack(exported.bytes);
  manifest.files = manifest.files.filter(file => file.path !== 'native/pages/motion.js');
  await assert.rejects(() => f.bundles.receiveImport(Readable.from([repack(manifest, entries)])), error => error.code === 'BUNDLE_FILM_INCOMPLETE' && error.report.issues.some(item => item.code === 'BUNDLE_PAGE_RESOURCE_MISSING'));
});

test('known credentials in a binary payload are blocked rather than copied or silently corrupted', async t => {
  const f = await fixture(t); await f.store.save('binary-private-fixture', { kind: 'video', title: '二进制凭据检查', video: { timeline: [] } });
  const native = path.join(f.dataDir, 'openfilm/projects/binary-private-fixture'); await mkdir(path.join(native, 'assets'), { recursive: true });
  await writeFile(path.join(native, 'film.html'), filmHtml({ stage: { w: 320, h: 180 }, tracks: [] }));
  await writeFile(path.join(native, 'assets/opaque.bin'), Buffer.concat([Buffer.alloc(65530), Buffer.from(knownSecret), Buffer.alloc(20)]));
  const report = await f.bundles.inspectProject('binary-private-fixture'); assert.equal(report.ok, false); assert.ok(report.issues.some(item => item.code === 'BUNDLE_PRIVATE_CONTENT'));
});

test('an incomplete metadata rollback retains its new files and reports the retained project instead of destroying them', async t => {
  const f = await fixture(t);
  await f.store.save('rollback-source', { kind: 'writing', title: '来源', videoProjectId: 'rollback-primary' });
  await f.store.save('rollback-primary', { kind: 'video', title: '视频', sourceProjectId: 'rollback-source', video: { timeline: [] } });
  const exported = await packaged(f, 'rollback-primary'); let saves = 0;
  const failingStore = { ...f.store, async save(id, input) { if (++saves === 2) throw new Error('Second project commit fails'); return f.store.save(id, input); }, async remove() { throw new Error('Isolated removal permission failure'); } };
  const restore = await f.other({ store: failingStore }), preview = await restore.receiveImport(Readable.from([exported.bytes]));
  await assert.rejects(() => restore.restoreImport(preview.token), error => error.code === 'BUNDLE_ROLLBACK_INCOMPLETE' && error.report.retainedProjectIds.length === 1);
  assert.equal((await f.store.list()).projects.length, 3); assert.ok(await f.store.read('rollback-source')); assert.ok(await f.store.read('rollback-primary'));
});

test('real media, Chinese native paths, pages, state, reference ranges, cover and analysis round-trip with rollback', { timeout: 90000 }, async t => {
  try { await run(binary('ffmpeg'), ['-version'], { windowsHide: true }); } catch { t.skip('Real FFmpeg/FFprobe are required for media bundle integration.'); return; }
  const f = await fixture(t, { media: true });
  const clip = path.join(f.directory, '中文 素材.mp4'), png = path.join(f.directory, '封面.png');
  await run(binary('ffmpeg'), ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=navy:s=160x90:r=15:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip], { windowsHide: true });
  await run(binary('ffmpeg'), ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=orange:s=32x32', '-frames:v', '1', '-pix_fmt', 'rgba', '-update', '1', png], { windowsHide: true });
  const originalAsset = await f.videoService.importLocalFile(clip), image = await readFile(png), covers = await createProjectCovers(f.dataDir);
  const unusedAnimationPath = path.join(f.directory, '尚未加入时间线的动画.mp4'); await copyFile(clip, unusedAnimationPath);
  const unusedAnimation = await f.videoService.importLocalFile(unusedAnimationPath, { generated: true, generatedType: 'animation' });
  const coverRequest = Readable.from([image]); coverRequest.headers = { 'content-type': 'image/png', 'content-length': image.length };
  const cover = await covers.upload(coverRequest);
  const originalCover = await covers.read(cover.coverAssetId);
  const animationJobId = randomUUID();
  const original = await f.store.save('full-video-fixture', { kind: 'video', title: '中文完整工程', cover: 'custom', coverAssetId: cover.coverAssetId, video: { timeline: [{ assetId: originalAsset.id, start: 0, end: 1 }], captions: [], script: '保留旁白', assistantJob: { jobId: 'old-session-task' }, openfilmAnimationJob: { jobId: animationJobId, status: 'complete', progress: 1, title: '已生成未使用动画', asset: unusedAnimation, downloadUrl: '/api/video/exports/old-export/file', appended: false } } });
  const native = path.join(f.dataDir, 'openfilm/projects', original.id); await mkdir(path.join(native, 'assets'), { recursive: true }); await mkdir(path.join(native, 'pages')); await mkdir(path.join(native, '.film/history/media'), { recursive: true });
  await copyFile(clip, path.join(native, 'assets/中文 素材.mp4'));
  await writeFile(path.join(native, 'pages/标题.html'), '<!doctype html><body>中文标题<script>window.film={duration:1,frame(){}}</script></body>');
  const legacyPage = Buffer.concat([Buffer.from('<!doctype html><meta charset="windows-1252"><body>caf'), Buffer.from([233]), Buffer.from('</body>')]);
  await writeFile(path.join(native, 'pages/旧编码.html'), legacyPage);
  await writeFile(path.join(native, 'film.html'), filmHtml({ stage: { w: 160, h: 90 }, tracks: [{ attrs: { id: 'picture' }, clips: [{ id: 'picture-one', src: 'assets/中文 素材.mp4', time: [0, 1], attrs: { 'data-guangxuan-asset-id': originalAsset.id } }] }, { clips: [{ id: 'title-one', src: 'pages/标题.html', time: [0, 1] }] }] }));
  await writeFile(path.join(native, '.guangxuan-project.json'), JSON.stringify({ app: 'GuangxuanStudio', version: 1, projectId: original.id, media: { 'assets/中文 素材.mp4': { assetId: originalAsset.id, name: originalAsset.name, type: 'video', duration: 1 } } }));
  await writeFile(path.join(native, '.film/settings.json'), JSON.stringify({ fps: 30, apiKey: knownSecret }));
  await writeFile(path.join(native, '.film/canvas.json'), JSON.stringify({ assetId: originalAsset.id, url: `/api/video/media/${originalAsset.id}` }));
  await writeFile(path.join(native, '.film/history/media/history-fixture'), Buffer.from('retained native history bytes'));
  await writeFile(path.join(native, '.env'), knownSecret);
  await mkdir(path.join(f.dataDir, 'references', original.id), { recursive: true });
  const referenceId = randomUUID(), range = { start: 0.1, end: 0.8 }, targetRange = { start: 2, end: 3 };
  await writeFile(path.join(f.dataDir, 'references', original.id, 'index.json'), JSON.stringify({ version: 1, projectCreatedAt: original.createdAt, revision: 1, includeImages: true, items: [{ id: referenceId, type: 'video', assetId: originalAsset.id, name: '中文分段参考', focus: '只参考这一段', aspects: ['editing'], createdAt: original.createdAt, updatedAt: original.createdAt, sourceRange: range, targetRange }] }));
  await mkdir(path.join(f.dataDir, 'source-analysis', originalAsset.id), { recursive: true });
  await writeFile(path.join(f.dataDir, 'source-analysis', originalAsset.id, 'transcript.json'), JSON.stringify({ assetId: originalAsset.id, segments: [{ start: 0, end: 1, text: '已有转写' }] }));
  const exported = await packaged(f, original.id);
  assert.ok(!gunzipSync(exported.bytes).toString().includes(knownSecret));
  const parsed = unpack(exported.bytes); assert.equal(parsed.manifest.assets.length, 2); assert.ok(parsed.manifest.files.some(item => item.path === 'native/pages/标题.html'));
  const preview = await f.bundles.receiveImport(Readable.from([exported.bytes])), result = await f.bundles.restoreImport(preview.token);
  const newAssetId = result.mapping.assets[originalAsset.id], restoredAsset = await f.videoService.resolveAsset(newAssetId);
  assert.notEqual(newAssetId, originalAsset.id); assert.deepEqual(await readFile(restoredAsset.path), await readFile(clip));
  assert.equal(result.project.video.timeline[0].assetId, newAssetId); assert.equal(result.project.video.assistantJob, undefined);
  const restoredAnimationId = result.mapping.assets[unusedAnimation.id];
  assert.equal(result.project.video.openfilmAnimationJob.asset.id, restoredAnimationId); assert.notEqual(result.project.video.openfilmAnimationJob.jobId, animationJobId); assert.equal(result.project.video.openfilmAnimationJob.status, 'complete'); assert.equal(result.project.video.openfilmAnimationJob.downloadUrl, `/api/video/media/${restoredAnimationId}`); assert.equal(result.project.video.openfilmAnimationJob.imported, true);
  assert.deepEqual(await readFile((await f.videoService.resolveAsset(restoredAnimationId)).path), await readFile(unusedAnimationPath));
  const restoredNative = path.join(f.dataDir, 'openfilm/projects', result.projectId), film = readFilmFile(await readFile(path.join(restoredNative, 'film.html'), 'utf8'));
  assert.equal(restoredAsset.path, await realpath(path.join(restoredNative, 'assets/中文 素材.mp4')), 'Native identity must use the final native file path');
  assert.equal((await f.videoService.registerOwnedAsset(restoredAsset.path, restoredNative, { name: originalAsset.name })).id, newAssetId, 'Opening the native context must reuse the restored asset ID');
  assert.deepEqual(film.problems, []); assert.equal(film.doc.tracks[0].clips[0].src, 'assets/中文 素材.mp4');
  assert.deepEqual(await readFile(path.join(restoredNative, 'assets/中文 素材.mp4')), await readFile(clip));
  assert.deepEqual(await readFile(path.join(restoredNative, 'pages/旧编码.html')), legacyPage);
  assert.equal(JSON.parse(await readFile(path.join(restoredNative, '.guangxuan-project.json'))).projectId, result.projectId);
  assert.equal(JSON.parse(await readFile(path.join(restoredNative, '.film/settings.json'))).apiKey, undefined);
  assert.equal(await readFile(path.join(restoredNative, '.film/history/media/history-fixture'), 'utf8'), 'retained native history bytes');
  const restoredRefs = JSON.parse(await readFile(path.join(f.dataDir, 'references', result.projectId, 'index.json')));
  assert.equal(restoredRefs.projectCreatedAt, result.project.createdAt); assert.equal(restoredRefs.items[0].assetId, newAssetId); assert.notEqual(restoredRefs.items[0].id, referenceId); assert.deepEqual(restoredRefs.items[0].sourceRange, range); assert.deepEqual(restoredRefs.items[0].targetRange, targetRange);
  assert.deepEqual(await readFile(path.join(f.dataDir, 'project-covers', result.project.coverAssetId + '.png')), originalCover);
  assert.equal(JSON.parse(await readFile(path.join(f.dataDir, 'source-analysis', newAssetId, 'transcript.json'))).assetId, newAssetId);

  const filesBefore = (await readdir(path.join(f.dataDir, 'project-bundles/restored-assets'))).sort();
  const catalogBefore = JSON.parse(await readFile(path.join(f.dataDir, 'video/catalog.json'))).assets.map(item => item.id).sort();
  const brokenStore = { ...f.store, async save() { throw new Error('Isolated commit failure'); } };
  const rollback = await f.other({ store: brokenStore });
  const rollbackPreview = await rollback.receiveImport(Readable.from([exported.bytes]));
  await assert.rejects(() => rollback.restoreImport(rollbackPreview.token), /Isolated commit failure/);
  assert.deepEqual((await readdir(path.join(f.dataDir, 'project-bundles/restored-assets'))).sort(), filesBefore);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.dataDir, 'video/catalog.json'))).assets.map(item => item.id).sort(), catalogBefore);
  await assert.rejects(() => f.videoService.unregisterOwnedAssets([originalAsset.id], path.join(f.dataDir, 'project-bundles/restored-assets', result.projectId)), error => /scope|outside|范围|归属|owned/i.test(error.message) || Boolean(error.code));
  await assert.rejects(() => f.videoService.unregisterOwnedAssets([newAssetId], restoredNative), error => error.code === 'RESTORE_PROJECT_ALREADY_COMMITTED');
  assert.ok(await f.videoService.resolveAsset(originalAsset.id));
});

test('bundle HTTP streams a file, preflights raw upload and requires explicit restore confirmation', async t => {
  const f = await fixture(t); await f.store.save('http-bundle-fixture', { kind: 'writing', title: 'HTTP项目包', source: { text: '正文' } });
  const server = http.createServer((req, res) => { void f.bundles.handler(req, res, new URL(req.url, 'http://127.0.0.1')).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`, post = (url, body) => fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const exported = await (await post('/api/project-bundles/exports', { projectId: 'http-bundle-fixture' })).json();
  const download = await fetch(base + exported.downloadUrl); assert.equal(download.status, 200); assert.match(download.headers.get('content-disposition'), /filename\*/);
  const uploaded = await fetch(base + '/api/project-bundles/imports', { method: 'POST', headers: { 'content-type': 'application/x-gxproject' }, body: await download.arrayBuffer() });
  assert.equal(uploaded.status, 201); const preview = await uploaded.json(); assert.equal(preview.report.ok, true);
  const rejected = await post(`/api/project-bundles/imports/${preview.token}/restore`, {}); assert.equal(rejected.status, 400);
  const restored = await post(`/api/project-bundles/imports/${preview.token}/restore`, { confirm: true, title: 'HTTP恢复副本' }); assert.equal(restored.status, 201); assert.equal((await restored.json()).project.title, 'HTTP恢复副本');
});

test('service shutdown waits for a confirmed metadata commit and leaves its restored project intact', async t => {
  const f = await fixture(t); await f.store.save('shutdown-source', { kind: 'writing', title: '关服提交测试', source: { text: '保留已确认恢复' } });
  const exported = await packaged(f, 'shutdown-source');
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), saving = new Promise(resolve => { entered = resolve; });
  const waitingStore = { ...f.store, async save(id, input) { entered(); await gate; return f.store.save(id, input); } };
  const service = await f.other({ store: waitingStore }), preview = await service.receiveImport(Readable.from([exported.bytes]));
  const restoring = service.restoreImport(preview.token); await saving;
  let closed = false; const closing = service.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
  release(); const result = await restoring; await closing;
  assert.equal((await f.store.read(result.projectId)).source.text, '保留已确认恢复'); assert.equal(closed, true);
});
