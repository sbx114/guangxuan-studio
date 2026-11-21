import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createProjectStore } from '../lib/store.mjs';
import { createOpenFilmManager } from '../lib/openfilm.mjs';
import { filmHtml } from '../integrations/openfilm/packages/openfilm/src/film-doc.mjs';

const root = path.resolve(import.meta.dirname, '..');
// Valid 1x1 PNGs keep 501 distinct real media paths under 40 KiB in total.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5yoAAAAASUVORK5CYII=', 'base64');

test('real native context registers every declared source after asset 500 without changing the film', { skip: process.env.GUANGXUAN_TEST_OPENFILM !== '1', timeout: 90000 }, async t => {
  const parent = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'gx-native-many-assets-')), dataDir = path.join(directory, 'data'), store = await createProjectStore(dataDir), projectId = 'many-owned-sources', origin = 'http://127.0.0.1:49794';
  let manager;
  t.after(async () => { await manager?.close(); await store.settle(); assert.equal(path.dirname(directory), parent); assert.ok(path.basename(directory).startsWith('gx-native-many-assets-')); await rm(directory, { recursive: true, force: true }); });
  await store.save(projectId, { kind: 'video', title: 'Isolated many-source fixture', video: { timeline: [], captions: [] } });
  const registered = new Map(), options = { root, dataDir, store, registerOwnedAsset: async (filename, scope, metadata = {}) => {
    const actualRoot = await realpath(scope), actualPath = await realpath(filename); assert.ok(actualPath.startsWith(actualRoot + path.sep));
    const info = await stat(actualPath); assert.equal(info.isFile(), true); assert.equal(info.size, png.length); assert.deepEqual(await readFile(actualPath), png);
    const relative = path.relative(actualRoot, actualPath).replaceAll('\\', '/'), id = createHash('sha256').update(relative).digest('hex').slice(0, 24);
    registered.set(relative, id); return { id, name: metadata.name || path.basename(filename), type: 'image', duration: 5, width: 1, height: 1, hasAudio: false, generated: false };
  } };
  manager = await createOpenFilmManager(options); await manager.context(projectId, origin); await manager.close();
  const home = path.join(dataDir, 'openfilm/projects', projectId), mediaHome = path.join(home, 'assets/guangxuan'); await mkdir(mediaHome, { recursive: true });
  const clips = [];
  for (let index = 0; index < 501; index++) {
    const name = `image-${String(index + 1).padStart(4, '0')}.png`, src = 'assets/guangxuan/' + name; await writeFile(path.join(mediaHome, name), png);
    clips.push({ id: 'clip-' + (index + 1), src, at: index, time: [0, 1] });
  }
  const film = path.join(home, 'film.html'), original = filmHtml({ stage: { w: 1280, h: 720 }, tracks: [{ attrs: { id: 'guangxuan-picture' }, clips }] }); await writeFile(film, original);
  manager = await createOpenFilmManager(options);
  const current = await manager.context(projectId, origin, { inspectAll: true, inspection: { offset: 500, limit: 1 } });
  assert.equal(registered.size, 501); assert.equal(current.assets.length, 501); assert.equal(current.timeline.length, 501); assert.equal(current.mainTrackEditable, true);
  assert.equal(current.editorTimeline.clips[0].id, 'clip-501'); assert.equal(current.editorTimeline.clips[0].assetId, registered.get('assets/guangxuan/image-0501.png')); assert.equal(current.editorTimeline.clips[0].editable, true);
  assert.equal(current.editorTimeline.pagination.totalInDocument, 501); assert.equal(current.editorTimeline.pagination.nextOffset, null); assert.equal(current.duration, 501);
  assert.deepEqual(current.warnings, []); assert.equal(await readFile(film, 'utf8'), original); assert.ok(png.length * 501 < 40 * 1024);
});
