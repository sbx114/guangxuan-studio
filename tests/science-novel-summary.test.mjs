import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeProject } from '../lib/store.mjs';
test('science archive summaries include adopted visual-novel output without counting original documents or discarded drafts', () => {
  const novel = { title: '校园', logline: '讨论', learningGoals: ['理解'], characters: [{ name: '学姐', role: '不计设置' }], chapters: [{ title: '章节' }], scenes: [{ title: '研究室', lines: [{ text: '先看原文', citations: [{ quote: '不计引用快照' }] }], card: { title: '知识卡', text: '适用条件' }, choices: [{ text: '选项', feedback: '纠错' }] }], documentSnapshot: { text: '不计整本教材' } };
  const summary = summarizeProject({ id: 'science', title: '项目', kind: 'science', source: { text: '不计源文件' }, science: { novel, pendingNovel: { title: '不计未采用' }, novelDraft: '不计草稿', novelHistory: [{ novel }] } });
  const visible = ['校园','讨论','理解','学姐','章节','研究室','先看原文','知识卡','适用条件','选项','纠错'].join('');
  assert.equal(summary.outputCount, 1); assert.equal(summary.wordCount, Array.from(visible).length);
});
test('single-scene summaries count inline knowledge and variable-choice feedback without source snapshots', () => {
  const novel = { title: '讲解', scenes: [{ title: '课堂', lines: [{ text: '正文', card: { title: '卡片', text: '条件' }, question: { prompt: '为何', choices: [{ text: '甲', feedback: '解释甲' }, { text: '乙', feedback: '解释乙' }, { text: '丙', feedback: '解释丙' }] }, citations: [{ quote: '不计原文摘录' }] }], choices: [] }], documentSnapshot: { text: '不计教材' } };
  const summary = summarizeProject({ id: 'single', title: '项目', kind: 'science', science: { novel } });
  assert.equal(summary.wordCount, Array.from('讲解课堂正文卡片条件为何甲解释甲乙解释乙丙解释丙').length);
  assert.equal(summary.outputCount, 1);
});
