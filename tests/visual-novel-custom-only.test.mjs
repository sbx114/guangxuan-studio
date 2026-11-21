import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVisualNovelPrompt, validateVisualNovelPayload, normalizeVisualNovel } from '../lib/visual-novel.mjs';
import { defaultNovelConfig, normalizeNovelConfig, normalizeNovelScript, validatePlayableNovel } from '../public/visual-novel-model.js';
import { singleGuideInput as payload, singleGuideFixture as script } from './fixtures/single-guide.mjs';

test('new visual novels start with no predefined cast, poses or backgrounds', () => {
  const first = defaultNovelConfig(), second = defaultNovelConfig();
  assert.deepEqual(first.characters, []); assert.deepEqual(first.backgrounds, []);
  assert.equal(first.style, 'single-guide'); assert.equal(first.sceneCount, 1); assert.equal(first.chapterCount, 1); assert.equal(first.interactionDensity, 'balanced');
  assert.equal('questionCount' in first, false); assert.equal('audience' in first, false);
  first.characters.push({ id: 'local-draft' });
  assert.deepEqual(second.characters, []);
  assert.throws(() => normalizeNovelConfig(second), /公用素材库选择一个人物/);
});

test('generation requires imported cast and background images with matching shared catalog kinds', () => {
  const input = payload();
  const normalized = normalizeNovelConfig(input.config, input.assetCatalog);
  assert.equal(normalized.characters[0].portraits[0].assetId, 'portrait1');
  assert.equal(normalized.backgrounds[0].assetId, 'background1');
  for (const [change, error] of [
    [value => { value.config.backgrounds = []; }, /公用素材库选择一个场景/],
    [value => { value.config.characters[0].portraits = []; }, /添加表情.*立绘/],
    [value => { delete value.config.characters[0].portraits[0].assetId; value.config.characters[0].portraits[0].builtin = 'neutral'; }, /导入.*立绘/],
    [value => { delete value.config.backgrounds[0].assetId; value.config.backgrounds[0].builtin = 'lab'; }, /导入.*背景图片/],
    [value => { value.assetCatalog.items[0].kind = 'background'; }, /不在公用素材库/],
    [value => { value.assetCatalog.items = []; }, /不在公用素材库/],
  ]) {
    const changed = payload(); change(changed);
    assert.throws(() => validateVisualNovelPayload(changed), error);
  }
  const prompt = buildVisualNovelPrompt(input);
  assert.match(prompt.system, /人物和场景由用户从公用素材库选择/);
  assert.doesNotMatch(prompt.system, /内置/);
});

test('old stories give a clear regeneration message while preserving their saved data and source', () => {
  const input = payload(), original = normalizeVisualNovel(script(input), input);
  const legacy = { ...structuredClone(original), version: 1, characters: structuredClone(input.config.characters), backgrounds: structuredClone(input.config.backgrounds), configSnapshot: structuredClone(input.config) };
  legacy.characters[0].portraits[0] = { id: 'explain', name: '原表情名称', builtin: 'neutral' };
  legacy.backgrounds[0] = { id: 'room', name: '原场景名称', builtin: 'lab', fit: 'cover' };
  legacy.scenes[0].nextSceneId = 'old-scene2';
  legacy.scenes.push({ id: 'old-scene2', chapterId: 'chapter1', title: '旧结尾', backgroundId: 'room', actors: [], lines: [{ id: 'old-line', speakerId: null, text: '你记下了讨论。', kind: 'story', citations: [] }], choices: [], nextSceneId: null });
  const originalBytes = JSON.stringify(legacy);
  for (const resources of [undefined, input]) {
    assert.throws(() => validatePlayableNovel(legacy, resources), error => error.code === 'VISUAL_NOVEL_INVALID' && /旧版结构.*重新生成.*原始资料仍可使用/.test(error.message));
  }
  assert.equal(JSON.stringify(legacy), originalBytes, 'Reading does not rewrite, migrate or delete the saved project.');
  assert.deepEqual(legacy.documentSnapshot, original.documentSnapshot);
  assert.equal(legacy.scenes[0].nextSceneId, 'old-scene2');
  assert.equal(legacy.characters[0].portraits[0].builtin, 'neutral');
});

test('missing-art and legacy compatibility flags cannot relax new generation validation', () => {
  const input = payload();
  delete input.config.characters[0].portraits[0].assetId;
  input.config.characters[0].portraits[0].builtin = 'unknown-preset';
  input.config.allowMissingAssets = true;
  input.allowMissingAssets = true;
  assert.throws(() => normalizeNovelConfig(input.config, input.assetCatalog, true), /导入.*立绘/);
  assert.throws(() => normalizeNovelScript(script(input), input, { allowMissingAssets: true }), /导入.*立绘/);
  assert.throws(() => buildVisualNovelPrompt(input), /导入.*立绘/);
  const complete = payload();
  complete.config.characters[0].portraits[0].builtin = 'ignored';
  complete.config.backgrounds[0].builtin = 'ignored';
  assert.ok(!JSON.stringify(validateVisualNovelPayload(complete).config).includes('builtin'));
});
