import test from 'node:test';
import assert from 'node:assert/strict';
import { planNativeAdjustments, describeNativeTimeline, NATIVE_ADJUST_ACTIONS } from '../lib/native-adjustments.mjs';
import { clipFade } from '../integrations/openfilm/packages/openfilm/src/film-doc.mjs';
import { readMotion } from '../integrations/openfilm/packages/openfilm/src/clip-motion.mjs';

const known = { 'a.mp4': { assetId: 'asset-a', name: '可用视频', duration: 30 }, 'b.mp4': { assetId: 'asset-b', name: '其它视频', duration: 10 }, 'music.wav': { assetId: 'asset-music', name: '配乐', duration: 30 } };
const document = () => ({ stage: { w: 1280, h: 720 }, tracks: [
  { attrs: { id: 'picture' }, clips: [{ id: 'clip-a', src: 'a.mp4', time: [2, 10], at: 2, volume: .7, box: { x: 10, y: 20, w: 1000, h: 600 }, style: 'object-fit: cover; opacity: .8', attrs: { title: '第一段', 'data-user': 'keep' } }, { id: 'clip-b', src: 'b.mp4', time: [0, 4], at: 12 }] },
  { clips: [{ id: 'music', src: 'music.wav', time: [0, 20], volume: .2 }] },
] });
const scope = { assetIds: ['asset-a'], placement: { mode: 'range', start: 2, end: 10, clipIds: ['clip-a'] } };
const plan = (doc, edits, extra = {}) => planNativeAdjustments(doc, edits, { known, ...extra });
const clip = (doc, id) => doc.tracks.flatMap(track => track.clips).find(clip => clip.id === id);
const code = expected => error => error.code === expected;

test('precise inspection covers picture and sound tracks without leaking paths or CSS', () => {
  const source = document(), value = describeNativeTimeline(source, known, scope);
  assert.deepEqual(value.supportedActions, NATIVE_ADJUST_ACTIONS); assert.equal(value.tracks.length, 2);
  assert.equal(value.clips[0].editable, true); assert.equal(value.clips[1].editable, false); assert.equal(value.clips[2].editable, false);
  assert.equal(value.clips[0].sourceStart, 2); assert.equal(value.clips[0].end, 10); assert.equal(value.clips[0].opacity, .8);
  assert.equal(JSON.stringify(value).includes('a.mp4'), false); assert.equal(JSON.stringify(value).includes('object-fit'), false);
  assert.deepEqual(source, document(), 'inspection never mutates the document');
});

test('volume, fade, picture geometry, opacity and look commit as one precise batch', () => {
  const source = document(), beforeOther = structuredClone(source.tracks[0].clips[1]), beforeMusic = structuredClone(source.tracks[1]);
  const result = plan(source, [{ action: 'volume', clipId: 'clip-a', value: 0 }, { action: 'fade', clipId: 'clip-a', in: .2, out: .3 }, { action: 'transform', clipId: 'clip-a', scale: .8, rotation: 12, opacity: .6 }, { action: 'look', clipId: 'clip-a', preset: 'warm', strength: .5 }], { editScope: scope });
  const target = clip(result.document, 'clip-a');
  assert.equal(target.volume, 0); assert.deepEqual(clipFade(target), [.2, .3]); assert.deepEqual(target.box, { x: 110, y: 80, w: 800, h: 480, r: 12 });
  assert.match(target.style, /opacity: 0.6/); assert.match(target.style, /object-fit: cover/); assert.match(target.style, /filter:/); assert.equal(target.attrs['data-user'], 'keep');
  assert.deepEqual(clip(result.document, 'clip-b'), beforeOther); assert.deepEqual(result.document.tracks[1], beforeMusic); assert.deepEqual(source, document());
});

test('split uses timeline seconds and source speed while preserving both halves and attributes', () => {
  const source = document(); source.tracks[0].clips[0].speed = 2;
  const result = plan(source, [{ action: 'split', clipId: 'clip-a', at: 4 }], { editScope: { placement: { mode: 'range', start: 2, end: 6 } }, idFactory: () => 'new-half' });
  assert.deepEqual(clip(result.document, 'clip-a').time, [2, 6]); assert.deepEqual(clip(result.document, 'new-half').time, [6, 10]);
  assert.equal(clip(result.document, 'new-half').at, 4); assert.equal(clip(result.document, 'new-half').speed, 2); assert.equal(clip(result.document, 'new-half').attrs['data-user'], 'keep');
  assert.equal(result.results[0].createdClipId, 'new-half');
});

test('trim, speed, move, duplicate and remove preserve other positions and source values', () => {
  let value = document();
  value = plan(value, [{ action: 'trim', clipId: 'clip-a', start: 3, end: 7 }, { action: 'speed', clipId: 'clip-a', value: 2 }, { action: 'move', clipId: 'clip-a', at: 5 }]).document;
  assert.deepEqual(clip(value, 'clip-a').time, [3, 7]); assert.equal(clip(value, 'clip-a').at, 5); assert.equal(clip(value, 'clip-a').speed, 2); assert.equal(clip(value, 'clip-b').at, 12);
  value = plan(value, [{ action: 'duplicate', clipId: 'clip-a', at: 8 }], { idFactory: () => 'copy' }).document;
  assert.equal(clip(value, 'copy').volume, .7); assert.equal(clip(value, 'copy').at, 8);
  value = plan(value, [{ action: 'remove', clipId: 'clip-a' }]).document;
  assert.equal(clip(value, 'clip-a'), undefined); assert.equal(clip(value, 'clip-b').at, 12); assert.equal(clip(value, 'copy').at, 8);
});

test('whole batch rejects stale clips, arbitrary ops, lock, unavailable assets and out-of-scope targets', () => {
  const source = document();
  assert.throws(() => plan(source, [{ action: 'remove', clipId: 'absent' }]), code('NATIVE_ADJUST_CLIP_STALE'));
  assert.throws(() => plan(source, [{ action: 'remove', clipId: 'clip-a', op: 'stage' }]), code('NATIVE_ADJUST_INVALID'));
  assert.throws(() => plan(source, [{ action: 'volume', clipId: 'clip-a', value: .4 }, { action: 'remove', clipId: 'clip-b' }], { editScope: scope }), code('NATIVE_ADJUST_SCOPE'));
  assert.deepEqual(source, document(), 'an invalid later operation never commits earlier operations');
  source.tracks[0].locked = true; assert.throws(() => plan(source, [{ action: 'volume', clipId: 'clip-a', value: .4 }]), code('NATIVE_ADJUST_SCOPE'));
  delete source.tracks[0].locked;
  assert.throws(() => plan(source, [{ action: 'volume', clipId: 'clip-a', value: .4 }], { editScope: { placement: { mode: 'range', start: 3, end: 7 } } }), /跨越所选区间/);
  assert.throws(() => plan(source, [{ action: 'move', clipId: 'clip-a', at: 3 }], { editScope: scope }), code('NATIVE_ADJUST_OUTSIDE_SCOPE'));
});

test('timing changes never silently overlap other clips or exceed actual source durations', () => {
  assert.throws(() => plan(document(), [{ action: 'move', clipId: 'clip-a', at: 8 }]), code('NATIVE_ADJUST_COLLISION'));
  assert.throws(() => plan(document(), [{ action: 'duplicate', clipId: 'clip-a', at: 4 }]), code('NATIVE_ADJUST_COLLISION'));
  assert.throws(() => plan(document(), [{ action: 'speed', clipId: 'clip-a', value: .5 }]), code('NATIVE_ADJUST_COLLISION'));
  assert.throws(() => plan(document(), [{ action: 'trim', clipId: 'clip-a', end: 40 }]), /实际时长/);
  assert.throws(() => plan(document(), [{ action: 'fade', clipId: 'clip-a', in: 6, out: 5 }]), /不能超过/);
  assert.throws(() => plan(document(), [{ action: 'transform', clipId: 'clip-a', x: 2000 }]), /完全移出/);
});

test('linked time edits and custom animation splitting are explicitly refused while volume remains usable', () => {
  const source = document(); source.tracks[0].clips[0].attrs['data-link'] = 'linked'; source.tracks[1].clips[0].attrs = { 'data-link': 'linked' };
  assert.throws(() => plan(source, [{ action: 'trim', clipId: 'clip-a', end: 7 }]), code('NATIVE_ADJUST_LINKED'));
  assert.equal(clip(plan(source, [{ action: 'volume', clipId: 'music', value: 0 }]).document, 'music').volume, 0);
  delete source.tracks[0].clips[0].attrs['data-link']; source.tracks[0].clips[0].class = 'custom-animation';
  assert.throws(() => plan(source, [{ action: 'split', clipId: 'clip-a', at: 5 }]), code('NATIVE_ADJUST_COMPLEX_CLIP'));
});

test('keyframes use bounded numeric clip-local values, preserve unrelated properties and copy under a fresh id', () => {
  let value = plan(document(), [{ action: 'motion', clipId: 'clip-a', property: 'scale', keys: [{ time: 0, value: 1 }, { time: 4, value: 1.2, easing: 'ease-out' }] }, { action: 'motion', clipId: 'clip-a', property: 'opacity', keys: [{ time: 0, value: 0 }, { time: 1, value: 1 }] }]).document;
  let motion = readMotion(clip(value, 'clip-a'), value.keyframes); assert.equal(motion.scale[1].v, 1.2); assert.equal(motion.opacity[0].v, 0);
  value = plan(value, [{ action: 'duplicate', clipId: 'clip-a', at: 20 }], { idFactory: () => 'copy-motion' }).document;
  assert.deepEqual(readMotion(clip(value, 'copy-motion'), value.keyframes), readMotion(clip(value, 'clip-a'), value.keyframes));
  value = plan(value, [{ action: 'transform', clipId: 'copy-motion', opacity: .4 }]).document;
  motion = readMotion(clip(value, 'copy-motion'), value.keyframes); assert.equal(motion.opacity, undefined); assert.equal(motion.scale[1].v, 1.2); assert.match(clip(value, 'copy-motion').style, /opacity: 0.4/);
  value = plan(value, [{ action: 'motion', clipId: 'clip-a', property: 'scale', keys: [] }]).document;
  assert.equal(readMotion(clip(value, 'clip-a'), value.keyframes).scale, undefined);
  assert.throws(() => plan(document(), [{ action: 'motion', clipId: 'clip-a', property: 'opacity', keys: [{ time: 1, value: 1, easing: 'url(secret)' }] }]), /缓动/);
  assert.throws(() => plan(document(), [{ action: 'motion', clipId: 'clip-a', property: 'scale', keys: [{ time: 20, value: 1 }] }]), /关键帧秒数/);
  assert.throws(() => plan(document(), [{ action: 'motion', clipId: 'clip-a', property: 'scale', keys: [{ time: 1, value: 1 }, { time: 1, value: 2 }] }]), /不可重复/);
});

test('generated caption text and styles use safe native overrides and retain fades and existing unrelated overrides', () => {
  const source = document(); source.tracks.unshift({ clips: [{ id: 'caption', src: 'pages/subtitle.html', at: 2, time: [0, 2], size: { w: 1280, h: 720 }, attrs: { 'data-guangxuan-caption': 'true', 'data-guangxuan-text': '旧字幕' }, overrides: [{ fade: [.1, .2] }, { at: '#other', text: '不动' }] }] });
  const result = plan(source, [{ action: 'caption', clipId: 'caption', text: '新字幕<script>纯文字</script>', fontSize: 32, color: '#FFD700', fontWeight: 600, align: 'left', placement: 'title' }]);
  const edited = clip(result.document, 'caption'), text = edited.overrides.find(override => override.at === '#caption');
  assert.equal(text.text, '新字幕<script>纯文字</script>'); assert.equal(text.style.fontSize, '32px'); assert.equal(text.style.color, '#FFD700'); assert.equal(text.style.textAlign, 'left'); assert.equal(edited.attrs['data-guangxuan-placement'], 'title');
  assert.deepEqual(clipFade(edited), [.1, .2]); assert.equal(edited.overrides.find(override => override.at === '#other').text, '不动');
  assert.equal(describeNativeTimeline(result.document, known).clips[0].captionText, text.text);
  assert.throws(() => plan(source, [{ action: 'caption', clipId: 'caption', color: 'url(x)' }]), /#RRGGBB/);
  assert.throws(() => plan(source, [{ action: 'caption', clipId: 'clip-a', text: '误改' }]), /仅用于Gx/);
});

test('a range may structurally split crossing ordinary media at its boundaries without granting outside edits', () => {
  const source = { stage: { w: 1280, h: 720 }, tracks: [{ clips: [{ id: 'long', src: 'a.mp4', time: [0, 30], at: 0, volume: .7, box: { x: 10, y: 20, w: 1000, h: 600 }, attrs: { title: 'Keep', 'data-user': 'keep' }, style: 'object-fit: cover; opacity: .8' }] }] };
  const range = { assetIds: ['asset-a'], placement: { mode: 'range', start: 10, end: 20, clipIds: ['long'] } };
  const first = plan(source, [{ action: 'split', clipId: 'long', at: 10 }], { editScope: range, idFactory: () => 'middle' });
  const inspection = describeNativeTimeline(source, known, range).clips[0]; assert.equal(inspection.editable, false); assert.equal(inspection.canSplitInScope, true); assert.deepEqual(inspection.splitRange, [10, 20]);
  const secondScope = structuredClone(range); secondScope.placement.clipIds.push('middle');
  const second = plan(first.document, [{ action: 'split', clipId: 'middle', at: 20 }], { editScope: secondScope, idFactory: () => 'tail' });
  const volume = plan(second.document, [{ action: 'volume', clipId: 'middle', value: 0 }], { editScope: secondScope });
  assert.deepEqual(clip(volume.document, 'long').time, [0, 10]); assert.deepEqual(clip(volume.document, 'middle').time, [10, 20]); assert.deepEqual(clip(volume.document, 'tail').time, [20, 30]);
  assert.equal(clip(volume.document, 'long').volume, .7); assert.equal(clip(volume.document, 'tail').volume, .7); assert.equal(clip(volume.document, 'middle').volume, 0);
  assert.equal(clip(volume.document, 'tail').at, 20); assert.equal(clip(volume.document, 'tail').style, source.tracks[0].clips[0].style); assert.deepEqual(clip(volume.document, 'tail').attrs, source.tracks[0].clips[0].attrs);
  assert.throws(() => plan(source, [{ action: 'volume', clipId: 'long', value: 0 }], { editScope: range }), code('NATIVE_ADJUST_SCOPE'));
  assert.throws(() => plan(source, [{ action: 'split', clipId: 'long', at: 5 }], { editScope: range }), code('NATIVE_ADJUST_SCOPE'));
  assert.deepEqual(source.tracks[0].clips[0].time, [0, 30]);
});

test('cross-range structural splitting never unlocks clips or changes unselected, animated or fading media', () => {
  const base = () => ({ stage: { w: 1280, h: 720 }, tracks: [{ clips: [{ id: 'long', src: 'a.mp4', time: [0, 30], at: 0 }] }] });
  const range = { assetIds: ['asset-a'], placement: { mode: 'range', start: 10, end: 20, clipIds: ['long'] } };
  const split = source => plan(source, [{ action: 'split', clipId: 'long', at: 10 }], { editScope: range });
  const locked = base(); locked.tracks[0].locked = true; assert.throws(() => split(locked), code('NATIVE_ADJUST_SCOPE'));
  assert.throws(() => plan(base(), [{ action: 'split', clipId: 'long', at: 10 }], { editScope: { ...range, assetIds: ['asset-b'] } }), code('NATIVE_ADJUST_SCOPE'));
  const custom = base(); custom.tracks[0].clips[0].class = 'custom-animation'; assert.throws(() => split(custom), code('NATIVE_ADJUST_COMPLEX_CLIP'));
  const fading = base(); fading.tracks[0].clips[0].overrides = [{ fade: [15, 0] }]; assert.throws(() => split(fading), code('NATIVE_ADJUST_COMPLEX_CLIP')); assert.deepEqual(describeNativeTimeline(fading, known, range).clips[0].splitRange, [15, 20]);
  const animated = plan(base(), [{ action: 'motion', clipId: 'long', property: 'scale', keys: [{ time: 0, value: 1 }, { time: 30, value: 2, easing: 'ease-out' }] }]).document;
  assert.throws(() => split(animated), code('NATIVE_ADJUST_COMPLEX_CLIP')); assert.equal(describeNativeTimeline(animated, known, range).clips[0].canSplitInScope, undefined);
});
