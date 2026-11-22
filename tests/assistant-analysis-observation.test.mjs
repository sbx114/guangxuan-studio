import test from 'node:test';
import assert from 'node:assert/strict';
import { compactAnalysisObservation } from '../lib/assistant-analysis-observation.mjs';

test('oversized analysis preserves processed IDs and distinct source versus displayed paging', () => {
  const items = Array.from({ length: 8 }, (_, index) => ({ assetId: `asset-${index}`, range: { start: 300, end: 600 },
    pagination: { shotOffset: 6, shotLimit: 6, totalShots: 20, nextShotOffset: 12, hasMore: true },
    shots: Array.from({ length: 12 }, (_, shot) => ({ id: `shot-${shot}`, start: 300 + shot, end: 301 + shot, description: '可见资料'.repeat(5000), evidence: ['f001.jpg', 'f002.jpg'] })),
    summary: { kind: 'visual-sampled', text: '根据实际图像'.repeat(4000) },
    apiKey: 'synthetic-private-value',
  }));
  const result = compactAnalysisObservation({ summary: '分析结果', data: { assetPagination: { mode: 'project-page', offset: 0, limit: 8, total: 30, nextAssetOffset: 8, analyzedAssetIds: items.map(item => item.assetId) }, items,
    sourceWindows: [{ assetId: 'asset-0', start: 300, end: 600, requestedEnd: 900, nextRange: { start: 600, end: 900 } }],
  } }, { budget: 8000 });
  const text = JSON.stringify(result);
  assert.ok(text.length <= 8000);
  assert.equal(result.data.sourceReturnedItems, 8);
  assert.equal(result.data.sourceNextAssetOffset, 8);
  assert.equal(result.data.assetPagination.total, 30);
  assert.deepEqual(result.data.assetPagination.analyzedAssetIds, items.map(item => item.assetId));
  assert.equal(result.data.responsePartial, true);
  assert.equal(result.data.items[0].assetId, 'asset-0');
  assert.equal(result.data.items[0].pagination.nextShotOffset, 12);
  assert.deepEqual(result.data.sourceWindows[0].nextRange, { start: 600, end: 900 });
  assert.equal(text.includes('synthetic-private-value'), false);
  assert.equal(result.data.responseReturnedItems + result.data.responseOmittedAssetIds.length, 8);
  if (result.data.responseOmittedAssetIds.length) assert.equal(result.data.responseNextAssetOffset, result.data.responseReturnedItems);
});

test('cleaning occurs before shortening rich cue text', () => {
  const secret = 'synthetic-long-credential-for-cleaning';
  const result = compactAnalysisObservation({ data: { items: [{ assetId: 'owned', summary: { text: secret + 'x'.repeat(1000) } }] } }, { clean: value => String(value).split(secret).join('[hidden]') });
  assert.equal(JSON.stringify(result).includes('synthetic-long-credential'), false);
  assert.match(result.data.items[0].summary.text, /\[hidden\]/);
});
