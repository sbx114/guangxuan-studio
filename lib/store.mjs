import { mkdir, readFile, readdir, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AppError, requireObject } from './errors.mjs';
import { createProjectCovers, validCoverAssetId, projectCoverUrl } from './project-covers.mjs';
import { renameWithRetry } from './atomic-file.mjs';
import { normalizeEditScope } from './edit-scope.mjs';

const SECRET_KEYS = /^(?:apikey|api_key|authorization|access_?token|refresh_?token|password|secret|client_?secret|credentials)$/i;
export function withoutSecrets(value, depth = 0, sensitiveStrings = []) {
  if (depth > 50) throw new AppError(400, '项目内容层级过深。', 'INVALID_PROJECT');
  if (typeof value === 'string') {
    let sanitized = value;
    for (const secret of sensitiveStrings) if (secret) sanitized = sanitized.split(secret).join('[密钥已隐藏]');
    return sanitized;
  }
  if (Array.isArray(value)) return value.map(item => withoutSecrets(item, depth + 1, sensitiveStrings));
  if (!value || typeof value !== 'object') return value;
  const clean = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEYS.test(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) continue;
    clean[key] = withoutSecrets(item, depth + 1, sensitiveStrings);
  }
  return clean;
}

export function validateProjectId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) throw new AppError(400, '项目编号不正确。', 'INVALID_PROJECT_ID');
  return id;
}

const OUTPUT_CHANNELS = ['article', 'poster', 'video', 'social'];
const PROJECT_COVERS = new Set(['classic', 'blueprint', 'film', 'paper', 'custom']);
const normalizedCover = value => PROJECT_COVERS.has(value) ? value : 'classic';
function metadataRevision(project) {
  return Number.isSafeInteger(project?.metadataRevision) && project.metadataRevision >= 0 ? project.metadataRevision : 0;
}
function assistantRevision(project) {
  return Number.isSafeInteger(project?.assistantRevision) && project.assistantRevision >= 0 ? project.assistantRevision : 0;
}
function writingRevision(project) {
  return Number.isSafeInteger(project?.writingRevision) && project.writingRevision >= 0 ? project.writingRevision : 0;
}

const ASSISTANT_HASH_TOP_TRANSIENT = new Set(['updatedAt', 'metadataRevision', 'assistantRevision', 'writingRevision']);
const ASSISTANT_HASH_VIDEO_TRANSIENT = new Set(['assistantMessages', 'assistantDraft', 'assistantJob', 'assistantMode', 'sourceSyncRevision', 'lastExportJob', 'lastAnimationJob']);

export function assistantContentHash(project) {
  requireObject(project, '项目');
  const ancestors = new Set();
  function stable(value, parts = []) {
    if (parts.length > 50) throw new AppError(400, '项目内容层级过深。', 'INVALID_PROJECT');
    if (!value || typeof value !== 'object') return value;
    if (ancestors.has(value)) throw new AppError(400, '项目不能包含循环引用。', 'INVALID_PROJECT');
    ancestors.add(value);
    let result;
    if (Array.isArray(value)) result = value.map((item, index) => stable(item, [...parts, String(index)]));
    else {
      result = Object.create(null);
      for (const key of Object.keys(value).sort()) {
        if ((!parts.length && ASSISTANT_HASH_TOP_TRANSIENT.has(key)) || (parts.length === 1 && parts[0] === 'video' && ASSISTANT_HASH_VIDEO_TRANSIENT.has(key))) continue;
        result[key] = stable(value[key], [...parts, key]);
      }
    }
    ancestors.delete(value);
    return result;
  }
  try { return createHash('sha256').update(JSON.stringify(stable(project))).digest('hex'); }
  catch (error) { if (error instanceof AppError) throw error; throw new AppError(400, '项目内容不能转换为有效 JSON。', 'INVALID_PROJECT'); }
}

const ASSISTANT_PATCH_PATHS = new Set([
  'title', 'description', 'source', 'sourceChanged', 'facts', 'review', 'sourceProjectId',
  ...['article', 'poster', 'video', 'social'].map(key => `outputs.${key}`),
  ...['script', 'openfilmDraftCaptions', 'sourceStoryboard', 'editScope'].map(key => `video.${key}`),
  ...['draft', 'brief', 'previousDraft', 'references'].map(key => `writing.${key}`),
  ...['novel', 'novelConfig', 'documentSelection', 'novelStale', 'novelSettingsChanged'].map(key => `science.${key}`),
]);
function validateAssistantPatch(input, secrets) {
  if (!Array.isArray(input) || !input.length || input.length > 24) throw new AppError(400, '助手修改需要1到24个明确字段。', 'INVALID_ASSISTANT_PATCH');
  const seen = new Set();
  return input.map(entry => {
    requireObject(entry, '助手修改');
    if (Object.keys(entry).some(key => !['path', 'value', 'remove'].includes(key)) || !Array.isArray(entry.path) || !entry.path.every(part => typeof part === 'string') || !ASSISTANT_PATCH_PATHS.has(entry.path.join('.')) || entry.path.some(part => part.includes('.'))) throw new AppError(400, '助手修改包含不允许的字段路径。', 'INVALID_ASSISTANT_PATCH');
    const key = entry.path.join('.');
    if (seen.has(key)) throw new AppError(400, '助手修改包含重复字段。', 'INVALID_ASSISTANT_PATCH');
    seen.add(key);
    if (entry.remove === true) {
      if (Object.hasOwn(entry, 'value')) throw new AppError(400, '删除字段时不能同时设置值。', 'INVALID_ASSISTANT_PATCH');
      return { path: [...entry.path], remove: true };
    }
    if ((Object.hasOwn(entry, 'remove') && entry.remove !== false) || !Object.hasOwn(entry, 'value') || entry.value === undefined) throw new AppError(400, '助手修改缺少有效的字段值。', 'INVALID_ASSISTANT_PATCH');
    let serialized;
    try { serialized = JSON.stringify(entry.value, (childKey, value) => {
      if (SECRET_KEYS.test(childKey) || ['__proto__', 'prototype', 'constructor'].includes(childKey) || typeof value === 'function' || typeof value === 'symbol' || value === undefined || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('invalid value');
      return value;
    }); } catch { throw new AppError(400, '助手字段包含凭据、不安全字段或无效 JSON。', 'INVALID_ASSISTANT_PATCH'); }
    if (!serialized || Buffer.byteLength(serialized) > 3 * 1024 * 1024) throw new AppError(400, '助手修改内容过大。', 'PROJECT_TOO_LARGE');
    let value = withoutSecrets(JSON.parse(serialized), 0, secrets);
    const objectOrNull = value === null || (typeof value === 'object' && !Array.isArray(value));
    if (key === 'title' || key === 'description') value = validateMetadataPatch({ [key]: value })[key];
    else if (key === 'sourceProjectId') {
      value = value === null ? null : validateProjectId(value);
    } else if (key === 'sourceChanged') {
      if (typeof value !== 'boolean') throw new AppError(400, '材料变更状态需要布尔值。', 'INVALID_ASSISTANT_PATCH');
    } else if (key === 'facts') {
      if (!Array.isArray(value) || value.length > 60 || value.some(fact => !fact || typeof fact !== 'object' || Array.isArray(fact))) throw new AppError(400, '事实卡需要至多60项有效对象。', 'INVALID_ASSISTANT_PATCH');
      const maximums = { id: 100, label: 300, value: 6000, quote: 10000, status: 30 };
      for (const fact of value) {
        for (const [field, maximum] of Object.entries(maximums)) if (Object.hasOwn(fact, field) && (typeof fact[field] !== 'string' || fact[field].length > maximum)) throw new AppError(400, '事实卡文字格式无效。', 'INVALID_ASSISTANT_PATCH');
        for (const field of ['confirmed', 'quoteMatched']) if (Object.hasOwn(fact, field) && typeof fact[field] !== 'boolean') throw new AppError(400, '事实卡确认状态需要布尔值。', 'INVALID_ASSISTANT_PATCH');
      }
    } else if (key === 'review') {
      if (!objectOrNull) throw new AppError(400, '审核状态需要对象或空值。', 'INVALID_ASSISTANT_PATCH');
    } else if (key === 'video.script') {
      if (typeof value !== 'string' || value.length > 30000) throw new AppError(400, '旁白草稿最多30000字。', 'INVALID_ASSISTANT_PATCH');
    } else if (key.startsWith('writing.')) {
      if (!objectOrNull) throw new AppError(400, '写作状态格式不正确。', 'INVALID_ASSISTANT_PATCH');
    } else if (key === 'video.editScope') {
      value = normalizeEditScope(value);
    } else if (key === 'video.openfilmDraftCaptions' || key === 'video.sourceStoryboard') {
      if (!Array.isArray(value) || value.length > (key === 'video.openfilmDraftCaptions' ? 2000 : 200)) throw new AppError(400, '视频草稿列表格式或数量不正确。', 'INVALID_ASSISTANT_PATCH');
    } else if (key === 'science.novelStale' || key === 'science.novelSettingsChanged') {
      if (typeof value !== 'boolean') throw new AppError(400, '科普状态需要布尔值。', 'INVALID_ASSISTANT_PATCH');
    } else if (!objectOrNull) throw new AppError(400, '助手字段需要对象或空值。', 'INVALID_ASSISTANT_PATCH');
    if (key === 'source' && value !== null) {
      for (const field of ['title', 'text', 'url']) if (Object.hasOwn(value, field) && (typeof value[field] !== 'string' || value[field].length > ({ title: 300, text: 60000, url: 2000 })[field])) throw new AppError(400, '素材标题、正文或链接格式不正确。', 'INVALID_ASSISTANT_PATCH');
    }
    return { path: [...entry.path], value };
  });
}
function validateAssistantParents(input, patch) {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 24) throw new AppError(400, '撤销父字段格式不正确。', 'INVALID_ASSISTANT_PATCH');
  const parents = new Map();
  for (const entry of input) {
    requireObject(entry, '撤销父字段');
    if (Object.keys(entry).some(key => !['path', 'exists', 'value'].includes(key)) || !Array.isArray(entry.path) || entry.path.length !== 1 || !['outputs', 'science', 'video', 'writing'].includes(entry.path[0]) || !patch.some(item => item.path.length === 2 && item.path[0] === entry.path[0]) || (entry.exists !== true && entry.exists !== false) || (entry.exists ? entry.value !== null : Object.hasOwn(entry, 'value'))) throw new AppError(400, '仅能恢复本次撤销涉及的空父字段。', 'INVALID_ASSISTANT_PATCH');
    const clean = { path: [...entry.path], exists: entry.exists, ...(entry.exists ? { value: null } : {}) };
    if (parents.has(entry.path[0]) && JSON.stringify(parents.get(entry.path[0])) !== JSON.stringify(clean)) throw new AppError(400, '撤销父字段含重复冲突。', 'INVALID_ASSISTANT_PATCH');
    parents.set(entry.path[0], clean);
  }
  return [...parents.values()];
}

export function summarizeProject(project) {
  const video = project.video && typeof project.video === 'object' ? project.video : project.videoProject || {};
  const clips = (Array.isArray(video.timeline) ? video.timeline : []).filter(clip => Number.isFinite(Number(clip?.start)) && Number.isFinite(Number(clip?.end)) && Number(clip.end) > Number(clip.start));
  const outputs = project.outputs && typeof project.outputs === 'object' ? project.outputs : {};
  const novel = project.kind === 'science' && Array.isArray(project.science?.novel?.scenes) && project.science.novel.scenes.length ? project.science.novel : null;
  const outputCount = OUTPUT_CHANNELS.filter(channel => outputs[channel] && typeof outputs[channel] === 'object').length + (video.lastExportJob?.status === 'complete' ? 1 : 0) + (novel ? 1 : 0);
  // Count visible output text, never the source, prompts, versions or credentials.
  const strings = [];
  const add = value => { if (typeof value === 'string') strings.push(value); };
  const array = value => Array.isArray(value) ? value : [];
  for (const key of ['title', 'lead', 'body']) add(outputs.article?.[key]);
  for (const key of ['eyebrow', 'title', 'subtitle', 'footer']) add(outputs.poster?.[key]);
  for (const item of array(outputs.poster?.highlights)) add(item);
  for (const item of array(outputs.poster?.details)) { add(item?.label); add(item?.value); }
  add(outputs.video?.title);
  for (const shot of array(outputs.video?.shots)) { add(shot?.visual); add(shot?.narration); add(shot?.caption); }
  add(outputs.social?.title); add(outputs.social?.text);
  if (novel) {
    add(novel.title); add(novel.logline);
    for (const goal of array(novel.learningGoals)) add(goal);
    for (const character of array(novel.characters)) add(character?.name);
    for (const chapter of array(novel.chapters)) add(chapter?.title);
    for (const scene of novel.scenes) {
      add(scene?.title);
      for (const line of array(scene?.lines)) {
        add(line?.text); add(line?.card?.title); add(line?.card?.text);
        add(line?.question?.prompt);
        for (const choice of array(line?.question?.choices)) { add(choice?.text); add(choice?.feedback); }
      }
      add(scene?.card?.title); add(scene?.card?.text);
      for (const choice of array(scene?.choices)) { add(choice?.text); add(choice?.feedback); }
    }
  }
  return {
    id: project.id,
    title: typeof project.title === 'string' ? project.title.slice(0, 120) : typeof project.name === 'string' ? project.name.slice(0, 120) : '未命名项目',
    kind: ['video', 'writing', 'science'].includes(project.kind) ? project.kind : project.video || project.videoProject ? 'video' : 'writing',
    description: typeof project.description === 'string' ? project.description.slice(0, 1000) : '',
    cover: normalizedCover(project.cover),
    coverAssetId: validCoverAssetId(project.coverAssetId) ? project.coverAssetId : '',
    coverUrl: projectCoverUrl(project.coverAssetId),
    createdAt: typeof project.createdAt === 'string' ? project.createdAt : '',
    updatedAt: typeof project.updatedAt === 'string' ? project.updatedAt : '',
    duration: Math.round(clips.reduce((total, clip) => total + Number(clip.end) - Number(clip.start), 0) * 1000) / 1000,
    clipCount: clips.length,
    wordCount: Array.from(strings.join('').replace(/\s/gu, '')).length,
    outputCount,
  };
}

function validateMetadataPatch(input) {
  requireObject(input, '项目资料');
  const keys = Object.keys(input);
  if (!keys.length || keys.some(key => !['title', 'description', 'cover', 'coverAssetId'].includes(key))) throw new AppError(400, '仅支持修改项目标题、简介和封面。', 'INVALID_PROJECT_METADATA');
  const patch = {};
  if (Object.hasOwn(input, 'title')) {
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.trim().length > 120) throw new AppError(400, '项目标题不能为空且不能超过120字。', 'INVALID_PROJECT_TITLE');
    patch.title = input.title.trim();
  }
  if (Object.hasOwn(input, 'description')) {
    if (typeof input.description !== 'string' || input.description.length > 1000) throw new AppError(400, '项目简介不能超过1000字。', 'INVALID_PROJECT_DESCRIPTION');
    patch.description = input.description;
  }
  if (Object.hasOwn(input, 'cover')) {
    if (!PROJECT_COVERS.has(input.cover)) throw new AppError(400, '请选择可用的档案封面。', 'INVALID_PROJECT_COVER');
    patch.cover = input.cover;
  }
  if (Object.hasOwn(input, 'coverAssetId')) {
    if (input.coverAssetId !== '' && !validCoverAssetId(input.coverAssetId)) throw new AppError(400, '封面编号不正确。', 'INVALID_COVER_ASSET');
    patch.coverAssetId = input.coverAssetId;
  }
  return patch;
}

export async function createProjectStore(dataDir, { sensitiveStrings = () => [] } = {}) {
  const directory = path.join(path.resolve(dataDir), 'projects');
  await mkdir(directory, { recursive: true });
  const covers = await createProjectCovers(dataDir);
  const queues = new Map();
  function serialized(id, operation) {
    const previous = queues.get(id) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    queues.set(id, current);
    current.finally(() => { if (queues.get(id) === current) queues.delete(id); }).catch(() => {});
    return current;
  }
  async function read(id) {
    validateProjectId(id);
    try { return withoutSecrets(JSON.parse(await readFile(path.join(directory, `${id}.json`), 'utf8')), 0, sensitiveStrings()); }
    catch (error) { if (error.code === 'ENOENT') return null; throw new AppError(500, '项目文件无法读取。原文件已保留。', 'PROJECT_READ_ERROR'); }
  }
  async function writeProject(id, project) {
    const serializedProject = JSON.stringify(project, null, 2);
    if (Buffer.byteLength(serializedProject) > 3 * 1024 * 1024) throw new AppError(400, '项目超过 3 MB，请精简历史记录或拆分项目。', 'PROJECT_TOO_LARGE');
    const temporary = path.join(directory, `.${id}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, serializedProject, { mode: 0o600, flag: 'wx' });
      await renameWithRetry(temporary, path.join(directory, `${id}.json`));
    } catch (error) {
      await unlink(temporary).catch(() => {});
      const failure = new AppError(500, '项目保存失败，请检查本地磁盘空间和目录权限。', 'PROJECT_WRITE_ERROR');
      Object.defineProperty(failure, 'cause', { value: error, configurable: true });
      throw failure;
    }
    return project;
  }
  async function list() {
    const entries = (await readdir(directory)).filter(filename => /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.json$/.test(filename));
    const projects = [];
    let unreadableCount = 0;
    for (const filename of entries) {
      try { const project = await read(filename.slice(0, -5)); if (project) projects.push(project); }
      catch { unreadableCount++; }
    }
    projects.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    return { projects, ...(unreadableCount ? { warning: `${unreadableCount} 个项目文件无法读取，原文件已保留。` } : {}) };
  }
  return {
    list,
    async summary() { const result = await list(); return { ...result, projects: result.projects.map(summarizeProject) }; },
    read,
    async save(id, input, { requireExisting = false } = {}) {
      validateProjectId(id);
      requireObject(input, '项目');
      if (input.id && input.id !== id) throw new AppError(400, '项目编号与保存路径不一致。', 'PROJECT_ID_MISMATCH');
      return serialized(id, async () => {
        const clean = withoutSecrets(input, 0, sensitiveStrings());
        const previous = await read(id);
        if (requireExisting && !previous) throw new AppError(404, '原项目已移除，本次编辑没有重新创建项目。', 'PROJECT_NOT_FOUND');
        const now = new Date().toISOString();
        const revision = metadataRevision(previous);
        const assistantVersion = assistantRevision(previous);
        if (previous && assistantVersion > 0 && clean.assistantRevision !== assistantVersion) throw new AppError(409, 'AI助手已更新项目，请刷新后再保存，避免覆盖新内容。', 'ASSISTANT_STALE_PROJECT');
        const project = { ...clean, id, cover: normalizedCover(clean.cover ?? previous?.cover), coverAssetId: validCoverAssetId(clean.coverAssetId ?? previous?.coverAssetId) ? clean.coverAssetId ?? previous.coverAssetId : '', createdAt: previous?.createdAt || clean.createdAt || now, updatedAt: now, metadataRevision: revision, assistantRevision: assistantVersion };
        if ((previous?.kind === 'writing' || clean.kind === 'writing') && (writingRevision(previous) > 0 || Object.hasOwn(clean, 'writingRevision'))) {
          const currentWriting = writingRevision(previous);
          if (!Number.isSafeInteger(clean.writingRevision) || clean.writingRevision < 0) throw new AppError(400, '文稿版本不正确，请重新打开项目。', 'INVALID_WRITING_REVISION');
          if (previous && clean.writingRevision !== currentWriting) throw new AppError(409, '这份文稿已有较新修改，你当前未保存的内容仍可保留。', 'WRITING_STALE_PROJECT');
          if (currentWriting >= Number.MAX_SAFE_INTEGER) throw new AppError(409, '文稿版本已达到上限，请另存项目。', 'WRITING_REVISION_LIMIT');
          project.writingRevision = currentWriting + 1;
        }
        // An autosave prepared before PATCH can still save its editing content,
        // but cannot replace the newer title, description or archive cover.
        if (previous && revision > 0 && metadataRevision(clean) !== revision) {
          if (Object.hasOwn(previous, 'title')) project.title = previous.title;
          if (Object.hasOwn(previous, 'description')) project.description = previous.description;
          project.cover = normalizedCover(previous.cover);
          project.coverAssetId = validCoverAssetId(previous.coverAssetId) ? previous.coverAssetId : '';
        }
        const sourceRevision = Number.isSafeInteger(previous?.video?.sourceSyncRevision) ? previous.video.sourceSyncRevision : 0;
        if (previous && sourceRevision > 0 && clean.video?.sourceSyncRevision !== sourceRevision) {
          project.video = { ...(project.video || {}) };
          for (const key of ['script', 'openfilmDraftCaptions', 'sourceStoryboard', 'sourceSyncRevision']) {
            if (Object.hasOwn(previous.video, key)) project.video[key] = structuredClone(previous.video[key]); else delete project.video[key];
          }
          if (previous.sourceProjectId) project.sourceProjectId = previous.sourceProjectId; else delete project.sourceProjectId;
        }
        if (project.cover === 'custom' && !project.coverAssetId) throw new AppError(400, '请先上传自定义封面。', 'COVER_REQUIRED');
        if (project.coverAssetId && (project.coverAssetId !== previous?.coverAssetId || (project.cover === 'custom' && previous?.cover !== 'custom'))) await covers.assertExists(project.coverAssetId);
        return writeProject(id, project);
      });
    },
    async updateAssistant(id, input) {
      validateProjectId(id);
      requireObject(input, '助手修改');
      return serialized(id, async () => {
        if (Object.keys(input).some(key => !['expectedHash', 'patch', 'restoreParents'].includes(key)) || typeof input.expectedHash !== 'string' || !/^[a-f0-9]{64}$/i.test(input.expectedHash)) throw new AppError(400, '助手修改需要有效的项目版本。', 'INVALID_ASSISTANT_PATCH');
        const previous = await read(id);
        if (!previous) throw new AppError(404, '项目不存在。', 'PROJECT_NOT_FOUND');
        if (assistantContentHash(previous) !== input.expectedHash.toLowerCase()) throw new AppError(409, '项目内容已变化，请重新读取后再修改。', 'ASSISTANT_CONFLICT');
        const patch = validateAssistantPatch(input.patch, sensitiveStrings());
        const restoreParents = validateAssistantParents(input.restoreParents, patch);
        const next = structuredClone(previous);
        const before = [];
        let metadataChanged = false, videoChanged = false;
        for (const entry of patch) {
          const [first, second] = entry.path;
          const previousParent = second ? previous[first] : previous;
          const key = second || first;
          const exists = !!previousParent && typeof previousParent === 'object' && Object.hasOwn(previousParent, key);
          const createsParent = !!second && !entry.remove && (!Object.hasOwn(previous, first) || previous[first] === null);
          before.push({ path: [...entry.path], exists, ...(exists ? { value: structuredClone(previousParent[key]) } : {}), ...(createsParent ? { parents: [{ path: [first], exists: Object.hasOwn(previous, first), ...(Object.hasOwn(previous, first) ? { value: null } : {}) }] } : {}) });
          if (second && (!next[first] || typeof next[first] !== 'object' || Array.isArray(next[first]))) {
            if (entry.remove) continue;
            if (next[first] !== undefined && next[first] !== null) throw new AppError(400, '助手修改的父字段格式不正确。', 'INVALID_ASSISTANT_PATCH');
            next[first] = {};
          }
          const parent = second ? next[first] : next;
          if (entry.remove) delete parent[key]; else parent[key] = structuredClone(entry.value);
          const changed = exists !== !entry.remove || (exists && !entry.remove && JSON.stringify(previousParent[key]) !== JSON.stringify(entry.value));
          if (changed && ['title', 'description'].includes(first)) metadataChanged = true;
          if (changed && first === 'video' && ['script', 'openfilmDraftCaptions', 'sourceStoryboard'].includes(second)) videoChanged = true;
        }
        const revision = assistantRevision(previous);
        if (revision >= Number.MAX_SAFE_INTEGER) throw new AppError(409, '助手项目版本已达到上限，请导出后导入为新项目。', 'ASSISTANT_REVISION_LIMIT');
        next.assistantRevision = revision + 1;
        if (previous.kind === 'writing' && writingRevision(previous) > 0) {
          if (writingRevision(previous) >= Number.MAX_SAFE_INTEGER) throw new AppError(409, '文稿版本已达到上限，请另存项目。', 'WRITING_REVISION_LIMIT');
          next.writingRevision = writingRevision(previous) + 1;
        }
        next.updatedAt = new Date().toISOString();
        if (metadataChanged) next.metadataRevision = metadataRevision(previous) + 1;
        if (videoChanged) {
          const oldRevision = Number.isSafeInteger(previous.video?.sourceSyncRevision) && previous.video.sourceSyncRevision >= 0 ? previous.video.sourceSyncRevision : 0;
          if (oldRevision >= Number.MAX_SAFE_INTEGER) throw new AppError(409, '视频草稿版本已达到上限。', 'ASSISTANT_REVISION_LIMIT');
          next.video.sourceSyncRevision = oldRevision + 1;
        }
        for (const parent of restoreParents) {
          const key = parent.path[0], value = next[key];
          if (value !== undefined && value !== null && (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(field => key !== 'video' || field !== 'sourceSyncRevision'))) throw new AppError(409, '撤销时父字段已有其他内容，已保留当前项目。', 'ASSISTANT_CONFLICT');
          if (parent.exists) next[key] = null; else delete next[key];
        }
        await writeProject(id, next);
        return { project: next, before, afterHash: assistantContentHash(next) };
      });
    },
    async updateVideoDraft(id, update, { expectedHash, expectedCreatedAt } = {}) {
      validateProjectId(id);
      if (typeof update !== 'function') throw new AppError(400, '视频草稿更新无效。', 'INVALID_VIDEO_DRAFT');
      return serialized(id, async () => {
        const previous = await read(id);
        if (!previous || previous.kind !== 'video') throw new AppError(404, '视频项目不存在。', 'PROJECT_NOT_FOUND');
        if (expectedHash !== undefined && expectedHash !== assistantContentHash(previous) || expectedCreatedAt !== undefined && expectedCreatedAt !== previous.createdAt) throw new AppError(409, '项目内容已变化，请重新读取后再修改草稿。', 'ASSISTANT_CONFLICT');
        const patch = withoutSecrets(await update(structuredClone(previous)), 0, sensitiveStrings());
        requireObject(patch, '视频草稿');
        if (Object.keys(patch).some(key => !['script', 'captions', 'storyboard', 'sourceProjectId'].includes(key))) throw new AppError(400, '视频草稿更新含不支持字段。', 'INVALID_VIDEO_DRAFT');
        if (patch.script !== undefined && (typeof patch.script !== 'string' || patch.script.length > 30000)) throw new AppError(400, '旁白草稿最多30000字。', 'INVALID_VIDEO_DRAFT');
        if (patch.captions !== undefined && (!Array.isArray(patch.captions) || patch.captions.length > 2000)) throw new AppError(400, '拟定字幕数量无效。', 'INVALID_VIDEO_DRAFT');
        if (patch.storyboard !== undefined && (!Array.isArray(patch.storyboard) || patch.storyboard.length > 200)) throw new AppError(400, '分镜草稿数量无效。', 'INVALID_VIDEO_DRAFT');
        const oldRevision = Number.isSafeInteger(previous.video?.sourceSyncRevision) && previous.video.sourceSyncRevision >= 0 && previous.video.sourceSyncRevision < Number.MAX_SAFE_INTEGER ? previous.video.sourceSyncRevision : 0;
        const video = { ...previous.video, sourceSyncRevision: oldRevision + 1 };
        if (patch.script !== undefined) video.script = patch.script;
        if (patch.captions !== undefined) video.openfilmDraftCaptions = patch.captions;
        if (patch.storyboard !== undefined) video.sourceStoryboard = patch.storyboard;
        const next = { ...previous, video, updatedAt: new Date().toISOString() };
        if (Object.hasOwn(patch, 'sourceProjectId')) { if (patch.sourceProjectId) next.sourceProjectId = validateProjectId(patch.sourceProjectId); else delete next.sourceProjectId; }
        return writeProject(id, next);
      });
    },
    async patchMetadata(id, input, { expectedHash, expectedCreatedAt, expectedMetadataRevision } = {}) {
      validateProjectId(id);
      const patch = validateMetadataPatch(input);
      return serialized(id, async () => {
        const previous = await read(id);
        if (!previous) throw new AppError(404, '项目不存在。', 'PROJECT_NOT_FOUND');
        if (expectedHash !== undefined && expectedHash !== assistantContentHash(previous) || expectedCreatedAt !== undefined && expectedCreatedAt !== previous.createdAt || expectedMetadataRevision !== undefined && (!Number.isSafeInteger(expectedMetadataRevision) || expectedMetadataRevision !== metadataRevision(previous))) throw new AppError(409, '项目资料已有更新，请读取最新版本后再修改。', 'PROJECT_METADATA_CONFLICT');
        const cleanPatch = withoutSecrets(patch, 0, sensitiveStrings());
        const nextCover = cleanPatch.cover ?? previous.cover;
        const nextAsset = cleanPatch.coverAssetId ?? previous.coverAssetId;
        if (nextCover === 'custom' && !validCoverAssetId(nextAsset)) throw new AppError(400, '请先上传自定义封面。', 'COVER_REQUIRED');
        if (nextAsset && (nextAsset !== previous.coverAssetId || (nextCover === 'custom' && previous.cover !== 'custom'))) await covers.assertExists(nextAsset);
        return writeProject(id, { ...previous, ...cleanPatch, metadataRevision: metadataRevision(previous) + 1, updatedAt: new Date().toISOString() });
      });
    },
    async remove(id) {
      validateProjectId(id);
      return serialized(id, async () => {
        try { await unlink(path.join(directory, `${id}.json`)); return true; }
        catch (error) { if (error.code === 'ENOENT') return false; throw new AppError(500, '项目删除失败，请重试。', 'PROJECT_DELETE_ERROR'); }
      });
    },
    async settle() { await Promise.allSettled([...queues.values()]); },
  };
}
