import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AppError } from '../lib/errors.mjs';
import { createVideoService } from '../lib/video.mjs';
import { createReferenceUrlImporter, resolvePublicReferenceUrl, isPublicReferenceAddress, referenceDownloaderArgs, createReferenceMetadataProxy, MAX_REFERENCE_URL_BYTES } from '../lib/reference-url.mjs';

const publicIp = '93.184.216.34';
const lookupPublic = async () => [{ address: publicIp, family: 4 }];
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(512, 7)]);
const code = expected => error => { assert.equal(error.code, expected); return true; };
const execute = promisify(execFile);

async function setup(t, handler, options = {}) {
  const testRoot = path.resolve(process.env.GUANGXUAN_TEST_WORK || path.join(os.tmpdir(), 'guangxuan-reference-url-tests'));
  await fs.mkdir(testRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(testRoot, 'url-'));
  const requests = [], imports = [], sockets = new Set();
  const server = http.createServer(handler || ((_req, res) => { res.writeHead(200, { 'content-type': 'video/mp4' }); res.end(mp4); }));
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const request = async (target, requestOptions) => {
    requests.push({ url: target.url.href, address: target.address, family: target.family, headers: requestOptions.headers });
    return new Promise((resolve, reject) => {
      // Test-only transport maps the already-validated public URL to a local fixture server.
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path: target.url.pathname + target.url.search, signal: requestOptions.signal, headers: requestOptions.headers }, resolve);
      req.once('error', reject); req.end();
    });
  };
  const importer = createReferenceUrlImporter({ dataDir: directory, root: path.resolve('.'),
    importLocal: async (filename, metadata) => {
      assert.equal(path.dirname(path.dirname(filename)), path.join(await fs.realpath(directory), 'reference-url'));
      assert.equal(metadata.expectedType, 'video'); assert.ok(metadata.signal instanceof AbortSignal);
      imports.push({ filename, metadata, bytes: await fs.readFile(filename) });
      return { id: 'reference-asset-' + imports.length, type: 'video', name: metadata.name };
    },
    ...options,
    dependencies: { lookup: lookupPublic, request, ...options.dependencies },
  });
  t.after(async () => {
    await importer.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve));
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== testRoot || !path.basename(resolved).startsWith('url-')) throw new Error('Unsafe test cleanup path');
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return { importer, directory, requests, imports, server, async remaining() { return fs.readdir(path.join(directory, 'reference-url')).catch(error => { if (error.code === 'ENOENT') return []; throw error; }); } };
}

test('public-address policy rejects local, reserved, mapped and cloud-metadata addresses', () => {
  for (const value of ['0.0.0.0', '10.1.1.1', '127.0.0.1', '100.100.100.200', '169.254.169.254', '172.16.0.1', '192.168.1.1', '192.0.0.192', '198.18.0.1', '224.0.0.1', '255.255.255.255', '168.63.129.16', '::1', '::', 'fc00::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '2002:7f00:1::', '2001::1', '2001:db8::1', '64:ff9b::7f00:1', '3fff::1']) assert.equal(isPublicReferenceAddress(value), false, value);
  for (const value of [publicIp, '8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8']) assert.equal(isPublicReferenceAddress(value), true, value);
});

test('URL input cannot provide paths, credentials, internal names, alternate IP spellings or nonstandard ports', async t => {
  const run = await setup(t);
  for (const url of ['file:///C:/private/video.mp4', 'C:\\private\\video.mp4', 'ftp://example.com/a.mp4', 'https://user:pass@example.com/a.mp4', 'http://localhost/a.mp4', 'http://metadata.google.internal/a', 'http://127.1/a', 'http://2130706433/a', 'http://0x7f000001/a', 'http://[::ffff:7f00:1]/a', 'https://example.com:22/a']) {
    await assert.rejects(run.importer.import(url), error => error instanceof AppError && error.status === 400, url);
  }
  assert.equal(run.requests.length, 0); assert.equal(run.imports.length, 0);
});

test('all DNS answers must be public, not only the selected address', async () => {
  for (const addresses of [[{ address: '127.0.0.1', family: 4 }], [{ address: publicIp, family: 4 }, { address: 'fd00::1', family: 6 }], []]) {
    await assert.rejects(resolvePublicReferenceUrl('https://cdn.example.com/a.mp4', { lookup: async () => addresses }), code('REFERENCE_URL_PRIVATE'));
  }
});

test('direct MP4 streams into a managed file and retains that path after registration', async t => {
  const run = await setup(t);
  const result = await run.importer.import('https://cdn.example.com/my-video.mp4#ignored');
  assert.equal(result.asset.type, 'video'); assert.equal(result.sourceUrl, 'https://cdn.example.com/my-video.mp4'); assert.equal(result.title, 'my-video');
  assert.equal(run.requests[0].address, publicIp); assert.equal(run.requests[0].family, 4);
  assert.deepEqual(run.imports[0].bytes, mp4); assert.equal((await run.remaining()).length, 1);
  await run.importer.close(); assert.deepEqual(await fs.readFile(run.imports[0].filename), mp4);
});

test('every redirect is re-resolved and a DNS rebind is rejected before connecting', async t => {
  let lookups = 0;
  const run = await setup(t, (_req, res) => { res.writeHead(302, { location: '/next.mp4' }); res.end(); }, {
    dependencies: { lookup: async () => [{ address: ++lookups <= 2 ? publicIp : '127.0.0.1', family: 4 }] },
  });
  await assert.rejects(run.importer.import('https://cdn.example.com/start.mp4'), code('REFERENCE_URL_PRIVATE'));
  assert.equal(run.requests.length, 1); assert.equal(run.imports.length, 0); assert.deepEqual(await run.remaining(), []);
});

test('redirects cannot reach cloud metadata or downgrade HTTPS', async t => {
  const privateRun = await setup(t, (_req, res) => { res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }); res.end(); });
  await assert.rejects(privateRun.importer.import('http://cdn.example.com/start'), code('REFERENCE_URL_PRIVATE'));
  const downgrade = await setup(t, (_req, res) => { res.writeHead(302, { location: 'http://cdn.example.com/video.mp4' }); res.end(); });
  await assert.rejects(downgrade.importer.import('https://cdn.example.com/start'), code('REFERENCE_URL_INVALID'));
  assert.equal(privateRun.requests.length, 1); assert.equal(downgrade.requests.length, 1);
});

test('public redirect succeeds and redirect loops stop after a bounded number of requests', async t => {
  const run = await setup(t, (req, res) => { if (req.url === '/start') { res.writeHead(302, { location: 'https://media.example.com/final.mp4' }); res.end(); } else { res.writeHead(200, { 'content-type': 'video/mp4' }); res.end(mp4); } });
  await run.importer.import('https://cdn.example.com/start'); assert.equal(run.requests.length, 2);
  const looping = await setup(t, (_req, res) => { res.writeHead(307, { location: '/again' }); res.end(); });
  await assert.rejects(looping.importer.import('https://cdn.example.com/start'), code('REFERENCE_URL_REDIRECT'));
  assert.equal(looping.requests.length, 6);
});

test('both declared and streamed oversize files stop before registration', async t => {
  assert.equal(MAX_REFERENCE_URL_BYTES, 200 * 1024 * 1024);
  const declared = await setup(t, (_req, res) => { res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': 1000000 }); res.end(); }, { maxBytes: 512 });
  await assert.rejects(declared.importer.import('https://cdn.example.com/a.mp4'), code('REFERENCE_URL_TOO_LARGE'));
  const streamed = await setup(t, (_req, res) => { res.writeHead(200, { 'content-type': 'video/mp4' }); res.write(mp4); res.end(Buffer.alloc(1000)); }, { maxBytes: 600 });
  await assert.rejects(streamed.importer.import('https://cdn.example.com/a.mp4'), code('REFERENCE_URL_TOO_LARGE'));
  assert.equal(streamed.imports.length, 0); assert.deepEqual(await streamed.remaining(), []); assert.deepEqual(await declared.remaining(), []);
});

test('HTML, playlists, wrong containers and compressed bodies never reach the media importer', async t => {
  for (const [headers, bytes, expected] of [
    [{ 'content-type': 'text/html' }, Buffer.from('<html>login</html>'), 'REFERENCE_PAGE_UNSUPPORTED'],
    [{ 'content-type': 'application/vnd.apple.mpegurl' }, Buffer.from('#EXTM3U\nhttp://127.0.0.1/secret'), 'REFERENCE_PAGE_UNSUPPORTED'],
    [{ 'content-type': 'video/mp4' }, Buffer.from('<html>not a video</html>'), 'REFERENCE_FORMAT_UNSUPPORTED'],
    [{ 'content-type': 'video/mp4', 'content-encoding': 'gzip' }, mp4, 'REFERENCE_FORMAT_UNSUPPORTED'],
  ]) {
    const run = await setup(t, (_req, res) => { res.writeHead(200, headers); res.end(bytes); });
    await assert.rejects(run.importer.import('https://cdn.example.com/a.mp4'), code(expected));
    assert.equal(run.imports.length, 0); assert.deepEqual(await run.remaining(), []);
  }
});

test('download cancellation and total timeout release the file and socket', async t => {
  let began;
  const start = new Promise(resolve => { began = resolve; });
  const run = await setup(t, (_req, res) => { res.writeHead(200, { 'content-type': 'video/mp4' }); res.write(mp4); began(); });
  const controller = new AbortController(), pending = run.importer.import('https://cdn.example.com/a.mp4', { signal: controller.signal });
  await start; controller.abort(); await assert.rejects(pending, code('REFERENCE_URL_CANCELLED'));
  assert.deepEqual(await run.remaining(), []); assert.equal(run.imports.length, 0);
  const timed = await setup(t, (_req, res) => { res.writeHead(200, { 'content-type': 'video/mp4' }); res.write(mp4); }, { timeoutMs: 40 });
  await assert.rejects(timed.importer.import('https://cdn.example.com/a.mp4'), code('REFERENCE_URL_TIMEOUT'));
  assert.deepEqual(await timed.remaining(), []);
});

test('closing the service cancels active work and rejects new imports', async t => {
  let began;
  const start = new Promise(resolve => { began = resolve; });
  const run = await setup(t, (_req, res) => { res.writeHead(200, { 'content-type': 'video/mp4' }); res.write(mp4); began(); });
  const pending = run.importer.import('https://cdn.example.com/a.mp4');
  const rejected = assert.rejects(pending, code('REFERENCE_URL_CANCELLED'));
  await start; await run.importer.close(); await rejected;
  await assert.rejects(run.importer.import('https://cdn.example.com/a.mp4'), code('REFERENCE_URL_CANCELLED'));
});

test('cancellation reaches media probing before an asset is registered', async t => {
  let began;
  const started = new Promise(resolve => { began = resolve; });
  const run = await setup(t, null, { importLocal: async (_filename, metadata) => {
    began();
    await new Promise((_, reject) => metadata.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  } });
  const controller = new AbortController(), pending = run.importer.import('https://cdn.example.com/a.mp4', { signal: controller.signal });
  await started; controller.abort(); await assert.rejects(pending, code('REFERENCE_URL_CANCELLED'));
  assert.deepEqual(await run.remaining(), []);
});

test('assistant opt-in retains a committed asset receipt when cancellation arrives inside registration', async t => {
  const controller = new AbortController(); let committedFile;
  const run = await setup(t, null, { importLocal: async (filename, metadata) => {
    assert.ok(metadata.signal instanceof AbortSignal); committedFile = filename;
    controller.abort(); return { id: 'already-registered', type: 'video', name: metadata.name };
  } });
  const result = await run.importer.import('https://cdn.example.com/campus.mp4', { signal: controller.signal, retainCommittedReceipt: true });
  assert.equal(result.asset.id, 'already-registered'); assert.equal(result.sourceUrl, 'https://cdn.example.com/campus.mp4');
  assert.deepEqual(await fs.readFile(committedFile), mp4); assert.equal((await run.remaining()).length, 1);
});

test('default reference import keeps its cancellation result while preserving already registered bytes', async t => {
  const controller = new AbortController(); let committedFile;
  const run = await setup(t, null, { importLocal: async filename => { committedFile = filename; controller.abort(); return { id: 'already-registered', type: 'video' }; } });
  await assert.rejects(run.importer.import('https://cdn.example.com/campus.mp4', { signal: controller.signal }), code('REFERENCE_URL_CANCELLED'));
  assert.deepEqual(await fs.readFile(committedFile), mp4);
});

test('retaining committed receipts does not suppress cancellation before registration succeeds', async t => {
  let began; const started = new Promise(resolve => { began = resolve; });
  const run = await setup(t, null, { importLocal: async (_filename, metadata) => { began(); await new Promise((_, reject) => metadata.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })); } });
  const controller = new AbortController(), pending = run.importer.import('https://cdn.example.com/campus.mp4', { signal: controller.signal, retainCommittedReceipt: true });
  const rejected = assert.rejects(pending, code('REFERENCE_URL_CANCELLED')); await started; controller.abort(); await rejected;
  assert.deepEqual(await run.remaining(), []);
});

test('trusted progress observers see preparation, transfer and registration without changing the imported asset', async t => {
  const run = await setup(t), progress = [];
  const result = await run.importer.import('https://cdn.example.com/campus.mp4', { onProgress: value => { progress.push(value); throw new Error('Observer failure'); } });
  assert.equal(result.asset.id, 'reference-asset-1');
  assert.equal(progress[0].phase, 'preparing'); assert.ok(progress.some(value => value.phase === 'downloading' && value.receivedBytes === 0));
  assert.equal(progress.at(-1).phase, 'complete'); assert.equal(progress.at(-1).receivedBytes, mp4.length);
  assert.ok(progress.every(value => !JSON.stringify(value).includes('cdn.example.com')));
});

test('cancelling an unresolved DNS lookup does not open a socket or create a file', async t => {
  const run = await setup(t, null, { dependencies: { lookup: async () => new Promise(() => {}) } });
  const controller = new AbortController(), pending = run.importer.import('https://cdn.example.com/a.mp4', { signal: controller.signal });
  controller.abort(); await assert.rejects(pending, code('REFERENCE_URL_CANCELLED'));
  assert.equal(run.requests.length, 0); assert.deepEqual(await run.remaining(), []);
});

const metadata = overrides => ({ title: '公开视频', availability: 'public', formats: [{ url: 'https://media.example.com/clip.mp4', protocol: 'https', ext: 'mp4', vcodec: 'h264', acodec: 'none', height: 720 }], ...overrides });
const withAudio = (audio = {}) => metadata({ formats: [...metadata().formats, { url: 'https://media.example.com/sound.m4a', protocol: 'https', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', abr: 128, ...audio }] });
const dummyRuntime = { ffmpegPath: process.execPath, ffprobePath: process.execPath };

test('a supported muxed stream is preferred and never downloads a separate audio file', async t => {
  const run = await setup(t, null, { dependencies: { extractMetadata: async () => metadata({ formats: [...metadata().formats, { ...metadata().formats[0], url: 'https://media.example.com/with-audio.mp4', height: 480, acodec: 'mp4a.40.2' }] }) } });
  await run.importer.import('https://www.bilibili.com/zh-Hant/video/BV16MJY6yEKq');
  assert.equal(run.requests.length, 1); assert.equal(new URL(run.requests[0].url).pathname, '/with-audio.mp4'); assert.equal(run.imports.length, 1);
});

test('a separate audio URL retains public-address, credential and HTTPS redirect restrictions', async t => {
  for (const [url, expected] of [['https://127.0.0.1/sound.m4a', 'REFERENCE_URL_PRIVATE'], ['https://u:p@media.example.com/sound.m4a', 'REFERENCE_URL_INVALID'], ['http://media.example.com/sound.m4a', 'REFERENCE_URL_INVALID']]) {
    const run = await setup(t, null, { ...dummyRuntime, dependencies: { extractMetadata: async () => withAudio({ url }) } });
    await assert.rejects(run.importer.import('https://www.bilibili.com/video/BV16MJY6yEKq'), code(expected)); assert.equal(run.imports.length, 0); assert.deepEqual(await run.remaining(), []);
  }
  const redirect = await setup(t, (req, res) => { if (req.url === '/sound.m4a') { res.writeHead(302, { location: 'https://169.254.169.254/private.m4a' }); res.end(); } else { res.writeHead(200, { 'content-type': 'video/mp4' }); res.end(mp4); } }, { ...dummyRuntime, dependencies: { extractMetadata: async () => withAudio() } });
  await assert.rejects(redirect.importer.import('https://www.bilibili.com/video/BV16MJY6yEKq'), code('REFERENCE_URL_PRIVATE')); assert.equal(redirect.imports.length, 0); assert.deepEqual(await redirect.remaining(), []);
});

test('declared and streamed audio share the already-downloaded video byte budget', async t => {
  for (const declared of [true, false]) {
    const run = await setup(t, (_req, res) => { res.writeHead(200, { 'content-type': 'video/mp4', ...(declared ? { 'content-length': mp4.length } : {}) }); res.write(mp4.subarray(0, 100)); res.end(mp4.subarray(100)); }, { ...dummyRuntime, maxBytes: mp4.length * 2 - 1, dependencies: { extractMetadata: async () => withAudio() } });
    await assert.rejects(run.importer.import('https://www.bilibili.com/video/BV16MJY6yEKq'), code('REFERENCE_URL_TOO_LARGE')); assert.equal(run.imports.length, 0); assert.deepEqual(await run.remaining(), []);
  }
});

test('unavailable or incompatible audio never silently registers a video-only substitute', async t => {
  const failed = await setup(t, (req, res) => { if (req.url === '/sound.m4a') { res.writeHead(403); res.end(); } else { res.writeHead(200, { 'content-type': 'video/mp4' }); res.end(mp4); } }, { ...dummyRuntime, dependencies: { extractMetadata: async () => withAudio() } });
  await assert.rejects(failed.importer.import('https://www.bilibili.com/video/BV16MJY6yEKq'), code('REFERENCE_AUDIO_DOWNLOAD_FAILED')); assert.equal(failed.imports.length, 0); assert.deepEqual(await failed.remaining(), []);
  const opus = await setup(t, null, { ...dummyRuntime, dependencies: { extractMetadata: async () => withAudio({ acodec: 'opus', ext: 'webm' }) } });
  await assert.rejects(opus.importer.import('https://www.bilibili.com/video/BV16MJY6yEKq'), code('REFERENCE_AUDIO_FORMAT_UNSUPPORTED')); assert.equal(opus.requests.length, 0); assert.equal(opus.imports.length, 0);
});

test('audio transfer observes the same cancellation and whole-import timeout', async t => {
  for (const timeout of [false, true]) {
    let entered; const ready = new Promise(resolve => { entered = resolve; });
    const run = await setup(t, (req, res) => { res.writeHead(200, { 'content-type': 'video/mp4' }); if (req.url === '/sound.m4a') { res.write(mp4.subarray(0, 32)); entered(); } else res.end(mp4); }, { ...dummyRuntime, ...(timeout ? { timeoutMs: 60 } : {}), dependencies: { extractMetadata: async () => withAudio() } });
    const controller = new AbortController(), pending = run.importer.import('https://www.bilibili.com/video/BV16MJY6yEKq', { signal: controller.signal });
    await ready; if (!timeout) controller.abort(); await assert.rejects(pending, code(timeout ? 'REFERENCE_URL_TIMEOUT' : 'REFERENCE_URL_CANCELLED')); assert.equal(run.imports.length, 0); assert.deepEqual(await run.remaining(), []);
  }
});

test('ffmpeg failure waits for process close and cleans both unregistered tracks', async t => {
  const run = await setup(t, null, { ...dummyRuntime, dependencies: { extractMetadata: async () => withAudio() } });
  await assert.rejects(run.importer.import('https://www.bilibili.com/video/BV16MJY6yEKq'), code('REFERENCE_AUDIO_MUX_FAILED')); assert.equal(run.imports.length, 0); assert.deepEqual(await run.remaining(), []);
});

test('real local copy mux preserves AAC, registers once, removes source tracks and keeps true silent sources compatible', { timeout: 60000 }, async t => {
  const binary = name => process.env[`GUANGXUAN_${name.toUpperCase()}`] || (process.env.GUANGXUAN_BIN_DIR ? path.join(process.env.GUANGXUAN_BIN_DIR, name + (process.platform === 'win32' ? '.exe' : '')) : name);
  const ffmpegPath = binary('ffmpeg'), ffprobePath = binary('ffprobe');
  try { await execute(ffmpegPath, ['-version'], { windowsHide: true }); await execute(ffprobePath, ['-version'], { windowsHide: true }); } catch { t.skip('A configured media runtime is required.'); return; }
  let videoBytes, audioBytes, service, registrations = 0, currentMetadata = withAudio();
  const run = await setup(t, (req, res) => { const body = req.url === '/sound.m4a' ? audioBytes : videoBytes; res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': body.length }); res.end(body); }, { ffmpegPath, ffprobePath, importLocal: async (...args) => { registrations++; return service.importLocalFile(...args); }, dependencies: { extractMetadata: async () => currentMetadata } });
  t.after(() => service?.close());
  const fixtures = path.join(run.directory, 'fixtures'); await fs.mkdir(fixtures);
  const video = path.join(fixtures, 'silent.mp4'), audio = path.join(fixtures, 'sine.m4a');
  await Promise.all([
    execute(ffmpegPath, ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=15:d=1.2', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video], { windowsHide: true }),
    execute(ffmpegPath, ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1.2', '-c:a', 'aac', '-b:a', '96k', audio], { windowsHide: true }),
  ]);
  videoBytes = await fs.readFile(video); audioBytes = await fs.readFile(audio);
  service = await createVideoService({ dataDir: run.directory, root: path.resolve('.'), ffmpegPath, ffprobePath });
  const progress = [], result = await run.importer.import('https://www.bilibili.com/zh-Hant/video/BV16MJY6yEKq', { onProgress: value => progress.push(value) });
  assert.equal(result.asset.hasAudio, true); assert.equal(result.audio.status, 'preserved'); assert.equal(result.audio.method, 'copy-mux'); assert.equal(registrations, 1);
  const owned = await service.resolveAsset(result.asset.id); assert.deepEqual(await fs.readdir(path.dirname(owned.path)), ['media.mp4']);
  const probe = JSON.parse((await execute(ffprobePath, ['-v', 'error', '-show_streams', '-of', 'json', owned.path], { windowsHide: true })).stdout); assert.ok(probe.streams.some(stream => stream.codec_type === 'video' && stream.codec_name === 'h264')); assert.ok(probe.streams.some(stream => stream.codec_type === 'audio' && stream.codec_name === 'aac'));
  assert.equal(progress.at(-1).receivedBytes, videoBytes.length + audioBytes.length); assert.equal(progress.at(-1).totalBytes, videoBytes.length + audioBytes.length); assert.ok(progress.some(value => value.phase === 'muxing')); assert.ok(progress.filter(value => value.receivedBytes !== undefined).every((value, index, list) => !index || value.receivedBytes >= list[index - 1].receivedBytes));
  currentMetadata = metadata(); const silent = await run.importer.import('https://www.bilibili.com/video/BV16MJY6yEKq'); assert.equal(silent.asset.hasAudio, false); assert.equal(silent.audio.status, 'none'); assert.equal(registrations, 2);
  currentMetadata = withAudio(); const controller = new AbortController();
  await assert.rejects(run.importer.import('https://www.bilibili.com/video/BV16MJY6yEKq', { signal: controller.signal, onProgress: value => { if (value.phase === 'muxing') setTimeout(() => controller.abort(), 0); } }), code('REFERENCE_URL_CANCELLED')); assert.equal(registrations, 2);
  assert.equal((await run.remaining()).length, 2, 'Only the two completed imports remain; cancelled tracks are removed');
});
test('public platform metadata produces only one HTTPS video download without auth headers', async t => {
  let asked;
  const run = await setup(t, null, { dependencies: { extractMetadata: async target => { asked = target; return metadata({ http_headers: { Cookie: 'do-not-copy', Authorization: 'do-not-copy', 'User-Agent': 'ReferenceTest' } }); } } });
  const result = await run.importer.import('https://youtu.be/BaW_jenozKc?list=ignored&t=2');
  assert.deepEqual(asked, { platform: 'youtube', url: 'https://www.youtube.com/watch?v=BaW_jenozKc' });
  assert.equal(result.sourceUrl, asked.url); assert.equal(result.title, '公开视频'); assert.equal(run.requests.length, 1);
  assert.equal(run.requests[0].headers.Cookie, undefined); assert.equal(run.requests[0].headers.Authorization, undefined);
  assert.equal(run.requests[0].headers.Referer, asked.url);
});

test('Bilibili known locale video links canonicalize the same selected video and part', async t => {
  for (const [url, expected] of [
    ['https://www.bilibili.com/zh-Hant/video/BV16MJY6yEKq/?vd_source=tracking-fixture', 'https://www.bilibili.com/video/BV16MJY6yEKq?p=1'],
    ['https://m.bilibili.com/zh-Hans/video/BV16MJY6yEKq/?p=2&share_source=copy', 'https://www.bilibili.com/video/BV16MJY6yEKq?p=2'],
    ['https://www.bilibili.com/zh-Hant/video/av170001', 'https://www.bilibili.com/video/av170001?p=1'],
    ['https://www.bilibili.com/pt/video/BV1CMaf69EZu/?vd_source=0019a92b5765c2a04ee70311c2909d89', 'https://www.bilibili.com/video/BV1CMaf69EZu?p=1'],
    ['https://m.bilibili.com/pt/video/av170001/?p=2', 'https://www.bilibili.com/video/av170001?p=2'],
  ]) {
    let target;
    const run = await setup(t, null, { dependencies: { extractMetadata: async value => { target = value; return metadata(); } } });
    const result = await run.importer.import(url);
    assert.deepEqual(target, { platform: 'bilibili', url: expected }); assert.equal(result.sourceUrl, expected); assert.equal(run.imports.length, 1);
    assert.equal(run.requests[0].headers.Referer, expected); assert.ok(!JSON.stringify(run.requests).includes('tracking-fixture'));
  }
});

test('locale recognition does not accept arbitrary prefixes, playlists or extra path segments', async t => {
  const run = await setup(t);
  for (const url of ['https://www.bilibili.com/random/video/BV16MJY6yEKq', 'https://www.bilibili.com/zh-Hant/list/watchlater?bvid=BV16MJY6yEKq', 'https://www.bilibili.com/zh-Hans/bangumi/play/ep1', 'https://www.bilibili.com/zh-Hant/video/BV16MJY6yEKq/extra', 'https://www.bilibili.com/pt/bangumi/play/ep1', 'https://www.bilibili.com/pt/list/watchlater?bvid=BV1CMaf69EZu', 'https://www.bilibili.com/pt/video/BV1CMaf69EZu/extra']) await assert.rejects(run.importer.import(url), code('REFERENCE_PAGE_UNSUPPORTED'));
  assert.equal(run.requests.length, 0); assert.equal(run.imports.length, 0);
});

test('localized platform inputs still refuse private media DNS and do not claim blocked extraction succeeded', async t => {
  const localeUrl = 'https://www.bilibili.com/zh-Hant/video/BV16MJY6yEKq/';
  const privateRun = await setup(t, null, { dependencies: { lookup: async host => [{ address: host === 'media.example.com' ? '127.0.0.1' : publicIp, family: 4 }], extractMetadata: async () => metadata() } });
  await assert.rejects(privateRun.importer.import(localeUrl), code('REFERENCE_URL_PRIVATE')); assert.equal(privateRun.requests.length, 0); assert.equal(privateRun.imports.length, 0);
  const phases = [], blocked = await setup(t, null, { dependencies: { extractMetadata: async () => { throw new AppError(422, '公开读取受到平台校验。', 'REFERENCE_PAGE_UNAVAILABLE'); } } });
  await assert.rejects(blocked.importer.import(localeUrl, { onProgress: value => phases.push(value.phase) }), code('REFERENCE_PAGE_UNAVAILABLE'));
  assert.ok(phases.includes('metadata')); assert.ok(!phases.includes('complete')); assert.equal(blocked.imports.length, 0); assert.deepEqual(await blocked.remaining(), []);
});

test('a localized video import cancelled during metadata does not start the media download', async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { entered = resolve; });
  const run = await setup(t, null, { dependencies: { extractMetadata: async () => { entered(); await gate; return metadata(); } } });
  const controller = new AbortController(), pending = run.importer.import('https://www.bilibili.com/zh-Hans/video/BV16MJY6yEKq/', { signal: controller.signal });
  await ready; controller.abort(); release(); await assert.rejects(pending, code('REFERENCE_URL_CANCELLED')); assert.equal(run.requests.length, 0); assert.equal(run.imports.length, 0); assert.deepEqual(await run.remaining(), []);
});

test('platform output cannot inject a private, authenticated or HLS media URL', async t => {
  for (const [url, protocol, expected] of [
    ['https://127.0.0.1/a.mp4', 'https', 'REFERENCE_URL_PRIVATE'],
    ['https://u:p@media.example.com/a.mp4', 'https', 'REFERENCE_URL_INVALID'],
    ['https://media.example.com/a.m3u8', 'm3u8_native', 'REFERENCE_FORMAT_UNSUPPORTED'],
  ]) {
    const run = await setup(t, null, { dependencies: { extractMetadata: async () => metadata({ formats: [{ url, protocol, ext: 'mp4', vcodec: 'h264', height: 720 }] }) } });
    await assert.rejects(run.importer.import('https://www.bilibili.com/video/BV1xx411c7mD'), code(expected));
    assert.equal(run.requests.length, 0); assert.deepEqual(await run.remaining(), []);
  }
});

test('a platform media hostname is independently resolved and cannot point to private DNS', async t => {
  const run = await setup(t, null, { dependencies: {
    lookup: async host => [{ address: host === 'media.example.com' ? '169.254.169.254' : publicIp, family: 4 }],
    extractMetadata: async () => metadata(),
  } });
  await assert.rejects(run.importer.import('https://www.youtube.com/watch?v=BaW_jenozKc'), code('REFERENCE_URL_PRIVATE'));
  assert.equal(run.requests.length, 0); assert.deepEqual(await run.remaining(), []);
});

test('playlists, DRM, private and live results are rejected, without requesting a media file', async t => {
  for (const [info, expected] of [
    [metadata({ _type: 'playlist', entries: [] }), 'REFERENCE_PLAYLIST_UNSUPPORTED'],
    [metadata({ has_drm: true }), 'REFERENCE_PAGE_RESTRICTED'],
    [metadata({ availability: 'needs_auth' }), 'REFERENCE_PAGE_RESTRICTED'],
    [metadata({ live_status: 'is_live' }), 'REFERENCE_PAGE_RESTRICTED'],
  ]) {
    const run = await setup(t, null, { dependencies: { extractMetadata: async () => info } });
    await assert.rejects(run.importer.import('https://www.youtube.com/watch?v=BaW_jenozKc'), code(expected)); assert.equal(run.requests.length, 0);
  }
});

test('Bilibili short links are resolved through the same safe redirect policy and select one part', async t => {
  let target;
  const run = await setup(t, (req, res) => {
    if (req.url === '/abc') { res.writeHead(302, { location: 'https://www.bilibili.com/video/BV1xx411c7mD?p=2&share_source=copy' }); res.end(); }
    else if (req.url.startsWith('/video/')) { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html></html>'); }
    else { res.writeHead(200, { 'content-type': 'video/mp4' }); res.end(mp4); }
  }, { dependencies: { extractMetadata: async value => { target = value; return metadata(); } } });
  const result = await run.importer.import('https://b23.tv/abc');
  assert.equal(target.url, 'https://www.bilibili.com/video/BV1xx411c7mD?p=2'); assert.equal(result.sourceUrl, target.url); assert.equal(run.imports.length, 1);
});

test('media registration failure cleans the unregistered controlled file', async t => {
  const run = await setup(t, null, { importLocal: async () => { throw new AppError(415, '没有视频流。', 'MEDIA_TYPE_MISMATCH'); } });
  await assert.rejects(run.importer.import('https://cdn.example.com/a.mp4'), code('MEDIA_TYPE_MISMATCH')); assert.deepEqual(await run.remaining(), []);
});

test('extractor arguments disable user settings, cookies, plugins, scripts and playlist downloads', () => {
  const args = referenceDownloaderArgs('https://www.youtube.com/watch?v=BaW_jenozKc', 'http://local-proxy', 'youtube');
  for (const flag of ['--ignore-config', '--no-config-locations', '--no-plugin-dirs', '--no-cookies', '--no-cookies-from-browser', '--no-cache-dir', '--no-exec', '--no-remote-components', '--no-js-runtimes', '--no-playlist', '--skip-download', '--simulate', '--no-check-formats']) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf('--proxy') + 1], 'http://local-proxy');
  assert.equal(args[args.indexOf('--xff') + 1], 'never');
  assert.equal(args[args.indexOf('--use-extractors') + 1], 'youtube');
  assert.equal(args.at(-2), '--');
});

async function proxyRequest(proxy, host) {
  const url = new URL(proxy.url), authorization = Buffer.from(url.username + ':' + url.password).toString('base64');
  const socket = net.connect({ host: url.hostname, port: Number(url.port) });
  let result = '';
  return new Promise((resolve, reject) => {
    socket.once('connect', () => socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\nProxy-Authorization: Basic ${authorization}\r\n\r\n`));
    socket.on('data', chunk => { result += chunk; if (result.includes('403') || result.includes('pong')) { socket.destroy(); resolve(result); } });
    socket.once('error', reject); socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('Proxy test timeout')); });
  });
}
test('metadata proxy denies private DNS results and off-platform destinations before opening sockets', async t => {
  let connects = 0;
  const privateProxy = await createReferenceMetadataProxy({ platform: 'bilibili', lookup: async () => [{ address: '127.0.0.1', family: 4 }], connect: () => { connects++; throw new Error('Must not connect'); } });
  t.after(() => privateProxy.close());
  assert.match(await proxyRequest(privateProxy, 'api.bilibili.com'), /403/); assert.equal(connects, 0);
  const offsite = await createReferenceMetadataProxy({ platform: 'youtube', lookup: lookupPublic, connect: () => { connects++; throw new Error('Must not connect'); } });
  t.after(() => offsite.close()); assert.match(await proxyRequest(offsite, 'other.example.com'), /403/); assert.equal(connects, 0);
});

test('metadata proxy pins the checked public address while its fixture transport remains local', async t => {
  const upstream = net.createServer(socket => { socket.write('pong'); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  let connected;
  const proxy = await createReferenceMetadataProxy({ platform: 'youtube', lookup: lookupPublic, connect: options => { connected = options; return net.connect({ host: '127.0.0.1', port: upstream.address().port }); } });
  t.after(async () => { await proxy.close(); await new Promise(resolve => upstream.close(resolve)); });
  assert.match(await proxyRequest(proxy, 'www.youtube.com'), /200 Connection Established[\s\S]*pong/);
  assert.deepEqual(connected, { host: publicIp, port: 443, family: 4 });
});
