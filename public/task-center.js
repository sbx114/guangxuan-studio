import { api, escapeHtml as h, formatDate, icon, showModal, toast } from './ui.js';

const ACTIVE = new Set(['queued', 'running', 'cancelling']);
const LABELS = { queued: '排队中', running: '进行中', cancelling: '正在取消', succeeded: '已完成', failed: '未完成', cancelled: '已取消', interrupted: '已中断' };
const assistantRunId = task => task?.type === 'assistant' && typeof task.sourceJobId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(task.sourceJobId) ? task.sourceJobId : '';
function safeOutputUrl(url, projectId) {
  if (typeof url !== 'string' || /[\\%?#\s]/.test(url)) return '';
  if (/^\/api\/(?:video\/exports|project-bundles\/exports)\/[A-Za-z0-9_-]{1,128}\/file$/.test(url)) return url;
  if (/^\/api\/video\/previews\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,128}\.(?:jpg|png)$/.test(url)) return url;
  const native = /^\/api\/openfilm\/exports\/([A-Za-z0-9_-]{1,128})\/[A-Za-z0-9_-]{1,128}\/file$/.exec(url);
  return native && native[1] === projectId ? url : '';
}
const dateText = value => value && Number.isFinite(Date.parse(value)) ? formatDate(value) : '';

/** Host entry points: taskCenter.open(), taskCenter.refresh(), taskCenter.dispose(). */
export function createTaskCenter({ getProjectId = () => '', onOpenProject } = {}) {
  if (!document.querySelector('link[data-task-center-css]')) {
    const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = '/task-center.css'; link.dataset.taskCenterCss = ''; document.head.append(link);
  }
  let active = null, disposed = false;
  const connected = session => !disposed && active === session && !session.closed && session.panel?.isConnected;
  function clearTimer(session) { clearTimeout(session.timer); session.timer = null; }
  function cleanup(session) {
    if (session.closed) return;
    session.closed = true; clearTimer(session); session.request?.abort(); session.actions.abort();
    document.removeEventListener('visibilitychange', session.visibility);
    if (active === session) active = null;
  }
  function scopeQuery(session, { actionProjectId } = {}) {
    const query = new URLSearchParams();
    const owner = actionProjectId || (session.scope === 'current' ? session.projectId : '');
    if (owner) query.set('projectId', owner);
    if (actionProjectId === undefined && session.status) query.set('status', session.status === 'active' ? 'queued,running,cancelling' : session.status);
    const text = query.toString(); return text ? `?${text}` : '';
  }
  function announce(session, message = '', error = false) {
    if (!connected(session)) return;
    const element = session.panel.querySelector('[data-tasks-status]');
    element.textContent = message; element.classList.toggle('is-error', error); element.setAttribute('role', error ? 'alert' : 'status');
  }
  function cardMarkup(task, pending) {
    const status = Object.hasOwn(LABELS, task.status) ? task.status : 'queued';
    const progress = Math.max(0, Math.min(100, Number(task.progress) || 0));
    const busy = pending.has(task.id), outputs = (Array.isArray(task.outputs) ? task.outputs : []).flatMap(output => {
      const url = safeOutputUrl(output?.url, task.projectId);
      return url ? [`<a class="btn gx-task-output" href="${h(url)}" download>${icon('download')}${h(output.label || '下载结果')}</a>`] : [];
    });
    const error = typeof task.error === 'string' ? task.error : task.error?.message;
    const project = task.projectId ? task.projectName || '未命名项目' : '工作台';
    return `<article class="gx-task-card" data-task-id="${h(task.id)}" aria-label="${h(task.title || '后台任务')}">
      <div class="gx-task-heading"><div class="gx-task-name"><span class="gx-task-project">${icon(task.projectId ? 'folder' : 'layers')}${h(project)}</span><h3>${h(task.title || '后台任务')}</h3></div><span class="gx-task-state is-${status}">${status === 'succeeded' ? icon('check') : status === 'failed' || status === 'interrupted' ? icon('info') : icon('clock')}${LABELS[status]}</span></div>
      <div class="gx-task-phase"><span>${h(task.phase || LABELS[status])}</span><span>${Math.round(progress)}%</span></div>
      <progress class="gx-task-progress is-${status}" max="100" value="${progress}" aria-label="${h(task.title || '任务')}进度 ${Math.round(progress)}%"></progress>
      ${task.message ? `<p class="gx-task-message">${h(task.message)}</p>` : ''}${error ? `<p class="gx-task-error">${icon('info')}<span>${h(error)}</span></p>` : ''}
      <div class="gx-task-bottom"><span class="gx-task-date">${h(dateText(task.createdAt))}${Number(task.attempt) > 1 ? ` · 第 ${Math.floor(Number(task.attempt))} 次执行` : ''}</span><div class="gx-task-actions">${outputs.join('')}${assistantRunId(task) ? `<button class="btn" data-task-action="assistant" data-task="${h(task.id)}">${icon('spark')}查看对话</button>` : ''}${task.projectId && typeof onOpenProject === 'function' ? `<button class="btn" data-task-action="project" data-task="${h(task.id)}">${icon('arrow')}返回项目</button>` : ''}${task.canCancel ? `<button class="btn" data-task-action="cancel" data-task="${h(task.id)}" ${busy ? 'disabled' : ''}>${icon('close')}${busy ? '正在处理…' : '取消任务'}</button>` : ''}${task.canRetry ? `<button class="btn" data-task-action="retry" data-task="${h(task.id)}" ${busy ? 'disabled' : ''}>${icon('refresh')}${busy ? '正在处理…' : '重试'}</button>` : ''}</div></div>
    </article>`;
  }
  function render(session) {
    if (!connected(session)) return;
    const list = session.panel.querySelector('[data-tasks-list]'), focused = document.activeElement;
    const focusTask = focused?.dataset?.task, focusAction = focused?.dataset?.taskAction, scrollTop = list.scrollTop;
    const signature = JSON.stringify([session.loaded, session.scope, session.items, [...session.pending]]);
    if (signature !== session.rendered) {
      session.rendered = signature;
      list.innerHTML = session.items.length ? session.items.map(task => cardMarkup(task, session.pending)).join('') : !session.loaded ? '<div class="gx-tasks-empty"><span class="spinner"></span><p>正在读取任务…</p></div>' : `<div class="gx-tasks-empty">${icon('layers')}<strong>暂无任务</strong><p>${session.scope === 'current' ? '当前项目的任务会显示在这里。' : '生成、导出等任务会显示在这里。'}</p></div>`;
      list.scrollTop = scrollTop;
      if (focusTask && focusAction) [...list.querySelectorAll('[data-task-action]')].find(button => button.dataset.task === focusTask && button.dataset.taskAction === focusAction)?.focus({ preventScroll: true });
    }
    const activeCount = session.items.filter(task => ACTIVE.has(task.status)).length;
    session.panel.querySelector('[data-tasks-count]').textContent = `${session.items.length} 项任务${activeCount ? ` · ${activeCount} 项进行中` : ''}`;
    for (const button of session.panel.querySelectorAll('[data-tasks-scope]')) button.setAttribute('aria-pressed', String(button.dataset.tasksScope === session.scope));
  }
  function schedule(session) {
    clearTimer(session);
    if (!connected(session) || document.hidden) return;
    session.timer = setTimeout(() => { void load(session); }, session.items.some(task => ACTIVE.has(task.status)) ? 1600 : 8000);
  }
  async function load(session, { force = false } = {}) {
    if (!connected(session) || document.hidden) return;
    if (session.loading && !force) return session.loading;
    if (force) session.request?.abort();
    clearTimer(session);
    const generation = ++session.generation, request = new AbortController(); session.request = request;
    const refresh = session.panel.querySelector('[data-tasks-refresh]'); refresh.disabled = true;
    session.loading = (async () => {
      try {
        const result = await api(`/api/tasks${scopeQuery(session)}`, undefined, { signal: request.signal });
        if (!connected(session) || generation !== session.generation) return;
        session.items = (Array.isArray(result?.items) ? result.items : []).filter(task => task && typeof task.id === 'string');
        session.loaded = true; announce(session); render(session);
      } catch (error) {
        if (!connected(session) || generation !== session.generation || error.name === 'AbortError') return;
        announce(session, error.message || '任务列表刷新失败，请重试。', true);
        if (!session.loaded) session.panel.querySelector('[data-tasks-list]').innerHTML = '<div class="gx-tasks-empty"><p>点击“刷新”重试。</p></div>';
      } finally {
        if (connected(session) && generation === session.generation) { session.loading = null; refresh.disabled = false; schedule(session); }
      }
    })();
    return session.loading;
  }
  async function perform(session, button) {
    const task = session.items.find(item => item.id === button.dataset.task), action = button.dataset.taskAction;
    if (!task || !connected(session)) return;
    if (action === 'assistant' && assistantRunId(task)) {
      session.close();
      document.dispatchEvent(new CustomEvent('gx:assistant-open', { detail: { projectId: task.projectId || null, runId: assistantRunId(task) } }));
      return;
    }
    if (action === 'project') {
      session.close();
      try { await onOpenProject?.(task.projectId, task); } catch (error) { toast(error.message || '暂时无法打开项目，请从项目列表重试。', 'error'); }
      return;
    }
    if (!['cancel', 'retry'].includes(action) || session.pending.has(task.id)) return;
    session.pending.add(task.id); render(session); announce(session, action === 'cancel' ? '正在取消任务…' : '正在重试…');
    try {
      await api(`/api/tasks/${encodeURIComponent(task.id)}/${action}${scopeQuery(session, { actionProjectId: task.projectId || '' })}`, {}, { signal: session.actions.signal });
      if (connected(session)) { announce(session); await load(session, { force: true }); }
    } catch (error) { if (connected(session) && error.name !== 'AbortError') announce(session, error.message || '任务操作未完成，请稍后重试。', true); }
    finally { session.pending.delete(task.id); if (connected(session)) render(session); }
  }
  function open(options = {}) {
    if (disposed) return;
    active?.close();
    const rawId = getProjectId?.(), owner = typeof rawId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(rawId) ? rawId : '';
    const session = { projectId: owner, scope: owner && options?.scope !== 'all' ? 'current' : 'all', status: '', items: [], pending: new Set(), actions: new AbortController(), closed: false, panel: null, request: null, timer: null, generation: 0, loaded: false, rendered: '', loading: null, close: null, visibility: null };
    active = session;
    const close = showModal({ title: '任务中心', kicker: 'Gx · 工作进度', wide: true, body: `<div class="gx-task-center"><p class="gx-tasks-intro">查看任务进度和结果。</p><div class="gx-tasks-toolbar"><div class="gx-tasks-scope" role="group" aria-label="任务范围"><button class="btn" data-tasks-scope="current" ${owner ? '' : 'disabled title="请先打开一个项目"'}>当前项目</button><button class="btn" data-tasks-scope="all">全部任务</button></div><label class="gx-tasks-filter"><span>状态</span><select data-tasks-filter aria-label="筛选任务状态"><option value="">全部状态</option><option value="active">进行中</option><option value="succeeded">已完成</option><option value="failed">未完成</option><option value="cancelled">已取消</option><option value="interrupted">已中断</option></select></label><button class="btn" data-tasks-refresh>${icon('refresh')}刷新</button></div><div class="gx-tasks-meta"><span data-tasks-count>正在读取任务…</span><span data-tasks-status role="status" aria-live="polite"></span></div><div class="gx-tasks-list" data-tasks-list aria-label="任务列表"><div class="gx-tasks-empty"><span class="spinner"></span><p>正在读取任务…</p></div></div><p class="gx-tasks-footnote">关闭窗口后任务会继续。</p></div>`, onMount(root, closeModal) {
      session.panel = root.querySelector('.modal'); session.panel.classList.add('gx-task-modal'); session.close = closeModal;
      session.panel.querySelector('[data-tasks-refresh]').onclick = () => { void load(session, { force: true }); };
      session.panel.querySelector('[data-tasks-filter]').onchange = event => { session.status = event.target.value; session.items = []; session.loaded = false; render(session); void load(session, { force: true }); };
      for (const button of session.panel.querySelectorAll('[data-tasks-scope]')) button.onclick = () => { if (button.disabled || session.scope === button.dataset.tasksScope) return; session.scope = button.dataset.tasksScope; session.items = []; session.loaded = false; render(session); void load(session, { force: true }); };
      session.panel.querySelector('[data-tasks-list]').onclick = event => { const button = event.target.closest('[data-task-action]'); if (button && session.panel.contains(button)) void perform(session, button); };
      session.visibility = () => {
        if (!connected(session)) return;
        if (document.hidden) { clearTimer(session); session.generation += 1; session.request?.abort(); session.loading = null; }
        else void load(session, { force: true });
      };
      document.addEventListener('visibilitychange', session.visibility); render(session); void load(session);
    }, onClose() { cleanup(session); } });
    session.close ||= close;
    return close;
  }
  function refresh() { if (active) return load(active, { force: true }); }
  function dispose() { if (disposed) return; const session = active; disposed = true; if (session) { session.close?.(); cleanup(session); } }
  return { open, refresh, dispose };
}
