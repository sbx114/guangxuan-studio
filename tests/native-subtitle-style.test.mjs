import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { readVtt } from '../integrations/openfilm/packages/openfilm/src/captions.mjs';
import { applySubtitleStyle, SUBTITLE_STYLE_CATALOG, subtitleStyleSummary } from '../lib/native-subtitle-style.mjs';
import { cueRule } from '../lib/native-caption-edits.mjs';
import { CAPTION_LIBRARY } from '../lib/native-caption-library.mjs';

const code = wanted => error => error.code === wanted;
const fixture = () => readVtt('WEBVTT\n\nNOTE custom note\n\nREGION\nid:keep\nwidth:80%\n\nSTYLE\n::cue { font: italic 700 5cqmin serif; color: red; --unknown: keep; }\n::cue(#second) { --shadow: 0 1px 2px black; border: 2px solid teal; }\n::cue(:past) { font-style: italic; }\n@keyframes custom { from { opacity:.5 } to { opacity:1 } }\n\nfirst\n00:00:00.000 --> 00:00:01.000 align:start\n<00:00:00.000>Original first\n\nsecond\n00:00:02.000 --> 00:00:03.000 align:end\n<00:00:02.000>Original second\n');

test('all four runtime subtitle modules are exact type-only UI conversions with source attribution', async () => {
  for (const name of ['caption-edits', 'caption-look', 'text-look', 'word-effects']) {
    const raw = await readFile(new URL('../integrations/openfilm/packages/openfilm/studio/ui/src/lib/' + name + '.ts', import.meta.url), 'utf8');
    const deployed = await readFile(new URL('../lib/native-' + name + '.mjs', import.meta.url), 'utf8');
    assert.ok(deployed.includes(createHash('sha256').update(raw).digest('hex'))); assert.ok(deployed.includes('MIT License'));
    let expected = stripTypeScriptTypes(raw, { mode: 'strip' }).replaceAll("'../../../../src/captions.mjs'", "'../integrations/openfilm/packages/openfilm/src/captions.mjs'");
    for (const local of ['caption-edits', 'text-look', 'caption-look', 'word-effects']) expected = expected.replaceAll("'./" + local + ".ts'", "'./native-" + local + ".mjs'");
    assert.equal(deployed.slice(deployed.indexOf(' */\n') + 4), expected);
  }
});

test('style catalog exactly covers UI variables, every library text look/motion and all word effects', async () => {
  const upstream = JSON.parse(await readFile(new URL('../integrations/openfilm/packages/openfilm/library/index.json', import.meta.url), 'utf8'));
  assert.deepEqual(CAPTION_LIBRARY.map(item => item.id), upstream.items.filter(item => ['textstyle', 'textmotion'].includes(item.kind)).map(item => item.id));
  assert.equal(Object.keys(SUBTITLE_STYLE_CATALOG.variables).length, 22); assert.equal(SUBTITLE_STYLE_CATALOG.wordEffects.length, 12);
  for (const item of CAPTION_LIBRARY) {
    const patch = item.kind === 'textstyle' ? { lookId: item.id } : { motion: { [item.group]: { id: item.id, duration: .6 } } };
    assert.doesNotThrow(() => applySubtitleStyle(fixture(), patch), item.id);
  }
  for (const { id } of SUBTITLE_STYLE_CATALOG.wordEffects) assert.doesNotThrow(() => applySubtitleStyle(fixture(), { wordEffect: id }));
});

test('selected styles retain all outside cues, real word times and unrelated CSS while overriding legacy plain CSS', () => {
  const before = fixture(), next = applySubtitleStyle(before, { variables: { '--font': 'Arial', '--size': '7cqmin', '--color': '#FFD700', '--stroke': '.1em', '--stroke-color': '#000000', '--box': '#203040' }, css: { 'text-decoration': 'underline', 'line-height': '1.4' }, align: 'center', line: 85, position: 50, width: 75 }, { cueIndices: [1], editScope: { placement: { mode: 'range', start: 2, end: 4 } } });
  assert.deepEqual(next.cues[0], before.cues[0]); assert.equal(next.cues[1].text, before.cues[1].text); assert.deepEqual(next.notes, before.notes); assert.deepEqual(next.regions, before.regions);
  const own = cueRule(next, '::cue(#second)'); assert.equal(own['--color'], '#FFD700'); assert.equal(own.color, 'var(--color)'); assert.equal(own['font-size'], 'var(--size)'); assert.equal(own.border, '2px solid teal');
  assert.equal(cueRule(next, '::cue')['--unknown'], 'keep'); assert.ok(next.styles.join('\n').includes('@keyframes custom')); assert.match(next.cues[1].settings, /align:center/);
});

test('global field updates clear only corresponding cue overrides and preserve the other look fields', () => {
  const next = applySubtitleStyle(fixture(), { variables: { '--color': '#00FF00' } });
  assert.equal(cueRule(next, '::cue')['--color'], '#00FF00'); assert.equal(cueRule(next, '::cue').font, 'italic 700 5cqmin serif');
  assert.equal(cueRule(next, '::cue(#second)')['--shadow'], '0 1px 2px black'); assert.equal(cueRule(next, '::cue(#second)').border, '2px solid teal');
  const original = fixture(); original.styles.push('::cue(#second) { font: italic 800 9cqmin monospace; }');
  const resized = applySubtitleStyle(original, { variables: { '--size': '6cqmin' } });
  const own = cueRule(resized, '::cue(#second)'); assert.equal(own.font, undefined); assert.equal(own['--font'], 'monospace'); assert.equal(own['--weight'], '800'); assert.equal(own['--italic'], 'italic');
});

test('word effects preserve custom CSS and word timing unless timeWords is explicitly requested', () => {
  const before = fixture(), next = applySubtitleStyle(before, { wordEffect: 'pop', wordColor: '#22AAFF' });
  assert.deepEqual(next.cues.map(cue => cue.text), before.cues.map(cue => cue.text)); assert.match(cueRule(next, '::cue(:past)').animation, /wfx-pop/); assert.equal(cueRule(next, '::cue(:past)')['font-style'], 'italic');
  assert.equal(subtitleStyleSummary(next).wordEffect.id, 'pop');
  const timed = applySubtitleStyle(readVtt('WEBVTT\n\n00:00:02.000 --> 00:00:04.000\n两个词 继续\n'), { timeWords: true }); assert.match(timed.cues[0].text, /<00:00:02/);
});

test('style patches reject injection, invalid enums and scope enlargement, and preserve raw cue order', () => {
  for (const patch of [{ variables: { '--font': 'url(https://evil)' } }, { css: { color: 'red; background:url(file:///secret)' } }, { variables: { '--in': 'invented-animation' } }, { motion: { in: { id: 'text/motions/out-fade' } } }, { css: null }]) assert.throws(() => applySubtitleStyle(fixture(), patch), code('NATIVE_SUBTITLE_STYLE_INVALID'));
  assert.throws(() => applySubtitleStyle(fixture(), { wordEffect: 'pop' }, { cueIndices: [1] }), code('NATIVE_SUBTITLE_STYLE_SCOPE'));
  assert.throws(() => applySubtitleStyle(fixture(), { variables: { '--color': 'red' } }, { editScope: { placement: { mode: 'range', start: 2, end: 4 } } }), code('NATIVE_SUBTITLE_STYLE_SCOPE'));
  const original = fixture(); original.cues.reverse(); const next = applySubtitleStyle(original, { variables: { '--color': '#ABCDEF' } }, { cueIndices: [0] }); assert.equal(next.cues[0].id, 'second'); assert.deepEqual(next.cues[1], original.cues[1]);
});
