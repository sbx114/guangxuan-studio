import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readPortPreference, listenWithPortPreference } from '../scripts/local-server.mjs';
import { resolveLaunchService } from '../scripts/start-local.mjs';

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
