import test from 'node:test';
import assert from 'node:assert/strict';
import { createRemotionIntegration } from '../lib/remotion-integration.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(overrides = {}) {
  const project = { id: 'owner-a', kind: 'video', createdAt: 'owner-version', video: {} };
  const record = { id: 'source', ownerCreatedAt: project.createdAt, revision: 1, title: '自由作品', compositionId: 'Main', inputProps: {}, files: [{ path: 'index.tsx', content: 'source' }] };
  const calls = [];
  const projects = {
    read: async () => structuredClone(record),
    inspect: async () => ({ compositions: [{ id: 'Main', fps: 24, durationInFrames: 3000, width: 640, height: 360 }] }),
    render: async (_projectId, _id, options) => { calls.push(['render', options]); return { jobId: 'job' }; },
    getJob: async () => ({ id: 'job', status: 'complete', remotionId: 'source', revision: 1, ownerCreatedAt: project.createdAt, kind: 'video', result: { outputPath: 'C:/fixture-only/video.mp4', duration: 4 } }),
    ...overrides.projects,
  };
  const integration = createRemotionIntegration({ projects, store: { read: async () => structuredClone(project) },
    openFilm: { context: async () => ({ revision: 'native1', assets: [] }), appendAsset: async (...args) => { calls.push(['append', args]); return { revision: 'native2', undo: { id: 'undo' } }; } },
    videoService: { importLocalFile: overrides.importLocalFile || (async () => ({ id: 'asset' })) },
    ...(overrides.ai ? { ai: overrides.ai } : {}), ...(overrides.references ? { references: overrides.references } : {}),
  });
  return { integration, project, record, projects, calls };
}
test('default UI append scope equals an unset saved scope and keeps native CAS', async () => {
  const f = fixture(), result = await f.integration.append('owner-a', 'source', { jobId: 'job', expectedNativeRevision: 'native1', editScope: { placement: { mode: 'append' } } });
  assert.equal(result.appended, true); const call = f.calls.find(item => item[0] === 'append')[1];
  assert.equal(call[4].expectedRevision, 'native1'); assert.deepEqual(call[4].editScope, { placement: { mode: 'append' } });
});
test('a changed user scope refuses append before touching the timeline', async () => {
  const f = fixture(); f.project.video.editScope = { placement: { mode: 'insert', at: 5 } };
  await assert.rejects(() => f.integration.append('owner-a', 'source', { jobId: 'job', editScope: { placement: { mode: 'append' } } }), { code: 'REMOTION_SCOPE_CHANGED' });
  assert.equal(f.calls.length, 0);
});
test('source changes while media is importing cannot append the stale render', async () => {
  const entered = deferred(), release = deferred(), f = fixture({ importLocalFile: async () => { entered.resolve(); await release.promise; return { id: 'asset' }; } });
  const pending = f.integration.append('owner-a', 'source', { jobId: 'job', editScope: { placement: { mode: 'append' } } });
  await entered.promise; f.record.revision = 2; release.resolve();
  await assert.rejects(pending, { code: 'REMOTION_STALE_RENDER' }); assert.equal(f.calls.length, 0);
});
test('scope changes during asset import are rechecked before native commit', async () => {
  const entered = deferred(), release = deferred(), f = fixture({ importLocalFile: async () => { entered.resolve(); await release.promise; return { id: 'asset' }; } });
  const pending = f.integration.append('owner-a', 'source', { jobId: 'job', editScope: { placement: { mode: 'append' } } });
  await entered.promise; f.project.video.editScope = { placement: { mode: 'range', start: 1, end: 3 } }; release.resolve();
  await assert.rejects(pending, { code: 'REMOTION_SCOPE_CHANGED' }); assert.equal(f.calls.length, 0);
});
test('UI sample seconds convert through actual composition fps into renderer frames', async () => {
  const f = fixture(); await f.integration.start('owner-a', 'source', { expectedRevision: 1, kind: 'video', range: [1, 3.5] });
  assert.deepEqual(f.calls[0][1].range, [24, 84]);
  await assert.rejects(() => f.integration.start('owner-a', 'source', { expectedRevision: 1, kind: 'video', range: [0, 999] }), { code: 'REMOTION_RANGE_INVALID' });
});
test('HTTP job representation strips internal output paths and supplies usable media URLs', () => {
  const f = fixture(), job = { id: 'job', kind: 'video', error: { code: 'COMPILE', message: '错误 C:/Users/owner/remotion-projects/a/revisions/1/src/Scene.tsx:2' }, result: { outputPath: 'C:/private/video.mp4', frames: [{ file: 'frame-00.png', frame: 2 }] } };
  const result = f.integration.publicJob('owner-a', job);
  assert.equal(result.result.outputPath, undefined); assert.match(result.result.videoUrl, /\/files\/video\.mp4$/); assert.match(result.result.frames[0].url, /frame-00\.png$/);
  assert.ok(!JSON.stringify(result).includes('C:/private')); assert.equal(job.result.outputPath, 'C:/private/video.mp4');
  assert.ok(!JSON.stringify(result).includes('C:/Users')); assert.match(result.error.message, /src\/Scene\.tsx:2/);
});
test('recreated parent projects cannot read source projects from the old parent instance', async () => {
  const f = fixture(); f.project.createdAt = 'new-owner-version';
  await assert.rejects(() => f.integration.read('owner-a', 'source'), { code: 'REMOTION_OWNER_CHANGED' });
});

test('production refinement sends context-selected complete Shotcraft code and the catalogue to the model', async () => {
  const sent = [], f = fixture({ ai: async (task, payload) => { sent.push({ task, payload }); return { data: { title: '精修', entryPoint: 'index.tsx', compositionId: 'Main', inputProps: {}, assetIds: [], files: [{ path: 'index.tsx', content: 'updated source' }] } }; },
    projects: { update: async (_owner, id, input) => ({ id, ...input, revision: 2 }) },
    references: { list: async () => ({ revision: 1, includeImages: false }), context: async () => ({ references: { includeImages: false, items: [{ id: 'reference', type: 'text', name: '设计参考', focus: '空间景深和排版基线', aspects: ['composition', 'titles'], text: '取景与信息有明确关系。', frames: [] }] } }) } });
  f.project.video.script = '演示镜头光路与数据增长12%，重要文字清晰落定。'; f.record.files[0].content = 'export const Main=()=> <OffthreadVideo/>;';
  const result = await f.integration.generate('owner-a', { instruction: '精修现有动画', remotionId: 'source', expectedRevision: 1 });
  assert.equal(result.project.revision, 2); assert.equal(sent.length, 1); assert.equal(sent[0].task, 'remotion-project');
  const { references, referenceLibrary } = sent[0].payload;
  assert.ok(references.length > 2); assert.equal(referenceLibrary.catalog.length, 10); assert.equal(referenceLibrary.contextUsed.script, true); assert.equal(referenceLibrary.contextUsed.referenceFocus, true);
  assert.ok(references.some(reference => reference.key === 'page-camera')); assert.ok(references.some(reference => reference.key === 'video-surface'));
  assert.ok(references.every(reference => !reference.partial && reference.sourceMetadata.sha256));
  assert.equal(sent[0].payload.existingProject.files[0].content, f.record.files[0].content);
});

test('actual supplied reference frames are retained when their timestamps fall outside a UI sampling suggestion', async () => {
  const images = [], dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
  const f = fixture({ ai: async (_task, payload, _settings, request) => { images.push(...request.images); assert.equal(payload.visualReferences.items[0].frames[0].timestamp, 20); return { data: { title: '精修', entryPoint: 'index.tsx', compositionId: 'Main', assetIds: [], files: [{ path: 'index.tsx', content: 'updated' }] } }; },
    projects: { update: async (_owner, id, input) => ({ id, ...input, revision: 2 }) },
    references: { list: async () => ({ revision: 1, includeImages: true }), context: async () => ({ references: { includeImages: true, items: [{ id: 'reference-video', type: 'video', name: '当前项目参考', duration: 30, sourceRange: { start: 6, end: 8 }, targetRange: { start: 80, end: 90 }, frames: [{ label: '已提供的20秒抽样', timestamp: 20 }] }] }, images: [{ referenceId: 'reference-video', label: '已提供的20秒抽样', timestamp: 20, dataUrl }, { referenceId: 'unknown-reference', label: '未登记图像', timestamp: 20, dataUrl }] }) } });
  await f.integration.generate('owner-a', { instruction: '读取参考并精修全片', remotionId: 'source', expectedRevision: 1 });
  assert.deepEqual(images, [{ dataUrl, label: '已提供的20秒抽样' }], 'Only actual matching reference metadata is sent; the UI range does not remove it');
});
