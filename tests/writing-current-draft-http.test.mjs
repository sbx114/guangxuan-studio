import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { startServer } from '../server.mjs';

const material = '用于文案流程回归的实际材料。';
const article = body => ({ title: '当前稿件', lead: '', body, titles: [] });
const social = text => ({ title: '当前社群稿', text, tags: [] });
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t, responder) {
  const parent = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'gx-current-writing-http-')), calls = [], releases = [];
  const provider = http.createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/v1/chat/completions');
      const body = JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString());
      const user = JSON.parse(body.messages.find(message => message.role === 'user').content); calls.push(user);
      const value = await responder(user);
      if (res.destroyed) return;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }));
    } catch { if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }); res.end('{}'); }
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const app = await startServer({ port: 0, dataDir: path.join(directory, 'data') });
  const settings = { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, model: 'current-writing-fixture', apiKey: 'synthetic-current-writing-key', apiStyle: 'chat', timeoutSeconds: 10 };
  t.after(async () => { for (const release of releases) release(); await app.close(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); assert.equal(path.dirname(directory), parent); await rm(directory, { recursive: true, force: true }); });
  async function api(route, body, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(app.url + route, { method, signal: AbortSignal.timeout(15000), ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  }
  async function project(current, cached = current, extraOutputs = {}) {
    const created = await api('/api/projects/current-writing', { kind: 'writing', title: '文案流程', source: { title: '', text: material, url: '' }, facts: [], outputs: { article: cached, ...extraOutputs } }, 'PUT');
    assert.equal(created.status, 200);
    const saved = await api('/api/projects/current-writing', { ...created.data.project, writingRevision: created.data.project.writingRevision || 0, writing: { version: 1, brief: { channel: 'article', goal: '按材料写稿' }, draft: { channel: 'article', output: current, notes: [], evidence: [], summary: '' } } }, 'PUT');
    assert.equal(saved.status, 200); return saved.data.project;
  }
  const ai = (task, p, payload = {}) => api('/api/ai', { task, payload: { projectId: p.id, writingBrief: { channel: 'article', goal: '按材料写稿' }, ...payload }, settings });
  return { api, project, ai, calls, releases };
}
const result = channel => ({ channel, output: channel === 'social' ? social(material) : article(material), evidence: [], notes: [], summary: '完成精修' });

test('ordinary writing revise reads the current stored draft instead of an obsolete channel output', async t => {
  const f = await fixture(t, () => result('article')), current = article('当前新稿'), cached = article('旧副本');
  const p = await f.project(current, cached);
  const response = await f.ai('writing-revise', p, { output: current, quickIntent: 'natural' });
  assert.equal(response.status, 200); assert.deepEqual(f.calls[0].当前稿件, current);
  assert.equal((await f.api('/api/projects/' + p.id)).data.project.writing.draft.output.body, current.body, 'the AI response remains read only before explicit save');
});

test('ordinary writing revise refuses an obsolete output copy before contacting the model', async t => {
  const f = await fixture(t, () => result('article')), cached = article('旧副本');
  const p = await f.project(article('当前新稿'), cached);
  const response = await f.ai('writing-revise', p, { output: cached, quickIntent: 'natural' });
  assert.equal(response.status, 409); assert.equal(response.data.code, 'WRITING_INPUT_CHANGED'); assert.equal(f.calls.length, 0);
});

test('a draft-only edit during ordinary revision marks the late response as a candidate and preserves the manual draft', async t => {
  const arrived = gate(), release = gate(), f = await fixture(t, async () => { arrived.resolve(); await release.promise; return result('article'); }); f.releases.push(release.resolve);
  const original = article('原稿'), p = await f.project(original), pending = f.ai('writing-revise', p, { output: original, quickIntent: 'natural' });
  await arrived.promise;
  const edited = structuredClone(p); edited.writing.draft.output = article('人工保留的新稿');
  assert.equal((await f.api('/api/projects/' + p.id, edited, 'PUT')).status, 200);
  release.resolve(); const response = await pending;
  assert.equal(response.status, 200); assert.equal(response.data.meta.inputChanged, true);
  const stored = (await f.api('/api/projects/' + p.id)).data.project;
  assert.equal(stored.writing.draft.output.body, '人工保留的新稿'); assert.equal(stored.outputs.article.body, original.body);
});

test('a writing brief change during generation also keeps the late draft as a candidate', async t => {
  const arrived = gate(), release = gate(), f = await fixture(t, async () => { arrived.resolve(); await release.promise; return result('article'); }); f.releases.push(release.resolve);
  const p = await f.project(article('当前稿')), pending = f.ai('writing-draft', p);
  await arrived.promise;
  const edited = structuredClone(p); edited.writing.brief.goal = '后来保存的新目标';
  assert.equal((await f.api('/api/projects/' + p.id, edited, 'PUT')).status, 200);
  release.resolve(); const response = await pending;
  assert.equal(response.status, 200); assert.equal(response.data.meta.inputChanged, true);
  assert.equal((await f.api('/api/projects/' + p.id)).data.project.writing.brief.goal, edited.writing.brief.goal);
});

test('an explicit other-channel revision uses its own stored output without borrowing the active draft', async t => {
  const f = await fixture(t, () => result('social')), currentSocial = social('保留的社群稿'), p = await f.project(article('当前文章'), article('旧文章'), { social: currentSocial });
  const response = await f.ai('writing-revise', p, { writingBrief: { channel: 'social' }, output: currentSocial, quickIntent: 'natural' });
  assert.equal(response.status, 200); assert.deepEqual(f.calls[0].当前稿件, currentSocial);
  assert.equal((await f.api('/api/projects/' + p.id)).data.project.writing.draft.channel, 'article');
});
