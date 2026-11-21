import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, unlink, writeFile, rmdir } from 'node:fs/promises';
import { AppError } from './errors.mjs';
import { validateProjectId } from './store.mjs';

const ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const TYPES = new Set(['text/plain; charset=utf-8', 'text/markdown; charset=utf-8', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'image/png', 'application/json', 'text/html; charset=utf-8']);
const MAX_FILE = 48 * 1024 * 1024;
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = (status, message, code) => new AppError(status, message, 'ASSISTANT_ARTIFACT_' + code);
const equal = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

/** Local generated exports. Models never supply paths, file bytes or download destinations. */
export async function createAssistantArtifactService({ dataDir, store, root: _appRoot, maxFiles = 256, maxTotalBytes = 128 * 1024 * 1024 } = {}) {
  if (!dataDir || !store?.read) throw fail(500, '助手导出服务尚未配置。', 'NOT_CONFIGURED');
  const home = path.resolve(dataDir, 'assistant'), candidate = path.join(home, 'exports');
  await mkdir(home, { recursive: true });
  if ((await lstat(home)).isSymbolicLink()) throw fail(403, '助手导出目录不能是链接。', 'STORAGE');
  await mkdir(candidate, { recursive: true });
  if ((await lstat(candidate)).isSymbolicLink()) throw fail(403, '助手导出目录不能是链接。', 'STORAGE');
  const root = await realpath(candidate), operations = new Set();
  let closed = false, tail = Promise.resolve();
  const check = signal => { if (closed || signal?.aborted) throw fail(499, '导出已停止。', 'CANCELLED'); };
  const publicFile = value => ({ id: value.id, projectId: value.projectId, name: value.name, size: value.size, sha256: value.sha256, contentType: value.contentType, createdAt: value.createdAt, downloadUrl: `/api/assistant/exports/${value.id}/file`, canImport: false });
  async function owner(projectId, createdAt) {
    const project = await store.read(validateProjectId(projectId));
    if (!project || createdAt !== undefined && project.createdAt !== createdAt) throw fail(409, '原项目已移除或重建，这份导出不可用于当前项目。', 'PROJECT_CHANGED');
    return project;
  }
  async function safe(filename, folder = false) {
    const info = await lstat(filename);
    if (info.isSymbolicLink() || !(folder ? info.isDirectory() : info.isFile()) || !equal(await realpath(filename), filename)) throw fail(403, '助手导出文件位置无效。', 'STORAGE');
    return info;
  }
  function create({ projectId, name, contentType, buffer }, { signal } = {}) {
    const work = tail.catch(() => {}).then(async () => {
      check(signal); const project = await owner(projectId);
      if (typeof name !== 'string' || !name || name.length > 200 || /[<>:"/\\|?*\x00-\x1f\x7f]/.test(name) || /[. ]$/.test(name) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) throw fail(400, '导出文件名无效。', 'NAME');
      if (!TYPES.has(contentType) || !Buffer.isBuffer(buffer) || buffer.length < 1 || buffer.length > MAX_FILE) throw fail(400, '导出文件格式或大小无效。', 'FORMAT');
      const groups = (await readdir(root, { withFileTypes: true })).filter(item => ID.test(item.name));
      let total = 0;
      for (const group of groups) {
        const directory = path.join(root, group.name); await safe(directory, true);
        total += (await safe(path.join(directory, 'payload'))).size;
      }
      if (groups.length >= Math.max(1, Math.min(256, maxFiles)) || total + buffer.length > Math.max(1, Math.min(128 * 1024 * 1024, maxTotalBytes))) throw fail(413, '助手导出区已达容量上限，请先保存并清理已有导出。', 'QUOTA');
      check(signal); await owner(project.id, project.createdAt);
      const id = randomUUID(), directory = path.join(root, id), filename = path.join(directory, 'payload');
      const value = { version: 1, id, projectId: project.id, projectCreatedAt: project.createdAt, name, size: buffer.length, sha256: digest(buffer), contentType, createdAt: new Date().toISOString() };
      await mkdir(directory);
      try {
        await writeFile(filename, buffer, { flag: 'wx', mode: 0o600 });
        check(signal); await owner(project.id, project.createdAt);
        await writeFile(path.join(directory, 'metadata.json'), JSON.stringify(value), { flag: 'wx', mode: 0o600 });
        return publicFile(value);
      } catch (error) {
        await unlink(filename).catch(() => {}); await unlink(path.join(directory, 'metadata.json')).catch(() => {}); await rmdir(directory).catch(() => {});
        throw error;
      }
    });
    tail = work; operations.add(work); work.finally(() => operations.delete(work)).catch(() => {}); return work;
  }
  async function read(id, { projectId } = {}) {
    check(); if (typeof id !== 'string' || !ID.test(id)) throw fail(404, '助手导出不存在。', 'NOT_FOUND');
    const directory = path.join(root, id); let value, buffer;
    try {
      await safe(directory, true); const metadata = path.join(directory, 'metadata.json');
      if ((await safe(metadata)).size > 4096) throw fail(409, '助手导出记录已变化。', 'CHANGED');
      value = JSON.parse(await readFile(metadata, 'utf8'));
      if (value.version !== 1 || value.id !== id || !ID.test(value.id) || typeof value.name !== 'string' || value.name.length > 200 || /[\r\n]/.test(value.name) || !TYPES.has(value.contentType) || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > MAX_FILE || typeof value.projectCreatedAt !== 'string' || !Number.isFinite(Date.parse(value.projectCreatedAt)) || !/^[a-f0-9]{64}$/.test(value.sha256)) throw fail(409, '助手导出记录已变化。', 'CHANGED');
      if (projectId !== undefined && value.projectId !== projectId) throw fail(404, '导出不属于当前项目。', 'NOT_FOUND');
      await owner(value.projectId, value.projectCreatedAt);
      const filename = path.join(directory, 'payload');
      if ((await safe(filename)).size !== value.size) throw fail(409, '助手导出文件已变化。', 'CHANGED');
      buffer = await readFile(filename);
      if (buffer.length !== value.size || digest(buffer) !== value.sha256) throw fail(409, '助手导出校验失败，请重新导出。', 'CHANGED');
    } catch (error) { if (error instanceof AppError) throw error; throw fail(404, '助手导出不存在或文件已移走。', 'NOT_FOUND'); }
    return { file: publicFile(value), buffer };
  }
  async function handler(req, res, url) {
    const match = /^\/api\/assistant\/exports\/([a-f0-9-]{36})\/file$/.exec(url.pathname);
    if (!match || !['GET', 'HEAD'].includes(req.method)) return false;
    const { file, buffer } = await read(match[1]);
    const ascii = file.name.replace(/[^\x20-\x7e]|["\\]/g, '_');
    res.writeHead(200, { 'content-type': file.contentType, 'content-length': file.size, 'cache-control': 'private, no-store', 'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}` });
    res.end(req.method === 'HEAD' ? undefined : buffer); return true;
  }
  return { create, read, handler, async close() { closed = true; await Promise.allSettled([...operations]); } };
}
