import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { configureWorkerGit } from './git-runtime.mjs';

let studio;
const key = randomBytes(24).toString('hex');
const projects = new Map();
const library = path.resolve(process.env.OPENFILM_LIBRARY || '');
function safeError(error) { return String(error?.message || 'OpenFilm操作失败。').split(key).join('[local-key]').slice(0, 1200); }
function ownedFolder(folder) {
  const resolved = path.resolve(folder);
  if (!resolved.startsWith(library + path.sep)) throw new Error('Project is outside the owned OpenFilm library.');
  return resolved;
}
async function api(route, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(`${studio.origin}${route}`, {
    method, headers: { 'x-studio-key': key, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120000),
  });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || 'OpenFilm请求失败。'), { status: response.status });
  return result;
}

try {
  for (const name of ['OPENFILM_HOME', 'OPENFILM_SHARED_HOME', 'OPENFILM_LIBRARY', 'OPENFILM_EXPORTS', 'OPENFILM_SAVED']) {
    if (!process.env[name] || !path.isAbsolute(process.env[name])) throw new Error('Owned OpenFilm data directories must be configured.');
  }
  if (process.env.OPENFILM_LOCAL_ONLY !== '1') throw new Error('Local-only OpenFilm integration is required.');
  const git = await configureWorkerGit();
  const entry = path.resolve(process.env.GUANGXUAN_OPENFILM_ENTRY || '');
  const guard = path.resolve(path.dirname(entry), '../../src/guangxuan.mjs');
  if (!(await readFile(entry, 'utf8')).includes('guangxuan.mjs') || !(await readFile(guard, 'utf8')).includes('process.env.OPENFILM_LOCAL_ONLY')) throw new Error('OpenFilm local-only integration is not installed.');
  const { startStudio } = await import(pathToFileURL(entry).href);
  studio = await startStudio({ port: 0, key, advertise: false, stays: true, openBrowser: () => {} });
  process.send?.({ type: 'ready', origin: studio.origin, filmOrigin: studio.filmOrigin, gitAvailable: git.available });
} catch (error) {
  process.send?.({ type: 'failed', error: safeError(error) });
  process.exitCode = 1;
}

process.on('message', async message => {
  if (!message?.id || !studio) return;
  try {
    let result;
    if (message.action === 'open') {
      const opened = await api('/api/open', { path: ownedFolder(message.folder), fallback: 0, now: false });
      projects.set(opened.project.id, ownedFolder(message.folder));
      result = { nativeProjectId: opened.project.id, privateUrl: opened.url };
    } else if (message.action === 'close') {
      await studio.close();
      process.send?.({ id: message.id, result: { closed: true } });
      process.exit(0);
      return;
    } else {
      const id = message.nativeProjectId;
      if (!projects.has(id)) throw new Error('Project has not been opened by this bridge.');
      const route = `/api/projects/${encodeURIComponent(id)}`;
      if (message.action === 'read') result = await api(route);
      else if (message.action === 'files') result = await api(`${route}/files`);
      else if (message.action === 'edit') result = await api(`${route}/edit`, { base: message.base, ops: message.ops });
      else if (message.action === 'export') result = await api(`${route}/exports`, message.spec);
      else if (message.action === 'exports') result = await api(`${route}/exports`);
      else throw new Error('Unknown OpenFilm bridge operation.');
    }
    process.send?.({ id: message.id, result });
  } catch (error) { process.send?.({ id: message.id, error: safeError(error), status: error.status || 502 }); }
});

process.on('disconnect', () => { Promise.resolve(studio?.close()).finally(() => process.exit(0)); });
