import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { startServer } from '../server.mjs';
import { createProjectStore } from '../lib/store.mjs';
import { musicCutRequestSignature } from '../lib/music-cut-service.mjs';

async function fixture(t, pending = false) {
  const base = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(base, { recursive: true });
  const dataDir = await mkdtemp(path.join(base, 'gx-music-service-http-')), store = await createProjectStore(dataDir);
  const project = await store.save('api-video', { kind: 'video', title: '接口隔离工程', source: { text: '' }, video: { timeline: [] } }); await store.settle();
  const request = { projectId: project.id, requestId: randomUUID(), musicAssetId: 'never-resolve-native' };
  if (pending) { await mkdir(path.join(dataDir, 'music-cuts')); await writeFile(path.join(dataDir, 'music-cuts/operations.json'), JSON.stringify({ version: 1, operations: [{ id: request.requestId, projectId: project.id, ownerCreatedAt: project.createdAt, signature: musicCutRequestSignature(request), status: 'pending' }] })); }
  const app = await startServer({ dataDir, port: 0 }); assert.notEqual(Number(new URL(app.url).port), 4417);
  t.after(async () => { await app.close(); assert.equal(path.dirname(dataDir), base); await rm(dataDir, { recursive: true, force: true }); });
  const call = async (route, body) => { const response = await fetch(app.url + route, { method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }); return { status: response.status, body: await response.json() }; };
  return { dataDir, call, project, request };
}

test('actual application HTTP music routes reject external beat records, path-only authority and missing owners before native work', { timeout: 20000 }, async t => {
  const fx = await fixture(t);
  const invalidBeats = await fx.call('/api/projects/api-video/music-cut', { musicAssetId: 'never-resolve-native', requestId: randomUUID(), beats: [{ time: 1 }] });
  assert.equal(invalidBeats.status, 400); assert.equal(invalidBeats.body.code, 'MUSIC_CUT_INPUT');
  const pathOnly = await fx.call('/api/projects/api-video/music-rhythm', { sourcePath: 'C:/not-an-authority.wav' });
  assert.equal(pathOnly.status, 400); assert.equal(pathOnly.body.code, 'MUSIC_CUT_SOURCE');
  const missing = await fx.call('/api/projects/missing-video/music-cut', { musicAssetId: 'never-resolve-native' }); assert.equal(missing.status, 404);
  const current = await fx.call('/api/projects/api-video'); assert.deepEqual(current.body.project.video.timeline, []);
});

test('actual HTTP discovers durable unknown music intent and refuses replay without resolving the fake native source', { timeout: 20000 }, async t => {
  const fx = await fixture(t, true), body = { requestId: fx.request.requestId, musicAssetId: fx.request.musicAssetId };
  const prior = await readFile(path.join(fx.dataDir, 'music-cuts/operations.json'), 'utf8');
  const status = await fx.call('/api/projects/api-video/music-cut/' + fx.request.requestId); assert.equal(status.status, 200); assert.equal(status.body.status, 'pending');
  const replay = await fx.call('/api/projects/api-video/music-cut', body); assert.equal(replay.status, 409); assert.equal(replay.body.code, 'MUSIC_CUT_UNCONFIRMED');
  assert.equal(await readFile(path.join(fx.dataDir, 'music-cuts/operations.json'), 'utf8'), prior);
  assert.deepEqual((await fx.call('/api/projects/api-video')).body.project.video.timeline, []);
});
