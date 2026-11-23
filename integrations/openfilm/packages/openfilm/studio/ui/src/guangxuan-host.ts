import { studioHost, type HostProject } from './lib/host';

let parentOrigin: string | null = null;
let lastProject: Pick<HostProject, 'id' | 'name'> | null = null;
let ownerNativeProjectId: string | null = null;
const ownedSubviews = new Map<string, string>();
let flusher: { id: string; run: () => Promise<void> } | null = null;
const auxiliaries = new Map<string, Set<() => Promise<void>>>();
type TimelineBridge = { selection: () => { range: { start: number; end: number } | null; playhead: number; clipIds: string[] }; seek: (value: { start: number; clipId?: string }) => void };
let timelineBridge: { id: string; value: TimelineBridge } | null = null;
const exportChecks = new Map<string, { resolve: (value: boolean) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; id: string }>();
const importReports = new Map<string, { at: number; status: string }>();
export interface ManagedMusicResult { revision?: string; cutTimes?: number[]; beatCount?: number; summary?: string; undo?: { id: string; label: string } }
const musicRequests = new Map<string, { id: string; kind: 'cut' | 'undo'; resolve: (result: ManagedMusicResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
const routeProject = () => /^\/projects\/([\w-]+)/.exec(location.pathname)?.[1] ?? null;
const ownerOf = (id: string | null | undefined) => id ? ownedSubviews.get(id) ?? id : null;
const identity = (id: string | null | undefined) => ({ nativeProjectId: id ?? null, ownerNativeProjectId: ownerOf(id) });
function send(type: string, extra: Record<string, unknown> = {}) {
  if (parentOrigin && window.parent !== window) window.parent.postMessage({ type, ...extra }, parentOrigin);
}
export function showManagedProjectInfo(nativeProjectId: string): boolean {
  if (!parentOrigin || window.parent === window) return false;
  if (nativeProjectId !== lastProject?.id || nativeProjectId !== (ownerNativeProjectId ?? ownerOf(nativeProjectId))) return false;
  send('guangxuan:studio-show-project', identity(nativeProjectId));
  return true;
}
export function showManagedArchive(): boolean {
  if (!parentOrigin || window.parent === window) return false;
  send('guangxuan:studio-open-archive', identity(lastProject?.id));
  return true;
}
export function registerOwnedSubview(childId: string, fromNativeProjectId: string | null = lastProject?.id ?? null): boolean {
  if (window.parent === window) return true;
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(childId)) return false;
  const current = lastProject?.id;
  // An old openPartFilm promise must not attach its result to a newly selected root.
  if (!current || fromNativeProjectId !== current || routeProject() !== current) return false;
  const owner = ownerOf(current)!;
  if (ownerNativeProjectId && owner !== ownerNativeProjectId) return false;
  ownerNativeProjectId ??= owner;
  if (childId !== owner) ownedSubviews.set(childId, owner);
  return true;
}
function ready() {
  const id = lastProject?.id;
  if (!id || flusher?.id !== id || routeProject() !== id) return;
  setTimeout(() => {
    if (lastProject?.id === id && flusher?.id === id && routeProject() === id) send('guangxuan:studio-ready', identity(id));
  }, 0);
}
export function registerStudioFlush(nativeProjectId: string, run: () => Promise<void>) {
  const current = { id: nativeProjectId, run };
  flusher = current;
  ready();
  return () => { if (flusher === current) flusher = null; };
}
export function registerStudioAuxFlush(nativeProjectId: string, run: () => Promise<void>) {
  const group = auxiliaries.get(nativeProjectId) ?? new Set<() => Promise<void>>();
  group.add(run);
  auxiliaries.set(nativeProjectId, group);
  return () => { group.delete(run); if (!group.size) auxiliaries.delete(nativeProjectId); };
}
export function registerStudioTimeline(nativeProjectId: string, value: TimelineBridge) {
  const registered = { id: nativeProjectId, value };
  timelineBridge = registered;
  return () => { if (timelineBridge === registered) timelineBridge = null; };
}
export function hasManagedMusicHost(nativeProjectId: string): boolean {
  return Boolean(parentOrigin && window.parent !== window && nativeProjectId === ownerNativeProjectId && nativeProjectId === routeProject() && flusher?.id === nativeProjectId);
}
/** An explicit click, with the current film flushed first. Client beat arrays are never sent as authority. */
async function managedMusicRequest(nativeProjectId: string, kind: 'cut' | 'undo', extra: Record<string, unknown>) {
  if (!hasManagedMusicHost(nativeProjectId)) throw new Error('按音乐自动卡点需要在 Gx 视频主时间线中使用。');
  const current = flusher!;
  await current.run(); await Promise.all([...(auxiliaries.get(nativeProjectId) ?? [])].map(run => run()));
  if (current !== flusher || !hasManagedMusicHost(nativeProjectId)) throw new Error('工程已切换，本次音乐操作尚未发送。');
  const requestId = crypto.randomUUID();
  return new Promise<ManagedMusicResult>((resolve, reject) => {
    const timer = setTimeout(() => { musicRequests.delete(requestId); reject(new Error('音乐操作等待超时，请先查看当前工程状态。')); }, 150000);
    musicRequests.set(requestId, { id: nativeProjectId, kind, resolve, reject, timer });
    send(kind === 'cut' ? 'guangxuan:studio-music-cut' : 'guangxuan:studio-music-undo', { ...identity(nativeProjectId), requestId, ...extra });
  });
}
export function requestManagedMusicCut(nativeProjectId: string, data: { clipId: string; sourcePath: string; sourceVersion: string; cadence?: 'auto' | 'beat' | 'half' | 'strong' }) {
  if (!data.clipId || !data.sourcePath || !/^[a-f0-9]{64}$/.test(data.sourceVersion)) return Promise.reject(new Error('当前音乐分析或片段身份不完整，请重新识别。'));
  return managedMusicRequest(nativeProjectId, 'cut', data);
}
export function requestManagedMusicUndo(nativeProjectId: string, undoId: string) {
  if (!undoId) return Promise.reject(new Error('此音乐操作没有可用的撤销记录。'));
  return managedMusicRequest(nativeProjectId, 'undo', { undoId });
}
/** A deliberate user action; the parent opens the composer and never submits automatically. */
export async function requestManagedRangeEdit(nativeProjectId: string) {
  if (!parentOrigin || window.parent === window || nativeProjectId !== ownerNativeProjectId || nativeProjectId !== routeProject()) return false;
  const registered = timelineBridge;
  if (!registered || registered.id !== nativeProjectId) throw new Error('时间线尚未就绪，请稍后重新框选。');
  if (flusher?.id === nativeProjectId) {
    await flusher.run();
    await Promise.all([...(auxiliaries.get(nativeProjectId) ?? [])].map(run => run()));
  }
  if (registered !== timelineBridge || routeProject() !== nativeProjectId) return false;
  const selection = registered.value.selection(), range = selection.range;
  if (!range || !(range.end > range.start) || range.start < 0 || range.end > 3600) throw new Error('请先框选片段，或用I / O标记0—60分钟内的修改区间。');
  send('guangxuan:studio-edit-range', { ...identity(nativeProjectId), selection });
  return true;
}
/** Batch counts and bounded progress only; source paths and error logs stay in Studio. */
export function notifyManagedImport(nativeProjectId: string, value: { id: string; name: string; status: 'queued' | 'running' | 'succeeded' | 'failed'; progress: number }) {
  if (!parentOrigin || window.parent === window || nativeProjectId !== lastProject?.id || routeProject() !== nativeProjectId) return;
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.id) || !Number.isFinite(value.progress)) return;
  const key = `${nativeProjectId}:${value.id}`, previous = importReports.get(key), at = Date.now();
  if (value.status === 'running' && previous?.status === 'running' && at - previous.at < 250) return;
  if (['succeeded', 'failed'].includes(value.status)) importReports.delete(key); else importReports.set(key, { at, status: value.status });
  const name = value.name.replace(/[\\/\r\n\x00-\x1f]/g, '').slice(0, 100) || '导入素材';
  send('guangxuan:studio-import-progress', { ...identity(nativeProjectId), import: { id: value.id, name, status: value.status, progress: Math.max(0, Math.min(1, value.progress)), ...(value.status === 'failed' ? { error: '导入未完成，请返回项目查看。' } : {}) } });
}
/** Standalone Studio keeps its own export flow; managed main films ask the host first. */
export async function confirmManagedExport(nativeProjectId: string, jobs: readonly { kind: string; range?: [number, number]; ranges?: [number, number][]; fps?: number }[]) {
  if (!parentOrigin || window.parent === window || nativeProjectId !== ownerNativeProjectId) return true;
  const rendered = jobs.filter(job => !['project', 'subtitles'].includes(job.kind));
  if (!rendered.length) return true;
  const specs = rendered.flatMap(job => (job.ranges?.length ? job.ranges : [job.range]).map(range => ({ ...(range ? { range } : {}), ...(Number.isFinite(job.fps) ? { fps: job.fps } : {}) })));
  if (specs.length > 40) throw new Error('单次导出范围过多，请拆分后重试。');
  const requestId = crypto.randomUUID();
  return new Promise<boolean>((resolve, reject) => {
    const timer = setTimeout(() => { exportChecks.delete(requestId); reject(new Error('导出检查等待超时，请重试。')); }, 10 * 60 * 1000);
    exportChecks.set(requestId, { resolve, reject, timer, id: nativeProjectId });
    send('guangxuan:studio-before-export', { requestId, ...identity(nativeProjectId), specs });
  });
}
if (studioHost) studioHost.projectChanged = project => {
  if (routeProject() && routeProject() !== project.id) return;
  const changed = lastProject !== null && lastProject.id !== project.id;
  ownerNativeProjectId ??= project.id;
  lastProject = { id: project.id, name: project.name };
  document.title = `${project.name} · 光宣剪辑`;
  if (changed) send('guangxuan:studio-project-changed', identity(project.id));
  ready();
};

void fetch('/api/integration').then(response => response.ok ? response.json() : null).then(data => {
  if (!data?.localOnly || typeof data.embedOrigin !== 'string') return;
  const allowed = new URL(data.embedOrigin);
  if (allowed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(allowed.hostname) || allowed.origin !== data.embedOrigin) return;
  parentOrigin = allowed.origin;
  window.dispatchEvent(new Event('guangxuan:bridge-ready'));
  ready();
}).catch(() => {});

window.addEventListener('message', event => {
  if (!parentOrigin || event.source !== window.parent || event.origin !== parentOrigin) return;
  if (event.data?.type === 'guangxuan:studio-music-cut-result' || event.data?.type === 'guangxuan:studio-music-undo-result') {
    const pending = musicRequests.get(event.data.requestId);
    if (!pending || event.data.nativeProjectId !== pending.id || event.data.type !== (pending.kind === 'cut' ? 'guangxuan:studio-music-cut-result' : 'guangxuan:studio-music-undo-result')) return;
    clearTimeout(pending.timer); musicRequests.delete(event.data.requestId);
    if (!hasManagedMusicHost(pending.id)) { pending.reject(new Error('工程已切换，请查看原工程结果。')); return; }
    if (event.data.ok !== true) pending.reject(new Error(String(event.data.error?.message || '音乐操作未完成。').slice(0, 300)));
    else pending.resolve(event.data.result && typeof event.data.result === 'object' ? event.data.result : {});
    return;
  }
  if (event.data?.type === 'guangxuan:studio-export-checked' && typeof event.data.requestId === 'string') {
    const pending = exportChecks.get(event.data.requestId);
    if (!pending) return;
    clearTimeout(pending.timer); exportChecks.delete(event.data.requestId);
    if (pending.id !== lastProject?.id || routeProject() !== pending.id) { pending.resolve(false); return; }
    if (event.data.error) pending.reject(new Error(String(event.data.error).slice(0, 300)));
    else pending.resolve(event.data.allowed === true);
    return;
  }
  if (event.data?.type === 'guangxuan:studio-timeline-request' && typeof event.data.requestId === 'string' && event.data.requestId.length < 120) {
    const current = timelineBridge, requestId = event.data.requestId;
    if (!current || current.id !== lastProject?.id || routeProject() !== current.id || current.id !== ownerNativeProjectId) {
      send('guangxuan:studio-timeline-result', { requestId, ...identity(lastProject?.id), error: '请返回主时间线后重试。' }); return;
    }
    const start = event.data.seek?.start;
    if (start !== undefined) {
      if (typeof start !== 'number' || !Number.isFinite(start) || start < 0 || start > 86400) return;
      current.value.seek({ start, ...(typeof event.data.seek.clipId === 'string' ? { clipId: event.data.seek.clipId } : {}) });
    }
    send('guangxuan:studio-timeline-result', { requestId, ...identity(current.id), selection: current.value.selection() }); return;
  }
  if (event.data?.type === 'guangxuan:studio-visibility' && typeof event.data.visible === 'boolean') {
    document.documentElement.dataset.hostVisible = String(event.data.visible);
    window.dispatchEvent(new CustomEvent('guangxuan:visibility', { detail: { visible: event.data.visible } }));
  }
  if (event.data?.type === 'guangxuan:studio-project' && typeof event.data.nativeProjectId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(event.data.nativeProjectId)) {
    const rootId = event.data.nativeProjectId;
    if (ownerNativeProjectId !== rootId) { ownedSubviews.clear(); ownerNativeProjectId = rootId; }
    const current = routeProject();
    if (current === rootId || (current && ownedSubviews.get(current) === rootId)) ready();
    else {
      const next = new URL(`/projects/${encodeURIComponent(rootId)}`, location.origin);
      const key = new URLSearchParams(location.search).get('key');
      if (key) next.searchParams.set('key', key);
      history.replaceState(null, '', next.pathname + next.search);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }
  }
  if (event.data?.type === 'guangxuan:studio-metadata' && event.data.nativeProjectId === ownerNativeProjectId) {
    const title = event.data.title;
    if (typeof title === 'string' && title.trim() && title.length <= 120) {
      if (lastProject?.id === ownerNativeProjectId && routeProject() === ownerNativeProjectId) {
        lastProject = { id: lastProject.id, name: title };
        document.title = `${title} · 光宣剪辑`;
      }
      window.dispatchEvent(new CustomEvent('guangxuan:project-metadata', { detail: { nativeProjectId: ownerNativeProjectId, title } }));
    }
  }
  if (event.data?.type === 'guangxuan:studio-flush' && typeof event.data.requestId === 'string' && event.data.requestId.length < 120) {
    const requestId = event.data.requestId;
    const current = flusher;
    if (!current) { send('guangxuan:studio-flushed', { requestId, ...identity(lastProject?.id), error: '当前影片尚未就绪。' }); return; }
    void current.run().then(() => Promise.all([...(auxiliaries.get(current.id) ?? [])].map(run => run()))).then(() => send('guangxuan:studio-flushed', { requestId, ...identity(current.id) }), error =>
      send('guangxuan:studio-flushed', { requestId, ...identity(current.id), error: String(error instanceof Error ? error.message : error) }));
  }
});
