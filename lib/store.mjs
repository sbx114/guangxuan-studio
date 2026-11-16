import { mkdir, readFile, readdir, rename, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError, requireObject } from './errors.mjs';

const SECRET_KEYS = /^(?:apikey|api_key|authorization|access_?token|refresh_?token|password|secret|client_?secret|credentials)$/i;
export function withoutSecrets(value, depth = 0, sensitiveStrings = []) {
  if (depth > 50) throw new AppError(400, '项目内容层级过深。', 'INVALID_PROJECT');
  if (typeof value === 'string') {
    let sanitized = value;
    for (const secret of sensitiveStrings) if (secret) sanitized = sanitized.split(secret).join('[密钥已隐藏]');
    return sanitized;
  }
  if (Array.isArray(value)) return value.map(item => withoutSecrets(item, depth + 1, sensitiveStrings));
  if (!value || typeof value !== 'object') return value;
  const clean = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEYS.test(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) continue;
    clean[key] = withoutSecrets(item, depth + 1, sensitiveStrings);
  }
  return clean;
}

export function validateProjectId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) throw new AppError(400, '项目编号不正确。', 'INVALID_PROJECT_ID');
  return id;
}

export async function createProjectStore(dataDir, { sensitiveStrings = () => [] } = {}) {
  const directory = path.join(path.resolve(dataDir), 'projects');
  await mkdir(directory, { recursive: true });
  const queues = new Map();
  function serialized(id, operation) {
    const previous = queues.get(id) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    queues.set(id, current);
    current.finally(() => { if (queues.get(id) === current) queues.delete(id); }).catch(() => {});
    return current;
  }
  async function read(id) {
    validateProjectId(id);
    try { return withoutSecrets(JSON.parse(await readFile(path.join(directory, `${id}.json`), 'utf8')), 0, sensitiveStrings()); }
    catch (error) { if (error.code === 'ENOENT') return null; throw new AppError(500, '项目文件无法读取。原文件已保留。', 'PROJECT_READ_ERROR'); }
  }
  return {
    async list() {
      const entries = (await readdir(directory)).filter(filename => /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.json$/.test(filename));
      const projects = [];
      let unreadableCount = 0;
      for (const filename of entries) {
        try { const project = await read(filename.slice(0, -5)); if (project) projects.push(project); }
        catch { unreadableCount++; }
      }
      projects.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
      return { projects, ...(unreadableCount ? { warning: `${unreadableCount} 个项目文件无法读取，原文件已保留。` } : {}) };
    },
    read,
    async save(id, input) {
      validateProjectId(id);
      requireObject(input, '项目');
      if (input.id && input.id !== id) throw new AppError(400, '项目编号与保存路径不一致。', 'PROJECT_ID_MISMATCH');
      return serialized(id, async () => {
        const clean = withoutSecrets(input, 0, sensitiveStrings());
        const previous = await read(id);
        const now = new Date().toISOString();
        const project = { ...clean, id, createdAt: previous?.createdAt || clean.createdAt || now, updatedAt: now };
        const serializedProject = JSON.stringify(project, null, 2);
        if (Buffer.byteLength(serializedProject) > 3 * 1024 * 1024) throw new AppError(400, '项目超过 3 MB，请精简历史记录或拆分项目。', 'PROJECT_TOO_LARGE');
        const temporary = path.join(directory, `.${id}.${randomUUID()}.tmp`);
        try {
          await writeFile(temporary, serializedProject, { mode: 0o600 });
          await rename(temporary, path.join(directory, `${id}.json`));
        } catch {
          await unlink(temporary).catch(() => {});
          throw new AppError(500, '项目保存失败，请检查本地磁盘空间和目录权限。', 'PROJECT_WRITE_ERROR');
        }
        return project;
      });
    },
    async remove(id) {
      validateProjectId(id);
      return serialized(id, async () => {
        try { await unlink(path.join(directory, `${id}.json`)); return true; }
        catch (error) { if (error.code === 'ENOENT') return false; throw new AppError(500, '项目删除失败，请重试。', 'PROJECT_DELETE_ERROR'); }
      });
    },
    async settle() { await Promise.allSettled([...queues.values()]); },
  };
}
