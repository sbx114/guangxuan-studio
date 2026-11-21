import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const code = (await fs.readFile(new URL('../public/science-workspace.js', import.meta.url), 'utf8')).replace(/^import .*;\s*$/gm, '').replace(/^export /gm, '');
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
class Element {
  constructor() { this.children = new Map(); this.events = new Map(); this.value = ''; this.isConnected = true; this.classList = { toggle() {} }; }
  set innerHTML(value) { this.html = value; this.children.clear(); }
  get innerHTML() { return this.html || ''; }
  querySelector(selector) { if (!this.children.has(selector)) this.children.set(selector, new Element()); return this.children.get(selector); }
  addEventListener(event, callback, options) { this.events.set(event, callback); options?.signal?.addEventListener('abort', () => { if (this.events.get(event) === callback) this.events.delete(event); }); }
  emit(event, detail = {}) { return this.events.get(event)?.({ target: this, ...detail }); }
}
function setup(t, options = {}) {
  const saves = [], notices = [], operations = [], root = new Element(), children = {};
  const context = {
    clone: structuredClone, h: String, icon: () => '', toast: message => notices.push(message), AbortController, DOMException,
    createScienceImporter(config) { children.importConfig = config; return children.importer = { async flush(project, settings) { operations.push(['import-flush', project.id, settings]); return options.flushImport?.(project); }, async cancelProject(id) { operations.push(['import-cancel', id]); return options.cancelImport?.(id); }, dispose() { operations.push(['import-dispose']); } }; },
    createVisualNovelWorkspace(config) { children.novelConfig = config; return children.novel = { mount(host, project) { operations.push(['mount', project.id]); children.project = project; children.host = host; }, unmount() { operations.push(['unmount']); }, async flush() { operations.push(['novel-flush']); return options.flushNovel?.(); }, async cancelProject(id) { operations.push(['novel-cancel', id]); return options.cancelNovel?.(id); }, isBusy: id => options.busy?.(id) || false, sourceChanged(project) { operations.push(['source-change', project.id]); }, dispose() { operations.push(['novel-dispose']); } }; },
  };
  vm.createContext(context); vm.runInContext(code, context);
  const desk = context.createScienceWorkspace({ saveProject: async project => { saves.push(structuredClone(project)); return options.saveProject ? options.saveProject(project) : project; }, callAi() {}, requireConnection: () => true, onNew: options.onNew, onMetadata: options.onMetadata });
  const project = { id: 'science-one', kind: 'science', title: '项目', source: { title: '旧资料', text: '已有资料仍保留', url: '' }, facts: [], science: { step: 'source' } };
  desk.render(root, project); t.after(() => desk.dispose());
  return { desk, project, root, section: () => root.querySelector('[data-science-project]'), saves, notices, operations, children };
}

test('science entry mounts the current novel flow directly and preserves the original material', t => {
  let newCalls = 0; const run = setup(t, { onNew: () => newCalls++ });
  assert.equal(run.project.science.step, 'novel'); assert.equal(run.project.source.text, '已有资料仍保留');
  assert.match(run.root.innerHTML, /data-science-novel-host/);
  assert.doesNotMatch(run.root.innerHTML, /data-science-step|tablist|data-science-brief|data-science-extract|data-science-export|science-source/);
  assert.equal(run.children.novelConfig.importer, run.children.importer);
  run.children.importConfig.onSelected(run.project); assert.deepEqual(run.operations.at(-1), ['source-change', run.project.id]);
  run.section().querySelector('[data-science-new]').emit('click'); assert.equal(newCalls, 1);
});

test('flush drains novel edits, material selection and writes before resolving', async t => {
  const novel = deferred(), imported = deferred(), writing = deferred(), run = setup(t, { flushNovel: () => novel.promise, flushImport: () => imported.promise, saveProject: () => writing.promise });
  const saving = run.children.novelConfig.saveProject(run.project); await tick();
  let flushed = false; const flushing = run.desk.flush().then(() => { flushed = true; }); await tick(); assert.equal(flushed, false);
  novel.resolve(); await tick(); assert.ok(run.operations.some(item => item[0] === 'import-flush')); assert.equal(flushed, false);
  imported.resolve(); await tick(); assert.equal(flushed, false);
  writing.resolve(run.project); await Promise.all([saving, flushing]); assert.equal(flushed, true);
  assert.equal(run.operations.find(item => item[0] === 'import-flush')[2].requireSelection, false);
});

test('flush propagates child errors and retries a previously failed project save', async t => {
  const novelError = new Error('对白未保存'), run = setup(t, { flushNovel: () => Promise.reject(novelError) });
  await assert.rejects(run.desk.flush(), error => error === novelError);
  const importError = new Error('资料未保存'), material = setup(t, { flushImport: () => Promise.reject(importError) });
  await assert.rejects(material.desk.flush(), error => error === importError);
  let fail = true; const saving = setup(t, { saveProject: async project => { if (fail) throw new Error('磁盘暂时不可写'); return project; } });
  await assert.rejects(saving.children.novelConfig.saveProject(saving.project), /磁盘/); fail = false; await saving.desk.flush(); assert.equal(saving.saves.length, 2);
});

test('deactivation unmounts without discarding in-memory edits and remounts the same project', async t => {
  const run = setup(t); run.project.science.novelDraft = { title: '刚修改的对白' }; run.desk.deactivate();
  assert.equal(run.operations.at(-1)[0], 'unmount'); await run.children.novelConfig.saveProject(run.project);
  run.desk.render(run.root, run.project); assert.equal(run.children.project, run.project); assert.equal(run.project.science.novelDraft.title, '刚修改的对白'); assert.equal(run.saves[0].science.novelDraft.title, '刚修改的对白');
});

test('cancellation drains both child producers and an already-submitted store write', async t => {
  const importing = deferred(), novel = deferred(), writing = deferred(), run = setup(t, { cancelImport: () => importing.promise, cancelNovel: () => novel.promise, saveProject: () => writing.promise });
  const saved = run.children.importConfig.saveProject(run.project); const rejectedSave = assert.rejects(saved, { name: 'AbortError' }); await tick();
  let drained = false; const cancelling = run.desk.cancelProject(run.project.id).then(() => { drained = true; }); await tick();
  assert.ok(run.operations.some(item => item[0] === 'import-cancel')); assert.ok(run.operations.some(item => item[0] === 'novel-cancel')); assert.equal(drained, false);
  importing.resolve(); novel.resolve(); await tick(); assert.equal(drained, false);
  writing.resolve(run.project); await Promise.all([rejectedSave, cancelling]); assert.equal(drained, true); assert.equal(run.saves.length, 1); assert.deepEqual(run.notices, []);
});

test('late child callbacks and a global flush cannot recreate a cancelled project', async t => {
  const run = setup(t); await run.desk.cancelProject(run.project.id);
  await assert.rejects(run.children.importConfig.saveProject(run.project), { name: 'AbortError' }); await assert.rejects(run.children.novelConfig.saveProject(run.project), { name: 'AbortError' });
  const mounts = run.operations.filter(item => item[0] === 'mount').length; run.desk.render(run.root, run.project); await run.desk.flush();
  assert.equal(run.operations.filter(item => item[0] === 'mount').length, mounts); assert.equal(run.saves.length, 0);
});

test('cancellation waits for a metadata request and ignores its late title change', async t => {
  const metadata = deferred(); let began = false; const run = setup(t, { onMetadata: () => { began = true; return metadata.promise; } });
  const field = run.section().querySelector('[data-science-title]'); field.value = '新名称'; field.emit('change'); await tick(); assert.equal(began, true);
  let drained = false; const cancelling = run.desk.cancelProject(run.project.id).then(() => { drained = true; }); await tick(); assert.equal(drained, false);
  metadata.resolve({ title: '晚到名称' }); await cancelling; assert.equal(run.project.title, '项目'); assert.equal(run.saves.length, 0);
});

test('dispose closes child lifecycles and prevents late writes or rerendering', async t => {
  const run = setup(t, { busy: id => id === 'science-one' }); assert.equal(run.desk.isBusy(run.project.id), true); assert.equal(run.desk.isBusy('other'), false);
  run.desk.dispose(); assert.ok(run.operations.some(item => item[0] === 'novel-dispose')); assert.ok(run.operations.some(item => item[0] === 'import-dispose'));
  await assert.rejects(run.children.novelConfig.saveProject(run.project), { name: 'AbortError' }); await assert.rejects(run.children.importConfig.saveProject(run.project), { name: 'AbortError' });
  const mounts = run.operations.filter(item => item[0] === 'mount').length; run.desk.render(run.root, run.project); assert.equal(run.operations.filter(item => item[0] === 'mount').length, mounts); assert.equal(run.saves.length, 0);
});
