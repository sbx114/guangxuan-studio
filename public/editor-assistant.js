import { api, clone, escapeHtml as h, icon, toast, uid, timecode } from './ui.js';
import { mountEditScope, editScopeSnapshot, contextForEditScope, editPlacementText, selectTimelineRange } from './editor-scope.js';
import { startAssistantRun, cancelAssistantRun, watchAssistantRun, applyAssistantJob, assistantDetails, assistantProgressText } from './assistant-client.js';

const MAX_MESSAGES = 60;
const safeMessage = message => message && ['user', 'assistant'].includes(message.role) && typeof message.content === 'string';
const importedScopeAssetIds = (projectId, effects) => [...new Set((Array.isArray(effects) ? effects : []).filter(effect => effect && effect.projectId === projectId && ['media', 'native', 'project'].includes(effect.type) && effect.changed !== false && !effect.undone && typeof effect.importedAssetId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(effect.importedAssetId)).map(effect => effect.importedAssetId))];

export function mergeImportedAssetScope(projectId, scope, effects) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return scope;
  const next = clone(scope);
  // An absent assetIds field already means all material. Preserve an explicit
  // selection and add only IDs confirmed by this server operation's receipts.
  if (Array.isArray(next.assetIds)) next.assetIds = [...new Set([...next.assetIds, ...importedScopeAssetIds(projectId, effects)])];
  return next;
}

export function assistantContext(context) {
  const ids = new Set((context.timeline || []).map(clip => clip.assetId));
  const assets = [...(context.assets || []).filter(asset => ids.has(asset.id)), ...(context.assets || []).filter(asset => !ids.has(asset.id))].slice(0, 100);
  const available = new Set(assets.map(asset => asset.id));
  const timeline = (context.timeline || []).filter(clip => available.has(clip.assetId)).slice(0, 200);
  const complete = timeline.length === (context.timeline || []).length;
  return {
    assets: assets.map(({ id, name, type, duration, width, height }) => ({ id, name, type, duration, width, height })),
    timeline: timeline.map(({ id, assetId, start, end, at, speed }) => ({ id, assetId, start, end, at, speed: speed || 1 })),
    duration: Number.isFinite(context.duration) ? context.duration : 0,
    mainTrackEditable: Boolean(complete && context.mainTrackEditable),
    aspect: context.aspect || '16:9',
    warnings: [...(context.warnings || []), ...(!complete ? ['主轨内容过多，本次仅支持问答或添加字幕。'] : [])],
  };
}

export function createEditorAssistant({ getSettings, requireConnection, callAi, saveProject, beforeAction, beforeAi, onChanged, onAnimation, onVisibilityChange, onUndo } = {}) {
  let host = null, active = null, visible = true, destroyed = false;
  let scopeControl = null;
  const sessions = new Map(), pendingSaves = new Set();
  const activeRuns = new Map();
  try { for (const [id, value] of JSON.parse(localStorage.getItem('gx-editor-assistant-active-runs') || '[]')) if (id && value?.runId) activeRuns.set(id, value); } catch {}
  const rememberRuns = () => { try { localStorage.setItem('gx-editor-assistant-active-runs', JSON.stringify([...activeRuns])); } catch {} };
  const live = session => !destroyed && host?.isConnected && active === session;

  function getSession(project) {
    project.video ||= { timeline: [], captions: [] };
    project.video.assistantMessages = (Array.isArray(project.video.assistantMessages) ? project.video.assistantMessages : []).filter(safeMessage).slice(-MAX_MESSAGES);
    project.video.assistantDraft = typeof project.video.assistantDraft === 'string' ? project.video.assistantDraft.slice(0, 12000) : '';
    let session = sessions.get(project.id);
    if (session) {
      if (!session.busy && !session.dirty && session.project !== project) session.project = project;
      return session;
    }
    project.video.assistantMessages = (Array.isArray(project.video.assistantMessages) ? project.video.assistantMessages : []).filter(safeMessage).slice(-MAX_MESSAGES);
    project.video.assistantDraft = typeof project.video.assistantDraft === 'string' ? project.video.assistantDraft.slice(0, 12000) : '';
    session = { project, busy: false, applying: false, phase: '', progress: null, controller: null, timer: null, dirty: false, revision: 0, context: null, saveError: false, removed: false, saves: new Set(), operation: null, finishOperation: null };
    sessions.set(project.id, session);
    return session;
  }
  const messages = session => session.project.video.assistantMessages;
  function addMessage(session, role, content, extra = {}) {
    const message = { id: uid(), role, content: String(content).slice(0, role === 'user' ? 12000 : 24000), at: new Date().toISOString(), ...extra };
    messages(session).push(message);
    session.project.video.assistantMessages = messages(session).slice(-MAX_MESSAGES);
    session.dirty = true; session.revision++;
    return message;
  }
  function save(session) {
    if (session.removed) return Promise.resolve(session.project);
    clearTimeout(session.timer); session.timer = null;
    session.dirty = true;
    const revision = ++session.revision;
    const pending = Promise.resolve().then(() => session.removed ? session.project : saveProject(session.project, { assistantOnly: true })).then(result => {
      if (result === null) throw new Error('对话尚未保存，请重试。');
      if (revision === session.revision) session.dirty = false;
      session.saveError = false; updateStatus(session); return result;
    }).catch(error => { session.saveError = true; updateStatus(session); throw error; }).finally(() => { pendingSaves.delete(pending); session.saves.delete(pending); });
    pendingSaves.add(pending); session.saves.add(pending); return pending;
  }
  function schedule(session) {
    if (session.removed) return;
    session.dirty = true; session.revision++;
    clearTimeout(session.timer);
    session.timer = setTimeout(() => { save(session).catch(error => toast(error.message, 'error')); }, 600);
  }
  async function flush() {
    await Promise.all([...pendingSaves]);
    await Promise.all([...sessions.values()].filter(session => session.dirty).map(save));
  }
  function phase(session, value, progress = null) {
    session.phase = value; session.progress = progress;
    updateStatus(session);
  }
  function updateStatus(session) {
    if (!live(session)) return;
    const status = host.querySelector('[data-assistant-status]'), spinner = host.querySelector('[data-assistant-progress]');
    if (status) { status.textContent = session.saveError ? '保存失败 · 重试' : session.busy ? '处理中…' : session.dirty ? '待保存' : '已保存'; status.classList.toggle('is-error', session.saveError); }
    if (spinner) {
      spinner.hidden = !session.busy;
      spinner.innerHTML = `${session.progress == null ? '<span class="spinner"></span>' : `<span class="gx-assistant-meter"><i style="width:${Math.max(0, Math.min(100, session.progress))}%"></i></span>`}<span>${h(session.phase)}</span>`;
    }
    const send = host.querySelector('[data-assistant-send]'), cancel = host.querySelector('[data-assistant-cancel]'), input = host.querySelector('[data-assistant-input]');
    if (send) send.disabled = session.busy || !session.project.video.assistantDraft.trim();
    if (input) input.disabled = session.busy;
    if (cancel) { cancel.hidden = !session.busy; cancel.disabled = session.stopping || session.applying; cancel.title = session.applying ? '正在应用修改，请稍候' : '停止本次请求'; cancel.textContent = session.stopping ? '正在停止…' : '停止'; }
    host.querySelectorAll('[data-assistant-undo]').forEach(button => { button.disabled = session.busy; });
    const mode = host.querySelector('[data-assistant-mode]'); if (mode) mode.disabled = session.busy;
    host.querySelectorAll('[data-assistant-run-resume],[data-assistant-effect-undo]').forEach(button => { button.disabled = session.busy; });
    scopeControl?.setDisabled(session.busy);
  }
  function renderMessages(session) {
    if (!live(session)) return;
    const list = host.querySelector('[data-assistant-messages]');
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 90;
    list.innerHTML = messages(session).length ? messages(session).map(message => `<article class="gx-assistant-message ${message.role === 'user' ? 'is-user' : 'is-assistant'} ${message.status === 'error' ? 'is-error' : ''}"><div class="gx-assistant-role">${message.role === 'user' ? '你' : 'AI 助手'}${message.status === 'working' ? '<span>处理中</span>' : message.status === 'error' ? '<span>未完成</span>' : message.status === 'cancelled' ? '<span>已取消</span>' : ''}</div><p>${h(message.content)}</p>${assistantDetails(message)}${message.effects?.some(effect => effect.undo && !effect.undone) ? `<div class="gx-assistant-effect-actions">${message.effects.map((effect, index) => effect.undo && !effect.undone ? `<button class="btn small" data-assistant-effect-undo="${h(message.id)}" data-effect-index="${index}">${icon('undo')}${h(effect.undo.label || '撤销这次修改')}</button>` : effect.undone ? '<span class="tiny muted">已撤销</span>' : '').join('')}</div>` : ''}${message.status === 'error' && !message.jobId ? `<button class="btn small" data-assistant-run-resume="${h(message.id)}">${icon('refresh')}${message.retryWatch ? '重新查看进度' : '重试'}</button>` : ''}${message.result ? `<div class="gx-assistant-result">${icon('check')}<span>${h(message.result)}</span></div>` : ''}${message.undo && !message.undone ? `<button class="btn small" data-assistant-undo="${h(message.id)}">${icon('undo')}撤销操作</button>` : message.undone ? '<span class="tiny muted">已撤销</span>' : ''}${message.jobId && message.status === 'error' && !(session.project.video.assistantJob?.messageId === message.id && session.project.video.assistantJob?.status === 'cancelled') ? `<button class="btn small" data-assistant-resume="${h(message.id)}">${icon('refresh')}查看动画进度</button>` : ''}</article>`).join('') : `<div class="gx-assistant-welcome"><div class="gx-assistant-examples"><button type="button" data-assistant-example="根据当前素材和时间线给出剪辑建议。">剪辑建议</button><button type="button" data-assistant-example="读取当前工程，帮我修剪和调整片段位置，保留未要求改变的内容。">精确调整片段</button><button type="button" data-assistant-example="把当前工程片段的音量调到70%，并加0.3秒淡入淡出。">调整声音</button><button type="button" data-assistant-example="根据当前项目文案添加标题和字幕。">添加字幕</button><button type="button" data-assistant-example="按当前主题制作Remotion动画，先预览检查，再渲染加入时间线。">自由动画</button></div><p class="gx-assistant-capabilities">直接描述剪辑、字幕或动画要求。默认处理当前工程，可指定范围；修改可撤销。</p></div>`;
    list.querySelectorAll('[data-assistant-example]').forEach(button => button.onclick = () => {
      session.project.video.assistantDraft = button.dataset.assistantExample;
      host.querySelector('[data-assistant-input]').value = session.project.video.assistantDraft;
      schedule(session); updateStatus(session); host.querySelector('[data-assistant-input]').focus();
    });
    list.querySelectorAll('[data-assistant-undo]').forEach(button => button.onclick = () => undo(session, button.dataset.assistantUndo));
    list.querySelectorAll('[data-assistant-run-resume]').forEach(button => button.onclick = () => { const reply = messages(session).find(item => item.id === button.dataset.assistantRunResume); if (reply) { if (reply.retryWatch) void resumeRun(session, reply); else { session.project.video.assistantDraft = reply.instruction || [...messages(session).slice(0, messages(session).indexOf(reply))].reverse().find(item => item.role === 'user')?.content || ''; void submit(session); } } });
    list.querySelectorAll('[data-assistant-effect-undo]').forEach(button => button.onclick = () => void undoEffect(session, button.dataset.assistantEffectUndo, Number(button.dataset.effectIndex)));
    list.querySelectorAll('[data-assistant-resume]').forEach(button => button.onclick = () => resume(session, button.dataset.assistantResume));
    if (nearBottom || session.busy) list.scrollTop = list.scrollHeight;
    updateStatus(session);
  }
  function paint(session) {
    if (!host || destroyed) return;
    scopeControl?.dispose(); scopeControl = null;
    host.hidden = !visible;
    host.innerHTML = `<aside class="gx-editor-assistant" aria-label="剪辑AI对话"><header class="gx-assistant-header"><div><strong>${icon('spark')}AI 助手</strong><button class="gx-assistant-status" data-assistant-status>已保存</button></div><button class="icon-btn" data-assistant-close aria-label="收起AI对话" title="收起AI对话">${icon('close')}</button></header><div class="gx-assistant-messages" data-assistant-messages role="log" aria-live="polite" aria-relevant="additions text"></div><div class="gx-assistant-progress" data-assistant-progress role="status" hidden></div><div class="gx-assistant-scope" data-assistant-scope></div><form class="gx-assistant-composer" data-assistant-form><div class="gx-assistant-mode"><span>当前项目 · 可联网</span><select data-assistant-mode aria-label="助手处理方式"><option value="auto" ${session.project.video.assistantMode !== 'ask' ? 'selected' : ''}>自动处理</option><option value="ask" ${session.project.video.assistantMode === 'ask' ? 'selected' : ''}>仅问答</option></select></div><label class="tiny muted" for="gx-assistant-input">剪辑要求</label><textarea id="gx-assistant-input" data-assistant-input rows="3" maxlength="12000" placeholder="输入剪辑要求">${h(session.project.video.assistantDraft)}</textarea><div class="gx-assistant-composer-actions"><span title="Shift+Enter 换行">Enter 发送</span><button class="btn small" type="button" data-assistant-cancel hidden>停止</button><button class="btn small primary" type="submit" data-assistant-send>${icon('arrow')}发送</button></div></form></aside>`;
    scopeControl = mountEditScope(host.querySelector('[data-assistant-scope]'), session.project, {
      disabled: session.busy,
      loadContext: () => currentContext(session),
      onChange: () => { schedule(session); updateStatus(session); },
    });
    if (session.context) scopeControl.setContext(session.context);
    host.querySelector('[data-assistant-close]').onclick = () => setVisible(false);
    host.querySelector('[data-assistant-status]').onclick = () => { if (session.saveError) save(session).catch(error => toast(error.message, 'error')); };
    host.querySelector('[data-assistant-form]').onsubmit = event => { event.preventDefault(); void submit(session); };
    const input = host.querySelector('[data-assistant-input]');
    input.oninput = () => { session.project.video.assistantDraft = input.value; schedule(session); updateStatus(session); };
    input.onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); void submit(session); } };
    host.querySelector('[data-assistant-cancel]').onclick = () => { if (session.runId || session.agentStarting) void stopRun(session); else if (!session.applying) session.controller?.abort(); };
    host.querySelector('[data-assistant-mode]').onchange = event => { session.project.video.assistantMode = event.target.value === 'ask' ? 'ask' : 'auto'; schedule(session); };
    renderMessages(session);
  }
  const checkCancelled = session => { if (destroyed || session.removed || session.controller?.signal.aborted) throw new DOMException('请求已停止', 'AbortError'); };
  function startOperation(session) {
    session.operation = new Promise(resolve => { session.finishOperation = resolve; });
  }
  function endOperation(session) {
    const done = session.finishOperation;
    session.finishOperation = null; session.operation = null; done?.();
  }
  async function currentContext(session) {
    await beforeAction?.(session.project.id);
    checkCancelled(session);
    const context = await api(`/api/openfilm/context?projectId=${encodeURIComponent(session.project.id)}`, undefined, { signal: session.controller?.signal });
    checkCancelled(session);
    if (context.projectId !== session.project.id || typeof context.revision !== 'string') throw new Error('未读到当前项目的时间线，请重新打开项目。');
    session.context = context; return context;
  }
  async function changed(session) { await onChanged?.(session.project.id); }
  function releaseRangeBinding(project, scope) {
    const stored = project.video?.editScope?.placement;
    if (scope?.placement?.mode === 'range' && stored?.mode === 'range' && stored.start === scope.placement.start && stored.end === scope.placement.end) delete stored.clipIds;
  }
  function recordRun(session, response) {
    const project = session.project;
    project.runs ||= [];
    project.runs.unshift({ id: uid(), at: new Date().toISOString(), task: 'edit-assistant', meta: clone(response.meta || {}), action: response.data.action });
    project.runs = project.runs.slice(0, 60);
  }
  async function submit(session) {
    const instruction = session.project.video.assistantDraft.trim();
    if (!instruction || session.busy || destroyed || session.removed) return;
    if (/^(?:撤销|撤回|undo)(?:刚才|刚刚|上次|上一次|最后|这次|这一次)?(?:的)?(?:AI)?(?:操作|剪辑|修改)?[。.!！]?$/i.test(instruction)) {
      const previous = [...messages(session)].reverse().find(message => message.undo && !message.undone || message.effects?.some(effect => effect.undo && !effect.undone));
      addMessage(session, 'user', instruction); session.project.video.assistantDraft = '';
      if (previous) { if (live(session)) paint(session); const effectIndex = previous.effects?.findLastIndex(effect => effect.undo && !effect.undone) ?? -1; if (effectIndex >= 0) await undoEffect(session, previous.id, effectIndex); else await undo(session, previous.id); }
      else { addMessage(session, 'assistant', '当前对话没有可以撤销的AI操作。', { status: 'complete' }); await save(session).catch(error => toast(error.message, 'error')); if (live(session)) paint(session); }
      return;
    }
    if (requireConnection?.() === false) return;
    const history = messages(session).filter(message => message.status !== 'working').slice(-12).map(({ role, content, result }) => ({ role, content: `${content}${result ? `\n执行结果：${result}` : ''}` }));
    addMessage(session, 'user', instruction);
    const reply = addMessage(session, 'assistant', '正在读取当前项目…', { status: 'working', instruction });
    session.project.video.assistantDraft = '';
    session.busy = true; session.agentStarting = true; session.stopping = false; session.controller = new AbortController();
    startOperation(session);
    phase(session, '读取当前项目'); if (live(session)) paint(session);
    try {
      await save(session);
      const context = await currentContext(session);
      const editScope = editScopeSnapshot(session.project, context); session.requestScope = clone(editScope);
      phase(session, '正在理解要求');
      await beforeAi?.(session.project.id, { signal: session.controller.signal }); checkCancelled(session);
      if (session.stopping) throw new DOMException('请求已停止', 'AbortError');
      session.agentStarting = true;
      const response = await startAssistantRun({ projectId: session.project.id, instruction, history, settings: getSettings?.(), editScope, mode: session.project.video.assistantMode === 'ask' ? 'ask' : 'auto' });
      session.agentStarting = false;
      if (!response.runId) throw new Error('未能创建助手任务，请重试。');
      reply.runId = response.runId; session.runId = response.runId;
      activeRuns.set(session.project.id, { runId: response.runId, messageId: reply.id, instruction }); rememberRuns();
      if (session.stopping) await cancelAssistantRun(response.runId);
      await watchRun(session, reply, response.job);
      await refreshProject(session);
      await save(session);
      await changed(session);
    } catch (error) {
      reply.status = error.name === 'AbortError' ? 'cancelled' : 'error';
      if (reply.runId && !['failed','interrupted'].includes(reply.runStatus)) reply.retryWatch = true;
      if (error.name === 'AbortError') reply.content = reply.jobId ? '已停止查看，动画仍在渲染，可稍后查看进度。' : '本次请求已停止。';
      else reply.content = `${reply.content.startsWith('正在读取') ? '' : `${reply.content}\n\n`}${error.message}`;
      if (reply.jobId && session.project.video.assistantJob?.messageId === reply.id) session.project.video.assistantJob.awaitingResume = true;
      await refreshProject(session).catch(() => {});
      await save(session).catch(() => {});
    } finally { session.agentStarting = false; session.stopping = false; session.runId = null; session.applying = false; session.busy = false; session.controller = null; phase(session, ''); renderMessages(session); endOperation(session); }
  }

  async function refreshProject(session) {
    if (session.removed) return;
    const result = await api(`/api/projects/${encodeURIComponent(session.project.id)}`);
    if (!result.project) throw new Error('项目暂时无法刷新，请重新打开。');
    const savedMessages = messages(session), video = session.project.video;
    const local = { assistantMessages: savedMessages, assistantDraft: video.assistantDraft, assistantMode: video.assistantMode, editScope: video.editScope };
    for (const key of Object.keys(session.project)) delete session.project[key];
    Object.assign(session.project, result.project);
    session.project.video = { ...(session.project.video || {}), ...local };
  }
  async function watchRun(session, reply, initial) {
    const job = await watchAssistantRun(reply.runId, { initial, signal: session.controller?.signal, onUpdate: value => {
      if ((value.id || value.runId) !== reply.runId || value.projectId !== session.project.id) throw new Error('此任务不属于当前项目或本次请求，请重新查看任务。');
      applyAssistantJob(reply, value);
      const applied = new Set(reply.scopeImportedAssetIds || []);
      const newlyImported = importedScopeAssetIds(session.project.id, value.effects).filter(id => !applied.has(id));
      if (newlyImported.length) {
        const fresh = new Set(newlyImported);
        session.project.video.editScope = mergeImportedAssetScope(session.project.id, session.project.video.editScope, value.effects.filter(effect => fresh.has(effect.importedAssetId)));
        reply.scopeImportedAssetIds = [...applied, ...newlyImported];
        session.context = null; scopeControl?.setContext(null);
      }
      phase(session, [assistantProgressText(value), value.steps?.at(-1)?.label].filter(Boolean).join(' · ')); renderMessages(session);
    } });
    activeRuns.delete(session.project.id); rememberRuns();
    if (job.effects?.some(effect => !effect.importedAssetId && (effect.type === 'native' || effect.type === 'video' || effect.kind === 'native'))) releaseRangeBinding(session.project, session.requestScope);
    return job;
  }
  async function stopRun(session) {
    if (!session.busy || session.stopping) return;
    session.stopping = true; phase(session, '正在停止本次处理');
    if (!session.runId) return;
    try { await cancelAssistantRun(session.runId); }
    catch (error) { session.stopping = false; updateStatus(session); toast(error.message, 'error'); }
  }
  async function resumeRun(session, reply) {
    if (session.busy || !reply?.runId || session.removed || destroyed) return;
    session.busy = true; session.runId = reply.runId; session.controller = new AbortController(); reply.status = 'working';
    startOperation(session); renderMessages(session);
    try { await watchRun(session, reply); await refreshProject(session); await save(session); await changed(session); }
    catch (error) { reply.status = 'error'; reply.content = error.message; }
    finally { session.busy = false; session.stopping = false; session.runId = null; session.controller = null; phase(session, ''); renderMessages(session); endOperation(session); }
  }
  async function undoEffect(session, messageId, index) {
    const message = messages(session).find(item => item.id === messageId), effect = message?.effects?.[index];
    if (!effect?.undo || effect.undone || session.busy || !onUndo) return;
    session.busy = true; phase(session, '正在撤销'); startOperation(session);
    try { await beforeAction?.(session.project.id); await onUndo(session.project.id, effect.undo); effect.undone = true; await refreshProject(session); await save(session); await changed(session); }
    catch (error) { addMessage(session, 'assistant', error.message, { status: 'error' }); }
    finally { session.busy = false; phase(session, ''); renderMessages(session); endOperation(session); }
  }
  function waitForJob(session, milliseconds = 1400) {
    const signal = session.controller.signal;
    return new Promise((resolve, reject) => {
      const finish = () => { signal.removeEventListener('abort', stop); resolve(); };
      const timer = setTimeout(finish, milliseconds);
      const stop = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); reject(new DOMException('请求已停止', 'AbortError')); };
      if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
    });
  }
  function animationCancelled(task, reply) {
    task.status = 'cancelled'; task.awaitingResume = false;
    reply.status = 'cancelled'; reply.content = '动画渲染已取消，可重新发送要求。';
    delete reply.jobId;
  }
  async function watchAnimation(session, reply) {
    const project = session.project, task = project.video.assistantJob;
    if (!task || task.messageId !== reply.id) throw new Error('此动画任务已由后续操作替换。');
    let failures = 0, job;
    while (!destroyed) {
      checkCancelled(session);
      try { job = await api(`/api/video/jobs/${encodeURIComponent(task.jobId)}`, undefined, { signal: session.controller.signal }); failures = 0; }
      catch (error) { if (error.name === 'AbortError' || ++failures >= 3) throw error; phase(session, '暂未读到渲染进度，正在重试'); await waitForJob(session, 2000); continue; }
      if (job.status === 'cancelled') { animationCancelled(task, reply); return; }
      if (job.status === 'error') { task.status = 'error'; throw new Error(job.error || '动画未能渲染完成。'); }
      if (job.status === 'complete') break;
      phase(session, job.status === 'cancelling' ? '正在取消动画渲染' : `正在渲染动画 ${Math.round((Number(job.progress) || 0) * 100)}%`, (Number(job.progress) || 0) * 100);
      await waitForJob(session);
    }
    checkCancelled(session);
    if (!job?.asset?.id) throw new Error('动画素材未能读取，请重试。');
    phase(session, '动画完成，正在加入时间线');
    const context = await currentContext(session);
    checkCancelled(session);
    session.applying = true; updateStatus(session);
    const imported = await api('/api/openfilm/import-asset', { projectId: project.id, assetId: job.asset.id, keepUndo: true, expectedRevision: context.revision, requestId: task.requestId, ...(task.editScope ? { editScope: clone(task.editScope) } : {}) });
    session.applying = false;
    if (!imported.appended) throw new Error('动画已完成，尚未加入时间线。');
    task.status = 'complete';
    releaseRangeBinding(project, task.editScope);
    project.video.openfilmAnimationJob = { ...clone(job), jobId: task.jobId, appended: true, ...(task.editScope ? { editScope: clone(task.editScope) } : {}) };
    reply.status = 'complete'; reply.undo = imported.undo;
    reply.result = `已生成“${task.title}” · ${editPlacementText(task.editScope)}${job.duration ? ` · ${timecode(job.duration)}` : ''}`;
    await changed(session);
  }
  async function resume(session, messageId) {
    if (session.busy || destroyed || session.removed) return;
    const reply = messages(session).find(message => message.id === messageId);
    if (!reply?.jobId) return;
    const task = session.project.video.assistantJob;
    if (task?.messageId === reply.id && task.status === 'cancelled') { animationCancelled(task, reply); await save(session).catch(() => {}); renderMessages(session); return; }
    if (session.project.video.assistantJob?.messageId === reply.id) session.project.video.assistantJob.awaitingResume = false;
    session.busy = true; session.controller = new AbortController(); reply.status = 'working';
    startOperation(session);
    phase(session, '读取已有动画任务'); renderMessages(session);
    try { await watchAnimation(session, reply); await save(session); }
    catch (error) { reply.status = 'error'; reply.content = error.name === 'AbortError' ? '已停止等待，可以稍后继续查看。' : error.message; if (session.project.video.assistantJob?.messageId === reply.id) session.project.video.assistantJob.awaitingResume = true; await save(session).catch(() => {}); }
    finally { session.busy = false; session.applying = false; session.controller = null; phase(session, ''); renderMessages(session); endOperation(session); }
  }
  async function undo(session, messageId) {
    if (session.busy || destroyed || session.removed) return;
    const message = messages(session).find(item => item.id === messageId);
    if (!message?.undo?.id || message.undone) return;
    session.busy = true; session.applying = true; session.controller = new AbortController(); phase(session, '正在撤销');
    startOperation(session);
    try {
      await beforeAction?.(session.project.id);
      const result = await api('/api/openfilm/assistant-undo', { projectId: session.project.id, undoId: message.undo.id });
      if (!result.restored) throw new Error('尚未恢复到操作前的工程。');
      message.undone = true;
      addMessage(session, 'assistant', '已撤销，恢复到修改前的剪辑。', { status: 'complete' });
      await changed(session); await save(session);
    } catch (error) { addMessage(session, 'assistant', error.message, { status: 'error' }); await save(session).catch(() => {}); }
    finally { session.busy = false; session.applying = false; session.controller = null; phase(session, ''); renderMessages(session); endOperation(session); }
  }
  function setVisible(next) {
    visible = Boolean(next); if (host) host.hidden = !visible;
    onVisibilityChange?.(visible);
    if (visible && active) { renderMessages(active); host?.querySelector('[data-assistant-input]')?.focus(); }
  }
  async function removeProject(id) {
    const session = sessions.get(id);
    if (!session) return;
    if (session.applying) throw new Error('正在修改项目，请完成或停止后再移除存档。');
    session.removed = true; session.dirty = false;
    clearTimeout(session.timer); session.timer = null;
    if (session.runId) await cancelAssistantRun(session.runId);
    session.controller?.abort();
    await session.operation;
    await Promise.allSettled([...session.saves]);
    if (sessions.get(id) === session) sessions.delete(id);
    if (active === session) { active = null; scopeControl?.dispose(); scopeControl = null; if (host) host.innerHTML = ''; }
  }
  return {
    updateProject(project) {
      const session = sessions.get(project?.id);
      if (!session || session.busy || session.dirty) return false;
      getSession(project); if (active === session) paint(session); return true;
    },
    selectRange(selection) {
      if (!active || active.removed || destroyed) return false;
      if (active.busy) { toast('请先完成或停止当前操作，再更换区间。'); return false; }
      try {
        selectTimelineRange(active.project, selection); schedule(active);
        if (live(active)) paint(active);
        setVisible(true); host?.querySelector('[data-assistant-input]')?.focus({ preventScroll: true });
        return true;
      } catch (error) { toast(error.message, 'error'); return false; }
    },
    mount(container, project) {
      host = container; active = getSession(project); paint(active);
      const running = activeRuns.get(project.id);
      if (running && !active.busy) { let reply = messages(active).find(message => message.id === running.messageId); if (!reply) reply = addMessage(active, 'assistant', '正在读取任务…', { status: 'working', runId: running.runId }); reply.runId = running.runId; void resumeRun(active, reply); return; }
      const task = active.project.video.assistantJob;
      if (!active.busy && task?.status === 'rendering' && !task.awaitingResume) { const message = messages(active).find(item => item.id === task.messageId); if (message) void resume(active, message.id); }
      else if (!active.busy && messages(active).some(message => message.status === 'working')) {
        for (const message of messages(active)) if (message.status === 'working') { message.status = 'error'; message.content = '上次请求已中断，请检查时间线后重试。'; }
        schedule(active); renderMessages(active);
      }
    },
    setVisible,
    flush,
    removeProject,
    cancelProject: removeProject,
    isBusy: id => Boolean(sessions.get(id)?.busy),
    dispose() { destroyed = true; scopeControl?.dispose(); scopeControl = null; for (const session of sessions.values()) { clearTimeout(session.timer); session.controller?.abort(); } host = null; active = null; },
  };
}
