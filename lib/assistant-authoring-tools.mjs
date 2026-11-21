import { createHash } from 'node:crypto';
import { AppError, boundedString, requireObject } from './errors.mjs';
import { normalizeWritingInput } from './writing.mjs';
import { createDocx } from './documents.mjs';
import { serializePlayableNovel } from './visual-novel.mjs';
import { renderAssistantPoster } from './assistant-poster.mjs';
import { referenceContentHash } from './references.mjs';
import { exportAssistantNovel } from './assistant-novel-export.mjs';

const schema = (properties = {}, required = []) => ({ type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}) });
const text = maxLength => ({ type: 'string', minLength: 1, maxLength });
const optional = maxLength => ({ type: 'string', maxLength });
const channels = ['article', 'poster', 'video', 'social'];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (status, message, code = 'ASSISTANT_AUTHORING_INVALID') => new AppError(status, message, code);
const pick = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
const range = { anyOf: [schema({ start: { type: 'number', minimum: 0 }, end: { type: 'number', minimum: 0 } }, ['start', 'end']), { type: 'null' }] };
const selectionSchema = schema({ documentId: text(128), unitIds: { type: 'array', minItems: 1, maxItems: 160, items: text(100) } }, ['documentId', 'unitIds']);
const referenceProperties = { type: { type: 'string', enum: ['text', 'image', 'video'] }, assetId: text(100), name: optional(120), text: optional(12000), focus: optional(1500), sourceUrl: optional(2000), aspects: { type: 'array', maxItems: 6, items: { type: 'string', enum: ['style', 'editing', 'color', 'composition', 'titles', 'structure'] } }, sourceRange: range, targetRange: range };
const filename = title => { const clean = String(title || '当前稿件').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_').replace(/[. ]+$/, '').slice(0, 100); return /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(clean) ? '稿件-' + clean : clean || '当前稿件'; };
const publicLibraryIntent = instruction => /(?:公用|公共|素材库|人物库|角色库|场景库|全局|库(?:里|中|内|的)|所有(?:项目|工程)|跨(?:项目|工程)|shared\s+library)/i.test(instruction || '');
const artifactEffect = (projectId, file, kind = 'writing') => ({ type: 'artifact', projectId, label: '已生成：' + file.name, changed: true, artifact: { kind, id: file.id, projectId, name: file.name, downloadUrl: file.downloadUrl } });

function outputText(channel, output) {
  const array = value => Array.isArray(value) ? value : [];
  if (channel === 'article') return [output.title, output.lead, output.body].filter(Boolean).join('\n\n');
  if (channel === 'social') return [output.title, output.text, array(output.tags).filter(tag => typeof tag === 'string').map(tag => '#' + tag.replace(/^#/, '')).join(' ')].filter(Boolean).join('\n\n');
  if (channel === 'poster') return [output.eyebrow, output.title, output.subtitle, array(output.highlights).filter(item => typeof item === 'string').join('\n'), array(output.details).filter(item => item && typeof item === 'object').map(item => [item.label, item.value].filter(Boolean).join('：')).join('\n'), output.footer].filter(Boolean).join('\n\n');
  return [output.title, ...array(output.shots).filter(shot => shot && typeof shot === 'object').map((shot, index) => [`镜头${index + 1}（${shot.duration || 0}秒）`, shot.visual ? '画面：' + shot.visual : '', shot.narration ? '旁白：' + shot.narration : '', shot.caption ? '字幕：' + shot.caption : ''].filter(Boolean).join('\n'))].filter(Boolean).join('\n\n');
}
function stringLeaf(novel, parts) {
  if (!Array.isArray(parts) || !parts.length || parts.length > 10 || parts.some(part => !(typeof part === 'string' || Number.isSafeInteger(part) && part >= 0))) throw fail(400, '作品文字路径无效。');
  const key = parts.join('.');
  if (!/^(?:title|logline|learningGoals\.\d+|chapters\.\d+\.title|scenes\.\d+\.title|scenes\.\d+\.lines\.\d+\.(?:text|card\.(?:title|text)|question\.(?:prompt|choices\.\d+\.(?:text|feedback))))$/.test(key)) throw fail(400, '只能修改已有作品文字，人物、引用、问题答案和结构需要专用编辑。', 'ASSISTANT_NOVEL_PATH');
  let parent = novel;
  for (const part of parts.slice(0, -1)) { if (!parent || !Object.hasOwn(parent, part)) throw fail(400, '作品文字位置不存在。', 'ASSISTANT_NOVEL_PATH'); parent = parent[part]; }
  if (!parent || !Object.hasOwn(parent, parts.at(-1)) || typeof parent[parts.at(-1)] !== 'string') throw fail(400, '该位置不是已有文字。', 'ASSISTANT_NOVEL_PATH');
  return { parent, field: parts.at(-1), value: parent[parts.at(-1)] };
}

/** Hooks are private trusted adapter functions, never model arguments. */
export function createAuthoringCapabilityTools({ tool, owner, current, commit, rememberUndo, readNative, check = () => {}, references, scienceDocuments, novelLibrary, artifacts, downloads, root } = {}) {
  if (![tool, owner, current, commit, rememberUndo].every(value => typeof value === 'function')) throw fail(500, '创作工具未正确配置。', 'ASSISTANT_AUTHORING_NOT_CONFIGURED');
  const tools = [];
  if (references) {
    tools.push(tool('reference_list', '读取当前视频项目全部参考项、文字、参考/作品区间和画面发送开关；返回实际revision。', schema(), false, async (_args, ctx) => {
      await owner(ctx, 'video'); return { summary: '已读取当前项目参考库。', data: await references.list(ctx.projectId) };
    }));
    tools.push(tool('reference_manage', '按明确要求添加/修改/移除当前视频参考，或设置includeImages画面开关。媒体assetId只能来自当前已选素材；不会下载或执行链接。先reference_list取版本和id。remove仅移除参考关系，不删素材。每次原子检查版本且可撤销。', schema({ action: { type: 'string', enum: ['add', 'update', 'remove', 'configure'] }, expectedRevision: { type: 'integer', minimum: 0 }, referenceId: text(128), item: schema(referenceProperties), includeImages: { type: 'boolean' } }, ['action', 'expectedRevision']), true, async (args, ctx, state) => {
      const project = await current(ctx, state, 'video'), before = await references.list(project.id); check(ctx);
      if (before.revision !== args.expectedRevision) throw fail(409, '参考版本已变化，请重新读取。', 'REFERENCE_REVISION_CONFLICT');
      const options = { expectedRevision: args.expectedRevision, expectedCreatedAt: project.createdAt };
      let after;
      try {
        if (args.action === 'add') {
          requireObject(args.item, '参考资料');
          if (args.item.type !== 'text') {
            if (state.scope?.assetIds && !state.scope.assetIds.includes(args.item.assetId)) throw fail(403, '只能引用本次已选素材；请先选择或导入该素材。', 'ASSISTANT_REFERENCE_SCOPE');
            if (!readNative) throw fail(503, '请先打开原生剪辑素材库。', 'ASSISTANT_REFERENCE_CONTEXT');
            const native = await readNative(ctx, state);
            if (!native.assets?.some(asset => asset.id === args.item.assetId)) throw fail(403, '参考素材不属于当前项目。', 'ASSISTANT_REFERENCE_SCOPE');
          }
          after = await references.add(project.id, pick(args.item, Object.keys(referenceProperties)), options);
        } else if (args.action === 'update') {
          after = await references.update(project.id, args.referenceId, pick(requireObject(args.item, '参考修改'), Object.keys(referenceProperties).filter(key => !['type', 'assetId'].includes(key))), options);
        } else if (args.action === 'remove') after = await references.remove(project.id, args.referenceId, options);
        else if (args.action === 'configure') after = await references.configure(project.id, { includeImages: args.includeImages }, options);
        else throw fail(400, '参考操作无效。');
      } catch (error) { if (error.status === 409) state.conflicted = true; throw error; }
      state.referenceRevision = after.revision;
      const changed = before.revision !== after.revision;
      const undo = changed ? rememberUndo({ kind: 'references', projectId: project.id, createdAt: project.createdAt, expectedContentHash: referenceContentHash(after), before, runId: ctx.runId }) : undefined;
      return { summary: changed ? '已更新当前视频参考库。' : '参考库无需修改。', data: after, effects: changed ? [{ type: 'document', projectId: project.id, label: '已更新项目参考', changed: true, undo }] : [] };
    }));
  }
  tools.push(tool('writing_material_update', '按明确要求补充或替换文案原始材料及写作目标、形式、读者、场景、篇幅、必提要点。sourceMode=append保留原正文后追加，replace替换给出的source字段；材料变化使旧事实和审核待核对，保留已有稿件，可撤销。', schema({ sourceMode: { type: 'string', enum: ['append', 'replace'] }, source: schema({ title: optional(300), text: optional(60000), url: optional(2000) }), brief: schema({ goal: optional(2000), channel: { type: 'string', enum: ['auto', ...channels] }, audience: optional(500), scenario: optional(500), length: optional(200), requiredPoints: { anyOf: [{ type: 'array', maxItems: 20, items: text(500) }, optional(5000)] } }) }), true, async (args, ctx, state) => {
    const project = await current(ctx, state, 'writing');
    if (!args.source && !args.brief) throw fail(400, '请给出要修改的材料或写作需求。');
    let source = { ...(project.source || {}) };
    if (args.source) {
      requireObject(args.source, '写作材料');
      if (!['append', 'replace'].includes(args.sourceMode)) throw fail(400, '更新材料需要明确append追加或replace替换。');
      source = { ...source, ...pick(args.source, ['title', 'text', 'url']) };
      if (args.sourceMode === 'append' && Object.hasOwn(args.source, 'text')) source.text = [project.source?.text, args.source.text].filter(Boolean).join('\n\n');
    }
    const normalized = normalizeWritingInput('writing-draft', { source, writingBrief: { ...(project.writing?.brief || {}), ...pick(args.brief || {}, ['goal', 'channel', 'audience', 'scenario', 'length', 'requiredPoints']) }, instruction: '更新本次材料与写作要求' });
    const patch = [];
    if (args.source) {
      patch.push({ path: ['source'], value: normalized.source });
      if (hash(normalized.source) !== hash(project.source || {})) patch.push({ path: ['sourceChanged'], value: true }, { path: ['review'], value: null }, { path: ['facts'], value: (project.facts || []).map(fact => ({ ...fact, confirmed: false, status: 'pending' })) });
    }
    if (args.brief) patch.push({ path: ['writing', 'brief'], value: normalized.writingBrief });
    return commit(ctx, state, patch, '已更新文案材料和写作要求');
  }));
  if (artifacts) tools.push(tool('writing_export', '把当前已保存文稿真实导出为Word(docx)、Markdown(md)、纯文本(txt)，海报渠道还可导出完整PNG图片。返回实际本机下载链接，不会发布或自动写入桌面。先读项目核对当前稿件；不把源材料、密钥或旧版本混入。', schema({ format: { type: 'string', enum: ['docx', 'md', 'txt', 'png'] }, channel: { type: 'string', enum: channels } }, ['format']), true, async (args, ctx, state) => {
    const project = await current(ctx, state, 'writing'), channel = args.channel || project.writing?.draft?.channel || project.writing?.brief?.channel;
    if (!channels.includes(channel)) throw fail(400, '请先选择已有稿件渠道。');
    const output = project.writing?.draft?.channel === channel ? project.writing.draft.output : project.outputs?.[channel];
    if (!output || typeof output !== 'object') throw fail(400, '当前渠道没有已保存稿件。', 'ASSISTANT_WRITING_DRAFT_REQUIRED');
    const body = outputText(channel, output), title = output.title || project.title || '当前稿件';
    if (!['docx', 'md', 'txt', 'png'].includes(args.format)) throw fail(400, '导出格式无效。');
    if (args.format === 'png' && channel !== 'poster') throw fail(400, 'PNG导出用于海报稿件，请选择Word、Markdown或TXT导出当前渠道。', 'ASSISTANT_WRITING_PNG_CHANNEL');
    ctx.update('正在生成' + args.format.toUpperCase() + '文件');
    const buffer = args.format === 'png' ? await renderAssistantPoster(output, { root, signal: ctx.signal }) : args.format === 'docx' ? createDocx({ title, sections: [{ heading: '', content: body.startsWith(title) ? body.slice(title.length).trimStart() : body }] }) : Buffer.from(body + '\n', 'utf8');
    await current(ctx, state, 'writing'); check(ctx);
    const contentType = ({ docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', md: 'text/markdown; charset=utf-8', txt: 'text/plain; charset=utf-8', png: 'image/png' })[args.format];
    const file = await artifacts.create({ projectId: project.id, name: filename(title) + (args.format === 'png' ? '-海报' : '') + '.' + args.format, contentType, buffer }, { signal: ctx.signal });
    return { summary: '已生成可下载的' + args.format.toUpperCase() + '稿件。', data: { file }, effects: [artifactEffect(project.id, file)] };
  }));
  if (scienceDocuments) {
    tools.push(tool('knowledge_selection_clear', '按当前工程要求清空本次生成所选资料页段，保留已经导入的原文件与旧作品；旧作品标记材料变化，可撤销。需要移除正在选用的资料时先执行此步。', schema(), true, async (_args, ctx, state) => {
      const project = await current(ctx, state, 'science');
      return commit(ctx, state, [{ path: ['science', 'documentSelection'], remove: true }, { path: ['science', 'novelStale'], value: Boolean(project.science?.novel) }], '已清空本次科普资料选择');
    }));
    tools.push(tool('knowledge_document_remove', '按用户要求移除当前科普项目一份已导入资料及其原文件；先document_read取得documentId/sourceHash。正在选用时先knowledge_selection_clear；已生成作品内的依据快照保留。真实删除不可撤销，原下载区文件不受影响。', schema({ documentId: text(128), expectedSourceHash: text(64) }, ['documentId', 'expectedSourceHash']), true, async (args, ctx, state) => {
      const project = await current(ctx, state, 'science'), document = await scienceDocuments.get(project.id, args.documentId, { signal: ctx.signal });
      if (document.sourceHash !== args.expectedSourceHash) throw fail(409, '原资料已变化，请重新读取。', 'SCIENCE_DOCUMENT_CHANGED');
      if (project.science?.documentSelection?.documentId === document.id) throw fail(409, '请先清空或更换本次资料选择，再移除该原文件。', 'ASSISTANT_DOCUMENT_IN_USE');
      await current(ctx, state, 'science'); check(ctx);
      const result = await scienceDocuments.remove(project.id, document.id);
      return { summary: '已移除当前项目资料原文件；已有互动作品内的依据快照仍保留，此删除没有撤销记录。', data: result, effects: [{ type: 'document', projectId: project.id, label: '已移除资料：' + document.title, changed: true }] };
    }));
    tools.push(tool('knowledge_import_text', '把用户提供的真实论文/教材文字导入当前科普项目并解析页段；不自动选择材料、不修改作品；重复资料复用原件。', schema({ title: text(300), text: text(2000000) }, ['title', 'text']), true, async (args, ctx, state) => {
      const project = await current(ctx, state, 'science'); check(ctx);
      const result = await scienceDocuments.importText(project.id, { title: args.title, text: args.text }, { signal: ctx.signal });
      const undo = result.duplicate ? undefined : rememberUndo({ kind: 'document', projectId: project.id, documentId: result.document.id, sourceHash: result.document.sourceHash, createdAt: project.createdAt, runId: ctx.runId });
      return { summary: result.duplicate ? '当前资料已经导入。' : '已导入并解析科普资料页段。', data: { document: result.document, duplicate: result.duplicate }, effects: result.duplicate ? [] : [{ type: 'document', projectId: project.id, label: '已导入文字资料', changed: true, undo }] };
    }));
    tools.push(tool('knowledge_context', '验证并读取当前或指定的已导入页段作为讲解依据。包含原文、真实unitId和hash；超量明确失败，不截断后假称全读。', schema({ selection: selectionSchema }), false, async (args, ctx) => {
      const project = await owner(ctx, 'science'); return { summary: '已读取所选科普依据。', data: await scienceDocuments.context(project.id, args.selection || project.science?.documentSelection, { signal: ctx.signal, maxCharacters: 60000 }) };
    }));
    tools.push(tool('knowledge_select', '按用户明确要求选择当前科普项目的一份文档和实际页段。先document_read取得ID。仅给定unitIds作为生成依据，更换后标记旧作品材料已变化，可撤销。', selectionSchema, true, async (args, ctx, state) => {
      const project = await current(ctx, state, 'science');
      const value = await scienceDocuments.context(project.id, pick(args, ['documentId', 'unitIds']), { signal: ctx.signal, maxCharacters: 60000 });
      return commit(ctx, state, [{ path: ['science', 'documentSelection'], value: { documentId: value.documentId, unitIds: value.selection.unitIds } }, { path: ['science', 'novelStale'], value: Boolean(project.science?.novel) }], '已选择科普资料页段');
    }));
  }
  if (novelLibrary) {
    if (downloads) tools.push(tool('library_asset_import', '仅按用户明确公用素材库要求，把当前项目下载区中已保存的图片导入公用库，作为人物立绘portrait或场景background。读取实际字节解码校验，不读取任意本机路径；导入后不自动改任何项目或人物的选择。', schema({ downloadId: text(36), kind: { type: 'string', enum: ['portrait', 'background'] }, name: text(160), expectedRevision: text(64) }, ['downloadId', 'kind', 'name', 'expectedRevision']), true, async (args, ctx, state) => {
      const project = await current(ctx, state);
      if (!publicLibraryIntent(ctx.instruction)) throw fail(403, '本轮没有明确要求修改公用素材库。', 'ASSISTANT_LIBRARY_SCOPE');
      const file = await downloads.read(args.downloadId, { projectId: project.id }); check(ctx);
      const result = await novelLibrary.importBytes(file.buffer, { kind: args.kind, name: args.name, expectedRevision: args.expectedRevision, signal: ctx.signal });
      const undo = rememberUndo({ kind: 'library-asset', projectId: project.id, createdAt: project.createdAt, assetId: result.asset.id, expectedSha256: result.asset.sha256, runId: ctx.runId });
      return { summary: '已把真实图片导入公用素材库，尚未绑定人物或场景。', data: result, effects: [{ type: 'library', projectId: project.id, label: '已导入公用图片', changed: true, undo }] };
    }));
    tools.push(tool('library_asset_remove', '仅当用户本轮明确点名删除公用库中的图片时使用；先library_profile_read查看id/name/sha256/revision。删除实际图片文件，仍被人物或场景引用时拒绝；成功后不能撤销，原下载文件不受影响。', schema({ assetId: text(64), expectedSha256: text(64), expectedRevision: text(64) }, ['assetId', 'expectedSha256', 'expectedRevision']), true, async (args, ctx, state) => {
      const project = await current(ctx, state), library = await novelLibrary.list(), asset = library.assets.find(item => item.id === args.assetId);
      if (!asset) throw fail(404, '公用图片不存在。', 'NOVEL_LIBRARY_NOT_FOUND');
      if (!publicLibraryIntent(ctx.instruction) || !/(?:删除|移除|删掉|delete|remove)/i.test(ctx.instruction) || ![asset.name, asset.id].some(name => name && ctx.instruction.includes(name))) throw fail(403, '删除公用图片需要用户本轮明确点名该图片。', 'ASSISTANT_LIBRARY_DELETE_SCOPE');
      const result = await novelLibrary.removeAsset(args.assetId, { expectedRevision: args.expectedRevision, expectedSha256: args.expectedSha256 });
      return { summary: '已移除用户点名的公用图片；此操作没有撤销记录。', data: result, effects: [{ type: 'library', projectId: project.id, label: '已移除公用图片', changed: true }] };
    }));
    if (artifacts) tools.push(tool('novel_export', '把当前已生成互动作品连同真实所选公用图片导出为离线HTML阅读器或完整JSON；HTML阅读器可离线答题和回查材料，返回真实文件下载链接。先读取当前作品核对，不上传外站。', schema({ format: { type: 'string', enum: ['html', 'json'] } }, ['format']), true, async (args, ctx, state) => {
      const project = await current(ctx, state, 'science');
      if (!project.science?.novel) throw fail(404, '当前项目尚无已生成作品。', 'ASSISTANT_NOVEL_REQUIRED');
      const result = await exportAssistantNovel(project, { novelLibrary, format: args.format, root, signal: ctx.signal });
      await current(ctx, state, 'science'); check(ctx);
      const file = await artifacts.create({ projectId: project.id, name: filename(result.title) + result.extension, contentType: result.contentType, buffer: result.buffer }, { signal: ctx.signal });
      return { summary: '已生成包含真实图片的离线互动作品。', data: { file }, effects: [artifactEffect(project.id, file, 'novel')] };
    }));
    tools.push(tool('library_profile_read', '读取公用素材库的人物、表情和场景资料及已上传图片ID、实际revision。可指定kind/id读取单项；公用库被所有科普项目共同引用。', schema({ kind: { type: 'string', enum: ['character', 'background'] }, id: text(64) }), false, async (args, ctx) => {
      await owner(ctx); const library = await novelLibrary.list();
      if (!args.id) return { summary: '已读取公用素材库及版本。', data: library };
      if (!['character', 'background'].includes(args.kind)) throw fail(400, '读取单项时请选择人物或场景。');
      const profile = library[args.kind === 'character' ? 'characters' : 'backgrounds'].find(item => item.id === args.id);
      if (!profile) throw fail(404, '公用素材条目不存在。', 'NOVEL_LIBRARY_NOT_FOUND');
      return { summary: '已读取公用素材条目。', data: { revision: library.revision, kind: args.kind, profile, assets: library.assets } };
    }));
    tools.push(tool('library_profile_manage', '仅在用户明确要求修改公用/公共素材库时使用：创建、更新或移除公用人物/场景资料（影响全部引用该条目的项目），不自动改当前项目选择。普通“改这段语气”应改作品文字。先library_profile_read取revision和真实id；create/update可绑定库中已有图片assetId和表情，不读任意本机路径。remove要求用户本轮明确删除并点名条目，禁止删除仍被使用的条目。原子版本检查、可撤销。', schema({ action: { type: 'string', enum: ['create', 'update', 'remove'] }, kind: { type: 'string', enum: ['character', 'background'] }, expectedRevision: text(64), id: text(64), profile: schema({ name: text(60), role: optional(1200), tone: optional(600), personality: optional(600), color: text(7), portraits: { type: 'array', maxItems: 12, items: schema({ id: text(64), name: text(40), assetId: optional(64) }, ['name']) }, assetId: optional(64), fit: { type: 'string', enum: ['cover', 'contain'] } }) }, ['action', 'kind', 'expectedRevision']), true, async (args, ctx, state) => {
      const project = await current(ctx, state);
      if (!publicLibraryIntent(ctx.instruction)) throw fail(403, '本轮没有明确要求修改公用素材库；当前作品文字请使用作品编辑工具。', 'ASSISTANT_LIBRARY_SCOPE');
      if (!['character', 'background'].includes(args.kind) || !['create', 'update', 'remove'].includes(args.action)) throw fail(400, '公用素材操作无效。');
      const library = await novelLibrary.list(), plural = args.kind === 'character' ? 'characters' : 'backgrounds';
      if (library.revision !== args.expectedRevision) throw fail(409, '公用素材库已变化，请重新读取。', 'NOVEL_LIBRARY_REVISION_CONFLICT');
      const previous = library[plural].find(item => item.id === args.id), before = { characters: library.characters.map(({ ready, ...profile }) => profile), backgrounds: library.backgrounds.map(({ ready, ...profile }) => profile) };
      const options = { expectedRevision: args.expectedRevision, requireExisting: args.action === 'update' };
      let after;
      try {
        if (args.action === 'remove') {
          if (!previous) throw fail(404, '公用素材条目不存在。', 'NOVEL_LIBRARY_NOT_FOUND');
          if (!/(?:删除|移除|删掉|delete|remove)/i.test(ctx.instruction) || ![previous.name, previous.id].some(name => name && ctx.instruction.includes(name))) throw fail(403, '移除公用素材需要用户本轮明确点名要删除的条目。', 'ASSISTANT_LIBRARY_DELETE_SCOPE');
          after = await novelLibrary[args.kind === 'character' ? 'removeCharacter' : 'removeBackground'](args.id, options);
        } else {
          requireObject(args.profile, '公用素材资料');
          if (args.action === 'update' && !previous) throw fail(404, '公用素材条目不存在。', 'NOVEL_LIBRARY_NOT_FOUND');
          const allowed = args.kind === 'character' ? ['name', 'role', 'tone', 'personality', 'color', 'portraits'] : ['name', 'assetId', 'fit'];
          const profile = { ...(args.action === 'update' ? pick(previous, ['id', ...allowed]) : {}), ...pick(args.profile, allowed), ...(args.action === 'update' ? { id: args.id } : {}) };
          after = await novelLibrary[args.kind === 'character' ? 'saveCharacter' : 'saveBackground'](profile, options);
        }
      } catch (error) { if (error.status === 409) state.conflicted = true; throw error; }
      const undo = rememberUndo({ kind: 'library', projectId: project.id, createdAt: project.createdAt, expectedRevision: after.revision, before, runId: ctx.runId });
      return { summary: '已更新公用素材库，引用该条目的项目会使用最新资料；当前项目选择未改变。', data: after, effects: [{ type: 'library', projectId: project.id, label: '已更新公用素材库', changed: true, undo }] };
    }));
    tools.push(tool('knowledge_configure', '按明确要求选择公用库中已有的人物/场景，设置互动密度与补充要求；不自动创建或猜选人物场景，不立即重新生成作品。未提供字段保留，旧作品保留并标记设置变化，可撤销。', schema({ characterId: text(64), backgroundId: text(64), interactionDensity: { type: 'string', enum: ['sparse', 'balanced', 'dense'] }, instruction: optional(3000) }), true, async (args, ctx, state) => {
      const project = await current(ctx, state, 'science'), library = await novelLibrary.list(), previous = project.science?.novelConfig || {};
      if (!Object.keys(args).some(key => ['characterId', 'backgroundId', 'interactionDensity', 'instruction'].includes(key))) throw fail(400, '请选择要更新的科普设置。');
      const config = { ...previous, style: 'single-guide', sceneCount: 1, chapterCount: 1 };
      for (const [field, kind, selected] of [['characterId', 'characters', 'selectedCharacterId'], ['backgroundId', 'backgrounds', 'selectedBackgroundId']]) if (Object.hasOwn(args, field)) {
        if (!library[kind].some(item => item.id === args[field])) throw fail(404, '所选公用人物或场景不存在。', 'NOVEL_LIBRARY_NOT_FOUND');
        config[selected] = args[field];
      }
      const characterId = config.selectedCharacterId || config.librarySelection?.characterId, backgroundId = config.selectedBackgroundId || config.librarySelection?.backgroundId;
      config.librarySelection = { ...(characterId ? { characterId } : {}), ...(backgroundId ? { backgroundId } : {}) };
      if (Object.hasOwn(args, 'interactionDensity')) { if (!['sparse', 'balanced', 'dense'].includes(args.interactionDensity)) throw fail(400, '互动密度无效。'); config.interactionDensity = args.interactionDensity; }
      if (Object.hasOwn(args, 'instruction')) config.instruction = boundedString(args.instruction, '补充说明', 3000, { optional: true });
      return commit(ctx, state, [{ path: ['science', 'novelConfig'], value: config }, { path: ['science', 'novelSettingsChanged'], value: Boolean(project.science?.novel) }], '已更新科普人物、场景与互动设置');
    }));
    tools.push(tool('novel_read', '读取当前已生成互动作品的真实文字和引用。按lines offset/limit分页，返回每句原始index供准确修改；未返回的句子不能假称已阅读。', schema({ offset: { type: 'integer', minimum: 0, maximum: 180 }, limit: { type: 'integer', minimum: 1, maximum: 40 } }), false, async (args, ctx) => {
      const project = await owner(ctx, 'science'), novel = project.science?.novel;
      if (!novel) throw fail(404, '当前项目尚无已生成作品。', 'ASSISTANT_NOVEL_REQUIRED');
      const scene = novel.scenes?.[0], offset = args.offset || 0, limit = args.limit || 20, lines = []; let size = 0;
      for (let index = offset; index < Math.min(offset + limit, scene?.lines?.length || 0); index++) { const line = scene.lines[index], length = JSON.stringify(line).length; if (lines.length && size + length > 30000) break; lines.push({ index, ...line }); size += length; }
      return { summary: '已读取当前作品及本页对话。', data: { ...pick(novel, ['id', 'title', 'logline', 'learningGoals', 'chapters', 'librarySelection', 'settings', 'sourceHash']), scene: scene ? { ...pick(scene, ['id', 'title', 'chapterId', 'backgroundId', 'actors']), index: 0, lines } : null, totalLines: scene?.lines?.length || 0, nextOffset: offset + lines.length, truncated: offset > 0 || offset + lines.length < (scene?.lines?.length || 0) } };
    }));
    tools.push(tool('novel_text_update', '精确修改已生成互动作品已有文字（标题/简介/目标/章节场景标题/对话/卡片/题干/选项文字与反馈）。先novel_read取得index和expectedText；保留资料引用、人物图片、正确答案和结构，完整校验后原子保存，可撤销。path示例["scenes",0,"lines",1,"text"]。', schema({ edits: { type: 'array', minItems: 1, maxItems: 40, items: schema({ path: { type: 'array', minItems: 1, maxItems: 10, items: { anyOf: [text(64), { type: 'integer', minimum: 0, maximum: 180 }] } }, expectedText: optional(12000), value: optional(12000) }, ['path', 'expectedText', 'value']) } }, ['edits']), true, async (args, ctx, state) => {
      const project = await current(ctx, state, 'science'), original = project.science?.novel;
      if (!original) throw fail(404, '当前项目尚无已生成作品。', 'ASSISTANT_NOVEL_REQUIRED');
      if (!Array.isArray(args.edits) || !args.edits.length || args.edits.length > 40) throw fail(400, '请提供1至40处明确文字修改。');
      const value = structuredClone(original), used = new Set();
      for (const edit of args.edits) {
        const leaf = stringLeaf(value, edit.path), key = edit.path.join('.');
        if (used.has(key)) throw fail(400, '同一段文字不能在一批内重复修改。'); used.add(key);
        if (leaf.value !== edit.expectedText) throw fail(409, '作品文字已经变化，请重新读取后修改。', 'ASSISTANT_CONFLICT');
        leaf.parent[leaf.field] = boundedString(edit.value, '作品文字', 12000, { optional: true });
      }
      const resources = await novelLibrary.resolveSelection(original.librarySelection, { signal: ctx.signal });
      let validated;
      try { validated = serializePlayableNovel(value, resources); } catch (error) { throw fail(400, error.message, error.code || 'ASSISTANT_NOVEL_INVALID'); }
      return commit(ctx, state, [{ path: ['science', 'novel'], value: validated }], '已精确更新互动作品文字');
    }));
  }
  return tools;
}
