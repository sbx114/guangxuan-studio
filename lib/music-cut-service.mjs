import path from 'node:path';
import { mkdir, readFile, writeFile, rename, unlink, lstat, realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { AppError, requireObject } from './errors.mjs';
import { validateProjectId } from './store.mjs';
import { buildMusicCutPlan } from './music-cut-plan.mjs';
import { normalizeEditScope } from './edit-scope.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (status, code, message) => new AppError(status, message, code);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const check = signal => { if (signal?.aborted) throw fail(499, 'REQUEST_CANCELLED', '音乐卡点已停止，已有内容保留。'); };
const finite = (value, label) => { if (!Number.isFinite(value) || value < 0) throw fail(400, 'MUSIC_CUT_INPUT', label + '需要有效非负秒数。'); return value; };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])) : value;
const clone = value => structuredClone(value);
function permissions(context) {
  const normalize = value => {
    if (value == null) return null;
    const scope = normalizeEditScope({ ...requireObject(value, '卡点权限范围'), placement: value.placement || { mode: 'free' } });
    if (scope.placement.mode === 'range') { scope.placement.start = value.placement.start; scope.placement.end = value.placement.end; }
    if (scope.assetIds) scope.assetIds.sort(); if (scope.placement.clipIds) scope.placement.clipIds.sort();
    return scope;
  };
  const first = normalize(context.editScope), second = normalize(context.scope);
  if (first && second && hash(canonical(first)) !== hash(canonical(second))) throw fail(403, 'MUSIC_CUT_CONTEXT_CONFLICT', '两份权限范围不一致，请基于当前范围重新处理。');
  if (context.mode !== undefined && !['auto', 'ask'].includes(context.mode)) throw fail(403, 'MUSIC_CUT_MODE', '卡点权限模式无效。');
  return { mode: context.mode || 'auto', scope: first || second };
}
export function musicCutRequestSignature(input, context = {}) {
  const value = { ...requireObject(input, '卡点操作参数') }; delete value.requestId;
  return hash(canonical({ input: value, permissions: permissions(context) }));
}
const progress = (context, text) => { try { Promise.resolve(context.update?.(text)).catch(() => {}); } catch {} };
const scopeAllows = (scope, affected) => !scope || !!affected && !['append', 'insert'].includes(scope.placement?.mode) && !(scope.placement?.mode === 'range' && (affected.range.start < scope.placement.start - 1e-8 || affected.range.end > scope.placement.end + 1e-8)) && !(scope.assetIds && affected.assetIds.some(id => !scope.assetIds.includes(id))) && !(scope.placement?.clipIds && (!affected.clipIds || affected.clipIds.some(id => !scope.placement.clipIds.includes(id))));

export async function createMusicCutService({ dataDir, store, openFilm, dependencies = {} }) {
  if (!dataDir || typeof store?.read !== 'function' || !['readMusicRhythm', 'applyMusicCutPlan', 'context', 'undoAssistant'].every(name => typeof openFilm?.[name] === 'function')) throw fail(503, 'MUSIC_CUT_NOT_CONFIGURED', '音乐卡点服务尚未配置。');
  await mkdir(dataDir, { recursive: true }); const root = await realpath(dataDir);
  const folder = path.join(root, 'music-cuts'), filename = path.join(folder, 'operations.json');
  await mkdir(folder, { recursive: true });
  if ((await lstat(folder)).isSymbolicLink() || await realpath(folder) !== folder) throw fail(500, 'MUSIC_CUT_STATE', '音乐操作目录必须是普通私有目录。');
  const records = new Map(), running = new Map(), analyses = new Set(), closing = new AbortController(); let saves = Promise.resolve(), closed = false;
  const stateWrite = dependencies.writeFile || writeFile;
  try { const info = await lstat(filename); if (!info.isFile() || info.isSymbolicLink() || info.size > 20 * 1024 * 1024) throw new Error(); const value = JSON.parse(await readFile(filename, 'utf8')); if (value.version !== 1 || !Array.isArray(value.operations)) throw new Error(); for (const record of value.operations) { if (!uuid(record.id) || typeof record.projectId !== 'string' || typeof record.ownerCreatedAt !== 'string' || !/^[a-f0-9]{64}$/.test(record.signature || '') || !['pending', 'completed', 'completed-pruned', 'failed-before-write', 'undone'].includes(record.status) || records.has(record.id.toLowerCase())) throw new Error(); record.id = record.id.toLowerCase(); records.set(record.id, record); } }
  catch (error) { if (error.code !== 'ENOENT') throw fail(500, 'MUSIC_CUT_STATE', '音乐卡点操作记录无法读取，原记录保留。'); }
  const save = () => {
    const all = [...records.values()].filter(value => value.status !== 'analyzing'), fullResults = new Set(all.filter(value => value.status === 'completed').slice(-200).map(value => value.id));
    const operations = all.map(record => {
      if (record.status !== 'completed' || fullResults.has(record.id)) return record;
      const retained = { id: record.id, projectId: record.projectId, ownerCreatedAt: record.ownerCreatedAt, signature: record.signature, scopeHash: record.scopeHash, status: 'completed-pruned', createdAt: record.createdAt, beforeRevision: record.beforeRevision };
      records.set(record.id, retained); return retained;
    });
    const text = JSON.stringify({ version: 1, operations });
    if (Buffer.byteLength(text) > 20 * 1024 * 1024) throw fail(507, 'MUSIC_CUT_STATE_LIMIT', '音乐操作记录超过可保存容量，已有未知写入身份不会删除。');
    saves = saves.catch(() => {}).then(async () => { const temporary = filename + '.' + randomUUID() + '.tmp'; try { await stateWrite(temporary, text, { flag: 'wx', mode: 0o600 }); await rename(temporary, filename); } finally { await unlink(temporary).catch(() => {}); } }); return saves;
  };
  async function owner(projectId) { const project = await store.read(validateProjectId(projectId)); if (!project || project.kind !== 'video') throw fail(404, 'MUSIC_CUT_PROJECT', '请打开仍存在的剪辑工程。'); return project; }
  async function sameOwner(project) { const current = await owner(project.id); if (current.createdAt !== project.createdAt) throw fail(409, 'MUSIC_CUT_OWNER_CHANGED', '工程已重新创建，旧操作不能用于当前工程。'); return current; }
  const runtimeContext = context => ({ ...context, signal: context.signal ? AbortSignal.any([context.signal, closing.signal]) : closing.signal });
  async function analyzeOwned(input, context) {
    requireObject(input, '音乐分析参数'); check(context.signal); await owner(input.projectId);
    if (!input.musicAssetId && !input.musicClipId) throw fail(400, 'MUSIC_CUT_SOURCE', '请选定当前工程的音乐素材或音乐片段。');
    const value = await openFilm.readMusicRhythm(input.projectId, input.musicAssetId, context.origin || '', { clipId: input.musicClipId, range: input.sourceRange, signal: context.signal });
    check(context.signal);
    if (input.sourcePath !== undefined && input.sourcePath !== value.sourcePath || input.sourceVersion !== undefined && input.sourceVersion !== value.sourceVersion) throw fail(409, 'MUSIC_CUT_SOURCE_CHANGED', '音乐文件或范围已有更新，请重新识别。');
    return value;
  }
  async function analyze(input, context = {}) {
    if (closed) throw fail(503, 'MUSIC_CUT_CLOSED', '音乐服务已关闭。'); input = clone(requireObject(input, '音乐分析参数')); const active = analyzeOwned(input, runtimeContext(context)); analyses.add(active); try { return await active; } finally { analyses.delete(active); }
  }
  async function cut(input, context = {}) {
    if (closed) throw fail(503, 'MUSIC_CUT_CLOSED', '音乐服务已关闭。'); input = clone(requireObject(input, '音乐卡点参数')); const permission = permissions(context); context = runtimeContext(context);
    if (permission.mode === 'ask') throw fail(403, 'MUSIC_CUT_READ_ONLY', '只读模式不会写音乐卡点。');
    for (const key of ['allowUncertain', 'reuseSources']) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw fail(400, 'MUSIC_CUT_INPUT', '不确定/循环选项需要明确布尔值。');
    for (const key of ['originalVolume', 'musicVolume']) if (input[key] !== undefined && (!Number.isFinite(input[key]) || input[key] < 0 || input[key] > 4)) throw fail(400, 'MUSIC_CUT_INPUT', '音量需要0至4的有限数值。');
    const project = await owner(input.projectId); check(context.signal);
    let requestId = input.requestId || randomUUID(); if (!uuid(requestId)) throw fail(400, 'MUSIC_CUT_OPERATION_ID', '卡点操作编号无效。'); requestId = requestId.toLowerCase();
    const signature = musicCutRequestSignature(input, { mode: permission.mode, editScope: permission.scope || undefined }), scopeHash = hash(canonical(permission));
    const cached = records.get(requestId);
    if (cached) {
      if (cached.projectId !== project.id || cached.ownerCreatedAt !== project.createdAt || cached.signature !== signature) throw fail(409, 'MUSIC_CUT_OPERATION_CHANGED', '这条卡点操作不属于当前工程或输入已有变化。');
      if (running.has(requestId)) return running.get(requestId);
      if (cached.status !== 'completed' || !cached.result) throw fail(409, 'MUSIC_CUT_UNCONFIRMED', '原操作没有可核对的完成回执，请先检查工程；不会重播未知写入。');
      const latest = await openFilm.context(project.id, context.origin || '');
      if (latest.revision !== cached.result.revision) throw fail(409, 'MUSIC_CUT_CHANGED', '工程在上次卡点后已有修改，请基于当前工程重新处理。');
      await sameOwner(project); check(context.signal); return { ...clone(cached.result), reusedOperation: true };
    }
    records.set(requestId, { id: requestId, projectId: project.id, ownerCreatedAt: project.createdAt, signature, scopeHash, status: 'analyzing' });
    const operation = (async () => {
      progress(context, '正在识别音乐节奏');
      const rhythm = await analyzeOwned(input, context); check(context.signal);
      const current = await openFilm.context(project.id, context.origin || '');
      await sameOwner(project); check(context.signal);
      if (current.revision !== rhythm.nativeRevision || input.expectedRevision !== undefined && input.expectedRevision !== current.revision) throw fail(409, 'MUSIC_CUT_CHANGED', '工程在节奏识别期间已有修改，请重新读取后再处理。');
      const clip = rhythm.musicClip;
      const constraint = permission.scope?.placement;
      if (constraint?.mode === 'insert') throw fail(403, 'MUSIC_CUT_PLACEMENT_MODE', '音乐卡点定向修改范围，不会擅自挤出其它片段；请明确范围。');
      const baseMusic = clip ? { assetId: rhythm.assetId, sourceStart: clip.sourceStart, sourceEnd: clip.sourceEnd, timelineAt: clip.timelineAt, speed: clip.speed, volume: clip.volume } : {
        assetId: rhythm.assetId, sourceStart: input.sourceRange?.start ?? rhythm.coverage.requestedStart ?? rhythm.coverage.start, sourceEnd: input.sourceRange?.end ?? rhythm.coverage.requestedEnd ?? rhythm.coverage.end, timelineAt: input.timelineAt ?? (constraint?.mode === 'append' ? current.duration : 0), speed: input.musicSpeed ?? 1, volume: input.musicVolume ?? .7,
      };
      const sourceStart = Math.max(baseMusic.sourceStart, rhythm.coverage.start), sourceEnd = Math.min(baseMusic.sourceEnd, rhythm.coverage.end);
      if (!(sourceEnd > sourceStart) || !Number.isFinite(baseMusic.speed) || baseMusic.speed <= 0) throw fail(409, 'MUSIC_CUT_ANALYSIS_RANGE', '实际分析覆盖与所选音乐没有可用交集。');
      const selectedMusic = { ...baseMusic, sourceStart, sourceEnd, timelineAt: baseMusic.timelineAt + (sourceStart - baseMusic.sourceStart) / baseMusic.speed };
      const span = { start: selectedMusic.timelineAt, end: selectedMusic.timelineAt + (selectedMusic.sourceEnd - selectedMusic.sourceStart) / selectedMusic.speed };
      const range = input.range || (constraint?.mode === 'range' ? { start: Math.max(span.start, constraint.start), end: Math.min(span.end, constraint.end) } : span);
      finite(range.start, '目标起点'); finite(range.end, '目标终点');
      if (range.end <= range.start || range.start < span.start - 1e-8 || range.end > span.end + 1e-8 || constraint?.mode === 'range' && (range.start < constraint.start - 1e-8 || range.end > constraint.end + 1e-8)) throw fail(403, 'MUSIC_CUT_RANGE', '卡点范围必须位于选定音乐和当前允许的作品区间内。');
      if (constraint?.mode === 'append' && range.start < current.duration - 1e-8) throw fail(403, 'MUSIC_CUT_RANGE', '末尾追加不能覆盖当前作品已有范围。');
      const permitted = permission.scope?.assetIds ? new Set(permission.scope.assetIds) : null;
      const available = current.assets.filter(asset => ['video', 'image'].includes(asset.type) && (!permitted || permitted.has(asset.id)));
      let candidates;
      if (input.assetIds !== undefined) {
        if (!Array.isArray(input.assetIds) || !input.assetIds.length || input.assetIds.length > 256 || new Set(input.assetIds).size !== input.assetIds.length) throw fail(400, 'MUSIC_CUT_ASSETS', '请选择当前工程1至256个不同画面素材。');
        candidates = input.assetIds.map(id => { const asset = available.find(value => value.id === id); if (!asset) throw fail(403, 'MUSIC_CUT_ASSETS', '卡点计划不能使用未选或工程外的画面素材。'); return asset; });
      } else {
        candidates = (current.timeline || []).filter(value => available.some(asset => asset.id === value.assetId)).map(value => ({ ...available.find(asset => asset.id === value.assetId), sourceRange: { start: value.start, end: value.end } }));
        if (!candidates.length) candidates = available;
      }
      if (!candidates.length) throw fail(409, 'MUSIC_CUT_ASSETS', '请先导入视频或图片画面素材，再按音乐卡点。');
      progress(context, '正在按实际拍点编排画面');
      const plan = buildMusicCutPlan({ rhythm, music: selectedMusic, assets: candidates, placement: range, cadence: input.cadence || 'auto', allowUncertain: input.allowUncertain === true, reuseSources: input.reuseSources === true, signal: context.signal });
      if (!plan.canApply) throw fail(409, plan.reason?.code || 'MUSIC_CUT_BLOCKED', typeof plan.reason === 'string' ? plan.reason : plan.reason?.message || plan.warnings?.at(-1) || '当前音乐或素材不足以可靠卡点。');
      check(context.signal);
      const record = { id: requestId, projectId: project.id, ownerCreatedAt: project.createdAt, signature, scopeHash, affected: { range: clone(range), assetIds: [...new Set(plan.timeline.map(item => item.assetId))], clipIds: constraint?.clipIds }, status: 'pending', createdAt: new Date().toISOString(), beforeRevision: current.revision };
      records.set(requestId, record); await save();
      let dispatched = false;
      try {
        check(context.signal); await sameOwner(project); check(context.signal); progress(context, '正在将卡点计划写入时间线'); check(context.signal); dispatched = true;
        const applied = await openFilm.applyMusicCutPlan(project.id, plan, context.origin || '', current.revision, { keepUndo: true, editScope: { ...permission.scope, placement: { mode: 'range', start: range.start, end: range.end, ...(constraint?.clipIds ? { clipIds: constraint.clipIds } : {}) } }, signal: context.signal, existingMusicClipId: clip?.id, originalVolume: input.originalVolume ?? 0 });
        const result = { ...applied, requestId, bpm: rhythm.bpm, tempoConfidence: rhythm.tempoConfidence, beatCount: plan.observedBeatCount, cutTimes: applied.cutTimes || plan.cutTimes, plannedCutTimes: plan.cutTimes, warnings: plan.warnings,
          summary: `已按音乐节奏编排${plan.timeline.length}段画面，使用${plan.cutTimes.length}个实际卡点。`, ...(applied.nativeUndoId ? { undo: { id: applied.nativeUndoId, label: '撤销音乐卡点' } } : {}) };
        result.operationRecordPersisted = true; record.status = 'completed'; record.result = clone(result);
        try { await save(); } catch {
          result.operationRecordPersisted = false;
          result.warnings = [...result.warnings, '原生卡点已经提交并返回回执，但附加操作记录保存失败；已有结果保留，重启后不会自动重播未确认记录。'];
          record.result = clone(result);
        }
        await sameOwner(project); return clone(result);
      } catch (error) {
        // Never remove a pending intent after a possibly committed write.
        if (!dispatched && record.status !== 'completed') { record.status = 'failed-before-write'; await save(); }
        throw error;
      }
    })();
    running.set(requestId, operation);
    try { return await operation; } catch (error) { if (records.get(requestId)?.status === 'analyzing') records.delete(requestId); throw error; } finally { running.delete(requestId); }
  }
  async function undo(input, context = {}) {
    if (closed) throw fail(503, 'MUSIC_CUT_CLOSED', '音乐服务已关闭。'); input = clone(requireObject(input, '音乐撤销参数')); const permission = permissions(context); context = runtimeContext(context);
    if (permission.mode === 'ask') throw fail(403, 'MUSIC_CUT_READ_ONLY', '只读模式不会撤销音乐卡点。');
    const project = await owner(input.projectId); check(context.signal);
    const record = [...records.values()].find(value => value.projectId === project.id && value.ownerCreatedAt === project.createdAt && value.status === 'completed' && value.result?.nativeUndoId === input.undoId);
    if (!record) throw fail(409, 'MUSIC_CUT_UNDO', '没有当前工程可核对的卡点撤销记录。');
    if (!scopeAllows(permission.scope, record.affected)) throw fail(403, 'MUSIC_CUT_UNDO_SCOPE', '当前权限范围不能撤销该操作的全部影响。');
    const latest = await openFilm.context(project.id, context.origin || ''); await sameOwner(project); check(context.signal);
    if (latest.revision !== record.result.revision) throw fail(409, 'MUSIC_CUT_CHANGED', '卡点后已有其它编辑，不能覆盖它们撤销。');
    const result = await openFilm.undoAssistant(project.id, input.undoId, context.origin || ''); record.status = 'undone'; await save(); return clone(result);
  }
  async function status(projectId, requestId, context = {}) { const project = await owner(projectId), record = records.get(String(requestId).toLowerCase()); check(context.signal); if (!record || record.projectId !== project.id || record.ownerCreatedAt !== project.createdAt) throw fail(404, 'MUSIC_CUT_OPERATION_NOT_FOUND', '这条音乐卡点记录不属于当前工程。'); const permission = permissions(context); if (permission.scope && !scopeAllows(permission.scope, record.affected)) throw fail(403, 'MUSIC_CUT_OPERATION_SCOPE', '当前权限不能读取该操作的范围结果。'); return { requestId: record.id, status: record.status, ...(record.status === 'completed' ? { result: clone(record.result) } : {}) }; }
  return { analyze, cut, undo, status, async close() { closed = true; closing.abort(); await Promise.allSettled([...running.values(), ...analyses]); await saves.catch(() => {}); } };
}
