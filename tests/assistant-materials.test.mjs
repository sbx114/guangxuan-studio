import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createAssistantWebService } from '../lib/assistant-web.mjs';
import { createAssistantDownloadService } from '../lib/assistant-downloads.mjs';
import { createVideoService } from '../lib/video.mjs';
import { createOpenFilmManager } from '../lib/openfilm.mjs';
import { createProjectStore } from '../lib/store.mjs';
import { appendWritingMaterial, normalizeWritingMaterials, normalizeMaterialProvenance } from '../lib/assistant-materials.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const publicHost = 'https://materials.example.com';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const bodyA = '第一份材料的真实正文包含观察、证据和可回查的公开研究说明。😀这段文字用来验证UTF16范围，不能把它归到第二份来源。'.repeat(3);
const bodyB = '第二份材料讨论另一个实验和设计目标，有不同的页面标题和原始来源。此段是独立材料，不能归到前一份来源网址。'.repeat(3);
const article = (title, body) => `<html><head><title>${title}</title></head><body><main><p>${body}</p></main></body></html>`;
const gallery = `<html><head><title>光束素材与实验材料</title><meta name="author" content="页面作者声明"><meta property="og:video" content="/downloads/clip.mp4"></head><body><main><p>这是本地受控公开素材页，用于测试实际检索、候选来源、原文件字节与导入流程；不是外部网站或模型的质量证明。</p><a href="/downloads/clip.mp4">光束实验原视频</a><a href="/tone.wav">示例音频原文件</a><img data-original="/picture.png" src="/thumb.png" width="640" height="360" alt="光束实验示意图"><a rel="license" href="https://creativecommons.org/licenses/by/4.0/">页面许可声明</a><script>const forged='<img src="https://wrong.example.com/forged.png">';</script></main></body></html>`;

async function publicFixture(t, { videoBytes, audioBytes } = {}) {
  const requests = [], sockets = new Set(); let video;
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://fixture');
      if (url.pathname.startsWith('/api/video/') && video) { if (await video.handler(req, res, url)) return; }
      if (url.pathname === '/search') { res.writeHead(200, { 'content-type': 'application/rss+xml' }); res.end(`<rss><channel><item><title>光束素材与实验材料</title><link>${publicHost}/gallery</link><description>受控公开来源</description></item><item><title>正文来源A</title><link>${publicHost}/article-a</link><description>研究材料</description></item></channel></rss>`); return; }
      if (url.pathname === '/downloads/clip.mp4') { res.writeHead(302, { location: 'https://cdn.example.com/actual/clip.mp4' }); res.end(); return; }
      if (url.pathname === '/actual/clip.mp4') { res.writeHead(200, { 'content-type': 'video/mp4' }); res.end(videoBytes || Buffer.from('not-a-real-movie')); return; }
      if (url.pathname === '/tone.wav') { res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(audioBytes || Buffer.from('not-a-wave')); return; }
      if (['/picture.png', '/thumb.png'].includes(url.pathname)) { res.writeHead(200, { 'content-type': 'image/png' }); res.end(png); return; }
      const pages = { '/gallery': gallery, '/article-a': article('第一份材料', bodyA), '/article-b': article('第二份材料', bodyB), '/media-only': '<html><title>媒体页</title><body><img src="/picture.png" alt="实际字面资源"></body></html>',
        '/base': '<html><head><title>CDN素材</title><base href="https://cdn.example.com/assets/"></head><body><img src="photo.png" alt="原图"></body></html>',
        '/private-base': '<html><head><title>不能伪造相对地址</title><base href="http://127.0.0.1/private/"></head><body><img src="private.png"><img src="https://cdn.example.com/public.png" alt="明确的公开地址"></body></html>' };
      if (pages[url.pathname]) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(pages[url.pathname]); return; }
      res.writeHead(404); res.end('not found');
    } catch (error) { res.writeHead(error.status || 500); res.end(error.code || String(error.message)); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const service = createAssistantWebService({ dependencies: { lookup: async () => [{ address: '93.184.216.34', family: 4 }], request: async (target, config) => {
    requests.push({ url: target.url.href, address: target.address });
    return new Promise((resolve, reject) => { const req = http.request({ host: '127.0.0.1', port: server.address().port, path: target.url.pathname + target.url.search, headers: { Host: target.url.host }, signal: config.signal }, resolve); req.once('error', reject); req.end(); });
  } } });
  t.after(async () => { await service.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { service, requests, origin: `http://127.0.0.1:${server.address().port}`, attachVideo(value) { video = value; } };
}

test('material search reads real pages, separates original candidates, declared dimensions and unverified rights', async t => {
  const f = await publicFixture(t), result = await f.service.searchMaterials('光束 素材', { kind: 'image', aspect: '16:9', readLimit: 1 });
  assert.equal(result.preparationOnly, true); assert.equal(result.pages.length, 1); assert.equal(result.results.length, 2);
  assert.ok(result.materialCandidates.length >= 2);
  const picture = result.materialCandidates.find(item => item.url === publicHost + '/picture.png');
  assert.ok(picture); assert.equal(picture.contentVerified, false); assert.equal(picture.match.semanticMatchVerified, false); assert.equal(picture.match.motionVerified, false);
  assert.equal(picture.sourcePage.url, publicHost + '/gallery'); assert.equal(picture.sourcePage.authorDeclared, '页面作者声明');
  assert.deepEqual(picture.declaredDimensions, { width: 640, height: 360, basis: 'html-element', verified: false });
  assert.equal(picture.rights.status, 'page-declaration'); assert.equal(picture.rights.applicability, 'unconfirmed-for-asset'); assert.equal(picture.rights.verification, 'not-legally-verified');
  assert.ok(!JSON.stringify(result).includes('forged.png')); assert.ok(f.requests.every(request => request.address === '93.184.216.34'));
});

test('media-only pages work, literal base URLs are honoured and private bases never fabricate public candidates', async t => {
  const f = await publicFixture(t);
  assert.equal((await f.service.read(publicHost + '/media-only')).materialCandidates[0].kind, 'image');
  const cdn = await f.service.read(publicHost + '/base'); assert.equal(cdn.materialCandidates[0].url, 'https://cdn.example.com/assets/photo.png');
  const blocked = await f.service.read(publicHost + '/private-base');
  assert.ok(blocked.materialCandidates.some(item => item.url === 'https://cdn.example.com/public.png'));
  assert.ok(!blocked.materialCandidates.some(item => item.url.includes('private.png'))); assert.ok(!blocked.links.some(link => link.url.includes('private.png')));
});

test('two imported web texts retain exact UTF16 ranges, titles and URLs; edited ranges become untrusted', async t => {
  const f = await publicFixture(t), a = await f.service.read(publicHost + '/article-a'), b = await f.service.read(publicHost + '/article-b');
  const first = appendWritingMaterial({}, a), both = appendWritingMaterial(first, b), ledger = normalizeWritingMaterials(both);
  assert.equal(ledger.items.length, 2); assert.equal(ledger.items[0].title, '第一份材料'); assert.equal(ledger.items[1].url, publicHost + '/article-b');
  for (const entry of ledger.items) assert.equal(hash(both.text.slice(entry.range.start, entry.range.end)), entry.contentSHA256);
  assert.equal(both.text.slice(ledger.items[1].range.start, ledger.items[1].range.end), b.text);
  assert.deepEqual(appendWritingMaterial(both, a), both, 'same still-valid source text is not appended twice');
  const edited = normalizeWritingMaterials({ ...both, text: '手工增加前缀。' + both.text });
  assert.equal(edited.status, 'stale'); assert.equal(edited.canUseLegacyUrl, false); assert.equal(edited.items.length, 0);
});

test('locator-only provenance never invents a verified final transport or a copyright grant', () => {
  const locator = normalizeMaterialProvenance({ requestedUrl: publicHost + '/watch', sourcePage: { url: publicHost + '/gallery', title: '真实读页' }, rights: { status: 'verified', licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/' } });
  assert.equal(locator.locatorUrl, publicHost + '/watch'); assert.equal(locator.finalUrl, undefined); assert.equal(locator.transportUrlVerified, false); assert.equal(locator.rights.status, 'unknown');
  const actual = normalizeMaterialProvenance({}, { requestedUrl: publicHost + '/download', finalUrl: 'https://cdn.example.com/file.mp4', sha256: 'a'.repeat(64), size: 100 });
  assert.equal(actual.transportUrlVerified, true); assert.equal(actual.finalUrl, 'https://cdn.example.com/file.mp4');
});

test('actual candidate downloads retain source-page provenance and cannot be relabelled with another candidate', async t => {
  const f = await publicFixture(t), read = await f.service.read(publicHost + '/gallery'), candidate = read.materialCandidates.find(item => item.url === publicHost + '/picture.png');
  const file = await f.service.download(candidate.url, { candidateId: candidate.id });
  assert.equal(file.provenance.sourcePage.url, publicHost + '/gallery'); assert.equal(file.provenance.sha256, hash(png));
  assert.equal(file.provenance.rights.verification, 'not-legally-verified'); assert.deepEqual(file.buffer, png);
  await assert.rejects(f.service.download(publicHost + '/thumb.png', { candidateId: candidate.id }), { code: 'ASSISTANT_WEB_MATERIAL_CANDIDATE' });
});

test('public-material download, FFprobe and canonical native import preserve real image/video/audio plus origins without editing a timeline', { skip: !process.env.GUANGXUAN_BIN_DIR, timeout: 180000 }, async t => {
  const command = promisify(execFile), bin = process.env.GUANGXUAN_BIN_DIR, root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const parent = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(parent, { recursive: true });
  const folder = await mkdtemp(path.join(parent, 'gx-network-materials-')), dataDir = path.join(folder, 'data');
  const mp4 = path.join(folder, 'original.mp4'), wav = path.join(folder, 'original.wav');
  await command(path.join(bin, 'ffmpeg.exe'), ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=15:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-threads', '1', mp4], { windowsHide: true });
  await command(path.join(bin, 'ffmpeg.exe'), ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=1', '-c:a', 'pcm_s16le', wav], { windowsHide: true });
  const videoBytes = await readFile(mp4), audioBytes = await readFile(wav), f = await publicFixture(t, { videoBytes, audioBytes });
  const store = await createProjectStore(dataDir);
  const video = await createVideoService({ dataDir, root, ffmpegPath: path.join(bin, 'ffmpeg.exe'), ffprobePath: path.join(bin, 'ffprobe.exe') }); f.attachVideo(video);
  const downloads = await createAssistantDownloadService({ dataDir, webTools: f.service, store, videoService: video });
  const manager = await createOpenFilmManager({ dataDir, root, store, resolveAsset: id => video.resolveAsset(id), registerOwnedAsset: (...args) => video.registerOwnedAsset(...args) });
  let restoredVideo, restoredDownloads, restoredManager;
  t.after(async () => { await restoredManager?.close(); await restoredDownloads?.close(); await restoredVideo?.close(); await manager.close(); await downloads.close(); await video.close(); await store.settle(); if (process.env.GUANGXUAN_KEEP_MATERIAL_TESTS !== '1') { assert.equal(path.dirname(folder), parent); await rm(folder, { recursive: true, force: true }); } });
  const project = await store.save('network-material-project', { kind: 'video', title: '隔离网络素材工程', video: { timeline: [], captions: [], aspect: '16:9', resolution: '720' } });
  const before = await manager.context(project.id, f.origin), filmFile = path.join(dataDir, 'openfilm/projects', project.id, 'film.html'), beforeFilm = await readFile(filmFile);
  const page = await f.service.read(publicHost + '/gallery'), entries = [];
  for (const [url, type, bytes] of [[publicHost + '/picture.png', 'image', png], [publicHost + '/downloads/clip.mp4', 'video', videoBytes], [publicHost + '/tone.wav', 'audio', audioBytes]]) {
    const candidate = page.materialCandidates.find(item => item.url === url); assert.ok(candidate);
    const saved = await downloads.download(url, { projectId: project.id, runId: 'material-test-' + type, candidateId: candidate.id });
    const original = await downloads.read(saved.download.id, { projectId: project.id }); assert.deepEqual(original.buffer, bytes);
    const prepared = await downloads.mediaAsset(saved.download.id, { projectId: project.id });
    assert.equal(prepared.asset.type, type); assert.equal(prepared.download.preparedMedia.metadataVerified, true);
    const imported = await manager.importAsset(project.id, prepared.asset.id, f.origin, { expectedRevision: before.revision, requestId: 'network-' + type });
    const canonical = await video.resolveAsset(imported.asset.id); assert.equal(hash(await readFile(canonical.path)), hash(bytes));
    assert.equal(imported.asset.provenance.sourcePage.url, publicHost + '/gallery'); assert.equal(imported.asset.provenance.rights.status, 'page-declaration');
    assert.equal(imported.asset.provenance.rights.verification, 'not-legally-verified');
    const meta = await video.readAssetMetadata(imported.asset.id); assert.equal(meta.provenance.sha256, hash(bytes));
    if (type === 'video') { assert.equal(meta.video.width, 160); assert.equal(meta.video.height, 90); assert.equal(meta.provenance.finalUrl, 'https://cdn.example.com/actual/clip.mp4'); }
    if (type === 'audio') { assert.equal(meta.audioTrackCount, 1); assert.equal(meta.audioTracks[0].sampleRate, 16000); }
    entries.push({ type, download: saved.download, prepared: prepared.download.preparedMedia, imported: imported.asset, metadata: meta });
  }
  const after = await manager.context(project.id, f.origin); assert.equal(after.assets.length, 3); assert.equal(after.timeline.length, 0); assert.equal(after.duration, 0); assert.equal(after.revision, before.revision);
  assert.deepEqual(await readFile(filmFile), beforeFilm);
  await store.save('other-project', { kind: 'video', title: '另一个隔离工程', video: {} });
  await assert.rejects(downloads.mediaAsset(entries[0].download.id, { projectId: 'other-project' }), { code: 'ASSISTANT_DOWNLOAD_NOT_FOUND' });
  const provenanceRead = after.assets.find(item => item.type === 'video').provenance; assert.equal(provenanceRead.sourcePage.url, publicHost + '/gallery');
  await assert.rejects(video.setAssetProvenance(entries[1].imported.id, { ...entries[1].imported.provenance, sha256: 'f'.repeat(64) }), { code: 'MEDIA_PROVENANCE_CHANGED' });
  assert.equal((await video.readAssetMetadata(entries[1].imported.id)).provenance.sha256, hash(videoBytes), 'failed attribution of mismatched bytes leaves the prior source intact');
  await manager.close(); await downloads.close(); await video.close();
  restoredVideo = await createVideoService({ dataDir, root, ffmpegPath: path.join(bin, 'ffmpeg.exe'), ffprobePath: path.join(bin, 'ffprobe.exe') }); f.attachVideo(restoredVideo);
  restoredDownloads = await createAssistantDownloadService({ dataDir, webTools: f.service, store, videoService: restoredVideo });
  restoredManager = await createOpenFilmManager({ dataDir, root, store, resolveAsset: id => restoredVideo.resolveAsset(id), registerOwnedAsset: (...args) => restoredVideo.registerOwnedAsset(...args) });
  const restarted = await restoredManager.context(project.id, f.origin); assert.equal(restarted.assets.length, 3); assert.equal(restarted.duration, 0);
  assert.equal(restarted.assets.find(item => item.type === 'audio').provenance.sourcePage.url, publicHost + '/gallery');
  const recovered = await restoredDownloads.read(entries[1].download.id, { projectId: project.id }); assert.deepEqual(recovered.buffer, videoBytes); assert.equal(recovered.download.provenance.finalUrl, 'https://cdn.example.com/actual/clip.mp4'); assert.equal(recovered.download.preparedMedia.metadataVerified, true);
  await store.remove(project.id); await store.save(project.id, { kind: 'video', title: '重新创建的隔离工程', createdAt: '2099-01-01T00:00:00.000Z', video: {} });
  await assert.rejects(restoredDownloads.mediaAsset(entries[0].download.id, { projectId: project.id }), { code: 'ASSISTANT_DOWNLOAD_PROJECT_CHANGED' });
  await writeFile(path.join(folder, 'materials-network-verification.json'), JSON.stringify({ status: 'passed', localPublicHttpFixture: true, externalNetworkUsed: false, externalModelHttp: 0, actualFFprobe: true, canonicalNativeImport: true, restartProvenancePreserved: true, mismatchedBytesRejected: true, recreatedProjectMediaImportRejected: true, projectId: project.id, filmSha256: hash(beforeFilm), timelineUnchanged: true, entries, requests: f.requests, sourcePage: publicHost + '/gallery' }, null, 2));
});
