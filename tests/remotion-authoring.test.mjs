import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, normalizeModelData } from '../lib/prompts.mjs';
const code = 'import React from "react"; import {Composition, registerRoot} from "remotion"; import {Scene} from "./Scene"; registerRoot(()=> <Composition id="Original" component={Scene} durationInFrames={4000} fps={24} width={900} height={900}/>);';
const input = () => ({ instruction: '原创机械结构动画，不套文字卡', aspect: '1:1', assets: [{ assetId: 'image-one', publicPath: 'media/image-one.png', type: 'image', name: '项目图片.png' }] });
const result = () => ({ title: '原创结构', entryPoint: 'src/index.tsx', compositionId: 'Original', inputProps: {}, files: [{ path: 'src/index.tsx', content: code }, { path: 'src/Scene.tsx', content: 'export const Scene=()=> <svg><circle r={40}/></svg>;' }, { path: 'shot-plan.json', content: JSON.stringify({ concept: '结构示意', shots: [{ id: 'one', start: 0, end: 166.67, intent: '说明关系', action: '轨道转动' }] }) }], assetIds: [], notes: ['示意图'] });
const normalize = raw => normalizeModelData('remotion-project', raw, buildPrompt('remotion-project', input()).payload);

test('free source authoring returns actual multi-file TSX without scene or duration schema', () => {
  const prompt = buildPrompt('remotion-project', input()), raw = result(), output = normalize(raw);
  assert.equal(output.files[0].content, code); assert.equal(output.files.length, 3);
  assert.ok(output.files[0].content.includes('4000')); assert.equal(output.scenes, undefined);
  for (const fragment of ['真正的React', 'SVG', 'Canvas', 'GLSL', 'useCurrentFrame', '不是从固定', 'registerRoot']) assert.ok(prompt.system.includes(fragment), fragment);
});
test('source authoring uses only declared assets and preserves full source', () => {
  const raw = result(); raw.assetIds = ['image-one', 'image-one']; assert.deepEqual(normalize(raw).assetIds, ['image-one']);
  raw.assetIds = ['foreign-id']; assert.throws(() => normalize(raw), /未提供/);
});

test('authoring calculates a canvas-specific production ruler and concrete shot choreography without prescribing templates', () => {
  const portrait = buildPrompt('remotion-project', { ...input(), aspect: '9:16' }), wide = buildPrompt('remotion-project', { ...input(), aspect: '16:9' });
  assert.deepEqual(portrait.payload.productionBrief.referenceCanvas.width, 1080); assert.equal(portrait.payload.productionBrief.referenceCanvas.height, 1920);
  assert.equal(wide.payload.productionBrief.referenceCanvas.width, 1920); assert.ok(portrait.payload.productionBrief.safeArea.y > wide.payload.productionBrief.safeArea.y);
  assert.ok(portrait.payload.productionBrief.typography.hero > portrait.payload.productionBrief.typography.narrative); assert.ok(portrait.payload.productionBrief.typography.narrative > portrait.payload.productionBrief.typography.annotation);
  for (const fragment of ['480px', 'layout', 'actionEnd', 'hold:{start,duration}', '共用同一组时间常量', '连续示意可以保持机位', '不是从固定场景类型']) assert.ok(portrait.system.includes(fragment), fragment);
  assert.equal(portrait.payload.productionBrief.scenes, undefined); assert.equal(portrait.payload.instruction, input().instruction);
});
test('UI reference ranges remain creative suggestions and do not hide references outside the suggested placement', () => {
  const prompt = buildPrompt('remotion-project', { ...input(), visualReferences: { includeImages: true, workRange: { start: 10, end: 15 }, items: [
    { id: 'later-style', type: 'video', name: '其它镜头的风格', duration: 40, sourceRange: { start: 2, end: 5 }, targetRange: { start: 25, end: 30 }, aspects: ['composition'], frames: [{ timestamp: 20, label: '实际提供的其它抽样时刻' }] },
  ] } });
  assert.equal(prompt.payload.visualReferences.items.length, 1); assert.equal(prompt.payload.visualReferences.rangeRole, 'advisory');
  const reference = prompt.payload.visualReferences.items[0]; assert.deepEqual(reference.targetRange, { start: 25, end: 30 }); assert.equal(reference.compositionRange, undefined); assert.equal(reference.frames[0].timestamp, 20);
  assert.match(prompt.system, /不是创作许可边界/); assert.match(prompt.system, /本次对话中的明确要求/);
});
test('valid source maps and common project wrappers do not fail on optional presentation metadata', () => {
  const value = normalize({ project: { files: { 'src/index.tsx': code }, assetIds: [] } });
  assert.equal(value.entryPoint, 'src/index.tsx'); assert.equal(value.title, '自由动画'); assert.equal(value.compositionId, '');
  assert.deepEqual(value.files, [{ path: 'src/index.tsx', content: code }]);
});
test('existing source edits may return just changed files without losing the entry', () => {
  const existing = result(), { payload } = buildPrompt('remotion-project', { ...input(), existingProject: existing, diagnostics: 'Scene.tsx:2 缺少闭合标签' });
  const raw = result(); raw.files = [{ path: 'src/Scene.tsx', content: 'export const Scene=()=> <svg/>;' }];
  const output = normalizeModelData('remotion-project', raw, payload);
  assert.equal(output.files.length, 1); assert.equal(output.entryPoint, existing.entryPoint); assert.match(payload.diagnostics, /闭合/);
});
for (const name of ['../outside.tsx', 'C:/secret.ts', '/absolute.tsx', 'src/../../file.tsx', 'src\\file.tsx', '.env.ts', 'index.html', 'script.exe']) test('generated source rejects unsafe path ' + name, () => {
  const raw = result(); raw.files[1].path = name; assert.throws(() => normalize(raw));
});
test('missing entry, duplicate names and excessive props fail before storage', () => {
  let raw = result(); raw.entryPoint = 'missing.tsx'; assert.throws(() => normalize(raw), /缺少入口/);
  raw = result(); raw.files.push({ path: 'src/SCENE.tsx', content: 'duplicate' }); assert.throws(() => normalize(raw), /重复/);
  raw = result(); raw.inputProps = { data: 'x'.repeat(65000) }; assert.throws(() => normalize(raw), /过大/);
});
test('director plans describe original shots without becoming a required rendering template', () => {
  const raw = result(); raw.files = raw.files.filter(file => file.path !== 'shot-plan.json'); assert.equal(normalize(raw).files.length, 2);
  raw.files.push({ path: 'shot-plan.json', content: '{bad json' }); assert.equal(normalize(raw).files.length, 3);
  raw.files[2].content = JSON.stringify({ shots: [{ startFrame: 0, endFrame: 4000 }] }); assert.equal(normalize(raw).files.length, 3);
});
test('editor animation routing delegates creation instead of returning legacy template data', () => {
  const { payload } = buildPrompt('edit-assistant', { instruction: '原创结构动画', script: '', context: { assets: [], timeline: [], duration: 0, aspect: '16:9', mainTrackEditable: true } });
  assert.deepEqual(normalizeModelData('edit-assistant', { action: 'animation', message: '将原创动画工程', animation: { arbitrary: 'discarded' } }, payload), { action: 'animation', message: '将原创动画工程' });
});
