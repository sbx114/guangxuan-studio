import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, lstat, realpath, unlink, rmdir } from 'node:fs/promises';
import { AppError } from './errors.mjs';
import { validateProjectId } from './store.mjs';
import { renameWithRetry } from './atomic-file.mjs';
import { normalizeMaterialProvenance } from './assistant-materials.mjs';

const MAX_FILE = 64 * 1024 * 1024, MAX_TOTAL = 2 * 1024 * 1024 * 1024, MAX_FILES = 256;
const ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const IMPORTABLE = new Set(['.pdf', '.docx', '.txt', '.md']);
const IMAGE_IMPORTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp']);
const VIDEO_IMPORTS = new Set(['.mp4', '.m4v', '.mov', '.webm']);
const AUDIO_IMPORTS = new Set(['.mp3', '.wav', '.m4a']);
const mediaKind = value => /^image\//.test(value.contentType) && IMAGE_IMPORTS.has(path.extname(value.name).toLowerCase()) ? 'image' : /^video\//.test(value.contentType) && VIDEO_IMPORTS.has(path.extname(value.name).toLowerCase()) ? 'video' : /^audio\//.test(value.contentType) && AUDIO_IMPORTS.has(path.extname(value.name).toLowerCase()) ? 'audio' : null;
const clone = value => structuredClone(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = (status, message, code) => new AppError(status, message, 'ASSISTANT_DOWNLOAD_' + code);
const cancelled = () => fail(499, '资料下载已停止。', 'CANCELLED');
function name(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[<>:"/\\|?*\x00-\x1f\x7f]/.test(value) || /[. ]$/.test(value) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value)) throw fail(422, '下载文件名无效。', 'NAME');
  return value;
}
function sourceUrl(value) {
  let url; try { url = new URL(value); } catch { throw fail(422, '下载来源网址无效。', 'SOURCE'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 8192) throw fail(422, '下载来源网址无效。', 'SOURCE');
  return url.href;
}

/** Original bytes are private application data. No path or filename comes from model arguments. */
export async function createAssistantDownloadService({ dataDir, webTools, store, scienceDocuments, videoService, maxFiles = MAX_FILES, maxTotalBytes = MAX_TOTAL } = {}) {
  if (!dataDir || !webTools?.download || !store?.read) throw fail(500, '原文件下载服务尚未配置。', 'NOT_CONFIGURED');
  const home = path.resolve(dataDir), assistantHome = path.join(home, 'assistant'), directory = path.join(assistantHome, 'downloads');
  await mkdir(home, { recursive: true });
  await mkdir(assistantHome, { recursive: true });
  if ((await lstat(assistantHome)).isSymbolicLink()) throw fail(403, '助手资料目录不能是链接。', 'STORAGE');
  await mkdir(directory, { recursive: true });
  if ((await lstat(directory)).isSymbolicLink()) throw fail(403, '下载资料目录不能是链接。', 'STORAGE');
  const root = await realpath(directory), index = path.join(root, 'index.json'), records = new Map(), pending = new Map(), operations = new Set(), controller = new AbortController();
  const limitFiles = Math.max(1, Math.min(MAX_FILES, Number(maxFiles) || MAX_FILES)), limitBytes = Math.max(1, Math.min(MAX_TOTAL, Number(maxTotalBytes) || MAX_TOTAL));
  let closed = false, tail = Promise.resolve();
  function check(signal) { if (closed || signal?.aborted) throw cancelled(); }
  function serial(run) { const result = tail.catch(() => {}).then(run); tail = result; return result; }
  function publicRecord(value) {
    return { id: value.id, name: value.name, size: value.size, contentType: value.contentType, sha256: value.sha256, url: value.url, projectId: value.projectId, createdAt: value.createdAt, downloadUrl: '/api/assistant/downloads/' + value.id + '/file', canImport: IMPORTABLE.has(path.extname(value.name).toLowerCase()), canImportMedia: Boolean(mediaKind(value)), ...(mediaKind(value) ? { mediaKind: mediaKind(value) } : {}), ...(value.provenance ? { provenance: clone(value.provenance) } : {}), ...(value.preparedMedia ? { preparedMedia: clone(value.preparedMedia) } : {}) };
  }
  function scope(value, projectId) { return projectId === undefined || value.projectId === null || value.projectId === projectId; }
  function find(id, { projectId } = {}) {
    const value = typeof id === 'string' && ID.test(id) ? records.get(id) : null;
    if (!value || !scope(value, projectId)) throw fail(404, '下载资料不存在或不属于本次项目。', 'NOT_FOUND');
    return value;
  }
  async function owner(projectId) {
    if (!projectId) return null;
    const value = await store.read(validateProjectId(projectId));
    if (!value) throw fail(404, '本次项目已不存在，资料尚未保存。', 'PROJECT');
    return value;
  }
  async function safeFile(value) {
    const group = path.join(root, value.id), filename = path.join(group, 'payload');
    try {
      if ((await lstat(group)).isSymbolicLink() || (await lstat(filename)).isSymbolicLink() || await realpath(group) !== group || await realpath(filename) !== filename) throw fail(403, '下载资料位置无效。', 'STORAGE');
      const info = await lstat(filename);
      if (!info.isFile() || info.size !== value.size || info.size > MAX_FILE) throw fail(409, '本机下载文件已有变化，请重新下载。', 'CHANGED');
      const buffer = await readFile(filename);
      if (digest(buffer) !== value.sha256) throw fail(409, '本机下载文件校验失败，请重新下载。', 'CHANGED');
      return buffer;
    } catch (error) { if (error instanceof AppError) throw error; throw fail(404, '本机下载文件已移走或不可读取，请重新下载。', 'FILE_MISSING'); }
  }
  async function persist() {
    const temporary = path.join(root, '.' + randomUUID() + '.tmp');
    try { await writeFile(temporary, JSON.stringify({ version: 1, downloads: [...records.values()] }, null, 2), { mode: 0o600, flag: 'wx' }); await renameWithRetry(temporary, index); }
    finally { await unlink(temporary).catch(() => {}); }
  }
  try {
    if ((await lstat(index)).isSymbolicLink()) throw new Error('linked registry');
    const raw = await readFile(index, 'utf8');
    if (Buffer.byteLength(raw) > 4 * 1024 * 1024) throw new Error('large registry');
    const saved = JSON.parse(raw);
    if (saved.version !== 1 || !Array.isArray(saved.downloads) || saved.downloads.length > MAX_FILES) throw new Error('invalid registry');
    for (const item of saved.downloads) {
      if (!item || !ID.test(item.id || '') || records.has(item.id) || !Number.isSafeInteger(item.size) || item.size < 1 || item.size > MAX_FILE || !/^[a-f0-9]{64}$/.test(item.sha256 || '') || typeof item.contentType !== 'string' || item.contentType.length > 160 || !Number.isFinite(Date.parse(item.createdAt))) throw new Error('invalid record');
      const value = { id: item.id, name: name(item.name), size: item.size, contentType: item.contentType, sha256: item.sha256, url: sourceUrl(item.url), projectId: item.projectId === null ? null : validateProjectId(item.projectId), projectCreatedAt: typeof item.projectCreatedAt === 'string' ? item.projectCreatedAt : null, createdAt: item.createdAt };
      if (item.provenance) value.provenance = normalizeMaterialProvenance(item.provenance, { finalUrl: value.url, sha256: value.sha256, size: value.size });
      if (item.preparedMedia && ID.test(item.preparedMedia.assetId || '') && ['image', 'video', 'audio'].includes(item.preparedMedia.type)) value.preparedMedia = { assetId: item.preparedMedia.assetId, type: item.preparedMedia.type, duration: Number(item.preparedMedia.duration) || 0, width: Number(item.preparedMedia.width) || 0, height: Number(item.preparedMedia.height) || 0, metadataVerified: item.preparedMedia.metadataVerified === true };
      records.set(value.id, value);
    }
  } catch (error) { if (error.code !== 'ENOENT') throw fail(500, '下载记录无法读取，原文件已保留。', 'REGISTRY'); }

  function tracked(operation) { operations.add(operation); operation.finally(() => operations.delete(operation)).catch(() => {}); return operation; }
  function download(url, { projectId = null, runId = '', signal: external, onProgress, candidateId } = {}) {
    if (closed) return Promise.reject(cancelled());
    const key = runId ? runId + ':' + (projectId || '') + ':' + url + ':' + (candidateId || '') : '';
    if (key && pending.has(key)) return pending.get(key);
    const operation = (async () => {
      const signal = external ? AbortSignal.any([external, controller.signal]) : controller.signal;
      check(signal); const before = await owner(projectId);
      const file = await webTools.download(url, { signal, onProgress, ...(candidateId !== undefined ? { candidateId } : {}) }); check(signal);
      if (!Buffer.isBuffer(file.buffer) || file.buffer.length < 1 || file.buffer.length > MAX_FILE || file.size !== file.buffer.length || file.sha256 !== digest(file.buffer)) throw fail(422, '下载字节与校验信息不一致，资料未保存。', 'INTEGRITY');
      const fileName = name(file.fileName), originalUrl = sourceUrl(file.url);
      const provenance = normalizeMaterialProvenance(file.provenance, { requestedUrl: file.provenance?.requestedUrl || url, finalUrl: originalUrl, sha256: file.sha256, size: file.size });
      if (typeof file.contentType !== 'string' || !file.contentType || file.contentType.length > 160 || /[\r\n]/.test(file.contentType)) throw fail(422, '下载文件类型无效。', 'TYPE');
      return serial(async () => {
        check(signal); const after = await owner(projectId);
        if (before && after.createdAt !== before.createdAt) throw fail(409, '本次项目已重新创建，请重新下载到目标项目。', 'PROJECT_CHANGED');
        const duplicate = [...records.values()].find(item => item.sha256 === file.sha256 && item.url === originalUrl && item.projectId === projectId && (item.provenance?.sourcePage?.url || '') === (provenance.sourcePage?.url || '') && (!after || item.projectCreatedAt === after.createdAt));
        if (duplicate) {
          try { await safeFile(duplicate); return { download: publicRecord(duplicate), duplicate: true, warnings: file.warnings || [] }; }
          catch (error) { if (!['ASSISTANT_DOWNLOAD_FILE_MISSING', 'ASSISTANT_DOWNLOAD_CHANGED'].includes(error.code)) throw error; }
        }
        const total = [...records.values()].reduce((sum, item) => sum + item.size, 0);
        if (records.size >= limitFiles || total + file.size > limitBytes) throw fail(413, '本机资料下载区已达到容量上限，请先保存并清理已有下载资料。', 'QUOTA');
        const id = randomUUID(), group = path.join(root, id), filename = path.join(group, 'payload');
        const value = { id, name: fileName, size: file.size, contentType: file.contentType, sha256: file.sha256, url: originalUrl, provenance, projectId: after?.id || null, projectCreatedAt: after?.createdAt || null, createdAt: new Date().toISOString() };
        await mkdir(group);
        try {
          // Once the original bytes are committed, always return the receipt,
          // including a Stop arriving during the atomic registry save.
          await writeFile(filename, file.buffer, { mode: 0o600, flag: 'wx' });
          records.set(id, value);
          try { await persist(); } catch (error) { records.delete(id); throw error; }
          return { download: publicRecord(value), duplicate: false, warnings: file.warnings || [] };
        } catch (error) { await unlink(filename).catch(() => {}); await rmdir(group).catch(() => {}); throw error instanceof AppError ? error : fail(500, '下载文件无法保存，请检查本机磁盘空间。', 'WRITE'); }
      });
    })();
    if (key) {
      pending.set(key, operation);
      operation.catch(() => { if (pending.get(key) === operation) pending.delete(key); });
      while (pending.size > 128) pending.delete(pending.keys().next().value);
    }
    return tracked(operation);
  }
  async function list({ projectId = null } = {}) { check(); if (projectId) await owner(projectId); return { downloads: [...records.values()].filter(item => scope(item, projectId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicRecord), limits: { fileBytes: MAX_FILE, totalBytes: limitBytes, files: limitFiles } }; }
  async function read(id, options) { check(); const value = find(id, options); return { download: publicRecord(value), buffer: await safeFile(value) }; }
  async function mediaAsset(id, { projectId, signal } = {}) {
    check(signal); const project = projectId ? await owner(projectId) : null;
    const value = find(id, { projectId });
    const extension = path.extname(value.name).toLowerCase();
    if (value.projectId && project && value.projectCreatedAt !== project.createdAt) throw fail(409, '这份下载来自已重新创建的项目，请重新选取原件。', 'PROJECT_CHANGED');
    const expectedType = mediaKind(value);
    if (!expectedType) throw fail(415, '当前媒体导入支持PNG/JPG/WebP/BMP、MP4/MOV/WebM及MP3/WAV/M4A单文件；原件仍可保存。', 'MEDIA_TYPE');
    if (!videoService?.importLocalFile) throw fail(503, '本机媒体处理服务尚未就绪。', 'MEDIA_UNAVAILABLE');
    const buffer = await safeFile(value); check(signal);
    const filename = path.join(root, value.id, 'media' + extension);
    try { await writeFile(filename, buffer, { mode: 0o600, flag: 'wx' }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw fail(500, '媒体处理副本无法保存。', 'WRITE');
      const info = await lstat(filename);
      if (!info.isFile() || info.isSymbolicLink() || await realpath(filename) !== filename || digest(await readFile(filename)) !== value.sha256) throw fail(409, '本机媒体处理副本已有变化，请重新下载原文件。', 'CHANGED');
    }
    const provenance = value.provenance || normalizeMaterialProvenance({}, { finalUrl: value.url, sha256: value.sha256, size: value.size });
    const asset = await videoService.importLocalFile(filename, { name: value.name, expectedType, signal, provenance });
    check(signal); if (project && (await owner(projectId)).createdAt !== project.createdAt) throw fail(409, '媒体准备期间项目已重新创建，未登记到新项目。', 'PROJECT_CHANGED');
    const metadataVerified = asset.type === expectedType && Number.isFinite(asset.duration) && asset.duration > 0 && (asset.type === 'audio' || asset.width > 0 && asset.height > 0);
    await serial(async () => { const previous = value.preparedMedia; value.preparedMedia = { assetId: asset.id, type: asset.type, duration: asset.duration, width: asset.width, height: asset.height, metadataVerified }; try { await persist(); } catch (error) { value.preparedMedia = previous; throw error; } });
    return { asset: { ...asset, provenance }, download: publicRecord(value) };
  }
  async function importFile(id, { projectId, signal } = {}) {
    check(signal); const project = await owner(projectId);
    if (!project || project.kind !== 'science') throw fail(400, '请先打开需要接收资料的科普项目。', 'SCIENCE_PROJECT');
    const value = find(id, { projectId });
    if (value.projectId && value.projectCreatedAt !== project.createdAt) throw fail(409, '这份下载来自已重新创建的项目，请重新下载或保存原文件后导入。', 'PROJECT_CHANGED');
    if (!IMPORTABLE.has(path.extname(value.name).toLowerCase())) throw fail(415, '当前科普材料支持PDF、DOCX、TXT和Markdown；这份原文件可以保存到电脑使用。', 'IMPORT_TYPE');
    const buffer = await safeFile(value); check(signal);
    const result = await scienceDocuments.importBuffer(project.id, { name: value.name, title: value.name.replace(/\.[^.]+$/, ''), buffer }, { signal });
    return { ...result, download: publicRecord(value) };
  }
  async function handler(req, res, url) {
    if (url.pathname === '/api/assistant/downloads' && req.method === 'GET') {
      const result = await list(url.searchParams.has('projectId') ? { projectId: validateProjectId(url.searchParams.get('projectId')) } : {});
      const body = JSON.stringify(result); res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) }); res.end(body); return true;
    }
    const match = /^\/api\/assistant\/downloads\/([a-f0-9-]{36})\/file$/.exec(url.pathname);
    if (!match || !['GET', 'HEAD'].includes(req.method)) return false;
    const { download: file, buffer } = await read(match[1]);
    const ascii = file.name.replace(/[^\x20-\x7e]|["\\]/g, '_');
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': buffer.length, 'cache-control': 'private, no-store', 'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}` });
    res.end(req.method === 'HEAD' ? undefined : buffer); return true;
  }
  return { download, list, read, mediaAsset, importFile, handler, async close() { if (closed) return; closed = true; controller.abort(); await Promise.allSettled([...operations]); await tail.catch(() => {}); pending.clear(); } };
}
