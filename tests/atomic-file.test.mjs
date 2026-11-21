import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { renameWithRetry } from '../lib/atomic-file.mjs';
import { createProjectStore } from '../lib/store.mjs';
import { createNovelLibraryService } from '../lib/novel-library.mjs';

const windows = process.platform === 'win32';
async function setup(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'gx-atomic-store-')), dataDir = path.join(parent, 'data'); await mkdir(dataDir);
  const store = await createProjectStore(dataDir);
  t.after(async () => { await store.settle(); assert.equal(path.dirname(parent), os.tmpdir()); await rm(parent, { recursive: true, force: true }); });
  return { parent, dataDir, store };
}
async function lockFile(filename, duration) {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$stream=[System.IO.File]::Open($env:GX_LOCK_FILE,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::ReadWrite);try{[Console]::WriteLine('LOCKED');[Console]::Out.Flush();if($env:GX_LOCK_MS){Start-Sleep -Milliseconds ([int]$env:GX_LOCK_MS)}else{[Console]::ReadLine()|Out-Null}}finally{$stream.Dispose()}"], { env: { ...process.env, GX_LOCK_FILE: filename, GX_LOCK_MS: duration ? String(duration) : '' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '', released = false; child.stderr.on('data', chunk => { stderr += chunk; }); child.stdin.on('error', () => {});
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('File lock helper failed: ' + stderr))); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('File lock helper timed out: ' + stderr)); }, 5000);
    child.stdout.once('data', chunk => { clearTimeout(timer); String(chunk).includes('LOCKED') ? resolve() : reject(new Error('Unexpected lock output')); });
    exited.catch(error => { clearTimeout(timer); reject(error); });
  });
  return async () => { if (!released) { released = true; if (!duration) child.stdin.end('\n'); } await exited; };
}

test('atomic rename retries only temporary sharing errors with six attempts and 540ms bounded backoff', async () => {
  const delays = [], attempts = [], errors = ['EPERM', 'EBUSY', 'EACCES'].map(code => Object.assign(new Error(code), { code }));
  await renameWithRetry('pending.tmp', 'project.json', { renameOperation: async (...args) => { attempts.push(args); if (errors.length) throw errors.shift(); }, wait: async delay => { delays.push(delay); } });
  assert.equal(attempts.length, 4); assert.deepEqual(delays, [20, 40, 80]); assert.ok(attempts.every(args => args[0] === 'pending.tmp' && args[1] === 'project.json'));
  let calls = 0; const blocked = Object.assign(new Error('locked'), { code: 'EPERM', errno: -4048, syscall: 'rename' }), exhaustedDelays = [];
  await assert.rejects(renameWithRetry('pending.tmp', 'project.json', { renameOperation: async () => { calls++; throw blocked; }, wait: async delay => { exhaustedDelays.push(delay); } }), error => error === blocked);
  assert.equal(calls, 6); assert.deepEqual(exhaustedDelays, [20, 40, 80, 160, 240]); assert.equal(exhaustedDelays.reduce((sum, delay) => sum + delay, 0), 540);
  for (const code of ['ENOSPC', 'EIO', 'ENOENT', 'EXDEV']) {
    let permanentCalls = 0; const original = Object.assign(new Error(code), { code });
    await assert.rejects(renameWithRetry('a', 'b', { renameOperation: async () => { permanentCalls++; throw original; }, wait: async () => { assert.fail('Permanent failures must not retry.'); } }), error => error === original);
    assert.equal(permanentCalls, 1);
  }
});

test('real Windows read sharing lock releases during atomic project save without losing the prior file', { skip: !windows, timeout: 15000 }, async t => {
  const { dataDir, store } = await setup(t); await store.save('locked', { kind: 'science', title: 'old', science: {} });
  const filename = path.join(dataDir, 'projects', 'locked.json'), release = await lockFile(filename); t.after(release);
  // Coordinate the real lock release with the save in this process.
  const unlocking = new Promise((resolve, reject) => setTimeout(() => { release().then(resolve, reject); }, 100));
  let stopped = false, reads = 0, readError;
  // Thousands of immediate Windows reopen operations can starve rename even
  // after the sharing lock is released. Yield while retaining concurrent reads.
  const reader = (async () => { while (!stopped) { try { const project = JSON.parse(await readFile(filename, 'utf8')); assert.ok(['old', 'new'].includes(project.title)); reads++; await pause(1); } catch (error) { readError = error; break; } } })();
  const start = Date.now();
  try { await store.save('locked', { kind: 'science', title: 'new', science: {} }); } finally { stopped = true; await reader; await unlocking; }
  assert.ok(Date.now() - start < 1500); assert.ifError(readError); assert.ok(reads > 0);
  assert.equal((await store.read('locked')).title, 'new'); assert.deepEqual((await readdir(path.dirname(filename))).filter(name => name.endsWith('.tmp')), []);
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
  assert.equal(result.error?.code, 'NOVEL_LIBRARY_WRITE'); assert.equal(result.error?.cause?.code, 'EPERM'); assert.ok(Date.now() - start < 1500, 'Close waits only for bounded rename attempts.');
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
