import { AppError } from './errors.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const STATES = new Set(['pending', 'in_progress', 'completed']);
const KINDS = new Set(['read', 'change', 'verify', 'deliver']);
const ROLES = new Set(['read', 'execution', 'verification', 'job', 'failure']);
const OUTCOMES = new Set(['completed', 'passed', 'issues', 'failed', 'unavailable', 'pending', 'cancelled']);
const PLAN_LIMIT = 12, EVIDENCE_LIMIT = 240;
const text = (value, clean, limit) => clean(String(value ?? '')).slice(0, limit);
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value) ? value : null;
const ids = (value, limit = 12) => [...new Set((Array.isArray(value) ? value : []).map(id).filter(Boolean))].slice(0, limit);
const VERSION_KEYS = ['revision', 'filmRevision', 'expectedRevision', 'hash', 'sha256'];
const stateRead = entry => entry.role === 'read' && ['read_result', 'source_read', 'source_search', 'job_status'].includes(entry.kind)
  && !/^(?:web_|app_capabilities|app_tool_schema|.*_catalog$|download_list$|task_list$|project_jobs$)/.test(entry.tool);

export const ASSISTANT_PLAN_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['items'],
  properties: {
    items: { type: 'array', maxItems: PLAN_LIMIT, items: {
      type: 'object', additionalProperties: false, required: ['id', 'label', 'kind', 'status'],
      properties: { id: { type: 'string', minLength: 1, maxLength: 80 }, label: { type: 'string', minLength: 1, maxLength: 180 },
        kind: { type: 'string', enum: [...KINDS] }, status: { type: 'string', enum: [...STATES] },
        evidenceIds: { type: 'array', maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 128 } } },
    } },
    note: { type: 'string', maxLength: 500 },
  },
};

/** Metadata only. Tool receipts can only be appended by the execution loop. */
export function updateAssistantPlan(job, input, { clean = String, stamp = new Date().toISOString() } = {}) {
  if (!Array.isArray(input?.items) || input.items.length > PLAN_LIMIT) throw new AppError(400, '计划最多保留12项。', 'ASSISTANT_PLAN_INVALID');
  const known = new Map((job.evidence?.entries || []).map(entry => [entry.id, entry])), used = new Set();
  let running = 0;
  const items = input.items.map(item => {
    if (!object(item) || !id(item.id) || item.id.length > 80 || used.has(item.id) || !STATES.has(item.status) || !KINDS.has(item.kind) || typeof item.label !== 'string' || !item.label.trim() || item.label.length > 180) throw new AppError(400, '计划项的编号、状态或内容不正确。', 'ASSISTANT_PLAN_INVALID');
    used.add(item.id); if (item.status === 'in_progress') running++;
    const evidenceIds = ids(item.evidenceIds);
    if (evidenceIds.some(value => !known.has(value))) throw new AppError(400, '计划只能引用本次任务的真实记录。', 'ASSISTANT_PLAN_EVIDENCE');
    if (item.status === 'completed') {
      const actual = evidenceIds.map(value => known.get(value)).filter(entry => !entry.superseded);
      const supported = actual.some(entry => item.kind === 'read' ? entry.role === 'read' && entry.outcome === 'completed'
        : item.kind === 'verify' ? entry.role === 'verification' && entry.outcome === 'passed'
          : item.kind === 'deliver' ? entry.role === 'execution' && ['video_render', 'file_ready', 'download_ready'].includes(entry.kind) && entry.outcome === 'completed'
            : entry.role === 'execution' && entry.outcome === 'completed');
      if (!supported) throw new AppError(400, '完成计划项需要对应的真实结果；排队、计划或失败不能当作完成。', 'ASSISTANT_PLAN_EVIDENCE');
    }
    return { id: item.id, label: text(item.label.trim(), clean, 180), kind: item.kind, status: item.status, evidenceIds };
  });
  if (running > 1) throw new AppError(400, '请一次处理一个当前计划项。', 'ASSISTANT_PLAN_INVALID');
  job.plan = { version: 1, items, note: text(input.note, clean, 500), updatedAt: stamp };
  compact(job); return job.plan;
}

function resource(tool, args, data, projectId, effect) {
  const root = id(projectId) || 'global';
  if (effect?.type === 'native' || /^native_/.test(tool)) return `native:${root}`;
  if (effect?.type === 'remotion' || /^(?:remotion_|animation_create)/.test(tool)) return `remotion:${root}:${id(args.remotionId || args.id || data.remotionId || data.id || data.job?.remotionId || data.job?.remotionProjectId) || 'project'}`;
  return `project:${root}`;
}
function revision(data, args) {
  for (const key of VERSION_KEYS) {
    const value = data?.[key] ?? (key === 'expectedRevision' ? args?.[key] : undefined);
    if (Number.isSafeInteger(value) && value >= 0 || typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)) return value;
  }
  return undefined;
}
function jobKeys(value) {
  return [...new Set(['jobId', 'taskId', 'exportId', 'sourceJobId'].flatMap(key => id(value?.[key]) ? [value[key]] : []))];
}
function compact(job) {
  const ledger = job.evidence;
  if (!ledger || ledger.entries.length <= EVIDENCE_LIMIT) return;
  const pinned = new Set((job.plan?.items || []).flatMap(item => item.evidenceIds || []));
  const unresolved = latestJobStates(ledger.entries).filter(entry => entry.outcome !== 'completed').map(entry => entry.id);
  const toolOutcomes = new Map(); for (const entry of ledger.entries) toolOutcomes.set(entry.tool, entry.role === 'failure' ? entry.id : null);
  unresolved.push(...[...toolOutcomes.values()].filter(Boolean));
  const checkpoints = new Map(); for (const entry of ledger.entries) if (['execution', 'verification'].includes(entry.role)) checkpoints.set(`${entry.role}:${entry.resourceKey}:${entry.kind}`, entry.id);
  const keep = new Set(ledger.entries.filter(entry => pinned.has(entry.id)).map(entry => entry.id));
  for (const value of [...unresolved, ...checkpoints.values()].reverse()) { if (keep.size >= EVIDENCE_LIMIT) break; keep.add(value); }
  if (unresolved.some(value => !keep.has(value))) ledger.omittedUnfinished = true;
  for (const entry of ledger.entries.slice().reverse()) { if (keep.size >= EVIDENCE_LIMIT) break; keep.add(entry.id); }
  ledger.entries = ledger.entries.filter(entry => keep.has(entry.id));
  ledger.omitted = ledger.total - ledger.entries.length;
}

/** Receives registered-tool results, never model-authored final/plan objects. */
export function recordAssistantResult(job, { tool, toolId, args = {}, result, error, mutating = false, clean = String, stamp = new Date().toISOString(), trustedEvidence = [] } = {}) {
  if (['assistant_plan', 'assistant_recall'].includes(tool)) return [];
  job.evidence ||= { version: 1, total: 0, omitted: 0, entries: [] };
  const data = object(result?.data) ? result.data : {}, added = [];
  const add = value => {
    const safeRevision = revision({ revision: value.revision }, {});
    const entry = { id: `E${++job.evidence.total}`, stepId: text(toolId, clean, 100), tool: text(tool, clean, 80), role: value.role, kind: text(value.kind, clean, 80), outcome: value.outcome,
      label: text(value.label, clean, 500), resourceKey: text(value.resourceKey || resource(tool, args, data, job.projectId), clean, 260), at: stamp,
      ...(safeRevision !== undefined ? { revision: safeRevision } : {}), ...(value.jobIds?.length ? { jobIds: ids(value.jobIds) } : {}),
      ...(value.limitations ? { limitations: text(value.limitations, clean, 1000) } : {}), ...(value.code ? { code: text(value.code, clean, 100) } : {}) };
    for (const earlier of job.evidence.entries) {
      const sameResource = earlier.resourceKey === entry.resourceKey, affected = sameResource || value.invalidatesAll === true;
      const newVersion = sameResource && safeRevision !== undefined && earlier.revision !== undefined && earlier.revision !== safeRevision;
      if (earlier.role === 'verification' && (value.invalidates && affected || newVersion)) earlier.superseded = true;
      // Staleness affects current-state conclusions, never the historical fact
      // that a plan's read step actually happened.
      if (stateRead(earlier) && (value.invalidates && affected || newVersion || sameResource && stateRead(entry) && (earlier.revision === undefined || safeRevision === undefined))) earlier.stale = true;
    }
    job.evidence.entries.push(entry); added.push(entry); return entry;
  };
  if (error) {
    add({ role: 'failure', kind: 'tool_error', outcome: 'failed', label: error.message || '工具未完成。', code: error.code || 'ASSISTANT_TOOL_FAILED' }); compact(job); return added;
  }
  add({ role: 'read', kind: mutating ? 'tool_result' : 'read_result', outcome: 'completed', label: result?.summary || '已读取工具结果。', revision: revision(data, args) });
  if (tool === 'assistant_undo_apply' && data.restored === true) add({ role: 'execution', kind: 'undo_apply', outcome: 'completed', label: '已撤销指定修改，并重新读取当前工程。', invalidates: true, invalidatesAll: true });
  const effects = Array.isArray(result?.effects) ? result.effects : [];
  for (const effect of effects) {
    if (!object(effect)) continue;
    const pending = ['native-export'].includes(effect.type) || tool === 'remotion_render_advanced';
    const keys = jobKeys(effect);
    if (pending && keys.length) { add({ role: 'job', kind: 'async_job', outcome: 'pending', label: effect.label || '任务已启动，尚未完成。', jobIds: keys }); continue; }
    if (['download', 'artifact'].includes(effect.type)) {
      add({ role: 'execution', kind: effect.type === 'download' ? 'download_ready' : 'file_ready', outcome: 'completed', label: effect.label || '文件已可保存。', jobIds: keys,
        limitations: effect.changed === false ? '此凭据确认已有文件可保存，不代表本次新建。' : undefined }); continue;
    }
    if (effect.changed === true || effect.undo?.id) {
      const nativeTimeline = effect.type === 'native' && /^(?:native_(?:edit|adjust|operation)|remotion_(?:append|render)|animation_create)$/.test(tool) && !effect.importedAssetId;
      add({ role: 'execution', kind: nativeTimeline ? 'timeline_apply' : effect.importedAssetId ? 'asset_import' : effect.type === 'remotion' ? 'source_saved' : 'project_change', outcome: 'completed', label: effect.label || '工程修改已保存。',
        resourceKey: resource(tool, args, data, job.projectId, effect), revision: revision(data, args), jobIds: keys, invalidates: tool !== 'remotion_render' || effect.type === 'native' });
    }
  }
  if (['animation_create', 'remotion_edit'].includes(tool) && data.remotionId && data.revision !== undefined && !effects.some(effect => effect.type === 'remotion' && effect.changed === true)) add({ role: 'execution', kind: 'source_saved', outcome: 'completed', label: '自由动画源码版本已保存。', revision: data.revision, invalidates: true });
  if (/^remotion_inspect(?:_advanced)?$/.test(tool) && (Array.isArray(result?.data) || Array.isArray(data.compositions))) add({ role: 'verification', kind: 'compile_check', outcome: 'passed', label: '源码编译与Composition信息已检查。', revision: revision(data, args), limitations: '只证明编译检查完成；未据此确认画面、声音或最终视频。' });
  const review = tool === 'remotion_review' ? data : ['animation_create', 'remotion_edit'].includes(tool) && object(data.review) ? data.review : null;
  if (review) {
    const frames = Array.isArray(review.frames) ? review.frames : [];
    if (frames.length) add({ role: 'verification', kind: 'frame_render', outcome: 'passed', label: `已取得${frames.length}张实际采样图。`, revision: review.revision ?? revision(data, args), limitations: '仅所列采样帧；取帧完成不代表画面复核通过。' });
    add({ role: 'verification', kind: 'visual_review', outcome: review.status !== 'reviewed' || review.verdict === 'unknown' || !frames.length ? 'unavailable' : review.verdict === 'pass' ? 'passed' : 'issues', label: review.summary || '画面复核未完成。', revision: review.revision ?? revision(data, args), limitations: review.limitations || '只检查实际采样画面；未检查音频或未采样帧。' });
  }
  const preflights = tool === 'native_preflight' ? [data] : ['native_export', 'native_export_advanced'].includes(tool) ? [data.report, ...(Array.isArray(data.reports) ? data.reports : [])] : [];
  for (const report of preflights.slice(0, 8)) if (object(report?.checks) && typeof report.canExport === 'boolean') add({ role: 'verification', kind: 'native_preflight', outcome: report.canExport ? 'passed' : 'failed', label: report.canExport ? '导出体检已完成。' : '导出体检发现阻断问题。', revision: report.revision,
    limitations: report.checks.deep?.note || '结构与有限源素材检查；没有渲染最终合成全片。' });
  const cancelTool = ['remotion_cancel', 'native_export_cancel', 'task_cancel'].includes(tool);
  const jobTool = ['remotion_job', 'remotion_render', 'remotion_cancel', 'native_export', 'native_export_advanced', 'native_export_cancel', 'task_get', 'task_cancel', 'task_retry'].includes(tool);
  const actualJob = jobTool ? object(data.job) ? data.job : object(data.task) ? data.task : tool === 'native_export_cancel' && Array.isArray(data.exports) ? data.exports.find(item => item?.id === args.exportId) : null : null;
  if (actualJob && typeof actualJob.status === 'string') {
    const status = actualJob.status, keys = [...new Set([...jobKeys(actualJob), ...jobKeys(args), ...(id(actualJob.id) ? [actualJob.id] : [])])];
    const completed = ['complete', 'completed', 'succeeded', 'done'].includes(status);
    add({ role: 'job', kind: 'job_state', outcome: completed ? 'completed' : ['error', 'failed', 'interrupted'].includes(status) ? 'failed' : status === 'cancelled' ? 'cancelled' : 'pending', label: `任务状态：${status}`, jobIds: keys,
      code: actualJob.error?.code, limitations: completed ? '任务完成不等于已通过画面或音频检查。' : undefined });
    const requestedCancel = cancelTool || job.evidence.entries.some(entry => entry.kind === 'cancel_requested' && entry.jobIds?.some(key => keys.includes(key)));
    if (status === 'cancelled' && requestedCancel) add({ role: 'execution', kind: 'task_cancelled', outcome: 'completed', label: '已确认指定任务取消。', jobIds: keys });
    else if (cancelTool && !completed) add({ role: 'execution', kind: 'cancel_requested', outcome: 'completed', label: '已提交停止请求，尚需确认最终状态。', jobIds: keys });
    else if (cancelTool && completed) add({ role: 'read', kind: 'job_status', outcome: 'completed', label: '指定任务此前已经结束。', jobIds: keys });
    if (tool === 'task_retry') add({ role: 'execution', kind: 'task_retry_requested', outcome: 'completed', label: '已按任务服务的安全方式重试。', jobIds: keys });
    if (completed && Array.isArray(actualJob.result?.frames) && actualJob.result.frames.length) add({ role: 'verification', kind: 'frame_render', outcome: 'passed', label: `已生成${actualJob.result.frames.length}张预览帧。`, jobIds: keys, revision: actualJob.revision, limitations: '取帧完成；尚未据此进行视觉评审。' });
    if (completed && typeof actualJob.result?.videoUrl === 'string') add({ role: 'execution', kind: 'video_render', outcome: 'completed', label: '实际视频渲染已完成。', jobIds: keys, revision: actualJob.revision, limitations: '渲染完成不等于画面评审、音频检查或加入时间线。' });
  }
  if (tool === 'native_export_cancel' && !actualJob && data.cancellationRequested === true) {
    const keys = jobKeys({ ...args, ...data });
    add({ role: 'execution', kind: 'cancel_requested', outcome: 'completed', label: '已提交原生导出停止请求。', jobIds: keys });
    add({ role: 'job', kind: 'job_state', outcome: 'pending', label: '尚未确认原生导出的取消终态。', jobIds: keys });
  }
  // Optional extractors are functions registered by server code. Arbitrary
  // result.data.evidence, web text and planner JSON never enter this branch.
  for (const item of (Array.isArray(trustedEvidence) ? trustedEvidence : []).slice(0, 8)) if (object(item) && ROLES.has(item.role) && OUTCOMES.has(item.outcome)) {
    const key = text(item.resourceKey || resource(tool, args, data, job.projectId), clean, 260), version = revision({ revision: item.revision }, {});
    const existing = added.find(entry => entry.role === item.role && entry.kind === item.kind && entry.outcome === item.outcome && entry.resourceKey === key && entry.revision === version);
    if (existing) { if (item.label) existing.label = text(item.label, clean, 500); if (item.limitations) existing.limitations = text(item.limitations, clean, 1000); }
    else add(item);
  }
  compact(job); return added;
}

function latestJobStates(entries) {
  const states = [];
  for (const entry of entries.filter(value => value.role === 'job' && value.jobIds?.length)) {
    const matches = states.filter(state => state.jobIds.some(key => entry.jobIds.includes(key)));
    const merged = [...new Set([...matches.flatMap(state => state.jobIds), ...entry.jobIds])];
    for (const match of matches) states.splice(states.indexOf(match), 1);
    states.push({ ...entry, jobIds: merged });
  }
  return states;
}

export function buildAssistantReport(job, { executionExpected = false, terminalStatus = job.status, final = {}, clean = String } = {}) {
  const entries = job.evidence?.entries || [], byId = new Map(entries.map(entry => [entry.id, entry]));
  const executed = entries.filter(entry => entry.role === 'execution' && entry.outcome === 'completed');
  const unfinished = [], append = value => { if (!unfinished.some(item => item.code === value.code && item.evidenceId === value.evidenceId && item.planId === value.planId)) unfinished.push(value); };
  if (job.evidence?.omittedUnfinished) append({ code: 'ARCHIVED_UNFINISHED', label: '较早任务的未完成状态已归档，需要查看任务中心核实。' });
  for (const item of job.plan?.items || []) if (item.status !== 'completed') append({ code: 'PLAN_PENDING', label: item.label, planId: item.id });
  for (const item of job.plan?.items || []) if (item.kind === 'verify' && item.status === 'completed' && !item.evidenceIds.some(value => { const entry = byId.get(value); return entry?.role === 'verification' && entry.outcome === 'passed' && !entry.superseded; })) append({ code: 'VERIFICATION_STALE', label: `${item.label}：检查后工程已有修改，需要重新核对。`, planId: item.id });
  for (const entry of latestJobStates(entries)) if (entry.outcome !== 'completed' && !(entry.outcome === 'cancelled' && entries.some(other => other.kind === 'task_cancelled' && other.jobIds?.some(key => entry.jobIds.includes(key))))) append({ code: entry.outcome === 'pending' ? 'JOB_PENDING' : 'JOB_NOT_COMPLETED', label: entry.label, evidenceId: entry.id });
  const currentChecks = new Map(); for (const entry of entries) if (entry.role === 'verification') currentChecks.set(`${entry.resourceKey}:${entry.kind}`, entry);
  const verified = [...currentChecks.values()].filter(entry => entry.outcome === 'passed' && !entry.superseded);
  for (const entry of currentChecks.values()) if (!entry.superseded && entry.outcome !== 'passed') append({ code: 'CHECK_NOT_PASSED', label: entry.label, evidenceId: entry.id });
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry.role !== 'failure') continue;
    const corrected = entries.slice(index + 1).some(later => later.tool === entry.tool && later.role !== 'failure');
    if (!corrected) append({ code: entry.code || 'TOOL_FAILED', label: entry.label, evidenceId: entry.id });
  }
  const noChangeIds = ids(final.noChangeNeeded?.evidenceIds), noChange = noChangeIds.length > 0 && noChangeIds.every(value => { const entry = byId.get(value); return entry && stateRead(entry) && entry.outcome === 'completed' && !entry.stale; });
  const expects = executionExpected || (job.plan?.items || []).some(item => ['change', 'deliver'].includes(item.kind));
  if (expects && !executed.length && !noChange) append({ code: 'NO_EXECUTION_RECEIPT', label: '尚无对应写入或成品凭据。' });
  if (['cancelled', 'interrupted', 'failed'].includes(terminalStatus)) append({ code: job.error?.code || (terminalStatus === 'cancelled' ? 'REQUEST_CANCELLED' : 'TASK_NOT_FINISHED'), label: job.error?.message || (terminalStatus === 'cancelled' ? '已停止后续操作。' : '本次处理未完成。') });
  const outcome = terminalStatus === 'cancelled' ? 'stopped' : unfinished.length ? 'partial' : noChange && !executed.length ? 'unchanged' : !expects && !executed.length ? 'answer' : 'complete';
  const report = { version: 1, outcome, executed: executed.slice(-20).map(entry => entry.id), verified: verified.slice(-20).map(entry => entry.id), unfinished: unfinished.slice(-30),
    ...(noChange ? { noChangeNeeded: { evidenceIds: noChangeIds, reason: text(final.noChangeNeeded.reason || '实际读取后判断已符合本次要求。', clean, 500) } } : {}) };
  job.report = report; return report;
}

export function assistantRecoveryHint(error, tool) {
  const code = String(error?.code || '');
  if (/REVISION_CONFLICT|ASSISTANT_CONFLICT/.test(code)) return { code, tool, action: '先读取当前工程或源码的真实版本与差异，再按本轮目标重新判断；不能覆盖并发人工修改，也不能重播旧写入。' };
  if (/(?:READ|IMPORT|DOWNLOAD)_SOURCE$/.test(code)) return { code, tool, action: '使用allowedUserUrls或allowedReadUrls中的完整原样候选；没有合适来源时先搜索，不能拼改路径或查询参数。' };
  if (/TOOL_ARGUMENTS|TOOL_UNAVAILABLE|CAPABILITY_UNAVAILABLE/.test(code)) return { code, tool, action: '读取app_capabilities与app_tool_schema的真实能力和参数后调整；不要重复同一无效调用。' };
  if (/NOT_FOUND|FILE_NOT_FOUND/.test(code)) return { code, tool, action: '先列出或搜索当前工程中的真实对象编号和路径，读取后再操作；不能猜测编号。' };
  return null;
}
export function isReferenceRebuildRequest(instruction) {
  return /逐镜|逐帧|(?:参考|原片|视频|画面).{0,16}(?:重建|重制|复刻|模仿)|(?:重建|重制|复刻|模仿).{0,16}(?:参考|原片|视频|画面)|(?:完整|完全).{0,8}(?:模仿|复刻)|frame.by.frame|shot.by.shot|(?:rebuild|reconstruct|replicate).{0,20}(?:reference|video|footage)/i.test(String(instruction || ''));
}

/** Bounded restore independent of older steps and arbitrary result bodies. */
export function restoreAssistantTaskState(input, clean = String) {
  if (input?.reportVersion !== 1) return {};
  const entries = [], seen = new Set();
  for (const raw of (Array.isArray(input?.evidence?.entries) ? input.evidence.entries : []).slice(-EVIDENCE_LIMIT)) {
    if (!object(raw) || !/^E[1-9]\d{0,8}$/.test(raw.id || '') || seen.has(raw.id) || !ROLES.has(raw.role) || !OUTCOMES.has(raw.outcome)) continue;
    seen.add(raw.id); entries.push({ id: raw.id, stepId: text(raw.stepId, clean, 100), tool: text(raw.tool, clean, 80), role: raw.role, kind: text(raw.kind, clean, 80), outcome: raw.outcome,
      label: text(raw.label, clean, 500), resourceKey: text(raw.resourceKey, clean, 260), at: text(raw.at, clean, 40), ...(raw.revision !== undefined ? { revision: revision({ revision: raw.revision }, {}) } : {}),
      ...(raw.superseded === true ? { superseded: true } : {}), ...(raw.stale === true ? { stale: true } : {}), ...(raw.limitations ? { limitations: text(raw.limitations, clean, 1000) } : {}), ...(raw.code ? { code: text(raw.code, clean, 100) } : {}), ...(raw.jobIds ? { jobIds: ids(raw.jobIds) } : {}) });
  }
  const total = Math.max(Number.isSafeInteger(input?.evidence?.total) && input.evidence.total >= 0 ? input.evidence.total : 0, ...entries.map(entry => Number(entry.id.slice(1))));
  const result = { reportVersion: 1, evidence: { version: 1, total, omitted: Math.max(0, total - entries.length), ...(input.evidence?.omittedUnfinished === true ? { omittedUnfinished: true } : {}), entries } };
  if (Array.isArray(input?.plan?.items)) {
    const items = input.plan.items.slice(0, PLAN_LIMIT).filter(item => object(item) && id(item.id) && KINDS.has(item.kind) && STATES.has(item.status)).map(item => ({ id: item.id.slice(0, 80), label: text(item.label, clean, 180), kind: item.kind, status: item.status, evidenceIds: ids(item.evidenceIds).filter(value => seen.has(value)) }));
    result.plan = { version: 1, items, note: text(input.plan.note, clean, 500), updatedAt: text(input.plan.updatedAt, clean, 40) };
  }
  if (object(input?.report) && ['answer', 'complete', 'partial', 'unchanged', 'stopped'].includes(input.report.outcome)) {
    const report = input.report;
    result.report = { version: 1, outcome: report.outcome, executed: ids(report.executed, 20).filter(value => seen.has(value)), verified: ids(report.verified, 20).filter(value => seen.has(value)),
      unfinished: (Array.isArray(report.unfinished) ? report.unfinished : []).slice(-30).filter(object).map(item => ({ code: text(item.code, clean, 100), label: text(item.label, clean, 1000), ...(id(item.evidenceId) && seen.has(item.evidenceId) ? { evidenceId: item.evidenceId } : {}), ...(id(item.planId) ? { planId: item.planId } : {}) })),
      ...(object(report.noChangeNeeded) ? { noChangeNeeded: { evidenceIds: ids(report.noChangeNeeded.evidenceIds).filter(value => seen.has(value)), reason: text(report.noChangeNeeded.reason, clean, 500) } } : {}) };
  }
  return result;
}
