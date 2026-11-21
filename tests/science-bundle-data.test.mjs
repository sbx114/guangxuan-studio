import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { scienceBundlePath, validateScienceBundleContents } from '../lib/science-bundle-data.mjs';
const digest = value => createHash('sha256').update(value).digest('hex');
function fixture() {
  const projectId = 'science-one', docId = '11111111-1111-4111-8111-111111111111', assetId = '22222222-2222-4222-8222-222222222222';
  const prefix = 'science-documents/' + projectId + '/' + docId, imagePrefix = 'novel-assets/' + projectId + '/' + assetId;
  const units = [{ id: 's0001-001-123456789abc', index: 0, text: '合外力等于质量与加速度的乘积。', characterCount: '合外力等于质量与加速度的乘积。'.length, readable: true, hash: digest('合外力等于质量与加速度的乘积。') }];
  const source = Buffer.from('# 物理\n合外力等于质量与加速度的乘积。'), unitBytes = Buffer.from(JSON.stringify(units)), picture = Buffer.from('registered-image-bytes');
  const project = { id: projectId, kind: 'science', createdAt: '2026-11-18T00:00:00Z' };
  const document = { version: 1, projectId, ownerCreatedAt: project.createdAt, documentId: docId, format: 'md', sourceFile: 'source.md', unitsFile: 'units.json', sourceHash: digest(source), unitsHash: digest(unitBytes), contentHash: digest(JSON.stringify(units.map(unit => [unit.id, unit.hash]))), totalUnitCount: units.length, pageCount: null, bytes: source.length, characterCount: units[0].text.length, readableUnitCount: 1, warnings: [] };
  const metadata = { id: assetId, projectId, ownerCreatedAt: project.createdAt, kind: 'portrait', mimeType: 'image/png', bytes: picture.length, sha256: digest(picture), width: 96, height: 160 };
  const records = new Map([['project.json', project], [prefix + '/document.json', document], [prefix + '/units.json', units], [imagePrefix + '/metadata.json', metadata]]);
  const files = [...records].map(([path, value]) => { const bytes = path.endsWith('/units.json') ? unitBytes : Buffer.from(JSON.stringify(value)); return { path, size: bytes.length, sha256: digest(bytes) }; });
  files.push({ path: prefix + '/source.md', size: source.length, sha256: digest(source) }, { path: imagePrefix + '/image.png', size: picture.length, sha256: digest(picture) });
  const manifest = { files, projects: [{ sourceId: projectId, file: 'project.json' }] };
  return { manifest, records, prefix, imagePrefix, document, metadata, units, assetId };
}
test('science backup paths are limited to owned document and raster asset layouts', () => {
  assert.equal(scienceBundlePath('science-documents/p/11111111-1111-4111-8111-111111111111/source.pdf').kind, 'science-documents');
  for (const value of ['science-documents/p/../source.pdf', 'novel-assets/p/22222222-2222-4222-8222-222222222222/image.svg', 'novel-assets/p/22222222-2222-4222-8222-222222222222/.env', 'science-documents/p/source.pdf']) assert.equal(scienceBundlePath(value), null);
});
test('a complete science archive keeps exact text hashes and independent portrait identities', () => {
  const f = fixture(), result = validateScienceBundleContents(f.manifest, f.records);
  assert.equal(result.resourceCount, 2); assert.ok(result.novelAssetIds.has(f.assetId));
});
test('foreign ownership, a changed source, and changed unit text are rejected before restore', () => {
  let f = fixture(); f.document.ownerCreatedAt = 'different-owner';
  assert.throws(() => validateScienceBundleContents(f.manifest, f.records), { code: 'BUNDLE_WRONG_OWNER' });
  f = fixture(); f.document.sourceHash = '0'.repeat(64);
  assert.throws(() => validateScienceBundleContents(f.manifest, f.records), { code: 'BUNDLE_SCIENCE_HASH_MISMATCH' });
  f = fixture(); f.units[0].text = '被改写的摘录';
  assert.throws(() => validateScienceBundleContents(f.manifest, f.records), { code: 'BUNDLE_SCIENCE_HASH_MISMATCH' });
});
test('incomplete portraits and extra competing original documents are rejected', () => {
  let f = fixture(); f.manifest.files = f.manifest.files.filter(file => !file.path.endsWith('/image.png'));
  assert.throws(() => validateScienceBundleContents(f.manifest, f.records), { code: 'BUNDLE_SCIENCE_HASH_MISMATCH' });
  f = fixture(); f.manifest.files.push({ path: f.prefix + '/source.pdf', size: 3, sha256: digest('bad') });
  assert.throws(() => validateScienceBundleContents(f.manifest, f.records), { code: 'BUNDLE_SCIENCE_INVALID' });
});
test('even recomputed archive hashes cannot hide invalid unit indices, readability or IDs', () => {
  for (const mutate of [unit => { unit.index = 9; }, unit => { unit.readable = false; }, unit => { unit.id = 'foreign/unit'; }, unit => { unit.characterCount = 0; }]) {
    const f = fixture(); mutate(f.units[0]);
    const bytes = Buffer.from(JSON.stringify(f.units)), file = f.manifest.files.find(file => file.path === f.prefix + '/units.json');
    file.sha256 = digest(bytes); file.size = bytes.length; f.document.unitsHash = file.sha256;
    f.document.contentHash = digest(JSON.stringify(f.units.map(unit => [unit.id, unit.hash])));
    assert.throws(() => validateScienceBundleContents(f.manifest, f.records), { code: 'BUNDLE_SCIENCE_HASH_MISMATCH' });
  }
});
test('portraits from an earlier owner cannot be restored into a recreated project', () => {
  const f = fixture(); f.metadata.ownerCreatedAt = 'earlier-owner';
  assert.throws(() => validateScienceBundleContents(f.manifest, f.records), { code: 'BUNDLE_SCIENCE_HASH_MISMATCH' });
});
