import { api, showModal, toast, escapeHtml, icon, clone, uid, timecode, safeName } from './ui.js';

const h = escapeHtml;
const clamp = (value, low, high) => Math.min(high, Math.max(low, Number(value) || 0));
const round = value => Math.round(Number(value) * 1000) / 1000;
const sceneNames = { title: '标题', steps: '步骤', bars: '图表', quote: '重点', outro: '结尾' };

export function createOpenfilmActions({ getSettings, requireConnection, callAi, saveProject, onChanged }) {
  let activeDialog = null;
  let disposed = false;
  const jobs = new Map();
  const aiBusy = new Set();

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
  async function persist(project, label) { if (label) log(project, label); await saveProject(project); }
  async function recordAi(project, task, result, label) {
    video(project);
    project.runs.unshift({ id: uid(), at: new Date().toISOString(), task, meta: clone(result.meta || {}), prompt: clone(result.prompt || {}), result: clone(result.data) });
    project.runs = project.runs.slice(0, 60);
    await persist(project, label);
  }
  async function changed(projectId) {
    try { await onChanged?.(projectId); }
    catch { toast('工程已更新，档案信息暂未刷新，可稍后返回档案查看。'); }
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
  const readContext = project => api(`/api/openfilm/context?projectId=${encodeURIComponent(project.id)}`);
  function showError(panel, selector, error) {
    if (!panel?.isConnected) return;
    const box = panel.querySelector(selector); if (!box) return;
    box.textContent = error?.message || String(error); box.classList.remove('hidden');
  }

  function watchAnimation(project, initial) {
    const key = `${project.id}:${initial.jobId}`;
    const existing = jobs.get(key);
    if (existing) { if (existing.readError && !existing.running) existing.retry(); return existing; }
    const state = { project, job: clone(initial), listeners: new Set(), running: false, readError: null, controller: null, timer: null, wake: null, stopped: false };
    jobs.set(key, state);
    function notify() { for (const listener of state.listeners) { try { listener(state); } catch { /* A closed dialog does not affect the job. */ } } }
    function stop() { state.stopped = true; state.controller?.abort(); clearTimeout(state.timer); state.wake?.(); state.listeners.clear(); }
    state.stop = stop;
    state.retry = () => { state.readError = null; run(); };
    async function run() {
      if (state.running || state.stopped || ['complete', 'error'].includes(state.job.status)) return;
      state.running = true; state.readError = null; let failures = 0;
      try {
        while (!disposed && !state.stopped) {
          try {
            state.controller = new AbortController();
            const next = await api(`/api/video/jobs/${encodeURIComponent(state.job.jobId)}`, undefined, { signal: state.controller.signal });
            if (state.stopped || disposed) return;
            state.job = { ...state.job, ...next }; state.readError = null; failures = 0;
            video(project).openfilmAnimationJob = clone(state.job);
            notify();
            if (next.status === 'complete' || next.status === 'error') {
              await persist(project, next.status === 'complete' ? 'Remotion 动画渲染完成' : 'Remotion 渲染未完成').catch(error => { toast(`渲染状态已返回，项目记录保存失败：${error.message}`, 'error'); });
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
    if (state.readError) return `<div class="job-box"><strong>暂未读到最新进度</strong><p class="small muted">${h(state.readError)}</p><button class="btn small" data-requery-job>重新查询已有任务</button></div>`;
    const done = job.status === 'complete', failed = job.status === 'error', progress = Math.round(clamp(job.progress, 0, 1) * 100);
    return `<div class="job-box"><div class="row spread"><strong>${done ? '动画已生成' : failed ? '渲染未完成' : job.status === 'queued' ? '等待渲染' : '正在渲染'}</strong><span class="mono">${failed ? '' : `${progress}%`}</span></div>${failed ? `<p class="small">${h(job.error || '请检查运行时后重试。')}</p>` : `<div class="progress-bar"><div class="progress-fill" style="width:${progress}%"></div></div><p class="small muted" style="margin-top:12px">${done ? `${job.width || ''} × ${job.height || ''}${job.duration ? ` · ${timecode(job.duration)}` : ''} · MP4` : '进度来自本地渲染。关闭窗口后仍会继续，结果保存在此项目。'}</p>`}${done ? '<div class="row wrap"><button class="btn olive small" data-append-animation>加入项目</button><button class="btn small" data-download-animation>保存 MP4</button></div>' : failed ? '<button class="btn small" data-retry-render>重新渲染当前方案</button>' : ''}</div>`;
  }
  async function downloadAnimation(job) {
    if (job?.status !== 'complete' || !job.exportId) throw new Error('动画尚未生成完成。');
    if (window.desktopApi?.saveExport) { const result = await window.desktopApi.saveExport({ exportId: job.exportId, name: `${safeName(job.title || '光宣动画')}.mp4` }); if (!result?.canceled) toast('MP4 已保存'); return; }
    const anchor = document.createElement('a'); anchor.href = job.downloadUrl || `/api/video/exports/${encodeURIComponent(job.exportId)}/file`; anchor.download = `${safeName(job.title || '光宣动画')}.mp4`; anchor.click();
  }

  function showRoughCut(project) {
    video(project);
    const busyKey = `${project.id}:edit-plan`;
    if (aiBusy.has(busyKey)) { toast('此项目的粗剪建议仍在生成，完成后会保存并提示。'); return; }
    let context = null, plan = null, generationContext = null, pending = false, applying = false;
    openDialog({ title: 'AI 粗剪', wide: true, body: `<p class="small muted">读取当前工程的素材名称、时长和脚本编排片段，不识别画面或语音。检查建议后再应用。</p><div data-context-info class="notice">正在读取原生工程…</div><div class="form-field"><label>剪辑要求</label><textarea data-cut-instruction rows="3" maxlength="6000" placeholder="例如：把现有素材编成简洁的活动预告，先交代主题，再展示亮点，最后给出参与信息。">${h(project.video.openfilmCutInstruction || '')}</textarea></div><div class="form-grid"><div class="form-field"><label>目标时长 / 秒</label><input type="number" data-cut-duration min="5" max="3600" value="30"></div><div class="form-field"><label>旁白脚本</label><textarea data-cut-script rows="3" maxlength="30000" placeholder="可粘贴旁白，或从文案工作区导入分镜">${h(project.video.script)}</textarea></div></div><div class="row wrap"><button class="btn primary" data-generate-cut disabled>${icon('spark')} 生成粗剪建议</button><button class="btn" data-refresh-context>${icon('refresh')} 重新读取工程</button></div><div data-cut-result style="margin-top:18px"></div><div data-cut-error class="notice error hidden"></div><div class="modal-actions"><button class="btn" data-close-cut>关闭</button><button class="btn olive" data-apply-cut disabled>确认并应用到工程</button></div>`, onMount: ({ panel, close, alive }) => {
      const updateButtons = () => {
        if (!alive()) return;
        const assets = context?.assets?.filter(asset => ['video', 'image'].includes(asset.type)) || [];
        panel.querySelector('[data-generate-cut]').disabled = pending || applying || aiBusy.has(busyKey) || !assets.length;
        panel.querySelector('[data-apply-cut]').disabled = !plan || pending || applying || !generationContext || generationContext.mainTrackEditable === false;
        panel.querySelector('[data-refresh-context]').disabled = pending || applying;
      };
      const displayContext = () => {
        if (!alive()) return;
        const box = panel.querySelector('[data-context-info]');
        const warnings = context?.warnings || [];
        box.innerHTML = context ? `<span>${context.assets.filter(asset => asset.type !== 'audio').length} 个画面素材 · ${context.timeline.length} 个主轨片段 · ${Number.isFinite(context.duration) ? timecode(context.duration) : '时长待计算'}${warnings.length ? `<br>${warnings.map(h).join('<br>')}` : ''}${context.mainTrackEditable === false ? '<br>主轨包含未纳入上下文的片段，暂不应用粗剪，以保留现有内容。' : ''}${!context.assets.some(asset => asset.type !== 'audio') ? '<br>请先在素材区导入视频或图片，也可以先生成动画画面。<br><button class="btn small" data-create-animation style="margin-top:10px">先做 AI 动画</button>' : ''}</span>` : '工程尚未读取。';
        box.querySelector('[data-create-animation]')?.addEventListener('click', () => { close(); showAnimation(project); });
        updateButtons();
      };
      const displayPlan = () => {
        if (!alive()) return;
        const assetMap = new Map((generationContext?.assets || []).map(asset => [asset.id, asset]));
        panel.querySelector('[data-cut-result]').innerHTML = plan ? `<div class="animation-plan-header"><strong>${h(plan.title)}</strong><p class="small" style="margin:10px 0 0">${h(plan.summary)}</p></div><div style="max-height:265px;overflow:auto">${plan.timeline.map((clip, index) => `<div class="history-row"><span>${String(index + 1).padStart(2, '0')} · ${h(assetMap.get(clip.assetId)?.name || '素材')}<br><span class="muted">${h(clip.reason || '')}</span></span><span class="mono">${timecode(clip.start)}–${timecode(clip.end)}</span></div>`).join('')}</div><p class="small">建议主轨 ${timecode(plan.timeline.reduce((sum, clip) => sum + clip.end - clip.start, 0))}，${plan.captions.length} 条拟定字幕。字幕时间可在原生编辑器中调整。</p>${plan.captions.length ? '<label class="checkbox-line"><input type="checkbox" data-apply-captions checked>同时应用拟定字幕</label>' : '<p class="small muted">没有拟定字幕，现有字幕保留。</p>'}<p class="small muted">应用会重排主画面轨，其余原生轨道保留。${h((plan.warnings || []).join(' '))}</p>` : '';
        updateButtons();
      };
      const refresh = async () => {
        try {
          panel.querySelector('[data-refresh-context]').disabled = true;
          const latest = await readContext(project);
          if (!alive()) return;
          if (!Array.isArray(latest.assets) || !Array.isArray(latest.timeline) || typeof latest.revision !== 'string' || latest.projectId !== project.id) throw new Error('原生工程上下文不完整，请重新读取。');
          context = latest; plan = null; generationContext = null;
          const previous = project.video.openfilmRoughCut;
          if (previous?.revision === context.revision) { plan = clone(previous.plan); generationContext = clone(context); }
          panel.querySelector('[data-cut-duration]').value = String(Math.min(90, Math.max(15, Math.round(context.duration) || 30)));
          if (!panel.querySelector('[data-cut-script]').value && context.script) panel.querySelector('[data-cut-script]').value = context.script;
          displayContext(); displayPlan();
        } catch (error) { showError(panel, '[data-cut-error]', error); }
        finally { if (alive()) { panel.querySelector('[data-refresh-context]').disabled = false; updateButtons(); } }
      };
      panel.querySelector('[data-close-cut]').onclick = close;
      panel.querySelector('[data-refresh-context]').onclick = refresh;
      panel.querySelector('[data-generate-cut]').onclick = async () => {
        if (!context || pending || aiBusy.has(busyKey)) return;
        if (!requireAi(close)) return;
        const instruction = panel.querySelector('[data-cut-instruction]').value.trim() || '结合素材和脚本，制作结构清楚的宣传短片。';
        const script = panel.querySelector('[data-cut-script]').value.trim();
        const durationTarget = Number(panel.querySelector('[data-cut-duration]').value);
        const captured = clone(context), available = captured.assets.filter(asset => asset.type !== 'audio');
        if (available.length > 100 || captured.timeline.length > 100) return showError(panel, '[data-cut-error]', new Error('本次粗剪最多处理100个素材和100个主轨片段，请先简化工程。'));
        pending = true; aiBusy.add(busyKey); updateButtons(); panel.querySelector('[data-cut-error]').classList.add('hidden');
        panel.querySelector('[data-generate-cut]').innerHTML = '<span class="spinner"></span> 正在生成建议…';
        try {
          const result = await callAi('edit-plan', { instruction, script, durationTarget, assets: available.map(({ id, name, type, duration, width, height }) => ({ id, name, type, duration, width, height })), timeline: captured.timeline.map(({ assetId, start, end }) => ({ assetId, start, end })) });
          plan = result.data; generationContext = captured;
          project.video.script = script; project.video.openfilmCutInstruction = instruction; project.video.openfilmRoughCut = { revision: captured.revision, plan: clone(plan), at: new Date().toISOString() };
          await recordAi(project, 'edit-plan', result, '生成原生工程粗剪建议');
          if (!alive()) toast('粗剪建议已保存到项目，再次打开AI粗剪可查看。');
        } catch (error) { if (alive()) showError(panel, '[data-cut-error]', error); else toast(error.message, 'error'); }
        finally { pending = false; aiBusy.delete(busyKey); if (alive()) { panel.querySelector('[data-generate-cut]').innerHTML = `${icon('spark')} 重新生成建议`; displayPlan(); } }
      };
      panel.querySelector('[data-apply-cut]').onclick = async () => {
        if (!plan || !generationContext || applying || generationContext.mainTrackEditable === false) return;
        applying = true; updateButtons();
        const chosen = { timeline: clone(plan.timeline) };
        if (panel.querySelector('[data-apply-captions]')?.checked) chosen.captions = clone(plan.captions);
        try {
          const result = await api('/api/openfilm/apply-plan', { projectId: project.id, plan: chosen, expectedRevision: generationContext.revision });
          if (result.applied !== true) throw new Error('工程未发生更改，请重新检查建议。');
          project.video.openfilmRoughCutApplied = { at: new Date().toISOString(), revision: result.revision, title: plan.title };
          await persist(project, '将AI粗剪建议应用到原生主轨').catch(error => toast(`工程已更新，操作记录保存失败：${error.message}`, 'error'));
          await changed(project.id);
          toast('粗剪已应用到原生工程。');
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
    await persist(project, '接收文案旁白与拟定字幕草稿');
    await changed(project.id);
    toast(`已保存旁白${captions.length ? `与${captions.length}条拟定字幕` : ''}，可在AI粗剪中编排；原生时间线未被改写。`);
    return { scriptImported: true, captionsDrafted: captions.length, nativeChanged: false };
  }

  function presetPlan(aspect) {
    return { title: '动画模板示例', aspect, theme: 'paper', fps: 30, scenes: [
      { type: 'title', duration: 5, title: '从一份素材开始', subtitle: '预置动画示例' },
      { type: 'steps', duration: 7, title: '把内容讲清楚', items: ['确认关键信息', '组织内容结构', '检查并导出'] },
      { type: 'outro', duration: 4, title: '继续你的创作', subtitle: '文字、画面与节奏' },
    ] };
  }
  function showAnimation(project) {
    const target = video(project), busyKey = `${project.id}:animation-plan`;
    if (aiBusy.has(busyKey)) { toast('此项目的动画方案仍在生成，完成后会保存并提示。'); return; }
    let plan = clone(target.openfilmAnimationPlan || target.animationPlan || null);
    let origin = target.openfilmAnimationOrigin || target.animationOrigin || 'ai';
    let pending = false, starting = false, appending = false, state = null, unsubscribe = null;
    openDialog({ title: 'AI 动画画面', wide: true, body: `<p class="small muted">为“${h(project.title)}”编排可编辑场景，由 Remotion 渲染成视频，再加入原生时间线。</p><div class="form-field"><label>动画要求</label><textarea data-animation-instruction rows="3" maxlength="10000" placeholder="例如：制作20秒的活动预告，先展示主题，再用三个要点介绍活动，最后留下参与邀请。">${h(target.openfilmAnimationInstruction || '')}</textarea></div><div class="form-grid"><div class="form-field"><label>目标时长 / 秒</label><input data-animation-duration type="number" min="3" max="90" value="${plan ? round(plan.scenes.reduce((sum, scene) => sum + scene.duration, 0)) : 30}"></div><div class="form-field"><label>画幅</label><select data-animation-aspect>${['16:9', '9:16', '1:1'].map(aspect => `<option ${aspect === (plan?.aspect || target.aspect || '16:9') ? 'selected' : ''}>${aspect}</option>`).join('')}</select></div></div><div class="row spread wrap" style="margin-bottom:18px"><div class="form-field" style="margin:0;min-width:170px"><label>视觉主题</label><select data-animation-theme><option value="paper" ${plan?.theme !== 'dark' ? 'selected' : ''}>纸感浅色</option><option value="dark" ${plan?.theme === 'dark' ? 'selected' : ''}>深色舞台</option></select></div><button class="btn" data-use-preset>体验预置模板</button><button class="btn primary" data-generate-animation>${icon('spark')} AI 生成场景</button></div><p class="tiny muted">当前旁白脚本 ${target.script.length} 字。使用现有模型连接，无需新增账号。</p><div data-animation-error class="notice error hidden"></div><div data-animation-editor></div><div data-animation-job></div><div class="modal-actions"><button class="btn" data-save-animation disabled>保存场景修改</button><button class="btn olive" data-render-animation disabled>${icon('play')} 渲染动画</button></div>`, onMount: ({ panel, close, alive, cleanup }) => {
      const editor = panel.querySelector('[data-animation-editor]');
      const updateButtons = () => {
        if (!alive()) return;
        const busyJob = state && !['complete', 'error'].includes(state.job.status);
        panel.querySelector('[data-generate-animation]').disabled = pending || aiBusy.has(busyKey);
        panel.querySelector('[data-use-preset]').disabled = pending || starting;
        panel.querySelector('[data-save-animation]').disabled = !plan || pending || starting;
        panel.querySelector('[data-render-animation]').disabled = !plan || pending || starting || Boolean(busyJob);
        const add = panel.querySelector('[data-append-animation]'); if (add) { add.disabled = appending; add.textContent = appending ? '正在加入…' : state?.job.appended ? '再次加入项目' : '加入项目'; }
      };
      const displayJob = () => { if (!alive()) return; panel.querySelector('[data-animation-job]').innerHTML = animationJobMarkup(state); updateButtons(); };
      const attach = job => {
        unsubscribe?.();
        state = watchAnimation(project, job);
        const listener = () => { if (alive()) displayJob(); };
        const watched = state; watched.listeners.add(listener); unsubscribe = () => watched.listeners.delete(listener);
        displayJob();
      };
      cleanup(() => { unsubscribe?.(); });
      const displayPlan = () => {
        if (!alive()) return;
        editor.innerHTML = plan ? `<div class="animation-plan-header"><div class="row spread"><strong>${origin === 'preset' ? '预置演示，不调用模型' : '动画场景方案'}</strong><span class="pill">${plan.scenes.length} 场 · ${round(plan.scenes.reduce((sum, scene) => sum + scene.duration, 0))} 秒</span></div><input data-plan-title value="${h(plan.title)}" maxlength="80" style="width:100%;margin-top:12px" aria-label="动画标题"></div><div class="animation-scenes">${plan.scenes.map((scene, index) => `<section class="animation-scene" data-scene="${index}"><div class="row spread"><span class="small">${String(index + 1).padStart(2, '0')} · ${sceneNames[scene.type] || '场景'}</span><label class="small">时长 <input type="number" min="3" max="12" step="0.5" data-scene-duration value="${scene.duration}" style="width:60px;margin:0 4px">秒</label></div><input data-scene-title value="${h(scene.title)}" maxlength="40" aria-label="第${index + 1}场标题"><input data-scene-subtitle value="${h(scene.subtitle || '')}" maxlength="100" placeholder="副标题（可选）" aria-label="第${index + 1}场副标题">${scene.items ? `<textarea data-scene-items rows="${Math.max(2, scene.items.length)}" placeholder="每行一个要点">${h(scene.items.join('\n'))}</textarea>` : ''}${scene.type === 'bars' ? `<div style="margin-top:8px">${(scene.data || []).map(item => `<div class="form-grid" data-chart-row style="gap:8px"><input data-chart-label maxlength="24" value="${h(item.label)}" aria-label="图表标签"><input data-chart-value type="number" min="0" value="${item.value}" aria-label="图表数值"></div>`).join('')}<span class="tiny muted">图表数值需有真实依据。</span></div>` : ''}${scene.note ? `<input data-scene-note value="${h(scene.note)}" maxlength="180" aria-label="场景说明">` : ''}</section>`).join('')}</div>` : '<div class="empty-state"><p>描述需要表达的内容，或先体验预置模板。</p></div>';
        updateButtons();
      };
      const readPlan = () => {
        if (!plan) throw new Error('请先生成场景或载入预置模板。');
        const next = clone(plan); next.title = panel.querySelector('[data-plan-title]').value.trim(); next.aspect = panel.querySelector('[data-animation-aspect]').value; next.theme = panel.querySelector('[data-animation-theme]').value; next.fps = 30;
        next.scenes = [...editor.querySelectorAll('[data-scene]')].map((row, index) => {
          const scene = { ...next.scenes[index], title: row.querySelector('[data-scene-title]').value.trim(), subtitle: row.querySelector('[data-scene-subtitle]').value.trim(), duration: Number(row.querySelector('[data-scene-duration]').value) };
          if (!scene.title || !Number.isFinite(scene.duration) || scene.duration < 3 || scene.duration > 12) throw new Error('每个场景需要标题，时长为3—12秒。');
          if (row.querySelector('[data-scene-items]')) { scene.items = row.querySelector('[data-scene-items]').value.split('\n').map(text => text.trim()).filter(Boolean); if (!scene.items.length || scene.items.length > 5 || scene.items.some(text => text.length > 50)) throw new Error('每场最多五个要点，每项不超过50字。'); }
          if (scene.type === 'bars') { scene.data = [...row.querySelectorAll('[data-chart-row]')].map(item => ({ label: item.querySelector('[data-chart-label]').value.trim(), value: Number(item.querySelector('[data-chart-value]').value) })); if (!scene.data.length || scene.data.some(item => !item.label || !Number.isFinite(item.value) || item.value < 0)) throw new Error('请检查图表标签与非负数值。'); }
          if (row.querySelector('[data-scene-note]')) scene.note = row.querySelector('[data-scene-note]').value.trim();
          return scene;
        });
        if (!next.title || !next.scenes.length || next.scenes.length > 8 || next.scenes.reduce((sum, scene) => sum + scene.duration, 0) > 90) throw new Error('动画需要标题，最多八场，总时长不超过90秒。');
        return next;
      };
      const savePlan = async () => { plan = readPlan(); target.openfilmAnimationPlan = clone(plan); target.openfilmAnimationOrigin = origin; target.openfilmAnimationInstruction = panel.querySelector('[data-animation-instruction]').value; await persist(project, '保存动画场景修改'); };
      const renderAnimation = async () => {
        if (starting) return;
        try {
          starting = true; updateButtons(); panel.querySelector('[data-animation-error]').classList.add('hidden');
          await savePlan();
          const result = await api('/api/video/render-animation', { plan, prompt: target.openfilmAnimationInstruction || '', model: origin === 'preset' ? 'preset-template' : target.openfilmAnimationModel || target.animationModel || '' });
          const job = { jobId: result.jobId, status: 'queued', progress: 0, title: plan.title, startedAt: new Date().toISOString() };
          target.openfilmAnimationJob = clone(job);
          await persist(project, origin === 'preset' ? '开始渲染预置动画' : '开始渲染AI动画').catch(error => toast(`渲染已开始，任务记录保存失败：${error.message}`, 'error'));
          if (alive()) attach(job); else watchAnimation(project, job);
        } catch (error) { if (alive()) showError(panel, '[data-animation-error]', error); else toast(error.message, 'error'); }
        finally { starting = false; updateButtons(); }
      };
      panel.querySelector('[data-use-preset]').onclick = () => { plan = presetPlan(panel.querySelector('[data-animation-aspect]').value); origin = 'preset'; displayPlan(); };
      panel.querySelector('[data-generate-animation]').onclick = async () => {
        if (pending || aiBusy.has(busyKey)) return;
        if (!requireAi(close)) return;
        const instruction = panel.querySelector('[data-animation-instruction]').value.trim();
        if (!instruction && !target.script.trim()) return showError(panel, '[data-animation-error]', new Error('请填写动画要求或导入旁白脚本。'));
        const ask = { instruction, script: target.script, durationTarget: Number(panel.querySelector('[data-animation-duration]').value), aspect: panel.querySelector('[data-animation-aspect]').value, theme: panel.querySelector('[data-animation-theme]').value };
        pending = true; aiBusy.add(busyKey); updateButtons(); panel.querySelector('[data-animation-error]').classList.add('hidden'); panel.querySelector('[data-generate-animation]').innerHTML = '<span class="spinner"></span> 正在编排场景…';
        try {
          const result = await callAi('animation-plan', ask); plan = result.data; origin = 'ai';
          target.openfilmAnimationPlan = clone(plan); target.openfilmAnimationOrigin = origin; target.openfilmAnimationInstruction = instruction; target.openfilmAnimationModel = result.meta?.model || getSettings().model;
          await recordAi(project, 'animation-plan', result, '生成原生项目的动画场景方案');
          if (!alive()) toast('动画场景方案已保存到项目，可再次打开继续渲染。');
        } catch (error) { if (alive()) showError(panel, '[data-animation-error]', error); else toast(error.message, 'error'); }
        finally { pending = false; aiBusy.delete(busyKey); if (alive()) { panel.querySelector('[data-generate-animation]').innerHTML = `${icon('spark')} AI 重新编排`; displayPlan(); } }
      };
      panel.querySelector('[data-save-animation]').onclick = async () => { try { await savePlan(); toast('场景方案已保存'); } catch (error) { showError(panel, '[data-animation-error]', error); } };
      panel.querySelector('[data-render-animation]').onclick = renderAnimation;
      panel.querySelector('[data-animation-job]').onclick = async event => {
        try {
          if (event.target.closest('[data-requery-job]')) { state?.retry(); displayJob(); }
          else if (event.target.closest('[data-retry-render]')) await renderAnimation();
          else if (event.target.closest('[data-download-animation]')) await downloadAnimation(state?.job);
          else if (event.target.closest('[data-append-animation]')) {
            if (appending || state?.job.status !== 'complete' || !state.job.asset?.id) return;
            appending = true; updateButtons();
            const result = await api('/api/openfilm/import-asset', { projectId: project.id, assetId: state.job.asset.id });
            if (result.appended !== true) throw new Error('动画尚未加入工程，请重试。');
            state.job.appended = true; target.openfilmAnimationJob = clone(state.job);
            await persist(project, '将Remotion动画加入原生时间线').catch(error => toast(`动画已加入，记录保存失败：${error.message}`, 'error'));
            await changed(project.id); toast('动画已加入当前项目，原生时间线会自动更新。');
          }
        } catch (error) { if (alive()) showError(panel, '[data-animation-error]', error); else toast(error.message, 'error'); }
        finally { appending = false; updateButtons(); }
      };
      displayPlan();
      const previousJob = target.openfilmAnimationJob || target.lastAnimationJob;
      if (previousJob?.jobId) attach(previousJob);
    } });
  }

  const dispose = () => { disposed = true; activeDialog?.close(); for (const state of jobs.values()) state.stop(); window.removeEventListener('pagehide', dispose); };
  window.addEventListener('pagehide', dispose, { once: true });
  return { showAnimation, showRoughCut, importScript, dispose };
}
