import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { AppError } from './errors.mjs';
import { renameWithRetry } from './atomic-file.mjs';

const MAX_BYTES = 64 * 1024;
const comparable = value => process.platform === 'win32' ? value.toLowerCase() : value;
const failure = (code = 'DESKTOP_RUNTIME_INVALID', status = 403) => new AppError(status, code === 'ENOENT' ? '本地服务会话记录不存在。' : '本地服务会话文件或目录无效，请重新启动应用。', code);
const pendingWrites = new Map();
function filenameOf(value) { if (typeof value !== 'string' || !path.isAbsolute(value)) throw failure(); return path.resolve(value); }
async function unlinked(candidate, allowMissing = false) {
  const root = path.parse(candidate).root;
  let current = root;
  for (const part of ['', ...path.relative(root, candidate).split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    try { const info = await lstat(current); if (info.isSymbolicLink() || info.isFile() && info.nlink > 1) throw failure('DESKTOP_RUNTIME_UNSAFE_PATH'); }
    catch (error) { if (allowMissing && error.code === 'ENOENT') return; if (error instanceof AppError) throw error; throw failure(error.code === 'ENOENT' ? 'ENOENT' : 'DESKTOP_RUNTIME_INVALID'); }
  }
}
export async function readDesktopRuntime(filename) {
  const target = filenameOf(filename); let handle;
  try {
    await unlinked(target); handle = await open(target, 'r'); const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > MAX_BYTES || comparable(await realpath(target)) !== comparable(target)) throw failure('DESKTOP_RUNTIME_UNSAFE_PATH');
    let value; try { value = JSON.parse((await handle.readFile('utf8')).replace(/^\uFEFF/, '')); } catch { throw failure(); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure();
    return value;
  } catch (error) { if (error instanceof AppError) throw error; throw failure(error.code === 'ENOENT' ? 'ENOENT' : 'DESKTOP_RUNTIME_INVALID'); }
  finally { await handle?.close().catch(() => {}); }
}
export function writeDesktopRuntime(filename, value) {
  const target = filenameOf(filename); let encoded;
  try { if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure(); encoded = JSON.stringify(value); if (Buffer.byteLength(encoded) > MAX_BYTES) throw failure(); }
  catch { return Promise.reject(failure()); }
  const key = comparable(target), previous = pendingWrites.get(key) || Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    const directory = path.dirname(target), temporary = target + '.' + randomUUID() + '.tmp'; let handle;
    try {
      await unlinked(directory, true); await mkdir(directory, { recursive: true }); await unlinked(directory);
      if (comparable(await realpath(directory)) !== comparable(directory)) throw failure('DESKTOP_RUNTIME_UNSAFE_PATH');
      await unlinked(target, true); handle = await open(temporary, 'wx', 0o600); await handle.writeFile(encoded, 'utf8'); await handle.sync(); await handle.close(); handle = null;
      await unlinked(directory); await unlinked(target, true); await unlinked(temporary);
      await renameWithRetry(temporary, target); return { written: true };
    } catch (error) { if (error instanceof AppError) throw error; throw failure(); }
    finally { await handle?.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
  });
  pendingWrites.set(key, operation); operation.finally(() => { if (pendingWrites.get(key) === operation) pendingWrites.delete(key); }).catch(() => {});
  return operation;
}
