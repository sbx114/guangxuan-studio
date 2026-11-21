import path from 'node:path';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { AppError, boundedString } from './errors.mjs';
import { validateProjectId } from './store.mjs';
import { runAi } from './ai.mjs';
import { normalizeEditScope, scopedAssets, resolveFreeEditScope } from './edit-scope.mjs';
import { createRemotionQualityService } from './remotion-quality.mjs';
import { buildRemotionReferenceContext } from './remotion-reference-library.mjs';
import { runReviewedRemotion } from './remotion-workflow.mjs';
import { normalizeRemotionVisualReferences } from './remotion-authoring.mjs';
import { createRemotionReferenceReviewService, normalizeRemotionReferenceEvidence } from './remotion-reference-review.mjs';

const fail = (status, message, code = 'REMOTION_REQUEST') => new AppError(status, message, code);
const terminal = new Set(['complete', 'error', 'cancelled']);
const normalizedScope = (value, assets) => normalizeEditScope(value ?? { placement: { mode: 'append' } }, assets);
function scopeKey(value, assets) {
  const scope = normalizedScope(value, assets), placement = scope.placement;
  return JSON.stringify({ assetIds: scope.assetIds?.slice().sort(), placement: { mode: placement.mode, at: placement.at, start: placement.start, end: placement.end, clipIds: placement.clipIds?.slice().sort() } });
}
function publicDiagnostic(value) {
  return String(value || '').replace(/[A-Za-z]:[\\/][^\s"'<>]+/g, name => {
    const relative = name.replace(/\\/g, '/').match(/\/revisions\/\d+\/(.+)$/);
    return relative ? relative[1] : '[工程文件]';
  }).replace(/\\\\[^\s"'<>]+/g, '[工程文件]');
}
export function createRemotionIntegration({ projects, store, openFilm, videoService, references, sourceAnalysis, ai = runAi, tasks } = {}) {
  if (!projects || !store) throw new Error('Remotion projects and store are required');
  const active = new Set(), imported = new Map(), appends = new Map(), metadata = new Map();
  const quality = createRemotionQualityService({ projects: { ...projects, read: (...args) => read(...args), inspect: (...args) => inspect(...args) }, ai, ffmpegPath: videoService?.runtimeTools?.().ffmpeg });
  const referenceQuality = createRemotionReferenceReviewService({ projects: { ...projects, read: (...args) => read(...args), inspect: (...args) => inspect(...args) }, ai, ffmpegPath: videoService?.runtimeTools?.().ffmpeg });
  async function owner(projectId, createdAt) {
    validateProjectId(projectId);
    const project = await store.read(projectId);
    if (!project || project.kind !== 'video') throw fail(404, '请先打开仍存在的视频项目。', 'PROJECT_NOT_FOUND');
    if (createdAt && project.createdAt !== createdAt) throw fail(409, '原视频项目已被移除或重建。', 'REMOTION_OWNER_CHANGED');
    return project;
  }
  async function read(projectId, id) {
    const project = await owner(projectId), record = await projects.read(projectId, id);
    if (record.ownerCreatedAt && record.ownerCreatedAt !== project.createdAt) throw fail(409, '这个动画工程属于之前的项目，请重新创建。', 'REMOTION_OWNER_CHANGED');
    return record;
  }
  async function list(projectId) {
    const project = await owner(projectId);
    return (await projects.list(projectId)).filter(record => !record.ownerCreatedAt || record.ownerCreatedAt === project.createdAt);
  }
  async function assetContext(projectId, origin, editScope, { signal } = {}) {
    const native = await openFilm.context(projectId, origin);
    const scope = normalizedScope(editScope, native.assets);
    const assets = [];
    for (const asset of scopedAssets(native.assets || [], scope).slice(0, 100)) {
      const local = await videoService.resolveAsset(asset.id);
      assets.push({ assetId: asset.id, name: asset.name, type: asset.type, duration: asset.duration, width: asset.width, height: asset.height, publicPath: 'media/' + asset.id + path.extname(local.path).toLowerCase() });
    }
    if (signal?.aborted) throw new DOMException('创作已取消。', 'AbortError');
    const analysis = sourceAnalysis?.context ? await sourceAnalysis.context(projectId, { origin, assetIds: assets.map(asset => asset.assetId) }) : undefined;
    if (signal?.aborted) throw new DOMException('创作已取消。', 'AbortError');
    const allowed = new Set(assets.map(asset => asset.assetId));
    const existingAnalysis = analysis?.sourceAnalysis ? { ...analysis.sourceAnalysis, items: (analysis.sourceAnalysis.items || []).filter(item => allowed.has(item.assetId)) } : undefined;
    return { native, scope, assets, sourceAnalysis: existingAnalysis };
  }
  async function generate(projectId, args, { origin, signal, editScope, settings, onProgress = () => {}, referenceEvidence, assertReferenceEvidence } = {}) {
    const project = await owner(projectId);
    let instruction = boundedString(args.instruction, '动画创作要求', 16000);
    if (referenceEvidence) await assertReferenceEvidence?.();
    const previous = args.remotionId ? await read(projectId, args.remotionId) : null;
    if (previous && args.expectedRevision !== previous.revision) throw fail(409, '动画代码已经变化，请先读取最新工程。', 'REMOTION_REVISION_CONFLICT');
    const context = await assetContext(projectId, origin, editScope ?? project.video?.editScope, { signal });
    const available = new Map(context.assets.map(asset => [asset.assetId, asset]));
    const clean = value => { const key = (settings ?? args.settings)?.apiKey; return publicDiagnostic(typeof key === 'string' && key ? String(value).split(key).join('[已隐藏]') : value); };
    const frameEvidence = referenceEvidence ? normalizeRemotionReferenceEvidence(referenceEvidence, context.assets, { signal, clean }) : null;
    if (frameEvidence?.context.expectedDuration) instruction = instruction.slice(0, 15000) + `\n本轮已绑定实际参考目标：Composition目标时长${frameEvidence.context.expectedDuration}秒；保持源时间顺序与1:1时间对应，不得压缩为短片、循环或空白补时后称全片重建完成。实际源范围${JSON.stringify(frameEvidence.context.sourceRange || { start: 0, end: frameEvidence.context.expectedDuration })}。只按selectedImageFrames判断本次看见的画面，较早登记notes是辅助观察，不能冒充本次全部逐帧核验。`;
    const referenceState = references?.list ? await references.list(projectId) : null;
    const referenceVersion = referenceState === null ? null : JSON.stringify([referenceState.revision, referenceState.includeImages]);
    const referenceContext = references?.context ? await references.context(projectId, { signal }) : undefined;
    if (signal?.aborted) throw new DOMException('创作已取消。', 'AbortError');
    const userReferences = referenceContext?.references ? normalizeRemotionVisualReferences({ ...referenceContext.references, includeImages: !frameEvidence && referenceContext.references.includeImages === true && (referenceState === null || referenceState.includeImages === true), ...(context.scope.placement.mode === 'range' ? { workRange: { start: context.scope.placement.start, end: context.scope.placement.end } } : {}) }) : undefined;
    const byReferenceId = new Map((userReferences?.items || []).map(item => [item.id, item]));
    const images = frameEvidence ? frameEvidence.images : userReferences?.includeImages ? (referenceContext.images || []).filter(image => {
      const item = byReferenceId.get(image.referenceId);
      if (!item || item.type === 'text') return false;
      return item.frames.some(frame => frame.label === image.label && (item.type !== 'video' || frame.timestamp === image.timestamp));
    }).slice(0, 12).map(image => ({ dataUrl: image.dataUrl, label: image.label })) : [];
    const assertReferenceVersion = async () => {
      if (signal?.aborted) throw new DOMException('创作已取消。', 'AbortError');
      if (referenceVersion !== null) { const latest = await references.list(projectId); if (referenceVersion !== JSON.stringify([latest.revision, latest.includeImages])) throw fail(409, '用户参考或发送画面设置已变化，请按最新参考重新生成。', 'REMOTION_REFERENCE_CHANGED'); }
      if (frameEvidence) await assertReferenceEvidence?.();
      if (signal?.aborted) throw new DOMException('创作已取消。', 'AbortError');
    };
    onProgress('正在编写自由Remotion工程');
    const codeContext = await buildRemotionReferenceContext({ instruction, title: project.title || '', script: project.video?.script || '',
      assets: context.assets, visualReferences: userReferences, ...(previous ? { existingProject: previous } : {}) });
    let existingFiles = previous?.files;
    if (previous && args.paths !== undefined) {
      if (!Array.isArray(args.paths) || !args.paths.length || args.paths.length > 128 || args.paths.some(name => typeof name !== 'string' || !previous.files.some(file => file.path === name))) throw fail(400, '请指定工程中实际存在的待改文件。', 'REMOTION_FILE_NOT_FOUND');
      existingFiles = previous.files.filter(file => args.paths.includes(file.path) || file.path === previous.entryPoint);
    }
    await assertReferenceVersion();
    const response = await ai('remotion-project', {
      instruction, title: project.title || '', script: project.video?.script || '', aspect: context.native.aspect,
      assets: context.assets, diagnostics: args.diagnostics || '',
      references: codeContext.references, referenceLibrary: codeContext.library, visualReferences: userReferences, sourceAnalysis: context.sourceAnalysis,
      ...(frameEvidence ? { referenceFrameAnalysis: frameEvidence.context } : {}),
      ...(previous ? { existingProject: { entryPoint: previous.entryPoint, compositionId: previous.compositionId, inputProps: previous.inputProps, files: existingFiles } } : {}),
    }, settings ?? args.settings, { signal, images });
    if (signal?.aborted) throw new DOMException('创作已取消。', 'AbortError');
    await owner(projectId, project.createdAt);
    await assertReferenceVersion();
    const data = response.data;
    if ((data.assetIds || []).some(id => !available.has(id))) throw fail(403, '动画引用了本次未选素材。', 'REMOTION_ASSET_SCOPE');
    const update = { title: data.title, entryPoint: data.entryPoint, compositionId: data.compositionId, inputProps: data.inputProps, files: data.files, assets: (data.assetIds || []).map(assetId => ({ assetId })), ownerCreatedAt: project.createdAt };
    const saved = previous ? await projects.update(projectId, previous.id, { ...update, expectedRevision: previous.revision }) : await projects.create(projectId, update);
    return { project: saved, notes: data.notes || [] };
  }
  const metadataKey = (projectId, id, record, options) => `${projectId}:${id}:${record.revision}:${JSON.stringify(options.inputProps ?? record.inputProps)}`;
  async function inspect(projectId, id, options = {}) {
    const record = await read(projectId, id);
    let result;
    try { result = await projects.inspect(projectId, id, options); }
    catch (error) { throw fail(error.status || 422, publicDiagnostic(error.message), error.code || 'REMOTION_INSPECT_FAILED'); }
    metadata.set(metadataKey(projectId, id, record, options), Array.isArray(result) ? result : result.compositions);
    return result;
  }
  async function start(projectId, id, options = {}) {
    const record = await read(projectId, id), settings = { ...options };
    if (options.range !== undefined) {
      const key = metadataKey(projectId, id, record, options);
      if (!metadata.has(key)) await inspect(projectId, id, options);
      const compositions = metadata.get(key) || [], composition = compositions.find(item => item.id === (options.compositionId || record.compositionId)) || (compositions.length === 1 ? compositions[0] : null);
      if (!composition) throw fail(400, '请先选择实际Composition。', 'REMOTION_COMPOSITION_REQUIRED');
      if (!Array.isArray(options.range) || options.range.length !== 2 || options.range.some(value => typeof value !== 'number' || !Number.isFinite(value)) || options.range[0] < 0 || options.range[1] <= options.range[0] || options.range[1] > composition.durationInFrames / composition.fps) throw fail(400, '小样起止秒数超出实际作品。', 'REMOTION_RANGE_INVALID');
      settings.range = options.range.map(value => Math.round(value * composition.fps));
      if (settings.range[1] <= settings.range[0]) throw fail(400, '小样至少需要一帧。', 'REMOTION_RANGE_INVALID');
    }
    return projects.render(projectId, id, settings);
  }
  async function job(projectId, jobId) {
    const project = await owner(projectId), value = await projects.getJob(projectId, jobId);
    if (value.ownerCreatedAt && value.ownerCreatedAt !== project.createdAt) throw fail(409, '此渲染任务属于旧项目。', 'REMOTION_OWNER_CHANGED');
    return value;
  }
  async function cancel(projectId, jobId) { await job(projectId, jobId); return projects.cancelJob(projectId, jobId); }
  async function review(projectId, id, options = {}) {
    await read(projectId, id);
    const result = await quality.review(projectId, id, options);
    await read(projectId, id);
    return { ...result, frames: (result.frames || []).map(frame => ({ ...frame, url: `/api/projects/${projectId}/remotion/jobs/${result.previewJobId}/files/${encodeURIComponent(frame.file)}` })) };
  }
  async function compareReference(projectId, id, options = {}) {
    const project = await owner(projectId), source = await read(projectId, id);
    const currentAssets = await assetContext(projectId, options.origin, options.editScope ?? project.video?.editScope, { signal: options.signal });
    const assertReferenceEvidence = async () => { await owner(projectId, project.createdAt); await options.assertReferenceEvidence?.(); };
    const clean = value => { const key = options.settings?.apiKey; return publicDiagnostic(typeof key === 'string' && key ? String(value).split(key).join('[已隐藏]') : value); };
    const result = await referenceQuality.compare(projectId, id, { ...options, clean, allowedAssets: currentAssets.assets, assertReferenceEvidence });
    const latest = await read(projectId, id);
    if (latest.revision !== source.revision) throw fail(409, '参考对照期间源码已有修改。', 'REMOTION_REVISION_CONFLICT');
    return { ...result, frames: (result.frames || []).map(frame => ({ ...frame, url: `/api/projects/${projectId}/remotion/jobs/${result.previewJobId}/files/${encodeURIComponent(frame.file)}` })) };
  }
  async function generateAndImprove(projectId, args, options = {}) {
    const result = await runReviewedRemotion({
      signal: options.signal, onProgress: options.onProgress,
      compileRepairs: 2, visualRepairs: 1,
      generate: ({ project: previous, diagnostics }) => generate(projectId, { ...args, ...(previous ? { remotionId: previous.id, expectedRevision: previous.revision } : {}), diagnostics: diagnostics || args.diagnostics || '' }, options),
      inspect: record => inspect(projectId, record.id, { expectedRevision: record.revision, signal: options.signal }),
      review: record => review(projectId, record.id, { expectedRevision: record.revision, compositionId: record.compositionId, inputProps: record.inputProps, instruction: args.instruction, settings: options.settings ?? args.settings, signal: options.signal, onProgress: options.onProgress }),
    });
    return result;
  }
  function publicJob(projectId, value) {
    const copy = structuredClone(value), id = value.id || value.jobId;
    if (copy.result) {
      delete copy.result.outputPath;
      if (copy.result.frames) copy.result.frames = copy.result.frames.map(frame => ({ ...frame, url: `/api/projects/${projectId}/remotion/jobs/${id}/files/${encodeURIComponent(frame.file)}` }));
      if (value.result?.outputPath || value.kind === 'video' || value.type === 'video') copy.result.videoUrl = `/api/projects/${projectId}/remotion/jobs/${id}/files/video.mp4`;
    }
    delete copy.outputPath;
    if (copy.error?.message) copy.error.message = publicDiagnostic(copy.error.message);
    else if (typeof copy.error === 'string') copy.error = publicDiagnostic(copy.error);
    return copy;
  }
  async function append(projectId, id, args, { origin, editScope, signal } = {}) {
    const record = await read(projectId, id), rendered = await job(projectId, args.jobId);
    if (rendered.status !== 'complete' || rendered.remotionId !== id || rendered.revision !== record.revision || !rendered.result?.outputPath) throw fail(409, '请使用当前工程版本已完成的视频渲染结果。', 'REMOTION_STALE_RENDER');
    const project = await owner(projectId, record.ownerCreatedAt), native = await openFilm.context(projectId, origin);
    if (args.expectedNativeRevision && native.revision !== args.expectedNativeRevision) throw fail(409, '剪辑时间线已有修改，请重新核对后加入。', 'OPENFILM_REVISION_CONFLICT');
    if (signal?.aborted) throw new DOMException('操作已取消。', 'AbortError');
    if (args.editScope && scopeKey(args.editScope, native.assets) !== scopeKey(project.video?.editScope, native.assets)) throw fail(409, '本次渲染后的剪辑范围已有变化，请重新核对后加入。', 'REMOTION_SCOPE_CHANGED');
    const requestedScope = normalizedScope(editScope ?? args.editScope ?? project.video?.editScope, native.assets);
    const scope = resolveFreeEditScope(requestedScope, args.placement, native.assets);
    const key = `${projectId}:${args.jobId}:${native.revision}:${JSON.stringify(scope)}`;
    if (appends.has(key)) return structuredClone(await appends.get(key));
    const operation = (async () => {
      let asset = imported.get(args.jobId);
      if (!asset) {
        asset = await videoService.importLocalFile(rendered.result.outputPath, { name: record.title + '.mp4', generated: true, generatedType: 'remotion', projectId });
        imported.set(args.jobId, asset);
      }
      const commit = async () => {
        const latestSource = await read(projectId, id), latestProject = await owner(projectId, project.createdAt);
        if (latestSource.revision !== rendered.revision) throw fail(409, '导入期间动画源码已有修改，请渲染最新版本后再加入。', 'REMOTION_STALE_RENDER');
        if (args.editScope && scopeKey(args.editScope, native.assets) !== scopeKey(latestProject.video?.editScope, native.assets)) throw fail(409, '导入期间剪辑范围已有变化，请重新核对。', 'REMOTION_SCOPE_CHANGED');
        if (signal?.aborted) throw new DOMException('操作已取消。', 'AbortError');
        const applied = await openFilm.appendAsset(projectId, asset.id, origin, undefined, { keepUndo: true, expectedRevision: native.revision, requestId: 'remotion-' + args.jobId, editScope: requestedScope, ...(requestedScope.placement.mode === 'free' ? { placement: scope.placement } : {}) });
        return { ...applied, appended: true, asset, remotionId: id, jobId: args.jobId };
      };
      return projects.withRevision ? projects.withRevision(projectId, id, rendered.revision, commit) : commit();
    })();
    appends.set(key, operation);
    try { return await operation; } catch (error) { appends.delete(key); throw error; }
  }
  async function onJob(value) {
    if (!tasks) return;
    const id = value.id || value.jobId;
    await tasks.upsertExternal('remotion:' + id, { type: 'remotion', title: 'Remotion · ' + (value.title || '自由动画'), projectId: value.projectId, sourceJobId: id }, {
      status: ({ complete: 'completed', error: 'failed' })[value.status] || value.status,
      progress: Math.round((value.progress || 0) * 100), phase: value.phase || ({ queued: '等待渲染', running: '正在编译和渲染', complete: '渲染完成', error: '渲染未完成', cancelled: '已取消' })[value.status],
      message: String(value.error?.message || value.error || '').slice(0, 500), error: value.status === 'error' ? { code: 'REMOTION_RENDER_ERROR', message: String(value.error?.message || value.error || '渲染未完成').slice(0, 500) } : null,
    }, { safeRetry: false, cancel: () => projects.cancelJob(value.projectId, id) });
  }
  async function handler(req, res, url, { readJson, json, signal, rememberSecret } = {}) {
    const match = /^\/api\/projects\/([^/]+)\/remotion(?:\/(.*))?$/.exec(url.pathname);
    if (!match) return false;
    const projectId = validateProjectId(decodeURIComponent(match[1])), rest = match[2] || '', method = req.method || 'GET';
    const project = await owner(projectId);
    const body = method === 'POST' || method === 'PUT' ? await readJson(req) : null;
    const respond = (status, data) => { json(res, status, data); return true; };
    if (!rest && method === 'GET') return respond(200, { items: await list(projectId) });
    if (!rest && method === 'POST') return respond(201, { project: await projects.create(projectId, { ...body, ownerCreatedAt: project.createdAt }) });
    if (rest === 'generate' && method === 'POST') {
      rememberSecret?.(body.settings);
      const create = ({ signal: taskSignal = signal, update = () => {} } = {}) => (body.autoImprove === true ? generateAndImprove : generate)(projectId, body, { origin: url.origin, signal: taskSignal, settings: body.settings, onProgress: phase => { void Promise.resolve(update({ phase })).catch(() => {}); } });
      return respond(200, tasks?.track ? await tasks.track({ projectId, type: 'remotion-source', title: 'Remotion源码创作' }, create, { signal, safeRetry: false }) : await create());
    }
    const jobMatch = /^jobs\/([A-Za-z0-9_-]+)(?:\/(cancel|files\/([^/]+)))?$/.exec(rest);
    if (jobMatch) {
      const [, jobId, operation, encodedFile] = jobMatch;
      if (!operation && method === 'GET') return respond(200, { job: publicJob(projectId, await job(projectId, jobId)) });
      if (operation === 'cancel' && method === 'POST') { await job(projectId, jobId); return respond(200, { job: publicJob(projectId, await projects.cancelJob(projectId, jobId)) }); }
      if (encodedFile && ['GET', 'HEAD'].includes(method)) {
        await job(projectId, jobId);
        const found = await projects.file(projectId, jobId, decodeURIComponent(encodedFile)), filename = typeof found === 'string' ? found : found.path;
        const info = await stat(filename), range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
        let start = 0, end = info.size - 1;
        if (range) { start = Number(range[1]); end = Math.min(end, range[2] ? Number(range[2]) : end); if (start > end || start >= info.size) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); res.end(); return true; } }
        res.writeHead(range ? 206 : 200, { 'Content-Type': path.extname(filename) === '.mp4' ? 'video/mp4' : 'image/png', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${info.size}` } : {}) });
        if (method === 'HEAD') res.end(); else createReadStream(filename, { start, end }).on('error', () => res.destroy()).pipe(res);
        return true;
      }
    }
    const sourceMatch = /^([A-Za-z0-9_-]+)(?:\/(inspect|preview|render|append|review))?$/.exec(rest);
    if (sourceMatch) {
      const [, id, operation] = sourceMatch;
      if (!operation && method === 'GET') return respond(200, { project: await read(projectId, id) });
      if (!operation && method === 'PUT') { await read(projectId, id); return respond(200, { project: await projects.update(projectId, id, body) }); }
      if (operation === 'inspect' && method === 'POST') { const result = await inspect(projectId, id, { ...body, signal }); return respond(200, Array.isArray(result) ? { compositions: result } : result); }
      if (operation === 'review' && method === 'POST') {
        rememberSecret?.(body.settings);
        const check = ({ signal: taskSignal = signal, update = () => {} } = {}) => review(projectId, id, { ...body, signal: taskSignal, onProgress: phase => { void Promise.resolve(update({ phase })).catch(() => {}); } });
        return respond(200, { review: tasks?.track ? await tasks.track({ projectId, type: 'remotion-review', title: '动画画面复核' }, check, { signal, safeRetry: false }) : await check() });
      }
      if (['preview', 'render'].includes(operation) && method === 'POST') return respond(202, await start(projectId, id, { ...body, kind: operation === 'preview' ? 'preview' : 'video' }));
      if (operation === 'append' && method === 'POST') return respond(200, await append(projectId, id, body, { origin: url.origin, signal }));
    }
    throw fail(404, '找不到这个Remotion工程操作。', 'REMOTION_ROUTE_NOT_FOUND');
  }
  return { list, read, generate, inspect, start, job, cancel, review, compareReference, publicJob, append, onJob, handler, terminal,
    track(promise) { active.add(promise); promise.finally(() => active.delete(promise)).catch(() => {}); return promise; },
    async close() { await Promise.allSettled([...active]); appends.clear(); imported.clear(); metadata.clear(); },
  };
}
