import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildPrompt, normalizeModelData } from '../lib/prompts.mjs';
import { assistantContext } from '../public/editor-assistant.js';
import { startServer } from '../server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const context = { assets: [{ id: 'media-a', name: 'clip.mp4', type: 'video', duration: 10 }], timeline: [{ id: 'clip-a', assetId: 'media-a', start: 0, end: 8, at: 0, speed: 1 }], duration: 8, mainTrackEditable: true, aspect: '16:9' };
const input = { instruction: '把现有片段剪到6秒并加标题字幕“走近光电”', context, title: '项目', script: '', history: [] };

test('editor chat supports questions with no assets and strips executable fields', () => {
  const { payload } = buildPrompt('edit-assistant', { ...input, instruction: '可以帮我做什么？', context: { ...context, assets: [], timeline: [], duration: 0 } });
  assert.deepEqual(normalizeModelData('edit-assistant', { action: 'reply', message: '可添加标题或根据文字生成动画。', plan: { code: 'do-not-run' }, command: 'ignored' }, payload), { action: 'reply', message: '可添加标题或根据文字生成动画。' });
  assert.throws(() => normalizeModelData('edit-assistant', { action: 'execute', message: 'x' }, payload), error => error.code === 'MODEL_FORMAT_ERROR');
});

test('editor plans preserve existing clip identity and reject impossible clips, ranges and captions', () => {
  const { payload } = buildPrompt('edit-assistant', input);
  const data = { action: 'edit', message: '准备保留前6秒并添加标题。', plan: { timeline: [{ assetId: 'media-a', clipId: 'clip-a', start: 0, end: 6 }], captions: [{ start: 0, end: 2, text: '走近光电', placement: 'title' }], arbitraryCode: 'ignored' } };
  const result = normalizeModelData('edit-assistant', data, payload);
  assert.equal(result.plan.timeline[0].clipId, 'clip-a');
  assert.equal(result.plan.captionMode, 'append');
  assert.equal(result.plan.captions[0].placement, 'title');
  assert.equal('arbitraryCode' in result.plan, false);
  assert.throws(() => normalizeModelData('edit-assistant', { ...data, plan: { timeline: [{ ...data.plan.timeline[0], clipId: 'missing' }] } }, payload), error => error.code === 'MODEL_CLIP_INVALID');
  assert.throws(() => normalizeModelData('edit-assistant', { ...data, plan: { timeline: [{ ...data.plan.timeline[0], end: 99 }] } }, payload), error => error.code === 'MODEL_TIMELINE_INVALID');
  assert.throws(() => normalizeModelData('edit-assistant', { ...data, plan: { ...data.plan, captions: [{ start: 0, end: 7, text: 'too long' }] } }, payload), error => error.code === 'MODEL_CAPTIONS_INVALID');
  const speedPayload = buildPrompt('edit-assistant', { ...input, context: { ...context, timeline: [{ ...context.timeline[0], speed: 2 }] } }).payload;
  assert.throws(() => normalizeModelData('edit-assistant', { ...data, plan: { ...data.plan, captions: [{ start: 0, end: 4, text: 'exceeds the 3s result' }] } }, speedPayload), error => error.code === 'MODEL_CAPTIONS_INVALID');
});

test('caption-only edits work without rebuilding an unsupported native main track', () => {
  const { payload } = buildPrompt('edit-assistant', { ...input, context: { ...context, mainTrackEditable: false } });
  const result = normalizeModelData('edit-assistant', { action: 'edit', message: '添加标题。', plan: { captions: [{ start: 0, end: 1, text: '标题', placement: 'title' }] } }, payload);
  assert.equal('timeline' in result.plan, false);
  assert.equal(result.plan.captions.length, 1);
  assert.throws(() => normalizeModelData('edit-assistant', { action: 'edit', message: '重排。', plan: { timeline: [{ assetId: 'media-a', start: 0, end: 6 }] } }, payload), error => error.code === 'MODEL_MAIN_TRACK_UNSUPPORTED');
});

test('context sent to the model excludes filesystem paths, media URLs and native capability IDs', () => {
  const filtered = assistantContext({ ...context, nativeProjectId: 'private-id', revision: 'not-for-model', assets: [{ ...context.assets[0], path: 'C:/private/media.mp4', url: '/private-url', apiKey: 'secret' }] });
  assert.equal(JSON.stringify(filtered).includes('private'), false);
  assert.equal(JSON.stringify(filtered).includes('secret'), false);
  assert.equal(filtered.timeline[0].id, 'clip-a');
});

test('native assistant trims to six seconds, adds a real title, preserves clip properties and safely undoes', { timeout: 120000, skip: process.env.GUANGXUAN_TEST_OPENFILM !== '1' }, async t => {
  const work = path.resolve(root, 'work');
  await mkdir(work, { recursive: true });
  const directory = await mkdtemp(path.join(work, 'editor-assistant-test-'));
  let app;
  t.after(async () => {
    await app?.close();
    if (path.dirname(path.resolve(directory)) !== work || !path.basename(directory).startsWith('editor-assistant-test-')) throw new Error('Unsafe test cleanup');
    await rm(directory, { recursive: true, force: true });
  });
  const run = promisify(execFile);
  const ffmpeg = process.env.GUANGXUAN_BIN_DIR ? path.join(process.env.GUANGXUAN_BIN_DIR, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg') : 'ffmpeg';
  const fixture = path.join(directory, 'fixture.mp4');
  await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=navy:s=320x180:r=15:d=10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', fixture], { windowsHide: true });
  const dataDir = path.join(directory, 'data');
  app = await startServer({ port: 0, dataDir });
  assert.notEqual(new URL(app.url).port, '4417');
  async function request(route, body, method = body === undefined ? 'GET' : 'POST', expected = 200) {
    const response = await fetch(`${app.url}${route}`, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json(); assert.equal(response.status, expected, JSON.stringify(data)); return data;
  }
  const imported = await request('/api/video/import-local', { paths: [fixture] });
  const asset = imported.assets[0], id = 'assistant-native-test';
  await request(`/api/projects/${id}`, { id, kind: 'video', title: '隔离助手测试', video: { timeline: [{ assetId: asset.id, start: 0, end: 8 }], captions: [] } }, 'PUT');
  const opened = await request('/api/openfilm/open', { projectId: id });
  const wrapper = await (await fetch(`${app.url}${opened.editorUrl}`)).text();
  const nativeUrl = new URL(/id="openfilm-studio"[^>]+src="([^"]+)"/.exec(wrapper)[1].replaceAll('&amp;', '&'));
  const { readFilmFile } = await import(pathToFileURL(path.join(root, 'integrations/openfilm/packages/openfilm/src/film-doc.mjs')).href);
  const filmPath = path.join(dataDir, 'openfilm/projects', id, 'film.html');
  const read = async () => readFilmFile(await readFile(filmPath, 'utf8')).doc;
  const main = doc => doc.tracks.flatMap(track => track.clips).find(clip => clip.src.endsWith('.mp4'));
  async function nativeEdit(ops, base) {
    const response = await fetch(`${nativeUrl.origin}/api/projects/${opened.nativeProjectId}/edit`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-studio-key': nativeUrl.searchParams.get('key') }, body: JSON.stringify({ ops, base }) });
    assert.equal(response.status, 200); return response.json();
  }
  let current = await request(`/api/openfilm/context?projectId=${id}`);
  await nativeEdit([{ op: 'set', clip: current.timeline[0].id, field: 'volume', value: 0.4 }], current.revision);
  current = await request(`/api/openfilm/context?projectId=${id}`);
  const before = main(await read());
  const plan = { timeline: [{ assetId: current.timeline[0].assetId, clipId: current.timeline[0].id, start: 0, end: 6 }], captions: [{ start: 0, end: 2, text: '走近光电 <script>文本</script>', placement: 'title' }], captionMode: 'append' };
  const applied = await request('/api/openfilm/apply-plan', { projectId: id, expectedRevision: current.revision, plan, keepUndo: true });
  assert.equal(applied.duration, 6); assert.ok(applied.undo.id);
  const after = await read(), afterMain = main(after);
  assert.equal(afterMain.id, before.id); assert.equal(afterMain.volume, 0.4); assert.deepEqual(afterMain.time, [0, 6]); assert.deepEqual(afterMain.box, before.box);
  const title = after.tracks.flatMap(track => track.clips).find(clip => clip.attrs?.['data-guangxuan-placement'] === 'title');
  assert.ok(title);
  const titleHtml = await readFile(path.join(path.dirname(filmPath), title.src), 'utf8');
  assert.match(titleHtml, /align-items:flex-start/); assert.match(titleHtml, /&lt;script&gt;/);
  await request('/api/openfilm/apply-plan', { projectId: id, expectedRevision: current.revision, plan, keepUndo: true }, 'POST', 409);
  const restored = await request('/api/openfilm/assistant-undo', { projectId: id, undoId: applied.undo.id });
  assert.equal(restored.restored, true); assert.deepEqual(main(await read()), before);
  await readFile(path.join(path.dirname(filmPath), title.src), 'utf8');
  current = await request(`/api/openfilm/context?projectId=${id}`);
  const captionOnly = await request('/api/openfilm/apply-plan', { projectId: id, expectedRevision: current.revision, keepUndo: true, plan: { captions: [{ start: 0, end: 1, text: '仅加字幕' }], captionMode: 'append' } });
  assert.deepEqual(main(await read()), before);
  await nativeEdit([{ op: 'set', clip: before.id, field: 'volume', value: 0.2 }], captionOnly.revision);
  const beforeRejected = await readFile(filmPath, 'utf8');
  await request('/api/openfilm/assistant-undo', { projectId: id, undoId: captionOnly.undo.id }, 'POST', 409);
  assert.equal(await readFile(filmPath, 'utf8'), beforeRejected);
  current = await request(`/api/openfilm/context?projectId=${id}`);
  const append = { projectId: id, assetId: current.assets[0].id, expectedRevision: current.revision, keepUndo: true, requestId: 'single-animation-operation' };
  const first = await request('/api/openfilm/append-asset', append);
  const second = await request('/api/openfilm/append-asset', append);
  assert.equal(first.revision, second.revision);
  assert.equal((await read()).tracks.flatMap(track => track.clips).filter(clip => clip.attrs?.['data-guangxuan-operation'] === append.requestId).length, 1);
});
