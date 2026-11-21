// The native launch capability remains inside this host document.
const studio = document.querySelector('#openfilm-studio');
const nativeOrigin = studio ? new URL(studio.src, location.href).origin : '';
const parentOrigin = location.origin;
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const sessionId = document.body.dataset.sessionId || '';
const sendParent = data => { if (window.parent !== window) window.parent.postMessage({ ...data, sessionId }, parentOrigin); };
let projectId = document.body.dataset.projectId || '';
let nativeProjectId = document.body.dataset.nativeProjectId || '';
let visible = true;
let switching = true;
studio?.addEventListener('load', () => {
  sendParent({ type: 'guangxuan:studio-loaded', projectId, nativeProjectId });
  studio.contentWindow?.postMessage({ type: 'guangxuan:studio-visibility', visible }, nativeOrigin);
});
window.addEventListener('message', event => {
  if (event.source === window.parent && event.origin === parentOrigin) {
    if (event.data?.type === 'guangxuan:studio-visibility') {
      visible = Boolean(event.data.visible);
      studio?.contentWindow?.postMessage({ type: 'guangxuan:studio-visibility', visible }, nativeOrigin);
    }
    if (event.data?.type === 'guangxuan:studio-project' && validId(event.data.projectId)) {
      projectId = event.data.projectId;
      const nextNativeId = typeof event.data.nativeProjectId === 'string' ? event.data.nativeProjectId : '';
      if (nextNativeId !== nativeProjectId) switching = true;
      nativeProjectId = nextNativeId;
      studio?.contentWindow?.postMessage({ type: 'guangxuan:studio-project', projectId, nativeProjectId, title: typeof event.data.title === 'string' ? event.data.title.slice(0, 120) : '' }, nativeOrigin);
    }
    if (event.data?.type === 'guangxuan:studio-metadata' && event.data.projectId === projectId && event.data.nativeProjectId === nativeProjectId) {
      studio?.contentWindow?.postMessage({ type: 'guangxuan:studio-metadata', nativeProjectId, title: typeof event.data.title === 'string' ? event.data.title.slice(0, 120) : '' }, nativeOrigin);
    }
    if (event.data?.type === 'guangxuan:studio-flush' && validId(event.data.requestId)) studio?.contentWindow?.postMessage({ type: 'guangxuan:studio-flush', requestId: event.data.requestId }, nativeOrigin);
    if (event.data?.type === 'guangxuan:studio-timeline-request' && validId(event.data.requestId)) studio?.contentWindow?.postMessage({ type: event.data.type, requestId: event.data.requestId, ...(event.data.seek ? { seek: event.data.seek } : {}) }, nativeOrigin);
    if (event.data?.type === 'guangxuan:studio-export-checked' && validId(event.data.requestId)) studio?.contentWindow?.postMessage({ type: event.data.type, requestId: event.data.requestId, allowed: event.data.allowed === true, ...(event.data.error ? { error: String(event.data.error).slice(0, 300) } : {}) }, nativeOrigin);
    return;
  }
  if (!studio || event.source !== studio.contentWindow || event.origin !== nativeOrigin || !event.data || typeof event.data !== 'object') return;
  const data = event.data;
  const owner = data.ownerNativeProjectId || data.nativeProjectId;
  if (data.type === 'guangxuan:studio-edit-range' && owner === nativeProjectId && data.nativeProjectId === nativeProjectId && data.selection?.range) sendParent({ type: data.type, projectId, selection: data.selection });
  if (data.type === 'guangxuan:studio-import-progress' && owner === nativeProjectId && data.import && typeof data.import === 'object') sendParent({ type: data.type, projectId, import: data.import });
  if (data.type === 'guangxuan:studio-timeline-result' && validId(data.requestId) && owner === nativeProjectId) sendParent({ type: data.type, projectId, requestId: data.requestId, selection: data.selection, ...(data.error ? { error: String(data.error).slice(0, 300) } : {}) });
  if (data.type === 'guangxuan:studio-before-export' && validId(data.requestId) && owner === nativeProjectId && Array.isArray(data.specs) && data.specs.length <= 40) sendParent({ type: data.type, projectId, requestId: data.requestId, specs: data.specs });
  if (data.type === 'guangxuan:studio-ready' || data.type === 'guangxuan:studio-project-ready') {
    if (!nativeProjectId || owner !== nativeProjectId) {
      if (visible && !switching) sendParent({ type: 'guangxuan:studio-unexpected-project', projectId });
      return;
    }
    switching = false;
    sendParent({ type: 'guangxuan:studio-ready', projectId });
  }
  if (data.type === 'guangxuan:studio-project-changed' && owner === nativeProjectId) sendParent({ type: 'guangxuan:studio-project-changed', projectId });
  if (data.type === 'guangxuan:studio-show-project' && data.nativeProjectId === nativeProjectId) sendParent({ type: 'guangxuan:studio-show-project', projectId });
  if (data.type === 'guangxuan:studio-open-archive') sendParent({ type: 'guangxuan:studio-open-archive', projectId });
  if (data.type === 'guangxuan:studio-flushed' && validId(data.requestId)) sendParent({ type: 'guangxuan:studio-flushed', projectId, requestId: data.requestId, ...(data.error ? { error: String(data.error).slice(0, 300) } : {}) });
});
