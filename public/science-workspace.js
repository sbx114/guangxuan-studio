import { clone, escapeHtml as h, icon, toast } from './ui.js';
import { createScienceImporter } from './science-import.js';
import { createVisualNovelWorkspace } from './visual-novel.js';


export function ensureScienceProject(project) {
  if (!project.source || typeof project.source !== 'object' || Array.isArray(project.source)) project.source = { title: '', text: '', url: '' };
  for (const key of ['title', 'text', 'url']) if (typeof project.source[key] !== 'string') project.source[key] = '';
  if (!project.brief || typeof project.brief !== 'object' || Array.isArray(project.brief)) project.brief = {};
  project.brief.audience ||= '普通公众';
  project.brief.tone ||= '清晰亲切';
  project.brief.length ||= '标准';
  project.brief.scenario = '科普讲解';
  project.facts = Array.isArray(project.facts) ? project.facts : [];
  project.history = Array.isArray(project.history) ? project.history : [];
  project.runs = Array.isArray(project.runs) ? project.runs : [];
  if (!project.science || typeof project.science !== 'object' || Array.isArray(project.science)) project.science = {};
  const result = project.science.result;
  if (result && (typeof result !== 'object' || Array.isArray(result))) project.science.result = null;
  else if (result) {
    for (const key of ['title', 'summary', 'explanation']) if (typeof result[key] !== 'string') result[key] = '';
    for (const [key, fields] of [['terms', ['term', 'explanation']], ['misconceptions', ['claim', 'correction']]]) {
      result[key] = (Array.isArray(result[key]) ? result[key] : []).filter(item => item && typeof item === 'object' && fields.every(field => typeof item[field] === 'string'));
    }
    if (result.video && (!Array.isArray(result.video.shots) || !result.video.shots.every(shot => shot && Number.isFinite(Number(shot.duration)) && Number(shot.duration) > 0 && typeof shot.visual === 'string'))) result.video = null;
  }
  project.science.step = 'novel';
  return project;
}

export function scienceText(project) {
  const result = project.science?.result;
  if (!result) return '';
  const terms = (result.terms || []).map(item => `- ${item.term}：${item.explanation}`).join('\n');
  const misconceptions = (result.misconceptions || []).map(item => `- 容易混淆：${item.claim}\n  说明：${item.correction}`).join('\n');
  return [result.title, result.summary, result.explanation, terms && `术语解释\n${terms}`, misconceptions && `常见误区\n${misconceptions}`].filter(Boolean).join('\n\n');
}

/** Use the existing writing/video contract so the same project can continue in either editor. */
export function syncScienceOutputs(project) {
  const result = project.science?.result;
  if (!result) return;
  project.outputs ||= {};
  project.outputs.article = {
    title: result.title || project.title,
    titles: [],
    lead: result.summary || '',
    body: [result.explanation || '', ...(result.terms || []).map(item => `${item.term}：${item.explanation}`), ...(result.misconceptions || []).map(item => `容易混淆：${item.claim}\n说明：${item.correction}`)].filter(Boolean).join('\n\n'),
  };
  if (result.video?.shots?.length) {
    project.outputs.video = clone(result.video);
    project.outputs.video.durationSeconds = Math.round(result.video.shots.reduce((total, shot) => total + Number(shot.duration || 0), 0) * 10) / 10;
  }
}

/** A minimal project shell around the material → library → interaction flow. */
export function createScienceWorkspace({ saveProject, callAi, requireConnection, onNew, onMetadata } = {}) {
  let active = null, disposed = false, revision = 0;
  const removed = new Set(), generations = new Map(), pendingSaves = new Set(), savesByProject = new Map(), dirty = new Map(), metadataByProject = new Map();
  const generationOf = project => generations.get(project.id) || 0;
  const current = (project, generation) => !disposed && !removed.has(project.id) && generationOf(project) === generation;
  const aborted = () => new DOMException('项目操作已取消。', 'AbortError');
  const visible = project => !disposed && active?.project === project && active.section.isConnected;
  function status(project, text, failed = false) { if (!visible(project)) return; const label = active.section.querySelector('[data-science-save]'); label.textContent = text; label.classList.toggle('is-error', failed); }
  function persist(project) {
    const generation = generationOf(project); if (!current(project, generation)) return Promise.reject(aborted());
    const version = ++revision; dirty.set(project.id, { project, version }); status(project, '正在保存…');
    const pending = Promise.resolve().then(() => { if (!current(project, generation)) throw aborted(); return saveProject?.(project); }).then(saved => { if (!current(project, generation)) throw aborted(); if (saved === null) throw new Error('作品尚未保存，请重试。'); if (dirty.get(project.id)?.version === version) dirty.delete(project.id); status(project, '已保存'); return saved; }).catch(error => { if (error.name !== 'AbortError') status(project, '保存失败，点击重试', true); throw error; }).finally(() => { pendingSaves.delete(pending); const group = savesByProject.get(project.id); group?.delete(pending); if (!group?.size) savesByProject.delete(project.id); });
    pendingSaves.add(pending); const group = savesByProject.get(project.id) || new Set(); savesByProject.set(project.id, group); group.add(pending); return pending;
  }
  let novelDesk;
  const importer = createScienceImporter({ saveProject: persist, onSelected: project => novelDesk.sourceChanged(project) });
  novelDesk = createVisualNovelWorkspace({ saveProject: persist, callAi, requireConnection, importer, onSaveState: status });
  async function flush() {
    await novelDesk.flush();
    if (active && !removed.has(active.project.id)) await importer.flush(active.project, { requireSelection: false });
    await Promise.all([...pendingSaves]);
    await Promise.all([...dirty.values()].map(({ project }) => persist(project)));
    await Promise.all([...pendingSaves]);
    await Promise.all([...metadataByProject.values()].flatMap(group => [...group]));
  }
  function render(root, project) {
    if (disposed || removed.has(project.id)) return;
    active?.unbind?.(); novelDesk.unmount(); ensureScienceProject(project);
    root.innerHTML = '<section class="workspace science-workspace science-novel-workspace" data-science-project="' + h(project.id) + '"><div class="workspace-title"><div><input class="project-title-input" data-science-title value="' + h(project.title) + '" maxlength="120" aria-label="科普项目名称"></div><div class="row wrap"><button class="btn small" data-science-new>' + icon('plus') + '新建</button><button class="science-save" data-science-save>自动保存</button></div></div><div class="science-body"><div data-science-novel-host></div></div></section>';
    const section = root.querySelector('[data-science-project]'), lifecycle = new AbortController(); active = { root, section, project, unbind: () => lifecycle.abort() };
    novelDesk.mount(section.querySelector('[data-science-novel-host]'), project);
    section.querySelector('[data-science-new]').addEventListener('click', () => onNew?.(), { signal: lifecycle.signal });
    section.querySelector('[data-science-save]').addEventListener('click', () => { void flush().then(() => persist(project)).catch(error => { if (error.name !== 'AbortError') toast(error.message, 'error'); }); }, { signal: lifecycle.signal });
    section.querySelector('[data-science-title]').addEventListener('change', event => {
      const field = event.target, title = field.value.trim(), generation = generationOf(project);
      if (!title) { field.value = project.title; toast('项目名称不能为空。'); return; }
      const pending = Promise.resolve().then(async () => { if (!current(project, generation)) return; if (onMetadata) { const result = await onMetadata(project.id, { title }); if (current(project, generation)) project.title = result?.title || title; } else { project.title = title; await persist(project); } }).catch(error => { if (current(project, generation)) { field.value = project.title; toast(error.message, 'error'); } }).finally(() => { const group = metadataByProject.get(project.id); group?.delete(pending); if (!group?.size) metadataByProject.delete(project.id); });
      const group = metadataByProject.get(project.id) || new Set(); metadataByProject.set(project.id, group); group.add(pending);
    }, { signal: lifecycle.signal });
  }
  async function cancelProject(id) {
    removed.add(id); generations.set(id, (generations.get(id) || 0) + 1); dirty.delete(id);
    await Promise.allSettled([novelDesk.cancelProject(id), importer.cancelProject(id)]);
    await Promise.allSettled([...(savesByProject.get(id) || []), ...(metadataByProject.get(id) || [])]);
    if (active?.project.id === id) { active.unbind?.(); active = null; }
  }
  return {
    render, flush, cancelProject,
    deactivate() { active?.unbind?.(); novelDesk.unmount(); active = null; },
    isBusy: id => novelDesk.isBusy(id),
    dispose() { if (disposed) return; disposed = true; active?.unbind?.(); novelDesk.dispose(); importer.dispose(); active = null; dirty.clear(); },
  };
}

