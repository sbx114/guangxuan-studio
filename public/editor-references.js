import { api, fetchLocal, escapeHtml as h, icon, showModal, toast, uid } from './ui.js';
import { createReferenceSegmentState, referenceSegmentsMarkup, paintReferenceSegments, bindReferenceSegments } from './reference-segments.js';

const MAX_REFERENCES = 8, TEXT_LIMIT = 12000, FOCUS_LIMIT = 1500;
const ASPECTS = [['style', '整体风格'], ['editing', '剪辑手法'], ['color', '色彩滤镜'], ['composition', '镜头构图'], ['titles', '字幕排版'], ['structure', '文案结构']];
const defaultAspects = type => type === 'text' ? ['structure'] : type === 'image' ? ['style', 'color'] : ['style', 'editing'];
const abortError = () => new DOMException('操作已取消', 'AbortError');
const mediaUrl = item => `/api/video/media/${encodeURIComponent(item.assetId)}`;
const endpoint = id => `/api/projects/${encodeURIComponent(id)}/references`;
const allowedUrl = value => {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : ''; }
  catch { return ''; }
};

function ensureStyles() {
  if (document.querySelector('link[data-editor-references-style]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = '/editor-references.css'; link.dataset.editorReferencesStyle = '';
  document.head.append(link);
}

function waitFor(promises, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  const completion = Promise.allSettled(promises);
  if (!signal) return completion;
  return new Promise((resolve, reject) => {
    const stop = () => { signal.removeEventListener('abort', stop); reject(abortError()); };
    signal.addEventListener('abort', stop, { once: true });
    completion.then(result => { signal.removeEventListener('abort', stop); resolve(result); });
  });
}

/** References have their own server store and never enter the editor's asset pool. */
export function createEditorReferences({ onChanged, getTimelineRange } = {}) {
  const sessions = new Map();
  let modal = null, destroyed = false;
  ensureStyles();

  function sessionFor(project) {
    const id = typeof project === 'string' ? project : project?.id;
    if (!id || destroyed) throw abortError();
    let session = sessions.get(id);
    if (!session) {
      session = { id, items: [], revision: 0, includeImages: true, loaded: false, removed: false,
        tail: Promise.resolve(), importTail: Promise.resolve(), pending: new Set(), pendingKinds: new Map(), operations: new Set(), drafts: new Map(), timers: new Map(),
        editVersion: 0, config: null, configTimer: null, loading: null, reservations: 0,
        error: '', addError: '', mode: '', newText: '', textFocus: '', newUrl: '', urlFocus: '', segments: createReferenceSegmentState() };
      sessions.set(id, session);
    }
    return session;
  }
  const alive = session => !destroyed && !session.removed && sessions.get(session.id) === session;
  const panelFor = session => modal?.session === session && modal.panel?.isConnected ? modal.panel : null;
  const modified = session => session.drafts.size > 0 || Boolean(session.config) || session.segments.errors.size > 0;
  const report = (session, error) => {
    if (error?.name !== 'AbortError' && alive(session) && !panelFor(session)) toast(error.message, 'error');
  };

  function accept(session, result) {
    if (!alive(session)) throw abortError();
    if (!result || !Array.isArray(result.items)) throw new Error('参考列表未能读取，请重试。');
    if (Number.isSafeInteger(result.revision) && result.revision < session.revision) return result;
    session.items = result.items.filter(item => item && typeof item.id === 'string' && ['video', 'image', 'text'].includes(item.type));
    session.revision = result.revision;
    session.includeImages = result.includeImages !== false;
    session.loaded = true;
    onChanged?.(session.id, session.items.length);
    paint(session);
    return result;
  }

  function enqueue(session, label, run, kind = 'save') {
    if (!alive(session)) return Promise.reject(abortError());
    const operation = { id: uid(), label, kind, controller: new AbortController(), started: false };
    session.operations.add(operation);
    const lane = kind === 'add' ? 'importTail' : 'tail';
    const pending = session[lane].catch(() => {}).then(async () => {
      if (!alive(session) || operation.controller.signal.aborted) throw abortError();
      operation.started = true; paint(session);
      const result = await run(operation.controller.signal);
      if (operation.controller.signal.aborted) throw abortError();
      return accept(session, result);
    }).catch(error => {
      if (alive(session) && error.name !== 'AbortError') {
        session.error = error.message;
        if (kind === 'add') session.addError = error.message;
      }
      throw error;
    }).finally(() => {
      session.operations.delete(operation); session.pending.delete(pending); session.pendingKinds.delete(pending); paint(session);
    });
    session.pending.add(pending);
    session.pendingKinds.set(pending, kind);
    session[lane] = pending.catch(() => {});
    paint(session);
    return pending;
  }

  function load(project, force = false) {
    const session = sessionFor(project);
    if (session.loading) return session.loading;
    if (session.loaded && !force) return Promise.resolve(session);
    session.error = '';
    session.loading = enqueue(session, '正在读取参考…', signal => api(endpoint(session.id), undefined, { signal }), 'read')
      .then(() => session).finally(() => { session.loading = null; paint(session); });
    return session.loading;
  }

  function saveDraft(session, id) {
    const draft = session.drafts.get(id);
    clearTimeout(session.timers.get(id)); session.timers.delete(id);
    if (!draft || !alive(session)) return Promise.resolve();
    if (draft.savingVersion === draft.version) return draft.pending;
    const version = draft.version, fields = { ...draft.fields };
    draft.savingVersion = version;
    const pending = enqueue(session, '正在保存…', signal => api(`${endpoint(session.id)}/${encodeURIComponent(id)}`, fields, { method: 'PATCH', signal }))
      .then(() => {
        if (session.drafts.get(id)?.version === version) {
          session.drafts.delete(id);
          for (const kind of ['source', 'target']) if (!session.segments.errors.has(`${id}:${kind}`)) session.segments.drafts.delete(`${id}:${kind}`);
        }
        if (!modified(session)) session.error = '';
      }).catch(error => {
        if (session.drafts.get(id)?.savingVersion === version) session.drafts.get(id).savingVersion = null;
        throw error;
      }).finally(() => paint(session));
    draft.pending = pending;
    return pending;
  }

  function editField(session, id, key, value) {
    if (!alive(session) || !session.items.some(item => item.id === id)) return;
    const previous = session.drafts.get(id);
    const draft = { ...previous, fields: { ...previous?.fields, [key]: value }, version: ++session.editVersion };
    session.drafts.set(id, draft); session.error = '';
    clearTimeout(session.timers.get(id));
    session.timers.set(id, setTimeout(() => { void saveDraft(session, id).catch(error => report(session, error)); }, 450));
    paintStatus(session);
  }

  function saveConfig(session) {
    clearTimeout(session.configTimer); session.configTimer = null;
    const draft = session.config;
    if (!draft || !alive(session)) return Promise.resolve();
    if (draft.pending) return draft.pending;
    const pending = enqueue(session, '正在保存…', signal => api(endpoint(session.id), { includeImages: draft.includeImages }, { method: 'PATCH', signal }))
      .then(() => { if (session.config === draft) session.config = null; if (!modified(session)) session.error = ''; })
      .catch(error => { draft.pending = null; throw error; }).finally(() => paint(session));
    draft.pending = pending;
    return pending;
  }

  async function flush(projectId, { signal, imports = true } = {}) {
    const targets = projectId ? [sessions.get(projectId)].filter(Boolean) : [...sessions.values()];
    for (const session of targets) {
      if (!alive(session)) continue;
      if (session.segments.errors.size) throw new Error([...session.segments.errors.values()][0]);
      const mutations = () => [...session.pending].filter(pending => session.pendingKinds.get(pending) !== 'read' && (imports || session.pendingKinds.get(pending) !== 'add'));
      for (;;) {
        const saves = [...session.drafts.keys()].map(id => saveDraft(session, id));
        if (session.config) saves.push(saveConfig(session));
        const results = await waitFor([...mutations(), ...saves], signal);
        if (!alive(session)) throw abortError();
        const failed = results.find(result => result.status === 'rejected' && result.reason?.name !== 'AbortError');
        if (failed) throw failed.reason;
        if (imports && session.addError) throw new Error(session.addError);
        // A failed background list read has no unsaved content to hold navigation.
        if (!mutations().length && !modified(session)) break;
      }
    }
  }

  function add(session, label, run) {
    if (session.items.length + session.reservations >= MAX_REFERENCES) return Promise.reject(new Error('最多添加 8 项参考。'));
    session.reservations++;
    return enqueue(session, label, run, 'add').finally(() => { session.reservations--; paint(session); });
  }

  async function upload(session, file) {
    const image = file.type.startsWith('image/') || /\.(?:png|jpe?g|webp|gif|bmp|avif)$/i.test(file.name);
    const video = file.type.startsWith('video/') || /\.(?:mp4|mov|webm|mkv|avi|m4v)$/i.test(file.name);
    if (!image && !video) throw new Error('请选择视频或图片。');
    const limit = (image ? 20 : 200) * 1024 * 1024;
    if (!file.size || file.size > limit) throw new Error(image ? '图片需小于 20MB。' : '视频需小于 200MB。');
    return add(session, `正在上传 ${file.name}`, async signal => {
      const response = await fetchLocal('/api/video/upload', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) }, body: file, signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message || result.error || '上传失败，请重试。');
      const asset = result.assets?.find(item => ['image', 'video'].includes(item.type));
      if (!asset?.id) throw new Error('未读到可用的视频或图片。');
      if (!alive(session) || signal.aborted) throw abortError();
      return api(endpoint(session.id), { type: asset.type, assetId: asset.id, name: file.name.slice(0, 120), focus: '', aspects: defaultAspects(asset.type) }, { signal });
    });
  }

  function itemMarkup(item, session) {
    const content = item.type === 'text'
      ? `<label class="gx-reference-text"><span>参考文字</span><textarea rows="3" maxlength="${TEXT_LIMIT}" data-reference-field="text">${h(item.text || '')}</textarea></label>`
      : `<details class="gx-reference-preview"><summary>预览</summary>${item.type === 'video' ? `<video controls preload="none" src="${h(mediaUrl(item))}"></video>` : `<img loading="lazy" src="${h(mediaUrl(item))}" alt="${h(item.name)}">`}</details>`;
    const source = allowedUrl(item.sourceUrl);
    const aspects = Array.isArray(item.aspects) ? item.aspects : [];
    return `<article class="gx-reference-item" data-reference-id="${h(item.id)}"><div class="gx-reference-heading">${icon(item.type === 'image' ? 'layers' : item.type === 'video' ? 'video' : 'text')}<input data-reference-field="name" aria-label="参考名称" maxlength="120" value="${h(item.name)}"><button type="button" class="icon-btn" data-reference-remove aria-label="移除参考" title="移除参考">${icon('trash')}</button></div>${content}${referenceSegmentsMarkup(item, session.segments)}<details class="gx-reference-aspects"><summary>参考方向 <small data-reference-aspect-count>${aspects.length} 项</small></summary><div class="gx-reference-chips" role="group" aria-label="参考方向">${ASPECTS.map(([id, label]) => `<button type="button" data-reference-aspect="${id}" aria-pressed="${aspects.includes(id)}">${label}</button>`).join('')}</div></details><label class="gx-reference-focus"><span>参考重点</span><textarea rows="2" maxlength="${FOCUS_LIMIT}" data-reference-field="focus" placeholder="选填">${h(item.focus || '')}</textarea></label>${source ? `<a class="gx-reference-source" href="${h(source)}" target="_blank" rel="noopener noreferrer">来源 ↗</a>` : ''}</article>`;
  }

  function paintStatus(session) {
    const panel = panelFor(session); if (!panel) return;
    const operation = [...session.operations].find(item => item.started) || [...session.operations][0];
    const error = session.addError || [...session.segments.errors.values()][0] || session.error;
    const status = panel.querySelector('[data-reference-status]');
    status.textContent = error || operation?.label || (modified(session) ? '待保存' : session.loaded ? '已保存' : '正在读取参考…');
    status.classList.toggle('is-error', Boolean(error));
    panel.querySelector('[data-reference-retry]').hidden = !error || Boolean(session.addError) || session.segments.errors.size > 0;
    panel.querySelector('[data-reference-dismiss]').hidden = !session.addError;
    panel.querySelector('[data-reference-stop]').hidden = ![...session.operations].some(item => item.kind === 'add');
    const full = !session.loaded || session.items.length + session.reservations >= MAX_REFERENCES;
    panel.querySelector('[data-reference-files]').disabled = full;
    panel.querySelectorAll('[data-reference-submit]').forEach(button => { button.disabled = full || session.reservations > 0; });
    panel.querySelector('[data-reference-empty]').hidden = !session.loaded || session.items.length > 0;
  }

  function paint(session) {
    const panel = panelFor(session); if (!panel) return;
    const list = panel.querySelector('[data-reference-list]');
    const retained = new Set(session.items.map(item => item.id));
    for (const card of [...list.children]) if (!retained.has(card.dataset.referenceId)) {
      card.querySelectorAll('video').forEach(player => { player.pause(); player.removeAttribute('src'); player.load(); }); card.remove();
    }
    for (const record of session.items) {
      const item = { ...record, ...session.drafts.get(record.id)?.fields };
      let card = [...list.children].find(node => node.dataset.referenceId === record.id);
      if (!card) { list.insertAdjacentHTML('beforeend', itemMarkup(item, session)); card = list.lastElementChild; }
      paintReferenceSegments(card, item, session.segments, { hasSelection: typeof getTimelineRange === 'function' });
      for (const input of card.querySelectorAll('[data-reference-field]')) {
        const next = String(item[input.dataset.referenceField] || '');
        if (document.activeElement !== input && input.value !== next) input.value = next;
      }
      const aspects = Array.isArray(item.aspects) ? item.aspects : [];
      card.querySelector('[data-reference-aspect-count]').textContent = `${aspects.length} 项`;
      card.querySelectorAll('[data-reference-aspect]').forEach(button => button.setAttribute('aria-pressed', String(aspects.includes(button.dataset.referenceAspect))));
    }
    panel.querySelector('[data-reference-visual-option]').hidden = !session.items.some(item => item.type !== 'text');
    panel.querySelector('[data-reference-images]').checked = session.config?.includeImages ?? session.includeImages;
    panel.querySelector('[data-reference-text-form]').hidden = session.mode !== 'text';
    panel.querySelector('[data-reference-url-form]').hidden = session.mode !== 'url';
    panel.querySelectorAll('[data-reference-mode]').forEach(button => button.setAttribute('aria-expanded', String(button.dataset.referenceMode === session.mode)));
    paintStatus(session);
  }

  function close() {
    const current = modal; if (!current) return;
    if (current.panel?.isConnected) current.close?.();
    else modal = null;
  }

  function open(project) {
    const session = sessionFor(project);
    close();
    const view = { session, panel: null, close: null }; modal = view;
    view.close = showModal({ title: '参考', wide: true, body: `<div class="gx-editor-references"><div class="gx-reference-tools"><label class="btn small gx-reference-upload">${icon('upload')}视频 / 图片<input type="file" data-reference-files accept="video/*,image/*" multiple></label><button class="btn small" type="button" data-reference-mode="text" aria-expanded="false">${icon('text')}文字</button><button class="btn small" type="button" data-reference-mode="url" aria-expanded="false">${icon('link')}网址</button></div><form class="gx-reference-add" data-reference-text-form hidden><label>参考文字<textarea data-reference-new-text rows="4" maxlength="${TEXT_LIMIT}" placeholder="粘贴参考文字">${h(session.newText)}</textarea></label><label>参考重点<input data-reference-text-focus maxlength="${FOCUS_LIMIT}" placeholder="选填" value="${h(session.textFocus)}"></label><button class="btn small primary" type="submit" data-reference-submit>添加</button></form><form class="gx-reference-add" data-reference-url-form hidden><label>视频网址<input type="url" data-reference-new-url maxlength="2000" placeholder="粘贴视频网址" value="${h(session.newUrl)}" required></label><label>参考重点<input data-reference-url-focus maxlength="${FOCUS_LIMIT}" placeholder="选填" value="${h(session.urlFocus)}"></label><button class="btn small primary" type="submit" data-reference-submit>添加</button></form><label class="gx-reference-visual" data-reference-visual-option hidden><input type="checkbox" data-reference-images checked>使用参考画面</label><div class="gx-reference-list" data-reference-list></div><p class="gx-reference-empty" data-reference-empty hidden>暂无参考</p><div class="gx-reference-status"><span data-reference-status role="status"></span><button class="btn small" type="button" data-reference-retry hidden>重试</button><button class="btn small" type="button" data-reference-dismiss hidden>取消此次添加</button><button class="btn small" type="button" data-reference-stop hidden>停止添加</button></div></div>`, onMount(root) {
      view.panel = root.querySelector('.gx-editor-references');
      const panel = view.panel;
      view.segments = bindReferenceSegments({ panel, state: session.segments, getItem: id => { const item = session.items.find(item => item.id === id); return item && { ...item, ...session.drafts.get(id)?.fields }; }, onEdit: (id, field, value) => editField(session, id, field, value), onState: () => paintStatus(session), getTimelineRange });
      panel.querySelector('.gx-reference-tools').after(panel.querySelector('.gx-reference-status'));
      const failure = error => { if (error.name !== 'AbortError' && alive(session)) { session.error = error.message; paint(session); report(session, error); } };
      const resetAddError = () => { session.error = ''; session.addError = ''; };
      panel.addEventListener('input', event => {
        const input = event.target;
        const key = input.dataset.referenceField;
        if (key) editField(session, input.closest('[data-reference-id]').dataset.referenceId, key, input.value);
        if (input.matches('[data-reference-new-text]')) session.newText = input.value;
        if (input.matches('[data-reference-text-focus]')) session.textFocus = input.value;
        if (input.matches('[data-reference-new-url]')) session.newUrl = input.value;
        if (input.matches('[data-reference-url-focus]')) session.urlFocus = input.value;
      });
      panel.addEventListener('click', event => {
        const mode = event.target.closest('[data-reference-mode]');
        if (mode) { session.mode = session.mode === mode.dataset.referenceMode ? '' : mode.dataset.referenceMode; paint(session); panel.querySelector(session.mode === 'text' ? '[data-reference-new-text]' : '[data-reference-new-url]')?.focus(); }
        const remove = event.target.closest('[data-reference-remove]');
        if (remove) {
          const id = remove.closest('[data-reference-id]').dataset.referenceId;
          clearTimeout(session.timers.get(id)); session.timers.delete(id); session.drafts.delete(id); session.error = ''; remove.disabled = true;
          for (const key of [...session.segments.errors.keys()]) if (key.startsWith(id + ':')) session.segments.errors.delete(key);
          for (const key of [...session.segments.drafts.keys()]) if (key.startsWith(id + ':')) session.segments.drafts.delete(key);
          void enqueue(session, '正在移除…', signal => api(`${endpoint(session.id)}/${encodeURIComponent(id)}`, undefined, { method: 'DELETE', signal })).catch(failure).finally(() => { if (remove.isConnected) remove.disabled = false; });
        }
        const chip = event.target.closest('[data-reference-aspect]');
        if (chip) {
          const id = chip.closest('[data-reference-id]').dataset.referenceId, item = session.items.find(record => record.id === id);
          const chosen = new Set(session.drafts.get(id)?.fields.aspects ?? item?.aspects ?? []), aspect = chip.dataset.referenceAspect;
          if (chosen.has(aspect)) chosen.delete(aspect); else chosen.add(aspect);
          editField(session, id, 'aspects', ASPECTS.map(([value]) => value).filter(value => chosen.has(value))); paint(session);
        }
      });
      panel.querySelector('[data-reference-files]').onchange = event => {
        const files = [...event.target.files]; event.target.value = ''; resetAddError();
        if (files.length > MAX_REFERENCES - session.items.length - session.reservations) return failure(new Error('最多添加 8 项参考。'));
        for (const file of files) void upload(session, file).catch(failure);
      };
      panel.querySelector('[data-reference-text-form]').onsubmit = event => {
        event.preventDefault(); const text = session.newText.trim(), focus = session.textFocus.trim();
        if (!text) return failure(new Error('请填写参考文字。'));
        resetAddError();
        void add(session, '正在添加文字…', signal => api(endpoint(session.id), { type: 'text', name: text.split(/\r?\n/)[0].slice(0, 120), text, focus, aspects: defaultAspects('text') }, { signal }))
          .then(() => { if (session.newText.trim() === text) { session.newText = ''; session.textFocus = ''; session.mode = ''; const current = panelFor(session); if (current) { current.querySelector('[data-reference-new-text]').value = ''; current.querySelector('[data-reference-text-focus]').value = ''; } } paint(session); }).catch(failure);
      };
      panel.querySelector('[data-reference-url-form]').onsubmit = event => {
        event.preventDefault(); const raw = session.newUrl.trim(), url = allowedUrl(raw), focus = session.urlFocus.trim();
        if (!url) return failure(new Error('请输入有效的 http 或 https 网址。'));
        resetAddError();
        void add(session, '正在读取网址视频…', signal => api(`${endpoint(session.id)}/url`, { url, focus, aspects: defaultAspects('video') }, { signal }))
          .then(() => { if (session.newUrl.trim() === raw) { session.newUrl = ''; session.urlFocus = ''; session.mode = ''; const current = panelFor(session); if (current) { current.querySelector('[data-reference-new-url]').value = ''; current.querySelector('[data-reference-url-focus]').value = ''; } } paint(session); }).catch(failure);
      };
      panel.querySelector('[data-reference-images]').onchange = event => {
        session.config = { includeImages: event.target.checked, pending: null }; session.error = '';
        clearTimeout(session.configTimer); session.configTimer = setTimeout(() => { void saveConfig(session).catch(failure); }, 200); paintStatus(session);
      };
      panel.querySelector('[data-reference-retry]').onclick = () => { session.error = ''; void (session.loaded ? flush(session.id) : load(session.id, true)).catch(failure); };
      panel.querySelector('[data-reference-dismiss]').onclick = () => { session.addError = ''; session.error = ''; paint(session); };
      panel.querySelector('[data-reference-stop]').onclick = () => { for (const operation of session.operations) if (operation.kind === 'add') operation.controller.abort(); session.addError = ''; session.error = ''; paint(session); };
      paint(session);
      void load(session.id, true).catch(failure);
    }, onClose() {
      view.segments?.dispose();
      view.panel?.querySelectorAll('video').forEach(player => { player.pause(); player.removeAttribute('src'); player.load(); });
      if (modal === view) modal = null;
      if (alive(session)) void flush(session.id, { imports: false }).catch(error => report(session, error));
    } });
  }

  async function cancelProject(id) {
    const session = sessions.get(id); if (!session) return;
    session.removed = true;
    for (const timer of session.timers.values()) clearTimeout(timer);
    clearTimeout(session.configTimer);
    for (const operation of session.operations) operation.controller.abort();
    if (modal?.session === session) close();
    await Promise.allSettled([...session.pending]);
    if (sessions.get(id) === session) sessions.delete(id);
  }

  return {
    open, close, flush, cancelProject,
    activate(project) { if (modal && modal.session.id !== project.id) close(); return load(project, true); },
    count: id => sessions.get(id)?.items.length || 0,
    dispose() {
      destroyed = true;
      for (const session of sessions.values()) {
        session.removed = true;
        for (const timer of session.timers.values()) clearTimeout(timer);
        clearTimeout(session.configTimer);
        for (const operation of session.operations) operation.controller.abort();
      }
      close(); sessions.clear();
    },
  };
}
