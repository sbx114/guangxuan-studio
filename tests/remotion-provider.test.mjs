import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { connectProvider, listProviderModels, runAi, runStructuredAi } from '../lib/ai.mjs';
import { startServer } from '../server.mjs';

const authored = {
  title: '真实协议源码作品', entryPoint: 'src/index.tsx', compositionId: 'ProviderMotion', inputProps: { label: '实际源码' }, assetIds: [], notes: ['本机协议 fixture，无外部模型调用。'],
  files: [
    { path: 'src/index.tsx', content: "import React from 'react';import {Composition,registerRoot} from 'remotion';import {Motion} from './Motion';registerRoot(()=> <Composition id='ProviderMotion' component={Motion} durationInFrames={30} fps={15} width={320} height={180}/>);" },
    { path: 'src/Motion.tsx', content: "import React from 'react';import {AbsoluteFill,useCurrentFrame} from 'remotion';export const Motion=({label='实际源码'})=>{const frame=useCurrentFrame();return <AbsoluteFill style={{background:'#132a39',color:'#f4ecce',justifyContent:'center',alignItems:'center'}}><svg width={320} height={120}><circle cx={40+frame*6} cy={60} r={20} fill='#4dccbc'/></svg><div>{label}</div></AbsoluteFill>};" },
    { path: 'shot-plan.json', content: JSON.stringify({ concept: '移动主体与稳定标签', shots: [{ id: 'moving-subject', start: 0, end: 2, intent: '展示真实逐帧位移', action: '圆形向右运动', hero: '圆形', hold: '标签全程稳定', transition: '结束' }] }) },
  ],
};
const sourceInput = references => ({ instruction: '编写一段原创逐帧位移动画。', assets: [], ...(references === undefined ? {} : { references }) });
const sourceReference = { title: 'Fixture source reference', source: 'https://example.invalid/reference', summary: '纯文本运动参考', code: '/* plain text reference only */' };
const legacyInput = () => ({ instruction: '给出剪辑建议', context: { assets: [], timeline: [], duration: 0, aspect: '16:9', mainTrackEditable: true }, references: { includeImages: false, items: [{ id: 'text-reference', type: 'text', name: '文字参考', text: '先出现主体，再稳定停留。', focus: '结构', frames: [] }] } });

async function providerFixture(t, options = {}) {
  const requests = [], pending = new Map();
  const provider = http.createServer(async (req, res) => {
    const body = JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString() || '{}');
    requests.push({ path: req.url, body });
    if (Object.hasOwn(options, 'envelope')) {
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(options.envelope)); return;
    }
    if (body.model === 'cancel-source') {
      pending.get(body.model)?.();
      return;
    }
    const answer = JSON.stringify(body.model === 'legacy-reference' ? { action: 'reply', message: '主体先入场，落定后保留阅读时间。' } : authored);
    const truncated = body.model === 'truncated-source';
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url.endsWith('/responses')
      ? { status: truncated ? 'incomplete' : 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: answer }] }] }
      : { choices: [{ finish_reason: truncated ? 'length' : 'stop', message: { content: answer } }] }));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  t.after(async () => { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); });
  return {
    requests,
    settings: (apiStyle, model = 'source-fixture') => ({ baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, model, apiKey: 'fixture-no-user-credential', apiStyle }),
    waitFor(model) { return new Promise(resolve => pending.set(model, resolve)); },
  };
}

for (const [label, invoke] of [
  ['source generation', settings => runAi('remotion-project', sourceInput([]), settings)],
  ['structured assistant', settings => runStructuredAi('只输出JSON。', '测试', settings)],
  ['connection check', settings => connectProvider(settings)],
  ['model list', settings => listProviderModels(settings)],
]) test(`null provider envelope is a typed upstream error for ${label}`, async t => {
  const fixture = await providerFixture(t, { envelope: null });
  await assert.rejects(invoke(fixture.settings('chat')), error => error.name === 'AppError' && error.status === 502 && typeof error.code === 'string');
  assert.equal(fixture.requests.length, 1);
});

test('model list keeps supported top-level array envelopes', async t => {
  const fixture = await providerFixture(t, { envelope: [{ id: 'one' }, { id: 'two' }] });
  const output = await listProviderModels(fixture.settings('chat'));
  assert.deepEqual(output.models, [{ id: 'one' }, { id: 'two' }]);
});

for (const [apiStyle, envelope] of [
  ['chat', { choices: [{ message: { content: [null] } }] }],
  ['responses', { output: [null] }],
]) test(`${apiStyle} null provider content entries report a typed output error`, async t => {
  const fixture = await providerFixture(t, { envelope });
  await assert.rejects(runAi('remotion-project', sourceInput([]), fixture.settings(apiStyle)), error => error.name === 'AppError' && error.status === 502 && typeof error.code === 'string');
});

for (const apiStyle of ['chat', 'responses']) {
  for (const [label, references, expectedCount] of [['omitted', undefined, 0], ['empty', [], 0], ['one source', [sourceReference], 1]]) {
    test(`${apiStyle} source provider preserves successful source with ${label} reference array`, async t => {
      const fixture = await providerFixture(t);
      const output = await runAi('remotion-project', sourceInput(references), fixture.settings(apiStyle));
      assert.deepEqual(output.data.files, authored.files);
      assert.equal(output.data.compositionId, authored.compositionId);
      assert.equal(output.meta.referenceCount, expectedCount);
      assert.equal(output.meta.referenceImageCount, 0);
      assert.equal(fixture.requests.length, 1);
      const request = fixture.requests[0];
      assert.equal(request.path, `/v1/${apiStyle === 'responses' ? 'responses' : 'chat/completions'}`);
      assert.equal(request.body[apiStyle === 'responses' ? 'max_output_tokens' : 'max_tokens'], 16384);
      assert.ok(!JSON.stringify(output).includes('fixture-no-user-credential'));
    });
  }

  test(`${apiStyle} legacy items reference context keeps its count`, async t => {
    const fixture = await providerFixture(t);
    const output = await runAi('edit-assistant', legacyInput(), fixture.settings(apiStyle, 'legacy-reference'));
    assert.equal(output.data.action, 'reply');
    assert.equal(output.meta.referenceCount, 1);
    assert.equal(output.meta.referenceImageCount, 0);
  });

  test(`${apiStyle} cancelled source provider is a typed cancellation`, async t => {
    const fixture = await providerFixture(t), controller = new AbortController();
    const entered = fixture.waitFor('cancel-source');
    const operation = runAi('remotion-project', sourceInput([]), fixture.settings(apiStyle, 'cancel-source'), { signal: controller.signal });
    const assertion = assert.rejects(operation, error => error.name === 'AppError' && error.code === 'REQUEST_CANCELLED' && error.status === 499);
    await entered; controller.abort(); await assertion;
    assert.equal(fixture.requests.length, 1);
  });

  test(`${apiStyle} truncated source provider is rejected before source can be saved`, async t => {
    const fixture = await providerFixture(t);
    await assert.rejects(runAi('remotion-project', sourceInput([]), fixture.settings(apiStyle, 'truncated-source')), error => error.name === 'AppError' && error.code === 'MODEL_OUTPUT_TRUNCATED' && error.status === 502);
    assert.equal(fixture.requests.length, 1);
  });

  test(`${apiStyle} production generate route uses real provider transport and persists source`, { timeout: 60000 }, async t => {
    const fixture = await providerFixture(t), parent = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir());
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(path.join(parent, 'gx-remotion-provider-')), dataDir = path.join(directory, 'data');
    let app;
    t.after(async () => {
      await app?.close();
      assert.equal(path.dirname(directory), parent); assert.ok(path.basename(directory).startsWith('gx-remotion-provider-'));
      await rm(directory, { recursive: true, force: true });
    });
    app = await startServer({ dataDir, port: 0 });
    assert.notEqual(new URL(app.url).port, '4417');
    async function request(route, body, method = body === undefined ? 'GET' : 'POST') {
      const response = await fetch(app.url + route, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
      const value = await response.json();
      assert.equal(response.ok, true, JSON.stringify(value));
      return value;
    }
    const projectId = `provider-${apiStyle}`;
    const owner = (await request(`/api/projects/${projectId}`, { id: projectId, kind: 'video', title: '实际协议工程', video: { timeline: [], captions: [], aspect: '16:9', script: '' }, source: { text: '' }, history: [], runs: [] }, 'PUT')).project;
    const before = await request(`/api/openfilm/context?projectId=${projectId}`);
    assert.deepEqual(before.assets, []); assert.deepEqual(before.timeline, []);
    const generated = await request(`/api/projects/${projectId}/remotion/generate`, { instruction: '用真实Remotion源码设计原创相机运动与圆形逐帧位移动画。', settings: fixture.settings(apiStyle) });
    assert.equal(generated.project.revision, 1); assert.equal(generated.project.ownerCreatedAt, owner.createdAt);
    assert.deepEqual(generated.project.files, authored.files.slice().sort((a, b) => a.path.localeCompare(b.path)));
    const read = await request(`/api/projects/${projectId}/remotion/${generated.project.id}`);
    assert.deepEqual(read.project, generated.project);
    const listed = await request(`/api/projects/${projectId}/remotion`);
    assert.deepEqual(listed.items.map(item => item.id), [generated.project.id]);
    const sourceRoot = path.join(dataDir, 'remotion-projects', projectId, generated.project.id);
    const metadata = JSON.parse(await readFile(path.join(sourceRoot, 'metadata.json'), 'utf8'));
    assert.equal(metadata.revision, 1);
    for (const file of authored.files) assert.equal(await readFile(path.join(sourceRoot, 'revisions', '1', ...file.path.split('/')), 'utf8'), file.content);
    assert.equal(fixture.requests.length, 1);
    const providerRequest = fixture.requests[0].body;
    const sent = JSON.parse(apiStyle === 'responses' ? providerRequest.input : providerRequest.messages[1].content);
    assert.equal(sent.assets.length, 0); assert.ok(Array.isArray(sent.references));
    const after = await request(`/api/openfilm/context?projectId=${projectId}`);
    assert.deepEqual(after.timeline, []);
    if (process.env.GUANGXUAN_TEST_REMOTION === '1') {
      const inspection = await request(`/api/projects/${projectId}/remotion/${generated.project.id}/inspect`, { expectedRevision: 1 });
      assert.equal(inspection.compositions[0].id, authored.compositionId);
      assert.equal(inspection.compositions[0].durationInFrames, 30);
      assert.ok((await readdir(path.join(sourceRoot, 'jobs'))).length > 0);
    }
  });
}
