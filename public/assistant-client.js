import { api, escapeHtml as h, icon } from './ui.js';
import { normalizeAssistantArtifact } from './assistant-artifacts-model.js';
import { boundAssistantSourceChangeEffects } from './assistant-source-diff-model.js';

export const assistantRunFinished = job => ['completed', 'failed', 'cancelled', 'interrupted'].includes(job?.status);
export const assistantRunStatus = job => ({ queued: '等待开始', running: '处理中', completed: '已完成', failed: '未完成', cancelled: '已停止', interrupted: '已中断' })[job?.status] || '处理中';
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
export function assistantProgress(job) {
  const retainedTools = (Array.isArray(job?.steps) ? job.steps : []).filter(step => step?.type === 'tool').length;
  return { totalToolCalls: Math.max(retainedTools, count(job?.totalToolCalls) ?? 0), totalModelCalls: count(job?.totalModelCalls) ?? 0, batch: Math.max(1, count(job?.batch) ?? 1), compactedSteps: count(job?.compactedSteps) ?? 0, hasToolTotal: count(job?.totalToolCalls) !== null };
}
export function assistantProgressText(job) {
  const progress = assistantProgress(job), status = job?.runStatus || job?.status;
  const working = ['queued', 'running', 'working'].includes(status);
  const partial = job?.reportVersion === 1 && job?.report?.outcome === 'partial';
  const label = partial && !working ? '处理结束，尚有未完成项' : working ? progress.batch > 1 ? '正在继续处理' : '正在处理' : ['failed', 'error', 'cancelled', 'interrupted'].includes(status) ? '已停止处理' : '处理完成';
  return [label, ...(progress.batch > 1 ? [`第${progress.batch}批`] : []), ...(progress.hasToolTotal || !progress.compactedSteps && progress.totalToolCalls ? [`累计${progress.totalToolCalls}步`] : [])].join(' · ');
}
const unwrap = response => response?.job || response;
export async function startAssistantRun(payload) { const result = await api('/api/assistant/runs', payload); return { runId: result.runId || result.job?.id, job: unwrap(result) }; }
export async function getAssistantRun(id, options) { return unwrap(await api(`/api/assistant/runs/${encodeURIComponent(id)}`, undefined, options)); }
export async function cancelAssistantRun(id) { return unwrap(await api(`/api/assistant/runs/${encodeURIComponent(id)}/cancel`, {})); }

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); reject(new DOMException('已停止查看进度', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, milliseconds);
    if (signal?.aborted) stop(); else signal?.addEventListener('abort', stop, { once: true });
  });
}
export async function watchAssistantRun(id, { onUpdate, signal, initial, interval = 1000 } = {}) {
  let job = initial, failures = 0;
  while (true) {
    if (signal?.aborted) throw new DOMException('已停止查看进度', 'AbortError');
    try { if (!job) job = await getAssistantRun(id, { signal }); failures = 0; }
    catch (error) { if (error.name === 'AbortError' || ++failures > 3) throw error; await delay(1500, signal); continue; }
    await onUpdate?.(job);
    if (assistantRunFinished(job)) return job;
    await delay(interval, signal); job = null;
  }
}

export function assistantSources(sources) {
  return (Array.isArray(sources) ? sources : []).flatMap(source => {
    try { const url = new URL(source.url); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return []; return [{ id: String(source.id || '').slice(0, 40), title: String(source.title || url.hostname).slice(0, 300), url: url.href }]; }
    catch { return []; }
  });
}
export function assistantDownloads(effects) {
  const found = new Set();
  return (Array.isArray(effects) ? effects : []).flatMap(effect => {
    const file = effect?.type === 'download' ? effect.download : null;
    if (!file || typeof file.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(file.id) || file.downloadUrl !== `/api/assistant/downloads/${file.id}/file` || found.has(file.id)) return [];
    if (typeof file.name !== 'string' || !file.name.trim() || !Number.isSafeInteger(file.size) || file.size < 1 || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(file.sha256)) return [];
    found.add(file.id);
    return [{ id: file.id, name: file.name.trim().replace(/[\\/\u0000-\u001f\u007f]/g, '_').slice(0, 250), size: file.size, downloadUrl: file.downloadUrl, canImport: file.canImport === true }];
  }).slice(0, 20);
}
export function assistantFileSize(size) {
  if (size < 1024) return `${size} B`;
  const units = ['KB', 'MB', 'GB', 'TB']; let value = size / 1024, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
export function assistantArtifacts(effects, projectId) {
  const seen = new Set();
  return (Array.isArray(effects) ? effects : []).flatMap(effect => {
    if (projectId && effect?.projectId && effect.projectId !== projectId) return [];
    const file = effect?.type === 'artifact' ? normalizeAssistantArtifact(effect.artifact, projectId ?? effect.projectId) : null;
    if (!file || seen.has(file.downloadUrl)) return []; seen.add(file.downloadUrl); return [file];
  }).slice(0, 30);
}
const taskId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value) ? value : null;
const taskIds = value => [...new Set((Array.isArray(value) ? value : []).map(taskId).filter(Boolean))].slice(0, 30);
const taskText = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';
export function applyAssistantTaskState(message, job) {
  if (job?.reportVersion !== 1) { for (const key of ['reportVersion', 'plan', 'evidence', 'report']) delete message[key]; return message; }
  message.reportVersion = 1;
  const entries = (Array.isArray(job.evidence?.entries) ? job.evidence.entries : []).slice(-240)
    .filter(entry => entry && /^E[1-9]\d{0,8}$/.test(entry.id || '') && ['read', 'execution', 'verification', 'job', 'failure'].includes(entry.role) && ['completed', 'passed', 'issues', 'failed', 'unavailable', 'pending', 'cancelled'].includes(entry.outcome));
  // The backend owns the complete ledger. Conversation snapshots need only
  // the evidence their plan/report actually references and a small live tail.
  const retained = new Set([
    ...(Array.isArray(job.plan?.items) ? job.plan.items : []).slice(0, 12).flatMap(item => taskIds(item?.evidenceIds)),
    ...taskIds(job.report?.executed), ...taskIds(job.report?.verified), ...taskIds(job.report?.noChangeNeeded?.evidenceIds),
    ...(Array.isArray(job.report?.unfinished) ? job.report.unfinished : []).slice(-30).map(item => taskId(item?.evidenceId)).filter(Boolean),
    ...entries.slice(-4).map(entry => entry.id),
  ]);
  const projected = entries.filter(entry => retained.has(entry.id));
  const total = Math.max(count(job.evidence?.total) || 0, entries.length);
  message.evidence = { version: 1, total, omitted: Math.max(0, total - projected.length), entries: projected
    .map(entry => ({ id: entry.id, role: entry.role, kind: taskText(entry.kind, 80), outcome: entry.outcome, label: taskText(entry.label, 500),
      ...(entry.limitations ? { limitations: taskText(entry.limitations, 1000) } : {}), ...(entry.superseded === true ? { superseded: true } : {}),
      ...(Number.isSafeInteger(entry.revision) && entry.revision >= 0 || typeof entry.revision === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(entry.revision) ? { revision: entry.revision } : {}) })) };
  const known = new Map(message.evidence.entries.map(entry => [entry.id, entry]));
  if (Array.isArray(job.plan?.items)) message.plan = { version: 1, items: job.plan.items.slice(0, 12).filter(item => item && taskId(item.id) && ['pending', 'in_progress', 'completed'].includes(item.status))
    .map(item => ({ id: item.id, label: taskText(item.label, 180), kind: taskText(item.kind, 20), status: item.status, evidenceIds: taskIds(item.evidenceIds).filter(value => known.has(value)) })) };
  else delete message.plan;
  if (job.report && ['answer', 'complete', 'partial', 'unchanged', 'stopped'].includes(job.report.outcome)) message.report = { version: 1, outcome: job.report.outcome,
    executed: taskIds(job.report.executed).filter(value => known.get(value)?.role === 'execution' && known.get(value)?.outcome === 'completed'),
    verified: taskIds(job.report.verified).filter(value => known.get(value)?.role === 'verification' && known.get(value)?.outcome === 'passed' && !known.get(value)?.superseded),
    unfinished: (Array.isArray(job.report.unfinished) ? job.report.unfinished : []).slice(-30).filter(item => item && typeof item.label === 'string').map(item => ({ code: taskText(item.code, 100), label: taskText(item.label, 1000),
      ...(taskId(item.evidenceId) && known.has(item.evidenceId) ? { evidenceId: item.evidenceId } : {}), ...(taskId(item.planId) ? { planId: item.planId } : {}) })),
    ...(job.report.noChangeNeeded ? { noChangeNeeded: { reason: taskText(job.report.noChangeNeeded.reason, 500), evidenceIds: taskIds(job.report.noChangeNeeded.evidenceIds).filter(value => known.has(value)) } } : {}) };
  else delete message.report;
  return message;
}
export function assistantTaskDetails(input) {
  if (input?.reportVersion !== 1) return '';
  const message = {}; applyAssistantTaskState(message, input);
  const plan = message.plan?.items || [], evidence = new Map((message.evidence?.entries || []).map(entry => [entry.id, entry])), report = message.report;
  const working = input.status === 'working' || ['queued', 'running'].includes(input.runStatus || input.status);
  const planMarkup = plan.length ? `<section class="gx-assistant-plan" data-assistant-plan aria-label="任务计划"><strong>任务计划</strong><ol>${plan.map(item => `<li class="is-${h(item.status)}"><span aria-label="${h(({ pending: '待处理', in_progress: '处理中', completed: '已完成' })[item.status])}">${item.status === 'completed' ? icon('check') : item.status === 'in_progress' ? '<span class="spinner"></span>' : '<span class="gx-assistant-plan-dot"></span>'}</span><div>${h(item.label)}</div></li>`).join('')}</ol></section>` : '';
  if (working) return planMarkup;
  if (!report || report.outcome === 'answer' && !report.executed.length && !report.verified.length && !report.unfinished.length) return planMarkup;
  const labels = { source_saved: '源码保存', project_change: '工程修改', asset_import: '素材导入', timeline_apply: '加入或修改时间线', video_render: '视频渲染', file_ready: '成品文件', download_ready: '原文件保存', compile_check: '编译检查', frame_render: '实际取帧', visual_review: '画面复核', native_preflight: '导出体检', undo_apply: '撤销修改', cancel_requested: '停止请求', task_cancelled: '任务取消', task_retry_requested: '任务重试' };
  const lines = refs => refs.map(value => evidence.get(value)).filter(Boolean).map(entry => `<li data-evidence-kind="${h(entry.kind)}"><span>${h(labels[entry.kind] || '工具结果')}${entry.revision !== undefined ? ` · ${h(typeof entry.revision === 'number' ? 'v' + entry.revision : entry.revision.slice(0, 12))}` : ''}</span><div>${h(entry.label)}${entry.limitations ? `<small>${h(entry.limitations)}</small>` : ''}</div></li>`).join('');
  const resultLabel = ({ answer: '已整理', complete: '已处理', partial: '部分完成', unchanged: '无需修改', stopped: '已停止' })[report.outcome];
  return `${planMarkup}<details class="gx-assistant-report" data-assistant-report="${h(report.outcome)}" ${working || report.outcome === 'partial' ? 'open' : ''}><summary>本次结果 · ${h(resultLabel)}</summary><div>${report.executed.length ? `<section><strong>已执行</strong><ul>${lines(report.executed)}</ul></section>` : ''}${report.verified.length ? `<section><strong>已验证</strong><ul>${lines(report.verified)}</ul></section>` : report.executed.length ? '<p class="gx-assistant-report-note">暂无额外检查记录。</p>' : ''}${report.noChangeNeeded ? `<p>${h(report.noChangeNeeded.reason)}</p>` : ''}${report.unfinished.length ? `<section class="is-unfinished"><strong>未完成</strong><ul>${report.unfinished.map(item => `<li><div>${h(item.label)}</div></li>`).join('')}</ul></section>` : ''}</div></details>`;
}

export function assistantSourceDiffs(effects) {
  const found = new Set();
  const range = (start, end, column) => `${start}${column ? ':' + column : ''}–${end}行`;
  return boundAssistantSourceChangeEffects(effects).filter(effect => effect?.type === 'remotion' && effect.sourceChanges).slice(-10).map(effect => {
    const diff = effect.sourceChanges, key = `${diff.remotionId}:${diff.fromRevision}:${diff.toRevision}`;
    if (found.has(key)) return ''; found.add(key);
    return `<details class="gx-assistant-source-diff" data-assistant-source-diff><summary>查看改动 <span>v${h(diff.fromRevision)} → v${h(diff.toRevision)} · ${diff.files.length}个文件</span></summary>${diff.files.map(file => `<details class="gx-assistant-diff-file" ${diff.files.length === 1 ? 'open' : ''}><summary>${h(file.path)}</summary>${file.hunks.map(hunk => `<div class="gx-assistant-diff-hunk"><section class="is-before"><strong>修改前 · ${h(range(hunk.oldStartLine, hunk.oldEndLine, hunk.oldStartColumn))}</strong><pre><code>${h(hunk.before)}</code></pre></section><section class="is-after"><strong>修改后 · ${h(range(hunk.newStartLine, hunk.newEndLine, hunk.newStartColumn))}</strong><pre><code>${h(hunk.after)}</code></pre></section></div>`).join('')}</details>`).join('')}${diff.truncated ? '<p>部分差异已收起。</p>' : ''}</details>`;
  }).join('');
}

export function assistantDetails(message) {
  const allSteps = (Array.isArray(message.steps) ? message.steps : []).filter(step => step?.type === 'tool'), steps = allSteps.slice(-14), progress = assistantProgress(message);
  const totalKnown = progress.hasToolTotal || progress.compactedSteps === 0;
  const summary = totalKnown ? `处理过程 · 累计${progress.totalToolCalls}步${steps.length < progress.totalToolCalls ? ` · 最近${steps.length}步` : ''}` : `处理过程 · 最近${steps.length}步`;
  const continuing = message.status === 'working' && (progress.hasToolTotal || progress.batch > 1);
  const sources = assistantSources(message.sources);
  const sourceLink = source => `<a href="${h(source.url)}" target="_blank" rel="noopener noreferrer">${h(source.id ? `[${source.id}] ` : '')}${h(source.title)}${icon('link')}</a>`;
  const sourceMarkup = sources.length ? `<div class="gx-assistant-sources"><span>来源${sources.length > 8 ? ` · ${sources.length}个` : ''}</span>${sources.slice(0, 8).map(sourceLink).join('')}${sources.length > 8 ? `<details class="gx-assistant-source-more"><summary>其余${sources.length - 8}个来源</summary>${sources.slice(8).map(sourceLink).join('')}</details>` : ''}</div>` : '';
  const effects = (Array.isArray(message.effects) ? message.effects : []).filter(effect => effect && !['download', 'artifact'].includes(effect.type) && (effect.label || effect.summary)).slice(0, 10);
  const downloads = assistantDownloads(message.effects), artifacts = assistantArtifacts(message.effects, message.projectId);
  const artifactMarkup = artifacts.map(file => `<section class="gx-assistant-download" data-assistant-artifact aria-label="已生成的制作文件"><div class="gx-assistant-download-heading">${icon('file')}<div><strong>${h(file.name)}</strong><span>${Number.isSafeInteger(file.size) ? h(assistantFileSize(file.size)) + ' · ' : ''}已生成</span></div></div><div class="gx-assistant-download-bottom"><a class="btn small" data-assistant-artifact-save href="${h(file.downloadUrl)}" download="${h(file.name)}">${icon('download')}保存文件</a></div></section>`).join('');
  const taskMarkup = assistantTaskDetails(message) + assistantSourceDiffs(message.effects);
  const legacyEffects = message.reportVersion === 1 && message.report ? [] : effects;
  return `${taskMarkup}${continuing ? `<div class="gx-assistant-run-progress" data-assistant-cumulative role="status">${h(assistantProgressText(message))}</div>` : ''}${steps.length ? `<details class="gx-assistant-steps" ${message.status === 'working' ? 'open' : ''}><summary>${h(summary)}</summary>${progress.compactedSteps || !totalKnown ? `<p class="gx-assistant-history-note">${message.status === 'working' ? '已收起较早步骤，任务仍在继续。' : '已收起较早步骤，结果和来源已保留。'}</p>` : ''}<ol>${steps.map(step => `<li class="is-${h(['running', 'completed', 'failed', 'cancelled'].includes(step.status) ? step.status : 'running')}"><span>${step.status === 'running' ? '<span class="spinner"></span>' : icon(step.status === 'completed' ? 'check' : 'info')}</span><div>${h(step.label || '处理资料')}${step.message ? `<small>${h(step.message)}</small>` : ''}</div></li>`).join('')}</ol></details>` : ''}${legacyEffects.map(effect => `<div class="gx-assistant-result">${icon('check')}<span>${h(effect.label || effect.summary)}</span></div>`).join('')}${downloads.map(file => `<section class="gx-assistant-download" data-assistant-download="${h(file.id)}" aria-label="已下载的原文件"><div class="gx-assistant-download-heading">${icon('file')}<div><strong>${h(file.name)}</strong><span>${h(assistantFileSize(file.size))} · 已下载</span></div></div><div class="gx-assistant-download-bottom"><span>${file.canImport ? '可导入科普项目。' : ''}</span><a class="btn small" data-assistant-download-save href="${h(file.downloadUrl)}" download="${h(file.name)}">${icon('download')}保存原文件</a></div></section>`).join('')}${artifactMarkup}${sourceMarkup}`;
}

export function applyAssistantJob(message, job) {
  message.runId = job.id || job.runId || message.runId; message.runStatus = job.status;
  if (typeof job.projectId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(job.projectId)) message.projectId = job.projectId;
  for (const key of ['totalToolCalls', 'totalModelCalls', 'batch', 'compactedSteps']) if (count(job[key]) !== null) message[key] = job[key]; else delete message[key];
  applyAssistantTaskState(message, job);
  message.errorCode = typeof job.error?.code === 'string' ? job.error.code : '';
  if (assistantRunFinished(job)) message.retryWatch = false;
  const undone = new Set((message.effects || []).filter(effect => effect.undone && effect.undo?.id).map(effect => effect.undo.id));
  message.steps = job.steps || []; message.sources = assistantSources(job.sources); message.effects = boundAssistantSourceChangeEffects((job.effects || []).map(effect => undone.has(effect.undo?.id) ? { ...effect, undone: true } : effect));
  message.status = !assistantRunFinished(job) ? 'working' : job.status === 'completed' ? 'complete' : job.status === 'cancelled' ? 'cancelled' : 'error';
  const failure = ['failed', 'interrupted'].includes(job.status) ? job.error?.message || (job.status === 'interrupted' ? '服务已重启，上次请求已中断，请重新发送。' : '处理未完成，请重试。') : '';
  message.content = failure ? [job.message, failure].filter((value, index, list) => value && list.indexOf(value) === index).join('\n\n') : job.message || (job.status === 'cancelled' ? '已停止，已完成的修改可在下方查看或撤销。' : (job.steps || []).at(-1)?.label || '正在理解要求…');
  return message;
}
