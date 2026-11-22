import { api, clone, escapeHtml as h, icon, toast, uid, copyText, saveFile, safeName, showModal } from './ui.js';
import { readWritingPreferences, saveWritingPreferences, clearWritingPreferences, writingPreferencesRemembered } from './writing-preferences.js';
import { writingSourceFingerprint, normalizeWritingReferenceSelection, writingOutputText } from './writing-model.js';

const CHANNELS = { article: '文章', poster: '海报要点', video: '短视频文案', social: '社群短文' };
const SCENARIOS = ['自动适配', '通知邀请', '产品介绍', '经验分享', '工作沟通', '活动报道'];
const QUICK = [['natural', '更自然'], ['shorter', '精简'], ['clearer', '更清楚'], ['formal', '更正式']];
const MAX_SOURCE = 60000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = value => typeof value === 'string' ? value : '';
const channelOf = value => Object.hasOwn(CHANNELS, value) ? value : 'auto';
const autoValue = value => !value || value === 'auto' ? '' : value;
const sourceFingerprint = project => writingSourceFingerprint(project.source);
const validDraft = value => object(value) && Object.hasOwn(CHANNELS, value.channel) && object(value.output);
const stateOf = project => JSON.stringify([project.source, project.writing?.brief, normalizeWritingReferenceSelection(project.writing?.references), project.writing?.draft?.channel, project.writing?.draft?.output]);
const textArray = value => Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
function materialChanged(project) { project.sourceChanged = true; project.review = null; for (const fact of Array.isArray(project.facts) ? project.facts : []) if (object(fact)) { fact.confirmed = false; fact.status = 'pending'; } }

export function ensureWritingProject(project) {
  if (!object(project.source)) project.source = { title: '', text: '', url: '' };
  for (const key of ['title', 'text', 'url']) if (typeof project.source[key] !== 'string') project.source[key] = '';
  if (!object(project.writing)) project.writing = {};
  const writing = project.writing, oldBrief = object(writing.brief) ? writing.brief : {};
  writing.version = 1;
  writing.brief = { ...oldBrief, goal: string(oldBrief.goal), channel: channelOf(oldBrief.channel), audience: string(oldBrief.audience) || 'auto', scenario: string(oldBrief.scenario) || 'auto', length: string(oldBrief.length) || 'auto', requiredPoints: Array.isArray(oldBrief.requiredPoints) ? oldBrief.requiredPoints.join('\n') : string(oldBrief.requiredPoints) };
  writing.revisionInstruction = string(writing.revisionInstruction);
  writing.references = normalizeWritingReferenceSelection(writing.references);
  if (!validDraft(writing.draft)) {
    const channel = [writing.brief.channel, ...Object.keys(CHANNELS)].filter(key => Object.hasOwn(CHANNELS, key)).find(key => object(project.outputs?.[key]));
    if (channel) { writing.draft = { channel, output: clone(project.outputs[channel]), evidence: [], notes: [], summary: '', origin: 'legacy', updatedAt: project.updatedAt || '' }; writing.brief.channel = channel; }
    else writing.draft = null;
  }
  if (writing.previousDraft && !validDraft(writing.previousDraft)) delete writing.previousDraft;
  return project;
}

export function writingText(project, channel) {
  const draft = project.writing?.draft, selected = channel || draft?.channel || project.writing?.brief?.channel || 'article', output = draft?.channel === selected ? draft.output : project.outputs?.[selected];
  return writingOutputText(selected, output);
}

function preview(draft) {
  if (!validDraft(draft)) return '';
  const output = draft.output;
  const title = `<h2>${h(output.title || '未命名稿件')}</h2>`;
  if (draft.channel === 'article') return `${title}${output.lead ? `<p class="writing-lead">${h(output.lead)}</p>` : ''}<div class="writing-body-text">${h(output.body)}</div>`;
  if (draft.channel === 'social') return `${title}<div class="writing-body-text">${h(output.text)}</div><p class="writing-tags">${textArray(output.tags).map(tag => '#' + h(tag.replace(/^#/, ''))).join(' ')}</p>`;
  if (draft.channel === 'poster') return `${output.eyebrow ? `<p class="writing-kicker">${h(output.eyebrow)}</p>` : ''}${title}${output.subtitle ? `<p class="writing-lead">${h(output.subtitle)}</p>` : ''}<ul>${textArray(output.highlights).map(value => `<li>${h(value)}</li>`).join('')}</ul><dl>${(Array.isArray(output.details) ? output.details : []).map(item => `<div><dt>${h(item.label)}</dt><dd>${h(item.value)}</dd></div>`).join('')}</dl>${output.footer ? `<p class="writing-footer-note">${h(output.footer)}</p>` : ''}`;
  return `${title}${(Array.isArray(output.shots) ? output.shots : []).map((shot, index) => `<section class="writing-shot"><span>镜头${index + 1} · ${h(shot.duration)}秒</span>${shot.narration ? `<p>${h(shot.narration)}</p>` : ''}${shot.visual ? `<small>画面：${h(shot.visual)}</small>` : ''}${shot.caption ? `<small>字幕：${h(shot.caption)}</small>` : ''}</section>`).join('')}`;
}

function editor(draft) {
  const output = draft.output;
  const field = (key, label, rows = 0) => `<label class="writing-edit-field"><span>${label}</span>${rows ? `<textarea rows="${rows}" data-writing-out="${key}" aria-label="${label}">${h(output[key])}</textarea>` : `<input data-writing-out="${key}" aria-label="${label}" value="${h(output[key])}">`}</label>`;
  let content = field('title', '标题');
  if (draft.channel === 'article') content += field('lead', '导语（可留空）', 2) + field('body', '正文', 16);
  if (draft.channel === 'social') content += field('text', '正文', 12) + `<label class="writing-edit-field"><span>标签（可留空）</span><input data-writing-array="tags" value="${h(textArray(output.tags).join('，'))}"></label>`;
  if (draft.channel === 'poster') content += field('subtitle', '副标题', 2) + `<label class="writing-edit-field"><span>要点（每行一条）</span><textarea rows="5" data-writing-array="highlights">${h(textArray(output.highlights).join('\n'))}</textarea></label><label class="writing-edit-field"><span>关键信息（每行：名称：内容）</span><textarea rows="4" data-writing-array="details">${h((Array.isArray(output.details) ? output.details : []).map(item => `${item.label}：${item.value}`).join('\n'))}</textarea></label>` + field('eyebrow', '顶部说明（可留空）') + field('footer', '补充说明（可留空）');
  if (draft.channel === 'video') content += (Array.isArray(output.shots) ? output.shots : []).map((shot, index) => `<fieldset class="writing-shot-editor"><legend>镜头${index + 1}</legend><label>时长（秒）<input type="number" min="0.5" max="120" step="0.5" data-writing-shot="${index}" data-writing-shot-field="duration" value="${h(shot.duration)}"></label>${[['narration', '旁白'], ['visual', '画面'], ['caption', '字幕']].map(([key, label]) => `<label>${label}<textarea rows="2" data-writing-shot="${index}" data-writing-shot-field="${key}">${h(shot[key])}</textarea></label>`).join('')}</fieldset>`).join('');
  return `<div class="writing-editor">${content}<div class="writing-editor-actions"><span>直接编辑会自动保存</span><button class="btn small" type="button" data-writing-finish-edit>${icon('check')}保存并预览</button></div></div>`;
}

export function createWritingWorkspace({ saveProject, callAi, requireConnection, onNew, onMetadata, onExport, onAssistant } = {}) {
  if (!document.querySelector('link[data-writing-workspace-style]')) { const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = '/writing-workspace.css'; link.dataset.writingWorkspaceStyle = ''; document.head.append(link); }
  const sessions = new Map(), pendingSaves = new Set(); let active = null, disposed = false;
  const live = session => !disposed && active?.session === session && active.host.isConnected;
  const allowed = session => !disposed && !session.removed;
  const aborted = () => new DOMException('写作操作已取消。', 'AbortError');
  function getSession(project) {
    let session = sessions.get(project.id);
    if (!session) { ensureWritingProject(project); session = { project, dirty: false, saveVersion: 0, pending: new Set(), saveChain: Promise.resolve(), timer: null, busy: false, importing: false, importEpoch: 0, editing: false, editSnapshot: false, selection: null, error: '', saveError: '', latestProject: null, proposal: null, importProposal: null, removed: false }; sessions.set(project.id, session); }
    else if (session.project !== project) { if (!session.dirty && !session.busy && !session.importing && !session.pending.size) session.project = ensureWritingProject(project); else session.latestProject = project; }
    return session;
  }
  function touch(session) { if (!allowed(session)) return; session.dirty = true; session.saveVersion++; clearTimeout(session.timer); session.timer = setTimeout(() => { void persist(session).catch(() => {}); }, 650); update(session); }
  function persist(session) {
    if (!allowed(session)) return Promise.resolve(session.project);
    clearTimeout(session.timer); session.timer = null;
    if (session.project.source.text.length > MAX_SOURCE) { session.saveError = '材料超过60000字，输入已保留，请精简后保存。'; update(session); return Promise.reject(new Error(session.saveError)); }
    const version = session.saveVersion;
    const pending = session.saveChain.catch(() => {}).then(async () => { if (!allowed(session)) throw aborted(); const saved = await saveProject(session.project); if (saved === null) throw new Error('稿件尚未保存，当前编辑内容已保留。'); if (version === session.saveVersion) session.dirty = false; session.saveError = ''; return saved; }).catch(error => { if (allowed(session) && error.name !== 'AbortError') { session.saveError = error.message || '保存未完成，当前内容已保留。'; if (error.latestProject) session.latestProject = error.latestProject; } throw error; }).finally(() => { pendingSaves.delete(pending); session.pending.delete(pending); update(session); });
    session.saveChain = pending; session.pending.add(pending); pendingSaves.add(pending); update(session); return pending;
  }
  async function flushSession(session) { clearTimeout(session.timer); session.timer = null; await Promise.all([...session.pending]); if (session.dirty) await persist(session); }
  async function flush() { await Promise.all([...sessions.values()].filter(allowed).map(flushSession)); await Promise.all([...pendingSaves]); }
  function syncOutput(project) { const draft = project.writing.draft; if (!validDraft(draft)) return; project.outputs ||= {}; project.outputs[draft.channel] = draft.output; project.review = null; }
  function setDraft(session, draft, { previous = true } = {}) { const project = session.project; if (previous && validDraft(project.writing.draft)) project.writing.previousDraft = clone(project.writing.draft); project.writing.draft = clone(draft); project.sourceChanged = Boolean(draft.sourceFingerprint && draft.sourceFingerprint !== sourceFingerprint(project)); syncOutput(project); session.proposal = null; session.selection = null; session.editSnapshot = false; session.editing = false; touch(session); }
  function currentDraft(session) { return session.project.writing.draft; }
  async function assistantContext(session) {
    await flushSession(session);
    if (!allowed(session)) throw aborted();
    const draft = currentDraft(session), context = { writingRevision: Number.isSafeInteger(session.project.writingRevision) ? session.project.writingRevision : 0 };
    if (!validDraft(draft)) return null;
    context.channel = draft.channel;
    const bytes = new TextEncoder().encode(JSON.stringify(draft.output));
    context.outputFingerprint = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
    const selection = session.selection, leaf = selection?.path?.length === 1 ? draft.output[selection.path[0]] : null;
    if (selection && typeof leaf === 'string' && Number.isInteger(selection.start) && Number.isInteger(selection.end) && selection.start >= 0 && selection.end > selection.start && leaf.slice(selection.start, selection.end) === selection.text)
      context.selection = { path: [...selection.path], start: selection.start, end: selection.end, text: selection.text };
    return context;
  }
  function noticeHtml(session) {
    const notices = [session.error, session.saveError].filter(Boolean);
    return `${notices.length ? `<div class="writing-notice is-error" role="status">${icon('info')}<div>${notices.map(value => `<p>${h(value)}</p>`).join('')}<div class="writing-notice-actions">${session.saveError ? '<button class="btn small" type="button" data-writing-retry-save>重试保存</button>' : ''}${session.latestProject ? '<button class="btn small" type="button" data-writing-load-latest>加载较新版本</button>' : ''}</div></div></div>` : ''}${session.localRecovery ? '<div class="writing-notice"><span>已加载较新版本，本机未保存内容仍可恢复。</span><button class="btn small" type="button" data-writing-restore-local>恢复本机编辑</button></div>' : ''}${session.proposal ? `<div class="writing-notice"><span>${icon('spark')}新稿已就绪，当前编辑已保留。</span><button class="btn small" type="button" data-writing-view-proposal>查看新稿</button></div>` : ''}${session.importProposal ? `<div class="writing-notice"><span>文件已解析，当前材料已保留。</span><button class="btn small" type="button" data-writing-apply-import>追加文件内容</button></div>` : ''}`;
  }
  function update(session) {
    if (!live(session)) return;
    const root = active.host, project = session.project, draft = currentDraft(session), count = Array.from(writingText(project).replace(/\s/g, '')).length;
    const status = root.querySelector('[data-writing-save]'); status.textContent = session.saveError ? '保存未完成 · 点击重试' : session.pending.size ? '正在保存…' : session.dirty ? '待保存' : '已保存'; status.classList.toggle('is-error', Boolean(session.saveError));
    const sourceCount = root.querySelector('[data-writing-source-count]'); sourceCount.textContent = `${project.source.text.length.toLocaleString('zh-CN')} / 60,000 字${project.source.text.length > MAX_SOURCE ? ' · 超出上限，请精简' : ''}`; sourceCount.classList.toggle('is-error', project.source.text.length > MAX_SOURCE);
    const draftCount = root.querySelector('[data-writing-word-count]'); if (draftCount) draftCount.textContent = `${count.toLocaleString('zh-CN')} 字${draft?.origin === 'legacy' ? ' · 从旧稿恢复' : ''}`;
    const generate = root.querySelector('[data-writing-generate]'); generate.disabled = session.busy || project.source.text.length > MAX_SOURCE || !(project.source.text.trim() || project.writing.brief.goal.trim()); generate.innerHTML = session.busy ? '<span class="spinner"></span>正在处理…' : `${icon('spark')}${draft ? '再写一稿' : '开始写作'}`;
    const busy = root.querySelector('[data-writing-busy]'); busy.innerHTML = session.busy ? `<span class="spinner"></span><span>${session.task === 'writing-revise' ? '正在修改…' : '正在起草…'}</span><button class="btn small" type="button" data-writing-cancel>停止</button>` : session.importing ? '<span class="spinner"></span><span>正在读取文件…</span><button class="btn small" type="button" data-writing-cancel-import>停止导入</button>' : ''; busy.hidden = !(session.busy || session.importing);
    busy.querySelector('[data-writing-cancel]')?.addEventListener('click', () => session.controller?.abort()); busy.querySelector('[data-writing-cancel-import]')?.addEventListener('click', () => session.importController?.abort());
    root.querySelectorAll('[data-writing-quick],[data-writing-revise]').forEach(button => { button.disabled = session.busy || !draft || button.hasAttribute('data-writing-revise') && !project.writing.revisionInstruction.trim(); });
    root.querySelectorAll('[data-writing-copy],[data-writing-export],[data-writing-edit]').forEach(button => { button.disabled = !draft; });
    const assistant = root.querySelector('[data-writing-assistant]'); if (assistant) assistant.disabled = session.busy || session.importing || session.openingAssistant;
    const undo = root.querySelector('[data-writing-undo]'); if (undo) { undo.hidden = !validDraft(project.writing.previousDraft); undo.disabled = session.busy; }
    const selection = root.querySelector('[data-writing-selection]'); if (selection) { selection.innerHTML = session.selection ? `<span>仅精修选中的${Array.from(session.selection.text).length}字</span><button type="button" data-writing-clear-selection aria-label="取消仅精修选中段落">${icon('close')}</button>` : ''; selection.hidden = !session.selection; selection.querySelector('button')?.addEventListener('click', () => { session.selection = null; update(session); }); }
    const feedback = root.querySelector('[data-writing-feedback]'); feedback.innerHTML = noticeHtml(session); bindFeedback(session, feedback);
  }
  function bindFeedback(session, root) {
    root.querySelector('[data-writing-retry-save]')?.addEventListener('click', () => { void persist(session).catch(() => {}); });
    root.querySelector('[data-writing-load-latest]')?.addEventListener('click', () => { const latest = session.latestProject; if (!latest) return; session.localRecovery = clone(session.project); for (const key of Object.keys(session.project)) delete session.project[key]; Object.assign(session.project, clone(latest)); ensureWritingProject(session.project); session.latestProject = null; session.saveError = ''; session.error = ''; session.dirty = false; session.selection = null; session.editing = false; paint(session); });
    root.querySelector('[data-writing-restore-local]')?.addEventListener('click', () => { const local = session.localRecovery; if (!local) return; const changed = session.project.source.text !== local.source.text; session.project.source = clone(local.source); session.project.writing = clone(local.writing); if (changed) materialChanged(session.project); syncOutput(session.project); session.localRecovery = null; touch(session); paint(session); });
    root.querySelector('[data-writing-view-proposal]')?.addEventListener('click', () => showProposal(session));
    root.querySelector('[data-writing-apply-import]')?.addEventListener('click', () => { if (appendMaterial(session, session.importProposal)) { session.importProposal = null; paint(session); } });
  }
  function evidenceHtml(session) {
    const project = session.project, draft = currentDraft(session); if (!draft) return '';
    const sourceFor = item => item.sourceId && item.sourceId !== 'source' ? (draft.referenceSnapshot?.purpose !== 'style' && Array.isArray(draft.referenceSnapshot?.items) ? draft.referenceSnapshot.items.find(source => source?.id === item.sourceId) : null) : { title: project.source.title || '原始材料', text: project.source.text };
    const evidence = (Array.isArray(draft.evidence) ? draft.evidence : []).filter(item => item && typeof item.quote === 'string' && item.quote && sourceFor(item)?.text?.includes(item.quote));
    const notes = textArray(draft.notes), changed = draft.sourceFingerprint && draft.sourceFingerprint !== sourceFingerprint(project);
    return `<details class="writing-evidence" data-writing-evidence><summary>${icon('shield')}依据与备注<span>${changed ? '材料已更新' : `${evidence.length}条引用${notes.length ? ` · ${notes.length}条备注` : ''}`}</span></summary><div>${changed ? '<p class="writing-evidence-warning">材料已更新，可重新起草。</p>' : ''}${evidence.length ? evidence.map(item => `<blockquote data-writing-evidence-source="${h(item.sourceId || 'source')}"><span>${h(item.sourceId && item.sourceId !== 'source' ? '参考｜' + sourceFor(item).title : '材料｜' + sourceFor(item).title)}${item.label ? ' · ' + h(item.label) : ''}</span>${h(item.quote)}</blockquote>`).join('') : '<p>暂无引用。</p>'}${notes.length ? `<h4>备注</h4><ul>${notes.map(value => `<li>${h(value)}</li>`).join('')}</ul>` : ''}</div></details>`;
  }
  function referenceOptionMarkup(session) {
    const reference = session.project.writing.references, options = session.referenceOptions || [], identity = item => JSON.stringify([item.projectId, item.part || item.projectPart, item.projectCreatedAt || '']), selected = reference.projectId ? identity(reference) : '';
    return `<option value="">不选项目</option>${reference.projectId && !options.some(item => identity(item) === selected) ? `<option value="${h(selected)}" selected>${session.referenceOptions ? '原参考已失效，请重新选择' : '已选参考项目'}</option>` : ''}${options.map(item => `<option value="${h(identity(item))}" ${selected === identity(item) ? 'selected' : ''}>${h(item.label)}</option>`).join('')}`;
  }
  function referenceHtml(session) {
    const reference = session.project.writing.references;
    return `<details class="writing-options writing-references" data-writing-references ${session.referenceOpen ? 'open' : ''}><summary>参考（可选）<span data-writing-reference-status>${reference.enabled ? '已启用' : '未启用'}</span></summary><div><label class="writing-reference-toggle"><input type="checkbox" data-writing-reference-enabled ${reference.enabled ? 'checked' : ''}>使用参考</label><div data-writing-reference-fields ${reference.enabled ? '' : 'hidden'}><label class="writing-field"><span>参考用途</span><select data-writing-reference-purpose><option value="auto" ${reference.purpose === 'auto' ? 'selected' : ''}>自动决定</option><option value="content" ${reference.purpose === 'content' ? 'selected' : ''}>参考内容</option><option value="style" ${reference.purpose === 'style' ? 'selected' : ''}>只学写法</option></select></label><label class="writing-field"><span>粘贴参考</span><textarea rows="4" maxlength="12000" data-writing-reference-text placeholder="想参考的内容或表达方式">${h(reference.text)}</textarea></label><label class="writing-field"><span>或选已有内容</span><select data-writing-reference-project>${referenceOptionMarkup(session)}</select></label><p class="writing-reference-state" data-writing-reference-state></p><p class="writing-reference-note">内容引用会注明来源；只学写法不补充事实。</p></div></div></details>`;
  }
  function updateReferenceFields(session) {
    if (!live(session)) return;
    const root = active.host, reference = session.project.writing.references;
    root.querySelector('[data-writing-reference-fields]').hidden = !reference.enabled;
    root.querySelector('[data-writing-reference-status]').textContent = reference.enabled ? '已启用' : '未启用';
    const selected = session.referenceOptions?.find(item => item.projectId === reference.projectId && item.part === reference.projectPart && item.projectCreatedAt === reference.projectCreatedAt), state = root.querySelector('[data-writing-reference-state]');
    state.textContent = session.referencesLoading ? '正在读取项目…' : session.referenceError || (selected?.truncated ? '较长的参考将使用前16,000字。' : ''); state.hidden = !state.textContent;
  }
  async function loadReferenceOptions(session) {
    if (session.referencesLoading || session.referenceOptions) return;
    session.referenceController?.abort(); session.referenceController = new AbortController(); session.referencesLoading = true; session.referenceError = ''; updateReferenceFields(session);
    try { const result = await api('/api/projects/' + encodeURIComponent(session.project.id) + '/writing-references', undefined, { signal: session.referenceController.signal }); if (!allowed(session)) return; session.referenceOptions = Array.isArray(result.items) ? result.items : []; if (live(session)) active.host.querySelector('[data-writing-reference-project]').innerHTML = referenceOptionMarkup(session); }
    catch (error) { if (allowed(session) && error.name !== 'AbortError') session.referenceError = '项目列表未读取，仍可粘贴参考。'; }
    finally { session.referencesLoading = false; updateReferenceFields(session); }
  }
  function paint(session) {
    if (!live(session)) return;
    const project = session.project, brief = project.writing.brief, draft = currentDraft(session), preferences = readWritingPreferences(), remember = writingPreferencesRemembered();
    active.host.innerHTML = `<section class="workspace writing-workspace" data-writing-project="${h(project.id)}"><header class="writing-heading"><div><span class="writing-eyebrow">文案写作</span><input class="project-title-input" data-writing-title aria-label="项目名称" maxlength="120" value="${h(project.title)}"></div><div class="writing-heading-actions"><button class="writing-save" data-writing-save>已保存</button><button class="btn small" type="button" data-writing-new>${icon('plus')}新建</button></div></header><div class="writing-feedback" data-writing-feedback></div><div class="writing-layout"><aside class="writing-input-panel"><div class="writing-input-heading"><h2>写文案</h2><p>写下目标，添加材料。</p></div><label class="writing-field writing-goal"><span>想写什么</span><textarea data-writing-brief="goal" rows="3" maxlength="2000" placeholder="例如：介绍产品用途，写得简洁自然">${h(brief.goal)}</textarea></label><div class="writing-format"><label for="writing-channel">写成</label><select id="writing-channel" data-writing-brief="channel" aria-label="稿件形式"><option value="auto" ${brief.channel === 'auto' ? 'selected' : ''}>自动适配材料</option>${Object.entries(CHANNELS).map(([key, label]) => `<option value="${key}" ${brief.channel === key ? 'selected' : ''}>${label}</option>`).join('')}</select></div><div class="writing-scenarios" aria-label="常用场景">${SCENARIOS.map(value => `<button type="button" data-writing-scenario="${value === '自动适配' ? 'auto' : h(value)}" aria-pressed="${brief.scenario === (value === '自动适配' ? 'auto' : value)}">${value}</button>`).join('')}</div><label class="writing-field writing-material"><span>原始材料</span><textarea data-writing-source="text" rows="9" placeholder="粘贴原文或相关材料">${h(project.source.text)}</textarea></label><div class="writing-material-actions"><label class="btn small" for="writing-source-file">${icon('upload')}导入文件</label><input id="writing-source-file" data-writing-file type="file" accept=".txt,.md,.markdown,.docx,.pdf" hidden><span data-writing-source-count></span></div><p class="writing-material-hint">TXT / Markdown / Word / PDF，10MB以内。</p>${referenceHtml(session)}<details class="writing-options"><summary>补充需求</summary><div><label class="writing-field"><span>给谁看</span><input data-writing-brief="audience" maxlength="500" placeholder="自动判断；也可写新客户、同事、关注者…" value="${h(autoValue(brief.audience))}"></label><label class="writing-field"><span>使用场景</span><input data-writing-brief="scenario" maxlength="500" placeholder="按材料自动判断" value="${h(autoValue(brief.scenario))}"></label><label class="writing-field"><span>希望多长</span><input data-writing-brief="length" list="writing-lengths" maxlength="100" placeholder="自动适配，也可写300字左右" value="${h(autoValue(brief.length))}"><datalist id="writing-lengths"><option value="150字以内"><option value="300字左右"><option value="600字左右"><option value="1000字左右"></datalist></label><label class="writing-field"><span>必须提到的内容</span><textarea data-writing-brief="requiredPoints" rows="3" maxlength="4000" placeholder="可留空；每行一个要点">${h(brief.requiredPoints)}</textarea></label><label class="writing-field"><span>材料标题（可选）</span><input data-writing-source="title" maxlength="250" value="${h(project.source.title)}"></label><label class="writing-field"><span>来源链接（可选）</span><input data-writing-source="url" type="url" value="${h(project.source.url)}" placeholder="https://…"></label></div></details><details class="writing-options writing-preferences"><summary>写作习惯 <span data-writing-preference-status>${remember ? '已记住' : '可选'}</span></summary><div><label class="writing-field"><span>写作身份</span><input data-writing-preference="identity" maxlength="500" placeholder="例如：个人作者、团队、产品负责人" value="${h(preferences.identity)}"></label><label class="writing-field"><span>语气</span><textarea data-writing-preference="voice" rows="2" maxlength="600" placeholder="例如：自然、直接，像跟熟人解释，少用套话">${h(preferences.voice)}</textarea></label><label class="writing-field"><span>常用写法</span><textarea data-writing-preference="styleSample" rows="4" maxlength="6000" placeholder="贴一小段你喜欢或自己写过的文字">${h(preferences.styleSample)}</textarea><small>仅参考表达。</small></label><label class="writing-field"><span>少用的词</span><input data-writing-preference="avoidWords" maxlength="1200" placeholder="用逗号分隔" value="${h(preferences.avoidWords)}"></label><label class="writing-field"><span>固定说法</span><input data-writing-preference="preferredTerms" maxlength="1200" placeholder="例如：产品名称统一写作“星河”" value="${h(preferences.preferredTerms)}"></label><div class="writing-preference-actions"><label><input type="checkbox" data-writing-remember ${remember ? 'checked' : ''}>在这台电脑上记住</label><button type="button" data-writing-clear-preferences>清除习惯</button></div></div></details><div class="writing-start"><button class="btn primary" type="button" data-writing-generate>${icon('spark')}写成一份可用稿</button><div class="writing-busy" data-writing-busy hidden role="status"></div></div></aside><main class="writing-draft-panel"><section class="writing-paper" data-writing-paper><header class="writing-paper-heading"><div><span>${draft ? '当前成稿' : '成稿会出现在这里'}</span>${draft ? `<strong>${CHANNELS[draft.channel]}</strong>` : ''}</div><div class="writing-draft-actions"><button class="btn small" data-writing-edit type="button">${icon('pen')}编辑</button><button class="btn small" data-writing-copy type="button">${icon('copy')}复制</button><button class="btn small" data-writing-export type="button">${icon('download')}导出</button></div></header><div class="writing-paper-content" data-writing-content>${draft ? session.editing ? editor(draft) : preview(draft) : `<div class="writing-empty">${icon('pen')}<h3>在这里查看和修改文稿</h3><p>写下目标或添加材料即可开始。</p><div><span>文章</span><span>海报要点</span><span>短视频文案</span><span>社群短文</span></div></div>`}</div><footer class="writing-paper-footer"><span data-writing-word-count></span><button class="btn small subtle" type="button" data-writing-undo hidden>${icon('undo')}撤销上次替换</button></footer></section>${draft ? `<section class="writing-refine"><div class="writing-refine-heading"><strong>修改文稿</strong><span>也可以直接编辑</span></div><div class="writing-quick">${QUICK.map(([key, label]) => `<button type="button" data-writing-quick="${key}">${label}</button>`).join('')}</div><div class="writing-selection" data-writing-selection hidden></div><form data-writing-revise-form><textarea rows="2" data-writing-revision placeholder="例如：缩短开头，保留数字">${h(project.writing.revisionInstruction)}</textarea><button class="btn" type="submit" data-writing-revise>${icon('spark')}按这句话修改</button></form></section>${evidenceHtml(session)}` : ''}</main></div></section>`;
    bind(session); update(session);
  }
  function bind(session) {
    const root = active.host, project = session.project;
    if (onAssistant) {
      root.querySelector('.writing-heading-actions').insertAdjacentHTML('beforeend', `<button class="btn small writing-assistant-entry" type="button" data-writing-assistant aria-haspopup="dialog">${icon('spark')}AI 助手</button>`);
      root.querySelector('[data-writing-assistant]').onclick = async () => {
        if (session.busy || session.importing || session.openingAssistant) return;
        session.openingAssistant = true; update(session);
        try {
          const context = await assistantContext(session);
          if (live(session)) await onAssistant({ projectId: project.id, windowKind: 'writing', writingContext: context, getWritingContext: () => assistantContext(session) });
        } catch (error) { session.error = error.message; }
        finally { session.openingAssistant = false; update(session); }
      };
    }
    root.querySelector('[data-writing-new]').onclick = () => onNew?.(); root.querySelector('[data-writing-save]').onclick = () => { void flushSession(session).catch(() => {}); };
    root.querySelector('[data-writing-title]').onchange = async event => { const title = event.target.value.trim(); if (!title) { event.target.value = project.title; return; } try { if (onMetadata) { const result = await onMetadata(project.id, { title }); project.title = result?.title || title; } else { project.title = title; touch(session); } } catch (error) { session.error = error.message; update(session); } };
    root.querySelectorAll('[data-writing-brief]').forEach(input => input.oninput = () => { const key = input.dataset.writingBrief; project.writing.brief[key] = key === 'channel' ? channelOf(input.value) : input.value || (['audience', 'scenario', 'length'].includes(key) ? 'auto' : ''); touch(session); root.querySelectorAll('[data-writing-scenario]').forEach(button => button.setAttribute('aria-pressed', String(project.writing.brief.scenario === button.dataset.writingScenario))); });
    root.querySelectorAll('[data-writing-scenario]').forEach(button => button.onclick = () => { project.writing.brief.scenario = button.dataset.writingScenario; const input = root.querySelector('[data-writing-brief="scenario"]'); input.value = autoValue(project.writing.brief.scenario); root.querySelectorAll('[data-writing-scenario]').forEach(item => item.setAttribute('aria-pressed', String(item === button))); touch(session); });
    root.querySelectorAll('[data-writing-source]').forEach(input => input.oninput = () => { const key = input.dataset.writingSource; if (key === 'text' && project.source.text !== input.value) materialChanged(project); project.source[key] = input.value; touch(session); });
    const referencePanel = root.querySelector('[data-writing-references]');
    referencePanel.ontoggle = () => { const changed = Boolean(session.referenceOpen) !== referencePanel.open; session.referenceOpen = referencePanel.open; if (referencePanel.open) { if (changed) session.referenceOptions = undefined; void loadReferenceOptions(session); } };
    root.querySelector('[data-writing-reference-enabled]').onchange = event => { project.writing.references.enabled = event.target.checked; touch(session); updateReferenceFields(session); if (project.writing.references.enabled) void loadReferenceOptions(session); };
    root.querySelector('[data-writing-reference-purpose]').onchange = event => { project.writing.references.purpose = event.target.value; touch(session); };
    root.querySelector('[data-writing-reference-text]').oninput = event => { project.writing.references.text = event.target.value; touch(session); };
    root.querySelector('[data-writing-reference-project]').onchange = event => { const selected = event.target.value ? JSON.parse(event.target.value) : ['', 'work', '']; project.writing.references.projectId = selected[0]; project.writing.references.projectPart = selected[1]; project.writing.references.projectCreatedAt = selected[2]; touch(session); updateReferenceFields(session); };
    updateReferenceFields(session); if (session.referenceOpen) void loadReferenceOptions(session);
    const preferences = () => Object.fromEntries([...root.querySelectorAll('[data-writing-preference]')].map(input => [input.dataset.writingPreference, input.value]));
    const updatePreferences = () => { const result = saveWritingPreferences(preferences(), { remember: root.querySelector('[data-writing-remember]').checked }); root.querySelector('[data-writing-preference-status]').textContent = result.remembered ? '已记住' : '本次使用'; };
    root.querySelectorAll('[data-writing-preference]').forEach(input => input.oninput = updatePreferences); root.querySelector('[data-writing-remember]').onchange = updatePreferences;
    root.querySelector('[data-writing-clear-preferences]').onclick = () => { clearWritingPreferences(); root.querySelectorAll('[data-writing-preference]').forEach(input => { input.value = ''; }); root.querySelector('[data-writing-remember]').checked = false; root.querySelector('[data-writing-preference-status]').textContent = '已清除'; };
    root.querySelector('[data-writing-file]').onchange = event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importFile(session, file); };
    root.querySelector('[data-writing-generate]').onclick = () => void run(session, 'writing-draft');
    root.querySelector('[data-writing-copy]').onclick = () => { void copyText(writingText(project)); };
    root.querySelector('[data-writing-export]').onclick = async () => { try { await flushSession(session); const draft = currentDraft(session), text = writingText(project); if (onExport) await onExport(project, { channel: draft.channel, text }); else await saveFile(`${safeName(draft.output.title || project.title)}.md`, text); } catch (error) { session.error = error.message; update(session); } };
    root.querySelector('[data-writing-edit]').onclick = () => { session.editing = !session.editing; session.editSnapshot = false; session.selection = null; paint(session); };
    root.querySelector('[data-writing-undo]')?.addEventListener('click', () => { const previous = project.writing.previousDraft; if (!validDraft(previous) || session.busy) return; project.writing.draft = clone(previous); project.writing.brief.channel = previous.channel; delete project.writing.previousDraft; syncOutput(project); session.editing = false; session.selection = null; touch(session); paint(session); void persist(session).catch(() => {}); });
    root.querySelectorAll('[data-writing-quick]').forEach(button => button.onclick = () => void run(session, 'writing-revise', { quickIntent: button.dataset.writingQuick }));
    root.querySelector('[data-writing-revision]')?.addEventListener('input', event => { project.writing.revisionInstruction = event.target.value; touch(session); });
    root.querySelector('[data-writing-revise-form]')?.addEventListener('submit', event => { event.preventDefault(); void run(session, 'writing-revise', { instruction: project.writing.revisionInstruction.trim() }); });
    bindEditor(session);
  }
  function bindEditor(session) {
    if (!session.editing || !validDraft(currentDraft(session))) return;
    const root = active.host, project = session.project, draft = currentDraft(session), output = draft.output;
    const changed = () => { if (!session.editSnapshot) { project.writing.previousDraft = clone(draft); session.editSnapshot = true; } session.selection = null; draft.edited = true; draft.updatedAt = new Date().toISOString(); syncOutput(project); touch(session); };
    root.querySelectorAll('[data-writing-out]').forEach(input => {
      input.oninput = () => { changed(); output[input.dataset.writingOut] = input.value; syncOutput(project); update(session); };
      input.onselect = () => { const key = input.dataset.writingOut; if (!((draft.channel === 'article' && key === 'body') || (draft.channel === 'social' && key === 'text'))) return; const start = input.selectionStart, end = input.selectionEnd; session.selection = end > start ? { path: [key], start, end, text: input.value.slice(start, end) } : null; update(session); };
    });
    root.querySelectorAll('[data-writing-array]').forEach(input => input.oninput = () => { changed(); const key = input.dataset.writingArray; output[key] = key === 'details' ? input.value.split('\n').filter(value => value.trim()).map(value => { const at = value.search(/[：:]/); return { label: at < 0 ? '信息' : value.slice(0, at).trim(), value: at < 0 ? value.trim() : value.slice(at + 1).trim() }; }) : input.value.split(key === 'tags' ? /[，,\n]/ : /\n/).map(value => value.trim()).filter(Boolean); syncOutput(project); update(session); });
    root.querySelectorAll('[data-writing-shot]').forEach(input => input.oninput = () => { changed(); const key = input.dataset.writingShotField; output.shots[Number(input.dataset.writingShot)][key] = key === 'duration' ? Math.max(.5, Math.min(120, Number(input.value) || .5)) : input.value; output.durationSeconds = output.shots.reduce((sum, item) => sum + Number(item.duration || 0), 0); syncOutput(project); update(session); });
    root.querySelector('[data-writing-finish-edit]').onclick = async () => { try { await flushSession(session); session.editing = false; session.selection = null; paint(session); } catch {} };
  }
  function preparedDraft(session, result, source, referenceSelection) {
    if (!object(result) || !Object.hasOwn(CHANNELS, result.channel) || !object(result.output)) throw new Error('模型没有返回有效稿件，当前内容已保留。');
    const snapshot = result.referenceSnapshot?.enabled === true && Array.isArray(result.referenceSnapshot.items) ? { enabled: true, purpose: result.referenceSnapshot.purpose, items: result.referenceSnapshot.items.slice(0, 2).filter(item => ['reference-text', 'reference-project'].includes(item?.id) && typeof item.text === 'string').map(item => ({ id: item.id, title: string(item.title).slice(0, 300), text: item.text.slice(0, 16000) })) } : undefined;
    return { channel: result.channel, output: clone(result.output), evidence: (Array.isArray(result.evidence) ? result.evidence : []).slice(0, 40).filter(item => object(item) && typeof item.quote === 'string').map(item => ({ id: string(item.id).slice(0, 100), label: string(item.label).slice(0, 200), quote: item.quote.slice(0, 6000), ...(item.sourceId ? { sourceId: string(item.sourceId).slice(0, 100), sourceLabel: string(item.sourceLabel).slice(0, 300) } : {}) })), ...(snapshot ? { referenceSnapshot: snapshot } : {}), referenceSelection: clone(referenceSelection), notes: textArray(result.notes).slice(0, 30).map(value => value.slice(0, 2000)), summary: string(result.summary).slice(0, 1000), sourceFingerprint: source, origin: 'ai', updatedAt: new Date().toISOString() };
  }
  function recordRun(project, task, meta = {}) { const clean = item => ({ id: item.id || uid(), task: item.task || '', at: item.at || '', ...(item.channel ? { channel: item.channel } : {}), meta: { model: string(item.meta?.model).slice(0, 300), durationMs: Number(item.meta?.durationMs) || 0, promptVersion: string(item.meta?.promptVersion).slice(0, 100) } }); project.runs = [clean({ id: uid(), task, at: new Date().toISOString(), channel: project.writing.draft?.channel, meta }), ...(Array.isArray(project.runs) ? project.runs : []).slice(0, 19).map(clean)]; }
  async function run(session, task, extra = {}) {
    if (!allowed(session) || session.busy) return;
    const project = session.project, isRevision = task === 'writing-revise', draft = currentDraft(session);
    if (isRevision && !draft || isRevision && !extra.quickIntent && !extra.instruction) return;
    if (!project.source.text.trim() && !project.writing.brief.goal.trim() && !isRevision) { session.error = '先写一个目标，或贴上原始材料。'; update(session); return; }
    if (project.source.text.length > MAX_SOURCE) { session.error = '材料超过60000字，请精简后再生成，不会截断材料。'; update(session); return; }
    if (requireConnection?.() === false) return;
    session.error = ''; session.busy = true; session.task = task; session.controller = new AbortController(); const baseline = stateOf(project), source = sourceFingerprint(project), selected = session.selection ? clone(session.selection) : undefined;
    const requestBrief = clone(project.writing.brief); if (isRevision) requestBrief.channel = draft.channel;
    const referenceSelection = clone(project.writing.references);
    const payload = { projectId: project.id, source: clone(project.source), writingBrief: requestBrief, writingPreferences: readWritingPreferences(), writingReferences: referenceSelection, ...(isRevision ? { channel: draft.channel, output: clone(draft.output), ...extra, ...(selected ? { selection: selected } : {}) } : {}) };
    update(session);
    session.job = (async () => {
      try {
        await flushSession(session); if (!allowed(session) || session.controller.signal.aborted) throw aborted();
        const response = await callAi(task, payload, { signal: session.controller.signal }); if (!allowed(session) || session.controller.signal.aborted) throw aborted(); const candidate = preparedDraft(session, response.data || response, source, referenceSelection);
        if ((isRevision || payload.writingBrief.channel !== 'auto') && candidate.channel !== (isRevision ? draft.channel : payload.writingBrief.channel)) throw new Error('返回的稿件形式与本次要求不同，当前稿已保留。');
        if (response.meta?.inputChanged || stateOf(project) !== baseline || session.latestProject && stateOf(session.latestProject) !== baseline) {
          session.proposal = { draft: candidate, task, meta: response.meta, clearInstruction: isRevision && !extra.quickIntent ? extra.instruction : null, note: string(response.meta?.inputChangeNote) };
          if (response.meta?.inputChanged) { try { const fresh = await api('/api/projects/' + encodeURIComponent(project.id)); if (fresh.project && allowed(session)) { session.latestProject = fresh.project; if (stateOf(fresh.project) !== stateOf(project) && !session.dirty) session.error = '项目已更新，可加载较新版本后比较新稿。'; } } catch {} }
          update(session); return;
        }
        setDraft(session, candidate); if (isRevision && !extra.quickIntent && project.writing.revisionInstruction.trim() === extra.instruction) project.writing.revisionInstruction = ''; project.generationMode = 'live'; recordRun(project, task, response.meta); if (live(session)) paint(session); await persist(session); if (live(session)) active.host.querySelector('[data-writing-paper]')?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
      } catch (error) { if (allowed(session)) { session.error = error.name === 'AbortError' ? '已停止本次处理，当前稿和输入仍保留。' : error.message || '这次未能完成，当前稿已保留。'; if (error.latestProject) session.latestProject = error.latestProject; else if (/^WRITING_.*(?:CHANGED|STALE|CONFLICT)/.test(error.code || '') || error.code === 'ASSISTANT_STALE_PROJECT') { try { const fresh = await api('/api/projects/' + encodeURIComponent(project.id)); if (fresh.project && allowed(session)) session.latestProject = fresh.project; } catch {} } } }
      finally { session.busy = false; session.controller = null; session.job = null; update(session); }
    })();
    return session.job;
  }
  function showProposal(session) {
    const proposal = session.proposal; if (!proposal) return;
    showModal({ title: '新稿已就绪', wide: true, body: `<p class="writing-proposal-intro">生成期间内容已更新，请比较后选择。采用新稿可撤销。</p>${proposal.note ? `<p class="writing-proposal-intro">${h(proposal.note)}</p>` : ''}<div class="writing-proposal-grid"><section><h3>当前稿</h3>${currentDraft(session) ? preview(currentDraft(session)) : '<p>尚无当前稿</p>'}</section><section><h3>AI新稿</h3>${preview(proposal.draft)}</section></div><div class="modal-actions"><button class="btn" data-writing-keep-current>保留当前稿</button><button class="btn primary" data-writing-adopt-proposal>采用新稿</button></div>`, onMount(root, close) { root.querySelector('[data-writing-keep-current]').onclick = close; root.querySelector('[data-writing-adopt-proposal]').onclick = async event => {
      const button = event.currentTarget; button.disabled = true;
      try {
        const fresh = (await api('/api/projects/' + encodeURIComponent(session.project.id))).project;
        if (!fresh) throw new Error('项目已不存在，当前内容仍保留。');
        const changedRevision = (fresh.writingRevision || 0) !== (session.project.writingRevision || 0) || (fresh.assistantRevision || 0) !== (session.project.assistantRevision || 0);
        if (changedRevision && stateOf(fresh) !== stateOf(session.project)) { session.latestProject = fresh; session.error = '项目已有另一份更新，尚未覆盖。请先加载较新版本，比较后再采用AI新稿。'; close(); update(session); return; }
        if (changedRevision) { session.project.writingRevision = fresh.writingRevision; session.project.assistantRevision = fresh.assistantRevision; }
        await flushSession(session); if (!allowed(session)) return;
        session.proposal = null; setDraft(session, proposal.draft); if (proposal.clearInstruction && session.project.writing.revisionInstruction.trim() === proposal.clearInstruction) session.project.writing.revisionInstruction = ''; recordRun(session.project, proposal.task, proposal.meta); close(); if (live(session)) paint(session); await persist(session);
      } catch (error) { session.error = error.message; if (error.latestProject) session.latestProject = error.latestProject; close(); update(session); }
      finally { if (button.isConnected) button.disabled = false; }
    }; } });
  }
  function appendMaterial(session, imported) {
    if (!imported || !allowed(session)) return false;
    const project = session.project, text = [project.source.text.trim(), imported.text.trim()].filter(Boolean).join('\n\n');
    if (text.length > MAX_SOURCE) { session.error = `追加后共${text.length.toLocaleString('zh-CN')}字，超过60000字。当前材料已保留，请先精简后再追加。`; update(session); return false; }
    if (project.source.text !== text) materialChanged(project); project.source.text = text; if (!project.source.title) project.source.title = imported.name; touch(session); return true;
  }
  async function importFile(session, file) {
    if (!allowed(session)) return;
    if (file.size > 10 * 1024 * 1024) { session.error = '文件请控制在10MB以内，当前材料已保留。'; update(session); return; }
    session.importController?.abort(); const epoch = ++session.importEpoch, baseline = sourceFingerprint(session.project); session.importController = new AbortController(); session.importing = true; session.error = ''; update(session);
    session.importJob = (async () => {
      try { const bytes = new Uint8Array(await file.arrayBuffer()); if (!allowed(session) || epoch !== session.importEpoch) throw aborted(); let binary = ''; for (let at = 0; at < bytes.length; at += 32768) binary += String.fromCharCode(...bytes.subarray(at, at + 32768)); const result = await api('/api/writing/import', { name: file.name, contentBase64: btoa(binary) }, { signal: session.importController.signal }); if (!allowed(session) || epoch !== session.importEpoch) throw aborted(); if (typeof result.text !== 'string' || !result.text.trim()) throw new Error('没有读取到可用文字，当前材料已保留。'); if (result.text.length > MAX_SOURCE) throw new Error('文件正文超过60000字，未截断或替换当前材料。'); const imported = { name: result.name || file.name, text: result.text }; if (baseline !== sourceFingerprint(session.project)) session.importProposal = imported; else if (appendMaterial(session, imported)) { if (live(session)) paint(session); await persist(session); } else session.importProposal = imported; const warnings = (Array.isArray(result.warnings) ? result.warnings : []).map(value => typeof value === 'string' ? value : value?.message || '').filter(Boolean); if (warnings.length) session.error = warnings.join('；'); }
      catch (error) { if (allowed(session) && epoch === session.importEpoch) session.error = error.name === 'AbortError' ? '已停止导入，当前材料仍保留。' : error.message; }
      finally { if (epoch === session.importEpoch) { session.importing = false; session.importController = null; session.importJob = null; update(session); } }
    })();
    return session.importJob;
  }
  async function cancelProject(id) { const session = sessions.get(id); if (!session) return; session.removed = true; clearTimeout(session.timer); session.timer = null; session.dirty = false; session.controller?.abort(); session.importController?.abort(); session.referenceController?.abort(); await Promise.allSettled([session.job, session.importJob, ...session.pending].filter(Boolean)); sessions.delete(id); if (active?.session === session) deactivate(); }
  function deactivate() { active = null; }
  return { render(host, project) { if (disposed || !project?.id) return; active = { host, session: getSession(project) }; paint(active.session); }, flush, deactivate, cancelProject, isBusy: id => Boolean(sessions.get(id)?.busy || sessions.get(id)?.importing), dispose() { disposed = true; active = null; for (const session of sessions.values()) { clearTimeout(session.timer); session.controller?.abort(); session.importController?.abort(); session.referenceController?.abort(); } } };
}
