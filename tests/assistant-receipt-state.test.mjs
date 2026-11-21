import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createProjectStore } from '../lib/store.mjs';
import { createAssistantAppTools } from '../lib/assistant-app-tools.mjs';
import { createNovelLibraryService } from '../lib/novel-library.mjs';
import { createRemotionProjectsService } from '../lib/remotion-projects.mjs';
import { createRemotionIntegration } from '../lib/remotion-integration.mjs';
import { createOpenFilmManager } from '../lib/openfilm.mjs';
import { filmHtml } from '../integrations/openfilm/packages/openfilm/src/film-doc.mjs';

const root = path.resolve(import.meta.dirname, '..'), code = expected => error => error.code === expected;
async function fixture(t, { kind = 'writing', makeServices = async () => ({}) } = {}) {
  const parent = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'gx-receipt-state-')), dataDir = path.join(directory, 'data'), store = await createProjectStore(dataDir);
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port; assert.notEqual(new URL(origin).port, '4417');
  const project = await store.save('receipt-project', { kind, title: 'Original', source: { text: 'Fixture only' }, ...(kind === 'video' ? { video: { timeline: [], captions: [] } } : {}) });
  const services = await makeServices({ dataDir, store, project, origin }), app = createAssistantAppTools({ store, ...services });
  t.after(async () => { await app.close(); for (const service of new Set(Object.values(services))) await service?.close?.(); await store.settle(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); assert.equal(path.dirname(directory), parent); await rm(directory, { recursive: true, force: true }); });
  const ctx = { projectId: project.id, runId: randomUUID(), instruction: '按顺序修改当前工程，按要求撤销并重新应用。', scopeAuthority: 'dialog', mode: 'auto', origin, signal: new AbortController().signal, update() {} };
  return { dataDir, store, project, services, app, ctx, call: (name, args, context = ctx) => app.tools.find(tool => tool.name === name).execute(args || {}, { ...context, callId: randomUUID() }) };
}

test('a same-state resend is deduplicated but A → B → A really reapplies A with a fresh undo', async t => {
  const f = await fixture(t), first = await f.call('project_update', { title: 'A' }), resend = await f.call('project_update', { title: 'A' });
  assert.deepEqual(resend, first); assert.equal((await f.store.read(f.project.id)).assistantRevision, 1);
  await f.call('project_update', { title: 'B' }); const again = await f.call('project_update', { title: 'A' });
  assert.equal((await f.store.read(f.project.id)).title, 'A'); assert.equal((await f.store.read(f.project.id)).assistantRevision, 3); assert.notEqual(again.effects[0].undo.id, first.effects[0].undo.id);
});

test('undo followed by the same arguments performs a new write instead of resurrecting a consumed receipt', async t => {
  const f = await fixture(t), first = await f.call('project_update', { title: 'A' });
  await f.call('assistant_undo_apply', { undoId: first.effects[0].undo.id }); assert.equal((await f.store.read(f.project.id)).title, 'Original');
  const reapplied = await f.call('project_update', { title: 'A' }); assert.equal((await f.store.read(f.project.id)).title, 'A'); assert.notEqual(reapplied.effects[0].undo.id, first.effects[0].undo.id);
});

test('a cached success cannot bypass a manual project edit and duplicate first requests share initialization', async t => {
  const f = await fixture(t);
  const [a, b] = await Promise.all([f.call('project_update', { title: 'A' }), f.call('project_update', { title: 'A' })]);
  assert.equal(a.effects[0].undo.id, b.effects[0].undo.id); assert.equal((await f.store.read(f.project.id)).assistantRevision, 1);
  await f.store.patchMetadata(f.project.id, { title: 'Manual user edit' });
  await assert.rejects(f.call('project_update', { title: 'A' }), code('ASSISTANT_CONFLICT')); assert.equal((await f.store.read(f.project.id)).title, 'Manual user edit');
});

test('ordinary writing retries never open unrelated native, library or Remotion services', async t => {
  const unexpected = () => { throw new Error('Unrelated service should not be read'); };
  const f = await fixture(t, { makeServices: async () => ({ openFilm: { context: unexpected, async syncMetadata() {} }, novelLibrary: { list: unexpected }, remotion: { list: unexpected, read: unexpected } }) });
  const a = await f.call('project_update', { title: 'A' }), b = await f.call('project_update', { title: 'A' }); assert.deepEqual(b, a); assert.equal((await f.store.read(f.project.id)).assistantRevision, 1);
});

test('a write in another project does not invalidate an unchanged run receipt', async t => {
  const f = await fixture(t), first = await f.call('project_update', { title: 'A' });
  await f.store.save('independent-project', { kind: 'writing', title: 'Other project', source: { text: '' } });
  await f.call('project_update', { title: 'B' }, { ...f.ctx, projectId: 'independent-project', runId: randomUUID() });
  const resend = await f.call('project_update', { title: 'A' }); assert.equal(resend.effects[0].undo.id, first.effects[0].undo.id); assert.equal((await f.store.read(f.project.id)).assistantRevision, 1);
});

test('actual shared-library revision changes invalidate a cached profile receipt before its real CAS', async t => {
  const f = await fixture(t, { makeServices: async ({ dataDir, store }) => ({ novelLibrary: await createNovelLibraryService({ dataDir, store }) }) }), library = f.services.novelLibrary;
  await library.saveCharacter({ id: 'guide', name: 'Original', portraits: [] });
  const before = await library.list(), args = { action: 'update', kind: 'character', id: 'guide', expectedRevision: before.revision, profile: { name: 'A' } }, ctx = { ...f.ctx, instruction: '修改公用素材库中的guide人物。' };
  const first = await f.call('library_profile_manage', args, ctx), resend = await f.call('library_profile_manage', args, ctx); assert.deepEqual(resend, first);
  await library.saveCharacter({ id: 'guide', name: 'Manual profile', portraits: [] }, { expectedRevision: (await library.list()).revision });
  await assert.rejects(f.call('library_profile_manage', args, ctx), code('NOVEL_LIBRARY_REVISION_CONFLICT')); assert.equal((await library.list()).characters[0].name, 'Manual profile');
});

test('real Remotion byte changes cannot hide behind an unchanged cached source receipt', async t => {
  const f = await fixture(t, { kind: 'video', makeServices: async ({ dataDir, store }) => {
    const remotionProjects = await createRemotionProjectsService({ dataDir, root });
    return { remotionProjects, remotion: createRemotionIntegration({ projects: remotionProjects, store }) };
  } });
  const args = { files: [{ path: 'src/index.tsx', content: 'export const original = 1;' }] }, first = await f.call('remotion_create', args), resend = await f.call('remotion_create', args); assert.equal(resend.data.id, first.data.id);
  const sourcePath = path.join(f.dataDir, 'remotion-projects', f.project.id, first.data.id, 'revisions/1/src/index.tsx'); await writeFile(sourcePath, 'export const manual = 2;');
  const again = await f.call('remotion_create', args); assert.notEqual(again.data.id, first.data.id, 'A changed source cannot be reported as the original successful create'); assert.equal(await readFile(sourcePath, 'utf8'), 'export const manual = 2;');
});

test('real native setters reapply after a toggle and a cached result never bypasses manual film CAS', { skip: process.env.GUANGXUAN_TEST_OPENFILM !== '1', timeout: 60000 }, async t => {
  const f = await fixture(t, { kind: 'video', makeServices: async ({ dataDir, store, project, origin }) => {
    const manager = await createOpenFilmManager({ dataDir, root, store }); await manager.open(project.id, origin);
    const home = path.join(dataDir, 'openfilm/projects', project.id); await mkdir(path.join(home, 'pages'), { recursive: true });
    await writeFile(path.join(home, 'pages/scene.html'), '<!doctype html><body><script>window.film={duration:2,frame(t){}};</script></body>');
    await writeFile(path.join(home, 'film.html'), filmHtml({ stage: { w: 128, h: 72 }, tracks: [{ clips: [{ id: 'scene', src: 'pages/scene.html', time: [0, 2], size: { w: 128, h: 72 } }] }] })); return { openFilm: manager };
  } });
  const args = opacity => ({ edits: [{ action: 'transform', clipId: 'scene', opacity }] });
  const first = await f.call('native_adjust', args(.5)), resend = await f.call('native_adjust', args(.5)); assert.equal(resend.effects[0].undo.id, first.effects[0].undo.id);
  await f.call('native_adjust', args(1)); const last = await f.call('native_adjust', args(.5)); assert.notEqual(last.effects[0].undo.id, first.effects[0].undo.id);
  const manager = f.services.openFilm, current = await manager.context(f.project.id, f.ctx.origin); assert.equal(current.editorTimeline.clips[0].opacity, .5);
  await manager.adjustClips(f.project.id, [{ action: 'transform', clipId: 'scene', opacity: .8 }], f.ctx.origin, current.revision);
  await assert.rejects(f.call('native_adjust', args(.5)), error => error.code === 'ASSISTANT_CONFLICT' && /时间线/.test(error.message)); assert.equal((await manager.context(f.project.id, f.ctx.origin)).editorTimeline.clips[0].opacity, .8);
});
