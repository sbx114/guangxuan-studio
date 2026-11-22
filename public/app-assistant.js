import { icon, escapeHtml as h, showModal, toast, uid } from './ui.js';
import { startAssistantRun, cancelAssistantRun, watchAssistantRun, applyAssistantJob, assistantDetails, assistantProgressText } from './assistant-client.js';
import { readWritingPreferences } from './writing-preferences.js';

const STORAGE = 'gx-assistant-conversations-v1';
export function createAppAssistant({ getSettings, requireConnection, getProjects, getProjectId, beforeStart, onChanged, onUndo } = {}) {
  const sessions = new Map(); let root = null, current = null, closeDialog = null, disposed = false;
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE) || '[]');
    for (const value of (Array.isArray(stored) ? stored : []).slice(-12)) {
      if (!value || typeof value.key !== 'string') continue;
      sessions.set(value.key, { key: value.key, projectId: value.key || null, draft: String(value.draft || '').slice(0, 12000), mode: value.mode === 'ask' ? 'ask' : 'auto', windowKind: value.windowKind === 'writing' ? 'writing' : 'project', writingTarget: ['draft', 'selection', 'project'].includes(value.writingTarget) ? value.writingTarget : 'draft', messages: (Array.isArray(value.messages) ? value.messages : []).filter(message => message && ['user', 'assistant'].includes(message.role) && typeof message.content === 'string').slice(-60), busy: false });
    }
  } catch { /* A damaged or full browser store must not prevent opening the assistant. */ }
  const remember = () => { try { localStorage.setItem(STORAGE, JSON.stringify([...sessions.values()].slice(-12).map(({ key, draft, mode, windowKind, writingTarget, messages }) => ({ key, draft, mode, windowKind, writingTarget, messages: messages.slice(-60) })))); } catch {} };
  function sessionFor(projectId) {
    const key = projectId || '';
    if (!sessions.has(key)) sessions.set(key, { key, projectId: key || null, draft: '', mode: 'auto', windowKind: 'project', writingTarget: 'draft', messages: [], busy: false });
    return sessions.get(key);
  }
  const live = session => !disposed && root?.isConnected && current === session;
  function add(session, role, content, extra = {}) { const message = { id: uid(), role, content, ...extra }; session.messages.push(message); session.messages = session.messages.slice(-60); remember(); return message; }
  function paintMessages(session) {
    if (!live(session)) return;
    const list = root.querySelector('[data-app-assistant-messages]');
    const scrollTop = list.scrollTop;
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 90;
    list.innerHTML = session.messages.length ? session.messages.map(message => `<article data-assistant-message="${h(message.id)}" data-assistant-run="${h(message.runId || '')}" class="gx-assistant-message ${message.role === 'user' ? 'is-user' : 'is-assistant'} ${message.status === 'error' ? 'is-error' : ''}"><div class="gx-assistant-role">${message.role === 'user' ? '你' : 'AI 助手'}${message.status === 'working' ? '<span>处理中</span>' : message.status === 'error' ? '<span>未完成</span>' : message.status === 'cancelled' ? '<span>已停止</span>' : ''}</div><p>${h(message.content)}</p>${assistantDetails(message)}${message.effects?.some(effect => effect.undo && !effect.undone) ? `<div class="gx-assistant-effect-actions">${message.effects.map((effect, index) => effect.undo && !effect.undone ? `<button class="btn small" data-app-assistant-undo="${h(message.id)}" data-effect-index="${index}" ${session.busy ? 'disabled' : ''}>${icon('undo')}${h(effect.undo.label || '撤销这次修改')}</button>` : effect.undone ? '<span class="tiny muted">已撤销</span>' : '').join('')}</div>` : ''}${message.status === 'error' ? `<button class="btn small" data-app-assistant-retry="${h(message.id)}" ${session.busy ? 'disabled' : ''}>${icon('refresh')}${message.runId && message.retryWatch ? '重新查看进度' : '重试'}</button>` : ''}</article>`).join('') : `<div class="gx-app-assistant-welcome"><span class="gx-app-assistant-mark">${icon('spark')}</span><h3>把想做的事告诉我</h3><p>查资料、写文案，或处理当前项目。</p><div class="gx-app-assistant-examples"><button data-app-assistant-example="联网搜索这个主题的最新资料，并给出来源。">搜索资料</button><button data-app-assistant-example="下载这篇论文，导入当前科普项目">下载并导入论文</button><button data-app-assistant-example="阅读当前项目的材料，梳理核心知识点并解释。">梳理知识点</button><button data-app-assistant-example="根据当前项目的素材，整理一版适合传播的文案。">整理文案</button></div></div>`;
    list.querySelectorAll('[data-app-assistant-example]').forEach(button => button.onclick = () => { session.draft = button.dataset.appAssistantExample; const input = root.querySelector('[data-app-assistant-input]'); input.value = session.draft; input.focus(); update(session); remember(); });
    list.querySelectorAll('[data-app-assistant-retry]').forEach(button => {
      const message = session.messages.find(item => item.id === button.dataset.appAssistantRetry);
      if (message.resumeBlockReason) button.insertAdjacentHTML('beforebegin', `<p class="small muted gx-assistant-resume-state">${h(message.resumeBlockReason)}</p>`);
      button.textContent = message.resumable && message.runId ? '继续完成' : message.runId ? message.retryWatch || !message.runStatus ? '重新查看进度' : '查看任务状态' : '重试';
      button.onclick = () => {
        if (message.resumable && message.runId) void resume(session, message);
        else if (message.runId) void watch(session, message);
        else { session.draft = message.instruction || [...session.messages.slice(0, session.messages.indexOf(message))].reverse().find(item => item.role === 'user')?.content || ''; root.querySelector('[data-app-assistant-input]').value = session.draft; void submit(session); }
      };
    });
    list.querySelectorAll('[data-app-assistant-undo]').forEach(button => button.onclick = () => void undo(session, button.dataset.appAssistantUndo, Number(button.dataset.effectIndex)));
    if (session.focusRunId) {
      const target = [...list.querySelectorAll('[data-assistant-run]')].find(node => node.dataset.assistantRun === session.focusRunId);
      if (target) { target.classList.add('is-focused-run'); target.scrollIntoView({ block: 'center', behavior: 'instant' }); }
    } else if (nearBottom || session.busy) list.scrollTop = list.scrollHeight;
    else list.scrollTop = scrollTop;
    update(session);
  }
  function update(session) {
    if (!live(session)) return;
    root.querySelector('[data-app-assistant-send]').disabled = session.busy || !session.draft.trim();
    root.querySelector('[data-app-assistant-input]').disabled = session.busy;
    root.querySelector('[data-app-assistant-project]').disabled = session.busy;
    root.querySelector('[data-app-assistant-mode]').disabled = session.busy;
    root.querySelector('[data-app-assistant-window]').disabled = session.busy;
    const target = root.querySelector('[data-app-assistant-writing-target]'); if (target) target.disabled = session.busy;
    root.querySelector('[data-app-assistant-new]').disabled = session.busy;
    const stop = root.querySelector('[data-app-assistant-stop]'); stop.hidden = !session.busy; stop.disabled = Boolean(session.stopping); stop.textContent = session.stopping ? '正在停止…' : '停止';
    const status = root.querySelector('[data-app-assistant-status]');
    status.textContent = session.busy ? session.stopping ? '正在停止' : `${session.progressText || '正在处理'} · 关闭窗口后会继续` : session.mode === 'ask' ? '仅问答 · 可联网查资料' : '自动处理 · 按要求修改当前项目';
  }
  function paint(session) {
    if (!root?.isConnected) return;
    current = session;
    const projects = (getProjects?.() || []).filter(project => project?.id);
    const project = projects.find(project => project.id === session.projectId), writing = project?.kind === 'writing' || session.writingAvailable && (!project?.kind || project.kind === 'writing');
    if (!writing) session.windowKind = 'project';
    if (session.writingTarget === 'selection' && !session.writingContext?.selection) session.writingTarget = 'draft';
    root.querySelector('.modal').classList.add('gx-app-assistant-modal');
    root.querySelector('.modal-body').innerHTML = `<section class="gx-app-assistant"><div class="gx-app-assistant-options"><label><span>本次项目</span><select data-app-assistant-project aria-label="助手使用的项目"><option value="">不选项目 · 联网问答</option>${projects.map(project => `<option value="${h(project.id)}" ${project.id === session.projectId ? 'selected' : ''}>${h(project.title)}</option>`).join('')}</select></label><label><span>处理方式</span><select data-app-assistant-mode aria-label="助手处理方式"><option value="auto" ${session.mode === 'auto' ? 'selected' : ''}>自动处理</option><option value="ask" ${session.mode === 'ask' ? 'selected' : ''}>仅问答</option></select></label><button class="icon-btn" type="button" data-app-assistant-new title="清空当前对话" aria-label="清空当前对话">${icon('plus')}</button></div><div class="gx-app-assistant-log" data-app-assistant-messages role="log" aria-live="polite" aria-relevant="additions text"></div><form class="gx-assistant-composer" data-app-assistant-form><label for="gx-app-assistant-input">你的问题或要求</label><textarea id="gx-app-assistant-input" data-app-assistant-input maxlength="12000" rows="3" placeholder="输入要求，或粘贴资料链接">${h(session.draft)}</textarea><div class="gx-assistant-composer-actions"><span>Enter 发送 · Shift+Enter 换行</span><button class="btn small" type="button" data-app-assistant-stop hidden>停止</button><button class="btn small primary" type="submit" data-app-assistant-send>${icon('arrow')}发送</button></div><p class="gx-app-assistant-status" data-app-assistant-status role="status"></p></form></section>`;
    root.querySelector('.gx-app-assistant-options').insertAdjacentHTML('afterbegin', `<label class="gx-app-assistant-window"><span>助手窗口</span><select data-app-assistant-window aria-label="选择助手窗口"><option value="project" ${session.windowKind === 'project' ? 'selected' : ''}>项目助手</option><option value="writing" ${session.windowKind === 'writing' ? 'selected' : ''} ${writing ? '' : 'disabled'}>文案助手</option></select></label>`);
    if (session.windowKind === 'writing') root.querySelector('.gx-app-assistant-options').insertAdjacentHTML('afterend', `<div class="gx-app-assistant-writing"><label><span>参考范围</span><select data-app-assistant-writing-target aria-label="文案助手参考范围"><option value="draft" ${session.writingTarget === 'draft' ? 'selected' : ''}>当前文稿</option><option value="selection" ${session.writingTarget === 'selection' ? 'selected' : ''} ${session.writingContext?.selection ? '' : 'disabled'}>选中文字</option><option value="project" ${session.writingTarget === 'project' ? 'selected' : ''}>当前项目</option></select></label><p>${session.writingContext?.channel ? '当前文稿形式：' + h({ article: '文章', poster: '海报', video: '视频文案', social: '社群文案' }[session.writingContext.channel] || '') + '。' : ''}${session.writingContext?.selection ? '已有正文选区，可在本轮要求中指定只改所选内容。' : '在文稿中选中文字后重新打开，可使用选区。'}范围作为参考，以本轮要求为准。</p></div>`);
    root.querySelector('[data-app-assistant-window]').onchange = event => { session.windowKind = event.target.value === 'writing' && writing ? 'writing' : 'project'; remember(); paint(session); };
    root.querySelector('[data-app-assistant-writing-target]')?.addEventListener('change', event => { session.writingTarget = event.target.value; remember(); update(session); });
    root.querySelector('[data-app-assistant-project]').onchange = event => {
      remember(); const next = sessionFor(event.target.value);
      if (next.projectId !== getProjectId?.()) { next.writingContext = null; next.getWritingContext = null; next.writingTarget = 'draft'; }
      paint(next); recover(next);
    };
    root.querySelector('[data-app-assistant-mode]').onchange = event => { session.mode = event.target.value === 'ask' ? 'ask' : 'auto'; remember(); update(session); };
    root.querySelector('[data-app-assistant-new]').onclick = () => { if (!session.busy) { session.messages = []; remember(); paintMessages(session); } };
    root.querySelector('[data-app-assistant-form]').onsubmit = event => { event.preventDefault(); void submit(session); };
    const input = root.querySelector('[data-app-assistant-input]');
    input.oninput = () => { session.draft = input.value; remember(); update(session); };
    input.onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); void submit(session); } };
    root.querySelector('[data-app-assistant-stop]').onclick = () => void stop(session);
    paintMessages(session); input.focus({ preventScroll: true });
  }
  async function stop(session) {
    if (!session.busy || session.stopping) return;
    session.stopping = true; update(session);
    if (!session.runId) return;
    try { await cancelAssistantRun(session.runId); }
    catch (error) { session.stopping = false; update(session); toast(error.message, 'error'); }
  }
  async function watch(session, reply, initial) {
    if (session.watching || disposed) return;
    session.busy = true; session.watching = true; session.runId = reply.runId; reply.retryWatch = false;
    session.controller = new AbortController(); paintMessages(session);
    try {
      const job = await watchAssistantRun(reply.runId, { initial, signal: session.controller.signal, onConnection: value => { session.progressText = value.message; paintMessages(session); }, onUpdate: value => {
        if ((value.projectId || null) !== session.projectId) throw new Error('此任务属于其他项目，请从任务中心重新打开。');
        if (reply.imported && value.instruction) {
          const index = session.messages.indexOf(reply);
          if (index >= 0 && session.messages[index - 1]?.content !== value.instruction) session.messages.splice(index, 0, { id: uid(), role: 'user', content: value.instruction });
          reply.instruction = value.instruction; reply.imported = false;
        }
        reply.resumable = value.resumable === true; reply.resumeBlockReason = String(value.resumeBlockReason || '').slice(0, 1000); reply.runStatus = value.status;
        applyAssistantJob(reply, value); session.progressText = ['queued', 'running'].includes(value.status) ? assistantProgressText(value) + (value.resumeCount ? ' · 原任务模式：' + (value.mode === 'ask' ? '仅问答' : '自动处理') : '') : '正在同步处理结果'; remember(); paintMessages(session);
      } });
      const writingConflict = session.windowKind === 'writing' && (job.report?.unfinished || []).some(item => /CONFLICT|STALE|WRITING_CONTEXT_CHANGED/.test(item.code || ''));
      if ((job.effects?.some(effect => effect.type !== 'download' && effect.changed !== false) || writingConflict) && session.projectId && !session.removed) await onChanged?.(session.projectId, job.effects || []);
    } catch (error) {
      if (disposed || error.name === 'AbortError') return;
      reply.status = 'error'; reply.retryWatch = true; reply.content = `无法读取进度：${error.message}\n任务可能仍在运行，请重新查看。`;
    } finally { session.busy = false; session.watching = false; session.stopping = false; session.controller = null; session.runId = null; session.progressText = ''; session.focusRunId = null; remember(); paintMessages(session); }
  }
  function recover(session) { const reply = [...session.messages].reverse().find(message => message.status === 'working' && message.runId); if (reply && !session.busy) void watch(session, reply); }
  async function submit(session) {
    const instruction = session.draft.trim(); if (!instruction || session.busy || disposed) return;
    if (session.removed) return;
    if (requireConnection?.() === false) { closeDialog?.(); return; }
    const history = session.messages.filter(message => message.status !== 'working').slice(-12).map(({ role, content }) => ({ role, content }));
    add(session, 'user', instruction); const reply = add(session, 'assistant', '正在理解要求…', { status: 'working', instruction });
    session.draft = ''; session.busy = true; session.stopping = false; paint(session);
    session.operation = new Promise(resolve => { session.finishOperation = resolve; });
    try {
      await beforeStart?.(session.projectId);
      if (session.stopping || session.removed) { reply.status = 'cancelled'; reply.content = '本次请求已停止。'; session.busy = false; session.stopping = false; remember(); paintMessages(session); return; }
      let writingContext;
      if (session.windowKind === 'writing' && session.writingTarget !== 'project') {
        const context = session.getWritingContext ? await session.getWritingContext() : session.writingContext;
        session.writingContext = context || null;
        if (context) { writingContext = { ...context }; if (session.writingTarget !== 'selection') delete writingContext.selection; }
        if (session.writingTarget === 'selection' && !writingContext?.selection) {
          session.writingTarget = 'draft'; session.writingContext = context || null;
          const target = live(session) && root.querySelector('[data-app-assistant-writing-target]'); if (target) target.value = 'draft';
        }
      }
      const response = await startAssistantRun({ ...(session.projectId ? { projectId: session.projectId } : {}), instruction, settings: getSettings?.(), writingPreferences: readWritingPreferences(), ...(writingContext ? { writingContext } : {}), history, mode: session.mode });
      if (!response.runId) throw new Error('未能创建助手任务，请重试。');
      reply.runId = response.runId; session.runId = response.runId; remember();
      if (session.stopping) await cancelAssistantRun(response.runId);
      await watch(session, reply, response.job);
    } catch (error) { reply.status = 'error'; reply.content = error.message; session.busy = false; session.stopping = false; remember(); paintMessages(session); }
    finally { session.finishOperation?.(); session.finishOperation = null; session.operation = null; }
  }
  async function resume(session, reply) {
    if (!reply.runId || !reply.resumable || session.busy || disposed) return;
    if (requireConnection?.() === false) { closeDialog?.(); return; }
    session.busy = true; session.stopping = false; session.runId = reply.runId; reply.status = 'working'; reply.content = '正在按原任务继续…'; paintMessages(session);
    session.operation = new Promise(resolve => { session.finishOperation = resolve; });
    try {
      await beforeStart?.(session.projectId);
      const { resumeAssistantRun } = await import('./assistant-client.js');
      const response = await resumeAssistantRun(reply.runId, { settings: getSettings?.(), writingPreferences: readWritingPreferences() });
      if (response.runId !== reply.runId) throw new Error('恢复返回了不同任务，未替换当前对话。');
      if (session.stopping || session.removed) await cancelAssistantRun(reply.runId);
      session.busy = false;
      await watch(session, reply, response.job);
    } catch (error) { reply.status = 'error'; reply.content = error.message; reply.resumable = false; session.busy = false; session.stopping = false; session.runId = null; remember(); paintMessages(session); }
    finally { session.finishOperation?.(); session.finishOperation = null; session.operation = null; }
  }
  async function undo(session, messageId, index) {
    const message = session.messages.find(item => item.id === messageId), effect = message?.effects?.[index];
    if (!effect?.undo || effect.undone || session.busy || !onUndo) return;
    session.busy = true; update(session);
    try { await onUndo(session.projectId, effect.undo); effect.undone = true; await onChanged?.(session.projectId, [effect]); }
    catch (error) { add(session, 'assistant', error.message, { status: 'error' }); }
    finally { session.busy = false; remember(); paintMessages(session); }
  }
  return {
    open({ projectId = getProjectId?.(), runId, windowKind, writingContext, getWritingContext } = {}) {
      const session = sessionFor(projectId);
      if (windowKind) session.windowKind = windowKind === 'writing' ? 'writing' : 'project';
      if (writingContext !== undefined) session.writingContext = writingContext;
      if (getWritingContext) { session.getWritingContext = getWritingContext; session.writingAvailable = true; }
      else if (writingContext) session.writingAvailable = true;
      let target = runId && session.messages.find(message => message.runId === runId);
      if (runId && !target) target = add(session, 'assistant', '正在读取任务…', { status: 'working', runId, imported: true });
      session.focusRunId = runId || null;
      closeDialog = showModal({ title: 'AI 助手', body: '', wide: true, onClose: () => { root = null; closeDialog = null; }, onMount: value => { root = value; paint(session); if (target && !session.busy) void watch(session, target); else recover(session); } });
    },
    isBusy: id => Boolean(sessions.get(id || '')?.busy),
    async cancelProject(id) { const session = sessions.get(id || ''); if (!session) return; session.removed = true; if (session.busy) { await stop(session); if (session.operation) await session.operation; else if (session.runId) { const message = session.messages.find(item => item.runId === session.runId); if (message) await watchAssistantRun(session.runId, { onUpdate: value => applyAssistantJob(message, value) }); } } sessions.delete(id || ''); remember(); },
    dispose() { disposed = true; closeDialog?.(); for (const session of sessions.values()) session.controller?.abort(); remember(); },
  };
}
