import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createConnectionStore, CONNECTION_SETTINGS_FILENAME } from '../lib/connection-store.mjs';
import { createWindowsDpapiProtector, WINDOWS_DPAPI_METHOD } from '../lib/windows-dpapi.mjs';

const configuration = key => ({ baseUrl: 'https://fixture.invalid/v1', model: 'fixture-model', apiStyle: 'responses', jsonMode: true, timeoutSeconds: 123, ...(key === undefined ? {} : { apiKey: key }) });
function fakeProtector(options = {}) {
  const keys = new Map(), calls = { capability: 0, protect: 0, unprotect: 0 };
  return { calls, async capability() { calls.capability++; return { available: options.available !== false }; }, async protect(value, request) { calls.protect++; if (options.protect) return options.protect(value, request); const sealed = Buffer.from('synthetic-sealed-' + randomUUID()).toString('base64'); keys.set(sealed, value); return sealed; }, async unprotect(value) { calls.unprotect++; if (!keys.has(value)) throw new Error('Untrusted diagnostic is never forwarded'); return keys.get(value); } };
}
async function fixture(t, protector = fakeProtector()) {
  const parent = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'gx-connection-')), store = await createConnectionStore({ dataDir: directory, protector });
  t.after(async () => { await store.close(); assert.equal(path.dirname(directory), parent); await rm(directory, { recursive: true, force: true }); });
  return { store, directory, filename: path.join(directory, CONNECTION_SETTINGS_FILENAME), protector };
}

test('connection store construction is lazy and a first load distinguishes unset preferences from saved configuration', async t => {
  const f = await fixture(t); assert.equal(f.protector.calls.capability, 0);
  const loaded = await f.store.load(); assert.equal(loaded.configured, false); assert.equal(loaded.rememberKey, null); assert.equal(loaded.hasSavedKey, false); assert.equal(loaded.encryptionAvailable, true); assert.equal(loaded.settings.apiKey, '');
  assert.deepEqual(await readdir(f.directory), []);
});

test('saving writes only public settings and ciphertext, and turning remember off removes the encrypted key', async t => {
  const f = await fixture(t), key = 'synthetic-only-' + randomUUID();
  const saved = await f.store.save({ settings: { ...configuration(key), otherSecret: key }, rememberKey: true });
  assert.equal(saved.saved, true); assert.equal(saved.hasSavedKey, true); assert.equal(Object.hasOwn(saved.settings, 'apiKey'), false);
  const disk = await readFile(f.filename, 'utf8'); assert.ok(!disk.includes(key)); assert.ok(!disk.includes(Buffer.from(key).toString('base64'))); assert.ok(!disk.includes('otherSecret'));
  const loaded = await f.store.load(); assert.deepEqual(loaded.settings, configuration(key)); assert.equal(loaded.rememberKey, true);
  const publicOnly = await f.store.save({ settings: configuration(key), rememberKey: false }); assert.equal(publicOnly.hasSavedKey, false); assert.equal(publicOnly.rememberKey, false);
  const disabled = JSON.parse(await readFile(f.filename, 'utf8')); assert.equal(disabled.encryptedApiKey, undefined); assert.equal((await f.store.load()).settings.apiKey, '');
});

test('clear deletes ciphertext while retaining public model configuration and an explicit off preference', async t => {
  const f = await fixture(t); await f.store.save({ settings: configuration('fixture-' + randomUUID()), rememberKey: true });
  const cleared = await f.store.clear(); assert.equal(cleared.cleared, true); assert.equal(cleared.hasSavedKey, false); assert.equal(cleared.rememberKey, false); assert.equal(cleared.settings.model, 'fixture-model');
  const disk = JSON.parse(await readFile(f.filename, 'utf8')); assert.equal(disk.encryptedApiKey, undefined); assert.equal(disk.baseUrl, configuration().baseUrl);
  const loaded = await f.store.load(); assert.equal(loaded.settings.apiKey, ''); assert.equal(loaded.rememberKey, false); assert.equal(loaded.configured, true);
});

test('serial load/save/clear and atomic cross-instance saves cannot pair one model with another key', async t => {
  const f = await fixture(t), second = await createConnectionStore({ dataDir: f.directory, protector: f.protector }); t.after(() => second.close());
  const firstKey = 'fixture-a-' + randomUUID(), secondKey = 'fixture-b-' + randomUUID();
  await Promise.all([f.store.save({ settings: { ...configuration(firstKey), model: 'model-a' }, rememberKey: true }), second.save({ settings: { ...configuration(secondKey), model: 'model-b' }, rememberKey: true })]);
  const loaded = await f.store.load(); assert.equal(loaded.settings.apiKey, loaded.settings.model === 'model-a' ? firstKey : secondKey);
  assert.ok((await readdir(f.directory)).every(name => name === CONNECTION_SETTINGS_FILENAME));
  await f.store.clear(); assert.equal((await f.store.load()).settings.apiKey, '');
});

test('unavailable platforms persist public values only and never pretend a key was safely remembered', async t => {
  let spawns = 0;
  const protector = createWindowsDpapiProtector({ platform: 'linux', spawnProcess: () => { spawns++; throw new Error('Must not execute'); } }), f = await fixture(t, protector);
  const saved = await f.store.save({ settings: configuration('fixture-session-' + randomUUID()), rememberKey: true });
  assert.equal(saved.saved, true); assert.equal(saved.encryptionAvailable, false); assert.equal(saved.rememberKey, false); assert.equal(saved.hasSavedKey, false); assert.match(saved.notice, /当前会话/); assert.equal(spawns, 0);
  const record = JSON.parse(await readFile(f.filename, 'utf8')); assert.equal(record.encryptedApiKey, undefined); assert.equal((await f.store.load()).settings.apiKey, '');
});

test('decryption failure retains public configuration and returns an explicit notice without forwarding diagnostics', async t => {
  const f = await fixture(t); await f.store.save({ settings: configuration('fixture-' + randomUUID()), rememberKey: true });
  const record = JSON.parse(await readFile(f.filename, 'utf8')); record.encryptedApiKey = Buffer.from('not-a-valid-cipher').toString('base64'); await writeFile(f.filename, JSON.stringify(record));
  const loaded = await f.store.load(); assert.equal(loaded.settings.apiKey, ''); assert.equal(loaded.settings.model, 'fixture-model'); assert.equal(loaded.noticeCode, 'CONNECTION_DECRYPT_FAILED'); assert.match(loaded.notice, /无法.*解密/); assert.ok(!loaded.notice.includes('Untrusted diagnostic'));
});

test('an encryption provider cannot downgrade to plaintext or base64 plaintext on disk', async t => {
  const f = await fixture(t); await f.store.save({ settings: configuration('old-fixture-' + randomUUID()), rememberKey: true }); const before = await readFile(f.filename, 'utf8');
  f.protector.protect = async key => Buffer.from(key).toString('base64');
  await assert.rejects(f.store.save({ settings: configuration('new-fixture-' + randomUUID()), rememberKey: true }), { code: 'CONNECTION_ENCRYPT_FAILED' });
  assert.equal(await readFile(f.filename, 'utf8'), before);
});

test('validation rejects oversized keys, CRLF and credentials embedded in public URLs without changing the prior record', async t => {
  const f = await fixture(t); await f.store.save({ settings: configuration('fixture-' + randomUUID()), rememberKey: true }); const before = await readFile(f.filename, 'utf8');
  for (const settings of [configuration('x'.repeat(4097)), configuration('line\r\nsecret'), { ...configuration('other'), baseUrl: 'https://u:password@fixture.invalid/v1' }, { ...configuration('other'), baseUrl: 'https://fixture.invalid/v1?api_key=never-store' }, { ...configuration('other'), baseUrl: 'x'.repeat(2001) }, { ...configuration('other'), model: 'm'.repeat(301) }]) await assert.rejects(f.store.save({ settings, rememberKey: true }));
  assert.equal(await readFile(f.filename, 'utf8'), before);
});

test('a known API key pasted into public connection fields is rejected before encryption or replacing the old record', async t => {
  const f = await fixture(t); await f.store.save({ settings: configuration('old-fixture-' + randomUUID()), rememberKey: true }); const before = await readFile(f.filename, 'utf8'), protectCalls = f.protector.calls.protect;
  const key = 'synthetic-public-field/' + randomUUID() + '+value';
  for (const settings of [
    { ...configuration(key), model: key },
    { ...configuration(key), model: 'prefix ' + encodeURIComponent(key) + ' suffix' },
    { ...configuration(key), baseUrl: 'https://fixture.invalid/v1/' + encodeURIComponent(key) },
    { ...configuration(key), baseUrl: 'https://fixture.invalid/v1/' + encodeURIComponent(encodeURIComponent(key)) },
  ]) {
    await assert.rejects(f.store.save({ settings, rememberKey: true }), error => { assert.equal(error.code, 'CONNECTION_PUBLIC_SECRET'); assert.ok(!error.message.includes(key)); return true; });
    assert.equal(await readFile(f.filename, 'utf8'), before);
  }
  assert.equal(f.protector.calls.protect, protectCalls);
  const short = await f.store.save({ settings: { ...configuration('1'), model: 'model-v1' }, rememberKey: false }); assert.equal(short.saved, true, 'A short key must not spuriously match ordinary URL/model digits');
});

test('file hard links and directory junctions are rejected instead of reading or replacing an outside record', async t => {
  const f = await fixture(t), external = path.join(f.directory, 'outside.json'); await writeFile(external, '{"model":"external"}'); await link(external, f.filename);
  await assert.rejects(f.store.load(), { code: 'CONNECTION_STORAGE_LINK' }); await assert.rejects(f.store.save({ settings: configuration(), rememberKey: false }), { code: 'CONNECTION_STORAGE_LINK' }); assert.equal(await readFile(external, 'utf8'), '{"model":"external"}');
  const linked = path.join(f.directory, 'linked-data'), actual = path.join(f.directory, 'real-data'); await mkdir(actual); await symlink(actual, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const store = await createConnectionStore({ dataDir: linked, protector: f.protector }); t.after(() => store.close()); await assert.rejects(store.load(), { code: 'CONNECTION_STORAGE_LINK' });
});

test('cancelled encryption never replaces the previous record and close drains accepted saves while refusing new work', async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, fakeProtector({ protect: async () => { entered(); await gate; return Buffer.from('fixture-sealed-data').toString('base64'); } })), controller = new AbortController();
  const saving = f.store.save({ settings: configuration('fixture-cancel-' + randomUUID()), rememberKey: true }, { signal: controller.signal });
  await ready; let closed = false; const closing = f.store.close().then(() => { closed = true; }); await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
  await assert.rejects(f.store.load(), { code: 'CONNECTION_STORE_CLOSED' }); controller.abort(); release(); await assert.rejects(saving, { name: 'AbortError' }); await closing;
  await assert.rejects(readFile(f.filename), { code: 'ENOENT' }); assert.deepEqual(await readdir(f.directory), []);
});

test('real Windows DPAPI ciphertext survives a fresh Node process without plaintext or base64 plaintext on disk', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  const f = await fixture(t, createWindowsDpapiProtector()), key = 'sk-gx-synthetic-' + randomUUID();
  const saved = await f.store.save({ settings: configuration(key), rememberKey: true }); assert.equal(saved.saved, true); assert.equal(saved.encryptionAvailable, true); assert.equal(saved.hasSavedKey, true);
  await f.store.close(); const disk = await readFile(f.filename, 'utf8'); assert.ok(!disk.includes(key)); assert.ok(!disk.includes(Buffer.from(key).toString('base64'))); const parsed = JSON.parse(disk); assert.equal(parsed.provider, WINDOWS_DPAPI_METHOD);
  const helper = path.join(f.directory, 'fresh-process.mjs'), module = new URL('../lib/connection-store.mjs', import.meta.url).href;
  await writeFile(helper, `import {createConnectionStore}from${JSON.stringify(module)};let raw='';for await(const chunk of process.stdin)raw+=chunk;const expected=JSON.parse(raw),store=await createConnectionStore({dataDir:process.argv[2]});const loaded=await store.load();await store.close();console.log(JSON.stringify({keyMatches:loaded.settings.apiKey===expected.key,model:loaded.settings.model,hasSavedKey:loaded.hasSavedKey,encryptionAvailable:loaded.encryptionAvailable}));`);
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helper, f.directory], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); let output = '';
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', () => {}); child.once('error', reject); child.once('close', code => { if (code !== 0) reject(new Error('Fresh-process DPAPI check failed without exposing its key')); else { try { resolve(JSON.parse(output)); } catch (error) { reject(error); } } });
    child.stdin.end(JSON.stringify({ key }));
  });
  assert.equal(result.keyMatches, true); assert.equal(result.encryptionAvailable, true); assert.equal(result.hasSavedKey, true); assert.equal(result.model, 'fixture-model');
  const reopened = await createConnectionStore({ dataDir: f.directory }); await reopened.clear(); await reopened.close(); assert.equal(JSON.parse(await readFile(f.filename, 'utf8')).encryptedApiKey, undefined);
});
