import test from 'node:test';
import assert from 'node:assert/strict';
import { describeNativeTimeline, planNativeAdjustments, NATIVE_MAX_TIME_SECONDS } from '../lib/native-adjustments.mjs';
import { nativeOperationContext, planNativeOperations } from '../lib/native-operations.mjs';

const known = { 'a.mp4': { assetId: 'asset-a', name: 'selected video', duration: 4 }, 'b.mp4': { assetId: 'asset-b', name: 'other video', duration: 4 } };
const document = () => ({ stage: { w: 1280, h: 720 }, tracks: [{ clips: Array.from({ length: 1000 }, (_, index) => ({ id: 'clip-' + (index + 1), src: index < 600 ? 'a.mp4' : 'b.mp4', at: index, time: [0, .75], volume: .7, ...(index === 300 ? { speed: 1.5, attrs: { 'data-link': 'only-this-clip' } } : {}) })) }] });

test('legacy inspection retains its 300 clip view and explicitly reports the unreturned real timeline', () => {
  const source = document(), result = nativeOperationContext(source, known);
  assert.equal(result.clips.length, 300); assert.equal(result.clips.at(-1).id, 'clip-300'); assert.equal(result.truncated, true); assert.equal(result.scopeFiltered, false);
  assert.deepEqual(result.pagination, { total: 1000, offset: 0, limit: 300, hasMore: true, nextOffset: 300, totalInDocument: 1000 }); assert.match(result.truncationNote, /nextOffset/);
  const legacyScope = describeNativeTimeline(source, known, { assetIds: ['asset-b'], placement: { mode: 'append' } }); assert.equal(legacyScope.clips[0].editable, false); assert.equal(legacyScope.clips.length, 300);
});

test('real clip 301 is discoverable by paging and exact ID with speed/source/track/lock information', () => {
  const source = document(), scope = { assetIds: ['asset-a'], placement: { mode: 'append' } };
  const result = nativeOperationContext(source, known, scope, { offset: 300, limit: 7 }), target = result.clips[0];
  assert.equal(target.id, 'clip-301'); assert.equal(target.clipId, target.id); assert.equal(target.assetId, 'asset-a'); assert.equal(target.track, 0); assert.equal(target.at, 300); assert.equal(target.end, 300.5); assert.equal(target.speed, 1.5); assert.equal(target.sourceStart, 0); assert.equal(target.sourceEnd, .75); assert.equal(target.locked, false); assert.equal(target.disabled, false); assert.equal(target.linkGroup, 'only-this-clip');
  assert.deepEqual(result.pagination, { total: 600, offset: 300, limit: 7, hasMore: true, nextOffset: 307, totalInDocument: 1000 });
  const exact = nativeOperationContext(source, known, scope, { clipIds: ['clip-301'] }); assert.deepEqual(exact.clips.map(clip => clip.id), ['clip-301']); assert.equal(exact.pagination.total, 1);
  assert.equal(JSON.stringify(result).includes('a.mp4'), false); assert.deepEqual(source, document());
});

test('scope assets, range and selected clip IDs are applied before paging and query filters cannot broaden them', () => {
  const source = document(), scope = { assetIds: ['asset-b'], placement: { mode: 'range', start: 650, end: 680 } };
  const first = nativeOperationContext(source, known, scope, { limit: 10 }); assert.equal(first.clips[0].id, 'clip-651'); assert.equal(first.pagination.total, 30); assert.equal(first.pagination.nextOffset, 10);
  const second = nativeOperationContext(source, known, scope, { offset: 10, limit: 10 }); assert.equal(second.clips[0].id, 'clip-661');
  const outside = nativeOperationContext(source, known, scope, { clipIds: ['clip-301'], range: { start: 0, end: 3600 } }); assert.deepEqual(outside.clips, []); assert.equal(outside.pagination.total, 0);
  const chosen = { ...scope, placement: { ...scope.placement, clipIds: ['clip-675'] } }; const exact = nativeOperationContext(source, known, chosen, {}); assert.deepEqual(exact.clips.map(clip => clip.id), ['clip-675']);
  const intersection = nativeOperationContext(source, known, scope, { range: { start: 679, end: 700 } }); assert.deepEqual(intersection.clips.map(clip => clip.id), ['clip-680']);
});

test('crossing media remain visible for structural splitting and locked/disabled media are described without granting edits', () => {
  const source = document(); source.tracks[0].clips[300].time = [0, 4]; source.tracks[0].clips[300].speed = 1;
  const scope = { assetIds: ['asset-a'], placement: { mode: 'range', start: 301, end: 303, clipIds: ['clip-301'] } };
  const result = nativeOperationContext(source, known, scope, { clipIds: ['clip-301'] }); assert.equal(result.clips.length, 1); assert.equal(result.clips[0].editable, false); assert.equal(result.clips[0].canSplitInScope, true);
  source.tracks[0].locked = true; source.tracks[0].clips[300].disabled = true; const locked = nativeOperationContext(source, known, scope, {}).clips[0]; assert.equal(locked.locked, true); assert.equal(locked.disabled, true); assert.equal(locked.editable, false); assert.equal(locked.canSplitInScope, undefined);
});

test('whole-project inspection reads outside the write range and preserves trusted split and lock descriptions', () => {
  const source = document(); source.tracks[0].clips[300].time = [0, 4]; source.tracks[0].clips[300].speed = 1;
  source.tracks.push({ locked: true, clips: [{ id: 'locked-other-asset', src: 'b.mp4', at: 10, time: [0, 1] }] });
  const scope = { assetIds: ['asset-a'], placement: { mode: 'range', start: 301, end: 303, clipIds: ['clip-301'] } };
  const complete = nativeOperationContext(source, known, scope, { clipIds: ['clip-301', 'clip-999', 'locked-other-asset'] }, { inspectAll: true });
  assert.deepEqual(complete.clips.map(clip => clip.id), ['clip-301', 'clip-999', 'locked-other-asset']); assert.equal(complete.scopeFiltered, false);
  assert.equal(complete.clips[0].canSplitInScope, true); assert.deepEqual(complete.clips[0].splitRange, [301, 303]); assert.equal(complete.clips[0].editable, false);
  assert.equal(complete.clips[1].editable, false); assert.equal(complete.clips[2].locked, true); assert.equal(complete.clips[2].editable, false);
  assert.deepEqual(complete.tracks.map(track => track.index), [0, 1]);
  assert.throws(() => planNativeAdjustments(source, [{ action: 'volume', clipId: 'clip-999', value: .5 }], { known, editScope: scope }), error => error.code === 'NATIVE_ADJUST_SCOPE');
});

test('tracks beyond index 100 and their original indices are discoverable without slicing the wrong array', () => {
  const source = { stage: { w: 1280, h: 720 }, tracks: Array.from({ length: 120 }, (_, track) => ({ locked: track === 103, hidden: track === 104, muted: track === 105, clips: Array.from({ length: 10 }, (_, index) => ({ id: `track-${track}-clip-${index}`, src: 'a.mp4', at: index, time: [0, .5] })) })) };
  const legacy = describeNativeTimeline(source, known); assert.equal(legacy.tracks.length, 100); assert.equal(legacy.trackPagination.nextOffset, 100); assert.equal(legacy.truncated, true);
  const result = nativeOperationContext(source, known, undefined, { trackOffset: 100, trackLimit: 10, offset: 1000, limit: 100 }); assert.equal(result.tracks[0].index, 100); assert.equal(result.clips[0].track, 100); assert.equal(result.tracks.find(track => track.index === 103).locked, true); assert.equal(result.trackPagination.total, 120);
  const exact = nativeOperationContext(source, known, undefined, { trackIndices: [103], limit: 20 }); assert.equal(exact.clips.length, 10); assert.equal(exact.clips[0].locked, true); assert.deepEqual(exact.tracks.map(track => track.index), [103]);
});

test('the discovered source clip ID drives actual trim and native filter operations while 999 other clips remain intact', () => {
  const source = document(), scope = { assetIds: ['asset-a'], placement: { mode: 'range', start: 300, end: 301 } };
  const target = nativeOperationContext(source, known, scope, {}).clips[0]; assert.equal(target.clipId, 'clip-301');
  const trimmed = planNativeAdjustments(source, [{ action: 'trim', clipId: target.clipId, start: .1, end: .7 }], { known, editScope: scope });
  assert.deepEqual(trimmed.document.tracks[0].clips[300].time, [.1, .7]); assert.equal(trimmed.document.tracks[0].clips[300].at, 300); assert.equal(trimmed.document.tracks[0].clips[300].speed, 1.5);
  const filtered = planNativeOperations(trimmed.document, [{ action: 'filter', clipId: target.clipId, brightness: 1.2 }], { known, editScope: scope }); assert.match(filtered.document.tracks[0].clips[300].style, /brightness\(1.2\)/);
  for (let index = 0; index < 1000; index++) if (index !== 300) assert.deepEqual(filtered.document.tracks[0].clips[index], source.tracks[0].clips[index]);
});

test('invalid pagination and arbitrary file/path queries are rejected explicitly', () => {
  for (const options of [{ offset: -1 }, { limit: 301 }, { limit: 0 }, { trackLimit: 101 }, { clipIds: ['../private'] }, { trackIndices: [-1] }, { range: { start: 0, end: NATIVE_MAX_TIME_SECONDS + 1 } }, { range: { start: 2, end: 1 } }, { file: 'C:/private' }, []]) assert.throws(() => nativeOperationContext(document(), known, undefined, options), error => error.code === 'NATIVE_INSPECT_PAGE');
});
