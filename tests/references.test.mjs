import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createReferenceService } from '../lib/references.mjs';
import { createProjectStore } from '../lib/store.mjs';
import { AppError } from '../lib/errors.mjs';

const jpeg = 'data:image/jpeg;base64,/9j/2Q==';
const ids = Array.from({ length: 10 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`);
const asset = (id, type = 'video', extra = {}) => ({ id, type, name: type + '.fixture', size: 1024, duration: 12, width: 1280, height: 720, hasAudio: true, path: 'C:/private-location/never-in-context', ...extra });
function media(assets = ids.map(id => asset(id))) {
  const known = new Map(assets.map(value => [value.id, value])), calls = [];
  return {
    calls,
    async resolveAsset(id) { if (!known.has(id)) throw new AppError(404, 'missing', 'MEDIA_NOT_FOUND'); return known.get(id); },
    async referenceFrames(id, { count, signal }) {
      signal?.throwIfAborted(); calls.push({ id, count });
      const value = known.get(id);
      return Array.from({ length: value.type === 'image' ? 1 : count }, (_, index) => ({ dataUrl: jpeg, ...(value.type === 'image' ? {} : { timestamp: (index + 1) * 2 }) }));
    },
  };
}
async function setup(t, videoService = media()) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'guangxuan-references-test-'));
  const store = await createProjectStore(dataDir);
  const project = await store.save('video-project', { kind: 'video', title: 'Fixture video', video: { timeline: [], captions: [] } });
  let service = await createReferenceService({ dataDir, store, videoService });
  t.after(async () => {
    await service.close(); await store.settle();
    const target = path.resolve(dataDir);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('guangxuan-references-test-')) throw new Error('Unsafe test cleanup');
    await rm(target, { recursive: true, force: true });
  });
  return { dataDir, store, project, get service() { return service; }, async restart() { await service.close(); service = await createReferenceService({ dataDir, store, videoService }); return service; } };
}
const fails = (fn, code) => assert.rejects(async () => fn(), error => error instanceof AppError && error.code === code);

test('references persist independently across restart and older project autosaves', async t => {
  const fixture = await setup(t, media([asset(ids[0], 'image', { duration: 4 })]));
  const initial = await fixture.service.list('video-project');
  assert.deepEqual(initial, { items: [], revision: 0, includeImages: true });
  await fixture.service.add('video-project', { type: 'text', text: 'Reference text', focus: 'Use its structure', name: 'Structure', sourceUrl: 'https://example.test/source' });
  const second = await fixture.service.add('video-project', { type: 'image', assetId: ids[0], focus: 'Colors only' });
  const textId = second.items[0].id;
  await fixture.service.update('video-project', textId, { text: 'Edited reference text', focus: 'Use the pacing', name: 'Edited title' });
  const expected = await fixture.service.configure('video-project', { includeImages: false });
  const originalProject = structuredClone(fixture.project);
  originalProject.video.script = 'A delayed, unrelated editing save';
  await fixture.store.save('video-project', originalProject);
  assert.equal((await fixture.store.read('video-project')).video.script, originalProject.video.script);
  assert.equal('references' in (await fixture.store.read('video-project')).video, false);
  await fixture.restart();
  assert.deepEqual(await fixture.service.list('video-project'), expected);
  const context = await fixture.service.context('video-project');
  assert.equal(context.images.length, 0); assert.ok(context.references.items.every(item => item.frames.length === 0));
  assert.equal(context.references.items[0].text, 'Edited reference text');
  const stored = await readFile(path.join(fixture.dataDir, 'references', 'video-project', 'index.json'), 'utf8');
  assert.equal(stored.includes('data:image/'), false);
  assert.equal(stored.includes('private-location'), false);
  assert.equal((await fixture.service.remove('video-project', textId)).items.length, 1);
});

test('reference mutations validate media, bounded text, supported projects and source URLs', async t => {
  const fixture = await setup(t, media([
    asset(ids[0], 'audio'), asset(ids[1], 'video', { size: 200 * 1024 * 1024 + 1 }),
    asset(ids[2], 'image', { size: 20 * 1024 * 1024 + 1 }), asset(ids[3], 'image'),
  ]));
  await fixture.store.save('writing-project', { kind: 'writing', title: 'Unrelated writing' });
  const bad = [
    [{ type: 'audio', assetId: ids[0] }, 'INVALID_REFERENCE_TYPE'],
    [{ type: 'video', assetId: ids[0] }, 'INVALID_REFERENCE_MEDIA'],
    [{ type: 'image', assetId: ids[9] }, 'MEDIA_NOT_FOUND'],
    [{ type: 'image', assetId: '../private-file' }, 'INVALID_REFERENCE_ASSET'],
    [{ type: 'video', assetId: ids[1] }, 'REFERENCE_MEDIA_TOO_LARGE'],
    [{ type: 'image', assetId: ids[2] }, 'REFERENCE_MEDIA_TOO_LARGE'],
    [{ type: 'text', text: '' }, 'INVALID_INPUT'],
    [{ type: 'text', text: 'x'.repeat(12001) }, 'INPUT_TOO_LARGE'],
    [{ type: 'text', text: 'x', focus: 'x'.repeat(1501) }, 'INPUT_TOO_LARGE'],
    [{ type: 'text', text: 'x', name: 'x'.repeat(121) }, 'INPUT_TOO_LARGE'],
    [{ type: 'text', text: 'x', sourceUrl: 'file:///private.txt' }, 'INVALID_REFERENCE_URL'],
    [{ type: 'text', text: 'x', sourceUrl: 'https://user:password@example.test/' }, 'INVALID_REFERENCE_URL'],
    [{ type: 'text', text: 'x', sourceUrl: 'https://example.test/' + '中'.repeat(1000) }, 'INPUT_TOO_LARGE'],
    [{ type: 'text', text: 'x', path: 'C:/private' }, 'INVALID_REFERENCE_FIELDS'],
  ];
  for (const [item, code] of bad) await fails(() => fixture.service.add('video-project', item), code);
  await fails(() => fixture.service.add('missing', { type: 'text', text: 'x' }), 'PROJECT_NOT_FOUND');
  await fails(() => fixture.service.add('writing-project', { type: 'text', text: 'x' }), 'REFERENCE_PROJECT_REQUIRED');
  const saved = await fixture.service.add('video-project', { type: 'image', assetId: ids[3] });
  await fails(() => fixture.service.update('video-project', saved.items[0].id, { assetId: ids[0] }), 'INVALID_REFERENCE_FIELDS');
  await fails(() => fixture.service.update('video-project', saved.items[0].id, { text: 'change kind' }), 'INVALID_REFERENCE_FIELDS');
  await fails(() => fixture.service.configure('video-project', { includeImages: 'false' }), 'INVALID_REFERENCE_CONFIGURATION');
  assert.equal((await fixture.service.list('video-project')).items.length, 1);
});

test('queued additions retain all updates and enforce the per-project reference limit', async t => {
  const fixture = await setup(t);
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => fixture.service.add('video-project', { type: 'text', name: String(index), text: 'Reference ' + index })));
  assert.deepEqual(results.map(result => result.revision), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal((await fixture.service.list('video-project')).items.length, 8);
  await fails(() => fixture.service.add('video-project', { type: 'text', text: 'Ninth' }), 'REFERENCE_LIMIT');
});

test('reference aspects have type defaults, persist edits and leave older indexes untouched on read', async t => {
  const fixture = await setup(t, media([asset(ids[0]), asset(ids[1], 'image')]));
  await fixture.service.add('video-project', { type: 'video', assetId: ids[0] });
  await fixture.service.add('video-project', { type: 'image', assetId: ids[1] });
  const state = await fixture.service.add('video-project', { type: 'text', text: 'Structure reference' });
  assert.deepEqual(state.items.map(item => item.aspects), [['style', 'editing'], ['style', 'color'], ['structure']]);
  await fails(() => fixture.service.update('video-project', state.items[0].id, { aspects: ['style', 'style'] }), 'INVALID_REFERENCE_ASPECTS');
  await fails(() => fixture.service.update('video-project', state.items[0].id, { aspects: ['unknown'] }), 'INVALID_REFERENCE_ASPECTS');
  await fixture.service.update('video-project', state.items[0].id, { aspects: ['titles', 'composition'] });
  await fixture.service.configure('video-project', { includeImages: false });
  assert.deepEqual((await fixture.service.context('video-project')).references.items[0].aspects, ['titles', 'composition']);
  const filename = path.join(fixture.dataDir, 'references', 'video-project', 'index.json');
  const legacy = JSON.parse(await readFile(filename, 'utf8')); delete legacy.items[2].aspects;
  const bytes = JSON.stringify(legacy); await writeFile(filename, bytes);
  assert.deepEqual((await fixture.service.list('video-project')).items[2].aspects, []);
  assert.equal(await readFile(filename, 'utf8'), bytes);
});

test('project deletion while media resolution is pending prevents current and queued reference writes', async t => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const videoService = { async resolveAsset(id) { entered(); await new Promise(resolve => { release = resolve; }); return asset(id); } };
  const fixture = await setup(t, videoService);
  const first = fixture.service.add('video-project', { type: 'video', assetId: ids[0] });
  const next = fixture.service.configure('video-project', { includeImages: false });
  const firstRejected = fails(() => first, 'PROJECT_NOT_FOUND');
  const nextRejected = fails(() => next, 'PROJECT_NOT_FOUND');
  await started; await fixture.store.remove('video-project'); release();
  await Promise.all([firstRejected, nextRejected]);
  assert.equal(await fixture.store.read('video-project'), null);
  await assert.rejects(stat(path.join(fixture.dataDir, 'references', 'video-project', 'index.json')), { code: 'ENOENT' });
});

test('context fairly budgets actual images and never exposes private paths or editable asset IDs', async t => {
  const videoService = media(), fixture = await setup(t, videoService);
  for (let index = 0; index < 8; index++) await fixture.service.add('video-project', { type: 'video', assetId: ids[index], name: 'Reference ' + index, focus: 'User focus ' + index });
  const context = await fixture.service.context('video-project');
  assert.equal(context.images.length, 12);
  assert.ok(context.references.items.every(item => item.frames.length >= 1 && item.frames.length <= 3));
  assert.deepEqual(videoService.calls.map(call => call.count), [2, 2, 2, 2, 1, 1, 1, 1]);
  for (const item of context.references.items) {
    assert.equal(item.duration, 12); assert.equal(item.assetId, undefined); assert.equal(item.path, undefined);
    assert.ok(item.frames.every(frame => Number.isFinite(frame.timestamp) && frame.label.includes(item.name)));
    assert.equal(context.images.filter(image => image.referenceId === item.id).length, item.frames.length);
  }
  assert.equal(JSON.stringify(context).includes('private-location'), false);
  const previous = videoService.calls.length;
  await fixture.service.configure('video-project', { includeImages: false });
  const textOnly = await fixture.service.context('video-project');
  assert.equal(textOnly.images.length, 0); assert.ok(textOnly.references.items.every(item => !item.frames.length));
  assert.equal(videoService.calls.length, previous);
});

test('image references omit fictional duration and canceled context reads do not modify saved references', async t => {
  const videoService = media([asset(ids[0], 'image', { duration: 4 })]), fixture = await setup(t, videoService);
  await fixture.service.add('video-project', { type: 'image', assetId: ids[0] });
  const context = await fixture.service.context('video-project');
  assert.equal(context.images.length, 1); assert.equal(context.references.items[0].duration, undefined); assert.equal(context.images[0].timestamp, undefined);
  const before = await fixture.service.list('video-project');
  let entered; const pending = new Promise(resolve => { entered = resolve; });
  videoService.referenceFrames = async (_id, { signal }) => { entered(); await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Canceled', 'AbortError')), { once: true })); };
  const controller = new AbortController(), request = fixture.service.context('video-project', { signal: controller.signal });
  const rejected = fails(() => request, 'REFERENCE_CANCELLED');
  await pending; controller.abort(); await rejected;
  assert.deepEqual(await fixture.service.list('video-project'), before);
});
