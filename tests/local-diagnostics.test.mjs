import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createLocalDiagnostics } from '../lib/local-diagnostics.mjs';
import { startServer } from '../server.mjs';

const secret = 'fixture-diagnostics-key';
async function fixture(t) {
  const parent = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'gx-local-diagnostics-')), dataDir = path.join(directory, 'data'), diagnostics = path.join(dataDir, 'diagnostics');
  await mkdir(dataDir);
  t.after(async () => { assert.equal(path.dirname(directory), parent); assert.ok(path.basename(directory).startsWith('gx-local-diagnostics-')); await rm(directory, { recursive: true, force: true }); });
  const log = path.join(diagnostics, 'errors.ndjson');
  return { directory, dataDir, diagnostics, log, records: async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) };
}
const failure = () => Object.assign(new Error(`Unexpected ${secret}; file "C:/Users/Fixture Private/project.tsx"; Bearer fixture-bearer-token; apiKey=another-fixture-secret; https://example.invalid/private?token=hidden`), { requestBody: 'HTTP-body-must-not-be-logged', modelReply: 'model-reply-must-not-be-logged' });

test('diagnostic receipts redact secrets, local paths and addresses while retaining only safe error metadata', async t => {
  const f = await fixture(t), diagnostics = await createLocalDiagnostics({ dataDir: f.dataDir, sensitiveStrings: () => [secret] });
  t.after(() => diagnostics.close());
  const receipt = await diagnostics.capture(failure(), { method: 'POST', route: `/api/test/${secret}?private-query=must-not-be-logged`, body: 'HTTP-body-must-not-be-logged', response: 'model-reply-must-not-be-logged' });
  await diagnostics.close(); const [record] = await f.records(), text = JSON.stringify(record);
  assert.equal(record.id, receipt.id); assert.match(record.id, /^[a-f0-9-]{36}$/);
  assert.deepEqual(Object.keys(record).sort(), ['at', 'id', 'message', 'method', 'name', 'route', 'stack']);
  for (const value of [secret, 'Fixture Private', 'Private/project.tsx', 'fixture-bearer-token', 'another-fixture-secret', 'example.invalid', 'private-query', 'HTTP-body-must-not-be-logged', 'model-reply-must-not-be-logged']) assert.ok(!text.includes(value), value);
  assert.ok(text.includes('[密钥已隐藏]')); assert.equal(record.method, 'POST');
});

test('close drains queued writes and a new logger appends after restart', async t => {
  const f = await fixture(t), first = await createLocalDiagnostics({ dataDir: f.dataDir });
  const writes = Array.from({ length: 20 }, (_, index) => first.capture(new TypeError('queued-' + index), { method: 'POST', route: '/api/test' }));
  await first.close(); const receipts = await Promise.all(writes), before = await f.records();
  assert.equal(before.length, 20); assert.deepEqual(before.map(record => record.id), receipts.map(receipt => receipt.id));
  const second = await createLocalDiagnostics({ dataDir: f.dataDir }); await second.capture(new Error('after-restart')); await second.close();
  const after = await f.records(); assert.equal(after.length, 21); assert.deepEqual(after.slice(0, 20), before);
});

test('large diagnostic logs rotate to one previous local file without touching unrelated data', async t => {
  const f = await fixture(t), logger = await createLocalDiagnostics({ dataDir: f.dataDir }), old = 'retained-local-history\n' + 'x'.repeat(2 * 1024 * 1024);
  const untouched = path.join(f.diagnostics, 'keep.txt'); await writeFile(untouched, 'keep'); await writeFile(f.log, old);
  await logger.capture(new Error('after-rotation')); await logger.close();
  assert.equal(await readFile(path.join(f.diagnostics, 'errors.previous.ndjson'), 'utf8'), old);
  assert.equal((await f.records())[0].message, 'after-rotation'); assert.equal(await readFile(untouched, 'utf8'), 'keep');
});

test('an existing diagnostics directory junction is refused before any external file is written', async t => {
  const f = await fixture(t), outside = path.join(f.directory, 'outside'); await mkdir(outside);
  const externalLog = path.join(outside, 'errors.ndjson'); await writeFile(externalLog, 'external-sentinel');
  await symlink(outside, f.diagnostics, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createLocalDiagnostics({ dataDir: f.dataDir }));
  assert.equal(await readFile(externalLog, 'utf8'), 'external-sentinel');
});

test('replacing the diagnostics directory with a junction after startup cannot redirect appends', async t => {
  const f = await fixture(t), logger = await createLocalDiagnostics({ dataDir: f.dataDir }), outside = path.join(f.directory, 'outside');
  await mkdir(outside); const externalLog = path.join(outside, 'errors.ndjson'); await writeFile(externalLog, 'external-sentinel');
  await rename(f.diagnostics, path.join(f.dataDir, 'original-diagnostics'));
  await symlink(outside, f.diagnostics, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(logger.capture(new Error('must-not-append-outside'))); await logger.close();
  assert.equal(await readFile(externalLog, 'utf8'), 'external-sentinel');
});

test('an external hard link at the logfile cannot receive diagnostic writes', async t => {
  const f = await fixture(t), logger = await createLocalDiagnostics({ dataDir: f.dataDir }), outside = path.join(f.directory, 'external-log.txt'); await writeFile(outside, 'external-sentinel');
  await link(outside, f.log); await assert.rejects(logger.capture(new Error('must-not-overwrite-linked-file'))); await logger.close();
  assert.equal(await readFile(outside, 'utf8'), 'external-sentinel');
});

test('real production generate errors return an errorId backed by local redacted receipts across restart', { timeout: 60000 }, async t => {
  const f = await fixture(t), projectId = 'server-diagnostic'; let app;
  t.after(async () => { await app?.close(); });
  const start = () => startServer({ dataDir: f.dataDir, port: 0, remotionDependencies: { ai: async () => { throw failure(); } } });
  app = await start(); assert.notEqual(new URL(app.url).port, '4417');
  let response = await fetch(app.url + `/api/projects/${projectId}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: projectId, kind: 'video', title: '隔离诊断项目', video: { timeline: [], captions: [], aspect: '16:9' }, source: { text: '' } }) });
  assert.equal(response.status, 200);
  const receipts = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    response = await fetch(app.url + `/api/projects/${projectId}/remotion/generate?private-query=must-not-be-logged`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instruction: 'HTTP-body-must-not-be-logged', settings: { baseUrl: 'http://127.0.0.1:1/v1', model: 'model-reply-must-not-be-logged', apiKey: secret } }) });
    const body = await response.json(); assert.equal(response.status, 500); assert.equal(body.code, 'INTERNAL_ERROR'); assert.match(body.errorId, /^[a-f0-9-]{36}$/); assert.ok(body.error.includes(body.errorId.slice(0, 8)));
    for (const value of [secret, 'C:/Users', 'fixture-bearer-token', 'example.invalid', 'requestBody', 'modelReply']) assert.ok(!JSON.stringify(body).includes(value));
    receipts.push(body.errorId); await app.close();
    const records = await f.records(); assert.equal(records.length, attempt + 1); assert.equal(records.at(-1).id, body.errorId); assert.equal(records.at(-1).route, `/api/projects/${projectId}/remotion/generate`);
    const text = JSON.stringify(records);
    for (const value of [secret, 'Private/project.tsx', 'fixture-bearer-token', 'another-fixture-secret', 'example.invalid', 'private-query', 'HTTP-body-must-not-be-logged', 'model-reply-must-not-be-logged']) assert.ok(!text.includes(value), value);
    if (attempt === 0) app = await start();
  }
  assert.notEqual(receipts[0], receipts[1]);
  assert.deepEqual(await readdir(path.join(f.dataDir, 'remotion-projects')), []);
});
