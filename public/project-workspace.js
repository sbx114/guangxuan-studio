import { api, icon, escapeHtml as h, showModal, toast, uid } from './ui.js';
import { mountRhineHome } from './rhine-host.js';
import { createNativeStudio } from './native-studio.js';
import { createOpenfilmActions } from './openfilm-actions.js';
import { createEditorAssistant } from './editor-assistant.js';
import { createEditorReferences } from './editor-references.js';
import { createTaskCenter } from './task-center.js';
import { createProjectBundles } from './project-bundles.js';
import { createSourceAnalysis } from './source-analysis.js';
import { createSourceVersions } from './source-versions.js';
import { createExportPreflightUI } from './export-preflight.js';
import { createAppAssistant } from './app-assistant.js';

function writingOutput(project, channel) {
  const draft = project.writing?.draft;
  return draft?.channel === channel && draft.output && typeof draft.output === 'object' && !Array.isArray(draft.output) ? draft.output : project.outputs?.[channel];
}

export function createProjectWorkspace({ app, state, saveProject, callAi, requireConnection, onWriting, onScience, beforeLeave, onLeave, onOtherView, onAssistantChanged }) {
  const home = document.createElement('div'), video = document.createElement('div'), status = document.createElement('div');
  home.id = 'gx-home-portal'; video.id = 'gx-video-portal'; status.className = 'gx-transition-status'; status.hidden = true;
  document.body.insertBefore(home, app); document.body.insertBefore(video, app); document.body.append(status);
  let homeController = null, transition = 0, summaryTimer = null, summaryRequest = null, activeHomeProject = null, summaryEpoch = 0, pendingEditorProject = null;
  const full = new Set(), patching = new Set();
  const lifecycle = new AbortController();
  let taskProjectOverride = '';
  state.summaries ||= [];
  const references = createEditorReferences({ onChanged: (id, count) => native.setReferenceCount(id, count), getTimelineRange: async () => (await native.timelineSelection())?.range });
  const currentProjectId = () => state.view === 'video' ? state.videoId : state.view === 'writer' ? state.writerId : state.view === 'science' ? state.scienceId : state.view === 'home' ? activeHomeProject : '';
  const sourceAnalysis = createSourceAnalysis({ getSettings: () => state.settings, onChanged: () => queueRefresh() });
  const sourceVersions = createSourceVersions({
    beforeAction: () => flushCurrent(false),
    onChanged: project => { putProject(project); native.updateProject(project); queueRefresh(); void refreshSourceVersion(project.id); },
    onOpenSource: id => enterEditor(id),
  });
  const preflight = createExportPreflightUI({ getProjectId: () => state.videoId, onNavigate: async (id, target) => { await enterEditor(id, 'video'); await native.seek(target); } });
  const bundles = createProjectBundles({
    beforeExport: () => flushCurrent(false),
    onRestored: async result => { if (result.project) putProject(result.project); await refreshSummaries({ force: true }); await showHome(result.projectId); },
  });
  const taskCenter = createTaskCenter({
    getProjectId: () => taskProjectOverride || currentProjectId(),
    onOpenProject: async (id, task) => {
      await enterEditor(id);
      const project = await loadProject(id);
      if (task?.type === 'source-analysis') await sourceAnalysis.show(project, { jobId: task.sourceJobId });
      else if (['animation-render', 'motion-preview'].includes(task?.type)) actions.showAnimation(project);
    },
  });
  const actions = createOpenfilmActions({ getSettings: () => state.settings, requireConnection, callAi, saveProject, beforeAi: (id, options) => references.flush(id, options), beforeAction: id => native.getProject()?.id === id ? native.flush() : Promise.resolve(), onChanged: () => queueRefresh() });
  const assistant = createEditorAssistant({
    getSettings: () => state.settings, requireConnection, callAi, saveProject,
    beforeAction: id => native.getProject()?.id === id ? native.flush() : Promise.resolve(),
    beforeAi: (id, options) => references.flush(id, options),
    onChanged: id => refreshAssistantProject(id),
    onUndo: undoAssistantEffect,
    onAnimation: p => actions.showAnimation(findProject(p?.id) || p),
    onVisibilityChange: visible => native.setAssistantVisible(visible),
  });
  const globalAssistant = createAppAssistant({
    getSettings: () => state.settings, requireConnection,
    getProjects: () => state.summaries,
    getProjectId: currentProjectId,
    beforeStart: () => flushCurrent(false),
    onChanged: id => refreshAssistantProject(id),
    onUndo: undoAssistantEffect,
  });
  document.addEventListener('gx:assistant-open', event => {
    const { projectId, runId } = event.detail || {};
    if (typeof runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(runId)) return;
    if (projectId != null && (typeof projectId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(projectId))) return;
    globalAssistant.open({ projectId: projectId || null, runId });
  }, { signal: lifecycle.signal });
  const native = createNativeStudio(video, {
    assistant, references,
    onBack: id => showHome(id),
    onArchive: () => onOtherView('archive'),
    onView: view => onOtherView(view),
    onSettings: () => onOtherView('settings'),
    onAnimation: p => actions.showAnimation(findProject(p?.id) || p),
    onRoughCut: p => actions.showRoughCut(findProject(p?.id) || p),
    onChanged: () => queueRefresh(),
    onTools: project => openTools(project?.id),
    beforeExport: (id, spec) => preflight.beforeExport(id, spec),
  });
  const findProject = id => state.projects.find(p => p.id === id);
  const summaryOf = id => state.summaries.find(p => p.id === id);
  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const paint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  function openTasks(options = {}) { taskProjectOverride = options.projectId || ''; taskCenter.open(options); }
  async function undoAssistantEffect(projectId, undo) {
    if (!undo?.id) throw new Error('这次修改没有可用的撤销记录。');
    const result = await api('/api/assistant/undo', { projectId, undoId: undo.id });
    if (!result.restored) throw new Error('修改尚未撤销，请重试。');
    return result;
  }
  async function refreshAssistantProject(id) {
    if (!id) return;
    const project = await loadProject(id, true);
    native.updateProject(project);
    await refreshSummaries({ force: true });
    await onAssistantChanged?.(project);
    return project;
  }
  async function refreshSourceVersion(id) {
    try { native.setSourceVersionStatus(id, await sourceVersions.status(id)); } catch { /* The explicit version tool offers retry. */ }
  }
  async function openTools(projectId = currentProjectId()) {
    if (!projectId) { openTasks({ scope: 'all' }); return; }
    try {
      const project = await loadProject(projectId), videoProject = project.kind === 'video';
      const tools = [['backup', 'download', '备份项目'], ...(videoProject ? [['analysis', 'eye', '素材分析'], ['versions', 'link', '关联文案'], ['preflight', 'shield', '导出前体检']] : []), ['tasks', 'clock', '项目任务']];
      showModal({ title: '项目工具 · ' + project.title, body: '<div class="gx-project-tools">' + tools.map(([id, symbol, label]) => '<button class="btn" data-project-tool="' + id + '">' + icon(symbol) + h(label) + '</button>').join('') + '</div><p class="small muted" data-tools-version-status></p>', onMount(root, close) {
        root.querySelectorAll('[data-project-tool]').forEach(button => { button.onclick = () => {
          close();
          const action = button.dataset.projectTool;
          if (action === 'backup') bundles.openExport(project);
          if (action === 'analysis') void sourceAnalysis.show(project).catch(error => toast(error.message, 'error'));
          if (action === 'versions') void sourceVersions.open(project).catch(error => toast(error.message, 'error'));
          if (action === 'preflight') void native.flush().then(() => preflight.open(project.id)).catch(error => toast(error.message, 'error'));
          if (action === 'tasks') openTasks({ projectId: project.id });
        }; });
        if (videoProject) void sourceVersions.status(project.id).then(value => {
          const label = root.querySelector('[data-tools-version-status]'); if (!label?.isConnected) return;
          const changed = ['changed', 'untracked'].includes(value.status);
          label.textContent = changed ? '来源文案有 ' + (value.changes?.length || 1) + ' 处更新，可查看并选择同步。' : value.status === 'in-sync' ? '关联文案已同步。' : '关联文案或科普项目后，可查看更新。';
          native.setSourceVersionStatus(project.id, value);
        }).catch(() => {});
      } });
    } catch (error) { toast(error.message, 'error'); }
  }

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
  async function readBackup(id) {
    await state.saveQueue;
    const result = await api(`/api/projects/${encodeURIComponent(id)}`);
    if (!result.project) throw new Error('这个项目已不存在，请刷新档案');
    return result.project;
  }
  async function refreshSummaries({ force = false } = {}) {
    if (force && summaryRequest) { ++summaryEpoch; await summaryRequest.catch(() => {}); }
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
      onOpen: view => { if (view === 'assistant') globalAssistant.open(); else if (view === 'tasks') openTasks({ scope: 'all' }); else if (view === 'restore') bundles.openRestore(); else if (view === 'tools') void openTools(activeHomeProject); else if (['video', 'writer', 'science'].includes(view)) void openLast(view); else onOtherView(view); },
      onNewProject: kind => newProjectDialog(kind || 'video'),
      onEditProject: id => enterEditor(id),
      onUpdateProject: async request => {
        try { const project = await updateMetadata(request.projectId, { title: request.title, description: request.description, ...(request.cover !== undefined ? { cover: request.cover } : {}), ...(request.coverAssetId !== undefined ? { coverAssetId: request.coverAssetId } : {}) }); homeController.projectUpdated(request.requestId, project); }
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
  async function flushWriting() {
    if (state.view !== 'writer') return;
    if (state.saveTimer) {
      clearTimeout(state.saveTimer); state.saveTimer = null;
      const p = findProject(state.writerId);
      if (p && await saveProject(p) === null) throw new Error('文案尚未保存，请重试后再切换。');
    }
    await state.saveQueue;
  }
  async function flushCurrent(leaving = true) {
    await beforeLeave?.({ leaving });
    await flushWriting();
    await references.flush(undefined, { imports: false });
    await assistant.flush();
    if (state.view === 'video') await native.flush();
  }
  async function showHome(projectId) {
    if (state.busy) return toast('当前生成完成后再切换项目');
    const token = ++transition; status.hidden = true;
    try { await flushCurrent(); } catch (error) { toast(error.message, 'error'); return; }
    if (token !== transition) return;
    if (pendingEditorProject) { homeController?.editorStatus(pendingEditorProject, false); pendingEditorProject = null; }
    onLeave?.(state.view); state.view = 'home';
    ensureHome(); hideVideo(); app.classList.add('gx-workspace-hidden');
    homeController.setProjects(state.summaries); homeController.setVisible(true); home.classList.add('is-visible');
    if (projectId && projectId !== activeHomeProject) homeController.selectProject(projectId, true);
    if (!state.summaryLoadedAt || Date.now() - state.summaryLoadedAt > 500) void refreshSummaries().catch(error => toast(error.message, 'error'));
  }
  function showWriting(project, view = 'writer') {
    onLeave?.(state.view);
    hideHome(); hideVideo(); app.classList.remove('gx-workspace-hidden');
    app.classList.add('gx-workspace-fade');
    state.view = view;
    if (view === 'science') { state.scienceId = project.id; onScience?.(project); }
    else { state.writerId = project.id; onWriting(project); }
    setTimeout(() => app.classList.remove('gx-workspace-fade'), reduced() ? 0 : 250);
  }
  async function enterEditor(projectId, preferredView) {
    if (state.busy) return toast('当前生成完成后再切换项目');
    const token = ++transition;
    pendingEditorProject = projectId;
    let failure = '';
    homeController?.editorStatus(projectId, true);
    status.innerHTML = `${icon('clock')}<span>正在打开项目…</span>`; status.hidden = false;
    try {
      await flushCurrent();
      if (token !== transition) return;
      const project = await loadProject(projectId);
      if (token !== transition) return;
      const view = preferredView || (project.kind === 'science' ? 'science' : project.kind === 'video' ? 'video' : 'writer');
      if (view !== 'video') { showWriting(project, view); return; }
      state.videoId = project.id;
      video.classList.add('is-preparing');
      await native.prepare(project);
      if (token !== transition) return;
      await paint();
      if (token !== transition) return;
      onLeave?.(state.view); state.view = 'video'; state.editing = false;
      // Pause the background renderer before the compositor blends the views.
      hideHome(); app.classList.add('gx-workspace-hidden');
      native.setVisible(true); video.classList.remove('is-preparing'); video.classList.add('is-visible');
      void refreshSourceVersion(project.id);
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
    const kind = view === 'writer' ? 'writing' : view;
    const remembered = view === 'video' ? state.videoId : view === 'science' ? state.scienceId : state.writerId;
    const id = (remembered && state.summaries.some(p => p.id === remembered && p.kind === kind) ? remembered : null) || state.summaries.find(p => p.kind === kind)?.id;
    if (!id) return newProjectDialog(kind);
    if (state.view === view && remembered === id) return;
    await enterEditor(id, view);
  }
  async function updateMetadata(id, changes) {
    patching.add(id);
    try {
      const { project } = await api(`/api/projects/${encodeURIComponent(id)}`, changes, { method: 'PATCH' });
      const local = findProject(id);
      if (local) for (const key of ['title', 'description', 'cover', 'coverAssetId', 'metadataRevision', 'updatedAt']) local[key] = project[key];
      else putProject(project);
      ++summaryEpoch;
      const summary = { ...(summaryOf(id) || {}), id, title: project.title, description: project.description || '', cover: project.cover, coverAssetId: project.coverAssetId, coverUrl: project.coverAssetId ? `/api/project-covers/${project.coverAssetId}` : '', kind: project.kind, createdAt: project.createdAt, updatedAt: project.updatedAt };
      state.summaries = state.summaries.map(p => p.id === id ? summary : p);
      homeController?.setProjects(state.summaries);
      queueRefresh();
      native.updateProject(summary); return summary;
    } finally { patching.delete(id); }
  }
  function factory(kind, title, description = '') {
    const now = new Date().toISOString();
    const p = { id: uid(), kind, title, description, createdAt: now, updatedAt: now, source: { title: '', text: '', url: '' }, brief: { audience: '学院师生', tone: '清晰亲切', scenario: '活动预告', length: '标准' }, facts: [], missing: [], outputs: null, review: null, history: [], runs: [], isDemo: false };
    if (kind === 'writing') p.brief = { audience: 'auto', tone: 'auto', scenario: 'auto', length: 'auto' };
    if (kind === 'video') p.video = { timeline: [], captions: [], aspect: '16:9', resolution: '720', sourceVolume: 1, music: null, script: '', animationPlan: null };
    if (kind === 'science') { p.brief.scenario = '科普讲解'; p.brief.audience = '普通公众'; p.science = { step: 'source', result: null }; }
    return p;
  }
  function newProjectDialog(initialKind = 'video') {
    let kind = ['video', 'writing', 'science'].includes(initialKind) ? initialKind : 'video';
    let alive = true, creating = false;
    showModal({ title: '新建项目',  onClose: () => { alive = false; }, body: `<div class="gx-project-form-kind"><button class="gx-project-kind ${kind === 'video' ? 'selected' : ''}" data-kind="video">${icon('video')}视频</button><button class="gx-project-kind ${kind === 'writing' ? 'selected' : ''}" data-kind="writing">${icon('pen')}文案</button><button class="gx-project-kind ${kind === 'science' ? 'selected' : ''}" data-kind="science">${icon('science')}科普</button></div><div class="form-field"><label for="new-project-name">项目名称</label><input id="new-project-name" maxlength="120" placeholder="为项目取个名字" autocomplete="off"></div><div class="form-field"><label for="new-project-description">简介（可选）</label><textarea id="new-project-description" maxlength="1000" rows="3" placeholder="记录用途或想法"></textarea></div><div class="modal-actions"><button class="btn primary" id="create-named-project">创建项目</button></div>`, onMount: (root, close) => {
      root.querySelectorAll('[data-kind]').forEach(button => button.onclick = () => { kind = button.dataset.kind; root.querySelectorAll('[data-kind]').forEach(b => b.classList.toggle('selected', b.dataset.kind === kind)); });
      const create = async () => {
        if (!alive || creating) return;
        const title = root.querySelector('#new-project-name').value.trim(), description = root.querySelector('#new-project-description').value.trim();
        if (!title) return toast('请填写项目名称');
        creating = true;
        const button = root.querySelector('#create-named-project'); button.disabled = true; button.textContent = '正在创建…';
        try {
          const p = factory(kind, title, description);
          const { project } = await api(`/api/projects/${p.id}`, p, { method: 'PUT' });
          putProject(project); await refreshSummaries({ force: true }); if (alive) { close(); showHome(project.id); } toast('项目已归档');
        } catch (error) { toast(error.message, 'error'); if (alive) { button.disabled = false; button.textContent = '创建项目'; } }
        finally { creating = false; }
      };
      root.querySelector('#create-named-project').onclick = create;
      root.querySelector('#new-project-name').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); void create(); } };
      root.querySelector('#new-project-name').focus();
    } });
  }
  async function sendScriptToVideo(project) {
    const script = writingOutput(project, 'video');
    if (project.kind !== 'video') {
      if (!script?.shots?.length) return toast('请先生成视频分镜');
      const videoProject = await scienceVideo(project);
      const sourceStatus = await sourceVersions.status(videoProject.id);
      if (['changed', 'untracked'].includes(sourceStatus.status)) {
        await showHome(videoProject.id); await sourceVersions.open(videoProject); return;
      }
      if (script?.shots?.length) await actions.importScript(videoProject, script, project.title);
      await refreshSummaries(); await showHome(videoProject.id);
      toast('分镜已送入关联视频项目'); return;
    }
    if (!script) return toast('请先生成视频分镜');
    project.kind = 'video';
    project.video ||= { timeline: [], captions: [], aspect: '16:9', resolution: '720', sourceVolume: 1, music: null };
    const saved = await saveProject(project); if (saved === null) return;
    state.videoId = project.id;
    await actions.importScript(project, script, project.title);
    await refreshSummaries(); showHome(project.id);
    toast('文案已送入同一项目，确认信息后可进入剪辑');
  }
  async function scienceVideo(project) {
    if (project.kind === 'science') project.science ||= {};
    let target;
    const linked = project.kind === 'science' ? project.science.videoProjectId : project.videoProjectId;
    if (linked) {
      try { target = await loadProject(linked); }
      catch (error) { if (error.code !== 'PROJECT_NOT_FOUND') throw error; }
    }
    const creatingTarget = !target || target.kind !== 'video';
    if (creatingTarget) {
      target = factory('video', `${project.title} · 视频`.slice(0, 120), project.description || '科普项目的动画与剪辑');
      target.sourceProjectId = project.id;
    }
    if (creatingTarget) {
      target.source = structuredClone(project.source);
      target.brief = structuredClone(project.brief);
      target.facts = structuredClone(project.facts || []);
      target.outputs = structuredClone(project.outputs || null);
      target.video.script = writingOutput(project, 'video')?.shots?.map(shot => shot.narration || '').filter(Boolean).join('\n') || project.science?.result?.explanation || '';
      if (await saveProject(target) === null) throw new Error('关联视频项目尚未保存，请重试。');
      const linked = await api('/api/projects/' + encodeURIComponent(target.id) + '/source-link', { sourceProjectId: project.id });
      if (linked.project) target = linked.project;
    }
    putProject(target);
    if (project.kind === 'science') project.science.videoProjectId = target.id; else project.videoProjectId = target.id;
    if (await saveProject(project) === null) throw new Error('科普关联记录尚未保存，请重试。');
    state.videoId = target.id;
    await refreshSummaries();
    return target;
  }
  return {
    showHome, enterEditor, openLast, newProjectDialog, updateMetadata, refreshSummaries, loadProject, readBackup, putProject, sendScriptToVideo, openTools,
    openTasks,
    openAssistant: options => globalAssistant.open(options),
    restoreBundle: () => bundles.openRestore(),
    async showScienceAnimation(project) { try { const target = await scienceVideo(project); actions.showAnimation(target); } catch (error) { toast(error.message, 'error'); } },
    async leaveForWorkspace() {
      const token = ++transition; status.hidden = true;
      try { await flushCurrent(); } catch (error) { toast(error.message, 'error'); return false; }
      if (token !== transition) return false;
      if (pendingEditorProject) { homeController?.editorStatus(pendingEditorProject, false); pendingEditorProject = null; }
      onLeave?.(state.view); hideHome(); hideVideo(); app.classList.remove('gx-workspace-hidden');
      return true;
    },
    recordSaved(project) {
      const current = findProject(project.id);
      if (current?.video && (project.video?.sourceSyncRevision || 0) > (current.video.sourceSyncRevision || 0)) {
        for (const key of ['script', 'openfilmDraftCaptions', 'sourceStoryboard', 'sourceSyncRevision']) {
          if (Object.hasOwn(project.video, key)) current.video[key] = structuredClone(project.video[key]); else delete current.video[key];
        }
        if (project.sourceProjectId) current.sourceProjectId = project.sourceProjectId; else delete current.sourceProjectId;
        native.updateProject(current);
      }
      if (current && !patching.has(project.id) && (project.metadataRevision || 0) >= (current.metadataRevision || 0))
        for (const key of ['title', 'description', 'cover', 'coverAssetId', 'metadataRevision', 'updatedAt']) if (project[key] !== undefined) current[key] = project[key];
      queueRefresh();
    },
    removeProject(id) { full.delete(id); state.projects = state.projects.filter(p => p.id !== id); state.summaries = state.summaries.filter(p => p.id !== id); homeController?.setProjects(state.summaries); },
    flush: () => flushCurrent(false),
    isBusy: id => assistant.isBusy(id) || globalAssistant.isBusy(id),
    async cancelProject(id) { await references.cancelProject(id); await assistant.cancelProject?.(id); await globalAssistant.cancelProject?.(id); actions.cancelProject?.(id); },
    dispose() { lifecycle.abort(); clearTimeout(summaryTimer); homeController?.(); references.dispose(); assistant.dispose(); globalAssistant.dispose(); sourceAnalysis.dispose(); sourceVersions.dispose(); preflight.dispose(); bundles.dispose(); taskCenter.dispose(); native.dispose(); actions.dispose?.(); home.remove(); video.remove(); status.remove(); },
  };
}
