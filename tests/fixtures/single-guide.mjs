import { defaultNovelConfig } from '../../public/visual-novel-model.js';

export const singleGuideQuote = '对照实验需要只改变待研究的因素，并保持其他条件相同。';
const defaultCitation = () => [{ unitId: 'page1', quote: singleGuideQuote }];

export function singleGuideInput() {
  return {
    document: { documentId: 'document1', title: '实验设计教材', hash: 'fixture-hash', units: [{ id: 'page1', label: '第1页', page: 1, text: singleGuideQuote + '结论需要说明适用条件，不能把类比直接当成真实机制。' }] },
    config: {
      ...defaultNovelConfig(),
      characters: [{ id: 'guide', name: '讲解员', role: '喜爱实验的学生', tone: '亲切简练', personality: '耐心、严谨', color: '#789e9c', portraits: [{ id: 'explain', name: '讲解', assetId: 'portrait1' }, { id: 'think', name: '思考', assetId: 'portrait2' }] }],
      backgrounds: [{ id: 'room', name: '自定义场景', assetId: 'background1', fit: 'cover' }],
      librarySelection: { characterId: 'guide', backgroundId: 'room' },
    },
    assetCatalog: { items: [{ id: 'portrait1', kind: 'portrait' }, { id: 'portrait2', kind: 'portrait' }, { id: 'background1', kind: 'background' }] },
  };
}

export const singleGuideQuestion = (id, count, evidence = defaultCitation()) => ({
  id, prompt: '实验中应怎样安排待研究因素与其他条件？', citations: structuredClone(evidence),
  choices: Array.from({ length: count }, (_, index) => ({ id: 'option-' + index, text: index === 0 ? '只改变待研究因素' : '同时改变额外的条件' + index, correct: index === 0, feedback: index === 0 ? '原文要求保持其他条件相同。' : '这改变了额外条件，与原文要求不符。', citations: structuredClone(evidence) })),
});

export function singleGuideFixture(payload = singleGuideInput()) {
  const character = payload.config.characters.find(item => item.id === payload.config.librarySelection?.characterId || item.id === payload.config.selectedCharacterId) || payload.config.characters[0];
  const background = payload.config.backgrounds.find(item => item.id === payload.config.librarySelection?.backgroundId || item.id === payload.config.selectedBackgroundId) || payload.config.backgrounds[0];
  const explain = character.portraits[0].id, think = character.portraits[1]?.id || explain;
  const unit = payload.document.units[0], evidence = [{ unitId: unit.id, quote: unit.text.slice(0, 29) }];
  const citation = () => structuredClone(evidence);
  return {
    version: 2, title: '一次实验前的对话', logline: '在一处场景中跟随讲解员理解实验设计。', learningGoals: ['理解对照实验的基本条件'],
    chapters: [{ id: 'chapter1', title: '实验设计', sceneId: 'scene1' }],
    scenes: [{ id: 'scene1', chapterId: 'chapter1', title: '一起读教材', backgroundId: background.id, actors: [{ characterId: character.id, poseId: explain, position: 'center' }], lines: [
      { id: 'line1', speakerId: character.id, poseId: explain, text: '我们先读这一段，再把条件写清楚。', kind: 'story', citations: [] },
      { id: 'line2', speakerId: character.id, poseId: think, text: '对照实验需要保持其他条件相同。', kind: 'knowledge', citations: citation(), card: { title: '控制条件', text: '只改变待研究因素，保持其他条件相同。', citations: citation() }, question: singleGuideQuestion('question1', 2, evidence) },
      { id: 'line3', speakerId: character.id, poseId: explain, text: '再比较不同的方案，找出符合原文的一项。', kind: 'story', citations: [], question: singleGuideQuestion('question2', 5, evidence) },
      { id: 'line4', speakerId: null, text: '你记下了这次讨论的要点。', kind: 'story', citations: [] },
    ], choices: [], nextSceneId: null }],
  };
}
