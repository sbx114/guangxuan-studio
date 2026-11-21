import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile, readdir, lstat } from 'node:fs/promises';
import { AppError } from './errors.mjs';
import { remotionSourcePath } from './remotion-projects.mjs';

const PROJECT = '[A-Za-z0-9][A-Za-z0-9_-]{0,127}', UUID = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', SHA = /^[a-f0-9]{64}$/;
const bytesHash = bytes => createHash('sha256').update(bytes).digest('hex');
const failure = (message, file = '') => Object.assign(new AppError(400, message, 'BUNDLE_REMOTION_INVALID'), { file });
const recordPath = (owner, id) => `remotion-projects/${owner}/${id}/project.json`;
function publicPath(value) {
  return typeof value === 'string' && /^media\/[A-Za-z0-9][A-Za-z0-9_.-]{0,199}\.(?:mp4|mov|webm|m4v|mp3|wav|m4a|aac|ogg|flac|png|jpe?g|webp|gif|avif|svg)$/i.test(value) && !/\/\.{1,2}(?:\/|$)|\/(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);
}
export function remotionBundlePath(value) {
  const found = typeof value === 'string' && value.match(new RegExp(`^remotion-projects/(${PROJECT})/(${UUID})/(.+)$`));
  if (!found) return null;
  const [, projectId, id, tail] = found;
  if (tail === 'project.json') return { projectId, id, kind: 'record', relative: tail };
  if (tail.startsWith('source/')) { try { const relative = remotionSourcePath(tail.slice(7)); return { projectId, id, kind: 'source', relative }; } catch { return null; } }
  if (tail.startsWith('public/') && publicPath(tail.slice(7))) return { projectId, id, kind: 'asset', relative: tail.slice(7) };
  return null;
}
function sourcePath(owner, id, relative) { return `remotion-projects/${owner}/${id}/source/${relative}`; }
function assetPath(owner, id, relative) { return `remotion-projects/${owner}/${id}/public/${relative}`; }
function activeSourceId(project) { return project?.video?.remotionProjectId || project?.video?.remotionId || null; }
async function archiveFile(root, relative) {
  const filename = path.resolve(root, ...relative.split('/')), inside = path.relative(root, filename);
  if (!inside || path.isAbsolute(inside) || inside.split(path.sep)[0] === '..') throw failure('自由动画源码超出项目包范围。', relative);
  let probe = root;
  for (const part of ['', ...inside.split(path.sep)]) { if (part) probe = path.join(probe, part); if ((await lstat(probe)).isSymbolicLink()) throw failure('自由动画源码不能通过文件链接恢复。', relative); }
  if (!(await lstat(filename)).isFile()) throw failure('自由动画源码不是普通文件。', relative);
  return filename;
}

/** Export only immutable current revisions through the owning source service. */
export async function collectRemotionBundle({ projects, remotionProjects, signal, dataDir }) {
  const entries = [], jsonRecords = new Map(), versions = [], owners = [], warnings = [];
  if (!remotionProjects?.list || !remotionProjects?.exportArchive) {
    if (projects.some(project => activeSourceId(project))) throw failure('自由动画源码服务不可用，无法完整备份当前工程。');
    if (dataDir) for (const project of projects) {
      let existing; try { existing = await readdir(path.join(dataDir, 'remotion-projects', project.id)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (existing?.length) throw failure('自由动画源码服务不可用，不能遗漏已保存的源码工程。');
    }
    return { entries, jsonRecords, versions, owners, warnings };
  }
  for (const project of projects) {
    signal?.throwIfAborted(); const listed = await remotionProjects.list(project.id), ids = new Set();
    if (!Array.isArray(listed) || listed.length > 100) throw failure('单个项目的自由动画工程过多，请拆分后备份。');
    for (const summary of listed) {
      signal?.throwIfAborted(); const file = recordPath(project.id, summary.id);
      if (summary.ownerCreatedAt && summary.ownerCreatedAt !== project.createdAt) { warnings.push({ code: 'BUNDLE_REMOTION_OLD_OWNER_EXCLUDED', file, message: '旧创建批次的动画源码未纳入当前项目包。' }); continue; }
      const pack = await remotionProjects.exportArchive(project.id, summary.id, { signal });
      if (pack.ownerCreatedAt && pack.ownerCreatedAt !== project.createdAt) throw failure('动画源码归属已经变化，请重新备份。', file);
      const files = pack.files.map(item => { const bytes = Buffer.from(item.content, 'utf8'); return { path: remotionSourcePath(item.path), bytes: bytes.length, sha256: bytesHash(bytes) }; });
      const assets = (pack.assets || []).map(({ assetId, publicPath, name, type, bytes, sha256 }) => ({ assetId, publicPath, name, type, bytes, sha256 }));
      const record = { version: 1, projectId: project.id, ownerCreatedAt: project.createdAt, id: summary.id, sourceRevision: pack.revision, title: pack.title, entryPoint: pack.entryPoint, compositionId: pack.compositionId, inputProps: pack.inputProps, files, assets };
      jsonRecords.set(file, record); entries.push({ relative: file, bytes: Buffer.from(JSON.stringify(record, null, 2) + '\n') });
      for (const item of pack.files) entries.push({ relative: sourcePath(project.id, summary.id, item.path), bytes: Buffer.from(item.content, 'utf8') });
      for (const item of pack.assets || []) entries.push({ relative: assetPath(project.id, summary.id, item.publicPath), filename: item.filename, scope: item.scope });
      ids.add(summary.id); versions.push({ projectId: project.id, id: summary.id, revision: pack.revision });
    }
    if (activeSourceId(project) && !ids.has(activeSourceId(project))) throw failure('当前选择的自由动画源码缺失，不能只备份渲染成片。', recordPath(project.id, activeSourceId(project)));
    owners.push({ projectId: project.id, ownerCreatedAt: project.createdAt, revisions: versions.filter(item => item.projectId === project.id).map(({ id, revision }) => ({ id, revision })).sort((a, b) => a.id.localeCompare(b.id)) });
  }
  return { entries, jsonRecords, versions, owners, warnings };
}

export function validateRemotionBundle(manifest, records) {
  const files = new Map(manifest.files.map(item => [item.path, item])), owners = new Map(manifest.projects.map(item => [item.sourceId, records.get(item.file)])), packs = new Map(), used = new Set(), ids = new Set();
  for (const file of manifest.files.filter(item => item.path.startsWith('remotion-projects/'))) {
    const info = remotionBundlePath(file.path); if (!info || !owners.has(info.projectId)) throw failure('自由动画归档路径或归属无效。', file.path);
    if (info.kind !== 'record') continue;
    const value = records.get(file.path), owner = owners.get(info.projectId);
    if (!value || value.version !== 1 || value.id !== info.id || value.projectId !== info.projectId || value.ownerCreatedAt !== owner.createdAt || !Number.isSafeInteger(value.sourceRevision) || value.sourceRevision < 1 || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 160 || !Array.isArray(value.files) || value.files.length < 1 || value.files.length > 128 || !Array.isArray(value.assets) || value.assets.length > 32 || ids.has(value.id)) throw failure('自由动画工程清单无效或与项目不符。', file.path);
    ids.add(value.id); const prefix = file.path.slice(0, -'project.json'.length), names = new Set(); let sourceBytes = 0, assetBytes = 0;
    for (const item of value.files) {
      let relative; try { relative = remotionSourcePath(item?.path); } catch { throw failure('自由动画源码路径无效。', file.path); }
      const full = prefix + 'source/' + relative, entry = files.get(full), key = relative.normalize('NFC').toLowerCase();
      if (names.has(key) || !entry || !SHA.test(item.sha256 || '') || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > 200 * 1024 || entry.size !== item.bytes || entry.sha256 !== item.sha256) throw failure('自由动画源码缺失、重复或哈希不符。', full);
      names.add(key); sourceBytes += item.bytes; used.add(full);
    }
    if (sourceBytes > 2 * 1024 * 1024 || !names.has(String(value.entryPoint).normalize('NFC').toLowerCase()) || !/\.[jt]sx?$/i.test(value.entryPoint) || typeof value.compositionId !== 'string' || value.compositionId.length > 160 || /[\x00-\x1f]/.test(value.compositionId)) throw failure('自由动画入口、Composition或源码容量无效。', file.path);
    let props; try { props = JSON.stringify(value.inputProps); } catch {}
    if (!props || !value.inputProps || typeof value.inputProps !== 'object' || Array.isArray(value.inputProps) || Buffer.byteLength(props) > 512 * 1024) throw failure('自由动画输入参数无效。', file.path);
    const visit = (item, depth = 0) => { if (depth > 32) throw failure('自由动画输入参数层级过深。', file.path); if (item && typeof item === 'object') for (const [key, child] of Object.entries(item)) { if (['__proto__', 'prototype', 'constructor'].includes(key)) throw failure('自由动画输入参数含保留字段。', file.path); visit(child, depth + 1); } }; visit(value.inputProps);
    const assetNames = new Set(), assetIds = new Set();
    for (const item of value.assets) {
      const full = prefix + 'public/' + item?.publicPath, entry = files.get(full), key = String(item?.publicPath).toLowerCase();
      if (!publicPath(item?.publicPath) || typeof item.assetId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(item.assetId) || assetNames.has(key) || assetIds.has(item.assetId) || !entry || !SHA.test(item.sha256 || '') || !Number.isSafeInteger(item.bytes) || item.bytes < 1 || item.bytes > 512 * 1024 * 1024 || entry.size !== item.bytes || entry.sha256 !== item.sha256 || typeof item.name !== 'string' || item.name.length > 250 || typeof item.type !== 'string' || item.type.length > 40) throw failure('自由动画公开资源缺失、重复或哈希不符。', full);
      assetBytes += item.bytes; assetNames.add(key); assetIds.add(item.assetId); used.add(full);
    }
    if (assetBytes > 1024 * 1024 * 1024) throw failure('自由动画资源总容量超过1GiB。', file.path);
    used.add(file.path); packs.set(file.path, value);
  }
  for (const file of manifest.files) if (file.path.startsWith('remotion-projects/') && !used.has(file.path)) throw failure('自由动画归档中包含未声明的文件。', file.path);
  for (const [ownerId, owner] of owners) if (activeSourceId(owner) && !packs.has(recordPath(ownerId, activeSourceId(owner)))) throw failure('项目包缺少当前自由动画源码工程。', recordPath(ownerId, activeSourceId(owner)));
  return { packs };
}

/** Imported source remains inert; the source service only stores the checked bytes. */
export async function restoreRemotionBundle({ manifest, records, entriesRoot, remotionProjects, projectMap, createdAtMap, created }) {
  const { packs } = validateRemotionBundle(manifest, records), mapping = new Map();
  if (packs.size && (!remotionProjects?.importArchive || !remotionProjects?.discardArchive)) throw failure('自由动画源码服务尚未就绪，当前项目包尚未恢复。');
  for (const [file, record] of packs) {
    const prefix = file.slice(0, -'project.json'.length), files = [];
    for (const item of record.files) {
      const bytes = await readFile(await archiveFile(entriesRoot, `${prefix}source/${item.path}`)), content = bytes.toString('utf8');
      if (!Buffer.from(content, 'utf8').equals(bytes) || bytesHash(bytes) !== item.sha256) throw failure('自由动画源码不是完整UTF-8文本。', file);
      files.push({ path: item.path, content });
    }
    const projectId = projectMap.get(record.projectId), ownerCreatedAt = createdAtMap.get(record.projectId);
    const imported = await remotionProjects.importArchive(projectId, { title: record.title, entryPoint: record.entryPoint, compositionId: record.compositionId, inputProps: record.inputProps, files, assets: record.assets.map(item => ({ ...item, filename: path.join(entriesRoot, ...(`${prefix}public/${item.publicPath}`).split('/')) })) }, { ownerCreatedAt, entriesRoot });
    created.push({ projectId, id: imported.id }); mapping.set(record.id, imported.id);
  }
  return mapping;
}

export function remapRemotionProject(value, mapping) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { value.forEach(item => remapRemotionProject(item, mapping)); return; }
  const mapped = ['remotionId', 'remotionProjectId'].some(key => typeof value[key] === 'string' && mapping.has(value[key]));
  for (const [key, item] of Object.entries(value)) {
    if (['remotionId', 'remotionProjectId'].includes(key) && mapping.has(item)) value[key] = mapping.get(item);
    else if (item && typeof item === 'object') remapRemotionProject(item, mapping);
  }
  if (mapped) for (const key of ['remotionRevision', 'revision', 'expectedRevision']) if (Object.hasOwn(value, key)) value[key] = 1;
}
