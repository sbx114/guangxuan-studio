import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVisualNovelPrompt, normalizeVisualNovel } from '../lib/visual-novel.mjs';
import { defaultNovelConfig, normalizeNovelConfig, hydratePlayableNovel, serializePlayableNovel, validatePlayableNovel } from '../public/visual-novel-model.js';

import { singleGuideInput, singleGuideFixture, singleGuideQuestion as question } from './fixtures/single-guide.mjs';
const prepared = () => { const input = singleGuideInput(); return { input, payload: buildVisualNovelPrompt(input).payload }; };
const modelError = error => error.code === 'MODEL_FORMAT_ERROR';

test('single guide defaults fix one chapter and scene without built-in assets or reader/count controls', () => {
  const config = defaultNovelConfig();
  assert.equal(config.sceneCount, 1); assert.equal(config.chapterCount, 1); assert.equal(config.interactionDensity, 'balanced');
  assert.deepEqual(config.characters, []); assert.deepEqual(config.backgrounds, []);
  assert.equal('audience' in config, false); assert.equal('questionCount' in config, false);
  assert.throws(() => normalizeNovelConfig(config), /公用素材库选择一个人物/);
});

test('config chooses one shared profile, keeps persona fields and discards obsolete counts', () => {
  const input = singleGuideInput();
  input.config.characters.push({ id: 'other', name: '未选择的人物' });
  input.config.backgrounds.push({ id: 'other-room', name: '未选择的场景' });
  Object.assign(input.config, { sceneCount: 20, chapterCount: 6, questionCount: 99, audience: '旧读者字段' });
  const config = normalizeNovelConfig(input.config, input.assetCatalog);
  assert.equal(config.characters.length, 1); assert.equal(config.backgrounds.length, 1);
  assert.equal(config.sceneCount, 1); assert.equal(config.chapterCount, 1);
  assert.equal(config.characters[0].role, '喜爱实验的学生'); assert.equal(config.characters[0].tone, '亲切简练'); assert.equal(config.characters[0].personality, '耐心、严谨');
  assert.deepEqual(config.librarySelection, { characterId: 'guide', backgroundId: 'room' });
  assert.equal('questionCount' in config, false); assert.equal('audience' in config, false);
  delete input.config.librarySelection;
  assert.throws(() => normalizeNovelConfig(input.config, input.assetCatalog), /请选择一个人物/);
});

test('generation only accepts trusted library images of the right kind and bounded persona/density', () => {
  for (const change of [
    value => value.assetCatalog.items.shift(),
    value => value.assetCatalog.items[0].kind = 'background',
    value => value.config.characters[0].portraits[0] = { id: 'explain', builtin: 'old-default' },
    value => value.config.characters[0].tone = '字'.repeat(601),
    value => value.config.characters[0].personality = '字'.repeat(601),
    value => value.config.characters[0].role = '字'.repeat(1201),
    value => value.config.interactionDensity = 'unknown',
    value => value.config.librarySelection.characterId = 'missing',
  ]) { const input = singleGuideInput(); change(input); assert.throws(() => buildVisualNovelPrompt(input)); }
});

test('prompt uses one guide and inline sourced questions with density and variable choices', () => {
  for (const density of ['sparse', 'balanced', 'dense']) {
    const input = singleGuideInput(); input.config.interactionDensity = density;
    const prompt = buildVisualNovelPrompt(input);
    assert.equal(prompt.payload.config.interactionDensity, density);
    assert.match(prompt.system, /都必须恰好一项/); assert.match(prompt.system, /line\.question/); assert.match(prompt.system, /2至6项/);
    assert.match(prompt.system, /不能照搬固定题数/); assert.match(prompt.system, /tone（语气）/); assert.match(prompt.user, /耐心、严谨/);
    assert.equal(prompt.payload.document.units.length, 1);
  }
});

test('one actual scene supports several questions with different option counts and line expressions', () => {
  const { payload } = prepared(), novel = normalizeVisualNovel(singleGuideFixture(), payload);
  assert.equal(novel.version, 2); assert.equal(novel.chapters.length, 1); assert.equal(novel.scenes.length, 1);
  const scene = novel.scenes[0];
  assert.equal(scene.actors.length, 1); assert.equal(scene.actors[0].position, 'center'); assert.deepEqual(scene.choices, []); assert.equal(scene.nextSceneId, null);
  assert.deepEqual(scene.lines.filter(line => line.question).map(line => line.question.choices.length), [2, 5]);
  assert.equal(scene.lines[1].poseId, 'think'); assert.equal(scene.lines[1].card.title, '控制条件');
});

test('project stories store library references and source evidence without persona/image snapshots', () => {
  const { payload } = prepared(), data = singleGuideFixture();
  Object.assign(data, { characters: [{ id: 'evil' }], backgrounds: [], configSnapshot: { instruction: 'fake' }, html: '<script>bad()</script>', librarySelection: { characterId: 'evil', backgroundId: 'evil' } });
  data.scenes[0].lines[0].script = 'bad()';
  const novel = normalizeVisualNovel(data, payload);
  assert.deepEqual(novel.librarySelection, { characterId: 'guide', backgroundId: 'room' });
  assert.deepEqual(novel.settings, { interactionDensity: 'balanced', instruction: '' });
  assert.equal(novel.documentSnapshot.units[0].text, payload.document.units[0].text);
  for (const field of ['characters', 'backgrounds', 'configSnapshot', 'html']) assert.equal(field in novel, false);
  assert.equal('script' in novel.scenes[0].lines[0], false);
  assert.equal(JSON.stringify(novel).includes('portrait1'), false);
});

test('single-scene validation cannot be bypassed by claiming old version or adding routes/characters', () => {
  const { payload } = prepared();
  for (const change of [
    value => { value.version = 1; value.scenes.push(structuredClone(value.scenes[0])); },
    value => value.chapters.push(structuredClone(value.chapters[0])),
    value => value.scenes[0].actors.push(structuredClone(value.scenes[0].actors[0])),
    value => value.scenes[0].actors[0].position = 'left',
    value => value.scenes[0].actors[0].characterId = 'stranger',
    value => value.scenes[0].backgroundId = 'other-room',
    value => value.scenes[0].nextSceneId = 'scene2',
    value => value.scenes[0].choices = [{ id: 'a' }, { id: 'b' }],
    value => value.chapters[0].sceneId = 'scene2',
    value => value.scenes[0].lines[0].speakerId = 'stranger',
    value => value.scenes[0].lines[0].poseId = 'invented-expression',
    value => value.scenes[0].lines[1].question.choices[0].nextSceneId = 'scene2',
  ]) { const data = singleGuideFixture(); change(data); assert.throws(() => normalizeVisualNovel(data, payload), modelError); }
});

test('source checks cover scientific dialogue, cards, question prompts and every option correction', () => {
  const { payload } = prepared();
  for (const change of [
    value => value.scenes[0].lines[1].citations = [],
    value => value.scenes[0].lines[1].card.citations = [],
    value => value.scenes[0].lines[1].question.citations = [],
    value => value.scenes[0].lines[1].question.choices[1].citations = [],
    value => value.scenes[0].lines[1].question.choices[1].feedback = '',
    value => value.scenes[0].lines[1].question.citations[0].quote = '材料中并不存在的原文',
    value => value.scenes[0].lines[1].question.citations[0].unitId = 'not-selected',
    value => value.scenes[0].lines[1].card.citations[0].quote = '材料中并不存在的原文',
  ]) { const data = singleGuideFixture(); change(data); assert.throws(() => normalizeVisualNovel(data, payload), modelError); }
});

test('questions require two to six choices, unique ids and exactly one correct answer', () => {
  const { payload } = prepared();
  for (const change of [
    value => value.scenes[0].lines[1].question.choices.pop(),
    value => value.scenes[0].lines[1].question = question('q1', 7),
    value => value.scenes[0].lines[1].question.choices[1].correct = true,
    value => value.scenes[0].lines[1].question.choices[0].correct = false,
    value => delete value.scenes[0].lines[1].question.choices[0].correct,
    value => value.scenes[0].lines[1].question.choices[1].id = 'option-0',
    value => value.scenes[0].lines[2].question.id = 'question1',
  ]) { const data = singleGuideFixture(); change(data); assert.throws(() => normalizeVisualNovel(data, payload), modelError); }
  const noQuestions = singleGuideFixture(); for (const line of noQuestions.scenes[0].lines) delete line.question;
  assert.doesNotThrow(() => normalizeVisualNovel(noQuestions, payload));
});

test('hydration uses current shared profiles while serialization removes runtime profiles again', () => {
  const { input, payload } = prepared(), stored = normalizeVisualNovel(singleGuideFixture(), payload);
  input.config.characters[0].name = '公用库的新姓名'; input.config.characters[0].tone = '公用库的新语气';
  const runtime = hydratePlayableNovel(stored, input);
  assert.equal(runtime.characters[0].name, '公用库的新姓名'); assert.equal(runtime.characters[0].tone, '公用库的新语气');
  assert.equal(runtime.id, stored.id); assert.equal(runtime.createdAt, stored.createdAt);
  assert.equal('characters' in stored, false);
  assert.deepEqual(serializePlayableNovel(runtime), stored);
  assert.equal(validatePlayableNovel(runtime).characters[0].name, '公用库的新姓名');
  assert.throws(() => validatePlayableNovel(stored), /公用素材库读取/);
  input.config.characters = [];
  assert.throws(() => hydratePlayableNovel(stored, input), /公用素材库选择一个人物/);
});

test('stored settings cannot inject profile replacements and old stories ask for regeneration', () => {
  const { input, payload } = prepared(), stored = normalizeVisualNovel(singleGuideFixture(), payload);
  stored.settings.characters = [{ id: 'guide', name: '假姓名' }];
  assert.equal(hydratePlayableNovel(stored, input).characters[0].name, '讲解员');
  const old = { ...stored, version: 1 };
  assert.throws(() => validatePlayableNovel(old, input), /旧版结构.*重新生成/);
});
