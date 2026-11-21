import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { describeNativeTimeline, nativeMotionHash, nativeTimelineEditLimits, NATIVE_MAX_TIME_SECONDS, planNativeAdjustments } from '../lib/native-adjustments.mjs';
import { nativeOperationCatalogForLimit, planNativeOperations } from '../lib/native-operations.mjs';
import { createAssistantAppTools } from '../lib/assistant-app-tools.mjs';
import { createProjectStore } from '../lib/store.mjs';
import { createVideoService } from '../lib/video.mjs';
import { createOpenFilmManager } from '../lib/openfilm.mjs';
import { filmHtml, readFilm, readFilmFile } from '../integrations/openfilm/packages/openfilm/src/film-doc.mjs';
import { readMotion, writeMotion } from '../integrations/openfilm/packages/openfilm/src/clip-motion.mjs';

const known = { 'a.mp4': { assetId: 'asset-a', type: 'video', duration: 5000 }, 'b.mp4': { assetId: 'asset-b', type: 'video', duration: 5000 } };
const doc = (duration = 10) => ({ stage: { w: 1280, h: 720 }, tracks: [{ clips: [{ id: 'a', src: 'a.mp4', at: 0, time: [0, duration] }] }] });
const clipOf = (value, id = 'a') => value.tracks.flatMap(track => track.clips).find(clip => clip.id === id);
function curvedDoc() {
  const value = doc(), clip = value.tracks[0].clips[0];
  const curves = { translate: Array.from({ length: 80 }, (_, index) => ({ t: index / 8, v: [index, index % 3], ...(index % 4 === 0 ? { ease: 'ease-in' } : index % 4 === 1 ? { ease: 'hold' } : index % 4 === 2 ? { ease: 'cubic-bezier(0.2, 0.1, 0.8, 0.9)' } : {}) })), opacity: [{ t: 0, v: .5 }, { t: 10, v: 1 }] };
  const written = writeMotion(clip, curves); clip.style = written.style; value.keyframes = Object.fromEntries(Object.entries(written.keyframes).filter(([, value]) => value !== null));
  return value;
}
const adjust = (value, edits) => planNativeAdjustments(value, edits, { known });
const operate = (value, operations, options = {}) => planNativeOperations(value, operations, { known, ...options });
const code = value => error => error.code === value;
const patchKeys = keys => keys.map(key => ({ time: key.t, x: key.v[0] + 10, y: key.v[1] }));

test('default motion view labels its 40-of-80 snapshot and a one-clip property page can read all keys', () => {
  const source = curvedDoc(), original = readMotion(clipOf(source), source.keyframes).translate;
  const view = describeNativeTimeline(source, known); assert.equal(view.clips[0].motion.translate.length, 40); assert.equal(view.clips[0].motionCoverage.translate.totalKeys, 80); assert.equal(view.clips[0].motionCoverage.translate.truncated, true); assert.equal(view.clips[0].motionComplete, false); assert.equal(view.truncated, true);
  const full = describeNativeTimeline(source, known, undefined, { clipIds: ['a'], motionProperty: 'translate', motionKeyLimit: 100 });
  assert.equal(full.clips.length, 1); assert.equal(full.clips[0].motion.translate.length, 80); assert.equal(full.clips[0].motionCoverage.translate.truncated, false); assert.equal(full.clips[0].motionCoverage.translate.sha256, nativeMotionHash(original));
  assert.throws(() => describeNativeTimeline(source, known, undefined, { motionProperty: 'translate', motionKeyLimit: 200 }), code('NATIVE_INSPECT_PAGE'));
});

test('a default replacement from an incomplete 40-key snapshot is rejected without deleting the 80-key source', () => {
  const source = curvedDoc(), before = structuredClone(source), keys = readMotion(clipOf(source), source.keyframes).translate;
  assert.throws(() => adjust(source, [{ action: 'motion', clipId: 'a', property: 'translate', keys: patchKeys(keys.slice(0, 40)) }]), code('NATIVE_ADJUST_MOTION_INCOMPLETE'));
  assert.deepEqual(source, before); assert.equal(readMotion(clipOf(source), source.keyframes).translate.length, 80);
});

test('two patch batches update all 80 translations while preserving time, other coordinates, easing and other properties', () => {
  const source = curvedDoc(), original = readMotion(clipOf(source), source.keyframes), first = adjust(source, [{ action: 'motion', clipId: 'a', property: 'translate', mode: 'patch', keys: patchKeys(original.translate.slice(0, 40)) }]);
  const partial = readMotion(clipOf(first.document), first.document.keyframes);
  assert.equal(partial.translate.length, 80); assert.deepEqual(partial.translate.slice(40), original.translate.slice(40)); assert.deepEqual(partial.opacity, original.opacity);
  const second = adjust(first.document, [{ action: 'motion', clipId: 'a', property: 'translate', mode: 'patch', expectedMotionHash: first.results[0].sha256, keys: patchKeys(original.translate.slice(40)) }]);
  const actual = readMotion(clipOf(second.document), second.document.keyframes); assert.equal(actual.translate.length, 80);
  for (const [index, key] of actual.translate.entries()) { assert.equal(key.t, original.translate[index].t); assert.equal(key.v[0], original.translate[index].v[0] + 10); assert.equal(key.v[1], original.translate[index].v[1]); assert.equal(key.ease, original.translate[index].ease); }
  assert.deepEqual(actual.opacity, original.opacity);
});

test('two patches in one atomic batch merge against the current working curve', () => {
  const source = curvedDoc(), original = readMotion(clipOf(source), source.keyframes).translate;
  const changed = adjust(source, [{ action: 'motion', clipId: 'a', property: 'translate', mode: 'patch', keys: patchKeys(original.slice(0, 40)) }, { action: 'motion', clipId: 'a', property: 'translate', mode: 'patch', keys: patchKeys(original.slice(40)) }]);
  const result = readMotion(clipOf(changed.document), changed.document.keyframes).translate; assert.equal(result.length, 80); assert.ok(result.every((key, index) => key.v[0] === original[index].v[0] + 10));
});

test('explicit replacement requires the current complete hash and stale hashes reject the whole batch', () => {
  const source = curvedDoc(), original = readMotion(clipOf(source), source.keyframes).translate;
  assert.throws(() => adjust(source, [{ action: 'volume', clipId: 'a', value: .4 }, { action: 'motion', clipId: 'a', property: 'translate', replaceAll: true, expectedMotionHash: '0'.repeat(64), keys: [] }]), code('NATIVE_ADJUST_MOTION_STALE'));
  const replaced = adjust(source, [{ action: 'motion', clipId: 'a', property: 'translate', mode: 'replace', replaceAll: true, expectedMotionHash: nativeMotionHash(original), keys: [{ time: 0, x: 20, y: 0 }, { time: 5, x: 40, y: 0 }] }]);
  assert.equal(readMotion(clipOf(replaced.document), replaced.document.keyframes).translate.length, 2); assert.equal(clipOf(source).volume, undefined);
  assert.throws(() => adjust(source, [{ action: 'motion', clipId: 'a', property: 'translate', mode: 'patch', keys: [] }]), /至少提供/);
});

test('patching still validates lock and scope before changing any keyframes', () => {
  const source = curvedDoc(), keys = patchKeys(readMotion(clipOf(source), source.keyframes).translate.slice(0, 40)); source.tracks[0].locked = true;
  assert.throws(() => adjust(source, [{ action: 'motion', clipId: 'a', property: 'translate', mode: 'patch', keys }]), code('NATIVE_ADJUST_SCOPE'));
  source.tracks[0].locked = false;
  assert.throws(() => planNativeAdjustments(source, [{ action: 'motion', clipId: 'a', property: 'translate', mode: 'patch', keys }], { known, editScope: { assetIds: ['asset-b'], placement: { mode: 'append' } } }), code('NATIVE_ADJUST_SCOPE'));
});

function grouped(count = 41) { return { stage: { w: 1280, h: 720 }, tracks: [{ clips: Array.from({ length: count }, (_, index) => ({ id: 'g' + index, src: 'a.mp4', at: index, time: [0, 1], attrs: { 'data-link': 'group-a' } })) }] }; }
test('41 explicit member IDs and a complete groupId both support actual unlinking', () => {
  const source = grouped(), changed = operate(source, [{ action: 'unlink', clipIds: source.tracks[0].clips.map(clip => clip.id) }]); assert.equal(changed.touchedClipIds.length, 41); assert.ok(changed.document.tracks[0].clips.every(clip => !clip.attrs?.['data-link']));
  const large = grouped(500), moved = operate(large, [{ action: 'group_move', groupId: 'group-a', delta: 10 }]); assert.equal(moved.touchedClipIds.length, 500); assert.ok(moved.document.tracks[0].clips.every((clip, index) => clip.at === index + 10));
});
test('groupId cannot widen scope, ignore a locked member, select an unknown group or mix selectors', () => {
  const source = grouped(); source.tracks[0].clips[40].locked = true; assert.throws(() => operate(source, [{ action: 'unlink', groupId: 'group-a' }]), code('NATIVE_OPERATION_SCOPE')); source.tracks[0].clips[40].locked = false;
  assert.throws(() => operate(source, [{ action: 'group_move', groupId: 'group-a', delta: 1 }], { editScope: { placement: { mode: 'range', start: 0, end: 20 } } }), code('NATIVE_OPERATION_SCOPE'));
  assert.throws(() => operate(source, [{ action: 'unlink', groupId: 'absent' }]), code('NATIVE_OPERATION_STALE'));
  assert.throws(() => operate(source, [{ action: 'unlink', groupId: 'group-a', clipIds: ['g0'] }]), /二选一/); assert.ok(source.tracks[0].clips.every(clip => clip.attrs['data-link'] === 'group-a'));
});

test('existing long timelines can grow while source durations and numeric precision stay authoritative', () => {
  const source = doc(4000), reduced = adjust(source, [{ action: 'trim', clipId: 'a', end: 3900 }]); assert.equal(clipOf(reduced.document).time[1], 3900); assert.equal(nativeTimelineEditLimits(source, known).maxEditedTimelineSeconds, NATIVE_MAX_TIME_SECONDS);
  assert.equal(clipOf(adjust(source, [{ action: 'trim', clipId: 'a', end: 4100 }]).document).time[1], 4100); assert.equal(clipOf(adjust(source, [{ action: 'move', clipId: 'a', at: 1 }]).document).at, 1);
  assert.throws(() => adjust(source, [{ action: 'trim', clipId: 'a', end: 5001 }]), /实际时长/);
  assert.throws(() => adjust(source, [{ action: 'move', clipId: 'a', at: NATIVE_MAX_TIME_SECONDS - 3999 }]), /精确/);
  const batch = operate(source, [{ action: 'trim', clipId: 'a', end: 3900 }, { action: 'trim', clipId: 'a', end: 3990 }]); assert.equal(clipOf(batch.document).time[1], 3990);
  const sameLength = operate(source, [{ action: 'asset_insert', assetId: 'asset-b', at: 3900, start: 0, end: 100 }]); assert.equal(sameLength.document.tracks.at(-1).clips[0].at, 3900);
});
test('new long insertions and enabling valid long clips no longer impose an hour growth cap', () => {
  const source = doc(100), inserted = operate(source, [{ action: 'asset_insert', assetId: 'asset-b', at: 100, end: 4000 }]); assert.equal(inserted.document.tracks.at(-1).clips[0].at, 100);
  source.tracks.push({ clips: [{ id: 'disabled', src: 'b.mp4', at: 0, time: [0, 4000], disabled: true }] });
  assert.equal(clipOf(operate(source, [{ action: 'enabled', clipId: 'disabled', value: true }]).document, 'disabled').disabled, undefined); assert.equal(clipOf(source, 'disabled').disabled, true);
  assert.throws(() => operate(source, [{ action: 'asset_insert', assetId: 'asset-b', at: 0, end: 5001 }]), code('NATIVE_OPERATION_INVALID'));
  const catalog = nativeOperationCatalogForLimit(4000); assert.equal(catalog.find(item => item.action === 'move_track').parameters.properties.at.maximum, 4000); assert.equal(catalog.find(item => item.action === 'unlink').parameters.properties.clipIds.maxItems, 200);
});

test('source coordinates beyond a day and timeline growth remain editable with actual duration checks', () => {
  const media = { 'long.mp4': { assetId: 'long-asset', type: 'video', duration: 100000 } }, source = { stage: { w: 1280, h: 720 }, tracks: [{ clips: [{ id: 'tail', src: 'long.mp4', at: 4000, time: [90000, 90002] }] }] }, original = structuredClone(source);
  const trimmed = planNativeAdjustments(source, [{ action: 'trim', clipId: 'tail', end: 90003 }, { action: 'move', clipId: 'tail', at: 95000 }, { action: 'duplicate', clipId: 'tail', at: 96000 }], { known: media });
  assert.equal(trimmed.document.tracks[0].clips.length, 2); assert.deepEqual(trimmed.document.tracks[0].clips[0].time, [90000, 90003]); assert.equal(trimmed.document.tracks[0].clips[1].at, 96000);
  const captioned = planNativeOperations(trimmed.document, [{ action: 'caption_add', text: 'Long timeline title', at: 95000, duration: 3 }, { action: 'subtitles_write', cues: [{ start: 95000, end: 95003, text: 'Long timeline cue' }] }], { known: media });
  assert.match(captioned.files.find(file => file.path.endsWith('.vtt')).content, /26:23:20\.000 --> 26:23:23\.000/);
  for (const at of [NaN, Infinity, -1, NATIVE_MAX_TIME_SECONDS + 1, '95000']) assert.throws(() => planNativeAdjustments(source, [{ action: 'move', clipId: 'tail', at }], { known: media }));
  assert.throws(() => planNativeOperations(source, [{ action: 'asset_insert', assetId: 'long-asset', at: 95000, start: 90000, end: 90001 }, { action: 'asset_insert', assetId: 'long-asset', at: 96000, end: 100001 }], { known: media }));
  const range = { placement: { mode: 'range', start: 4000, end: 4002, clipIds: ['tail'] } };
  assert.throws(() => planNativeAdjustments(source, [{ action: 'move', clipId: 'tail', at: 5000 }], { known: media, editScope: range }), code('NATIVE_ADJUST_OUTSIDE_SCOPE'));
  assert.deepEqual(source, original);
});

test('real app tools preserve independent track pages, long growing edits and complete motion curves', { skip: process.env.GUANGXUAN_TEST_OPENFILM !== '1', timeout: 90000 }, async t => {
  const root = path.resolve(import.meta.dirname, '..'), parent = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()), directory = await mkdtemp(path.join(parent, 'gx-native-safety-')), dataDir = path.join(directory, 'data');
  const binary = name => process.env['GUANGXUAN_' + name.toUpperCase()] || path.join(process.env.GUANGXUAN_BIN_DIR || '', name + (process.platform === 'win32' ? '.exe' : '')), execute = promisify(execFile);
  let manager, app, videoService, store;
  t.after(async () => { await app?.close(); await manager?.close(); await videoService?.close(); await store?.settle(); assert.equal(path.dirname(path.resolve(directory)), parent); assert.ok(path.basename(directory).startsWith('gx-native-safety-')); await rm(directory, { recursive: true, force: true }); });
  const sourceFile = path.join(directory, 'sparse-long.mp4'); await execute(binary('ffmpeg'), ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=1/1000:d=95000', '-an', '-c:v', 'libx264', '-threads', '1', '-g', '1', '-pix_fmt', 'yuv420p', sourceFile], { windowsHide: true, timeout: 30000 });
  store = await createProjectStore(dataDir); videoService = await createVideoService({ dataDir, root, ffmpegPath: binary('ffmpeg'), ffprobePath: binary('ffprobe') });
  const imported = await videoService.importLocalFile(sourceFile), projectId = 'native-safety-fixture', origin = 'http://127.0.0.1:49793'; assert.equal(imported.duration, 95000);
  await store.save(projectId, { kind: 'video', title: 'Isolated native safety verification', video: { timeline: [], aspect: '16:9', resolution: '720' } });
  const managerOptions = { dataDir, root, store, resolveAsset: id => videoService.resolveAsset(id), registerOwnedAsset: (...args) => videoService.registerOwnedAsset(...args) };
  manager = await createOpenFilmManager(managerOptions); const first = await manager.context(projectId, origin); await manager.importAsset(projectId, imported.id, origin, { expectedRevision: first.revision, requestId: 'native-safety-import' });
  const native = await manager.context(projectId, origin), asset = native.assets[0], nativeRoot = path.join(dataDir, 'openfilm/projects', projectId), filmFile = path.join(nativeRoot, 'film.html'), originalAsset = await videoService.resolveAsset(asset.id), src = path.relative(nativeRoot, originalAsset.path).replaceAll('\\', '/');
  const evidence = { actualNative: true, actualAppTools: true, actualModelHttp: 0, userProjectModified: false, sourceDuration: 95000, checks: [] };
  const context = () => ({ projectId, runId: randomUUID(), instruction: '在本独立工程精确调整允许片段。', editScope: { placement: { mode: 'free' } }, mode: 'auto', origin, settings: {}, signal: new AbortController().signal, update() {} });
  async function setDocument(value) { await app?.close(); await manager.close(); await writeFile(filmFile, filmHtml(value)); manager = await createOpenFilmManager(managerOptions); app = createAssistantAppTools({ store, openFilm: manager, videoService, root, ai: async () => { throw new Error('No real model call is permitted.'); } }); return manager.context(projectId, origin); }
  const call = (name, args, ctx) => app.tools.find(tool => tool.name === name).execute(args, ctx);
  const read = async () => readFilmFile(await readFile(filmFile, 'utf8')).doc;
  const makeClip = (id, at = 0, end = 1) => ({ id, src, at, time: [0, end] });
  await setDocument({ stage: native.stage, tracks: Array.from({ length: 120 }, (_, track) => ({ locked: track === 103, clips: [makeClip('track-' + track)] })) });
  const tracks = await call('native_inspect', { limit: 1, trackOffset: 100, trackLimit: 20 }, context()); assert.equal(tracks.data.tracks.length, 20); assert.equal(tracks.data.tracks[3].index, 103); assert.equal(tracks.data.tracks[3].locked, true); assert.equal(tracks.data.tracks[0].returnedClipCount, 0); assert.equal(tracks.data.tracks[0].clipCount, 1); evidence.checks.push({ kind: 'independent-track-page', returnedTracks: 20, lockedTrack: 103 });
  const groupDoc = { stage: native.stage, tracks: [{ clips: Array.from({ length: 41 }, (_, index) => ({ ...makeClip('linked-' + index, index), attrs: { 'data-link': 'native-group' } })) }] }; await setDocument(groupDoc);
  const groupedResult = await call('native_operation', { operations: [{ action: 'unlink', groupId: 'native-group' }] }, context()); assert.equal(groupedResult.data.touchedClipIds.length, 41); assert.ok((await read()).tracks[0].clips.every(clip => !clip.attrs?.['data-link'])); evidence.checks.push({ kind: 'groupId-unlink', members: 41, actualReceipt: true });
  await setDocument({ stage: native.stage, tracks: [{ clips: [makeClip('long', 0, 4000)] }] }); const longCtx = context(); const trimmed = await call('native_adjust', { edits: [{ action: 'trim', clipId: 'long', end: 3900 }] }, longCtx); assert.equal(trimmed.data.duration, 3900);
  const grown = await call('native_adjust', { edits: [{ action: 'trim', clipId: 'long', end: 4100 }] }, longCtx); assert.equal(grown.data.duration, 4100);
  const stable = await readFile(filmFile, 'utf8'); await assert.rejects(call('native_adjust', { edits: [{ action: 'trim', clipId: 'long', end: 95001 }] }, longCtx)); assert.equal(await readFile(filmFile, 'utf8'), stable);
  const limits = await call('native_operation_catalog', { actions: ['move_track'] }, longCtx); assert.equal(limits.data.limits.maxEditedTimelineSeconds, NATIVE_MAX_TIME_SECONDS); assert.equal(limits.data.catalog[0].parameters.properties.at.maximum, NATIVE_MAX_TIME_SECONDS); assert.equal(limits.data.limits.legacyExportRangeMaxSeconds, NATIVE_MAX_TIME_SECONDS);
  const inserted = await call('native_operation', { operations: [{ action: 'asset_insert', assetId: asset.id, at: 4100, start: 94000, end: 94001 }] }, longCtx); assert.equal(inserted.data.duration, 4101); assert.equal((await read()).tracks.at(-1).clips[0].at, 4100); assert.deepEqual((await read()).tracks.at(-1).clips[0].time, [94000, 94001]);
  const undo = await call('assistant_undo_apply', { undoId: inserted.effects[0].undo.id }, longCtx); assert.equal(undo.data.restored, true); assert.equal((await manager.context(projectId, origin)).duration, 4100); assert.equal(await readFile(filmFile, 'utf8'), stable);
  const beforeBridge = await manager.context(projectId, origin), bridged = await manager.applyPlan(projectId, { timeline: [{ assetId: asset.id, start: 94000, end: 94001 }] }, origin, beforeBridge.revision, { keepUndo: true, editScope: { placement: { mode: 'append' } } });
  assert.equal(bridged.placement.at, 4100); assert.equal(bridged.duration, 4101); await manager.undoAssistant(projectId, bridged.undo.id, origin); assert.equal(await readFile(filmFile, 'utf8'), stable);
  const beforeAsset = await manager.context(projectId, origin), appended = await manager.appendAsset(projectId, asset.id, origin, 96000, { keepUndo: true, expectedRevision: beforeAsset.revision });
  assert.equal(appended.duration, 191000); await manager.undoAssistant(projectId, appended.undo.id, origin); assert.equal(await readFile(filmFile, 'utf8'), stable);
  evidence.checks.push({ kind: 'long-timeline-growth', originalDuration: 4000, grownDuration: 4100, insertedTailDuration: 4101, sourceRangeBeyondADay: [94000, 94001], invalidSourceRejected: true, undoRestoredExactFilmBytes: true });
  evidence.checks.push({ kind: 'bridge-and-asset-placement', bridgedAppendAt: 4100, sourceRange: [94000, 94001], directAssetPlacementAt: 96000, directAssetTimelineDuration: 191000, eachUndoRestoredExactFilmBytes: true });
  await setDocument({ stage: native.stage, tracks: [{ clips: [makeClip('long-tail', 0, 4000)] }] });
  const tailCtx = { ...context(), editScope: { placement: { mode: 'range', start: 3900, end: 4000, clipIds: ['long-tail'] } } };
  const tailRead = await call('native_inspect', { clipIds: ['long-tail'] }, tailCtx); assert.equal(tailRead.data.clips[0].canSplitInScope, true);
  const split = await call('native_adjust', { edits: [{ action: 'split', clipId: 'long-tail', at: 3900 }] }, tailCtx), tailId = split.data.results[0].createdClipId, afterSplit = await read(), outside = structuredClone(clipOf(afterSplit, 'long-tail'));
  await call('native_adjust', { edits: [{ action: 'trim', clipId: tailId, end: 3950 }] }, tailCtx); const afterTail = await read(); assert.deepEqual(clipOf(afterTail, 'long-tail'), outside); assert.deepEqual(clipOf(afterTail, tailId).time, [3900, 3950]); assert.equal(clipOf(afterTail, tailId).at, 3900);
  evidence.checks.push({ kind: 'existing-long-tail-scope', range: [3900, 4000], actualSplitAndTrim: true, outsideClipUnchanged: true });
  const curve = curvedDoc(); curve.tracks[0].clips[0].src = src; await setDocument(curve); const motionCtx = context(), originalMotion = readMotion(clipOf(await read()), (await read()).keyframes), originalKeys = originalMotion.translate;
  const summary = await call('native_inspect', { clipIds: ['a'] }, motionCtx); assert.equal(summary.data.clips[0].motion.translate.length, 40); assert.equal(summary.data.clips[0].motionCoverage.translate.totalKeys, 80); const motionBefore = await readFile(filmFile, 'utf8');
  await assert.rejects(call('native_adjust', { edits: [{ action: 'motion', clipId: 'a', property: 'translate', keys: patchKeys(originalKeys.slice(0, 40)) }] }, motionCtx), { code: 'NATIVE_ADJUST_MOTION_INCOMPLETE' }); assert.equal(await readFile(filmFile, 'utf8'), motionBefore);
  const pages = [await call('native_motion_read', { clipId: 'a', property: 'translate', offset: 0, limit: 40 }, motionCtx), await call('native_motion_read', { clipId: 'a', property: 'translate', offset: 40, limit: 40 }, motionCtx)]; assert.equal(pages[0].data.nextOffset, 40); assert.equal(pages[1].data.keys.length, 40); assert.equal(pages[1].data.nextOffset, null);
  const firstPatch = await call('native_adjust', { edits: [{ action: 'motion', clipId: 'a', property: 'translate', mode: 'patch', keys: pages[0].data.keys.map(key => ({ time: key.time, x: key.x + 10, y: key.y })) }] }, motionCtx);
  const partialDoc = await read(), partialKeys = readMotion(clipOf(partialDoc), partialDoc.keyframes).translate; assert.equal(partialKeys.length, 80); assert.deepEqual(partialKeys.slice(40), originalKeys.slice(40));
  await assert.rejects(call('native_adjust', { edits: [{ action: 'motion', clipId: 'a', property: 'translate', replaceAll: true, expectedMotionHash: pages[0].data.sha256, keys: [] }] }, motionCtx), { code: 'NATIVE_ADJUST_MOTION_STALE' });
  await call('native_adjust', { edits: [{ action: 'motion', clipId: 'a', property: 'translate', mode: 'patch', expectedMotionHash: firstPatch.data.results[0].sha256, keys: pages[1].data.keys.map(key => ({ time: key.time, x: key.x + 10, y: key.y })) }] }, motionCtx);
  const changedDoc = await read(), actual = readMotion(clipOf(changedDoc), changedDoc.keyframes); assert.equal(actual.translate.length, 80);
  for (let index = 0; index < 80; index++) { assert.equal(actual.translate[index].v[0], originalKeys[index].v[0] + 10); assert.equal(actual.translate[index].v[1], originalKeys[index].v[1]); assert.equal(actual.translate[index].t, originalKeys[index].t); assert.equal(actual.translate[index].ease, originalKeys[index].ease); } assert.deepEqual(actual.opacity, originalMotion.opacity);
  const full = await call('native_motion_read', { clipId: 'a', property: 'translate', limit: 100 }, motionCtx); assert.equal(full.data.totalKeys, 80); assert.equal(full.data.truncated, false);
  await call('native_adjust', { edits: [{ action: 'motion', clipId: 'a', property: 'translate', replaceAll: true, expectedMotionHash: full.data.sha256, keys: [{ time: 0, x: 10, y: 0 }, { time: 5, x: 100, y: 0 }] }] }, motionCtx); const replaced = await read(); assert.equal(readMotion(clipOf(replaced), replaced.keyframes).translate.length, 2);
  const current = await manager.context(projectId, origin); await manager.adjustClips(projectId, [{ action: 'volume', clipId: 'a', value: .4 }], origin, current.revision); await assert.rejects(call('native_adjust', { edits: [{ action: 'volume', clipId: 'a', value: .3 }] }, motionCtx), { code: 'ASSISTANT_CONFLICT' });
  evidence.checks.push({ kind: 'motion-integrity', originalKeys: 80, defaultSnapshotKeys: 40, incompleteReplacementRejected: true, completeReadKeys: 80, all80Translated: true, easingTimeAndOtherCoordinatePreserved: true, staleHashRejected: true, explicitCurrentHashReplacementAllowed: true, nativeCasPreserved: true });
  if (process.env.GUANGXUAN_NATIVE_SAFETY_EVIDENCE) { const target = path.resolve(process.env.GUANGXUAN_NATIVE_SAFETY_EVIDENCE); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, JSON.stringify(evidence, null, 2)); }
});
