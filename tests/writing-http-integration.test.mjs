import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { startServer } from '../server.mjs';
import { makeZip } from '../lib/documents.mjs';

const KEY = 'fixture-writing-http-not-a-user-key';
const source = { title: '木桥共读', text: '木桥共读会定于2026年11月25日举行，暂定30人参加。报名方式稍后公布。', url: '' };
const sample = 'STYLE_ONLY_PRIVATE_SAMPLE：星辰公司2028年获得全国一等奖。';
const prefs = { voice: '自然、直接，像对熟人说话', identity: '活动组织者', styleSample: sample, avoidWords: '赋能，重磅', preferredTerms: '共读，伙伴' };
const cases = [], requests = [];
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const article = body => ({ title: '一起共读', lead: '把事情说明白。', body, titles: [] });
function modelResult(channel = 'article', body = source.text, evidence = [{ quote: source.text }]) {
  return { channel, output: channel === 'social' ? { title: '一起共读', text: body, tags: ['共读'] } : article(body), evidence, notes: ['报名方式稍后公布。'], summary: '完成当前稿。' };
}
async function fixture(t, responder) {
  const parent = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'gx-writing-http-')), calls = [];
  const provider = http.createServer(async (req, res) => {
    try {
      assert.equal(req.method, 'POST'); assert.equal(req.url, '/v1/chat/completions'); assert.equal(req.headers.authorization, 'Bearer ' + KEY);
      const body = JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString());
      const user = JSON.parse(body.messages.find(message => message.role === 'user').content);
      const call = { body, user }; calls.push(call); requests.push({ path: req.url, styleSampleDelivered: user.个人表达偏好?.styleSample === sample });
      const result = await responder(call, calls.length);
      if (res.destroyed) return;
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }], usage: { prompt_tokens: 20, completion_tokens: 20 } }));
    } catch { if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }); res.end('{}'); }
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const app = await startServer({ port: 0, dataDir: path.join(directory, 'data') }); assert.notEqual(new URL(app.url).port, '4417');
  const settings = { baseUrl: 'http://127.0.0.1:' + provider.address().port + '/v1', model: 'writing-fixture', apiKey: KEY, apiStyle: 'chat', timeoutSeconds: 10 };
  const release = [];
  t.after(async () => {
    for (const action of release) action(); await app.close(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
    const resolved = path.resolve(directory); assert.equal(path.dirname(resolved), parent); assert.ok(path.basename(resolved).startsWith('gx-writing-http-')); await rm(resolved, { recursive: true, force: true });
  });
  async function api(route, body, { method = body === undefined ? 'GET' : 'POST', status = 200 } = {}) {
    const response = await fetch(app.url + route, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
    const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value;
  }
  async function create(id = 'writing-http') { return (await api('/api/projects/' + id, { kind: 'writing', title: '旧稿兼容', source, brief: { audience: '旧项目受众' }, facts: [], outputs: { poster: { title: '保留旧海报', subtitle: '', highlights: [], details: [], footer: '' } }, history: [{ id: 'legacy-history', label: '旧历史保留', outputs: { social: { title: '旧稿', text: '原先文字', tags: [] } } }], runs: [{ id: 'legacy-run', task: 'generate', prompt: { user: 'LEGACY_PROMPT_MARKER' } }] }, { method: 'PUT' })).project; }
  const ai = (task, payload) => api('/api/ai', { task, payload, settings });
  return { directory, app, calls, settings, release, api, create, ai };
}

test('real writing HTTP uses stored material, carries personal style separately, returns one channel and strips style-only evidence', async t => {
  const f = await fixture(t, () => modelResult('social', source.text, [{ quote: source.text }, { quote: '星辰公司2028年获得全国一等奖。' }]));
  const project = await f.create();
  const result = await f.ai('writing-draft', { projectId: project.id, source: { text: 'EVIL_SOURCE_MARKER：范文奖项当材料' }, writingBrief: { goal: '写一份社群邀请', channel: 'auto', audience: 'auto', scenario: 'auto' }, writingPreferences: prefs });
  assert.equal(result.data.channel, 'social'); assert.equal(result.data.output.text, source.text); assert.equal(result.data.evidence.length, 1); assert.equal(result.data.evidence[0].quote, source.text); assert.ok(result.data.notes.some(value => value.includes('已移除')));
  assert.equal(f.calls[0].user.原始材料.text, source.text); assert.equal(f.calls[0].user.个人表达偏好.styleSample, sample); assert.equal(f.calls[0].user.本次写作需求.audience, 'auto'); assert.doesNotMatch(result.prompt.user, /EVIL_SOURCE_MARKER|学院师生/);
  assert.match(f.calls[0].body.messages[0].content, /范文/); assert.match(f.calls[0].body.messages[0].content, /不能|不可|不把/);
  const unchanged = (await f.api('/api/projects/' + project.id)).project; assert.deepEqual(unchanged, project, 'AI return is read only');
  const saved = (await f.api('/api/projects/' + project.id, { ...project, writingRevision: 0, outputs: { ...project.outputs, social: result.data.output }, writing: { version: 1, draft: result.data, brief: { channel: 'auto' } } }, { method: 'PUT' })).project;
  assert.equal(saved.writingRevision, 1); assert.equal(saved.outputs.poster.title, '保留旧海报'); assert.equal(saved.history[0].id, 'legacy-history'); assert.equal(saved.runs[0].id, 'legacy-run'); assert.ok(!JSON.stringify(saved).includes(sample));
  cases.push('stored-source-and-style-isolation-single-channel-legacy-preserved');
});

test('real writing-revise rejects stale input and returns a normalized current-channel revision without replacing other drafts', async t => {
  const f = await fixture(t, () => modelResult('article', '先说重点：' + source.text));
  const legacy = await f.create(), current = article(source.text);
  const project = (await f.api('/api/projects/' + legacy.id, { ...legacy, writingRevision: 0, outputs: { ...legacy.outputs, article: current } }, { method: 'PUT' })).project;
  const result = await f.ai('writing-revise', { projectId: project.id, writingBrief: { channel: 'article', audience: 'auto', scenario: 'auto' }, writingPreferences: prefs, output: current, quickIntent: 'natural' });
  assert.equal(result.data.channel, 'article'); assert.match(result.data.output.body, /^先说重点/); assert.equal(f.calls[0].user.本次调整.quickIntent, 'natural');
  const after = (await f.api('/api/projects/' + project.id)).project; assert.deepEqual(after.outputs.article, current); assert.equal(after.outputs.poster.title, '保留旧海报');
  await f.api('/api/ai', { task: 'writing-revise', payload: { projectId: project.id, writingBrief: { channel: 'article' }, output: article('被替换的旧稿'), quickIntent: 'natural' }, settings: f.settings }, { status: 409 }); assert.equal(f.calls.length, 1);
  cases.push('current-channel-revise-and-stale-input-rejected');
});

test('an in-flight result becomes a read-only candidate after human edits and stale save CAS cannot overwrite the human draft', async t => {
  const arrived = deferred(), release = deferred();
  const f = await fixture(t, async () => { arrived.resolve(); await release.promise; return modelResult('article', source.text); }); f.release.push(release.resolve);
  const legacy = await f.create(), project = (await f.api('/api/projects/' + legacy.id, { ...legacy, writingRevision: 0, outputs: { ...legacy.outputs, article: article(source.text) } }, { method: 'PUT' })).project;
  const pending = f.ai('writing-revise', { projectId: project.id, writingBrief: { channel: 'article' }, output: project.outputs.article, quickIntent: 'natural' });
  await arrived.promise;
  const edited = (await f.api('/api/projects/' + project.id, { ...project, outputs: { ...project.outputs, article: article('人工保留：' + source.text) } }, { method: 'PUT' })).project;
  release.resolve(); const result = await pending; assert.equal(result.meta.inputChanged, true); assert.equal(result.data.output.body, source.text);
  const failed = await f.api('/api/projects/' + project.id, { ...project, outputs: { ...project.outputs, article: result.data.output } }, { method: 'PUT', status: 409 }); assert.equal(failed.code, 'WRITING_STALE_PROJECT');
  const after = (await f.api('/api/projects/' + project.id)).project; assert.equal(after.outputs.article.body, edited.outputs.article.body); assert.match(after.outputs.article.body, /^人工保留/);
  cases.push('inflight-candidate-and-real-writing-cas-preserve-human-edit');
});

test('a late AI response or writing save cannot recreate a deleted project or attach to a recreated owner', async t => {
  const arrived = deferred(), release = deferred(); const f = await fixture(t, async () => { arrived.resolve(); await release.promise; return modelResult(); }); f.release.push(release.resolve);
  const legacy = await f.create(), project = (await f.api('/api/projects/' + legacy.id, { ...legacy, writingRevision: 0 }, { method: 'PUT' })).project;
  const pending = f.api('/api/ai', { task: 'writing-draft', payload: { projectId: project.id, writingBrief: { channel: 'article' } }, settings: f.settings }, { status: 409 });
  await arrived.promise; await f.api('/api/projects/' + project.id, undefined, { method: 'DELETE' });
  await f.api('/api/projects/' + project.id, project, { method: 'PUT', status: 404 });
  const recreated = (await f.api('/api/projects/' + project.id, { kind: 'writing', title: '新的归属', source: { title: '', text: '新的项目原文', url: '' }, createdAt: new Date(Date.now() + 1000).toISOString(), outputs: null }, { method: 'PUT' })).project;
  release.resolve(); assert.equal((await pending).code, 'WRITING_INPUT_CHANGED');
  const after = (await f.api('/api/projects/' + project.id)).project; assert.equal(after.createdAt, recreated.createdAt); assert.equal(after.outputs, null);
  cases.push('deleted-and-recreated-owner-not-resurrected');
});

test('real writing import preserves 60000-character tails and parses PDF/DOCX locally without using the model', async t => {
  const f = await fixture(t, () => { throw Error('import must never call a model'); }); const project = await f.create();
  const tail = '材料末尾必须完整保留', text = '原'.repeat(60000 - tail.length) + tail;
  const imported = await f.api('/api/writing/import', { name: '完整材料.txt', contentBase64: Buffer.from(text).toString('base64') }); assert.equal(imported.text, text); assert.equal(imported.characterCount, 60000);
  const pdf = await readFile(new URL('./fixtures/science-documents/bilingual-paper.pdf', import.meta.url)); const parsed = await f.api('/api/writing/import', { name: '原文.pdf', contentBase64: pdf.toString('base64') }); assert.equal(parsed.pageCount, 3); assert.match(parsed.text, /力矩等于力/);
  const word = makeZip({ 'word/document.xml': '<w:document xmlns:w="urn:test"><w:body><w:p><w:r><w:t>原始Word材料保持中文。</w:t></w:r></w:p></w:body></w:document>' }); const docx = await f.api('/api/writing/import', { name: '原文.docx', contentBase64: word.toString('base64') }); assert.match(docx.text, /原始Word材料保持中文/);
  const tooLong = await f.api('/api/writing/import', { name: '过长.txt', contentBase64: Buffer.from(text + '超').toString('base64') }, { status: 413 }); assert.equal(tooLong.code, 'WRITING_IMPORT_TOO_LONG');
  assert.equal(f.calls.length, 0); assert.deepEqual((await f.api('/api/projects/' + project.id)).project, project);
  cases.push('real-import-60000-tail-pdf-docx-no-model-no-truncation');
});

after(async () => {
  if (!process.env.GUANGXUAN_WRITING_HTTP_REPORT) return;
  const filename = path.resolve(process.env.GUANGXUAN_WRITING_HTTP_REPORT); await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, JSON.stringify({ status: cases.length === 5 ? 'passed' : 'failed', tests: 5, passed: cases.length, failed: 5 - cases.length, skipped: 0, checks: cases, modelHttpRequests: requests.length, actualApplicationServer: true, actualOpenAiCompatibleHttp: true, externalPaidModelUsed: false, requested4417: false, realDataUsed: false }, null, 2));
});
