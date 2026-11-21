import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { deflateSync, crc32 } from 'node:zlib';
import { startServer } from '../server.mjs';
import { validateCoverPng, MAX_COVER_BYTES } from '../lib/project-covers.mjs';
import { rhineCommand, publicProjectSummary } from '../public/rhine-host.js';

function pngChunk(type, bytes) {
  const chunk = Buffer.alloc(bytes.length + 12); chunk.writeUInt32BE(bytes.length, 0); chunk.write(type, 4); bytes.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + bytes.length)), 8 + bytes.length); return chunk;
}
function fixturePng(width = 4, height = 3) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc((width * 4 + 1) * height, 180);
  for (let row = 0; row < height; row++) pixels[row * (width * 4 + 1)] = 0;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(pixels)), pngChunk('IEND', Buffer.alloc(0))]);
}
async function temporaryData(t, beforeRemove = async () => {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'guangxuan-covers-test-'));
  t.after(async () => { const resolved = path.resolve(directory); if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('guangxuan-covers-test-')) throw new Error('Unsafe cleanup target'); await beforeRemove(); await rm(resolved, { recursive: true, force: true }); });
  return directory;
}

test('cover decoder validates complete image structure, checksums and pixel bounds', () => {
  const bytes = fixturePng();
  assert.equal(validateCoverPng(bytes).width, 4);
  assert.equal(validateCoverPng(bytes).height, 3);
  const corrupt = Buffer.from(bytes); corrupt[corrupt.length - 1] ^= 1;
  for (const invalid of [Buffer.from('<svg></svg>'), bytes.subarray(0, -12), corrupt, Buffer.concat([bytes, Buffer.from('extra')]), fixturePng(2049, 1), Buffer.alloc(MAX_COVER_BYTES + 1)]) {
    assert.throws(() => validateCoverPng(invalid), error => error.code === 'INVALID_COVER_IMAGE');
  }
});

test('custom cover upload, project binding, restart and stale autosave retain the real local image', async t => {
  let app;
  const dataDir = await temporaryData(t, () => app?.close()); app = await startServer({ dataDir, port: 0 });
  async function json(route, method = 'GET', body) {
    const response = await fetch(app.url + route, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, value: await response.json() };
  }
  const created = await json('/api/projects/custom-cover', 'PUT', { title: '自定义封面', kind: 'writing', outputs: { article: { body: '原稿' } } });
  const bytes = fixturePng();
  const uploaded = await fetch(app.url + '/api/project-covers', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: bytes });
  assert.equal(uploaded.status, 201); const asset = await uploaded.json();
  assert.match(asset.coverAssetId, /^[a-f0-9-]{36}$/); assert.equal(asset.coverUrl, '/api/project-covers/' + asset.coverAssetId);
  const patched = await json('/api/projects/custom-cover', 'PATCH', { cover: 'custom', coverAssetId: asset.coverAssetId });
  assert.equal(patched.status, 200); assert.equal(patched.value.project.cover, 'custom');
  const old = created.value.project; old.outputs.article.body = '仍可自动保存的新稿';
  await json('/api/projects/custom-cover', 'PUT', old);
  assert.equal((await json('/api/projects/custom-cover')).value.project.coverAssetId, asset.coverAssetId);
  for (const body of [{ cover: 'custom', coverAssetId: '' }, { coverAssetId: '../outside' }, { coverAssetId: '00000000-0000-0000-0000-000000000000' }]) {
    assert.ok((await json('/api/projects/custom-cover', 'PATCH', body)).status >= 400);
  }
  const invalid = await fetch(app.url + '/api/project-covers', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: Buffer.from('not an image') });
  assert.equal(invalid.status, 415); await invalid.arrayBuffer();
  assert.equal((await json('/api/projects/custom-cover')).value.project.coverAssetId, asset.coverAssetId);
  await app.close(); app = await startServer({ dataDir, port: 0 });
  const image = await fetch(app.url + asset.coverUrl); assert.equal(image.status, 200); assert.equal(image.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), bytes);
  const summary = (await json('/api/projects/summary')).value.projects[0];
  assert.equal(summary.cover, 'custom'); assert.equal(summary.coverUrl, asset.coverUrl); assert.ok(JSON.stringify(summary).length < 1000);
  await json('/api/projects/custom-cover', 'PATCH', { cover: 'classic' });
  assert.equal((await json('/api/projects/custom-cover')).value.project.coverAssetId, asset.coverAssetId);
  await json('/api/projects/custom-cover', 'PATCH', { cover: 'custom' });
  assert.equal((await json('/api/projects/custom-cover')).value.project.cover, 'custom');
});

test('public bridge metadata round-trips through HTTP and shared cover assets remain project-specific', async t => {
  let app;
  const dataDir = await temporaryData(t, () => app?.close()); app = await startServer({ dataDir, port: 0 });
  const frame = {};
  async function json(route, method = 'GET', body) {
    const response = await fetch(app.url + route, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, value: await response.json() };
  }
  async function upload(bytes) {
    const response = await fetch(app.url + '/api/project-covers', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: bytes });
    assert.equal(response.status, 201); return response.json();
  }
  const first = await upload(fixturePng()), second = await upload(fixturePng(8, 6));
  const initial = await json('/api/projects/bridge-a', 'PUT', { title: '项目甲', kind: 'writing', outputs: { article: { body: '旧版本文字' } } });
  const command = rhineCommand({ type: 'guangxuan:update-project', projectId: 'bridge-a', requestId: 'request-cover-a', title: '上传后标题', description: '仅修改封面信息', cover: 'custom', coverAssetId: first.coverAssetId, coverUrl: 'https://outside.invalid/should-never-load.png' }, app.url, frame, app.url, frame);
  assert.equal(command.error, undefined); assert.equal('coverUrl' in command, false);
  const patch = await json('/api/projects/bridge-a', 'PATCH', { title: command.title, description: command.description, cover: command.cover, coverAssetId: command.coverAssetId });
  assert.equal(patch.status, 200);
  const projected = publicProjectSummary({ ...patch.value.project, coverUrl: 'https://outside.invalid/injected.png' });
  assert.equal(projected.coverUrl, first.coverUrl);
  assert.equal(projected.coverAssetId, first.coverAssetId);
  assert.equal('outputs' in projected, false);
  const old = initial.value.project; old.outputs.article.body = '旧编辑器延迟发送的新内容';
  assert.equal((await json('/api/projects/bridge-a', 'PUT', old)).status, 200);
  const persisted = (await json('/api/projects/bridge-a')).value.project;
  assert.equal(persisted.title, command.title); assert.equal(persisted.coverAssetId, first.coverAssetId);
  assert.equal(persisted.outputs.article.body, '旧编辑器延迟发送的新内容');
  // A local copied project may refer to the same immutable image without uploading again.
  const copied = await json('/api/projects/bridge-b', 'PUT', { ...persisted, id: 'bridge-b', title: '继承封面的项目乙' });
  assert.equal(copied.status, 200); assert.equal(copied.value.project.coverAssetId, first.coverAssetId);
  await json('/api/projects/bridge-a', 'PATCH', { cover: 'custom', coverAssetId: second.coverAssetId });
  assert.equal((await json('/api/projects/bridge-b')).value.project.coverAssetId, first.coverAssetId);
  const beforeInvalid = (await json('/api/projects/bridge-a')).value.project;
  const invalidAsset = await json('/api/projects/bridge-a', 'PATCH', { cover: 'custom', coverAssetId: '11111111-1111-1111-1111-111111111111' });
  assert.equal(invalidAsset.status, 404); assert.deepEqual((await json('/api/projects/bridge-a')).value.project, beforeInvalid);
  assert.ok(rhineCommand({ ...command, type: 'guangxuan:update-project', coverAssetId: '../outside' }, app.url, frame, app.url, frame).error);
  const summarized = (await json('/api/projects/summary')).value.projects;
  assert.equal(summarized.find(project => project.id === 'bridge-a').coverUrl, second.coverUrl);
  assert.equal(summarized.find(project => project.id === 'bridge-b').coverUrl, first.coverUrl);
  await json('/api/projects/bridge-a', 'DELETE');
  const read = await fetch(app.url + first.coverUrl); assert.equal(read.status, 200); assert.deepEqual(Buffer.from(await read.arrayBuffer()), fixturePng());
});

test('cover HTTP endpoint rejects wrong media, oversized upload and foreign origins without binding data', async t => {
  let app;
  const dataDir = await temporaryData(t, () => app?.close()); app = await startServer({ dataDir, port: 0 });
  const wrongType = await fetch(app.url + '/api/project-covers', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: fixturePng() });
  assert.equal(wrongType.status, 415); await wrongType.arrayBuffer();
  const foreign = await fetch(app.url + '/api/project-covers', { method: 'POST', headers: { 'Content-Type': 'image/png', Origin: 'https://outside.invalid' }, body: fixturePng() });
  assert.equal(foreign.status, 403); await foreign.arrayBuffer();
  const oversized = await fetch(app.url + '/api/project-covers', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: Buffer.alloc(MAX_COVER_BYTES + 1) });
  assert.equal(oversized.status, 413); await oversized.arrayBuffer();
  const missing = await fetch(app.url + '/api/project-covers/11111111-1111-1111-1111-111111111111');
  assert.equal(missing.status, 404); await missing.arrayBuffer();
  const data = await fetch(app.url + '/api/projects/summary'); assert.deepEqual((await data.json()).projects, []);
});
