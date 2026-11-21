import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, normalizeModelData } from '../lib/prompts.mjs';

const assets = [
  { id: 'selected-asset', name: '原素材.mp4', type: 'video', duration: 60 },
  { id: 'unselected-asset', name: '未选素材.mp4', type: 'video', duration: 60 },
];
const evidence = (patch = {}) => ({
  assetId: assets[0].id, name: '不直接采信的名称', range: { start: 10, end: 30 }, analyzedAt: '2026-11-17T14:00:00.000Z',
  summary: { kind: 'visual-sampled', text: '抽样画面中可见蓝色演示器材。', coverageNote: '仅依据离散关键帧与成功转写。' },
  shots: [{ id: 's000', start: 10, end: 20, boundary: 'detected', description: '桌面上的蓝色演示器材', evidence: ['f000.jpg'] }, { id: 's001', start: 20, end: 30, boundary: 'interval', description: '没有帧证据的描述应移除', evidence: [] }],
  transcript: { status: 'partial', timing: 'chunk', timingNote: '所示时间为音频分块范围，并非精确字幕时间。', segments: [{ start: 10, end: 30, text: '以下是分块内识别到的讲解文字。', timing: 'chunk' }] },
  coverage: { fullSource: false, sceneDetection: 'ffmpeg-scene-estimate', detectedCuts: 1, sampledFrameCount: 1, shotCount: 2, transcriptRanges: [{ start: 10, end: 30 }], note: '未抽样画面未作语义判断。' },
  warnings: ['语音仅成功完成部分区间'], omitted: { transcriptSegments: 3, shots: 4 },
  provenance: { imported: true, verifiedContentSha256: 'a'.repeat(64), originalAnalyzedAt: '2026-11-16T12:00:00Z' },
  ...patch,
});
const input = (task, items = [evidence()]) => ({
  instruction: '按选中素材中介绍蓝色器材的内容编排剪辑', script: '',
  ...(task === 'edit-assistant' ? { context: { assets: structuredClone(assets), timeline: [], duration: 60, mainTrackEditable: true, aspect: '16:9' } } : { assets: structuredClone(assets), timeline: [] }),
  editScope: { assetIds: [assets[0].id], placement: { mode: 'append' } },
  sourceAnalysis: { version: 1, items },
});

test('coarse cut and assistant prompts preserve bounded selected source evidence and imported provenance', () => {
  for (const task of ['edit-plan', 'edit-assistant']) {
    const raw = input(task);
    raw.sourceAnalysis.settings = { apiKey: 'TOP_LEVEL_SECRET' };
    raw.sourceAnalysis.items[0].path = 'C:/PRIVATE/source.mp4';
    raw.sourceAnalysis.items[0].summary.providerOrigin = 'https://PRIVATE_PROVIDER';
    raw.sourceAnalysis.items[0].shots[0].path = 'C:/PRIVATE/frame.jpg';
    const built = buildPrompt(task, raw), data = JSON.parse(built.user), item = data['原素材分析'].items[0];
    assert.deepEqual(item.range, { start: 10, end: 30 });
    assert.equal(item.assetId, assets[0].id);
    assert.equal(item.name, assets[0].name);
    assert.equal(item.summary.kind, 'visual-sampled');
    assert.equal(item.shots[0].description, '桌面上的蓝色演示器材');
    assert.deepEqual(item.shots[0].evidence, ['f000.jpg']);
    assert.equal(item.shots[1].description, '');
    assert.equal(item.transcript.status, 'partial');
    assert.equal(item.transcript.timing, 'chunk');
    assert.deepEqual(item.transcript.segments[0], { start: 10, end: 30, text: '以下是分块内识别到的讲解文字。', timing: 'chunk' });
    assert.deepEqual(item.omitted, { transcriptSegments: 3, shots: 4, textTruncated: false });
    assert.equal(item.provenance.imported, true);
    assert.equal(item.provenance.verifiedContentSha256, 'a'.repeat(64));
    assert.equal(item.provenance.originalAnalyzedAt, '2026-11-16T12:00:00.000Z');
    assert.ok(!built.user.includes('PRIVATE'));
    assert.ok(!built.user.includes('TOP_LEVEL_SECRET'));
    assert.match(built.system, /technical.*绝不代表画面语义识别/s);
    assert.match(built.system, /timing=chunk.*严禁当成逐句、逐字/s);
    assert.match(built.system, /segment.*不是逐字时间/s);
    assert.match(built.system, /provenance.imported.*不能声称重新调用模型/s);
  }
});

test('unselected, foreign, duplicate, invalid-range and unverified imported analysis cannot reach a prompt', () => {
  const raw = input('edit-assistant', [
    evidence(), evidence({ assetId: assets[1].id, summary: { kind: 'technical', text: 'UNSELECTED_CONTENT' } }),
    evidence({ assetId: 'foreign-asset', summary: { kind: 'technical', text: 'FOREIGN_CONTENT' } }),
    evidence({ range: { start: 59, end: 70 }, summary: { kind: 'technical', text: 'OUTSIDE_CONTENT' } }),
    evidence({ range: { start: 4, end: 2 } }), evidence(),
    evidence({ range: { start: 1, end: 3 }, provenance: { imported: true, verifiedContentSha256: 'not-verified' } }),
  ]);
  const result = buildPrompt('edit-assistant', raw);
  assert.equal(result.payload.sourceAnalysis.items.length, 1);
  assert.equal(result.payload.sourceAnalysis.omitted.items, 6);
  assert.ok(!result.user.includes('UNSELECTED_CONTENT'));
  assert.ok(!result.user.includes('FOREIGN_CONTENT'));
  assert.ok(!result.user.includes('OUTSIDE_CONTENT'));
  raw.editScope.assetIds = [];
  assert.equal(buildPrompt('edit-assistant', raw).payload.sourceAnalysis, undefined);
});

test('technical detection and failed speech are never upgraded into semantic or recognized content', () => {
  const raw = input('edit-plan', [evidence({
    provenance: undefined,
    summary: { kind: 'technical', text: '本地估计1处画面变化，并抽取1帧。' },
    transcript: { status: 'error', timing: 'segment', segments: [{ start: 12, end: 13, text: 'FAILED_SPEECH_MUST_NOT_BE_USED', timing: 'segment' }] },
    coverage: { fullSource: true, sampledFrameCount: 1, transcriptRanges: [{ start: 10, end: 30 }] },
  })]);
  const result = buildPrompt('edit-plan', raw), item = result.payload.sourceAnalysis.items[0];
  assert.equal(item.summary.kind, 'technical');
  assert.ok(item.shots.every(shot => !shot.description));
  assert.equal(item.transcript.status, 'error');
  assert.equal(item.transcript.timing, 'none');
  assert.deepEqual(item.transcript.segments, []);
  assert.deepEqual(item.coverage.transcriptRanges, []);
  assert.equal(item.coverage.fullSource, false);
  assert.ok(!result.user.includes('FAILED_SPEECH_MUST_NOT_BE_USED'));
  assert.equal(item.omitted.transcriptSegments, 4);
  const unsupported = input('edit-plan', [evidence({ summary: { kind: 'visual-sampled', text: 'UNSUPPORTED_VISUAL' }, shots: [{ id: 's000', start: 10, end: 20, description: 'NO_PICTURE', evidence: ['file:///private.jpg'] }] })]);
  const downgraded = buildPrompt('edit-plan', unsupported).payload.sourceAnalysis.items[0];
  assert.equal(downgraded.summary.kind, 'technical');
  assert.ok(!JSON.stringify(downgraded).includes('UNSUPPORTED_VISUAL'));
  assert.ok(!JSON.stringify(downgraded).includes('NO_PICTURE'));
});

test('shots and speech retain only valid absolute times inside their analyzed source range', () => {
  const raw = input('edit-assistant', [evidence({
    provenance: undefined,
    shots: [{ id: 's000', start: 10, end: 20, description: '有效镜头', boundary: 'detected', evidence: ['f000.jpg', '../secret', 'f000.jpg'] }, { id: 's001', start: 0, end: 15, description: 'OUTSIDE_SHOT', evidence: ['f001.jpg'] }, { id: 's002', start: '20', end: 30, description: 'STRING_TIME', evidence: [] }],
    transcript: { status: 'complete', timing: 'segment', segments: [{ start: 12.5, end: 14.75, text: '有效识别句段', timing: 'segment' }, { start: 29, end: 31, text: 'OUTSIDE_SPEECH' }, { start: 11, end: 11, text: 'ZERO_DURATION' }, { start: NaN, end: 12, text: 'NAN_TIME' }] },
  })]);
  const built = buildPrompt('edit-assistant', raw), item = built.payload.sourceAnalysis.items[0];
  assert.equal(item.shots.length, 1);
  assert.deepEqual(item.shots[0].evidence, ['f000.jpg']);
  assert.equal(item.transcript.timing, 'segment');
  assert.deepEqual(item.transcript.segments, [{ start: 12.5, end: 14.75, text: '有效识别句段', timing: 'segment' }]);
  assert.equal(item.omitted.shots, 6);
  assert.equal(item.omitted.transcriptSegments, 6);
  for (const value of ['OUTSIDE_SHOT', 'STRING_TIME', 'OUTSIDE_SPEECH', 'ZERO_DURATION', 'NAN_TIME', '../secret']) assert.ok(!built.user.includes(value));
});

test('large analysis contexts obey a total 36000-character budget and report all trimmed evidence', () => {
  const largeAssets = Array.from({ length: 8 }, (_, index) => ({ id: `asset-${index}`, name: `素材${index}.mp4`, type: 'video', duration: 1800 }));
  const items = largeAssets.map(asset => evidence({
    assetId: asset.id, range: { start: 0, end: 1800 }, provenance: undefined,
    summary: { kind: 'visual-sampled', text: '抽样视觉摘要'.repeat(1500), coverageNote: '覆盖限制'.repeat(1000) },
    shots: Array.from({ length: 120 }, (_, index) => ({ id: `s${String(index).padStart(3, '0')}`, start: index * 15, end: (index + 1) * 15, description: '很长的画面描述'.repeat(1000), evidence: [`f${String(index % 24).padStart(3, '0')}.jpg`] })),
    transcript: { status: 'complete', timing: 'segment', segments: Array.from({ length: 80 }, (_, index) => ({ start: index * 20, end: index * 20 + 20, text: '很长的语音内容'.repeat(1000), timing: 'segment' })) },
    coverage: { fullSource: true, sampledFrameCount: 24, shotCount: 120, note: '抽样限制'.repeat(1000) },
    warnings: Array.from({ length: 50 }, () => '警告'.repeat(1000)),
  }));
  const built = buildPrompt('edit-plan', { instruction: '使用这些工程素材', assets: largeAssets, sourceAnalysis: { version: 1, items } });
  assert.ok(JSON.stringify(built.payload.sourceAnalysis).length <= 36000);
  assert.equal(built.payload.sourceAnalysis.items.length, 8);
  for (const item of built.payload.sourceAnalysis.items) {
    assert.ok(item.omitted.shots > 4);
    assert.ok(item.omitted.transcriptSegments > 3);
    assert.equal(item.omitted.textTruncated, true);
    assert.ok(item.summary.text.length <= 2000);
  }
});

test('source analysis and independently bound reference segments coexist without mixing their clocks', () => {
  const raw = input('edit-assistant');
  raw.references = { includeImages: true, items: [{ id: 'reference-only', type: 'video', name: '参考片', text: '', focus: '只参考剪辑节奏', aspects: ['editing'], duration: 90, sourceRange: { start: 40, end: 45 }, targetRange: { start: 5, end: 10 }, frames: [{ label: '参考41秒', timestamp: 41 }] }] };
  const built = buildPrompt('edit-assistant', raw), data = JSON.parse(built.user);
  assert.deepEqual(data['项目参考'].items[0].sourceRange, { start: 40, end: 45 });
  assert.deepEqual(data['项目参考'].items[0].targetRange, { start: 5, end: 10 });
  assert.deepEqual(data['原素材分析'].items[0].range, { start: 10, end: 30 });
  assert.match(built.system, /分段参考绑定/);
  assert.match(built.system, /源素材绝对秒数.*参考sourceRange\/targetRange混淆/s);
  assert.ok(!data['当前工程'].assets.some(asset => asset.id === 'reference-only'));
});

test('malformed or unsupported analysis envelopes are rejected before model use', () => {
  for (const sourceAnalysis of [null, [], { version: 2, items: [] }, { version: 1, items: {} }, { version: 1, items: Array(9).fill(evidence()) }]) {
    assert.throws(() => buildPrompt('edit-plan', { ...input('edit-plan'), sourceAnalysis }), error => ['INVALID_INPUT', 'SOURCE_ANALYSIS_VERSION_UNSUPPORTED', 'SOURCE_ANALYSIS_CONTEXT_LIMIT'].includes(error.code));
  }
  const raw = input('edit-plan', [evidence({ range: { start: -1, end: 12 } })]);
  assert.equal(buildPrompt('edit-plan', raw).payload.sourceAnalysis, undefined);
});

test('normalized coarse-cut warnings reflect actual analysis evidence without claiming fresh recognition', () => {
  const output = { title: '按证据粗剪', summary: '', timeline: [{ assetId: assets[0].id, start: 10, end: 15, reason: '已有分析' }], captions: [], warnings: [] };
  const withEvidence = buildPrompt('edit-plan', input('edit-plan')).payload;
  const result = normalizeModelData('edit-plan', output, withEvidence);
  assert.match(result.warnings[0], /已有成功转写/);
  assert.match(result.warnings[0], /原素材抽样画面摘要/);
  assert.match(result.warnings[0], /最终剪辑复核/);
  assert.ok(!result.warnings[0].includes('未进行语音识别'));
  const absent = input('edit-plan'); delete absent.sourceAnalysis;
  assert.match(normalizeModelData('edit-plan', output, buildPrompt('edit-plan', absent).payload).warnings[0], /未识别实际画面或语音/);
});
