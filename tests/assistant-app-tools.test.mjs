import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { assistantContentHash, createProjectStore } from '../lib/store.mjs';
import { createAssistantAppTools } from '../lib/assistant-app-tools.mjs';
import { buildPrompt, normalizeModelData } from '../lib/prompts.mjs';
import { singleGuideInput, singleGuideFixture } from './fixtures/single-guide.mjs';

const article = body => ({ title: '科普标题', lead: '导语', body, titles: ['另一标题'], arbitraryCode: 'not persisted' });
const scope = { assetIds: ['allowed'], placement: { mode: 'range', start: 1, end: 3, clipIds: ['clip-a'] } };
const nativeContext = () => ({ assets: [{ id: 'allowed', name: '可用.mp4', type: 'video', duration: 10 }, { id: 'unselected', name: '未选.mp4', type: 'video', duration: 10 }], timeline: [{ id: 'clip-a', assetId: 'allowed', start: 0, end: 4, at: 0, speed: 1 }], duration: 4, aspect: '16:9', mainTrackEditable: true, revision: 'native-r1', warnings: [] });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function normalizedAi(factory, calls = []) {
  return async (task, input, settings, options) => {
    calls.push({ task, input: structuredClone(input), settings, options });
    const prepared = buildPrompt(task, input);
    const raw = await factory(task, prepared.payload);
    return { data: normalizeModelData(task, raw, prepared.payload) };
  };
}

async function fixture(t, { kind = 'writing', project: patch = {}, ai, services = {} } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'gx-assistant-app-'));
  const store = await createProjectStore(dataDir);
  const project = await store.save('current-project', { kind, title: '当前项目', description: '原简介', source: { title: '材料', text: '用户原文', url: '' }, outputs: null, ...(kind === 'video' ? { video: { script: '旁白', editScope: scope, timeline: [] } } : {}), ...patch });
  const refs = { revision: 0, items: [] };
  const references = {
    async list() { return structuredClone(refs); },
    async add(_id, item) { refs.items.push({ id: 'ref-' + (refs.items.length + 1), ...structuredClone(item) }); refs.revision++; return structuredClone(refs); },
    async remove(_id, itemId) { refs.items = refs.items.filter(item => item.id !== itemId); refs.revision++; return structuredClone(refs); },
  };
  const adapter = createAssistantAppTools({ store, references, ...services, ...(ai ? { ai } : {}) });
  t.after(async () => { await adapter.close(); await store.settle(); await rm(dataDir, { recursive: true, force: true }); });
  const context = (overrides = {}) => {
    const controller = new AbortController();
    return { projectId: project.id, runId: randomUUID(), callId: randomUUID(), instruction: '请按当前项目资料生成并保存', editScope: kind === 'video' ? scope : undefined, origin: 'http://127.0.0.1:12345', settings: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture-only-not-real', model: 'fixture' }, mode: 'auto', signal: controller.signal, controller, update() {}, ...overrides };
  };
  const call = (name, args, ctx) => {
    const selected = adapter.tools.find(tool => tool.name === name); assert.ok(selected, `Missing tool ${name}`);
    return selected.execute(args || {}, ctx);
  };
  return { dataDir, store, project, adapter, context, call, refs };
}

test('draft_write normalizes real channel schemas, commits null parents and precisely undoes them', async t => {
  const fx = await fixture(t), ctx = fx.context();
  const originalHash = assistantContentHash(fx.project);
  const result = await fx.call('draft_write', { channel: 'article', content: article('真实写入正文') }, ctx);
  const saved = await fx.store.read(fx.project.id);
  assert.equal(saved.outputs.article.body, '真实写入正文'); assert.equal(saved.assistantRevision, 1);
  assert.equal(Object.hasOwn(saved.outputs.article, 'arbitraryCode'), false);
  assert.equal(result.effects[0].changed, true);
  const undone = await fx.adapter.undo({ projectId: saved.id, undoId: result.effects[0].undo.id });
  assert.equal(undone.restored, true); assert.equal(undone.project.outputs, null);
  assert.equal(assistantContentHash(undone.project), originalHash);
  await assert.rejects(fx.adapter.undo({ projectId: saved.id, undoId: result.effects[0].undo.id }), error => error.code === 'ASSISTANT_UNDO_EXPIRED');
  const after = await fx.store.read(saved.id);
  await assert.rejects(fx.call('draft_write', { channel: 'article', content: { title: '缺正文' } }, fx.context()), error => error.code === 'MODEL_FORMAT_ERROR');
  assert.deepEqual(await fx.store.read(saved.id), after);
});

test('same-run receipts are idempotent and multiple real writes undo in reverse order', async t => {
  const fx = await fixture(t), ctx = fx.context(); const initial = assistantContentHash(fx.project);
  const args = { channel: 'article', content: article('第一步草稿') };
  const first = await fx.call('draft_write', args, ctx);
  const repeated = await fx.call('draft_write', structuredClone(args), { ...ctx, callId: randomUUID() });
  assert.deepEqual(first, repeated); assert.equal((await fx.store.read(fx.project.id)).assistantRevision, 1);
  const second = await fx.call('project_update', { title: '第二步标题' }, ctx);
  await assert.rejects(fx.adapter.undo({ projectId: fx.project.id, undoId: first.effects[0].undo.id }), error => error.code === 'ASSISTANT_CONFLICT');
  await fx.adapter.undo({ projectId: fx.project.id, undoId: second.effects[0].undo.id });
  await fx.adapter.undo({ projectId: fx.project.id, undoId: first.effects[0].undo.id });
  const final = await fx.store.read(fx.project.id);
  assert.equal(assistantContentHash(final), initial); assert.equal(final.assistantRevision, 4);
});

test('concurrent user edits permanently conflict a run even after project_read refreshes its information', async t => {
  const fx = await fixture(t), ctx = fx.context();
  await fx.adapter.buildContext(ctx);
  await fx.store.patchMetadata(fx.project.id, { title: '用户并发新标题' });
  await assert.rejects(fx.call('project_update', { description: '过期助手简介' }, ctx), error => error.code === 'ASSISTANT_CONFLICT');
  const read = await fx.call('project_read', {}, ctx); assert.equal(read.data.title, '用户并发新标题');
  await assert.rejects(fx.call('project_update', { title: '不能用读取来重置冲突' }, ctx), error => error.code === 'ASSISTANT_CONFLICT');
  assert.equal((await fx.store.read(fx.project.id)).title, '用户并发新标题');
});

test('ask mode, missing projects and model-supplied project IDs cannot mutate other projects', async t => {
  const fx = await fixture(t);
  await fx.store.save('other-project', { kind: 'writing', title: '其他项目', source: { text: '保留' } });
  await assert.rejects(fx.call('project_update', { title: '不准写' }, fx.context({ mode: 'ask' })), error => error.code === 'ASSISTANT_READ_ONLY');
  await assert.rejects(fx.call('project_update', { title: '无项目' }, fx.context({ projectId: null })), error => error.code === 'ASSISTANT_PROJECT_REQUIRED');
  await assert.rejects(fx.call('project_read', {}, fx.context({ projectId: null })), error => error.code === 'ASSISTANT_PROJECT_REQUIRED');
  assert.equal((await fx.call('project_list', {}, fx.context({ projectId: null }))).data.length, 2);
  await fx.call('project_update', { title: '当前项目允许修改', projectId: 'other-project' }, fx.context());
  assert.equal((await fx.store.read(fx.project.id)).title, '当前项目允许修改');
  assert.equal((await fx.store.read('other-project')).title, '其他项目');
});

test('native_edit uses the initial user range and expected native revision, rejects unselected assets and stale native state', async t => {
  let native = nativeContext(); const applied = [], aiCalls = [], undone = [];
  let outside = false;
  const ai = normalizedAi(() => outside ? { action: 'edit', message: '错误素材', plan: { timeline: [{ assetId: 'unselected', start: 0, end: 2 }] } } : { action: 'edit', message: '添加字幕', plan: { captions: [{ start: 0, end: 1, text: '范围内字幕' }] } }, aiCalls);
  const fx = await fixture(t, { kind: 'video', ai, services: { openFilm: {
    async context() { return structuredClone(native); },
    async applyPlan(...args) { applied.push(args); native.revision = 'native-r2'; return { applied: true, revision: native.revision, undo: { id: 'native-undo' }, duration: 4 }; },
    async undoAssistant(...args) { undone.push(args); return { restored: true }; },
  } } });
  const ctx = fx.context(); await fx.adapter.buildContext(ctx);
  const result = await fx.call('native_edit', { instruction: '只给这个范围添加字幕', editScope: { placement: { mode: 'replace' } } }, ctx);
  assert.equal(applied.length, 1); assert.equal(applied[0][3], 'native-r1');
  assert.deepEqual(applied[0][4], { keepUndo: true, editScope: scope });
  assert.deepEqual(aiCalls[0].input.editScope, scope);
  assert.deepEqual(aiCalls[0].input.context.assets.map(asset => asset.id), ['allowed']);
  await fx.adapter.undo({ projectId: fx.project.id, undoId: result.effects[0].undo.id }, { origin: ctx.origin });
  assert.equal(undone[0][1], 'native-undo');
  outside = true;
  await assert.rejects(fx.call('native_edit', { instruction: '尝试未选素材' }, fx.context()), error => error.code === 'MODEL_ASSET_INVALID');
  assert.equal(applied.length, 1);
  outside = false; const stale = fx.context(); await fx.adapter.buildContext(stale); native.revision = 'user-native-edit';
  await assert.rejects(fx.call('native_edit', { instruction: '已过期' }, stale), error => error.code === 'ASSISTANT_CONFLICT');
  assert.equal(applied.length, 1);
});

test('native_read marks truncated collections unsafe for rebuilding and excludes private media metadata', async t => {
  const native = nativeContext();
  native.assets = Array.from({ length: 101 }, (_, index) => ({ id: 'asset-' + index, name: '素材' + index, type: 'video', duration: 3, path: 'C:/PRIVATE_PATH/media.mp4', url: '/private-media-url' }));
  native.timeline = native.assets.map((asset, index) => ({ id: 'clip-' + index, assetId: asset.id, start: 0, end: 3, at: index * 3, speed: 1 })); native.duration = 303;
  const fx = await fixture(t, { kind: 'video', services: { openFilm: { context: async () => structuredClone(native) } } });
  const result = await fx.call('native_read', {}, fx.context({ editScope: { placement: { mode: 'replace' } } }));
  assert.equal(result.data.assets.length, 100); assert.equal(result.data.mainTrackEditable, false);
  assert.equal(result.data.overviewComplete, false); assert.equal(result.data.assetCount, 101);
  assert.equal(result.data.nextAssetOffset, 100); assert.ok(result.data.warnings.some(warning => warning.includes('native_read')));
  assert.ok(!JSON.stringify(result).includes('PRIVATE_PATH') && !JSON.stringify(result).includes('private-media-url'));
});

test('media_analyze can read the whole current library independently of the editing selection', async t => {
  const calls = [];
  const f = await fixture(t, { kind: 'video', services: {
    openFilm: { context: async () => nativeContext() },
    sourceAnalysis: { async analyze(projectId, input, options) { calls.push({ projectId, input, options }); return { items: [{ assetId: 'allowed', range: { start: 1, end: 3 }, summary: { kind: 'visual-sampled', text: '真实抽样画面结果' }, transcript: { status: 'unavailable', text: '' }, warnings: ['未转写音频'] }], warnings: [] }; } },
  } });
  const ctx = f.context();
  const result = await f.call('media_analyze', { assetIds: ['allowed'] }, ctx);
  assert.deepEqual(calls[0].input.sources, [{ assetId: 'allowed', start: 0, end: 10 }]);
  assert.equal(calls[0].input.options.maxFrames, 3); assert.equal(calls[0].options.signal, ctx.signal);
  assert.match(result.summary, /真实抽样/);
  assert.equal(calls[0].input.options.transcribe, false); assert.equal(result.data.items[0].transcript.status, 'unavailable');
  await f.call('media_analyze', { assetIds: ['unselected'], range: { start: 1, end: 3 } }, ctx);
  assert.deepEqual(calls[1].input.sources, [{ assetId: 'unselected', start: 1, end: 3 }]);
  await assert.rejects(f.call('media_analyze', { assetIds: ['foreign-project'] }, ctx), { code: 'ASSISTANT_MEDIA_SCOPE' });
  assert.equal(calls.length, 2);
});

const sourceProject = () => ({ id: 'source-1', revision: 1, compositionId: 'FreeComposition', inputProps: {} });

test('animation_create compiles free source and waits for completed render before appending with CAS and undo', async t => {
  const events = [], firstPoll = deferred(); let polls = 0;
  const fx = await fixture(t, { kind: 'video', services: {
    openFilm: { context: async () => nativeContext() },
    remotion: {
      generate: async () => { events.push(['source']); return { project: sourceProject() }; },
      inspect: async () => { events.push(['inspect']); return { compositions: [{ id: 'FreeComposition' }] }; },
      start: async () => { events.push(['start']); return { jobId: 'render-1' }; },
      job: async () => { polls++; events.push(['poll', polls]); firstPoll.resolve(); return polls === 1 ? { status: 'running', progress: 0.3 } : { status: 'complete' }; },
      append: async (...args) => { events.push(['append', args]); return { revision: 'native-r2', asset: { id: 'rendered-asset' }, undo: { id: 'animation-native-undo' } }; },
      cancel: async () => { events.push(['cancel']); },
    },
  } });
  const ctx = fx.context({ editScope: { placement: { mode: 'append' } } });
  const pending = fx.call('animation_create', { instruction: '生成标题动画' }, ctx);
  await firstPoll.promise; assert.equal(events.some(event => event[0] === 'append'), false);
  const result = await pending;
  const appended = events.find(event => event[0] === 'append')[1];
  assert.equal(appended[1], 'source-1'); assert.equal(appended[2].expectedNativeRevision, 'native-r1');
  assert.deepEqual(appended[3].editScope, { placement: { mode: 'append' } });
  assert.ok(events.findIndex(event => event[0] === 'inspect') < events.findIndex(event => event[0] === 'start'));
  assert.equal(result.effects[0].jobId, 'render-1'); assert.equal(result.effects[0].undo.kind, 'native');
  assert.equal(events.some(event => event[0] === 'cancel'), false);
});

test('free animation Stop cancels jobs during polling and while render start is awaiting', async t => {
  for (const race of [false, true]) {
    const entered = deferred(), release = deferred(), cancelled = [], appended = [];
    const fx = await fixture(t, { kind: 'video', services: {
      openFilm: { context: async () => nativeContext() },
      remotion: {
        generate: async () => ({ project: sourceProject() }), inspect: async () => ({ compositions: [{ id: 'FreeComposition' }] }),
        start: async () => { if (race) { entered.resolve(); await release.promise; } return { jobId: race ? 'race-render' : 'active-render' }; },
        job: async () => { entered.resolve(); return { status: 'running', progress: 0.1 }; },
        append: async (...args) => { appended.push(args); return {}; },
        cancel: async (projectId, id) => { cancelled.push([id, { projectId }]); },
      },
    } });
    const ctx = fx.context({ editScope: { placement: { mode: 'append' } } });
    const pending = fx.call('animation_create', { instruction: '生成标题动画' }, ctx);
    await entered.promise; ctx.controller.abort(); release.resolve();
    await assert.rejects(pending, error => error.status === 499 || error.name === 'AbortError');
    assert.equal(cancelled.length, 1); assert.equal(cancelled[0][0], race ? 'race-render' : 'active-render');
    assert.equal(cancelled[0][1].projectId, fx.project.id); assert.equal(appended.length, 0);
  }
});

for (const mode of ['fix-then-pass', 'unavailable', 'still-blocking']) test('free source animation handles actual-frame review ' + mode, async t => {
  let generated = 0, rendered = 0, appended = 0; const inputs = [];
  const fx = await fixture(t, { kind: 'video', services: {
    openFilm: { context: async () => nativeContext() },
    remotion: {
      generate: async (_id, args) => { generated++; inputs.push(args); return { project: { ...sourceProject(), revision: generated } }; },
      inspect: async () => ({ compositions: [{ id: 'FreeComposition' }] }),
      review: async () => mode === 'unavailable' ? { status: 'unavailable', verdict: 'unknown', summary: '当前模型不支持图片', issues: [] } : generated === 1 || mode === 'still-blocking' ? { status: 'reviewed', verdict: 'revise', summary: '实际第30帧标题出画', issues: [{ severity: 'blocking', frame: 30, category: 'framing', detail: '标题出画', fix: '收回标题并保留边距' }] } : { status: 'reviewed', verdict: 'pass', summary: '所列帧无阻断问题', issues: [] },
      start: async () => { rendered++; return { jobId: 'rendered' }; }, job: async () => ({ status: 'complete' }),
      append: async () => { appended++; return { revision: 'native-r2', asset: { id: 'asset' }, undo: { id: 'undo' } }; }, cancel: async () => {},
    },
  } });
  const result = await fx.call('animation_create', { instruction: '原创自由动画并加入' }, fx.context({ editScope: { placement: { mode: 'append' } } }));
  if (mode === 'still-blocking') { assert.equal(generated, 3); assert.equal(rendered, 0); assert.equal(appended, 0); assert.match(result.summary, /尚未加入/); }
  else { assert.equal(rendered, 1); assert.equal(appended, 1); if (mode === 'fix-then-pass') { assert.equal(generated, 2); assert.match(inputs[1].diagnostics, /收回标题/); assert.equal(result.data.review.verdict, 'pass'); } else { assert.equal(generated, 1); assert.match(result.summary, /未完成有效视觉复核/); } }
});

test('review forwards targeted composition-time comparisons to the current owned source without a write', async t => {
  const calls = [], requests = [{ kind: 'ending', shotId: 'last-shot', times: [29.15, 29.966], reason: '核对片尾实际淡出' }];
  const fx = await fixture(t, { kind: 'video', services: { remotion: { review: async (...args) => {
    calls.push(args); return { status: 'reviewed', verdict: 'pass', revision: 4, frames: [{ frame: 875 }, { frame: 899 }], summary: '已复核片尾对照。' };
  } } } });
  const ctx = fx.context({ mode: 'ask' }), before = await fx.store.read(fx.project.id);
  const result = await fx.call('remotion_review', { remotionId: 'current-source', expectedRevision: 4, compositionId: 'FreeComposition', samplingRequests: requests }, ctx);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], fx.project.id);
  assert.equal(calls[0][1], 'current-source');
  assert.equal(calls[0][2].expectedRevision, 4);
  assert.deepEqual(calls[0][2].samplingRequests, requests);
  assert.equal(calls[0][2].signal, ctx.signal);
  assert.equal(result.data.frames.at(-1).frame, 899);
  assert.deepEqual(await fx.store.read(fx.project.id), before);
  assert.deepEqual(result.effects || [], []);
});

test('knowledge_generate uses current selected units, live shared profiles and density and stores no profile copies', async t => {
  const input = singleGuideInput(), contextCalls = [], libraryCalls = [], aiCalls = [];
  const selection = { documentId: input.document.documentId, unitIds: ['page1'] };
  const fx = await fixture(t, { kind: 'science', project: { science: { documentSelection: selection, novelConfig: { selectedCharacterId: 'guide', selectedBackgroundId: 'room', interactionDensity: 'dense', instruction: '讲解实验条件' } } }, ai: normalizedAi((_task, payload) => singleGuideFixture(payload), aiCalls), services: {
    scienceDocuments: { context: async (...args) => { contextCalls.push(args); return structuredClone(input.document); }, list: async () => ({ documents: [] }) },
    novelLibrary: { resolveSelection: async (...args) => { libraryCalls.push(args); return { config: structuredClone(input.config), assetCatalog: structuredClone(input.assetCatalog) }; } },
  } });
  const ctx = fx.context(), initial = assistantContentHash(fx.project);
  const result = await fx.call('knowledge_generate', { instruction: '多用问答核对理解' }, ctx);
  assert.deepEqual(structuredClone(contextCalls[0][1]), selection); assert.equal(contextCalls[0][2].signal, ctx.signal);
  assert.deepEqual(libraryCalls[0][0], { characterId: 'guide', backgroundId: 'room' }); assert.equal(libraryCalls.length, 2);
  assert.equal(aiCalls[0].task, 'visual-novel'); assert.equal(aiCalls[0].input.config.interactionDensity, 'dense');
  assert.equal(aiCalls[0].input.config.characters[0].personality, '耐心、严谨');
  const saved = await fx.store.read(fx.project.id), novel = saved.science.novel;
  assert.equal(novel.scenes.length, 1); assert.equal(novel.chapters.length, 1); assert.equal(novel.settings.interactionDensity, 'dense');
  for (const field of ['characters', 'backgrounds', 'configSnapshot']) assert.equal(Object.hasOwn(novel, field), false);
  assert.ok(!JSON.stringify(novel).includes('portrait1'));
  assert.deepEqual(structuredClone(novel.librarySelection), { characterId: 'guide', backgroundId: 'room' });
  await fx.adapter.undo({ projectId: saved.id, undoId: result.effects[0].undo.id });
  assert.equal(assistantContentHash(await fx.store.read(saved.id)), initial);
});

test('web_import really reads and imports each project type and offers precise undo', async t => {
  for (const kind of ['writing', 'video', 'science']) {
    const reads = [], docs = new Map(), removed = [];
    const services = { webTools: { read: async (...args) => { reads.push(args); return { title: '官方网页', url: 'https://real.example/article', text: '真正读取的公开正文', truncated: true }; } }, ...(kind === 'video' ? { openFilm: { context: async () => nativeContext() } } : {}), scienceDocuments: {
      importText: async (_id, data) => { const document = { id: 'new-document', sourceHash: 'doc-source-hash', title: data.title, text: data.text }; docs.set(document.id, document); return { document, duplicate: false }; },
      get: async (_id, id) => docs.get(id), remove: async (_id, id) => { removed.push(id); docs.delete(id); }, list: async () => ({ documents: [...docs.values()] }),
    } };
    const fx = await fixture(t, { kind, services }), ctx = fx.context(), initial = assistantContentHash(fx.project);
    const result = await fx.call('web_import', { url: 'https://real.example/article' }, ctx);
    assert.equal(reads.length, 1); assert.equal(reads[0][1].signal, ctx.signal);
    assert.equal(result.sources[0].url, 'https://real.example/article'); assert.equal(result.effects[0].changed, true);
    assert.equal(result.data.truncated, true); assert.match(result.summary, /仅提取正文前/);
    if (kind === 'writing') assert.match((await fx.store.read(fx.project.id)).source.text, /用户原文[\s\S]*真正读取/);
    if (kind === 'video') { assert.equal(fx.refs.items.length, 1); assert.match(fx.refs.items[0].text, /来源：https:\/\/real.example\/article/); }
    if (kind === 'science') assert.match(docs.get('new-document').text, /真正读取的公开正文/);
    await fx.adapter.undo({ projectId: fx.project.id, undoId: result.effects[0].undo.id });
    if (kind === 'writing') assert.equal(assistantContentHash(await fx.store.read(fx.project.id)), initial);
    if (kind === 'video') assert.equal(fx.refs.items.length, 0);
    if (kind === 'science') assert.deepEqual(removed, ['new-document']);
  }
});

test('an imported science document already selected by the user cannot be deleted by undo', async t => {
  const removed = [];
  const fx = await fixture(t, { kind: 'science', project: { science: {} }, services: {
    webTools: { read: async () => ({ title: '论文', url: 'https://real.example/paper', text: '公开论文正文' }) },
    scienceDocuments: { importText: async () => ({ document: { id: 'selected-doc', sourceHash: 'hash', title: '论文' }, duplicate: false }), remove: async (...args) => { removed.push(args); }, get: async () => ({ sourceHash: 'hash' }) },
  } });
  const result = await fx.call('web_import', { url: 'https://real.example/paper' }, fx.context());
  const project = await fx.store.read(fx.project.id); project.science.documentSelection = { documentId: 'selected-doc', unitIds: ['p1'] }; await fx.store.save(project.id, project);
  await assert.rejects(fx.adapter.undo({ projectId: project.id, undoId: result.effects[0].undo.id }), error => error.code === 'ASSISTANT_UNDO_IN_USE');
  assert.equal(removed.length, 0);
});
