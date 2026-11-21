import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork, execFile } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { AppError } from './errors.mjs';
import { renameWithRetry } from './atomic-file.mjs';
import { findAnimationBrowser } from '../animation/render.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OWNER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const TEXT_EXTENSION = /\.(?:[cm]?[jt]sx?|css|json|svg|txt|glsl|vert|frag|wgsl)$/i;
const ASSET_EXTENSION = /\.(?:mp4|mov|webm|m4v|mp3|wav|m4a|aac|ogg|flac|png|jpe?g|webp|gif|avif|svg)$/i;
const ACTIVE = new Set(['queued', 'running']);
const fail = (status, message, code = 'REMOTION_PROJECT_INVALID') => new AppError(status, message, code);
const cancelled = () => Object.assign(fail(499, 'Remotion任务已取消。', 'REMOTION_CANCELLED'), { name: 'AbortError' });
const clone = value => JSON.parse(JSON.stringify(value));
const digest = value => createHash('sha256').update(value).digest('hex');
const within = (root, candidate) => { const relative = path.relative(root, candidate); return relative === '' || !relative.startsWith('..') && !path.isAbsolute(relative); };

export function remotionSourcePath(value) {
  if (typeof value !== 'string' || value.length > 200 || !value || value.includes('\\') || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..' || /[:<>"|?*\x00-\x1f]/.test(part) || part !== part.trimEnd() || part.endsWith('.') || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw fail(400, '源码文件路径无效，请使用工程内的相对路径。');
  if (!TEXT_EXTENSION.test(value) || /(?:^|\/)(?:node_modules|\.git|\.env[^/]*)(?:\/|$)/i.test(value) || /^(?:package(?:-lock)?\.json|tsconfig\.json|remotion\.config\.[^/]+)$/i.test(value) || /^public\/media\//i.test(value)) throw fail(400, '此文件类型或保留路径不能作为生成源码。');
  return value;
}
function properties(value = {}) {
  let encoded;
  try { encoded = JSON.stringify(value); } catch { throw fail(400, '输入参数需要可保存的JSON。'); }
  if (!encoded || Buffer.byteLength(encoded) > 512 * 1024) throw fail(413, '输入参数超过512KiB。');
  const parsed = JSON.parse(encoded);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw fail(400, '输入参数需要JSON对象。');
  function visit(item, depth = 0) {
    if (depth > 32) throw fail(400, '输入参数嵌套过深。');
    if (item && typeof item === 'object') for (const [key, child] of Object.entries(item)) { if (['__proto__', 'prototype', 'constructor'].includes(key)) throw fail(400, '输入参数包含保留字段。'); visit(child, depth + 1); }
  }
  visit(parsed); return parsed;
}
function sourceFiles(input, previous = []) {
  if (!Array.isArray(input) || input.length > 128) throw fail(400, '源码需要文件列表，最多128个文件。');
  const files = new Map(previous.map(file => [file.path, file.content]));
  const seen = new Set();
  for (const file of input) {
    const relative = remotionSourcePath(file?.path), key = relative.toLowerCase();
    if (seen.has(key) || [...files.keys()].some(item => item.toLowerCase() === key && item !== relative)) throw fail(400, '源码文件路径重复。');
    if (typeof file.content !== 'string' || Buffer.byteLength(file.content) > 200 * 1024) throw fail(413, '每个源码文件最多200KiB。');
    seen.add(key); files.set(relative, file.content);
  }
  const result = [...files].map(([relative, content]) => ({ path: relative, content })).sort((a, b) => a.path.localeCompare(b.path));
  if (!result.length || result.length > 128 || result.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0) > 2 * 1024 * 1024) throw fail(413, '工程源码需有1至128个文件，总容量不超过2MiB。');
  return result;
}
async function noLinks(root, candidate, missing = false) {
  if (!within(root, candidate)) throw fail(403, '文件超出Remotion工程目录。', 'REMOTION_STORAGE_INVALID');
  let current = root;
  for (const part of ['', ...path.relative(root, candidate).split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    try { const info = await lstat(current); if (info.isSymbolicLink()) throw fail(403, 'Remotion工程不能使用文件链接。', 'REMOTION_STORAGE_INVALID'); }
    catch (error) { if (missing && error.code === 'ENOENT') return; throw error; }
  }
}

/** Generated components are compiled by a fixed worker and run only in its isolated browser. */
export async function createRemotionProjectsService({ dataDir, root, resolveAsset, onJob = () => {}, workerPath = path.join(HERE, 'remotion-project-worker.mjs'), idleTimeoutMs = 180000, workerExitTimeoutMs = 5000 } = {}) {
  if (!dataDir || !root) throw fail(500, 'Remotion工程服务未配置。');
  const storage = path.resolve(dataDir, 'remotion-projects'), engineRoot = path.resolve(root);
  await mkdir(storage, { recursive: true });
  if ((await lstat(storage)).isSymbolicLink()) throw fail(403, 'Remotion存储目录不能为链接。');
  const actualStorage = await realpath(storage), jobs = new Map(), locks = new Map(), writes = new WeakMap(), importedArchives = new Set(), workerDrains = new Set(), admissions = new Set();
  let closed = false, tail = Promise.resolve();
  const ensureOpen = () => { if (closed) throw fail(503, 'Remotion服务正在关闭。', 'REMOTION_CLOSED'); };
  function ownerId(value) { if (typeof value !== 'string' || !OWNER.test(value)) throw fail(400, '项目编号不正确。'); return value; }
  function sourceId(value) { if (typeof value !== 'string' || !UUID.test(value)) throw fail(404, 'Remotion工程不存在。', 'REMOTION_PROJECT_NOT_FOUND'); return value.toLowerCase(); }
  async function location(projectId, id, { create = false } = {}) {
    const directory = path.join(storage, ownerId(projectId), sourceId(id));
    await noLinks(storage, directory, true);
    if (create) await mkdir(directory, { recursive: true });
    else {
      try { await noLinks(storage, directory); if (!(await lstat(directory)).isDirectory() || !within(actualStorage, await realpath(directory))) throw new Error('Invalid'); }
      catch { throw fail(404, 'Remotion工程不存在或不属于此项目。', 'REMOTION_PROJECT_NOT_FOUND'); }
    }
    return directory;
  }
  async function atomic(filename, value) {
    await noLinks(storage, filename, true); const temporary = filename + '.' + randomUUID() + '.tmp';
    await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
    await noLinks(storage, filename, true); await renameWithRetry(temporary, filename);
  }
  async function metadata(projectId, id) {
    const directory = await location(projectId, id), filename = path.join(directory, 'metadata.json');
    await noLinks(storage, filename);
    let value; try { value = JSON.parse(await readFile(filename, 'utf8')); } catch { throw fail(404, 'Remotion工程记录不存在。', 'REMOTION_PROJECT_NOT_FOUND'); }
    if (value.projectId !== projectId || value.id !== sourceId(id) || !Number.isSafeInteger(value.revision) || value.revision < 1) throw fail(409, 'Remotion工程记录损坏。', 'REMOTION_METADATA_INVALID');
    return { directory, value, sourceRoot: path.join(directory, 'revisions', String(value.revision)) };
  }
  function serial(key, operation) { const result = (locks.get(key) || Promise.resolve()).catch(() => {}).then(operation); locks.set(key, result); result.finally(() => { if (locks.get(key) === result) locks.delete(key); }).catch(() => {}); return result; }
  function requireRevision(value, expected) { if (!Number.isSafeInteger(expected) || expected !== value.revision) throw fail(409, '源码版本已变化，请重新读取后再修改或渲染。', 'REMOTION_REVISION_CONFLICT'); }
  async function read(projectId, id) {
    ensureOpen(); const record = await metadata(projectId, id), files = [];
    for (const item of record.value.files) {
      const relative = remotionSourcePath(item.path), filename = path.join(record.sourceRoot, ...relative.split('/')); await noLinks(storage, filename);
      const content = await readFile(filename, 'utf8'); if (digest(content) !== item.sha256) throw fail(409, '源码文件已从工程外修改，请重新保存。', 'REMOTION_SOURCE_CHANGED');
      files.push({ path: relative, content });
    }
    return { ...clone(record.value), files };
  }
  async function saveRevision(projectId, id, input, previous, archiveAssets = []) {
    if (previous?.ownerCreatedAt && input.ownerCreatedAt !== undefined && input.ownerCreatedAt !== previous.ownerCreatedAt) throw fail(409, '父项目版本已变化。', 'REMOTION_OWNER_CHANGED');
    const directory = await location(projectId, id, { create: !previous }), revision = previous ? previous.revision + 1 : 1;
    const before = previous ? await read(projectId, id) : null;
    let files = sourceFiles(input.files || [], before?.files || []);
    if (input.deletedFiles !== undefined) {
      if (!Array.isArray(input.deletedFiles) || input.deletedFiles.length > 128) throw fail(400, '移除文件列表不正确。');
      const deleted = new Set(input.deletedFiles.map(remotionSourcePath)); files = files.filter(file => !deleted.has(file.path));
    }
    files = sourceFiles(files);
    const entryPoint = remotionSourcePath(input.entryPoint || previous?.entryPoint || (files.some(file => file.path === 'src/index.tsx') ? 'src/index.tsx' : files[0].path));
    if (!/\.[jt]sx?$/i.test(entryPoint) || !files.some(file => file.path === entryPoint)) throw fail(400, '入口必须是已保存的React/TypeScript源码文件。');
    const compositionId = input.compositionId === undefined ? previous?.compositionId || '' : input.compositionId;
    if (typeof compositionId !== 'string' || compositionId.length > 160 || /[\x00-\x1f]/.test(compositionId)) throw fail(400, 'Composition编号不正确。');
    const inputProps = properties(input.inputProps === undefined ? previous?.inputProps || {} : input.inputProps);
    const title = input.title === undefined ? previous?.title || 'Remotion动画工程' : input.title;
    if (typeof title !== 'string' || !title.trim() || title.length > 160) throw fail(400, '工程标题需为1至160字。');
    const staging = path.join(directory, 'revisions', '.stage-' + randomUUID()), destination = path.join(directory, 'revisions', String(revision));
    await noLinks(storage, staging, true); await mkdir(staging, { recursive: true });
    let published = false;
    try {
      for (const file of files) { const filename = path.join(staging, ...file.path.split('/')); await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, file.content, { mode: 0o600, flag: 'wx' }); }
      await mkdir(path.join(staging, 'public'), { recursive: true });
      const assets = new Map();
      for (const item of previous?.assets || []) {
        const from = path.join(directory, 'revisions', String(previous.revision), 'public', item.publicPath), to = path.join(staging, 'public', item.publicPath);
        await noLinks(storage, from); const bytes = await readFile(from); if (digest(bytes) !== item.sha256) throw fail(409, '工程素材已变化。', 'REMOTION_ASSET_CHANGED');
        await mkdir(path.dirname(to), { recursive: true }); await writeFile(to, bytes, { mode: 0o600, flag: 'wx' }); assets.set(item.assetId, clone(item));
      }
      if (input.assets !== undefined) {
        if (!Array.isArray(input.assets) || input.assets.length > 32 || !resolveAsset) throw fail(400, '请选择最多32项当前项目素材。');
        for (const item of input.assets) {
          if (typeof item?.assetId !== 'string' || !OWNER.test(item.assetId)) throw fail(400, '素材编号不正确。');
          if (assets.has(item.assetId)) continue;
          const asset = await resolveAsset(projectId, item.assetId);
          const filename = asset?.path || asset?.filename;
          if (typeof filename !== 'string' || !path.isAbsolute(filename) || !ASSET_EXTENSION.test(filename)) throw fail(400, '此素材不能加入Remotion工程。');
          const info = await lstat(filename); if (!info.isFile() || info.isSymbolicLink() || info.size > 512 * 1024 * 1024) throw fail(400, '素材文件无效或超过512MiB。');
          const publicPath = 'media/' + item.assetId + path.extname(filename).toLowerCase(), target = path.join(staging, 'public', publicPath);
          await mkdir(path.dirname(target), { recursive: true }); await copyFile(filename, target);
          const bytes = await readFile(target); assets.set(item.assetId, { assetId: item.assetId, publicPath, name: String(asset.name || path.basename(filename)).slice(0, 250), type: asset.type || '', bytes: bytes.length, sha256: digest(bytes) });
        }
      }
      for (const item of archiveAssets) {
        const target = path.join(staging, 'public', item.publicPath); await mkdir(path.dirname(target), { recursive: true }); await copyFile(item.filename, target);
        const { filename, ...record } = item; assets.set(item.assetId, record);
      }
      if ([...assets.values()].reduce((sum, item) => sum + item.bytes, 0) > 1024 * 1024 * 1024) throw fail(413, '工程素材总容量超过1GiB。');
      await writeFile(path.join(staging, 'package.json'), JSON.stringify({ name: 'gx-remotion-source', private: true, type: 'module' }));
      await writeFile(path.join(staging, 'tsconfig.json'), JSON.stringify({ compilerOptions: { jsx: 'react-jsx', module: 'ESNext', target: 'ES2020', moduleResolution: 'Bundler', esModuleInterop: true, skipLibCheck: true } }));
      await noLinks(storage, destination, true); await renameWithRetry(staging, destination); published = true;
      const ownerCreatedAt = input.ownerCreatedAt === undefined ? previous?.ownerCreatedAt || '' : input.ownerCreatedAt;
      if (typeof ownerCreatedAt !== 'string' || ownerCreatedAt.length > 100) throw fail(400, '父项目版本标记不正确。');
      const value = { id, projectId, ownerCreatedAt, title: title.trim(), revision, entryPoint, compositionId, inputProps, files: files.map(file => ({ path: file.path, bytes: Buffer.byteLength(file.content), sha256: digest(file.content) })), assets: [...assets.values()], createdAt: previous?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
      await atomic(path.join(directory, 'metadata.json'), value); return { ...clone(value), files };
    } finally { if (!published && within(storage, staging)) await rm(staging, { recursive: true, force: true }).catch(() => {}); }
  }
  async function create(projectId, input = {}) { ensureOpen(); ownerId(projectId); const id = randomUUID(); return serial(projectId + '/' + id, async () => { try { return await saveRevision(projectId, id, input); } catch (error) { const orphan = path.join(storage, projectId, id); if (within(storage, orphan)) { await noLinks(storage, orphan, true); await rm(orphan, { recursive: true, force: true }).catch(() => {}); } throw error; } }); }
  async function update(projectId, id, input = {}) { ensureOpen(); return serial(ownerId(projectId) + '/' + sourceId(id), async () => { const previous = await metadata(projectId, id); requireRevision(previous.value, input.expectedRevision); return saveRevision(projectId, id, input, previous.value); }); }
  async function withRevision(projectId, id, expectedRevision, operation) {
    ensureOpen();
    if (typeof operation !== 'function') throw fail(400, '版本事务需要内部操作。');
    return serial(ownerId(projectId) + '/' + sourceId(id), async () => {
      const record = await metadata(projectId, id); requireRevision(record.value, expectedRevision);
      // Only trusted host code supplies this callback. It may read this source
      // but must not recursively update the same engine while holding its lock.
      return operation(clone(record.value));
    });
  }
  async function list(projectId) {
    ensureOpen(); const parent = path.join(storage, ownerId(projectId)); await noLinks(storage, parent, true);
    let entries; try { entries = await readdir(parent, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const result = [];
    for (const entry of entries) if (entry.isDirectory() && !entry.isSymbolicLink() && UUID.test(entry.name)) { const record = await metadata(projectId, entry.name); const { files, ...summary } = record.value; result.push({ ...summary, fileCount: files.length }); }
    return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  function publicJob(job) { const { controller, completion, child, ...value } = job; return clone(value); }
  async function emit(job) { const value = publicJob(job), pending = (writes.get(job) || Promise.resolve()).catch(() => {}).then(async () => { await atomic(path.join(storage, job.projectId, job.remotionProjectId, 'jobs', job.id, 'job.json'), value); const publicValue = clone(value); if (publicValue.result) delete publicValue.result.outputPath; try { await onJob(publicValue); } catch {} }); writes.set(job, pending); return pending; }
  async function worker(job, request) {
    if (closed || job.controller.signal.aborted) throw cancelled();
    const browserExecutable = await findAnimationBrowser(), scratch = path.join(storage, '.tmp', job.id.slice(0, 12)); await noLinks(storage, scratch, true); await mkdir(scratch, { recursive: true });
    const environment = {};
    for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'COMSPEC', 'ProgramFiles', 'ProgramFiles(x86)', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'USERNAME', 'USERDOMAIN', 'HOMEDRIVE', 'HOMEPATH']) if (process.env[key]) environment[key] = process.env[key];
    // Edge needs the Windows account directories to locate its runtime. Its
    // actual browser profile is a fresh renderer-created folder below TEMP.
    for (const key of ['TEMP', 'TMP']) environment[key] = scratch;
    if (closed || job.controller.signal.aborted) { await rm(scratch, { recursive: true, force: true }).catch(() => {}); throw cancelled(); }
    return new Promise((resolve, reject) => {
      const child = fork(workerPath, [], { execPath: process.execPath, execArgv: [], cwd: request.sourceRoot, windowsHide: true, env: environment, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      job.child = child;
      let terminal, settled = false, closeSeen = false, errorTail = '', timer, cancelTimer, drainTimer, hardDrainTimer, killPromise, resolveDrain, rejectDrain;
      const drain = new Promise((yes, no) => { resolveDrain = yes; rejectDrain = no; }); drain.catch(() => {}); workerDrains.add(drain);
      const clearTimers = () => { clearTimeout(timer); clearTimeout(cancelTimer); clearTimeout(drainTimer); clearTimeout(hardDrainTimer); };
      const forceExit = () => {
        if (killPromise) return killPromise;
        killPromise = new Promise(done => {
          if (process.platform === 'win32' && Number.isInteger(child.pid)) execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 4000 }, () => { if (!closeSeen) child.kill('SIGKILL'); done(); });
          else { child.kill('SIGKILL'); done(); }
        });
        // An OS failure to terminate our own child is reported, never treated as
        // a successful close that would let callers delete its still-busy CWD.
        hardDrainTimer = setTimeout(() => {
          if (closeSeen || settled) return;
          settled = true; clearTimers(); job.controller.signal.removeEventListener('abort', stop); closed = true;
          const error = fail(503, 'Remotion进程未能退出，工程目录仍在使用；请关闭应用后重试。', 'REMOTION_WORKER_EXIT_FAILED');
          rejectDrain(error); reject(error);
        }, 8000);
        return killPromise;
      };
      const acknowledge = (error, value) => {
        if (terminal || settled) return;
        terminal = { error, value }; clearTimeout(timer); clearTimeout(cancelTimer);
        // A terminal IPC message means work completed; its sender can still
        // own file handles and its source CWD. Do not resolve until real close.
        drainTimer = setTimeout(() => {
          if (!terminal.error) terminal.error = fail(503, 'Remotion已返回结果但没有正常退出，已停止其进程。', 'REMOTION_WORKER_DRAIN_TIMEOUT');
          void forceExit();
        }, Math.max(100, Math.min(30000, Number(workerExitTimeoutMs) || 5000)));
      };
      const stop = () => {
        if (terminal || settled) return;
        if (child.connected) child.send({ type: 'cancel' }, () => {});
        cancelTimer = setTimeout(() => { acknowledge(cancelled()); void forceExit(); }, 8000);
      };
      const reset = () => { if (terminal || settled) return; clearTimeout(timer); timer = setTimeout(() => { acknowledge(fail(504, '渲染长时间没有进度，请检查组件循环或单帧计算。', 'REMOTION_IDLE_TIMEOUT')); void forceExit(); }, idleTimeoutMs); };
      reset(); job.controller.signal.addEventListener('abort', stop, { once: true });
      child.stderr.on('data', chunk => { errorTail = (errorTail + chunk).slice(-2000); });
      child.on('message', message => {
        if (terminal || settled) return;
        reset();
        if (message?.type === 'progress') { job.progress = Math.max(job.progress, Math.min(.99, Number(message.progress) || 0)); job.updatedAt = new Date().toISOString(); void emit(job).catch(() => {}); }
        if (message?.type === 'result') acknowledge(job.controller.signal.aborted ? cancelled() : null, message.result);
        if (message?.type === 'error') acknowledge(job.controller.signal.aborted ? cancelled() : fail(422, String(message.message || 'Remotion执行失败。').slice(0, 2000), message.code || 'REMOTION_EXECUTION_FAILED'));
      });
      child.on('error', () => acknowledge(fail(503, '无法启动Remotion隔离渲染进程。', 'REMOTION_WORKER_FAILED')));
      child.on('close', async code => {
        closeSeen = true; clearTimers(); job.controller.signal.removeEventListener('abort', stop);
        if (killPromise) await killPromise;
        if (within(storage, scratch)) await rm(scratch, { recursive: true, force: true }).catch(() => {});
        job.child = undefined; workerDrains.delete(drain); resolveDrain();
        if (settled) return;
        settled = true;
        if (!terminal) terminal = { error: job.controller.signal.aborted ? cancelled() : fail(422, `Remotion进程提前退出${code === null ? '' : '（' + code + '）'}。${errorTail.slice(-900)}`, 'REMOTION_WORKER_FAILED') };
        else if (!terminal.error && code !== 0) terminal.error = fail(422, 'Remotion进程未正常结束，结果未标记为完成。', 'REMOTION_WORKER_FAILED');
        terminal.error ? reject(terminal.error) : resolve(terminal.value);
      });
      child.send({ type: 'run', ...request, engineRoot, browserExecutable }, error => { if (error) acknowledge(fail(503, '无法提交Remotion渲染任务。', 'REMOTION_WORKER_FAILED')); }); if (job.controller.signal.aborted) stop();
    });
  }
  async function enqueue(projectId, id, options = {}, kind) {
    ensureOpen(); let releaseAdmission; const admission = new Promise(resolve => { releaseAdmission = resolve; }); admissions.add(admission);
    try {
    const record = await metadata(projectId, id); requireRevision(record.value, options.expectedRevision); ensureOpen();
    const inputProps = options.inputProps === undefined ? record.value.inputProps : properties(options.inputProps), compositionId = options.compositionId ?? record.value.compositionId;
    if (typeof compositionId !== 'string' || compositionId.length > 160) throw fail(400, 'Composition编号无效。');
    const jobId = randomUUID(), outputDirectory = path.join(record.directory, 'jobs', jobId); await mkdir(outputDirectory, { recursive: true });
    const job = { id: jobId, jobId, projectId, remotionProjectId: id, remotionId: id, ownerCreatedAt: record.value.ownerCreatedAt || '', revision: record.value.revision, kind, status: 'queued', progress: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), controller: new AbortController() };
    jobs.set(jobId, job); await emit(job);
    const externalAbort = () => job.controller.abort(); options.signal?.addEventListener('abort', externalAbort, { once: true }); if (options.signal?.aborted) externalAbort();
    job.completion = tail.catch(() => {}).then(async () => {
      try {
        if (closed || job.controller.signal.aborted) throw cancelled();
        job.status = 'running'; await emit(job);
        const result = await worker(job, { kind, sourceRoot: record.sourceRoot, entryPoint: record.value.entryPoint, compositionId, inputProps, outputDirectory, frames: options.frames, range: options.range });
        if (job.controller.signal.aborted) throw cancelled();
        job.status = 'complete'; job.progress = 1; job.result = { ...result, revision: job.revision };
      } catch (error) { job.status = error.name === 'AbortError' || job.controller.signal.aborted ? 'cancelled' : 'error'; job.error = { code: error.code || 'REMOTION_EXECUTION_FAILED', message: String(error.message || error).slice(0, 2000) }; }
      finally { job.updatedAt = new Date().toISOString(); options.signal?.removeEventListener('abort', externalAbort); await emit(job); }
      return publicJob(job);
    });
    tail = job.completion; return job;
    } finally { admissions.delete(admission); releaseAdmission(); }
  }
  async function render(projectId, id, options = {}) {
    const kind = options.kind || 'video'; if (!['preview', 'video'].includes(kind)) throw fail(400, '请选择PNG预览或MP4渲染。');
    if (kind === 'preview' && options.frames !== undefined && (!Array.isArray(options.frames) || !options.frames.length || options.frames.length > 16 || options.frames.some(frame => !Number.isSafeInteger(frame) || frame < 0))) throw fail(400, 'PNG预览需要1至16个有效帧位置。');
    const job = await enqueue(projectId, id, options, kind); return { jobId: job.id };
  }
  async function inspect(projectId, id, options = {}) {
    const record = await metadata(projectId, id), job = await enqueue(projectId, id, { ...options, expectedRevision: options.expectedRevision ?? record.value.revision }, 'inspect');
    const result = await job.completion; if (result.status !== 'complete') throw fail(result.status === 'cancelled' ? 499 : 422, result.error?.message || '无法读取Composition。', result.error?.code || 'REMOTION_INSPECT_FAILED');
    return { ...result.result, jobId: job.id, remotionId: id, ownerCreatedAt: record.value.ownerCreatedAt || '', revision: job.revision };
  }
  async function getJob(projectId, jobId) {
    ensureOpen(); ownerId(projectId); sourceId(jobId);
    const current = jobs.get(jobId); if (current) { if (current.projectId !== projectId) throw fail(404, 'Remotion任务不属于此项目。', 'REMOTION_JOB_NOT_FOUND'); return publicJob(current); }
    for (const item of await list(projectId)) {
      const filename = path.join(storage, projectId, item.id, 'jobs', jobId, 'job.json');
      try { await noLinks(storage, filename); const saved = JSON.parse(await readFile(filename, 'utf8')); if (saved.projectId !== projectId || saved.id !== jobId || saved.remotionProjectId !== item.id || saved.remotionId !== item.id) continue; if (ACTIVE.has(saved.status)) { saved.status = 'error'; saved.error = { code: 'REMOTION_INTERRUPTED', message: '服务重启前的任务未自动重放，请核对后重新渲染。' }; } return saved; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    throw fail(404, 'Remotion任务不存在。', 'REMOTION_JOB_NOT_FOUND');
  }
  async function cancelJob(projectId, jobId) { const job = await getJob(projectId, jobId), live = jobs.get(jobId); if (live && ACTIVE.has(live.status)) { live.controller.abort(); if (live.status === 'queued') { live.status = 'cancelled'; await emit(live); } } return live ? publicJob(live) : job; }
  async function file(projectId, jobId, filename) {
    const job = await getJob(projectId, jobId), allowed = [...(job.kind === 'video' && job.result?.outputPath ? ['video.mp4'] : []), ...(job.result?.frames || []).map(frame => frame.file)];
    if (!/^(?:video\.mp4|frame-\d{2}\.png)$/.test(filename || '') || job.status !== 'complete' || !allowed.includes(filename)) throw fail(404, '渲染结果尚未完成或文件不存在。', 'REMOTION_FILE_NOT_FOUND');
    const target = path.join(storage, projectId, job.remotionProjectId, 'jobs', jobId, filename); await noLinks(storage, target); if (!(await lstat(target)).isFile()) throw fail(404, '渲染文件不存在。');
    return { path: target, mimeType: filename.endsWith('.png') ? 'image/png' : 'video/mp4' };
  }
  async function exportArchive(projectId, id, { signal } = {}) {
    return serial(ownerId(projectId) + '/' + sourceId(id), async () => {
    const value = await read(projectId, id), record = await metadata(projectId, id), assets = [];
    for (const item of value.assets || []) {
      if (signal?.aborted) throw cancelled();
      const scope = path.join(record.sourceRoot, 'public'), filename = path.join(scope, item.publicPath); await noLinks(storage, filename);
      const bytes = await readFile(filename); if (bytes.length !== item.bytes || digest(bytes) !== item.sha256) throw fail(409, 'Remotion归档素材已变化。', 'REMOTION_ASSET_CHANGED');
      assets.push({ ...clone(item), filename, scope });
    }
    const { files, title, entryPoint, compositionId, inputProps, revision, ownerCreatedAt } = value;
    return { title, entryPoint, compositionId, inputProps, files, assets, revision, ownerCreatedAt };
    });
  }
  async function importArchive(projectId, input, { ownerCreatedAt = '', entriesRoot } = {}) {
    ensureOpen(); ownerId(projectId);
    if (typeof entriesRoot !== 'string' || !path.isAbsolute(entriesRoot) || !Array.isArray(input?.assets) || input.assets.length > 32) throw fail(400, 'Remotion归档恢复范围无效。');
    const actualRoot = await realpath(entriesRoot), assets = [], paths = new Set(), ids = new Set();
    for (const item of input.assets) {
      if (!item || typeof item.assetId !== 'string' || !OWNER.test(item.assetId) || typeof item.publicPath !== 'string' || !/^media\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(item.publicPath) || !ASSET_EXTENSION.test(item.publicPath) || paths.has(item.publicPath.toLowerCase()) || ids.has(item.assetId) || !Number.isSafeInteger(item.bytes) || item.bytes < 1 || item.bytes > 512 * 1024 * 1024 || !/^[a-f0-9]{64}$/i.test(item.sha256 || '') || typeof item.filename !== 'string' || !path.isAbsolute(item.filename)) throw fail(400, 'Remotion归档素材清单无效。');
      await noLinks(entriesRoot, item.filename); if (!within(actualRoot, await realpath(item.filename)) || !(await lstat(item.filename)).isFile()) throw fail(403, 'Remotion归档素材超出恢复范围。');
      const bytes = await readFile(item.filename); if (bytes.length !== item.bytes || digest(bytes) !== item.sha256.toLowerCase()) throw fail(400, 'Remotion归档素材哈希不匹配。');
      paths.add(item.publicPath.toLowerCase()); ids.add(item.assetId); assets.push({ assetId: item.assetId, publicPath: item.publicPath, name: String(item.name || item.publicPath).slice(0, 250), type: String(item.type || '').slice(0, 30), bytes: item.bytes, sha256: item.sha256.toLowerCase(), filename: item.filename });
    }
    if (assets.reduce((sum, item) => sum + item.bytes, 0) > 1024 * 1024 * 1024) throw fail(413, '归档素材超过容量。');
    const id = randomUUID();
    const value = await serial(projectId + '/' + id, async () => { try { return await saveRevision(projectId, id, { title: input.title, entryPoint: input.entryPoint, compositionId: input.compositionId, inputProps: input.inputProps, files: input.files, ownerCreatedAt }, undefined, assets); } catch (error) { const orphan = path.join(storage, projectId, id); if (within(storage, orphan)) { await noLinks(storage, orphan, true); await rm(orphan, { recursive: true, force: true }).catch(() => {}); } throw error; } });
    importedArchives.add(projectId + '/' + id); return value;
  }
  async function discardArchive(projectId, id) {
    const key = ownerId(projectId) + '/' + sourceId(id);
    return serial(key, async () => {
      if (!importedArchives.has(key)) throw fail(403, '只能回滚本次恢复创建的Remotion工程。');
      const record = await metadata(projectId, id); if (record.value.revision !== 1) throw fail(409, '已编辑工程不能按恢复回滚。');
      let entries = []; try { entries = await readdir(path.join(record.directory, 'jobs')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (entries.length) throw fail(409, '已执行任务的工程不能按恢复回滚。');
      await noLinks(storage, record.directory); if (!within(storage, record.directory)) throw fail(403, '回滚目录超出范围。'); await rm(record.directory, { recursive: true }); importedArchives.delete(key); return { removed: true };
    });
  }
  async function close() {
    closed = true;
    for (const job of jobs.values()) if (ACTIVE.has(job.status)) job.controller.abort();
    await Promise.allSettled([...admissions]);
    await Promise.allSettled([...locks.values()]);
    for (const job of jobs.values()) if (ACTIVE.has(job.status)) job.controller.abort();
    await Promise.allSettled([...jobs.values()].map(job => job.completion).filter(Boolean));
    const drained = await Promise.allSettled([...workerDrains]);
    await Promise.allSettled([...jobs.values()].map(job => writes.get(job)).filter(Boolean));
    const failure = drained.find(item => item.status === 'rejected'); if (failure) throw failure.reason;
  }
  return { create, read, update, withRevision, list, inspect, render, getJob, cancelJob, file, exportArchive, importArchive, discardArchive, close };
}
