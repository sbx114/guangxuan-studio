import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeShotCues } from '../lib/source-analysis-cues.mjs';
import { buildPrompt } from '../lib/prompts.mjs';
const shot = { id: 's001', start: 10, end: 14 };
const frames = [{ id: 'f002.jpg', shotId: 's001', timestamp: 10.8 }, { id: 'f003.jpg', shotId: 's001', timestamp: 13.2 }, { id: 'f004.jpg', shotId: 's002', timestamp: 15 }];
const raw = { evidence: ['f002.jpg', 'f003.jpg'], subjects: [{ label: '装置', role: 'primary', position: 'center' }], composition: { shotSize: 'detail', negativeSpace: 'left' }, motion: { beforeFrame: 'f002.jpg', afterFrame: 'f003.jpg', direction: 'right', camera: 'pan', description: '所列两帧间主体位移' }, usableSegments: [{ purpose: 'action', start: 10, end: 14, evidence: ['f002.jpg', 'f003.jpg'], rationale: '本段动作候选', confidence: 'medium' }] };
test('typed cues bind subjects, paired changes and candidate use to the actual same-shot evidence', () => {
  const value = normalizeShotCues(raw, { shot, frames }); assert.equal(value.id, 's001:visual'); assert.equal(value.motion.status, 'paired-observation'); assert.equal(value.motion.continuous, false); assert.equal(value.usableSegments[0].status, 'sample-based-candidate'); assert.equal(value.subjects[0].role, 'primary');
});
test('single-frame and foreign frame claims cannot manufacture motion, source intervals or cue identity', () => {
  const value = normalizeShotCues({ ...raw, id: 'invented', evidence: ['f002.jpg', 'f004.jpg'], motion: { ...raw.motion, afterFrame: 'f004.jpg' }, usableSegments: [{ ...raw.usableSegments[0], start: 9 }] }, { shot, frames });
  assert.deepEqual(value.evidence, ['f002.jpg']); assert.equal(value.motion.direction, 'unknown'); assert.equal(value.motion.description, ''); assert.equal(value.usableSegments.length, 0); assert.equal(value.id, 's001:visual');
  assert.equal(normalizeShotCues({ evidence: ['f999.jpg'] }, { shot, frames }), undefined);
});
test('the edit context carries actual cue frames and strips semantic cues from technical analysis', () => {
  const item = { assetId: 'known-asset', range: { start: 10, end: 14 }, frames, shots: [{ ...shot, boundary: 'detected', evidence: raw.evidence, description: '可见装置', cues: raw }], summary: { kind: 'visual-sampled', text: '基于实际抽样', coverageNote: '有限帧' }, coverage: { sampledFrameCount: 2, shotCount: 1 }, transcript: { status: 'skipped', segments: [] } };
  const input = { instruction: '编排当前实际素材', assets: [{ id: 'known-asset', name: '素材', type: 'video', duration: 20 }], timeline: [], editScope: { placement: { mode: 'append' } }, sourceAnalysis: { version: 1, items: [item] } };
  const prompt = buildPrompt('edit-plan', input); assert.equal(prompt.payload.sourceAnalysis.items[0].shots[0].cues.id, 's001:visual'); assert.equal(prompt.payload.sourceAnalysis.items[0].frames.length, 2); assert.match(prompt.system, /continuous=false/);
  input.sourceAnalysis.items[0].summary.kind = 'technical'; const technical = buildPrompt('edit-plan', input); assert.equal(technical.payload.sourceAnalysis.items[0].shots[0].cues, undefined); assert.equal(technical.payload.sourceAnalysis.items[0].shots[0].description, '');
});
