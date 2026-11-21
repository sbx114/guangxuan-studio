import { mountRemotionWorkspace } from './remotion-workspace.js';
import { api, showModal, toast, escapeHtml, icon, clone, uid, timecode, safeName } from './ui.js';
import { mountEditScope, readEditScope, editScopeSnapshot, contextForEditScope, editPlacementText } from './editor-scope.js';

const h = escapeHtml;
const clamp = (value, low, high) => Math.min(high, Math.max(low, Number(value) || 0));
const round = value => Math.round(Number(value) * 1000) / 1000;
const sceneNames = { title: '标题', steps: '步骤', bars: '图表', quote: '重点', outro: '结尾' };
const animationFinished = status => ['complete', 'error', 'cancelled'].includes(status);
const plannedSeconds = (plan, context) => {
  const clips = new Map((context?.timeline || []).map(clip => [clip.id, clip]));
  return (plan?.timeline || []).reduce((total, clip) => total + (clip.end - clip.start) / Number(clips.get(clip.clipId)?.speed || 1), 0);
};
function releaseRangeBinding(project, scope) {
  const stored = project.video?.editScope?.placement;
  if (scope?.placement?.mode === 'range' && stored?.mode === 'range' && stored.start === scope.placement.start && stored.end === scope.placement.end) delete stored.clipIds;
}

export function createOpenfilmActions({ getSettings, requireConnection, callAi, saveProject, beforeAi, beforeAction, onChanged }) {
  let activeDialog = null;
  let disposed = false;
  const jobs = new Map();
  const aiBusy = new Set();
  const removedProjects = new Set();

  function video(project) {
    project.video ||= {};
    project.video.script ||= '';
    project.runs ||= [];
    project.history ||= [];
    return project.video;
  }
  function log(project, label) {
    project.history ||= [];
    project.history.unshift({ id: uid(), at: new Date().toISOString(), type: 'openfilm', label });
    project.history = project.history.slice(0, 100);
  }
  async function persist(project, label) { if (removedProjects.has(project.id)) return; if (label) log(project, label); await saveProject(project); }
  async function recordAi(project, task, result, label) {
    video(project);
    project.runs.unshift({ id: uid(), at: new Date().toISOString(), task, meta: clone(result.meta || {}), prompt: clone(result.prompt || {}), result: clone(result.data) });
    project.runs = project.runs.slice(0, 60);
    await persist(project, label);
  }
  async function changed(projectId) {
    if (removedProjects.has(projectId)) return;
    try { await onChanged?.(projectId); }
    catch { toast('工程已更新，项目信息未刷新。'); }
  }
  function openDialog(options) {
    activeDialog?.close();
    const cleaners = [];
    let panel = null, closed = false, nativeClose = null;
    const clean = () => { if (closed) return; closed = true; cleaners.splice(0).forEach(fn => fn()); if (activeDialog?.panel === panel) activeDialog = null; };
    const close = () => { if (panel?.isConnected && nativeClose) nativeClose(); else clean(); };
    nativeClose = showModal({ ...options, onClose: clean, onMount: (root, closeModal) => {
      nativeClose = closeModal;
      panel = root.querySelector('.modal');
      options.onMount?.({ panel, close, alive: () => !closed && Boolean(panel?.isConnected), cleanup: fn => cleaners.push(fn) });
    } });
    activeDialog = { panel, close };
    return close;
  }
  function requireAi(close) {
    const settings = getSettings?.() || {};
    if (!settings.baseUrl || !settings.model || !settings.apiKey) { close(); requireConnection(); return false; }
    if (requireConnection() === false) { close(); return false; }
    return true;
  }
  const readContext = async project => { await beforeAction?.(project.id); return api(`/api/openfilm/context?projectId=${encodeURIComponent(project.id)}`); };
  function showError(panel, selector, error) {
    if (!panel?.isConnected) return;
    const box = panel.querySelector(selector); if (!box) return;
    box.textContent = error?.message || String(error); box.classList.remove('hidden');
  }

  function watchAnimation(project, initial) {
    const key = `${project.id}:${initial.jobId}`;
    const existing = jobs.get(key);
    if (existing) { if (existing.readError && !existing.running) existing.retry(); return existing; }
    const state = { project, job: clone(initial), editScope: initial.editScope ? clone(initial.editScope) : null, listeners: new Set(), running: false, readError: null, controller: null, timer: null, wake: null, stopped: false };
    jobs.set(key, state);
    function notify() { for (const listener of state.listeners) { try { listener(state); } catch { /* A closed dialog does not affect the job. */ } } }
    function stop() { state.stopped = true; state.controller?.abort(); clearTimeout(state.timer); state.wake?.(); state.listeners.clear(); }
    state.stop = stop;
    state.retry = () => { state.readError = null; run(); };
    async function run() {
      if (state.running || state.stopped || animationFinished(state.job.status)) return;
      state.running = true; state.readError = null; let failures = 0;
      try {
        while (!disposed && !state.stopped) {
          try {
            state.controller = new AbortController();
            const next = await api(`/api/video/jobs/${encodeURIComponent(state.job.jobId)}`, undefined, { signal: state.controller.signal });
            if (state.stopped || disposed) return;
            state.job = { ...state.job, ...next }; state.readError = null; failures = 0;
            if (state.editScope) state.job.editScope = clone(state.editScope); else delete state.job.editScope;
            video(project).openfilmAnimationJob = clone(state.job);
            notify();
            if (animationFinished(next.status)) {
              await persist(project, next.status === 'complete' ? '动画渲染完成' : next.status === 'cancelled' ? '动画渲染已取消' : '动画渲染未完成').catch(error => { toast(`渲染状态已返回，项目记录保存失败：${error.message}`, 'error'); });
              if (next.status === 'complete') toast(`“${state.job.title || project.title}”动画已生成，可加入项目。`);
              break;
            }
          } catch (error) {
            if (state.stopped || disposed || error.name === 'AbortError') return;
            failures++;
            if (error.code === 'VIDEO_JOB_NOT_FOUND') {
              state.job = { ...state.job, status: 'error', error: '未找到已有渲染任务，可以重新渲染当前方案。' };
              project.video.openfilmAnimationJob = clone(state.job); await persist(project).catch(() => {}); notify(); break;
            }
            if (failures >= 3) { state.readError = error.message; notify(); break; }
          }
          await new Promise(resolve => { state.wake = resolve; state.timer = setTimeout(resolve, failures ? 2200 : 1300); }); state.wake = null;
        }
      } finally { state.running = false; state.controller = null; clearTimeout(state.timer); }
    }
    state.run = run;
    run();
    return state;
  }
  function animationJobMarkup(state) {
    const job = state?.job; if (!job) return '';
    if (state.readError) return `<div class="job-box"><strong>暂未读到最新进度</strong><p class="small muted">${h(state.readError)}</p><button class="btn small" data-requery-job>刷新进度</button></div>`;
    const done = job.status === 'complete', cancelled = job.status === 'cancelled', failed = job.status === 'error' || cancelled, progress = Math.round(clamp(job.progress, 0, 1) * 100);
    return `<div class="job-box"><div class="row spread"><strong>${done ? '动画已生成' : cancelled ? '渲染已取消' : failed ? '渲染未完成' : job.status === 'queued' ? '等待渲染' : '正在渲染'}</strong><span class="mono">${failed ? '' : `${progress}%`}</span></div>${failed ? `<p class="small">${h(cancelled ? '可以继续修改场景，或重新渲染当前方案。' : job.error || '渲染失败，请重试。')}</p>` : `<div class="progress-bar"><div class="progress-fill" style="width:${progress}%"></div></div><p class="small muted" style="margin-top:12px">${done ? `${job.width || ''} × ${job.height || ''}${job.duration ? ` · ${timecode(job.duration)}` : ''} · MP4` : '关闭弹窗后仍会继续渲染。'}</p>`}${done ? '<div class="row wrap"><button class="btn olive small" data-append-animation>加入项目</button><button class="btn small" data-download-animation>保存 MP4</button></div>' : failed ? '<button class="btn small" data-retry-render>重新渲染当前方案</button>' : ''}</div>`;
  }
  async function downloadAnimation(job) {
    if (job?.status !== 'complete' || !job.exportId) throw new Error('动画尚未生成完成。');
    if (window.desktopApi?.saveExport) { const result = await window.desktopApi.saveExport({ exportId: job.exportId, name: `${safeName(job.title || '光宣动画')}.mp4` }); if (!result?.canceled) toast('MP4 已保存'); return; }
    const anchor = document.createElement('a'); anchor.href = job.downloadUrl || `/api/video/exports/${encodeURIComponent(job.exportId)}/file`; anchor.download = `${safeName(job.title || '光宣动画')}.mp4`; anchor.click();
  }

  function showRoughCut(project) {
    video(project);
    const busyKey = `${project.id}:edit-plan`;
    if (aiBusy.has(busyKey)) { toast('正在生成粗剪建议，完成后会自动保存。'); return; }
    let context = null, plan = null, generationContext = null, generationScope = null, scopeControl = null, pending = false, applying = false;
    const concretePlacement = () => generationScope?.placement.mode === 'free' ? plan?.placement : generationScope?.placement;
    const canApplyPlacement = () => generationScope?.placement.mode !== 'free' || ['append', 'insert', 'replace', 'range'].includes(plan?.placement?.mode);
    const supportsComplexTrack = () => generationScope?.placement.mode === 'free' ? ['append', 'insert', 'range'].includes(plan?.placement?.mode) : generationScope?.placement.mode === 'range';
    openDialog({ title: 'AI 粗剪', wide: true, body: `<p class="small muted">根据素材和参考画面编排，不分析参考语音。</p><div data-context-info class="notice">正在读取项目…</div><div class="form-field"><label>剪辑要求</label><textarea data-cut-instruction rows="3" maxlength="6000" placeholder="描述剪辑要求">${h(project.video.openfilmCutInstruction || '')}</textarea></div><div class="form-grid"><div class="form-field"><label>目标时长 / 秒</label><input type="number" data-cut-duration min="5" max="3600" value="30"></div><div class="form-field"><label>旁白脚本</label><textarea data-cut-script rows="3" maxlength="30000" placeholder="粘贴旁白脚本（可选）">${h(project.video.script)}</textarea></div></div><div class="row wrap"><button class="btn primary" data-generate-cut disabled>${icon('spark')} 生成粗剪建议</button><button class="btn" data-refresh-context>${icon('refresh')} 重新读取工程</button></div><div data-cut-result style="margin-top:18px"></div><div data-cut-error class="notice error hidden"></div><div class="modal-actions"><button class="btn" data-close-cut>关闭</button><button class="btn olive" data-apply-cut disabled>应用到时间线</button></div>`, onMount: ({ panel, close, alive, cleanup }) => {
      const updateButtons = () => {
        if (!alive()) return;
        const assets = contextForEditScope(context || {}, readEditScope(project)).assets?.filter(asset => ['video', 'image'].includes(asset.type)) || [];
        panel.querySelector('[data-generate-cut]').disabled = pending || applying || aiBusy.has(busyKey) || !assets.length;
        panel.querySelector('[data-apply-cut]').disabled = !plan || pending || applying || !generationContext || !canApplyPlacement() || (generationContext.mainTrackEditable === false && !supportsComplexTrack());
        const fixed = readEditScope(project).placement, durationInput = panel.querySelector('[data-cut-duration]');
        durationInput.min = fixed.mode === 'range' ? '0.001' : '5';
        durationInput.disabled = pending || applying || fixed.mode === 'range';
        if (fixed.mode === 'range' && Number.isFinite(fixed.start) && Number.isFinite(fixed.end) && fixed.end > fixed.start) durationInput.value = String(round(fixed.end - fixed.start));
        panel.querySelector('[data-refresh-context]').disabled = pending || applying;
        scopeControl?.setDisabled(pending || applying);
      };
      const displayContext = () => {
        if (!alive()) return;
        const box = panel.querySelector('[data-context-info]');
        const warnings = context?.warnings || [];
        box.innerHTML = context ? `<span>${context.assets.filter(asset => asset.type !== 'audio').length} 个画面素材 · ${context.timeline.length} 个主轨片段 · ${Number.isFinite(context.duration) ? timecode(context.duration) : '时长待计算'}${warnings.length ? `<br>${warnings.map(h).join('<br>')}` : ''}${context.mainTrackEditable === false ? '<br>主轨有复杂片段，可选择支持的区间编辑，其余内容保留。' : ''}${!context.assets.some(asset => asset.type !== 'audio') ? '<br>请先导入视频或图片，也可生成动画。<br><button class="btn small" data-create-animation style="margin-top:10px">先做 AI 动画</button>' : ''}</span>` : '工程尚未读取。';
        box.querySelector('[data-create-animation]')?.addEventListener('click', () => { close(); showAnimation(project); });
        updateButtons();
      };
      const displayPlan = () => {
        if (!alive()) return;
        const assetMap = new Map((generationContext?.assets || []).map(asset => [asset.id, asset]));
        panel.querySelector('[data-cut-result]').innerHTML = plan ? `<div class="animation-plan-header"><strong>${h(plan.title)}</strong><p class="small" style="margin:10px 0 0">${h(plan.summary)}</p></div><div style="max-height:265px;overflow:auto">${plan.timeline.map((clip, index) => `<div class="history-row"><span>${String(index + 1).padStart(2, '0')} · ${h(assetMap.get(clip.assetId)?.name || '素材')}<br><span class="muted">${h(clip.reason || '')}</span></span><span class="mono">${timecode(clip.start)}–${timecode(clip.end)}</span></div>`).join('')}</div><p class="small">建议主轨 ${timecode(plannedSeconds(plan, generationContext))}，${plan.captions.length} 条拟定字幕。字幕时间可在剪辑器中调整。</p>${plan.captions.length ? '<label class="checkbox-line"><input type="checkbox" data-apply-captions checked>同时应用拟定字幕</label>' : '<p class="small muted">没有拟定字幕，现有字幕保留。</p>'}<p class="small muted">${h(editPlacementText(concretePlacement() ? { placement: concretePlacement() } : generationScope))}；其余轨道保留。${h((plan.warnings || []).join(' '))}</p>` : '';
        updateButtons();
      };
      const refresh = async () => {
        try {
          panel.querySelector('[data-refresh-context]').disabled = true;
          const latest = await readContext(project);
          if (!alive()) return;
          if (!Array.isArray(latest.assets) || !Array.isArray(latest.timeline) || typeof latest.revision !== 'string' || latest.projectId !== project.id) throw new Error('项目信息不完整，请重新读取。');
          context = latest; plan = null; generationContext = null; generationScope = null;
          const previous = project.video.openfilmRoughCut;
          if (previous?.revision === context.revision && previous.editScope) { plan = clone(previous.plan); generationContext = clone(context); generationScope = clone(previous.editScope); }
          scopeControl?.setContext(context);
          panel.querySelector('[data-cut-duration]').value = String(Math.min(90, Math.max(15, Math.round(context.duration) || 30)));
          if (!panel.querySelector('[data-cut-script]').value && context.script) panel.querySelector('[data-cut-script]').value = context.script;
          displayContext(); displayPlan();
        } catch (error) { showError(panel, '[data-cut-error]', error); }
        finally { if (alive()) { panel.querySelector('[data-refresh-context]').disabled = false; updateButtons(); } }
      };
      const scopeHost = document.createElement('div');
      panel.querySelector('[data-generate-cut]').closest('.row').before(scopeHost);
      scopeControl = mountEditScope(scopeHost, project, {
        loadContext: async () => { await refresh(); return context; },
        onChange: () => { plan = null; generationContext = null; generationScope = null; displayContext(); displayPlan(); void persist(project).catch(error => showError(panel, '[data-cut-error]', error)); },
      });
      cleanup(() => scopeControl.dispose());
      panel.querySelector('[data-close-cut]').onclick = close;
      panel.querySelector('[data-refresh-context]').onclick = refresh;
      panel.querySelector('[data-generate-cut]').onclick = async () => {
        if (!context || pending || aiBusy.has(busyKey)) return;
        if (!requireAi(close)) return;
        const instruction = panel.querySelector('[data-cut-instruction]').value.trim() || '结合素材和脚本，制作结构清楚的宣传短片。';
        const script = panel.querySelector('[data-cut-script]').value.trim();
        const durationTarget = Number(panel.querySelector('[data-cut-duration]').value);
        const captured = clone(context);
        let capturedScope;
        try { capturedScope = scopeControl.snapshot(captured); } catch (error) { return showError(panel, '[data-cut-error]', error); }
        const allowed = contextForEditScope(captured, capturedScope), available = allowed.assets.filter(asset => asset.type !== 'audio');
        if (!available.length) return showError(panel, '[data-cut-error]', new Error('请先选择可用于粗剪的视频或图片。'));
        if (available.length > 100 || allowed.timeline.length > 100) return showError(panel, '[data-cut-error]', new Error('本次粗剪最多处理100个素材和100个主轨片段，请先缩小选择范围。'));
        pending = true; aiBusy.add(busyKey); updateButtons(); panel.querySelector('[data-cut-error]').classList.add('hidden');
        panel.querySelector('[data-generate-cut]').innerHTML = '<span class="spinner"></span> 正在生成建议…';
        try {
          await beforeAi?.(project.id);
          if (disposed || removedProjects.has(project.id)) throw new DOMException('项目已关闭', 'AbortError');
          const result = await callAi('edit-plan', { instruction, script, durationTarget, ...(capturedScope.placement.mode === 'free' ? { timelineDuration: captured.duration } : {}), assets: available.map(({ id, name, type, duration, width, height }) => ({ id, name, type, duration, width, height })), timeline: allowed.timeline.map(({ id, assetId, start, end, at, speed }) => ({ assetId, start, end, ...(['free', 'range'].includes(capturedScope.placement.mode) ? { id, at, speed: speed || 1 } : {}) })), referenceProjectId: project.id, editScope: capturedScope });
          plan = result.data; generationContext = captured; generationScope = clone(capturedScope);
          project.video.script = script; project.video.openfilmCutInstruction = instruction; project.video.openfilmRoughCut = { revision: captured.revision, plan: clone(plan), editScope: clone(capturedScope), at: new Date().toISOString() };
          await recordAi(project, 'edit-plan', result, '生成粗剪建议');
          if (!alive()) toast('粗剪建议已保存，可重新打开查看。');
        } catch (error) { if (alive()) showError(panel, '[data-cut-error]', error); else toast(error.message, 'error'); }
        finally { pending = false; aiBusy.delete(busyKey); if (alive()) { panel.querySelector('[data-generate-cut]').innerHTML = `${icon('spark')} 重新生成建议`; displayPlan(); } }
      };
      panel.querySelector('[data-apply-cut]').onclick = async () => {
        if (!plan || !generationContext || applying || !canApplyPlacement() || (generationContext.mainTrackEditable === false && !supportsComplexTrack())) return;
        applying = true; updateButtons();
        const chosen = { timeline: clone(plan.timeline) };
        if (generationScope?.placement.mode === 'free') chosen.placement = clone(plan.placement);
        for (const effect of ['look', 'fade']) if (plan[effect]) chosen[effect] = clone(plan[effect]);
        if (panel.querySelector('[data-apply-captions]')?.checked) chosen.captions = clone(plan.captions);
        try {
          const result = await api('/api/openfilm/apply-plan', { projectId: project.id, plan: chosen, expectedRevision: generationContext.revision, editScope: clone(generationScope) });
          if (result.applied !== true) throw new Error('工程未发生更改，请重新检查建议。');
          releaseRangeBinding(project, generationScope);
          project.video.openfilmRoughCutApplied = { at: new Date().toISOString(), revision: result.revision, title: plan.title };
          await persist(project, '应用AI粗剪建议').catch(error => toast(`工程已更新，操作记录保存失败：${error.message}`, 'error'));
          await changed(project.id);
          toast('粗剪已应用到项目。');
          close();
        } catch (error) {
          if (error.code === 'OPENFILM_REVISION_CONFLICT') { context = null; plan = null; generationContext = null; displayContext(); }
          if (error.code === 'OPENFILM_MAIN_TRACK_UNSUPPORTED') { if (context) context.mainTrackEditable = false; if (generationContext) generationContext.mainTrackEditable = false; displayContext(); }
          if (alive()) { showError(panel, '[data-cut-error]', error); displayPlan(); } else toast(error.message, 'error');
        } finally { applying = false; updateButtons(); }
      };
      void refresh();
    } });
  }

  async function importScript(project, videoScript, sourceTitle = '') {
    const target = video(project);
    const shots = Array.isArray(videoScript?.shots) ? videoScript.shots : [];
    let script = '', cursor = 0;
    const captions = [];
    if (shots.length) {
      script = shots.map(shot => String(shot.narration || shot.caption || '').trim()).filter(Boolean).join('\n');
      for (const shot of shots) {
        const duration = Math.max(0.5, Number(shot.duration) || 5), text = String(shot.caption || shot.narration || '').trim();
        if (text) captions.push({ start: round(cursor), end: round(cursor + duration), text });
        cursor += duration;
      }
    } else script = typeof videoScript === 'string' ? videoScript : String(videoScript?.narration || videoScript?.text || '');
    if (!script.trim()) throw new Error('没有可导入的旁白文字。');
    if (script.length > 30000) throw new Error('旁白超过30000字，请缩短后导入。');
    target.script = script;
    target.openfilmScriptDraft = { title: String(sourceTitle || videoScript?.title || ''), captions, source: 'writing-draft', at: new Date().toISOString() };
    target.openfilmDraftCaptions = clone(captions);
    await persist(project, '接收文案旁白与拟定字幕草稿');
    await changed(project.id);
    toast(`已保存旁白${captions.length ? `与${captions.length}条拟定字幕` : ''}，可用于 AI 粗剪，时间线未改动。`);
    return { scriptImported: true, captionsDrafted: captions.length, nativeChanged: false };
  }

  function showAnimation(project) {
    const target = video(project);
    openDialog({ title: 'Remotion 自由创作', wide: true, body: '<div data-remotion-workspace></div>', onMount: ({ panel, cleanup }) => {
      const workspace = mountRemotionWorkspace(panel.querySelector('[data-remotion-workspace]'), {
        project, getSettings, requireConnection, saveProject: value => persist(value),
        loadContext: () => readContext(project), onChanged: changed,
        onApplied: async scope => { releaseRangeBinding(project, scope); await persist(project, '将Remotion成片加入时间线').catch(error => toast('成片已加入，记录保存失败：' + error.message, 'error')); },
        legacyPlan: target.openfilmAnimationPlan || target.animationPlan,
      });
      cleanup(() => workspace.dispose());
    } });
  }

  const dispose = () => { disposed = true; activeDialog?.close(); for (const state of jobs.values()) state.stop(); window.removeEventListener('pagehide', dispose); };
  window.addEventListener('pagehide', dispose, { once: true });
  return { showAnimation, showRoughCut, importScript, dispose,
    cancelProject(id) { removedProjects.add(id); for (const state of jobs.values()) if (state.project.id === id) state.stop(); },
  };
}
