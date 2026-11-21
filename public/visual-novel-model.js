const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const HEX = /^#[a-f0-9]{6}$/i;
const fail = message => { const error = new Error(message); error.code = 'VISUAL_NOVEL_INVALID'; throw error; };
const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value, label, maximum, optional = false) => {
  if (optional && (value === undefined || value === null)) return '';
  if (typeof value !== 'string' || (!optional && !value.trim()) || value.length > maximum || /\0/.test(value)) fail(label + '格式不正确，最多' + maximum + '字。');
  return value.trim();
};
const id = (value, label) => { if (typeof value !== 'string' || !ID.test(value)) fail(label + '编号不正确。'); return value; };
const list = (value, label, min, max) => { if (!Array.isArray(value) || value.length < min || value.length > max) fail(label + '需要' + min + '至' + max + '项。'); return value; };
const unique = (values, label) => { if (new Set(values).size !== values.length) fail(label + '编号重复。'); };
export const NOVEL_SCHEMA_VERSION = 2;
export const NOVEL_SOURCE_LIMIT = 60000;
export function defaultNovelConfig() {
  return {
    style: 'single-guide', instruction: '', sceneCount: 1, chapterCount: 1, interactionDensity: 'balanced',
    selectedCharacterId: '', selectedBackgroundId: '', characters: [], backgrounds: [],
  };
}

// Match untouched placeholders from the previous release without bundling their content.
const LEGACY_DEFAULT_SIGNATURES = new Set([
  'd47b11c56ce52109', '47f015b6f5823612', '33ca8ac3ae7f0e05',
  '48cd7a4a7d57254a', 'a64f684cc8064ffe', '2be367bdd4fa2603',
]);
function legacyDefaultSignature(value, kind) {
  const exact = (item, fields) => object(item) && Object.keys(item).length === fields.length && fields.every(field => Object.hasOwn(item, field));
  const strings = (item, fields) => fields.every(field => typeof item[field] === 'string');
  if (kind === 'character') {
    const fields = ['id', 'name', 'role', 'color'];
    if (!exact(value, [...fields, 'portraits']) || !strings(value, fields) || !Array.isArray(value.portraits)) return '';
    const poses = [];
    for (const pose of value.portraits) {
      if (!exact(pose, ['id', 'name', 'builtin']) || !strings(pose, ['id', 'name', 'builtin'])) return '';
      poses.push([pose.id, pose.name, pose.builtin]);
    }
    return novelFingerprint([kind, value.id, value.name, value.role, value.color, poses]);
  }
  const fields = ['id', 'name', 'builtin', 'fit'];
  return exact(value, fields) && strings(value, fields) ? novelFingerprint([kind, value.id, value.name, value.builtin, value.fit]) : '';
}
export function removeUnchangedLegacyNovelDefaults(config, { hasWork = true, hasImportedImages = true } = {}) {
  if (hasWork !== false || hasImportedImages !== false || !object(config) || !Array.isArray(config.characters) || !Array.isArray(config.backgrounds)) return config;
  const seen = new WeakSet();
  const hasAsset = value => {
    if (!value || typeof value !== 'object' || seen.has(value)) return false;
    seen.add(value);
    return Object.hasOwn(value, 'assetId') || Object.values(value).some(hasAsset);
  };
  if (hasAsset(config)) return config;
  const characters = config.characters.filter(value => !LEGACY_DEFAULT_SIGNATURES.has(legacyDefaultSignature(value, 'character')));
  const backgrounds = config.backgrounds.filter(value => !LEGACY_DEFAULT_SIGNATURES.has(legacyDefaultSignature(value, 'background')));
  return characters.length === config.characters.length && backgrounds.length === config.backgrounds.length ? config : { ...config, characters, backgrounds };
}

function normalizeConfig(input, assetCatalog) {
  const value = input === undefined ? defaultNovelConfig() : input;
  if (!object(value)) fail('视觉小说设置无效。');
  const assets = new Map((assetCatalog?.items || []).map(asset => [asset.id, asset]));
  const image = (assetId, kind) => {
    id(assetId, '图片');
    if (!assets.has(assetId) || assets.get(assetId).kind !== kind) fail('自定义图片已移除或不在公用素材库中，请重新选择。');
    return assetId;
  };
  const selection = object(value.librarySelection) ? value.librarySelection : {};
  const select = (items, selectedId, label, maximum) => {
    if (!Array.isArray(items) || !items.length) fail('请先从公用素材库选择一个' + label + '。');
    list(items, label + '素材', 1, maximum);
    if (items.some(item => !object(item))) fail(label + '设置无效。');
    unique(items.map(item => id(item.id, label)), label);
    if (selectedId !== undefined && selectedId !== null && selectedId !== '') {
      id(selectedId, '所选' + label);
      const item = items.find(item => item.id === selectedId);
      if (!item) fail('所选' + label + '已不在公用素材库，请重新选择。');
      return item;
    }
    if (items.length !== 1) fail('每次制作请选择一个' + label + '。');
    return items[0];
  };
  const selectedCharacter = select(value.characters, selection.characterId || value.selectedCharacterId, '人物', 256);
  const selectedBackground = select(value.backgrounds, selection.backgroundId || value.selectedBackgroundId, '场景', 256);
  const characters = [selectedCharacter].map(character => {
    if (!object(character)) fail('人物设置无效。');
    if (!Array.isArray(character.portraits) || !character.portraits.length) fail('请为人物添加表情，并导入和选择立绘。');
    const portraits = list(character.portraits, '人物表情', 1, 12).map(portrait => {
      if (!object(portrait)) fail('人物表情无效。');
      const base = { id: id(portrait.id, '表情'), name: text(portrait.name || portrait.id, '表情名称', 40) };
      if (portrait.assetId) return { ...base, assetId: image(portrait.assetId, 'portrait') };
      fail('请为每个人物表情导入并选择立绘。');
    });
    unique(portraits.map(pose => pose.id), '人物表情');
    return { id: id(character.id, '人物'), name: text(character.name, '人物姓名', 40), role: text(character.role || '', '人物人设', 1200, true), tone: text(character.tone || '', '人物语气', 600, true), personality: text(character.personality || '', '人物性格', 600, true), color: HEX.test(character.color || '') ? character.color : '#789e9c', portraits };
  });
  unique(characters.map(character => character.id), '人物');
  const backgrounds = [selectedBackground].map(background => {
    if (!object(background)) fail('场景设置无效。');
    const base = { id: id(background.id, '场景'), name: text(background.name, '场景名称', 60), fit: background.fit === 'contain' ? 'contain' : 'cover' };
    if (background.assetId) return { ...base, assetId: image(background.assetId, 'background') };
    fail('请为每个场景导入并选择背景图片。');
  });
  unique(backgrounds.map(background => background.id), '场景');
  const interactionDensity = value.interactionDensity === undefined ? 'balanced' : value.interactionDensity;
  if (!['sparse', 'balanced', 'dense'].includes(interactionDensity)) fail('互动密度无效，请选择少量、适中或密集。');
  return { style: 'single-guide', instruction: text(value.instruction || '', '创作要求', 3000, true), sceneCount: 1, chapterCount: 1, interactionDensity, selectedCharacterId: characters[0].id, selectedBackgroundId: backgrounds[0].id, librarySelection: { characterId: characters[0].id, backgroundId: backgrounds[0].id }, characters, backgrounds };
}

export function normalizeNovelConfig(input, assetCatalog = { items: [] }) {
  return normalizeConfig(input, assetCatalog);
}

export function novelFingerprint(value) {
  const source = typeof value === 'string' ? value : JSON.stringify(value);
  let first = 2166136261, second = 5381;
  for (let index = 0; index < source.length; index++) { const code = source.charCodeAt(index); first = Math.imul(first ^ code, 16777619); second = Math.imul(second, 33) ^ code; }
  return (first >>> 0).toString(16).padStart(8, '0') + (second >>> 0).toString(16).padStart(8, '0');
}

export function normalizeNovelDocument(input) {
  if (!object(input)) fail('请先导入资料并选择用于创作的页段。');
  const units = list(input.units, '资料单元', 1, 300).map((unit, index) => {
    if (!object(unit)) fail('资料单元无效。');
    return { id: id(unit.id, '资料单元'), label: text(unit.label || '资料' + (index + 1), '资料页段', 160), ...(Number.isInteger(unit.page) && unit.page > 0 ? { page: unit.page } : {}), index: Number.isInteger(unit.index) && unit.index >= 0 ? unit.index : index, text: text(unit.text, '资料正文', NOVEL_SOURCE_LIMIT) };
  });
  unique(units.map(unit => unit.id), '资料单元');
  if (units.reduce((sum, unit) => sum + unit.text.length, 0) > NOVEL_SOURCE_LIMIT) fail('所选资料过长，请减少页段后再生成。');
  return { title: text(input.title || '学习资料', '资料标题', 300), documentId: typeof input.documentId === 'string' && ID.test(input.documentId) ? input.documentId : '', hash: text(input.hash || novelFingerprint(units), '资料版本', 128), sourceType: text(input.sourceType || 'text', '资料类型', 40), units, note: text(input.note || '', '资料说明', 1500, true) };
}

export function normalizeNovelScript(data, input) {
  return normalizeScript(data, input.document, normalizeNovelConfig(input.config, input.assetCatalog));
}

function normalizeScript(data, sourceDocument, config) {
  if (!object(data)) fail('视觉小说脚本不是有效对象。');
  const document = normalizeNovelDocument(sourceDocument), character = config.characters[0], background = config.backgrounds[0];
  const units = new Map(document.units.map(unit => [unit.id, unit]));
  const poseIds = new Set(character.portraits.map(pose => pose.id));
  const normalizeQuote = value => value.replace(/\s+/gu, '');
  const citations = (items, required, location) => {
    if (items === undefined && !required) return [];
    return list(items, location + '的原文依据', required ? 1 : 0, 4).map(citation => {
      if (!object(citation) || !units.has(citation.unitId)) fail(location + '引用了未选择的资料页段。');
      const quote = text(citation.quote, '原文摘录', 600);
      if (normalizeQuote(quote).length < 4 || !normalizeQuote(units.get(citation.unitId).text).includes(normalizeQuote(quote))) fail(location + '的原文摘录未在所选资料中找到，请重新生成或核对摘录。');
      return { unitId: citation.unitId, quote };
    });
  };
  const scenesInput = list(data.scenes, '小说场景', 1, 1), chaptersInput = list(data.chapters, '章节', 1, 1);
  const scene = scenesInput[0], chapter = chaptersInput[0];
  if (!object(scene) || !object(chapter)) fail('小说章节或场景无效。');
  if (scene.backgroundId !== background.id) fail('小说需要使用所选的唯一场景。');
  const actor = list(scene.actors, '登场人物', 1, 1)[0];
  if (!object(actor) || actor.characterId !== character.id || actor.position !== 'center') fail('小说需要且只能让所选人物居中登场。');
  if (!poseIds.has(actor.poseId)) fail('登场人物引用了不存在的表情，请在公用素材库中重新选择。');
  if (scene.nextSceneId != null || (scene.choices !== undefined && (!Array.isArray(scene.choices) || scene.choices.length))) fail('单场景作品请把互动问题放在对话中，不使用场景跳转。');
  if (scene.card != null) fail('请把知识卡放在相应对话的card字段中。');
  let knowledgeCount = 0, quizCount = 0, totalCharacters = 0;
  const countText = (value, label, maximum) => { const result = text(value, label, maximum); totalCharacters += result.length; return result; };
  const lines = list(scene.lines, '场景对话', 1, 180).map((line, lineIndex) => {
    const location = '第' + (lineIndex + 1) + '句';
    if (!object(line) || !['story', 'knowledge'].includes(line.kind)) fail(location + '需要标注过场或知识讲解。');
    if (line.speakerId !== null && line.speakerId !== '' && line.speakerId !== character.id) fail(location + '只能由所选人物或旁白发言。');
    const poseId = line.poseId === undefined ? actor.poseId : line.poseId;
    if (!poseIds.has(poseId)) fail(location + '引用了不存在的人物表情。');
    const knowledge = line.kind === 'knowledge';
    if (knowledge) knowledgeCount++;
    let card, question;
    if (line.card != null) {
      if (!object(line.card)) fail(location + '知识卡片格式无效。');
      card = { title: countText(line.card.title, '知识卡标题', 120), text: countText(line.card.text, '知识卡正文', 2200), citations: citations(line.card.citations, true, location + '知识卡') };
      knowledgeCount++;
    }
    if (line.question != null) {
      if (!object(line.question)) fail(location + '互动问题格式无效。');
      quizCount++;
      const choices = list(line.question.choices, '问题选项', 2, 6).map((choice, index) => {
        if (!object(choice) || typeof choice.correct !== 'boolean') fail(location + '每个选项必须标注是否正确。');
        if (choice.nextSceneId != null) fail('互动问题答题后继续下一句，不使用场景跳转。');
        return { id: choice.id === undefined ? 'choice-' + (index + 1) : id(choice.id, '选项'), text: countText(choice.text, '选项文字', 240), correct: choice.correct, feedback: countText(choice.feedback, '选择反馈', 1200), citations: citations(choice.citations, true, location + '选项反馈') };
      });
      unique(choices.map(choice => choice.id), '问题选项');
      if (choices.filter(choice => choice.correct).length !== 1) fail(location + '知识问题需要且只能有一个正确选项。');
      question = { id: line.question.id === undefined ? 'question-' + (lineIndex + 1) : id(line.question.id, '互动问题'), prompt: countText(line.question.prompt, '问题题干', 1200), citations: citations(line.question.citations, true, location + '问题题干'), choices };
    }
    return { id: line.id === undefined ? 'line-' + (lineIndex + 1) : id(line.id, '对话'), speakerId: line.speakerId || null, poseId, text: countText(line.text, '对话', 1500), kind: line.kind, citations: citations(line.citations, knowledge, location), ...(card ? { card } : {}), ...(question ? { question } : {}) };
  });
  unique(lines.map(line => line.id), '场景对话');
  unique(lines.filter(line => line.question).map(line => line.question.id), '互动问题');
  if (quizCount > 36) fail('互动问题过多，请减少资料范围或降低互动密度。');
  if (totalCharacters > 70000) fail('小说正文过长，请减少资料范围后重新生成。');
  if (!knowledgeCount) fail('视觉小说缺少可核对来源的知识讲解。');
  const sceneId = id(scene.id, '场景'), chapterId = id(chapter.id, '章节');
  if (scene.chapterId !== chapterId || chapter.sceneId !== sceneId) fail('唯一场景与章节归属不一致。');
  const scenes = [{ id: sceneId, chapterId, title: text(scene.title, '场景标题', 120), backgroundId: background.id, actors: [{ characterId: character.id, poseId: actor.poseId, position: 'center' }], lines, choices: [], nextSceneId: null }];
  const chapters = [{ id: chapterId, title: text(chapter.title, '章节标题', 120), sceneId }];
  const title = text(data.title, '小说标题', 120), logline = text(data.logline || '', '故事简介', 1200, true);
  const learningGoals = list(data.learningGoals || [], '学习目标', 1, 6).map(goal => text(goal, '学习目标', 180));
  // Shared profiles stay in the library. Projects retain references and learning text only.
  const value = { version: NOVEL_SCHEMA_VERSION, title, logline, learningGoals, chapters, scenes, librarySelection: { ...config.librarySelection }, settings: { interactionDensity: config.interactionDensity, instruction: config.instruction }, sourceHash: document.hash, documentSnapshot: document, createdAt: new Date().toISOString() };
  value.id = 'novel-' + novelFingerprint([document.hash, title, config.librarySelection, scenes]);
  return value;
}

export function hydratePlayableNovel(novel, resources) {
  if (!object(novel) || novel.version !== NOVEL_SCHEMA_VERSION) fail('此作品使用旧版结构，请按新流程重新生成；原始资料仍可使用。');
  if (!object(novel.librarySelection)) fail('作品缺少公用素材库选择，请重新选择人物和场景后生成。');
  const characterId = id(novel.librarySelection.characterId, '所选人物'), backgroundId = id(novel.librarySelection.backgroundId, '所选场景');
  if (!resources?.config || !resources?.assetCatalog) fail('请先从公用素材库读取作品使用的人物和场景。');
  if (novel.settings != null && !object(novel.settings)) fail('作品阅读设置无效。');
  const config = normalizeNovelConfig({ ...resources.config, interactionDensity: novel.settings?.interactionDensity, instruction: novel.settings?.instruction, librarySelection: { characterId, backgroundId } }, resources.assetCatalog);
  const value = normalizeScript(novel, novel.documentSnapshot, config);
  if (typeof novel.id === 'string' && ID.test(novel.id)) value.id = novel.id;
  if (typeof novel.createdAt === 'string' && novel.createdAt.length <= 40 && Number.isFinite(Date.parse(novel.createdAt))) value.createdAt = novel.createdAt;
  return { ...value, characters: config.characters, backgrounds: config.backgrounds, configSnapshot: config };
}

export function validatePlayableNovel(novel, resources) {
  if (resources) return hydratePlayableNovel(novel, resources);
  // Explicit offline exports may embed the selected profiles. Ordinary project files do not.
  if (object(novel) && Array.isArray(novel.characters) && Array.isArray(novel.backgrounds)) {
    const items = [
      ...novel.characters.flatMap(character => Array.isArray(character?.portraits) ? character.portraits.filter(pose => pose?.assetId).map(pose => ({ id: pose.assetId, kind: 'portrait' })) : []),
      ...novel.backgrounds.filter(background => background?.assetId).map(background => ({ id: background.assetId, kind: 'background' })),
    ];
    return hydratePlayableNovel(novel, { config: { characters: novel.characters, backgrounds: novel.backgrounds }, assetCatalog: { items } });
  }
  return hydratePlayableNovel(novel, resources);
}

export function serializePlayableNovel(novel, resources) {
  const value = validatePlayableNovel(novel, resources);
  const { characters, backgrounds, configSnapshot, ...stored } = value;
  return stored;
}
