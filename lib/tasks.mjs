import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AppError } from './errors.mjs';

const ACTIVE = new Set(['queued', 'running', 'cancelling']);
const FINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
const RETRYABLE = new Set(['failed', 'cancelled']);
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const STATUS = new Map([
  ['queued', 'queued'], ['pending', 'queued'], ['running', 'running'], ['processing', 'running'], ['rendering', 'running'], ['analyzing', 'running'],
  ['cancelling', 'cancelling'], ['canceling', 'cancelling'], ['succeeded', 'succeeded'], ['success', 'succeeded'], ['complete', 'succeeded'], ['completed', 'succeeded'], ['done', 'succeeded'],
  ['failed', 'failed'], ['error', 'failed'], ['cancelled', 'cancelled'], ['canceled', 'cancelled'], ['interrupted', 'interrupted'],
]);
const now = () => new Date().toISOString();
const failure = (status, message, code) => new AppError(status, message, code);
const abortError = () => Object.assign(new Error('任务已取消。'), { name: 'AbortError', code: 'TASK_CANCELLED' });
const normalizedStatus = value => STATUS.get(typeof value === 'string' ? value.toLowerCase() : '');
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : '';

/** A persisted summary of local work. Runners, request bodies and credentials stay in memory. */
export async function createTaskService({ dataDir, projectName = async () => '', sensitiveStrings = () => [] } = {}) {
  if (!dataDir) throw failure(500, '任务存储目录尚未配置。', 'TASKS_NOT_CONFIGURED');
  const directory = path.resolve(dataDir, 'tasks'), filename = path.join(directory, 'index.json');
  await mkdir(directory, { recursive: true });
  const records = new Map(), controls = new Map(), sources = new Map(), external = new Map(), dedupe = new Map(), claims = new Map();
  let closed = false, writing = Promise.resolve();

  function cleanText(value, length = 320) {
    if (!['string', 'number'].includes(typeof value)) return '';
    let text = String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
    let secrets = [];
    try { const values = sensitiveStrings(); if (Array.isArray(values)) secrets = values; } catch { /* Redaction must not break task reporting. */ }
    for (const secret of secrets) if (typeof secret === 'string' && secret) text = text.split(secret).join('[密钥已隐藏]');
    text = text.replace(/\bBearer\s+[^\s,;"'<>]+/gi, 'Bearer [密钥已隐藏]')
      .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, '[密钥已隐藏]')
      .replace(/((?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|password|secret)\s*[=:]\s*)[^\s,;]+/gi, '$1[密钥已隐藏]')
      .replace(/(?:https?|file):\/\/[^\s<>"']+/gi, '[地址已隐藏]')
      .replace(/\b[A-Za-z]:[\\/][^\s<>"']+/g, '[本地路径已隐藏]')
      .replace(/\\\\[^\s<>"']+/g, '[本地路径已隐藏]')
      .replace(/(^|\s)\/(?:Users|home|tmp|var|private|opt|mnt|etc)(?:\/[^\s<>"']*)?/g, '$1[本地路径已隐藏]');
    return text.trim().slice(0, length);
  }
  function cleanError(error, defaultCode = 'TASK_FAILED') {
    if (!error) return null;
    const message = cleanText(typeof error === 'string' ? error : error.message, 600) || '任务未完成，请检查后重试。';
    const code = typeof error.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code) && cleanText(error.code, 80) === error.code ? error.code : defaultCode;
    return { code, message };
  }
  function projectId(value, optional = true) {
    if (optional && (value === undefined || value === null || value === '')) return '';
    if (typeof value !== 'string' || !ID.test(value)) throw failure(400, '项目编号不正确。', 'INVALID_PROJECT_ID');
    return value;
  }
  function safeOutputs(value, owner = '') {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 12).flatMap(item => {
      if (!item || typeof item !== 'object') return [];
      const url = item.url || item.href || item.downloadUrl;
      if (typeof url !== 'string' || url.length > 420 || /[\\%?#\s]/.test(url) || cleanText(url, 420) !== url) return [];
      const generic = /^\/api\/(?:video\/exports|project-bundles\/exports)\/[A-Za-z0-9_-]{1,128}\/file$/.test(url);
      const preview = /^\/api\/video\/previews\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,128}\.(?:jpg|png)$/.test(url);
      const native = /^\/api\/openfilm\/exports\/([A-Za-z0-9_-]{1,128})\/[A-Za-z0-9_-]{1,128}\/file$/.exec(url);
      if (!generic && !preview && !(native && owner && native[1] === owner)) return [];
      return [{ label: cleanText(item.label || item.name || '下载结果', 100), url }];
    });
  }
  const outputFrom = (result, owner) => safeOutputs(Array.isArray(result?.outputs) ? result.outputs : result?.downloadUrl ? [{ label: result.filename || '下载结果', url: result.downloadUrl }] : [], owner);
  function stored(record) {
    return {
      id: record.id, type: cleanText(record.type, 80), title: cleanText(record.title, 160), projectId: record.projectId,
      projectName: cleanText(record.projectName, 160), status: record.status, phase: cleanText(record.phase, 160),
      message: cleanText(record.message, 360), progress: record.progress, attempt: record.attempt,
      createdAt: record.createdAt, updatedAt: record.updatedAt,
      ...(record.startedAt ? { startedAt: record.startedAt } : {}), ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
      ...(record.error ? { error: cleanError(record.error) } : {}), outputs: safeOutputs(record.outputs, record.projectId),
      ...(record.sourceJobId && cleanText(record.sourceJobId, 128) === record.sourceJobId ? { sourceJobId: record.sourceJobId } : {}),
      ...(record.dedupeHash ? { dedupeHash: record.dedupeHash } : {}),
    };
  }
  function view(record) {
    const value = stored(record); delete value.dedupeHash;
    const control = controls.get(record.id), source = sources.get(record.id);
    return { ...value, canCancel: ACTIVE.has(record.status) && record.status !== 'cancelling' && Boolean(control?.controller || control?.cancel || source?.cancel), canRetry: RETRYABLE.has(record.status) && control?.safeRetry === true && typeof control.retry === 'function' };
  }
  function save() {
    const next = writing.catch(() => {}).then(async () => {
      const temp = path.join(directory, `.index.${randomUUID()}.tmp`);
      try {
        await writeFile(temp, JSON.stringify({ version: 1, items: [...records.values()].map(stored) }, null, 2) + '\n', { mode: 0o600 });
        await rename(temp, filename);
      } catch (error) { await unlink(temp).catch(() => {}); throw error; }
    });
    writing = next;
    return next;
  }
  function ensureOpen() { if (closed) throw failure(503, '任务服务正在关闭。', 'TASK_SERVICE_CLOSED'); }
  function find(id, filters = {}) {
    const record = typeof id === 'string' && ID.test(id) ? records.get(id) : null;
    if (!record || filters.projectId !== undefined && record.projectId !== projectId(filters.projectId, false)) throw failure(404, '找不到此任务。', 'TASK_NOT_FOUND');
    return record;
  }
  async function nameFor(id, fallback = '') {
    if (!id) return '';
    try { return cleanText(await projectName(id), 160) || cleanText(fallback, 160) || '未命名项目'; }
    catch { return cleanText(fallback, 160) || '已移除项目'; }
  }
  function keyHash(meta, key) {
    if (key === undefined || key === null || key === '') return '';
    if (typeof key !== 'string' || key.length > 2048) throw failure(400, '任务幂等编号不正确。', 'TASK_INVALID_IDEMPOTENCY_KEY');
    return createHash('sha256').update(`${projectId(meta?.projectId)}\0${key}`).digest('hex');
  }
  async function newRecord(meta = {}, hash = '') {
    ensureOpen();
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw failure(400, '任务摘要格式不正确。', 'TASK_INVALID_META');
    const owner = projectId(meta.projectId), name = await nameFor(owner, meta.projectName || meta.projectTitle);
    ensureOpen();
    if (hash && dedupe.has(hash)) return { record: find(dedupe.get(hash)), exists: true };
    if (records.size >= 10000) throw failure(503, '任务记录过多，请先整理任务存储。', 'TASK_RECORD_LIMIT');
    const stamp = now(), record = {
      id: randomUUID(), type: cleanText(meta.type || meta.kind || 'task', 80) || 'task', title: cleanText(meta.title || meta.label || '后台任务', 160) || '后台任务',
      projectId: owner, projectName: name, status: 'queued', phase: cleanText(meta.phase, 160) || '等待开始', message: '', progress: 0,
      attempt: 1, createdAt: stamp, updatedAt: stamp, outputs: [], ...(hash ? { dedupeHash: hash } : {}),
      ...(ID.test(meta.sourceJobId || meta.jobId || '') ? { sourceJobId: meta.sourceJobId || meta.jobId } : {}),
    };
    records.set(record.id, record); if (hash) dedupe.set(hash, record.id);
    await save(); return { record, exists: false };
  }
  async function create(meta) { return view((await newRecord(meta)).record); }
  function patchRecord(record, patch = {}, { retry = false } = {}) {
    const nextStatus = normalizedStatus(patch.status);
    if (FINAL.has(record.status) && !retry && nextStatus && nextStatus !== record.status) return false;
    if (nextStatus) record.status = record.status === 'cancelling' && ACTIVE.has(nextStatus) ? 'cancelling' : nextStatus;
    if (typeof patch.phase === 'string') record.phase = cleanText(patch.phase, 160);
    if (typeof patch.message === 'string') record.message = cleanText(patch.message, 360);
    if (Number.isFinite(patch.progress)) record.progress = Math.max(0, Math.min(100, Math.round(patch.progress * 100) / 100));
    if (Object.hasOwn(patch, 'error')) record.error = cleanError(patch.error);
    if (Object.hasOwn(patch, 'outputs')) record.outputs = safeOutputs(patch.outputs, record.projectId);
    if (typeof patch.downloadUrl === 'string') record.outputs = outputFrom(patch, record.projectId);
    if (record.status === 'running' && !record.startedAt) record.startedAt = now();
    if (record.status === 'succeeded') { record.progress = 100; record.error = null; }
    if (record.status === 'failed' && !record.error) record.error = cleanError('任务未完成，请检查后重试。');
    if (FINAL.has(record.status) && !record.finishedAt) record.finishedAt = now();
    record.updatedAt = now(); return true;
  }
  async function update(id, patch = {}) {
    ensureOpen(); const record = find(id);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw failure(400, '任务状态格式不正确。', 'TASK_INVALID_PATCH');
    if (Object.hasOwn(patch, 'projectId') && patch.projectId !== record.projectId) {
      const owner = projectId(patch.projectId, false);
      if (record.projectId) throw failure(409, '任务不能移到另一个项目。', 'TASK_PROJECT_CONFLICT');
      record.projectId = owner; record.projectName = await nameFor(owner);
    }
    if (!record.sourceJobId && ID.test(patch.sourceJobId || '')) record.sourceJobId = patch.sourceJobId;
    patchRecord(record, patch); await save(); return view(record);
  }
  async function refreshSource(id) {
    const source = sources.get(id), record = records.get(id);
    if (closed || !source || !record || !ACTIVE.has(record.status)) return;
    if (source.refreshing) return source.refreshing;
    source.refreshing = (async () => {
      try {
        const job = await source.read();
        if (closed || sources.get(id) !== source || !ACTIVE.has(record.status)) return;
        const patch = source.map ? await source.map(job) : job;
        if (patch && typeof patch === 'object') { patchRecord(record, patch); await save(); }
      } catch (error) {
        // A temporary source-read failure does not turn a running render into a failed render.
        if (!closed && sources.get(id) === source && ACTIVE.has(record.status)) {
          record.message = '暂时无法刷新任务状态，将自动重试。'; record.updatedAt = now(); await save();
        }
      } finally { source.refreshing = null; }
    })();
    return source.refreshing;
  }
  async function attachSource(id, source = {}) {
    ensureOpen(); const record = find(id);
    if (typeof source.read !== 'function') throw failure(400, '任务状态来源不正确。', 'TASK_SOURCE_REQUIRED');
    sources.set(id, { read: source.read, map: source.map, cancel: source.cancel, refreshing: null });
    const previous = controls.get(id) || {};
    controls.set(id, { ...previous, cancel: source.cancel, retry: source.retry, safeRetry: source.safeRetry === true });
    await refreshSource(id); return view(record);
  }
  async function list(filters = {}) {
    const owner = filters.projectId === undefined || filters.projectId === '' ? undefined : projectId(filters.projectId, false);
    let statuses;
    if (filters.status) {
      const requested = Array.isArray(filters.status) ? filters.status : String(filters.status).split(',');
      statuses = new Set(requested.map(normalizedStatus));
      if (statuses.has(undefined)) throw failure(400, '任务状态筛选不正确。', 'TASK_INVALID_STATUS');
    }
    await Promise.allSettled([...sources.keys()].filter(id => owner === undefined || records.get(id)?.projectId === owner).map(refreshSource));
    const items = [...records.values()].filter(item => owner === undefined || item.projectId === owner).filter(item => !statuses || statuses.has(item.status)).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).map(view);
    return { items, total: items.length };
  }
  async function get(id, filters = {}) { const record = find(id, filters); await refreshSource(id); return view(record); }

  async function execute(record, runner, control) {
    control.controller = new AbortController();
    control.cancelRequested = false;
    await update(record.id, { status: 'running', phase: '正在处理', error: null });
    const context = { taskId: record.id, signal: control.controller.signal, update: patch => FINAL.has(record.status) ? Promise.resolve(view(record)) : update(record.id, patch) };
    try {
      if (control.initialSignal?.aborted) throw abortError();
      const result = await runner(context);
      const stopped = control.controller.signal.aborted || control.cancelRequested;
      let committed = false;
      if (stopped && typeof control.acceptCommittedResult === 'function') {
        try { committed = control.acceptCommittedResult(result) === true; } catch {}
      }
      if (stopped && !committed) throw abortError();
      const resultHasOutputs = Array.isArray(result?.outputs) || typeof result?.downloadUrl === 'string';
      if (!closed) await update(record.id, { status: 'succeeded', phase: committed ? '停止前已提交' : '已完成', ...(committed ? { message: '编辑已提交，完成回执保留；可回到工程使用撤销。' } : {}), progress: 100, error: null, ...(resultHasOutputs ? { outputs: outputFrom(result, record.projectId) } : {}) });
      return result;
    } catch (error) {
      const cancelled = control.controller.signal.aborted || control.cancelRequested || error?.name === 'AbortError' || error?.code === 'TASK_CANCELLED';
      if (!closed) await update(record.id, { status: cancelled ? 'cancelled' : 'failed', phase: cancelled ? '已取消' : '未完成', ...(cancelled ? { error: null } : { error }) });
      throw cancelled ? abortError() : error;
    } finally { control.controller = null; control.initialSignal = null; control.detachSignal?.(); control.detachSignal = null; }
  }
  function notify(callback, id) { try { Promise.resolve(callback?.(id)).catch(() => {}); } catch { /* UI observers cannot break the work. */ } }
  function track(meta, runner, options = {}) {
    if (typeof runner !== 'function') return Promise.reject(failure(400, '任务执行器不正确。', 'TASK_RUNNER_REQUIRED'));
    let hash;
    try { ensureOpen(); hash = keyHash(meta, options.idempotencyKey); }
    catch (error) { return Promise.reject(error); }
    const type = cleanText(meta?.type || meta?.kind || 'task', 80) || 'task', existingClaim = hash && claims.get(hash);
    if (existingClaim) {
      if (type !== existingClaim.type) return Promise.reject(failure(409, '此幂等编号已用于另一种任务。', 'TASK_IDEMPOTENCY_CONFLICT'));
      if (existingClaim.id) notify(options.onTask, existingClaim.id); else existingClaim.listeners.push(options.onTask);
      const record = existingClaim.id && records.get(existingClaim.id);
      if (record && RETRYABLE.has(record.status)) return Promise.reject(failure(409, '此任务未完成，请使用任务中心的重试操作。', 'TASK_RETRY_REQUIRED'));
      return existingClaim.promise;
    }
    const claim = { type, id: '', listeners: [] };
    const promise = (async () => {
      const created = await newRecord(meta, hash), record = created.record;
      claim.id = record.id; notify(options.onTask, record.id); for (const callback of claim.listeners) notify(callback, record.id); claim.listeners.length = 0;
      if (created.exists) {
        if (record.type !== type) throw failure(409, '此幂等编号已用于另一种任务。', 'TASK_IDEMPOTENCY_CONFLICT');
        throw Object.assign(failure(409, record.status === 'succeeded' ? '此任务已完成，不能重复执行。' : '此任务已有记录，请在任务中心查看。', record.status === 'succeeded' ? 'TASK_ALREADY_COMPLETED' : 'TASK_RETRY_REQUIRED'), { taskId: record.id });
      }
      const control = { runner, retry: typeof options.retry === 'function' ? options.retry : runner, safeRetry: options.safeRetry === true, cancel: options.cancel, initialSignal: options.signal, acceptCommittedResult: options.acceptCommittedResult };
      controls.set(record.id, control);
      if (options.signal) {
        const aborted = () => { if (!FINAL.has(record.status)) void cancel(record.id).catch(() => {}); };
        options.signal.addEventListener('abort', aborted, { once: true });
        control.detachSignal = () => options.signal.removeEventListener('abort', aborted);
      }
      return execute(record, runner, control);
    })();
    claim.promise = promise;
    if (hash) claims.set(hash, claim);
    return promise;
  }
  async function cancel(id, filters = {}) {
    ensureOpen(); const record = find(id, filters), control = controls.get(id), source = sources.get(id);
    if (FINAL.has(record.status) || record.status === 'cancelling') return view(record);
    if (!control?.controller && typeof control?.cancel !== 'function' && typeof source?.cancel !== 'function') throw failure(409, '当前任务不能从任务中心取消。', 'TASK_CANCEL_UNAVAILABLE');
    const prior = record.status;
    control.cancelRequested = true;
    await update(id, { status: 'cancelling', phase: '正在取消' });
    control.controller?.abort(abortError());
    try {
      const callback = source?.cancel || control.cancel;
      const result = callback ? await callback({ taskId: id }) : null;
      if (source) {
        if (result && typeof result === 'object') { const patch = source.map ? await source.map(result) : result; if (patch) await update(id, patch); }
        await refreshSource(id);
      } else if (!control.controller && !closed) await update(id, { status: 'cancelled', phase: '已取消', error: null });
      return view(record);
    } catch (error) {
      if (!control.controller?.signal.aborted && !closed) { record.status = prior; control.cancelRequested = false; record.phase = '取消未完成'; record.error = cleanError(error, 'TASK_CANCEL_FAILED'); record.updatedAt = now(); await save(); }
      throw failure(502, cleanText(error?.message, 360) || '未能取消任务，请稍后重试。', 'TASK_CANCEL_FAILED');
    }
  }
  async function retry(id, filters = {}) {
    ensureOpen(); const record = find(id, filters), control = controls.get(id), source = sources.get(id);
    if (!RETRYABLE.has(record.status) || control?.safeRetry !== true || typeof control.retry !== 'function') throw failure(409, '此任务不能安全重试，请返回项目重新发起。', 'TASK_RETRY_UNAVAILABLE');
    record.status = 'queued'; record.phase = '等待重试'; record.progress = 0; record.error = null; record.outputs = []; record.startedAt = ''; record.finishedAt = ''; record.attempt += 1; record.updatedAt = now();
    await save();
    let running;
    if (source || control.external) {
      running = Promise.resolve().then(() => control.retry({ taskId: id })).then(async job => {
        if (closed) return;
        if (job && typeof job === 'object') { const patch = source?.map ? await source.map(job) : job; if (patch) await update(id, patch); }
        if (source) await refreshSource(id);
      }).catch(async error => { if (!closed) await update(id, { status: 'failed', phase: '重试未完成', error }); });
    } else running = execute(record, control.retry, control);
    if (record.dedupeHash && claims.has(record.dedupeHash)) claims.get(record.dedupeHash).promise = running;
    running.catch(() => {});
    return view(record);
  }
  async function upsertExternal(key, meta = {}, patch = {}, inputControls = {}) {
    ensureOpen();
    if (typeof key !== 'string' || !key || key.length > 512) throw failure(400, '外部任务编号不正确。', 'TASK_INVALID_SOURCE_KEY');
    const scoped = createHash('sha256').update(`external\0${key}`).digest('hex');
    let entry = external.get(scoped);
    if (!entry) {
      const pending = newRecord(meta, scoped).then(({ record }) => {
        if (record.projectId !== projectId(meta.projectId)) throw failure(409, '任务来源与项目不匹配。', 'TASK_PROJECT_CONFLICT');
        return record.id;
      });
      external.set(scoped, { pending, projectId: projectId(meta.projectId) });
      try { entry = external.get(scoped); entry.id = await pending; }
      catch (error) { external.delete(scoped); throw error; }
    }
    if (entry.projectId !== projectId(meta.projectId)) throw failure(409, '任务来源与项目不匹配。', 'TASK_PROJECT_CONFLICT');
    const id = entry.id || await entry.pending;
    if (inputControls && typeof inputControls === 'object') {
      const previous = controls.get(id) || {};
      controls.set(id, { ...previous, external: true, ...(typeof inputControls.cancel === 'function' ? { cancel: inputControls.cancel } : {}), ...(typeof inputControls.retry === 'function' ? { retry: inputControls.retry } : {}), ...(Object.hasOwn(inputControls, 'safeRetry') ? { safeRetry: inputControls.safeRetry === true } : {}) });
    }
    return update(id, patch);
  }
  const json = (res, status, value) => { const body = JSON.stringify(value); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) }); res.end(body); };
  async function handler(req, res, url) {
    if (url.pathname !== '/api/tasks' && !url.pathname.startsWith('/api/tasks/')) return false;
    try {
      const owner = url.searchParams.has('projectId') ? projectId(url.searchParams.get('projectId'), false) : undefined;
      if (url.pathname === '/api/tasks' && req.method === 'GET') { json(res, 200, await list({ projectId: owner, status: url.searchParams.get('status') || undefined })); return true; }
      const match = /^\/api\/tasks\/([A-Za-z0-9_-]+)(?:\/(cancel|retry))?$/.exec(url.pathname);
      if (!match) throw failure(404, '找不到此任务操作。', 'TASK_ROUTE_NOT_FOUND');
      const filters = owner === undefined ? {} : { projectId: owner };
      if (!match[2] && req.method === 'GET') { json(res, 200, { task: await get(match[1], filters) }); return true; }
      if (match[2] && req.method === 'POST') { json(res, 200, { task: await (match[2] === 'cancel' ? cancel : retry)(match[1], filters) }); return true; }
      throw failure(405, '此任务操作不支持该请求方法。', 'TASK_METHOD_NOT_ALLOWED');
    } catch (error) { json(res, error instanceof AppError ? error.status : 500, { error: cleanText(error instanceof AppError ? error.message : '任务服务暂时不可用，请稍后重试。', 600), code: error instanceof AppError ? error.code : 'TASK_SERVICE_FAILED' }); return true; }
  }

  let restored = false;
  try {
    const raw = await readFile(filename, 'utf8');
    if (Buffer.byteLength(raw) > 16 * 1024 * 1024) throw failure(500, '任务存储文件过大。', 'TASK_STORAGE_INVALID');
    const parsed = JSON.parse(raw);
    if (parsed.version !== 1 || !Array.isArray(parsed.items) || parsed.items.length > 10000) throw failure(500, '任务存储格式不正确。', 'TASK_STORAGE_INVALID');
    for (const item of parsed.items) {
      if (!item || !ID.test(item.id || '') || !normalizedStatus(item.status) || !validDate(item.createdAt)) continue;
      let owner; try { owner = projectId(item.projectId); } catch { continue; }
      const record = {
        id: item.id, type: cleanText(item.type, 80) || 'task', title: cleanText(item.title, 160) || '后台任务', projectId: owner,
        projectName: cleanText(item.projectName, 160), status: normalizedStatus(item.status), phase: cleanText(item.phase, 160), message: cleanText(item.message, 360),
        progress: Number.isFinite(item.progress) ? Math.max(0, Math.min(100, item.progress)) : 0, attempt: Number.isSafeInteger(item.attempt) && item.attempt > 0 ? item.attempt : 1,
        createdAt: validDate(item.createdAt), updatedAt: validDate(item.updatedAt) || validDate(item.createdAt), startedAt: validDate(item.startedAt), finishedAt: validDate(item.finishedAt),
        error: cleanError(item.error), outputs: safeOutputs(item.outputs, owner),
        ...(ID.test(item.sourceJobId || '') ? { sourceJobId: item.sourceJobId } : {}),
        ...(/^[a-f0-9]{64}$/.test(item.dedupeHash || '') ? { dedupeHash: item.dedupeHash } : {}),
      };
      if (ACTIVE.has(record.status)) { record.status = 'interrupted'; record.phase = '服务重启，任务已中断'; record.error = cleanError({ code: 'TASK_INTERRUPTED', message: '应用在任务完成前退出。请返回项目检查结果后重新发起。' }); record.finishedAt = now(); record.updatedAt = now(); }
      records.set(record.id, record); if (record.dedupeHash) dedupe.set(record.dedupeHash, record.id); restored = true;
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error instanceof AppError ? error : failure(500, '任务记录无法读取，请检查任务存储文件。', 'TASK_STORAGE_INVALID'); }
  if (restored) await save();
  const timer = setInterval(() => { if (!closed) void Promise.allSettled([...sources.keys()].map(refreshSource)); }, 1500);
  timer.unref?.();
  async function close() {
    if (closed) return writing;
    closed = true; clearInterval(timer);
    for (const [id, control] of controls) {
      control.detachSignal?.(); control.controller?.abort(abortError());
      if (ACTIVE.has(records.get(id)?.status) && typeof control.cancel === 'function') { try { Promise.resolve(control.cancel({ taskId: id })).catch(() => {}); } catch { /* Shutdown keeps the last known summary. */ } }
    }
    for (const record of records.values()) if (ACTIVE.has(record.status)) { record.status = 'interrupted'; record.phase = '应用已退出，任务已中断'; record.error = cleanError({ code: 'TASK_INTERRUPTED', message: '应用在任务完成前退出。请返回项目检查结果后重新发起。' }); record.finishedAt = now(); record.updatedAt = now(); }
    await save(); controls.clear(); sources.clear(); external.clear(); claims.clear();
  }
  return { create, update, list, get, track, attachSource, upsertExternal, cancel, retry, handler, handle: handler, close };
}
