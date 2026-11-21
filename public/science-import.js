import { api, fetchLocal, escapeHtml as h, icon, showModal, toast } from './ui.js';

const endpoint = id => '/api/projects/' + encodeURIComponent(id) + '/science-documents';
const ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const MAX_CHARACTERS = 60000, MAX_UNITS = 160;
function styles() {
  if (document.querySelector('[data-science-import-style]')) return;
  const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = '/science-import.css'; link.dataset.scienceImportStyle = ''; document.head.append(link);
}
function rangeNumbers(text, max) {
  if (typeof text !== 'string' || !text.trim() || text.length > 1000) throw new Error('请输入页码或段号，如1-3,6。');
  const result = new Set();
  for (const part of text.replace(/，/g, ',').split(',')) {
    const match = /^\s*(\d+)(?:\s*[-–—]\s*(\d+))?\s*$/.exec(part);
    if (!match) throw new Error('页段范围格式为1-3,6。');
    const start = Number(match[1]), end = Number(match[2] || match[1]);
    if (start < 1 || end < start || end > max) throw new Error('页段范围须在1至' + max + '之内。');
    for (let value = start; value <= end; value++) result.add(value);
  }
  return result;
}

/** Source text lives in the document service; the project only keeps selected IDs. */
export function createScienceImporter({ saveProject = async () => ({}), onChanged, onSelected } = {}) {
  const sessions = new Map(); let view = null, disposed = false;
  styles();
  function sessionFor(project) {
    if (!project?.id) throw new Error('请先打开科普项目。');
    project.science ||= {};
    let session = sessions.get(project.id);
    if (!session) { session = { project, documents: [], document: null, operation: null, controller: null, load: null, loadController: null, loadPending: false, loadError: null, saveQueue: Promise.resolve(), saveError: '', error: '', busy: false, removed: false, generation: 0 }; sessions.set(project.id, session); }
    if (!session.busy) session.project = project;
    return session;
  }
  const live = session => !disposed && !session.removed && sessions.get(session.project.id) === session;
  const visible = session => live(session) && view?.session === session && view.host.isConnected;
  function selection(project) {
    const selected = project?.science?.documentSelection;
    if (!selected || !ID.test(selected.documentId || '') || !Array.isArray(selected.unitIds)) return null;
    return { documentId: selected.documentId, unitIds: [...selected.unitIds] };
  }
  function save(session) {
    const pending = session.saveQueue.catch(() => {}).then(async () => {
      if (!live(session)) throw new DOMException('资料操作已取消。', 'AbortError');
      const saved = await saveProject(session.project);
      if (saved === null) throw new Error('资料选择尚未保存，请重试。');
      session.saveError = ''; paintStatus(session); return saved;
    }).catch(error => { if (live(session) && error.name !== 'AbortError') { session.saveError = error.message; paintStatus(session); } throw error; });
    session.saveQueue = pending; pending.catch(() => {}); return pending;
  }
  function selectedUnits(session) {
    const chosen = selection(session.project);
    if (!chosen || chosen.documentId !== session.document?.id) return [];
    const wanted = new Set(chosen.unitIds); return session.document.units.filter(unit => wanted.has(unit.id));
  }
  function validateSelection(session) {
    const chosen = selection(session.project);
    if (!chosen || !chosen.unitIds.length) throw new Error('请先导入资料并勾选用于生成的页段。');
    if (chosen.unitIds.length > MAX_UNITS) throw new Error('本次最多选择160个页段，请缩小范围后生成。');
    if (session.document?.id === chosen.documentId) {
      const units = selectedUnits(session);
      if (units.length !== chosen.unitIds.length || units.some(unit => !unit.readable)) throw new Error('所选页段已失效或没有文字，请重新勾选。');
      const total = units.reduce((sum, unit) => sum + unit.text.length, 0);
      if (total > MAX_CHARACTERS) throw new Error('已选' + total + '字，超过60000字上限，请减少页段；不会截断整本资料。');
    }
    return chosen;
  }
  function paintStatus(session) {
    if (!visible(session)) return;
    const host = view.host, message = host.querySelector('[data-scidoc-status]');
    message.textContent = session.busy ? '正在解析资料…' : session.saveError || session.error || (session.document ? '资料已保存' : '导入资料后，选择本次使用的页段。');
    message.classList.toggle('is-error', Boolean(session.error || session.saveError));
    host.querySelector('[data-scidoc-cancel]').hidden = !session.busy;
    host.querySelector('[data-scidoc-save]').hidden = !session.saveError;
    host.querySelectorAll('[data-scidoc-pick],[data-scidoc-file],[data-scidoc-paste-toggle],[data-scidoc-refresh],[data-scidoc-select],[data-scidoc-import-text],[data-scidoc-remove],[data-scidoc-all],[data-scidoc-none],[data-scidoc-range-apply],[data-scidoc-unit]').forEach(control => { control.disabled = session.busy || control.matches('[data-scidoc-unit][data-unreadable]'); });
    host.querySelector('[data-scidoc-pick]').setAttribute('aria-disabled', String(session.busy));
    const units = selectedUnits(session), size = units.reduce((sum, unit) => sum + unit.text.length, 0), summary = host.querySelector('[data-scidoc-selection-summary]');
    if (summary) {
      const invalid = size > MAX_CHARACTERS || units.length > MAX_UNITS;
      summary.textContent = '已选 ' + units.length + ' / ' + (session.document?.totalUnitCount || 0) + ' 个页段 · ' + size.toLocaleString('zh-CN') + ' 字' + (invalid ? ' · 超过生成范围，请减少选择' : ' · 上限60,000字');
      summary.classList.toggle('is-error', invalid);
    }
  }
  function choose(session, ids, { persist = true, reason = 'selection' } = {}) {
    const doc = session.document;
    if (!doc) return;
    const wanted = new Set(ids);
    session.project.science ||= {};
    session.project.science.documentSelection = { documentId: doc.id, unitIds: doc.units.filter(unit => unit.readable && wanted.has(unit.id)).map(unit => unit.id) };
    if (visible(session)) for (const checkbox of view.host.querySelectorAll('[data-scidoc-unit]')) checkbox.checked = session.project.science.documentSelection.unitIds.includes(checkbox.dataset.scidocUnit);
    paintStatus(session);
    try { onSelected?.(session.project, selection(session.project), { document: doc, reason }); } catch {}
    if (persist) void save(session).catch(() => {});
  }
  function preview(session, unitId) {
    if (!visible(session)) return;
    const unit = session.document?.units.find(unit => unit.id === unitId); if (!unit) return;
    const host = view.host;
    host.querySelector('[data-scidoc-preview-label]').textContent = unit.label + ' · 原文';
    host.querySelector('[data-scidoc-preview]').textContent = unit.text || '未提取到文字，扫描页需先转成可复制文本。';
    host.querySelector('[data-scidoc-preview-details]').open = true;
  }
  function paintDocument(session) {
    if (!visible(session)) return;
    const host = view.host, select = host.querySelector('[data-scidoc-select]'), doc = session.document;
    select.innerHTML = '<option value="">选择已导入资料</option>' + session.documents.map(item => '<option value="' + h(item.id) + '">' + h(item.title) + ' · ' + (item.pageCount ? item.pageCount + '页' : item.totalUnitCount + '段') + '</option>').join('');
    select.value = doc?.id || '';
    const panel = host.querySelector('[data-scidoc-document]');
    panel.hidden = !doc;
    if (!doc) { panel.innerHTML = ''; paintStatus(session); return; }
    const selected = new Set(selection(session.project)?.documentId === doc.id ? selection(session.project).unitIds : []);
    panel.innerHTML = '<div class="gx-scidoc-heading"><div><strong>' + h(doc.title) + '</strong><p class="tiny muted">' + h(doc.fileName) + ' · ' + (doc.pageCount ? doc.pageCount + '页 · ' : '') + doc.characterCount.toLocaleString('zh-CN') + ' 字</p></div><div class="row"><a class="btn small" href="' + endpoint(session.project.id) + '/' + encodeURIComponent(doc.id) + '/source" download>' + icon('download') + '原文件</a><button type="button" class="btn small subtle" data-scidoc-remove>移除资料</button></div></div>' +
      (doc.warnings?.length ? '<details class="gx-scidoc-warnings"><summary>提取说明 · ' + doc.warnings.length + '项</summary><ul>' + doc.warnings.map(item => '<li>' + h(item.message) + '</li>').join('') + '</ul></details>' : '') +
      '<div class="gx-scidoc-selection-actions"><label>' + (doc.pageCount ? '按页码选择' : '按段号选择') + '<input data-scidoc-range maxlength="1000" placeholder="如 1-3,6" aria-label="页段范围"></label><button type="button" class="btn small" data-scidoc-range-apply>应用范围</button><button type="button" class="btn small" data-scidoc-all>全选可读页段</button><button type="button" class="btn small subtle" data-scidoc-none>清空选择</button></div>' +
      '<p class="small gx-scidoc-summary" data-scidoc-selection-summary aria-live="polite"></p><div class="gx-scidoc-units" role="group" aria-label="本次生成页段">' + doc.units.map(unit => '<div class="gx-scidoc-unit"><label><input type="checkbox" data-scidoc-unit="' + h(unit.id) + '" ' + (selected.has(unit.id) ? 'checked ' : '') + (!unit.readable ? 'disabled data-unreadable ' : '') + '><span><strong>' + h(unit.label) + '</strong><small>' + (unit.readable ? unit.characterCount.toLocaleString('zh-CN') + '字 · ' + h(unit.text.slice(0, 65).replace(/\s+/g, ' ')) : '没有可提取文字') + '</small></span></label><button type="button" class="btn small subtle" data-scidoc-preview-unit="' + h(unit.id) + '">原文</button></div>').join('') + '</div>' +
      '<details class="gx-scidoc-preview" data-scidoc-preview-details><summary data-scidoc-preview-label>查看原文</summary><pre data-scidoc-preview></pre></details><p class="tiny muted">只使用勾选的页段生成。刚导入时仅默认选择首个可读页段，其余内容不会悄悄截断或送入模型。</p>';
    paintStatus(session);
  }
  function startLoad(session, operation) {
    const generation = ++session.generation;
    session.loadController?.abort(); const controller = new AbortController(); session.loadController = controller;
    session.loadPending = true; session.loadError = null;
    const pending = Promise.resolve().then(() => operation({ generation, signal: controller.signal })).then(value => {
      if (generation === session.generation) { session.loadPending = false; session.loadError = null; }
      return value;
    }, error => {
      if (generation === session.generation) { session.loadPending = false; session.loadError = error; }
      throw error;
    });
    // Keep the original rejection so generation cannot fall back to an old selection.
    session.load = pending; pending.catch(() => {}); return pending;
  }
  async function readDocument(session, id, { makeSelection = false, generation, signal }) {
    const result = await api(endpoint(session.project.id) + '/' + encodeURIComponent(id), undefined, { signal });
    if (!live(session) || generation !== session.generation) return;
    session.document = result.document; session.error = '';
    const chosen = selection(session.project);
    if (makeSelection || !chosen || chosen.documentId !== id) choose(session, result.document.units.filter(unit => unit.readable).slice(0, 1).map(unit => unit.id), { reason: 'document' });
    paintDocument(session);
    const first = selectedUnits(session)[0] || session.document.units[0]; if (first) preview(session, first.id);
    return result.document;
  }
  function loadDocument(session, id, { makeSelection = false } = {}) {
    return startLoad(session, context => readDocument(session, id, { ...context, makeSelection }));
  }
  function load(session, { preferId } = {}) {
    return startLoad(session, async context => {
      const result = await api(endpoint(session.project.id), undefined, { signal: context.signal });
      if (!live(session) || context.generation !== session.generation) return;
      session.documents = result.documents || [];
      const chosen = selection(session.project), id = preferId || chosen?.documentId || session.document?.id || session.documents[0]?.id;
      if (id && session.documents.some(document => document.id === id)) await readDocument(session, id, { ...context, makeSelection: Boolean(preferId) });
      else { session.document = null; if (chosen && !session.documents.some(document => document.id === chosen.documentId)) session.error = '之前选择的资料不存在，请重新导入或选择资料。'; paintDocument(session); }
    });
  }
  async function importFile(session, file) {
    const extension = file.name.split('.').at(-1).toLowerCase(), max = extension === 'pdf' ? 32 * 1024 * 1024 : extension === 'docx' ? 10 * 1024 * 1024 : 8 * 1024 * 1024;
    if (!['pdf', 'docx', 'txt', 'md', 'markdown'].includes(extension)) throw new Error('支持PDF、DOCX、TXT和Markdown文件。');
    if (!file.size || file.size > max) throw new Error('文件大小不符合要求：PDF最多32MB，DOCX最多10MB，文本最多8MB。');
    const response = await fetchLocal(endpoint(session.project.id) + '/upload', { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) }, body: file, signal: session.controller.signal });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || '资料导入失败。'); return result;
  }
  function startImport(session, run) {
    if (session.busy || !live(session)) return Promise.resolve();
    session.loadController?.abort(); ++session.generation; session.load = null; session.loadPending = false; session.loadError = null;
    session.busy = true; session.error = ''; session.controller = new AbortController(); paintStatus(session);
    const operation = Promise.resolve().then(async () => {
      try {
        const result = await run();
        if (!live(session) || session.controller.signal.aborted) return;
        const doc = result.document; session.document = doc;
        session.documents = [doc, ...session.documents.filter(item => item.id !== doc.id)];
        choose(session, doc.units.filter(unit => unit.readable).slice(0, 1).map(unit => unit.id), { persist: false, reason: 'import' });
        await save(session);
        await onChanged?.(session.project, { document: doc, selection: selection(session.project), reason: 'import' });
        paintDocument(session); const first = doc.units.find(unit => unit.readable); if (first) preview(session, first.id);
        if (visible(session)) { view.host.querySelector('[data-scidoc-paste]').hidden = true; toast(result.duplicate ? '资料已存在，已选中原有记录' : '资料已导入，请选择页段'); }
      } catch (error) {
        if (live(session)) { session.error = error.name === 'AbortError' ? '导入已取消，可刷新查看已保存的资料。' : error.message; paintStatus(session); }
        if (error.name !== 'AbortError') throw error;
      } finally { session.busy = false; session.controller = null; if (session.operation === operation) session.operation = null; paintStatus(session); }
    });
    session.operation = operation; operation.catch(() => {}); return operation;
  }
  function removeDocument(session) {
    if (!session.document || session.busy) return;
    const id = session.document.id;
    showModal({ title: '移除资料', body: '<p>从当前项目移除“' + h(session.document.title) + '”？已有作品的原文依据会保留。</p><div class="modal-actions"><button type="button" class="btn" data-scidoc-keep>保留</button><button type="button" class="btn primary" data-scidoc-confirm-remove>移除资料</button></div>', onMount(root, close) {
      root.querySelector('[data-scidoc-keep]').onclick = close;
      root.querySelector('[data-scidoc-confirm-remove]').onclick = async event => {
        const confirm = event.currentTarget; confirm.disabled = true;
        try {
          await api(endpoint(session.project.id) + '/' + encodeURIComponent(id), undefined, { method: 'DELETE' });
          if (!live(session)) { close(); return; }
          if (selection(session.project)?.documentId === id) delete session.project.science.documentSelection;
          session.document = null; session.documents = session.documents.filter(document => document.id !== id);
          await save(session); onSelected?.(session.project, null, { document: null, reason: 'remove' }); await onChanged?.(session.project, { document: null, selection: selection(session.project), reason: 'remove' });
          close(); await load(session);
        } catch (error) { confirm.disabled = false; toast(error.message, 'error'); }
      };
    } });
  }
  function mount(host, project) {
    if (disposed) throw new Error('资料导入器已关闭。');
    view?.dispose();
    const session = sessionFor(project), controller = new AbortController();
    const current = { host, session, dispose: () => { controller.abort(); if (view === current) view = null; } }; view = current;
    host.innerHTML = '<section class="gx-science-import"><div class="gx-scidoc-header"><div><h3>' + icon('file') + '论文与教材</h3><p class="small muted">选择用于讲解的资料页段。</p></div><div class="row wrap"><label class="btn small" data-scidoc-pick>' + icon('upload') + '导入文件<input type="file" accept=".pdf,.docx,.txt,.md,.markdown" data-scidoc-file hidden></label><button type="button" class="btn small" data-scidoc-paste-toggle>粘贴文字</button><button type="button" class="btn small subtle" data-scidoc-refresh aria-label="刷新资料">' + icon('refresh') + '</button></div></div><p class="tiny muted">PDF ≤32MB / 800页，DOCX ≤10MB，文本 ≤8MB。扫描件需先转成文字，每次最多选60,000字。</p><div class="gx-scidoc-status-row"><p class="small" role="status" data-scidoc-status></p><button class="btn small" type="button" data-scidoc-cancel hidden>取消导入</button><button class="btn small" type="button" data-scidoc-save hidden>重试保存选择</button></div><div class="gx-scidoc-paste" data-scidoc-paste hidden><label>资料标题<input maxlength="300" data-scidoc-title value="' + h(project.title + ' · 资料') + '"></label><label>资料正文<textarea rows="7" maxlength="2000000" data-scidoc-text placeholder="粘贴摘要、章节或正文，再选择页段。"></textarea></label><button type="button" class="btn primary small" data-scidoc-import-text>保存并分段</button></div><label class="gx-scidoc-document-picker">已导入资料<select data-scidoc-select aria-label="已导入资料"><option value="">正在读取…</option></select></label><div data-scidoc-document hidden></div></section>';
    host.querySelector('[data-scidoc-file]').onchange = event => { const file = event.target.files[0]; event.target.value = ''; if (!file) return; void startImport(session, () => importFile(session, file)).catch(() => {}); };
    host.querySelector('[data-scidoc-paste-toggle]').onclick = () => { const panel = host.querySelector('[data-scidoc-paste]'); panel.hidden = !panel.hidden; if (!panel.hidden) host.querySelector('[data-scidoc-text]').focus(); };
    host.querySelector('[data-scidoc-import-text]').onclick = () => { const title = host.querySelector('[data-scidoc-title]').value, text = host.querySelector('[data-scidoc-text]').value; void startImport(session, () => api(endpoint(session.project.id) + '/text', { title, text }, { signal: session.controller.signal })).catch(() => {}); };
    host.querySelector('[data-scidoc-cancel]').onclick = () => session.controller?.abort();
    host.querySelector('[data-scidoc-save]').onclick = () => { void save(session).catch(() => {}); };
    host.querySelector('[data-scidoc-refresh]').onclick = () => { void load(session).catch(error => { session.error = error.message; paintStatus(session); }); };
    host.querySelector('[data-scidoc-select]').onchange = event => { if (!event.target.value) return; void loadDocument(session, event.target.value, { makeSelection: true }).catch(error => { if (error.name !== 'AbortError') { session.error = error.message; paintStatus(session); } }); };
    host.addEventListener('change', event => { if (!event.target.matches('[data-scidoc-unit]')) return; choose(session, [...host.querySelectorAll('[data-scidoc-unit]:checked')].map(input => input.dataset.scidocUnit)); }, { signal: controller.signal });
    host.addEventListener('click', event => {
      const button = event.target.closest('button'); if (!button) return;
      if (button.hasAttribute('data-scidoc-preview-unit')) preview(session, button.dataset.scidocPreviewUnit);
      if (button.hasAttribute('data-scidoc-all')) choose(session, session.document.units.filter(unit => unit.readable).map(unit => unit.id));
      if (button.hasAttribute('data-scidoc-none')) choose(session, []);
      if (button.hasAttribute('data-scidoc-remove')) removeDocument(session);
      if (button.hasAttribute('data-scidoc-range-apply')) {
        try {
          const doc = session.document, max = doc.pageCount || doc.units.length, range = rangeNumbers(host.querySelector('[data-scidoc-range]').value, max);
          const chosen = doc.units.filter(unit => unit.readable && range.has(doc.pageCount ? unit.page : unit.index + 1));
          if (!chosen.length) throw new Error('所选范围没有可提取文字，请换一个页段。');
          session.error = ''; choose(session, chosen.map(unit => unit.id));
        } catch (error) { session.error = error.message; paintStatus(session); }
      }
    }, { signal: controller.signal });
    paintDocument(session);
    // Generation and status paints remount this view. Preserve a user's pending or
    // failed choice; an automatic list refresh must not restore the previous file.
    const loading = session.load && (session.loadPending || session.loadError) ? session.load : load(session);
    void loading.catch(error => { if (live(session) && error.name !== 'AbortError') { session.error = error.message; paintStatus(session); } });
    const cleanup = current.dispose; cleanup.dispose = cleanup; return cleanup;
  }
  async function flush(project, { requireSelection = true } = {}) {
    const session = sessionFor(project);
    for (;;) {
      const operation = session.operation; await operation;
      const loading = session.load;
      try { await loading; } catch (error) { if (loading === session.load && requireSelection) throw error; }
      const saving = session.saveQueue; await saving;
      if (operation === session.operation && loading === session.load && saving === session.saveQueue) break;
    }
    return requireSelection ? validateSelection(session) : selection(session.project);
  }
  async function cancelProject(id) {
    const session = sessions.get(id); if (!session) return;
    session.removed = true; session.controller?.abort(); session.loadController?.abort(); ++session.generation;
    await Promise.allSettled([session.operation, session.load, session.saveQueue].filter(Boolean));
    if (view?.session === session) view.dispose(); sessions.delete(id);
  }
  function dispose() {
    disposed = true; view?.dispose();
    for (const session of sessions.values()) { session.removed = true; session.controller?.abort(); session.loadController?.abort(); }
    sessions.clear();
  }
  return { mount, selection, flush, cancelProject, dispose };
}
