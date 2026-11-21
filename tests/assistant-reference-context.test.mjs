import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AppError } from '../lib/errors.mjs';
import { createAssistantReferenceContext, ASSISTANT_FRAME_NOTES_SCHEMA } from '../lib/assistant-reference-context.mjs';
import { createAssistantFrameReader } from '../lib/assistant-frame-reader.mjs';

const PROJECT = 'reference-owner', ASSET = 'reference-video-0001';
const digest = value => createHash('sha256').update(value).digest('hex');
const OWNER = digest('owned-project-version'), SOURCE = digest('controlled-source-version');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const PICTURE = 'data:image/png;base64,' + PNG, IMAGE_SHA = digest(Buffer.from(PNG, 'base64'));
const inspectionId = index => `12345678-1234-4234-8234-${String(index).padStart(12, '0')}`;
function page(index = 1, { offset = 0, times = [0, 30, 60, 91.999], totalFrames = times.length, planId = digest('one-plan'), ownerVersion = OWNER, sourceVersion = SOURCE, requestedTimes = times, type = 'video' } = {}) {
  const frames = times.map((timestamp, i) => ({ index: offset + i + 1, ...(type === 'video' ? { timestamp, requestedTimestamp: requestedTimes[i], timestampKind: 'seek-position' } : {}), mimeType: 'image/png', bytes: Buffer.from(PNG, 'base64').length, sha256: IMAGE_SHA }));
  return { data: {
    inspectionId: inspectionId(index), ownerVersion,
    asset: { id: ASSET, name: '真实参考', type, duration: type === 'video' ? 92 : 0, width: 1280, height: 720, sourceVersion, path: 'C:/PRIVATE/never-forward.mp4' },
    frames, coverage: { requestedRange: { start: 0, end: 92 }, actualRange: { start: times[0], end: times.at(-1) }, frameCount: frames.length, pageComplete: true, planComplete: offset === 0 && totalFrames === frames.length, fullSource: true, frameByFrame: true },
    pagination: { planId, mode: 'interval', offset, pageSize: times.length, totalFrames, hasMore: offset + times.length < totalFrames, nextOffset: offset + times.length < totalFrames ? offset + times.length : null },
    path: 'C:/PRIVATE/never-forward.mp4', apiKey: 'never-forward-secret',
  }, images: frames.map(frame => ({ dataUrl: PICTURE, index: frame.index, timestamp: frame.timestamp, sha256: IMAGE_SHA, label: 'actual frame' })) };
}
function fixture(pages = [page()]) {
  const entries = new Map(pages.map(result => [result.data.inspectionId, result])), expired = new Set(), calls = [], readCalls = [];
  let onReceipt, onRead;
  const reader = {
    async receipt(id, options) {
      calls.push({ id, options });
      if (onReceipt) await onReceipt(id, options);
      if (options.projectId !== PROJECT || options.assetId && options.assetId !== entries.get(id)?.data.asset.id || expired.has(id) || !entries.has(id)) throw new AppError(404, '真实凭据已过期或不属于工程', 'ASSISTANT_FRAMES_RECEIPT');
      return structuredClone(entries.get(id));
    },
    async read(projectId, assetId, options) {
      readCalls.push({ projectId, assetId, options });
      if (onRead) return onRead(projectId, assetId, options);
      assert.equal(projectId, PROJECT); assert.equal(assetId, ASSET);
      return page(900 + readCalls.length, { times: options.timestamps || [0], planId: digest('replay-' + readCalls.length) });
    },
  };
  return { service: createAssistantReferenceContext({ frameReader: reader }), reader, entries, expired, calls, readCalls, setReceipt(callback) { onReceipt = callback; }, setRead(callback) { onRead = callback; } };
}
const note = (frameIndex, overrides = {}) => ({ frameIndex, description: '画面中可见几何图形。', layout: '主体位于中央。', motion: '该静帧不能证明完整运动。', ...overrides });
const recordAll = (service, result, override) => service.record(PROJECT, { inspectionId: result.data.inspectionId, notes: result.data.frames.map(frame => note(frame.index, override)) }, { origin: 'http://127.0.0.1:4417' });

test('binds notes to actual receipt frames and exposes only verified context and images', async () => {
  const result = page(), f = fixture([result]);
  const saved = await recordAll(f.service, result);
  assert.equal(saved.noteCount, 4); assert.deepEqual(saved.recordedFrameIndices, [1, 2, 3, 4]);
  const snapshot = await f.service.snapshot(PROJECT);
  assert.equal(snapshot.images.length, 4); assert.equal(snapshot.context.notes.length, 4);
  assert.deepEqual(snapshot.context.coverage.assets[0].timestamps, [0, 30, 60, 91.999]);
  assert.equal(snapshot.context.coverage.frameByFrame, false);
  assert.equal(snapshot.context.inspections[0].coverage.frameByFrame, false);
  assert.equal(snapshot.context.coverage.assets[0].plans[0].samplingPlanComplete, true);
  assert.equal(snapshot.context.assets[0].sourceVersion, SOURCE);
  assert.equal(snapshot.context.assets[0].ownerVersion, OWNER);
  assert.ok(snapshot.images.every(image => image.dataUrl === PICTURE && image.detail === 'high'));
  assert.deepEqual(snapshot.context.selectedImageFrames.map(frame => frame.timestamp), [0, 30, 60, 91.999]);
  assert.ok(!JSON.stringify(snapshot.context).includes('data:image'));
  assert.ok(!JSON.stringify(snapshot.context).includes('PRIVATE'));
  assert.ok(!JSON.stringify(snapshot.context).includes('never-forward-secret'));
  assert.equal(f.calls[0].options.projectId, PROJECT);
});

test('rejects fabricated fields, indexes, images, duplicates and oversized notes atomically', async () => {
  const f = fixture(), id = inspectionId(1);
  for (const input of [
    { inspectionId: id, notes: [note(1)], coverage: { frameByFrame: true } },
    { inspectionId: id, notes: [{ ...note(1), dataUrl: PICTURE }] },
    { inspectionId: id, notes: [note(1), note(1)] },
    { inspectionId: id, notes: [note(1, { description: 'x'.repeat(2001) })] },
    { inspectionId: id, notes: [note(1, { description: '\0injected' })] },
    { inspectionId: id, notes: Array.from({ length: 13 }, (_, i) => note(i + 1)) },
    { inspectionId: id, notes: Array.from({ length: 4 }, (_, i) => note(i + 1, { description: 'x'.repeat(2000), visibleText: 'y'.repeat(2000), layout: 'z'.repeat(2000), motion: 'm'.repeat(2000) })) },
  ]) await assert.rejects(f.service.record(PROJECT, input), { code: 'ASSISTANT_REFERENCE_NOTES_INPUT' });
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.service.record(PROJECT, { inspectionId: id, notes: [note(99)] }), { code: 'ASSISTANT_REFERENCE_FRAME_NOT_IN_RECEIPT' });
  assert.equal((await f.service.snapshot(PROJECT)).context.coverage.noteCount, 0);
  assert.deepEqual(ASSISTANT_FRAME_NOTES_SCHEMA.properties.notes.items.required, ['frameIndex', 'description']);
});

test('updates only descriptions of the same real frame without inflating sampled coverage', async () => {
  const f = fixture();
  await f.service.record(PROJECT, { inspectionId: inspectionId(1), notes: [note(1)] });
  await f.service.record(PROJECT, { inspectionId: inspectionId(1), notes: [note(1, { description: '重新检查后的描述。' }), note(2)] });
  const snapshot = await f.service.snapshot(PROJECT);
  assert.equal(snapshot.context.coverage.inspectionCount, 1); assert.equal(snapshot.context.coverage.sampledFrameCount, 4);
  assert.equal(snapshot.context.coverage.noteCount, 2); assert.equal(snapshot.context.coverage.unannotatedFrameCount, 2);
  assert.equal(snapshot.context.notes[0].description, '重新检查后的描述。');
});

test('expired receipt replays actual timestamps and preserves original offset/frame indices', async () => {
  const result = page(1, { offset: 12, times: [30, 60, 91.967], requestedTimes: [30, 60, 92], totalFrames: 30 }), f = fixture([result]);
  await recordAll(f.service, result); f.expired.add(result.data.inspectionId);
  const snapshot = await f.service.snapshot(PROJECT);
  assert.deepEqual(f.readCalls[0].options.timestamps, [30, 60, 91.967]);
  assert.deepEqual(snapshot.context.notes.map(frame => frame.frameIndex), [13, 14, 15]);
  assert.deepEqual(snapshot.context.selectedImageFrames.map(frame => frame.frameIndex), [13, 14, 15]);
  assert.equal(snapshot.context.notes[2].requestedTimestamp, 92); assert.equal(snapshot.context.notes[2].timestamp, 91.967);
  assert.equal(snapshot.context.inspections[0].pagination.planId, digest('one-plan'));
});

test('changed owner/source or changed replay frame never reuse old descriptions', async () => {
  for (const change of [{ ownerVersion: digest('different-owner') }, { sourceVersion: digest('different-source') }]) {
    const result = page(), f = fixture([result]); await recordAll(f.service, result); f.expired.add(result.data.inspectionId);
    f.setRead((_projectId, _assetId, options) => page(2, { times: options.timestamps, ...change }));
    await assert.rejects(f.service.snapshot(PROJECT), { code: 'ASSISTANT_REFERENCE_SOURCE_CHANGED' });
  }
  const result = page(), f = fixture([result]); await recordAll(f.service, result); f.expired.add(result.data.inspectionId);
  f.setRead((_projectId, _assetId, options) => page(2, { times: options.timestamps.map(time => time > 91.9 ? time - .01 : time + .01) }));
  await assert.rejects(f.service.snapshot(PROJECT), { code: 'ASSISTANT_REFERENCE_FRAME_CHANGED' });
});

test('real receipt source/scope failures are not converted into expiry replay', async () => {
  const f = fixture(); await recordAll(f.service, page());
  f.setReceipt(() => { throw new AppError(409, 'source changed', 'ASSISTANT_FRAMES_ASSET_CHANGED'); });
  await assert.rejects(f.service.snapshot(PROJECT), { code: 'ASSISTANT_FRAMES_ASSET_CHANGED' });
  assert.equal(f.readCalls.length, 0);
  await assert.rejects(f.service.record('other-owner', { inspectionId: inspectionId(1), notes: [note(1)] }), { code: 'ASSISTANT_FRAMES_ASSET_CHANGED' });
});

test('invalid actual image hash cannot be registered or forwarded', async () => {
  const result = page(); result.images[0].dataUrl = 'data:image/png;base64,' + Buffer.from('different-pixels').toString('base64');
  const f = fixture([result]);
  await assert.rejects(recordAll(f.service, result), { code: 'ASSISTANT_REFERENCE_RECEIPT_INVALID' });
  assert.equal((await f.service.snapshot(PROJECT)).images.length, 0);
});

test('stable paginated plan coverage preserves the entire source timeline and limits representative images', async () => {
  const pages = Array.from({ length: 4 }, (_, p) => page(p + 1, { offset: p * 12, times: Array.from({ length: 12 }, (_, i) => (p * 12 + i) * 1.9), totalFrames: 48 })), f = fixture(pages);
  for (const result of pages) await recordAll(f.service, result);
  const snapshot = await f.service.snapshot(PROJECT);
  assert.equal(snapshot.context.coverage.inspectionCount, 4); assert.equal(snapshot.context.coverage.sampledFrameCount, 48);
  assert.equal(snapshot.context.coverage.noteCount, 48); assert.equal(snapshot.images.length, 12);
  assert.equal(snapshot.context.coverage.assets[0].plans.length, 1);
  const plan = snapshot.context.coverage.assets[0].plans[0];
  assert.equal(plan.samplingPlanComplete, true); assert.equal(plan.unsampledPlannedFrameCount, 0);
  assert.ok(snapshot.context.selectedImageFrames.some(frame => frame.timestamp === 0));
  assert.ok(snapshot.context.selectedImageFrames.some(frame => frame.timestamp === 47 * 1.9));
  assert.equal(snapshot.context.coverage.frameByFrame, false);
  const limited = await f.service.snapshot(PROJECT, { maxNotes: 8 });
  assert.equal(limited.context.coverage.includedNoteCount, 8); assert.equal(limited.context.coverage.omittedNoteCount, 40);
  assert.equal(limited.context.notes[0].timestamp, 0); assert.equal(limited.context.notes.at(-1).timestamp, 47 * 1.9);
  const seen = []; let offset = 0;
  do { const batch = await f.service.snapshot(PROJECT, { imageOffset: offset, maxImages: 6 }); seen.push(...batch.context.selectedImageFrames.map(frame => frame.timestamp)); assert.deepEqual(batch.images.map(frame => frame.timestamp), batch.context.selectedImageFrames.map(frame => frame.timestamp)); assert.equal(batch.context.imagePagination.totalFrames, 48); offset = batch.context.imagePagination.nextOffset; } while (offset !== null);
  assert.deepEqual(seen, Array.from({ length: 48 }, (_, i) => i * 1.9));
});

test('different plans and repeated frames are never mistaken for one complete plan', async () => {
  const first = page(1, { offset: 0, times: [0, 1, 2], totalFrames: 6, planId: digest('plan-a') }), second = page(2, { offset: 3, times: [0, 1, 2], totalFrames: 6, planId: digest('plan-b') }), f = fixture([first, second]);
  await recordAll(f.service, first); await recordAll(f.service, second);
  const snapshot = await f.service.snapshot(PROJECT);
  assert.equal(snapshot.context.coverage.inspectionCount, 2); assert.equal(snapshot.context.coverage.sampledFrameCount, 3);
  assert.equal(snapshot.context.coverage.assets[0].plans.length, 2);
  assert.ok(snapshot.context.coverage.assets[0].plans.every(plan => !plan.samplingPlanComplete && plan.unsampledPlannedFrameCount === 3));
});

test('snapshot text budget reports omissions and still represents both ends of the source', async () => {
  const pages = Array.from({ length: 3 }, (_, p) => page(p + 1, { offset: p * 12, times: Array.from({ length: 12 }, (_, i) => p * 12 + i), totalFrames: 36 })), f = fixture(pages);
  for (const result of pages) await recordAll(f.service, result, { description: 'x'.repeat(2000), layout: '', motion: '' });
  const snapshot = await f.service.snapshot(PROJECT, { maxNoteCharacters: 24000 });
  assert.ok(JSON.stringify(snapshot.context.notes).length <= 24000);
  assert.equal(snapshot.context.coverage.noteCount, 36);
  assert.equal(snapshot.context.coverage.omittedNoteCount, 36 - snapshot.context.notes.length);
  assert.equal(snapshot.context.notes[0].timestamp, 0); assert.equal(snapshot.context.notes.at(-1).timestamp, 35);
});

test('filters only already registered current-project inspections and refuses missing records', async () => {
  const first = page(1), second = page(2, { times: [10, 20] }), f = fixture([first, second]);
  await recordAll(f.service, first); await recordAll(f.service, second);
  assert.equal((await f.service.snapshot(PROJECT, { inspectionIds: [second.data.inspectionId], assetId: ASSET })).context.coverage.inspectionCount, 1);
  await assert.rejects(f.service.snapshot(PROJECT, { inspectionIds: [inspectionId(404)] }), { code: 'ASSISTANT_REFERENCE_NOT_FOUND' });
  assert.equal((await f.service.snapshot('other-owner')).images.length, 0);
  f.service.clear(PROJECT); assert.equal((await f.service.snapshot(PROJECT)).images.length, 0);
});

test('abort while validating prevents registering/forwarding notes; close clears transient state', async () => {
  const f = fixture(), abort = new AbortController();
  f.setReceipt(() => { abort.abort(); });
  await assert.rejects(f.service.record(PROJECT, { inspectionId: inspectionId(1), notes: [note(1)] }, { signal: abort.signal }), { code: 'ASSISTANT_REFERENCE_CANCELLED' });
  assert.equal((await f.service.snapshot(PROJECT)).context.coverage.noteCount, 0);
  f.service.close(); await assert.rejects(f.service.snapshot(PROJECT), { code: 'ASSISTANT_REFERENCE_CLOSED' });
});

test('image reference has no fabricated video timestamp or continuous coverage', async () => {
  const result = page(1, { times: [0], type: 'image' }), f = fixture([result]); await recordAll(f.service, result);
  const snapshot = await f.service.snapshot(PROJECT);
  assert.equal(snapshot.images.length, 1); assert.deepEqual(snapshot.context.coverage.assets[0].timestamps, []);
  assert.equal(snapshot.context.notes[0].timestamp, undefined); assert.equal(snapshot.context.coverage.frameByFrame, false);
});

test('valid read receipts can be used before notes are registered without inventing descriptions', async () => {
  const result = page(), f = fixture([result]);
  const snapshot = await f.service.snapshot(PROJECT, { inspectionIds: [result.data.inspectionId], imageOffset: 0, maxImages: 2 });
  assert.equal(snapshot.images.length, 2); assert.equal(snapshot.context.notes.length, 0);
  assert.equal(snapshot.context.coverage.noteCount, 0); assert.equal(snapshot.context.coverage.unannotatedFrameCount, 4);
  assert.equal(snapshot.context.imagePagination.nextOffset, 2);
  await assert.rejects(f.service.snapshot(PROJECT, { inspectionIds: [result.data.inspectionId], imageOffset: 0, maxImages: 0 }), { code: 'ASSISTANT_REFERENCE_OPTIONS' });
});

test('each comparison page validates current source versions and only replays picture batches it uses', async () => {
  const pages = Array.from({ length: 4 }, (_, p) => page(p + 1, { offset: p * 12, times: Array.from({ length: 12 }, (_, i) => p * 12 + i), totalFrames: 48 })), f = fixture(pages);
  for (const result of pages) await recordAll(f.service, result);
  f.calls.length = 0;
  const snapshot = await f.service.snapshot(PROJECT, { imageOffset: 0, maxImages: 6 });
  assert.equal(f.calls.length, 1); assert.equal(snapshot.context.coverage.noteCount, 48);
  assert.deepEqual(snapshot.context.verification.revalidatedInspectionIds, [pages[0].data.inspectionId]);
  assert.deepEqual(snapshot.context.verification.assetVersions, [{ assetId: ASSET, sourceVersion: SOURCE, ownerVersion: OWNER }]);
  f.calls.length = 0;
  const noImages = await f.service.snapshot(PROJECT, { maxImages: 0 });
  assert.equal(f.calls.length, 1); assert.equal(noImages.images.length, 0);
  f.setReceipt(() => { throw new AppError(409, 'source changed', 'ASSISTANT_FRAMES_ASSET_CHANGED'); });
  await assert.rejects(f.service.snapshot(PROJECT, { maxImages: 0 }), { code: 'ASSISTANT_FRAMES_ASSET_CHANGED' });
});

test('actual frame reader receipts survive count eviction through verified replay across the 92-second reference', async t => {
  const owner = { id: PROJECT, kind: 'video', createdAt: 'fixture-owner-created-at' }, asset = { id: ASSET, type: 'video', name: 'test-reference.mp4', duration: 92, size: 1000, mtimeMs: 1, width: 1280, height: 720, hasAudio: false }, calls = [];
  const reader = createAssistantFrameReader({ store: { read: async () => ({ ...owner }) }, openFilm: { context: async () => ({ assets: [{ ...asset }] }) }, videoService: { resolveAsset: async () => ({ ...asset }), referenceFrames: async (_id, options) => { calls.push(options); return options.timestamps.map(timestamp => ({ dataUrl: PICTURE, timestamp })); } } });
  const service = createAssistantReferenceContext({ frameReader: reader }); t.after(async () => { service.close(); await reader.close(); });
  const ids = []; let offset = 0;
  do { const result = await reader.read(PROJECT, ASSET, { intervalSeconds: 1, pageSize: 10, offset }); ids.push(result.data.inspectionId); await recordAll(service, result); offset = result.data.pagination.nextOffset; } while (offset !== null);
  assert.equal(ids.length, 10); assert.equal(calls.length, 10);
  const snapshot = await service.snapshot(PROJECT, { inspectionIds: ids });
  assert.equal(snapshot.context.coverage.sampledFrameCount, 92); assert.equal(snapshot.context.coverage.noteCount, 92);
  assert.equal(snapshot.context.coverage.assets[0].plans.length, 1);
  assert.equal(snapshot.context.coverage.assets[0].plans[0].samplingPlanComplete, true);
  assert.equal(snapshot.images.length, 12); assert.ok(calls.length > 10, 'evicted receipts were freshly decoded through the reader');
  assert.deepEqual(snapshot.context.coverage.assets[0].timestamps, Array.from({ length: 92 }, (_, i) => i + .5));
  asset.mtimeMs++; await assert.rejects(service.snapshot(PROJECT, { inspectionIds: ids }), /已有变化/);
});

test('cumulative edits cannot grow one receipt beyond the batch text limit', async () => {
  const result = page(1, { times: Array.from({ length: 12 }, (_, i) => i) }), f = fixture([result]);
  await recordAll(f.service, result, { description: 'x'.repeat(2000), layout: '', motion: '' });
  await assert.rejects(f.service.record(PROJECT, { inspectionId: result.data.inspectionId, notes: [note(1, { description: 'x'.repeat(2000), visibleText: 'y'.repeat(2000), layout: '', motion: '' })] }), { code: 'ASSISTANT_REFERENCE_NOTES_INPUT' });
  const snapshot = await f.service.snapshot(PROJECT);
  assert.equal(snapshot.context.notes[0].visibleText, undefined); assert.equal(snapshot.context.coverage.noteCount, 12);
});

test('sequential image byte budget returns a contiguous prefix and accurate nextOffset', async () => {
  const result = page(1, { times: Array.from({ length: 12 }, (_, i) => i) }), pixels = Buffer.alloc(1400 * 1024);
  Buffer.from(PNG, 'base64').copy(pixels); const dataUrl = 'data:image/png;base64,' + pixels.toString('base64'), sha256 = digest(pixels);
  for (const frame of result.data.frames) { frame.sha256 = sha256; frame.bytes = pixels.length; }
  for (const image of result.images) { image.sha256 = sha256; image.dataUrl = dataUrl; }
  const f = fixture([result]); await recordAll(f.service, result);
  const snapshot = await f.service.snapshot(PROJECT, { imageOffset: 0, maxImages: 12 });
  assert.equal(snapshot.images.length, 4); assert.equal(snapshot.context.imagePagination.nextOffset, 4);
  assert.deepEqual(snapshot.context.selectedImageFrames.map(frame => frame.frameIndex), [1, 2, 3, 4]);
  assert.ok(snapshot.images.reduce((sum, frame) => sum + Buffer.byteLength(frame.dataUrl), 0) <= 8 * 1024 * 1024);
  const next = await f.service.snapshot(PROJECT, { imageOffset: 4, maxImages: 12 });
  assert.deepEqual(next.context.selectedImageFrames.map(frame => frame.frameIndex), [5, 6, 7, 8]); assert.equal(next.context.imagePagination.nextOffset, 8);
});

test('metadata-only exports are immutable same-process capabilities, never model JSON import data', async () => {
  const f = fixture(); await recordAll(f.service, page());
  const exported = f.service.export(PROJECT);
  assert.equal(exported.noteCount, 4); assert.equal(exported.inspectionCount, 1); assert.match(exported.sourceSignature, /^[a-f0-9]{64}$/);
  assert.ok(Object.isFrozen(exported) && Object.isFrozen(exported.inspections[0].notes[0]));
  const keys = [], visit = value => { if (!value || typeof value !== 'object') return; for (const [name, child] of Object.entries(value)) { keys.push(name); visit(child); } };
  visit(exported);
  for (const field of ['images', 'imageBatch', 'dataUrl', 'path', 'apiKey', 'settings']) assert.ok(!keys.includes(field));
  assert.ok(!JSON.stringify(exported).includes('data:image') && !JSON.stringify(exported).includes('PRIVATE'));
  assert.throws(() => { exported.inspections[0].notes[0].description = 'forged note'; }, TypeError);
  const target = createAssistantReferenceContext({ frameReader: f.reader });
  for (const forged of [structuredClone(exported), JSON.parse(JSON.stringify(exported)), { version: 1, inspections: [] }]) await assert.rejects(target.restore(PROJECT, forged), { code: 'ASSISTANT_REFERENCE_CACHE_UNTRUSTED' });
  await assert.rejects(target.restore('other-owner', exported), { code: 'ASSISTANT_REFERENCE_CACHE_UNTRUSTED' });
  assert.equal((await target.snapshot(PROJECT)).context.coverage.noteCount, 0);
  f.service.close(); const restored = await target.restore(PROJECT, exported);
  assert.equal(restored.noteCount, 4); assert.equal(restored.eagerFrameHashesVerified, 1); assert.equal(restored.remainingFrameHashesDeferred, true);
  assert.equal((await target.snapshot(PROJECT)).context.notes[0].description, '画面中可见几何图形。');
  target.close();
});

test('restore filters cached assets using the current server scope without reading excluded sources', async () => {
  const first = page(1), second = page(2); second.data.asset.id = 'other-reference-video'; second.data.pagination.planId = digest('other-plan');
  const f = fixture([first, second]); await recordAll(f.service, first); await recordAll(f.service, second);
  const exported = f.service.export(PROJECT), target = createAssistantReferenceContext({ frameReader: f.reader }); f.calls.length = 0;
  const restored = await target.restore(PROJECT, exported, { assetIds: [ASSET] });
  assert.deepEqual(restored.assetIds, [ASSET]); assert.deepEqual(restored.restoredInspectionIds, [first.data.inspectionId]);
  assert.ok(f.calls.every(call => call.id === first.data.inspectionId));
  assert.deepEqual((await target.snapshot(PROJECT)).context.assets.map(asset => asset.id), [ASSET]);
  const empty = createAssistantReferenceContext({ frameReader: f.reader });
  assert.deepEqual((await empty.restore(PROJECT, exported, { assetIds: [] })).restoredInspectionIds, []);
  assert.equal((await empty.snapshot(PROJECT)).context.coverage.noteCount, 0); empty.close(); target.close();
});

test('stale cached owner/source versions are refused atomically and fresh notes can still be recorded', async () => {
  for (const change of [{ ownerVersion: digest('new-owner') }, { sourceVersion: digest('new-source') }]) {
    const original = page(), f = fixture([original]); await recordAll(f.service, original); const exported = f.service.export(PROJECT), target = createAssistantReferenceContext({ frameReader: f.reader });
    if (change.ownerVersion) f.entries.get(original.data.inspectionId).data.ownerVersion = change.ownerVersion;
    if (change.sourceVersion) f.entries.get(original.data.inspectionId).data.asset.sourceVersion = change.sourceVersion;
    await assert.rejects(target.restore(PROJECT, exported), { code: 'ASSISTANT_REFERENCE_SOURCE_CHANGED' });
    assert.equal((await target.snapshot(PROJECT)).context.coverage.noteCount, 0);
    await target.record(PROJECT, { inspectionId: original.data.inspectionId, notes: [note(1, { description: '新来源重新分析' })] });
    assert.equal((await target.snapshot(PROJECT)).context.notes[0].description, '新来源重新分析'); target.close();
  }
});

test('restore checks an eager actual SHA and deferred picture SHA before cached images are forwarded', async () => {
  const original = page(), f = fixture([original]); await recordAll(f.service, original); const exported = f.service.export(PROJECT), target = createAssistantReferenceContext({ frameReader: f.reader });
  const current = f.entries.get(original.data.inspectionId), changed = Buffer.from('different-fixture-pixels'), changedSha = digest(changed);
  current.data.frames[0].sha256 = changedSha; current.images[0].sha256 = changedSha; current.images[0].dataUrl = 'data:image/png;base64,' + changed.toString('base64');
  await assert.rejects(target.restore(PROJECT, exported), { code: 'ASSISTANT_REFERENCE_FRAME_CHANGED' });
  current.data.frames[0].sha256 = IMAGE_SHA; current.images[0].sha256 = IMAGE_SHA; current.images[0].dataUrl = PICTURE;
  await target.restore(PROJECT, exported);
  current.data.frames[2].sha256 = changedSha; current.images[2].sha256 = changedSha; current.images[2].dataUrl = 'data:image/png;base64,' + changed.toString('base64');
  await assert.rejects(target.snapshot(PROJECT, { imageOffset: 2, maxImages: 1 }), { code: 'ASSISTANT_REFERENCE_FRAME_CHANGED' }); target.close();
});

test('expired cache restores one source frame and replays only requested representatives instead of all fifty', async () => {
  const pages = Array.from({ length: 5 }, (_, p) => page(p + 1, { offset: p * 10, times: Array.from({ length: 10 }, (_, i) => (p * 10 + i) * 1.8), totalFrames: 50 })), f = fixture(pages);
  for (const result of pages) await recordAll(f.service, result);
  const exported = f.service.export(PROJECT); for (const result of pages) f.expired.add(result.data.inspectionId);
  const target = createAssistantReferenceContext({ frameReader: f.reader }), restored = await target.restore(PROJECT, exported);
  assert.equal(restored.noteCount, 50); assert.equal(f.readCalls.length, 1); assert.deepEqual(f.readCalls[0].options.timestamps, [0]);
  const selected = await target.snapshot(PROJECT, { imageOffset: 12, maxImages: 6 });
  assert.equal(selected.context.coverage.noteCount, 50); assert.equal(selected.context.coverage.sampledFrameCount, 50);
  assert.deepEqual(selected.context.selectedImageFrames.map(frame => frame.frameIndex), [13, 14, 15, 16, 17, 18]);
  assert.equal(f.readCalls.reduce((total, call) => total + call.options.timestamps.length, 0), 7);
  assert.deepEqual(selected.images.map(image => image.frameIndex), [13, 14, 15, 16, 17, 18]); target.close();
});

test('actual reader cached receipts reuse all fifty bound notes across run instances without new decoding', async t => {
  const owner = { id: PROJECT, kind: 'video', createdAt: 'cache-owner-created-at' }, asset = { id: ASSET, type: 'video', name: 'reference.mp4', duration: 100, size: 1000, mtimeMs: 1, width: 1280, height: 720, hasAudio: false }, reads = [];
  const reader = createAssistantFrameReader({ store: { read: async () => ({ ...owner }) }, openFilm: { context: async () => ({ assets: [{ ...asset }] }) }, videoService: { resolveAsset: async () => ({ ...asset }), referenceFrames: async (_id, options) => { reads.push(options.timestamps); return options.timestamps.map(timestamp => ({ dataUrl: PICTURE, timestamp })); } } });
  const first = createAssistantReferenceContext({ frameReader: reader }), target = createAssistantReferenceContext({ frameReader: reader });
  t.after(async () => { first.close(); target.close(); await reader.close(); });
  let offset = 0;
  do { const result = await reader.read(PROJECT, ASSET, { pageSize: 10, offset }); await recordAll(first, result); offset = result.data.pagination.nextOffset; } while (offset !== null);
  assert.equal(reads.length, 5); const exported = first.export(PROJECT); first.close();
  const restored = await target.restore(PROJECT, exported, { assetIds: [ASSET] });
  assert.equal(restored.noteCount, 50); assert.equal(reads.length, 5);
  const resumed = await target.snapshot(PROJECT);
  assert.equal(resumed.context.coverage.noteCount, 50); assert.equal(resumed.images.length, 12); assert.equal(reads.length, 5);
  assert.equal(resumed.context.coverage.assets[0].plans[0].samplingPlanComplete, true);
});

test('invalid cache export filters do not affect valid record and snapshot use', async () => {
  const f = fixture(); await recordAll(f.service, page());
  for (const options of [{ inspectionIds: 1 }, { inspectionIds: ['invented'] }, { assetIds: ASSET }, { path: 'C:/private/cache.json' }]) assert.throws(() => f.service.export(PROJECT, options), { code: 'ASSISTANT_REFERENCE_CACHE_OPTIONS' });
  assert.equal(f.service.export(PROJECT, { assetIds: [] }).noteCount, 0);
  assert.equal((await f.service.snapshot(PROJECT)).context.coverage.noteCount, 4);
});
