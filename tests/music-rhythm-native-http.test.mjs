import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { startServer } from '../server.mjs';
const wav = (seconds, period = .5) => {
  const rate = 8000, pcm = Buffer.alloc(Math.round(seconds * rate) * 2);
  for (let i = 0; i < pcm.length / 2; i++) { const t = i / rate, rel = ((t - .1) % period + period) % period; pcm.writeInt16LE(t >= .1 && rel < .07 ? Math.round(.7 * Math.exp(-rel * 65) * Math.sin(2 * Math.PI * 900 * rel) * 32767) : 0, i * 2); }
  const bytes = Buffer.alloc(pcm.length + 44); bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(pcm.length, 40); pcm.copy(bytes, 44); return bytes;
};
test('owned Native rhythm HTTP decodes real PCM, preserves source coverage and rejects oversized or changed-cache input', { timeout: 90000 }, async t => {
  const parent = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await fs.mkdir(parent, { recursive: true });
  const folder = await fs.mkdtemp(path.join(parent, 'gx-rhythm-http-')), dataDir = path.join(folder, 'data'); let app;
  t.after(async () => { await app?.close(); if (!path.resolve(folder).startsWith(parent + path.sep)) throw Error('Test cleanup escaped its parent'); await fs.rm(folder, { recursive: true, force: true }); });
  app = await startServer({ port: 0, dataDir }); assert.notEqual(new URL(app.url).port, '4417');
  const request = async (route, body, method = body ? 'POST' : 'GET') => { const response = await fetch(app.url + route, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value; };
  const id = 'music-rhythm-http'; await request('/api/projects/' + id, { kind: 'video', title: 'Isolated music fixture', video: { timeline: [], captions: [], aspect: '16:9', resolution: '720' }, source: { text: 'synthetic PCM only' } }, 'PUT');
  const opened = await request('/api/openfilm/open', { projectId: id }), html = await (await fetch(app.url + `/openfilm/editor.html?projectId=${id}&session=${opened.sessionId}`)).text();
  const native = new URL(/id="openfilm-studio"[^>]+src="([^"]+)"/.exec(html)[1].replaceAll('&amp;', '&')), headers = { 'x-studio-key': native.searchParams.get('key') };
  const put = async (name, bytes) => { const r = await fetch(native.origin + `/api/projects/${opened.nativeProjectId}/files?path=${encodeURIComponent('assets/' + name)}`, { method: 'PUT', headers: { ...headers, 'content-type': 'audio/wav' }, body: bytes }); assert.ok(r.ok, await r.text()); };
  const get = async (name, query = '') => { const r = await fetch(native.origin + `/api/projects/${opened.nativeProjectId}/media?what=rhythm&path=${encodeURIComponent('assets/' + name)}${query}`, { headers }); return { status: r.status, body: await r.json() }; };
  const original = wav(8); await put('click.wav', original); const first = await get('click.wav'); assert.equal(first.status, 200); assert.equal(first.body.sourceVersion, crypto.createHash('sha256').update(original).digest('hex')); assert.equal(first.body.sampleRate, 22050); assert.equal(first.body.status, 'ready'); assert.ok(Math.abs(first.body.bpm - 120) < 1); assert.ok(first.body.beats.length >= 12); assert.ok(!JSON.stringify(first.body).includes(folder));
  assert.deepEqual(await get('click.wav'), first);
  const range = await get('click.wav', '&from=2&to=6'); assert.equal(range.status, 200); assert.equal(range.body.coverage.start, 2); assert.ok(Math.abs(range.body.coverage.end - 6) < .002); assert.equal(range.body.coverage.completeSource, false); assert.ok(range.body.beats.every(b => b.time >= 2 && b.time <= 6));
  const file = path.join(dataDir, 'openfilm/projects', id, 'assets/click.wav'), previous = await fs.stat(file); await fs.writeFile(file, wav(8, .75)); await fs.utimes(file, previous.atime, previous.mtime); const changed = await get('click.wav'); assert.equal(changed.status, 200); assert.notEqual(changed.body.sourceVersion, first.body.sourceVersion);
  await put('long.wav', wav(601)); assert.equal((await get('long.wav')).status, 413); const slice = await get('long.wav', '&from=5&to=13'); assert.equal(slice.status, 200); assert.equal(slice.body.coverage.completeSource, false);
  const inFlight = get('long.wav', '&from=0&to=600&fresh=1'); await new Promise(resolve => setTimeout(resolve, 100));
  const longFile = await fs.open(path.join(dataDir, 'openfilm/projects', id, 'assets/long.wav'), 'r+'); try { await longFile.write(Buffer.from([17, 0]), 0, 2, 44); } finally { await longFile.close(); }
  assert.equal((await inFlight).status, 409, 'Changed decoded source must not publish partial or stale rhythm data');
  assert.equal((await get('click.wav', '&from=4&to=2')).status, 400);
});
