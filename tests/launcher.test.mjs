import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readPortPreference, listenWithPortPreference } from '../scripts/local-server.mjs';
import { resolveLaunchService, connectionLaunchUrl } from '../scripts/start-local.mjs';
import { readDesktopRuntime, writeDesktopRuntime } from '../lib/desktop-session.mjs';

async function fixture(t) {
  const base = path.resolve(process.env.GUANGXUAN_TEST_TMP || os.tmpdir());
  await fs.mkdir(base, { recursive: true });
  const directory = await fs.mkdtemp(path.join(base, 'guangxuan-launcher-test-'));
  t.after(async () => {
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== base || !path.basename(resolved).startsWith('guangxuan-launcher-test-'))
      throw new Error('Refusing unsafe launcher-test cleanup.');
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return path.join(directory, 'desktop-preferences.json');
}

function occupied() {
  return Object.assign(new Error('The simulated port is occupied.'), { code: 'EADDRINUSE' });
}

test('a saved port conflict never migrates an existing workspace to the other origin', async t => {
  const file = await fixture(t);
  await fs.writeFile(file, JSON.stringify({ port: 4417 }));
  const attempted = [];
  await assert.rejects(listenWithPortPreference(await readPortPreference(file), async port => {
    attempted.push(port);
    throw occupied();
  }), error => error.code === 'FIXED_PORT_IN_USE' && error.message.includes('4417'));
  assert.deepEqual(attempted, [4417]);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { port: 4417 });
});

test('only the first launch may try a fallback port', async t => {
  const file = await fixture(t);
  const attempted = [];
  const server = { url: 'http://127.0.0.1:4317' };
  const actual = await listenWithPortPreference(await readPortPreference(file), async port => {
    attempted.push(port);
    if (port === 4417) throw occupied();
    return server;
  });
  assert.equal(actual, server);
  assert.deepEqual(attempted, [4417, 4317]);
});

test('a damaged saved preference is reported instead of treated as a first launch', async t => {
  const file = await fixture(t);
  await fs.writeFile(file, '{"port":');
  await assert.rejects(readPortPreference(file), /配置损坏/);
  await fs.writeFile(file, JSON.stringify({ port: 9999 }));
  await assert.rejects(readPortPreference(file), /配置无效/);
});

test('a healthy instance is reused even when another application copy launched it', async () => {
  const healthy = { url: 'http://127.0.0.1:4417', appRoot: 'C:/another-copy/resources/app', instanceId: 'verified-instance' };
  let newStarts = 0;
  const actual = await resolveLaunchService(healthy, async () => { newStarts++; throw new Error('Should not start another service.'); });
  assert.equal(actual, healthy);
  assert.equal(newStarts, 0);
});

test('connection launch capability is fragment-only and discards stale paths, query and fragment values', () => {
  const token = randomBytes(32).toString('base64url');
  for (const port of [4317, 4417]) {
    const url = connectionLaunchUrl({ url: `http://127.0.0.1:${port}/old-route?old=ignored#stale`, connectionAccessToken: token });
    assert.equal(url.origin, `http://127.0.0.1:${port}`); assert.equal(url.pathname, '/'); assert.equal(url.search, '');
    assert.equal(new URLSearchParams(url.hash.slice(1)).get('gx-connection-session') === token, true);
    assert.ok(!url.origin.includes(token)); assert.ok(!url.search.includes(token));
  }
});

test('launcher refuses missing or malformed session capabilities and nonlocal service origins without echoing credentials', () => {
  const token = randomBytes(32).toString('base64url');
  for (const value of [undefined, '', token.slice(0, -1), token + 'a', '='.repeat(43), ' '.repeat(43), 'a'.repeat(42) + '\n']) assert.throws(() => connectionLaunchUrl({ url: 'http://127.0.0.1:4417', connectionAccessToken: value }), /重新启动/);
  for (const url of ['https://127.0.0.1:4417', 'http://localhost:4417', 'http://127.0.0.1:9999', 'http://127.0.0.1.evil.invalid:4417', 'http://user:password@127.0.0.1:4417', 'http://[::1]:4417']) assert.throws(() => connectionLaunchUrl({ url, connectionAccessToken: token }), error => { assert.ok(!error.message.includes(token)); assert.ok(!error.message.includes('password')); return true; });
});

test('private runtime records use atomic complete replacements, bounded regular files and no fixed tmp overwrite', async t => {
  const file = (await fixture(t)).replace('desktop-preferences.json', 'desktop-runtime.json'), directory = path.dirname(file), records = Array.from({ length: 8 }, (_, index) => ({ index, instanceId: randomUUID(), controlToken: randomUUID(), connectionAccessToken: randomBytes(32).toString('base64url'), url: 'http://127.0.0.1:4417' }));
  await Promise.all(records.map(record => writeDesktopRuntime(file, record)));
  const saved = await readDesktopRuntime(file); assert.equal(saved.connectionAccessToken === records[saved.index].connectionAccessToken, true); assert.equal(saved.instanceId, records[saved.index].instanceId);
  assert.deepEqual(await fs.readdir(directory), ['desktop-runtime.json']);
  if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o077, 0);
  const before = await fs.readFile(file, 'utf8'); await assert.rejects(writeDesktopRuntime(file, { text: 'x'.repeat(70 * 1024) }), { code: 'DESKTOP_RUNTIME_INVALID' }); assert.equal(await fs.readFile(file, 'utf8'), before);
  await fs.writeFile(file, '{invalid'); await assert.rejects(readDesktopRuntime(file), { code: 'DESKTOP_RUNTIME_INVALID' });
});

test('runtime read/write refuses file hardlinks and parent junctions before exposing or replacing token records', async t => {
  const file = (await fixture(t)).replace('desktop-preferences.json', 'desktop-runtime.json'), directory = path.dirname(file), outside = path.join(directory, 'outside.json');
  await fs.writeFile(outside, '{"sentinel":true}'); await fs.link(outside, file);
  await assert.rejects(readDesktopRuntime(file), { code: 'DESKTOP_RUNTIME_UNSAFE_PATH' }); await assert.rejects(writeDesktopRuntime(file, { connectionAccessToken: randomBytes(32).toString('base64url') }), { code: 'DESKTOP_RUNTIME_UNSAFE_PATH' }); assert.equal(await fs.readFile(outside, 'utf8'), '{"sentinel":true}');
  const actual = path.join(directory, 'actual'), alias = path.join(directory, 'alias'); await fs.mkdir(actual); await fs.symlink(actual, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(writeDesktopRuntime(path.join(alias, 'desktop-runtime.json'), { session: 'synthetic-only' }), { code: 'DESKTOP_RUNTIME_UNSAFE_PATH' });
});

async function isolatedManagedSource(dataDirectory) {
  const filename = fileURLToPath(new URL('../scripts/local-server.mjs', import.meta.url));
  let source = await fs.readFile(filename, 'utf8');
  source = source.replace(/^import[^\n]*\r?\n/gm, '').replace(/\bexport (?=(?:async )?function)/g, '').replaceAll('import.meta.url', JSON.stringify(new URL('../scripts/local-server.mjs', import.meta.url).href));
  const events = [], messages = [], logs = [], exits = [], server = new EventEmitter(); server.on('request', () => {});
  const processStub = { env: { GUANGXUAN_USER_DATA: dataDirectory, GUANGXUAN_BIN_DIR: path.join(dataDirectory, 'bin') }, argv: ['node', 'not-the-launcher-under-test'], pid: 12345, platform: 'win32', connected: true, send: value => messages.push(value), exit: code => exits.push(code), on() {}, once() {} };
  const sandbox = { fs, path, randomBytes, randomUUID, timingSafeEqual, fileURLToPath, readDesktopRuntime, writeDesktopRuntime, Buffer, URL, setImmediate, process: processStub, console: { log: value => logs.push(String(value)), error: value => logs.push(String(value)) }, startServer: async options => { events.push(options); return { url: 'http://127.0.0.1:4417', server, close: async () => {} }; } };
  vm.createContext(sandbox); await vm.runInContext('(async()=>{' + source + '\nglobalThis.auditRun=runManagedServer;globalThis.auditShutdown=shutdown;})();', sandbox);
  await sandbox.auditRun(); return { sandbox, events, messages, logs, exits, server };
}

test('managed source generates independent per-start tokens, keeps public status clean and never binds real test ports', async t => {
  const file = (await fixture(t)).replace('desktop-preferences.json', 'desktop-runtime.json'), directory = path.dirname(file), first = await isolatedManagedSource(directory), one = await readDesktopRuntime(file);
  assert.equal(first.events.length, 1); assert.equal(first.events[0].host, '127.0.0.1'); assert.equal(first.events[0].connectionAccessToken === one.connectionAccessToken, true); assert.match(one.connectionAccessToken, /^[A-Za-z0-9_-]{43}$/); assert.notEqual(one.connectionAccessToken, one.controlToken);
  assert.equal(first.messages.find(value => value.type === 'ready').connectionAccessToken === one.connectionAccessToken, true);
  let publicBody = '';
  first.server.emit('request', { url: '/api/desktop/status', method: 'GET', headers: { host: '127.0.0.1:4417' } }, { writeHead() {}, end: value => { publicBody += value || ''; } });
  assert.equal(JSON.parse(publicBody).instanceId, one.instanceId); assert.ok(!publicBody.includes(one.connectionAccessToken)); assert.ok(!publicBody.includes(one.controlToken)); assert.ok(!first.logs.join('').includes(one.connectionAccessToken));
  const second = await isolatedManagedSource(directory), two = await readDesktopRuntime(file); assert.notEqual(two.instanceId, one.instanceId); assert.equal(two.connectionAccessToken !== one.connectionAccessToken, true);
  await first.sandbox.auditShutdown(); assert.equal((await readDesktopRuntime(file)).instanceId, two.instanceId, 'An old service must not delete its successor runtime');
  await second.sandbox.auditShutdown(); await assert.rejects(readDesktopRuntime(file), { code: 'ENOENT' });
});
