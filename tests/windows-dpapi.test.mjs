import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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

test('subprocess startup details are never forwarded as key-store errors', async () => {
  const protector = createWindowsDpapiProtector({ platform: 'win32', spawnProcess: () => { throw new Error('PRIVATE_DIAGNOSTIC_SHOULD_NOT_ESCAPE'); } });
  const capability = await protector.capability(); assert.equal(capability.available, false); assert.ok(!JSON.stringify(capability).includes('PRIVATE_DIAGNOSTIC'));
});

test('real Windows DPAPI rejects invalid ciphertext with a safe explicit decrypt error', { skip: process.platform !== 'win32', timeout: 15000 }, async () => {
  const protector = createWindowsDpapiProtector(); assert.equal((await protector.capability()).available, true);
  const corrupted = Buffer.from('synthetic invalid blob only ' + randomUUID()).toString('base64');
  await assert.rejects(protector.unprotect(corrupted), error => { assert.equal(error.code, 'DPAPI_DECRYPT_FAILED'); assert.ok(!error.message.includes(corrupted)); return true; });
});
