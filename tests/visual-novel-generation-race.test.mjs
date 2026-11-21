import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; };
async function setup() {
  let source = (await readFile(new URL('../public/visual-novel.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '').replace(/\bexport (?=(?:async )?function)/g, '').replace(/\r\n/g, '\n');
  const marker = 'return {\n    mount(host, project)'; assert.ok(source.includes(marker));
  source = source.replace(marker, 'return {\n    audit: {generate,sessionFor,action,editInput},\n    mount(host, project)');
  const response = deferred(), started = deferred(), saves = [], notices = [];
  const sandbox = { queueMicrotask, clearTimeout, setTimeout, AbortController, structuredClone, clone: structuredClone, uid: () => crypto.randomUUID(), toast: value => notices.push(value), createNovelAssetManager: () => ({ flush: async () => ({ config: {}, assetCatalog: {} }) }), normalizeNovelConfig: () => ({ librarySelection: { characterId: 'guide', backgroundId: 'room' } }), resolveNovelLibrary: async () => ({}), hydratePlayableNovel: value => value, serializePlayableNovel: structuredClone, novelFingerprint: JSON.stringify, api: async () => ({ hash: 'source-hash' }) };
  vm.createContext(sandbox); vm.runInContext(source + '\nglobalThis.createDesk=createVisualNovelWorkspace;', sandbox);
  const project = { id: 'isolated-science', runs: [], science: { documentSelection: { documentId: 'doc', unitIds: ['unit'] }, novelConfig: {}, novel: { id: 'old', version: 2, manualText: '原先讲解' } } };
  const desk = sandbox.createDesk({ saveProject: async value => { saves.push(structuredClone(value)); return value; }, callAi: async () => { started.resolve(); return response.promise; }, requireConnection: () => true, importer: { flush: async () => {}, selection: value => value.science.documentSelection } });
  const session = desk.audit.sessionFor(project), job = desk.audit.generate(session);
  await Promise.race([started.promise, job.then(() => { throw new Error(session.error || 'Generation stopped early'); })]);
  const finish = async () => { response.resolve({ data: { id: 'new', version: 2, manualText: '新AI讲解', librarySelection: { characterId: 'guide', backgroundId: 'room' } }, meta: { model: 'local-fixture' } }); await job; };
  return { desk, project, session, saves, notices, finish };
}

test('an unchanged science work still receives the generated result', async () => {
  const run = await setup(); await run.finish(); assert.equal(run.project.science.novel.manualText, '新AI讲解'); assert.equal(run.project.runs.length, 1); assert.equal(run.saves.length, 2);
});

test('a late science generation keeps newer saved work and its editing draft', async () => {
  const run = await setup(); run.project.science.novel.manualText = '等待期间更新的人工作品'; run.project.science.novelDraft = { id: 'old', version: 2, manualText: '仍在编辑的草稿' };
  const before = structuredClone(run.project.science); await run.finish();
  assert.deepEqual(JSON.parse(JSON.stringify(run.project.science)), before); assert.match(run.session.error, /未应用新结果/); assert.equal(run.project.runs.length, 0); assert.equal(run.saves.length, 1);
});

test('generation rejects edit/open/save/reset actions and ignores late editing inputs', async () => {
  const run = await setup(); run.project.science.novelDraft = { title: '保留草稿' };
  for (const attribute of ['data-vn-edit', 'data-vn-edit-apply', 'data-vn-edit-reset']) {
    const button = { hasAttribute: name => name === attribute };
    await run.desk.audit.action(run.session, { target: { closest: () => button } });
    assert.match(run.session.error, /先等待完成或取消/); assert.equal(run.project.science.novelDraft.title, '保留草稿');
  }
  run.desk.audit.editInput(run.session, { hasAttribute: name => name === 'data-vn-edit-title', value: '不应写入' });
  assert.equal(run.project.science.novelDraft.title, '保留草稿'); await run.finish();
});
