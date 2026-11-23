import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { AppError, boundedString, requireObject } from './errors.mjs';
import { assistantContentHash, validateProjectId } from './store.mjs';
import { runAi } from './ai.mjs';
import { normalizeModelData } from './prompts.mjs';
import { normalizeEditScope, scopedAssets } from './edit-scope.mjs';
import { contextForEditScope } from '../public/editor-scope.js';
import { serializePlayableNovel } from './visual-novel.mjs';
import { normalizePublicAssistantUrl } from './assistant-web.mjs';
import { writingSourceFingerprint, writingOutputText } from '../public/writing-model.js';
import { NATIVE_ADJUST_ACTIONS, NATIVE_MAX_TIME_SECONDS } from './native-adjustments.mjs';
import { searchRemotionReferences, readRemotionReference } from './remotion-reference-library.mjs';
import { createProductionCapabilityTools, restoreProductionUndo } from './assistant-production-tools.mjs';
import { createAuthoringCapabilityTools } from './assistant-authoring-tools.mjs';
import { resolveAssistantScope, setAssistantScope } from './assistant-permissions.mjs';
import { createProjectCapabilityTools, restoreProjectCapabilityUndo } from './assistant-project-tools.mjs';
import { createRemotionCodeTools } from './assistant-remotion-code-tools.mjs';
import { createWritingReferenceService, normalizeWritingReferenceConfig } from './writing-references.mjs';
import { createAssistantWritingReferenceTools } from './assistant-writing-reference-tools.mjs';
import { runReviewedRemotion } from './remotion-workflow.mjs';
import { createAssistantReferenceContext, ASSISTANT_FRAME_NOTES_SCHEMA } from './assistant-reference-context.mjs';
import { isReferenceRebuildRequest } from './assistant-task-state.mjs';
import { collectProjectMedia } from './project-media.mjs';
import { assistantWritingFingerprint, normalizeAssistantWritingContext, currentAssistantWritingContext, writingSelectionRequired } from './assistant-writing-context.mjs';
import { normalizeWritingInput } from './writing.mjs';
import { appendWritingMaterial, normalizeWritingMaterials } from './assistant-materials.mjs';

const clone = value => value === undefined ? undefined : structuredClone(value);
const fail = (status, message, code) => new AppError(status, message, code);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const schema = (properties = {}, required = []) => ({ type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}) });
const textField = maxLength => ({ type: 'string', minLength: 1, maxLength });
const remotionSamplingRequestsSchema = { type: 'array', maxItems: 3, items: schema({
  kind: { type: 'string', enum: ['action', 'hold', 'ending', 'transition'] },
  shotId: textField(120),
  times: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'number', minimum: 0 } },
  reason: { type: 'string', maxLength: 500 },
}, ['kind', 'times']) };
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const CHANNELS = ['article', 'poster', 'video', 'social'];
const preciseEditSchema = schema({ edits: { type: 'array', minItems: 1, maxItems: 40, items: schema({
  action: { type: 'string', enum: NATIVE_ADJUST_ACTIONS }, clipId: textField(200),
  at: { type: 'number', minimum: 0 }, start: { type: 'number', minimum: 0, maximum: NATIVE_MAX_TIME_SECONDS }, end: { type: 'number', minimum: 0, maximum: NATIVE_MAX_TIME_SECONDS },
  value: { type: 'number', minimum: 0, maximum: 16 }, in: { type: 'number', minimum: 0, maximum: 30 }, out: { type: 'number', minimum: 0, maximum: 30 },
  x: { type: 'number', minimum: -16000, maximum: 16000 }, y: { type: 'number', minimum: -16000, maximum: 16000 }, width: { type: 'number', minimum: 1, maximum: 16000 }, height: { type: 'number', minimum: 1, maximum: 16000 },
  scale: { type: 'number', minimum: .1, maximum: 4 }, rotation: { type: 'number', minimum: -360, maximum: 360 }, opacity: { type: 'number', minimum: 0, maximum: 1 },
  preset: { type: 'string', enum: ['none', 'warm', 'cool', 'cinematic', 'soft', 'vivid', 'mono'] }, strength: { type: 'number', minimum: 0, maximum: 1 },
  property: { type: 'string', enum: ['translate', 'scale', 'rotate', 'opacity'] }, mode: { type: 'string', enum: ['patch', 'replace'] }, replaceAll: { type: 'boolean' }, expectedMotionHash: { type: 'string', minLength: 64, maxLength: 64 }, keys: { type: 'array', maxItems: 40, items: schema({ time: { type: 'number', minimum: 0 }, value: { type: 'number', minimum: -360, maximum: 360 }, x: { type: 'number', minimum: -16000, maximum: 16000 }, y: { type: 'number', minimum: -16000, maximum: 16000 }, easing: { type: 'string', enum: ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'hold'] } }, ['time']) },
  text: textField(2000), fontSize: { type: 'number', minimum: 8, maximum: 200 }, color: { type: 'string', minLength: 7, maxLength: 7 }, fontWeight: { type: 'integer', enum: [400, 500, 600, 700, 800] }, align: { type: 'string', enum: ['left', 'center', 'right'] }, placement: { type: 'string', enum: ['title', 'center', 'bottom'] },
}, ['action', 'clipId']) } }, ['edits']);
function nativeSummary(value, scope) {
  const scoped = contextForEditScope(value, scope);
  const selected = scopedAssets(scoped.assets || [], scope);
  const assets = selected.slice(0, 100).map(({ id, name, type, duration, width, height, generated, generatedType }) => ({ id, name, type, duration, width, height, ...(typeof generated==='boolean'?{generated}:{}), ...(generatedType?{generatedType}:{}) }));
  const ids = new Set(assets.map(item => item.id));
  const timeline = (scoped.timeline || []).filter(item => ids.has(item.assetId));
  const complete = selected.length === assets.length && timeline.length === (scoped.timeline || []).length && timeline.length <= 200;
  return { assets, assetCount:selected.length, timelineCount:timeline.length, overviewComplete:complete, timeline: timeline.slice(0, 200).map(({ id, assetId, start, end, at, speed }) => ({ id, assetId, start, end, at, speed })), duration: value.duration, aspect: value.aspect, mainTrackEditable: value.mainTrackEditable === true && complete, warnings: [...(value.warnings || []), ...(!complete ? ['时间线概览有截断，请用native_inspect的offset/limit继续读取；精确编辑仍可用，不能按截断概览重建完整主轨。'] : [])].slice(0, 10), revision: value.revision };
}
function nativeAssetSummary(native, media, args = {}) {
  const integer = (value, fallback, minimum, maximum, label) => {
    const number = value === undefined ? fallback : value;
    if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw fail(400, label + '不在有效范围内。', 'ASSISTANT_ASSET_PAGE');
    return number;
  };
  const offset = integer(args.assetOffset, 0, 0, 1000000, '素材偏移'), limit = integer(args.assetLimit, 100, 1, 200, '每页素材数');
  if (args.type !== undefined && !['video', 'image', 'audio'].includes(args.type) || args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 200 || /\0/.test(args.query))) throw fail(400, '素材查询参数无效。', 'ASSISTANT_ASSET_PAGE');
  const query = (args.query || '').trim().toLocaleLowerCase();
  const selected = media.assets.filter(asset => (!args.type || asset.type === args.type) && (!query || String(asset.name || '').toLocaleLowerCase().includes(query) || asset.id.toLocaleLowerCase().includes(query)));
  const assets = selected.slice(offset, offset + limit).map(({ id, name, type, duration, width, height, generated, generatedType, provenance }) => {
    const registration = media.registrations.get(id);
    return { id, name: String(name || '').split(/[\\/]/).at(-1).slice(0, 240), type, duration, width, height, ...(typeof generated === 'boolean' ? { generated } : {}), ...(generatedType ? { generatedType } : {}), ...(provenance ? { provenance } : {}), source: registration.nativeImported ? 'native' : 'reference', sources: [...(registration.nativeImported ? ['native'] : []), ...(registration.referenceIds.length ? ['reference'] : [])], registration };
  });
  const timeline = native.timeline || [], assetsComplete = offset === 0 && assets.length === selected.length && selected.length === media.assets.length, timelineComplete = timeline.length <= 200;
  const overviewComplete = assetsComplete && timelineComplete;
  const nextAssetOffset = offset + assets.length < selected.length ? offset + assets.length : null;
  return { assets, assetCount: selected.length, totalAssetCount: media.assets.length, nativeAssetCount: media.assets.filter(asset => media.registrations.get(asset.id).nativeImported).length, referenceAssetCount: media.assets.filter(asset => media.registrations.get(asset.id).referenceIds.length).length,
    assetOffset: offset, assetLimit: limit, returnedAssetCount: assets.length, nextAssetOffset, assetsComplete,
    ownerCreatedAt: media.ownerCreatedAt, assetCatalogVersion: digest([media.ownerCreatedAt, native.revision, media.referenceRevision, media.assets.map(asset => [asset.id, asset.name, asset.type, asset.duration, asset.provenance, media.registrations.get(asset.id)])]),
    assetPage: { offset, limit, total: selected.length, totalInProject: media.assets.length, returned: assets.length, nextOffset: nextAssetOffset, hasMore: nextAssetOffset !== null, ...(args.type ? { type: args.type } : {}), ...(query ? { query: args.query } : {}) },
    timelineCount: timeline.length, timelineComplete, overviewComplete, timeline: timeline.slice(0, 200).map(({ id, assetId, start, end, at, speed }) => ({ id, assetId, start, end, at, speed })), duration: native.duration, aspect: native.aspect, mainTrackEditable: native.mainTrackEditable === true && overviewComplete, revision: native.revision,
    warnings: [...(native.warnings || []), ...(!assetsComplete ? ['素材页不是整个工程素材库；保留相同type/query，用native_read的nextAssetOffset继续，按素材id去重。'] : []), ...(!timelineComplete ? ['时间线概览有截断，请用native_inspect的offset/limit继续读取；不能按截断概览重建完整主轨。'] : [])].slice(0, 10) };
}
function preciseTimelineSummary(native, scope, wholeProject = false) {
  if (!native.editorTimeline) return { available: false, note: '当前剪辑服务尚未提供精确片段上下文，请刷新应用。' };
  const place = scope?.placement;
  const inSelectedAssets = clip => !scope?.assetIds || scope.assetIds.includes(clip.assetId) || clip.caption;
  const clips = native.editorTimeline.clips.filter(clip => wholeProject || inSelectedAssets(clip) &&
    (place?.mode !== 'range' || clip.at < place.end && clip.end > place.start) &&
    (!place?.clipIds?.length || place.clipIds.includes(clip.id))).map(clip => {
      if (!wholeProject) return clip;
      const reason = !inSelectedAssets(clip) ? '此片段不在当前明确写入素材范围内。'
        : place?.clipIds?.length && !place.clipIds.includes(clip.id) ? '此片段不在当前明确写入片段范围内。'
          : place?.mode === 'range' && (clip.at < place.start - .001 || clip.end > place.end + .001) ? '此片段超出当前明确写入时间范围。' : '';
      return { ...clip, withinEditScope: !reason, ...(reason ? { editable: false, unavailableReason: clip.unavailableReason || reason } : {}) };
    });
  const tracks = wholeProject ? native.editorTimeline.tracks.map(track => ({ ...track, returnedClipCount: clips.filter(clip => clip.track === track.index).length })) : native.editorTimeline.scopeFiltered === true
    ? native.editorTimeline.tracks.map(track => ({ ...track, clipCount: track.matchingClipCount ?? track.clipCount, returnedClipCount: clips.filter(clip => clip.track === track.index).length }))
    : native.editorTimeline.tracks.filter(track => clips.some(clip => clip.track === track.index)).map(track => ({ ...track, clipCount: clips.filter(clip => clip.track === track.index).length }));
  return { ...native.editorTimeline, clips, tracks, stage: native.stage, revision: native.revision, editScope: scope };
}
function projectSummary(project) {
  const ledger = project.source ? normalizeWritingMaterials(project.source) : null;
  return { id: project.id, kind: project.kind, title: project.title, description: project.description || '', source: project.source ? { ...project.source, ...(ledger?.hadLedger ? { url: '', materials: ledger.items, materialStatus: ledger.status } : {}), text: String(project.source.text || '').slice(0, 14000), truncated: String(project.source.text || '').length > 14000 } : null, brief: project.brief || {}, facts: (project.facts || []).slice(0, 60), outputs: project.outputs || null, video: project.kind === 'video' ? { script: String(project.video?.script || '').slice(0, 12000), editScope: project.video?.editScope } : undefined, science: project.kind === 'science' ? { documentSelection: project.science?.documentSelection, novelConfig: project.science?.novelConfig, novel: project.science?.novel ? { id: project.science.novel.id, title: project.science.novel.title, logline: project.science.novel.logline, librarySelection: project.science.novel.librarySelection, sceneCount: project.science.novel.scenes?.length } : null } : undefined };
}

/** Gx business tools. Model arguments never choose a project, filesystem path or edit scope. */
export function createAssistantAppTools({ store, openFilm, videoService, references, writingReferences, sourceAnalysis, sourceLinks, scienceDocuments, novelLibrary, webTools, downloads, videoImporter, mediaUnderstanding, frameReader, remotion, remotionProjects, preflight, tasks, taskAdapters, bundles, artifacts, projectCovers, musicCuts, root, ai = runAi, undoLimit = 64 } = {}) {
  if (!store?.read || !store?.updateAssistant) throw fail(500, '助手项目工具尚未配置。', 'ASSISTANT_APP_NOT_CONFIGURED');
  writingReferences ||= createWritingReferenceService({ store });
  const states = new Map(), undos = new Map(), operations = new Set();
  const referenceResumeCache = new Map();
  const REFERENCE_CACHE_TTL = 60 * 60000, REFERENCE_CACHE_BYTES = 2 * 1024 * 1024;
  const stateInitializations = new Map();
  let closed = false, undoBytes = 0;
  const activeReceiptWrites = new Set();
  function check(ctx) {
    if (closed) throw fail(503, '助手项目工具已关闭。', 'ASSISTANT_APP_CLOSED');
    if (ctx.signal?.aborted) throw fail(499, '操作已停止。', 'REQUEST_CANCELLED');
  }
  async function owner(ctx, kind) {
    check(ctx);
    if (!ctx.projectId) throw fail(400, '请先打开需要操作的项目，再向助手发送要求。', 'ASSISTANT_PROJECT_REQUIRED');
    const project = await store.read(validateProjectId(ctx.projectId));
    if (!project || kind && project.kind !== kind) throw fail(404, kind === 'science' ? '请先打开科普项目。' : kind === 'video' ? '请先打开视频项目。' : '当前项目已不存在。', 'ASSISTANT_PROJECT_NOT_FOUND');
    return project;
  }
  async function stateFor(ctx) {
    check(ctx);
    if (stateInitializations.has(ctx.runId)) return stateInitializations.get(ctx.runId);
    if (states.has(ctx.runId)) return states.get(ctx.runId);
    const pending = (async () => {
      const project = await owner(ctx); check(ctx);
      const chosen = resolveAssistantScope({ instruction: ctx.instruction, uiScope: ctx.editScope, storedScope: project.video?.editScope, authority: ctx.scopeAuthority || 'explicit-scope' });
      const state = { projectId: project.id, hash: assistantContentHash(project), createdAt: project.createdAt, scope: chosen.scope, dialogueConstraint: chosen.constraint, pendingScope: chosen.pending, scopeAuthority: chosen.authority, receipts: new Map(), writeEpoch: 0, conflicted: false, referenceInspectionIds: [], referenceInspectionAssets: new Map(), referenceContext: frameReader && project.kind === 'video' ? createAssistantReferenceContext({ frameReader }) : null, assetMetadata: new Map(), writingContext: normalizeAssistantWritingContext(ctx.writingContext, project) };
      states.set(ctx.runId, state);
      const cached = referenceResumeCache.get(project.id);
      if (state.referenceContext && cached) {
        if (cached.createdAt !== project.createdAt || Date.now() - cached.at > REFERENCE_CACHE_TTL) referenceResumeCache.delete(project.id);
        else try {
          const { assets } = await readProjectMedia(ctx, state); check(ctx);
          const readable = new Set(assets.map(asset => asset.id)), cachedAssetIds = cached.exported.assetIds.filter(id => readable.has(id));
          const restored = await state.referenceContext.restore(project.id,cached.exported,{origin:ctx.origin,signal:ctx.signal,assetIds:cachedAssetIds});
          state.referenceInspectionIds=restored.restoredInspectionIds; for(const item of cached.exported.inspections)if(state.referenceInspectionIds.includes(item.inspectionId))state.referenceInspectionAssets.set(item.inspectionId,item.asset.id);state.referenceCacheRestored=true;
        } catch (error) { if(ctx.signal?.aborted)throw error; referenceResumeCache.delete(project.id); state.referenceCacheNotice='原参考缓存已失效，需要重新读取当前工程素材或参考。'; }
      }
      return state;
    })();
    stateInitializations.set(ctx.runId, pending);
    try { return await pending; } finally { if (stateInitializations.get(ctx.runId) === pending) stateInitializations.delete(ctx.runId); }
  }
  function conflict(state, message = '项目在助手处理期间已有其他修改，本次后续写入已停止。请查看最新项目后重新发送要求。') {
    state.conflicted = true;
    throw fail(409, message, 'ASSISTANT_CONFLICT');
  }
  async function current(ctx, state, kind) {
    const project = await owner(ctx, kind);
    if (state.conflicted || project.createdAt !== state.createdAt || assistantContentHash(project) !== state.hash) conflict(state);
    if (state.referenceRevision !== undefined) {
      const value = await references.list(project.id);
      if (value.revision !== state.referenceRevision) conflict(state, '项目参考资料已经变化，本次后续修改已停止。请重新发送要求。');
    }
    return project;
  }
  async function readNative(ctx, state, inspection, wholeProject = false) {
    const project = await current(ctx, state, 'video'); check(ctx);
    if (!openFilm?.context) throw fail(503, '原生剪辑服务尚未就绪。', 'OPENFILM_UNAVAILABLE');
    const value = await openFilm.context(ctx.projectId, ctx.origin, { editScope: state.scope, ...(wholeProject ? { inspectAll: true } : {}), ...(inspection !== undefined ? { inspection } : {}) }); check(ctx);
    if (state.pendingScope) {
      const chosen = resolveAssistantScope({ instruction: ctx.instruction, uiScope: ctx.editScope, storedScope: project.video?.editScope, authority: ctx.scopeAuthority || 'explicit-scope', duration: value.duration });
      state.scope = chosen.scope; state.dialogueConstraint = chosen.constraint; state.pendingScope = chosen.pending; state.scopeAuthority = chosen.authority;
    }
    if (state.nativeRevision && state.nativeRevision !== value.revision) conflict(state, '时间线在助手处理期间已有其他修改，本次后续写入已停止。请刷新后重试。');
    state.scope = normalizeEditScope(state.scope, value.assets);
    state.nativeRevision = value.revision;
    return value;
  }
  async function readProjectMedia(ctx, state) {
    const native = await readNative(ctx, state);
    const media = await collectProjectMedia(ctx.projectId, { nativeAssets: native.assets || [], references, videoService });
    if (state.referenceRevision !== undefined && media.referenceRevision !== state.referenceRevision) conflict(state, '项目参考资料已经变化，本次后续修改已停止。请重新发送要求。');
    if (media.referenceRevision !== undefined) state.referenceRevision = media.referenceRevision;
    await current(ctx, state, 'video'); check(ctx);
    return { native, ...media, ownerCreatedAt: state.createdAt };
  }
  function rememberUndo(record) {
    const activeState = states.get(record.runId);
    const entry = { ...record, scope: record.scope || (activeState?.scope ? clone(activeState.scope) : undefined), at: new Date().toISOString(), label: record.label || activeState?.activeToolLabel || record.kind };
    const id = randomUUID(), bytes = Buffer.byteLength(JSON.stringify(entry));
    if (bytes > 8 * 1024 * 1024) throw fail(413, '这次修改的撤销记录过大，请缩小处理范围。', 'ASSISTANT_UNDO_TOO_LARGE');
    while (undos.size >= undoLimit || undoBytes + bytes > 20 * 1024 * 1024) {
      const oldest = [...undos].find(([, value]) => !value.pending)?.[0];
      if (!oldest) {
        // Reservations fail before their write. A completed write must still
        // receive a receipt; at most one bounded active record can overflow
        // while all older records are pending, and is evictable thereafter.
        if (!record.pending) break;
        throw fail(409, '其它修改正在预留撤销空间，请稍后重试；本次尚未提交。', 'ASSISTANT_UNDO_BUSY');
      }
      undoBytes -= undos.get(oldest).bytes; undos.delete(oldest);
    }
    undos.set(id, { ...entry, bytes }); undoBytes += bytes;
    return { kind: record.kind, id };
  }
  function prepareUndo(record) {
    const undo = rememberUndo({ ...record, pending: true });
    return { undo,
      commit(patch = {}) { const entry = undos.get(undo.id); if (!entry || !entry.pending) throw fail(409, '撤销预留已经失效。', 'ASSISTANT_UNDO_EXPIRED'); Object.assign(entry, patch); entry.pending = false; },
      cancel() { const entry = undos.get(undo.id); if (entry?.pending) { undoBytes -= entry.bytes; undos.delete(undo.id); } },
    };
  }
  async function commit(ctx, state, patch, label) {
    await current(ctx, state); check(ctx);
    // Reserve room before committing; the inverse never contains media or model settings.
    const preview = await store.read(ctx.projectId);
    if (Buffer.byteLength(JSON.stringify(preview)) > 2.8 * 1024 * 1024) throw fail(413, '项目已接近大小上限，请精简后再让助手修改。', 'ASSISTANT_UNDO_TOO_LARGE');
    let result;
    try { result = await store.updateAssistant(ctx.projectId, { expectedHash: state.hash, patch }); }
    catch (error) { if (error.status === 409) state.conflicted = true; throw error; }
    state.hash = result.afterHash;
    const undo = rememberUndo({ kind: 'project', projectId: ctx.projectId, createdAt: state.createdAt, expectedHash: result.afterHash, before: result.before, runId: ctx.runId });
    return { summary: label, data: { projectId: ctx.projectId, assistantRevision: result.project.assistantRevision }, effects: [{ type: 'project', projectId: ctx.projectId, label, changed: true, undo }] };
  }
  async function receiptState(name, args, ctx, state, result) {
    const project = await current(ctx, state);
    const versions = { project: state.hash, scope: state.scope, constraint: state.dialogueConstraint };
    if (name === 'native_project_edit' && openFilm?.readProjectCapability) {
      const readArgs = args.section === 'page' ? { path: args.args?.path } : args.section === 'canvas' ? { board: result?.data?.data?.boardId || args.args?.board || 'main' } : {};
      const section = await openFilm.readProjectCapability(ctx.projectId, args.section, readArgs, ctx.origin);
      if (state.nativeRevision && section.filmRevision && section.filmRevision !== state.nativeRevision) conflict(state, '时间线在助手处理期间已有其他修改，本次后续写入已停止。请刷新后重试。');
      if (result?.data?.revision !== undefined && section.revision !== result.data.revision) throw fail(409, '原生内容在提交后已有更新，不能复用旧回执。', 'ASSISTANT_RECEIPT_CHANGED');
      versions.nativeSection = [args.section, section.revision, section.filmRevision];
    } else if (state.nativeRevision && (/^native_/.test(name) || ['native_edit', 'music_autocut', 'animation_create', 'remotion_edit', 'media_asset_import', 'download_media_import', 'video_import_url', 'image_import_url'].includes(name) || args.append === true)) {
      const native = await readNative(ctx, state);
      versions.native = { revision: native.revision, assets: (native.assets || []).map(({ id, name, type, duration, width, height }) => ({ id, name, type, duration, width, height })) };
    }
    if (references?.list && (state.referenceRevision !== undefined || /^reference_/.test(name))) {
      const value = await references.list(project.id); versions.references = value.revision ?? digest(value);
    }
    if (novelLibrary?.list && /^(?:library_|knowledge_|novel_)/.test(name)) {
      const value = await novelLibrary.list();
      if (result?.data?.revision !== undefined && value.revision !== result.data.revision) throw fail(409, '公用素材在提交后已有更新，不能复用旧回执。', 'ASSISTANT_RECEIPT_CHANGED');
      versions.library = value.revision ?? digest(value);
    }
    if (sourceLinks?.status && /^source_link_/.test(name)) {
      const value = await sourceLinks.status(project.id); versions.link = { revision: value.revision, linkHash: value.linkHash, sourceHash: value.sourceHash, targetHash: value.targetHash, status: value.status };
    }
    if (['writing_create', 'writing_revise'].includes(name) && project.writing?.references?.enabled && project.writing.references.projectId) {
      const reference = await store.read(project.writing.references.projectId); versions.writingReference = reference ? assistantContentHash(reference) : null;
    }
    if (name === 'knowledge_generate' && scienceDocuments?.context && project.science?.documentSelection?.documentId) {
      const document = await scienceDocuments.context(project.id, project.science.documentSelection, { signal: ctx.signal }); versions.document = digest(document);
    }
    if (name === 'native_edit' && sourceAnalysis?.context) {
      const native = await readNative(ctx, state);
      const evidence = await sourceAnalysis.context(project.id, { origin: ctx.origin, assetIds: scopedAssets(native.assets || [], state.scope).map(asset => asset.id) }); versions.analysis = digest(evidence);
    }
    const remotionId = args.remotionId || (name === 'remotion_create' ? result?.data?.id : result?.data?.remotionId);
    if (remotion?.read && remotionId && (/^remotion_/.test(name) || ['animation_create', 'native_edit'].includes(name))) {
      const source = await remotion.read(project.id, remotionId);
      if (Number.isSafeInteger(result?.data?.revision) && source.revision !== result.data.revision) throw fail(409, '动画源码在提交后已有更新，不能复用旧回执。', 'ASSISTANT_RECEIPT_CHANGED');
      versions.remotion = { id: source.id, revision: source.revision, entryPoint: source.entryPoint, compositionId: source.compositionId, props: source.inputProps, files: source.files?.map(file => [file.path, digest(file.content)]), assets: source.assets };
    }
    if (tasks?.get && ['task_cancel', 'task_retry'].includes(name)) {
      const task = await tasks.get(args.taskId, { projectId: project.id }); versions.task = { id: task.id, status: task.status, attempt: task.attempt, canCancel: task.canCancel, canRetry: task.canRetry };
    }
    return digest(versions);
  }
  function advanceWriteEpoch(state, currentEntry) {
    state.writeEpoch++;
    for (const [key, entry] of state.receipts) if (entry !== currentEntry && !entry.pending) state.receipts.delete(key);
  }
  function tool(name, description, inputSchema, mutating, execute, { repeatable = false, images } = {}) {
    return { name, description, inputSchema, mutating, ...(typeof images === 'function' ? { images } : {}), execute(args, ctx) {
      const pending = (async () => {
        check(ctx); requireObject(args, '工具参数');
        if (mutating && ctx.mode === 'ask') throw fail(403, '仅问答模式不会修改项目。', 'ASSISTANT_READ_ONLY');
        const state = ctx.projectId ? await stateFor(ctx) : null;
        if (state) state.activeToolLabel = `${name}${args.instruction ? ' · ' + String(args.instruction).slice(0, 160) : ''}`;
        if (mutating && !state) await owner(ctx);
        const key = mutating && !repeatable ? name + ':' + digest(args) : '';
        while (key && state.receipts.has(key)) {
          const cached = state.receipts.get(key); let result;
          try { result = await cached.promise; } catch (error) { if (state.receipts.get(key) === cached) state.receipts.delete(key); throw error; }
          let actual = null;
          if (cached.reusable && cached.epoch === state.writeEpoch) { try { actual = await receiptState(name, args, ctx, state, result); } catch (error) { if (state.conflicted) throw error; /* Otherwise re-execute through the operation's real validation. */ } }
          if (state.receipts.get(key) !== cached) continue;
          if (actual && actual === cached.version && cached.epoch === state.writeEpoch) return clone(result);
          state.receipts.delete(key);
        }
        check(ctx);
        const entry = { state, pending: true, reusable: true, epoch: null, version: null, promise: null };
        if (mutating) { const overlapping = [...activeReceiptWrites].filter(active => active.state === state); if (overlapping.length) { entry.reusable = false; for (const active of overlapping) active.reusable = false; } activeReceiptWrites.add(entry); }
        entry.promise = (async () => {
          try {
            const result = await execute(args, ctx, state);
            for (const effect of Array.isArray(result?.effects) ? result.effects : []) if (effect?.undo?.id && undos.has(effect.undo.id)) undos.get(effect.undo.id).label = String(effect.label || result.summary || name).slice(0, 300);
            if (mutating) {
              advanceWriteEpoch(state, entry); entry.epoch = state.writeEpoch;
              if (key && entry.reusable) { try { entry.version = await receiptState(name, args, ctx, state, result); } catch { entry.reusable = false; } }
              if (entry.epoch !== state.writeEpoch) entry.reusable = false;
            }
            return result;
          } finally {
            entry.pending = false; activeReceiptWrites.delete(entry);
            if (key && (!entry.version || !entry.reusable) && state.receipts.get(key) === entry) state.receipts.delete(key);
          }
        })();
        if (key) state.receipts.set(key, entry);
        try { return await entry.promise; } catch (error) { if (key && state.receipts.get(key) === entry) state.receipts.delete(key); throw error; }
      })();
      operations.add(pending); pending.finally(() => operations.delete(pending)).catch(() => {}); return pending;
    } };
  }
  async function editNative(args, ctx, state) {
    const project = await current(ctx, state, 'video'), native = await readNative(ctx, state);
    ctx.update('正在结合当前时间线、所选范围和项目参考拟定剪辑');
    const [ref, evidence, linked] = await Promise.all([
      references?.context ? references.context(project.id, { signal: ctx.signal }) : null,
      sourceAnalysis?.context ? sourceAnalysis.context(project.id, { origin: ctx.origin, assetIds: scopedAssets(native.assets || [], state.scope).map(asset => asset.id) }) : null,
      sourceLinks?.context ? sourceLinks.context(project.id) : null,
    ]);
    const instruction = boundedString(args.instruction || ctx.instruction, '剪辑要求', 6000);
    const result = await ai('edit-assistant', { instruction: `用户本轮要求：${ctx.instruction.slice(0, 3500)}\n本步处理：${instruction}`.slice(0, 6000), title: project.title || '', script: project.video?.script || '', context: nativeSummary(native, state.scope), editScope: state.scope, references: ref?.references, sourceAnalysis: evidence?.sourceAnalysis, sourceDraft: linked }, ctx.settings, { signal: ctx.signal, images: ref?.images || [] });
    if (result.data.action === 'reply') return { summary: result.data.message, data: { applied: false } };
    if (result.data.action === 'animation') return renderAnimation({ instruction }, ctx, state, result.data.animation);
    await current(ctx, state, 'video'); check(ctx);
    ctx.update('正在应用范围内的剪辑修改');
    let applied;
    try { applied = await openFilm.applyPlan(project.id, result.data.plan, ctx.origin, state.nativeRevision, { keepUndo: true, editScope: state.scope }); }
    catch (error) { if (error.status === 409) state.conflicted = true; throw error; }
    if (!applied.applied) return { summary: '当前工程无需修改。', data: { applied: false } };
    state.nativeRevision = applied.revision;
    const undo = rememberUndo({ kind: 'native', projectId: project.id, createdAt: state.createdAt, nativeUndoId: applied.undo?.id, runId: ctx.runId });
    return { summary: '已应用剪辑修改。', data: { revision: applied.revision, duration: applied.duration, placement: applied.placement }, effects: [{ type: 'native', projectId: project.id, label: '已更新所选剪辑范围', changed: true, undo }] };
  }
  const rebuildingReference = ctx => {
    const instruction = ctx.goalInstruction || ctx.instruction;
    if (!isReferenceRebuildRequest(instruction)) return false;
    const styleOnly = /风格|配色|色调|节奏|构图|视觉语言|\b(?:style|aesthetic|palette|mood|color|look)\b/i.test(instruction);
    const completeRebuild = /逐镜|逐帧|(?:完整|全片|整片|全长|全部).{0,12}(?:重建|重制|复刻|模仿|参考|原片|视频)|(?:重建|重制|复刻|模仿).{0,12}(?:完整|全片|整片|全长)|frame.by.frame|shot.by.shot|\b(?:full|entire|whole|complete)\b.{0,20}(?:rebuild|reconstruct|replicate|reference|video|footage)/i.test(instruction);
    return !styleOnly || completeRebuild;
  };
  async function frameReference(ctx, state, { inspectionIds = state.referenceInspectionIds, assetId, maxImages = 12, imageOffset, forProduction = false } = {}) {
    if (!state.referenceContext || !inspectionIds?.length) return null;
    if (inspectionIds.some(id => !state.referenceInspectionIds.includes(id))) throw fail(400, '请先读取本轮实际参考画面，再使用返回的批次编号。', 'ASSISTANT_REFERENCE_RECEIPT_REQUIRED');
    if (forProduction && state.dialogueConstraint?.assetIds) {
      const permitted = new Set(state.dialogueConstraint.assetIds);
      if (assetId && !permitted.has(assetId)) return null;
      inspectionIds = inspectionIds.filter(id => permitted.has(state.referenceInspectionAssets.get(id)));
      if (!inspectionIds.length) return null;
    }
    const { assets: allowed } = await readProjectMedia(ctx, state);
    const snapshot = await state.referenceContext.snapshot(ctx.projectId, { inspectionIds, ...(assetId ? { assetId } : {}), maxImages, ...(imageOffset !== undefined ? { imageOffset } : {}) }, { origin: ctx.origin, signal: ctx.signal }); check(ctx);
    snapshot.images = snapshot.images.map(image => ({ ...image, detail: 'high' }));
    if (snapshot.context.assets.some(asset => !allowed.some(item => item.id === asset.id))) throw fail(403, '参考素材已不属于当前工程素材库或参考库。', 'ASSISTANT_MEDIA_SCOPE');
    const source = snapshot.context.assets.length === 1 ? snapshot.context.assets[0] : null;
    if (source?.type === 'video' && rebuildingReference(ctx)) {
      // A zoom/read window is evidence coverage, not the user's creation scope.
      const selected = { start: 0, end: source.duration };
      snapshot.context.sourceAssetId = source.id; snapshot.context.sourceRange = selected;
      snapshot.context.expectedDuration = state.scope.placement.mode === 'range' ? state.scope.placement.end - state.scope.placement.start : selected.end - selected.start;
    }
    return snapshot;
  }
  function referenceStamp(snapshot) { return snapshot ? digest(snapshot.context.assets.map(({ id, sourceVersion, ownerVersion }) => ({ id, sourceVersion, ownerVersion }))) : ''; }
  async function referenceOptions(ctx, state, options = {}) {
    const evidence = await frameReference(ctx, state, { ...options, forProduction: true });
    if (!evidence?.context.assets.length) return {};
    const stamp = referenceStamp(evidence);
    return { referenceEvidence: evidence, assertReferenceEvidence: async () => { const current = await frameReference(ctx, state, { ...options, maxImages: 0, imageOffset: undefined, forProduction: true }); if (referenceStamp(current) !== stamp) throw fail(409, '参考素材在制作期间已有变化，请重新读取画面。', 'REMOTION_REFERENCE_CHANGED'); } };
  }
  async function progressContext(ctx) {
    if(!ctx.projectId)return{};
    const state=await stateFor(ctx),project=await owner(ctx); check(ctx);
    if(project.kind!=='video')return{};
    let native;try{native=await readNative(ctx,state);}catch(error){return{referenceReady:false,creationStarted:state.creationStarted===true,creationComplete:state.creationComplete===true,blockedCode:error.code,ownerCreatedAt:project.createdAt};}
    let reference;try{reference=await frameReference(ctx,state,{maxImages:0,forProduction:true});}catch(error){return{referenceReady:false,creationStarted:state.creationStarted===true,creationComplete:state.creationComplete===true,blockedCode:error.code,scope:state.scope,timelineEmpty:native.duration===0,ownerCreatedAt:project.createdAt};}
    const coverage=reference?.context.coverage,plans=coverage?.assets?.flatMap(asset=>asset.plans)||[];
    const referenceReady=Boolean(coverage?.sampledFrameCount&&coverage.unannotatedFrameCount===0&&plans.length&&plans.every(plan=>plan.samplingPlanComplete));
    return{referenceReady,frameCount:coverage?.sampledFrameCount||0,noteCount:coverage?.noteCount||0,plannedFrameCount:plans.reduce((sum,plan)=>sum+plan.plannedFrameCount,0),sourceDuration:reference?.context.assets?.find(asset=>asset.type==='video')?.duration||0,scope:state.scope,timelineEmpty:native.duration===0,creationStarted:state.creationStarted===true,creationComplete:state.creationComplete===true,ownerCreatedAt:project.createdAt,referenceCacheRestored:state.referenceCacheRestored===true,productionTools:['native_scope_set','animation_create','remotion_edit','remotion_create','remotion_update','remotion_render','remotion_render_advanced']};
  }
  async function checkpoint(ctx) {
    if (!ctx.projectId) return { v: 1, runId: ctx.runId, projectId: null };
    const state = await stateFor(ctx); await current(ctx, state);
    if (state.nativeRevision !== undefined) await readNative(ctx, state);
    const compact = (value, depth = 0) => {
      if (depth > 7) return { detailsIncomplete: true };
      if (typeof value === 'string') return /^data:/i.test(value) ? undefined : value.slice(0, 1600);
      if (Array.isArray(value)) return value.slice(0, 24).map(item => compact(item, depth + 1));
      if (!value || typeof value !== 'object') return value;
      return Object.fromEntries(Object.entries(value).filter(([key]) => !/^(settings|api_?key|authorization|access_?token|refresh_?token|password|secret|cookie)$/i.test(key)).map(([key, item]) => [key, compact(item, depth + 1)]));
    };
    const completedReceipts = [];
    for (const [key, entry] of state.receipts) if (!entry.pending && entry.reusable && entry.epoch === state.writeEpoch) {
      const original = await entry.promise;
      const result = JSON.stringify(original).length <= 20000 ? original : { ...compact(original), detailsIncomplete: true };
      if (JSON.stringify(result).length <= 24000) completedReceipts.push({ key, epoch: entry.epoch, version: entry.version, result });
    }
    let referenceExport;
    if (state.referenceContext && state.referenceInspectionIds.length) {
      try { const exported = state.referenceContext.export(state.projectId), text = JSON.stringify(exported); if (text.length < 14000 && !/data:image\//i.test(text)) referenceExport = exported; } catch { /* Actual owned frames can be read again. */ }
    }
    const saved = { v: 1, runId: ctx.runId, projectId: state.projectId, createdAt: state.createdAt, projectHash: state.hash,
      scope: clone(state.scope), dialogueConstraint: clone(state.dialogueConstraint), pendingScope: state.pendingScope, scopeAuthority: state.scopeAuthority,
      nativeRevision: state.nativeRevision, referenceRevision: state.referenceRevision, writeEpoch: state.writeEpoch,
      creationStarted: state.creationStarted === true, creationComplete: state.creationComplete === true, writingContext: clone(state.writingContext),
      referenceInspectionIds: [...state.referenceInspectionIds], referenceInspectionAssets: [...state.referenceInspectionAssets],
      assetMetadata: [...state.assetMetadata].slice(0, 100), completedReceipts, ...(referenceExport ? { referenceExport } : {}) };
    if (JSON.stringify(saved).length > 60000) { delete saved.referenceExport; saved.assetMetadata = []; }
    if (JSON.stringify(saved).length > 64000) throw fail(413, '当前任务检查点超过可恢复容量，已完成操作仍保留。', 'ASSISTANT_CHECKPOINT_TOO_LARGE');
    return saved;
  }
  async function restoreCheckpoint(ctx, saved) {
    if (!saved || saved.v !== 1 || saved.runId !== ctx.runId || saved.projectId !== (ctx.projectId || null)) throw fail(409, '任务检查点与当前项目不一致。', 'ASSISTANT_CHECKPOINT_INVALID');
    if (!ctx.projectId) return { reconciled: false };
    const project = await owner(ctx);
    if (project.createdAt !== saved.createdAt || assistantContentHash(project) !== saved.projectHash) throw fail(409, '项目在中断后已有新修改，请按最新项目继续，不能自动恢复旧写入。', 'ASSISTANT_CONFLICT');
    const state = await stateFor({ ...ctx, writingContext: null });
    state.hash = saved.projectHash; state.createdAt = saved.createdAt;
    state.scope = normalizeEditScope(saved.scope); state.dialogueConstraint = clone(saved.dialogueConstraint); state.pendingScope = saved.pendingScope === 'tail' ? 'tail' : saved.pendingScope === true; state.scopeAuthority = saved.scopeAuthority;
    state.nativeRevision = saved.nativeRevision; state.referenceRevision = saved.referenceRevision; state.writeEpoch = Number.isSafeInteger(saved.writeEpoch) ? saved.writeEpoch : 0;
    state.creationStarted = saved.creationStarted === true; state.creationComplete = saved.creationComplete === true; state.writingContext = clone(saved.writingContext);
    await current(ctx, state); if (state.nativeRevision !== undefined) await readNative(ctx, state);
    state.referenceInspectionIds = (saved.referenceInspectionIds || []).filter(id => typeof id === 'string');
    state.referenceInspectionAssets = new Map(saved.referenceInspectionAssets || []); state.assetMetadata = new Map(saved.assetMetadata || []);
    for (const receipt of saved.completedReceipts || []) if (typeof receipt.key === 'string' && /^[a-z_]+:[a-f0-9]{64}$/.test(receipt.key) && receipt.epoch === state.writeEpoch && /^[a-f0-9]{64}$/.test(receipt.version) && receipt.result && typeof receipt.result === 'object') {
      state.receipts.set(receipt.key, { state, pending: false, reusable: true, epoch: receipt.epoch, version: receipt.version, promise: Promise.resolve(clone(receipt.result)) });
    }
    if (state.referenceContext && saved.referenceExport) {
      try {
        const { assets } = await readProjectMedia(ctx, state);
        const restored = await state.referenceContext.restore(ctx.projectId, saved.referenceExport, { origin: ctx.origin, signal: ctx.signal, assetIds: assets.map(asset => asset.id) });
        state.referenceInspectionIds = restored.restoredInspectionIds;
      } catch (error) { if (ctx.signal?.aborted || state.conflicted) throw error; state.referenceCacheNotice = '原采样笔记需要重新读取当前实际画面。'; }
    }
    return { reconciled: false };
  }
  async function renderRemotionProject(args, ctx, state, record) {
    const project = await current(ctx, state, 'video'); await readNative(ctx, state);
    if (!remotion) throw fail(503, '自由Remotion工程服务尚未就绪。', 'REMOTION_UNAVAILABLE');
    const started = await remotion.start(project.id, record.id, { expectedRevision: record.revision, compositionId: args.compositionId || record.compositionId, inputProps: record.inputProps, kind: args.preview ? 'preview' : 'video', ...(args.frames ? { frames: args.frames } : {}), ...(args.range ? { range: args.range } : {}) });
    const id = started.jobId;
    const cancel = () => { void remotion.cancel(project.id, id).catch(() => {}); };
    ctx.signal?.addEventListener('abort', cancel, { once: true });
    if (ctx.signal?.aborted) cancel();
    try {
      let job;
      while (true) {
        check(ctx); job = await remotion.job(project.id, id);
        if (['complete', 'error', 'cancelled'].includes(job.status)) break;
        ctx.update(`动画渲染中 · ${Math.round((job.progress || 0) * 100)}%`);
        await pause(500, undefined, { signal: ctx.signal });
      }
      if (job.status !== 'complete') throw fail(422, 'Remotion渲染未完成，源码已保留，时间线尚未修改。' + String(job.error?.message || job.error || ''), 'ASSISTANT_ANIMATION_FAILED');
      await current(ctx, state, 'video'); check(ctx);
      if (args.preview || args.append === false) return { summary: args.preview ? '已生成真实Remotion预览帧。' : 'Remotion视频已渲染，可在动画工作区查看或加入时间线。', data: { remotionId: record.id, revision: record.revision, job: remotion.publicJob(project.id, job) }, effects: [{ type: 'remotion', projectId: project.id, label: args.preview ? '自由动画预览已生成' : '自由动画视频已生成', changed: true }] };
      ctx.update('动画已生成，正在加入所选位置');
      const applied = await remotion.append(project.id, record.id, { jobId: id, expectedNativeRevision: state.nativeRevision }, { origin: ctx.origin, editScope: state.scope, signal: ctx.signal });
      state.nativeRevision = applied.revision;
      const undo = rememberUndo({ kind: 'native', projectId: project.id, createdAt: state.createdAt, nativeUndoId: applied.undo?.id, runId: ctx.runId });
      return { summary: '自由Remotion动画已完成并加入时间线，源码工程可继续修改。', data: { remotionId: record.id, revision: record.revision, jobId: id, assetId: applied.asset?.id, placement: applied.placement }, effects: [{ type: 'native', projectId: project.id, label: '自由Remotion动画已加入时间线', changed: true, jobId: id, undo }] };
    } catch (error) { if (error.status === 409) state.conflicted = true; throw error; }
    finally { ctx.signal?.removeEventListener('abort', cancel); }
  }
  async function renderAnimation(args, ctx, state) {
    const project = await current(ctx, state, 'video'); await readNative(ctx, state);
    if (state.scope.placement.mode === 'free' && args.append !== false) throw fail(400, '请先用native_scope_set按本轮要求决定具体放置方式，无需让用户填写时间区间。', 'EDIT_PLACEMENT_UNRESOLVED');
    state.creationStarted=true;
    if (!remotion) throw fail(503, '自由Remotion工程服务尚未就绪。', 'REMOTION_UNAVAILABLE');
    const scope = state.scope.placement;
    const reference = await referenceOptions(ctx, state);
    const targetSeconds = reference.referenceEvidence?.context.expectedDuration;
    const instruction = [ctx.instruction, args.instruction, scope.mode === 'range' ? `本次成片必须恰好为${scope.end - scope.start}秒，加入作品${scope.start}至${scope.end}秒，不能改变区间外内容。` : '', targetSeconds ? `参考重建目标为${targetSeconds}秒，请依已登记画面和源时间安排完整镜头；不能缩成无关短动画。` : '', state.assetMetadata.size ? '本轮真实素材技术信息：' + JSON.stringify([...state.assetMetadata.values()]) : ''].filter(Boolean).join('\n').slice(0, 16000);
    const creation = await runReviewedRemotion({
      signal: ctx.signal, onProgress: value => ctx.update(value), compileRepairs: 2, visualRepairs: 2,
      generate: async ({ project: previous, diagnostics }) => {
        check(ctx); await current(ctx, state, 'video');
        const previousId = previous?.id || args.remotionId, expectedRevision = previous?.revision ?? args.expectedRevision;
        return remotion.generate(project.id, { instruction, ...(previousId ? { remotionId: previousId, expectedRevision } : {}), ...(args.paths ? { paths: args.paths } : {}), diagnostics }, { origin: ctx.origin, signal: ctx.signal, editScope: state.scope, settings: ctx.settings, onProgress: value => ctx.update(value), ...reference });
      },
      inspect: async record => { const inspected = await remotion.inspect(project.id, record.id, { expectedRevision: record.revision, inputProps: record.inputProps, signal: ctx.signal }); const values = Array.isArray(inspected) ? inspected : inspected.compositions; const selected = values?.find(item => item.id === record.compositionId) || values?.[0]; if (targetSeconds && selected && Math.abs(selected.durationInFrames / selected.fps - targetSeconds) > Math.max(.05, 1 / selected.fps)) throw fail(422, `实际Composition时长应为${targetSeconds}秒，当前为${selected.durationInFrames / selected.fps}秒；请保持参考时长后重新编写。`, 'REMOTION_REFERENCE_DURATION_MISMATCH'); return inspected; },
      ...(remotion.review ? { review: async record => { const reviewed = await remotion.review(project.id, record.id, { expectedRevision: record.revision, compositionId: record.compositionId, inputProps: record.inputProps, instruction, settings: ctx.settings, signal: ctx.signal, onProgress: value => ctx.update(value) }); if (!rebuildingReference(ctx) || !reference.referenceEvidence || !remotion.compareReference) return reviewed; const comparison = await remotion.compareReference(project.id, record.id, { expectedRevision: record.revision, compositionId: record.compositionId, inputProps: record.inputProps, instruction, settings: ctx.settings, signal: ctx.signal, ...(await referenceOptions(ctx, state, { maxImages: 6, imageOffset: 0 })) }); if (comparison.status !== 'reviewed') return { ...reviewed, status: 'unavailable', referenceComparison: comparison }; const issues = (comparison.issues || []).map(issue => ({ ...issue, frame: comparison.pairs?.find(pair => pair.pairId === issue.pairId)?.output.frame ?? 0 })); return { ...reviewed, verdict: reviewed.verdict === 'revise' || comparison.verdict === 'revise' ? 'revise' : reviewed.verdict, issues: [...(reviewed.issues || []), ...issues], referenceComparison: comparison }; } } : {}),
    });
    const record = creation.project, reviewResult = creation.review;
    if (reviewResult?.status === 'reviewed' && reviewResult.verdict === 'revise' && reviewResult.issues?.some(issue => issue.severity === 'blocking')) return { summary: '自由工程源码已保存，但实际采样图仍存在影响使用的问题，尚未加入时间线。可按具体帧号继续修改。', data: { remotionId: record.id, revision: record.revision, review: reviewResult }, effects: [{ type: 'remotion', projectId: project.id, label: '源码已保留，画面待继续改进', changed: true }] };
    const rendered = await renderRemotionProject(args, ctx, state, record);
    state.creationComplete=true;
    rendered.data.workflow = creation.workflow;
    if (reviewResult) { rendered.data.review = reviewResult; if (reviewResult.status !== 'reviewed' || reviewResult.verdict === 'unknown') rendered.summary += ' 当前未完成有效视觉复核，请查看预览。'; else if (reviewResult.verdict === 'revise') rendered.summary += ' 采样检查仍有可选优化，详见帧号反馈。'; }
    return rendered;
  }
  async function adjustNative(args, ctx, state) {
    const project = await current(ctx, state, 'video'); await readNative(ctx, state);
    if (!openFilm?.adjustClips) throw fail(503, '精确剪辑服务尚未就绪，请重新打开应用。', 'OPENFILM_UNAVAILABLE');
    check(ctx); ctx.update('正在检查片段、锁定状态和所选范围');
    let applied;
    try { applied = await openFilm.adjustClips(project.id, args.edits, ctx.origin, state.nativeRevision, { keepUndo: true, editScope: clone(state.scope), signal: ctx.signal }); }
    catch (error) { if (error.code === 'OPENFILM_REVISION_CONFLICT' || error.code === 'ASSISTANT_CONFLICT') state.conflicted = true; throw error; }
    state.nativeRevision = applied.revision;
    // A new half/copy descends from a selected clip; it remains available to
    // subsequent steps of this same authorized run, never to unrelated clips.
    if (state.scope.placement.clipIds?.length) state.scope.placement.clipIds = [...new Set([...state.scope.placement.clipIds, ...(applied.results || []).map(result => result.createdClipId).filter(Boolean)])];
    if (state.dialogueConstraint?.placement?.clipIds?.length) state.dialogueConstraint.placement.clipIds = [...new Set([...state.dialogueConstraint.placement.clipIds, ...(applied.results || []).map(result => result.createdClipId).filter(Boolean)])];
    const undo = rememberUndo({ kind: 'native', projectId: project.id, createdAt: state.createdAt, nativeUndoId: applied.undo?.id, runId: ctx.runId });
    return { summary: applied.summary || '已完成精确剪辑。', data: { revision: applied.revision, results: applied.results, duration: applied.duration }, effects: [{ type: 'native', projectId: project.id, label: applied.summary || '已精确调整片段', changed: true, undo }] };
  }

  function mediaResult(asset) { return { id: asset.id, name: asset.name, type: asset.type, duration: asset.duration, width: asset.width, height: asset.height, hasAudio: asset.hasAudio === true, url: `/api/video/media/${asset.id}`, ...(asset.provenance ? { provenance: clone(asset.provenance) } : {}) }; }
  const fileEffect = (file, changed) => ({ type: 'download', projectId: file.projectId, label: (changed ? '已下载：' : '本机资料：') + file.name, changed, download: { id: file.id, name: file.name, size: file.size, contentType: file.contentType, sha256: file.sha256, ...(file.url.length <= 2000 ? { url: file.url } : {}), downloadUrl: file.downloadUrl, canImport: file.canImport } });
  async function prepareKnowledge(ctx, state, asset, sourceUrl, sampling = {}) {
    await current(ctx, state, 'science'); check(ctx);
    if (!mediaUnderstanding?.prepare) throw fail(503, '图片与视频知识识别服务尚未就绪。', 'ASSISTANT_MEDIA_UNAVAILABLE');
    const result = await mediaUnderstanding.prepare(ctx.projectId, asset.id, { settings: ctx.settings, signal: ctx.signal, instruction: ctx.instruction, sourceUrl, ...sampling, onProgress: value => ctx.update(typeof value === 'string' ? value : value?.message || '正在识别素材并整理知识资料') });
    const undo = result.duplicate ? undefined : rememberUndo({ kind: 'document', projectId: ctx.projectId, documentId: result.document.id, sourceHash: result.document.sourceHash, createdAt: state.createdAt, runId: ctx.runId });
    return { summary: result.duplicate ? '识别整理后的资料已在当前科普库中。' : '已识别整理图片或视频内容，并导入当前科普资料库。', data: { assetId: asset.id, documentId: result.document.id, title: result.document.title, analysis: result.analysis, timelineChanged: false }, effects: result.duplicate ? [] : [{ type: 'document', projectId: ctx.projectId, changed: true, label: '已将媒体识别结果导入科普资料库', undo }] };
  }
  async function importOnlineMedia(args, ctx, state) {
    const project = await current(ctx, state);
    if (!['video', 'science'].includes(project.kind)) throw fail(400, '请打开剪辑或科普项目后导入图片、视频。', 'ASSISTANT_MEDIA_PROJECT');
    const url = normalizePublicAssistantUrl(args.url);
    if (args.candidateId && !webTools?.materialCandidate) throw fail(503, '素材候选来源读取功能尚未就绪。', 'ASSISTANT_MEDIA_UNAVAILABLE');
    const candidate = args.candidateId ? await webTools.materialCandidate(args.candidateId, url) : null;
    if (args.candidateId && !candidate) throw fail(400, '该素材候选尚未在当前服务读取，请重新查看真实来源页。', 'ASSISTANT_MATERIAL_CANDIDATE');
    if (candidate && !videoService?.setAssetProvenance) throw fail(503, '素材来源保存功能尚未就绪。', 'ASSISTANT_MEDIA_UNAVAILABLE');
    const kind = args.kind || 'video';
    if (!['image', 'video'].includes(kind)) throw fail(400, '请选择图片或视频类型。', 'ASSISTANT_MEDIA_TYPE');
    if (project.kind === 'video') await readNative(ctx, state);
    ctx.update(kind === 'video' ? '正在下载并校验公开视频原文件' : '正在下载并处理原始图片');
    let imported, originalDownload;
    if (kind === 'image') {
      if (!downloads?.mediaAsset) throw fail(503, '图片下载处理服务尚未就绪。', 'ASSISTANT_MEDIA_UNAVAILABLE');
      originalDownload = await downloads.download(url, { projectId: project.id, runId: ctx.runId, signal: ctx.signal, ...(candidate ? { candidateId: args.candidateId } : {}) });
      const savedImage = error => ({ summary: '原始图片已下载；后续识别和导入尚未完成。' + (error instanceof AppError ? error.message : ''), data: { imported: false, downloadId: originalDownload.download.id }, effects: [fileEffect(originalDownload.download, !originalDownload.duplicate)], sources: [{ title: originalDownload.download.name, url: originalDownload.download.url }] });
      if (ctx.signal?.aborted) return savedImage();
      try {
        const result = await downloads.mediaAsset(originalDownload.download.id, { projectId: project.id, signal: ctx.signal });
        imported = { asset: result.asset, sourceUrl: result.download.url, title: result.download.name };
      } catch (error) { return savedImage(error); }
    } else {
      const importer = typeof videoImporter === 'function' ? await videoImporter() : videoImporter;
      if (!importer?.import) throw fail(503, '公开视频导入服务尚未就绪。', 'ASSISTANT_MEDIA_UNAVAILABLE');
      imported = await importer.import(url, { signal: ctx.signal, retainCommittedReceipt: true, onProgress: value => ctx.update(value.phase === 'downloading' ? value.totalBytes ? `正在下载视频 · ${Math.round(value.receivedBytes / value.totalBytes * 100)}%` : '正在下载视频原文件' : value.phase === 'muxing' ? '正在保留原音轨' : value.phase === 'metadata' ? '正在读取视频信息' : value.phase === 'preparing' ? '正在检查视频网址' : '正在校验并登记视频素材') });
    }
    if (candidate) imported.asset = await videoService.setAssetProvenance(imported.asset.id, { sourcePage: candidate.sourcePage, rights: candidate.rights, candidateId: args.candidateId, requestedUrl: url }, { signal: ctx.signal });
    const source = { title: candidate?.sourcePage?.title || imported.title || imported.asset.name, url: candidate?.sourcePage?.url || imported.sourceUrl || url };
    let projectAsset;
    const partial = error => ({ summary: (projectAsset ? '素材已导入当前工程；后续处理已停止。' : '原始素材已下载；后续识别或项目导入尚未完成。') + (error instanceof AppError ? error.message : ''), data: { imported: Boolean(projectAsset), asset: mediaResult(projectAsset || imported.asset), ...(originalDownload ? { downloadId: originalDownload.download.id } : {}), ...(error instanceof AppError ? { error: { code: error.code, message: error.message } } : {}) }, effects: [{ type: 'media', projectId: project.id, changed: true, label: projectAsset ? '素材已导入，后续处理未完成' : '素材已下载，尚未完成项目导入', ...(projectAsset ? { importedAssetId: projectAsset.id } : {}) }], sources: [source] });
    if (ctx.signal?.aborted) return partial();
    try {
      await current(ctx, state); check(ctx);
      if (project.kind === 'science') return { ...await prepareKnowledge(ctx, state, imported.asset, source.url), sources: [source] };
      const result = await openFilm.importAsset(project.id, imported.asset.id, ctx.origin, { expectedRevision: state.nativeRevision, requestId: `${ctx.runId}-${ctx.callId}`, signal: ctx.signal });
      projectAsset = result.asset;
      state.nativeRevision = result.revision;
      // Only this user's newly imported asset is added. Existing unchosen
      // assets and the user's timeline placement/range stay excluded.
      if (Array.isArray(state.scope.assetIds) && !state.dialogueConstraint?.assetIds) state.scope.assetIds = [...new Set([...state.scope.assetIds, result.asset.id])];
      const scopeEffects = [];
      if (Array.isArray(state.scope.assetIds) && !state.dialogueConstraint?.assetIds && !ctx.signal?.aborted) {
        const selected = await commit(ctx, state, [{ path: ['video', 'editScope'], value: state.scope }], '已选择本轮新导入素材');
        scopeEffects.push(...selected.effects.map(effect => ({ ...effect, ...(effect.undo ? { undo: { ...effect.undo, label: '撤销素材选择' } } : {}) })));
      }
      return { summary: `已将${kind === 'image' ? '图片' : '视频'}导入当前工程素材库，尚未修改时间线。可继续读取真实素材并按要求剪辑。`, data: { imported: true, asset: mediaResult(result.asset), revision: result.revision, timelineChanged: false, editScope: state.scope }, effects: [{ type: 'media', projectId: project.id, changed: true, importedAssetId: result.asset.id, editScope: clone(state.scope), label: `已导入${kind === 'image' ? '图片' : '视频'}素材：${result.asset.name}` }, ...scopeEffects], sources: [source] };
    } catch (error) { if (error.status === 409) state.conflicted = true; return partial(error); }
  }

  function writingDraftPatch(project, result) {
    const draft = { ...clone(result), origin: 'ai', updatedAt: new Date().toISOString(), sourceFingerprint: writingSourceFingerprint(project.source), referenceSelection: normalizeWritingReferenceConfig(project.writing?.references) };
    return [{ path: ['outputs', result.channel], value: result.output }, { path: ['writing', 'draft'], value: draft }, { path: ['writing', 'brief'], value: { ...(project.writing?.brief || {}), channel: result.channel } }, ...(project.writing?.draft ? [{ path: ['writing', 'previousDraft'], value: clone(project.writing.draft) }] : [])];
  }
  async function assistWriting(args, ctx, state, task) {
    const project = await current(ctx, state, 'writing');
    if (task === 'writing-draft' && writingSelectionRequired(ctx.instruction)) throw fail(403, '本轮只改选中文字，请使用writing_revise保留选区外内容。', 'ASSISTANT_DIALOG_SCOPE');
    const referenceContext = await writingReferences.context(project);
    const channel = args.channel || (task === 'writing-revise' ? project.writing?.draft?.channel : null) || project.writing?.brief?.channel || 'auto';
    const input = { source: project.source || { text: '' }, facts: project.sourceChanged ? [] : project.facts || [], writingBrief: { ...(project.writing?.brief || {}), channel, goal: ctx.instruction.slice(0, 2000) || project.writing?.brief?.goal || '' }, writingPreferences: ctx.writingPreferences || {}, writingReferences: referenceContext, instruction: ctx.instruction.slice(0, 4000), dialogueInstruction: ctx.instruction.slice(0, 24000), operationInstruction: String(args.instruction || '').slice(0, 4000) };
    if (task === 'writing-revise') {
      input.output = project.writing?.draft?.channel === channel ? project.writing.draft.output : project.outputs?.[channel];
      input.quickIntent = args.quickIntent || '';
      if (!input.output) throw fail(400, '这个形式还没有稿件，可以先起草一份。', 'WRITING_DRAFT_REQUIRED');
      let selection = args.selection;
      if (writingSelectionRequired(ctx.instruction)) {
        const selected = currentAssistantWritingContext(project, state.writingContext).selection;
        if (!selected) throw fail(400, '本轮只允许修改选中文字，但当前没有仍有效的选区，请重新选择后继续。', 'WRITING_SELECTION_REQUIRED');
        selection ||= selected;
        if (JSON.stringify(selection.path) !== JSON.stringify(selected.path) || selection.start < selected.start || selection.end > selected.end) throw fail(403, '本轮只允许修改原选区内的文字。', 'ASSISTANT_DIALOG_SCOPE');
      }
      if (selection !== undefined) input.selection = normalizeWritingInput('writing-revise', { ...input, selection }).selection;
    }
    ctx.update(task === 'writing-draft' ? '正在按材料和你的表达习惯起草当前文稿' : '正在按要求精修当前稿件');
    const result = await ai(task, input, ctx.settings, { signal: ctx.signal });
    const latest = await current(ctx, state, 'writing'); check(ctx);
    try { if ((await writingReferences.context(latest)).fingerprint !== referenceContext.fingerprint) throw fail(409, '参考内容已更新，请按最新参考重新生成。', 'WRITING_REFERENCE_CHANGED'); }
    catch (error) { if (error.status === 409) state.conflicted = true; throw error; }
    const receipt = await commit(ctx, state, writingDraftPatch(project, result.data), task === 'writing-draft' ? '已保存个性化文稿' : '已保存精修后的文稿');
    if (result.data.revision?.mode === 'selection') {
      const revision = result.data.revision, selected = revision.selection, saved = await current(ctx, state, 'writing');
      state.writingContext = { channel: result.data.channel, writingRevision: saved.writingRevision || 0, outputFingerprint: assistantWritingFingerprint(result.data.output),
        selection: revision.replacement.length ? { path: [...selected.path], start: selected.start, end: selected.start + revision.replacement.length, text: revision.replacement } : null };
    }
    return { ...receipt, data: { ...receipt.data, channel: result.data.channel, evidence: result.data.evidence, notes: result.data.notes, summary: result.data.summary } };
  }

  const tools = [
    tool('project_list', '列出本机项目摘要。只能操作用户当前打开的项目；其他项目需要用户切换后再操作。', schema(), false, async () => ({ summary: '已读取项目摘要。', data: (await store.summary()).projects.slice(0, 40) })),
    tool('project_read', '读取当前项目原始材料、已确认事实、稿件和已选科普配置。', schema(), false, async (_args, ctx) => ({ summary: '已读取当前项目。', data: projectSummary(await owner(ctx)) })),
    tool('project_materials', '列出当前项目已导入的论文教材页段或视频参考资料。', schema(), false, async (_args, ctx) => {
      const project = await owner(ctx);
      return { summary: '已读取当前项目资料列表。', data: project.kind === 'science' ? await scienceDocuments.list(project.id) : project.kind === 'video' ? await references.list(project.id) : { source: project.source || null } };
    }),
    tool('document_read', '读取当前科普项目一份已导入资料。优先使用当前已选unitIds；返回页段ID、原文和是否截短，不会读取其他项目文件。', schema({ documentId: textField(128), unitIds: { type: 'array', maxItems: 160, items: textField(100) } }, ['documentId']), false, async (args, ctx) => {
      const project = await owner(ctx, 'science'), doc = await scienceDocuments.get(project.id, args.documentId, { signal: ctx.signal });
      const wanted = args.unitIds ? new Set(args.unitIds) : null;
      if (wanted && (wanted.size !== args.unitIds.length || [...wanted].some(id => !doc.units.some(unit => unit.id === id)))) throw fail(400, '资料页段编号无效。', 'SCIENCE_DOCUMENT_SELECTION_INVALID');
      let chars = 0, truncated = false;
      const units = [];
      for (const unit of doc.units.filter(unit => !wanted || wanted.has(unit.id))) {
        if (chars + unit.text.length > 24000) { truncated = true; break; }
        units.push({ id: unit.id, label: unit.label, text: unit.text, readable: unit.readable }); chars += unit.text.length;
      }
      return { summary: `已读取${units.length}个页段${truncated ? '；尚有页段未送入模型，可按ID继续读取' : ''}。`, data: { id: doc.id, title: doc.title, totalUnitCount: doc.totalUnitCount, units, truncated } };
    }),
    tool('library_read', '查看公用素材库中可用的人物、人设、语气、性格、表情和场景；不自动改变用户已选人物或场景。', schema(), false, async () => {
      const value = await novelLibrary.list();
      return { summary: '已读取公用素材库。', data: { characters: value.characters.map(({ id, name, role, tone, personality, portraits, ready }) => ({ id, name, role, tone, personality, portraits: (portraits || []).map(({ id, name }) => ({ id, name })), ready })), backgrounds: value.backgrounds.map(({ id, name, ready }) => ({ id, name, ready })) } };
    }),
    tool('project_update', '按用户明确要求修改当前项目标题或简介。', schema({ title: textField(120), description: { type: 'string', maxLength: 1000 } }), true, async (args, ctx, state) => {
      const patch = ['title', 'description'].filter(key => Object.hasOwn(args, key)).map(key => ({ path: [key], value: args[key] }));
      if (!patch.length) throw fail(400, '请提供要修改的标题或简介。', 'ASSISTANT_PATCH_EMPTY');
      const result = await commit(ctx, state, patch, '已更新项目资料');
      await openFilm?.syncMetadata?.(await store.read(ctx.projectId)).catch(() => {});
      return result;
    }),
    tool('draft_write', '把已经撰写好的草稿保存到当前项目指定渠道。content结构：article={title,lead,body,titles:[]}；social={title,text,tags:[]}；poster={title,subtitle,highlights:[],details:[],footer}；video={title,shots:[{duration,visual,narration,caption}]}。只写有资料依据的内容，不自动确认事实。', schema({ channel: { type: 'string', enum: CHANNELS }, content: { type: 'object' } }, ['channel', 'content']), true, async (args, ctx, state) => {
      const project = await current(ctx, state);
      if (project.kind !== 'writing') throw fail(400, '请在文案项目中保存宣传稿；视频项目可使用旁白工具，科普项目可生成互动讲解。', 'ASSISTANT_WRITING_REQUIRED');
      if (writingSelectionRequired(ctx.instruction)) throw fail(403, '本轮只改选中文字，请使用writing_revise保留选区外内容。', 'ASSISTANT_DIALOG_SCOPE');
      if (!CHANNELS.includes(args.channel)) throw fail(400, '稿件渠道无效。', 'INVALID_CHANNEL');
      const content = normalizeModelData('rewrite', args.content, { channel: args.channel });
      return commit(ctx, state, writingDraftPatch(project, { channel: args.channel, output: content, evidence: [], notes: ['由AI助手写入，具体表述可与材料对照。'], summary: '已保存当前稿件。' }), '已保存' + ({ article: '公众号稿件', poster: '海报文案', video: '短视频分镜', social: '社群文案' })[args.channel]);
    }),
    tool('writing_read', '按页读取当前文案的真实原始材料或稿件文字。channel省略时读取当前稿件；offset/maxChars继续长文，不把概览截断当全文。返回版本与材料出处，不授予额外修改范围。', schema({ section: { type: 'string', enum: ['source', 'draft'] }, channel: { type: 'string', enum: CHANNELS }, offset: { type: 'integer', minimum: 0 }, maxChars: { type: 'integer', minimum: 100, maximum: 12000 } }), false, async (args, ctx, state) => {
      const project = await current(ctx, state, 'writing');
      const channel = args.channel || project.writing?.draft?.channel || 'article';
      const output = project.writing?.draft?.channel === channel ? project.writing.draft.output : project.outputs?.[channel];
      const text = args.section === 'source' ? String(project.source?.text || '') : writingOutputText(channel, output);
      const offset = args.offset ?? 0, limit = args.maxChars ?? 10000;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 100 || limit > 12000) throw fail(400, '文案分页参数无效。', 'WRITING_PAGE_INVALID');
      const boundary = position => !(position > 0 && position < text.length && /[\uD800-\uDBFF]/.test(text[position - 1]) && /[\uDC00-\uDFFF]/.test(text[position]));
      if (!boundary(offset)) throw fail(400, '文案页起点不能切开一个字符，请使用上一页返回的位置。', 'WRITING_PAGE_INVALID');
      let next = Math.min(text.length, offset + limit); if (!boundary(next)) next--;
      const ledger = normalizeWritingMaterials(project.source || {});
      return { summary: '已读取当前文案实际文字页。', data: { channel, section: args.section || 'draft', text: text.slice(offset, next), writingRevision: project.writingRevision || 0, outputFingerprint: output ? digest(output) : null,
        pagination: { offset, returned: Math.max(0, next - offset), total: text.length, hasMore: next < text.length, nextOffset: next < text.length ? next : null }, materials: ledger.items, materialStatus: ledger.status } };
    }),
    tool('writing_create', '根据当前文案项目的真实材料、用户目标与表达偏好起草一份稿件，并保存到文案工作区。默认自动适配形式，不要求先逐条人工确认事实；保留其他渠道稿件与可回查材料依据。', schema({ channel: { type: 'string', enum: ['auto', ...CHANNELS] }, instruction: { type: 'string', maxLength: 4000 } }), true, (args, ctx, state) => assistWriting(args, ctx, state, 'writing-draft')),
    tool('writing_revise', '按用户一句话要求精修当前文案，不重写其他渠道；使用本次表达偏好，保留真实材料限定与可回查依据。', schema({ channel: { type: 'string', enum: CHANNELS }, instruction: { type: 'string', maxLength: 4000 }, quickIntent: { type: 'string', enum: ['shorter', 'natural', 'clearer', 'punchier', 'formal'] }, selection: schema({ path: { type: 'array', minItems: 1, maxItems: 3, items: { type: ['string', 'integer'] } }, start: { type: 'integer', minimum: 0 }, end: { type: 'integer', minimum: 1 }, text: { type: 'string', maxLength: 60000 } }, ['path', 'start', 'end']) }), true, (args, ctx, state) => assistWriting(args, ctx, state, 'writing-revise')),
    tool('video_script_write', '保存用户要求的新旁白文本到当前视频项目，不直接替换时间线。', schema({ text: textField(30000) }, ['text']), true, async (args, ctx, state) => { await current(ctx, state, 'video'); return commit(ctx, state, [{ path: ['video', 'script'], value: boundedString(args.text, '旁白', 30000) }], '已更新视频旁白'); }),
    tool('web_import', '真正读取一个公开网页或PDF，将正文导入当前项目。科普项目新增资料后由用户选择页段；视频项目新增文字参考；文案项目追加原始素材。只支持公网，不下载视频。', schema({ url: textField(2000) }, ['url']), true, async (args, ctx, state) => {
      let project = await current(ctx, state); ctx.update('正在读取公开链接正文');
      const value = await webTools.read(args.url, { signal: ctx.signal, maxChars: 24000 });
      const text = boundedString(value.text, '网页正文', 30000), source = { title: value.title || '网页资料', url: value.url };
      project = await current(ctx, state); check(ctx);
      const partialNote = value.truncated ? `单次读取上限：本次仅提取前${text.length}字，其余正文尚未读取。\n\n` : '';
      const content = `来源：${value.url}\n\n${partialNote}${text}`;
      let receipt;
      if (project.kind === 'science') {
        const imported = await scienceDocuments.importText(project.id, { title: String(source.title).slice(0, 300), text: content }, { signal: ctx.signal });
        const undo = imported.duplicate ? undefined : rememberUndo({ kind: 'document', projectId: project.id, documentId: imported.document.id, sourceHash: imported.document.sourceHash, createdAt: state.createdAt, runId: ctx.runId });
        receipt = { summary: imported.duplicate ? '此网页正文已在当前资料库中。' : '已导入科普资料，请在制作页选择本次使用的页段。', data: { documentId: imported.document.id, title: imported.document.title }, effects: imported.duplicate ? [] : [{ type: 'document', projectId: project.id, label: '已导入网页正文为科普资料', changed: true, undo }] };
      } else if (project.kind === 'video') {
        const result = await references.add(project.id, { type: 'text', name: String(source.title).slice(0, 120), text: content.slice(0, 12000), sourceUrl: value.url, focus: '联网助手导入的公开正文' });
        state.referenceRevision = result.revision;
        const item = result.items.at(-1), undo = rememberUndo({ kind: 'document', projectId: project.id, referenceId: item.id, referenceHash: digest(item), createdAt: state.createdAt, runId: ctx.runId });
        receipt = { summary: `已导入为视频文字参考${content.length > 12000 ? '（参考容量上限，保留前12000字）' : ''}。`, data: { referenceId: item.id }, effects: [{ type: 'document', projectId: project.id, label: '已导入网页文字参考', changed: true, undo }] };
      } else {
        const combined = appendWritingMaterial(project.source || { title: '', text: '', url: '' }, value);
        if (combined.text.length > 60000) throw fail(413, '追加后原始素材超过60000字，请先精简材料。', 'INPUT_TOO_LARGE');
        receipt = await commit(ctx, state, [{ path: ['source'], value: combined }], '已将网页正文及各自出处追加到原始素材');
      }
      return { ...receipt, summary: receipt.summary + (value.truncated ? ` 单次网页读取上限，本次仅提取正文前${text.length}字。` : ''), data: { ...receipt.data, truncated: value.truncated === true, readCharacters: text.length }, sources: [source] };
    }),
    tool('knowledge_generate', '根据科普制作页已经选好的资料页段、公用人物和场景生成单人单景视觉小说。保留用户的互动密度、人设、语气、性格和表情设置。缺少选择时说明缺项，不内置或自动选择人物场景。', schema({ instruction: { type: 'string', maxLength: 3000 } }), true, async (args, ctx, state) => {
      const project = await current(ctx, state, 'science'), settings = project.science?.novelConfig || {};
      const selection = settings.librarySelection || { characterId: settings.selectedCharacterId, backgroundId: settings.selectedBackgroundId };
      const [document, resolved] = await Promise.all([
        scienceDocuments.context(project.id, project.science?.documentSelection, { signal: ctx.signal, maxCharacters: 60000 }),
        novelLibrary.resolveSelection(selection, { signal: ctx.signal }),
      ]);
      ctx.update('正在根据所选材料编写讲解、知识卡和问答');
      const config = { ...resolved.config, interactionDensity: settings.interactionDensity || 'balanced', instruction: [settings.instruction, args.instruction, ctx.instruction].filter(Boolean).join('\n').slice(0, 3000) };
      const result = await ai('visual-novel', { projectId: project.id, document, config, assetCatalog: resolved.assetCatalog }, ctx.settings, { signal: ctx.signal });
      await current(ctx, state, 'science'); check(ctx);
      const latest = await novelLibrary.resolveSelection(selection, { signal: ctx.signal });
      if (digest(resolved) !== digest(latest)) conflict(state, '公用人物或场景在生成期间已修改，请重新生成以使用最新素材。');
      return commit(ctx, state, [{ path: ['science', 'novel'], value: serializePlayableNovel(result.data, latest) }, { path: ['science', 'novelStale'], value: false }, { path: ['science', 'novelSettingsChanged'], value: false }], '已生成单人单景互动讲解');
    }),
    tool('native_read', '读取当前工程素材库、参考库与时间线概览。assetOffset/assetLimit分页，默认100项最多200；保留type/query，用nextAssetOffset继续；assetCatalogVersion变化时从0重读，按id去重。source/registration区分原生素材和参考；参考登记不代表已进入时间线。素材页不等于全工程读完，时间线明细用native_inspect分页。界面选择为参考，写入遵守用户本轮明确要求。', schema({ assetOffset: { type: 'integer', minimum: 0, maximum: 1000000 }, assetLimit: { type: 'integer', minimum: 1, maximum: 200 }, type: { type: 'string', enum: ['video', 'image', 'audio'] }, query: { type: 'string', maxLength: 200 } }), false, async (args, ctx, state) => { const media = await readProjectMedia(ctx, state); return { summary: '已读取当前工程素材页与剪辑概览。', data: { ...nativeAssetSummary(media.native, media, args), editScope: state.scope } }; }),
    tool('native_inspect', '读取当前工程全部原生片段的稳定ID、轨道、源出入点、速度、音量、画框及锁定状态。编辑范围不限制读取；editable/withinEditScope提示当前写入边界。可用offset/limit分页，也可按clipIds、trackIndices、range筛选；返回真实total/nextOffset，不能把一页当全片。旧无参数读取保留兼容视图。', schema({ offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 300 }, trackOffset: { type: 'integer', minimum: 0 }, trackLimit: { type: 'integer', minimum: 1, maximum: 100 }, clipIds: { type: 'array', minItems: 1, maxItems: 200, items: textField(200) }, trackIndices: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'integer', minimum: 0 } }, range: schema({ start: { type: 'number', minimum: 0 }, end: { type: 'number', minimum: 0 } }, ['start','end']) }), false, async (args, ctx, state) => ({ summary: '已读取可精确调整的片段及分页信息。', data: preciseTimelineSummary(await readNative(ctx, state, Object.keys(args).length ? args : undefined, true), state.scope, true) })),
    tool('native_motion_read', '按真实clipId和属性读取完整或分页关键帧。默认单属性100个，最多200个；返回totalKeys/nextOffset/sha256。native_inspect默认只显示前40，不能用截断快照覆盖原曲线；可分批motion mode=patch保留未改点，显式整体替换需replaceAll和当前hash。', schema({ clipId: textField(200), property: { type: 'string', enum: ['translate', 'scale', 'rotate', 'opacity'] }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 200 } }, ['clipId','property']), false, async (args, ctx, state) => {
      const native = await readNative(ctx, state, { clipIds: [args.clipId], limit: 1, motionProperty: args.property, motionKeyOffset: args.offset || 0, motionKeyLimit: args.limit || 100 }, true);
      const described = preciseTimelineSummary(native, state.scope, true), clip = described.clips.find(clip => clip.id === args.clipId), coverage = clip?.motionCoverage?.[args.property];
      if (!clip || !coverage) throw fail(404, '当前工程没有该片段的可读取关键帧。', 'NATIVE_MOTION_NOT_FOUND');
      return { summary: '已读取实际关键帧与完整曲线校验信息。', data: { clipId: clip.id, property: args.property, keys: clip.motion[args.property], ...coverage, revision: native.revision, editable: clip.editable, withinEditScope: clip.withinEditScope, ...(clip.unavailableReason ? { unavailableReason: clip.unavailableReason } : {}) } };
    }),
    tool('media_asset_import', '将当前工程参考库里已登记的视频或图片真正导入剪辑素材库，不需要重新下载。输入参考assetId，返回实际导入后的asset.id；之后用新ID剪辑。仅登记素材，timelineChanged=false；已在素材库时直接返回真实登记信息，不伪造时间线或成片凭据。', schema({ assetId: textField(100) }, ['assetId']), true, async (args, ctx, state) => {
      const { assets, registrations, native } = await readProjectMedia(ctx, state);
      const asset = assets.find(item => item.id === args.assetId);
      if (!asset || !['video', 'image'].includes(asset.type)) throw fail(403, '请使用当前工程素材库或参考库中已登记的视频或图片。', 'ASSISTANT_MEDIA_SCOPE');
      if (state.dialogueConstraint?.assetIds && !state.dialogueConstraint.assetIds.includes(asset.id)) throw fail(403, '此素材不在用户本轮明确指定的素材范围内。', 'ASSISTANT_MEDIA_SCOPE');
      if (registrations.get(asset.id)?.nativeImported) return { summary: '此素材已在当前剪辑素材库，可直接使用。', data: { imported: true, alreadyImported: true, asset: mediaResult(asset), revision: native.revision, timelineChanged: false }, effects: [] };
      if (!openFilm?.importAsset) throw fail(503, '原生素材导入服务尚未就绪。', 'OPENFILM_UNAVAILABLE');
      ctx.update('正在将参考素材导入当前剪辑素材库');
      const result = await openFilm.importAsset(ctx.projectId, asset.id, ctx.origin, { expectedRevision: state.nativeRevision, requestId: `${ctx.runId}-${ctx.callId}`, signal: ctx.signal });
      state.nativeRevision = result.revision;
      if (result.imported !== true || !result.asset?.id) throw fail(422, '未取得当前剪辑素材库的真实导入凭据。', 'ASSISTANT_MEDIA_IMPORT_INCOMPLETE');
      const receipt = { summary: '参考素材已导入当前剪辑素材库，尚未修改时间线。', data: { imported: true, asset: mediaResult(result.asset), sourceAssetId: asset.id, revision: result.revision, ownerCreatedAt: state.createdAt, timelineChanged: false }, effects: [{ type: 'media', projectId: ctx.projectId, ownerCreatedAt: state.createdAt, changed: result.alreadyImported !== true, importedAssetId: result.asset.id, label: '已导入参考素材：' + result.asset.name }] };
      try {
        await current(ctx, state, 'video');
        const importedNative = await readNative(ctx, state);
        if (!importedNative.assets.some(item => item.id === result.asset.id)) throw fail(422, '未取得当前剪辑素材库的真实导入凭据。', 'ASSISTANT_MEDIA_IMPORT_INCOMPLETE');
      } catch (error) {
        if (!['REQUEST_CANCELLED', 'ASSISTANT_CONFLICT', 'ASSISTANT_PROJECT_NOT_FOUND'].includes(error.code)) throw error;
        // Keep the trusted committed import receipt when Stop or a newer owner
        // ends follow-up work; never attribute it to the replacement project.
        return { ...receipt, summary: '参考素材导入已完成，后续处理已停止。', data: { ...receipt.data, currentProjectConfirmed: false, error: { code: error.code, message: error.message } } };
      }
      return receipt;
    }),
    tool('media_asset_read', '读取当前工程素材库或参考库中已登记素材的真实技术信息：时长、帧率/时基、尺寸、视频编码、音轨编码/采样率/声道。输入已有assetId；不凭文件名推画面，不读取任意路径。', schema({ assetId: textField(100) }, ['assetId']), false, async (args, ctx, state) => { const {assets:allowed}=await readProjectMedia(ctx,state); if(!allowed.some(asset=>asset.id===args.assetId))throw fail(403,'素材不属于当前工程素材库或参考库。','ASSISTANT_MEDIA_SCOPE'); if(!videoService?.readAssetMetadata)throw fail(503,'素材技术信息服务尚未就绪。','ASSISTANT_MEDIA_UNAVAILABLE'); const raw=await videoService.readAssetMetadata(args.assetId,{signal:ctx.signal}); const live=await readProjectMedia(ctx,state);check(ctx);if(!live.assets.some(asset=>asset.id===args.assetId))throw fail(403,'素材已从当前工程移除。','ASSISTANT_MEDIA_SCOPE');const data={...raw,registration:live.registrations.get(args.assetId)};state.assetMetadata.set(args.assetId,data); return{summary:'已读取实际素材参数。',data}; }),
    ...(frameReader ? [
      tool('media_frames_read', '读取当前素材的实际画面并直接交给创作助手看。视频默认全长、每2秒一帧、每页12帧；按pagination.nextOffset继续即可读完整采样计划，无需用户填时间。mode=shots按本地镜头估计读取，windowIndex继续长片；timestamps可细看动作/转场。图片读原图。返回inspectionId用于media_frame_notes和media_frames_recall，画面是实际采样不是逐帧完整验收。', schema({ assetId:textField(100),mode:{type:'string',enum:['interval','shots']},range:schema({start:{type:'number',minimum:0},end:{type:'number',minimum:0}},['start','end']),timestamps:{type:'array',minItems:1,maxItems:240,items:{type:'number',minimum:0}},intervalSeconds:{type:'number',minimum:.04,maximum:3600},page:{type:'integer',minimum:0},offset:{type:'integer',minimum:0},pageSize:{type:'integer',minimum:1,maximum:12},windowIndex:{type:'integer',minimum:0} },['assetId']), false, async(args,ctx,state)=>{ const {assets:allowed}=await readProjectMedia(ctx,state);if(!allowed.some(asset=>asset.id===args.assetId))throw fail(403,'素材不属于当前工程素材库或参考库。','ASSISTANT_MEDIA_SCOPE');ctx.update('正在读取实际参考画面');const {assetId,...options}=args, result=await frameReader.read(ctx.projectId,assetId,{...options,origin:ctx.origin,signal:ctx.signal});await current(ctx,state);check(ctx);if(!state.referenceInspectionIds.includes(result.data.inspectionId))state.referenceInspectionIds.push(result.data.inspectionId);state.referenceInspectionAssets.set(result.data.inspectionId,result.data.asset.id);if(state.referenceInspectionIds.length>256)state.referenceInspectionAssets.delete(state.referenceInspectionIds.shift());state.lastFramePagination=result.data.pagination;return{summary:`已读取${result.data.frames.length}张实际画面，${result.data.pagination.hasMore?'还有下一页。':'本批读取完成。'}`,data:result.data,imageBatch:result.images.map(image=>({...image,detail:'high'}))}; }, {images: result=>result.imageBatch}),
      tool('media_frame_notes', '根据刚才实际看到的画面登记文字、布局、状态和运动观察。必须使用本轮inspectionId与其中真实frameIndex；每批看图后先登记再翻页，供后续Remotion生成使用。描述有不确定处应标明，不把登记当成已制作或验证。', ASSISTANT_FRAME_NOTES_SCHEMA, false, async(args,ctx,state)=>{if(!state.referenceInspectionIds.includes(args.inspectionId))throw fail(400,'请先读取本轮参考画面。','ASSISTANT_REFERENCE_RECEIPT_REQUIRED');const page=await frameReader.receipt(args.inspectionId,{projectId:ctx.projectId,origin:ctx.origin,signal:ctx.signal}),{assets:allowed}=await readProjectMedia(ctx,state);if(!allowed.some(asset=>asset.id===page.data.asset.id))throw fail(403,'参考素材已不属于当前工程。','ASSISTANT_MEDIA_SCOPE');const data=await state.referenceContext.record(ctx.projectId,args,{origin:ctx.origin,signal:ctx.signal});return{summary:'已登记绑定实际画面的参考观察。',data};}),
      tool('media_frames_recall', '重新查看本轮实际读取或登记过的参考画面与观察。inspectionIds限定批次，assetId限定源，offset顺序翻图；未给offset时均匀挑代表图。返回覆盖/遗漏/下一页，生成模型只看到selectedImageFrames，不把全部描述说成本次看到全部图。', schema({inspectionIds:{type:'array',minItems:1,maxItems:256,items:textField(100)},assetId:textField(100),offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:12}}),false,async(args,ctx,state)=>{const snapshot=await frameReference(ctx,state,{inspectionIds:args.inspectionIds||state.referenceInspectionIds,assetId:args.assetId,maxImages:args.limit||12,imageOffset:args.offset});if(!snapshot)throw fail(400,'请先读取本轮参考画面。','ASSISTANT_REFERENCE_RECEIPT_REQUIRED');return{summary:'已读取实际参考画面及覆盖记录。',data:snapshot.context,imageBatch:snapshot.images.map(image=>({...image,detail:'high'}))};},{images:result=>result.imageBatch}),
      tool('remotion_compare_reference','将当前Remotion实际渲染画面与本轮原视频帧按源时间对照，默认1:1秒且不把短片按比例压缩冒充完整参考。offset/limit分页，每批最多6对；按coverage.nextOffset继续。先读取并登记参考，再输入实际源码id/revision；只报告本批真实差异，不声称已看全部帧或音频。',schema({id:textField(100),expectedRevision:{type:'integer',minimum:1},compositionId:textField(160),assetId:textField(100),offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:6},instruction:textField(6000)},['id','expectedRevision']),false,async(args,ctx,state)=>{await current(ctx,state,'video');if(!remotion?.compareReference)throw fail(503,'参考对照服务尚未就绪。','REMOTION_UNAVAILABLE');const options=await referenceOptions(ctx,state,{assetId:args.assetId,maxImages:args.limit||6,imageOffset:args.offset||0});if(!options.referenceEvidence)throw fail(400,'请先读取本轮参考画面。','ASSISTANT_REFERENCE_RECEIPT_REQUIRED');const data=await remotion.compareReference(ctx.projectId,args.id,{expectedRevision:args.expectedRevision,compositionId:args.compositionId,instruction:args.instruction||ctx.instruction,settings:ctx.settings,signal:ctx.signal,...options});return{summary:data.status==='reviewed'?'已对照本批实际参考与成品画面。':'本批参考对照未完成，原因见返回结果。',data};}),
    ] : []),
    tool('media_analyze', '按真实画面对照分析当前素材库或参考库，返回有帧证据的内容线索、镜头用途、运动与可用区间。assetIds可点名最多8份素材；assetOffset按当前完整素材库继续批量分析。视频每源本批最多300秒，range继续源区间，shotOffset/shotLimit继续该区间的镜头页。默认12帧；视觉每页最多12张图、6段镜头，实际页长受maxFrames的双帧预算限制并由pagination说明。只有transcribe=true才转写音频，识图与转写覆盖分别记录。', schema({ assetIds: { type: 'array', maxItems: 8, minItems: 1, items: textField(100) }, assetOffset: { type: 'integer', minimum: 0 }, shotOffset: { type: 'integer', minimum: 0 }, shotLimit: { type: 'integer', minimum: 1, maximum: 6 }, range:schema({start:{type:'number',minimum:0},end:{type:'number',minimum:0}},['start','end']), transcribe: { type: 'boolean' }, transcriptionModel:textField(300),maxFrames:{type:'integer',minimum:1,maximum:24},maxShotSeconds:{type:'number',minimum:2,maximum:120} }), false, async (args, ctx, state) => {
      const { assets: allowed } = await readProjectMedia(ctx, state);
      if (args.assetIds && args.assetOffset !== undefined) throw fail(400, '请使用素材编号或素材页位置其中一种方式。', 'ASSISTANT_MEDIA_PAGE');
      const offset = args.assetOffset ?? 0;
      const ids = args.assetIds || allowed.slice(offset, offset + 8).map(asset => asset.id);
      if (!ids.length || ids.some(id => !allowed.some(asset => asset.id === id))) throw fail(403, '只能处理当前工程素材库或参考库中已登记的素材。', 'ASSISTANT_MEDIA_SCOPE');
      if (!sourceAnalysis?.analyze) throw fail(503, '本机素材分析服务尚未就绪。', 'ASSISTANT_MEDIA_UNAVAILABLE');
      const sources = [...new Set(ids)].map(assetId => {
        const asset = allowed.find(item => item.id === assetId);
        const start = args.range?.start ?? 0, end = Math.min(args.range?.end ?? asset.duration, start + 300);
        return { assetId, start, end };
      });
      ctx.update('正在抽取真实画面并分析所选素材');
      const result = await sourceAnalysis.analyze(ctx.projectId, { sources, options: { visualSummary: true, model: ctx.settings?.model, transcribe: args.transcribe === true, transcriptionModel: args.transcriptionModel || 'whisper-1', maxFrames: args.maxFrames ?? 12, maxShotSeconds: args.maxShotSeconds || 120, ...(args.shotOffset !== undefined ? { shotOffset: args.shotOffset } : {}), ...(args.shotLimit !== undefined ? { shotLimit: Math.min(args.shotLimit, Math.max(1, Math.floor(Math.min(12, args.maxFrames ?? 12) / 2))) } : {}), audioChunkSeconds: 120 } }, { origin: ctx.origin, settings: ctx.settings, signal: ctx.signal });
      await current(ctx, state); check(ctx);
      const visual = result.items?.some(item => item.summary?.kind === 'visual-sampled'), speech = result.items?.some(item => ['complete', 'partial'].includes(item.transcript?.status));
      const nextAssetOffset = !args.assetIds && offset + ids.length < allowed.length ? offset + ids.length : null;
      const assetPagination = { mode: args.assetIds ? 'explicit-assets' : 'project-page', offset: args.assetIds ? null : offset, limit: 8, total: allowed.length, analyzedAssetIds: [...new Set(ids)], returned: result.items?.length || 0, nextAssetOffset, hasMore: nextAssetOffset !== null };
      const sourceWindows = sources.map(source => { const asset = allowed.find(item => item.id === source.assetId), requestedEnd = Math.min(args.range?.end ?? asset.duration, asset.duration); return { ...source, requestedEnd, nextRange: Number.isFinite(requestedEnd) && source.end < requestedEnd ? { start: source.end, end: Math.min(requestedEnd, source.end + 300) } : null }; });
      return { summary: visual ? '已根据本批真实画面对照整理素材依据。' + (speech ? '已取得所列范围的音频转写。' : '音频未转写不影响纯视觉制作；按返回页位置继续读取。') : '已取得本地素材技术信息；视觉识别未完成，具体原因见返回说明。', data: { assetPagination, sourceWindows, items: result.items?.map(item => ({ assetId: item.assetId, range: item.range, shots:item.shots,keyframes:item.keyframes,frames:item.frames,pagination:item.pagination,coverage:item.coverage,summary: item.summary, transcript: item.transcript, warnings: item.warnings })), warnings: result.warnings } };
    }),
    tool('native_edit', '根据本轮明确要求修改当前视频。自动读取真实工程、已有分析和参考；界面勾选与放置为参考，修改边界以用户当前对话明确要求为准，成功后可撤销。', schema({ instruction: textField(6000) }, ['instruction']), true, editNative),
    tool('native_adjust', '精确批量调整现有片段：split分割、trim修剪、move移动、remove删除、duplicate复制、speed变速、volume音量、fade、transform、look、motion、caption。先native_inspect取得clipId/limits；既有长时间线可保持或缩短，不能增长。at是作品秒数，trim为源秒数；motion时间为片段内秒数。motion mode=patch按时间保留未提供点，整体replace原曲线超过40时必须replaceAll=true与当前expectedMotionHash，先native_motion_read，不把截断快照当完整曲线。同批原子校验，保留scope/锁定/CAS/撤销；split/duplicate新ID由结果返回。', preciseEditSchema, true, adjustNative),
    tool('animation_create', '按要求创建真正的多文件React/TSX Remotion工程，实际编译与采样画面复核后改进，再完整渲染。append=false先保存可审阅成片而不改时间线；默认加入时，自由创作先用native_scope_set自主决定具体位置，无需用户手填时间。参考准备完成后直接调用此制作工具，不能把逐帧无法百分百验证作为不开始的理由。', schema({ instruction: textField(6000),append:{type:'boolean'} }, ['instruction']), true, renderAnimation),
    tool('remotion_reference_search', '检索video-shotcraft实际镜头/相机/运动数学/排版/多轨代码参考。返回出处和key；不是模板选项，不执行上游代码。可按具体视觉或编辑机制选择。', schema({ query: textField(6000), limit: { type: 'integer', minimum: 1, maximum: 10 } }, ['query']), false, async args => ({ summary: '已检索本机镜头与动效源码参考。', data: { references: await searchRemotionReferences(args.query, { limit: args.limit || 3 }) } })),
    tool('remotion_reference_read', '读取选定key的完整真实Remotion源码、依赖、helper和改写说明。按当前素材/画幅/时间表独立改写并保留必要归属，不照搬演示文案/资产或缺失包。', schema({ key: textField(100) }, ['key']), false, async args => ({ summary: '已读取有固定出处的镜头/动效源码。', data: await readRemotionReference(args.key) })),
    tool('remotion_list', '列出当前视频项目保存的自由Remotion源码工程及版本，供继续编辑。', schema(), false, async (_args, ctx) => {
      await owner(ctx, 'video'); if (!remotion) throw fail(503, '自由Remotion服务尚未就绪。', 'REMOTION_UNAVAILABLE');
      return { summary: '已读取自由动画工程。', data: { projects: await remotion.list(ctx.projectId) } };
    }),
    tool('remotion_read', '读取已有Remotion真实源文件、入口和Composition。大型工程可指定paths按文件读取；不要凭空猜测源代码。', schema({ id: textField(100), paths: { type: 'array', maxItems: 128, items: textField(240) } }, ['id']), false, async (args, ctx) => {
      await owner(ctx, 'video'); if (!remotion) throw fail(503, '自由Remotion服务尚未就绪。', 'REMOTION_UNAVAILABLE');
      const record = await remotion.read(ctx.projectId, args.id);
      if (args.paths) { if (args.paths.some(name => !record.files.some(file => file.path === name))) throw fail(404, '工程中不存在所指定的源文件。', 'REMOTION_FILE_NOT_FOUND'); record.fileList = record.files.map(file => file.path); record.files = record.files.filter(file => args.paths.includes(file.path)); }
      return { summary: '已读取真实Remotion源码。', data: record };
    }),
    tool('remotion_edit', '按明确要求修改已有自由Remotion工程，读取当前版本后完整重写需改的文件，再实际编译、渲染。大型工程可指定paths缩小本次代码上下文，未返回文件保留。默认只生成视频不加入时间线；append=true才加入所选范围。', schema({ remotionId: textField(100), expectedRevision: { type: 'integer', minimum: 1 }, instruction: textField(6000), paths: { type: 'array', minItems: 1, maxItems: 128, items: textField(240) }, append: { type: 'boolean' } }, ['remotionId', 'expectedRevision', 'instruction']), true, (args, ctx, state) => renderAnimation({ ...args, append: args.append === true }, ctx, state)),
    tool('remotion_inspect', '实际编译并读取自由工程的真实Composition列表、尺寸、帧率和时长，生成或改代码后可检查，不靠模型猜测。', schema({ remotionId: textField(100), expectedRevision: { type: 'integer', minimum: 1 } }, ['remotionId', 'expectedRevision']), false, async (args, ctx) => {
      await owner(ctx, 'video'); if (!remotion) throw fail(503, '自由Remotion服务尚未就绪。', 'REMOTION_UNAVAILABLE');
      return { summary: '已实际检查Remotion工程。', data: await remotion.inspect(ctx.projectId, args.remotionId, { expectedRevision: args.expectedRevision, signal: ctx.signal }) };
    }),
    tool('remotion_review', '实际渲染镜头主画面、停留和转场附近采样图，交给当前图片模型复核可读性、裁切遮挡和构图。反馈缺少必要对照时用samplingRequests补看同一动作、停留、收尾或转场：每组2至4个当前Composition秒数（不是素材源时间或原生时间线坐标），最多3组。结论只代表真实采样；可按具体反馈继续修改和复查。', schema({ remotionId: textField(100), expectedRevision: { type: 'integer', minimum: 1 }, compositionId: textField(120), instruction: { type: 'string', maxLength: 6000 }, samplingRequests: remotionSamplingRequestsSchema }, ['remotionId', 'expectedRevision']), false, async (args, ctx) => {
      await owner(ctx, 'video'); if (!remotion?.review) throw fail(503, '画面复核服务尚未就绪。', 'REMOTION_UNAVAILABLE');
      const review = await remotion.review(ctx.projectId, args.remotionId, { expectedRevision: args.expectedRevision, compositionId: args.compositionId, instruction: args.instruction || ctx.instruction, ...(args.samplingRequests !== undefined ? { samplingRequests: args.samplingRequests } : {}), settings: ctx.settings, signal: ctx.signal, onProgress: value => ctx.update(value) });
      return { summary: review.status === 'reviewed' ? '已依据实际采样图完成画面复核，结论仅限所列帧。' : review.summary, data: review };
    }),
    tool('remotion_render', '实际渲染已保存的自由Remotion工程；支持preview预览帧或完整视频，append=true才加入当前时间线。先remotion_read核对版本，不能把保存源码说成渲染完成。', schema({ remotionId: textField(100), expectedRevision: { type: 'integer', minimum: 1 }, compositionId: textField(120), preview: { type: 'boolean' }, frames: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'integer', minimum: 0 } }, append: { type: 'boolean' } }, ['remotionId', 'expectedRevision']), true, async (args, ctx, state) => {
      await owner(ctx, 'video'); if (!remotion) throw fail(503, '自由Remotion服务尚未就绪。', 'REMOTION_UNAVAILABLE');
      const record = await remotion.read(ctx.projectId, args.remotionId);
      if (record.revision !== args.expectedRevision) throw fail(409, 'Remotion代码版本已变化，请重新读取。', 'REMOTION_REVISION_CONFLICT');
      return renderRemotionProject({ ...args, append: args.append === true }, ctx, state, record);
    }),
    tool('project_jobs', '查看当前项目实际渲染、动画和原生导出任务，区分排队、运行、完成和失败。', schema(), false, async (_args, ctx) => { const project = await owner(ctx); return { summary: '已读取实际任务状态。', data: { media: await videoService?.listJobs?.({ projectId: project.id }) || [], native: project.kind === 'video' ? await openFilm.nativeExports(project.id) : [] } }; }),
  ];
  if (videoImporter || downloads?.mediaAsset) {
    tools.push(tool('media_import_url', '下载并处理用户要求的公开图片或视频：剪辑项目导入可编辑原生素材库，随后native_read/native_edit；科普项目先AI识图或视频抽样整理，再导入可引用文字资料。原件或处理失败时如实返回，不代表成片已完成。', schema({ url: textField(2000), kind: { type: 'string', enum: ['image', 'video'] } }, ['url', 'kind']), true, importOnlineMedia));
    tools.push(tool('video_import_url', '真正下载公开的视频直链或受支持的B站/YouTube单视频，导入当前视频项目原生素材库；空素材工程也可用。candidateId可绑定已读素材候选的实际出处。成功后需要native_read/native_edit才能制作或追加成片。', schema({ url: textField(2000), candidateId: textField(100) }, ['url']), true, (args, ctx, state) => importOnlineMedia({ ...args, kind: 'video' }, ctx, state)));
  }
  if (downloads) {
    // Saving a public original file is available with or without a project.
    // It intentionally bypasses the project-mutation wrapper, never its scope.
    tools.push({ name: 'web_download', description: '把已找到的公开资料原文件真正下载到本机资料区，返回文件卡和保存原文件入口。支持PDF、Office文档、文本及常用资料格式；不会把提取的正文伪造成原文件。下载后若用户要求，可继续download_import导入当前科普项目。', inputSchema: schema({ url: textField(2000) }, ['url']), mutating: true, async execute(args, ctx) {
      check(ctx); if (ctx.mode === 'ask') throw fail(403, '仅问答模式不会下载或保存文件。', 'ASSISTANT_READ_ONLY');
      const state = ctx.projectId ? await stateFor(ctx) : null;
      if (state) await current(ctx, state);
      const result = await downloads.download(args.url, { projectId: ctx.projectId || null, runId: ctx.runId, signal: ctx.signal, onProgress: ({ receivedBytes, totalBytes }) => ctx.update(totalBytes ? `正在下载原文件 · ${Math.min(100, Math.round(receivedBytes / totalBytes * 100))}%` : `正在下载原文件 · ${(receivedBytes / 1024 / 1024).toFixed(1)} MB`) });
      const file = result.download;
      return { summary: (result.duplicate ? '本机已保存并核验这份原文件：' : '原文件已下载到本机资料区：') + file.name, data: { download: file, warnings: result.warnings || [] }, effects: [fileEffect(file, !result.duplicate)], sources: [{ title: file.name, url: file.url }] };
    } });
    tools.push({ name: 'download_list', description: '查看当前项目及公用未绑定项目的已下载原文件，显示可以保存的文件卡；无项目时查看未绑定项目的资料。可在后续对话找回刚下载的文件编号。', inputSchema: schema(), mutating: false, async execute(_args, ctx) {
      check(ctx); const result = await downloads.list({ projectId: ctx.projectId || null });
      return { summary: '已读取本机资料下载区。', data: result, effects: result.downloads.slice(0, 20).map(file => fileEffect(file, false)) };
    } });
    tools.push(tool('download_import', '把已经下载的PDF、DOCX、TXT或Markdown原文件导入当前科普资料库，解析页段供用户选择；不擅自改变已选人物、场景或页段。', schema({ downloadId: textField(36) }, ['downloadId']), true, async (args, ctx, state) => {
      await current(ctx, state, 'science'); check(ctx);
      const file = (await downloads.read(args.downloadId, { projectId: ctx.projectId })).download;
      if (/^image\//.test(file.contentType)) {
        const media = await downloads.mediaAsset(args.downloadId, { projectId: ctx.projectId, signal: ctx.signal });
        return { ...await prepareKnowledge(ctx, state, media.asset, file.url), sources: [{ title: file.name, url: file.url }] };
      }
      const result = await downloads.importFile(args.downloadId, { projectId: ctx.projectId, signal: ctx.signal });
      const undo = result.duplicate ? undefined : rememberUndo({ kind: 'document', projectId: ctx.projectId, documentId: result.document.id, sourceHash: result.document.sourceHash, createdAt: state.createdAt, runId: ctx.runId });
      return { summary: result.duplicate ? '这份原文件已经在当前科普资料库中。' : '已导入原文件并解析资料页段，请在科普制作页选择本次使用的内容。', data: { documentId: result.document.id, title: result.document.title, totalUnitCount: result.document.totalUnitCount, warnings: result.document.warnings || [] }, effects: result.duplicate ? [] : [{ type: 'document', projectId: ctx.projectId, label: '已导入下载的原始资料', changed: true, undo }], sources: [{ title: result.download.name, url: result.download.url }] };
    }));
    tools.push(tool('download_media_import', '把下载区已保存的真实图片、视频或音频复用导入当前剪辑素材库。保持原文件、真实技术信息和出处，不重新下载，不自动改时间线；导入后可继续分析和剪辑。', schema({ downloadId: textField(36) }, ['downloadId']), true, async (args, ctx, state) => {
      await current(ctx, state, 'video'); await readNative(ctx, state);
      const prepared = await downloads.mediaAsset(args.downloadId, { projectId: ctx.projectId, signal: ctx.signal });
      await current(ctx, state, 'video'); check(ctx);
      if (!['image', 'video', 'audio'].includes(prepared.asset.type)) throw fail(400, '下载文件不是支持的实际媒体素材。', 'ASSISTANT_MEDIA_TYPE');
      if (state.dialogueConstraint?.assetIds && !state.dialogueConstraint.assetIds.includes(prepared.asset.id)) throw fail(403, '本轮对话限定已有素材，不能追加其他素材。', 'ASSISTANT_DIALOG_SCOPE');
      const imported = await openFilm.importAsset(ctx.projectId, prepared.asset.id, ctx.origin, { expectedRevision: state.nativeRevision, requestId: `${ctx.runId}-${ctx.callId}`, signal: ctx.signal });
      if (imported.imported !== true || !imported.asset?.id) throw fail(422, '未取得当前剪辑素材库的真实导入凭据。', 'ASSISTANT_MEDIA_IMPORT_INCOMPLETE');
      state.nativeRevision = imported.revision;
      if (Array.isArray(state.scope.assetIds) && !state.dialogueConstraint?.assetIds) state.scope.assetIds = [...new Set([...state.scope.assetIds, imported.asset.id])];
      const sourcePage = prepared.download.provenance?.sourcePage;
      return { summary: imported.alreadyImported === true ? '此原始媒体已在当前素材库，可继续使用。' : '已将保存的原始媒体登记到当前素材库，可继续按要求制作。', data: { imported: true, alreadyImported: imported.alreadyImported === true, assetId: imported.asset.id, asset: mediaResult(imported.asset), sourceAssetId: prepared.asset.id, downloadId: args.downloadId, revision: imported.revision, timelineChanged: false, provenance: prepared.download.provenance },
        effects: [{ type: 'media', projectId: ctx.projectId, ownerCreatedAt: state.createdAt, importedAssetId: imported.asset.id, changed: imported.alreadyImported !== true && imported.duplicate !== true, label: '已导入保存的媒体素材' }],
        sources: [{ title: sourcePage?.title || prepared.download.name, url: sourcePage?.url || prepared.download.url }] };
    }));
    if (mediaUnderstanding) tools.push(tool('media_prepare_import', '识别下载区已保存图片或视频的本批文字和知识内容，成功后导入可回查的科普资料。视频可用range、frameOffset和framePageSize继续源区间及画面页，按实际覆盖范围使用结果。', schema({ downloadId: textField(36), range: schema({ start: { type: 'number', minimum: 0 }, end: { type: 'number', minimum: 0 } }, ['start', 'end']), frameOffset: { type: 'integer', minimum: 0 }, framePageSize: { type: 'integer', minimum: 1, maximum: 12 } }, ['downloadId']), true, async (args, ctx, state) => {
      await current(ctx, state, 'science');
      const result = await downloads.mediaAsset(args.downloadId, { projectId: ctx.projectId, signal: ctx.signal });
      const sampling = Object.fromEntries(['range', 'frameOffset', 'framePageSize'].filter(key => args[key] !== undefined).map(key => [key, args[key]]));
      const prepared = await prepareKnowledge(ctx, state, result.asset, result.download.url, sampling);
      return { ...prepared, data: { ...prepared.data, downloadId: args.downloadId }, sources: [{ title: result.download.name, url: result.download.url }] };
    }));
  }
  if (musicCuts) {
    const musicInput = { musicAssetId: textField(100), musicClipId: textField(100), sourceRange: schema({ start: { type: 'number', minimum: 0 }, end: { type: 'number', minimum: 0 } }, ['start', 'end']) };
    tools.push(tool('music_analyze', '读取当前工程用户音乐的真实PCM节奏分析：BPM候选、源绝对秒拍点/起音、强度和不确定性。音乐素材或片段必须已登记，不能凭名字猜拍点；inferred补点不是实际起音。用户仅分析时用此读操作。', schema(musicInput), false, async (args, ctx, state) => {
      await current(ctx, state, 'video'); await readNative(ctx, state);
      const data = await musicCuts.analyze({ ...args, projectId: ctx.projectId }, { origin: ctx.origin, signal: ctx.signal });
      await current(ctx, state); await readNative(ctx, state);
      return { summary: data.status === 'ready' ? `已测量音乐节奏，约${data.bpm} BPM；拍点按源秒数返回。` : '已测量音乐，但节奏不明确或没有可靠拍点，不能强行宣称自动卡点。', data };
    }));
    tools.push(tool('music_autocut', '按当前用户音乐的真实拍点自动剪辑已选画面素材；内部重新核对音频与工程版本，不接受模型提供的拍点数组/BPM均分。音乐可指定工程内素材或已有音乐片段。保留目标范围外及其它轨道，有真实撤销；uncertain/无拍默认不写，素材不足需补素材或明确循环。', schema({ ...musicInput,
      assetIds: { type: 'array', minItems: 1, maxItems: 256, items: textField(100) }, range: schema({ start: { type: 'number', minimum: 0 }, end: { type: 'number', minimum: 0 } }, ['start', 'end']),
      cadence: { type: 'string', enum: ['auto', 'beat', 'half', 'strong'] }, allowUncertain: { type: 'boolean' }, reuseSources: { type: 'boolean' },
      timelineAt: { type: 'number', minimum: 0 }, musicSpeed: { type: 'number', minimum: .1, maximum: 100 }, musicVolume: { type: 'number', minimum: 0, maximum: 4 }, originalVolume: { type: 'number', minimum: 0, maximum: 4 },
    }), true, async (args, ctx, state) => {
      await current(ctx, state, 'video'); await readNative(ctx, state);
      const rhythm = await musicCuts.analyze({ projectId: ctx.projectId, musicAssetId: args.musicAssetId, musicClipId: args.musicClipId, sourceRange: args.sourceRange }, { origin: ctx.origin, signal: ctx.signal });
      const native = await readNative(ctx, state);
      if (native.revision !== rhythm.nativeRevision) conflict(state, '音乐识别期间时间线已有变化，请重新读取后处理。');
      const clip = rhythm.musicClip, speed = clip?.speed ?? args.musicSpeed ?? 1;
      const baseStart = clip?.sourceStart ?? args.sourceRange?.start ?? rhythm.coverage.requestedStart ?? rhythm.coverage.start;
      const baseEnd = clip?.sourceEnd ?? args.sourceRange?.end ?? rhythm.coverage.requestedEnd ?? rhythm.coverage.end;
      const sourceStart = Math.max(baseStart, rhythm.coverage.start), sourceEnd = Math.min(baseEnd, rhythm.coverage.end);
      const at = (clip?.timelineAt ?? args.timelineAt ?? 0) + (sourceStart - baseStart) / speed;
      const span = { start: at, end: at + (sourceEnd - sourceStart) / speed }, currentRange = state.scope.placement?.mode === 'range' ? state.scope.placement : null;
      const range = args.range || { start: Math.max(span.start, currentRange?.start ?? span.start), end: Math.min(span.end, currentRange?.end ?? span.end) };
      if (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.end <= range.start || range.start < span.start - 1e-8 || range.end > span.end + 1e-8 || currentRange && (range.start < currentRange.start - 1e-8 || range.end > currentRange.end + 1e-8)) throw fail(403, '卡点范围必须位于实际音乐和本次允许区间内。', 'MUSIC_CUT_RANGE');
      setAssistantScope(state, { ...state.scope, placement: { mode: 'range', ...range, ...(currentRange?.clipIds ? { clipIds: currentRange.clipIds } : {}) } }, native.assets);
      // Keep the measured sub-millisecond coverage after validating the UI scope.
      state.scope.placement.start = range.start; state.scope.placement.end = range.end;
      const requestId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(ctx.callId || '') ? ctx.callId : randomUUID();
      const result = await musicCuts.cut({ ...args, range, projectId: ctx.projectId, expectedRevision: state.nativeRevision, requestId }, { origin: ctx.origin, signal: ctx.signal, mode: ctx.mode, editScope: state.scope, update: message => ctx.update(message) });
      state.nativeRevision = result.revision;
      const undo = result.nativeUndoId ? rememberUndo({ kind: 'native', projectId: ctx.projectId, nativeUndoId: result.nativeUndoId, createdAt: state.createdAt, runId: ctx.runId }) : undefined;
      return { summary: result.summary, data: result, effects: [{ type: 'native', projectId: ctx.projectId, changed: result.applied === true, label: '按音乐节奏自动卡点', ...(undo ? { undo } : {}) }] };
    }));
  }
  tools.push(...createProductionCapabilityTools({ tool, owner, current, readNative, rememberUndo, prepareUndo, check, remotion, remotionProjects, preflight, openFilm, tasks, taskAdapters, bundles }));
  tools.push(...createAuthoringCapabilityTools({ tool, owner, current, commit, rememberUndo, readNative, check, references, scienceDocuments, novelLibrary, artifacts, downloads, root }));
  tools.push(...createProjectCapabilityTools({ tool, owner, current, check, rememberUndo, readNative, store, sourceLinks, projectCovers, downloads, artifacts, videoService, root }));
  tools.push(...createRemotionCodeTools({ tool, owner, current, check, prepareUndo, remotion, remotionProjects }));
  tools.push(...createAssistantWritingReferenceTools({ tool, owner, current, commit, store, writingReferences }));
  tools.push(tool('assistant_undo_list', '读取当前工程仍可用的助手撤销回执，按最近在前；用于用户对话要求撤销上次或某次修改。只返回id/类型/时间/简短操作名，不返回源码快照或本机路径。', schema({ limit: { type: 'integer', minimum: 1, maximum: 100 } }), false, async (args, ctx) => {
    const project = await owner(ctx); return { summary: '已读取本次服务会话中可用的工程撤销记录。', data: { items: [...undos].reverse().filter(([, record]) => record.projectId === project.id && !record.pending && record.createdAt === project.createdAt).slice(0, args.limit || 20).map(([id, record]) => ({ id, kind: record.kind, at: record.at, label: record.label, runId: record.runId })) } };
  }));
  tools.push(tool('assistant_undo_apply', '按用户要求实际撤销当前工程的一条助手修改。undoId须先从assistant_undo_list取得；内容已被后续手改时拒绝覆盖。成功后可继续本轮其它操作。', schema({ undoId: textField(36) }, ['undoId']), true, async (args, ctx, state) => {
    await current(ctx, state);
    const record = undos.get(args.undoId), limit = state.dialogueConstraint;
    if (limit && record && ['native', 'native-project'].includes(record.kind)) {
      const place = record.scope?.placement, allowed = limit.placement;
      if (!place || allowed.mode === 'range' && (place.mode !== 'range' || place.start < allowed.start - .001 || place.end > allowed.end + .001) || limit.assetIds && (!record.scope.assetIds || record.scope.assetIds.some(id => !limit.assetIds.includes(id)))) throw fail(403, '这条撤销影响的范围大于本轮明确限制，请改为针对具体属性调整，或明确允许撤销整次修改。', 'ASSISTANT_DIALOG_SCOPE');
    }
    const result = await undo({ projectId: ctx.projectId, undoId: args.undoId }, { origin: ctx.origin });
    const latest = await owner(ctx); state.hash = assistantContentHash(latest); state.conflicted = false;
    if (latest.kind === 'video' && openFilm?.context) state.nativeRevision = (await openFilm.context(ctx.projectId, ctx.origin, { editScope: state.scope })).revision;
    if (references?.list && state.referenceRevision !== undefined) state.referenceRevision = (await references.list(ctx.projectId)).revision;
    return { summary: '已撤销指定修改，当前工程版本已重新读取。', data: { restored: result.restored, projectId: ctx.projectId } };
  }));
  tools.push(tool('native_scope_set', '按本轮对话决定本次操作的具体位置/范围。自由创作不要求用户填写时间：先读真实工程，自主选择append/insert/replace/range及所需时间，再加入动画；精确片段操作可直接自行提供位置，native_edit也可在plan.placement返回具体安排。保留本轮允许素材；用户明确只改某段时不得扩大。范围仅影响本次任务，不改界面自由创作偏好。', schema({ placement: schema({ mode: { type: 'string', enum: ['append', 'insert', 'replace', 'range'] }, at: { type: 'number', minimum: 0 }, start: { type: 'number', minimum: 0 }, end: { type: 'number', minimum: 0 }, clipIds: { type: 'array', maxItems: 200, items: textField(200) } }, ['mode']), assetIds: { type: 'array', maxItems: 100, items: textField(200) } }, ['placement']), false, async (args, ctx, state) => {
    const native = await readNative(ctx, state); return { summary: '已按当前对话设置本次工程操作范围。', data: { scope: setAssistantScope(state, args, native.assets), authority: state.scopeAuthority } };
  }));
  tools.push(tool('app_capabilities', '检索当前助手真实产品能力目录，可按query/domain查询或分页；包括工程、Remotion、剪辑导出、任务、资料、写作、科普和公用库。不要因常用工具参数少就声称不能，先发现能力再用app_tool_schema取精确参数。', schema({ query: { type: 'string', maxLength: 300 }, domain: { type: 'string', maxLength: 80 }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 40 } }), false, async args => {
    const query = String(args.query || '').toLowerCase(), domain = String(args.domain || '').toLowerCase(), offset = args.offset || 0, limit = args.limit || 20;
    const rows = tools.filter(tool => (!query || `${tool.name} ${tool.description}`.toLowerCase().includes(query)) && (!domain || tool.name.startsWith(domain) || tool.description.toLowerCase().includes(domain)));
    return { summary: '已读取当前实际能力目录，可继续分页或查询具体参数。', data: { total: rows.length, offset, tools: rows.slice(offset, offset + limit).map(({ name, description, mutating }) => ({ name, description, mutating })), nextOffset: offset + limit < rows.length ? offset + limit : null } };
  }));
  tools.push(tool('app_tool_schema', '读取已发现产品工具的精确JSON参数schema，每次最多6项；用于完整功能而不是猜参数或任意HTTP/终端。', schema({ names: { type: 'array', minItems: 1, maxItems: 6, items: textField(80) } }, ['names']), false, async args => {
    const chosen = args.names.map(name => { const selected = tools.find(tool => tool.name === name); if (!selected) throw fail(404, '不存在这个产品操作，请先查能力目录。', 'ASSISTANT_CAPABILITY_NOT_FOUND'); return selected; });
    return { summary: '已读取所选功能的实际参数。', data: { tools: chosen.map(({ name, description, inputSchema, mutating }) => ({ name, description, inputSchema, mutating })) } };
  }));
  async function buildContext(ctx) {
    check(ctx);
    if (!ctx.projectId) return { note: '当前没有打开项目。可以联网问答、阅读公开资料、按用户要求下载原文件和查看项目摘要。需要修改项目或导入科普材料时，请用户先打开目标项目。' };
    const state = await stateFor(ctx), project = await owner(ctx), data = projectSummary(project);
    if (project.kind === 'writing') {
      data.writingBrief = clone(project.writing?.brief || { channel: 'auto' }); data.writingPreferences = clone(ctx.writingPreferences || {});
      const reference = normalizeWritingReferenceConfig(project.writing?.references);
      // Planning only needs to know whether a reference is configured. The
      // writing operation resolves its actual body after checking the switch.
      data.writingReferences = reference.enabled ? { enabled: true, purpose: reference.purpose, hasText: Boolean(reference.text.trim()), hasProject: Boolean(reference.projectId) } : { enabled: false };
      data.currentDraft = project.writing?.draft ? { channel: project.writing.draft.channel, summary: project.writing.draft.summary, notes: project.writing.draft.notes, output: clone(project.writing.draft.output) } : null;
      data.writingContext = currentAssistantWritingContext(project, state.writingContext);
    }
    if (project.kind === 'video') {
      try { const ref = await references.list(project.id); state.referenceRevision = ref.revision; data.references = ref.items.map(({ id, assetId, type, name, focus, text, aspects, sourceRange, targetRange }) => ({ id, type, name, focus, aspects, ...(assetId?{assetId}:{}), ...(sourceRange?{sourceRange}:{}), ...(targetRange?{targetRange}:{}), ...(text ? { text: text.slice(0, 3000) } : {}) })); } catch {}
        try { const media = await readProjectMedia(ctx, state); data.native = nativeAssetSummary(media.native, media); } catch (error) { data.native = { available: false, message: error instanceof AppError ? error.message : '需要读取原生工程后才能剪辑。' }; }
      data.editScope = state.scope; data.scopeAuthority = state.scopeAuthority;
    }
    if (project.kind === 'science') data.documents = (await scienceDocuments.list(project.id)).documents;
    return data;
  }
  async function undo({ projectId, undoId }, { origin = '' } = {}) {
    if (typeof undoId !== 'string' || !/^[a-f0-9-]{36}$/.test(undoId)) throw fail(400, '撤销编号无效。', 'INVALID_ASSISTANT_UNDO');
    const record = undos.get(undoId);
    if (!record) throw fail(410, '这条撤销记录已经过期或已使用；软件重启后不能恢复内存中的撤销记录。', 'ASSISTANT_UNDO_EXPIRED');
    if (record.pending) throw fail(409, '这条修改尚未提交，没有可撤销的已完成结果。', 'ASSISTANT_UNDO_PENDING');
    if (record.projectId !== projectId) throw fail(403, '撤销记录不属于当前项目。', 'ASSISTANT_UNDO_PROJECT');
    if (record.busy) throw fail(409, '这条修改正在撤销，请稍候。', 'ASSISTANT_UNDO_BUSY');
    const project = await store.read(validateProjectId(projectId));
    if (!project) throw fail(404, '项目已不存在。', 'PROJECT_NOT_FOUND');
    if (record.createdAt && project.createdAt !== record.createdAt) throw fail(409, '项目已经重新创建，旧撤销记录不能用于当前项目。', 'ASSISTANT_CONFLICT');
    record.busy = true;
    const state = states.get(record.runId); if (state) state.conflicted = true;
    try {
      if (record.kind === 'project') {
        const restoreParents = record.before.flatMap(item => item.parents || []);
        await store.updateAssistant(projectId, { expectedHash: record.expectedHash, patch: record.before.map(item => ({ path: item.path, ...(item.exists ? { value: item.value } : { remove: true }) })), restoreParents });
        await openFilm?.syncMetadata?.(await store.read(projectId)).catch(() => {});
      } else if (record.kind === 'native') {
        if (!record.nativeUndoId) throw fail(410, '原生工程没有可用的撤销记录。', 'ASSISTANT_UNDO_EXPIRED');
        await openFilm.undoAssistant(projectId, record.nativeUndoId, origin);
      } else if (record.kind === 'native-project') {
        await openFilm.undoProjectCapability(projectId, record.nativeUndoId, origin);
      } else if (record.kind === 'project-metadata' || record.kind === 'source-link') {
        await restoreProjectCapabilityUndo(record, { store, sourceLinks });
      } else if (record.kind === 'remotion-source') {
        await restoreProductionUndo(record, { remotion, remotionProjects });
      } else if (record.kind === 'references') {
        await references.restoreAssistant(projectId, record.before, { expectedContentHash: record.expectedContentHash, expectedCreatedAt: record.createdAt });
      } else if (record.kind === 'library') {
        await novelLibrary.restoreAssistant(record.before, { expectedRevision: record.expectedRevision });
      } else if (record.kind === 'library-asset') {
        await novelLibrary.removeAsset(record.assetId, { expectedSha256: record.expectedSha256 });
      } else if (record.documentId) {
        if (project.createdAt !== record.createdAt || project.science?.documentSelection?.documentId === record.documentId || project.science?.novel?.documentSnapshot?.documentId === record.documentId) throw fail(409, '此资料已被选择或用于作品，请先在制作页更换资料后再撤销导入。', 'ASSISTANT_UNDO_IN_USE');
        const value = await scienceDocuments.get(projectId, record.documentId);
        if (value.sourceHash !== record.sourceHash) throw fail(409, '资料已有变化，不能撤销覆盖。', 'ASSISTANT_CONFLICT');
        await scienceDocuments.remove(projectId, record.documentId);
      } else if (record.referenceId) {
        const value = await references.list(projectId), item = value.items.find(item => item.id === record.referenceId);
        if (project.createdAt !== record.createdAt || !item || digest(item) !== record.referenceHash) throw fail(409, '参考资料已有变化，不能撤销覆盖。', 'ASSISTANT_CONFLICT');
        await references.remove(projectId, record.referenceId);
      }
      undoBytes -= record.bytes; undos.delete(undoId);
      return { restored: true, project: await store.read(projectId) };
    } finally { record.busy = false; }
  }
  return { tools, buildContext, progressContext, checkpoint, restoreCheckpoint, undo, capabilities: () => tools.map(({ name, description, inputSchema, mutating }) => ({ name, description, inputSchema, mutating })), finishRun(job) { if (TERMINAL.has(job.status)) { const state=states.get(job.id);if(state?.referenceContext&&state.referenceInspectionIds.length)try{const exported=state.referenceContext.export(state.projectId),bytes=Buffer.byteLength(JSON.stringify(exported));if(bytes<=REFERENCE_CACHE_BYTES&&exported.noteCount>0){referenceResumeCache.delete(state.projectId);referenceResumeCache.set(state.projectId,{exported,createdAt:state.createdAt,bytes,at:Date.now()});while(referenceResumeCache.size>12||[...referenceResumeCache.values()].reduce((sum,item)=>sum+item.bytes,0)>REFERENCE_CACHE_BYTES)referenceResumeCache.delete(referenceResumeCache.keys().next().value);}}catch{} state?.referenceContext?.close(); states.delete(job.id); } }, async close() { closed = true; await Promise.allSettled([...operations]); for (const state of states.values()) state.referenceContext?.close(); states.clear(); referenceResumeCache.clear(); undos.clear(); undoBytes = 0; } };
}
