import test from 'node:test';
import assert from 'node:assert/strict';
import { NATIVE_OPERATION_CATALOG, nativeOperationContext, planNativeOperations } from '../lib/native-operations.mjs';
import { readFilm } from '../integrations/openfilm/packages/openfilm/src/film-doc.mjs';
import { readVtt } from '../integrations/openfilm/packages/openfilm/src/captions.mjs';

const known = { 'a.mp4': { assetId: 'asset-a', duration: 20 }, 'b.mp4': { assetId: 'asset-b', duration: 20 }, 'music.wav': { assetId: 'music', duration: 20 } };
const document = () => ({ stage: { w: 1280, h: 720 }, tracks: [
  { clips: [{ id: 'a', src: 'a.mp4', time: [0, 4], at: 2, volume: .7, box: { x: 0, y: 0, w: 1280, h: 720 }, attrs: { title: '第一段', 'data-user': 'keep' } }] },
  { clips: [{ id: 'b', src: 'b.mp4', time: [0, 3], at: 10 }] },
  { clips: [{ id: 'music', src: 'music.wav', time: [0, 8], at: 0 }] },
] });
const plan = (doc, operations, options = {}) => planNativeOperations(doc, operations, { known, ...options });
const clip = (doc, id) => doc.tracks.flatMap(track => track.clips).find(clip => clip.id === id);
const code = wanted => error => error.code === wanted;
const scope = { assetIds: ['asset-a'], placement: { mode: 'range', start: 2, end: 6, clipIds: ['a'] } };

test('native catalog and context discover cross-track, grouped editing and full-project boundaries without host paths', () => {
  const value = nativeOperationContext(document(), known, scope);
  assert.ok(NATIVE_OPERATION_CATALOG.some(item => item.action === 'move_track'));
  assert.ok(NATIVE_OPERATION_CATALOG.some(item => item.action === 'stage' && item.wholeProject));
  assert.equal(value.clips[0].editable, true); assert.equal(value.clips[1].editable, false);
  assert.equal(JSON.stringify(value).includes('a.mp4'), false);
});

test('cross-track movement validates destinations and leaves every other clip unchanged', () => {
  const source = document(), other = structuredClone(source.tracks.slice(1));
  const moved = plan(source, [{ action: 'move_track', clipId: 'a', track: 1, at: 2 }], { editScope: scope }).document;
  assert.equal(moved.tracks.findIndex(track => track.clips.some(item => item.id === 'a')), 0, 'empty original track is removed by native engine');
  assert.deepEqual(clip(moved, 'b'), other[0].clips[0]); assert.deepEqual(clip(moved, 'music'), other[1].clips[0]);
  assert.throws(() => plan(source, [{ action: 'move_track', clipId: 'a', track: 1, at: 8 }]), code('NATIVE_OPERATION_COLLISION'));
  source.tracks[1].locked = true;
  assert.throws(() => plan(source, [{ action: 'move_track', clipId: 'a', track: 1, at: 2 }]), code('NATIVE_OPERATION_SCOPE'));
});

test('linking and grouped movement require all members and move atomically', () => {
  const linked = plan(document(), [{ action: 'link', clipIds: ['a', 'music'] }], { idFactory: () => 'link-group' }).document;
  assert.equal(clip(linked, 'a').attrs['data-link'], 'link-group'); assert.equal(clip(linked, 'music').attrs['data-link'], 'link-group');
  assert.throws(() => plan(linked, [{ action: 'group_move', clipIds: ['a'], delta: 1 }]), code('NATIVE_OPERATION_LINKED'));
  const moved = plan(linked, [{ action: 'group_move', clipIds: ['a', 'music'], delta: 1 }, { action: 'unlink', clipIds: ['a', 'music'] }]).document;
  assert.equal(clip(moved, 'a').at, 3); assert.equal(clip(moved, 'music').at, 1); assert.equal(clip(moved, 'a').attrs['data-link'], undefined);
});

test('detach audio creates a real linked sound clip and preserves source timing and volume', () => {
  let next = 0;
  const value = plan(document(), [{ action: 'detach_audio', clipId: 'a' }], { editScope: scope, idFactory: () => 'detached-' + (++next) }).document;
  const sound = clip(value, 'detached-2'); assert.equal(sound.sound, true); assert.equal(sound.src, 'a.mp4');
  assert.deepEqual(sound.time, [0, 4]); assert.equal(sound.at, 2); assert.equal(sound.volume, .7); assert.equal(clip(value, 'a').volume, 0);
  assert.equal(sound.attrs['data-link'], clip(value, 'a').attrs['data-link']); assert.ok(readFilm(value).doc);
});

test('whole-project structure never broadens range/asset scope and preserves lock constraints', () => {
  const source = document();
  assert.throws(() => plan(source, [{ action: 'stage', width: 720, height: 1280 }], { editScope: scope }), code('NATIVE_OPERATION_WHOLE_PROJECT_REQUIRED'));
  assert.throws(() => plan(source, [{ action: 'track_reorder', from: 0, to: 1 }], { editScope: { assetIds: ['asset-a'], placement: { mode: 'append' } } }), code('NATIVE_OPERATION_WHOLE_PROJECT_REQUIRED'));
  const staged = plan(source, [{ action: 'stage', width: 720, height: 1280 }, { action: 'track_reorder', from: 0, to: 1 }, { action: 'track_set', track: 0, field: 'muted', value: true }]).document;
  assert.deepEqual(staged.stage, { w: 720, h: 1280 }); assert.equal(staged.tracks[0].clips[0].id, 'b'); assert.equal(staged.tracks[0].muted, true);
  source.tracks[0].locked = true;
  assert.throws(() => plan(source, [{ action: 'track_set', track: 0, field: 'muted', value: true }]), code('NATIVE_OPERATION_SCOPE'));
  assert.throws(() => plan(source, [{ action: 'stage', width: 720, height: 1280 }]), code('NATIVE_OPERATION_SCOPE'));
  const unlocked = plan(source, [{ action: 'track_set', track: 0, field: 'locked', value: false }]).document; assert.equal(unlocked.tracks[0].locked, undefined);
});

test('fit, crop and numeric filters build bounded style declarations without raw code input', () => {
  const value = plan(document(), [{ action: 'fit', clipId: 'a', mode: 'cover', x: 30, y: 50 }, { action: 'crop', clipId: 'a', left: 10, right: 5, radius: 3 }, { action: 'filter', clipId: 'a', brightness: 1.1, hue: -20, blur: 2 }], { editScope: scope }).document;
  assert.match(clip(value, 'a').style, /object-fit: cover/); assert.match(clip(value, 'a').style, /inset\(0% 5% 0% 10% round 3%\)/); assert.match(clip(value, 'a').style, /hue-rotate\(-20deg\)/);
  assert.throws(() => plan(document(), [{ action: 'filter', clipId: 'a', style: 'url(file:///secret)' }]), code('NATIVE_OPERATION_INVALID'));
  assert.throws(() => plan(document(), [{ action: 'crop', clipId: 'a', left: 60, right: 40 }]), code('NATIVE_OPERATION_INVALID'));
  assert.throws(() => plan(document(), [{ action: 'fit', clipId: 'a', mode: 'cover; background:url(https://evil)' }]), code('NATIVE_OPERATION_INVALID'));
});

test('a later invalid expanded operation never changes the original document', () => {
  const source = document();
  assert.throws(() => plan(source, [{ action: 'volume', clipId: 'a', value: .4 }, { action: 'move_track', clipId: 'a', track: 1, at: 8 }]), code('NATIVE_OPERATION_COLLISION'));
  assert.deepEqual(source, document());
  const disabled = plan(source, [{ action: 'enabled', clipId: 'a', value: false }], { editScope: scope }).document;
  assert.equal(clip(disabled, 'a').disabled, true);
  const enabled = plan(disabled, [{ action: 'enabled', clipId: 'a', value: true }], { editScope: scope }).document;
  assert.equal(clip(enabled, 'a').disabled, undefined);
});

test('typed asset insertion and escaped generated captions create only owned sources', () => {
  const media = { ...known, 'a.mp4': { ...known['a.mp4'], type: 'video', name: 'Video' } };
  const result = planNativeOperations(document(), [{ action: 'asset_insert', assetId: 'asset-a', at: 2, start: 5, end: 9 }, { action: 'caption_add', text: '<script>alert(1)</script>', at: 2, duration: 2, color: '#FFD700' }], { known: media, editScope: scope });
  assert.equal(result.files.length, 1); assert.match(result.files[0].path, /^pages\/gx-operation-/); assert.match(result.files[0].content, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  const inserted = result.document.tracks.flatMap(track => track.clips).find(item => item.id === result.results[0].createdClipId);
  assert.deepEqual(inserted.time, [5, 9]); assert.equal(inserted.src, 'a.mp4');
  assert.throws(() => planNativeOperations(document(), [{ action: 'asset_insert', assetId: 'asset-b', at: 2, end: 4 }], { known: media, editScope: scope }), code('NATIVE_OPERATION_SCOPE'));
});

test('WebVTT cue creation and replacement validate whole-track scope and preserve source text as text', () => {
  const result = plan(document(), [{ action: 'subtitles_write', cues: [{ start: 2, end: 3, text: '<b>literal</b> --> user' }] }], { editScope: scope });
  assert.match(result.files[0].content, /00:00:02.000 --> 00:00:03.000/); assert.match(result.files[0].content, /&lt;b&gt;literal&lt;\/b&gt; --&gt; user/);
  const track = result.document.tracks.length - 1;
  assert.throws(() => plan(result.document, [{ action: 'subtitles_write', track, cues: [{ start: 2, end: 4, text: '替换' }] }], { editScope: scope }), code('NATIVE_OPERATION_WHOLE_PROJECT_REQUIRED'));
  const replaced = plan(result.document, [{ action: 'subtitles_write', track, cues: [{ start: 1, end: 4, text: '替换' }] }]);
  assert.notEqual(replaced.document.tracks[track].captions.src, result.document.tracks[track].captions.src);
  const removed = plan(replaced.document, [{ action: 'subtitles_remove', track }]); assert.equal(removed.document.tracks.length, document().tracks.length);
});

test('precise WebVTT edits preserve unrelated cues, style and track metadata within dialogue bounds', () => {
  const doc = document(), src = 'captions/original.vtt', vtt = readVtt('WEBVTT\n\nSTYLE\n::cue { color: yellow; }\n\n00:00:00.000 --> 00:00:01.000\nOutside\n\n00:00:02.000 --> 00:00:03.000\nInside\n');
  doc.tracks.push({ clips: [], muted: true, attrs: { title: 'Keep title' }, captions: { src, kind: 'subtitles', label: 'Keep label' } });
  const options = { known, editScope: { placement: { mode: 'range', start: 2, end: 4 } }, subtitleSources: { [src]: vtt } };
  const result = planNativeOperations(doc, [{ action: 'subtitles_edit', track: 3, edits: [{ action: 'update', index: 1, text: '<em>Literal</em>' }, { action: 'insert', index: 2, start: 3, end: 4, text: 'New sentence' }] }], options);
  const next = readVtt(result.files[0].content);
  assert.equal(next.cues[0].text, 'Outside'); assert.equal(next.cues[1].text, '&lt;em&gt;Literal&lt;/em&gt;'); assert.equal(next.cues[2].text, 'New sentence');
  assert.deepEqual(next.styles, vtt.styles); assert.equal(result.document.tracks[3].muted, true); assert.deepEqual(result.document.tracks[3].attrs, doc.tracks[3].attrs); assert.equal(result.requiresRestore, true);
  assert.equal(options.subtitleSources[src].cues.length, 2);
  assert.throws(() => planNativeOperations(doc, [{ action: 'subtitles_edit', track: 3, edits: [{ action: 'update', index: 0, text: 'No' }] }], options), code('NATIVE_OPERATION_SCOPE'));
  assert.throws(() => planNativeOperations(doc, [{ action: 'subtitles_edit', track: 3, edits: [null] }], options), code('NATIVE_OPERATION_INVALID'));
});
