import test from 'node:test';
import assert from 'node:assert/strict';
import { NATIVE_EXPORT_CATALOG, NATIVE_EXPORT_SCHEMA, normalizeNativeExport } from '../lib/native-export-capabilities.mjs';

const valid = spec => normalizeNativeExport(spec);
const invalid = spec => assert.throws(() => valid(spec), error => error.code === 'INVALID_OPENFILM_EXPORT' && error.status === 400);

test('native export catalog exposes all nine editor kinds with their actual parameter schemas', () => {
  assert.deepEqual(NATIVE_EXPORT_CATALOG.map(item => item.kind), ['video', 'gif', 'audio', 'stills', 'poster', 'subtitles', 'slides', 'nle', 'project']);
  assert.equal(NATIVE_EXPORT_SCHEMA.oneOf.length, 9);
  assert.equal(NATIVE_EXPORT_CATALOG[0].parameters.additionalProperties, false);
  assert.deepEqual(NATIVE_EXPORT_CATALOG.find(item => item.kind === 'video').parameters.properties.codec.enum, ['h264', 'hevc', 'vp9', 'prores422hq', 'prores4444', 'hevc_alpha', 'png']);
  assert.ok(Object.isFrozen(NATIVE_EXPORT_SCHEMA.oneOf[0].properties));
});

test('legacy empty export remains video while advanced video preserves native codec, delivery, audio and blur controls', () => {
  assert.deepEqual(valid({}), { kind: 'video', hardware: false });
  const ask = { kind: 'video', name: '原生完整参数', label: '审核小样', codec: 'prores4444', frame: '2.39:1', fill: 'cover', shortEdge: 2160, fps: 23.976, scale: 2, quality: 'master', audio: true, hardware: true, clip: 'clip-one', preset: 'cinema', sidecar: 'vtt', loudness: -16, burnSubtitles: true, samples: 16, shutter: .5, range: [1, 4] };
  assert.deepEqual(valid(ask), ask);
});

for (const codec of ['h264', 'hevc', 'vp9', 'prores422hq', 'prores4444', 'hevc_alpha', 'png']) test(`native video accepts actual ${codec} output choice`, () => {
  assert.equal(valid({ kind: 'video', codec }).codec, codec);
});

test('all non-video formats preserve their native per-kind fields', () => {
  const asks = [
    { kind: 'gif', frame: '9:16', fill: 'contain', burnSubtitles: true, width: 640, fps: 15, ranges: [[8, 9], [1, 2]] },
    { kind: 'audio', format: 'mp3', mix: false, stems: true, range: [0, 7] },
    { kind: 'stills', format: 'jpg', as: 'files', shortEdge: 1080, at: [1, 3.5] },
    { kind: 'poster', format: 'png', shortEdge: 4096, at: 2.5, burnSubtitles: true },
    { kind: 'subtitles', format: 'txt', ranges: [[5, 6], [0, 1]] },
    { kind: 'slides', format: 'pdf', frame: '4:3', shortEdge: 1080, at: [0, 1] },
    { kind: 'nle', format: 'capcut', fps: 29.97, media: 'link', audio: 'stems', subtitles: true, footage: 'source', alpha: 'auto' },
    { kind: 'project', as: 'folder', parts: ['history', 'chat', 'logs'] },
  ];
  for (const ask of asks) assert.deepEqual(valid(ask), ask);
  assert.equal(valid({ kind: 'audio', format: 'wav' }).format, 'wav');
  assert.equal(valid({ kind: 'audio', format: 'm4a' }).format, 'm4a');
  assert.equal(valid({ kind: 'slides', format: 'pptx' }).format, 'pptx');
  assert.equal(valid({ kind: 'subtitles', format: 'srt' }).format, 'srt');
  assert.equal(valid({ kind: 'subtitles', format: 'vtt' }).format, 'vtt');
});

test('joined source selections keep their order and are cloned before the engine receives them', () => {
  const spec = { kind: 'video', ranges: [[8, 10], [0, 2]] }, result = valid(spec);
  assert.deepEqual(result.ranges, spec.ranges); result.ranges[0][0] = 9;
  assert.equal(spec.ranges[0][0], 8);
  invalid({ ...spec, range: [0, 1] }); invalid({ ...spec, clip: 'clip-one' });
  invalid({ kind: 'audio', ranges: [] }); invalid({ kind: 'audio', ranges: [[1, 1]] });
});

test('export paths, script options, batch envelopes and unrelated kind fields never reach the worker', () => {
  for (const spec of [null, [], { kind: 'shell' }, { folder: 'C:/outside' }, { path: '../outside' }, { jobs: [{ kind: 'video' }] }, { kind: 'poster', codec: 'h264' }, { kind: 'audio', hardware: false }, JSON.parse('{"kind":"video","__proto__":{"folder":"outside"}}')]) invalid(spec);
});

test('numeric, boolean, range and codec validation rejects malformed requests before native enqueue', () => {
  for (const spec of [{ fps: '30' }, { fps: NaN }, { samples: 1.5 }, { samples: 65 }, { shutter: 2 }, { frame: '0:0' }, { frame: '10:1' }, { frame: 'url(file:///secret)' }, { quality: 'unlimited' }, { codec: 'execute' }, { hardware: 1 }, { audio: 'yes' }, { range: [2, 1] }, { range: [-1, 2] }, { kind: 'gif', width: 1921 }, { kind: 'gif', fps: 51 }, { kind: 'stills', range: [0, 1] }, { kind: 'slides', range: [0, 1] }, { kind: 'nle', range: [0, 1] }, { kind: 'project', range: [0, 1] }, { kind: 'poster', at: [1] }, { kind: 'audio', mix: false, stems: false }, { kind: 'project', parts: ['history', 'history'] }, { name: 'bad\nname' }]) invalid(spec);
});

test('NLE alpha choices follow each actual target editor and preserve existing source/render options', () => {
  for (const [format, alpha] of [['xml', 'png'], ['xml', 'prores4444'], ['fcpxml', 'prores4444'], ['jianying', 'prores'], ['capcut', 'auto']]) assert.equal(valid({ kind: 'nle', format, alpha, footage: 'render' }).alpha, alpha);
  for (const [format, alpha] of [['xml', 'auto'], ['fcpxml', 'png'], ['jianying', 'prores4444']]) invalid({ kind: 'nle', format, alpha });
});
