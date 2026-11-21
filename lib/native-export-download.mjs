import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, realpath, rename, rm } from 'node:fs/promises';
import { AppError } from './errors.mjs';
import { zipFiles } from '../integrations/openfilm/packages/openfilm/studio/server/zip.mjs';

const pending = new Map(), cached = new Map();
const fail = (status, message, code = 'OPENFILM_EXPORT_NOT_FOUND') => new AppError(status, message, code);
const within = (root, file) => { const relative = path.relative(root, file); return relative === '' || !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative); };
const mime = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.gif': 'image/gif', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.zip': 'application/zip', '.pdf': 'application/pdf', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.srt': 'application/x-subrip', '.vtt': 'text/vtt;charset=utf-8', '.txt': 'text/plain;charset=utf-8', '.xml': 'application/xml', '.fcpxml': 'application/xml', '.json': 'application/json' };
const nameOf = value => String(value || 'native-export').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 100).replace(/[. ]+$/, '') || 'native-export';

/** Prepare only a finished job's owned outputs. The returned local path is IPC-only. */
export async function prepareNativeExportDownload({ exportsRoot, projectId, job, signal } = {}) {
  if (!job || job.project !== projectId || job.status !== 'done' || !Array.isArray(job.outputs) || !job.outputs.length) throw fail(404, '当前项目的导出尚未完成或没有可下载文件。');
  if (typeof exportsRoot !== 'string' || !path.isAbsolute(exportsRoot)) throw fail(500, '原生导出目录未配置。', 'OPENFILM_EXPORT_STORAGE');
  const root = path.resolve(exportsRoot), files = new Map(); let actualRoot;
  async function checked(filename) {
    if (typeof filename !== 'string' || !path.isAbsolute(filename) || !within(root, filename)) throw fail(403, '导出文件超出应用管理目录。', 'OPENFILM_EXPORT_STORAGE');
    let current = root;
    for (const part of ['', ...path.relative(root, filename).split(path.sep).filter(Boolean)]) {
      if (part) current = path.join(current, part);
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw fail(403, '导出文件不能通过链接读取。', 'OPENFILM_EXPORT_STORAGE');
    }
    if (!within(actualRoot, await realpath(filename))) throw fail(403, '导出文件超出实际管理目录。', 'OPENFILM_EXPORT_STORAGE');
    return lstat(filename);
  }
  const signature = (filename, info) => [filename, info.size, info.mtimeMs, info.ctimeMs].join(':');
  async function collect(filename) {
    if (filename === root || path.relative(root, filename).split(path.sep)[0] === '.gx-downloads') throw fail(403, '不能将导出存储目录本身作为输出。', 'OPENFILM_EXPORT_STORAGE');
    const info = await checked(filename);
    if (info.isDirectory()) { for (const item of (await readdir(filename)).sort()) await collect(path.join(filename, item)); return; }
    if (!info.isFile()) throw fail(403, '导出输出必须是普通文件或目录。', 'OPENFILM_EXPORT_STORAGE');
    const key = process.platform === 'win32' ? filename.toLowerCase() : filename;
    files.set(key, { file: filename, name: path.relative(root, filename).split(path.sep).join('/'), signature: signature(filename, info) });
  }
  try {
    actualRoot = await realpath(root);
    for (const output of job.outputs) {
      if (typeof output !== 'string' || !path.isAbsolute(output)) throw fail(403, '导出输出必须位于应用管理目录。', 'OPENFILM_EXPORT_STORAGE');
      await collect(path.resolve(output));
    }
    const uniqueOutputs = [...new Set(job.outputs.map(value => path.resolve(value)))];
    if (uniqueOutputs.length === 1 && (await checked(uniqueOutputs[0])).isFile()) {
      const file = uniqueOutputs[0], info = await checked(file);
      return { path: file, name: path.basename(file), contentType: mime[path.extname(file).toLowerCase()] || 'application/octet-stream', size: info.size };
    }
    const entries = [...files.values()].sort((a, b) => a.name.localeCompare(b.name));
    const fingerprint = createHash('sha256').update(entries.map(item => item.signature).join('\n')).digest('hex');
    const key = `${root}:${projectId}:${job.id}:${fingerprint}`;
    const previous = cached.get(key);
    if (previous) {
      try { const info = await checked(previous.path); if (info.isFile() && signature(previous.path, info) === previous.signature) return { path: previous.path, name: previous.name, contentType: 'application/zip', size: info.size }; } catch {}
      cached.delete(key);
    }
    if (pending.has(key)) return await pending.get(key);
    const operation = (async () => {
      if (signal?.aborted) throw fail(499, '导出下载打包已取消。', 'REQUEST_CANCELLED');
      const folder = path.join(root, '.gx-downloads'); await mkdir(folder, { recursive: true }); await checked(folder);
      const filename = path.join(folder, randomUUID() + '.zip'), temporary = path.join(folder, '.partial-' + randomUUID() + '.zip');
      try {
        await zipFiles(temporary, entries.map(({ name, file }) => ({ name, file })), signal);
        for (const entry of entries) if (signature(entry.file, await checked(entry.file)) !== entry.signature) throw fail(409, '导出文件在打包期间发生变化，请重新下载。', 'OPENFILM_EXPORT_CHANGED');
        await rename(temporary, filename);
        const info = await checked(filename), result = { path: filename, name: nameOf(job.name || job.id) + '.zip', contentType: 'application/zip', size: info.size };
        cached.set(key, { ...result, signature: signature(filename, info) });
        if (cached.size > 128) cached.delete(cached.keys().next().value);
        return result;
      } finally { await rm(temporary, { force: true }).catch(() => {}); }
    })();
    pending.set(key, operation);
    try { return await operation; } finally { pending.delete(key); }
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (signal?.aborted) throw fail(499, '导出下载打包已取消。', 'REQUEST_CANCELLED');
    if (error.code === 'ENOENT') throw fail(404, '导出文件已被移动或删除，请重新导出。');
    throw fail(502, '导出文件暂时无法打包下载，请重试。', 'OPENFILM_EXPORT_DOWNLOAD_FAILED');
  }
}
