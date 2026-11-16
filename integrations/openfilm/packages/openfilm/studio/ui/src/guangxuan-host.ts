import { studioHost, type HostProject } from './lib/host';

let parentOrigin: string | null = null;
let lastProject: Pick<HostProject, 'id' | 'name'> | null = null;
let ownerNativeProjectId: string | null = null;
const ownedSubviews = new Map<string, string>();
let flusher: { id: string; run: () => Promise<void> } | null = null;
const auxiliaries = new Map<string, Set<() => Promise<void>>>();
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
