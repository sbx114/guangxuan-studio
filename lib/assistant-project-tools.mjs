import { AppError } from './errors.mjs';
import { assistantContentHash } from './store.mjs';
import { projectCoverUrl } from './project-covers.mjs';
import path from 'node:path';
import { prepareAssistantCover, requireAssistantCoverMime, readAssistantCoverFile, readAssistantCoverResponse } from './assistant-cover-image.mjs';

const schema = (properties = {}, required = []) => ({ type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}) });
const text = maxLength => ({ type: 'string', minLength: 1, maxLength });
const fail = (status, message, code) => new AppError(status, message, code);
const presets = ['classic', 'blueprint', 'film', 'paper', 'custom'];
const metadata = project => ({ projectId: project.id, title: project.title, description: project.description || '', cover: project.cover || 'classic', coverAssetId: project.coverAssetId || '', coverUrl: projectCoverUrl(project.coverAssetId), metadataRevision: project.metadataRevision || 0 });

export async function restoreProjectCapabilityUndo(record, { store, sourceLinks } = {}) {
  if (record.kind === 'project-metadata') return store.patchMetadata(record.projectId, record.before, { expectedHash: record.expectedHash, expectedCreatedAt: record.createdAt });
  if (record.kind === 'source-link') return sourceLinks.restoreAssistant(record.projectId, record.before, { expectedHash: record.expectedHash, expectedCreatedAt: record.createdAt, expectedLinkHash: record.expectedLinkHash });
  throw fail(400, '不是可恢复的项目资料记录。', 'ASSISTANT_UNDO_INVALID');
}

/** Current project business operations, with trusted CAS/owner/idempotence hooks. */
export function createProjectCapabilityTools({ tool, owner, current, check = () => {}, rememberUndo, store, sourceLinks, projectCovers, downloads, artifacts, readNative, videoService, root: _root } = {}) {
  if (![tool, owner, current, rememberUndo].every(value => typeof value === 'function') || !store?.read) throw new TypeError('Project capabilities require the scoped assistant adapter.');
  const tools = [];
  tools.push(tool('project_cover_inspect', '读取当前项目真实封面、图片URL和metadataRevision，以及可选的classic/blueprint/film/paper预置封面。自定义图片可直接用下载区downloadId、当前项目已生成图片artifactId、当前剪辑图片assetId或原生poster导出的nativeExportId；不需用户手工下载上传，不读模型指定路径。', schema(), false, async (_args, ctx) => ({ summary: '已读取当前项目封面。', data: { ...metadata(await owner(ctx)), presets } })));
  if (projectCovers?.importBytes) tools.push(tool('project_cover_set', '按当前对话设置当前工程封面。preset=classic/blueprint/film/paper，custom复用当前图片；或四选一：downloadId取可用下载图片，artifactId直接取本项目writing_export等已生成PNG，assetId取当前原生工程图片素材，nativeExportId取本项目已完成poster图片导出（native_export_catalog/native_export_advanced）。不得把ZIP/视频当图片；可先poster导出再直接设封面，不让用户手工下载上传。不接收URL/路径；实际PNG/JPEG/WebP需20MB以内，固定Canvas最长边1280，metadataRevision/CAS保护且可撤销。', schema({ preset: { type: 'string', enum: presets }, downloadId: text(36), artifactId: text(36), assetId: text(128), nativeExportId: text(128), expectedMetadataRevision: { type: 'integer', minimum: 0 } }, ['expectedMetadataRevision']), true, async (args, ctx, state) => {
    const project = await current(ctx, state); check(ctx);
    const sources = ['downloadId', 'artifactId', 'assetId', 'nativeExportId'].filter(field => Object.hasOwn(args, field));
    if (sources.length > 1 || !sources.length && !presets.includes(args.preset) || sources.length && args.preset && args.preset !== 'custom' || sources.some(field => typeof args[field] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(args[field]))) throw fail(400, '请选择一种预置封面或一份当前工程可用图片来源。', 'ASSISTANT_COVER_INPUT');
    if (!Number.isSafeInteger(args.expectedMetadataRevision) || args.expectedMetadataRevision !== (project.metadataRevision || 0)) throw fail(409, '封面资料已有更新，请重新读取。', 'PROJECT_METADATA_CONFLICT');
    let imported, dimensions;
    if (sources.length) {
      let buffer;
      if (args.downloadId) {
        if (!downloads?.read) throw fail(503, '本机下载资料区尚未就绪。', 'ASSISTANT_COVER_UNAVAILABLE');
        const file = await downloads.read(args.downloadId, { projectId: project.id }); check(ctx);
        if (file.download?.projectId && file.download.projectId !== project.id) throw fail(403, '这份下载不属于当前项目。', 'ASSISTANT_COVER_SCOPE');
        if (file.download?.contentType) requireAssistantCoverMime(file.download.contentType);
        buffer = file.buffer;
      } else if (args.artifactId) {
        if (!artifacts?.read) throw fail(503, '本机制作文件服务尚未就绪。', 'ASSISTANT_COVER_UNAVAILABLE');
        const file = await artifacts.read(args.artifactId, { projectId: project.id }); check(ctx);
        if (file.file?.projectId !== project.id) throw fail(403, '这份制作文件不属于当前项目。', 'ASSISTANT_COVER_SCOPE');
        requireAssistantCoverMime(file.file.contentType); buffer = file.buffer;
      } else if (args.assetId) {
        if (!readNative || !videoService?.resolveAsset) throw fail(503, '原生图片素材库尚未就绪。', 'ASSISTANT_COVER_UNAVAILABLE');
        const native = await readNative(ctx, state); check(ctx);
        const member = native.assets?.find(asset => asset.id === args.assetId);
        if (!member) throw fail(403, '封面素材不属于当前原生工程。', 'ASSISTANT_COVER_SCOPE');
        if (member.type !== 'image') requireAssistantCoverMime('video/mp4');
        const asset = await videoService.resolveAsset(args.assetId); check(ctx);
        if (asset?.id !== args.assetId || asset.type !== 'image' || typeof asset.path !== 'string') throw fail(403, '封面素材没有通过当前工程校验。', 'ASSISTANT_COVER_SCOPE');
        requireAssistantCoverMime(asset.mimeType || asset.contentType || ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' })[path.extname(asset.path).toLowerCase()]);
        buffer = await readAssistantCoverFile(asset.path, { signal: ctx.signal });
      } else {
        await owner(ctx, 'video'); let origin;
        try { const parsed = new URL(ctx.origin); if (!['http:', 'https:'].includes(parsed.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || parsed.username || parsed.password) throw new Error(); origin = parsed.origin; }
        catch { throw fail(403, '原生封面只能从当前本机应用服务读取。', 'ASSISTANT_COVER_ORIGIN'); }
        const signal = ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
        let response;
        try { response = await fetch(`${origin}/api/openfilm/exports/${project.id}/${args.nativeExportId}/file`, { method: 'GET', redirect: 'error', headers: { Origin: origin }, signal }); }
        catch (error) { if (ctx.signal?.aborted) throw error; throw fail(422, '原生封面文件读取未完成，请先确认当前工程的poster图片导出已完成。', 'ASSISTANT_COVER_EXPORT_UNAVAILABLE'); }
        if (!response.ok) { await response.body?.cancel().catch(() => {}); throw fail(422, '当前工程尚无可读取的此项导出，请先完成poster封面图片导出。', 'ASSISTANT_COVER_EXPORT_UNAVAILABLE'); }
        buffer = await readAssistantCoverResponse(response, { signal });
      }
      ctx.update('正在解码、缩放并校验真实封面图片');
      dimensions = await prepareAssistantCover(buffer, { signal: ctx.signal });
      await current(ctx, state); check(ctx);
      imported = await projectCovers.importBytes(dimensions.buffer, { signal: ctx.signal });
    }
    await current(ctx, state); check(ctx);
    const patch = imported ? { cover: 'custom', coverAssetId: imported.coverAssetId } : { cover: args.preset };
    let saved;
    try { saved = await store.patchMetadata(project.id, patch, { expectedHash: state.hash, expectedCreatedAt: project.createdAt, expectedMetadataRevision: args.expectedMetadataRevision }); }
    catch (error) { if (error.status === 409) state.conflicted = true; throw error; }
    state.hash = assistantContentHash(saved);
    const undo = rememberUndo({ kind: 'project-metadata', projectId: project.id, createdAt: project.createdAt, expectedHash: state.hash, before: { cover: project.cover || 'classic', coverAssetId: project.coverAssetId || '' }, runId: ctx.runId });
    return { summary: '已更新当前工程封面。', data: { ...metadata(saved), ...(dimensions ? { image: { width: dimensions.width, height: dimensions.height, originalWidth: dimensions.originalWidth, originalHeight: dimensions.originalHeight } } : {}) }, effects: [{ type: 'project', projectId: project.id, label: '已更新项目封面', changed: true, undo }] };
  }));
  if (sourceLinks?.assistantSnapshot) {
    tools.push(tool('source_link_inspect', '读取当前视频工程的真实来源关联、逐项差异ID、sourceHash/targetHash/revision/linkHash及可关联的文案/科普候选；可传sourceProjectId预览该已有来源的正文与分镜hash。此操作不改任何工程。', schema({ sourceProjectId: text(128) }), false, async (args, ctx) => {
      const project = await owner(ctx, 'video');
      const [status, candidates] = await Promise.all([sourceLinks.status(project.id), sourceLinks.candidates()]);
      const preview = args.sourceProjectId ? await sourceLinks.preview(args.sourceProjectId) : undefined;
      return { summary: '已比较当前工程来源与视频草稿。', data: { ...status, candidates: candidates.projects, ...(preview ? { preview } : {}), timelineChanged: false } };
    }));
    tools.push(tool('source_link_manage', '按当前对话建立bind、解除unlink来源关联，或按用户指定selectedIds同步sync比较出的旁白/拟定字幕/分镜字段。先source_link_inspect取真实版本与差异ID；bind还需预览来源的sourceHash。bind只建立后续版本基线，保留当前草稿；sync只更改草稿与来源基线，不触碰原生时间线、媒体、调色、锁轨或现有剪辑。手动修改冲突原样保留，可明确给manualScript合并旁白。原子版本检查并可撤销。', schema({ action: { type: 'string', enum: ['bind', 'unlink', 'sync'] }, expectedLinkHash: text(64), sourceProjectId: text(128), sourceHash: text(64), targetHash: text(64), revision: { type: 'integer', minimum: 0 }, selectedIds: { type: 'array', minItems: 1, maxItems: 801, items: text(100) }, manualScript: { type: 'string', maxLength: 30000 } }, ['action', 'expectedLinkHash']), true, async (args, ctx, state) => {
      const project = await current(ctx, state, 'video'), before = await sourceLinks.assistantSnapshot(project.id); check(ctx);
      if (before.expectedHash !== state.hash || before.linkHash !== args.expectedLinkHash) { state.conflicted = true; throw fail(409, '项目或关联已变化，请重新比较来源。', 'SOURCE_LINK_CONFLICT'); }
      const options = { expectedHash: state.hash, expectedCreatedAt: project.createdAt, expectedLinkHash: args.expectedLinkHash };
      let result;
      try {
        if (args.action === 'bind') {
          if (typeof args.sourceHash !== 'string' || typeof args.sourceProjectId !== 'string') throw fail(400, '关联前请读取来源项目和sourceHash。', 'SOURCE_LINK_INPUT');
          result = await sourceLinks.bind(project.id, { sourceProjectId: args.sourceProjectId, sourceHash: args.sourceHash }, options);
        } else if (args.action === 'unlink') result = await sourceLinks.unlink(project.id, options);
        else if (args.action === 'sync') {
          if (!Array.isArray(args.selectedIds) || !args.selectedIds.length) throw fail(400, '请明确选择要同步的差异ID。', 'INVALID_SOURCE_SELECTION');
          if (args.manualScript !== undefined && (typeof args.manualScript !== 'string' || args.manualScript.length > 30000)) throw fail(400, '合并后的旁白需为30000字以内文字。', 'INVALID_VIDEO_DRAFT');
          result = await sourceLinks.sync(project.id, { sourceHash: args.sourceHash, targetHash: args.targetHash, revision: args.revision, selectedIds: args.selectedIds, ...(args.manualScript !== undefined ? { manualScript: args.manualScript } : {}) }, options);
        } else throw fail(400, '来源关联操作无效。', 'SOURCE_LINK_INPUT');
      } catch (error) { if (error.status === 409) state.conflicted = true; throw error; }
      state.hash = assistantContentHash(result.project);
      const undo = rememberUndo({ kind: 'source-link', projectId: project.id, createdAt: project.createdAt, expectedHash: state.hash, expectedLinkHash: result.linkHash, before, runId: ctx.runId });
      const { project: _full, ...data } = result;
      const summary = args.action === 'bind' ? '已建立来源关联，当前草稿和原生剪辑保留。' : args.action === 'unlink' ? '已解除来源关联，当前草稿和原生剪辑保留。' : result.conflicts?.length ? '已同步可安全合并的草稿变动；手动冲突项已保留，请按返回差异继续处理。' : '已同步指定草稿变动，原生剪辑保持原样。';
      return { summary, data, effects: [{ type: 'project', projectId: project.id, label: summary, changed: true, undo }] };
    }));
  }
  return tools;
}
