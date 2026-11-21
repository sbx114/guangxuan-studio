import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt } from '../lib/prompts.mjs';

const input = sourceDraft => ({ instruction: '按来源草稿编排动画', script: '手动合并后的旁白', sourceDraft });

test('caption-only source drafts reach animation planning without inventing detected media', () => {
  const sourceDraft = { sourceProjectId: 'source-document', version: 4, openfilmDraftCaptions: [{ start: 0, end: 4, text: '拟定标题', placement: 'title', path: 'PRIVATE_PATH' }], settings: { apiKey: 'PRIVATE_KEY' } };
  const result = buildPrompt('animation-plan', input(sourceDraft)), sent = JSON.parse(result.user);
  assert.equal(sent['来源文案草稿'].openfilmDraftCaptions[0].text, '拟定标题');
  assert.equal(sent['来源文案草稿'].openfilmDraftCaptions[0].placement, 'title');
  assert.deepEqual(sent['来源文案草稿'].sourceStoryboard, []);
  assert.ok(!result.user.includes('PRIVATE'));
  assert.match(result.system, /duration是建议场景时长/);
  assert.match(result.system, /sourceProjectId或分镜序号当assetId/);
  assert.equal(result.payload.sourceAnalysis, undefined);
});

test('source draft normalization bounds large stories and captions and records omitted content', () => {
  const sourceDraft = { sourceProjectId: 'source-document', version: 7,
    sourceStoryboard: Array.from({ length: 200 }, () => ({ narration: '旁白'.repeat(3000), caption: '字幕'.repeat(1000), visual: '分镜建议'.repeat(2000), duration: 8, code: 'PRIVATE_CODE' })),
    openfilmDraftCaptions: Array.from({ length: 2000 }, (_, index) => ({ start: index * 2, end: index * 2 + 2, text: '字幕草稿'.repeat(500), src: 'file:///PRIVATE' })),
  };
  const result = buildPrompt('animation-plan', input(sourceDraft));
  assert.ok(JSON.stringify(result.payload.sourceDraft).length <= 16000);
  assert.ok(result.payload.sourceDraft.sourceStoryboard.length > 0);
  assert.ok(result.payload.sourceDraft.openfilmDraftCaptions.length > 0);
  assert.ok(result.payload.sourceDraft.omitted.shots > 160);
  assert.ok(result.payload.sourceDraft.omitted.captions > 1920);
  assert.equal(result.payload.sourceDraft.omitted.textTruncated, true);
  assert.ok(!result.user.includes('PRIVATE'));
});

test('empty drafts are omitted and invalid versions or caption times cannot enter model context', () => {
  for (const sourceDraft of [null, undefined, { sourceProjectId: 'source-document', version: 0, sourceStoryboard: [], openfilmDraftCaptions: [] }]) assert.equal(buildPrompt('animation-plan', input(sourceDraft)).payload.sourceDraft, undefined);
  for (const sourceDraft of [{ sourceProjectId: '../private', version: 1 }, { sourceProjectId: 'source-document', version: -1 }, { sourceProjectId: 'source-document', version: '2' }]) assert.throws(() => buildPrompt('animation-plan', input(sourceDraft)), { code: 'SOURCE_DRAFT_INVALID' });
  const result = buildPrompt('animation-plan', input({ sourceProjectId: 'source-document', version: 3,
    sourceStoryboard: [{ visual: 'BAD_DURATION', duration: Infinity }],
    openfilmDraftCaptions: [{ start: 0, end: 3, text: '有效拟定字幕' }, { start: -1, end: 2, text: 'NEGATIVE_TIME' }, { start: 2, end: 2, text: 'ZERO_DURATION' }, { start: '2', end: 3, text: 'STRING_TIME' }],
  }));
  assert.equal(result.payload.sourceDraft.sourceStoryboard.length, 0);
  assert.equal(result.payload.sourceDraft.openfilmDraftCaptions.length, 1);
  assert.equal(result.payload.sourceDraft.omitted.shots, 1);
  assert.equal(result.payload.sourceDraft.omitted.captions, 3);
  for (const value of ['BAD_DURATION', 'NEGATIVE_TIME', 'ZERO_DURATION', 'STRING_TIME']) assert.ok(!result.user.includes(value));
});
