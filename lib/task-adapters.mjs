import { AppError } from './errors.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const ACTIVE = new Set(['queued', 'running', 'cancelling']);
const STATES = { pending: 'queued', queued: 'queued', running: 'running', rendering: 'running', processing: 'running', analyzing: 'running', complete: 'succeeded', completed: 'succeeded', done: 'succeeded', success: 'succeeded', succeeded: 'succeeded', error: 'failed', failed: 'failed', cancelled: 'cancelled', canceled: 'cancelled', cancelling: 'cancelling', canceling: 'cancelling', interrupted: 'interrupted' };
const PHASES = { queued: '等待开始', pending: '等待开始', preparing: '准备原素材', running: '正在处理', rendering: '正在渲染', probe: '读取媒体信息', frames: '提取画面依据', keyframes: '提取关键帧', scenes: '分析镜头变化', local: '分析镜头和画面', transcribe: '转写原声', transcription: '转写原声', transcribing: '转写原声', summarize: '整理素材摘要', summarizing: '整理素材摘要', summary: '整理素材摘要', saving: '核验并保存分析', complete: '已完成', completed: '已完成', done: '已完成', succeeded: '已完成', error: '未完成', failed: '未完成', cancelled: '已取消', cancelling: '正在取消', interrupted: '应用退出，任务已中断' };
const listOf = value => Array.isArray(value) ? value : value?.items || value?.jobs || value?.exports || [];
const failure = (status, message, code) => new AppError(status, message, code);
function ownerId(value, optional = false) {
  if (optional && (value === undefined || value === null || value === '')) return '';
  if (typeof value !== 'string' || !ID.test(value)) throw failure(400, '任务项目编号不正确。', 'TASK_ADAPTER_INVALID_PROJECT');
  return value;
}
function jobId(job) {
  const id = job?.jobId || job?.id;
  if (typeof id !== 'string' || !ID.test(id)) throw failure(400, '任务来源编号不正确。', 'TASK_ADAPTER_INVALID_JOB');
  return id;
}
function patchOf(job, { native = false } = {}) {
  const status = STATES[job?.status] || 'queued', progress = Math.max(0, Math.min(1, Number(job?.progress) || 0));
  return {
    status, phase: PHASES[job?.phase] || (typeof job?.phase === 'string' && job.phase ? job.phase.slice(0, 160) : PHASES[status] || (native ? '原生导出' : '正在处理')),
    progress: status === 'succeeded' ? 100 : Math.round(progress * 10000) / 100,
    ...(typeof job?.message === 'string' ? { message: job.message.slice(0, 360) } : {}),
    error: job?.error ? { code: typeof job.code === 'string' ? job.code : native ? 'NATIVE_EXPORT_FAILED' : 'MEDIA_JOB_FAILED', message: typeof job.error === 'string' ? job.error : job.error.message || '任务未完成，请返回项目检查。' } : null,
    outputs: typeof job?.downloadUrl === 'string' ? [{ label: native ? '下载原生导出视频' : '下载视频', url: job.downloadUrl }] : [],
  };
}

/** Observes existing services; never starts a native worker or discovers unopened projects. */
export function createTaskAdapters({ tasks, videoService, sourceAnalysis, openFilm } = {}) {
  if (!tasks?.upsertExternal || !tasks?.attachSource) throw failure(500, '任务适配服务尚未配置。', 'TASK_ADAPTER_NOT_CONFIGURED');
  let closed = false, currentNativeProject = '', unsubscribe = null;
  const chains = new Map(), pending = new Set(), registrations = new Map(), nativeProjects = new Map(), nativeCache = new Map(), polling = new Map();
  const analysisService = () => typeof sourceAnalysis === 'function' ? sourceAnalysis() : sourceAnalysis;
  function sequence(key, action) {
    if (closed) return Promise.resolve(null);
    const previous = chains.get(key) || Promise.resolve();
    const promise = previous.catch(() => {}).then(() => closed ? null : action());
    chains.set(key, promise); pending.add(promise);
    promise.finally(() => { pending.delete(promise); if (chains.get(key) === promise) chains.delete(key); }).catch(() => {});
    return promise;
  }
  async function register(key, meta, job, { read, cancel, native = false } = {}) {
    if (closed) return null;
    let registration = registrations.get(key);
    if (registration && registration.projectId !== (meta.projectId || '')) throw failure(409, '任务来源与项目不匹配。', 'TASK_ADAPTER_PROJECT_CONFLICT');
    if (!registration) { registration = { projectId: meta.projectId || '', last: job, taskId: null, attached: false }; registrations.set(key, registration); }
    registration.last = job;
    const controls = typeof cancel === 'function' ? { cancel: () => { if (closed) throw failure(503, '任务观察服务已关闭。', 'TASK_ADAPTER_CLOSED'); return cancel(); }, safeRetry: false } : { safeRetry: false };
    const task = await tasks.upsertExternal(key, meta, patchOf(job, { native }), controls); registration.taskId = task.id;
    if (!closed && !registration.attached && typeof read === 'function' && ACTIVE.has(task.status)) {
      registration.attached = true;
      try {
        await tasks.attachSource(task.id, {
          read: async () => { if (closed) return registration.last; const latest = await read(); registration.last = latest; return latest; },
          map: value => patchOf(value, { native }), ...(typeof cancel === 'function' ? { cancel: controls.cancel } : {}), safeRetry: false,
        });
      } catch (error) { registration.attached = false; throw error; }
    }
    return task;
  }
  function videoJob(job) {
    let id, projectId;
    try { id = jobId(job); projectId = ownerId(job?.projectId, true); }
    catch (error) { return Promise.reject(error); }
    const key = `video:${id}`;
    return sequence(key, () => register(key, { projectId, sourceJobId: id, type: job.kind === 'animation' ? 'animation-render' : 'video-export', title: `${projectId ? '' : '素材库 · '}${typeof job.title === 'string' && job.title ? job.title : job.kind === 'animation' ? '动画渲染' : '视频导出'}` }, job, {
      ...(typeof videoService?.getJob === 'function' ? { read: () => videoService.getJob(id, projectId ? { projectId } : {}) } : {}),
      ...(typeof videoService?.cancelJob === 'function' ? { cancel: () => videoService.cancelJob(id, projectId ? { projectId } : {}) } : {}),
    }));
  }
  function analysisJob(job, metadata = {}) {
    let id, projectId;
    try { id = jobId(job); projectId = ownerId(metadata.projectId || job?.projectId); if (job.projectId && job.projectId !== projectId) throw failure(409, '分析任务与项目不匹配。', 'TASK_ADAPTER_PROJECT_CONFLICT'); }
    catch (error) { return Promise.reject(error); }
    const key = `analysis:${id}`;
    return sequence(key, () => {
      const service = analysisService();
      return register(key, { projectId, sourceJobId: id, type: 'source-analysis', title: '原素材分析' }, job, {
        ...(typeof service?.get === 'function' ? { read: () => analysisService().get(projectId, id) } : {}),
        ...(typeof service?.cancel === 'function' ? { cancel: () => analysisService().cancel(projectId, id) } : {}),
      });
    });
  }
  function readNative(projectId) {
    if (closed) return Promise.resolve({ exports: [], stopped: true });
    let cache = nativeCache.get(projectId);
    if (!cache) { cache = { at: 0, value: null, promise: null }; nativeCache.set(projectId, cache); }
    if (cache.promise) return cache.promise;
    if (cache.value && Date.now() - cache.at < 1000) return Promise.resolve(cache.value);
    cache.promise = Promise.resolve().then(() => openFilm.nativeExports(projectId)).then(value => {
      cache.at = Date.now(); cache.value = { exports: listOf(value) }; return cache.value;
    }).finally(() => { cache.promise = null; });
    return cache.promise;
  }
  function nativeJob(projectId, job) {
    const id = jobId(job), key = `native-export:${projectId}:${id}`;
    let known = nativeProjects.get(projectId); if (!known) { known = new Map(); nativeProjects.set(projectId, known); }
    known.set(id, { ...job, id });
    return sequence(key, () => register(key, { projectId, sourceJobId: id, type: 'native-export', title: '原生视频导出' }, job, { native: true, ...(typeof openFilm?.cancelNativeExport === 'function' ? { cancel: () => openFilm.cancelNativeExport(projectId, id) } : {}), read: async () => {
      const response = await readNative(projectId), latest = response.exports.find(value => (value.id || value.jobId) === id);
      if (latest) { known.set(id, latest); return latest; }
      const state = typeof openFilm?.status === 'function' ? await openFilm.status() : null;
      if (state?.running === false) return { id, status: 'interrupted', progress: known.get(id)?.progress || 0, error: '原生导出服务已停止，请返回项目检查结果后重新导出。' };
      return known.get(id);
    } }));
  }
  function pollNative(projectId) {
    if (closed || typeof openFilm?.nativeExports !== 'function') return Promise.resolve();
    if (polling.has(projectId)) return polling.get(projectId);
    const promise = (async () => {
      const response = await readNative(projectId);
      if (closed) return;
      await Promise.allSettled(response.exports.map(job => nativeJob(projectId, job)));
      if (!response.exports.length && nativeProjects.has(projectId) && typeof openFilm?.status === 'function' && (await openFilm.status()).running === false) {
        const known = nativeProjects.get(projectId);
        await Promise.allSettled([...known.values()].filter(job => ACTIVE.has(STATES[job.status] || 'queued')).map(job => nativeJob(projectId, { ...job, status: 'interrupted', error: '原生导出服务已停止，请返回项目检查结果后重新导出。' })));
      }
    })().finally(() => polling.delete(projectId));
    polling.set(projectId, promise); pending.add(promise); promise.finally(() => pending.delete(promise)).catch(() => {}); return promise;
  }
  function watchedProjects() {
    const projects = new Set(currentNativeProject ? [currentNativeProject] : []);
    for (const [projectId, jobs] of nativeProjects) if ([...jobs.values()].some(job => ACTIVE.has(STATES[job.status] || 'queued'))) projects.add(projectId);
    return [...projects];
  }
  function watchNativeProject(projectId) {
    if (closed) return Promise.resolve();
    currentNativeProject = projectId === undefined || projectId === null || projectId === '' ? '' : ownerId(projectId);
    if (!currentNativeProject) return Promise.resolve();
    const cache = nativeCache.get(currentNativeProject); if (cache) cache.at = 0;
    return pollNative(currentNativeProject);
  }
  if (typeof videoService?.subscribeJobs === 'function') unsubscribe = videoService.subscribeJobs(job => { void videoJob(job).catch(() => {}); });
  const ready = Promise.resolve().then(() => closed ? [] : videoService?.listJobs?.() || []).then(jobs => Promise.allSettled(listOf(jobs).map(videoJob))).then(() => undefined);
  ready.catch(() => {});
  const timer = typeof openFilm?.nativeExports === 'function' ? setInterval(() => { if (!closed) void Promise.allSettled(watchedProjects().map(pollNative)); }, 1500) : null;
  timer?.unref?.();
  async function flush() { await ready; while (pending.size) await Promise.allSettled([...pending]); }
  async function close() {
    if (closed) return;
    closed = true; if (timer) clearInterval(timer); unsubscribe?.(); unsubscribe = null;
    await Promise.allSettled([...pending]); chains.clear(); nativeCache.clear(); polling.clear();
  }
  return { ready, videoJob, analysisJob, watchNativeProject, flush, close };
}
