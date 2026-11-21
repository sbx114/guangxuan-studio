import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { AppError } from './errors.mjs';
import { normalizeNovelConfig, hydratePlayableNovel } from '../public/visual-novel-model.js';

const PROJECT = '[A-Za-z0-9][A-Za-z0-9_-]{0,127}', UUID = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const IMAGE = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const failure = (message, file = '') => Object.assign(new AppError(400, message, 'BUNDLE_NOVEL_LIBRARY_INVALID'), { file });
const equalSelection = (a, b) => a?.characterId === b?.characterId && a?.backgroundId === b?.backgroundId;
const selectionOf = value => value?.librarySelection || { characterId: value?.selectedCharacterId, backgroundId: value?.selectedBackgroundId };
export function sharedNovelBundlePath(value) {
  const record = typeof value === 'string' && value.match(new RegExp('^novel-library/(' + PROJECT + ')/(novel|draft)\\.json$'));
  if (record) return { kind: 'selection', projectId: record[1], slot: record[2] };
  const asset = typeof value === 'string' && value.match(new RegExp('^novel-library/assets/(' + UUID + ')\\.(png|jpg|webp)$'));
  return asset ? { kind: 'asset', assetId: asset[1], extension: asset[2] } : null;
}
function selections(project) {
  if (project?.kind !== 'science') return [];
  const result = [], science = project.science || {};
  for (const [slot, value] of [['novel', science.novel?.version === 2 ? science.novel : null], ['draft', science.novelConfig]]) {
    if (!value) continue;
    const selection = selectionOf(value);
    if (slot === 'draft' && !selection.characterId && !selection.backgroundId) continue;
    if (typeof selection.characterId !== 'string' || typeof selection.backgroundId !== 'string' || !selection.characterId || !selection.backgroundId) throw failure('公用素材选择尚未完整，请选好人物与场景，或清空制作选择后再备份。');
    result.push({ slot, selection });
  }
  if (science.novelDraft?.version === 2 && !result.some(item => equalSelection(item.selection, science.novelDraft.librarySelection))) throw failure('讲解编辑草稿使用了未随当前作品选择的公用素材，请先保存或放弃编辑后备份。');
  return result;
}
const recordPath = (projectId, slot) => 'novel-library/' + projectId + '/' + slot + '.json';

export async function collectSharedNovelBundle({ projects, novelLibrary, signal }) {
  const entries = [], assets = new Map(), jsonRecords = new Map(), selectionsSeen = new Map();
  for (const project of projects) for (const { slot, selection } of selections(project)) {
    const file = recordPath(project.id, slot);
    if (!novelLibrary?.exportSelection) throw failure('公用素材库暂不可用，无法确认作品图片可恢复。', file);
    let pack;
    try { signal?.throwIfAborted(); const key = JSON.stringify(selection); pack = selectionsSeen.get(key); if (!pack) { pack = await novelLibrary.exportSelection(selection, { signal }); selectionsSeen.set(key, pack); } }
    catch (error) { if (signal?.aborted) throw error; throw failure('公用素材缺失或无法读取，请在素材库中检查后再备份。', file); }
    const record = { version: 1, librarySelection: pack.librarySelection, characters: pack.characters, backgrounds: pack.backgrounds, assets: [] };
    for (const asset of pack.assets) {
      const metadata = asset.metadata, relative = 'novel-library/assets/' + metadata.id + '.' + IMAGE[metadata.mimeType], bytes = Buffer.from(asset.base64, 'base64');
      if (assets.has(relative) && !assets.get(relative).equals(bytes)) throw failure('同一公用图片的内容发生变化，请重新备份。', relative);
      assets.set(relative, bytes); record.assets.push({ metadata, file: relative });
    }
    jsonRecords.set(file, record); entries.push({ relative: file, bytes: Buffer.from(JSON.stringify(record, null, 2) + '\n') });
  }
  for (const [relative, bytes] of assets) entries.push({ relative, bytes });
  return { entries, jsonRecords };
}

export function validateSharedNovelBundle(manifest, records) {
  const files = new Map(manifest.files.map(file => [file.path, file])), projects = new Map(manifest.projects.map(project => [project.sourceId, records.get(project.file)]));
  const expected = new Map(), usedFiles = new Set(), packs = new Map();
  for (const [projectId, project] of projects) for (const item of selections(project)) expected.set(recordPath(projectId, item.slot), item);
  for (const file of manifest.files.filter(file => file.path.startsWith('novel-library/'))) {
    const info = sharedNovelBundlePath(file.path);
    if (!info) throw failure('公用素材包路径不正确。', file.path);
    if (info.kind !== 'selection') continue;
    const wanted = expected.get(file.path), record = records.get(file.path);
    if (!wanted || !projects.has(info.projectId) || !record || record.version !== 1 || !equalSelection(record.librarySelection, wanted.selection) || !Array.isArray(record.characters) || record.characters.length !== 1 || !Array.isArray(record.backgrounds) || record.backgrounds.length !== 1 || !Array.isArray(record.assets) || record.assets.length < 2 || record.assets.length > 13) throw failure('公用素材包与项目所选人物或场景不一致。', file.path);
    const catalog = [], ids = new Set();
    for (const item of record.assets) {
      const metadata = item?.metadata, resource = sharedNovelBundlePath(item?.file), image = files.get(item?.file);
      if (!metadata || !resource || resource.kind !== 'asset' || resource.assetId !== metadata.id || resource.extension !== IMAGE[metadata.mimeType] || ids.has(metadata.id) || !['portrait', 'background'].includes(metadata.kind) || typeof metadata.name !== 'string' || !metadata.name.trim() || metadata.name.length > 160 || /[\\/\x00-\x1f]/.test(metadata.name) || !image || image.sha256 !== metadata.sha256 || image.size !== metadata.bytes || metadata.bytes < 1 || metadata.bytes > 12 * 1024 * 1024 || !Number.isInteger(metadata.width) || !Number.isInteger(metadata.height) || metadata.width < 1 || metadata.height < 1 || metadata.width > 16000 || metadata.height > 16000 || metadata.width * metadata.height > 40000000) throw failure('公用素材图片的类型、内容或归属不一致。', item?.file || file.path);
      ids.add(metadata.id); usedFiles.add(item.file); catalog.push(metadata);
    }
    let config;
    try { config = normalizeNovelConfig({ librarySelection: record.librarySelection, characters: record.characters, backgrounds: record.backgrounds }, { items: catalog }); }
    catch (error) { throw failure('公用素材设定无效：' + error.message, file.path); }
    const needed = new Set([...config.characters[0].portraits.map(pose => pose.assetId), config.backgrounds[0].assetId]);
    if (needed.size !== ids.size || [...needed].some(id => !ids.has(id))) throw failure('公用素材包包含缺失或多余的图片。', file.path);
    const project = projects.get(info.projectId), resources = { config, assetCatalog: { items: catalog } };
    for (const novel of [info.slot === 'novel' ? project.science.novel : null, project.science.novelDraft?.version === 2 && equalSelection(project.science.novelDraft.librarySelection, record.librarySelection) ? project.science.novelDraft : null].filter(Boolean)) {
      try { hydratePlayableNovel(novel, resources); } catch (error) { throw failure('作品与公用素材不一致：' + error.message, file.path); }
    }
    packs.set(file.path, record);
  }
  for (const file of expected.keys()) if (!packs.has(file)) throw failure('项目包缺少当前作品引用的公用人物、表情或场景。', file);
  for (const file of manifest.files) if (sharedNovelBundlePath(file.path)?.kind === 'asset' && !usedFiles.has(file.path)) throw failure('公用素材包包含未被项目引用的图片。', file.path);
  return { packs };
}

export async function restoreSharedNovelBundle({ manifest, records, entriesRoot, novelLibrary, created }) {
  const { packs } = validateSharedNovelBundle(manifest, records), mappings = new Map(), reused = new Map();
  if (packs.size && !novelLibrary?.importSelection) throw failure('公用素材库暂不可用，无法恢复作品图片。');
  for (const [file, record] of packs) {
    const key = JSON.stringify(record);
    let imported = reused.get(key);
    if (!imported) {
      const pack = { ...record, assets: await Promise.all(record.assets.map(async item => ({ metadata: item.metadata, base64: (await readFile(path.join(entriesRoot, ...item.file.split('/')))).toString('base64') }))) };
      imported = await novelLibrary.importSelection(pack); created.push(imported.created); reused.set(key, imported);
    }
    mappings.set(file, imported.librarySelection);
  }
  return mappings;
}

export function remapSharedNovelProject(value, original, mappings) {
  if (original?.kind !== 'science' || !value.science) return;
  const selectionMappings = selections(original).map(item => ({ ...item, mapped: mappings.get(recordPath(original.id, item.slot)) }));
  for (const field of ['novel', 'novelDraft']) {
    const source = original.science?.[field]; if (source?.version !== 2) continue;
    const selected = selectionMappings.find(item => equalSelection(item.selection, source.librarySelection));
    if (!selected?.mapped) throw failure('作品公用素材恢复映射缺失。');
    const novel = structuredClone(source); delete novel.characters; delete novel.backgrounds; delete novel.configSnapshot;
    novel.librarySelection = { ...selected.mapped };
    for (const scene of novel.scenes) { scene.backgroundId = selected.mapped.backgroundId; for (const actor of scene.actors) actor.characterId = selected.mapped.characterId; for (const line of scene.lines) if (line.speakerId) line.speakerId = selected.mapped.characterId; }
    value.science[field] = novel;
  }
  const draft = selectionMappings.find(item => item.slot === 'draft');
  if (draft) { value.science.novelConfig = { ...structuredClone(original.science.novelConfig), librarySelection: { ...draft.mapped }, selectedCharacterId: draft.mapped.characterId, selectedBackgroundId: draft.mapped.backgroundId }; delete value.science.novelConfig.characters; delete value.science.novelConfig.backgrounds; }
}
