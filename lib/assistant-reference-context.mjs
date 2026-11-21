import { createHash } from 'node:crypto';
import { AppError } from './errors.mjs';
import { validateProjectId } from './store.mjs';

const SHA = /^[a-f0-9]{64}$/;
const INSPECTION = /^[a-f0-9-]{36}$/;
const TEXT_FIELDS = ['description', 'visibleText', 'layout', 'motion'];
const MAX_INSPECTIONS = 256, MAX_NOTES = 12, MAX_TEXT = 2000, MAX_BATCH_TEXT = 24000, MAX_IMAGES = 12, MAX_IMAGE_BYTES = 8 * 1024 * 1024;
// This is an in-process capability, not a JSON/HTTP import contract. Only an
// original frozen object returned by export() is accepted by another instance.
const EXPORTED_METADATA = new WeakMap();
const fail = (status, message, code) => new AppError(status, message, 'ASSISTANT_REFERENCE_' + code);
const check = signal => { if (signal?.aborted) throw fail(499, '参考画面处理已停止。', 'CANCELLED'); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);
const key = (projectId, inspectionId) => projectId + ':' + inspectionId;
const integer = (value, fallback, min, max, label) => {
  const number = value === undefined ? fallback : value;
  if (!Number.isInteger(number) || number < min || number > max) throw fail(400, label + '不在有效范围内。', 'OPTIONS');
  return number;
};
const sameTime = (a, b) => a === undefined && b === undefined || Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < .000001;
const byTime = (a, b) => a.assetId.localeCompare(b.assetId) || (a.timestamp ?? 0) - (b.timestamp ?? 0) || a.frameIndex - b.frameIndex;
const frameKey = frame => `${frame.assetId}:${frame.sourceVersion}:${frame.timestamp ?? 'image'}:${frame.sha256}`;
const frameIdentity = frame => `${frame.inspectionId}:${frame.frameIndex}`;
const pickSpread = (items, count) => count >= items.length ? items.slice() : Array.from({ length: count }, (_, index) => items[count === 1 ? Math.floor((items.length - 1) / 2) : Math.round(index * (items.length - 1) / (count - 1))]);

export const ASSISTANT_REFERENCE_LIMITS = Object.freeze({ maxNotesPerBatch: MAX_NOTES, maxTextCharacters: MAX_TEXT, maxBatchTextCharacters: MAX_BATCH_TEXT, maxStoredInspections: MAX_INSPECTIONS, maxImages: MAX_IMAGES, maxImageEncodedBytes: MAX_IMAGE_BYTES, defaultSnapshotNotes: 120, defaultSnapshotTextCharacters: 60000 });
export const ASSISTANT_REFERENCE_CACHE_LIMITS = Object.freeze({ version: 1, metadataOnly: true, persistent: false, sameProcessOnly: true });
export const ASSISTANT_FRAME_NOTES_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['inspectionId', 'notes'], properties: {
    inspectionId: { type: 'string', minLength: 36, maxLength: 36 },
    notes: { type: 'array', minItems: 1, maxItems: MAX_NOTES, items: {
      type: 'object', additionalProperties: false, required: ['frameIndex', 'description'], properties: {
        frameIndex: { type: 'integer', minimum: 1, maximum: 100000 },
        ...Object.fromEntries(TEXT_FIELDS.map(field => [field, { type: 'string', maxLength: MAX_TEXT, ...(field === 'description' ? { minLength: 1 } : {}) }])),
      },
    } },
  },
};

function notesOf(input) {
  if (!object(input) || Object.keys(input).some(field => !['inspectionId', 'notes'].includes(field)) || !INSPECTION.test(input.inspectionId || '')) throw fail(400, '请使用实际画面读取返回的inspectionId。', 'NOTES_INPUT');
  if (!Array.isArray(input.notes) || !input.notes.length || input.notes.length > MAX_NOTES) throw fail(400, '每批登记1至12帧的描述。', 'NOTES_INPUT');
  const seen = new Set(); let characters = 0;
  const notes = input.notes.map(note => {
    if (!object(note) || Object.keys(note).some(field => !['frameIndex', ...TEXT_FIELDS].includes(field))) throw fail(400, '画面描述包含不支持的字段。', 'NOTES_INPUT');
    const frameIndex = integer(note.frameIndex, undefined, 1, 100000, '画面编号');
    if (seen.has(frameIndex)) throw fail(400, '同批画面编号不能重复。', 'NOTES_INPUT'); seen.add(frameIndex);
    const result = { frameIndex };
    for (const field of TEXT_FIELDS) {
      if (note[field] === undefined && field !== 'description') continue;
      if (typeof note[field] !== 'string' || note[field].length > MAX_TEXT || /\0/.test(note[field]) || field === 'description' && !note[field].trim()) throw fail(400, '每项画面文字须为2000字以内的纯文字。', 'NOTES_INPUT');
      result[field] = note[field].trim(); characters += note[field].length;
    }
    return result;
  });
  if (characters > MAX_BATCH_TEXT) throw fail(400, '本批画面描述超过24000字。', 'NOTES_INPUT');
  return notes;
}

function assetFilter(value) {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length > MAX_INSPECTIONS || new Set(value).size !== value.length || value.some(id => typeof id !== 'string' || !id || id.length > 128)) throw fail(400, '缓存素材范围无效。', 'CACHE_OPTIONS');
  return new Set(value);
}
function freezeMetadata(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freezeMetadata(child); Object.freeze(value); }
  return value;
}
function metadataRecord(item) {
  return clone({ projectId: item.projectId, inspectionId: item.inspectionId, asset: item.asset, frames: item.frames, shots: item.shots, coverage: item.coverage, pagination: item.pagination, notes: item.notes });
}

function verifiedPage(result, { assetId, inspectionId } = {}) {
  const data = result?.data, asset = data?.asset;
  if (!object(data) || !object(asset) || !INSPECTION.test(data.inspectionId || '') || inspectionId !== undefined && data.inspectionId !== inspectionId || assetId !== undefined && asset.id !== assetId || typeof asset.id !== 'string' || !SHA.test(asset.sourceVersion || '') || !SHA.test(data.ownerVersion || '') || !['image', 'video'].includes(asset.type) || !Array.isArray(data.frames) || !data.frames.length || data.frames.length > MAX_IMAGES || !Array.isArray(result.images)) throw fail(422, '画面服务未返回可核对的真实凭据。', 'RECEIPT_INVALID');
  const frames = [], seen = new Set(), images = new Map();
  for (const frame of data.frames) {
    if (!object(frame) || !Number.isInteger(frame.index) || frame.index < 1 || seen.has(frame.index) || !SHA.test(frame.sha256 || '') || asset.type === 'video' && (!Number.isFinite(frame.timestamp) || frame.timestamp < 0 || !Number.isFinite(asset.duration) || frame.timestamp > asset.duration)) throw fail(422, '画面凭据的编号或时刻无效。', 'RECEIPT_INVALID');
    seen.add(frame.index);
    const found = result.images.find(image => image?.index === frame.index && image.sha256 === frame.sha256 && sameTime(image.timestamp, frame.timestamp));
    const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(found?.dataUrl || '');
    if (!match || found.dataUrl.length > 2 * 1024 * 1024) throw fail(422, '真实画面图片与凭据不一致。', 'RECEIPT_INVALID');
    const bytes = Buffer.from(match[2], 'base64');
    if (!bytes.length || bytes.toString('base64') !== match[2] || hash(bytes) !== frame.sha256) throw fail(422, '真实画面图片与凭据不一致。', 'RECEIPT_INVALID');
    frames.push({ index: frame.index, ...(Number.isFinite(frame.timestamp) ? { timestamp: frame.timestamp } : {}), ...(Number.isFinite(frame.requestedTimestamp) ? { requestedTimestamp: frame.requestedTimestamp } : {}), ...(frame.seekAdjusted === true ? { seekAdjusted: true } : {}), timestampKind: frame.timestampKind === 'seek-position' ? 'seek-position' : 'image', sha256: frame.sha256 });
    images.set(frame.index, { dataUrl: found.dataUrl, detail: 'high' });
  }
  const range = value => object(value) && Number.isFinite(value.start) && Number.isFinite(value.end) && value.start >= 0 && value.end >= value.start ? { start: value.start, end: value.end } : undefined;
  const pagination = {};
  for (const field of ['planId', 'mode', 'offset', 'nextOffset', 'hasMore', 'totalFrames', 'pageSize', 'windowIndex', 'nextWindowIndex', 'nextWindowOffset']) {
    const value = data.pagination?.[field];
    if (['planId', 'mode'].includes(field) && typeof value === 'string' && value.length <= 100 || field === 'hasMore' && typeof value === 'boolean' || value === null || Number.isInteger(value) && value >= 0) pagination[field] = value;
  }
  const shots = (Array.isArray(data.shots) ? data.shots : []).filter(shot => object(shot) && Number.isFinite(shot.start) && Number.isFinite(shot.end) && shot.start >= 0 && shot.end > shot.start).map(shot => ({ id: String(shot.id || '').slice(0, 100), start: shot.start, end: shot.end, boundary: String(shot.boundary || 'estimated').slice(0, 30), ...(Number.isFinite(shot.timestamp) ? { timestamp: shot.timestamp } : {}) }));
  return {
    inspectionId: data.inspectionId,
    asset: { id: asset.id, name: typeof asset.name === 'string' ? asset.name.slice(0, 240) : '', type: asset.type, ...(Number.isFinite(asset.duration) ? { duration: asset.duration } : {}), ...(Number.isFinite(asset.width) ? { width: asset.width } : {}), ...(Number.isFinite(asset.height) ? { height: asset.height } : {}), sourceVersion: asset.sourceVersion, ownerVersion: data.ownerVersion, ...(asset.registration && typeof asset.registration.nativeImported === 'boolean' && Array.isArray(asset.registration.referenceIds) ? { registration: { nativeImported: asset.registration.nativeImported, referenceIds: asset.registration.referenceIds.filter(id => typeof id === 'string').map(id => id.slice(0, 100)) } } : {}) },
    frames, shots, images, pagination,
    coverage: { ...(range(data.coverage?.requestedRange) ? { requestedRange: range(data.coverage.requestedRange) } : {}), ...(range(data.coverage?.actualRange) ? { actualRange: range(data.coverage.actualRange) } : {}), sourceDuration: Number.isFinite(asset.duration) ? asset.duration : null, timestamps: frames.flatMap(frame => frame.timestamp === undefined ? [] : [frame.timestamp]), frameCount: frames.length, pageComplete: data.coverage?.pageComplete === true, planComplete: data.coverage?.planComplete === true, frameByFrame: false },
  };
}

function mergedCoverage(records, notes, includedNotes, selectedImages) {
  const assets = new Map(), sampled = new Set(), annotated = new Set(notes.map(frameKey));
  for (const record of records) {
    let item = assets.get(record.asset.id);
    if (!item) { item = { assetId: record.asset.id, sourceDuration: record.asset.duration ?? null, timestamps: new Set(), frames: new Set(), requestedRanges: [], plans: new Map() }; assets.set(record.asset.id, item); }
    if (record.coverage.requestedRange && !item.requestedRanges.some(range => range.start === record.coverage.requestedRange.start && range.end === record.coverage.requestedRange.end)) item.requestedRanges.push(record.coverage.requestedRange);
    const planId = SHA.test(record.pagination.planId || '') ? record.pagination.planId : null, planKey = planId || record.inspectionId;
    let plan = item.plans.get(planKey);
    if (!plan) { plan = { planId, mode: record.pagination.mode || 'unknown', plannedFrameCount: Number.isInteger(record.pagination.totalFrames) ? record.pagination.totalFrames : record.frames.length, sampledPlanIndices: new Set(), inspectionIds: [], ...(record.pagination.windowIndex !== undefined ? { windowIndex: record.pagination.windowIndex } : {}), ...(record.pagination.nextWindowIndex !== undefined ? { nextWindowIndex: record.pagination.nextWindowIndex } : {}) }; item.plans.set(planKey, plan); }
    plan.inspectionIds.push(record.inspectionId);
    for (const frame of record.frames) {
      const id = frameKey({ ...frame, assetId: record.asset.id, sourceVersion: record.asset.sourceVersion }); item.frames.add(id); sampled.add(id);
      if (frame.timestamp !== undefined) item.timestamps.add(frame.timestamp);
      plan.sampledPlanIndices.add(frame.index);
    }
  }
  return {
    inspectionCount: records.length, sampledFrameCount: sampled.size, noteCount: notes.length, annotatedFrameCount: annotated.size, includedNoteCount: includedNotes.length, omittedNoteCount: notes.length - includedNotes.length,
    unannotatedFrameCount: Math.max(0, sampled.size - annotated.size), imageCount: selectedImages.length, omittedImageFrameCount: Math.max(0, sampled.size - selectedImages.length), frameByFrame: false,
    assets: [...assets.values()].map(item => {
      const timestamps = [...item.timestamps].sort((a, b) => a - b);
      return { assetId: item.assetId, sourceDuration: item.sourceDuration, timestamps, requestedRanges: item.requestedRanges, ...(timestamps.length ? { observedTimestampRange: { start: timestamps[0], end: timestamps.at(-1) } } : {}), sampledFrameCount: item.frames.size,
        plans: [...item.plans.values()].map(plan => { const indices = [...plan.sampledPlanIndices].sort((a, b) => a - b), contiguous = indices.length === plan.plannedFrameCount && indices.every((value, i) => value === i + 1); return { ...plan, sampledPlanIndices: indices, unsampledPlannedFrameCount: Math.max(0, plan.plannedFrameCount - indices.length), samplingPlanComplete: contiguous, stablePlanIdentity: Boolean(plan.planId) }; }),
      };
    }),
    limitations: ['画面是所列时刻的离散抽样，不代表完整逐帧观看；首尾时刻之间未逐帧核对。', 'notes是助手针对真实帧的分析描述，可能误读；不是人工事实校对，也未识别未转写音频。', '生成模型只收到selectedImageFrames中的实际图片；其余画面只通过已登记描述传递。'],
  };
}

/** Stores descriptions of server-verified pictures, never model-provided images, paths or coverage. */
export function createAssistantReferenceContext({ frameReader } = {}) {
  if (typeof frameReader?.read !== 'function' || typeof frameReader?.receipt !== 'function') throw new TypeError('Reference context requires the trusted frame reader.');
  const records = new Map(); let closed = false;
  const ready = signal => { check(signal); if (closed) throw fail(503, '参考画面服务已关闭。', 'CLOSED'); };
  async function record(projectId, input, { origin, signal } = {}) {
    validateProjectId(projectId); ready(signal); const notes = notesOf(input);
    const page = verifiedPage(await frameReader.receipt(input.inspectionId, { projectId, origin, signal }), { inspectionId: input.inspectionId }); ready(signal);
    if (notes.some(note => !page.frames.some(frame => frame.index === note.frameIndex))) throw fail(400, '只能描述这批实际读取的画面编号。', 'FRAME_NOT_IN_RECEIPT');
    const storedKey = key(projectId, input.inspectionId), previous = records.get(storedKey);
    if (previous && (previous.asset.sourceVersion !== page.asset.sourceVersion || previous.asset.ownerVersion !== page.asset.ownerVersion)) throw fail(409, '参考来源已有变化，请重新读取并分析画面。', 'SOURCE_CHANGED');
    if (!previous && records.size >= MAX_INSPECTIONS) throw fail(413, '本次参考记录已达上限，请完成当前任务后开始新的分析。', 'CONTEXT_LIMIT');
    const merged = new Map((previous?.notes || []).map(note => [note.frameIndex, note]));
    for (const note of notes) merged.set(note.frameIndex, note);
    if ([...merged.values()].reduce((total, note) => total + TEXT_FIELDS.reduce((sum, field) => sum + (note[field]?.length || 0), 0), 0) > MAX_BATCH_TEXT) throw fail(400, '此批累计画面描述超过24000字。', 'NOTES_INPUT');
    const { images: _images, ...metadata } = page;
    records.set(storedKey, { projectId, ...metadata, notes: [...merged.values()].sort((a, b) => a.frameIndex - b.frameIndex) });
    return { inspectionId: page.inspectionId, assetId: page.asset.id, sourceVersion: page.asset.sourceVersion, ownerVersion: page.asset.ownerVersion, noteCount: merged.size, recordedFrameIndices: notes.map(note => note.frameIndex), coverage: page.coverage, pagination: page.pagination, limitations: ['已绑定真实帧凭据的助手描述；登记不代表已制作动画或通过画面检查。'] };
  }
  async function revalidate(stored, { origin, signal, frameIndices } = {}) {
    const expected = frameIndices === undefined ? stored.frames : stored.frames.filter(frame => frameIndices.includes(frame.index));
    if (frameIndices !== undefined && (!Array.isArray(frameIndices) || !frameIndices.length || new Set(frameIndices).size !== frameIndices.length || expected.length !== frameIndices.length)) throw fail(400, '只能验证已登记的实际帧。', 'FRAME_NOT_IN_RECEIPT');
    let page;
    try { page = verifiedPage(await frameReader.receipt(stored.inspectionId, { projectId: stored.projectId, assetId: stored.asset.id, ...(frameIndices !== undefined ? { frameIndices } : {}), origin, signal }), { inspectionId: stored.inspectionId, assetId: stored.asset.id }); }
    catch (error) {
      ready(signal);
      if (error.code !== 'ASSISTANT_FRAMES_RECEIPT' || error.status !== 404) throw error;
      const timestamps = expected.flatMap(frame => frame.timestamp === undefined ? [] : [frame.timestamp]);
      page = verifiedPage(await frameReader.read(stored.projectId, stored.asset.id, { ...(stored.asset.type === 'video' ? { timestamps } : {}), pageSize: MAX_IMAGES, origin, signal }), { assetId: stored.asset.id });
    }
    ready(signal);
    if (page.asset.sourceVersion !== stored.asset.sourceVersion || page.asset.ownerVersion !== stored.asset.ownerVersion) throw fail(409, '参考工程或素材已有变化，旧画面描述不能沿用。', 'SOURCE_CHANGED');
    const images = new Map();
    for (const frame of expected) {
      const fresh = page.frames.find(candidate => candidate.sha256 === frame.sha256 && sameTime(candidate.timestamp, frame.timestamp));
      if (!fresh) throw fail(409, '重新读取的参考画面与原证据不一致，请重新分析。', 'FRAME_CHANGED');
      images.set(frame.index, page.images.get(fresh.index));
    }
    return { ...stored, images };
  }
  function exportMetadata(projectId, options = {}) {
    validateProjectId(projectId); ready();
    if (!object(options) || Object.keys(options).some(field => !['assetIds', 'inspectionIds'].includes(field))) throw fail(400, '缓存导出参数无效。', 'CACHE_OPTIONS');
    const allowed = assetFilter(options.assetIds);
    if (options.inspectionIds !== undefined && (!Array.isArray(options.inspectionIds) || options.inspectionIds.length > MAX_INSPECTIONS || new Set(options.inspectionIds).size !== options.inspectionIds.length || options.inspectionIds.some(id => !INSPECTION.test(id || '')))) throw fail(400, '缓存批次编号无效。', 'CACHE_OPTIONS');
    const wanted = options.inspectionIds === undefined ? null : new Set(options.inspectionIds);
    const inspections = [...records.values()].filter(item => item.projectId === projectId && (!allowed || allowed.has(item.asset.id)) && (!wanted || wanted.has(item.inspectionId))).map(metadataRecord);
    if (wanted && inspections.length !== wanted.size) throw fail(404, '缓存导出包含未登记的批次。', 'CACHE_NOT_FOUND');
    const assets = new Map();
    for (const item of inspections) { const previous = assets.get(item.asset.id); if (previous && (previous.ownerVersion !== item.asset.ownerVersion || previous.sourceVersion !== item.asset.sourceVersion)) throw fail(409, '参考缓存包含不同来源版本。', 'SOURCE_CHANGED'); assets.set(item.asset.id, item.asset); }
    const result = { version: 1, kind: 'assistant-frame-metadata-cache', projectId, assetIds: [...assets.keys()].sort(), sourceSignature: hash(JSON.stringify([...assets.values()].map(({ id, ownerVersion, sourceVersion }) => ({ id, ownerVersion, sourceVersion })).sort((a, b) => a.id.localeCompare(b.id)))), inspectionCount: inspections.length, noteCount: inspections.reduce((total, item) => total + item.notes.length, 0), inspections };
    freezeMetadata(result); EXPORTED_METADATA.set(result, { projectId, sha256: hash(JSON.stringify(result)) }); return result;
  }
  async function restore(projectId, value, { origin, signal, assetIds } = {}) {
    validateProjectId(projectId); ready(signal);
    const trusted = object(value) ? EXPORTED_METADATA.get(value) : null;
    if (!trusted || trusted.projectId !== projectId || value.projectId !== projectId || trusted.sha256 !== hash(JSON.stringify(value))) throw fail(400, '只接受本服务进程导出的原始参考缓存。', 'CACHE_UNTRUSTED');
    const allowed = assetFilter(assetIds);
    const selected = value.inspections.filter(item => !allowed || allowed.has(item.asset.id)).map(metadataRecord), additions = selected.filter(item => !records.has(key(projectId, item.inspectionId)));
    if (records.size + additions.length > MAX_INSPECTIONS) throw fail(413, '参考缓存超过本次任务容量。', 'CONTEXT_LIMIT');
    const assets = new Map();
    for (const item of selected) {
      const previous = records.get(key(projectId, item.inspectionId));
      if (previous && (previous.asset.sourceVersion !== item.asset.sourceVersion || previous.asset.ownerVersion !== item.asset.ownerVersion)) throw fail(409, '参考缓存与本轮来源版本不同。', 'SOURCE_CHANGED');
      if (!assets.has(item.asset.id)) assets.set(item.asset.id, item);
    }
    // Registration already verified every cached frame. Recheck one actual SHA
    // plus the live source/owner per asset now; remaining pixel hashes are
    // verified lazily when snapshot selects those pictures for the model.
    const sourceVersionsVerified = [];
    for (const item of assets.values()) {
      await revalidate(item, { origin, signal, frameIndices: [item.frames[0].index] }); ready(signal);
      sourceVersionsVerified.push({ assetId: item.asset.id, ownerVersion: item.asset.ownerVersion, sourceVersion: item.asset.sourceVersion });
    }
    ready(signal);
    for (const item of additions) records.set(key(projectId, item.inspectionId), item);
    return { restoredInspectionIds: selected.map(item => item.inspectionId), assetIds: [...assets.keys()], noteCount: selected.reduce((total, item) => total + item.notes.length, 0), sourceVersionsVerified, eagerFrameHashesVerified: assets.size, remainingFrameHashesDeferred: true, cachedDescriptionsReused: true, limitations: ['缓存是已绑定实际帧的助手观察；不是新的画面阅读或成品凭据。', '来源版本已复核，所需图片的实际SHA在发送模型前逐张验证。'] };
  }
  async function snapshot(projectId, options = {}, { origin, signal } = {}) {
    validateProjectId(projectId); ready(signal);
    if (!object(options) || Object.keys(options).some(field => !['inspectionIds', 'assetId', 'maxImages', 'imageOffset', 'maxNotes', 'maxNoteCharacters'].includes(field))) throw fail(400, '参考上下文参数无效。', 'OPTIONS');
    const maxImages = integer(options.maxImages, MAX_IMAGES, 0, MAX_IMAGES, '参考图片数'), maxNotes = integer(options.maxNotes, 120, 1, 256, '参考描述数'), maxCharacters = integer(options.maxNoteCharacters, 60000, 24000, 120000, '参考描述容量');
    const imageOffset = options.imageOffset === undefined ? null : integer(options.imageOffset, undefined, 0, 100000, '参考图片偏移');
    if (imageOffset !== null && maxImages === 0) throw fail(400, '顺序读取参考图时至少选择1张图片。', 'OPTIONS');
    if (options.assetId !== undefined && typeof options.assetId !== 'string' || options.inspectionIds !== undefined && (!Array.isArray(options.inspectionIds) || !options.inspectionIds.length || options.inspectionIds.length > MAX_INSPECTIONS || new Set(options.inspectionIds).size !== options.inspectionIds.length || options.inspectionIds.some(id => !INSPECTION.test(id || '')))) throw fail(400, '请选择实际已登记的参考素材或批次。', 'OPTIONS');
    const wanted = options.inspectionIds ? new Set(options.inspectionIds) : null;
    const selected = [...records.values()].filter(item => item.projectId === projectId && (options.assetId === undefined || item.asset.id === options.assetId) && (!wanted || wanted.has(item.inspectionId))).map(clone);
    if (wanted && selected.length !== wanted.size) {
      for (const inspectionId of wanted) {
        if (selected.some(item => item.inspectionId === inspectionId)) continue;
        let page;
        try { page = verifiedPage(await frameReader.receipt(inspectionId, { projectId, ...(options.assetId !== undefined ? { assetId: options.assetId } : {}), origin, signal }), { inspectionId, ...(options.assetId !== undefined ? { assetId: options.assetId } : {}) }); }
        catch (error) { ready(signal); if (error.code === 'ASSISTANT_FRAMES_RECEIPT' && error.status === 404) throw fail(404, '参考批次没有有效凭据；已过期且未登记的画面需重新读取。', 'NOT_FOUND'); throw error; }
        ready(signal); const { images: _images, ...metadata } = page;
        selected.push({ projectId, ...metadata, notes: [] });
      }
    }
    if (!selected.length) return { context: { version: 1, kind: 'assistant-frame-notes', assets: [], inspections: [], notes: [], selectedImageFrames: [], imagePagination: { totalFrames: 0, offset: imageOffset, nextOffset: null, hasMore: false, mode: imageOffset === null ? 'representative' : 'sequential' }, coverage: mergedCoverage([], [], [], []) }, images: [] };
    const assets = new Map();
    for (const item of selected) { const previous = assets.get(item.asset.id); if (previous && (previous.sourceVersion !== item.asset.sourceVersion || previous.ownerVersion !== item.asset.ownerVersion)) throw fail(409, '参考批次属于不同素材版本，请选取重新读取后的批次。', 'SOURCE_CHANGED'); assets.set(item.asset.id, item.asset); }
    const notes = selected.flatMap(item => item.notes.map(note => {
      const frame = item.frames.find(frame => frame.index === note.frameIndex), shot = item.shots.find(shot => Number.isFinite(shot.timestamp) && Number.isFinite(frame.requestedTimestamp) && sameTime(shot.timestamp, frame.requestedTimestamp) || frame.timestamp !== undefined && frame.timestamp >= shot.start && frame.timestamp < shot.end);
      return { inspectionId: item.inspectionId, assetId: item.asset.id, sourceVersion: item.asset.sourceVersion, ...note, ...(frame.timestamp !== undefined ? { timestamp: frame.timestamp } : {}), ...(frame.requestedTimestamp !== undefined ? { requestedTimestamp: frame.requestedTimestamp } : {}), timestampKind: frame.timestampKind, sha256: frame.sha256, ...(shot ? { shot: clone(shot) } : {}) };
    })).sort(byTime);
    let includedNotes = pickSpread(notes, Math.min(maxNotes, notes.length));
    while (JSON.stringify(includedNotes).length > maxCharacters && includedNotes.length > 1) includedNotes = pickSpread(notes, includedNotes.length - 1);
    const annotated = new Set(includedNotes.map(frameIdentity)), distinct = new Map();
    for (const item of selected) for (const frame of item.frames) { const metadata = { inspectionId: item.inspectionId, assetId: item.asset.id, sourceVersion: item.asset.sourceVersion, frameIndex: frame.index, ...(frame.timestamp !== undefined ? { timestamp: frame.timestamp } : {}), ...(frame.requestedTimestamp !== undefined ? { requestedTimestamp: frame.requestedTimestamp } : {}), timestampKind: frame.timestampKind, sha256: frame.sha256 }; const identity = frameKey(metadata), previous = distinct.get(identity); if (!previous || annotated.has(frameIdentity(metadata)) && !annotated.has(frameIdentity(previous))) distinct.set(identity, metadata); }
    const candidates = [...distinct.values()].sort(byTime), preferred = candidates.filter(frame => annotated.has(frameIdentity(frame))), pool = preferred.length ? preferred : candidates;
    if (imageOffset !== null && imageOffset > candidates.length) throw fail(400, '参考图片偏移超出已读取帧数。', 'OPTIONS');
    const chosen = new Map((imageOffset === null ? pickSpread(pool, Math.min(maxImages, pool.length)) : candidates.slice(imageOffset, imageOffset + maxImages)).map(frame => [frameIdentity(frame), frame]));
    // A live source/owner check covers stored notes for that unchanged asset.
    // Only batches whose actual pictures will be sent need pixel replay; do not
    // decode the complete video again for each six-picture comparison page.
    const neededIds = new Set([...chosen.values()].map(frame => frame.inspectionId));
    for (const asset of assets.values()) if (!selected.some(item => item.asset.id === asset.id && neededIds.has(item.inspectionId))) neededIds.add(selected.find(item => item.asset.id === asset.id).inspectionId);
    const verifiedImages = new Map(), revalidatedInspectionIds = [];
    for (const stored of selected.filter(item => neededIds.has(item.inspectionId))) {
      const chosenIndices = [...chosen.values()].filter(frame => frame.inspectionId === stored.inspectionId).map(frame => frame.frameIndex);
      const verified = await revalidate(stored, { origin, signal, frameIndices: chosenIndices.length ? chosenIndices : [stored.frames[0].index] }); ready(signal);
      revalidatedInspectionIds.push(stored.inspectionId);
      for (const frame of chosen.values()) if (frame.inspectionId === stored.inspectionId) verifiedImages.set(frameIdentity(frame), verified.images.get(frame.frameIndex));
    }
    const images = [], selectedImageFrames = []; let imageBytes = 0;
    for (const frame of chosen.values()) {
      const picture = verifiedImages.get(frameIdentity(frame)), size = Buffer.byteLength(picture.dataUrl);
      if (imageBytes + size > MAX_IMAGE_BYTES) { if (imageOffset !== null) break; continue; }
      imageBytes += size; selectedImageFrames.push(frame);
      images.push({ ...picture, ...frame, label: `参考素材 ${frame.assetId} · ${frame.timestamp === undefined ? '图片' : frame.timestamp.toFixed(3) + '秒'} · 批次 ${frame.inspectionId} · 第${frame.frameIndex}帧` });
    }
    const nextOffset = imageOffset !== null && imageOffset + images.length < candidates.length ? imageOffset + images.length : null;
    const context = { version: 1, kind: 'assistant-frame-notes', assets: [...assets.values()].map(clone), inspections: selected.map(({ inspectionId, asset, frames, shots, coverage, pagination }) => ({ inspectionId, assetId: asset.id, sourceVersion: asset.sourceVersion, ownerVersion: asset.ownerVersion, frames, ...(shots.length ? { shots } : {}), coverage, pagination })), notes: includedNotes, selectedImageFrames, imagePagination: { totalFrames: candidates.length, offset: imageOffset, nextOffset, hasMore: nextOffset !== null, mode: imageOffset === null ? 'representative' : 'sequential' }, verification: { assetVersions: [...assets.values()].map(({ id, sourceVersion, ownerVersion }) => ({ assetId: id, sourceVersion, ownerVersion })), revalidatedInspectionIds, noteFramesWereVerifiedAtRegistration: true }, coverage: mergedCoverage(selected, notes, includedNotes, selectedImageFrames) };
    return { context, images };
  }
  return { record, snapshot, export: exportMetadata, restore, clear(projectId) { validateProjectId(projectId); for (const [id, item] of records) if (item.projectId === projectId) records.delete(id); }, close() { closed = true; records.clear(); } };
}
