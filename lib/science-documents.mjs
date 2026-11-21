import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Worker } from 'node:worker_threads';
import { AppError, boundedString, requireObject } from './errors.mjs';
import { validateProjectId } from './store.mjs';

const VERSION = 1, ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const UNIT_ID = /^(?:p\d{4}|s\d{4})-\d{3}-[a-f0-9]{12}$/;
const FORMATS = new Set(['pdf', 'docx', 'txt', 'md', 'markdown']);
const HASH = /^[a-f0-9]{64}$/, MAX_TEXT = 2_000_000, MAX_UNITS = 3000;
const LIMITS = Object.freeze({ fileBytes: 32 * 1024 * 1024, docxBytes: 10 * 1024 * 1024, textBytes: 8 * 1024 * 1024, characters: MAX_TEXT, pages: 800, documents: 40, units: MAX_UNITS, unitCharacters: 6000, contextCharacters: 60000, contextUnits: 160, parseTimeoutMs: 45000 });
const digest = value => createHash('sha256').update(value).digest('hex');
const error = (status, message, code) => new AppError(status, message, code);
const aborted = () => error(499, '资料导入已取消。', 'SCIENCE_IMPORT_CANCELLED');
const check = signal => { if (signal?.aborted) throw aborted(); };
const comparable = value => process.platform === 'win32' ? value.toLowerCase() : value;
const cleanName = value => {
  const name = boundedString(value, '文件名', 240);
  if (/[\\/\x00-\x1f]/.test(name) || name === '.' || name === '..') throw error(400, '文件名不能包含目录。', 'SCIENCE_DOCUMENT_NAME_INVALID');
  return name;
};
function documentId(value) { if (typeof value !== 'string' || !ID.test(value)) throw error(404, '资料不存在。', 'SCIENCE_DOCUMENT_NOT_FOUND'); return value.toLowerCase(); }
function formatOf(name) { const format = name.split('.').at(-1).toLowerCase(); if (!FORMATS.has(format)) throw error(415, '支持PDF、DOCX、TXT和Markdown文件。', 'SCIENCE_DOCUMENT_FORMAT'); return format; }
function normalizeText(text) {
  if (typeof text !== 'string' || !text.trim()) throw error(400, '请填入论文或教材正文。', 'SCIENCE_DOCUMENT_EMPTY');
  if (text.length > MAX_TEXT) throw error(413, '资料超过200万个字符，请按章节拆分导入。', 'SCIENCE_DOCUMENT_TEXT_LIMIT');
  if (text.includes('\0')) throw error(400, '资料中包含非文本内容。', 'SCIENCE_DOCUMENT_INVALID_TEXT');
  return text.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '').normalize('NFC').trim();
}
function splitText(text, max = LIMITS.unitCharacters) {
  const parts = [];
  let at = 0;
  while (at < text.length) {
    let end = Math.min(text.length, at + max);
    if (end < text.length) {
      const choices = [text.lastIndexOf('\n\n', end - 1), text.lastIndexOf('\n', end - 1), text.lastIndexOf('。', end - 1), text.lastIndexOf('. ', end - 1), text.lastIndexOf(' ', end - 1)].filter(value => value > at + max / 2);
      if (choices.length) end = Math.max(...choices) + 1;
    }
    const raw = text.slice(at, end), value = raw.trim();
    if (value) parts.push({ text: value, charStart: at + raw.indexOf(value), charEnd: at + raw.indexOf(value) + value.length });
    at = end;
  }
  return parts;
}
function sectionsOf(text) {
  const lines = [...text.matchAll(/^.*$/gm)], starts = [];
  for (const line of lines) if (/^(?:#{1,6}\s+\S|第[一二三四五六七八九十百千万零\d]+[章篇节部分]\s*\S|(?:chapter|section)\s+[\divx]+\b|\d+(?:\.\d+){0,4}[ \t]+\S)/i.test(line[0].trim())) starts.push({ at: line.index, label: line[0].trim().replace(/^#{1,6}\s+/, '').slice(0, 140) });
  if (!starts.length || starts[0].at !== 0) starts.unshift({ at: 0, label: '正文' });
  return starts.map((value, index) => ({ ...value, text: text.slice(value.at, starts[index + 1]?.at ?? text.length) })).filter(value => value.text.trim());
}
function unitsFrom(parsed, format) {
  const units = [];
  if (format === 'pdf') {
    for (const page of parsed.pages) {
      const parts = splitText(page.text);
      if (!parts.length) units.push({ id: 'p' + String(page.page).padStart(4, '0') + '-001-' + digest('').slice(0, 12), index: units.length, page: page.page, label: page.label, text: '', hash: digest(''), characterCount: 0, readable: false, charStart: 0, charEnd: 0 });
      for (const [partIndex, part] of parts.entries()) units.push({ id: 'p' + String(page.page).padStart(4, '0') + '-' + String(partIndex + 1).padStart(3, '0') + '-' + digest(part.text).slice(0, 12), index: units.length, page: page.page, label: page.label + (parts.length > 1 ? ' · 第' + (partIndex + 1) + '段' : ''), ...part, hash: digest(part.text), characterCount: part.text.length, readable: true });
    }
  } else {
    for (const [sectionIndex, section] of sectionsOf(parsed.pages[0].text).entries()) {
      const parts = splitText(section.text);
      for (const [partIndex, part] of parts.entries()) units.push({ id: 's' + String(sectionIndex + 1).padStart(4, '0') + '-' + String(partIndex + 1).padStart(3, '0') + '-' + digest(part.text).slice(0, 12), index: units.length, section: sectionIndex + 1, label: section.label + (parts.length > 1 ? ' · 第' + (partIndex + 1) + '段' : ''), ...part, charStart: section.at + part.charStart, charEnd: section.at + part.charEnd, hash: digest(part.text), characterCount: part.text.length, readable: true });
    }
  }
  if (!units.length || units.length > MAX_UNITS) throw error(413, '资料分段过多，请按章节拆分文件。', 'SCIENCE_DOCUMENT_UNIT_LIMIT');
  return units;
}
function writeJson(res, status, value) { if (res.destroyed || res.writableEnded) return; const body = JSON.stringify(value); res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' }); res.end(body); }
async function requestBuffer(req, { max = LIMITS.fileBytes, signal } = {}) {
  const length = Number(req.headers['content-length']); if (Number.isFinite(length) && length > max) { req.resume(); throw error(413, '文件超过允许大小，请按章节拆分后导入。', 'SCIENCE_DOCUMENT_FILE_LIMIT'); }
  const chunks = []; let size = 0;
  check(signal);
  const stop = () => { if (!req.destroyed) req.destroy(aborted()); };
  signal?.addEventListener('abort', stop, { once: true });
  try {
    for await (const chunk of req) { check(signal); size += chunk.length; if (size > max) { req.resume(); throw error(413, '文件超过允许大小，请按章节拆分后导入。', 'SCIENCE_DOCUMENT_FILE_LIMIT'); } chunks.push(chunk); }
    check(signal); return Buffer.concat(chunks);
  } catch (value) { if (signal?.aborted) throw aborted(); throw value; }
  finally { signal?.removeEventListener('abort', stop); }
}
async function requestJson(req, { max = 8 * 1024 * 1024, signal } = {}) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw error(415, '请使用JSON请求。', 'CONTENT_TYPE_REQUIRED');
  let value; try { value = JSON.parse((await requestBuffer(req, { max, signal })).toString('utf8')); } catch (value) { if (value instanceof AppError) throw value; throw error(400, '请求不是有效JSON。', 'INVALID_JSON'); }
  return requireObject(value);
}

export async function createScienceDocumentService({ dataDir, store, parseTimeoutMs = LIMITS.parseTimeoutMs } = {}) {
  if (!dataDir || !store?.read) throw error(500, '资料库尚未配置。', 'SCIENCE_DOCUMENT_NOT_CONFIGURED');
  const root = path.resolve(dataDir, 'science-documents');
  await mkdir(root, { recursive: true });
  if ((await lstat(root)).isSymbolicLink()) throw error(403, '资料库目录不能是链接。', 'SCIENCE_DOCUMENT_STORAGE_INVALID');
  const realRoot = await realpath(root), serviceAbort = new AbortController(), operations = new Set(), queues = new Map(), workers = new Set();
  let closed = false, parseTail = Promise.resolve();
  async function owner(id) {
    validateProjectId(id);
    const value = await store.read(id);
    if (!value || value.kind !== 'science') throw error(404, '请选择仍存在的科普项目。', 'SCIENCE_DOCUMENT_PROJECT_NOT_FOUND');
    return value;
  }
  function ensureOpen() { if (closed) throw error(503, '资料服务正在关闭。', 'SCIENCE_DOCUMENT_CLOSED'); }
  async function directory(projectId, id, { createOwner = false } = {}) {
    const current = await owner(projectId), group = path.join(root, projectId);
    if (createOwner) await mkdir(group, { recursive: true });
    let groupInfo, realGroup;
    try { groupInfo = await lstat(group); realGroup = await realpath(group); } catch (value) { if (value.code === 'ENOENT') { if (id) throw error(404, '资料不存在或不属于此项目。', 'SCIENCE_DOCUMENT_NOT_FOUND'); return { owner: current, group, missing: true }; } throw value; }
    if (!groupInfo.isDirectory() || groupInfo.isSymbolicLink() || comparable(realGroup) !== comparable(path.join(realRoot, projectId))) throw error(403, '资料项目目录无效。', 'SCIENCE_DOCUMENT_STORAGE_INVALID');
    if (!id) return { owner: current, group, realGroup };
    const doc = documentId(id), target = path.join(group, doc);
    let info, resolved;
    try { info = await lstat(target); resolved = await realpath(target); } catch (value) { if (value.code === 'ENOENT') throw error(404, '资料不存在或已删除。', 'SCIENCE_DOCUMENT_NOT_FOUND'); throw value; }
    if (!info.isDirectory() || info.isSymbolicLink() || comparable(resolved) !== comparable(path.join(realGroup, doc))) throw error(403, '资料目录无效。', 'SCIENCE_DOCUMENT_STORAGE_INVALID');
    return { owner: current, group, directory: target, realDirectory: resolved };
  }
  async function file(target, name, maximum) {
    const filename = path.join(target.directory, name), info = await lstat(filename), resolved = await realpath(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maximum || comparable(path.dirname(resolved)) !== comparable(target.realDirectory)) throw error(403, '资料文件不能安全读取。', 'SCIENCE_DOCUMENT_STORAGE_INVALID');
    return resolved;
  }
  function publicMetadata(value) {
    return { id: value.documentId, documentId: value.documentId, projectId: value.projectId, title: value.title, fileName: value.fileName, format: value.format, sourceType: value.sourceType, sourceHash: value.sourceHash, contentHash: value.contentHash, pageCount: value.pageCount, totalUnitCount: value.totalUnitCount, readableUnitCount: value.readableUnitCount, characterCount: value.characterCount, bytes: value.bytes, createdAt: value.createdAt, warnings: value.warnings };
  }
  async function metadata(projectId, id) {
    const target = await directory(projectId, id);
    let value;
    try { value = JSON.parse(await readFile(await file(target, 'document.json', 512 * 1024), 'utf8')); } catch (value) { if (value instanceof AppError) throw value; throw error(422, '资料记录损坏，请重新导入原文件。', 'SCIENCE_DOCUMENT_CORRUPT'); }
    if (value.version !== VERSION || value.projectId !== projectId || value.ownerCreatedAt !== target.owner.createdAt || value.documentId !== documentId(id) || !FORMATS.has(value.format) || value.sourceFile !== 'source.' + value.format || value.unitsFile !== 'units.json' || !HASH.test(value.sourceHash || '') || !HASH.test(value.unitsHash || '') || !HASH.test(value.contentHash || '') || !Array.isArray(value.warnings)) throw error(404, '资料不属于当前项目，请重新导入。', 'SCIENCE_DOCUMENT_OWNER_MISMATCH');
    return { ...target, value };
  }
  async function list(projectId) {
    ensureOpen(); const target = await directory(projectId), documents = [], warnings = [];
    if (target.missing) return { projectId, documents, warnings, limits: LIMITS };
    const entries = (await readdir(target.group, { withFileTypes: true })).filter(entry => ID.test(entry.name));
    for (const entry of entries.slice(0, 1000)) {
      try { documents.push(publicMetadata((await metadata(projectId, entry.name)).value)); }
      catch { warnings.push({ code: 'DOCUMENT_NOT_LISTED', message: '一份旧资料无法归属或读取，原文件已保留；可重新导入原文。' }); }
    }
    documents.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return { projectId, documents, warnings, limits: LIMITS };
  }
  async function get(projectId, id, { verifySource = true, signal } = {}) {
    ensureOpen(); check(signal);
    const target = await metadata(projectId, id), bytes = await readFile(await file(target, 'units.json', 20 * 1024 * 1024));
    if (digest(bytes) !== target.value.unitsHash) throw error(409, '提取资料已改变，请重新导入原文件。', 'SCIENCE_DOCUMENT_CHANGED');
    let units;
    try { units = JSON.parse(bytes.toString('utf8')); } catch { throw error(422, '资料分段无法读取，请重新导入。', 'SCIENCE_DOCUMENT_CORRUPT'); }
    if (!Array.isArray(units) || units.length !== target.value.totalUnitCount || units.length > MAX_UNITS || units.some((unit, index) => !unit || !UNIT_ID.test(unit.id || '') || unit.index !== index || typeof unit.text !== 'string' || unit.text.length > LIMITS.unitCharacters || unit.hash !== digest(unit.text) || unit.characterCount !== unit.text.length || unit.readable !== Boolean(unit.text.trim()))) throw error(422, '资料分段无效，请重新导入原文。', 'SCIENCE_DOCUMENT_CORRUPT');
    if (verifySource) {
      const filename = await file(target, target.value.sourceFile, LIMITS.fileBytes), hash = createHash('sha256');
      for await (const chunk of createReadStream(filename)) { check(signal); hash.update(chunk); }
      if (hash.digest('hex') !== target.value.sourceHash) throw error(409, '原文件内容已改变，请重新导入，避免使用过期依据。', 'SCIENCE_DOCUMENT_CHANGED');
    }
    check(signal);
    const current = await owner(projectId);
    if (current.createdAt !== target.value.ownerCreatedAt) throw error(404, '项目已改变，请重新导入资料。', 'SCIENCE_DOCUMENT_OWNER_MISMATCH');
    return { ...publicMetadata(target.value), units };
  }
  function serial(projectId, operation) {
    const before = queues.get(projectId) || Promise.resolve();
    const pending = before.catch(() => {}).then(operation); queues.set(projectId, pending);
    pending.finally(() => { if (queues.get(projectId) === pending) queues.delete(projectId); }).catch(() => {});
    return pending;
  }
  function tracked(operation) {
    ensureOpen(); if (operations.size >= 4) return Promise.reject(error(429, '已有资料正在处理，请稍后再导入。', 'SCIENCE_IMPORT_BUSY'));
    const pending = Promise.resolve().then(operation); operations.add(pending);
    pending.finally(() => operations.delete(pending)).catch(() => {}); return pending;
  }
  function parse(buffer, format, signal) {
    const pending = parseTail.catch(() => {}).then(() => new Promise((resolve, reject) => {
      check(signal);
      const worker = new Worker(new URL('./science-document-worker.mjs', import.meta.url), { workerData: { bytes: new Uint8Array(buffer), format }, resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 8 } });
      workers.add(worker); let settled = false;
      const timer = setTimeout(() => finish(error(408, '资料解析超时，请先拆分需要的章节。', 'SCIENCE_IMPORT_TIMEOUT')), Math.max(50, Math.min(120000, Number(parseTimeoutMs) || LIMITS.parseTimeoutMs)));
      const stop = () => finish(aborted());
      const finish = async (failure, result) => {
        if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', stop); workers.delete(worker);
        await worker.terminate().catch(() => {});
        failure ? reject(failure) : resolve(result);
      };
      signal?.addEventListener('abort', stop, { once: true });
      if (signal?.aborted) return stop();
      worker.on('message', value => { if (!value?.ok) finish(error(400, value?.error?.message || '资料解析未完成，请重新导入。', value?.error?.code || 'SCIENCE_DOCUMENT_PARSE_FAILED')); else finish(null, value.result); });
      worker.on('error', () => finish(error(413, '资料解析超过可用资源，请按章节拆分后导入。', 'SCIENCE_IMPORT_RESOURCE_LIMIT')));
      worker.on('exit', code => { if (!settled) finish(error(500, '资料解析未完成，请换成较小文件后重试。', 'SCIENCE_DOCUMENT_PARSE_FAILED')); });
    }));
    parseTail = pending.catch(() => {}); return pending;
  }
  async function importBuffer(projectId, input, { signal: external } = {}) {
    return tracked(async () => {
      const signal = external ? AbortSignal.any([external, serviceAbort.signal]) : serviceAbort.signal; check(signal);
      requireObject(input); const name = cleanName(input.name), format = formatOf(name), buffer = Buffer.isBuffer(input.buffer) ? input.buffer : input.buffer instanceof Uint8Array ? Buffer.from(input.buffer) : null;
      const max = format === 'pdf' ? LIMITS.fileBytes : format === 'docx' ? LIMITS.docxBytes : LIMITS.textBytes;
      if (!buffer?.length || buffer.length > max) throw error(413, format === 'docx' ? 'DOCX需为非空且不超过10MB的文档。' : format === 'pdf' ? 'PDF需为非空且不超过32MB的文档。' : '文本文件需为非空且不超过8MB。', 'SCIENCE_DOCUMENT_FILE_LIMIT');
      const sourceHash = digest(buffer), requestedTitle = input.title == null ? '' : boundedString(input.title, '资料标题', 300, { optional: true });
      return serial(projectId, async () => {
        check(signal); const before = await owner(projectId), existing = await list(projectId);
        const duplicate = existing.documents.find(document => document.sourceHash === sourceHash && document.format === format);
        if (duplicate) return { document: await get(projectId, duplicate.id, { signal }), duplicate: true };
        if (existing.documents.length >= LIMITS.documents) throw error(400, '每个科普项目最多保存40份资料，请移除不用的资料后再导入。', 'SCIENCE_DOCUMENT_LIMIT');
        const parsed = await parse(buffer, format, signal); check(signal);
        const units = unitsFrom(parsed, format), id = randomUUID(), target = await directory(projectId, undefined, { createOwner: true });
        if (before.createdAt !== target.owner.createdAt) throw error(409, '项目在导入期间发生变化，请重试。', 'SCIENCE_DOCUMENT_OWNER_MISMATCH');
        const stage = path.join(target.group, '.import-' + id), destination = path.join(target.group, id);
        await mkdir(stage);
        try {
          const unitBytes = Buffer.from(JSON.stringify(units));
          const title = requestedTitle || parsed.title || name.replace(/\.[^.]+$/, '');
          const value = { version: VERSION, projectId, ownerCreatedAt: before.createdAt, documentId: id, title: title.slice(0, 300), fileName: name, format, sourceType: format === 'pdf' ? 'pdf' : format === 'docx' ? 'docx' : format === 'md' || format === 'markdown' ? 'markdown' : 'text', sourceFile: 'source.' + format, unitsFile: 'units.json', sourceHash, unitsHash: digest(unitBytes), contentHash: digest(JSON.stringify(units.map(unit => [unit.id, unit.hash]))), pageCount: parsed.pageCount, totalUnitCount: units.length, readableUnitCount: units.filter(unit => unit.readable).length, characterCount: units.reduce((sum, unit) => sum + unit.text.length, 0), bytes: buffer.length, warnings: parsed.warnings || [], createdAt: new Date().toISOString() };
          await writeFile(path.join(stage, value.sourceFile), buffer, { flag: 'wx', mode: 0o600 });
          await writeFile(path.join(stage, 'units.json'), unitBytes, { flag: 'wx', mode: 0o600 });
          await writeFile(path.join(stage, 'document.json'), JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 }); check(signal);
          if ((await owner(projectId)).createdAt !== before.createdAt) throw error(409, '项目已改变，未登记本次导入。', 'SCIENCE_DOCUMENT_OWNER_MISMATCH');
          await rename(stage, destination); return { document: { ...publicMetadata(value), units }, duplicate: false };
        } catch (value) {
          const relative = path.relative(target.group, path.resolve(stage)); if (relative === '.import-' + id && comparable(path.dirname(stage)) === comparable(target.group)) await rm(stage, { recursive: true, force: true });
          throw value;
        }
      });
    });
  }
  async function importText(projectId, input, options = {}) {
    requireObject(input); const text = normalizeText(input.text), title = boundedString(input.title || '粘贴资料', '资料标题', 300);
    return importBuffer(projectId, { name: title.replace(/[\\/\x00-\x1f]/g, '_').slice(0, 220) + '.txt', title, buffer: Buffer.from(text, 'utf8') }, options);
  }
  async function context(projectId, input, { signal, maxCharacters = LIMITS.contextCharacters } = {}) {
    requireObject(input, '资料选择'); const id = documentId(input.documentId);
    if (!Array.isArray(input.unitIds) || !input.unitIds.length || input.unitIds.length > LIMITS.contextUnits || new Set(input.unitIds).size !== input.unitIds.length || input.unitIds.some(id => typeof id !== 'string' || !UNIT_ID.test(id))) throw error(400, '请明确选择1至160个资料页段。', 'SCIENCE_DOCUMENT_SELECTION_REQUIRED');
    const document = await get(projectId, id, { signal }), wanted = new Set(input.unitIds), units = document.units.filter(unit => wanted.has(unit.id));
    if (units.length !== wanted.size || units.some(unit => !unit.readable)) throw error(400, '所选资料页段已失效或没有可提取文字，请重新选择。', 'SCIENCE_DOCUMENT_SELECTION_INVALID');
    const size = units.reduce((sum, unit) => sum + unit.text.length, 0), budget = Math.min(100000, Math.max(1, Number(maxCharacters) || LIMITS.contextCharacters));
    if (size > budget) throw Object.assign(error(413, '所选页段共' + size + '字，超过本次' + budget + '字上限。请减少章节后生成，不会截断整本资料。', 'SCIENCE_DOCUMENT_SELECTION_TOO_LARGE'), { selection: { characterCount: size, maxCharacters: budget } });
    const selected = units.map(({ id, index, label, page, section, text, hash }) => ({ id, index, label, ...(page ? { page } : {}), ...(section ? { section } : {}), text, hash }));
    return { documentId: id, title: document.title, fileName: document.fileName, sourceType: document.sourceType, sourceHash: document.sourceHash, hash: digest(JSON.stringify([document.sourceHash, selected.map(unit => [unit.id, unit.hash])])), pageCount: document.pageCount, totalUnitCount: document.totalUnitCount, text: selected.map(unit => unit.text).join('\n\n'), units: selected, selection: { unitIds: selected.map(unit => unit.id), characterCount: size }, note: '仅所选页段作为本次依据；引用须对应unitId和该单元真实原文，未选页段没有送入生成。PDF公式和阅读顺序需与原文件核对。' };
  }
  async function remove(projectId, id) {
    ensureOpen(); return serial(projectId, async () => {
      const target = await metadata(projectId, id), relative = path.relative(target.group, path.resolve(target.directory));
      if (relative !== documentId(id) || comparable(path.dirname(target.directory)) !== comparable(target.group)) throw error(403, '资料目录不在当前项目内。', 'SCIENCE_DOCUMENT_STORAGE_INVALID');
      await rm(target.directory, { recursive: true, force: false }); return { removed: true, documentId: id };
    });
  }
  async function handler(req, res, url, options = {}) {
    const match = url.pathname.match(/^\/api\/projects\/([^/]+)\/science-documents(?:\/([^/]+))?(?:\/(source))?$/);
    if (!match) return false;
    const controller = new AbortController(), stop = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', stop);
    const signal = AbortSignal.any([serviceAbort.signal, controller.signal, ...(options.signal ? [options.signal] : [])]);
    try {
      let projectId; try { projectId = validateProjectId(decodeURIComponent(match[1])); } catch { throw error(400, '项目编号不正确。', 'INVALID_PROJECT_ID'); }
      const action = match[2], method = req.method || 'GET'; await owner(projectId);
      if (!action && method === 'GET') { writeJson(res, 200, await list(projectId)); return true; }
      if (action === 'text' && method === 'POST') { writeJson(res, 201, await importText(projectId, await requestJson(req, { signal }), { signal })); return true; }
      if (action === 'upload' && method === 'POST') {
        if (!/^application\/octet-stream(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw error(415, '请上传原始文件内容。', 'CONTENT_TYPE_REQUIRED');
        let name; try { name = cleanName(decodeURIComponent(req.headers['x-file-name'] || '')); } catch { throw error(400, '请提供有效文件名。', 'SCIENCE_DOCUMENT_NAME_INVALID'); }
        formatOf(name); const bytes = await requestBuffer(req, { signal });
        writeJson(res, 201, await importBuffer(projectId, { name, buffer: bytes }, { signal })); return true;
      }
      if (action === 'context' && method === 'POST') { writeJson(res, 200, await context(projectId, await requestJson(req, { max: 65536, signal }), { signal })); return true; }
      if (action && match[3] === 'source' && ['GET', 'HEAD'].includes(method)) {
        const target = await metadata(projectId, action), filename = await file(target, target.value.sourceFile, LIMITS.fileBytes), info = await stat(filename);
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': info.size, 'content-disposition': 'attachment; filename="science-source.' + target.value.format + '"; filename*=UTF-8\'\'' + encodeURIComponent(target.value.fileName), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        if (method === 'HEAD') res.end(); else await pipeline(createReadStream(filename), res, { signal }); return true;
      }
      if (action && !match[3] && method === 'GET') { writeJson(res, 200, { document: await get(projectId, action, { signal }) }); return true; }
      if (action && !match[3] && method === 'DELETE') { writeJson(res, 200, await remove(projectId, action)); return true; }
      throw error(405, '资料操作不支持此请求方法。', 'METHOD_NOT_ALLOWED');
    } catch (value) {
      if (res.destroyed || res.writableEnded) return true;
      if (res.headersSent) { res.destroy(); return true; }
      writeJson(res, value instanceof AppError ? value.status : 500, { error: value instanceof AppError ? value.message : '资料操作未完成，请稍后重试。', code: value instanceof AppError ? value.code : 'SCIENCE_DOCUMENT_FAILED', ...(value.selection ? { selection: value.selection } : {}) }); return true;
    } finally { res.removeListener('close', stop); }
  }
  async function close() {
    if (closed) return; closed = true; serviceAbort.abort();
    await Promise.allSettled([...workers].map(worker => worker.terminate()));
    await Promise.allSettled([...operations]); await parseTail; await Promise.allSettled([...queues.values()]);
  }
  return { importBuffer, importText, list, get, remove, context, handler, handle: handler, close, limits: LIMITS };
}
