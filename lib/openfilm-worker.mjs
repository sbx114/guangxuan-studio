import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { configureWorkerGit } from './git-runtime.mjs';
import { normalizeNativeExport } from './native-export-capabilities.mjs';
import { prepareNativeExportDownload } from './native-export-download.mjs';
import { createNativeProjectCapabilities } from './native-project-capabilities.mjs';

let studio;
const key = randomBytes(24).toString('hex');
const projects = new Map();
const projectCapabilities = new Map();
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
      else if (['project-read', 'project-edit', 'project-undo'].includes(message.action)) {
        if (!projectCapabilities.has(id)) projectCapabilities.set(id, createNativeProjectCapabilities({ projectRoot: projects.get(id), nativeProjectId: id, api, route }));
        const service = projectCapabilities.get(id);
        if (message.action === 'project-read') result = await service.read({ section: message.section, args: message.args });
        else if (message.action === 'project-edit') result = await service.edit({ section: message.section, action: message.operation || message.projectAction, expectedRevision: message.expectedRevision, expectedFilmRevision: message.expectedFilmRevision, args: message.args, editScope: message.editScope });
        else result = await service.undo({ undoId: message.undoId, editScope: message.editScope });
      }
      else if ((message.action === 'edit' && message.strict) || message.action === 'restore') {
        const nativeRoot = path.dirname(path.resolve(process.env.GUANGXUAN_OPENFILM_ENTRY));
        const { changeProjectFilm } = await import(pathToFileURL(path.join(nativeRoot, 'film.mjs')).href);
        const { applyOps } = await import(pathToFileURL(path.join(nativeRoot, 'ops.mjs')).href);
        const { readFilm } = await import(pathToFileURL(path.resolve(nativeRoot, '../../src/film-doc.mjs')).href);
        const changed = await changeProjectFilm(projects.get(id), (value, current) => {
          if (current.rev !== message.base) throw Object.assign(new Error('工程已变化，请重新发送要求。'), { status: 409 });
          const next = message.action === 'restore' ? structuredClone(message.value) : applyOps(value, message.ops);
          const checked = readFilm(next);
          if (!checked.doc) throw new Error('编辑结果不是有效工程。');
          return { value: next, doc: checked.doc };
        }, message.action === 'restore' ? { undo: true } : { ops: message.ops });
        result = { rev: changed.rev, doc: changed.doc };
        // This undo restores film.html only. Its file watcher refreshes the edit;
        // the general put-back endpoint also resets and opens unrelated canvases.
      }
      else if (message.action === 'edit') result = await api(`${route}/edit`, { base: message.base, ops: message.ops });
      else if (message.action === 'export') {
        const spec = normalizeNativeExport(message.spec);
        if (message.base !== undefined) {
          if (typeof message.base !== 'string' || !/^[a-f0-9]{16}$/.test(message.base)) throw Object.assign(new Error('请先读取当前时间线，再开始导出。'), { status: 400, code: 'OPENFILM_REVISION_REQUIRED' });
          const current = await api(route);
          if (current.rev !== message.base) throw Object.assign(new Error('工程已变化，请重新核对后导出。'), { status: 409, code: 'OPENFILM_REVISION_CONFLICT' });
        }
        result = await api(`${route}/exports`, spec);
      }
      else if (message.action === 'cancel-export') {
        if (typeof message.exportId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(message.exportId)) throw Object.assign(new Error('导出任务编号无效。'), { status: 400, code: 'OPENFILM_EXPORT_INVALID' });
        const listed = await api(`${route}/exports`);
        if (!listed.exports?.some(job => job.id === message.exportId)) throw Object.assign(new Error('当前项目没有这个导出任务。'), { status: 404, code: 'OPENFILM_EXPORT_NOT_FOUND' });
        await api(`${route}/exports/${encodeURIComponent(message.exportId)}`, undefined, 'DELETE');
        result = { cancelled: true, exportId: message.exportId, ...(await api(`${route}/exports`)) };
      }
      else if (message.action === 'export-download') {
        if (typeof message.exportId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(message.exportId)) throw Object.assign(new Error('导出任务编号无效。'), { status: 400, code: 'OPENFILM_EXPORT_INVALID' });
        const listed = await api(`${route}/exports`), job = listed.exports?.find(job => job.id === message.exportId);
        result = await prepareNativeExportDownload({ exportsRoot: process.env.OPENFILM_EXPORTS, projectId: id, job });
      }
      else if (message.action === 'exports') result = await api(`${route}/exports`);
      else throw new Error('Unknown OpenFilm bridge operation.');
    }
    process.send?.({ id: message.id, result });
  } catch (error) { process.send?.({ id: message.id, error: safeError(error), status: error.status || 502, ...(error.code ? { code: error.code } : {}) }); }
});

process.on('disconnect', () => { Promise.resolve(studio?.close()).finally(() => process.exit(0)); });
