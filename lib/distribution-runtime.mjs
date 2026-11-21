import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, rename, rm, writeFile, open } from 'node:fs/promises';
import { inflateRawSync, gunzipSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';

const MAX_DOWNLOAD = 256 * 1024 * 1024;
const MAX_BINARY = 128 * 1024 * 1024;
const active = new Map();
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const invalid = message => Object.assign(new Error(message), { code: 'DISTRIBUTION_RUNTIME_INVALID' });
const within = (root, file) => { const relative = path.relative(root, file); return relative === '' || !relative.startsWith('..') && !path.isAbsolute(relative); };

async function noLinks(root, file) {
  if (!within(root, file)) throw invalid('视频工具目录无效。');
  let current = root;
  for (const part of ['', ...path.relative(root, file).split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw invalid('视频工具目录不能使用符号链接。'); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
  }
}

async function hashFile(file) {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex');
}

function validateManifest(manifest) {
  if (manifest?.schemaVersion !== 1 || manifest.platform !== 'win32-x64' || !Array.isArray(manifest.ffmpeg?.files) || manifest.ffmpeg.files.length !== 2 || manifest.ytdlp?.filename !== 'yt-dlp.exe') throw invalid('视频工具版本清单无效。');
  if (!/^https:\/\/www\.gyan\.dev\/ffmpeg\/builds\/packages\/ffmpeg-[0-9.]+-essentials_build\.zip$/.test(manifest.ffmpeg.url) ||
      !/^https:\/\/github\.com\/yt-dlp\/yt-dlp\/releases\/download\/[0-9.]+\/yt-dlp\.exe$/.test(manifest.ytdlp.url) ||
      !/^[a-zA-Z0-9_.-]+$/.test(manifest.ffmpeg.directory)) throw invalid('视频工具下载地址无效。');
  if (manifest.ffmpeg.mirrors !== undefined && (!Array.isArray(manifest.ffmpeg.mirrors) || manifest.ffmpeg.mirrors.length > 1 || manifest.ffmpeg.mirrors.some(url => url !== `https://github.com/GyanD/codexffmpeg/releases/download/${manifest.ffmpeg.version}/ffmpeg-${manifest.ffmpeg.version}-essentials_build.zip`))) throw invalid('FFmpeg 镜像必须使用同版本官方发行。');
  const files = [...manifest.ffmpeg.files, manifest.ytdlp];
  if (files.map(file => file.filename).sort().join(',') !== 'ffmpeg.exe,ffprobe.exe,yt-dlp.exe') throw invalid('视频工具文件清单无效。');
  for (const record of [manifest.ffmpeg, ...files]) if (!/^[a-f0-9]{64}$/.test(record.sha256)) throw invalid('视频工具校验记录无效。');
  for (const file of files) if (!Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > MAX_BINARY) throw invalid('视频工具大小记录无效。');
  const compositor = manifest.compositor;
  if (!compositor || !/^https:\/\/registry\.npmjs\.org\/@remotion\/compositor-win32-x64-msvc\/-\/compositor-win32-x64-msvc-[0-9.]+\.tgz$/.test(compositor.url) ||
      !/^[a-f0-9]{64}$/.test(compositor.sha256) || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(compositor.npmIntegrity) || !Number.isSafeInteger(compositor.bytes) || compositor.bytes > MAX_DOWNLOAD ||
      !Array.isArray(compositor.files) || !compositor.files.length || compositor.files.length > 1000) throw invalid('动画运行组件版本清单无效。');
  const names = new Set();
  for (const file of compositor.files) {
    if (typeof file.filename !== 'string' || !file.filename || file.filename !== path.posix.normalize(file.filename) || file.filename.startsWith('/') || /[:\\\x00-\x1f]/.test(file.filename) || file.filename.split('/').some(part => part === '..' || part === '.') || names.has(file.filename) ||
        !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > MAX_BINARY) throw invalid('动画运行组件文件清单无效。');
    names.add(file.filename);
  }
  return [...files.map(file => ({ ...file, directory: 'bin' })), ...compositor.files.map(file => ({ ...file, directory: 'compositor' }))];
}

export function readDistributionTar(bytes) {
  let tar; try { tar = gunzipSync(bytes, { maxOutputLength: MAX_BINARY }); } catch { throw invalid('动画运行组件解压失败。'); }
  const files = new Map();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512); if (header.every(value => value === 0)) break;
    const field = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/, '').trim();
    const name = field(0, 100), prefix = field(345, 155), filename = prefix ? prefix + '/' + name : name;
    const sizeText = field(124, 12), checksumText = field(148, 8), type = header[156];
    if (!/^[0-7]+$/.test(sizeText) || !/^[0-7]+$/.test(checksumText)) throw invalid('动画运行组件压缩包目录无效。');
    const size = Number.parseInt(sizeText, 8), checksum = Number.parseInt(checksumText, 8);
    let actualChecksum = 0; for (let index = 0; index < 512; index++) actualChecksum += index >= 148 && index < 156 ? 32 : header[index];
    if (checksum !== actualChecksum || size > MAX_BINARY || offset + 512 + size > tar.length) throw invalid('动画运行组件压缩包损坏。');
    if (type === 0 || type === 48) {
      if (!filename.startsWith('package/')) throw invalid('动画运行组件文件路径无效。');
      const relative = filename.slice(8);
      if (!relative || relative !== path.posix.normalize(relative) || relative.startsWith('/') || /[:\\\x00-\x1f]/.test(relative) || relative.split('/').some(part => part === '..' || part === '.') || files.has(relative)) throw invalid('动画运行组件文件路径无效。');
      files.set(relative, tar.subarray(offset + 512, offset + 512 + size));
    } else if (type !== 53) throw invalid('动画运行组件压缩包不能包含文件链接。');
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!files.size) throw invalid('动画运行组件压缩包为空。'); return files;
}

function zipEntry(bytes, name, expectedBytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 22 || bytes.length > MAX_DOWNLOAD) throw invalid('FFmpeg 下载文件不是有效压缩包。');
  let end = -1;
  for (let cursor = bytes.length - 22; cursor >= Math.max(0, bytes.length - 65557); cursor--) if (bytes.readUInt32LE(cursor) === 0x06054b50 && cursor + 22 + bytes.readUInt16LE(cursor + 20) === bytes.length) { end = cursor; break; }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw invalid('FFmpeg 压缩包格式不受支持。');
  const count = bytes.readUInt16LE(end + 10), centralSize = bytes.readUInt32LE(end + 12); let cursor = bytes.readUInt32LE(end + 16), found;
  if (!count || count > 5000 || cursor + centralSize > end) throw invalid('FFmpeg 压缩包目录无效。');
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) throw invalid('FFmpeg 压缩包目录损坏。');
    const flags = bytes.readUInt16LE(cursor + 8), compression = bytes.readUInt16LE(cursor + 10), compressed = bytes.readUInt32LE(cursor + 20), original = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28), extraLength = bytes.readUInt16LE(cursor + 30), commentLength = bytes.readUInt16LE(cursor + 32), local = bytes.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > end) throw invalid('FFmpeg 压缩包目录损坏。');
    const entryName = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8'); cursor = next;
    if (entryName !== name) continue;
    if (found || flags & 1 || original !== expectedBytes || original > MAX_BINARY || compressed > MAX_DOWNLOAD || local + 30 > end || bytes.readUInt32LE(local) !== 0x04034b50) throw invalid('FFmpeg 压缩包工具文件无效。');
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    if (start + compressed > end) throw invalid('FFmpeg 压缩包工具文件截断。');
    const body = bytes.subarray(start, start + compressed);
    try { found = compression === 0 ? Buffer.from(body) : compression === 8 ? inflateRawSync(body, { maxOutputLength: MAX_BINARY }) : null; } catch { throw invalid('FFmpeg 压缩包解压失败。'); }
    if (!found || found.length !== expectedBytes) throw invalid('FFmpeg 压缩包解压失败。');
  }
  if (!found) throw invalid('FFmpeg 压缩包缺少所需工具。'); return found;
}

function idleGuard(operation, controller, milliseconds) {
  let timer;
  const idle = new Promise((_resolve, reject) => { timer = setTimeout(() => { const error = Object.assign(new Error('视频工具下载等待数据超时，将尝试官方备用来源。'), { code: 'DISTRIBUTION_DOWNLOAD_IDLE' }); reject(error); controller.abort(error); }, milliseconds); });
  return Promise.race([operation, idle]).finally(() => clearTimeout(timer));
}

async function download(record, destination, fetchImpl, onProgress, { idleTimeoutMs = 30000 } = {}) {
  const urls = [record.url, ...(record.mirrors || [])];
  for (let attempt = 0; attempt < 3; attempt++) {
    let handle, reader; const controller = new AbortController();
    try {
      onProgress({ label: record.filename || 'FFmpeg', received: 0, total: 0, attempt: attempt + 1 });
      const url = urls[Math.min(attempt, urls.length - 1)];
      const response = await idleGuard(fetchImpl(url, { credentials: 'omit', redirect: 'follow', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15 * 60 * 1000)]), cache: 'no-store' }), controller, idleTimeoutMs);
      if (!response.ok || !response.body) throw new Error('视频工具下载失败，请检查网络连接。');
      const finalUrl = new URL(response.url || url);
      if (finalUrl.protocol !== 'https:' || !['www.gyan.dev', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'registry.npmjs.org'].includes(finalUrl.hostname)) throw invalid('视频工具下载来源无效。');
      const total = Number(response.headers.get('content-length')) || 0;
      if (total > MAX_DOWNLOAD || record.bytes && total && total !== record.bytes) throw invalid('视频工具下载大小不符。');
      handle = await open(destination, 'wx'); const hash = createHash('sha256'), integrityHash = record.npmIntegrity && createHash('sha512'); let received = 0;
      reader = response.body.getReader();
      while (true) {
        const { done, value: part } = await idleGuard(reader.read(), controller, idleTimeoutMs);
        if (done) break;
        const chunk = Buffer.from(part); received += chunk.length;
        if (received > (record.bytes || MAX_DOWNLOAD)) throw invalid('视频工具下载超过大小限制。');
        hash.update(chunk);
        integrityHash?.update(chunk);
        for (let offset = 0; offset < chunk.length;) { const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset); if (!bytesWritten) throw new Error('视频工具写入失败。'); offset += bytesWritten; }
        onProgress({ label: record.filename || 'FFmpeg', received, total, attempt: attempt + 1 });
      }
      await handle.close(); handle = null;
      if (record.bytes && received !== record.bytes || hash.digest('hex') !== record.sha256) throw invalid('视频工具校验失败，请重新下载。');
      if (integrityHash && 'sha512-' + integrityHash.digest('base64') !== record.npmIntegrity) throw invalid('动画运行组件完整性校验失败。');
      return;
    } catch (error) {
      await handle?.close().catch(() => {}); await rm(destination, { force: true }).catch(() => {});
      if (attempt === 2 || error.code === 'DISTRIBUTION_RUNTIME_INVALID') throw error;
      await delay((attempt + 1) * 1000);
    } finally {
      controller.abort();
      void reader?.cancel().catch(() => {});
    }
  }
}

/** First-run files come directly from their fixed official releases; no user secrets enter requests. */
export async function ensureDistributionRuntime({ root, dataDir, fetchImpl = fetch, onProgress = () => {}, platform = process.platform, idleTimeoutMs = 30000 } = {}) {
  if (platform !== 'win32') return null;
  if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 1 || idleTimeoutMs > 60000) throw invalid('视频工具下载等待时间无效。');
  const appRoot = path.resolve(root), dataRoot = path.resolve(dataDir);
  const manifestBytes = await readFile(path.join(appRoot, 'scripts', 'distribution-runtime-manifest.json'));
  let manifest; try { manifest = JSON.parse(manifestBytes); } catch { throw invalid('视频工具版本清单无效。'); }
  const files = validateManifest(manifest), toolsRoot = path.join(dataRoot, 'tools');
  await noLinks(dataRoot, toolsRoot); await mkdir(toolsRoot, { recursive: true });
  const runtime = path.join(toolsRoot, 'runtime-' + sha(manifestBytes).slice(0, 16));
  if (active.has(runtime)) return active.get(runtime);
  const operation = (async () => {
    await noLinks(dataRoot, runtime);
    let complete = true;
    for (const file of files) {
      const target = path.join(runtime, file.directory, file.filename);
      try { await noLinks(dataRoot, target); const info = await lstat(target); if (!info.isFile() || info.size !== file.bytes || await hashFile(target) !== file.sha256) complete = false; }
      catch (error) { if (error.code === 'ENOENT') complete = false; else throw error; }
    }
    if (complete) { onProgress({ complete: true, cached: true }); return path.join(runtime, 'bin'); }
    const staging = path.join(toolsRoot, '.download-' + randomUUID()); await mkdir(staging); await mkdir(path.join(staging, 'bin')); await mkdir(path.join(staging, 'compositor'));
    try {
      const archive = path.join(staging, 'ffmpeg-distribution.zip');
      await download(manifest.ffmpeg, archive, fetchImpl, onProgress, { idleTimeoutMs });
      const bytes = await readFile(archive);
      for (const file of manifest.ffmpeg.files) {
        const binary = zipEntry(bytes, manifest.ffmpeg.directory + '/bin/' + file.filename, file.bytes);
        if (sha(binary) !== file.sha256) throw invalid('FFmpeg 工具校验失败。');
        await writeFile(path.join(staging, 'bin', file.filename), binary, { flag: 'wx' });
      }
      await download(manifest.ytdlp, path.join(staging, 'bin', 'yt-dlp.exe'), fetchImpl, onProgress, { idleTimeoutMs });
      const compositorArchive = path.join(staging, 'compositor-distribution.tgz');
      await download({ ...manifest.compositor, filename: 'Remotion' }, compositorArchive, fetchImpl, onProgress, { idleTimeoutMs });
      const compositorFiles = readDistributionTar(await readFile(compositorArchive));
      if (compositorFiles.size !== manifest.compositor.files.length) throw invalid('动画运行组件文件数量不符。');
      for (const file of manifest.compositor.files) {
        const binary = compositorFiles.get(file.filename);
        if (!binary || binary.length !== file.bytes || sha(binary) !== file.sha256) throw invalid('动画运行组件文件校验失败。');
        const target = path.join(staging, 'compositor', file.filename); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, binary, { flag: 'wx' });
      }
      await writeFile(path.join(staging, 'runtime.json'), JSON.stringify({ schemaVersion: 1, downloadedAt: new Date().toISOString(), manifest, verified: true }, null, 2), { flag: 'wx' });
      await noLinks(dataRoot, runtime);
      // A damaged cache is retained for review; only this fresh staging directory is removed on failure.
      try { await lstat(runtime); await rename(runtime, path.join(toolsRoot, 'invalid-' + randomUUID())); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await rename(staging, runtime); onProgress({ complete: true, cached: false }); return path.join(runtime, 'bin');
    } finally { if (within(toolsRoot, staging)) { await noLinks(dataRoot, staging); await rm(staging, { recursive: true, force: true }); } }
  })();
  active.set(runtime, operation);
  try { return await operation; } finally { if (active.get(runtime) === operation) active.delete(runtime); }
}
