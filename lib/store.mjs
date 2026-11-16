import { mkdir, readFile, readdir, rename, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError, requireObject } from './errors.mjs';

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
function metadataRevision(project) {
  return Number.isSafeInteger(project?.metadataRevision) && project.metadataRevision >= 0 ? project.metadataRevision : 0;
}

export function summarizeProject(project) {
  const video = project.video && typeof project.video === 'object' ? project.video : project.videoProject || {};
  const clips = (Array.isArray(video.timeline) ? video.timeline : []).filter(clip => Number.isFinite(Number(clip?.start)) && Number.isFinite(Number(clip?.end)) && Number(clip.end) > Number(clip.start));
  const outputs = project.outputs && typeof project.outputs === 'object' ? project.outputs : {};
  const outputCount = OUTPUT_CHANNELS.filter(channel => outputs[channel] && typeof outputs[channel] === 'object').length + (video.lastExportJob?.status === 'complete' ? 1 : 0);
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
  return {
    id: project.id,
    title: typeof project.title === 'string' ? project.title.slice(0, 120) : typeof project.name === 'string' ? project.name.slice(0, 120) : '未命名项目',
    kind: ['video', 'writing', 'science'].includes(project.kind) ? project.kind : project.video || project.videoProject ? 'video' : 'writing',
    description: typeof project.description === 'string' ? project.description.slice(0, 1000) : '',
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
  if (!keys.length || keys.some(key => !['title', 'description'].includes(key))) throw new AppError(400, '仅支持修改项目标题和简介。', 'INVALID_PROJECT_METADATA');
  const patch = {};
  if (Object.hasOwn(input, 'title')) {
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.trim().length > 120) throw new AppError(400, '项目标题不能为空且不能超过120字。', 'INVALID_PROJECT_TITLE');
    patch.title = input.title.trim();
  }
  if (Object.hasOwn(input, 'description')) {
    if (typeof input.description !== 'string' || input.description.length > 1000) throw new AppError(400, '项目简介不能超过1000字。', 'INVALID_PROJECT_DESCRIPTION');
    patch.description = input.description;
  }
  return patch;
}

export async function createProjectStore(dataDir, { sensitiveStrings = () => [] } = {}) {
  const directory = path.join(path.resolve(dataDir), 'projects');
  await mkdir(directory, { recursive: true });
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
      await writeFile(temporary, serializedProject, { mode: 0o600 });
      await rename(temporary, path.join(directory, `${id}.json`));
    } catch {
      await unlink(temporary).catch(() => {});
      throw new AppError(500, '项目保存失败，请检查本地磁盘空间和目录权限。', 'PROJECT_WRITE_ERROR');
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
    async save(id, input) {
      validateProjectId(id);
      requireObject(input, '项目');
      if (input.id && input.id !== id) throw new AppError(400, '项目编号与保存路径不一致。', 'PROJECT_ID_MISMATCH');
      return serialized(id, async () => {
        const clean = withoutSecrets(input, 0, sensitiveStrings());
        const previous = await read(id);
        const now = new Date().toISOString();
        const revision = metadataRevision(previous);
        const project = { ...clean, id, createdAt: previous?.createdAt || clean.createdAt || now, updatedAt: now, metadataRevision: revision };
        // An autosave prepared before PATCH can still save its editing content,
        // but cannot replace the newer, server-owned title and description.
        if (previous && revision > 0 && metadataRevision(clean) !== revision) {
          if (Object.hasOwn(previous, 'title')) project.title = previous.title;
          if (Object.hasOwn(previous, 'description')) project.description = previous.description;
        }
        return writeProject(id, project);
      });
    },
    async patchMetadata(id, input) {
      validateProjectId(id);
      const patch = validateMetadataPatch(input);
      return serialized(id, async () => {
        const previous = await read(id);
        if (!previous) throw new AppError(404, '项目不存在。', 'PROJECT_NOT_FOUND');
        const cleanPatch = withoutSecrets(patch, 0, sensitiveStrings());
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
