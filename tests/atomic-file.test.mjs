import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, unlink, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { renameWithRetry } from '../lib/atomic-file.mjs';
import { createProjectStore } from '../lib/store.mjs';
import { createNovelLibraryService } from '../lib/novel-library.mjs';

const windows = process.platform === 'win32';
async function setup(t) {
  const base = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(base, { recursive: true });
  const parent = await mkdtemp(path.join(base, 'gx-atomic-store-')), dataDir = path.join(parent, 'data'); await mkdir(dataDir);
  const store = await createProjectStore(dataDir);
  const evidence = {};
  t.after(async () => { await store.settle(); assert.equal(path.dirname(path.resolve(parent)), base); assert.equal(path.dirname(await realpath(parent)), await realpath(base)); assert.ok(path.basename(parent).startsWith('gx-atomic-store-')); if (process.env.GUANGXUAN_KEEP_ATOMIC_TESTS) { await writeFile(path.join(parent, 'verification.json'), JSON.stringify(evidence, null, 2)); t.diagnostic('Atomic evidence: ' + parent); } else await rm(parent, { recursive: true, force: true }); });
  return { parent, dataDir, store, evidence };
}
async function lockFile(filename, duration) {
  const releaseFile = filename + '.release-' + randomUUID(), events = [], started = Date.now();
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$stream=[System.IO.File]::Open($env:GX_LOCK_FILE,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::ReadWrite);try{[Console]::WriteLine('LOCKED');[Console]::Out.Flush();if($env:GX_LOCK_MS){Start-Sleep -Milliseconds ([int]$env:GX_LOCK_MS)}else{while(-not [IO.File]::Exists($env:GX_RELEASE_FILE)){Start-Sleep -Milliseconds 5}}}finally{$stream.Dispose();[Console]::WriteLine('RELEASED');[Console]::Out.Flush()}"], { env: { ...process.env, GX_LOCK_FILE: filename, GX_RELEASE_FILE: releaseFile, GX_LOCK_MS: duration ? String(duration) : '' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '', signaled = false, output = '', ready, unlocked;
  const acquired = new Promise(resolve => ready = resolve), disposed = new Promise(resolve => unlocked = resolve);
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => { output += chunk.toString(); const lines = output.split(/\r?\n/); output = lines.pop(); for (const line of lines) { events.push({ event: line, elapsedMs: Date.now() - started }); if (line === 'LOCKED') ready(); if (line === 'RELEASED') unlocked(); } });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('File lock helper failed: ' + stderr))); });
  const timer = setTimeout(() => child.kill(), 5000);
  try { await Promise.race([acquired, exited.then(() => { throw Error('Lock helper exited without acquiring a lock'); })]); } finally { clearTimeout(timer); }
  const release = async () => { if (!signaled) { signaled = true; events.push({ event: 'release-request', elapsedMs: Date.now() - started }); if (!duration) await writeFile(releaseFile, 'release', { flag: 'wx' }); } await exited; await disposed; await unlink(releaseFile).catch(error => { if (error.code !== 'ENOENT') throw error; }); };
  release.events = events;
  Object.defineProperty(release, 'disposed', { value: disposed, writable: false });
  return release;
}

test('atomic rename retries only temporary sharing errors with nine attempts and 1180ms bounded backoff', async () => {
  const delays = [], attempts = [], errors = ['EPERM', 'EBUSY', 'EACCES'].map(code => Object.assign(new Error(code), { code }));
  await renameWithRetry('pending.tmp', 'project.json', { renameOperation: async (...args) => { attempts.push(args); if (errors.length) throw errors.shift(); }, wait: async delay => { delays.push(delay); } });
  assert.equal(attempts.length, 4); assert.deepEqual(delays, [20, 40, 80]); assert.ok(attempts.every(args => args[0] === 'pending.tmp' && args[1] === 'project.json'));
  let calls = 0; const blocked = Object.assign(new Error('locked'), { code: 'EPERM', errno: -4048, syscall: 'rename' }), exhaustedDelays = [];
  await assert.rejects(renameWithRetry('pending.tmp', 'project.json', { renameOperation: async () => { calls++; throw blocked; }, wait: async delay => { exhaustedDelays.push(delay); } }), error => error === blocked);
  assert.equal(calls, 9); assert.deepEqual(exhaustedDelays, [20, 40, 80, 120, 160, 200, 240, 320]); assert.equal(exhaustedDelays.reduce((sum, delay) => sum + delay, 0), 1180);
  for (const code of ['ENOSPC', 'EIO', 'ENOENT', 'EXDEV']) {
    let permanentCalls = 0; const original = Object.assign(new Error(code), { code });
    await assert.rejects(renameWithRetry('a', 'b', { renameOperation: async () => { permanentCalls++; throw original; }, wait: async () => { assert.fail('Permanent failures must not retry.'); } }), error => error === original);
    assert.equal(permanentCalls, 1);
  }
});

test('cancellation before rename or during bounded wait preserves uncommitted replacement; a completed rename retains its receipt', async () => {
  const before = new AbortController(); before.abort(); let calls = 0;
  await assert.rejects(renameWithRetry('a', 'b', { signal: before.signal, renameOperation: async () => { calls++; } }), error => error.name === 'AbortError'); assert.equal(calls, 0);
  const waiting = new AbortController(), original = Object.assign(Error('sharing lock'), { code: 'EPERM' });
  await assert.rejects(renameWithRetry('a', 'b', { signal: waiting.signal, renameOperation: async () => { calls++; throw original; }, wait: async (_delay, _value, options) => { assert.equal(options.signal, waiting.signal); waiting.abort(); } }), error => error.name === 'AbortError'); assert.equal(calls, 1);
  const late = new AbortController(); assert.equal(await renameWithRetry('a', 'b', { signal: late.signal, renameOperation: async () => { late.abort(); return 'committed'; } }), 'committed');
});

test('real Windows read sharing lock releases during atomic project save without losing the prior file', { skip: !windows, timeout: 15000 }, async t => {
  const { dataDir, store, evidence } = await setup(t); await store.save('locked', { kind: 'science', title: 'old', science: {} });
  const filename = path.join(dataDir, 'projects', 'locked.json'), release = await lockFile(filename, 700); t.after(release);
  // A timed lock really remains held beyond the old540ms budget. RELEASED is
  // emitted only after FileStream.Dispose; it is not a parent stdin timestamp.
  let stopped = false, reads = 0, readError;
  // Cloud evidence showed continuous reopens can still deny rename after the
  // PowerShell lock was disposed. Exercise reads while that real lock is held,
  // then quiesce them on its actual ACK instead of racing forever until save.
  const reader = (async () => { while (!stopped) { try { const project = JSON.parse(await readFile(filename, 'utf8')); assert.ok(['old', 'new'].includes(project.title)); reads++; await pause(5); } catch (error) { readError = error; break; } } })();
  const start = Date.now(); let readerClosedAt, readsAtDispose;
  const quiesced = release.disposed.then(async () => { readsAtDispose = reads; stopped = true; await reader; readerClosedAt = Date.now() - start; });
  try { const pending = store.save('locked', { kind: 'science', title: 'new', science: {} }); await pause(250); assert.equal((await store.read('locked')).title, 'old', 'no unlink or partial overwrite while locked'); await quiesced; await pending; } finally { stopped = true; await reader; await release(); }
  assert.ok(Date.now() - start < 2000); assert.ifError(readError); assert.ok(readsAtDispose >= 2, 'multiple real concurrent reads must occur before Dispose ACK'); assert.ok(release.events.some(event => event.event === 'RELEASED'));
  assert.equal((await store.read('locked')).title, 'new'); assert.deepEqual((await readdir(path.dirname(filename))).filter(name => name.endsWith('.tmp')), []);
  Object.assign(evidence, { passed: true, test: 'real700ms-sharing-lock-reader-quiesces-on-dispose-ack', elapsedMs: Date.now() - start, reads, readsAtDispose, readerClosedAt, readerStopReason: 'actual PowerShell FileStream.Dispose ACK', events: release.events, oldReadableDuringRetry: true, replacementComplete: true, temporaryFilesRemoved: true });
});

test('exhausted real Windows lock preserves original bytes and errno; store settles and remains usable', { skip: !windows, timeout: 15000 }, async t => {
  const { dataDir, store } = await setup(t); await store.save('blocked', { kind: 'science', title: 'original', science: {} });
  const filename = path.join(dataDir, 'projects', 'blocked.json'), before = await readFile(filename), release = await lockFile(filename); t.after(release);
  await assert.rejects(store.save('blocked', { kind: 'science', title: 'must-not-commit', science: {} }), error => error.code === 'PROJECT_WRITE_ERROR' && error.cause?.code === 'EPERM' && error.cause?.syscall === 'rename' && !JSON.stringify(error).includes(filename));
  await store.settle(); assert.deepEqual(await readFile(filename), before); assert.deepEqual((await readdir(path.dirname(filename))).filter(name => name.endsWith('.tmp')), []);
  await release(); await store.save('blocked', { kind: 'science', title: 'after-release', science: {} }); assert.equal((await store.read('blocked')).title, 'after-release');
});

test('shared library uses atomic retry and close settles after a permanently locked pending save', { skip: !windows, timeout: 15000 }, async t => {
  const { dataDir, store } = await setup(t), library = await createNovelLibraryService({ dataDir, store }); t.after(() => library.close());
  await library.saveCharacter({ id: 'guide', name: 'original' }); const filename = path.join(dataDir, 'novel-library', 'library.json'), before = await readFile(filename), release = await lockFile(filename); t.after(release);
  const pending = library.saveCharacter({ id: 'guide', name: 'must-not-commit' }).then(value => ({ value }), error => ({ error }));
  const start = Date.now(); await library.close(); const result = await pending;
  assert.equal(result.error?.code, 'NOVEL_LIBRARY_WRITE'); assert.equal(result.error?.cause?.code, 'EPERM'); assert.ok(Date.now() - start < 2000, 'Close waits only for bounded rename attempts.');
  assert.deepEqual(await readFile(filename), before); assert.deepEqual((await readdir(path.dirname(filename))).filter(name => name.endsWith('.tmp')), []); await release();
  const reopened = await createNovelLibraryService({ dataDir, store }); t.after(() => reopened.close()); assert.equal((await reopened.list()).characters[0].name, 'original');
});

test('project saves remain complete under concurrent shared-library reads and metadata writes for three rounds', { timeout: 30000 }, async t => {
  const { dataDir, store } = await setup(t), library = await createNovelLibraryService({ dataDir, store }); t.after(() => library.close());
  const ids = ['project-a', 'project-b', 'project-c']; for (const id of ids) await store.save(id, { kind: 'science', title: id, science: {} });
  for (let round = 0; round < 3; round++) {
    let stopped = false, readCount = 0;
    const reader = (async () => { while (!stopped) { const result = await store.list(); assert.equal(result.projects.length, 3); assert.ok(!result.warning); await library.list(); readCount++; } })();
    try {
      await Promise.all(Array.from({ length: 120 }, (_, index) => store.save(ids[index % ids.length], { kind: 'science', title: ids[index % ids.length], science: { round, sequence: index, text: '并发保存与读取'.repeat(1500) } })));
      await Promise.all(Array.from({ length: 12 }, (_, index) => library.saveCharacter({ id: 'guide-' + index, name: '人物' + round + '-' + index })));
    } finally { stopped = true; await reader; }
    assert.ok(readCount > 0); for (let index = 0; index < ids.length; index++) { const project = await store.read(ids[index]); assert.equal(project.science.round, round); assert.equal(project.science.sequence, 117 + index); }
  }
  await store.settle(); assert.deepEqual((await readdir(path.join(dataDir, 'projects'))).filter(name => name.endsWith('.tmp')), []);
});
