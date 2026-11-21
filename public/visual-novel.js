import { api, fetchLocal, clone, escapeHtml as h, icon, saveFile, safeName, showModal, toast, uid } from './ui.js';
import { hydratePlayableNovel, normalizeNovelConfig, validatePlayableNovel, serializePlayableNovel, novelFingerprint } from './visual-novel-model.js';
import { resolveNovelArt, novelAssetUrl } from './visual-novel-art.js';
import { createNovelPlayer } from './visual-novel-player.js';
import { createNovelAssetManager, resolveNovelLibrary } from './novel-assets.js';

const MAX_EXPORT_IMAGES = 30 * 1024 * 1024;
const pathFor = project => '/api/projects/' + encodeURIComponent(project.id);
function styles() { for (const name of ['visual-novel', 'visual-novel-reader']) if (!document.querySelector('[data-style="' + name + '"]')) { const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = '/' + name + '.css'; link.dataset.style = name; document.head.append(link); } }
export async function resolvePlayableNovel(novel, options = {}) { return hydratePlayableNovel(novel, await resolveNovelLibrary(novel.librarySelection, options)); }

export function showVisualNovel(project, novel, { onClose, instantText = false } = {}) {
  styles(); let player, closing, closed = false; const controller = new AbortController();
  const close = showModal({ title: novel.title, wide: true, body: '<div data-novel-player-host><p class="muted" role="status">正在读取公用素材…</p></div>', onMount(root, closeModal) { closing = closeModal; document.body.classList.add('vn-reading'); root.querySelector('.modal').classList.add('vn-reader-dialog'); void resolvePlayableNovel(novel, { signal: controller.signal }).then(value => { if (!closed) player = createNovelPlayer(root.querySelector('[data-novel-player-host]'), value, { art: resolveNovelArt(project.id, value), onClose: closeModal, instantText, storageKey: project.id + ':' + value.id }); }).catch(error => { if (!closed && error.name !== 'AbortError') root.querySelector('[data-novel-player-host]').innerHTML = '<div class="notice error" role="alert">' + h(error.message) + '</div>'; }); }, onClose() { closed = true; controller.abort(); document.body.classList.remove('vn-reading'); player?.dispose(); onClose?.(); } });
  return { close: () => (closing || close)(), getPlayer: () => player };
}
const referencedImages = novel => {
  const result = new Map();
  for (const background of novel.backgrounds) if (background.assetId) result.set(background.assetId, { kind: 'background', name: background.name });
  for (const character of novel.characters) for (const pose of character.portraits) if (pose.assetId) result.set(pose.assetId, { kind: 'portrait', name: character.name + ' · ' + pose.name });
  return result;
};
async function embeddedImages(novel, signal) {
  const images = {}; let total = 0;
  for (const [assetId, meta] of referencedImages(novel)) {
    const response = await fetchLocal(novelAssetUrl(assetId), { signal });
    if (!response.ok) throw new Error('有公用图片无法读取，请在素材库中检查后导出。');
    const mimeType = response.headers.get('content-type')?.split(';')[0];
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)) throw new Error('导出图片格式无效。');
    const bytes = new Uint8Array(await response.arrayBuffer()); total += bytes.length;
    if (total > MAX_EXPORT_IMAGES) throw new Error('离线导出所用图片合计超过30MB，请压缩图片后再导出。');
    let binary = ''; for (let index = 0; index < bytes.length; index += 32768) binary += String.fromCharCode(...bytes.subarray(index, index + 32768));
    images[assetId] = { ...meta, mimeType, dataUrl: 'data:' + mimeType + ';base64,' + btoa(binary) };
  }
  return images;
}
export async function exportNovelJson(project, novel, { signal } = {}) {
  const value = await resolvePlayableNovel(novel, { signal }), assets = await embeddedImages(value, signal);
  return saveFile(safeName(value.title) + '.gxnovel.json', JSON.stringify({ format: 'gx-visual-novel', version: 2, novel: value, assets }, null, 2), 'application/json');
}
export async function createStandaloneNovelHtml(project, novel, { signal } = {}) {
  const value = await resolvePlayableNovel(novel, { signal }), images = await embeddedImages(value, signal), art = resolveNovelArt(project.id, value);
  for (const background of value.backgrounds) art.backgrounds[background.id] = images[background.assetId].dataUrl;
  for (const character of value.characters) for (const pose of character.portraits) art.portraits[character.id][pose.id] = images[pose.assetId].dataUrl;
  const response = await fetchLocal('/visual-novel-reader.css', { signal }); if (!response.ok) throw new Error('离线阅读器样式未能读取。');
  const css = await response.text(), json = JSON.stringify({ novel: value, art }).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; script-src \'unsafe-inline\'; connect-src \'none\'; font-src \'none\'; base-uri \'none\'"><title>' + h(value.title) + '</title><style>html,body{margin:0;width:100%;height:100%;background:#10242f}#novel{height:100%}#novel>.vn-player{height:100dvh;min-height:100dvh;border:0;border-radius:0}' + css + '</style></head><body><main id="novel"></main><script type="application/json" id="novel-data">' + json + '</script><script>(' + createNovelPlayer.toString() + ')(document.getElementById("novel"),JSON.parse(document.getElementById("novel-data").textContent).novel,{art:JSON.parse(document.getElementById("novel-data").textContent).art});</script></body></html>';
}
export async function exportNovelHtml(project, novel, options) { return saveFile(safeName(novel.title) + '-视觉小说.html', await createStandaloneNovelHtml(project, novel, options), 'text/html;charset=utf-8'); }

export function createVisualNovelWorkspace({ saveProject, callAi, requireConnection, importer, onSaveState } = {}) {
  let active = null, disposed = false;
  const jobs = new Map(), generations = new Map(), saves = new Set(), savesByProject = new Map(), removedProjects = new Set(), timers = new Map(), sessions = new Map(), viewers = new Set();
  const assets = createNovelAssetManager({ onChanged: project => { if (project.science.novel) project.science.novelSettingsChanged = true; }, onSave: project => schedule(project) });
  const config = project => {
    const previous = project.science.novelConfig || {}, selection = previous.librarySelection || {};
    // Keep only editing settings and shared references in the project.
    return project.science.novelConfig = { style: 'single-guide', sceneCount: 1, chapterCount: 1, selectedCharacterId: previous.selectedCharacterId || selection.characterId || '', selectedBackgroundId: previous.selectedBackgroundId || selection.backgroundId || '', interactionDensity: ['sparse', 'balanced', 'dense'].includes(previous.interactionDensity) ? previous.interactionDensity : 'balanced', instruction: typeof previous.instruction === 'string' ? previous.instruction : '' };
  };
  const sessionFor = project => { let session = sessions.get(project.id); if (!session) { session = { project, mode: project.science.novel?.version === 2 ? 'overview' : 'setup', error: '', context: null, exporting: false, runtime: null, loadingRuntime: false }; sessions.set(project.id, session); } session.project = project; return session; };
  const alive = (project, generation) => !disposed && (generations.get(project.id) || 0) === generation;
  const live = session => !disposed && active?.session === session && active.host.isConnected;
  const selectionFor = project => clone(importer?.selection(project) || project.science.documentSelection);
  const fingerprint = project => novelFingerprint([selectionFor(project), config(project)]);
  async function persist(project) {
    if (disposed || removedProjects.has(project.id)) return;
    const generation = generations.get(project.id) || 0; clearTimeout(timers.get(project.id)?.timer); timers.delete(project.id);
    if (!alive(project, generation)) return;
    // Runtime library profiles are never saved in a project.
    if (project.science.novel?.version === 2 && project.science.novel.characters) project.science.novel = serializePlayableNovel(project.science.novel);
    if (project.science.novelDraft?.version === 2 && project.science.novelDraft.characters) project.science.novelDraft = serializePlayableNovel(project.science.novelDraft);
    const pending = Promise.resolve().then(() => alive(project, generation) ? saveProject?.(project) : null).then(saved => { if (saved === null && alive(project, generation)) throw new Error('作品尚未保存，请重试。'); return saved; });
    const projectSaves = savesByProject.get(project.id) || new Set(); savesByProject.set(project.id, projectSaves); projectSaves.add(pending);
    saves.add(pending); try { const result = await pending; onSaveState?.(project, '已保存'); return result; } finally { saves.delete(pending); projectSaves.delete(pending); if (!projectSaves.size) savesByProject.delete(project.id); }
  }
  function schedule(project) { if (disposed || removedProjects.has(project.id)) return; clearTimeout(timers.get(project.id)?.timer); const generation = generations.get(project.id) || 0; timers.set(project.id, { project, timer: setTimeout(() => { if (alive(project, generation)) void persist(project).catch(error => { const session = sessionFor(project); session.error = error.message; paint(session); }); }, 650) }); onSaveState?.(project, '等待保存…'); }
  async function context(session, selection = selectionFor(session.project)) {
    if (!selection?.documentId || !selection.unitIds?.length) throw new Error('请先导入资料并选择页段。');
    const value = await api(pathFor(session.project) + '/science-documents/context', selection); session.context = value;
    if (session.project.science.novel) session.project.science.novelStale = session.project.science.novel.sourceHash !== value.hash;
    return value;
  }
  function readConfigFields(session) { if (!live(session)) return; const value = config(session.project); for (const field of active.host.querySelectorAll('[data-novel-config]')) if (field.type !== 'radio' || field.checked) value[field.dataset.novelConfig] = field.value; }
  async function refreshRuntime(session) {
    const novel = session.project.science.novel; if (!novel || novel.version !== 2 || session.loadingRuntime) return;
    const id = novel.id; session.loadingRuntime = true;
    try { const value = await resolvePlayableNovel(novel); if (session.project.science.novel?.id === id) { session.runtime = value; session.runtimeError = ''; } }
    catch (error) { if (session.project.science.novel?.id === id) { session.runtimeError = error.message; session.runtime = null; } }
    finally { session.loadingRuntime = false; paint(session); }
  }
  async function generate(session) {
    const project = session.project; if (jobs.has(project.id)) return;
    readConfigFields(session); const generation = generations.get(project.id) || 0, controller = new AbortController(), job = { controller }; jobs.set(project.id, job); session.error = ''; paint(session);
    try {
      await importer?.flush(project); if (!alive(project, generation) || controller.signal.aborted) return;
      const resources = await assets.flush(project); if (!alive(project, generation) || controller.signal.aborted) return;
      const value = normalizeNovelConfig(resources.config, resources.assetCatalog);
      const selection = selectionFor(project), document = await context(session, selection);
      if (!alive(project, generation) || controller.signal.aborted) return;
      if (requireConnection?.() === false) return;
      const sourceFingerprint = fingerprint(project);
      await persist(project); if (!alive(project, generation) || controller.signal.aborted) return;
      const contentBaseline = JSON.stringify([project.science.novel ?? null, project.science.novelDraft ?? null]);
      const requestConfig = { ...config(project), librarySelection: value.librarySelection };
      const response = await callAi('visual-novel', { projectId: project.id, documentSelection: selection, config: requestConfig }, { signal: controller.signal });
      if (!alive(project, generation) || controller.signal.aborted) return;
      const currentResources = await resolveNovelLibrary(response.data.librarySelection, { signal: controller.signal }), runtime = hydratePlayableNovel(response.data, currentResources);
      if (!alive(project, generation) || controller.signal.aborted) return;
      if (contentBaseline !== JSON.stringify([project.science.novel ?? null, project.science.novelDraft ?? null])) {
        session.error = '生成期间作品有更新，已保留你的修改，未应用新结果。';
        if (!live(session)) toast(session.error, 'error');
        return;
      }
      project.runs ||= []; project.runs.unshift({ id: uid(), at: new Date().toISOString(), task: 'visual-novel', meta: clone(response.meta || {}), sourceHash: document.hash }); project.runs = project.runs.slice(0, 60);
      project.science.novel = serializePlayableNovel(runtime); delete project.science.novelDraft; delete project.science.pendingNovel; delete project.science.novelHistory;
      project.science.novelStale = sourceFingerprint !== fingerprint(project); project.science.novelSettingsChanged = false;
      session.runtime = runtime; session.runtimeError = ''; session.mode = 'overview'; await persist(project); toast('讲解已生成。');
    } catch (error) { if (alive(project, generation) && error.name !== 'AbortError') { session.error = error.message; if (!live(session)) toast(error.message, 'error'); } }
    finally { if (jobs.get(project.id) === job) jobs.delete(project.id); if (alive(project, generation)) paint(session); }
  }
  function view(project, novel) { let result; result = showVisualNovel(project, novel, { onClose: () => viewers.delete(result) }); viewers.add(result); }
  function setupMarkup(session) {
    const value = config(session.project);
    return '<div class="vn-preparation"><section class="surface"><div class="vn-section-heading"><div><h3><span class="vn-step-number">01</span> 导入讲解材料</h3><p>选择这次使用的页段，讲解和问答可回查原文。</p></div></div><div data-vn-document-import></div></section><section class="surface"><div data-vn-cast-host></div></section><section class="surface vn-generation-settings"><div class="vn-section-heading"><div><h3><span class="vn-step-number">03</span> 设置互动</h3><p>按材料内容生成讲解和问答。</p></div></div><fieldset class="vn-density"><legend>互动密度</legend>' + [['sparse', '少量', '以连贯讲解为主'], ['balanced', '适中', '在关键知识点提问'], ['dense', '密集', '更多理解与辨析练习']].map(([key, title, caption]) => '<label><input type="radio" name="vn-density" data-novel-config="interactionDensity" value="' + key + '" ' + (value.interactionDensity === key ? 'checked' : '') + '><span><strong>' + title + '</strong><small>' + caption + '</small></span></label>').join('') + '</fieldset><label>补充说明 <span class="muted">可选</span><textarea data-novel-config="instruction" rows="3" maxlength="3000" placeholder="例如：先解释核心概念，再结合材料中的实验讨论适用条件。">' + h(value.instruction) + '</textarea></label><div class="vn-generate-actions"><span class="small muted">生成后更新当前作品。</span><button class="btn primary" data-vn-generate>' + icon('spark') + (session.project.science.novel ? '重新生成讲解' : '生成讲解') + '</button></div></section></div>';
  }
  function overviewMarkup(session) {
    const novel = session.project.science.novel, value = session.runtime;
    if (!novel || novel.version !== 2) return '<div class="vn-no-story"><div class="vn-cover-glyph">知 · 识</div><h3>开始制作互动讲解</h3><p>' + (novel ? '旧版作品需重新生成，原始资料保留。' : '导入资料，选择人物和场景后生成。') + '</p><button class="btn primary" data-vn-mode="setup">开始制作 →</button></div>';
    const cover = value?.backgrounds[0]?.assetId ? novelAssetUrl(value.backgrounds[0].assetId) : '';
    return (session.runtimeError ? '<div class="notice error" role="alert">' + h(session.runtimeError) + '</div>' : '') + '<div class="vn-story-cover"><div class="vn-story-cover-art"' + (cover ? ' style="background-image:url(' + h(cover) + ')"' : '') + '><span>互动讲解</span><h2>' + h(novel.title) + '</h2><p>' + h(novel.logline) + '</p><button class="btn primary" data-vn-read>' + icon('play') + '阅读作品</button></div><aside><h3>学习目标</h3><ol>' + novel.learningGoals.map(goal => '<li>' + h(goal) + '</li>').join('') + '</ol><p class="vn-selected-summary">' + h(value?.characters[0]?.name || '公用人物') + ' · ' + h(value?.backgrounds[0]?.name || '公用场景') + '</p><p class="tiny muted">依据：' + h(novel.documentSnapshot.title) + ' · ' + novel.documentSnapshot.units.length + ' 个选中页段</p><div class="row wrap"><button class="btn small" data-vn-edit>编辑讲解</button><button class="btn small" data-vn-export-html>导出离线HTML</button><button class="btn subtle small" data-vn-export-json>导出作品文件</button></div><p class="tiny muted">离线导出包含当前使用的图片。</p></aside></div>';
  }
  function citationsMarkup(citations, novel) { return (citations || []).map(citation => '<blockquote><small>' + h(novel.documentSnapshot.units.find(unit => unit.id === citation.unitId)?.label || citation.unitId) + '</small><p>' + h(citation.quote) + '</p></blockquote>').join(''); }
  function editorMarkup(session) {
    const draft = session.project.science.novelDraft, character = session.runtime?.characters[0]; if (!draft || !character) return '<p class="notice">正在读取素材…</p>';
    return '<div class="vn-editor-toolbar"><input data-vn-edit-title value="' + h(draft.title) + '" maxlength="120" aria-label="作品标题"><button class="btn primary small" data-vn-edit-apply>保存讲解</button><button class="btn subtle small" data-vn-edit-reset>放弃此次修改</button></div><p class="tiny muted">可修改对白和表情，知识内容请对照原文。</p><div class="vn-single-script">' + draft.scenes[0].lines.map((line, index) => '<article data-vn-edit-line="' + index + '"><div class="row spread"><strong>对话 ' + (index + 1) + '</strong><label>人物表情<select data-vn-line-field="poseId">' + character.portraits.map(pose => '<option value="' + h(pose.id) + '" ' + (pose.id === line.poseId ? 'selected' : '') + '>' + h(pose.name) + '</option>').join('') + '</select></label></div><label>对白<textarea data-vn-line-field="text" rows="3" maxlength="1500">' + h(line.text) + '</textarea></label>' + (line.card ? '<details><summary>知识卡片</summary><label>卡片标题<input data-vn-card-field="title" maxlength="120" value="' + h(line.card.title) + '"></label><label>卡片正文<textarea data-vn-card-field="text" rows="3" maxlength="2200">' + h(line.card.text) + '</textarea></label></details>' : '') + (line.question ? '<details class="vn-edit-question"><summary>互动问答</summary><label>问题<textarea data-vn-question-field="prompt" rows="2" maxlength="1200">' + h(line.question.prompt) + '</textarea></label>' + line.question.choices.map((choice, choiceIndex) => '<div data-vn-edit-choice="' + choiceIndex + '"><label>选项 ' + (choiceIndex + 1) + '<input data-vn-choice-field="text" maxlength="240" value="' + h(choice.text) + '"></label><label>解答反馈<textarea data-vn-choice-field="feedback" rows="2" maxlength="1200">' + h(choice.feedback) + '</textarea></label><label class="checkbox-line"><input type="radio" name="correct-' + index + '" data-vn-choice-correct ' + (choice.correct ? 'checked' : '') + '>此项为正确答案</label></div>').join('') + '</details>' : '') + '<details class="vn-edit-evidence"><summary>查看本句原文依据</summary>' + citationsMarkup(line.citations, draft) + (line.card ? citationsMarkup(line.card.citations, draft) : '') + (line.question ? citationsMarkup(line.question.citations, draft) : '') + '</details></article>').join('') + '</div>';
  }
  function paint(session) { if (session.paintScheduled) return; session.paintScheduled = true; queueMicrotask(() => { session.paintScheduled = false; renderSession(session); }); }
  function renderSession(session) {
    if (!live(session)) return; const project = session.project, job = jobs.get(project.id);
    assets.unmount(); active.importDispose?.(); active.importDispose = null;
    active.host.innerHTML = '<section class="vn-workspace"><div class="vn-workspace-heading"><div><h2>互动讲解</h2></div><div class="row wrap"><button class="btn small" data-vn-mode="setup">制作</button><button class="btn small" data-vn-mode="overview" ' + (!project.science.novel ? 'disabled' : '') + '>当前作品</button></div></div>' + (job ? '<div class="busy-banner"><span class="spinner"></span><span>正在生成讲解与问答…</span><button class="btn small subtle" data-vn-cancel>取消</button></div>' : '') + (session.error ? '<div class="notice error" role="alert">' + h(session.error) + '</div>' : '') + (project.science.novel?.version !== undefined && project.science.novel.version !== 2 ? '<div class="notice">旧版作品需重新生成，原始资料保留。</div>' : '') + (project.science.novelStale ? '<div class="notice">资料范围已变，重新生成后应用。当前作品及原文依据保留。</div>' : '') + (session.mode === 'setup' ? setupMarkup(session) : session.mode === 'editor' ? editorMarkup(session) : overviewMarkup(session)) + '</section>';
    if (session.mode === 'setup') { const importHost = active.host.querySelector('[data-vn-document-import]'); if (importer && importHost) active.importDispose = importer.mount(importHost, project); assets.mount(active.host.querySelector('[data-vn-cast-host]'), project, { disabled: Boolean(job) }); }
    if (job) active.host.querySelectorAll('[data-novel-config],[data-vn-generate],[data-vn-library-character],[data-vn-library-background],[data-vn-library-open],[data-vn-edit],[data-vn-edit-apply],[data-vn-edit-reset],[data-vn-edit-title],[data-vn-line-field],[data-vn-card-field],[data-vn-question-field],[data-vn-choice-field],[data-vn-choice-correct]').forEach(field => { field.disabled = true; });
    if (session.exporting) active.host.querySelectorAll('[data-vn-export-html],[data-vn-export-json]').forEach(button => { button.disabled = true; });
  }
  function editInput(session, field) {
    if (jobs.has(session.project.id)) return;
    const draft = session.project.science.novelDraft; if (!draft) return;
    if (field.hasAttribute('data-vn-edit-title')) draft.title = field.value;
    else { const row = field.closest('[data-vn-edit-line]'); if (!row) return; const line = draft.scenes[0].lines[Number(row.dataset.vnEditLine)], choiceRow = field.closest('[data-vn-edit-choice]'), choice = choiceRow && line.question?.choices[Number(choiceRow.dataset.vnEditChoice)];
      if (field.dataset.vnLineField) line[field.dataset.vnLineField] = field.value;
      else if (field.dataset.vnCardField) line.card[field.dataset.vnCardField] = field.value;
      else if (field.dataset.vnQuestionField) line.question[field.dataset.vnQuestionField] = field.value;
      else if (field.dataset.vnChoiceField && choice) choice[field.dataset.vnChoiceField] = field.value;
      else if (field.hasAttribute('data-vn-choice-correct') && choice) line.question.choices.forEach(item => { item.correct = item === choice; });
      else return;
    } schedule(session.project);
  }
  async function action(session, event) {
    const button = event.target.closest('button'); if (!button) return; const project = session.project;
    try {
      if (jobs.has(project.id) && ['data-vn-edit', 'data-vn-edit-apply', 'data-vn-edit-reset'].some(name => button.hasAttribute(name))) throw new Error('正在生成讲解，请先等待完成或取消，再编辑当前作品。');
      if (button.dataset.vnMode) { readConfigFields(session); session.mode = button.dataset.vnMode; session.error = ''; paint(session); if (session.mode === 'overview') void refreshRuntime(session); }
      else if (button.hasAttribute('data-vn-generate')) await generate(session);
      else if (button.hasAttribute('data-vn-cancel')) jobs.get(project.id)?.controller.abort();
      else if (button.hasAttribute('data-vn-read')) view(project, project.science.novel);
      else if (button.hasAttribute('data-vn-edit')) { const runtime = await resolvePlayableNovel(project.science.novel); session.runtime = runtime; project.science.novelDraft ||= serializePlayableNovel(runtime); session.mode = 'editor'; paint(session); }
      else if (button.hasAttribute('data-vn-edit-apply')) { const resources = await resolveNovelLibrary(project.science.novelDraft.librarySelection); const runtime = validatePlayableNovel(project.science.novelDraft, resources); project.science.novel = serializePlayableNovel(runtime); delete project.science.novelDraft; session.runtime = runtime; session.mode = 'overview'; await persist(project); paint(session); toast('讲解已保存。'); }
      else if (button.hasAttribute('data-vn-edit-reset')) { delete project.science.novelDraft; session.mode = 'overview'; await persist(project); paint(session); }
      else if (button.hasAttribute('data-vn-export-html') || button.hasAttribute('data-vn-export-json')) { if (session.exporting) return; session.exporting = true; paint(session); try { await persist(project); await (button.hasAttribute('data-vn-export-html') ? exportNovelHtml(project, project.science.novel) : exportNovelJson(project, project.science.novel)); } finally { session.exporting = false; paint(session); } }
    } catch (error) { session.error = error.message; if (live(session)) paint(session); else toast(error.message, 'error'); }
  }
  return {
    mount(host, project) {
      styles(); project.science ||= {}; config(project); active?.unbind?.(); active?.importDispose?.(); const session = sessionFor(project); active = { host, session };
      const lifecycle = new AbortController(); active.unbind = () => lifecycle.abort(); host.addEventListener('click', event => { void action(session, event); }, { signal: lifecycle.signal });
      const input = event => { if (event.target.matches('[data-novel-config]')) { if (event.target.type === 'radio' && !event.target.checked) return; readConfigFields(session); schedule(project); } else editInput(session, event.target); };
      host.addEventListener('input', input, { signal: lifecycle.signal }); host.addEventListener('change', input, { signal: lifecycle.signal }); paint(session); void refreshRuntime(session);
    },
    sourceChanged(project) { const session = sessions.get(project.id); if (project.science.novel) project.science.novelStale = true; if (session) { session.context = null; if (live(session)) paint(session); } },
    async flush(project) { const pending = project ? timers.has(project.id) ? [timers.get(project.id)] : [] : [...timers.values()]; for (const entry of pending) await persist(entry.project); await Promise.all([...saves]); },
    async cancelProject(id) { removedProjects.add(id); generations.set(id, (generations.get(id) || 0) + 1); jobs.get(id)?.controller.abort(); jobs.delete(id); clearTimeout(timers.get(id)?.timer); timers.delete(id); await assets.cancelProject(id); await Promise.allSettled([...(savesByProject.get(id) || [])]); sessions.delete(id); if (active?.session.project.id === id) { active.unbind?.(); active.importDispose?.(); active = null; } },
    isBusy: id => jobs.has(id) || assets.isBusy(id),
    unmount() { active?.unbind?.(); active?.importDispose?.(); assets.unmount(); active = null; },
    dispose() { disposed = true; for (const job of jobs.values()) job.controller.abort(); jobs.clear(); for (const entry of timers.values()) clearTimeout(entry.timer); timers.clear(); for (const viewer of [...viewers]) viewer.close(); assets.dispose(); active?.unbind?.(); active?.importDispose?.(); active = null; },
  };
}
