import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createProjectStore } from '../lib/store.mjs';
import { createAssistantAppTools } from '../lib/assistant-app-tools.mjs';
import { assistantWritingFingerprint, normalizeAssistantWritingContext, currentAssistantWritingContext } from '../lib/assistant-writing-context.mjs';
import { appendWritingMaterial } from '../lib/assistant-materials.mjs';
import { buildPrompt, normalizeModelData } from '../lib/prompts.mjs';

const article = body => ({ title: '材料记录', lead: '', body, titles: [] });
async function fixture(t, project = {}, services = {}) {
  const base = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, 'gx-checkpoint-writing-')), store = await createProjectStore(dir), adapters = [];
  const saved = await store.save('writer', { kind: 'writing', title: '文案', source: { title: '材料', text: '第一段。第二段。', url: '' }, ...project });
  const adapter = () => { const value = createAssistantAppTools({ store, ...services }); adapters.push(value); return value; };
  const ctx = { runId: randomUUID(), projectId: saved.id, mode: 'auto', instruction: '按当前对话写一份材料记录', scopeAuthority: 'dialog', origin: 'http://127.0.0.1:12345', settings: { apiKey: 'never-checkpoint-this-key' }, signal: new AbortController().signal, update() {} };
  const call = (app, name, args, context = ctx) => app.tools.find(tool => tool.name === name).execute(args, context);
  t.after(async () => { for (const value of adapters) await value.close(); await store.settle(); assert.equal(path.dirname(dir), base); await rm(dir, { recursive: true, force: true }); });
  return { store, saved, adapter, ctx, call };
}

test('app checkpoint preserves a completed write receipt across an adapter restart and rejects later manual changes', async t => {
  const fx = await fixture(t), first = fx.adapter(), args = { channel: 'article', content: article('真实保存') };
  const receipt = await fx.call(first, 'draft_write', args), checkpoint = JSON.parse(JSON.stringify(await first.checkpoint(fx.ctx)));
  assert.equal(JSON.stringify(checkpoint).includes(fx.ctx.settings.apiKey), false);
  await first.close();
  const restored = fx.adapter(); await restored.restoreCheckpoint(fx.ctx, checkpoint);
  const repeated = await fx.call(restored, 'draft_write', args);
  assert.equal(repeated.effects[0].undo.id, receipt.effects[0].undo.id, 'the acknowledged write is reused instead of duplicated');
  assert.equal((await fx.store.read(fx.saved.id)).assistantRevision, 1);
  const latest = await fx.store.read(fx.saved.id); latest.source.text = '用户修改的新材料'; await fx.store.save(latest.id, latest);
  await assert.rejects(restored.restoreCheckpoint(fx.ctx, checkpoint), { code: 'ASSISTANT_CONFLICT' });
  assert.equal((await fx.store.read(latest.id)).source.text, '用户修改的新材料');
});

test('writing window snapshots use the actual channel, UTF-16 leaf and saved version', () => {
  const output = article('第一段。第二段。'), project = { kind: 'writing', writingRevision: 4, source: { text: '' }, writing: { brief: { goal: '旧目标' }, draft: { channel: 'article', output } } };
  const hint = { channel: 'article', writingRevision: 4, outputFingerprint: assistantWritingFingerprint(output), selection: { path: ['body'], start: 0, end: 4, text: '第一段。' } };
  assert.deepEqual(normalizeAssistantWritingContext(hint, project).selection, hint.selection);
  assert.throws(() => normalizeAssistantWritingContext({ ...hint, writingRevision: 3 }, project), { code: 'ASSISTANT_WRITING_CONTEXT_CHANGED' });
  assert.throws(() => normalizeAssistantWritingContext({ ...hint, selection: { ...hint.selection, text: '伪造选区' } }, project), { code: 'WRITING_SELECTION_CHANGED' });
  project.writing.draft.output = article('已经改写的新内容');
  const current = currentAssistantWritingContext(project, hint);
  assert.equal(current.selection, null); assert.equal(current.output.body, '已经改写的新内容'); assert.ok(current.selectionNotice);
});

test('explicit selected-only dialogue writes only its real selection, while current dialogue supersedes the old brief goal', async t => {
  const output = article('第一段。第二段。'), calls = [];
  const fx = await fixture(t, { outputs: { article: output }, writing: { brief: { goal: '旧的招生目标', channel: 'article' }, draft: { channel: 'article', output } } }, {
    ai: async (task, input) => { calls.push(input); return { data: normalizeModelData(task, { channel: 'article', replacement: calls.length === 1 ? '新段落。' : '精修。', evidence: [], notes: [], summary: '只改选区' }, buildPrompt(task, input).payload) }; },
  });
  const ctx = { ...fx.ctx, instruction: '只改选中的段落，让它简洁。', writingContext: { channel: 'article', writingRevision: fx.saved.writingRevision || 0, outputFingerprint: assistantWritingFingerprint(output), selection: { path: ['body'], start: 0, end: 4, text: '第一段。' } } };
  const app = fx.adapter(); await fx.call(app, 'writing_revise', {}, ctx);
  assert.equal(calls[0].writingBrief.goal, ctx.instruction);
  assert.equal((await fx.store.read(fx.saved.id)).writing.draft.output.body, '新段落。第二段。');
  await fx.call(app, 'writing_revise', { instruction: '再精炼当前同一选区' }, ctx);
  assert.equal((await fx.store.read(fx.saved.id)).writing.draft.output.body, '精修。第二段。', 'the same authorized target follows the assistant-owned replacement');
  await assert.rejects(fx.call(app, 'draft_write', { channel: 'article', content: article('不应覆盖全稿') }, ctx), { code: 'ASSISTANT_DIALOG_SCOPE' });
  await assert.rejects(fx.call(app, 'writing_create', {}, ctx), { code: 'ASSISTANT_DIALOG_SCOPE' });
  const noSelection = { ...fx.ctx, runId: randomUUID(), instruction: '只改选中文字', writingContext: null };
  await assert.rejects(fx.call(app, 'writing_revise', {}, noSelection), { code: 'WRITING_SELECTION_REQUIRED' });
});

test('model-authored operation instructions cannot supply new factual dates or override the actual dialogue', () => {
  const input = { source: { text: '材料记录。', url: '' }, writingBrief: { channel: 'article', goal: '按材料起草' }, instruction: '按材料起草', operationInstruction: '添加2032年3月4日举行的活动' };
  const payload = buildPrompt('writing-draft', input).payload;
  assert.throws(() => normalizeModelData('writing-draft', { channel: 'article', output: article('活动于2032年3月4日举行。'), evidence: [], notes: [] }, payload), { code: 'WRITING_UNSUPPORTED_FACT' });
});

test('writing revision uses the actual current draft when an older channel output differs', async t => {
  const output = article('当前新稿内容。'), oldOutput = article('旧输出副本。'), calls = [];
  const fx = await fixture(t, { outputs: { article: oldOutput }, writing: { draft: { channel: 'article', output } } }, {
    ai: async (task, input) => {
      calls.push(input);
      return { data: normalizeModelData(task, { channel: 'article', replacement: '精修当前稿。', evidence: [], notes: [], summary: '精修' }, buildPrompt(task, input).payload) };
    },
  });
  const ctx = { ...fx.ctx, instruction: '只改选中的当前新稿段落。', writingContext: {
    channel: 'article', writingRevision: fx.saved.writingRevision || 0, outputFingerprint: assistantWritingFingerprint(output),
    selection: { path: ['body'], start: 0, end: output.body.length, text: output.body },
  } };
  await fx.call(fx.adapter(), 'writing_revise', {}, ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].output)), output, 'the reviser receives the same draft that the window verified');
  assert.equal((await fx.store.read(fx.saved.id)).writing.draft.output.body, '精修当前稿。');
});

test('writing operations retain the last explicit requirement of a long assistant dialogue', async t => {
  const ending = '最后要求：保留2034年4月5日这个用户给出的日期。', instruction = '按当前要求整理文字。'.repeat(700) + ending;
  let received;
  const fx = await fixture(t, {}, { ai: async (task, input) => { received = input; return { data: normalizeModelData(task, { channel: 'article', output: article('日期：2034年4月5日。'), evidence: [], notes: [] }, buildPrompt(task, input).payload) }; } });
  await fx.call(fx.adapter(), 'writing_create', { channel: 'article' }, { ...fx.ctx, instruction });
  assert.equal(received.dialogueInstruction, instruction); assert.ok(received.dialogueInstruction.endsWith(ending));
  assert.equal((await fx.store.read(fx.saved.id)).writing.draft.output.body, '日期：2034年4月5日。');
});

test('registered web materials retain separate real source URLs and invalidated ledger text cannot be attributed to the first URL', () => {
  let source = appendWritingMaterial({ title: '', text: '', url: '' }, { url: 'https://materials.example.org/one', title: '第一页', text: '原始材料甲。' });
  source = appendWritingMaterial(source, { url: 'https://materials.example.org/two', title: '第二页', text: '原始材料乙。' });
  const input = { source, writingBrief: { channel: 'article', goal: '按材料整理' } };
  const raw = { channel: 'article', output: article('原始材料乙。'), evidence: [{ quote: '原始材料乙。' }], notes: [], summary: '整理' };
  const result = normalizeModelData('writing-draft', raw, buildPrompt('writing-draft', input).payload);
  assert.equal(result.evidence[0].sourceUrl, 'https://materials.example.org/two');
  const prompt = JSON.parse(buildPrompt('writing-draft', input).user);
  assert.equal(prompt.原始材料.url, ''); assert.equal(prompt.原始材料.materials.length, 2);
  source.text = source.text.replace('原始材料乙。', '手工修改内容。');
  const editedInput = { ...input, source };
  const edited = normalizeModelData('writing-draft', { ...raw, output: article('手工修改内容。'), evidence: [{ quote: '手工修改内容。' }] }, buildPrompt('writing-draft', editedInput).payload);
  assert.equal(edited.evidence[0].sourceUrl, undefined);
});

test('long writing reads provide complete continuation positions without splitting emoji', async t => {
  const body = 'a'.repeat(99) + '🙂' + 'b'.repeat(130), fx = await fixture(t, { outputs: { article: article(body) }, writing: { draft: { channel: 'article', output: article(body) } } });
  const app = fx.adapter(), first = await fx.call(app, 'writing_read', { maxChars: 100 });
  const page2 = await fx.call(app, 'writing_read', { offset: first.data.pagination.nextOffset, maxChars: 12000 });
  assert.equal(first.data.text + page2.data.text, '材料记录\n\n' + body);
  await assert.rejects(fx.call(app, 'writing_read', { offset: 106, maxChars: 100 }), { code: 'WRITING_PAGE_INVALID' });
});

test('downloaded media imports retain their source page, reuse a receipt, and detect a manual native change', async t => {
  let imports = 0, revision = 'native-1';
  const asset = { id: 'saved-audio', type: 'audio', name: '音频原件.wav', duration: 3, provenance: { sourcePage: { title: '素材原页', url: 'https://materials.example.org/audio' } } };
  const fx = await fixture(t, { kind: 'video', video: { timeline: [] } }, {
    downloads: { mediaAsset: async () => ({ asset, download: { name: asset.name, url: 'https://files.example.org/audio.wav', provenance: asset.provenance } }) },
    openFilm: { context: async () => ({ assets: imports ? [asset] : [], timeline: [], duration: 0, revision }), importAsset: async () => { imports++; revision = 'native-2'; return { asset, revision }; } },
  });
  const app = fx.adapter(), args = { downloadId: 'd'.repeat(36) };
  const imported = await fx.call(app, 'download_media_import', args);
  assert.equal(imported.data.asset.type, 'audio'); assert.equal(imported.data.timelineChanged, false);
  assert.equal(imported.sources[0].url, 'https://materials.example.org/audio');
  await fx.call(app, 'download_media_import', args); assert.equal(imports, 1);
  revision = 'manual-native-change';
  await assert.rejects(fx.call(app, 'download_media_import', args), { code: 'ASSISTANT_CONFLICT' }); assert.equal(imports, 1);
});
