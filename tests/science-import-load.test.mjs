import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const oldId = '11111111-1111-4111-8111-111111111111', nextId = '22222222-2222-4222-8222-222222222222', lastId = '33333333-3333-4333-8333-333333333333';
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const document = id => ({ id, units: [{ id: id + '-unit', readable: true, text: id }] });
async function setup() {
  let source = (await readFile(new URL('../public/science-import.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '').replace(/\bexport (?=(?:async )?function)/g, '');
  const marker = 'return { mount, selection, flush, cancelProject, dispose };'; assert.ok(source.includes(marker));
  source = source.replace(marker, 'return { mount, selection, flush, cancelProject, dispose, audit:{sessionFor,loadDocument,load,startImport} };');
  const calls = [], requests = new Map(), sandbox = { document: { querySelector: () => ({}) }, h: String, icon: () => '', AbortController, DOMException, api: async (url, body, options) => { const request = deferred(); calls.push({ url, options }); requests.set(url.split('/').at(-1), request); return request.promise; } };
  vm.createContext(sandbox); vm.runInContext(source + '\nglobalThis.createImporter=createScienceImporter;', sandbox);
  const project = { id: 'isolated-science', science: { documentSelection: { documentId: oldId, unitIds: [oldId + '-unit'] } } }, importer = sandbox.createImporter({ saveProject: async () => ({}) }), session = importer.audit.sessionFor(project);
  session.document = document(oldId); return { project, importer, session, requests, calls };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const hiddenHost = () => ({ isConnected: false, querySelector: () => ({}), addEventListener() {} });

test('generation waits for a new document selection instead of using the previous material', async () => {
  const run = await setup(), changing = run.importer.audit.loadDocument(run.session, nextId, { makeSelection: true }); let settled = false;
  const flushed = run.importer.flush(run.project).then(value => { settled = true; return value; }); await tick(); assert.equal(settled, false);
  run.requests.get(nextId).resolve({ document: document(nextId) }); await changing;
  assert.equal((await flushed).documentId, nextId);
});

test('flush follows the latest selection after an earlier request is superseded', async () => {
  const run = await setup(), changing = run.importer.audit.loadDocument(run.session, nextId, { makeSelection: true }); let settled = false;
  const flushed = run.importer.flush(run.project).then(value => { settled = true; return value; }); await tick();
  const latest = run.importer.audit.loadDocument(run.session, lastId, { makeSelection: true }); await tick();
  run.requests.get(nextId).reject(new DOMException('Superseded', 'AbortError')); await assert.rejects(changing, /Superseded/); await tick(); assert.equal(settled, false);
  run.requests.get(lastId).resolve({ document: document(lastId) }); await latest;
  assert.equal((await flushed).documentId, lastId);
});

test('a failed selection prevents generation until a successful retry and still allows leaving', async () => {
  const run = await setup(), changing = run.importer.audit.loadDocument(run.session, nextId, { makeSelection: true }); await tick();
  run.requests.get(nextId).reject(new Error('资料读取失败')); await assert.rejects(changing, /资料读取失败/);
  await assert.rejects(run.importer.flush(run.project), /资料读取失败/);
  assert.equal((await run.importer.flush(run.project, { requireSelection: false })).documentId, oldId);
  const retry = run.importer.audit.loadDocument(run.session, nextId, { makeSelection: true }); await tick(); run.requests.get(nextId).resolve({ document: document(nextId) }); await retry;
  assert.equal((await run.importer.flush(run.project)).documentId, nextId);
});

test('late list responses cannot replace a newer explicit document selection', async () => {
  const run = await setup(), listing = run.importer.audit.load(run.session); await tick();
  const changing = run.importer.audit.loadDocument(run.session, nextId, { makeSelection: true }); await tick();
  run.requests.get(nextId).resolve({ document: document(nextId) }); await changing;
  run.requests.get('science-documents').resolve({ documents: [{ id: oldId }] }); await listing;
  assert.equal((await run.importer.flush(run.project)).documentId, nextId);
});

test('generation repaint remount keeps the pending explicit selection and waits for it', async () => {
  const run = await setup(), changing = run.importer.audit.loadDocument(run.session, nextId, { makeSelection: true }); await tick();
  const load = run.session.load, signal = run.calls[0].options.signal;
  // createVisualNovelWorkspace.generate schedules a paint, whose mount runs while flush awaits this GET.
  const flushing = run.importer.flush(run.project); run.importer.mount(hiddenHost(), run.project); await tick();
  assert.equal(signal.aborted, false, 'A repaint must not cancel the user selection'); assert.equal(run.session.load, load); assert.equal(run.calls.length, 1, 'No replacement list request may fall back to the old document');
  run.requests.get(nextId).resolve({ document: document(nextId) }); await changing;
  assert.equal((await flushing).documentId, nextId);
});

test('remount keeps a failed explicit selection blocking until the user retries', async () => {
  const run = await setup(), changing = run.importer.audit.loadDocument(run.session, nextId, { makeSelection: true }); await tick();
  run.requests.get(nextId).reject(new Error('新资料读取失败')); await assert.rejects(changing, /新资料读取失败/);
  const failed = run.session.load; run.importer.mount(hiddenHost(), run.project); await tick();
  assert.equal(run.session.load, failed); assert.equal(run.calls.length, 1); await assert.rejects(run.importer.flush(run.project), /新资料读取失败/);
  const retry = run.importer.audit.loadDocument(run.session, nextId, { makeSelection: true }); await tick(); run.requests.get(nextId).resolve({ document: document(nextId) }); await retry;
  assert.equal((await run.importer.flush(run.project)).documentId, nextId);
});
