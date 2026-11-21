import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, normalizeModelData } from '../lib/prompts.mjs';
import { ensureScienceProject, scienceText, syncScienceOutputs } from '../public/science-workspace.js';

const source = { title: '光纤资料', text: '满足条件时，光可以在光纤中发生全反射。', url: '' };
const facts = [
  { id: 'F1', label: '传播条件', value: '全反射需要满足条件。', quote: '满足条件时', confirmed: true },
  { id: 'F2', label: '待确认结论', value: '未确认内容', confirmed: false },
];
const input = { source, facts, brief: { audience: '高中生', scenario: '科普讲解' } };
const result = {
  title: '光怎样沿光纤传播', summary: '全反射需要满足条件。', explanation: '先看清资料中给出的条件，再讨论传播。',
  terms: [{ term: '全反射', explanation: '此处以原文给定的条件为前提。' }], misconceptions: [], evidenceIds: ['F1', 'F1', 'F2', 'invented'],
  video: { title: '光纤示意', durationSeconds: 10000, shots: [{ duration: 8, visual: '示意：标出条件', narration: '传播需要满足条件。', caption: '先看条件' }] },
};

test('science prompt only receives confirmed facts and keeps source material as data', () => {
  const prompt = buildPrompt('science', input);
  const data = JSON.parse(prompt.user);
  assert.equal(data['已确认事实'].length, 1);
  assert.equal(data['已确认事实'][0].id, 'F1');
  assert.equal(prompt.user.includes('未确认内容'), false);
  assert.match(prompt.system, /不能把类比当作真实机制/);
  assert.throws(() => buildPrompt('science', { ...input, facts: [{ ...facts[0], confirmed: false }] }), error => error.code === 'FACTS_REQUIRED');
});

test('science results normalize reusable video data and cannot cite unconfirmed or invented facts', () => {
  const { payload } = buildPrompt('science', input);
  const normalized = normalizeModelData('science', { ...result, apiKey: 'ignored', html: '<script>ignored</script>' }, payload);
  assert.deepEqual(normalized.evidenceIds, ['F1']);
  assert.equal(normalized.video.durationSeconds, 8);
  assert.equal('apiKey' in normalized, false);
  assert.equal('html' in normalized, false);
  assert.throws(() => normalizeModelData('science', { ...result, explanation: '' }, payload), error => error.code === 'MODEL_FORMAT_ERROR');
  assert.throws(() => normalizeModelData('science', { ...result, video: { ...result.video, shots: [{ ...result.video.shots[0], duration: 13 }] } }, payload), error => error.code === 'MODEL_FORMAT_ERROR');
  assert.throws(() => normalizeModelData('science', { ...result, video: { ...result.video, shots: Array.from({ length: 8 }, () => ({ ...result.video.shots[0], duration: 12 })) } }, payload), error => error.code === 'MODEL_FORMAT_ERROR');
});

test('science outputs remain attached to their own project and do not change its kind or linked video', () => {
  const project = ensureScienceProject({ id: 'science-one', kind: 'science', title: '科普项目', source: { ...source }, science: { step: 'animate', videoProjectId: 'video-linked', result: structuredClone(result) }, outputs: { social: { text: '已有社群稿' } } });
  syncScienceOutputs(project);
  assert.equal(project.kind, 'science');
  assert.equal(project.science.step, 'novel', 'Every science entry uses the current visual-novel flow');
  assert.equal(project.science.videoProjectId, 'video-linked');
  assert.equal(project.outputs.article.title, result.title);
  assert.equal(project.outputs.video.durationSeconds, 8);
  assert.equal(project.outputs.social.text, '已有社群稿');
  project.outputs.video.shots[0].narration = '仅修改副本';
  assert.equal(project.science.result.video.shots[0].narration, result.video.shots[0].narration);
  assert.match(scienceText(project), /全反射/);
});
