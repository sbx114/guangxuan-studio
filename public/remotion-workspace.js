import { api, escapeHtml as h, toast } from './ui.js';
import { mountEditScope, editScopeSnapshot } from './editor-scope.js';

const sessions = new Map();
const finished = status => ['complete', 'error', 'cancelled'].includes(status);
const errorText = error => typeof error === 'string' ? error : error?.message || '操作未完成，请检查后重试。';
const copy = value => structuredClone(value);
const revisionKey = project => `${project?.id || ''}:${project?.revision ?? ''}`;

export function createRemotionApi(projectId, request = api) {
  const base = `/api/projects/${encodeURIComponent(projectId)}/remotion`;
  const one = id => `${base}/${encodeURIComponent(id)}`;
  return {
    list: options => request(base, undefined, options),
    read: (id, options) => request(one(id), undefined, options),
    create: (body, options) => request(base, body, options),
    generate: (body, options) => request(`${base}/generate`, body, options),
    save: (id, body, options) => request(one(id), body, { ...options, method: 'PUT' }),
    inspect: (id, body, options) => request(`${one(id)}/inspect`, body, options),
    preview: (id, body, options) => request(`${one(id)}/preview`, body, options),
    review: (id, body, options) => request(`${one(id)}/review`, body, options),
    render: (id, body, options) => request(`${one(id)}/render`, body, options),
    job: (id, options) => request(`${base}/jobs/${encodeURIComponent(id)}`, undefined, options),
    cancel: (id, options) => request(`${base}/jobs/${encodeURIComponent(id)}/cancel`, {}, options),
    append: (id, body, options) => request(`${one(id)}/append`, body, options),
    file: (id, file) => `${base}/jobs/${encodeURIComponent(id)}/files/${encodeURIComponent(file)}`,
  };
}

function styles() {
  if (document.querySelector('[data-remotion-workspace-style]')) return;
  const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = '/remotion-workspace.css'; link.dataset.remotionWorkspaceStyle = ''; document.head.append(link);
}
function stateFor(project) {
  let state = sessions.get(project.id);
  if (!state) { state = { active: null, title: '', items: [], files: new Map(), selectedFile: '', compositions: [], compositionId: '', entryPoint: '', propsText: '{}', dirty: false, editStamp: 0, instruction: '', job: null, preview: null, sample: null, pendingAppend: null, undo: null, conflict: false, candidate: null }; sessions.set(project.id, state); }
  return state;
}
const wait = (ms, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(new DOMException('已取消', 'AbortError')); return; }
  const stop = () => { clearTimeout(timer); reject(new DOMException('已取消', 'AbortError')); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
  signal.addEventListener('abort', stop, { once: true });
});

/** A real multi-file Remotion workspace; the API owns compilation and rendering. */
export function mountRemotionWorkspace(host, { project, getSettings = () => ({}), requireConnection, saveProject, beforeAction, loadContext = () => api(`/api/openfilm/context?projectId=${encodeURIComponent(project.id)}`), onChanged, onApplied, service = createRemotionApi(project.id), legacyPlan } = {}) {
  if (!host?.isConnected || !project?.id) throw new Error('请先打开视频项目。');
  styles();
  const state = stateFor(project), disposers = [];
  let disposed = false, busy = false, controller = null, scopeControl = null, operation = 0;
  host.innerHTML = `<section class="rm-workspace"><div class="rm-intro"><p>描述画面、节奏和时长，生成后可继续编辑。</p></div><div class="rm-project-row"><label>当前工程<select data-rm-project aria-label="Remotion工程"><option value="">新建动画工程</option></select></label><button class="btn small" data-rm-new>新建工程</button></div><label class="rm-request">想做什么动画<textarea data-rm-instruction rows="4" maxlength="30000" placeholder="例如：三个物体沿不同轨迹运动，镜头跟随展示它们的关系，时长10秒。">${h(state.instruction)}</textarea></label><div class="rm-main-actions"><button class="btn primary" data-rm-generate>生成 / 修改工程</button><label class="rm-auto-improve"><input type="checkbox" data-rm-auto-improve>生成后优化画面</label><button class="btn small subtle" data-rm-cancel hidden>取消</button><button class="btn small" data-rm-resume hidden>重新查看进度</button></div><p data-rm-status class="rm-status" role="status" aria-live="polite"></p><progress data-rm-progress max="1" value="0" hidden></progress><div data-rm-error class="notice error hidden" role="alert"></div><button class="btn small" data-rm-save-copy hidden>另存为新工程</button><section class="rm-composition-panel"><div class="rm-composition-row"><label>Composition<select data-rm-composition aria-label="实际Composition"><option value="">请先生成并编译工程</option></select></label><button class="btn small" data-rm-inspect>重新编译</button></div><p data-rm-metadata class="tiny muted"></p><div class="rm-preview-actions"><button class="btn" data-rm-preview>预览画面</button><button class="btn" data-rm-review>AI 画面检查</button><button class="btn" data-rm-sample>播放3秒小样</button><button class="btn olive" data-rm-render>渲染并加入时间线</button><button class="btn" data-rm-append hidden>加入成片</button><button class="btn subtle" data-rm-undo hidden>撤销这次加入</button></div><p data-rm-preview-note class="tiny muted"></p><div data-rm-frames class="rm-frames"></div><video data-rm-video controls preload="metadata" hidden></video><section class="rm-review" data-rm-review-result hidden aria-live="polite"><h4 data-rm-review-heading></h4><p data-rm-review-summary></p><p data-rm-review-scope class="tiny muted"></p><div data-rm-review-frames class="rm-review-frames"></div><ol data-rm-review-issues class="rm-review-issues"></ol><button class="btn" data-rm-improve hidden>按反馈改进</button></section><div data-rm-placement></div></section><details class="rm-source"><summary>编辑源文件 <small data-rm-dirty></small></summary><div class="rm-source-heading"><label>工程名称<input data-rm-title maxlength="120" aria-label="Remotion工程名称"></label><label>入口文件<input data-rm-entry maxlength="200" aria-label="Remotion入口文件" placeholder="src/index.jsx"></label></div><div class="rm-file-bar"><label>源文件<select data-rm-file aria-label="Remotion源文件"></select></label><input data-rm-new-file maxlength="200" aria-label="新增文件路径" placeholder="例如 src/Scene.jsx"><button class="btn small" data-rm-add-file>添加文件</button></div><textarea class="rm-code" data-rm-code spellcheck="false" rows="18" aria-label="Remotion源代码"></textarea><label>输入参数 JSON<textarea class="rm-props" data-rm-props spellcheck="false" rows="4" aria-label="Remotion输入参数"></textarea></label><div class="rm-source-actions"><button class="btn" data-rm-save>保存源码并编译</button><span class="tiny muted">编译失败不会丢失代码。</span></div></details>${legacyPlan ? `<details class="rm-legacy"><summary>查看旧版方案</summary><p class="tiny muted">旧方案已保留，可在上方新建动画工程。</p><pre>${h(JSON.stringify(legacyPlan, null, 2))}</pre></details>` : ''}</section>`;
  const q = selector => host.querySelector(selector);
  if (typeof state.autoImprove !== 'boolean') state.autoImprove = true;
  q('[data-rm-auto-improve]').checked = state.autoImprove;
  q('[data-rm-auto-improve]').onchange = event => { state.autoImprove = event.target.checked; };
  const status = text => { if (!disposed) q('[data-rm-status]').textContent = text; };
  const clearError = () => { q('[data-rm-error]').textContent = ''; q('[data-rm-error]').classList.add('hidden'); };
  function showError(error) { if (disposed) return; q('[data-rm-error]').textContent = errorText(error); q('[data-rm-error]').classList.remove('hidden'); }
  const props = () => { let value; try { value = JSON.parse(state.propsText || '{}'); } catch { throw new Error('JSON 格式有误，代码和输入已保留。'); } if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('输入参数需要是JSON对象。'); return value; };
  function draftFiles() { return [...state.files].map(([path, content]) => ({ path, content })); }
  function changed() {
    state.dirty = true; state.editStamp++; state.preview = null; state.sample = null; state.pendingAppend = null; state.review = null; paintReview();
    q('[data-rm-preview-note]').textContent = '源码或参数已修改，请保存并重新预览。'; q('[data-rm-frames]').replaceChildren(); q('[data-rm-video]').hidden = true; q('[data-rm-video]').removeAttribute('src');
    paintControls();
  }
  function paintControls() {
    if (disposed) return;
    const activeJob = state.job && !finished(state.job.status);
    q('[data-rm-auto-improve]').disabled = busy || Boolean(activeJob);
    for (const selector of ['[data-rm-generate]', '[data-rm-new]', '[data-rm-project]', '[data-rm-file]', '[data-rm-add-file]', '[data-rm-new-file]']) q(selector).disabled = busy || Boolean(activeJob);
    for (const selector of ['[data-rm-inspect]', '[data-rm-save]']) q(selector).disabled = busy || Boolean(activeJob) || (!state.active && !state.files.size);
    for (const selector of ['[data-rm-preview]', '[data-rm-sample]', '[data-rm-render]', '[data-rm-composition]']) q(selector).disabled = busy || Boolean(activeJob) || !state.active || (!state.compositionId && !state.dirty);
    for (const selector of ['[data-rm-code]', '[data-rm-props]', '[data-rm-title]', '[data-rm-entry]', '[data-rm-instruction]']) q(selector).readOnly = busy;
    q('[data-rm-code]').readOnly = busy || !state.selectedFile;
    q('[data-rm-cancel]').hidden = !busy && !activeJob; q('[data-rm-cancel]').disabled = false;
    q('[data-rm-resume]').hidden = busy || !activeJob;
    q('[data-rm-save-copy]').hidden = !(state.conflict || state.candidate); q('[data-rm-save-copy]').disabled = busy;
    q('[data-rm-append]').hidden = !state.pendingAppend || state.dirty || state.pendingAppend.remotionId !== state.active?.id || state.pendingAppend.revision !== state.active?.revision || state.pendingAppend.compositionId !== state.compositionId || state.job?.status !== 'complete';
    q('[data-rm-append]').disabled = busy;
    q('[data-rm-undo]').hidden = !state.undo?.id || state.undo.undone; q('[data-rm-undo]').disabled = busy || Boolean(activeJob);
    q('[data-rm-review]').disabled = busy || Boolean(activeJob) || !state.active || state.dirty || !state.compositions.some(item => item.id === state.compositionId);
    q('[data-rm-improve]').disabled = busy || Boolean(activeJob) || state.dirty || !reviewCanImprove();
    q('[data-rm-dirty]').textContent = state.dirty ? '有未保存修改' : state.active ? '已保存' : '';
    scopeControl?.setDisabled(busy || Boolean(activeJob));
  }
  function paintProjects() {
    q('[data-rm-project]').innerHTML = '<option value="">新建动画工程</option>' + state.items.map(item => `<option value="${h(item.id)}" ${item.id === state.active?.id ? 'selected' : ''}>${h(item.title || '未命名工程')}</option>`).join('');
  }
  function paintFiles() {
    const names = [...state.files.keys()]; if (!names.includes(state.selectedFile)) state.selectedFile = names[0] || '';
    q('[data-rm-file]').innerHTML = names.map(name => `<option value="${h(name)}" ${name === state.selectedFile ? 'selected' : ''}>${h(name)}</option>`).join('');
    q('[data-rm-code]').value = state.files.get(state.selectedFile) || '';
    q('[data-rm-title]').value = state.title || ''; q('[data-rm-entry]').value = state.entryPoint; q('[data-rm-props]').value = state.propsText;
  }
  function paintCompositions() {
    const list = state.compositions;
    if (!list.some(item => item.id === state.compositionId)) state.compositionId = list[0]?.id || '';
    q('[data-rm-composition]').innerHTML = list.length ? list.map(item => `<option value="${h(item.id)}" ${item.id === state.compositionId ? 'selected' : ''}>${h(item.id)}</option>`).join('') : '<option value="">请先生成并编译工程</option>';
    const selected = list.find(item => item.id === state.compositionId);
    q('[data-rm-metadata]').textContent = selected ? `${selected.width} × ${selected.height} · ${selected.fps} fps · ${(selected.durationInFrames / selected.fps).toFixed(2)} 秒 · ${selected.durationInFrames} 帧` : '编译后显示尺寸、帧率和时长。';
    paintControls();
  }
  function accept(value) {
    if (!value?.id || !Array.isArray(value.files)) throw new Error('工程未返回完整源文件，当前输入已保留。');
    const pending = state.pendingAppend;
    state.active = copy(value); state.title = value.title || ''; state.files = new Map(value.files.map(file => [file.path, file.content])); state.entryPoint = value.entryPoint || ''; state.propsText = JSON.stringify(value.inputProps || {}, null, 2); state.dirty = false; state.conflict = false; state.candidate = null; state.pendingAppend = pending?.remotionId === value.id && pending.revision === value.revision ? pending : null;
    state.compositions = []; state.compositionId = value.compositionId || ''; state.preview = null; state.sample = null; state.review = null; paintReview();
    paintProjects(); paintFiles(); paintCompositions(); q('[data-rm-frames]').replaceChildren(); q('[data-rm-video]').hidden = true;
  }
  async function refreshList(signal) { const result = await service.list({ signal }); if (!disposed) { state.items = Array.isArray(result.items) ? result.items : []; paintProjects(); } return state.items; }
  async function save(signal) {
    if (!state.active) {
      if (!state.files.size || !state.entryPoint.trim()) throw new Error('请先生成工程，或添加源文件并填写入口文件后保存。');
      const stamp = state.editStamp, result = await service.create({ title: state.title.trim() || project.title || 'Remotion自由创作', files: draftFiles(), entryPoint: state.entryPoint, compositionId: state.compositionId || undefined, inputProps: props(), assets: [] }, { signal });
      if (disposed) return result.project;
      if (stamp !== state.editStamp) { state.candidate = result.project; state.conflict = true; throw new Error('创建期间又有手工修改，当前输入已保留。'); }
      accept(result.project); await refreshList(signal); return state.active;
    }
    if (!state.dirty) return state.active;
    const previous = new Map((state.active.files || []).map(file => [file.path, file.content]));
    const files = draftFiles().filter(file => previous.get(file.path) !== file.content);
    const stamp = state.editStamp;
    const result = await service.save(state.active.id, { expectedRevision: state.active.revision, files, title: state.title.trim() || state.active.title, entryPoint: state.entryPoint, compositionId: state.compositionId || state.active.compositionId, inputProps: props() }, { signal });
    if (disposed) return result.project;
    if (stamp !== state.editStamp) { state.conflict = true; throw new Error('保存期间又有新的手工修改，当前输入已保留，请核对后重试。'); }
    accept(result.project); return state.active;
  }
  async function inspect(signal) {
    await save(signal); const key = revisionKey(state.active);
    const result = await service.inspect(state.active.id, { expectedRevision: state.active.revision }, { signal });
    if (disposed || key !== revisionKey(state.active)) return;
    if (!Array.isArray(result.compositions) || !result.compositions.length) throw new Error('工程已保存，但没有可用的Composition。请检查入口文件与编译信息。');
    state.compositions = result.compositions; paintCompositions(); status('编译完成，可预览或渲染。');
  }
  function selectedComposition() {
    const selected = state.compositions.find(item => item.id === state.compositionId);
    if (!selected || !Number.isInteger(selected.durationInFrames) || selected.durationInFrames < 1 || !(selected.fps > 0)) throw new Error('请先编译并选择 Composition。');
    return selected;
  }
  const currentReviewKey = () => `${revisionKey(state.active)}:${state.compositionId}:${state.propsText}`;
  function reviewPictures(review = state.review) {
    const prefix = `/api/projects/${encodeURIComponent(project.id)}/remotion/jobs/`;
    return (Array.isArray(review?.frames) ? review.frames : []).flatMap(item => {
      if (!item || !Number.isInteger(item.frame) || item.frame < 0) return [];
      let url = '';
      if (typeof item.url === 'string') {
        try { const target = new URL(item.url, location.origin); if (target.origin === location.origin && target.pathname.startsWith(prefix) && !target.search && !target.hash) url = target.pathname; } catch {}
      }
      if (!url && review.previewJobId && /^[A-Za-z0-9._-]+$/.test(item.file || '')) url = service.file(review.previewJobId, item.file);
      return url ? [{ frame: item.frame, url, reason: typeof item.reason === 'string' ? item.reason.slice(0, 100) : '' }] : [];
    });
  }
  function reviewCanImprove() {
    return state.review?.status === 'reviewed' && state.review.key === currentReviewKey() && reviewPictures().length > 0 && (state.review.issues || []).some(issue => typeof issue.fix === 'string' && issue.fix.trim());
  }
  function paintReview() {
    if (disposed) return;
    const panel = q('[data-rm-review-result]'); if (!panel) return;
    const review = state.review; panel.hidden = !review;
    if (!review) return;
    const pictures = reviewPictures(review), reviewed = review.status === 'reviewed' && pictures.length > 0;
    const verdict = reviewed ? review.verdict === 'pass' && (review.issues || []).length ? 'revise' : review.verdict : 'unknown';
    panel.dataset.reviewStatus = reviewed ? 'reviewed' : 'unavailable'; panel.dataset.reviewVerdict = verdict;
    q('[data-rm-review-heading]').textContent = !reviewed ? '画面检查未完成' : verdict === 'pass' ? '采样检查通过' : verdict === 'revise' ? '画面有待调整' : '画面检查暂无结论';
    q('[data-rm-review-summary]').textContent = review.summary || (!reviewed ? '暂无有效检查结果。' : '请查看下方反馈。');
    const coverage = review.coverage, coverageNote = Number.isSafeInteger(coverage?.plannedShots) && coverage.plannedShots > 0 && Number.isSafeInteger(coverage?.sampledShots) ? `，覆盖 ${coverage.sampledShots}/${coverage.plannedShots} 个镜头` : '';
    q('[data-rm-review-scope]').textContent = reviewed ? `已检查 ${pictures.length} 张采样画面${coverageNote}。节奏和转场请播放小样确认。` : pictures.length ? `已抽取 ${pictures.length} 张画面，AI 检查尚未完成。` : '未取得采样画面，暂时无法检查。';
    q('[data-rm-review-frames]').innerHTML = pictures.map(item => `<figure><a href="${h(item.url)}" target="_blank" rel="noopener"><img src="${h(item.url)}" alt="复核采样第${item.frame}帧"></a><figcaption>${item.reason ? h(item.reason) + ' · ' : ''}第 ${item.frame} 帧</figcaption></figure>`).join('');
    q('[data-rm-review-issues]').innerHTML = (Array.isArray(review.issues) ? review.issues : []).map(issue => `<li class="rm-review-issue" data-severity="${issue.severity === 'blocking' ? 'blocking' : 'polish'}"><div><strong>${issue.severity === 'blocking' ? '需要修正' : '可以优化'}</strong>${Number.isInteger(issue.frame) ? `<span>第 ${issue.frame} 帧</span>` : ''}${issue.category ? `<span>${h(issue.category)}</span>` : ''}</div><p>${h(issue.detail || '')}</p>${issue.fix ? `<p><strong>建议：</strong>${h(issue.fix)}</p>` : ''}</li>`).join('');
    q('[data-rm-improve]').hidden = !reviewCanImprove();
  }
  async function watch(jobId, signal) {
    state.job = { id: jobId, status: 'queued', progress: 0 }; paintControls();
    for (;;) {
      const response = await service.job(jobId, { signal }), job = response.job;
      if (!job || !['queued', 'running', 'complete', 'error', 'cancelled'].includes(job.status)) throw new Error('任务状态无效，可重新查看进度。');
      state.job = { ...job, id: jobId };
      if (!disposed) { q('[data-rm-progress]').hidden = finished(job.status); q('[data-rm-progress]').value = Math.max(0, Math.min(1, Number(job.progress) || 0)); status(job.status === 'complete' ? '任务完成。' : job.status === 'cancelled' ? '任务已取消，工程和源码保留。' : `正在${(job.kind || job.type) === 'preview' ? '预览' : '渲染'} · ${Math.round((Number(job.progress) || 0) * 100)}%`); }
      if (job.status === 'error') throw new Error(errorText(job.error));
      if (job.status === 'cancelled') throw new DOMException('任务已取消', 'AbortError');
      if (job.status === 'complete') return state.job;
      await wait(600, signal);
    }
  }
  function showFrames(job) {
    const frames = job.result?.frames;
    if (!Array.isArray(frames) || !frames.length) throw new Error('预览未返回实际画面文件。');
    q('[data-rm-frames]').innerHTML = frames.map(item => {
      if (!/^[A-Za-z0-9._-]+$/.test(item.file || '') || !Number.isInteger(item.frame)) throw new Error('预览文件信息无效。');
      const url = service.file(job.id, item.file); return `<figure><a href="${h(url)}" target="_blank" rel="noopener"><img src="${h(url)}" alt="第${item.frame}帧"></a><figcaption>第 ${item.frame} 帧</figcaption></figure>`;
    }).join('');
    state.preview = `${revisionKey(state.active)}:${state.compositionId}:${state.propsText}`;
    q('[data-rm-preview-note]').textContent = '静帧仅供查看画面，播放小样可检查节奏。';
  }
  async function preview(signal) {
    if (state.dirty || !state.compositions.length) await inspect(signal);
    const composition = selectedComposition(), count = composition.durationInFrames;
    const frames = [...new Set([.2, .5, .8].map(position => Math.max(0, Math.min(count - 1, Math.floor(count * position)))))];
    const result = await service.preview(state.active.id, { expectedRevision: state.active.revision, compositionId: composition.id, inputProps: props(), frames }, { signal });
    const job = await watch(result.jobId, signal); if (!disposed) showFrames(job); return job;
  }
  async function execute(label, action) {
    if (busy || disposed) return;
    const current = ++operation; busy = true; controller = new AbortController(); clearError(); status(label); paintControls();
    try { await action(controller.signal); }
    catch (error) { if (!disposed && current === operation) { if (error.name === 'AbortError') status('已停止等待，工程和当前输入保留。'); else { state.conflict ||= /版本|revision|冲突/i.test(errorText(error)); showError(error); status(state.job && !finished(state.job.status) ? '任务可能仍在运行，可重新查看进度或取消。' : '操作未完成，当前输入已保留。'); } } }
    finally { if (current === operation) { busy = false; controller = null; if (!disposed) { q('[data-rm-progress]').hidden = true; paintControls(); } } }
  }
  q('[data-rm-instruction]').oninput = event => { state.instruction = event.target.value; };
  q('[data-rm-code]').oninput = event => { if (state.selectedFile) { state.files.set(state.selectedFile, event.target.value); changed(); } };
  q('[data-rm-entry]').oninput = event => { state.entryPoint = event.target.value; changed(); };
  q('[data-rm-props]').oninput = event => { state.propsText = event.target.value; changed(); };
  q('[data-rm-title]').oninput = event => { state.title = event.target.value; changed(); };
  q('[data-rm-file]').onchange = event => { state.selectedFile = event.target.value; q('[data-rm-code]').value = state.files.get(state.selectedFile) || ''; };
  q('[data-rm-composition]').onchange = event => { state.compositionId = event.target.value; state.preview = null; state.sample = null; state.review = null; paintReview(); q('[data-rm-frames]').replaceChildren(); q('[data-rm-video]').hidden = true; paintCompositions(); };
  q('[data-rm-add-file]').onclick = () => { const name = q('[data-rm-new-file]').value.trim(); if (!name || name.startsWith('/') || name.includes('..') || name.includes('\\') || name.includes(':') || !/\.(?:[cm]?[jt]sx?|css|json|svg|txt|glsl|vert|frag|wgsl)$/.test(name)) { showError(new Error('请填写工程内的相对源文件路径，例如 src/Scene.jsx。')); return; } if (!state.files.has(name)) { state.files.set(name, ''); state.selectedFile = name; changed(); paintFiles(); } q('[data-rm-new-file]').value = ''; };
  q('[data-rm-new]').onclick = () => { if (state.dirty) { showError(new Error('请先保存当前源码，或另存为新工程后再新建。')); return; } state.active = null; state.title = ''; state.files = new Map(); state.compositions = []; state.compositionId = ''; state.entryPoint = ''; state.propsText = '{}'; state.selectedFile = ''; state.job = null; state.preview = null; state.sample = null; state.pendingAppend = null; state.review = null; paintReview(); paintProjects(); paintFiles(); paintCompositions(); q('[data-rm-frames]').replaceChildren(); q('[data-rm-video]').hidden = true; status('描述要求，开始生成动画。'); };
  q('[data-rm-project]').onchange = event => { const id = event.target.value; if (state.dirty) { paintProjects(); showError(new Error('当前源码尚未保存，请先保存或另存后再切换工程。')); return; } if (!id) { q('[data-rm-new]').click(); return; } void execute('正在打开工程…', async signal => { const result = await service.read(id, { signal }); if (!disposed) { accept(result.project); await inspect(signal); } }); };
  async function generate(signal, { diagnostics = '', fromReview = false } = {}) {
    const instruction = state.instruction.trim() || (fromReview ? '改进当前Remotion工程的画面质量，保留原有主题、时长、素材与未涉及的内容。' : '');
    if (!instruction) throw new Error('请先描述想呈现的动画内容与画面。');
    if (requireConnection?.() === false) return;
    const settings = getSettings(); if (!settings.baseUrl || !settings.model || !settings.apiKey) throw new Error('请先配置可用的模型连接。');
    if (state.dirty && state.files.size) await save(signal);
    const stamp = state.editStamp;
    let result;
    try { result = await service.generate({ instruction: instruction + (fromReview ? '\n请依据本次实际采样画面反馈修正工程，保留没有涉及的内容。' : ''), ...(diagnostics ? { diagnostics } : {}), ...(state.active ? { remotionId: state.active.id, expectedRevision: state.active.revision } : {}), autoImprove: state.autoImprove, settings }, { signal }); }
    catch (error) { if (!disposed) { try { await refreshList(); } catch {} } throw error; }
    if (disposed) return;
    await refreshList(signal);
    if (stamp !== state.editStamp) { state.candidate = result.project; state.conflict = true; throw new Error('生成期间又有手工修改，已保留当前输入；生成结果已保存为工程，可先将当前输入另存再查看。'); }
    accept(result.project);
    const inspected = Array.isArray(result.inspection) ? result.inspection : result.inspection?.compositions;
    if (inspected?.length) { state.compositions = inspected; paintCompositions(); } else await inspect(signal);
    if (result.review) {
      state.review = { ...copy(result.review), key: currentReviewKey() }; paintReview();
      status(result.review.status !== 'reviewed' || result.review.verdict === 'unknown' ? '工程已生成，画面检查未完成，请查看原因。' : result.review.verdict === 'revise' ? '工程已生成，画面仍有待调整项。' : '工程已生成并完成采样检查。');
    } else if (fromReview) status('已按反馈生成新版本，请重新复核采样画面。');
  }
  q('[data-rm-generate]').onclick = () => void execute('正在生成动画工程…', generate);
  q('[data-rm-review]').onclick = () => void execute('正在检查采样画面…', async signal => {
    if (requireConnection?.() === false) return;
    const settings = getSettings(); if (!settings.baseUrl || !settings.model || !settings.apiKey) throw new Error('请先配置可用的模型连接。');
    if (state.dirty || !state.compositions.length) await inspect(signal);
    const selected = selectedComposition(), key = currentReviewKey(), stamp = state.editStamp;
    state.review = null; paintReview();
    const result = await service.review(state.active.id, { expectedRevision: state.active.revision, compositionId: selected.id, inputProps: props(), settings, instruction: state.instruction }, { signal });
    if (disposed || signal.aborted) return;
    if (stamp !== state.editStamp || key !== currentReviewKey()) { status('复核期间源码已有新修改，已保留当前输入；该结果属于旧版本，请保存后重新复核。'); return; }
    const review = result.review;
    if (!review || !['reviewed', 'unavailable'].includes(review.status) || !['pass', 'revise', 'unknown'].includes(review.verdict)) throw new Error('画面复核未返回有效结论，当前工程和输入已保留。');
    state.review = { ...copy(review), issues: Array.isArray(review.issues) ? review.issues : [], previewJobId: review.previewJobId || result.previewJobId, frames: review.frames || result.frames || [], key };
    paintReview();
    status(review.status === 'reviewed' && reviewPictures().length ? '采样检查完成，请查看反馈。' : 'AI 画面检查未完成，请查看原因。');
  });
  q('[data-rm-improve]').onclick = () => void execute('正在按反馈调整动画…', async signal => {
    if (!reviewCanImprove()) throw new Error('请先完成当前源码版本的画面复核，再按反馈改进。');
    const review = state.review, fixes = review.issues.filter(issue => typeof issue.fix === 'string' && issue.fix.trim());
    const diagnostics = ['实际采样画面复核反馈：', review.summary || '', ...fixes.map(issue => `帧${Number.isInteger(issue.frame) ? issue.frame : '未指定'} · ${issue.category || '画面'} · ${issue.severity || 'polish'}\n问题：${issue.detail || ''}\n具体修正：${issue.fix}`)].join('\n\n');
    if (diagnostics.length > 10000) throw new Error('复核反馈较长，请在动画要求中指定本次优先修正的问题；当前工程未修改。');
    await generate(signal, { diagnostics, fromReview: true });
  });
  q('[data-rm-inspect]').onclick = q('[data-rm-save]').onclick = () => void execute('正在保存并编译…', inspect);
  q('[data-rm-preview]').onclick = () => void execute('正在生成预览…', preview);
  q('[data-rm-sample]').onclick = () => void execute('正在渲染短小样…', async signal => { if (state.dirty || !state.compositions.length) await inspect(signal); const selected = selectedComposition(); const result = await service.render(state.active.id, { expectedRevision: state.active.revision, compositionId: selected.id, inputProps: props(), range: [0, Math.min(3, selected.durationInFrames / selected.fps)] }, { signal }); const job = await watch(result.jobId, signal); if (!disposed) { state.sample = job.id; q('[data-rm-video]').src = service.file(job.id, 'video.mp4'); q('[data-rm-video]').hidden = false; status('短小样已完成，可播放检查节奏。'); } });
  const renderedDuration = (job, composition) => {
    const actual = Number(job?.result?.duration), inspected = Number(composition?.durationInFrames) / Number(composition?.fps);
    const duration = Number.isFinite(actual) && actual > 0 ? actual : inspected;
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('尚未读到成片时长，已渲染文件保留，请重新查看任务。');
    return duration;
  };
  async function freePlacement(scope, native, contentDuration, signal) {
    if (scope.placement.mode !== 'free') return undefined;
    const settings = getSettings();
    if (!settings?.baseUrl || !settings?.model || !settings?.apiKey) throw new Error('成片已渲染，请先配置模型连接，再安排放置位置。');
    status('成片已渲染，正在安排放置位置…');
    const response = await api('/api/ai', { task: 'edit-placement', settings, payload: { instruction: state.instruction || `按当前工程安排“${state.active?.title || '动画成片'}”的位置。`, title: project.title || '', context: native, editScope: scope, contentDuration } }, { signal });
    const placement = response?.data?.placement;
    if (!placement || !['append', 'insert', 'replace', 'range'].includes(placement.mode)) throw new Error('AI未返回有效放置位置，成片已保留，可重新安排。');
    return copy(placement);
  }
  q('[data-rm-render]').onclick = () => void execute('正在准备成片…', async signal => {
    await beforeAction?.(project.id);
    const native = await loadContext({ signal }); scopeControl?.setContext(native);
    const scope = editScopeSnapshot(project, native), expectedNativeRevision = native.revision;
    if (state.dirty || !state.compositions.length) await inspect(signal);
    const key = `${revisionKey(state.active)}:${state.compositionId}:${state.propsText}`; if (state.preview !== key) await preview(signal);
    const selected = selectedComposition(), result = await service.render(state.active.id, { expectedRevision: state.active.revision, compositionId: selected.id, inputProps: props() }, { signal });
    state.pendingAppend = { jobId: result.jobId, remotionId: state.active.id, revision: state.active.revision, compositionId: selected.id };
    const job = await watch(result.jobId, signal); if (signal.aborted || disposed) return;
    if (scope.placement.mode === 'free') state.pendingAppend.duration = renderedDuration(job, selected);
    status('渲染完成，正在加入时间线…');
    const placement = await freePlacement(scope, native, state.pendingAppend.duration, signal);
    if (signal.aborted || disposed) return;
    const appended = await service.append(state.active.id, { jobId: job.id, expectedNativeRevision, editScope: scope, ...(placement ? { placement } : {}) }, { signal });
    if (appended.appended !== true) throw new Error('成片已渲染，尚未加入时间线。请核对工程后重试。');
    state.pendingAppend = null; state.undo = appended.undo || null; await onApplied?.(scope, appended); await onChanged?.(project.id); status('成片已渲染并加入时间线。'); toast('Remotion成片已加入时间线。');
  });
  q('[data-rm-append]').onclick = () => void execute('正在加入成片…', async signal => {
    const pending = state.pendingAppend; if (!pending || state.dirty || pending.remotionId !== state.active?.id || pending.revision !== state.active?.revision) throw new Error('源码已变化，请重新渲染后再加入。');
    await beforeAction?.(project.id); const native = await loadContext({ signal }), scope = editScopeSnapshot(project, native);
    let placement;
    if (scope.placement.mode === 'free') {
      if (!pending.duration) { const result = await service.job(pending.jobId, { signal }); pending.duration = renderedDuration(result.job, state.compositions.find(value => value.id === pending.compositionId)); }
      placement = await freePlacement(scope, native, pending.duration, signal);
    }
    if (signal.aborted || disposed) return;
    const result = await service.append(pending.remotionId, { jobId: pending.jobId, expectedNativeRevision: native.revision, editScope: scope, ...(placement ? { placement } : {}) }, { signal });
    if (result.appended !== true) throw new Error('成片尚未加入，请核对后重试。');
    state.pendingAppend = null; state.undo = result.undo || null; await onApplied?.(scope, result); await onChanged?.(project.id); status('成片已加入时间线。');
  });
  q('[data-rm-undo]').onclick = () => void execute('正在撤销这次加入…', async signal => {
    if (!state.undo?.id || state.undo.undone) return;
    await beforeAction?.(project.id);
    const result = await api('/api/openfilm/assistant-undo', { projectId: project.id, undoId: state.undo.id }, { signal });
    if (result.restored !== true) throw new Error('尚未恢复到加入前的工程，请核对后重试。');
    state.undo.undone = true; await onChanged?.(project.id); status('已撤销，恢复到加入前的时间线。');
  });
  q('[data-rm-cancel]').onclick = async () => {
    controller?.abort();
    if (state.job && !finished(state.job.status)) { q('[data-rm-cancel]').disabled = true; try { const result = await service.cancel(state.job.id); state.job = { ...result.job, id: state.job.id }; status('已请求取消，工程和源码保留。'); } catch (error) { showError(error); } finally { paintControls(); } }
  };
  q('[data-rm-resume]').onclick = () => void execute('正在重新查看任务…', async signal => { const job = await watch(state.job.id, signal); if (job.result?.frames) showFrames(job); else { q('[data-rm-video]').src = service.file(job.id, 'video.mp4'); q('[data-rm-video]').hidden = false; status('渲染已完成。'); } });
  q('[data-rm-save-copy]').onclick = () => void execute('正在另存为新工程…', async signal => { const result = await service.create({ title: `${state.title.trim() || state.active?.title || project.title || '自由创作'}（手改）`, files: draftFiles(), entryPoint: state.entryPoint, compositionId: state.compositionId || undefined, inputProps: props(), assets: (state.active?.assets || []).map(({ assetId }) => ({ assetId })) }, { signal }); if (!disposed) { accept(result.project); await refreshList(signal); await inspect(signal); } });
  scopeControl = mountEditScope(q('[data-rm-placement]'), project, { loadContext: async () => { await beforeAction?.(project.id); return loadContext(); }, onChange: () => { void Promise.resolve(saveProject?.(project)).catch(showError); }, onError: showError });
  paintProjects(); paintFiles(); paintCompositions();
  void execute('正在读取工程列表…', async signal => { await refreshList(signal); if (state.active && !state.dirty) { const result = await service.read(state.active.id, { signal }); if (!disposed) { accept(result.project); await inspect(signal); } } else if (!state.active && state.items[0]?.id) { const result = await service.read(state.items[0].id, { signal }); if (!disposed) { accept(result.project); await inspect(signal); } } else status(state.dirty ? '当前输入尚未保存，已在本次会话中保留。' : '描述想做的动画。'); });
  return { dispose() { if (disposed) return; disposed = true; operation++; controller?.abort(); scopeControl?.dispose(); for (const dispose of disposers) dispose(); }, getState: () => ({ active: state.active, dirty: state.dirty, compositionId: state.compositionId }) };
}
