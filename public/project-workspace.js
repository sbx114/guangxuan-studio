import { api, icon, escapeHtml as h, showModal, toast, uid } from './ui.js';
import { mountRhineHome } from './rhine-host.js';
import { createNativeStudio } from './native-studio.js';
import { createOpenfilmActions } from './openfilm-actions.js';

export function createProjectWorkspace({ app, state, saveProject, callAi, requireConnection, onWriting, onOtherView }) {
  const home = document.createElement('div'), video = document.createElement('div'), status = document.createElement('div');
  home.id = 'gx-home-portal'; video.id = 'gx-video-portal'; status.className = 'gx-transition-status'; status.hidden = true;
  document.body.insertBefore(home, app); document.body.insertBefore(video, app); document.body.append(status);
  let homeController = null, transition = 0, summaryTimer = null, summaryRequest = null, activeHomeProject = null, summaryEpoch = 0, pendingEditorProject = null;
  const full = new Set(), patching = new Set();
  state.summaries ||= [];
  const actions = createOpenfilmActions({ getSettings: () => state.settings, requireConnection, callAi, saveProject, onChanged: () => queueRefresh() });
  const native = createNativeStudio(video, {
    onBack: id => showHome(id),
    onArchive: () => onOtherView('archive'),
    onWriter: async id => { try { const p = await loadProject(id); showWriting(p); } catch (error) { toast(error.message, 'error'); } },
    onSettings: () => onOtherView('settings'),
    onAnimation: p => actions.showAnimation(findProject(p?.id) || p),
    onRoughCut: p => actions.showRoughCut(findProject(p?.id) || p),
    onChanged: () => queueRefresh(),
  });
  const findProject = id => state.projects.find(p => p.id === id);
  const summaryOf = id => state.summaries.find(p => p.id === id);
  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const paint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  function putProject(project) {
    const index = state.projects.findIndex(p => p.id === project.id);
    if (index < 0) state.projects.push(project); else state.projects[index] = project;
    full.add(project.id); return project;
  }
  async function loadProject(id, force = false) {
    if (!id) throw new Error('请先选择项目');
    const cached = findProject(id);
    if (!force && cached && full.has(id)) return cached;
    await state.saveQueue.catch(() => {});
    const result = await api(`/api/projects/${encodeURIComponent(id)}`);
    if (!result.project) throw new Error('这个项目已不存在，请刷新档案');
    return putProject(result.project);
  }
  async function refreshSummaries() {
    if (summaryRequest) return summaryRequest;
    const epoch = ++summaryEpoch;
    summaryRequest = api('/api/projects/summary').then(result => {
      if (epoch !== summaryEpoch) return state.summaries;
      state.summaries = Array.isArray(result.projects) ? result.projects : [];
      state.summaryLoadedAt = Date.now();
      homeController?.setProjects(state.summaries);
      const active = summaryOf(state.videoId);
      if (active) native.updateProject(active);
      return state.summaries;
    }).finally(() => { summaryRequest = null; });
    return summaryRequest;
  }
  function queueRefresh() {
    clearTimeout(summaryTimer);
    summaryTimer = setTimeout(() => refreshSummaries().catch(() => {}), 650);
  }
  function ensureHome() {
    if (homeController) return;
    homeController = mountRhineHome(home, {
      onReady: () => { home.dataset.loaded = 'true'; homeController.setProjects(state.summaries); },
      onOpen: view => { if (view === 'video' || view === 'writer') openLast(view); else onOtherView(view); },
      onNewProject: () => newProjectDialog(),
      onEditProject: id => enterEditor(id),
      onUpdateProject: async request => {
        try { const project = await updateMetadata(request.projectId, { title: request.title, description: request.description }); homeController.projectUpdated(request.requestId, project); }
        catch (error) { homeController.projectUpdated(request.requestId, null, error.message); }
      },
      onState: event => {
        activeHomeProject = event.projectId;
        if (state.view === 'home' && pendingEditorProject && event.mode === 'archive') {
          ++transition; status.hidden = true; video.classList.remove('is-preparing');
          homeController.editorStatus(pendingEditorProject, false); pendingEditorProject = null;
        }
      },
    });
    homeController.setProjects(state.summaries);
  }
  function hideHome() { homeController?.setVisible(false); home.classList.remove('is-visible', 'is-preparing'); }
  function hideVideo() { native.setVisible(false); video.classList.remove('is-visible', 'is-preparing'); }
  function flushWriting() {
    if (state.view !== 'writer' || !state.saveTimer) return;
    clearTimeout(state.saveTimer); state.saveTimer = null;
    const p = findProject(state.writerId); if (p) void saveProject(p);
  }
  function showHome(projectId) {
    if (state.busy) return toast('当前生成完成后再切换项目');
    ++transition; status.hidden = true; flushWriting();
    if (pendingEditorProject) { homeController?.editorStatus(pendingEditorProject, false); pendingEditorProject = null; }
    if (state.view === 'video') void native.flush().catch(error => toast(error.message, 'error'));
    state.view = 'home'; state.editing = false;
    ensureHome(); hideVideo(); app.classList.add('gx-workspace-hidden');
    homeController.setProjects(state.summaries); homeController.setVisible(true); home.classList.add('is-visible');
    if (projectId && projectId !== activeHomeProject) homeController.selectProject(projectId, true);
    if (!state.summaryLoadedAt || Date.now() - state.summaryLoadedAt > 500) void refreshSummaries().catch(error => toast(error.message, 'error'));
  }
  function showWriting(project) {
    if (state.view === 'video') void native.flush().catch(error => toast(error.message, 'error'));
    hideHome(); hideVideo(); app.classList.remove('gx-workspace-hidden');
    app.classList.add('gx-workspace-fade');
    state.writerId = project.id; state.view = 'writer';
    onWriting(project);
    setTimeout(() => app.classList.remove('gx-workspace-fade'), reduced() ? 0 : 250);
  }
  async function enterEditor(projectId) {
    if (state.busy) return toast('当前生成完成后再切换项目');
    const token = ++transition;
    pendingEditorProject = projectId;
    let failure = '';
    homeController?.editorStatus(projectId, true);
    status.innerHTML = `${icon('clock')}<span>正在打开项目…</span>`; status.hidden = false;
    try {
      flushWriting();
      const project = await loadProject(projectId, true);
      if (token !== transition) return;
      if (project.kind !== 'video') { showWriting(project); return; }
      state.videoId = project.id;
      video.classList.add('is-preparing');
      await native.prepare(project);
      if (token !== transition) return;
      await paint();
      state.view = 'video'; state.editing = false;
      // Pause the background renderer before the compositor blends the views.
      hideHome(); app.classList.add('gx-workspace-hidden');
      native.setVisible(true); video.classList.remove('is-preparing'); video.classList.add('is-visible');
    } catch (error) {
      if (token !== transition || error.name === 'AbortError') return;
      video.classList.remove('is-preparing');
      failure = error.message;
      homeController?.editorStatus(projectId, false, failure); toast(error.message, 'error');
    } finally {
      if (token === transition) { status.hidden = true; homeController?.editorStatus(projectId, false, failure); pendingEditorProject = null; }
    }
  }
  async function openLast(view) {
    const kind = view === 'video' ? 'video' : 'writing';
    const remembered = kind === 'video' ? state.videoId : state.writerId;
    const id = remembered || state.summaries.find(p => p.kind === kind)?.id;
    if (!id) return newProjectDialog(kind);
    if (view === 'writer') {
      try { const p = await loadProject(id); showWriting(p); } catch (error) { toast(error.message, 'error'); }
    } else await enterEditor(id);
  }
  async function updateMetadata(id, changes) {
    patching.add(id);
    try {
      const { project } = await api(`/api/projects/${encodeURIComponent(id)}`, changes, { method: 'PATCH' });
      const local = findProject(id);
      if (local) for (const key of ['title', 'description', 'metadataRevision', 'updatedAt']) local[key] = project[key];
      else putProject(project);
      ++summaryEpoch;
      const summary = { ...(summaryOf(id) || {}), id, title: project.title, description: project.description || '', kind: project.kind, createdAt: project.createdAt, updatedAt: project.updatedAt };
      state.summaries = state.summaries.map(p => p.id === id ? summary : p);
      homeController?.setProjects(state.summaries);
      queueRefresh();
      native.updateProject(summary); return summary;
    } finally { patching.delete(id); }
  }
  function factory(kind, title, description = '') {
    const now = new Date().toISOString();
    const p = { id: uid(), kind, title, description, createdAt: now, updatedAt: now, source: { title: '', text: '', url: '' }, brief: { audience: '学院师生', tone: '清晰亲切', scenario: '活动预告', length: '标准' }, facts: [], missing: [], outputs: null, review: null, history: [], runs: [], isDemo: false };
    if (kind === 'video') p.video = { timeline: [], captions: [], aspect: '16:9', resolution: '720', sourceVolume: 1, music: null, script: '', animationPlan: null };
    return p;
  }
  function newProjectDialog(initialKind = 'video') {
    let kind = initialKind;
    let alive = true;
    showModal({ title: '新建项目', kicker: 'PROJECT ARCHIVE', onClose: () => { alive = false; }, body: `<div class="gx-project-form-kind"><button class="gx-project-kind ${kind === 'video' ? 'selected' : ''}" data-kind="video">${icon('video')}视频项目</button><button class="gx-project-kind ${kind === 'writing' ? 'selected' : ''}" data-kind="writing">${icon('pen')}文案项目</button></div><div class="form-field"><label for="new-project-name">项目名称</label><input id="new-project-name" maxlength="120" placeholder="为项目取个名字" autocomplete="off"></div><div class="form-field"><label for="new-project-description">简介（可选）</label><textarea id="new-project-description" maxlength="1000" rows="3" placeholder="记录用途或想法"></textarea></div><div class="modal-actions"><button class="btn primary" id="create-named-project">创建项目</button></div>`, onMount: (root, close) => {
      root.querySelectorAll('[data-kind]').forEach(button => button.onclick = () => { kind = button.dataset.kind; root.querySelectorAll('[data-kind]').forEach(b => b.classList.toggle('selected', b.dataset.kind === kind)); });
      const create = async () => {
        const title = root.querySelector('#new-project-name').value.trim(), description = root.querySelector('#new-project-description').value.trim();
        if (!title) return toast('请填写项目名称');
        const button = root.querySelector('#create-named-project'); button.disabled = true; button.textContent = '正在创建…';
        try {
          const p = factory(kind, title, description);
          const { project } = await api(`/api/projects/${p.id}`, p, { method: 'PUT' });
          putProject(project); await refreshSummaries(); if (alive) { close(); showHome(project.id); } toast('项目已归档');
        } catch (error) { toast(error.message, 'error'); if (alive) { button.disabled = false; button.textContent = '创建项目'; } }
      };
      root.querySelector('#create-named-project').onclick = create;
      root.querySelector('#new-project-name').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); void create(); } };
      root.querySelector('#new-project-name').focus();
    } });
  }
  async function sendScriptToVideo(project) {
    if (!project.outputs?.video) return toast('请先生成视频分镜');
    project.kind = 'video';
    project.video ||= { timeline: [], captions: [], aspect: '16:9', resolution: '720', sourceVolume: 1, music: null };
    const saved = await saveProject(project); if (saved === null) return;
    state.videoId = project.id;
    await actions.importScript(project, project.outputs.video, project.title);
    await refreshSummaries(); showHome(project.id);
    toast('文案已送入同一项目，确认信息后可进入剪辑');
  }
  return {
    showHome, enterEditor, openLast, newProjectDialog, updateMetadata, refreshSummaries, loadProject, putProject, sendScriptToVideo,
    leaveForWorkspace() {
      ++transition; status.hidden = true;
      if (pendingEditorProject) { homeController?.editorStatus(pendingEditorProject, false); pendingEditorProject = null; }
      flushWriting(); if (state.view === 'video') void native.flush().catch(error => toast(error.message, 'error'));
      hideHome(); hideVideo(); app.classList.remove('gx-workspace-hidden');
    },
    recordSaved(project) {
      const current = findProject(project.id);
      if (current && !patching.has(project.id) && (project.metadataRevision || 0) >= (current.metadataRevision || 0))
        for (const key of ['title', 'description', 'metadataRevision', 'updatedAt']) if (project[key] !== undefined) current[key] = project[key];
      queueRefresh();
    },
    removeProject(id) { full.delete(id); state.projects = state.projects.filter(p => p.id !== id); state.summaries = state.summaries.filter(p => p.id !== id); homeController?.setProjects(state.summaries); },
    flush: () => native.flush(),
    dispose() { clearTimeout(summaryTimer); homeController?.(); native.dispose(); actions.dispose?.(); home.remove(); video.remove(); status.remove(); },
  };
}
