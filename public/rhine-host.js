const VIEWS = new Set(['video', 'writer', 'science', 'archive', 'settings', 'tasks', 'restore', 'tools', 'assistant']);
const COVERS = new Set(['classic', 'blueprint', 'film', 'paper', 'custom']);
const coverAssetId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value.toLowerCase() : '';
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);

export function rhineCommand(data, origin, source, expectedOrigin, expectedSource) {
  if (!expectedSource || origin !== expectedOrigin || source !== expectedSource || !data || typeof data !== 'object') return null;
  if (data.type === 'guangxuan:ready') return { type: 'ready' };
  if (data.type === 'guangxuan:new-project') return { type: 'new-project', ...(['video', 'writing', 'science'].includes(data.kind) ? { kind: data.kind } : {}) };
  if (data.type === 'guangxuan:edit-project' && validId(data.projectId)) return { type: 'edit-project', projectId: data.projectId };
  if (data.type === 'guangxuan:update-project' && validId(data.projectId) && validId(data.requestId)) {
    const title = typeof data.title === 'string' ? data.title.trim() : '';
    const description = typeof data.description === 'string' ? data.description.trim() : '';
    const invalidCover = (data.cover !== undefined && !COVERS.has(data.cover)) || (data.coverAssetId !== undefined && data.coverAssetId !== '' && !coverAssetId(data.coverAssetId)) || (data.cover === 'custom' && !coverAssetId(data.coverAssetId));
    return { type: 'update-project', projectId: data.projectId, requestId: data.requestId, title, description,
      ...(data.cover !== undefined ? { cover: data.cover } : {}), ...(data.coverAssetId !== undefined ? { coverAssetId: coverAssetId(data.coverAssetId) } : {}),
      ...(!title || title.length > 120 || description.length > 1000 ? { error: '名称需为1—120字，简介最多1000字。' } : invalidCover ? { error: '请重新选择有效封面。' } : {}) };
  }
  if (data.type === 'guangxuan:home-state' && ['archive', 'detail'].includes(data.mode)) return { type: 'home-state', mode: data.mode, projectId: validId(data.projectId) ? data.projectId : null, ...(['video', 'writer', 'science'].includes(data.workspace) ? { workspace: data.workspace } : {}) };
  if (data.type !== 'guangxuan:open' || !VIEWS.has(data.view)) return null;
  return { type: 'open', view: data.view };
}

export function publicProjectSummary(project) {
  const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
  const count = value => Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 0);
  const assetId = coverAssetId(project.coverAssetId);
  return { id: project.id, title: text(project.title, 120), kind: ['video', 'writing', 'science'].includes(project.kind) ? project.kind : 'writing',
    cover: COVERS.has(project.cover) ? project.cover : 'classic', coverAssetId: assetId, coverUrl: assetId ? `/api/project-covers/${assetId}` : '',
    description: text(project.description, 1000), createdAt: text(project.createdAt, 64), updatedAt: text(project.updatedAt, 64),
    duration: project.duration == null ? null : count(project.duration), clipCount: count(project.clipCount), wordCount: count(project.wordCount), outputCount: count(project.outputCount) };
}

export function mountRhineHome(container, { skipBoot = false, onOpen, onReady, onNewProject, onEditProject, onUpdateProject, onState } = {}) {
  const lifecycle = new AbortController();
  let loaded = false, disposed = false, visible = true, projects = [], selection = null;
  container.innerHTML = `<section class="rhine-home" aria-label="项目档案"><div class="rhine-home-wait" role="status"><span class="spinner"></span><span>正在打开</span></div><iframe class="rhine-home-frame" title="光宣项目档案" sandbox="allow-scripts allow-same-origin allow-forms allow-downloads" allow="autoplay; fullscreen" allowfullscreen></iframe><div class="rhine-home-error" hidden><p>项目档案暂时未能打开。</p><div class="rhine-home-error-actions"><button class="btn small" data-home-retry>重试</button><button class="btn small" data-home-view="archive">项目列表</button></div></div></section>`;
  const frame = container.querySelector('iframe');
  const errorPanel = container.querySelector('.rhine-home-error');
  let timer;
  const send = data => { if (!disposed && frame.contentWindow) frame.contentWindow.postMessage(data, location.origin); };
  function pushProjects() { send({ type: 'guangxuan:projects', projects, ...(selection ? { selectedId: selection.projectId } : {}) }); }
  function ready() {
    if (disposed) return;
    const first = !loaded;
    loaded = true; clearTimeout(timer); errorPanel.hidden = true;
    container.querySelector('.rhine-home-wait')?.remove();
    pushProjects(); send({ type: 'guangxuan:visibility', visible });
    if (selection) send({ type: 'guangxuan:select-project', ...selection });
    if (first) onReady?.();
  }
  function load() {
    loaded = false; errorPanel.hidden = true; clearTimeout(timer);
    const url = new URL('/rhine/index.html', location.origin);
    url.searchParams.set('embed', '1');
    if (skipBoot) url.searchParams.set('skipBoot', '1');
    frame.src = url.href;
    timer = setTimeout(() => { if (!disposed && !loaded) errorPanel.hidden = false; }, 25000);
  }
  window.addEventListener('message', event => {
    const command = rhineCommand(event.data, event.origin, event.source, location.origin, frame.contentWindow);
    if (!command || disposed) return;
    if (command.type === 'ready') return ready();
    if (command.type === 'open') return onOpen?.(command.view);
    if (command.type === 'new-project') return onNewProject?.(command.kind);
    if (command.type === 'edit-project') return onEditProject?.(command.projectId);
    if (command.type === 'home-state') { selection = null; return onState?.(command); }
    if (command.type === 'update-project') {
      if (command.error) send({ type: 'guangxuan:project-updated', requestId: command.requestId, projectId: command.projectId, error: command.error });
      else onUpdateProject?.(command);
    }
  }, { signal: lifecycle.signal });
  frame.addEventListener('load', () => {
    try { if (!frame.contentDocument?.getElementById('viewport')) errorPanel.hidden = false; }
    catch { errorPanel.hidden = false; }
  }, { signal: lifecycle.signal });
  frame.addEventListener('error', () => { errorPanel.hidden = false; }, { signal: lifecycle.signal });
  container.querySelector('[data-home-retry]').addEventListener('click', load, { signal: lifecycle.signal });
  container.querySelectorAll('[data-home-view]').forEach(button => button.addEventListener('click', () => onOpen?.(button.dataset.homeView), { signal: lifecycle.signal }));
  load();
  const dispose = () => { disposed = true; clearTimeout(timer); lifecycle.abort(); frame.removeAttribute('src'); };
  return Object.assign(dispose, {
    frame,
    setProjects(next) {
      projects = (Array.isArray(next) ? next : []).filter(p => validId(p?.id)).map(publicProjectSummary)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      if (loaded) pushProjects();
    },
    selectProject(projectId, detail = true) { if (!validId(projectId)) return; selection = { projectId, detail }; if (loaded) send({ type: 'guangxuan:select-project', ...selection }); },
    setVisible(next) { visible = Boolean(next); container.inert = !visible; container.setAttribute('aria-hidden', String(!visible)); if (loaded) send({ type: 'guangxuan:visibility', visible }); },
    editorStatus(projectId, loading, error = '') { if (validId(projectId)) send({ type: 'guangxuan:editor-status', projectId, loading: Boolean(loading), error: String(error).slice(0, 300) }); },
    projectUpdated(requestId, project, error = '') { send({ type: 'guangxuan:project-updated', requestId, ...(project ? { project: publicProjectSummary(project), projectId: project.id } : {}), ...(error ? { error: String(error).slice(0, 300) } : {}) }); },
  });
}
