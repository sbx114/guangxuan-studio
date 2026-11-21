import path from 'node:path';
import { mkdir, lstat, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { AppError, boundedString, requireObject } from './errors.mjs';
import { validateProjectId } from './store.mjs';
import { normalizeTimeRange, formatTimeRange, MAX_TIME_SECONDS } from '../public/time-range.js';

const MAX_ITEMS = 8;
const MAX_IMAGES = 12;
const MAX_INDEX_BYTES = 1024 * 1024;
const REFERENCE_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ASSET_ID = /^[a-zA-Z0-9_-]{12,80}$/;
const TYPES = new Set(['video', 'image', 'text']);
const itemKeys = new Set(['type', 'assetId', 'name', 'text', 'focus', 'sourceUrl', 'aspects', 'sourceRange', 'targetRange']);
const patchKeys = new Set(['name', 'text', 'focus', 'sourceUrl', 'aspects', 'sourceRange', 'targetRange']);
const ASPECTS = new Set(['style', 'editing', 'color', 'composition', 'titles', 'structure']);
const DEFAULT_ASPECTS = { video: ['style', 'editing'], image: ['style', 'color'], text: ['structure'] };
const own = (value, key) => Object.hasOwn(value, key);
const invalidStorage = () => new AppError(500, '参考记录无法读取，原文件已保留。', 'REFERENCE_READ_FAILED');
export const referenceContentHash = value => createHash('sha256').update(JSON.stringify([value.items, value.includeImages])).digest('hex');

function aspects(value, fallback = []) {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.length > 6 || new Set(value).size !== value.length || value.some(item => !ASPECTS.has(item))) throw new AppError(400, '请选择不重复的有效参考维度。', 'INVALID_REFERENCE_ASPECTS');
  return [...value];
}

function referenceId(value) {
  if (typeof value !== 'string' || !REFERENCE_ID.test(value)) throw new AppError(400, '参考编号不正确。', 'INVALID_REFERENCE_ID');
  return value;
}
function assetId(value) {
  if (typeof value !== 'string' || !ASSET_ID.test(value)) throw new AppError(400, '参考素材编号不正确。', 'INVALID_REFERENCE_ASSET');
  return value;
}
function sourceUrl(value) {
  const text = boundedString(value, '参考来源链接', 2000, { optional: true });
  if (!text) return '';
  let url;
  try { url = new URL(text); } catch { throw new AppError(400, '参考来源需要有效的HTTP或HTTPS链接。', 'INVALID_REFERENCE_URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new AppError(400, '参考来源仅支持不含账号密码的HTTP或HTTPS链接。', 'INVALID_REFERENCE_URL');
  if (url.href.length > 2000) throw new AppError(400, '参考来源链接过长。', 'INPUT_TOO_LARGE');
  return url.href;
}
function fields(input, allowed) {
  requireObject(input, '参考资料');
  if (Object.keys(input).some(key => !allowed.has(key))) throw new AppError(400, '参考资料含不支持的字段。', 'INVALID_REFERENCE_FIELDS');
}
function referenceRange(value, label, duration) {
  try { return normalizeTimeRange(value, { label, duration }); }
  catch (error) { throw new AppError(400, error.message, 'INVALID_REFERENCE_RANGE'); }
}
function checkedAsset(asset, type) {
  if (!asset || !['image', 'video'].includes(asset.type) || asset.type !== type) throw new AppError(415, '参考素材类型不符，仅支持图片和视频。', 'INVALID_REFERENCE_MEDIA');
  const limit = (asset.type === 'image' ? 20 : 200) * 1024 * 1024;
  if (!Number.isFinite(asset.size) || asset.size <= 0 || asset.size > limit) throw new AppError(413, asset.type === 'image' ? '参考图片不能超过20MB。' : '参考视频不能超过200MB。', 'REFERENCE_MEDIA_TOO_LARGE');
  if (asset.type === 'video' && (!Number.isFinite(asset.duration) || asset.duration <= 0 || asset.duration > MAX_TIME_SECONDS)) throw new AppError(422, '参考视频时长无效，请重新导入。', 'INVALID_REFERENCE_DURATION');
  return asset;
}
function storedItem(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !TYPES.has(input.type)) throw invalidStorage();
  const item = {
    id: referenceId(input.id), type: input.type,
    name: boundedString(input.name, '参考名称', 120),
    focus: boundedString(input.focus, '参考重点', 1500, { optional: true }),
    aspects: aspects(input.aspects),
    createdAt: boundedString(input.createdAt, '参考创建时间', 50),
    updatedAt: boundedString(input.updatedAt, '参考更新时间', 50),
  };
  if (!Number.isFinite(Date.parse(item.createdAt)) || !Number.isFinite(Date.parse(item.updatedAt))) throw invalidStorage();
  if (item.type === 'text') item.text = boundedString(input.text, '参考文字', 12000);
  else item.assetId = assetId(input.assetId);
  if (input.sourceRange != null) {
    if (item.type !== 'video') throw invalidStorage();
    item.sourceRange = referenceRange(input.sourceRange, '参照片段');
  }
  if (input.targetRange != null) item.targetRange = referenceRange(input.targetRange, '作品应用区间');
  const url = sourceUrl(input.sourceUrl); if (url) item.sourceUrl = url;
  return item;
}

/** References live outside project JSON, so an older editing autosave cannot erase them. */
export async function createReferenceService({ dataDir, store, videoService } = {}) {
  if (!dataDir || !store?.read) throw new AppError(500, '参考资料存储未配置。', 'REFERENCE_STORAGE_UNAVAILABLE');
  const requestedRoot = path.resolve(dataDir, 'references');
  await mkdir(requestedRoot, { recursive: true });
  if ((await lstat(requestedRoot)).isSymbolicLink()) throw invalidStorage();
  const root = await realpath(requestedRoot);
  const queues = new Map(), contexts = new Set();
  let closing = false;
  const comparable = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const open = () => { if (closing) throw new AppError(503, '参考资料服务正在关闭。', 'REFERENCE_SERVICE_CLOSED'); };
  async function project(id, expectedCreatedAt) {
    open(); validateProjectId(id);
    const value = await store.read(id);
    if (!value) throw new AppError(404, '项目已不存在，参考资料未保存。', 'PROJECT_NOT_FOUND');
    if (value.kind !== 'video') throw new AppError(400, '参考资料仅用于视频项目。', 'REFERENCE_PROJECT_REQUIRED');
    if (expectedCreatedAt !== undefined && value.createdAt !== expectedCreatedAt) throw new AppError(409, '项目已重新创建，请重新打开后添加参考。', 'REFERENCE_PROJECT_CHANGED');
    return value;
  }
  const empty = value => ({ version: 1, projectCreatedAt: value.createdAt, items: [], revision: 0, includeImages: true });
  const publicState = value => ({ items: structuredClone(value.items), revision: value.revision, includeImages: value.includeImages });
  async function directory(id, create = false) {
    const candidate = path.join(root, validateProjectId(id));
    let info;
    try { info = await lstat(candidate); }
    catch (error) {
      if (error.code !== 'ENOENT') throw invalidStorage();
      if (!create) return null;
      await mkdir(candidate).catch(error => { if (error.code !== 'EEXIST') throw error; });
      info = await lstat(candidate);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw invalidStorage();
    const actual = await realpath(candidate);
    if (comparable(path.dirname(actual)) !== comparable(root)) throw invalidStorage();
    return actual;
  }
  async function read(id, value) {
    const folder = await directory(id); if (!folder) return empty(value);
    const filename = path.join(folder, 'index.json');
    try {
      const info = await lstat(filename);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_INDEX_BYTES) throw invalidStorage();
      const text = await readFile(filename, 'utf8');
      if (Buffer.byteLength(text) > MAX_INDEX_BYTES) throw invalidStorage();
      const state = JSON.parse(text);
      if (state.version !== 1 || !Array.isArray(state.items) || state.items.length > MAX_ITEMS || !Number.isSafeInteger(state.revision) || state.revision < 0 || typeof state.includeImages !== 'boolean') throw invalidStorage();
      // Reusing an old ID must not attach a deleted project's references to a new project.
      if (state.projectCreatedAt !== value.createdAt) return empty(value);
      state.items = state.items.map(storedItem);
      if (new Set(state.items.map(item => item.id)).size !== state.items.length) throw invalidStorage();
      return state;
    } catch (error) { if (error.code === 'ENOENT') return empty(value); throw invalidStorage(); }
  }
  async function write(id, state, expectedCreatedAt) {
    await project(id, expectedCreatedAt);
    const folder = await directory(id, true);
    const filename = path.join(folder, 'index.json'), temporary = path.join(folder, `.${randomUUID()}.tmp`);
    const text = JSON.stringify(state, null, 2);
    if (Buffer.byteLength(text) > MAX_INDEX_BYTES) throw new AppError(413, '参考资料过大，请精简文字。', 'REFERENCE_RECORD_TOO_LARGE');
    let published = false;
    try {
      await project(id, expectedCreatedAt);
      await writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
      await project(id, expectedCreatedAt);
      await rename(temporary, filename); published = true;
      await project(id, expectedCreatedAt);
      return publicState(state);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      if (published && ['PROJECT_NOT_FOUND', 'REFERENCE_PROJECT_CHANGED'].includes(error.code)) {
        // Do not leave a late completed update behind after the project was deleted.
        if (await readFile(filename, 'utf8').catch(() => '') === text) await unlink(filename).catch(() => {});
      }
      if (error instanceof AppError) throw error;
      throw new AppError(500, '参考资料保存失败，请重试。', 'REFERENCE_WRITE_FAILED');
    }
  }
  function serial(id, operation, { expectedRevision, expectedCreatedAt, expectedContentHash } = {}) {
    validateProjectId(id); open();
    const next = (queues.get(id) || Promise.resolve()).catch(() => {}).then(async () => {
      const value = await project(id);
      const state = await read(id, value);
      if (expectedCreatedAt !== undefined && value.createdAt !== expectedCreatedAt || expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision !== state.revision) || expectedContentHash !== undefined && expectedContentHash !== referenceContentHash(state)) throw new AppError(409, '项目参考资料已经变化，请读取最新版本后再修改。', 'REFERENCE_REVISION_CONFLICT');
      return operation(state, value);
    });
    queues.set(id, next);
    next.finally(() => { if (queues.get(id) === next) queues.delete(id); }).catch(() => {});
    return next;
  }
  async function media(id, type) {
    if (!videoService?.resolveAsset) throw new AppError(503, '媒体库尚未就绪。', 'MEDIA_LIBRARY_UNAVAILABLE');
    const key = assetId(id), asset = await videoService.resolveAsset(key);
    if (asset?.id !== key) throw new AppError(404, '参考素材不存在，请重新导入。', 'INVALID_REFERENCE_ASSET');
    return checkedAsset(asset, type);
  }
  async function list(id) {
    validateProjectId(id); open();
    await queues.get(id)?.catch(() => {});
    const value = await project(id);
    return publicState(await read(id, value));
  }
  return {
    list,
    add(id, input, options) {
      fields(input, itemKeys);
      if (!TYPES.has(input.type)) throw new AppError(400, '请选择视频、图片或文字参考。', 'INVALID_REFERENCE_TYPE');
      return serial(id, async (state, value) => {
        if (state.items.length >= MAX_ITEMS) throw new AppError(400, '每个项目最多保存8项参考。', 'REFERENCE_LIMIT');
        const now = new Date().toISOString();
        const item = { id: randomUUID(), type: input.type, name: boundedString(input.name, '参考名称', 120, { optional: true }), focus: boundedString(input.focus, '参考重点', 1500, { optional: true }), aspects: aspects(input.aspects, DEFAULT_ASPECTS[input.type]), createdAt: now, updatedAt: now };
        let selectedAsset;
        if (item.type === 'text') {
          if (input.assetId) throw new AppError(400, '文字参考不能绑定媒体文件。', 'INVALID_REFERENCE_FIELDS');
          item.text = boundedString(input.text, '参考文字', 12000);
          item.name ||= '文字参考';
        } else {
          if (input.text) throw new AppError(400, '媒体参考请将说明填写在参考重点中。', 'INVALID_REFERENCE_FIELDS');
          const asset = selectedAsset = await media(input.assetId, item.type);
          item.assetId = asset.id;
          item.name ||= String(asset.name || (item.type === 'image' ? '图片参考' : '视频参考')).slice(0, 120);
        }
        const source = referenceRange(input.sourceRange, '参照片段', selectedAsset?.duration);
        if (source && item.type !== 'video') throw new AppError(400, '只有视频参考需要指定参照片段。', 'INVALID_REFERENCE_RANGE');
        if (source) item.sourceRange = source;
        const target = referenceRange(input.targetRange, '作品应用区间');
        if (target) item.targetRange = target;
        const url = sourceUrl(input.sourceUrl); if (url) item.sourceUrl = url;
        state.items.push(item); state.revision++;
        return write(id, state, value.createdAt);
      }, options);
    },
    update(id, reference, patch, options) {
      referenceId(reference); fields(patch, patchKeys);
      if (!Object.keys(patch).length) throw new AppError(400, '请填写要修改的参考资料。', 'INVALID_REFERENCE_FIELDS');
      return serial(id, async (state, value) => {
        const item = state.items.find(item => item.id === reference);
        if (!item) throw new AppError(404, '参考资料不存在。', 'REFERENCE_NOT_FOUND');
        if (own(patch, 'name')) item.name = boundedString(patch.name, '参考名称', 120);
        if (own(patch, 'focus')) item.focus = boundedString(patch.focus, '参考重点', 1500, { optional: true });
        if (own(patch, 'aspects')) item.aspects = aspects(patch.aspects);
        if (own(patch, 'sourceRange')) {
          if (patch.sourceRange != null && item.type !== 'video') throw new AppError(400, '只有视频参考需要指定参照片段。', 'INVALID_REFERENCE_RANGE');
          const range = referenceRange(patch.sourceRange, '参照片段', item.type === 'video' && patch.sourceRange != null ? (await media(item.assetId, item.type)).duration : undefined);
          if (range) item.sourceRange = range; else delete item.sourceRange;
        }
        if (own(patch, 'targetRange')) {
          const range = referenceRange(patch.targetRange, '作品应用区间');
          if (range) item.targetRange = range; else delete item.targetRange;
        }
        if (own(patch, 'text')) {
          if (item.type !== 'text') throw new AppError(400, '媒体参考不能修改为文字参考。', 'INVALID_REFERENCE_FIELDS');
          item.text = boundedString(patch.text, '参考文字', 12000);
        }
        if (own(patch, 'sourceUrl')) { const url = sourceUrl(patch.sourceUrl); if (url) item.sourceUrl = url; else delete item.sourceUrl; }
        item.updatedAt = new Date().toISOString(); state.revision++;
        return write(id, state, value.createdAt);
      }, options);
    },
    remove(id, reference, options) {
      referenceId(reference);
      return serial(id, async (state, value) => {
        const filtered = state.items.filter(item => item.id !== reference);
        if (filtered.length === state.items.length) return publicState(state);
        state.items = filtered; state.revision++;
        // Removing a reference never deletes a media file that another project may use.
        return write(id, state, value.createdAt);
      }, options);
    },
    configure(id, input, options) {
      fields(input, new Set(['includeImages']));
      if (typeof input.includeImages !== 'boolean') throw new AppError(400, '请选择是否发送参考画面。', 'INVALID_REFERENCE_CONFIGURATION');
      return serial(id, async (state, value) => {
        state.includeImages = input.includeImages; state.revision++;
        return write(id, state, value.createdAt);
      }, options);
    },
    restoreAssistant(id, snapshot, options = {}) {
      requireObject(snapshot, '参考撤销记录');
      if (!(Number.isSafeInteger(options.expectedRevision) || typeof options.expectedContentHash === 'string' && /^[a-f0-9]{64}$/.test(options.expectedContentHash)) || typeof options.expectedCreatedAt !== 'string' || !Array.isArray(snapshot.items) || snapshot.items.length > MAX_ITEMS || typeof snapshot.includeImages !== 'boolean') throw new AppError(400, '参考撤销记录无效。', 'INVALID_REFERENCE_RESTORE');
      const restored = snapshot.items.map(storedItem);
      if (new Set(restored.map(item => item.id)).size !== restored.length) throw new AppError(400, '参考撤销记录含重复编号。', 'INVALID_REFERENCE_RESTORE');
      return serial(id, async (state, value) => {
        for (const item of restored) if (item.type !== 'text') await media(item.assetId, item.type);
        state.items = restored; state.includeImages = snapshot.includeImages; state.revision++;
        return write(id, state, value.createdAt);
      }, options);
    },
    async context(id, { signal } = {}) {
      const controller = new AbortController(); contexts.add(controller);
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const check = () => { if (combined.aborted) throw new AppError(499, '参考资料处理已取消。', 'REFERENCE_CANCELLED'); open(); };
      try {
        check(); const owner = await project(id); const state = await list(id); check();
        const counts = new Map(state.items.filter(item => item.type !== 'text').map(item => [item.id, 1]));
        let remaining = MAX_IMAGES - counts.size;
        for (let pass = 0; pass < 2; pass++) for (const item of state.items) {
          if (item.type === 'video' && remaining > 0) { counts.set(item.id, counts.get(item.id) + 1); remaining--; }
        }
        const items = [], images = [];
        for (const item of state.items) {
          check();
          const description = { id: item.id, type: item.type, name: item.name, focus: item.focus, aspects: [...item.aspects], ...(item.sourceUrl ? { sourceUrl: item.sourceUrl } : {}), ...(item.sourceRange ? { sourceRange: { ...item.sourceRange } } : {}), ...(item.targetRange ? { targetRange: { ...item.targetRange } } : {}), binding: `${formatTimeRange(item.sourceRange, item.type === 'video' ? '整个参考视频' : '此项参考')} → 作品${formatTimeRange(item.targetRange)}`, frames: [] };
          if (item.type === 'text') description.text = item.text;
          else {
            const asset = await media(item.assetId, item.type); check();
            if (item.sourceRange) referenceRange(item.sourceRange, '参照片段', asset.duration);
            if (Number.isFinite(asset.width) && asset.width > 0) description.width = asset.width;
            if (Number.isFinite(asset.height) && asset.height > 0) description.height = asset.height;
            if (item.type === 'video') description.duration = asset.duration;
            if (state.includeImages) {
              if (!videoService?.referenceFrames) throw new AppError(503, '参考画面处理尚未就绪。', 'REFERENCE_FRAMES_UNAVAILABLE');
              const frames = await videoService.referenceFrames(item.assetId, { signal: combined, count: counts.get(item.id), ...(item.sourceRange ? { range: item.sourceRange } : {}) }); check();
              if (!Array.isArray(frames) || !frames.length || frames.length > counts.get(item.id)) throw new AppError(422, '参考画面数量无效，请重新导入。', 'REFERENCE_FRAME_FAILED');
              for (const frame of frames) {
                if (typeof frame.dataUrl !== 'string' || frame.dataUrl.length > 3 * 1024 * 1024 || !/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(frame.dataUrl)) throw new AppError(422, '参考画面无法读取，请重新导入。', 'REFERENCE_FRAME_FAILED');
                const timestamp = item.type === 'video' && Number.isFinite(frame.timestamp) && frame.timestamp >= 0 && frame.timestamp <= asset.duration ? frame.timestamp : undefined;
                if (item.sourceRange && (timestamp === undefined || timestamp < item.sourceRange.start || timestamp > item.sourceRange.end)) throw new AppError(422, '参考画面超出所选片段，请重新选择区间。', 'REFERENCE_FRAME_OUTSIDE_RANGE');
                const label = `${item.name}${timestamp === undefined ? '' : ` · ${timestamp.toFixed(2)}秒`}${item.targetRange ? ` · 仅参考于作品${formatTimeRange(item.targetRange)}` : ''}`;
                const details = { label, ...(timestamp === undefined ? {} : { timestamp }) };
                description.frames.push(details);
                images.push({ dataUrl: frame.dataUrl, label, referenceId: item.id, ...(timestamp === undefined ? {} : { timestamp }) });
              }
            }
          }
          items.push(description);
        }
        check(); await project(id, owner.createdAt); check();
        return { references: { includeImages: state.includeImages, items }, images };
      } catch (error) {
        if (combined.aborted) throw new AppError(499, '参考资料处理已取消。', 'REFERENCE_CANCELLED');
        throw error;
      } finally { contexts.delete(controller); }
    },
    async close() {
      closing = true;
      for (const controller of contexts) controller.abort();
      await Promise.allSettled([...queues.values()]);
    },
  };
}
