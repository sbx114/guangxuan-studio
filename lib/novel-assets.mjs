import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { AppError } from './errors.mjs';
import { validateProjectId } from './store.mjs';
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const MAX_IMAGE = 12 * 1024 * 1024;
const TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const failure = (status, message, code) => new AppError(status, message, code);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function detectedType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length > 12 && bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP') return 'image/webp';
  throw failure(415, '自定义场景和立绘支持PNG、JPEG或WebP图片。', 'NOVEL_ASSET_TYPE');
}
function same(a, b) { return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b; }
function json(res, status, value) { if (res.destroyed || res.writableEnded) return; res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); }
function readUpload(req, signal) {
  return new Promise((resolve, reject) => {
    let size = 0, settled = false, cancelling = false; const chunks = [];
    const cleanup = () => { req.removeListener('data', data); req.removeListener('end', ended); if (cancelling && !req.closed) req.once('close', () => req.removeListener('error', errored)); else req.removeListener('error', errored); req.removeListener('aborted', aborted); signal?.removeEventListener('abort', aborted); };
    const finish = (error, value) => { if (settled) return; settled = true; cleanup(); error ? reject(error) : resolve(value); };
    const aborted = () => { cancelling = true; finish(failure(499, '图片导入已取消。', 'REQUEST_CANCELLED')); req.destroy(); };
    const errored = () => finish(failure(400, '图片上传未完成，请重试。', 'NOVEL_ASSET_UPLOAD_FAILED'));
    const data = chunk => { size += chunk.length; if (size > MAX_IMAGE) { finish(failure(413, '每张图片需在12MB以内。', 'NOVEL_ASSET_SIZE')); req.resume(); return; } chunks.push(chunk); };
    const ended = () => finish(null, Buffer.concat(chunks));
    req.on('data', data); req.once('end', ended); req.once('error', errored); req.once('aborted', aborted);
    signal?.addEventListener('abort', aborted, { once: true }); if (signal?.aborted) aborted();
  });
}
export async function createNovelAssetService({ dataDir, store, videoService } = {}) {
  if (!dataDir || !store) throw failure(500, '视觉小说素材服务未配置。', 'NOVEL_ASSET_NOT_CONFIGURED');
  const directory = path.resolve(dataDir, 'novel-assets'); await mkdir(directory, { recursive: true });
  const dataRoot = await realpath(dataDir), actualRoot = await realpath(directory);
  if ((await lstat(directory)).isSymbolicLink() || !same(actualRoot, path.join(dataRoot, 'novel-assets'))) throw failure(403, '素材目录不在应用管理范围。', 'NOVEL_ASSET_STORAGE');
  let closed = false;
  const controllers = new Set(), operations = new Set(), queues = new Map();
  async function scope(projectId, create = false) {
    validateProjectId(projectId);
    const owner = await store.read(projectId);
    if (!owner || owner.kind !== 'science') throw failure(404, '科普项目不存在。', 'PROJECT_NOT_FOUND');
    const value = path.join(directory, projectId);
    if (create) await mkdir(value, { recursive: true });
    try { if ((await lstat(value)).isSymbolicLink() || !same(await realpath(value), path.join(actualRoot, projectId))) throw failure(403, '素材目录无效。', 'NOVEL_ASSET_STORAGE'); }
    catch (error) { if (error.code === 'ENOENT' && !create) return null; throw error; }
    return value;
  }
  async function assetDirectory(projectId, assetId) {
    if (!UUID.test(assetId || '')) throw failure(404, '图片不存在。', 'NOVEL_ASSET_NOT_FOUND');
    const projectRoot = await scope(projectId), value = projectRoot && path.join(projectRoot, assetId);
    if (!value) throw failure(404, '图片不存在。', 'NOVEL_ASSET_NOT_FOUND');
    try { if ((await lstat(value)).isSymbolicLink() || !same(await realpath(value), path.join(await realpath(projectRoot), assetId))) throw failure(403, '图片目录无效。', 'NOVEL_ASSET_STORAGE'); }
    catch (error) { if (error.code === 'ENOENT') throw failure(404, '图片不存在。', 'NOVEL_ASSET_NOT_FOUND'); throw error; }
    return value;
  }
  async function metadata(projectId, assetId) {
    const location = await assetDirectory(projectId, assetId), filename = path.join(location, 'metadata.json');
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 5000) throw failure(422, '图片记录无法读取，请重新导入。', 'NOVEL_ASSET_INVALID');
    const value = JSON.parse(await readFile(filename, 'utf8'));
    const owner = await store.read(projectId);
    if (!owner || owner.kind !== 'science' || value.projectId !== projectId || value.ownerCreatedAt !== owner.createdAt) throw failure(404, '图片不属于当前项目，请重新导入。', 'NOVEL_ASSET_OWNER_MISMATCH');
    if (value.id !== assetId || !['background','portrait'].includes(value.kind) || !TYPES[value.mimeType] || !Number.isInteger(value.bytes) || value.bytes <= 0 || value.bytes > MAX_IMAGE || !Number.isInteger(value.width) || !Number.isInteger(value.height) || value.width <= 0 || value.height <= 0 || value.width * value.height > 40000000 || !/^[a-f0-9]{64}$/.test(value.sha256 || '') || typeof value.name !== 'string' || value.name.length > 160) throw failure(422, '图片记录无效，请重新导入。', 'NOVEL_ASSET_INVALID');
    return { location, ownerCreatedAt: value.ownerCreatedAt, value: { id: value.id, kind: value.kind, name: value.name, mimeType: value.mimeType, width: value.width, height: value.height, bytes: value.bytes, sha256: value.sha256, createdAt: value.createdAt } };
  }
  async function list(projectId) {
    const location = await scope(projectId);
    if (!location) return { items: [] };
    const items = [];
    for (const entry of (await readdir(location, { withFileTypes: true })).filter(entry => entry.isDirectory() && UUID.test(entry.name)).slice(0, 100)) {
      try { items.push((await metadata(projectId, entry.name)).value); }
      catch (error) { if (!['ENOENT','NOVEL_ASSET_OWNER_MISMATCH'].includes(error.code)) throw error; }
    }
    return { items: items.sort((a,b) => String(a.createdAt).localeCompare(String(b.createdAt))) };
  }
  function probe(filename, signal) {
    const executable = videoService?.runtimeTools?.().ffprobe;
    if (!executable) throw failure(503, '本机图片校验运行时不可用，请检查应用安装。', 'NOVEL_ASSET_RUNTIME');
    return new Promise((resolve, reject) => {
      const child = spawn(executable, ['-v','error','-select_streams','v:0','-show_entries','stream=codec_name,width,height','-of','json', filename], { windowsHide: true, stdio: ['ignore','pipe','pipe'] });
      let output = '', size = 0, finished = false;
      const timer = setTimeout(() => child.kill(), 10000);
      const aborted = () => child.kill();
      signal?.addEventListener('abort', aborted, { once: true });
      const finish = (error, value) => { if (finished) return; finished = true; clearTimeout(timer); signal?.removeEventListener('abort', aborted); error ? reject(error) : resolve(value); };
      child.stdout.on('data', chunk => { size += chunk.length; if (size > 65536) child.kill(); else output += chunk; }); child.stderr.on('data', () => {});
      child.once('error', () => finish(failure(503, '图片校验未能启动，请检查应用安装。', 'NOVEL_ASSET_RUNTIME')));
      child.once('exit', code => {
        if (signal?.aborted) return finish(failure(499, '图片导入已取消。', 'REQUEST_CANCELLED'));
        if (code !== 0) return finish(failure(422, '图片无法解码，请另存为常见PNG、JPEG或WebP后重试。', 'NOVEL_ASSET_DECODE'));
        try { const stream = JSON.parse(output).streams?.[0]; if (!stream || !['png','mjpeg','webp'].includes(stream.codec_name) || !Number.isInteger(stream.width) || !Number.isInteger(stream.height) || stream.width <= 0 || stream.height <= 0 || stream.width > 16000 || stream.height > 16000 || stream.width * stream.height > 40000000) throw new Error(); finish(null, { width: stream.width, height: stream.height }); }
        catch { finish(failure(422, '图片尺寸或格式不受支持，最长边需不超过16000像素，像素总数不超过4000万。', 'NOVEL_ASSET_DIMENSIONS')); }
      });
    });
  }
  async function importBytes(projectId, bytes, { name = '自定义图片', kind = 'background', signal, expectedOwnerCreatedAt } = {}) {
    if (closed) throw failure(503, '素材服务已关闭。', 'NOVEL_ASSET_CLOSED');
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_IMAGE) throw failure(413, '每张图片需在12MB以内。', 'NOVEL_ASSET_SIZE');
    if (!['background','portrait'].includes(kind)) throw failure(400, '请选择场景背景或人物立绘。', 'NOVEL_ASSET_KIND');
    if (typeof name !== 'string' || !name.trim() || name.length > 160 || /[\\/\x00-\x1f]/.test(name)) throw failure(400, '图片名称无效。', 'NOVEL_ASSET_NAME');
    const before = await store.read(validateProjectId(projectId));
    if (!before || before.kind !== 'science') throw failure(404, '科普项目不存在。', 'PROJECT_NOT_FOUND');
    if (expectedOwnerCreatedAt !== undefined && before.createdAt !== expectedOwnerCreatedAt) throw failure(409, '导入期间项目已移除或重建，图片未登记到新项目。', 'NOVEL_ASSET_OWNER_CHANGED');
    const assertOwner = async () => { const current = await store.read(projectId); if (!current || current.kind !== 'science' || current.createdAt !== before.createdAt) throw failure(409, '导入期间项目已移除或重建，图片未登记到新项目。', 'NOVEL_ASSET_OWNER_CHANGED'); };
    const controller = new AbortController(); controllers.add(controller);
    signal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const previous = queues.get(projectId) || Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
      signal.throwIfAborted();
      await assertOwner();
      const existing = await list(projectId);
      if (existing.items.length >= 64 || existing.items.reduce((sum,item) => sum + item.bytes, bytes.length) > 100 * 1024 * 1024) throw failure(413, '每个项目最多64张自定义图片，总计100MB。请先移除未使用素材。', 'NOVEL_ASSET_LIMIT');
      const mimeType = detectedType(bytes), id = randomUUID(), root = await scope(projectId, true), location = path.join(root, id);
      await mkdir(location);
      try {
        const filename = path.join(location, 'image.' + TYPES[mimeType]);
        await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); signal.throwIfAborted();
        await assertOwner();
        const dimensions = await probe(filename, signal); signal.throwIfAborted(); await assertOwner();
        const value = { id, projectId, ownerCreatedAt: before.createdAt, kind, name: name.trim(), mimeType, ...dimensions, bytes: bytes.length, sha256: digest(bytes), createdAt: new Date().toISOString() };
        const temporary = path.join(location, '.metadata.tmp'); await writeFile(temporary, JSON.stringify(value), { mode: 0o600 }); signal.throwIfAborted(); await assertOwner(); await rename(temporary, path.join(location, 'metadata.json'));
        const { projectId: _owner, ownerCreatedAt: _created, ...publicValue } = value;
        return { asset: publicValue };
      } catch (error) { const relative = path.relative(root, location); if (UUID.test(relative) && !path.isAbsolute(relative)) await rm(location, { recursive: true, force: true }); throw error; }
    });
    queues.set(projectId, pending); operations.add(pending);
    try { return await pending; } finally { controllers.delete(controller); operations.delete(pending); if (queues.get(projectId) === pending) queues.delete(projectId); }
  }
  async function file(projectId, assetId) {
    const { location, value, ownerCreatedAt } = await metadata(projectId, assetId), filename = path.join(location, 'image.' + TYPES[value.mimeType]);
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== value.bytes || !same(path.dirname(await realpath(filename)), await realpath(location))) throw failure(422, '图片文件无效，请重新导入。', 'NOVEL_ASSET_INVALID');
    const bytes = await readFile(filename);
    if (detectedType(bytes) !== value.mimeType || digest(bytes) !== value.sha256) throw failure(422, '图片内容已变化，请重新导入。', 'NOVEL_ASSET_CHANGED');
    if ((await store.read(projectId))?.createdAt !== ownerCreatedAt) throw failure(404, '图片不属于当前项目，请重新导入。', 'NOVEL_ASSET_OWNER_MISMATCH');
    return { bytes, contentType: value.mimeType, metadata: value };
  }
  async function remove(projectId, assetId) {
    await metadata(projectId, assetId);
    const location = await assetDirectory(projectId, assetId), project = await store.read(projectId);
    if (JSON.stringify(project).includes(assetId)) throw failure(409, '图片仍被当前项目的角色、场景或小说引用，请先替换。', 'NOVEL_ASSET_IN_USE');
    const root = await scope(projectId);
    if (!UUID.test(path.relative(root, location))) throw failure(403, '图片位置无效。', 'NOVEL_ASSET_STORAGE');
    await rm(location, { recursive: true, force: true }); return { removed: true };
  }
  async function handler(req, res, url, { signal } = {}) {
    const match = url.pathname.match(/^\/api\/projects\/([^/]+)\/novel-assets(?:\/(upload|[a-f0-9-]+)(?:\/(file))?)?$/i);
    if (!match) return false;
    const projectId = validateProjectId(decodeURIComponent(match[1])), assetId = match[2], action = match[3];
    if (!assetId && req.method === 'GET') { json(res, 200, await list(projectId)); return true; }
    if (assetId === 'upload' && req.method === 'POST') {
      const controller = new AbortController(), aborted = () => { if (!res.writableEnded) controller.abort(); }; res.once('close', aborted);
      controllers.add(controller);
      try {
        const owner = await store.read(projectId); if (!owner || owner.kind !== 'science') throw failure(404, '科普项目不存在。', 'PROJECT_NOT_FOUND');
        if (!/^application\/octet-stream(?:;|$)/i.test(req.headers['content-type'] || '')) throw failure(415, '请使用图片文件上传。', 'NOVEL_ASSET_CONTENT_TYPE');
        let name; try { name = decodeURIComponent(req.headers['x-file-name'] || ''); } catch { throw failure(400, '图片名称无效。', 'NOVEL_ASSET_NAME'); }
        if (Number(req.headers['content-length']) > MAX_IMAGE) { req.resume(); throw failure(413, '每张图片需在12MB以内。', 'NOVEL_ASSET_SIZE'); }
        const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
        const bytes = await readUpload(req, combined);
        json(res, 201, await importBytes(projectId, bytes, { name, kind: req.headers['x-asset-kind'], expectedOwnerCreatedAt: owner.createdAt, signal: combined }));
        return true;
      } finally { res.removeListener('close', aborted); controllers.delete(controller); }
    }
    if (action === 'file' && ['GET','HEAD'].includes(req.method)) { const value = await file(projectId, assetId); res.writeHead(200, { 'content-type': value.contentType, 'content-length': value.bytes.length, 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' }); res.end(req.method === 'HEAD' ? undefined : value.bytes); return true; }
    if (!action && assetId && req.method === 'DELETE') { json(res, 200, await remove(projectId, assetId)); return true; }
    throw failure(405, '自定义素材不支持此操作。', 'METHOD_NOT_ALLOWED');
  }
  const handle = (...args) => { const pending = handler(...args); operations.add(pending); pending.finally(() => operations.delete(pending)).catch(() => {}); return pending; };
  return { list, context: list, importBytes, file, remove, handler: handle, async close() { closed = true; for (const controller of controllers) controller.abort(); await Promise.allSettled([...operations]); } };
}
