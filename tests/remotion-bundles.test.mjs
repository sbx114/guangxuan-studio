import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createProjectStore } from '../lib/store.mjs';
import { createRemotionProjectsService } from '../lib/remotion-projects.mjs';
import { createProjectBundleService, PROJECT_BUNDLE_MAGIC } from '../lib/project-bundles.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const sourceFiles = label => [{ path: 'src/index.tsx', content: `import React from 'react'; import {registerRoot} from 'remotion'; export const label=${JSON.stringify(label)}; registerRoot(()=>null);` }, { path: 'src/options.json', content: '{ "businessField": "unchanged JSON source" }' }, { path: 'src/draft-config.json', content: '{"constructor":"literal source data","unfinished":' }, { path: 'src/color.glsl', content: 'precision mediump float; void main(){gl_FragColor=vec4(1.0);}' }, { path: 'public/diagram.svg', content: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>' }];
async function setup(t, overrides = {}) {
  const parent = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'gx-remotion-bundle-')), dataDir = path.join(directory, 'data'), store = await createProjectStore(dataDir), binary = path.join(directory, 'resource.png'); await writeFile(binary, PNG);
  let jobs = 0;
  const remotionProjects = await createRemotionProjectsService({ dataDir, root, onJob: () => { jobs++; }, resolveAsset: async () => ({ path: binary, name: 'resource.png', type: 'image' }) });
  const bundles = await createProjectBundleService({ dataDir, root, store, remotionProjects, ...overrides });
  t.after(async () => { await bundles.close(); await remotionProjects.close(); await store.settle(); assert.equal(path.dirname(directory), parent); await rm(directory, { recursive: true, force: true }); });
  return { directory, dataDir, store, bundles, remotionProjects, jobs: () => jobs };
}
async function populate(env) {
  const origin = await env.store.save('source-writing', { kind: 'writing', title: '直接来源', source: { text: '保留来源材料' } });
  let project = await env.store.save('video-one', { kind: 'video', title: '自由动画项目', sourceProjectId: origin.id, video: { timeline: [], captions: [] } });
  const first = await env.remotionProjects.create(project.id, { ownerCreatedAt: project.createdAt, title: '当前源码', entryPoint: 'src/index.tsx', compositionId: 'OpenComposition', inputProps: { title: '精确保留参数', nested: { value: 42 } }, files: sourceFiles('old revision sentinel'), assets: [{ assetId: 'image-resource-0001' }] });
  const current = await env.remotionProjects.update(project.id, first.id, { expectedRevision: first.revision, files: [sourceFiles('current revision only')[0]] });
  const dependent = await env.remotionProjects.create(origin.id, { ownerCreatedAt: origin.createdAt, title: '来源关联动画', entryPoint: 'src/index.tsx', compositionId: 'Source', inputProps: { source: true }, files: sourceFiles('source current') });
  project = await env.store.save(project.id, { ...project, video: { ...project.video, remotionProjectId: current.id, remotionRevision: current.revision, assistantMessages: [{ role: 'assistant', content: '已保存源码，未自动执行', status: 'complete', remotionId: current.id, revision: current.revision }] } });
  return { project, origin, current, dependent };
}
async function packaged(env, id = 'video-one') { const result = await env.bundles.prepareExport(id); return { result, bytes: await readFile(path.join(env.dataDir, 'project-bundles', result.token, 'project.gxproject')) }; }
function unpack(bytes) { const raw = gunzipSync(bytes), start = PROJECT_BUNDLE_MAGIC.length + 4, size = raw.readUInt32BE(PROJECT_BUNDLE_MAGIC.length), manifest = JSON.parse(raw.subarray(start, start + size)); let at = start + size; return { manifest, entries: new Map(manifest.files.map(item => { const bytes = raw.subarray(at, at + item.size); at += item.size; return [item.path, bytes]; })) }; }
function pack(value) { const text = Buffer.from(JSON.stringify(value.manifest)), size = Buffer.alloc(4); size.writeUInt32BE(text.length); return gzipSync(Buffer.concat([PROJECT_BUNDLE_MAGIC, size, text, ...value.manifest.files.map(item => value.entries.get(item.path))])); }
function change(value, filename, mutate) { const record = JSON.parse(value.entries.get(filename)), next = Buffer.from(JSON.stringify(mutate(record))); value.entries.set(filename, next); Object.assign(value.manifest.files.find(item => item.path === filename), { size: next.length, sha256: hash(next) }); }

test('complete bundles preserve current free Remotion source, public resources and directly linked sources without execution', async t => {
  const source = await setup(t), target = await setup(t), original = await populate(source), originalProjectBytes = await readFile(path.join(source.dataDir, 'projects/video-one.json'));
  const archived = await packaged(source), content = unpack(archived.bytes), prefix = `remotion-projects/video-one/${original.current.id}/`;
  assert.equal(archived.result.report.remotionProjectCount, 2); assert.ok(content.entries.has(prefix + 'project.json')); assert.ok(content.entries.has(prefix + 'source/src/index.tsx')); assert.ok(content.entries.has(prefix + 'source/src/color.glsl'));
  assert.equal(gunzipSync(archived.bytes).includes(Buffer.from('old revision sentinel')), false); assert.ok(content.manifest.files.every(item => !/\/(?:jobs|revisions|node_modules)\//.test(item.path)));
  const preview = await target.bundles.receiveImport(Readable.from([archived.bytes])), restored = await target.bundles.restoreImport(preview.token);
  assert.notEqual(restored.projectId, original.project.id); const remotionId = restored.mapping.remotionProjects[original.current.id], sourceId = restored.mapping.projects[original.origin.id], sourceRemotionId = restored.mapping.remotionProjects[original.dependent.id];
  assert.notEqual(remotionId, original.current.id); assert.notEqual(sourceRemotionId, original.dependent.id);
  const restoredProject = await target.store.read(restored.projectId), record = await target.remotionProjects.read(restored.projectId, remotionId), linked = await target.remotionProjects.read(sourceId, sourceRemotionId);
  assert.equal(record.revision, 1); assert.equal(record.ownerCreatedAt, restoredProject.createdAt); assert.equal(record.projectId, restored.projectId); assert.equal(record.entryPoint, original.current.entryPoint); assert.equal(record.compositionId, original.current.compositionId); assert.deepEqual(record.inputProps, original.current.inputProps); assert.deepEqual(record.files, original.current.files);
  assert.equal(restoredProject.video.remotionProjectId, remotionId); assert.equal(restoredProject.video.remotionRevision, 1); assert.equal(restoredProject.video.assistantMessages[0].remotionId, remotionId); assert.equal(restoredProject.video.assistantMessages[0].revision, 1); assert.equal(linked.ownerCreatedAt, (await target.store.read(sourceId)).createdAt);
  const exportedAgain = await target.remotionProjects.exportArchive(restored.projectId, remotionId); assert.deepEqual(await readFile(exportedAgain.assets[0].filename), PNG); assert.equal(exportedAgain.assets[0].publicPath, original.current.assets[0].publicPath);
  assert.ok(restored.report.warnings.some(item => item.code === 'BUNDLE_REMOTION_SOURCE_RESTORED'));
  assert.equal(source.jobs(), 0); assert.equal(target.jobs(), 0); assert.deepEqual(await readFile(path.join(source.dataDir, 'projects/video-one.json')), originalProjectBytes);
  assert.deepEqual(await target.bundles.restoreImport(preview.token), restored, 'Restore receipts do not duplicate imported source projects');
});

test('old bundles without free animation sources remain compatible when no source service is configured', async t => {
  const source = await setup(t), target = await setup(t); await source.store.save('plain', { kind: 'writing', source: { text: '旧存档材料' } });
  const archived = await packaged(source, 'plain'), bare = await createProjectBundleService({ dataDir: target.dataDir, root, store: target.store }); t.after(() => bare.close());
  const preview = await bare.receiveImport(Readable.from([archived.bytes])), restored = await bare.restoreImport(preview.token); assert.equal(restored.project.source.text, '旧存档材料'); assert.equal(restored.mapping.remotionProjects, undefined);
});

test('source owner, missing current source, extra files and resource hash mutations fail preflight', async t => {
  const source = await setup(t), target = await setup(t), original = await populate(source), { bytes } = await packaged(source), prefix = `remotion-projects/video-one/${original.current.id}/`, metadata = prefix + 'project.json';
  for (const mutate of [value => { value.ownerCreatedAt = 'different-owner'; return value; }, value => { value.files[0].sha256 = 'a'.repeat(64); return value; }, value => { value.assets[0].publicPath = '../../escaped.png'; return value; }, value => { value.entryPoint = 'outside.tsx'; return value; }]) {
    const archive = unpack(bytes); change(archive, metadata, mutate); await assert.rejects(() => target.bundles.receiveImport(Readable.from([pack(archive)])), { code: 'BUNDLE_REMOTION_INVALID' });
  }
  const absent = unpack(bytes); absent.manifest.files = absent.manifest.files.filter(item => !item.path.startsWith(prefix)); await assert.rejects(() => target.bundles.receiveImport(Readable.from([pack(absent)])), { code: 'BUNDLE_REMOTION_INVALID' });
  const extra = unpack(bytes), name = prefix + 'source/src/unlisted.ts'; extra.entries.set(name, Buffer.from('not declared')); extra.manifest.files.push({ path: name, size: 12, sha256: hash(extra.entries.get(name)) }); await assert.rejects(() => target.bundles.receiveImport(Readable.from([pack(extra)])), { code: 'BUNDLE_REMOTION_INVALID' });
  const traversal = unpack(bytes), targetEntry = traversal.manifest.files.find(item => item.path.endsWith('/source/src/index.tsx')), oldName = targetEntry.path; targetEntry.path = prefix + 'source/../outside.tsx'; traversal.entries.set(targetEntry.path, traversal.entries.get(oldName)); await assert.rejects(() => target.bundles.receiveImport(Readable.from([pack(traversal)])));
  assert.equal(target.jobs(), 0); assert.deepEqual(await readdir(path.join(target.dataDir, 'projects')), []);
});

test('source service unavailability cannot silently drop saved free animation drafts', async t => {
  const env = await setup(t); await populate(env);
  const project = await env.store.read('video-one'), video = { ...project.video }; delete video.remotionProjectId; delete video.remotionRevision; delete video.assistantMessages; await env.store.save(project.id, { ...project, video });
  const bare = await createProjectBundleService({ dataDir: env.dataDir, root, store: env.store }); t.after(() => bare.close());
  await assert.rejects(() => bare.prepareExport('video-one'), error => error.code === 'BUNDLE_PREFLIGHT_FAILED' && error.report.issues.some(item => item.code === 'BUNDLE_REMOTION_INVALID'));
});

test('failed parent restore rolls back only newly imported Remotion source projects', async t => {
  const source = await setup(t), target = await setup(t), original = await populate(source), archived = await packaged(source), imported = [];
  const keptParent = await target.store.save('keep-existing', { kind: 'video' }), kept = await target.remotionProjects.create(keptParent.id, { ownerCreatedAt: keptParent.createdAt, files: sourceFiles('keep existing'), assets: [] });
  const sourceService = { ...target.remotionProjects, async importArchive(...args) { const value = await target.remotionProjects.importArchive(...args); imported.push({ projectId: args[0], id: value.id }); return value; } };
  const brokenStore = { ...target.store, async save() { throw new Error('injected save failure'); } }, bundles = await createProjectBundleService({ dataDir: target.dataDir, root, store: brokenStore, remotionProjects: sourceService }); t.after(() => bundles.close());
  const preview = await bundles.receiveImport(Readable.from([archived.bytes])); await assert.rejects(() => bundles.restoreImport(preview.token), /injected save failure/); assert.equal(imported.length, 2);
  for (const item of imported) await assert.rejects(() => target.remotionProjects.read(item.projectId, item.id), { code: 'REMOTION_PROJECT_NOT_FOUND' });
  assert.equal((await target.remotionProjects.read(keptParent.id, kept.id)).title, kept.title); assert.equal(target.jobs(), 0); assert.deepEqual(await readdir(path.join(target.dataDir, 'projects')), ['keep-existing.json']);
});

test('a new source project created during export cannot silently disappear from the package', async t => {
  const env = await setup(t), original = await populate(env); let created = false;
  const wrapped = { ...env.remotionProjects, async exportArchive(...args) { const result = await env.remotionProjects.exportArchive(...args); if (!created) { created = true; await env.remotionProjects.create(original.project.id, { ownerCreatedAt: original.project.createdAt, title: '刚保存的新工程', files: sourceFiles('late current'), assets: [] }); } return result; } };
  const bundles = await createProjectBundleService({ dataDir: env.dataDir, root, store: env.store, remotionProjects: wrapped }); t.after(() => bundles.close());
  await assert.rejects(() => bundles.prepareExport('video-one'), { code: 'BUNDLE_SOURCE_CHANGED' }); assert.equal(env.jobs(), 0);
});
