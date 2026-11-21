import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVisualNovelPrompt, normalizeVisualNovel } from '../lib/visual-novel.mjs';
import { normalizeNovelConfig, validatePlayableNovel } from '../public/visual-novel-model.js';
import { singleGuideInput as input, singleGuideFixture as novelFixture, singleGuideQuote as quote } from './fixtures/single-guide.mjs';

test('visual novel prompts retain only chosen source units and registered shared assets', () => {
  const original = input(), prompt = buildVisualNovelPrompt(original), portraitAssetId = original.config.characters[0].portraits[0].assetId;
  assert.equal(prompt.payload.document.units.length, 1); assert.ok(prompt.user.includes(quote)); assert.match(prompt.system, /不得发明/); assert.match(prompt.system, /Galgame/);
  const config = structuredClone(original.config);
  assert.throws(() => normalizeNovelConfig(config, { items: original.assetCatalog.items.filter(asset => asset.id !== portraitAssetId) }), /不在公用素材库/);
  assert.doesNotThrow(() => normalizeNovelConfig(config, original.assetCatalog));
  assert.throws(() => normalizeNovelConfig(config, { items: original.assetCatalog.items.map(asset => asset.id === portraitAssetId ? { ...asset, kind: 'background' } : asset) }), /不在公用素材库/);
  assert.throws(() => buildVisualNovelPrompt({ ...original, document: { ...original.document, units: [{ id: 'big', text: '字'.repeat(60001) }] } }), /正文/);
});

test('visual novel output carries a bounded source snapshot and strips model code and profile copies', () => {
  const source = input(), payload = buildVisualNovelPrompt(source).payload, data = novelFixture(payload);
  data.html = '<script>alert(1)</script>'; data.characters = [{ id: 'evil', name: 'not registered' }]; data.scenes[0].url = 'https://invalid.example/'; data.scenes[0].lines[0].script = 'do not run';
  const novel = normalizeVisualNovel(data, payload);
  assert.equal(novel.librarySelection.characterId, 'guide'); assert.equal(novel.documentSnapshot.units[0].text, source.document.units[0].text); assert.equal(novel.sourceHash, payload.document.hash);
  for (const field of ['html', 'characters', 'backgrounds', 'configSnapshot']) assert.equal(field in novel, false);
  assert.equal('url' in novel.scenes[0], false); assert.equal('script' in novel.scenes[0].lines[0], false);
  assert.equal(validatePlayableNovel(novel, payload).id, novel.id);
  assert.equal('characters' in novel, false, 'Reading does not add resource snapshots to the stored object.');
});

test('visual novel rejects invented quotes, unknown sources, actors, poses and backgrounds', () => {
  const payload = buildVisualNovelPrompt(input()).payload;
  for (const mutation of [
    value => value.scenes[0].lines[1].citations[0].quote = '没有出现在教材中的结论',
    value => value.scenes[0].lines[1].citations[0].unitId = 'not-selected',
    value => value.scenes[0].actors[0].characterId = 'unknown',
    value => value.scenes[0].actors[0].poseId = 'unknown',
    value => value.scenes[0].backgroundId = 'https://outside.invalid/',
    value => value.scenes[0].lines[1].citations = [],
    value => value.scenes[0].lines[1].poseId = 'unknown-expression',
  ]) { const value = novelFixture(payload); mutation(value); assert.throws(() => normalizeVisualNovel(value, payload), error => error.code === 'MODEL_FORMAT_ERROR'); }
});

test('single-scene questions reject routes and require unique correct answers with sourced correction', () => {
  const payload = buildVisualNovelPrompt(input()).payload;
  for (const mutation of [
    value => value.scenes[0].nextSceneId = 'scene1',
    value => value.scenes[0].nextSceneId = 'missing',
    value => value.scenes[0].lines[1].question.choices[0].nextSceneId = 'scene1',
    value => value.scenes[0].lines[1].question.choices[1].correct = true,
    value => value.scenes[0].lines[1].question.choices[1].feedback = '',
    value => value.scenes[0].lines[1].question.choices[1].citations = [],
    value => value.scenes[0].lines[1].question.citations = [],
    value => value.chapters[0].sceneId = 'missing',
  ]) { const value = novelFixture(payload); mutation(value); assert.throws(() => normalizeVisualNovel(value, payload), error => error.code === 'MODEL_FORMAT_ERROR'); }
});
