import { api, icon, uid } from './ui.js';
import { workspaceHeader, installWorkspaceTools } from './workspace-chrome.js';

export function createNativeStudio(container, { assistant, references, onBack, onArchive, onView, onSettings, onAnimation, onRoughCut, onChanged, onTools, beforeExport } = {}) {
  let frame, currentProject = null, loaded = false, readyProject = null, sequence = 0;
  let session = null, pending = null, visible = false, destroyed = false, flushInProgress = null;
  const compactAssistant = matchMedia('(max-width: 850px)');
  let assistantVisible = !compactAssistant.matches, wasCompact = compactAssistant.matches;
  let preferredWidth = 328, resizeDrag = null;
  try { const saved = Number(localStorage.getItem('guangxuan-assistant-width')); if (Number.isFinite(saved) && saved >= 180 && saved <= 680) preferredWidth = saved; } catch {}
  const lifecycle = new AbortController(), flushRequests = new Map();
  const timelineRequests = new Map(), exportRequests = new Set(), musicRequests = new Set();
  const send = data => frame?.contentWindow?.postMessage(data, location.origin);
  const widthBounds = () => {
    const available = container.clientWidth || innerWidth;
    const max = Math.min(680, Math.max(100, available - (available <= 850 ? 24 : 360)));
    return { min: Math.min(260, max), max };
  };
  function applyAssistantWidth(value = preferredWidth, remember = false) {
    const { min, max } = widthBounds(), width = Math.round(Math.max(min, Math.min(max, value)));
    container.style.setProperty('--gx-assistant-width', `${width}px`);
    const handle = container.querySelector('[data-assistant-resize]');
    if (handle) { handle.setAttribute('aria-valuemin', String(min)); handle.setAttribute('aria-valuemax', String(max)); handle.setAttribute('aria-valuenow', String(width)); handle.setAttribute('aria-valuetext', `${width} 像素`); }
    if (remember) { preferredWidth = width; try { localStorage.setItem('guangxuan-assistant-width', String(width)); } catch {} }
    return width;
  }
  function finishResize() {
    const handle = container.querySelector('[data-assistant-resize]');
    if (resizeDrag && handle?.hasPointerCapture(resizeDrag.id)) handle.releasePointerCapture(resizeDrag.id);
    resizeDrag = null; container.classList.remove('is-resizing-assistant');
  }
  function setAssistantVisible(next) {
    const wasVisible = assistantVisible;
    assistantVisible = Boolean(next);
    const panel = container.querySelector('.gx-assistant-container'), button = container.querySelector('[data-studio-assistant]');
    const restoreFocus = wasVisible && !assistantVisible && visible;
    if (panel) panel.hidden = !assistantVisible;
    const handle = container.querySelector('[data-assistant-resize]'); if (handle) handle.hidden = !assistantVisible;
    const drawerOpen = compactAssistant.matches && assistantVisible;
    const backdrop = container.querySelector('[data-assistant-backdrop]'); if (backdrop) backdrop.hidden = !drawerOpen;
    if (frame) frame.inert = drawerOpen;
    if (!assistantVisible) finishResize();
    applyAssistantWidth();
    if (button) { button.setAttribute('aria-expanded', String(assistantVisible)); button.classList.toggle('is-open', assistantVisible); }
    if (restoreFocus) button?.focus({ preventScroll: true });
  }
  function closeAssistant() {
    if (assistant) assistant.setVisible(false); else setAssistantVisible(false);
    container.querySelector('[data-studio-assistant]')?.focus({ preventScroll: true });
  }
  function setup() {
    if (frame) return;
    container.innerHTML = `<section class="gx-studio-layout">${workspaceHeader('video')}<div class="gx-studio-toolbar"><div class="row grow"><button class="btn" data-studio-back>${icon('back')}项目信息</button><div class="gx-studio-project" data-studio-title></div></div><div class="gx-studio-actions"><button class="btn" data-studio-references aria-haspopup="dialog">${icon('folder')}参考<span class="gx-reference-count" data-studio-reference-count hidden></span></button><button class="btn" data-studio-ai-cut>${icon('cut')}AI 粗剪</button><button class="btn" data-studio-ai-animation>${icon('animation')}AI 动画</button><button class="btn" data-studio-assistant>${icon('spark')}AI 助手</button></div></div><div class="gx-studio-body"><iframe class="gx-native-studio" title="视频编辑器" sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-popups" allow="autoplay; fullscreen" allowfullscreen></iframe><div class="gx-assistant-resize" data-assistant-resize role="separator" tabindex="0" aria-label="调整 AI 助手宽度" aria-orientation="vertical" title="拖动调整宽度；← → 微调" hidden></div><aside class="gx-assistant-container" hidden></aside></div></section>`;
    frame = container.querySelector('iframe');
    installWorkspaceTools(container);
    const tools = document.createElement('button'); tools.className = 'btn'; tools.dataset.studioTools = ''; tools.setAttribute('aria-label', '项目工具'); tools.title = '备份、素材分析、文案关联、导出体检';
    tools.innerHTML = icon('more') + '<span>工具</span><span class="gx-source-update-count" data-source-update-count hidden></span>';
    tools.onclick = () => onTools?.(currentProject);
    container.querySelector('.gx-studio-actions').prepend(tools);
    const assistantPanel = container.querySelector('.gx-assistant-container');
    assistantPanel.id = 'gx-editor-assistant'; assistantPanel.setAttribute('aria-label', 'AI 助手');
    container.querySelector('[data-studio-assistant]').setAttribute('aria-controls', assistantPanel.id);
    frame.insertAdjacentHTML('afterend', '<button type="button" class="gx-assistant-backdrop" data-assistant-backdrop aria-label="收起 AI 助手" hidden></button>');
    container.querySelector('[data-assistant-backdrop]').onclick = closeAssistant;
    container.querySelector('[data-studio-back]').onclick = () => onBack?.(currentProject?.id);
    container.querySelectorAll('[data-nav]').forEach(button => button.onclick = () => {
      const view = button.dataset.nav;
      if (view === 'home') onBack?.(currentProject?.id);
      else if (view === 'settings') onSettings?.();
      else if (view === 'archive') onArchive?.();
      else onView?.(view);
    });
    container.querySelector('[data-studio-ai-animation]').onclick = () => onAnimation?.(currentProject);
    container.querySelector('[data-studio-ai-cut]').onclick = () => onRoughCut?.(currentProject);
    container.querySelector('[data-studio-references]').onclick = () => { if (currentProject) references?.open(currentProject); };
    container.querySelector('[data-studio-assistant]').onclick = () => assistant?.setVisible(!assistantVisible);
    for (const [selector, label] of [['[data-studio-references]', '参考'], ['[data-studio-ai-cut]', 'AI 粗剪'], ['[data-studio-ai-animation]', 'AI 动画'], ['[data-studio-assistant]', 'AI 助手']]) {
      const button = container.querySelector(selector); button.setAttribute('aria-label', label); button.title = label;
    }
    const handle = container.querySelector('[data-assistant-resize]');
    handle.onpointerdown = event => {
      if (event.button !== 0) return;
      event.preventDefault(); handle.focus({ preventScroll: true });
      resizeDrag = { id: event.pointerId, x: event.clientX, width: applyAssistantWidth() };
      handle.setPointerCapture(event.pointerId); container.classList.add('is-resizing-assistant');
    };
    handle.onpointermove = event => { if (resizeDrag?.id === event.pointerId) applyAssistantWidth(resizeDrag.width + resizeDrag.x - event.clientX, true); };
    handle.onpointerup = finishResize; handle.onpointercancel = finishResize; handle.onlostpointercapture = finishResize;
    handle.ondblclick = () => applyAssistantWidth(328, true);
    handle.onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const { min, max } = widthBounds(), step = event.shiftKey ? 48 : 16;
      const width = applyAssistantWidth();
      applyAssistantWidth(event.key === 'Home' ? min : event.key === 'End' ? max : width + (event.key === 'ArrowLeft' ? step : -step), true);
    };
    window.addEventListener('resize', () => {
      const compact = compactAssistant.matches;
      if (compact && !wasCompact) { if (assistant) assistant.setVisible(false); else setAssistantVisible(false); }
      wasCompact = compact;
      setAssistantVisible(assistantVisible);
    }, { signal: lifecycle.signal });
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || event.defaultPrevented || !visible || !compactAssistant.matches || !assistantVisible || container.closest('[inert]')) return;
      event.preventDefault(); event.stopPropagation(); closeAssistant();
    }, { signal: lifecycle.signal });
    applyAssistantWidth();
    frame.addEventListener('load', () => { loaded = true; notifyProject(); send({ type: 'guangxuan:studio-visibility', visible }); }, { signal: lifecycle.signal });
    window.addEventListener('guangxuan:request-timeline-selection', event => {
      const request = event.detail;
      if (request?.projectId !== currentProject?.id || typeof request.requestId !== 'string') return;
      void timelineRequest().then(selection => window.dispatchEvent(new CustomEvent('guangxuan:timeline-selection-result', { detail: { projectId: request.projectId, requestId: request.requestId, selection } })), error => window.dispatchEvent(new CustomEvent('guangxuan:timeline-selection-result', { detail: { projectId: request.projectId, requestId: request.requestId, error: error.message } })));
    }, { signal: lifecycle.signal });
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
    if (data.type === 'guangxuan:studio-edit-range' && data.projectId === currentProject?.id && data.selection?.range) assistant?.selectRange?.(data.selection);
    if (data.type === 'guangxuan:studio-import-progress' && data.projectId === currentProject?.id && data.import && typeof data.import === 'object') {
      const { id, name, status, progress } = data.import;
      void api('/api/openfilm/import-progress', { projectId: data.projectId, id, name, status, progress }).catch(() => {});
    }
    if (['guangxuan:studio-music-cut', 'guangxuan:studio-music-undo'].includes(data.type) && data.projectId === currentProject?.id && data.nativeProjectId === currentProject?.nativeProjectId && typeof data.requestId === 'string' && !musicRequests.has(data.requestId)) {
      const owner = currentProject.id, nativeId = currentProject.nativeProjectId, isUndo = data.type === 'guangxuan:studio-music-undo';
      const responseType = isUndo ? 'guangxuan:studio-music-undo-result' : 'guangxuan:studio-music-cut-result';
      musicRequests.add(data.requestId);
      void (async () => {
        try {
          await flush();
          if (owner !== currentProject?.id || nativeId !== currentProject?.nativeProjectId || !visible) throw new Error('工程已切换，未执行音乐卡点。');
          const payload = isUndo ? { undoId: data.undoId } : { requestId: data.requestId, musicClipId: data.clipId, sourcePath: data.sourcePath, sourceVersion: data.sourceVersion, cadence: data.cadence || 'auto' };
          const result = await api(`/api/projects/${encodeURIComponent(owner)}/music-${isUndo ? 'cut-undo' : 'cut'}`, payload);
          if (owner === currentProject?.id && nativeId === currentProject?.nativeProjectId) { send({ type: responseType, projectId: owner, nativeProjectId: nativeId, requestId: data.requestId, ok: true, result }); onChanged?.(owner); }
        } catch (error) { if (owner === currentProject?.id && nativeId === currentProject?.nativeProjectId) send({ type: responseType, projectId: owner, nativeProjectId: nativeId, requestId: data.requestId, ok: false, error: { code: error.code || 'MUSIC_CUT_FAILED', message: error.message || '音乐卡点未完成，现有工程保留。' } }); }
        finally { musicRequests.delete(data.requestId); }
      })();
    }
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
    if (data.type === 'guangxuan:studio-timeline-result' && data.projectId === currentProject?.id) {
      const waiting = timelineRequests.get(data.requestId);
      if (waiting) { clearTimeout(waiting.timer); timelineRequests.delete(data.requestId); if (data.error) waiting.reject(new Error(data.error)); else waiting.resolve(data.selection); }
    }
    if (data.type === 'guangxuan:studio-before-export' && data.projectId === currentProject?.id && typeof data.requestId === 'string' && Array.isArray(data.specs) && data.specs.length <= 40 && !exportRequests.has(data.requestId)) {
      const owner = currentProject.id; exportRequests.add(data.requestId);
      void (async () => {
        try {
          await flush();
          let allowed = true;
          const unique = [...new Map(data.specs.map(spec => [JSON.stringify({ range: spec?.range, fps: spec?.fps }), spec])).values()];
          for (const spec of unique) {
            if (owner !== currentProject?.id || !visible || typeof beforeExport === 'function' && !await beforeExport(owner, spec)) { allowed = false; break; }
          }
          send({ type: 'guangxuan:studio-export-checked', requestId: data.requestId, allowed: allowed && owner === currentProject?.id });
        } catch (error) { send({ type: 'guangxuan:studio-export-checked', requestId: data.requestId, allowed: false, error: error.message }); }
        finally { exportRequests.delete(data.requestId); }
      })();
    }
  }, { signal: lifecycle.signal });
  async function flush() {
    if (!frame || !loaded || !readyProject) return;
    if (flushInProgress) return flushInProgress;
    const requestId = uid();
    flushInProgress = new Promise((resolve, reject) => {
      // Native editing is already serialized. This acknowledgement additionally
      // drains its current user gesture before an external project switch.
      const timer = setTimeout(() => { flushRequests.delete(requestId); reject(new Error('内容尚未保存，请稍后切换项目。')); }, 5000);
      flushRequests.set(requestId, { resolve, reject, timer });
      send({ type: 'guangxuan:studio-flush', requestId });
    }).finally(() => { flushInProgress = null; });
    return flushInProgress;
  }
  function timelineRequest(seek) {
    if (!frame || !loaded || !readyProject) return Promise.reject(new Error('请先打开视频主时间线。'));
    const requestId = uid();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { timelineRequests.delete(requestId); reject(new Error('时间线暂未响应，请稍后重试。')); }, 5000);
      timelineRequests.set(requestId, { resolve, reject, timer });
      send({ type: 'guangxuan:studio-timeline-request', requestId, ...(seek ? { seek } : {}) });
    });
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
      if (url.origin !== location.origin || url.pathname !== '/openfilm/editor.html') throw new Error('无法打开编辑器，请重试。');
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
          reject(new Error('项目加载超时，请重试。'));
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
      if (token !== sequence) throw new DOMException('已切换到其他项目', 'AbortError');
      assistant?.mount(container.querySelector('.gx-assistant-container'), project);
      this.setReferenceCount(project.id, references?.count(project.id) || 0);
      void references?.activate(project).catch(() => {});
      if (assistant) assistant.setVisible(assistantVisible); else setAssistantVisible(assistantVisible);
      container.dataset.prepareMs = String(Math.round(performance.now() - started));
      return opened;
    },
    updateProject(project) {
      const title = container.querySelector('[data-studio-title]');
      if (title) title.textContent = project.title || '视频项目';
      if (currentProject?.id === project.id) {
        currentProject = { ...currentProject, ...project };
        if (project.video) assistant?.updateProject?.(project);
        if (loaded) send({ type: 'guangxuan:studio-metadata', projectId: currentProject.id, nativeProjectId: currentProject.nativeProjectId, title: currentProject.title });
      }
    },
    setVisible(next) { visible = Boolean(next); container.inert = !visible; container.setAttribute('aria-hidden', String(!visible)); if (!visible) { references?.close(); if (compactAssistant.matches) { if (assistant) assistant.setVisible(false); else setAssistantVisible(false); } } if (loaded) send({ type: 'guangxuan:studio-visibility', visible }); },
    setReferenceCount(projectId, count) {
      if (currentProject?.id !== projectId) return;
      const badge = container.querySelector('[data-studio-reference-count]');
      if (badge) { badge.textContent = String(count); badge.hidden = !count; }
    },
    setAssistantVisible,
    setSourceVersionStatus(projectId, value) {
      if (currentProject?.id !== projectId) return;
      const count = ['changed', 'untracked'].includes(value?.status) ? value.changes?.length || 1 : 0;
      const badge = container.querySelector('[data-source-update-count]'), button = container.querySelector('[data-studio-tools]');
      if (badge) { badge.textContent = String(count); badge.hidden = !count; }
      if (button) { button.classList.toggle('has-source-updates', Boolean(count)); button.title = count ? '来源文案有更新，点击查看' : '备份、素材分析、文案关联、导出体检'; }
    },
    timelineSelection: () => timelineRequest(),
    seek: value => timelineRequest(value),
    flush,
    getProject: () => currentProject,
    dispose() {
      destroyed = true; finishResize(); lifecycle.abort();
      if (pending) { clearTimeout(pending.timer); pending.reject(new DOMException('编辑器已关闭', 'AbortError')); pending = null; }
      for (const waiting of flushRequests.values()) { clearTimeout(waiting.timer); waiting.resolve(); }
      flushRequests.clear(); frame?.removeAttribute('src');
      for (const waiting of timelineRequests.values()) { clearTimeout(waiting.timer); waiting.reject(new DOMException('编辑器已关闭', 'AbortError')); }
      timelineRequests.clear(); exportRequests.clear();
    },
  };
}
