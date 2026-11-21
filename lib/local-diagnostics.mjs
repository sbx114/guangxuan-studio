import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';

/** Local, redacted failure receipts. Request bodies, headers and model replies are never recorded. */
export async function createLocalDiagnostics({ dataDir, sensitiveStrings = () => [] } = {}) {
  const directory = path.resolve(dataDir, 'diagnostics'), filename = path.join(directory, 'errors.ndjson');
  await mkdir(directory, { recursive: true });
  const originalDirectory = await lstat(directory), actualDirectory = await realpath(directory);
  if (!originalDirectory.isDirectory() || originalDirectory.isSymbolicLink()) throw new Error('Diagnostics directory cannot be a link.');
  let writing = Promise.resolve();
  function clean(value) {
    let text = String(value || '');
    for (const secret of sensitiveStrings() || []) if (typeof secret === 'string' && secret) text = text.split(secret).join('[密钥已隐藏]');
    return text.replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [密钥已隐藏]')
      .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, '[密钥已隐藏]')
      .replace(/((?:api[_-]?key|authorization|access[_-]?token|password|secret)\s*[=:]\s*)[^\s,;]+/gi, '$1[密钥已隐藏]')
      .replace(/(?:https?|file):\/\/[^\s)"'<>]+/gi, address => {
        const source = address.replace(/\\/g, '/').match(/\/(lib|public|scripts|animation)\/([^\s)"'<>]+)$/);
        return source ? source[1] + '/' + source[2] : '[地址已隐藏]';
      })
      .replace(/\b[A-Za-z]:[\\/][^\r\n)"'<>]+|\\\\[^\r\n)"'<>]+/g, '[本机路径已隐藏]')
      .replace(/(^|[\s("'=])\/(?!api(?:\/|$))[^\r\n)"'<>]+/g, '$1[本机路径已隐藏]')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ' ');
  }
  async function sameDirectory() {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== originalDirectory.dev || info.ino !== originalDirectory.ino || await realpath(directory) !== actualDirectory) throw new Error('Diagnostics directory changed.');
  }
  async function ordinary(file) {
    try { const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Diagnostics file must be ordinary and unlinked.'); return info; }
    catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
  }
  async function capture(error, context = {}) {
    const id = randomUUID();
    const route = typeof context.route === 'string' ? context.route.split('?')[0].slice(0, 500) : '';
    const record = { id, at: new Date().toISOString(), name: clean(error?.name || 'Error').slice(0, 80), message: clean(error?.message || error).slice(0, 1000), stack: clean(error?.stack || '').split('\n').slice(0, 9), method: clean(context.method || '').slice(0, 12), route: clean(route) };
    const pending = writing.catch(() => {}).then(async () => {
      await sameDirectory();
      const current = await ordinary(filename), size = current?.size || 0;
      if (size > 2 * 1024 * 1024) {
        const previous = path.join(directory, 'errors.previous.ndjson'); await ordinary(previous); await sameDirectory(); await unlink(previous).catch(issue => { if (issue.code !== 'ENOENT') throw issue; }); await sameDirectory(); await rename(filename, previous);
      }
      await sameDirectory();
      const handle = await open(filename, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW || 0), 0o600);
      try {
        const opened = await handle.stat(), named = await ordinary(filename); await sameDirectory();
        if (!opened.isFile() || opened.nlink !== 1 || !named || opened.dev !== named.dev || opened.ino !== named.ino) throw new Error('Diagnostics file changed.');
        await handle.writeFile(JSON.stringify(record) + '\n', { encoding: 'utf8' });
      } finally { await handle.close(); }
    });
    writing = pending; await pending; return { id };
  }
  return { capture, async close() { await writing.catch(() => {}); } };
}
