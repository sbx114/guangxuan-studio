import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdir, mkdtemp, readFile, writeFile, rm, readdir, symlink } from 'node:fs/promises';
import { ensureDistributionRuntime } from '../lib/distribution-runtime.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function storedZip(files) {
  const local = [], central = []; let offset = 0;
  for (const [filename, body] of files) {
    const name = Buffer.from(filename), header = Buffer.alloc(30), index = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt32LE(body.length, 18); header.writeUInt32LE(body.length, 22); header.writeUInt16LE(name.length, 26);
    index.writeUInt32LE(0x02014b50); index.writeUInt16LE(20, 4); index.writeUInt16LE(20, 6); index.writeUInt32LE(body.length, 20); index.writeUInt32LE(body.length, 24); index.writeUInt16LE(name.length, 28); index.writeUInt32LE(offset, 42);
    local.push(header, name, body); central.push(index, name); offset += header.length + name.length + body.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
function tarFile(filename, bytes) {
  const header = Buffer.alloc(512); header.write('package/' + filename); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116); header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124); header.write('00000000000\0', 136); header.fill(32, 148, 156); header[156] = 48; header.write('ustar\0', 257); header.write('00', 263);
  const checksum = header.reduce((sum, value) => sum + value, 0); header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
  return gzipSync(Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512), Buffer.alloc(1024)]));
}
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gx-distribution-runtime-test-'));
  t.after(async () => { if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('gx-distribution-runtime-test-')) throw new Error('Unsafe test cleanup path'); await rm(directory, { recursive: true, force: true }); });
  const root = path.join(directory, 'app'), dataDir = path.join(directory, 'data'); await mkdir(path.join(root, 'scripts'), { recursive: true }); await mkdir(dataDir);
  const binaries = { 'ffmpeg.exe': Buffer.from('MZ synthetic ffmpeg'), 'ffprobe.exe': Buffer.from('MZ synthetic ffprobe'), 'yt-dlp.exe': Buffer.from('MZ synthetic yt-dlp') };
  const archive = storedZip(['ffmpeg.exe', 'ffprobe.exe'].map(name => ['ffmpeg-1.2.3-essentials_build/bin/' + name, binaries[name]]));
  const manifest = { schemaVersion: 1, platform: 'win32-x64', ffmpeg: { version: '1.2.3', url: 'https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-1.2.3-essentials_build.zip', sha256: digest(archive), directory: 'ffmpeg-1.2.3-essentials_build', files: ['ffmpeg.exe', 'ffprobe.exe'].map(filename => ({ filename, bytes: binaries[filename].length, sha256: digest(binaries[filename]) })) }, ytdlp: { version: '1.2.3', filename: 'yt-dlp.exe', url: 'https://github.com/yt-dlp/yt-dlp/releases/download/1.2.3/yt-dlp.exe', bytes: binaries['yt-dlp.exe'].length, sha256: digest(binaries['yt-dlp.exe']) } };
  const compositorBinary = Buffer.from('MZ synthetic compositor'), compositorArchive = tarFile('remotion.exe', compositorBinary);
  manifest.compositor = { version: '1.2.3', url: 'https://registry.npmjs.org/@remotion/compositor-win32-x64-msvc/-/compositor-win32-x64-msvc-1.2.3.tgz', bytes: compositorArchive.length, sha256: digest(compositorArchive), npmIntegrity: 'sha512-' + createHash('sha512').update(compositorArchive).digest('base64'), files: [{ filename: 'remotion.exe', bytes: compositorBinary.length, sha256: digest(compositorBinary) }] };
  await writeFile(path.join(root, 'scripts', 'distribution-runtime-manifest.json'), JSON.stringify(manifest));
  await writeFile(path.join(dataDir, 'original-project.txt'), 'original');
  const requests = [];
  const fetchImpl = async (url, options) => { requests.push({ url, credentials: options.credentials }); return new Response(url.endsWith('.zip') ? archive : url.endsWith('.tgz') ? compositorArchive : binaries['yt-dlp.exe']); };
  return { root, dataDir, binaries, archive, manifest, fetchImpl, requests };
}

test('official-tool bootstrap verifies files, shares concurrent work, and reuses cache without network', async t => {
  const state = await fixture(t); const options = { root: state.root, dataDir: state.dataDir, fetchImpl: state.fetchImpl, platform: 'win32' };
  const [first, second] = await Promise.all([ensureDistributionRuntime(options), ensureDistributionRuntime(options)]);
  assert.equal(first, second); assert.equal(state.requests.length, 3); assert.ok(state.requests.every(request => request.credentials === 'omit'));
  for (const [name, expected] of Object.entries(state.binaries)) assert.deepEqual(await readFile(path.join(first, name)), expected);
  assert.equal(await ensureDistributionRuntime({ ...options, fetchImpl: () => { throw new Error('Cached start must not fetch'); } }), first);
  assert.equal(await readFile(path.join(state.dataDir, 'original-project.txt'), 'utf8'), 'original');
});

test('a checksum mismatch never publishes executable files or alters existing project data', async t => {
  const state = await fixture(t);
  await assert.rejects(ensureDistributionRuntime({ root: state.root, dataDir: state.dataDir, platform: 'win32', fetchImpl: async () => new Response(Buffer.from('corrupt archive')) }), /校验失败/);
  assert.deepEqual(await readdir(path.join(state.dataDir, 'tools')), []);
  assert.equal(await readFile(path.join(state.dataDir, 'original-project.txt'), 'utf8'), 'original');
});

test('a linked tools directory is rejected before any download or write through it', async t => {
  const state = await fixture(t); const other = path.join(state.root, 'unrelated'); await mkdir(other);
  await symlink(other, path.join(state.dataDir, 'tools'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(ensureDistributionRuntime({ root: state.root, dataDir: state.dataDir, platform: 'win32', fetchImpl: state.fetchImpl }), /符号链接/);
  assert.equal(state.requests.length, 0); assert.deepEqual(await readdir(other), []);
});
