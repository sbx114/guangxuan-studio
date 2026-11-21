import { AppError } from './errors.mjs';
import { scopedAssets } from './edit-scope.mjs';
import { NATIVE_OPERATION_CATALOG, nativeOperationCatalogForLimit } from './native-operations.mjs';
import { normalizeNativeExport, NATIVE_EXPORT_CATALOG } from './native-export-capabilities.mjs';
import { NATIVE_PROJECT_CATALOG, NATIVE_PROJECT_READ_SCHEMA, NATIVE_PROJECT_EDIT_SCHEMA } from './native-project-capabilities.mjs';
import { SUBTITLE_STYLE_CATALOG } from './native-subtitle-style.mjs';
import { NATIVE_MAX_TIME_SECONDS } from './native-adjustments.mjs';

const fail = (status, message, code) => new AppError(status, message, code);
const objectSchema = (properties = {}, required = []) => ({ type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}) });
const text = maxLength => ({ type: 'string', minLength: 1, maxLength });
const revision = { type: 'integer', minimum: 1 };
const sourceFile = objectSchema({ path: text(200), content: { type: 'string', maxLength: 204800 } }, ['path', 'content']);
const sourceFields = {
  title: text(160), entryPoint: text(200), compositionId: { type: 'string', maxLength: 160 },
  inputProps: { type: 'object' }, files: { type: 'array', minItems: 1, maxItems: 128, items: sourceFile },
  assets: { type: 'array', maxItems: 32, items: objectSchema({ assetId: text(128) }, ['assetId']) },
};
const renderFields = {
  remotionId: text(100), expectedRevision: revision, compositionId: text(160), inputProps: { type: 'object' },
  kind: { type: 'string', enum: ['preview', 'video'] },
  frames: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'integer', minimum: 0 } },
  range: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number', minimum: 0 } },
};
const exportFields = {
  fps: { type: 'number', minimum: 1, maximum: 120 }, name: text(100),
  range: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number', minimum: 0, maximum: NATIVE_MAX_TIME_SECONDS } },
};
const clone = value => structuredClone(value);
const ready = (service, method, label) => { if (typeof service?.[method] !== 'function') throw fail(503, label + '尚未就绪。', 'ASSISTANT_CAPABILITY_UNAVAILABLE'); };
const sourceSummary = value => ({ id: value.id, title: value.title, revision: value.revision, entryPoint: value.entryPoint, compositionId: value.compositionId, inputProps: value.inputProps, files: value.files.map(file => ({ path: file.path, ...(file.bytes !== undefined ? { bytes: file.bytes } : {}) })), assets: (value.assets || []).map(({ assetId, publicPath, name, type }) => ({ assetId, publicPath, name, type })) });
const sourceBefore = value => Object.fromEntries(['title', 'entryPoint', 'compositionId', 'inputProps', 'files'].map(key => [key, clone(value[key])]));
const artifact = (projectId, name, downloadUrl) => ({ type: 'artifact', projectId, label: name, changed: false, artifact: { name, downloadUrl } });

/** Restore source by publishing another revision; never overwrite a later user edit. */
export async function restoreProductionUndo(record, { remotion, remotionProjects } = {}) {
  if (record?.kind !== 'remotion-source') throw fail(400, '不是可恢复的动画源码记录。', 'ASSISTANT_UNDO_INVALID');
  ready(remotion, 'read', '自由动画服务'); ready(remotionProjects, 'update', '自由动画源码服务');
  const latest = await remotion.read(record.projectId, record.remotionId);
  if (latest.revision !== record.expectedRevision) throw fail(409, '动画源码已有后续修改，不能撤销覆盖。', 'REMOTION_REVISION_CONFLICT');
  const previousPaths = new Set(record.before.files.map(file => file.path));
  return remotionProjects.update(record.projectId, record.remotionId, {
    ...record.before, expectedRevision: latest.revision, ownerCreatedAt: record.createdAt,
    deletedFiles: latest.files.filter(file => !previousPaths.has(file.path)).map(file => file.path),
  });
}

/** Typed business operations: no model-supplied project IDs, host paths, URLs or RPC endpoints. */
export function createProductionCapabilityTools({ tool, owner, current, readNative, rememberUndo, prepareUndo, check = () => {}, remotion, remotionProjects, preflight, openFilm, tasks, taskAdapters, bundles } = {}) {
  if (![tool, owner, current, readNative, rememberUndo].every(value => typeof value === 'function')) throw new TypeError('Production capabilities require the scoped assistant adapter.');

  async function source(ctx, state, id, expectedRevision) {
    await current(ctx, state, 'video'); check(ctx); ready(remotion, 'read', '自由动画服务');
    const record = await remotion.read(ctx.projectId, id);
    if (expectedRevision !== undefined && record.revision !== expectedRevision) throw fail(409, '动画源码版本已变化，请重新读取。', 'REMOTION_REVISION_CONFLICT');
    return record;
  }
  async function sourceAssets(args, ctx, state) {
    if (args.assets === undefined) return;
    const native = await readNative(ctx, state), allowed = new Set(scopedAssets(native.assets || [], state.scope).map(asset => asset.id));
    if (!Array.isArray(args.assets) || args.assets.some(item => !allowed.has(item?.assetId))) throw fail(403, '动画只能引用当前工程中本轮对话允许的真实素材。', 'ASSISTANT_MEDIA_SCOPE');
  }
  function sourceInput(args) { return Object.fromEntries(Object.keys(sourceFields).filter(key => args[key] !== undefined).map(key => [key, args[key]])); }
  function nativeSpec(args, state) {
    const result = Object.fromEntries(Object.keys(exportFields).filter(key => args[key] !== undefined).map(key => [key, args[key]]));
    const selected = state.scope?.placement;
    if (selected?.mode === 'range') {
      result.range ||= [selected.start, selected.end];
      if (result.range[0] < selected.start || result.range[1] > selected.end) throw fail(403, '导出范围不能越过用户选中的区间。', 'ASSISTANT_EXPORT_SCOPE');
    }
    if (result.range && (!Array.isArray(result.range) || result.range.length !== 2 || result.range.some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0) || result.range[1] <= result.range[0])) throw fail(400, '导出起止秒数不正确。', 'ASSISTANT_EXPORT_RANGE');
    return result;
  }
  function advancedSpec(input, native, state) {
    const spec = normalizeNativeExport(input), selected = state.scope?.placement;
    if (selected?.mode !== 'range') return spec;
    const inside = time => time >= selected.start && time <= selected.end;
    if (['project', 'nle'].includes(spec.kind)) throw fail(403, '此格式导出整个原生工程，当前对话仅限定局部范围。', 'ASSISTANT_EXPORT_SCOPE');
    if (spec.clip) { const clip = native.editorTimeline?.clips.find(clip => clip.id === spec.clip); if (!clip || !inside(clip.at) || !inside(clip.end)) throw fail(403, '指定片段不完整处于当前对话范围。', 'ASSISTANT_EXPORT_SCOPE'); }
    else if (['video', 'gif', 'audio', 'subtitles'].includes(spec.kind)) {
      if (!spec.range && !spec.ranges) spec.range = [selected.start, selected.end];
      for (const range of spec.ranges || [spec.range]) if (!inside(range[0]) || !inside(range[1])) throw fail(403, '导出区间不能越过当前对话范围。', 'ASSISTANT_EXPORT_SCOPE');
    } else if (spec.kind === 'poster') { spec.at ??= (selected.start + selected.end) / 2; if (!inside(spec.at)) throw fail(403, '封面采样不能越过当前对话范围。', 'ASSISTANT_EXPORT_SCOPE'); }
    else if (['stills', 'slides'].includes(spec.kind)) { spec.at ||= [(selected.start + selected.end) / 2]; if (spec.at.some(time => !inside(time))) throw fail(403, '图片采样不能越过当前对话范围。', 'ASSISTANT_EXPORT_SCOPE'); }
    return spec;
  }
  async function scopedTask(args, ctx, state, writing = false) {
    if (writing) await current(ctx, state); else await owner(ctx);
    check(ctx); ready(tasks, 'get', '任务服务');
    const task = await tasks.get(args.taskId, { projectId: ctx.projectId });
    if (writing && task.type === 'assistant' && task.sourceJobId === ctx.runId) throw fail(409, '请使用助手的停止按钮结束本次请求，不能由任务工具取消自身。', 'ASSISTANT_TASK_SELF_CONTROL');
    return task;
  }
  function taskArtifacts(task, ctx) {
    return (task.outputs || []).flatMap(output => {
      const url = output.url || output.downloadUrl;
      // These are already service receipts. Keep a second narrow URL boundary
      // here so a new task type cannot turn arbitrary output URLs into cards.
      const native = /^\/api\/openfilm\/exports\/([A-Za-z0-9_-]+)\/[A-Za-z0-9_-]+\/file$/.exec(url || '');
      const bundle = /^\/api\/project-bundles\/exports\/[a-f0-9-]{36}\/file$/.test(url || '');
      return (native?.[1] === ctx.projectId || bundle) ? [artifact(ctx.projectId, output.label || '保存制作结果', url)] : [];
    });
  }

  return [
    tool('native_project_catalog', '发现当前原生工程的时间线标记、完整版本历史、页面源码/DOM图层以及画板节点/连线/分组/多画板编辑能力。页面支持纯文字、CSS、属性、画框和声明式增删移复制；先读目录取得精确参数，再用native_project_read/edit。', objectSchema(), false, async (_args, ctx) => {
      await owner(ctx, 'video'); return { summary: '已读取原生工程标记、历史、图层与画板能力目录。', data: NATIVE_PROJECT_CATALOG };
    }),
    tool('native_project_read', '读取当前原生工程的markers、history版本/指定commit差异、page真实页面列表/元素path/源码，或canvas当前画板/全部画板信息及节点连线分页。各section有独立revision，修改前必须读取。工程内相对path使用真实读取结果，不读取宿主文件。', NATIVE_PROJECT_READ_SCHEMA, false, async (args, ctx, state) => {
      await current(ctx, state, 'video'); ready(openFilm, 'readProjectCapability', '原生工程内容服务'); check(ctx);
      const result = await openFilm.readProjectCapability(ctx.projectId, args.section, args.args || {}, ctx.origin);
      if (result.filmRevision !== undefined && result.filmRevision !== null) {
        if (state.nativeRevision && state.nativeRevision !== result.filmRevision) { state.conflicted = true; throw fail(409, '原生工程已变化，请重新发送要求。', 'OPENFILM_REVISION_CONFLICT'); }
        state.nativeRevision = result.filmRevision;
      }
      return { summary: args.section === 'page' ? '已读取真实页面结构与版本。' : args.section === 'history' ? '已读取真实工程历史与版本状态。' : args.section === 'canvas' ? '已读取真实工程画板、节点与版本。' : '已读取真实时间线标记。', data: result };
    }),
    tool('native_project_edit', '按native_project_catalog精确参数修改标记、保存/恢复版本、声明式编辑页面DOM，或编排画板节点/连线/分组及新建复制改名删除画板。expectedRevision来自对应section读取；锁定/共享源/对话范围/版本冲突会检查。history恢复前保留当前版本，save不伪造撤销。page保留脚本，复杂可执行动画用自由Remotion。画板节点保存不代表执行媒体生成。', NATIVE_PROJECT_EDIT_SCHEMA, true, async (args, ctx, state) => {
      await current(ctx, state, 'video'); ready(openFilm, 'editProjectCapability', '原生工程内容服务'); check(ctx);
      // History works on the whole project, including recovery of missing film.
      // It must never silently discard the dialogue's explicit range limit.
      if (args.section === 'history' && (state.scope.placement.mode === 'range' || state.scope.assetIds || state.scope.placement.clipIds?.length)) throw fail(403, '工程历史操作影响全工程，当前对话只允许处理指定范围。', 'NATIVE_PROJECT_SCOPE');
      if (args.section !== 'history') await readNative(ctx, state);
      let result;
      try { result = await openFilm.editProjectCapability(ctx.projectId, args.section, args.action, args.expectedRevision, args.args || {}, ctx.origin, { expectedNativeRevision: state.nativeRevision, editScope: clone(state.scope), signal: ctx.signal }); }
      catch (error) { if (error.code === 'OPENFILM_REVISION_CONFLICT') state.conflicted = true; throw error; }
      if (result.filmRevision !== undefined && result.filmRevision !== null) state.nativeRevision = result.filmRevision;
      const undo = result.undo?.id ? rememberUndo({ kind: 'native-project', projectId: ctx.projectId, createdAt: state.createdAt, runId: ctx.runId, nativeUndoId: result.undo.id, label: result.undo.label || '原生工程内容修改' }) : undefined;
      return { summary: args.section === 'history' && args.action === 'save' ? '已保存真实工程版本。' : '已完成原生工程内容修改。', data: result, effects: [{ type: 'native', projectId: ctx.projectId, label: args.section === 'history' && args.action === 'save' ? '已保存工程历史版本' : result.undo?.label || '已更新原生工程内容', changed: true, ...(undo ? { undo } : {}) }] };
    }),
    tool('native_operation_catalog', '发现原生编辑器完整声明式操作目录；默认列出全部动作与参数名，actions可取得最多6种动作的精确JSON参数schema。时间线可用offset/limit分页，返回真实ID、联动组与锁定状态；导出参数用native_export_catalog。', objectSchema({ actions: { type: 'array', minItems: 1, maxItems: 6, items: text(40) }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 40 } }), false, async (args, ctx, state) => {
      const native = await readNative(ctx, state, { offset: args.offset || 0, limit: args.limit || 20 }, true);
      if (args.actions?.some(action => !NATIVE_OPERATION_CATALOG.some(item => item.action === action))) throw fail(400, '操作目录中不存在指定的action。', 'NATIVE_OPERATION_INVALID');
      const offset = args.offset || 0, limit = args.limit || 20;
      const alreadyPaged = native.editorTimeline?.pagination?.offset === offset || native.editorTimeline?.scopeFiltered === true;
      const timeline = native.editorTimeline ? { ...native.editorTimeline, clips: alreadyPaged ? native.editorTimeline.clips : native.editorTimeline.clips.slice(offset, offset + limit), offset, returned: alreadyPaged ? native.editorTimeline.clips.length : Math.min(limit, Math.max(0, native.editorTimeline.clips.length - offset)), totalAvailable: native.editorTimeline.pagination?.total ?? native.editorTimeline.clips.length } : null;
      const limits = native.editorTimeline?.limits || { existingTimelineSeconds: native.duration || 0, newTimelineMaxSeconds: NATIVE_MAX_TIME_SECONDS, maxEditedTimelineSeconds: NATIVE_MAX_TIME_SECONDS, maxSourceTimeSeconds: NATIVE_MAX_TIME_SECONDS, maxScopeCoordinateSeconds: NATIVE_MAX_TIME_SECONDS, maxSelectedRangeSeconds: NATIVE_MAX_TIME_SECONDS, legacyExportRangeMaxSeconds: NATIVE_MAX_TIME_SECONDS, maxOperations: 40, maxExplicitGroupClipIds: 200 };
      const availableCatalog = nativeOperationCatalogForLimit(limits.maxEditedTimelineSeconds);
      const catalog = args.actions ? availableCatalog.filter(item => args.actions.includes(item.action)) : availableCatalog.map(({ parameters: _parameters, ...item }) => item);
      return { summary: '已读取原生操作目录和真实工程范围。', data: { revision: native.revision, stage: native.stage, editScope: state.scope, timeline, catalog, limits, exportKinds: NATIVE_EXPORT_CATALOG.map(({ kind, label }) => ({ kind, label })), note: '每批最多40操作；组成员clipIds最多200，大组可用groupId，均可分批继续。时间范围按实际素材与工程核对，数值上限用于保证毫秒精度。写入遵守用户当前对话明确要求。' } };
    }),
    tool('native_subtitles_read', '读取当前项目真实WebVTT字幕轨的句子index、时间和原文，可分页读取200句以内；先native_operation_catalog获取字幕轨道编号。返回实际版本和每句是否处于对话范围，改写用native_operation的subtitles_edit，不猜原文。', objectSchema({ track: { type: 'integer', minimum: 0 }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 200 } }, ['track']), false, async (args, ctx, state) => {
      await readNative(ctx, state); ready(openFilm, 'readSubtitles', '字幕读取服务');
      const result = await openFilm.readSubtitles(ctx.projectId, args.track, ctx.origin, { offset: args.offset || 0, limit: args.limit || 100, editScope: state.scope });
      if (result.revision !== state.nativeRevision) throw fail(409, '时间线已更新，请重新读取字幕。', 'OPENFILM_REVISION_CONFLICT');
      return { summary: '已读取真实字幕原文和时间。', data: result };
    }),
    tool('native_subtitles_style_catalog', '读取与当前原生字幕UI完全对应的样式字段/枚举和真实字效目录：全部字体/描边/底框/阴影/渐变变量、入场/循环/出场、逐字效果、位置对齐/宽度、逐字计时与继承。使用native_operation的subtitles_style修改，先native_subtitles_read核对句子index与原样式。', objectSchema(), false, async (_args, ctx) => {
      await owner(ctx, 'video'); return { summary: '已读取原生字幕完整样式目录。', data: SUBTITLE_STYLE_CATALOG };
    }),
    tool('native_operation', '按native_operation_catalog目录对真实工程原子执行1至40项声明式操作。operations每项action及参数必须与目录一致；不接收原始HTML、JS、CSS、路径或RPC。支持跨轨、整组移动、音画联动/拆声、启用、轨道锁定隐藏静音/顺序、画布、裁切、画面适应、数值滤镜，及已有native_adjust动作。先读取目录/ID，保留锁轨、范围、CAS与撤销。', objectSchema({ operations: { type: 'array', minItems: 1, maxItems: 40, items: { type: 'object' } } }, ['operations']), true, async (args, ctx, state) => {
      await current(ctx, state, 'video'); await readNative(ctx, state); ready(openFilm, 'operateClips', '原生操作服务'); check(ctx);
      let result;
      try { result = await openFilm.operateClips(ctx.projectId, args.operations, ctx.origin, state.nativeRevision, { keepUndo: true, editScope: state.scope, signal: ctx.signal }); }
      catch (error) { if (error.status === 409 && error.code === 'OPENFILM_REVISION_CONFLICT') state.conflicted = true; throw error; }
      state.nativeRevision = result.revision;
      if (state.scope.placement.clipIds?.length) state.scope.placement.clipIds = [...new Set([...state.scope.placement.clipIds, ...(result.results || []).map(result => result.createdClipId).filter(Boolean)])];
      const undo = rememberUndo({ kind: 'native', projectId: ctx.projectId, createdAt: state.createdAt, nativeUndoId: result.undo?.id, runId: ctx.runId });
      return { summary: result.summary || '已完成原生编辑操作。', data: { revision: result.revision, duration: result.duration, results: result.results, touchedClipIds: result.touchedClipIds }, effects: [{ type: 'native', projectId: ctx.projectId, label: '已完成原生编辑操作', changed: true, undo }] };
    }),
    tool('remotion_create', '直接保存自主编写的多文件React/TSX/CSS/SVG等自由动画工程，不再额外请求一次模型。files是工程内相对路径与完整文件内容；assets使用当前工程中本轮对话允许的真实素材ID。保存不代表编译、渲染或已加入作品，接着inspect和render。', objectSchema(sourceFields, ['files']), true, async (args, ctx, state) => {
      const project = await current(ctx, state, 'video'); ready(remotionProjects, 'create', '自由动画源码服务');
      await sourceAssets(args, ctx, state); await current(ctx, state, 'video'); check(ctx);
      const record = await remotionProjects.create(ctx.projectId, { ...sourceInput(args), ownerCreatedAt: project.createdAt });
      return { summary: '已保存自由动画源码工程，尚未编译或渲染。', data: sourceSummary(record), effects: [{ type: 'remotion', projectId: ctx.projectId, label: '已保存新动画源码工程', changed: true }] };
    }),
    tool('remotion_update', '直接更新已读动画的源文件、入口、Composition、props或标题，可新增/删除工程内源文件；未列出的源文件保留。expectedRevision必须来自实际读取。成功后可撤销源码与参数；历史版本和已复制媒体保留。保存后需重新inspect与render。', objectSchema({ remotionId: text(100), expectedRevision: revision, ...sourceFields, deletedFiles: { type: 'array', maxItems: 128, items: text(200) } }, ['remotionId', 'expectedRevision']), true, async (args, ctx, state) => {
      ready(remotionProjects, 'update', '自由动画源码服务');
      const before = await source(ctx, state, args.remotionId, args.expectedRevision);
      await sourceAssets(args, ctx, state); await current(ctx, state, 'video'); check(ctx);
      if (!Object.keys(sourceFields).some(key => args[key] !== undefined) && args.deletedFiles === undefined) throw fail(400, '请提供需要修改的文件或工程参数。', 'ASSISTANT_REMOTION_EMPTY_UPDATE');
      // Pending reservations cannot be listed or executed as undo operations.
      // Only a successful source CAS activates the receipt; failures remove it.
      const undoRecord = { kind: 'remotion-source', projectId: ctx.projectId, createdAt: state.createdAt, runId: ctx.runId, remotionId: before.id, expectedRevision: before.revision + 1, before: sourceBefore(before) };
      const reservation = prepareUndo ? prepareUndo(undoRecord) : { undo: rememberUndo(undoRecord), commit() {}, cancel() {} };
      let saved;
      try {
        saved = await remotionProjects.update(ctx.projectId, args.remotionId, { ...sourceInput(args), ...(args.deletedFiles !== undefined ? { deletedFiles: args.deletedFiles } : {}), expectedRevision: args.expectedRevision, ownerCreatedAt: state.createdAt });
        await reservation.commit({ expectedRevision: saved.revision });
      } catch (error) { await reservation.cancel(); throw error; }
      const undo = reservation.undo;
      return { summary: '已保存新的动画源码版本，尚未重新渲染。', data: sourceSummary(saved), effects: [{ type: 'remotion', projectId: ctx.projectId, label: '已更新动画源码与参数', changed: true, undo }] };
    }),
    tool('remotion_inspect_advanced', '按指定inputProps实际编译动画并读取Composition尺寸、fps与时长；用于参数会改变构图或总时长的自由工程。不会修改保存参数。', objectSchema({ remotionId: text(100), expectedRevision: revision, inputProps: { type: 'object' } }, ['remotionId', 'expectedRevision']), false, async (args, ctx, state) => {
      await source(ctx, state, args.remotionId, args.expectedRevision); ready(remotion, 'inspect', '自由动画服务');
      const result = await remotion.inspect(ctx.projectId, args.remotionId, { expectedRevision: args.expectedRevision, ...(args.inputProps !== undefined ? { inputProps: args.inputProps } : {}), signal: ctx.signal });
      return { summary: '已按指定参数实际编译并读取动画信息。', data: result };
    }),
    tool('remotion_render_advanced', '启动已保存自由工程的真实预览或MP4渲染，可传inputProps、Composition和小样range=[开始秒,结束秒]；frames是预览帧号。返回真实jobId，继续remotion_job查状态，完成后remotion_append才加入时间线。不能把排队或保存源码说成成片完成。', objectSchema(renderFields, ['remotionId', 'expectedRevision']), true, async (args, ctx, state) => {
      await source(ctx, state, args.remotionId, args.expectedRevision); ready(remotion, 'start', '自由动画服务'); check(ctx);
      if (args.frames !== undefined && args.kind !== 'preview') throw fail(400, '指定frames时请选择preview预览。', 'ASSISTANT_REMOTION_RENDER_OPTIONS');
      const options = Object.fromEntries(Object.keys(renderFields).filter(key => key !== 'remotionId' && args[key] !== undefined).map(key => [key, args[key]]));
      const result = await remotion.start(ctx.projectId, args.remotionId, { ...options, kind: args.kind || 'video', signal: ctx.signal });
      return { summary: '已提交实际Remotion渲染任务，需继续查看任务结果。', data: { ...result, remotionId: args.remotionId, revision: args.expectedRevision }, effects: [{ type: 'remotion', projectId: ctx.projectId, label: '自由动画渲染任务已启动', changed: true, jobId: result.jobId }] };
    }),
    tool('remotion_job', '读取当前项目一个真实自由动画任务。仅complete表示渲染完成；返回真实预览图片或视频地址，失败时保留具体诊断。', objectSchema({ jobId: text(128) }, ['jobId']), false, async (args, ctx) => {
      await owner(ctx, 'video'); ready(remotion, 'job', '自由动画服务');
      const value = await remotion.job(ctx.projectId, args.jobId), job = remotion.publicJob(ctx.projectId, value);
      return { summary: job.status === 'complete' ? '动画渲染已完成。' : job.status === 'error' ? '动画渲染未完成，请按诊断修复源码。' : job.status === 'cancelled' ? '动画渲染已取消。' : '已读取动画渲染进度。', data: { job }, effects: job.status === 'complete' && job.result?.videoUrl ? [artifact(ctx.projectId, '保存Remotion动画视频', job.result.videoUrl)] : [] };
    }),
    tool('remotion_cancel', '取消当前项目指定的自由动画渲染任务，保留已经保存的工程源码。jobId必须来自真实工具结果。', objectSchema({ jobId: text(128) }, ['jobId']), true, async (args, ctx, state) => {
      await current(ctx, state, 'video'); ready(remotion, 'cancel', '自由动画服务'); check(ctx);
      const value = await remotion.cancel(ctx.projectId, args.jobId);
      return { summary: ['complete', 'error', 'cancelled'].includes(value.status) ? '已读取动画任务最终状态。' : '已提交停止动画渲染的请求。', data: { job: remotion.publicJob(ctx.projectId, value) } };
    }),
    tool('remotion_append', '把已经完成且仍对应当前源码版本的自由动画job直接加入用户所选位置或范围，无需再次渲染。遵守时间线版本、范围与时长检查；成功后可撤销。', objectSchema({ remotionId: text(100), expectedRevision: revision, jobId: text(128) }, ['remotionId', 'expectedRevision', 'jobId']), true, async (args, ctx, state) => {
      await source(ctx, state, args.remotionId, args.expectedRevision); await readNative(ctx, state); ready(remotion, 'append', '自由动画服务'); check(ctx);
      let applied;
      try { applied = await remotion.append(ctx.projectId, args.remotionId, { jobId: args.jobId, expectedNativeRevision: state.nativeRevision }, { origin: ctx.origin, editScope: state.scope, signal: ctx.signal }); }
      catch (error) { if (error.status === 409) state.conflicted = true; throw error; }
      state.nativeRevision = applied.revision;
      const undo = rememberUndo({ kind: 'native', projectId: ctx.projectId, createdAt: state.createdAt, nativeUndoId: applied.undo?.id, runId: ctx.runId });
      return { summary: '已把已渲染动画加入所选位置。', data: { remotionId: args.remotionId, jobId: args.jobId, revision: applied.revision, assetId: applied.asset?.id, placement: applied.placement }, effects: [{ type: 'native', projectId: ctx.projectId, label: '已加入动画渲染结果', changed: true, undo }] };
    }),
    tool('native_preflight', '对当前剪辑实际执行导出前体检，可deep抽样检查画面和音轨。range省略时使用本轮对话限定区间，未限定时检查全片；不能越过用户区间。体检不等于导出，也不等于观看全部画面。', objectSchema({ ...exportFields, deep: { type: 'boolean' } }), false, async (args, ctx, state) => {
      await readNative(ctx, state); ready(preflight, 'check', '导出体检服务');
      const spec = nativeSpec(args, state);
      const report = await preflight.check(ctx.projectId, { ...spec, deep: args.deep === true, signal: ctx.signal, origin: ctx.origin });
      await readNative(ctx, state);
      return { summary: report.canExport ? '已完成实际导出体检，请查看警告与抽样范围。' : '导出体检发现需要修复的问题。', data: report };
    }),
    tool('native_export_catalog', '读取原生编辑器全部9类真实导出参数及本机编码能力：视频/透明编码、GIF、混音与分轨、静帧、封面、字幕、PPTX/PDF、Premiere/Resolve/FinalCut/剪映/CapCut、原生项目包。按kind查看精确参数后使用native_export_advanced，不猜参数或本机路径。', objectSchema(), false, async (_args, ctx, state) => {
      await owner(ctx, 'video'); await readNative(ctx, state); const capabilities = openFilm?.nativeExports ? (await openFilm.nativeExports(ctx.projectId)).capabilities || {} : {};
      return { summary: '已读取本机原生编辑器导出能力目录，实际编码仍以渲染结果为准。', data: { capabilities, exports: NATIVE_EXPORT_CATALOG } };
    }),
    tool('native_export_advanced', '按native_export_catalog精确参数启动一种真实原生导出，spec必须符合所选kind；支持编码、透明、画幅、质量、运动采样、多区间拼接、音频分轨及完整工程导出。渲染类型先体检；项目包/字幕不因无关画面问题阻断。遵守当前对话范围与CAS，不接收本机路径。返回真实exportId/taskId，继续task_get查看最终文件。', objectSchema({ spec: { type: 'object' } }, ['spec']), true, async (args, ctx, state) => {
      await current(ctx, state, 'video'); const native = await readNative(ctx, state); ready(openFilm, 'exportNative', '高级原生导出服务');
      const spec = advancedSpec(args.spec, native, state), reports = [];
      if (!['project', 'subtitles'].includes(spec.kind)) {
        ready(preflight, 'check', '导出体检服务');
        for (const range of spec.ranges || [spec.range]) {
          const report = await preflight.check(ctx.projectId, { ...(range ? { range } : {}), ...(spec.fps ? { fps: spec.fps } : {}), signal: ctx.signal, origin: ctx.origin }); reports.push(report);
          if (!report.canExport) return { summary: '导出体检未通过，尚未启动高级导出。', data: { started: false, reports } };
        }
      }
      await current(ctx, state, 'video'); await readNative(ctx, state); check(ctx);
      let result;
      try { result = await openFilm.exportNative(ctx.projectId, spec, ctx.origin, { expectedRevision: state.nativeRevision }); }
      catch (error) { if (error.status === 409) state.conflicted = true; throw error; }
      await taskAdapters?.watchNativeProject?.(ctx.projectId);
      const task = tasks?.list ? (await tasks.list({ projectId: ctx.projectId })).items?.find(item => item.type === 'native-export' && item.sourceJobId === result.export?.id) : null;
      return { summary: '已启动实际原生导出，请继续检查任务最终结果。', data: { started: true, export: result.export, ...(task ? { task } : {}), reports }, effects: [{ type: 'native-export', projectId: ctx.projectId, label: '已启动' + (NATIVE_EXPORT_CATALOG.find(item => item.kind === spec.kind)?.label || '原生导出'), changed: false, exportId: result.export?.id, ...(task ? { taskId: task.id } : {}) }] };
    }),
    tool('native_export_cancel', '取消当前项目一个真实原生导出exportId，适用于全部9类导出。编号须来自制作工具或任务中心；不会触及其他项目任务或删除工程。停止请求不代表已经成功结束。', objectSchema({ exportId: text(128) }, ['exportId']), true, async (args, ctx) => {
      await owner(ctx, 'video'); ready(openFilm, 'cancelNativeExport', '原生导出取消服务'); check(ctx);
      const result = await openFilm.cancelNativeExport(ctx.projectId, args.exportId, ctx.origin);
      await taskAdapters?.watchNativeProject?.(ctx.projectId);
      return { summary: '已提交原生导出停止请求，请以返回状态为准。', data: result };
    }),
    tool('native_export', '先对当前原生时间线执行实际体检，通过后启动MP4导出。fps/name/range可设置；默认导出全片，本轮对话限定区间时按区间导出，不能越界。返回导出和任务编号，继续task_get查看最终文件；启动不代表已完成导出。', objectSchema(exportFields), true, async (args, ctx, state) => {
      await current(ctx, state, 'video'); await readNative(ctx, state); ready(preflight, 'check', '导出体检服务'); ready(openFilm, 'exportVideo', '原生导出服务');
      const spec = nativeSpec(args, state);
      ctx.update('正在检查实际剪辑工程与导出范围');
      const report = await preflight.check(ctx.projectId, { ...spec, signal: ctx.signal, origin: ctx.origin });
      if (!report.canExport) return { summary: '导出体检未通过，尚未启动导出。请先修复所列问题。', data: { started: false, report } };
      await current(ctx, state, 'video'); await readNative(ctx, state); check(ctx);
      let result;
      try { result = await openFilm.exportVideo(ctx.projectId, spec, ctx.origin, { expectedRevision: state.nativeRevision }); }
      catch (error) { if (error.status === 409) state.conflicted = true; throw error; }
      await taskAdapters?.watchNativeProject?.(ctx.projectId);
      const listed = tasks?.list ? await tasks.list({ projectId: ctx.projectId }) : { items: [] };
      const task = listed.items?.find(item => item.type === 'native-export' && item.sourceJobId === result.export?.id);
      return { summary: '已通过体检并启动真实原生视频导出，尚需查看最终任务状态。', data: { started: true, export: result.export, ...(task ? { task } : {}), report }, effects: [{ type: 'native-export', projectId: ctx.projectId, label: '原生视频导出任务已启动', changed: false, exportId: result.export?.id, ...(task ? { taskId: task.id } : {}) }] };
    }),
    tool('task_list', '读取当前项目统一任务中心，包含自由动画、原生导出、素材分析、资料导入、备份与助手任务；可按真实status筛选，显示能否取消和安全重试。', objectSchema({ status: { type: 'string', enum: ['queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'interrupted'] } }), false, async (args, ctx) => {
      await owner(ctx); ready(tasks, 'list', '任务服务');
      return { summary: '已读取当前项目统一任务中心。', data: await tasks.list({ projectId: ctx.projectId, ...(args.status ? { status: args.status } : {}) }) };
    }),
    tool('task_get', '读取当前项目指定任务的真实状态、错误与已完成文件。taskId必须来自task_list或制作工具结果；不会读取其他项目任务。', objectSchema({ taskId: text(128) }, ['taskId']), false, async (args, ctx, state) => {
      const task = await scopedTask(args, ctx, state);
      return { summary: '已读取实际任务状态。', data: { task }, effects: taskArtifacts(task, ctx) };
    }),
    tool('task_cancel', '按用户要求停止当前项目指定任务；仅canCancel=true的任务可取消，不能停止本次助手自身。返回真实状态，不伪称不支持取消的任务已停止。', objectSchema({ taskId: text(128) }, ['taskId']), true, async (args, ctx, state) => {
      const task = await scopedTask(args, ctx, state, true); ready(tasks, 'cancel', '任务服务');
      if (!task.canCancel) throw fail(409, '这个任务当前不能取消，请查看最终状态或对应工作区。', 'TASK_CANCEL_UNAVAILABLE');
      check(ctx); const result = await tasks.cancel(args.taskId, { projectId: ctx.projectId });
      return { summary: '已提交停止任务的请求，请以返回状态为准。', data: { task: result } };
    }),
    tool('task_retry', '按用户要求重试当前项目标记canRetry=true的失败任务，只调用后端已登记的安全重试操作；不会重放任意剪辑、导入、下载或过期任务。', objectSchema({ taskId: text(128) }, ['taskId']), true, async (args, ctx, state) => {
      const task = await scopedTask(args, ctx, state, true); ready(tasks, 'retry', '任务服务');
      if (!task.canRetry) throw fail(409, '这个任务不能安全重试，请基于当前项目重新发起对应操作。', 'TASK_RETRY_UNAVAILABLE');
      check(ctx); return { summary: '已按任务服务登记的安全方式重试。', data: { task: await tasks.retry(args.taskId, { projectId: ctx.projectId }) } };
    }),
    tool('project_backup', '按用户要求实际打包当前完整项目为.gxproject，包含工程、素材和自由Remotion源码，返回可保存的真实项目包。不会接收或写入模型指定本机路径。', objectSchema(), true, async (_args, ctx, state) => {
      await current(ctx, state); ready(bundles, 'prepareExport', '完整项目备份服务'); check(ctx);
      const run = async ({ signal = ctx.signal, update = () => {} } = {}) => {
        const value = await bundles.prepareExport(ctx.projectId, { signal, onProgress: progress => { ctx.update('正在打包完整项目与素材'); void Promise.resolve(update({ phase: '正在打包工程与素材', progress: progress.totalBytes > 0 ? Math.min(100, Math.round(progress.bytes / progress.totalBytes * 100)) : 0 })).catch(() => {}); } });
        await update({ outputs: [{ label: '保存完整项目包', url: value.downloadUrl }] }); return value;
      };
      const result = tasks?.track ? await tasks.track({ projectId: ctx.projectId, type: 'project-backup', title: '完整项目备份' }, run, { signal: ctx.signal, safeRetry: false }) : await run();
      return { summary: '已生成当前完整项目包，可保存到本机。', data: { filename: result.filename, bytes: result.bytes, report: result.report, downloadUrl: result.downloadUrl }, effects: [artifact(ctx.projectId, result.filename || '保存完整项目包', result.downloadUrl)] };
    }),
  ];
}
