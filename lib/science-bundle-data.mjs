import path from 'node:path';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { AppError } from './errors.mjs';

const PROJECT = '[A-Za-z0-9][A-Za-z0-9_-]{0,127}';
const UUID = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const RESOURCE = new RegExp('^(science-documents|novel-assets)/(' + PROJECT + ')/(' + UUID + ')/([^/]+)$');
const SHA = /^[a-f0-9]{64}$/;
const UNIT_ID = /^(?:p\d{4}|s\d{4})-\d{3}-[a-f0-9]{12}$/;
const IMAGE = { 'image/png': 'image.png', 'image/jpeg': 'image.jpg', 'image/webp': 'image.webp' };
const failure = (message, code = 'BUNDLE_SCIENCE_INVALID') => new AppError(400, message, code);
const digest = value => createHash('sha256').update(value).digest('hex');
const compare = value => process.platform === 'win32' ? value.toLowerCase() : value;

export function scienceBundlePath(value) {
  const match = typeof value === 'string' && RESOURCE.exec(value);
  if (!match) return null;
  const [, kind, projectId, id, name] = match;
  const allowed = kind === 'science-documents' ? /^(?:document\.json|units\.json|source\.(?:pdf|docx|txt|md|markdown))$/.test(name) : /^(?:metadata\.json|image\.(?:png|jpg|webp))$/.test(name);
  return allowed ? { kind, projectId, id, name } : null;
}

async function regular(root, filename, directory = false) {
  const scope = path.resolve(root), target = path.resolve(filename), relative = path.relative(scope, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw failure('资料文件超出项目管理范围。');
  let probe = scope;
  for (const part of [null, ...relative.split(path.sep).filter(Boolean)]) {
    if (part !== null) probe = path.join(probe, part);
    if ((await lstat(probe)).isSymbolicLink()) throw failure('资料或人物图片使用了外链，请重新导入后备份。');
  }
  const info = await lstat(target), actual = await realpath(target);
  if (compare(actual) !== compare(target) || (directory ? !info.isDirectory() : !info.isFile())) throw failure('资料或人物图片位置无效。');
  return info;
}

export async function collectScienceBundleFiles({ dataDir, projectIds, projects = [], signal }) {
  const entries = [], novelAssetIds = new Set(), warnings = [], owners = new Map(projects.map(project => [project.id, project]));
  for (const kind of ['science-documents', 'novel-assets']) {
    for (const projectId of projectIds) {
      const owner = path.join(dataDir, kind, projectId);
      let children;
      try { await regular(dataDir, owner, true); children = await readdir(owner, { withFileTypes: true }); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      for (const child of children) {
        signal?.throwIfAborted();
        if (child.name.startsWith('.import-') || child.name.startsWith('.stage-')) continue;
        if (!new RegExp('^' + UUID + '$').test(child.name) || !child.isDirectory() || child.isSymbolicLink()) throw failure('资料目录含无法备份的记录，请重新导入。');
        const directory = path.join(owner, child.name);
        await regular(dataDir, directory, true);
        const metadataFile = path.join(directory, kind === 'science-documents' ? 'document.json' : 'metadata.json');
        let metadata;
        try {
          const info = await regular(dataDir, metadataFile);
          if (info.size > 1024 * 1024) throw failure('资料记录过大。');
          metadata = JSON.parse(await readFile(metadataFile, 'utf8'));
        } catch {
          warnings.push({ code: 'BUNDLE_SCIENCE_RECORD_EXCLUDED', file: kind + '/' + projectId + '/' + child.name, message: '无法读取归属的旧资料未纳入备份，原文件保留。' }); continue;
        }
        if (metadata.projectId !== projectId || owners.has(projectId) && metadata.ownerCreatedAt !== owners.get(projectId).createdAt) {
          warnings.push({ code: 'BUNDLE_SCIENCE_OWNER_EXCLUDED', file: kind + '/' + projectId + '/' + child.name, message: '不属于当前项目创建批次的旧资料未纳入备份，原文件保留。' }); continue;
        }
        for (const item of await readdir(directory, { withFileTypes: true })) {
          const relative = kind + '/' + projectId + '/' + child.name + '/' + item.name;
          if (!scienceBundlePath(relative) || !item.isFile() || item.isSymbolicLink()) throw failure('资料目录含无法备份的文件。');
          const filename = path.join(directory, item.name);
          await regular(dataDir, filename);
          entries.push({ relative, filename, scope: dataDir });
        }
        if (kind === 'novel-assets') novelAssetIds.add(child.name);
      }
    }
  }
  return { entries, novelAssetIds, warnings };
}

export function validateScienceBundleContents(manifest, records) {
  const files = new Map(manifest.files.map(file => [file.path, file])), owners = new Map(manifest.projects.map(item => [item.sourceId, records.get(item.file)]));
  const groups = new Map(), novelAssetIds = new Set();
  let pathInCheck = '';
  const resourceFailure = (message, code) => Object.assign(failure(message, code), { file: pathInCheck });
  for (const file of manifest.files) {
    pathInCheck = file.path;
    const resource = scienceBundlePath(file.path);
    if (!resource) continue;
    if (!owners.has(resource.projectId)) throw resourceFailure('论文或人物图片不属于包内项目。', 'BUNDLE_WRONG_OWNER');
    const key = resource.kind + '/' + resource.projectId + '/' + resource.id;
    if (!groups.has(key)) groups.set(key, resource);
  }
  for (const [prefix, resource] of groups) {
    pathInCheck = prefix + (resource.kind === 'science-documents' ? '/document.json' : '/metadata.json');
    if (resource.kind === 'science-documents') {
      const metadata = records.get(prefix + '/document.json'), units = records.get(prefix + '/units.json'), owner = owners.get(resource.projectId);
      if (!metadata || metadata.version !== 1 || metadata.projectId !== resource.projectId || metadata.ownerCreatedAt !== owner.createdAt || metadata.documentId !== resource.id || !/^(?:pdf|docx|txt|md|markdown)$/.test(metadata.format || '') || metadata.sourceFile !== 'source.' + metadata.format || metadata.unitsFile !== 'units.json' || !SHA.test(metadata.sourceHash || '') || !SHA.test(metadata.unitsHash || '') || !SHA.test(metadata.contentHash || '') || !Array.isArray(units) || !units.length || units.length > 3000 || (metadata.format === 'pdf' ? !Number.isInteger(metadata.pageCount) || metadata.pageCount < 1 || metadata.pageCount > 800 : metadata.pageCount !== null && (!Number.isInteger(metadata.pageCount) || metadata.pageCount < 1 || metadata.pageCount > 800)) || !Array.isArray(metadata.warnings)) throw resourceFailure('论文资料的归属或格式无效。', 'BUNDLE_WRONG_OWNER');
      const sourceFile = files.get(prefix + '/' + metadata.sourceFile), unitFile = files.get(prefix + '/units.json');
      if (!sourceFile || !unitFile || sourceFile.sha256 !== metadata.sourceHash || unitFile.sha256 !== metadata.unitsHash || metadata.totalUnitCount !== units.length || metadata.bytes !== sourceFile.size) throw resourceFailure('论文原文件或页段与记录不一致。', 'BUNDLE_SCIENCE_HASH_MISMATCH');
      const ids = new Set();
      for (const [index, unit] of units.entries()) {
        if (!unit || !UNIT_ID.test(unit.id || '') || ids.has(unit.id) || unit.index !== index || typeof unit.text !== 'string' || unit.text.length > 6000 || unit.characterCount !== unit.text.length || unit.readable !== Boolean(unit.text.trim()) || !SHA.test(unit.hash || '') || digest(unit.text) !== unit.hash || (unit.page !== undefined && (!Number.isInteger(unit.page) || unit.page < 1 || unit.page > metadata.pageCount))) throw resourceFailure('论文页段内容与引用标识不一致。', 'BUNDLE_SCIENCE_HASH_MISMATCH');
        ids.add(unit.id);
      }
      if (metadata.characterCount !== units.reduce((sum, unit) => sum + unit.text.length, 0) || metadata.characterCount > 2000000 || metadata.readableUnitCount !== units.filter(unit => unit.readable).length) throw resourceFailure('论文页段统计不一致。', 'BUNDLE_SCIENCE_HASH_MISMATCH');
      if (digest(JSON.stringify(units.map(unit => [unit.id, unit.hash]))) !== metadata.contentHash) throw resourceFailure('论文页段清单已改变。', 'BUNDLE_SCIENCE_HASH_MISMATCH');
      const allowed = new Set(['document.json', 'units.json', metadata.sourceFile]);
      for (const name of files.keys()) if (name.startsWith(prefix + '/') && !allowed.has(name.slice(prefix.length + 1))) throw resourceFailure('论文目录包含额外原文件。');
    } else {
      const metadata = records.get(prefix + '/metadata.json'), imageName = IMAGE[metadata?.mimeType], image = imageName && files.get(prefix + '/' + imageName);
      if (!metadata || metadata.projectId !== resource.projectId || metadata.ownerCreatedAt !== owners.get(resource.projectId).createdAt || metadata.id !== resource.id || !['background', 'portrait'].includes(metadata.kind) || !image || image.sha256 !== metadata.sha256 || image.size !== metadata.bytes || !Number.isInteger(metadata.width) || !Number.isInteger(metadata.height) || metadata.width < 1 || metadata.height < 1 || metadata.width > 16000 || metadata.height > 16000 || metadata.width * metadata.height > 40000000) throw resourceFailure('自定义场景或人物图片与记录不一致。', 'BUNDLE_SCIENCE_HASH_MISMATCH');
      for (const name of files.keys()) if (name.startsWith(prefix + '/') && ![prefix + '/metadata.json', prefix + '/' + imageName].includes(name)) throw resourceFailure('人物图片目录包含额外图片。');
      novelAssetIds.add(resource.id);
    }
  }
  return { novelAssetIds, resourceCount: groups.size };
}

export async function restoreScienceBundleFiles({ dataDir, manifest, entriesRoot, records, projectMap, restoredRecords, created }) {
  const owners = new Map(restoredRecords.map(record => [record.id, record])), roots = new Set();
  for (const file of manifest.files) {
    const resource = scienceBundlePath(file.path);
    if (!resource) continue;
    const mapped = projectMap.get(resource.projectId), owner = owners.get(mapped);
    if (!mapped || !owner) throw failure('恢复论文资料时缺少项目映射。', 'BUNDLE_WRONG_OWNER');
    const directory = path.join(dataDir, resource.kind, mapped);
    if (!roots.has(directory)) {
      await mkdir(path.dirname(directory), { recursive: true }); await regular(dataDir, path.dirname(directory), true);
      try { await lstat(directory); throw failure('恢复资料时发生目录冲突。', 'BUNDLE_ID_CONFLICT'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await mkdir(directory); created.push(directory); roots.add(directory);
    }
    const destination = path.join(directory, resource.id, resource.name);
    await mkdir(path.dirname(destination), { recursive: true }); await regular(dataDir, path.dirname(destination), true);
    if ((resource.kind === 'science-documents' && resource.name === 'document.json') || (resource.kind === 'novel-assets' && resource.name === 'metadata.json')) {
      const metadata = { ...records.get(file.path), projectId: mapped, ownerCreatedAt: owner.createdAt };
      await writeFile(destination, JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    } else {
      await copyFile(path.join(entriesRoot, ...file.path.split('/')), destination);
    }
  }
  return { restoredRoots: roots.size };
}
