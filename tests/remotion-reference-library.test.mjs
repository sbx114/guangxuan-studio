import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { searchRemotionReferences, readRemotionReference, buildRemotionReferenceContext, REMOTION_REFERENCE_ORIGIN } from '../lib/remotion-reference-library.mjs';
import { buildRemotionPrompt } from '../lib/remotion-authoring.mjs';

test('local source search selects composable camera, typography and track mechanisms', async () => {
  assert.equal((await searchRemotionReferences('相机 2.5d 透视 清晰', { limit: 1 }))[0].key, 'page-camera');
  assert.equal((await searchRemotionReferences('文字基线推近组句', { limit: 1 }))[0].key, 'type-assemble');
  assert.equal((await searchRemotionReferences('多轨 manifest 拆解', { limit: 1 }))[0].key, 'manifest-tracks');
  const result = await searchRemotionReferences('相机');
  assert.ok(result.length <= 3); assert.ok(result.every(item => item.source.commit === REMOTION_REFERENCE_ORIGIN.commit && !Object.hasOwn(item, 'code')));
  assert.deepEqual(await searchRemotionReferences('a-nonexistent-xyzmechanism'), []);
});

test('all ten references return full pinned original source as text and preserve attribution', async () => {
  const all = await searchRemotionReferences('全部', { limit: 10 }); assert.equal(all.length, 10);
  const seen = new Set();
  for (const item of all) {
    const reference = await readRemotionReference(item.key);
    assert.ok(reference.code.length > 200); assert.equal(reference.source.license, 'Apache-2.0');
    for (const entry of [{ code: reference.code, source: reference.source }, ...reference.relatedSources]) {
      assert.equal(createHash('sha256').update(entry.code).digest('hex'), entry.source.sha256);
      assert.ok(entry.source.url.includes(REMOTION_REFERENCE_ORIGIN.commit)); seen.add(entry.source.path);
    }
    assert.ok(Array.isArray(reference.dependencies)); assert.ok(reference.adaptation.length > 0);
  }
  assert.equal(seen.size, 13);
  const license = await readFile(new URL('../lib/remotion-references/shotcraft/LICENSE', import.meta.url), 'utf8');
  assert.match(license, /Apache License/); assert.match(license, /END OF TERMS AND CONDITIONS/);
});

test('reference keys are a closed allowlist, never arbitrary file paths', async () => {
  for (const key of ['../errors.mjs', 'C:/Users/secret', '/etc/passwd', 'page-camera.source.txt', 'PAGE-CAMERA', 'unknown-key', '__proto__']) await assert.rejects(() => readRemotionReference(key), { code: 'REMOTION_REFERENCE_NOT_FOUND' });
  await assert.rejects(() => searchRemotionReferences('camera', { limit: 99 }), { code: 'REMOTION_REFERENCE_QUERY' });
  await assert.rejects(() => searchRemotionReferences({ path: '../secret' }), { code: 'REMOTION_REFERENCE_QUERY' });
});

test('source corpus contains actual timing, camera, media and editing APIs rather than docs', async () => {
  assert.match((await readRemotionReference('motion-signals')).code, /export const velocityAt/);
  assert.match((await readRemotionReference('page-camera')).code, /export const PageCam/);
  assert.match((await readRemotionReference('video-surface')).code, /OffthreadVideo/);
  assert.match((await readRemotionReference('manifest-tracks')).code, /export const buildProjectFromManifest/);
  const typography = await readRemotionReference('type-assemble'); assert.match(typography.code, /delayRender/); assert.match(typography.code, /baselineRef/); assert.ok(typography.relatedSources.some(item => item.source.path.endsWith('Polish.tsx')));
});

test('terse refinement discovers mechanisms from existing code, script and visual focus instead of returning no source', async () => {
  assert.deepEqual(await searchRemotionReferences('精修现有动画'), []);
  const result = await buildRemotionReferenceContext({ instruction: '精修现有动画', script: '光学实验：入射光经过镜头，比较两个空间层次，数据增长12%。',
    visualReferences: { items: [{ name: '参考', focus: '空间景深、相机推近与文字基线' }] },
    existingProject: { files: [{ path: 'src/Main.tsx', content: "export const Main=()=> <OffthreadVideo src='existing.mp4'/>;" }] } });
  for (const key of ['motion-polish', 'page-camera', 'video-surface', 'manifest-tracks']) assert.ok(result.library.selectedKeys.includes(key), key);
  assert.equal(result.library.contextUsed.existingSource, true); assert.equal(result.library.contextUsed.referenceFocus, true); assert.equal(result.library.contextUsed.script, true);
  assert.equal(result.library.catalog.length, 10); assert.ok(result.references.length > 2);
});

test('videocraft uses complete verified primary algorithms and retains file origins through the actual authoring payload', async () => {
  const context = await buildRemotionReferenceContext({ instruction: '充分利用videocraft，做文字排版、空间运镜和节奏转场，保留可编辑多轨。' });
  assert.equal(context.references.length, 10, 'Explicit library requests make every primary mechanism available, with relevance ordering');
  assert.ok(context.library.selectedKeys.includes('whip-brake')); assert.ok(context.library.selectedKeys.includes('type-assemble')); assert.ok(context.library.selectedKeys.includes('page-camera'));
  const prompt = buildRemotionPrompt({ instruction: '精修', references: context.references, referenceLibrary: context.library });
  assert.equal(prompt.payload.references.length, context.references.length);
  const delivered = prompt.payload.references.flatMap(reference => [{ source: reference.sourceMetadata, code: reference.code }, ...reference.relatedSources]);
  assert.ok(delivered.some(item => /const TABLE =/.test(item.code))); assert.ok(delivered.some(item => /baselineRef/.test(item.code))); assert.ok(delivered.some(item => /perspectiveOrigin/.test(item.code)));
  for (const item of delivered) assert.equal(createHash('sha256').update(item.code).digest('hex'), item.source.sha256, item.source.path);
  assert.ok(delivered.reduce((sum, item) => sum + item.code.length, 0) <= 80000);
  assert.ok(prompt.payload.references.every(reference => reference.partial === false));
  assert.equal(prompt.payload.referenceLibrary.origin.commit, REMOTION_REFERENCE_ORIGIN.commit);
  assert.match(prompt.system, /implementation/); assert.match(prompt.system, /不把参考文件名或示例外观当场景菜单/);
});

test('limited budgets omit complete helpers explicitly rather than truncating a velocity or camera algorithm', async () => {
  const context = await buildRemotionReferenceContext({ instruction: '甩镜速度节奏与排版基线相机' }, { limit: 4, maxCodeChars: 26000 });
  assert.ok(context.references.length >= 2); assert.ok(context.references.some(reference => reference.omittedSources.length > 0));
  assert.ok(context.references.every(reference => !reference.partial)); assert.ok(context.library.codeChars <= 26000);
  for (const reference of context.references) assert.equal(createHash('sha256').update(reference.code).digest('hex'), reference.sourceMetadata.sha256);
  assert.ok(context.references.flatMap(reference => reference.omittedSources).every(source => source.reason && source.sha256));
});
