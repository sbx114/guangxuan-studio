import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function command(binary, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let error = '';
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stderr.on('data', chunk => { error = (error + chunk.toString()).slice(-3000); });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`Media command failed: ${error}`)));
  });
}

test('native OpenFilm bridge migrates owned assets, preserves JSON, edits real film, and exports MP4', { timeout: 240000, skip: process.env.GUANGXUAN_TEST_OPENFILM !== '1' }, async t => {
  // Exercise the shipped launcher's default environment, so an explicit native
  // browser override cannot hide a missing installed-browser discovery bridge.
  const nativeBrowserOverride = process.env.OPENFILM_BROWSER_EXECUTABLE;
  delete process.env.OPENFILM_BROWSER_EXECUTABLE;
  t.after(() => { if (nativeBrowserOverride === undefined) delete process.env.OPENFILM_BROWSER_EXECUTABLE; else process.env.OPENFILM_BROWSER_EXECUTABLE = nativeBrowserOverride; });
  await access(path.join(ROOT, 'integrations/openfilm/packages/openfilm/studio/ui/dist/index.html'));
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'guangxuan-openfilm-test-'));
  let app;
  t.after(async () => {
    await app?.close();
    const resolved = path.resolve(temporary);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('guangxuan-openfilm-test-')) throw new Error('Refusing unsafe cleanup target');
    await rm(resolved, { recursive: true, force: true });
  });
  const extension = process.platform === 'win32' ? '.exe' : '';
  const ffmpeg = process.env.GUANGXUAN_FFMPEG || (process.env.GUANGXUAN_BIN_DIR ? path.join(process.env.GUANGXUAN_BIN_DIR, `ffmpeg${extension}`) : 'ffmpeg');
  const ffprobe = process.env.GUANGXUAN_FFPROBE || (process.env.GUANGXUAN_BIN_DIR ? path.join(process.env.GUANGXUAN_BIN_DIR, `ffprobe${extension}`) : 'ffprobe');
  const fixture = path.join(temporary, 'original-clip.mp4');
  await command(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=30:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', fixture]);
  const dataDir = path.join(temporary, 'data');
  app = await startServer({ dataDir, port: 0 });
  assert.notEqual(new URL(app.url).port, '4417');
  async function request(route, body, method = body === undefined ? 'GET' : 'POST', expected = 200) {
    const response = await fetch(`${app.url}${route}`, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json();
    assert.equal(response.status, expected, JSON.stringify(data));
    return data;
  }
  const imported = await request('/api/video/import-local', { paths: [fixture] });
  const asset = imported.assets[0];
  const id = 'openfilm-owned-test';
  await request(`/api/projects/${id}`, {
    id, title: '原生工程测试', kind: 'video', description: '合成媒体测试，不是真实用户资料',
    source: { text: '保留原始来源' }, outputs: { article: { body: '保留已有文案' } }, history: [{ label: '原始记录' }],
    video: { timeline: [{ id: 'clip-one', assetId: asset.id, start: 0.25, end: 1.25 }], captions: [{ start: 0.1, end: 0.8, text: '字幕 <script>不会执行</script>' }], aspect: '16:9', resolution: '720', sourceVolume: 1 },
  }, 'PUT');
  const legacyPath = path.join(dataDir, 'projects', `${id}.json`);
  const originalJson = await readFile(legacyPath, 'utf8');
  await request('/api/openfilm/open', { projectId: '../outside' }, 'POST', 400);
  const opened = await request('/api/openfilm/open', { projectId: id });
  assert.equal(opened.editorUrl, '/openfilm/editor.html');
  assert.ok(typeof opened.nativeProjectId === 'string' && opened.nativeProjectId);
  assert.ok(typeof opened.sessionId === 'string' && opened.sessionId);
  assert.ok(!JSON.stringify(opened).includes('key='));
  assert.equal(await readFile(legacyPath, 'utf8'), originalJson, 'Migration must not rewrite the original JSON project');
  const projectRoot = path.join(dataDir, 'openfilm', 'projects', id);
  const snapshot = JSON.parse(await readFile(path.join(projectRoot, 'legacy-project.json'), 'utf8'));
  assert.equal(snapshot.source.text, '保留原始来源');
  assert.equal(snapshot.outputs.article.body, '保留已有文案');
  const marker = JSON.parse(await readFile(path.join(projectRoot, '.guangxuan-project.json'), 'utf8'));
  assert.equal(marker.projectId, id);
  const { readFilmFile } = await import(pathToFileURL(path.join(ROOT, 'integrations/openfilm/packages/openfilm/src/film-doc.mjs')).href);
  const filmPath = path.join(projectRoot, 'film.html');
  const parsed = readFilmFile(await readFile(filmPath, 'utf8'));
  assert.deepEqual(parsed.problems, []);
  const clips = parsed.doc.tracks.flatMap(track => track.clips);
  const video = clips.find(clip => clip.src.endsWith('.mp4'));
  assert.deepEqual(video.time, [0.25, 1.25]);
  assert.equal(video.at || 0, 0);
  assert.match(video.src, /^assets\/guangxuan\//);
  await access(path.join(projectRoot, video.src));
  const page = clips.find(clip => clip.src.endsWith('.html'));
  assert.ok(page);
  const pageText = await readFile(path.join(projectRoot, page.src), 'utf8');
  assert.match(pageText, /&lt;script&gt;/);
  assert.ok(!pageText.includes('<script>不会执行'));

  const wrapper = await fetch(`${app.url}${opened.editorUrl}`);
  assert.equal(wrapper.status, 200);
  assert.equal(wrapper.headers.get('x-frame-options'), 'SAMEORIGIN');
  const html = await wrapper.text();
  assert.ok(html.includes(`data-session-id="${opened.sessionId}"`));
  const nativeUrl = new URL(/id="openfilm-studio"[^>]+src="([^"]+)"/.exec(html)[1].replaceAll('&amp;', '&'));
  assert.ok(['127.0.0.1', 'localhost'].includes(nativeUrl.hostname));
  assert.match(wrapper.headers.get('content-security-policy'), new RegExp(`frame-src ${nativeUrl.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.ok(!wrapper.headers.get('content-security-policy').includes('*'));
  const main = await fetch(app.url, { method: 'HEAD' });
  assert.equal(main.headers.get('x-frame-options'), 'DENY');
  assert.match(main.headers.get('content-security-policy'), /frame-src 'self'/);
  const nativePage = await fetch(nativeUrl, { redirect: 'follow' });
  assert.equal(nativePage.status, 200);
  assert.match(nativePage.headers.get('content-type'), /^text\/html/);
  assert.notEqual(nativePage.headers.get('x-frame-options'), 'DENY');
  assert.notEqual(nativePage.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.ok(nativePage.headers.get('content-security-policy')?.includes(app.url), 'Native Studio must explicitly allow the owning app as frame ancestor');
  assert.ok((await nativePage.text()).includes('<script'));

  let context = await request(`/api/openfilm/context?projectId=${id}`);
  assert.equal(context.projectId, id);
  assert.equal(context.nativeProjectId, opened.nativeProjectId);
  assert.equal(context.timeline.length, 1);
  assert.equal(context.mainTrackEditable, true);
  assert.ok(context.assets.some(item => item.id === context.timeline[0].assetId));
  assert.ok(context.assets.every(item => !Object.hasOwn(item, 'path')));
  const secondContext = await request('/api/openfilm/context', { projectId: id });
  assert.equal(secondContext.timeline[0].assetId, context.timeline[0].assetId);
  const oldRevision = context.revision;
  await writeFile(path.join(projectRoot, 'pages/native-note.html'), '<!doctype html><html><body style="margin:0;background:transparent"><div>Native manual overlay</div><script>window.film={duration:0.4,frame(t){}};</script></body></html>');
  const nativeEdit = await fetch(`${nativeUrl.origin}/api/projects/${encodeURIComponent(opened.nativeProjectId)}/edit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-studio-key': nativeUrl.searchParams.get('key') },
    body: JSON.stringify({ base: context.revision, ops: [{ op: 'insert', newTrack: 0, newTrackAttrs: { title: 'Native manual track' }, clip: { id: 'native-manual-page', src: 'pages/native-note.html', at: 0, time: [0, 0.4], size: { w: 1280, h: 720 } } }] }),
  });
  assert.equal(nativeEdit.status, 200); await nativeEdit.json();
  const planBody = { projectId: id, expectedRevision: oldRevision, plan: { timeline: [{ assetId: context.timeline[0].assetId, start: 0.5, end: 1.25 }], captions: [], aspect: '16:9', resolution: '720' } };
  await request('/api/openfilm/apply-plan', planBody, 'POST', 409);
  context = await request(`/api/openfilm/context?projectId=${id}`);
  assert.equal(context.mainTrackEditable, true, 'A separate native HTML track must not block media rough cuts');
  const currentFilm = readFilmFile(await readFile(filmPath, 'utf8'));
  const primaryIndex = currentFilm.doc.tracks.findIndex(track => track.attrs?.id === 'guangxuan-picture');
  async function nativeOps(ops, base) {
    const response = await fetch(`${nativeUrl.origin}/api/projects/${encodeURIComponent(opened.nativeProjectId)}/edit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-studio-key': nativeUrl.searchParams.get('key') }, body: JSON.stringify({ base, ops }),
    });
    assert.equal(response.status, 200); return response.json();
  }
  await nativeOps([{ op: 'insert', track: primaryIndex, clip: { id: 'native-mixed-main-page', src: 'pages/native-note.html', at: 0, time: [0, 0.4], size: { w: 1280, h: 720 } } }], context.revision);
  const mixed = await request(`/api/openfilm/context?projectId=${id}`);
  assert.equal(mixed.mainTrackEditable, false);
  assert.ok(mixed.warnings.some(warning => warning.includes('主画面轨')));
  const beforeRejected = await readFile(filmPath, 'utf8');
  const rejected = await request('/api/openfilm/apply-plan', { ...planBody, expectedRevision: mixed.revision }, 'POST', 409);
  assert.equal(rejected.code, 'OPENFILM_MAIN_TRACK_UNSUPPORTED');
  assert.equal(await readFile(filmPath, 'utf8'), beforeRejected, 'Rejected rough cut must not remove the unrepresented main-track page');
  await nativeOps([{ op: 'remove', clip: 'native-mixed-main-page' }], mixed.revision);
  context = await request(`/api/openfilm/context?projectId=${id}`);
  assert.equal(context.mainTrackEditable, true);
  planBody.expectedRevision = context.revision;
  const applied = await request('/api/openfilm/apply-plan', planBody);
  assert.equal(applied.applied, true);
  assert.equal(applied.duration, 0.75);
  await request('/api/openfilm/apply-plan', planBody, 'POST', 409);
  const afterPlan = readFilmFile(await readFile(filmPath, 'utf8'));
  assert.ok(afterPlan.doc.tracks.some(track => track.clips.some(clip => clip.id === 'native-manual-page')), 'AI rough cut must retain unrelated native tracks');
  assert.equal((await request('/api/projects/summary')).projects.find(project => project.id === id).duration, 0.75);
  await request('/api/openfilm/append-asset', { projectId: id, assetId: asset.id });
  const summary = (await request('/api/projects/summary')).projects.find(project => project.id === id);
  assert.equal(summary.duration, 2.75);
  assert.equal(summary.clipCount, 3);
  assert.equal(await readFile(legacyPath, 'utf8'), originalJson, 'Native edits preserve the legacy source project');
  await request(`/api/projects/${id}`, { title: '已修改项目名' }, 'PATCH');
  assert.equal(JSON.parse(await readFile(path.join(projectRoot, '.guangxuan-project.json'), 'utf8')).title, '已修改项目名');

  const submitted = await request('/api/openfilm/export', { projectId: id, spec: { fps: 30, range: [0, 0.5], name: 'Native test export' } });
  let exported;
  const deadline = Date.now() + 150000;
  do {
    const listed = await request(`/api/openfilm/exports?projectId=${id}`);
    exported = listed.exports.find(job => job.id === submitted.export.id);
    if (exported?.status === 'failed') {
      const detailedResponse = await fetch(`${nativeUrl.origin}/api/projects/${encodeURIComponent(opened.nativeProjectId)}/exports`, { headers: { 'x-studio-key': nativeUrl.searchParams.get('key') } });
      const details = await detailedResponse.json();
      const failed = details.exports?.find(job => job.id === submitted.export.id);
      const launchKey = nativeUrl.searchParams.get('key') || '';
      let diagnostic = String(failed?.error || 'Native export failed without diagnostic text.');
      if (launchKey) diagnostic = diagnostic.split(launchKey).join('[launch-key-redacted]');
      diagnostic = diagnostic.replace(/([?&]key=)[^&\s"'<>]+/gi, '$1[redacted]');
      assert.fail(`Native export failed: ${diagnostic.slice(0, 4000)}`);
    }
    if (exported?.status === 'done') break;
    await delay(300);
  } while (Date.now() < deadline);
  assert.equal(exported?.status, 'done', JSON.stringify(exported));
  const download = await fetch(`${app.url}${exported.downloadUrl}`);
  assert.equal(download.status, 200);
  const output = path.join(temporary, 'native-output.mp4');
  await writeFile(output, Buffer.from(await download.arrayBuffer()));
  const metadata = JSON.parse((await command(ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', output])).toString());
  assert.ok(metadata.streams.some(stream => stream.codec_type === 'video'));
  assert.ok(Math.abs(Number(metadata.format.duration) - 0.5) < 0.15);
});
