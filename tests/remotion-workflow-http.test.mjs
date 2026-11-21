import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { startServer } from '../server.mjs';

test('real generation endpoint compiles, renders evidence, improves a visible issue and rechecks the saved revision', { timeout: 180000, skip: process.env.GUANGXUAN_TEST_REMOTION_QUALITY !== '1' }, async t => {
  const parent = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(parent, { recursive: true });
  const dataDir = await mkdtemp(path.join(parent, 'gx-quality-workflow-http-'));
  let app, generated = 0, reviewed = 0; const imageHashes = [];
  const ai = async (task, payload, _settings, options = {}) => {
    if (task === 'remotion-project') {
      generated++;
      if (generated === 2) assert.match(payload.diagnostics, /实际采样画面反馈/);
      const color = generated === 1 ? '#163b65' : '#c95832';
      return { data: { title: '自动画面优化验证', entryPoint: 'src/index.tsx', compositionId: 'QualityTest', inputProps: {}, assetIds: [], notes: [], files: [
        { path: 'src/index.tsx', content: `import React from 'react';import{AbsoluteFill,Composition,registerRoot}from'remotion';const Film=()=> <AbsoluteFill style={{background:'${color}',justifyContent:'center',alignItems:'center',color:'white',fontSize:32}}>VISIBLE SUBJECT</AbsoluteFill>;registerRoot(()=> <Composition id="QualityTest" component={Film} width={320} height={180} fps={12} durationInFrames={24}/>);` },
        { path: 'shot-plan.json', content: JSON.stringify({ shots: [{ id: 'hero', start: 0, end: 2, actionEnd: .5, hold: { start: 1, duration: .8 }, qaTimes: [.5, 1, 1.5] }] }) },
      ] } };
    }
    assert.equal(task, 'remotion-review'); reviewed++;
    assert.ok(options.images.length > 0);
    const picture = options.images[0].dataUrl;
    assert.match(picture, /^data:image\/(?:png|jpeg);base64,/);
    imageHashes.push(createHash('sha256').update(picture).digest('hex'));
    return { data: reviewed === 1 ? { verdict: 'revise', summary: '主体色彩区分需要调整。', issues: [{ severity: 'polish', frame: payload.frames[0].frame, category: 'composition', detail: '采样画面需要更明确的主体色彩。', fix: '将主体背景改为暖色，保留文字与时长。' }] } : { verdict: 'pass', summary: '调整后的实际采样画面清楚。', issues: [] } };
  };
  t.after(async () => { await app?.close(); assert.equal(path.dirname(dataDir), parent); await rm(dataDir, { recursive: true, force: true }); });
  app = await startServer({ dataDir, port: 0, remotionDependencies: { ai } });
  const api = async (route, body, method = 'POST') => {
    const response = await fetch(app.url + route, { method, headers: { 'Content-Type': 'application/json', Origin: app.url }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json(); assert.equal(response.ok, true, value.error || route); return value;
  };
  await api('/api/projects/quality-workflow-owner', { kind: 'video', title: '隔离质量工作流', video: { script: '', assets: [], timeline: [], captions: [], aspect: '16:9' }, source: { text: '' } }, 'PUT');
  await api('/api/openfilm/open', { projectId: 'quality-workflow-owner' });
  const result = await api('/api/projects/quality-workflow-owner/remotion/generate', { instruction: '用单一主体做两秒演示，按实际画面反馈改进。', autoImprove: true });
  assert.equal(result.project.revision, 2); assert.equal(result.review.status, 'reviewed'); assert.equal(result.review.verdict, 'pass');
  assert.deepEqual(result.workflow, { generations: 2, compileRepairs: 0, visualRepairs: 1, reviews: 2 });
  assert.equal(generated, 2); assert.equal(reviewed, 2); assert.notEqual(imageHashes[0], imageHashes[1]);
  const frame = await fetch(app.url + result.review.frames[0].url); assert.equal(frame.status, 200); assert.equal(frame.headers.get('content-type'), 'image/png');
  const bytes = Buffer.from(await frame.arrayBuffer()); assert.ok(bytes.length > 100); assert.deepEqual([...bytes.subarray(0, 4)], [137, 80, 78, 71]);
  const context = await api('/api/openfilm/context', { projectId: 'quality-workflow-owner' }); assert.equal(context.timeline.length, 0, 'source generation does not append an unrequested clip');
});
