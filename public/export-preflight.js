import { api, escapeHtml as h, icon, showModal, timecode, toast } from './ui.js';

const VALID_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SEVERITY = { error: '需要修复', warning: '请确认', info: '说明' };
const seconds = value => Number.isFinite(Number(value)) ? timecode(Number(value)) : '';

/** beforeExport resolves true only after a clean check or explicit continuation of warnings. */
export function createExportPreflightUI({ getProjectId = () => '', onNavigate } = {}) {
  if (!document.querySelector('link[data-export-preflight-css]')) { const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = '/export-preflight.css'; link.dataset.exportPreflightCss = ''; document.head.append(link); }
  let active = null, disposed = false;
  const live = session => !disposed && active === session && !session.done;
  function finish(session, proceed = false, close = true) {
    if (session.done) return;
    session.done = true; session.request?.abort();
    if (active === session) active = null;
    if (close && session.close && session.panel?.isConnected) session.close();
    session.resolve(proceed === true);
  }
  function issuesOf(report) { return (Array.isArray(report?.issues) ? report.issues : []).filter(issue => issue && typeof issue.message === 'string').sort((a, b) => ({ error: 0, warning: 1, info: 2 }[a.severity] ?? 2) - ({ error: 0, warning: 1, info: 2 }[b.severity] ?? 2)); }
  const blocked = report => report?.canExport !== true || issuesOf(report).some(issue => issue.severity === 'error');
  function mount(session) {
    if (!live(session) || session.panel?.isConnected) return;
    const close = showModal({ title: '导出前体检', kicker: 'Gx · 检查当前工程', wide: true, body: '<div class="gx-export-preflight" data-preflight-body></div>', onMount(root, closeModal) { session.panel = root.querySelector('.modal'); session.panel.classList.add('gx-preflight-modal'); session.close = closeModal; }, onClose() { finish(session, false, false); } });
    session.close ||= close; render(session);
  }
  function render(session) {
    if (!live(session) || !session.panel?.isConnected) return;
    const body = session.panel.querySelector('[data-preflight-body]');
    if (session.busy) {
      body.innerHTML = `<div class="gx-preflight-loading" role="status" aria-live="polite"><span class="spinner"></span><strong>${session.deep ? '正在抽检素材片段…' : '正在检查工程和源素材…'}</strong><p>${session.deep ? '抽查黑场和静音，不含最终合成画面。' : '核对文件、时间线、字幕和音轨。'}</p></div><div class="gx-preflight-actions"><button class="btn" data-preflight-close>取消检查</button></div>`;
      body.querySelector('[data-preflight-close]').onclick = () => finish(session); return;
    }
    if (session.error) {
      body.innerHTML = `<div class="gx-preflight-result is-error" role="alert">${icon('info')}<div><strong>检查未完成</strong><p>${h(session.error)}</p></div></div><div class="gx-preflight-actions"><button class="btn" data-preflight-close>返回</button><button class="btn primary" data-preflight-recheck>${icon('refresh')}重新检查</button></div>`;
      body.querySelector('[data-preflight-close]').onclick = () => finish(session);
      body.querySelector('[data-preflight-recheck]').onclick = () => { void run(session, false); }; return;
    }
    const report = session.report, issues = issuesOf(report), errors = issues.filter(issue => issue.severity === 'error'), warnings = issues.filter(issue => issue.severity === 'warning'), hard = blocked(report), summary = report?.summary || {}, deep = report?.checks?.deep || {};
    session.displayIssues = issues.slice(0, 100);
    const resultTitle = hard ? `有 ${errors.length || 1} 项问题需要修复` : warnings.length ? `有 ${warnings.length} 项提示待确认` : '检查通过';
    const lead = hard ? '修复后请重新检查。' : warnings.length ? '确认提示后可继续导出。' : session.mode === 'export' ? '可以继续导出。' : '未发现会阻止导出的问题。';
    const stage = report?.checks?.structure?.stage;
    body.innerHTML = `<div class="gx-preflight-result ${hard ? 'is-error' : warnings.length ? 'is-warning' : 'is-success'}" role="status">${icon(hard || warnings.length ? 'info' : 'check')}<div><strong>${h(resultTitle)}</strong><p>${h(lead)}</p></div></div>
      <div class="gx-preflight-summary"><span>${Number(summary.clipCount) || 0} 个片段</span><span>${Number(summary.sourceCount) || 0} 个引用文件</span><span>${seconds(summary.range?.[0] || 0)} — ${seconds(summary.range?.[1] ?? summary.duration ?? 0)}</span>${stage ? `<span>${Number(stage.width) || 0} × ${Number(stage.height) || 0}</span>` : ''}<span>${Number(summary.fps) || Number(session.spec.fps) || 30} fps</span></div>
      <div class="gx-preflight-issues" aria-label="体检结果">${session.displayIssues.map((issue, index) => {
        const severity = Object.hasOwn(SEVERITY, issue.severity) ? issue.severity : 'info', navigable = typeof session.navigate === 'function' && (Number.isFinite(issue.start) || typeof issue.clipId === 'string');
        return `<article class="gx-preflight-issue is-${severity}"><div class="gx-preflight-issue-copy"><span class="gx-preflight-severity">${SEVERITY[severity]}</span><p>${h(issue.message)}</p><div class="gx-preflight-issue-meta">${Number.isFinite(issue.start) ? `<span>${seconds(issue.start)}${Number.isFinite(issue.end) ? ` — ${seconds(issue.end)}` : ''}</span>` : ''}${typeof issue.source === 'string' ? `<span>${h(issue.source)}</span>` : ''}</div></div>${navigable ? `<button class="btn" data-preflight-issue="${index}">${icon('arrow')}前往检查</button>` : ''}</article>`;
      }).join('') || '<p class="gx-preflight-clear">文件和时间线检查通过。</p>'}${issues.length > 100 ? '<p class="gx-preflight-note">仅显示前100项，请分段修复后重新检查。</p>' : ''}</div>
      <div class="gx-preflight-scope"><strong>${deep.enabled ? `已抽检 ${Array.isArray(deep.samples) ? deep.samples.length : 0} 个素材片段` : '本次为快速检查'}</strong><p>${h(deep.note || '仅检查结构和素材信息，不含最终合成画面。')}</p><p>字幕排版请在预览中确认。</p></div>
      <div class="gx-preflight-deep"><button class="btn" data-preflight-deep>${icon('eye')}${deep.enabled ? '重新深度抽检' : '深度抽检素材'}</button><span>最多 ${Number(deep.limits?.maxDeepSamples) || 6} 段、共 ${Number(deep.limits?.maxDeepSeconds) || 60} 秒；不含最终合成或混音。</span></div>
      <div class="gx-preflight-actions"><button class="btn" data-preflight-close>${session.mode === 'export' ? hard ? '返回修复' : '暂不导出' : '关闭'}</button><button class="btn" data-preflight-recheck>${icon('refresh')}重新快速检查</button>${session.mode === 'export' && !hard ? `<button class="btn primary" data-preflight-continue>${icon('download')}继续导出</button>` : ''}</div>`;
    body.querySelector('[data-preflight-close]').onclick = () => finish(session);
    body.querySelector('[data-preflight-recheck]').onclick = () => { void run(session, false); };
    body.querySelector('[data-preflight-deep]').onclick = () => { void run(session, true); };
    const proceed = body.querySelector('[data-preflight-continue]'); if (proceed) proceed.onclick = () => finish(session, true);
    for (const button of body.querySelectorAll('[data-preflight-issue]')) button.onclick = async () => {
      const issue = session.displayIssues[Number(button.dataset.preflightIssue)]; if (!issue) return;
      const location = {};
      for (const key of ['start', 'end']) if (Number.isFinite(issue[key])) location[key] = issue[key];
      if (typeof issue.clipId === 'string') location.clipId = issue.clipId;
      finish(session);
      try { await session.navigate(session.projectId, location); } catch (error) { toast(error.message || '暂时无法定位，请在编辑器中检查该片段。', 'error'); }
    };
  }
  async function run(session, deep, autoProceed = false) {
    if (!live(session)) return;
    session.request?.abort(); const generation = ++session.generation, request = new AbortController(); session.request = request; session.busy = true; session.deep = deep; session.error = '';
    render(session);
    try {
      const report = await api(`/api/projects/${encodeURIComponent(session.projectId)}/export-preflight`, { ...session.spec, deep: deep === true }, { signal: request.signal });
      if (!live(session) || generation !== session.generation) return;
      session.report = report; session.busy = false;
      if (autoProceed && !blocked(report) && !issuesOf(report).some(issue => issue.severity === 'warning')) { finish(session, true); return; }
      mount(session); render(session);
    } catch (error) {
      if (!live(session) || generation !== session.generation || error.name === 'AbortError') return;
      session.busy = false; session.error = error.message || '暂时无法完成导出体检，请稍后重试。'; mount(session); render(session);
    }
  }
  function start(mode, projectId, spec = {}, options = {}) {
    if (disposed) return Promise.resolve(false);
    if (active) finish(active);
    const owner = projectId || getProjectId?.();
    if (typeof owner !== 'string' || !VALID_ID.test(owner)) { toast('请先打开一个视频项目'); return Promise.resolve(false); }
    let resolve; const promise = new Promise(yes => { resolve = yes; });
    const safeSpec = { ...(spec?.range !== undefined ? { range: spec.range } : {}), ...(spec?.fps !== undefined ? { fps: spec.fps } : {}) };
    const session = { mode, projectId: owner, spec: safeSpec, navigate: options.onNavigate || onNavigate, resolve, done: false, panel: null, close: null, request: null, report: null, displayIssues: [], busy: true, deep: false, error: '', generation: 0 };
    active = session;
    if (mode === 'inspect') mount(session);
    void run(session, false, mode === 'export');
    return promise;
  }
  return {
    open: (projectId, spec) => start('inspect', projectId, spec),
    beforeExport: (projectId, spec, options = {}) => start('export', projectId, spec, options),
    dispose() { if (disposed) return; if (active) finish(active); disposed = true; },
  };
}
