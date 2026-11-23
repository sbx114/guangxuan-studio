import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import vm from 'node:vm';
import { createProjectStore } from '../lib/store.mjs';
import { createProjectLinkService } from '../lib/project-links.mjs';
import { createProjectBundleService } from '../lib/project-bundles.mjs';
import { buildPrompt } from '../lib/prompts.mjs';

const shot = { narration: '旧旁白', caption: '旧字幕', visual: '旧镜头', duration: 6 };
async function setup(t, { native = true } = {}) {
  const base = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(base, { recursive: true });
  const dataDir = await mkdtemp(path.join(base, 'gx-project-links-'));
  t.after(async () => { assert.equal(path.dirname(dataDir), base); await rm(dataDir, { recursive: true, force: true }); });
  const store = await createProjectStore(dataDir);
  await store.save('source-doc', { kind: 'writing', title: '来源', source: { text: '已确认原文' }, outputs: { video: { shots: [shot] } } });
  await store.save('target-video', { kind: 'video', title: '剪辑', video: { script: shot.narration, openfilmDraftCaptions: [{ start: 0, end: 6, text: shot.caption }] } });
  const directory = path.join(dataDir, 'openfilm', 'projects', 'target-video');
  const film = path.join(directory, 'film.html');
  if (native) { await mkdir(directory, { recursive: true }); await writeFile(film, 'manual timeline stays byte-for-byte unchanged'); }
  const service = await createProjectLinkService({ dataDir, store }); t.after(() => service.close());
  await service.bind('target-video', { sourceProjectId: 'source-doc' });
  const updateSource = async patch => { const source = await store.read('source-doc'); Object.assign(source.outputs.video.shots[0], patch); await store.save(source.id, source); };
  return { dataDir, store, service, updateSource, film };
}
const request = (state, selectedIds, extra = {}) => ({ sourceHash: state.sourceHash, targetHash: state.targetHash, revision: state.revision, selectedIds, ...extra });

test('source snapshots use the current video draft and track its updates without rewriting older channel outputs', async t => {
  const { service, store, film } = await setup(t);
  const source = await store.read('source-doc');
  source.outputs.article = { title: '独立文章', body: '文章渠道正文' };
  source.writing = { draft: { channel: 'video', output: { title: '当前分镜', shots: [{ narration: '当前旁白', caption: '当前字幕', visual: '当前画面', duration: 3 }] } } };
  await store.save(source.id, source);
  const before = await store.read(source.id), current = await service.preview(source.id);
  assert.equal(current.storyboard[0].narration, '当前旁白'); assert.equal(current.storyboard[0].duration, 3); assert.equal(current.body, '文章渠道正文');
  await service.bind('target-video', { sourceProjectId: source.id });
  const updated = await store.read(source.id); updated.writing.draft.output.shots[0].narration = '新当前旁白'; await store.save(updated.id, updated);
  const changed = await service.status('target-video'); assert.ok(changed.changes.some(change => change.id === '0:narration' && change.after === '新当前旁白'));
  assert.deepEqual((await store.read(source.id)).outputs, before.outputs); assert.equal(await readFile(film, 'utf8'), 'manual timeline stays byte-for-byte unchanged');
});

test('article snapshots follow the current article body while retaining the video channel and read-only source contents', async t => {
  const { service, store } = await setup(t);
  const source = await store.read('source-doc'); source.outputs.article = { title: '旧文章', body: '旧文章正文' };
  source.writing = { draft: { channel: 'article', output: { title: '当前文章', body: '当前文章正文' } } }; await store.save(source.id, source);
  const before = await store.read(source.id), current = await service.preview(source.id);
  assert.equal(current.body, '当前文章正文'); assert.equal(current.storyboard[0].narration, shot.narration); assert.deepEqual(await store.read(source.id), before);
  await service.bind('target-video', { sourceProjectId: source.id });
  const updated = await store.read(source.id); updated.writing.draft.output.body = '文章最新正文'; await store.save(updated.id, updated);
  const changed = await service.status('target-video'); assert.ok(changed.changes.some(change => change.id === 'source:body' && change.after === '文章最新正文'));
  assert.equal((await store.read(source.id)).outputs.article.body, '旧文章正文');
});

test('other-channel and invalid drafts keep their own outputs, while an empty current video does not revive an older storyboard', async t => {
  const { service, store } = await setup(t);
  const source = await store.read('source-doc'); source.outputs.article = { title: '独立文章', body: '文章渠道正文' };
  source.writing = { draft: { channel: 'social', output: { title: '社群稿', text: '当前社群正文' } } }; await store.save(source.id, source);
  let current = await service.preview(source.id); assert.equal(current.body, '文章渠道正文'); assert.equal(current.storyboard[0].narration, shot.narration);
  source.writing.draft = { channel: 'video', output: [] }; await store.save(source.id, source);
  current = await service.preview(source.id); assert.equal(current.storyboard[0].narration, shot.narration);
  source.writing.draft = { channel: 'video', output: { title: '当前空分镜', shots: [] } }; await store.save(source.id, source);
  current = await service.preview(source.id); assert.deepEqual(current.storyboard, []); assert.equal(current.body, '文章渠道正文');
});
async function importActualScript(t, store, project, script) {
  const code = (await readFile(new URL('../public/openfilm-actions.js', import.meta.url), 'utf8')).replace(/^import .*;\s*$/gm, '').replace('export function createOpenfilmActions', 'function createOpenfilmActions');
  const context = { escapeHtml: String, clone: structuredClone, uid: () => 'script-import-history', toast() {}, window: { addEventListener() {}, removeEventListener() {} } };
  vm.createContext(context); vm.runInContext(code, context);
  const actions = context.createOpenfilmActions({ saveProject: value => store.save(value.id, value), onChanged: async () => {} });
  t.after(() => actions.dispose());
  await actions.importScript(project, script, '实际文案导入');
  return store.read(project.id);
}

test('selected source revisions update drafts and leave film and unchecked storyboards untouched', async t => {
  const { service, store, updateSource, film, dataDir } = await setup(t);
  await updateSource({ narration: '新旁白', caption: '新字幕', visual: '新镜头' });
  const state = await service.status('target-video'); assert.equal(state.status, 'changed');
  const synced = await service.sync('target-video', request(state, ['0:narration', '0:caption']));
  assert.equal(synced.project.video.script, '新旁白'); assert.equal(synced.project.video.openfilmDraftCaptions[0].text, '新字幕');
  assert.ok(synced.changes.some(change => change.id === '0:visual')); assert.equal(synced.timelineChanged, false);
  assert.equal(await readFile(film, 'utf8'), 'manual timeline stays byte-for-byte unchanged');
  const reopened = await createProjectLinkService({ dataDir, store }); t.after(() => reopened.close());
  const pending = await reopened.status('target-video');
  const complete = await reopened.sync('target-video', request(pending, ['0:visual']));
  assert.equal(complete.status, 'in-sync'); assert.equal(complete.project.video.sourceStoryboard[0].visual, '新镜头');
});

test('manual draft conflicts stay intact until explicitly merged', async t => {
  const { service, store, updateSource, film } = await setup(t);
  const target = await store.read('target-video'); target.video.script = '手动改过的旁白'; await store.save(target.id, target);
  await updateSource({ narration: '新版来源旁白' });
  const state = await service.status('target-video');
  const conflict = await service.sync('target-video', request(state, ['0:narration']));
  assert.equal(conflict.project.video.script, '手动改过的旁白'); assert.equal(conflict.conflicts.length, 1);
  const merged = await service.sync('target-video', request(conflict, ['0:narration'], { manualScript: '手动保留前言\n新版来源旁白' }));
  assert.equal(merged.conflicts.length, 0); assert.match(merged.project.video.script, /手动保留前言/);
  assert.equal(await readFile(film, 'utf8'), 'manual timeline stays byte-for-byte unchanged');
});

test('stale source/target comparisons fail and old autosaves cannot undo a new source sync', async t => {
  const { service, store, updateSource } = await setup(t);
  const before = await service.status('target-video'), oldTarget = await store.read('target-video');
  await updateSource({ narration: '新稿一' });
  await assert.rejects(service.sync('target-video', request(before, ['0:narration'])), { code: 'SOURCE_VERSION_CHANGED' });
  const changed = await service.status('target-video');
  const currentTarget = await store.read('target-video'); currentTarget.video.script = '手动稿'; await store.save(currentTarget.id, currentTarget);
  await assert.rejects(service.sync('target-video', request(changed, ['0:narration'])), { code: 'TARGET_DRAFT_CHANGED' });
  const latest = await service.status('target-video');
  await service.sync('target-video', request(latest, ['0:narration'], { manualScript: '新稿一' }));
  oldTarget.note = '旧自动保存仍可保留其它编辑'; await store.save(oldTarget.id, oldTarget);
  const saved = await store.read('target-video'); assert.equal(saved.video.script, '新稿一'); assert.equal(saved.note, oldTarget.note);
});

test('source body review does not change movie drafts and unlink survives an older autosave', async t => {
  const { service, store } = await setup(t);
  const source = await store.read('source-doc'); source.source.text = '更新了原文依据'; await store.save(source.id, source);
  const state = await service.status('target-video'); assert.ok(state.changes.some(change => change.id === 'source:body'));
  const result = await service.sync('target-video', request(state, ['source:body'])); assert.equal(result.project.video.script, shot.narration);
  const stale = await store.read('target-video');
  await service.unlink('target-video'); await store.save(stale.id, stale);
  assert.equal((await service.status('target-video')).status, 'unlinked'); assert.equal((await store.read(stale.id)).sourceProjectId, undefined);
});

test('selected changes preserve manual storyboard fields, extra shots, and narration whitespace', async t => {
  const { service, store, updateSource, film } = await setup(t);
  const target = await store.read('target-video');
  target.video.script = '手动前言\n\n\n旧旁白';
  target.video.sourceStoryboard = [{ ...shot, visual: '手动分镜画面', note: '保留备注' }, { narration: '手动补拍段', caption: '', visual: '手动补拍', duration: 3 }];
  await store.save(target.id, target);
  await updateSource({ narration: '来源新旁白', visual: '来源新画面', duration: 9 });
  const state = await service.status('target-video');
  const result = await service.sync(target.id, request(state, ['0:narration', '0:duration']));
  assert.equal(result.project.video.script, '手动前言\n\n\n来源新旁白');
  assert.equal(result.project.video.sourceStoryboard[0].visual, '手动分镜画面');
  assert.equal(result.project.video.sourceStoryboard[0].note, '保留备注');
  assert.equal(result.project.video.sourceStoryboard[0].duration, 9);
  assert.equal(result.project.video.sourceStoryboard[1].narration, '手动补拍段');
  const conflict = await service.sync(target.id, request(result, ['0:visual']));
  assert.equal(conflict.project.video.sourceStoryboard[0].visual, '手动分镜画面');
  assert.equal(conflict.conflicts.length, 1);
  assert.equal(conflict.conflicts[0].field, 'visual');
  assert.ok(conflict.changes.some(change => change.id === '0:visual'));
  assert.equal(await readFile(film, 'utf8'), 'manual timeline stays byte-for-byte unchanged');
});

test('added and removed source shots update only the selected draft entries', async t => {
  const { service, store } = await setup(t);
  const original = await store.read('source-doc'); original.outputs.video.shots.push({ narration: '新加旁白', caption: '新加字幕', visual: '新加画面', duration: 4 }); await store.save(original.id, original);
  let state = await service.status('target-video');
  let result = await service.sync('target-video', request(state, state.changes.map(change => change.id)));
  assert.equal(result.project.video.sourceStoryboard.length, 2);
  assert.equal(result.project.video.sourceStoryboard[1].visual, '新加画面');
  assert.equal(result.project.video.openfilmDraftCaptions[1].start, 6);
  assert.equal(result.project.video.openfilmDraftCaptions[1].end, 10);
  const source = await store.read('source-doc'); source.outputs.video.shots.pop(); await store.save(source.id, source);
  state = await service.status('target-video'); result = await service.sync('target-video', request(state, state.changes.map(change => change.id)));
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.project.video.sourceStoryboard.length, 1);
  assert.equal(result.project.video.openfilmDraftCaptions.length, 1);
  assert.ok(!result.project.video.script.includes('新加旁白'));
  assert.equal(result.status, 'in-sync');
});

test('source missing, damaged versions, and incomplete generated shots fail without touching the film', async t => {
  const { service, store, dataDir, film } = await setup(t);
  await store.remove('source-doc');
  assert.equal((await service.status('target-video')).status, 'source-missing');
  await store.save('incomplete-source', { kind: 'science', title: '不完整模型草稿', science: { result: { explanation: '科普正文', video: { shots: [null, { narration: '可用旁白' }] } } } });
  assert.equal((await service.bind('target-video', { sourceProjectId: 'incomplete-source' })).status, 'in-sync');
  const filename = path.join(dataDir, 'project-links', 'target-video.json');
  const bytes = await readFile(filename); await writeFile(filename, '{broken');
  await assert.rejects(service.status('target-video'), { code: 'SOURCE_LINK_READ_FAILED' });
  assert.equal(await readFile(filename, 'utf8'), '{broken');
  assert.equal(await readFile(film, 'utf8'), 'manual timeline stays byte-for-byte unchanged');
  await writeFile(filename, bytes);
});

test('full project package restores source version comparisons and later sync to new IDs', async t => {
  const { service, store, dataDir, updateSource } = await setup(t, { native: false });
  await updateSource({ narration: '备份前的新旁白', visual: '备份前的新分镜' });
  const initial = await service.status('target-video');
  await service.sync('target-video', request(initial, ['0:narration']));
  const original = JSON.stringify(await store.read('target-video'));
  const sourceBefore = JSON.stringify(await store.read('source-doc'));
  const bundles = await createProjectBundleService({ dataDir, store }); t.after(() => bundles.close());
  const exported = await bundles.prepareExport('target-video');
  const bytes = await readFile(path.join(dataDir, 'project-bundles', exported.token, 'project.gxproject'));
  const preview = await bundles.receiveImport(Readable.from([bytes]));
  const restored = await bundles.restoreImport(preview.token);
  const status = await service.status(restored.projectId);
  assert.equal(status.sourceProjectId, restored.mapping.projects['source-doc']);
  assert.notEqual(status.sourceProjectId, 'source-doc');
  assert.equal(status.status, 'changed');
  assert.deepEqual(status.changes.map(change => change.id), ['0:visual']);
  const synced = await service.sync(restored.projectId, request(status, ['0:visual']));
  assert.equal(synced.status, 'in-sync');
  assert.equal(synced.project.video.script, '备份前的新旁白');
  assert.equal(synced.project.video.sourceStoryboard[0].visual, '备份前的新分镜');
  assert.equal(JSON.stringify(await store.read('target-video')), original);
  assert.equal(JSON.stringify(await store.read('source-doc')), sourceBefore);
});

test('source draft context supports captions alone, storyboards alone, and no association or empty draft', async t => {
  const { service, store } = await setup(t);
  const captionsOnly = await service.context('target-video');
  assert.equal(captionsOnly.sourceProjectId, 'source-doc');
  assert.equal(captionsOnly.openfilmDraftCaptions[0].text, shot.caption);
  assert.equal(captionsOnly.sourceStoryboard, undefined);
  assert.ok(captionsOnly.version > 0);
  const target = await store.read('target-video');
  target.video.openfilmDraftCaptions = [];
  target.video.sourceStoryboard = [{ narration: '', caption: '', visual: '单独的画面建议', duration: 7, path: 'PRIVATE_PATH', settings: { apiKey: 'PRIVATE_KEY' } }];
  await store.save(target.id, target);
  const storyboardOnly = await service.context(target.id);
  assert.equal(storyboardOnly.sourceStoryboard[0].visual, '单独的画面建议');
  assert.equal(storyboardOnly.openfilmDraftCaptions, undefined);
  assert.ok(!JSON.stringify(storyboardOnly).includes('PRIVATE'));
  await service.unlink(target.id);
  assert.equal(await service.context(target.id), null);
  await store.save('empty-linked-video', { kind: 'video', sourceProjectId: 'source-doc', video: { script: '只有旁白，没有版本草稿', sourceStoryboard: [], openfilmDraftCaptions: [] } });
  assert.equal(await service.context('empty-linked-video'), null);
});

test('syncing only visual duration and caption reaches all three creation prompts while preserving actual film', async t => {
  const { service, updateSource, film } = await setup(t);
  await updateSource({ narration: '未选中的来源新旁白', caption: '已同步的新字幕', visual: '已同步的蓝色器材示意画面', duration: 9 });
  const before = await service.status('target-video');
  const synced = await service.sync('target-video', request(before, ['0:visual', '0:duration', '0:caption']));
  assert.equal(synced.project.video.script, shot.narration);
  const sourceDraft = await service.context('target-video');
  const asset = { id: 'real-project-asset', name: '工程素材.mp4', type: 'video', duration: 30 };
  const sourceAnalysis = { version: 1, items: [{ assetId: asset.id, range: { start: 2, end: 5 }, summary: { kind: 'technical', text: '仅有本地技术检测' }, shots: [], transcript: { status: 'skipped', timing: 'none', segments: [] }, coverage: { sampledFrameCount: 0 }, warnings: [] }] };
  const references = { includeImages: false, items: [{ id: 'reference-only', name: '结构参考', type: 'text', text: '分段介绍', focus: '结构', targetRange: { start: 0, end: 9 } }] };
  for (const task of ['edit-plan', 'edit-assistant', 'animation-plan']) {
    const prompt = buildPrompt(task, { instruction: '按已同步的草稿继续制作', script: synced.project.video.script, sourceDraft, sourceAnalysis, references, ...(task === 'edit-assistant' ? { context: { assets: [asset], timeline: [], duration: 30, mainTrackEditable: true } } : { assets: [asset] }) });
    const sent = JSON.parse(prompt.user), draft = sent['来源文案草稿'];
    assert.equal(draft.sourceStoryboard[0].visual, '已同步的蓝色器材示意画面');
    assert.equal(draft.sourceStoryboard[0].duration, 9);
    assert.equal(draft.openfilmDraftCaptions[0].text, '已同步的新字幕');
    assert.equal(draft.sourceProjectId, 'source-doc');
    assert.equal(draft.version, synced.project.video.sourceSyncRevision);
    assert.ok(!prompt.user.includes('未选中的来源新旁白'));
    assert.equal(sent['项目参考'].items[0].targetRange.end, 9);
    if (task !== 'animation-plan') assert.equal(sent['原素材分析'].items[0].summary.kind, 'technical');
    assert.match(prompt.system, /创作计划.*不是已识别原素材/s);
    assert.match(prompt.system, /不因草稿旧旁白覆盖用户手动合并/);
    assert.match(prompt.system, /不能声称同步草稿已经改过film时间线/);
  }
  assert.equal(await readFile(film, 'utf8'), 'manual timeline stays byte-for-byte unchanged');
});

test('real script import and a legacy imported caption continue through source sync context and AI', async t => {
  const { service, store, updateSource, film } = await setup(t);
  const target = await store.read('target-video'); delete target.video.openfilmDraftCaptions;
  let imported = await importActualScript(t, store, target, { shots: [shot] });
  assert.equal(imported.video.openfilmScriptDraft.source, 'writing-draft');
  assert.equal(imported.video.openfilmScriptDraft.captions[0].text, shot.caption);
  assert.equal(imported.video.openfilmDraftCaptions[0].text, shot.caption, 'New explicit imports initialize the canonical subtitle draft');
  // Keep the older persisted shape to exercise migration even after new imports initialize the canonical field.
  delete imported.video.openfilmDraftCaptions; await store.save(imported.id, imported);
  assert.equal((await service.context(imported.id)).openfilmDraftCaptions[0].text, shot.caption);
  await updateSource({ caption: '导入后更新的字幕' });
  const before = await service.status(imported.id);
  const result = await service.sync(imported.id, request(before, ['0:caption']));
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.project.video.openfilmDraftCaptions[0].text, '导入后更新的字幕');
  assert.equal(result.project.video.openfilmScriptDraft.captions[0].text, shot.caption, 'Historical import evidence stays intact after canonical migration');
  const sourceDraft = await service.context(imported.id);
  assert.equal(sourceDraft.openfilmDraftCaptions[0].text, '导入后更新的字幕');
  const prompt = buildPrompt('edit-assistant', { instruction: '按更新后的字幕安排画面', script: result.project.video.script, sourceDraft, context: { assets: [], timeline: [], duration: 6, mainTrackEditable: true } });
  assert.equal(JSON.parse(prompt.user)['来源文案草稿'].openfilmDraftCaptions[0].text, '导入后更新的字幕');
  assert.equal(await readFile(film, 'utf8'), 'manual timeline stays byte-for-byte unchanged');
});

test('explicitly removed or manually changed canonical captions never fall back to imported captions', async t => {
  for (const captions of [[], [{ start: 0, end: 6, text: '手动的新字幕' }]]) await t.test(captions.length ? 'manual text' : 'explicit deletion', async t => {
    const { service, store, updateSource } = await setup(t);
    const target = await store.read('target-video');
    target.video.openfilmScriptDraft = { source: 'writing-draft', captions: [{ start: 0, end: 6, text: shot.caption }] };
    target.video.openfilmDraftCaptions = captions;
    await store.save(target.id, target); await updateSource({ caption: '新版来源字幕' });
    const before = await service.status(target.id), result = await service.sync(target.id, request(before, ['0:caption']));
    assert.equal(result.conflicts.length, 1);
    assert.equal(JSON.stringify(result.project.video.openfilmDraftCaptions), JSON.stringify(captions));
    assert.ok(result.changes.some(change => change.id === '0:caption'));
  });
});

test('legacy caption changes participate in optimistic target checks and retain genuine manual conflicts', async t => {
  const { service, store, updateSource } = await setup(t);
  const target = await store.read('target-video'); delete target.video.openfilmDraftCaptions;
  target.video.openfilmScriptDraft = { source: 'writing-draft', captions: [{ start: 0, end: 6, text: shot.caption }] };
  await store.save(target.id, target); await updateSource({ caption: '新版来源字幕' });
  const compared = await service.status(target.id);
  const edited = await store.read(target.id); edited.video.openfilmScriptDraft.captions[0].text = '手动改过的旧格式字幕'; await store.save(edited.id, edited);
  await assert.rejects(service.sync(target.id, request(compared, ['0:caption'])), { code: 'TARGET_DRAFT_CHANGED' });
  const latest = await service.status(target.id), result = await service.sync(target.id, request(latest, ['0:caption']));
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.project.video.openfilmDraftCaptions[0].text, '手动改过的旧格式字幕');
  assert.equal((await service.context(target.id)).openfilmDraftCaptions[0].text, '手动改过的旧格式字幕');
});
