import { api, icon, uid } from './ui.js';

export function createNativeStudio(container, { onBack, onArchive, onWriter, onSettings, onAnimation, onRoughCut, onChanged } = {}) {
  let frame, currentProject = null, loaded = false, readyProject = null, sequence = 0;
  let session = null, pending = null, visible = false, destroyed = false, flushInProgress = null;
  const lifecycle = new AbortController(), flushRequests = new Map();
  const send = data => frame?.contentWindow?.postMessage(data, location.origin);
  function setup() {
    if (frame) return;
    container.innerHTML = `<section class="gx-studio-layout"><header class="gx-studio-toolbar"><div class="row grow"><button class="btn" data-studio-back>${icon('back')}项目档案</button><div class="gx-studio-project" data-studio-title></div></div><div class="gx-studio-actions"><button class="btn" data-studio-ai-cut>${icon('cut')}AI 粗剪</button><button class="btn" data-studio-ai-animation>${icon('animation')}AI 动画</button><button class="btn" data-studio-writer>${icon('pen')}文案</button><button class="btn" data-studio-settings>${icon('settings')}模型</button></div></header><iframe class="gx-native-studio" title="视频编辑器" sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-popups" allow="autoplay; fullscreen" allowfullscreen></iframe></section>`;
    frame = container.querySelector('iframe');
    container.querySelector('[data-studio-back]').onclick = () => onBack?.(currentProject?.id);
    container.querySelector('[data-studio-writer]').onclick = () => onWriter?.(currentProject?.id);
    container.querySelector('[data-studio-settings]').onclick = () => onSettings?.();
    container.querySelector('[data-studio-ai-animation]').onclick = () => onAnimation?.(currentProject);
    container.querySelector('[data-studio-ai-cut]').onclick = () => onRoughCut?.(currentProject);
    frame.addEventListener('load', () => { loaded = true; notifyProject(); send({ type: 'guangxuan:studio-visibility', visible }); }, { signal: lifecycle.signal });
  }
  function notifyProject() {
    if (loaded && currentProject) send({ type: 'guangxuan:studio-project', projectId: currentProject.id, nativeProjectId: currentProject.nativeProjectId, title: currentProject.title });
  }
  function finishReady(projectId) {
    if (projectId !== currentProject?.id) return;
    readyProject = projectId;
    container.dataset.readyProject = projectId;
    if (pending?.id === projectId) { clearTimeout(pending.timer); pending.resolve(); pending = null; }
  }
  window.addEventListener('message', event => {
    if (destroyed || !frame || event.source !== frame.contentWindow || event.origin !== location.origin || !event.data || typeof event.data !== 'object') return;
    const data = event.data;
    if (session && data.sessionId !== session) return;
    if (data.type === 'guangxuan:studio-ready') finishReady(data.projectId);
    if (data.type === 'guangxuan:studio-loaded') { loaded = true; notifyProject(); }
    if (data.type === 'guangxuan:studio-project-changed' && data.projectId === currentProject?.id) onChanged?.(data.projectId);
    if (data.type === 'guangxuan:studio-show-project' && data.projectId === currentProject?.id) onBack?.(data.projectId);
    if (data.type === 'guangxuan:studio-open-archive' || data.type === 'guangxuan:studio-unexpected-project') {
      if (data.type === 'guangxuan:studio-unexpected-project') readyProject = null;
      onArchive?.();
    }
    if (data.type === 'guangxuan:studio-flushed') {
      const waiting = flushRequests.get(data.requestId);
      if (waiting) { clearTimeout(waiting.timer); flushRequests.delete(data.requestId); if (data.error) waiting.reject(new Error(data.error)); else waiting.resolve(); }
    }
  }, { signal: lifecycle.signal });
  async function flush() {
    if (!frame || !loaded || !readyProject) return;
    if (flushInProgress) return flushInProgress;
    const requestId = uid();
    flushInProgress = new Promise((resolve, reject) => {
      // Native editing is already serialized. This acknowledgement additionally
      // drains its current user gesture before an external project switch.
      const timer = setTimeout(() => { flushRequests.delete(requestId); reject(new Error('编辑内容尚未确认保存，请稍后再切换项目。')); }, 5000);
      flushRequests.set(requestId, { resolve, reject, timer });
      send({ type: 'guangxuan:studio-flush', requestId });
    }).finally(() => { flushInProgress = null; });
    return flushInProgress;
  }
  return {
    async prepare(project) {
      if (destroyed) throw new Error('编辑器已关闭');
      setup();
      const token = ++sequence, started = performance.now();
      if (pending) { clearTimeout(pending.timer); pending.reject(new DOMException('已切换到其他项目', 'AbortError')); pending = null; }
      const opened = await api('/api/openfilm/open', { projectId: project.id });
      if (token !== sequence) throw new DOMException('已切换到其他项目', 'AbortError');
      const url = new URL(opened.editorUrl, location.origin);
      if (url.origin !== location.origin || url.pathname !== '/openfilm/editor.html') throw new Error('编辑器返回了无效的本地入口');
      const nextSession = opened.sessionId || opened.editorSession || null;
      if (currentProject && currentProject.id !== project.id && (!session || session === nextSession)) await flush();
      if (token !== sequence) throw new DOMException('已切换到其他项目', 'AbortError');
      const mustLoad = !frame.getAttribute('src') || (session && nextSession && session !== nextSession);
      const wasReady = !mustLoad && readyProject === project.id && currentProject?.nativeProjectId === opened.nativeProjectId;
      session = nextSession;
      currentProject = { ...project, nativeProjectId: opened.nativeProjectId };
      this.updateProject(project);
      container.dataset.projectId = project.id;
      if (!wasReady) readyProject = null;
      const waiting = wasReady ? Promise.resolve() : new Promise((resolve, reject) => {
        pending = { id: project.id, resolve, reject, timer: setTimeout(() => {
          if (pending?.id === project.id) pending = null;
          reject(new Error('编辑器尚未完成项目加载，请重试。'));
        }, 35000) };
      });
      if (mustLoad) {
        loaded = false;
        url.searchParams.set('projectId', project.id);
        if (nextSession) url.searchParams.set('session', nextSession);
        frame.src = url.href;
        container.dataset.frameLoads = String(Number(container.dataset.frameLoads || 0) + 1);
      } else notifyProject();
      await waiting;
      container.dataset.prepareMs = String(Math.round(performance.now() - started));
      return opened;
    },
    updateProject(project) {
      const title = container.querySelector('[data-studio-title]');
      if (title) title.textContent = project.title || '视频项目';
      if (currentProject?.id === project.id) {
        currentProject = { ...currentProject, ...project };
        if (loaded) send({ type: 'guangxuan:studio-metadata', projectId: currentProject.id, nativeProjectId: currentProject.nativeProjectId, title: currentProject.title });
      }
    },
    setVisible(next) { visible = Boolean(next); container.inert = !visible; container.setAttribute('aria-hidden', String(!visible)); if (loaded) send({ type: 'guangxuan:studio-visibility', visible }); },
    flush,
    getProject: () => currentProject,
    dispose() {
      destroyed = true; lifecycle.abort();
      if (pending) { clearTimeout(pending.timer); pending.reject(new DOMException('编辑器已关闭', 'AbortError')); pending = null; }
      for (const waiting of flushRequests.values()) { clearTimeout(waiting.timer); waiting.resolve(); }
      flushRequests.clear(); frame?.removeAttribute('src');
    },
  };
}
