import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { createWindowsDpapiProtector, WINDOWS_DPAPI_SCRIPT } from '../lib/windows-dpapi.mjs';

const echoHelper = "let raw='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>raw+=c);process.stdin.on('end',()=>{const r=JSON.parse(raw);process.stdout.write(JSON.stringify({ok:true,payload:r.operation==='probe'?'b2s=':r.payload}));});";
function runner() {
  const calls = [], inputs = []; let hangNext = false, onSpawn;
  return { calls, inputs, set hang(value) { hangNext = value; }, nextSpawn() { return new Promise(resolve => { onSpawn = resolve; }); }, spawnProcess(binary, args, options) {
    const child = spawn(process.execPath, ['-e', hangNext ? 'process.stdin.resume();setInterval(()=>{},1000)' : echoHelper], options); hangNext = false;
    calls.push({ binary, args, options, child });
    const original = child.stdin.end.bind(child.stdin); child.stdin.end = (input, ...rest) => { inputs.push(input); return original(input, ...rest); };
    child.once('spawn', () => { if (onSpawn) { const respond = onSpawn; onSpawn = null; respond(child.pid); } }); return child;
  } };
}

test('DPAPI transport is lazy, uses one fixed command and sends secret material through stdin only', async t => {
  const fake = runner(), secret = 'fixture-transport-' + randomUUID(), encoded = Buffer.from(secret).toString('base64'), previous = process.env.GX_CONNECTION_FAKE_SECRET;
  process.env.GX_CONNECTION_FAKE_SECRET = secret; t.after(() => { if (previous === undefined) delete process.env.GX_CONNECTION_FAKE_SECRET; else process.env.GX_CONNECTION_FAKE_SECRET = previous; });
  const protector = createWindowsDpapiProtector({ platform: 'win32', spawnProcess: fake.spawnProcess });
  assert.equal(fake.calls.length, 0); assert.equal((await protector.capability()).available, true); await protector.capability(); assert.equal(fake.calls.length, 1);
  // This echo process tests transport only; real cryptography is tested against
  // Windows ProtectedData separately and is never replaced in production.
  const cipher = await protector.protect(secret); assert.equal(await protector.unprotect(cipher), secret);
  assert.equal(fake.calls.length, 3); assert.ok(fake.calls.every(call => JSON.stringify(call.args) === JSON.stringify(fake.calls[0].args)));
  for (const call of fake.calls) {
    assert.equal(call.options.shell, false); assert.equal(call.options.windowsHide, true); assert.equal(call.options.env.GX_CONNECTION_FAKE_SECRET, undefined);
    const visible = JSON.stringify([call.args, call.options.env]); assert.ok(!visible.includes(secret)); assert.ok(!visible.includes(encoded));
  }
  const sent = JSON.parse(fake.inputs[1]); assert.equal(sent.operation, 'protect'); assert.equal(sent.payload, encoded);
  assert.match(WINDOWS_DPAPI_SCRIPT, /DataProtectionScope\]::CurrentUser/); assert.match(WINDOWS_DPAPI_SCRIPT, /\[Console\]::In.ReadToEnd/); assert.ok(!WINDOWS_DPAPI_SCRIPT.includes('Invoke-Expression'));
});

test('DPAPI cancellation rejects only after its child exits and permits a later retry', async () => {
  const fake = runner(), protector = createWindowsDpapiProtector({ platform: 'win32', spawnProcess: fake.spawnProcess }); await protector.capability();
  fake.hang = true; const spawned = fake.nextSpawn(), controller = new AbortController(), pending = protector.protect('fixture-cancel-' + randomUUID(), { signal: controller.signal }), pid = await spawned;
  controller.abort(); await assert.rejects(pending, { name: 'AbortError' }); assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
  assert.equal(typeof await protector.protect('fixture-retry-' + randomUUID()), 'string');
});

test('a timed-out DPAPI probe is unavailable and leaves no running helper or false encrypted state', async () => {
  const fake = runner(); fake.hang = true; const spawned = fake.nextSpawn(), protector = createWindowsDpapiProtector({ platform: 'win32', spawnProcess: fake.spawnProcess, timeoutMs: 80 });
  const waiting = protector.capability(), pid = await spawned, capability = await waiting;
  assert.equal(capability.available, false); assert.equal(capability.reasonCode, 'DPAPI_TIMEOUT'); assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
  await assert.rejects(protector.protect('fixture-' + randomUUID()), { code: 'DPAPI_TIMEOUT' }); assert.equal(fake.calls.length, 1);
});

test('a failed DPAPI transport rechecks only on a later explicit request and shares the recovered probe', async () => {
  const fake = runner(); fake.hang = true;
  const spawned = fake.nextSpawn(), protector = createWindowsDpapiProtector({ platform: 'win32', spawnProcess: fake.spawnProcess, timeoutMs: 80, retryDelayMs: 120 });
  const pending = protector.capability(), pid = await spawned, first = await pending;
  assert.equal(first.available, false); assert.equal(first.reasonCode, 'DPAPI_TIMEOUT');
  assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
  assert.equal((await protector.capability()).available, false);
  await assert.rejects(protector.protect('fixture-recovery-' + randomUUID()), { code: 'DPAPI_TIMEOUT' });
  assert.equal(fake.calls.length, 1);
  await delay(160); assert.equal(fake.calls.length, 1, 'cooldown must not launch a background child');
  const recovered = await Promise.all([protector.capability(), protector.capability(), protector.capability()]);
  assert.ok(recovered.every(value => value.available === true)); assert.equal(fake.calls.length, 2);
  assert.equal((await protector.capability()).available, true); assert.equal(fake.calls.length, 2, 'successful probe remains cached');
  const cipher = await protector.protect('fixture-protected-after-recovery-' + randomUUID());
  assert.equal(typeof cipher, 'string'); assert.equal(fake.calls.length, 3);
  assert.equal(JSON.stringify(fake.calls[0].args), JSON.stringify(fake.calls[1].args));
});

test('cancelling an initial DPAPI probe waits for child exit and permits an immediate explicit recheck', async () => {
  const fake = runner(); fake.hang = true;
  const spawned = fake.nextSpawn(), controller = new AbortController(), protector = createWindowsDpapiProtector({ platform: 'win32', spawnProcess: fake.spawnProcess, retryDelayMs: 30000 });
  const pending = protector.capability({ signal: controller.signal }), pid = await spawned;
  controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
  assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
  assert.equal((await protector.capability()).available, true); assert.equal(fake.calls.length, 2);
});

test('subprocess startup details are never forwarded as key-store errors', async () => {
  const protector = createWindowsDpapiProtector({ platform: 'win32', spawnProcess: () => { throw new Error('PRIVATE_DIAGNOSTIC_SHOULD_NOT_ESCAPE'); } });
  const capability = await protector.capability(); assert.equal(capability.available, false); assert.ok(!JSON.stringify(capability).includes('PRIVATE_DIAGNOSTIC'));
});

test('DPAPI host selection uses the installed fixed modern path, falls back when absent and preserves an explicit host', async t => {
  // The injected child tests host selection/transport; this ordinary placeholder
  // executable is never run and is not evidence of real cryptography.
  const parent = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'gx-dpapi-host-')), previous = process.env.ProgramFiles;
  process.env.ProgramFiles = directory;
  t.after(async () => { if (previous === undefined) delete process.env.ProgramFiles; else process.env.ProgramFiles = previous; assert.equal(path.dirname(directory), parent); await rm(directory, { recursive: true, force: true }); });
  const modern = path.join(directory, 'PowerShell', '7', 'pwsh.exe'); await mkdir(path.dirname(modern), { recursive: true }); await writeFile(modern, 'ordinary placeholder; never execute');
  const first = runner(); assert.equal((await createWindowsDpapiProtector({ platform: 'win32', spawnProcess: first.spawnProcess }).capability()).available, true); assert.equal(first.calls[0].binary, modern);
  await unlink(modern);
  const fallback = runner(); assert.equal((await createWindowsDpapiProtector({ platform: 'win32', spawnProcess: fallback.spawnProcess }).capability()).available, true);
  assert.equal(fallback.calls[0].binary, path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  const explicit = runner(), fixed = 'C:/synthetic-controlled/explicit.exe'; assert.equal((await createWindowsDpapiProtector({ platform: 'win32', powershellPath: fixed, spawnProcess: explicit.spawnProcess }).capability()).available, true); assert.equal(explicit.calls[0].binary, fixed);
  assert.equal(JSON.stringify(first.calls[0].args), JSON.stringify(fallback.calls[0].args));
});

test('real Windows DPAPI rejects invalid ciphertext with a safe explicit decrypt error', { skip: process.platform !== 'win32', timeout: 15000 }, async () => {
  const protector = createWindowsDpapiProtector(); assert.equal((await protector.capability()).available, true);
  const corrupted = Buffer.from('synthetic invalid blob only ' + randomUUID()).toString('base64');
  await assert.rejects(protector.unprotect(corrupted), error => { assert.equal(error.code, 'DPAPI_DECRYPT_FAILED'); assert.ok(!error.message.includes(corrupted)); return true; });
});
