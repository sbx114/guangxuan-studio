import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createNativeProjectCapabilities, NATIVE_PROJECT_CATALOG, NATIVE_PROJECT_READ_SCHEMA, NATIVE_PROJECT_EDIT_SCHEMA } from '../lib/native-project-capabilities.mjs';
import { readProjectFilm } from '../integrations/openfilm/packages/openfilm/studio/server/film.mjs';
import { readMarkers, writeMarkers } from '../integrations/openfilm/packages/openfilm/studio/server/markers.mjs';
import { readPage, writePage } from '../integrations/openfilm/packages/openfilm/studio/server/page-text.mjs';
import { filmHtml } from '../integrations/openfilm/packages/openfilm/src/film-doc.mjs';
import { canvasRoute, readCanvas, writeCanvas } from '../integrations/openfilm/packages/openfilm/studio/server/canvas.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), script = '<script>window.film={duration:3,frame(t){}};</script>';
const original = '<!doctype html><html><head><style>.x{color:#abc}</style></head><body><main id="hero" style="color:#abc"><span id="label">Old</span><svg><defs><clipPath id="mask"><rect width="10"/></clipPath></defs><rect clip-path="url(#mask)" fill="#abc"/></svg></main><p id="footer">Footer</p>' + script + '</body></html>';
async function fixture(t) {
  const parent = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'gx-native-project-')), projectRoot = path.join(directory, 'owned'); await mkdir(path.join(projectRoot, 'pages'), { recursive: true }); await mkdir(path.join(projectRoot, 'assets'), { recursive: true });
  t.after(async () => { assert.equal(path.dirname(directory), parent); assert.ok(path.basename(directory).startsWith('gx-native-project-')); await rm(directory, { recursive: true, force: true }); });
  const page = path.join(projectRoot, 'pages', 'scene.html'), film = path.join(projectRoot, 'film.html'); await writeFile(page, original); await writeFile(path.join(projectRoot, 'assets', 'bg.png'), 'owned image');
  const filmValue = { stage: { w: 320, h: 180 }, tracks: [{ clips: [{ id: 'hero-clip', src: 'pages/scene.html', at: 0, time: [0, 3], size: { w: 320, h: 180 } }] }] }; await writeFile(film, filmHtml(filmValue));
  const route = '/api/projects/native-fixture';
  const api = async (url, body, method = body === undefined ? 'GET' : 'POST') => {
    if (url === route) return readProjectFilm(projectRoot);
    if (url === route + '/markers') return { markers: method === 'PUT' ? await writeMarkers(projectRoot, body.markers) : await readMarkers(projectRoot) };
    if (url.startsWith(route + '/page?')) return readPage(projectRoot, new URL(url, 'http://fixture').searchParams.get('path'));
    if (url === route + '/page') return writePage(projectRoot, body.path, body.text, body.expect, { undo: body.undo });
    if (url.startsWith(route + '/canvases/') && method === 'DELETE') { let result; await canvasRoute({ method }, { writeHead() {}, end(text) { result = JSON.parse(text); } }, projectRoot, url.slice(route.length + 1)); return result; }
    throw new Error('Unimplemented fixture API ' + url);
  };
  const service = () => createNativeProjectCapabilities({ projectRoot, nativeProjectId: 'native-fixture', route, api });
  const current = service(), read = args => current.read({ section: 'page', args: { path: 'pages/scene.html', ...args } });
  async function edit(action, args = {}, options = {}) { const before = await read(); return current.edit({ section: 'page', action, expectedRevision: before.revision, args: { path: 'pages/scene.html', target: [0], ...args }, ...options }); }
  const locate = async id => (await read({ query: id, limit: 200 })).data.tree.find(item => item.id === id).path;
  return { directory, projectRoot, page, film, filmValue, current, service, read, edit, locate };
}

test('deployed HTML parser is a type-only conversion of the actual UI parser with its MIT attribution', async () => {
  const source = await readFile(path.join(root, 'integrations/openfilm/packages/openfilm/studio/ui/src/lib/html-source.ts'), 'utf8'), derived = await readFile(path.join(root, 'lib/native-html-source.mjs'), 'utf8');
  assert.ok(derived.includes(createHash('sha256').update(source).digest('hex'))); assert.ok(derived.includes('Copyright (c) 2026 OpenFilm contributors')); assert.ok(derived.endsWith(stripTypeScriptTypes(source, { mode: 'strip' })));
  assert.equal(NATIVE_PROJECT_CATALOG.sections.length, 4); assert.equal(NATIVE_PROJECT_READ_SCHEMA.oneOf.length, 4); assert.equal(NATIVE_PROJECT_EDIT_SCHEMA.oneOf.length, 19);
});

test('page discovery returns real project-relative sources and tree/source reads support bounded pagination', async t => {
  const f = await fixture(t), discovered = await f.current.read({ section: 'page' });
  assert.deepEqual(discovered.data.pages.map(item => [item.path, item.clipIds]), [['pages/scene.html', ['hero-clip']]]);
  const read = await f.read({ offset: 1, limit: 2, includeSource: true, sourceOffset: 10, sourceLimit: 20 });
  assert.equal(read.data.tree.length, 2); assert.equal(read.data.offset, 1); assert.equal(read.data.truncated, true); assert.equal(read.data.source, original.slice(10, 30)); assert.equal(read.data.sourceLength, original.length);
  assert.deepEqual((await f.read({ query: 'label' })).data.tree.map(item => item.id), ['label']);
});

test('page text, all ordinary CSS properties, attributes and layout edit the real page while preserving scripts', async t => {
  const f = await fixture(t);
  await f.edit('text', { target: [0, 0], text: 'New <b> text' });
  await f.edit('style', { style: { backgroundImage: 'url("../assets/bg.png")', display: 'grid', gridTemplateColumns: '1fr 2fr', padding: 12, '--accent': '#efc342' } });
  await f.edit('attr', { attributes: { class: 'designed', 'aria-label': '主图层' } });
  const result = await f.edit('layout', { x: 12, y: 8, width: 240, height: 120, rotation: 5, opacity: .8 });
  const text = await readFile(f.page, 'utf8'); assert.ok(text.includes('New &lt;b&gt; text')); assert.ok(text.includes('grid-template-columns:1fr 2fr')); assert.ok(text.includes('left:12px')); assert.ok(text.includes('opacity:0.8')); assert.ok(text.includes(script)); assert.ok(result.undo.id); assert.match(result.filmRevision, /^[a-f0-9]{16}$/);
});

test('safe style edits preserve pre-existing remote resource CSS without creating new remote requests', async t => {
  const f = await fixture(t), remote = original.replace('color:#abc', 'color:#abc;background:url(https://example.invalid/existing.png)'); await writeFile(f.page, remote);
  await f.edit('style', { style: { color: '#eeddbb' } }); const edited = await readFile(f.page, 'utf8'); assert.ok(edited.includes('url(https://example.invalid/existing.png)')); assert.ok(edited.includes('color:#eeddbb')); assert.ok(edited.includes(script));
});

test('editing a page longer than a source preview preserves all trailing code and content', async t => {
  const f = await fixture(t), large = original.replace('</main>', '<!--' + 'layout data '.repeat(1500) + '--></main>'); await writeFile(f.page, large);
  const preview = await f.read({ includeSource: true }); assert.equal(preview.data.sourceTruncated, true); assert.equal(preview.data.source.length, 8000);
  await f.edit('text', { target: [0, 0], text: 'Edited title' }); const edited = await readFile(f.page, 'utf8'); assert.ok(edited.includes(script)); assert.ok(edited.includes('layout data '.repeat(1500))); assert.ok(edited.includes('id="footer"'));
});

test('page insert/move/remove and duplicate preserve unrelated content and remap SVG references', async t => {
  const f = await fixture(t);
  await f.edit('insert', { target: [], position: 'append', node: { tag: 'section', attributes: { id: 'new' }, children: [{ tag: 'h2', text: 'Added' }] } });
  await f.edit('move', { target: await f.locate('new'), to: await f.locate('footer'), position: 'before' });
  await f.edit('remove', { target: await f.locate('footer') });
  await f.edit('duplicate', { target: await f.locate('hero'), idSuffix: '-copy' });
  const source = await readFile(f.page, 'utf8'); assert.ok(!source.includes('id="footer"')); assert.ok(source.includes('id="hero-copy"')); assert.ok(source.includes('id="mask-copy"')); assert.ok(source.includes('url(#mask-copy)')); assert.ok(source.includes('fill="#abc"')); assert.ok(source.includes(script));
});

test('page CAS and trusted film CAS reject concurrent edits; undo persists across helper recreation', async t => {
  const f = await fixture(t), before = await f.read(), changed = await f.edit('text', { target: [0, 0], text: 'Undo this' });
  await assert.rejects(f.current.edit({ section: 'page', action: 'text', expectedRevision: before.revision, args: { path: 'pages/scene.html', target: [0, 0], text: 'stale' } }), { code: 'NATIVE_PROJECT_REVISION_CONFLICT', status: 409 });
  await f.service().undo({ undoId: changed.undo.id }); assert.equal(await readFile(f.page, 'utf8'), original);
  const current = await f.read(); await assert.rejects(f.current.edit({ section: 'page', action: 'text', expectedRevision: current.revision, expectedFilmRevision: '0'.repeat(16), args: { path: 'pages/scene.html', target: [0, 0], text: 'wrong film' } }), { code: 'OPENFILM_REVISION_CONFLICT' });
  const next = await f.edit('text', { target: [0, 0], text: 'AI edit' }); await writeFile(f.page, original + '\n<!-- newer human edit -->'); await assert.rejects(f.service().undo({ undoId: next.undo.id }), { code: 'NATIVE_PROJECT_UNDO_CONFLICT' });
});

test('source sharing, locked tracks and explicit ranges are honored without broadening the edit', async t => {
  const f = await fixture(t); f.filmValue.tracks[0].locked = true; await writeFile(f.film, filmHtml(f.filmValue));
  await assert.rejects(f.edit('text', { target: [0, 0], text: 'locked' }), { code: 'NATIVE_PROJECT_SHARED_PAGE' });
  delete f.filmValue.tracks[0].locked; f.filmValue.tracks[0].clips.push({ id: 'outside-clip', src: 'pages/scene.html', at: 5, time: [0, 3], size: { w: 320, h: 180 } }); await writeFile(f.film, filmHtml(f.filmValue));
  await assert.rejects(f.edit('text', { target: [0, 0], text: 'outside' }, { editScope: { placement: { mode: 'range', start: 0, end: 3 } } }), { code: 'NATIVE_PROJECT_SHARED_PAGE' });
  assert.equal(await readFile(f.page, 'utf8'), original);
});

test('declarative DOM edits reject executable/network injections and project path escapes', async t => {
  const f = await fixture(t);
  for (const [action, args] of [['style', { style: { background: 'url(https://example.invalid/private)' } }], ['style', { style: { background: 'u\\72l(http://example.invalid)' } }], ['attr', { attributes: { onclick: 'alert(1)' } }], ['attr', { attributes: { src: 'file:///C:/private' } }], ['insert', { position: 'append', node: { tag: 'script', text: 'fetch("https://example.invalid")' } }], ['insert', { position: 'append', node: { tag: 'img', attributes: { src: '../../../outside.png' } } }], ['text', { target: [], text: 'would remove script' }]]) await assert.rejects(f.edit(action, args));
  await assert.rejects(f.current.read({ section: 'page', args: { path: '../outside.html' } }));
  const outside = path.join(f.directory, 'outside'); await mkdir(outside); await writeFile(path.join(outside, 'secret.html'), 'outside'); await symlink(outside, path.join(f.projectRoot, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.current.read({ section: 'page', args: { path: 'linked/secret.html' } }), { code: 'NATIVE_PROJECT_PATH' }); assert.equal(await readFile(f.page, 'utf8'), original);
});

test('marker add/update/remove/replace have actual revisions and durable undo', async t => {
  const f = await fixture(t);
  async function change(action, args) { const state = await f.current.read({ section: 'markers' }); return f.current.edit({ section: 'markers', action, expectedRevision: state.revision, args }); }
  const added = await change('add', { marker: { id: 'mark-one', t: 1, name: '主动作落定', color: 'green' } }); assert.equal(added.data.markers[0].name, '主动作落定');
  await change('update', { id: 'mark-one', patch: { t: 2, color: 'orange' } }); const removed = await change('remove', { ids: ['mark-one'] }); assert.equal(removed.data.markers.length, 0);
  await f.service().undo({ undoId: removed.undo.id }); assert.equal((await readMarkers(f.projectRoot))[0].t, 2);
  const state = await f.current.read({ section: 'markers' }); await writeMarkers(f.projectRoot, [{ id: 'human', t: 0, color: 'blue' }]);
  await assert.rejects(f.current.edit({ section: 'markers', action: 'replace', expectedRevision: state.revision, args: { markers: [] } }), { code: 'NATIVE_PROJECT_REVISION_CONFLICT' });
  const before = await f.current.read({ section: 'markers' }); await assert.rejects(f.current.edit({ section: 'markers', action: 'add', expectedRevision: before.revision, editScope: { placement: { mode: 'range', start: 0, end: 1 } }, args: { marker: { t: 2 } } }), { code: 'NATIVE_PROJECT_SCOPE' });
});

test('canvas native ops arrange, group, wire and version current-project material with independent CAS and durable undo', async t => {
  const f = await fixture(t), initial = await f.current.read({ section: 'canvas' }), filmBefore = initial.filmRevision;
  const result = await f.current.edit({ section: 'canvas', action: 'apply', expectedRevision: initial.revision, args: { ops: [{ op: 'add', kind: 'note', id: 'note', text: '画板文字', x: 0, y: 0 }, { op: 'add', kind: 'file', id: 'media', path: 'assets/bg.png', inputs: ['note'] }, { op: 'add', kind: 'group', id: 'group', name: '镜头一', around: ['note', 'media'], color: 'blue' }, { op: 'add', kind: 'image', id: 'make', prompt: '尚未调用生成', opts: { ratio: '16:9', transparent: true }, inputs: ['media'] }, { op: 'version', id: 'make', path: 'assets/bg.png' }] } });
  assert.equal(result.filmRevision, filmBefore); assert.notEqual(result.revision, initial.revision); assert.equal(result.data.total, 4); assert.equal(result.data.edgeTotal, 2);
  const canvas = await readCanvas(f.projectRoot); assert.equal(canvas.nodes.find(item => item.id === 'note').parent, 'group'); assert.equal(canvas.nodes.find(item => item.id === 'make').path, 'assets/bg.png');
  await assert.rejects(f.current.edit({ section: 'canvas', action: 'apply', expectedRevision: initial.revision, args: { ops: [{ op: 'set', id: 'note', text: 'stale' }] } }), { code: 'NATIVE_PROJECT_REVISION_CONFLICT' });
  await f.service().undo({ undoId: result.undo.id }); assert.deepEqual((await f.current.read({ section: 'canvas' })).data.canvas.nodes, []);
});

test('canvas board create/rename/duplicate/remove and main promotion restore the exact prior boards on undo', async t => {
  const f = await fixture(t), previousTrash = process.env.OPENFILM_TRASH_DIR; process.env.OPENFILM_TRASH_DIR = path.join(f.directory, 'trash');
  t.after(() => { if (previousTrash === undefined) delete process.env.OPENFILM_TRASH_DIR; else process.env.OPENFILM_TRASH_DIR = previousTrash; });
  async function edit(action, args = {}) { const before = await f.current.read({ section: 'canvas' }); return f.current.edit({ section: 'canvas', action, expectedRevision: before.revision, args }); }
  await edit('apply', { ops: [{ op: 'add', kind: 'note', id: 'main-note', text: 'main' }] });
  const created = await edit('create', { name: 'Second', from: 'main' }), id = created.data.boardId; assert.notEqual(id, 'main');
  await edit('rename', { board: id, name: 'Renamed' }); assert.equal((await readCanvas(f.projectRoot, id)).name, 'Renamed');
  const removed = await edit('remove', { board: 'main' }); assert.equal(removed.data.boards.length, 1); assert.equal((await readCanvas(f.projectRoot)).name, 'Renamed');
  await f.service().undo({ undoId: removed.undo.id }); const restored = await f.current.read({ section: 'canvas' }); assert.equal(restored.data.boards.length, 2); assert.equal((await readCanvas(f.projectRoot)).nodes[0].text, 'main'); assert.equal((await readCanvas(f.projectRoot, id)).name, 'Renamed');
});

test('canvas validates owned resources, exposes long notes by chunks and refuses metadata-only concurrent overwrites', async t => {
  const f = await fixture(t); await writeCanvas(f.projectRoot, { nodes: [{ id: 'long', text: 'x'.repeat(2500), x: 0, y: 0 }], edges: [] });
  const state = await f.current.read({ section: 'canvas', args: { query: 'long', textOffset: 1000, textLimit: 700 } }); assert.equal(state.data.canvas.nodes[0].text.length, 700); assert.equal(state.data.canvas.nodes[0].textTruncated, true);
  const edit = args => f.current.edit({ section: 'canvas', action: 'apply', expectedRevision: state.revision, args: { ops: args } });
  await assert.rejects(edit([{ op: 'add', kind: 'file', path: 'C:/outside.png' }]), { code: 'NATIVE_PROJECT_RESOURCE' });
  await assert.rejects(edit([{ op: 'add', kind: 'image', opts: { markup: '../outside.html' } }]), { code: 'NATIVE_PROJECT_RESOURCE' });
  await writeCanvas(f.projectRoot, { nodes: [{ id: 'long', text: 'human edit', x: 0, y: 0 }], edges: [] });
  await assert.rejects(edit([{ op: 'remove', id: 'long' }]), { code: 'NATIVE_PROJECT_REVISION_CONFLICT' }); assert.equal((await readCanvas(f.projectRoot)).nodes[0].text, 'human edit');
});
