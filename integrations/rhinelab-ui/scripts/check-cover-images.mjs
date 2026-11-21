import test from 'node:test';
import assert from 'node:assert/strict';
import { ArchiveCoverImages } from '../src/cover-images.ts';

const ids = ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444'];
class ImageFixture {
  width = 64; height = 48; naturalWidth = 0; complete = false; src = ''; onload = null; onerror = null;
  finish() { this.naturalWidth = this.width; this.complete = true; this.onload?.({}); }
  fail() { this.complete = true; this.onerror?.({}); }
  removeAttribute(name) { if (name === 'src') this.src = ''; }
}
function fixtures(capacity = 3) { const created = []; return { created, images: new ArchiveCoverImages(() => { const image = new ImageFixture(); created.push(image); return image; }, capacity) }; }

test('out-of-order images only repaint the selected project, and the previous project is reusable from cache', () => {
  const { images, created } = fixtures(); const paints = [];
  images.select(ids[0], () => paints.push('A')); images.select(ids[1], () => paints.push('B'));
  created[0].finish(); assert.deepEqual(paints, []); assert.equal(images.imageFor(ids[1]), undefined);
  created[1].finish(); assert.deepEqual(paints, ['B']); assert.equal(images.imageFor(ids[1]), created[1]);
  images.select(ids[0], () => paints.push('A again')); assert.equal(images.imageFor(ids[0]), created[0]); assert.equal(created.length, 2);
  images.dispose();
});

test('rapid A to B to A navigation never applies B to A and preset selection ignores delayed completions', () => {
  const { images, created } = fixtures(); let repaints = 0;
  images.select(ids[0], () => { repaints++; }); images.select(ids[1], () => { repaints++; }); images.select(ids[0], () => { repaints++; });
  created[1].finish(); assert.equal(repaints, 0); created[0].finish(); assert.equal(repaints, 1);
  images.select(ids[2], () => { repaints++; }); images.select('', () => { repaints++; }); created[2].finish(); assert.equal(repaints, 1);
  images.select(ids[2], () => { repaints++; }); assert.equal(images.imageFor(ids[2]), created[2]); assert.equal(created.length, 3);
  images.dispose();
});

test('failed custom covers can be reselected after a preset, and bounded cache disposal cancels stale handlers', () => {
  const { images, created } = fixtures(2); let repaints = 0;
  images.select(ids[0], () => { repaints++; }); created[0].fail(); assert.equal(images.imageFor(ids[0]), undefined);
  images.select('', () => { repaints++; }); images.select(ids[0], () => { repaints++; }); assert.equal(created.length, 2);
  created[1].finish(); assert.equal(images.imageFor(ids[0]), created[1]);
  images.select(ids[1], () => { repaints++; }); const delayed = created[2].onload;
  images.select(ids[2], () => { repaints++; }); images.select(ids[3], () => { repaints++; });
  assert.equal(created[2].src, ''); const before = repaints; delayed({}); assert.equal(repaints, before);
  images.dispose(); assert.ok(created.every(image => image.onload === null && image.onerror === null && image.src === ''));
  assert.equal(images.imageFor(ids[3]), undefined); images.select(ids[0], () => {}); assert.equal(created.length, 5);
});
