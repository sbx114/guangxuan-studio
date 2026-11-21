import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { deflateSync } from 'node:zlib';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createProjectStore } from '../lib/store.mjs';
import { createNovelLibraryService } from '../lib/novel-library.mjs';

const bin = process.env.GUANGXUAN_BIN_DIR;
async function setup(t, prefix = 'gx-novel-library-') {
  const parent = await mkdtemp(path.join(os.tmpdir(), prefix)), dataDir = path.join(parent, 'data'); await mkdir(dataDir);
  const store = await createProjectStore(dataDir), videoService = { runtimeTools: () => ({ ffprobe: path.join(bin || '', 'ffprobe.exe') }) };
  let service = await createNovelLibraryService({ dataDir, store, videoService });
  t.after(async () => { await service.close(); assert.ok(path.resolve(parent).startsWith(path.resolve(os.tmpdir(), prefix))); await rm(parent, { recursive: true, force: true }); });
  return { parent, dataDir, store, get service() { return service; }, async restart() { await service.close(); service = await createNovelLibraryService({ dataDir, store, videoService }); return service; } };
}
async function picture(_parent, color) {
  const width = 240, height = 480, rgb = { red: [255, 0, 0], blue: [0, 0, 255], green: [0, 128, 0], yellow: [255, 255, 0] }[color];
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let channel = 0; channel < 3; channel++) rows[y * (width * 3 + 1) + 1 + x * 3 + channel] = rgb[channel];
  function chunk(name, data) {
    const type = Buffer.from(name), payload = Buffer.concat([type, data]); let crc = 0xffffffff;
    for (const byte of payload) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4); length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, payload, checksum]);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
async function populate(service, bytes) {
  const portrait = (await service.importBytes(bytes, { name: '平静.png', kind: 'portrait' })).asset;
  const background = (await service.importBytes(bytes, { name: '研究室.png', kind: 'background' })).asset;
  const character = (await service.saveCharacter({ id: 'my-guide', name: '若青', role: '研究生兼讲解员', tone: '短句，循序解释', personality: '耐心、严谨', color: '#789e9c', portraits: [{ id: 'calm', name: '平静', assetId: portrait.id }] })).character;
  const scene = (await service.saveBackground({ id: 'my-room', name: '我的研究室', assetId: background.id, fit: 'cover' })).background;
  return { portrait, background, character, scene, selection: { characterId: character.id, backgroundId: scene.id } };
}

test('shared novel library starts empty, keeps draft profiles, validates fields and serializes concurrent saves', async t => {
  const env = await setup(t), service = env.service;
  assert.deepEqual((await service.list()).characters, []); assert.deepEqual((await service.list()).backgrounds, []);
  const { character } = await service.saveCharacter({ name: '自定义', role: '由用户设定', tone: '自然', personality: '沉稳', portraits: [], apiKey: 'must-not-be-saved', absolutePath: 'C:/private/secret' });
  const { background } = await service.saveBackground({ name: '空场景', assetId: '' });
  assert.equal(character.ready, false); assert.equal(background.ready, false);
  await assert.rejects(service.resolveSelection({ characterId: character.id, backgroundId: background.id }), { code: 'NOVEL_LIBRARY_NOT_READY' });
  await assert.rejects(service.saveCharacter({ name: 'x', tone: 'x'.repeat(601) }), { code: 'NOVEL_LIBRARY_INVALID' });
  await assert.rejects(service.saveCharacter({ name: 'x', portraits: [{ id: 'a', name: 'a', assetId: '' }, { id: 'a', name: 'b', assetId: '' }] }), { code: 'NOVEL_LIBRARY_INVALID' });
  await assert.rejects(service.saveBackground({ name: 'x', assetId: 'missing' }), { code: 'NOVEL_LIBRARY_ASSET_MISSING' });
  await Promise.all(Array.from({ length: 10 }, (_, index) => service.saveCharacter({ id: 'guide-' + index, name: '人物' + index })));
  assert.equal((await service.list()).characters.length, 11);
  const saved = await readFile(path.join(env.dataDir, 'novel-library', 'library.json'), 'utf8');
  assert.ok(!saved.includes('must-not-be-saved')); assert.ok(!saved.includes('C:/private')); assert.ok(!saved.includes('apiKey'));
  const restarted = await env.restart(); assert.equal((await restarted.list()).characters.length, 11);
  await restarted.removeCharacter(character.id); await restarted.removeBackground(background.id);
  assert.deepEqual((await env.store.list()).projects, [], 'Virtual asset ownership must never create a hidden user project.');
});

test('profile, pose, asset and selection identifiers reject explicit non-string values without creating undeletable entries', async t => {
  const { service } = await setup(t);
  for (const id of [123, true, 0, false, null, undefined, {}, []]) {
    await assert.rejects(service.saveCharacter({ id, name: '非法人物' }), { code: 'NOVEL_LIBRARY_INVALID' });
    await assert.rejects(service.saveBackground({ id, name: '非法场景' }), { code: 'NOVEL_LIBRARY_INVALID' });
    await assert.rejects(service.saveCharacter({ name: '非法表情', portraits: [{ id, name: '表情', assetId: '' }] }), { code: 'NOVEL_LIBRARY_INVALID' });
    await assert.rejects(service.resolveSelection({ characterId: id, backgroundId: 'room' }), { code: 'NOVEL_LIBRARY_INVALID' });
    await assert.rejects(service.resolveSelection({ characterId: 'guide', backgroundId: id }), { code: 'NOVEL_LIBRARY_INVALID' });
    await assert.rejects(service.resolveSelection({ librarySelection: id, characterId: 'guide', backgroundId: 'room' }), { code: 'NOVEL_LIBRARY_INVALID' });
    if (id !== undefined) {
      await assert.rejects(service.saveCharacter({ name: '非法立绘', portraits: [{ name: '表情', assetId: id }] }), { code: 'NOVEL_LIBRARY_INVALID' });
      await assert.rejects(service.saveBackground({ name: '非法图片', assetId: id }), { code: 'NOVEL_LIBRARY_INVALID' });
    }
  }
  const empty = await service.list(); assert.deepEqual(empty.characters, []); assert.deepEqual(empty.backgrounds, []);
  const { character } = await service.saveCharacter({ id: '123', name: '合法字符串编号', portraits: [{ id: 'true', name: '字符串表情编号', assetId: '' }] });
  assert.equal(character.id, '123'); assert.equal(character.portraits[0].id, 'true');
  await service.removeCharacter('123'); assert.deepEqual((await service.list()).characters, []);
  const generated = (await service.saveCharacter({ name: '省略编号自动生成', portraits: [{ name: '自动表情编号' }] })).character;
  assert.equal(typeof generated.id, 'string'); assert.equal(typeof generated.portraits[0].id, 'string');
  await service.removeCharacter(generated.id);
});

test('shared pictures and profiles resolve across projects, update in place, survive restart, and protect references', { skip: !bin, timeout: 60000 }, async t => {
  const env = await setup(t), bytes = await picture(env.parent, 'red'), otherBytes = await picture(env.parent, 'blue');
  const populated = await populate(env.service, bytes), { selection, character, scene, portrait, background } = populated;
  for (const id of ['science-a', 'science-b']) await env.store.save(id, { kind: 'science', title: id, science: { novelConfig: { librarySelection: selection }, novel: { version: 2, librarySelection: selection, scenes: [{ actors: [{ characterId: character.id, poseId: 'calm' }], lines: [{ poseId: 'calm' }] }] } } });
  const sourceBefore = new Map(await Promise.all(['science-a', 'science-b'].map(async id => [id, await readFile(path.join(env.dataDir, 'projects', id + '.json'), 'utf8')])));
  const first = await env.service.resolveSelection(selection);
  assert.equal(first.config.characters[0].role, '研究生兼讲解员'); assert.equal(first.config.characters.length, 1); assert.equal(first.config.backgrounds.length, 1);
  assert.equal(first.assetCatalog.items.length, 2); assert.ok(first.assetCatalog.items.every(asset => asset.url.startsWith('/api/novel-library/assets/')));
  assert.deepEqual((await env.service.file(portrait.id)).bytes, bytes);
  assert.ok(!(await readdir(env.dataDir)).includes('novel-assets'), 'No project-local image copy is created.');
  await assert.rejects(env.service.removeCharacter(character.id), { code: 'NOVEL_LIBRARY_IN_USE' });
  await assert.rejects(env.service.removeBackground(scene.id), { code: 'NOVEL_LIBRARY_IN_USE' });
  await assert.rejects(env.service.removeAsset(portrait.id), { code: 'NOVEL_ASSET_IN_USE' });
  await assert.rejects(env.service.saveCharacter({ ...character, portraits: [] }), { code: 'NOVEL_LIBRARY_IN_USE' });
  await assert.rejects(env.service.saveCharacter({ ...character, portraits: [{ id: 'different', name: '重命名表情ID', assetId: portrait.id }] }), { code: 'NOVEL_LIBRARY_POSE_IN_USE' });
  await assert.rejects(env.service.saveBackground({ ...scene, assetId: '' }), { code: 'NOVEL_LIBRARY_IN_USE' });
  const replacement = (await env.service.importBytes(otherBytes, { name: '新的平静.png', kind: 'portrait' })).asset;
  await env.service.saveCharacter({ ...character, tone: '简洁亲切', portraits: [{ id: 'calm', name: '平静', assetId: replacement.id }] });
  for (const id of ['science-a', 'science-b']) {
    const project = await env.store.read(id), resolved = await env.service.resolveSelection(project.science.novel.librarySelection);
    assert.equal(resolved.config.characters[0].portraits[0].assetId, replacement.id); assert.equal(resolved.config.characters[0].portraits[0].id, 'calm');
    assert.equal(resolved.config.characters[0].tone, '简洁亲切');
    assert.equal(await readFile(path.join(env.dataDir, 'projects', id + '.json'), 'utf8'), sourceBefore.get(id), 'Profile updates do not rewrite or copy assets into projects.');
  }
  await env.service.removeAsset(portrait.id);
  const restarted = await env.restart(), resolved = await restarted.resolveSelection(selection);
  assert.deepEqual((await restarted.file(resolved.config.characters[0].portraits[0].assetId)).bytes, otherBytes);
  await assert.rejects(restarted.importBytes(Buffer.from('<svg></svg>'), { name: 'bad.svg', kind: 'portrait' }), { code: 'NOVEL_ASSET_TYPE' });
  await assert.rejects(restarted.importBytes(bytes, { name: '../secret.png', kind: 'portrait' }), { code: 'NOVEL_ASSET_NAME' });
  for (const id of ['science-a', 'science-b']) await env.store.save(id, { kind: 'science', title: id, science: {} });
  await restarted.removeCharacter(character.id); await restarted.removeBackground(scene.id); await restarted.removeAsset(replacement.id); await restarted.removeAsset(background.id);
  assert.deepEqual((await restarted.list()).assets, []);
});

test('explicit selection migration includes only referenced resources, deduplicates bytes, and never overwrites conflicting profiles', { skip: !bin, timeout: 60000 }, async t => {
  const origin = await setup(t, 'gx-novel-library-origin-'), target = await setup(t, 'gx-novel-library-target-'), bytes = await picture(origin.parent, 'green');
  const populated = await populate(origin.service, bytes);
  await origin.service.importBytes(bytes, { name: '不相关.png', kind: 'portrait' });
  const pack = await origin.service.exportSelection(populated.selection);
  assert.equal(pack.assets.length, 2); assert.equal(pack.characters.length, 1); assert.equal(pack.backgrounds.length, 1);
  assert.ok(!JSON.stringify(pack).includes(origin.parent)); assert.ok(!JSON.stringify(pack).includes('不相关'));
  await target.service.saveCharacter({ id: 'my-guide', name: '原有角色', portraits: [] });
  const imported = await target.service.importSelection(pack);
  assert.notEqual(imported.librarySelection.characterId, 'my-guide');
  assert.equal((await target.service.list()).characters.find(profile => profile.id === 'my-guide').name, '原有角色');
  const resolved = await target.service.resolveSelection(imported.librarySelection);
  assert.equal(resolved.config.characters[0].name, populated.character.name);
  assert.deepEqual((await target.service.file(resolved.config.backgrounds[0].assetId)).bytes, bytes);
  const importedAgain = await target.service.importSelection(pack);
  assert.deepEqual(importedAgain.created.assetIds, []); assert.equal((await target.service.list()).assets.length, 2, 'Importing identical bytes reuses the shared picture.');
  const invalid = structuredClone(pack); invalid.assets[0].base64 = Buffer.from('tampered').toString('base64');
  await assert.rejects(target.service.importSelection(invalid), { code: 'NOVEL_LIBRARY_PACKAGE' });
  assert.equal((await target.service.list()).assets.length, 2);
  await target.service.rollbackImport(importedAgain.created);
  await target.store.save('using-import', { kind: 'science', science: { novel: { librarySelection: imported.librarySelection } } });
  await assert.rejects(target.service.rollbackImport(imported.created), { code: 'NOVEL_LIBRARY_IN_USE' });
  await target.store.remove('using-import'); await target.service.rollbackImport(imported.created);
  assert.equal((await target.service.list()).assets.length, 0); assert.equal((await target.service.list()).characters[0].name, '原有角色');
});

test('shared library HTTP API serves validated images, resolves profiles, and cancels stalled upload before EOF', { skip: !bin, timeout: 60000 }, async t => {
  const env = await setup(t), controller = new AbortController();
  const server = http.createServer((req, res) => {
    env.service.handler(req, res, new URL(req.url, 'http://localhost'), { signal: controller.signal }).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }).catch(error => { if (!res.destroyed && !res.writableEnded) { res.writeHead(error.status || 500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: error.code })); } });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const url = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const bytes = await picture(env.parent, 'yellow');
  const upload = await fetch(url + '/api/novel-library/assets/upload', { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent('立绘.png'), 'x-asset-kind': 'portrait' }, body: bytes });
  assert.equal(upload.status, 201); const { asset } = await upload.json();
  const get = await fetch(url + asset.url); assert.equal(get.status, 200); assert.deepEqual(Buffer.from(await get.arrayBuffer()), bytes);
  const head = await fetch(url + asset.url, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(Number(head.headers.get('content-length')), bytes.length); assert.equal((await head.arrayBuffer()).byteLength, 0);
  const created = await fetch(url + '/api/novel-library/characters', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '由我定义', portraits: [{ id: 'normal', name: '平静', assetId: asset.id }] }) });
  assert.equal(created.status, 200); assert.equal((await created.json()).character.ready, true);
  let closed = false;
  const request = http.request(url + '/api/novel-library/assets/upload', { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'content-length': 8192, 'x-file-name': encodeURIComponent('慢流.png'), 'x-asset-kind': 'portrait' } });
  request.on('error', () => { closed = true; }); request.on('close', () => { closed = true; }); request.on('response', response => response.resume()); request.flushHeaders(); request.write(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  t.after(() => request.destroy());
  await new Promise(resolve => setTimeout(resolve, 50)); const start = Date.now(); controller.abort();
  while (!closed && Date.now() - start < 2000) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(closed, true, 'Cancellation closes a stalled upload without waiting for another chunk or EOF.');
  assert.ok(Date.now() - start < 2000); assert.equal((await env.service.list()).assets.length, 1);
  const subsequent = await env.service.importBytes(bytes, { name: '取消后仍可使用.png', kind: 'background' }); assert.equal(subsequent.asset.kind, 'background');
});

test('corrupt shared profile records are preserved and do not silently reset the library', async t => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'gx-novel-library-corrupt-')), dataDir = path.join(parent, 'data');
  await mkdir(path.join(dataDir, 'novel-library'), { recursive: true }); const filename = path.join(dataDir, 'novel-library', 'library.json'), original = '{broken'; await writeFile(filename, original);
  t.after(async () => { assert.ok(path.resolve(parent).startsWith(path.resolve(os.tmpdir(), 'gx-novel-library-corrupt-'))); await rm(parent, { recursive: true, force: true }); });
  const store = await createProjectStore(dataDir);
  await assert.rejects(createNovelLibraryService({ dataDir, store }), { code: 'NOVEL_LIBRARY_READ' }); assert.equal(await readFile(filename, 'utf8'), original);
});
