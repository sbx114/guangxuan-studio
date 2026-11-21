import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { AppError } from './errors.mjs';
import { createNovelAssetService } from './novel-assets.mjs';
import { renameWithRetry } from './atomic-file.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const OWNER = 'shared-library';
const OWNER_CREATED = '2026-01-01T00:00:00.000Z';
const LIMITS = Object.freeze({ characters: 64, backgrounds: 64, portraits: 12, assets: 64, assetBytes: 12 * 1024 * 1024, totalBytes: 100 * 1024 * 1024 });
const fail = (status, message, code = 'NOVEL_LIBRARY_INVALID') => new AppError(status, message, code);
const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const clone = value => structuredClone(value);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const imageUrl = id => '/api/novel-library/assets/' + encodeURIComponent(id) + '/file';
const publicAsset = asset => ({ ...asset, url: imageUrl(asset.id) });
function identifier(value, label) { if (typeof value !== 'string' || !ID.test(value)) throw fail(400, label + '编号不正确。'); return value; }
const profileId = (input, label) => Object.hasOwn(input, 'id') ? identifier(input.id, label) : randomUUID();
const optionalAssetId = value => value === undefined || value === '' ? '' : identifier(value, '图片');
function text(value, label, maximum, optional = false) {
  if (optional && (value === undefined || value === null)) return '';
  if (typeof value !== 'string' || (!optional && !value.trim()) || value.length > maximum || /\0/.test(value)) throw fail(400, label + '格式不正确，最多' + maximum + '字。');
  return value.trim();
}
function characterProfile(input) {
  if (!object(input)) throw fail(400, '人物资料格式不正确。');
  const portraits = input.portraits === undefined ? [] : input.portraits;
  if (!Array.isArray(portraits) || portraits.length > LIMITS.portraits) throw fail(400, '每个人物最多添加12种表情。');
  const value = {
    id: profileId(input, '人物'), name: text(input.name, '人物姓名', 40),
    role: text(input.role, '人物人设', 1200, true), tone: text(input.tone, '人物语气', 600, true), personality: text(input.personality, '人物性格', 600, true),
    color: /^#[a-f0-9]{6}$/i.test(input.color || '') ? input.color : '#789e9c',
    portraits: portraits.map(pose => {
      if (!object(pose)) throw fail(400, '表情资料格式不正确。');
      return { id: profileId(pose, '表情'), name: text(pose.name, '表情名称', 40), assetId: optionalAssetId(pose.assetId) };
    }),
  };
  if (new Set(value.portraits.map(pose => pose.id)).size !== value.portraits.length) throw fail(400, '人物表情编号重复。');
  return value;
}
function backgroundProfile(input) {
  if (!object(input)) throw fail(400, '场景资料格式不正确。');
  return { id: profileId(input, '场景'), name: text(input.name, '场景名称', 60), assetId: optionalAssetId(input.assetId), fit: input.fit === 'contain' ? 'contain' : 'cover' };
}
function selectionIds(value) {
  if (object(value) && Object.hasOwn(value, 'librarySelection') && !object(value.librarySelection)) throw fail(400, '公用素材选择格式不正确。');
  const selection = object(value?.librarySelection) ? value.librarySelection : value;
  return { characterId: identifier(selection?.characterId, '人物'), backgroundId: identifier(selection?.backgroundId, '场景') };
}
function json(res, status, value) { if (!res.destroyed && !res.writableEnded) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); } }
function readBody(req, signal, maximum) {
  return new Promise((resolve, reject) => {
    let size = 0, settled = false, cancelling = false; const chunks = [];
    const cleanup = () => { req.removeListener('data', data); req.removeListener('end', ended); req.removeListener('aborted', aborted); signal?.removeEventListener('abort', aborted); if (cancelling && !req.closed) req.once('close', () => req.removeListener('error', errored)); else req.removeListener('error', errored); };
    const finish = (error, value) => { if (settled) return; settled = true; cleanup(); error ? reject(error) : resolve(value); };
    const aborted = () => { cancelling = true; finish(fail(499, '公用素材操作已取消。', 'REQUEST_CANCELLED')); req.destroy(); };
    const errored = () => finish(fail(400, '上传未完成，请重试。', 'NOVEL_LIBRARY_UPLOAD_FAILED'));
    const data = chunk => { size += chunk.length; if (size > maximum) { finish(fail(413, '上传内容超过大小限制。', 'NOVEL_LIBRARY_SIZE')); req.resume(); return; } chunks.push(chunk); };
    const ended = () => finish(null, Buffer.concat(chunks));
    req.on('data', data); req.once('end', ended); req.once('error', errored); req.once('aborted', aborted);
    signal?.addEventListener('abort', aborted, { once: true }); if (signal?.aborted) aborted();
  });
}

// Images share one managed owner. This owner exists only in this service and is
// never inserted into the user's project store.
export async function createNovelLibraryService({ dataDir, store, videoService } = {}) {
  if (!dataDir || !store?.list) throw fail(500, '公用素材库未配置。', 'NOVEL_LIBRARY_NOT_CONFIGURED');
  const directory = path.resolve(dataDir, 'novel-library'); await mkdir(directory, { recursive: true });
  const actualRoot = await realpath(dataDir), actualDirectory = await realpath(directory);
  if ((await lstat(directory)).isSymbolicLink() || !same(actualDirectory, path.join(actualRoot, 'novel-library'))) throw fail(403, '公用素材库目录无效。', 'NOVEL_LIBRARY_STORAGE');
  const filename = path.join(directory, 'library.json');
  let state = { version: 1, characters: [], backgrounds: [] }, queue = Promise.resolve(), closed = false;
  try {
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) throw new Error('Invalid library metadata');
    const saved = JSON.parse(await readFile(filename, 'utf8'));
    if (saved.version !== 1 || !Array.isArray(saved.characters) || !Array.isArray(saved.backgrounds) || saved.characters.length > LIMITS.characters || saved.backgrounds.length > LIMITS.backgrounds) throw new Error('Invalid library schema');
    state = { version: 1, characters: saved.characters.map(characterProfile), backgrounds: saved.backgrounds.map(backgroundProfile) };
    for (const key of ['characters', 'backgrounds']) if (new Set(state[key].map(profile => profile.id)).size !== state[key].length) throw new Error('Duplicate profile');
  } catch (error) { if (error.code !== 'ENOENT') throw fail(422, '公用素材库记录无法读取，原文件已保留。', 'NOVEL_LIBRARY_READ'); }
  const assets = await createNovelAssetService({ dataDir: directory, videoService, store: { async read(id) { return id === OWNER ? { id, kind: 'science', createdAt: OWNER_CREATED, science: { sharedLibrary: state } } : null; } } });
  const controllers = new Set(), operations = new Set();
  const tracked = pending => { operations.add(pending); pending.finally(() => operations.delete(pending)).catch(() => {}); return pending; };
  const serialized = operation => {
    if (closed) return Promise.reject(fail(503, '公用素材库已关闭。', 'NOVEL_LIBRARY_CLOSED'));
    const pending = queue.catch(() => {}).then(operation); queue = pending; return tracked(pending);
  };
  async function persist(next) {
    const temporary = path.join(directory, '.library.' + randomUUID() + '.tmp');
    try { await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600, flag: 'wx' }); await renameWithRetry(temporary, filename); state = next; }
    catch (error) { await rm(temporary, { force: true }).catch(() => {}); const failure = fail(500, '公用素材库保存失败，请检查磁盘空间。', 'NOVEL_LIBRARY_WRITE'); Object.defineProperty(failure, 'cause', { value: error, configurable: true }); throw failure; }
  }
  async function catalog() { return (await assets.list(OWNER)).items; }
  const isReady = (profile, kind, map) => kind === 'characters' ? profile.portraits.length > 0 && profile.portraits.every(pose => map.get(pose.assetId)?.kind === 'portrait') : map.get(profile.assetId)?.kind === 'background';
  const revision = () => createHash('sha256').update(JSON.stringify(state)).digest('hex');
  function compare(options = {}) {
    if (options.expectedRevision !== undefined && (typeof options.expectedRevision !== 'string' || options.expectedRevision !== revision())) throw fail(409, '公用素材库已经变化，请重新读取后再修改。', 'NOVEL_LIBRARY_REVISION_CONFLICT');
  }
  async function list() {
    await queue.catch(() => {}); const items = await catalog(), map = new Map(items.map(item => [item.id, item]));
    return { revision: revision(), characters: state.characters.map(profile => ({ ...clone(profile), ready: isReady(profile, 'characters', map) })), backgrounds: state.backgrounds.map(profile => ({ ...clone(profile), ready: isReady(profile, 'backgrounds', map) })), assets: items.map(publicAsset), limits: { ...LIMITS } };
  }
  async function assertProfileImages(profile, kind) {
    const map = new Map((await catalog()).map(item => [item.id, item]));
    const refs = kind === 'characters' ? profile.portraits.map(pose => [pose.assetId, 'portrait']) : [[profile.assetId, 'background']];
    for (const [assetId, expectedKind] of refs) if (assetId && map.get(assetId)?.kind !== expectedKind) throw fail(400, '请从公用素材库选择相应类型的图片。', 'NOVEL_LIBRARY_ASSET_MISSING');
  }
  function saveProfile(kind, input, options = {}) {
    return serialized(async () => {
      compare(options);
      const profile = kind === 'characters' ? characterProfile(input) : backgroundProfile(input); await assertProfileImages(profile, kind);
      const next = clone(state), index = next[kind].findIndex(item => item.id === profile.id);
      if (options.requireExisting === true && index < 0 || options.requireExisting === false && index >= 0) throw fail(409, '公用素材条目已经变化，请重新读取后再修改。', 'NOVEL_LIBRARY_REVISION_CONFLICT');
      if (index < 0 && next[kind].length >= LIMITS[kind]) throw fail(413, '公用素材库中的' + (kind === 'characters' ? '人物' : '场景') + '已达64个，请先移除未使用条目。', 'NOVEL_LIBRARY_LIMIT');
      if (index >= 0) await assertWorkStillPlayable(profile, kind, next[kind][index]);
      if (index < 0) next[kind].push(profile); else next[kind][index] = profile;
      await persist(next); const map = new Map((await catalog()).map(item => [item.id, item]));
      return { revision: revision(), [kind === 'characters' ? 'character' : 'background']: { ...clone(profile), ready: isReady(profile, kind, map) } };
    });
  }
  async function profileUsed(id, kind) {
    const result = await store.list();
    // An unreadable project must not silently lose a potentially referenced profile.
    if (result?.warning) throw fail(409, '有项目暂时无法读取，请修复后再移除公用素材。', 'NOVEL_LIBRARY_REFERENCE_UNKNOWN');
    return (Array.isArray(result) ? result : result?.projects || []).some(project => {
      if (project?.kind !== 'science') return false;
      const science = project.science || {};
      return [science.novel, science.novelConfig].some(value => {
        const selected = value?.librarySelection || {};
        return (kind === 'characters' ? selected.characterId || value?.selectedCharacterId : selected.backgroundId || value?.selectedBackgroundId) === id;
      });
    });
  }
  async function assertWorkStillPlayable(profile, kind, previous) {
    const poses = kind === 'characters' ? new Set(profile.portraits.map(pose => pose.id)) : null;
    const incomplete = kind === 'characters' ? !profile.portraits.length || profile.portraits.some(pose => !pose.assetId) : !profile.assetId;
    const removedPose = kind === 'characters' && previous.portraits.some(pose => !poses.has(pose.id));
    if (!incomplete && !removedPose) return;
    const result = await store.list();
    if (result?.warning) throw fail(409, '有项目暂时无法读取，请修复后再移除公用素材。', 'NOVEL_LIBRARY_REFERENCE_UNKNOWN');
    for (const project of Array.isArray(result) ? result : result?.projects || []) {
      const novel = project.kind === 'science' && project.science?.novel;
      if (!novel || (kind === 'characters' ? novel.librarySelection?.characterId : novel.librarySelection?.backgroundId) !== profile.id) continue;
      if (incomplete) throw fail(409, '已有作品正在使用此素材，请先补齐图片后再保存。', 'NOVEL_LIBRARY_IN_USE');
      if (removedPose && (novel.scenes || []).some(scene => (scene.actors || []).some(actor => actor.characterId === profile.id && !poses.has(actor.poseId)) || (scene.lines || []).some(line => line.poseId && !poses.has(line.poseId)))) throw fail(409, '该表情正在作品中使用，请保留表情条目并替换图片，或先重新生成作品。', 'NOVEL_LIBRARY_POSE_IN_USE');
    }
  }
  function removeProfile(kind, id, options = {}) {
    return serialized(async () => {
      compare(options);
      identifier(id, kind === 'characters' ? '人物' : '场景');
      if (!state[kind].some(item => item.id === id)) throw fail(404, '公用素材不存在。', 'NOVEL_LIBRARY_NOT_FOUND');
      if (await profileUsed(id, kind)) throw fail(409, '该' + (kind === 'characters' ? '人物' : '场景') + '正被项目使用，请先在项目中更换或取消选择。', 'NOVEL_LIBRARY_IN_USE');
      await persist({ ...state, [kind]: state[kind].filter(item => item.id !== id) }); return { removed: true, revision: revision() };
    });
  }
  function restoreAssistant(snapshot, options = {}) {
    return serialized(async () => {
      if (typeof options.expectedRevision !== 'string' || !object(snapshot) || !Array.isArray(snapshot.characters) || !Array.isArray(snapshot.backgrounds) || snapshot.characters.length > LIMITS.characters || snapshot.backgrounds.length > LIMITS.backgrounds) throw fail(400, '公用素材库撤销记录无效。', 'NOVEL_LIBRARY_RESTORE_INVALID');
      compare(options);
      const next = { version: 1, characters: snapshot.characters.map(characterProfile), backgrounds: snapshot.backgrounds.map(backgroundProfile) };
      for (const kind of ['characters', 'backgrounds']) {
        if (new Set(next[kind].map(item => item.id)).size !== next[kind].length) throw fail(400, '公用素材库撤销记录含重复编号。', 'NOVEL_LIBRARY_RESTORE_INVALID');
        for (const profile of next[kind]) {
          await assertProfileImages(profile, kind);
          const previous = state[kind].find(item => item.id === profile.id);
          if (previous) await assertWorkStillPlayable(profile, kind, previous);
        }
        for (const profile of state[kind]) if (!next[kind].some(item => item.id === profile.id) && await profileUsed(profile.id, kind)) throw fail(409, '新建公用素材已被项目使用，请先更换项目选择后再撤销。', 'NOVEL_LIBRARY_IN_USE');
      }
      await persist(next); return { restored: true, revision: revision() };
    });
  }
  function importBytes(bytes, options) {
    if (closed) return Promise.reject(fail(503, '公用素材库已关闭。', 'NOVEL_LIBRARY_CLOSED'));
    return serialized(async () => { compare(options); return assets.importBytes(OWNER, bytes, options); }).then(value => ({ asset: publicAsset(value.asset) })).catch(error => { if (error.code === 'NOVEL_ASSET_LIMIT') throw fail(413, '公用素材库最多64张图片，总计100MB。请先移除未使用的图片。', 'NOVEL_ASSET_LIMIT'); throw error; });
  }
  function removeAsset(id, options = {}) { return serialized(async () => { compare(options); const key = identifier(id, '图片'); if (options.expectedSha256 !== undefined && (await assets.file(OWNER, key)).metadata.sha256 !== options.expectedSha256) throw fail(409, '公用图片已经变化，请重新读取。', 'NOVEL_LIBRARY_REVISION_CONFLICT'); return assets.remove(OWNER, key); }); }
  async function resolveSelection(value, { signal } = {}) {
    await queue.catch(() => {}); signal?.throwIfAborted(); const librarySelection = selectionIds(value);
    const character = state.characters.find(item => item.id === librarySelection.characterId), background = state.backgrounds.find(item => item.id === librarySelection.backgroundId);
    if (!character || !background) throw fail(400, '请从公用素材库选择一个人物和一个场景。', 'NOVEL_LIBRARY_SELECTION');
    const items = await catalog(), map = new Map(items.map(item => [item.id, item]));
    if (!isReady(character, 'characters', map) || !isReady(background, 'backgrounds', map)) throw fail(400, '请先为所选人物的每个表情添加立绘，并为场景添加背景。', 'NOVEL_LIBRARY_NOT_READY');
    const ids = [...new Set([...character.portraits.map(pose => pose.assetId), background.assetId])];
    for (const id of ids) { signal?.throwIfAborted(); await assets.file(OWNER, id); }
    return { config: { librarySelection, selectedCharacterId: character.id, selectedBackgroundId: background.id, characters: [clone(character)], backgrounds: [clone(background)] }, assetCatalog: { items: ids.map(id => publicAsset(map.get(id))) } };
  }
  async function exportSelection(selection, options = {}) {
    const resolved = await resolveSelection(selection, options), packed = [];
    for (const asset of resolved.assetCatalog.items) { options.signal?.throwIfAborted(); const value = await assets.file(OWNER, asset.id); packed.push({ metadata: value.metadata, base64: value.bytes.toString('base64') }); }
    return { version: 1, librarySelection: resolved.config.librarySelection, characters: resolved.config.characters, backgrounds: resolved.config.backgrounds, assets: packed };
  }
  function importSelection(pack, { signal } = {}) {
    return serialized(async () => {
      if (!object(pack) || pack.version !== 1 || !Array.isArray(pack.characters) || pack.characters.length !== 1 || !Array.isArray(pack.backgrounds) || pack.backgrounds.length !== 1 || !Array.isArray(pack.assets) || pack.assets.length < 2 || pack.assets.length > 13) throw fail(400, '公用素材迁移包格式不正确。', 'NOVEL_LIBRARY_PACKAGE');
      const selection = selectionIds(pack.librarySelection), character = characterProfile(pack.characters[0]), background = backgroundProfile(pack.backgrounds[0]);
      if (selection.characterId !== character.id || selection.backgroundId !== background.id) throw fail(400, '迁移包所选人物或场景不一致。', 'NOVEL_LIBRARY_PACKAGE');
      const needed = new Set([...character.portraits.map(pose => pose.assetId), background.assetId]);
      if (needed.has('') || needed.size !== pack.assets.length) throw fail(400, '迁移包包含缺失或多余的图片。', 'NOVEL_LIBRARY_PACKAGE');
      let total = 0; const decoded = [], seen = new Set();
      for (const item of pack.assets) {
        const metadata = item?.metadata;
        if (!object(metadata) || typeof metadata.id !== 'string' || !ID.test(metadata.id) || !needed.has(metadata.id) || seen.has(metadata.id) || !['portrait', 'background'].includes(metadata.kind) || typeof item.base64 !== 'string' || item.base64.length > Math.ceil(LIMITS.assetBytes / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(item.base64)) throw fail(400, '迁移包图片记录不正确。', 'NOVEL_LIBRARY_PACKAGE');
        const bytes = Buffer.from(item.base64, 'base64'); total += bytes.length;
        if (!bytes.length || bytes.length > LIMITS.assetBytes || total > LIMITS.totalBytes || metadata.bytes !== bytes.length || metadata.sha256 !== sha256(bytes)) throw fail(400, '迁移包图片校验失败。', 'NOVEL_LIBRARY_PACKAGE');
        const kind = metadata.id === background.assetId ? 'background' : 'portrait';
        if (metadata.kind !== kind) throw fail(400, '迁移包图片类型不一致。', 'NOVEL_LIBRARY_PACKAGE');
        seen.add(metadata.id); decoded.push({ metadata, bytes });
      }
      const existing = await catalog(), mapping = { characters: {}, backgrounds: {}, assets: {} }, created = { characterIds: [], backgroundIds: [], assetIds: [] };
      try {
        for (const { metadata, bytes } of decoded) {
          signal?.throwIfAborted(); const reusable = existing.find(asset => asset.kind === metadata.kind && asset.sha256 === metadata.sha256 && asset.bytes === bytes.length);
          if (reusable) { await assets.file(OWNER, reusable.id); mapping.assets[metadata.id] = reusable.id; }
          else { const { asset } = await assets.importBytes(OWNER, bytes, { name: text(metadata.name, '图片名称', 160), kind: metadata.kind, signal }); mapping.assets[metadata.id] = asset.id; created.assetIds.push(asset.id); existing.push(asset); }
        }
        const next = clone(state), sameProfile = (a, b) => JSON.stringify(a) === JSON.stringify(b);
        for (const [kind, original] of [['characters', character], ['backgrounds', background]]) {
          const profile = clone(original);
          if (kind === 'characters') profile.portraits.forEach(pose => { pose.assetId = mapping.assets[pose.assetId]; }); else profile.assetId = mapping.assets[profile.assetId];
          const collision = next[kind].find(item => item.id === profile.id);
          if (collision && !sameProfile(collision, profile)) profile.id = randomUUID();
          if (!collision || profile.id !== collision.id) {
            if (next[kind].length >= LIMITS[kind]) throw fail(413, '公用素材库条目已达上限。', 'NOVEL_LIBRARY_LIMIT');
            next[kind].push(profile); created[kind === 'characters' ? 'characterIds' : 'backgroundIds'].push(profile.id);
          }
          mapping[kind][original.id] = profile.id;
        }
        signal?.throwIfAborted(); await persist(next);
        return { librarySelection: { characterId: mapping.characters[selection.characterId], backgroundId: mapping.backgrounds[selection.backgroundId] }, mapping, created };
      } catch (error) { for (const id of created.assetIds) await assets.remove(OWNER, id).catch(() => {}); throw error; }
    });
  }
  function rollbackImport(created) {
    return serialized(async () => {
      if (!object(created)) throw fail(400, '素材导入回滚记录不正确。');
      const characterIds = new Set((created.characterIds || []).map(id => identifier(id, '人物'))), backgroundIds = new Set((created.backgroundIds || []).map(id => identifier(id, '场景')));
      for (const [kind, ids] of [['characters', characterIds], ['backgrounds', backgroundIds]]) for (const id of ids) if (await profileUsed(id, kind)) throw fail(409, '导入的素材已被项目使用，无法撤回。', 'NOVEL_LIBRARY_IN_USE');
      await persist({ ...state, characters: state.characters.filter(item => !characterIds.has(item.id)), backgrounds: state.backgrounds.filter(item => !backgroundIds.has(item.id)) });
      for (const id of created.assetIds || []) await assets.remove(OWNER, identifier(id, '图片'));
      return { removed: true };
    });
  }
  async function handler(req, res, url, { signal } = {}) {
    const match = url.pathname.match(/^\/api\/novel-library(?:\/(characters|backgrounds|assets|resolve)(?:\/([^/]+)(?:\/(file))?)?)?\/?$/);
    if (!match) return false;
    const [, kind, rawId, action] = match; let id;
    try { id = rawId && decodeURIComponent(rawId); } catch { throw fail(400, '公用素材编号不正确。'); }
    if (!kind && req.method === 'GET') { json(res, 200, await list()); return true; }
    if (kind === 'assets' && id && action === 'file' && ['GET', 'HEAD'].includes(req.method)) { const value = await assets.file(OWNER, id); res.writeHead(200, { 'content-type': value.contentType, 'content-length': value.bytes.length, 'cache-control': 'private, no-cache', 'x-content-type-options': 'nosniff', etag: '"' + value.metadata.sha256 + '"' }); res.end(req.method === 'HEAD' ? undefined : value.bytes); return true; }
    if (kind === 'assets' && id && !action && id !== 'upload' && req.method === 'DELETE') { json(res, 200, await removeAsset(id)); return true; }
    if (['characters', 'backgrounds'].includes(kind) && id && !action && req.method === 'DELETE') { json(res, 200, await removeProfile(kind, id, url.searchParams.has('expectedRevision') ? { expectedRevision: url.searchParams.get('expectedRevision') } : {})); return true; }
    if (req.method === 'POST' && !action && ((['characters', 'backgrounds', 'resolve'].includes(kind) && !id) || (kind === 'assets' && id === 'upload'))) {
      const controller = new AbortController(), aborted = () => { if (!res.writableEnded) controller.abort(); }; controllers.add(controller); res.once('close', aborted);
      try {
        const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
        if (kind === 'assets') {
          if (!/^application\/octet-stream(?:;|$)/i.test(req.headers['content-type'] || '')) throw fail(415, '请使用图片文件上传。', 'NOVEL_ASSET_CONTENT_TYPE');
          if (Number(req.headers['content-length']) > LIMITS.assetBytes) { req.resume(); throw fail(413, '每张图片需在12MB以内。', 'NOVEL_ASSET_SIZE'); }
          let name; try { name = decodeURIComponent(req.headers['x-file-name'] || ''); } catch { throw fail(400, '图片名称无效。', 'NOVEL_ASSET_NAME'); }
          const bytes = await readBody(req, combined, LIMITS.assetBytes);
          json(res, 201, await importBytes(bytes, { name, kind: req.headers['x-asset-kind'], signal: combined }));
        } else {
          if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw fail(415, '请使用JSON提交素材资料。', 'NOVEL_LIBRARY_CONTENT_TYPE');
          let body; try { body = JSON.parse((await readBody(req, combined, 128 * 1024)).toString('utf8')); } catch (error) { if (error instanceof AppError) throw error; throw fail(400, '素材资料JSON格式不正确。'); }
          json(res, 200, kind === 'resolve' ? await resolveSelection(body, { signal: combined }) : await saveProfile(kind, body, object(body) && Object.hasOwn(body, 'expectedRevision') ? { expectedRevision: body.expectedRevision } : {}));
        }
        return true;
      } finally { controllers.delete(controller); res.removeListener('close', aborted); }
    }
    throw fail(405, '公用素材库不支持此操作。', 'METHOD_NOT_ALLOWED');
  }
  return { list, context: list, saveCharacter: (input, options) => saveProfile('characters', input, options), saveBackground: (input, options) => saveProfile('backgrounds', input, options), removeCharacter: (id, options) => removeProfile('characters', id, options), removeBackground: (id, options) => removeProfile('backgrounds', id, options), restoreAssistant, importBytes, file: id => assets.file(OWNER, id), removeAsset, resolveSelection, exportSelection, importSelection, rollbackImport, handler: (...args) => tracked(handler(...args)), async close() { closed = true; for (const controller of controllers) controller.abort(); await assets.close(); await Promise.allSettled([...operations]); } };
}
