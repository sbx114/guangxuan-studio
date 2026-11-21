import path from 'node:path';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { AppError } from './errors.mjs';
import { summarizeProject, validateProjectId, withoutSecrets } from './store.mjs';
import { validateCoverPng } from './project-covers.mjs';
import { scienceBundlePath, collectScienceBundleFiles, validateScienceBundleContents, restoreScienceBundleFiles } from './science-bundle-data.mjs';
import { sharedNovelBundlePath, collectSharedNovelBundle, validateSharedNovelBundle, restoreSharedNovelBundle, remapSharedNovelProject } from './novel-library-bundle.mjs';
import { remotionBundlePath, collectRemotionBundle, validateRemotionBundle, restoreRemotionBundle, remapRemotionProject } from './remotion-bundle-data.mjs';

export const PROJECT_BUNDLE_MAGIC = Buffer.from('GXPROJECT\n', 'ascii');
export const PROJECT_BUNDLE_VERSION = 1;
export const PROJECT_BUNDLE_LIMITS = Object.freeze({ manifestBytes: 16 * 1024 * 1024, textBytes: 32 * 1024 * 1024, files: 50000, packageBytes: 128 * 1024 ** 3, unpackedBytes: 256 * 1024 ** 3 });
const TOKEN = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const ASSET = /^[A-Za-z0-9_-]{12,80}$/;
const SHA = /^[a-f0-9]{64}$/;
const TEXT = /\.(?:json|html?|css|[cm]?js|jsx|tsx?|svg|md|txt|vtt|srt|xml|ya?ml)$/i;
const PRIVATE_NAME = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|credentials(?:\..*)?|connection-settings\.json|desktop-runtime\.json|settings\.local\.json|id_rsa|id_ed25519)$/i;
const PRIVATE_EXT = /\.(?:pem|key|pfx|p12|log|tmp|lock)$/i;
const SECRET_PROPERTY = /^(?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|password|secret|client[_-]?secret|credentials|connectionSettings|providerSettings)$/i;
const STALE_LINK = new Set(['sourceProjectId', 'videoProjectId', 'linkedProjectId']);
const TRANSIENT = new Set(['assistantJob', 'lastExportJob']);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const failure = (status, message, code, report) => Object.assign(new AppError(status, message, code), report ? { report } : {});
const keyOf = value => value.normalize('NFC').toLowerCase();
const inside = (root, candidate) => { const rel = path.relative(root, candidate); return rel && !path.isAbsolute(rel) && rel.split(path.sep)[0] !== '..'; };
const issue = (code, file, message) => ({ code, file, message });

/** Names are portable across Windows, macOS and Linux, including ADS/device rules. */
export function validateBundlePath(value) {
  if (typeof value !== 'string' || !value || value.length > 1500 || value.startsWith('/') || value.includes('\\') || /[:<>"|?*\x00-\x1f]/.test(value)) throw failure(400, '项目包含不安全的文件路径。', 'BUNDLE_UNSAFE_PATH');
  for (const part of value.split('/')) if (!part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) throw failure(400, '项目包含不安全的文件路径。', 'BUNDLE_UNSAFE_PATH');
  return value;
}
function nativeExcluded(relative) {
  relative = relative.toLowerCase();
  const parts = relative.split('/');
  if (parts.some(part => PRIVATE_NAME.test(part) || PRIVATE_EXT.test(part) || ['node_modules', '.git', '.dev', '.cache', 'browser-profile'].includes(part))) return true;
  if (/^\.film\/(?:cache|previews|thumbnails|exports)(?:\/|$)/.test(relative)) return true;
  if (/^\.film\/history\/(?:hooks|logs|openfilm-tmp)(?:\/|$)/.test(relative)) return true;
  return /^\.film\/history\/(?:commondir|objects\/info\/alternates|objects\/info\/http-alternates)$/.test(relative);
}
function allowedEntry(value) {
  if (remotionBundlePath(value)) return true;
  if (sharedNovelBundlePath(value)) return true;
  if (scienceBundlePath(value)) return true;
  if (value === 'project.json' || value === 'references.json' || value === 'project-link.json') return true;
  if (/^dependencies\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/project\.json$/.test(value)) return true;
  if (/^covers\/[a-f0-9-]{36}\.png$/.test(value) || /^media\/[A-Za-z0-9_-]{12,80}\.[A-Za-z0-9]{1,10}$/.test(value)) return true;
  if (value.startsWith('analysis/')) return !value.slice(9).split('/').some(part => PRIVATE_NAME.test(part) || PRIVATE_EXT.test(part));
  return value.startsWith('native/') && !nativeExcluded(value.slice(7));
}
function checkedManifest(value, limits) {
  if (!value || value.format !== 'gxproject' || value.version !== PROJECT_BUNDLE_VERSION || !value.project || !Array.isArray(value.files) || !Array.isArray(value.assets) || !Array.isArray(value.projects)) throw failure(400, '此项目包版本或清单不受支持。', 'BUNDLE_VERSION_UNSUPPORTED');
  validateProjectId(value.project.sourceId);
  if (!['video', 'writing', 'science'].includes(value.project.kind) || value.projects[0]?.file !== 'project.json' || value.projects[0]?.sourceId !== value.project.sourceId) throw failure(400, '项目包主项目归属无效。', 'BUNDLE_INVALID_MANIFEST');
  if (!value.files.length || value.files.length > limits.files || value.projects.length < 1 || value.projects.length > 2 || value.assets.length > limits.files) throw failure(413, '项目包清单超过可处理范围。', 'BUNDLE_LIMIT_EXCEEDED');
  let total = 0;
  const names = new Set();
  for (const file of value.files) {
    validateBundlePath(file?.path);
    if (!allowedEntry(file.path) || names.has(keyOf(file.path))) throw failure(400, '项目包含重复或不允许恢复的文件。', 'BUNDLE_UNSAFE_PATH');
    names.add(keyOf(file.path));
    if (!Number.isSafeInteger(file.size) || file.size < 0 || !SHA.test(file.sha256)) throw failure(400, '项目包文件清单无效。', 'BUNDLE_INVALID_MANIFEST');
    total += file.size;
    if (!Number.isSafeInteger(total) || total > limits.unpackedBytes) throw failure(413, '项目包解包体积过大。', 'BUNDLE_LIMIT_EXCEEDED');
  }
  for (const file of value.files) {
    const parts = file.path.split('/'); parts.pop();
    while (parts.length) { if (names.has(keyOf(parts.join('/')))) throw failure(400, '项目包中文件与目录路径冲突。', 'BUNDLE_UNSAFE_PATH'); parts.pop(); }
  }
  if (!names.has('project.json')) throw failure(400, '项目包缺少项目资料。', 'BUNDLE_MISSING_FILE');
  const ids = new Set();
  for (const project of value.projects) {
    validateProjectId(project?.sourceId);
    if (ids.has(project.sourceId) || !names.has(keyOf(project.file)) || (project.file !== 'project.json' && project.file !== `dependencies/${project.sourceId}/project.json`)) throw failure(400, '项目包项目归属无效。', 'BUNDLE_INVALID_MANIFEST');
    if (project.file !== 'project.json' && !['writing', 'science'].includes(project.kind)) throw failure(400, '仅支持随包携带直接来源文案或科普项目。', 'BUNDLE_INVALID_DEPENDENCY');
    if (project.coverId && (!TOKEN.test(project.coverId) || !names.has(`covers/${project.coverId}.png`))) throw failure(400, '项目包缺少封面。', 'BUNDLE_MISSING_FILE');
    ids.add(project.sourceId);
  }
  if (!value.projects.some(project => project.sourceId === value.project.sourceId && project.file === 'project.json')) throw failure(400, '项目包主项目归属无效。', 'BUNDLE_INVALID_MANIFEST');
  for (const file of value.files) { const shared = sharedNovelBundlePath(file.path); if (shared?.kind === 'selection' && !ids.has(shared.projectId)) throw failure(400, '公用素材资料不属于包内项目。', 'BUNDLE_NOVEL_LIBRARY_INVALID'); }
  const assets = new Set();
  for (const asset of value.assets) {
    if (!ASSET.test(asset?.sourceId) || assets.has(asset.sourceId) || !names.has(keyOf(asset.file)) || !['image', 'video', 'audio'].includes(asset.metadata?.type) || !/^(?:media|native)\//.test(asset.file)) throw failure(400, '项目包素材归属无效。', 'BUNDLE_INVALID_MANIFEST');
    assets.add(asset.sourceId);
  }
  const analysisOwners = new Set([...ids, ...assets]);
  for (const file of value.files.filter(item => item.path.startsWith('analysis/'))) if (!analysisOwners.has(file.path.split('/')[1].replace(/\.json$/, ''))) throw failure(400, '分析缓存不属于包内项目或素材。', 'BUNDLE_WRONG_OWNER');
  if (!value.native && value.files.some(file => file.path.startsWith('native/'))) throw failure(400, '原生文件归属清单不一致。', 'BUNDLE_INVALID_MANIFEST');
  if (value.native && !names.has('native/film.html')) throw failure(400, '项目包缺少原生电影工程。', 'BUNDLE_MISSING_FILE');
  return value;
}

function secretText(input, secrets) {
  let text = input;
  for (const secret of secrets) if (typeof secret === 'string' && secret.length >= 4) text = text.split(secret).join('[密钥已隐藏]');
  text = text.replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, '[密钥已隐藏]');
  text = text.replace(/([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token)=)[^&\s"'<>]+/gi, '$1[credential-removed]');
  return text.replace(/((?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)["']?\s*[:=]\s*["'])([^"'\r\n]+)(["'])/gi, '$1[密钥已隐藏]$3');
}
function rewriteText(bytes, mapper) {
  const text = bytes.toString('utf8');
  if (Buffer.from(text).equals(bytes)) return Buffer.from(mapper(text));
  // Keep legacy-encoded native pages byte-for-byte, while still remapping
  // ASCII local IDs/URLs. Never silently transcode a page to broken UTF-8.
  const raw = bytes.toString('latin1'), next = mapper(raw);
  if ([...next].some(character => character.charCodeAt(0) > 255)) throw failure(400, '旧编码页面中发现凭据，请移除凭据或转为UTF-8后重试。', 'BUNDLE_TEXT_ENCODING');
  return Buffer.from(next, 'latin1');
}
function secretScanner(secrets) {
  const needles = secrets.filter(value => typeof value === 'string' && value.length >= 4).map(value => Buffer.from(value));
  const keep = Math.max(256, ...needles.map(value => value.length)); let tail = Buffer.alloc(0);
  return chunk => {
    const bytes = tail.length ? Buffer.concat([tail, chunk]) : chunk;
    if (needles.some(needle => bytes.includes(needle)) || /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/.test(bytes.toString('latin1'))) throw failure(400, '项目文件中发现模型密钥，请移除后再备份。', 'BUNDLE_PRIVATE_CONTENT');
    tail = bytes.subarray(Math.max(0, bytes.length - keep));
  };
}
function cleanValue(value, secrets, depth = 0) {
  if (depth > 60) throw failure(400, '项目包资料层级过深。', 'BUNDLE_INVALID_DATA');
  if (typeof value === 'string') return secretText(value, secrets);
  if (Array.isArray(value)) return value.map(item => cleanValue(item, secrets, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const clean = Object.create(null);
  for (const [key, item] of Object.entries(value)) if (!SECRET_PROPERTY.test(key) && !['__proto__', 'prototype', 'constructor'].includes(key)) clean[key] = cleanValue(item, secrets, depth + 1);
  return clean;
}
function restoreDownloadHistory(message) {
  let changed = false;
  const seen = new Set(), history = [];
  const archive = (file, label) => {
    changed = true;
    const name = typeof file?.name === 'string' ? file.name : '';
    const key = file?.id || file?.url || name;
    if (key && seen.has(key)) return;
    if (key) seen.add(key);
    let sourceUrl = '';
    try { const url = new URL(file?.url); if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) sourceUrl = url.href; } catch { /* No public source was recorded. */ }
    if (sourceUrl) {
      if (!Array.isArray(message.sources)) message.sources = [];
      if (!message.sources.some(source => source?.url === sourceUrl)) message.sources.push({ title: name || '原始下载来源', url: sourceUrl });
    }
    const heading = typeof label === 'string' && label ? label : '下载记录';
    history.push({ type: 'download-history', label: `${heading}${name && !heading.includes(name) ? ' · ' + name : ''}（原文件未随项目包迁移）`, changed: false, ...(name ? { name } : {}), ...(sourceUrl ? { sourceUrl } : {}) });
  };
  const effects = [];
  for (const effect of Array.isArray(message.effects) ? message.effects : []) {
    if (effect?.type === 'download') archive(effect.download, effect.label);
    else effects.push(effect);
  }
  // Current UI reads download effects. Also remove a legacy shortcut list so
  // it cannot reintroduce old local file handles after a later UI migration.
  if (Object.hasOwn(message, 'downloads')) {
    changed = true;
    for (const file of Array.isArray(message.downloads) ? message.downloads : []) archive(file?.download || file, file?.label);
    delete message.downloads;
  }
  if (changed) message.effects = [...effects, ...history];
  return changed;
}
function restoreArtifactHistory(message) {
  // Export files and background jobs belong to the old local session. Imported
  // movie media and current Remotion source/resources follow their own paths.
  const project = '[A-Za-z0-9][A-Za-z0-9_-]{0,127}', uuid = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
  const route = `(?:/api/(?:assistant|project-bundles)/exports/${uuid}/file|/api/openfilm/exports/${project}/${project}/file|/api/projects/${project}/remotion/jobs/${uuid}/files/(?:video\\.mp4|frame-\\d{2}\\.png))`;
  const local = `(?:https?://(?:127\\.0\\.0\\.1|localhost|\\[::1\\])(?::\\d+)?)?${route}(?:[?#][^\\s)<>"']*)?`;
  const whole = new RegExp('^' + local + '$', 'i'), links = new RegExp(`\\[([^\\]\\n]*)\\]\\(${local}\\)`, 'gi'), urls = new RegExp(`(?<![A-Za-z0-9._~:/?-])${local}`, 'gi');
  let changed = false;
  const note = '制作文件未随项目包迁移', seen = new Set(), history = [];
  const readable = value => {
    if (typeof value !== 'string') return value;
    const restored = value.replace(links, (_link, label) => `${label || '制作文件记录'}（${note}）`).replace(urls, `（${note}）`);
    if (restored !== value) changed = true;
    return restored;
  };
  const archive = (file, label) => {
    changed = true;
    const name = typeof file?.name === 'string' ? readable(file.name) : '', key = file?.downloadUrl || file?.id || name || label;
    if (key && seen.has(key)) return;
    if (key) seen.add(key);
    const heading = readable(typeof label === 'string' && label ? label : '制作文件记录');
    history.push({ type: 'artifact-history', label: `${heading}${name && !heading.includes(name) ? ' · ' + name : ''}（${note}）`, changed: false, ...(name ? { name } : {}) });
  };
  const effects = [];
  for (const effect of Array.isArray(message.effects) ? message.effects : []) {
    if (effect?.type === 'artifact') archive(effect.artifact, effect.label);
    else effects.push(effect);
  }
  if (Object.hasOwn(message, 'artifacts')) {
    changed = true;
    for (const file of Array.isArray(message.artifacts) ? message.artifacts : []) archive(file?.artifact || file, file?.label);
    delete message.artifacts;
  }
  if (message.artifact && typeof message.artifact === 'object' && whole.test(message.artifact.downloadUrl || '')) { archive(message.artifact); delete message.artifact; }
  for (const field of ['content', 'result', 'summary']) if (typeof message[field] === 'string') message[field] = readable(message[field]);
  for (const step of Array.isArray(message.steps) ? message.steps : []) for (const field of ['label', 'message']) if (typeof step?.[field] === 'string') step[field] = readable(step[field]);
  if (Array.isArray(message.sources)) message.sources = message.sources.filter(source => {
    if (!whole.test(source?.url || '')) return true;
    archive({ name: source.title, downloadUrl: source.url }); return false;
  });
  if (changed) message.effects = [...effects, ...history];
  return changed;
}
function historyConfig(text) {
  // Never transplant command-bearing Git config, includes, hooks or remotes.
  const sha256 = /objectformat\s*=\s*sha256/i.test(text);
  return `[core]\n\trepositoryformatversion = ${sha256 ? 1 : 0}\n\tbare = false\n\tfilemode = false\n\tlogallrefupdates = true\n${sha256 ? '[extensions]\n\tobjectformat = sha256\n' : ''}`;
}
function assetIds(value, into = new Set(), key = '') {
  if (typeof value === 'string') { if ((key === 'assetId' || key === 'originalAssetId' || key === 'assetIds') && ASSET.test(value)) into.add(value); return into; }
  if (Array.isArray(value)) { for (const item of value) assetIds(item, into, key); return into; }
  if (value && typeof value === 'object') {
    if ((key === 'asset' || key === 'assets') && ASSET.test(value.id) && ['image', 'video', 'audio'].includes(value.type)) into.add(value.id);
    for (const [field, item] of Object.entries(value)) assetIds(item, into, field);
  }
  return into;
}
function publicReport(manifest, warnings = [], issues = []) {
  return { ok: !issues.length, format: 'gxproject', version: 1, project: { id: manifest.project.sourceId, title: manifest.project.title, kind: manifest.project.kind }, fileCount: manifest.files.length, bytes: manifest.files.reduce((sum, item) => sum + item.size, 0), assetCount: manifest.assets.length + manifest.files.filter(file => file.path.startsWith('novel-assets/') && file.path.endsWith('/metadata.json') || sharedNovelBundlePath(file.path)?.kind === 'asset').length, scienceDocumentCount: manifest.files.filter(file => file.path.startsWith('science-documents/') && file.path.endsWith('/document.json')).length, remotionProjectCount: manifest.files.filter(file => remotionBundlePath(file.path)?.kind === 'record').length, native: Boolean(manifest.native), dependencies: manifest.projects.slice(1).map(item => ({ id: item.sourceId, title: item.title, kind: item.kind })), warnings, issues };
}
async function exists(filename) { try { await access(filename); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function noLinks(root, filename, { missing = false } = {}) {
  const absolute = path.resolve(filename), scope = path.resolve(root);
  if (absolute !== scope && !inside(scope, absolute)) throw failure(403, '项目文件超出受控目录。', 'BUNDLE_PATH_OUTSIDE');
  let current = scope;
  const parts = [null, ...path.relative(scope, absolute).split(path.sep).filter(Boolean)];
  for (const part of parts) {
    if (part !== null) current = path.join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw failure(409, '项目仍含外链，请先在编辑器收集素材。', 'BUNDLE_EXTERNAL_LINK'); }
    catch (error) { if (missing && error.code === 'ENOENT') return; throw error; }
  }
}

class PackageReader {
  constructor(stream) { this.stream = stream; this.iterator = stream[Symbol.asyncIterator](); this.chunk = Buffer.alloc(0); this.at = 0; this.ended = false; }
  async next(maximum) {
    while (this.at >= this.chunk.length) {
      const next = await this.iterator.next();
      if (next.done) { this.ended = true; return null; }
      this.chunk = next.value; this.at = 0;
    }
    const chunk = this.chunk.subarray(this.at, this.at + maximum); this.at += chunk.length; return chunk;
  }
  async exact(size) {
    const chunks = []; let remaining = size;
    while (remaining) { const next = await this.next(remaining); if (!next) throw failure(400, '项目包缺少文件或上传未完成。', 'BUNDLE_TRUNCATED'); chunks.push(next); remaining -= next.length; }
    return Buffer.concat(chunks, size);
  }
  async *payload(size, digest, scan = () => {}, signal) {
    let remaining = size;
    while (remaining) { signal?.throwIfAborted(); const next = await this.next(Math.min(remaining, 64 * 1024)); if (!next) throw failure(400, '项目包中的文件不完整。', 'BUNDLE_TRUNCATED'); remaining -= next.length; digest.update(next); scan(next); yield next; }
  }
}

/** No dependency on zip binaries, Python, npm downloads or full-file base64. */
export async function createProjectBundleService({ dataDir, root, store, videoService, openFilm, references, analysisService, scienceDocuments, novelAssets, novelLibrary, remotionProjects, sensitiveStrings = () => [], limits: inputLimits = {}, idFactory = randomUUID } = {}) {
  if (!path.isAbsolute(dataDir || '') || !store?.read || !store?.save) throw new TypeError('An absolute dataDir and project store are required.');
  const data = path.resolve(dataDir), home = path.join(data, 'project-bundles'), restoredRoot = path.join(home, 'restored-assets');
  const limits = { ...PROJECT_BUNDLE_LIMITS, ...inputLimits };
  await mkdir(home, { recursive: true }); await noLinks(data, home);
  const exports = new Map(), imports = new Map();
  const activeOperations = new Set(), serviceAbort = new AbortController();
  let closing = false, closePromise;
  const check = () => { if (closing) throw failure(503, '项目包服务正在关闭。', 'BUNDLE_SERVICE_CLOSED'); };
  const secrets = () => [...new Set((sensitiveStrings() || []).filter(value => typeof value === 'string' && value))];
  const jobDirectory = token => { if (!TOKEN.test(token)) throw failure(404, '项目包操作已失效，请重新选择。', 'BUNDLE_NOT_FOUND'); return path.join(home, token); };
  async function cleanup(directory) { const absolute = path.resolve(directory); if (!inside(home, absolute)) throw new Error('Unsafe bundle cleanup'); await rm(absolute, { recursive: true, force: true }); }

  async function buildSnapshot(id, { signal } = {}) {
    check(); signal?.throwIfAborted(); validateProjectId(id); await store.settle?.();
    const storedProject = await store.read(id);
    if (!storedProject) throw failure(404, '项目不存在。', 'PROJECT_NOT_FOUND');
    const project = { ...storedProject, kind: summarizeProject(storedProject).kind };
    const manifest = { format: 'gxproject', version: 1, application: 'GuangxuanStudio', createdAt: new Date().toISOString(), project: { sourceId: id, title: project.title || '未命名项目', kind: project.kind }, projects: [], assets: [], files: [], native: false };
    const entries = [], issues = [], warnings = [], names = new Set(), rawSnapshots = []; let remotionVersions = [], remotionOwners = [];
    const knownSecrets = secrets();
    async function addBuffer(relative, bytes) {
      signal?.throwIfAborted();
      if (secretText(relative, knownSecrets) !== relative) throw failure(400, '文件名含凭据，请重命名后再备份。', 'BUNDLE_PRIVATE_CONTENT');
      validateBundlePath(relative);
      if (names.has(keyOf(relative))) { if (manifest.files.some(file => keyOf(file.path) === keyOf(relative) && file.path !== relative)) throw failure(400, '文件名在不同系统上冲突，请重命名后重试。', 'BUNDLE_DUPLICATE_PATH'); return; }
      if (!allowedEntry(relative)) throw failure(400, '项目含不支持备份的文件路径。', 'BUNDLE_UNSAFE_PATH');
      if (manifest.files.length >= limits.files) throw failure(413, '项目文件数量过多，请拆分后备份。', 'BUNDLE_LIMIT_EXCEEDED');
      names.add(keyOf(relative)); const file = { path: relative, size: bytes.length, sha256: hash(bytes) }; manifest.files.push(file); entries.push({ file, bytes });
    }
    async function addJson(relative, value) { await addBuffer(relative, Buffer.from(JSON.stringify(cleanValue(withoutSecrets(value), knownSecrets), null, 2) + '\n')); }
    async function addFile(relative, filename, scope, preserveBytes = false) {
      signal?.throwIfAborted();
      if (names.has(keyOf(relative))) { if (manifest.files.some(file => keyOf(file.path) === keyOf(relative) && file.path !== relative)) issues.push(issue('BUNDLE_DUPLICATE_PATH', relative, '文件名在不同系统上冲突，请重命名后重试。')); return; }
      try {
        if (secretText(relative, knownSecrets) !== relative) throw failure(400, '文件名含凭据，请重命名后再备份。', 'BUNDLE_PRIVATE_CONTENT');
        if (scope) await noLinks(scope, filename);
        const info = await lstat(filename);
        if (!info.isFile() || info.isSymbolicLink()) throw failure(409, '文件为外链或不是普通文件，请先收集素材。', 'BUNDLE_EXTERNAL_LINK');
        rawSnapshots.push({ filename, size: info.size, mtimeMs: info.mtimeMs });
        if (preserveBytes && TEXT.test(relative)) {
          if (info.size > limits.textBytes) throw failure(413, '项目中的资料文本过大。', 'BUNDLE_TEXT_TOO_LARGE');
          const bytes = await readFile(filename), text = bytes.toString('utf8');
          const safe = /\.json$/i.test(relative) ? JSON.stringify(JSON.parse(text)) === JSON.stringify(cleanValue(JSON.parse(text), knownSecrets)) : secretText(text, knownSecrets) === text;
          if (!safe) throw failure(400, '资料中含凭据内容，请移除后再备份，原文不会被静默改写。', 'BUNDLE_PRIVATE_CONTENT');
        }
        if (!preserveBytes && (TEXT.test(relative) || relative.toLowerCase() === 'native/.film/history/config')) {
          if (info.size > limits.textBytes) throw failure(413, '项目中的文本或状态文件过大。', 'BUNDLE_TEXT_TOO_LARGE');
          const bytes = await readFile(filename), text = bytes.toString('utf8');
          if (relative.toLowerCase() === 'native/.film/history/config') await addBuffer(relative, Buffer.from(historyConfig(text)));
          else if (/\.json$/i.test(relative)) {
            let value; try { value = JSON.parse(text); } catch { throw failure(400, '项目中的状态文件不是有效JSON。', 'BUNDLE_INVALID_DATA'); }
            await addJson(relative, value);
          } else await addBuffer(relative, rewriteText(bytes, text => secretText(text, knownSecrets)));
          return;
        }
        validateBundlePath(relative);
        if (!allowedEntry(relative) || names.has(keyOf(relative))) throw failure(400, '项目包含重复或私有文件。', 'BUNDLE_UNSAFE_PATH');
        const digest = createHash('sha256'), scan = secretScanner(knownSecrets); for await (const chunk of createReadStream(filename)) { signal?.throwIfAborted(); digest.update(chunk); scan(chunk); }
        if (manifest.files.length >= limits.files) throw failure(413, '项目文件数量过多，请拆分后备份。', 'BUNDLE_LIMIT_EXCEEDED');
        const file = { path: relative, size: info.size, sha256: digest.digest('hex') }; names.add(keyOf(relative)); manifest.files.push(file); entries.push({ file, filename });
      } catch (error) { if (signal?.aborted) throw error; issues.push(issue(error.code || 'BUNDLE_FILE_MISSING', secretText(relative, knownSecrets), error instanceof AppError ? error.message : '文件缺失或无法读取，请重新链接后备份。')); }
    }
    const sourceFile = path.join(data, 'project-links', `${id}.json`);
    let projectLink;
    if (await exists(sourceFile)) {
      await noLinks(data, sourceFile); const saved = JSON.parse(await readFile(sourceFile, 'utf8'));
      if (project.kind === 'video' && saved.version === 1 && saved.targetCreatedAt === project.createdAt) { projectLink = saved; await addJson('project-link.json', projectLink); }
      else warnings.push(issue('BUNDLE_LINK_OWNER_EXCLUDED', 'project-link.json', '旧关联记录不属于当前项目创建批次，未纳入备份。'));
    }
    const sourceId = typeof projectLink?.sourceProjectId === 'string' ? projectLink.sourceProjectId : typeof project.sourceProjectId === 'string' ? project.sourceProjectId : null;
    const records = [project];
    if (sourceId && sourceId !== id) {
      let dependency; try { dependency = await store.read(validateProjectId(sourceId)); } catch { /* Report a missing source below. */ }
      if (dependency && ['writing', 'science'].includes(summarizeProject(dependency).kind)) records.push({ ...dependency, kind: summarizeProject(dependency).kind });
      else warnings.push(issue('BUNDLE_SOURCE_MISSING', 'project-link.json', '关联来源项目不在本包中；保留来源快照，恢复时会移除失效关联。'));
    }
    for (const [index, value] of records.entries()) {
      const file = index ? `dependencies/${value.id}/project.json` : 'project.json';
      await addJson(file, value);
      manifest.projects.push({ sourceId: value.id, kind: value.kind, title: secretText(String(value.title || '未命名项目'), knownSecrets), file, ...(value.coverAssetId ? { coverId: value.coverAssetId } : {}) });
      if (value.coverAssetId) await addFile(`covers/${value.coverAssetId}.png`, path.join(data, 'project-covers', `${value.coverAssetId}.png`), data);
    }
    const nativeDirectory = path.join(data, 'openfilm', 'projects', id);
    let marker = {};
    if (await exists(nativeDirectory)) {
      await noLinks(data, nativeDirectory);
      manifest.native = true;
      async function walk(directory, relative = '') {
        if (relative && await exists(path.join(directory, '.guangxuan-project.json'))) { issues.push(issue('BUNDLE_NESTED_PROJECT', `native/${relative}`, '工程中包含另一份项目目录，请仅收集所需媒体后备份。')); return; }
        for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
          const name = relative ? `${relative}/${entry.name}` : entry.name, filename = path.join(directory, entry.name);
          if (nativeExcluded(name)) { if (!/^(?:\.film\/(?:cache|previews|thumbnails)|\.film\/history\/(?:hooks|logs))/.test(name)) warnings.push(issue('BUNDLE_PRIVATE_FILE_EXCLUDED', `native/${name}`, '不备份缓存、凭据或与项目无关的配置文件。')); continue; }
          if (entry.isSymbolicLink()) { issues.push(issue('BUNDLE_EXTERNAL_LINK', `native/${name}`, '工程仍含外链素材，请先在编辑器中收集到工程再备份。')); continue; }
          if (entry.isDirectory()) await walk(filename, name);
          else if (entry.isFile()) await addFile(`native/${name}`, filename, nativeDirectory);
        }
      }
      await walk(nativeDirectory);
      if (!names.has('native/film.html')) issues.push(issue('BUNDLE_MISSING_FILM', 'native/film.html', '原生工程缺少film.html。'));
      const markerFile = path.join(nativeDirectory, '.guangxuan-project.json');
      if (await exists(markerFile)) {
        marker = JSON.parse(await readFile(markerFile, 'utf8'));
        if (marker.projectId && marker.projectId !== id) issues.push(issue('BUNDLE_WRONG_OWNER', 'native/.guangxuan-project.json', '原生工程不属于此档案项目。'));
      }
      const linkFile = path.join(nativeDirectory, '.film', 'media-links.json');
      if (await exists(linkFile)) {
        let links; try { links = JSON.parse(await readFile(linkFile, 'utf8')); } catch { issues.push(issue('BUNDLE_INVALID_LINKS', 'native/.film/media-links.json', '外链记录无法读取，请先在编辑器中检查。')); }
        for (const link of Array.isArray(links) ? links : []) if (typeof link?.name === 'string') issues.push(issue('BUNDLE_EXTERNAL_LINK', `native/${link.name}`, '此素材仍使用外部链接，请先在编辑器中收集到工程再备份。'));
      }
    }
    let referenceState;
    if (storedProject.kind === 'video' && references?.list) referenceState = await references.list(id);
    const referenceFile = path.join(data, 'references', id, 'index.json');
    if (await exists(referenceFile)) {
      await noLinks(data, referenceFile);
      const saved = JSON.parse(await readFile(referenceFile, 'utf8'));
      // Keep newly authored optional fields (including reference time ranges),
      // even when an older public list response does not expose them yet.
      if (saved.projectCreatedAt === project.createdAt && saved.version === 1 && Array.isArray(saved.items)) referenceState = saved;
      else if (!referenceState) issues.push(issue('BUNDLE_INVALID_REFERENCES', 'references.json', '参考库归属或版本不一致，请重新打开项目核对。'));
    }
    if (referenceState) await addJson('references.json', { ...referenceState, version: 1, projectCreatedAt: project.createdAt });
    const science = await collectScienceBundleFiles({ dataDir: data, projectIds: records.map(value => value.id), projects: records, signal });
    warnings.push(...science.warnings);
    for (const entry of science.entries) await addFile(entry.relative, entry.filename, entry.scope, true);
    if (science.entries.length) {
      let checking = 'science-documents';
      try {
        const scienceRecords = new Map(manifest.projects.map(record => [record.file, records.find(value => value.id === record.sourceId)]));
        for (const entry of science.entries) {
          signal?.throwIfAborted(); checking = entry.relative;
          if (/\.json$/i.test(entry.relative)) scienceRecords.set(entry.relative, JSON.parse(await readFile(entry.filename, 'utf8')));
          const resource = scienceBundlePath(entry.relative);
          if (resource.kind === 'science-documents' && resource.name === 'document.json' && scienceDocuments?.get) await scienceDocuments.get(resource.projectId, resource.id, { signal });
          if (resource.kind === 'novel-assets' && resource.name === 'metadata.json' && novelAssets?.file) await novelAssets.file(resource.projectId, resource.id);
        }
        validateScienceBundleContents(manifest, scienceRecords);
      } catch (error) {
        if (signal?.aborted) throw error;
        issues.push(issue(error.code || 'BUNDLE_SCIENCE_INVALID', error.file || checking, error instanceof AppError ? error.message : '资料或自定义图片与记录不一致，请重新导入后备份。'));
      }
    }
    try {
      const shared = await collectSharedNovelBundle({ projects: records, novelLibrary, signal });
      for (const entry of shared.entries) {
        secretScanner(knownSecrets)(entry.bytes);
        if (entry.relative.endsWith('.json')) { const record = JSON.parse(entry.bytes.toString('utf8')); if (JSON.stringify(record) !== JSON.stringify(cleanValue(record, knownSecrets))) throw failure(400, '公用素材设定含凭据内容，请移除后再备份；设定不会被静默改写。', 'BUNDLE_PRIVATE_CONTENT'); }
        await addBuffer(entry.relative, entry.bytes);
      }
      const checking = new Map([...manifest.projects.map(record => [record.file, records.find(value => value.id === record.sourceId)]), ...shared.jsonRecords]);
      validateSharedNovelBundle(manifest, checking);
    } catch (error) { if (signal?.aborted) throw error; issues.push(issue(error.code || 'BUNDLE_NOVEL_LIBRARY_INVALID', error.file || 'novel-library', error instanceof AppError ? error.message : '公用素材无法完整备份，请检查人物、场景和图片。')); }
    try {
      const source = await collectRemotionBundle({ projects: records, remotionProjects, signal, dataDir: data }); remotionVersions = source.versions; remotionOwners = source.owners; warnings.push(...source.warnings);
      for (const entry of source.entries) {
        if (entry.bytes) {
          secretScanner(knownSecrets)(entry.bytes);
          const resource = remotionBundlePath(entry.relative), text = entry.bytes.toString('utf8');
          if (secretText(text, knownSecrets) !== text || resource?.kind === 'record' && JSON.stringify(JSON.parse(text)) !== JSON.stringify(cleanValue(JSON.parse(text), knownSecrets))) throw failure(400, '自由动画源码或输入参数含凭据，请移除后再备份；源码不会被静默改写。', 'BUNDLE_PRIVATE_CONTENT');
          await addBuffer(entry.relative, entry.bytes);
        } else await addFile(entry.relative, entry.filename, entry.scope, true);
      }
      const checking = new Map([...manifest.projects.map(record => [record.file, records.find(value => value.id === record.sourceId)]), ...source.jsonRecords]); validateRemotionBundle(manifest, checking);
    } catch (error) { if (signal?.aborted) throw error; issues.push(issue(error.code || 'BUNDLE_REMOTION_INVALID', error.file || 'remotion-projects', error instanceof AppError ? error.message : '自由动画源码无法完整备份。')); }
    const wanted = assetIds(project); assetIds(referenceState, wanted); assetIds(marker.media, wanted);
    for (const id of science.novelAssetIds) wanted.delete(id);
    for (const oldId of [...wanted].sort()) {
      try {
        let metadata, filename, packaged;
        for (const [relative, value] of Object.entries(marker.media || {})) if ((value?.assetId === oldId || value?.originalAssetId === oldId) && names.has(keyOf(`native/${relative}`))) { filename = path.join(nativeDirectory, ...relative.split('/')); packaged = `native/${relative}`; metadata = { ...value, id: oldId }; break; }
        if (videoService?.resolveAsset) {
          try { const asset = await videoService.resolveAsset(oldId); metadata = { ...asset, ...metadata }; filename ||= asset.path; } catch (error) { if (!filename) throw error; }
        }
        if (!filename || !metadata || !['image', 'video', 'audio'].includes(metadata.type)) throw failure(404, '素材记录缺失，请重新导入。', 'BUNDLE_MEDIA_MISSING');
        const otherProjects = path.join(data, 'openfilm', 'projects');
        const actual = await realpath(filename);
        if (inside(otherProjects, actual) && !inside(nativeDirectory, actual)) throw failure(403, '素材属于其它原生项目，请先复制到当前工程。', 'BUNDLE_OTHER_PROJECT_MEDIA');
        if (!packaged) { const extension = path.extname(filename).toLowerCase(); if (!/^\.[a-z0-9]{1,10}$/.test(extension)) throw failure(400, '素材文件名无有效扩展名。', 'BUNDLE_MEDIA_INVALID'); packaged = `media/${oldId}${extension}`; await addFile(packaged, actual); }
        if (!names.has(keyOf(packaged))) continue;
        const clean = {}; for (const key of ['name', 'type', 'duration', 'width', 'height', 'hasAudio', 'generated', 'generatedType', 'prompt', 'model', 'plan']) if (metadata[key] !== undefined) clean[key] = metadata[key];
        manifest.assets.push({ sourceId: oldId, file: packaged, metadata: cleanValue(clean, knownSecrets) });
      } catch (error) { issues.push(issue(error.code || 'BUNDLE_MEDIA_MISSING', `media/${oldId}`, error instanceof AppError ? error.message : '素材文件缺失或已变化，请重新链接后备份。')); }
    }
    const analysisIds = new Set([id, ...manifest.projects.map(item => item.sourceId), ...wanted]);
    for (const analysisId of analysisIds) {
      for (const suffix of ['', '.json']) {
        const filename = path.join(data, 'source-analysis', analysisId + suffix);
        if (!await exists(filename)) continue;
        const info = await lstat(filename);
        if (info.isDirectory() && !info.isSymbolicLink()) {
          async function analysisWalk(folder, relative) { for (const entry of await readdir(folder, { withFileTypes: true })) { const name = `${relative}/${entry.name}`, file = path.join(folder, entry.name); if (entry.isDirectory()) await analysisWalk(file, name); else await addFile(`analysis/${name}`, file, path.join(data, 'source-analysis')); } }
          await analysisWalk(filename, analysisId);
        } else await addFile(`analysis/${analysisId}${suffix}`, filename, data);
      }
    }
    if (manifest.native) issues.push(...await verifyFilmFiles(manifest, relative => entries.find(entry => entry.file.path === relative)?.bytes, nativeDirectory));
    if (!issues.length) { try { checkedManifest(manifest, limits); } catch (error) { issues.push(issue(error.code || 'BUNDLE_INVALID_MANIFEST', '', error.message)); } }
    manifest.project.title = secretText(String(manifest.project.title), knownSecrets);
    const report = cleanValue(publicReport(manifest, warnings, issues), knownSecrets);
    return { manifest, entries, rawSnapshots, remotionVersions, remotionOwners, report, project, sourceSignature: hash(Buffer.from(JSON.stringify(storedProject))) };
  }

  async function verifyFilmFiles(manifest, bufferFor, nativeDirectory) {
    if (!manifest.native) return [];
    const issues = [], names = new Set(manifest.files.map(item => keyOf(item.path)));
    try {
      const source = bufferFor?.('native/film.html') || await readFile(path.join(nativeDirectory, 'film.html'));
      const { readFilmFile } = await import(pathToFileURL(path.join(root, 'integrations/openfilm/packages/openfilm/src/film-doc.mjs')).href);
      const parsed = readFilmFile(source.toString('utf8')), doc = parsed.doc || parsed.value;
      if (!doc || parsed.problems?.length) throw new Error('Invalid film');
      for (const track of doc.tracks || []) for (const clip of track.clips || []) {
        if (typeof clip.src !== 'string') continue;
        if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(clip.src)) { issues.push(issue('BUNDLE_REMOTE_MEDIA', clip.src.slice(0, 180).replace(/\?.*$/, ''), '时间线仍引用远程或外部媒体，请先收集为本地素材。')); continue; }
        let relative = clip.src.replace(/^\/+/, '').split(/[?#]/)[0]; try { relative = decodeURIComponent(relative); } catch { /* The literal name can still be checked. */ }
        try { validateBundlePath(relative); } catch { issues.push(issue('BUNDLE_UNSAFE_FILM_PATH', 'native/film.html', '时间线含越界媒体路径。')); continue; }
        if (!names.has(keyOf(`native/${relative}`))) issues.push(issue('BUNDLE_FILM_MEDIA_MISSING', `native/${relative}`, '时间线引用的文件缺失，请重新链接后备份。'));
      }
      const { linkKind, rewriteLinks } = await import(pathToFileURL(path.join(root, 'integrations/openfilm/packages/openfilm/studio/server/page-links.mjs')).href);
      const reported = new Set();
      for (const file of manifest.files.filter(item => item.path.startsWith('native/') && !item.path.toLowerCase().startsWith('native/.film/'))) {
        const relative = file.path.slice(7), kind = linkKind(relative); if (!kind || file.size > limits.textBytes) continue;
        const bytes = bufferFor?.(file.path) || await readFile(path.join(nativeDirectory, ...relative.split('/'))), text = bytes.toString('utf8');
        const base = path.posix.dirname(relative) === '.' ? '' : path.posix.dirname(relative);
        rewriteLinks(text, kind, base, base, target => {
          let decoded = target; try { decoded = decodeURIComponent(target); } catch { /* Treat it as a literal file name. */ }
          const logical = `native/${decoded}`;
          const key = keyOf(logical);
          if (!names.has(key) && ![...names].some(name => name.startsWith(key.replace(/\/$/, '') + '/')) && !reported.has(key)) {
            reported.add(key); issues.push(issue('BUNDLE_PAGE_RESOURCE_MISSING', logical, '页面依赖的脚本、图片或其它文件缺失，请补齐后备份。'));
          }
          return target;
        });
      }
    } catch { issues.push(issue('BUNDLE_INVALID_FILM', 'native/film.html', '原生工程无法解析，不能确认完整恢复。')); }
    return issues;
  }

  async function inspectProject(id) { return (await buildSnapshot(id, { signal: serviceAbort.signal })).report; }
  async function prepareExport(id, { signal, onProgress = () => {} } = {}) {
    signal = signal ? AbortSignal.any([serviceAbort.signal, signal]) : serviceAbort.signal;
    const snapshot = await buildSnapshot(id, { signal });
    if (!snapshot.report.ok) throw failure(409, '项目尚不能完整备份，请先处理清单中的问题。', 'BUNDLE_PREFLIGHT_FAILED', snapshot.report);
    const token = randomUUID(), directory = jobDirectory(token); await mkdir(directory); const filename = path.join(directory, 'project.gxproject');
    const manifestBytes = Buffer.from(JSON.stringify(snapshot.manifest));
    if (manifestBytes.length > limits.manifestBytes) { await cleanup(directory); throw failure(413, '项目清单过大，请拆分项目。', 'BUNDLE_LIMIT_EXCEEDED'); }
    const length = Buffer.alloc(4); length.writeUInt32BE(manifestBytes.length);
    const total = snapshot.report.bytes;
    async function* source() {
      yield PROJECT_BUNDLE_MAGIC; yield length; yield manifestBytes;
      let done = 0;
      for (const [index, entry] of snapshot.entries.entries()) {
        signal?.throwIfAborted();
        const digest = createHash('sha256'), scan = secretScanner(secrets()); let size = 0;
        for await (const chunk of entry.bytes ? [entry.bytes] : createReadStream(entry.filename)) { signal?.throwIfAborted(); digest.update(chunk); scan(chunk); size += chunk.length; done += chunk.length; yield chunk; }
        if (size !== entry.file.size || digest.digest('hex') !== entry.file.sha256) throw failure(409, '备份期间项目文件发生变化，请保存后重试。', 'BUNDLE_SOURCE_CHANGED');
        onProgress({ phase: 'pack', done: index + 1, total: snapshot.entries.length, bytes: done, totalBytes: total });
      }
    }
    try {
      secretScanner(secrets())(manifestBytes);
      let written = 0;
      const bounded = new Transform({ transform(chunk, _encoding, done) { written += chunk.length; done(written > limits.packageBytes ? failure(413, '项目包超过体积限制。', 'BUNDLE_LIMIT_EXCEEDED') : null, chunk); } });
      await pipeline(Readable.from(source()), createGzip({ level: 1 }), bounded, createWriteStream(filename, { flags: 'wx', mode: 0o600 }), ...(signal ? [{ signal }] : []));
      for (const before of snapshot.rawSnapshots) { const now = await stat(before.filename); if (now.size !== before.size || now.mtimeMs !== before.mtimeMs) throw failure(409, '备份期间项目仍在保存，请稍后重试。', 'BUNDLE_SOURCE_CHANGED'); }
      if (hash(Buffer.from(JSON.stringify(await store.read(id)))) !== snapshot.sourceSignature) throw failure(409, '备份期间项目资料发生变化，请重试。', 'BUNDLE_SOURCE_CHANGED');
      for (const before of snapshot.remotionVersions) if ((await remotionProjects.read(before.projectId, before.id)).revision !== before.revision) throw failure(409, '备份期间自由动画源码仍在修改，请保存后重试。', 'BUNDLE_SOURCE_CHANGED');
      for (const before of snapshot.remotionOwners) {
        const now = (await remotionProjects.list(before.projectId)).filter(item => !item.ownerCreatedAt || item.ownerCreatedAt === before.ownerCreatedAt).map(({ id, revision }) => ({ id, revision })).sort((a, b) => a.id.localeCompare(b.id));
        if (JSON.stringify(now) !== JSON.stringify(before.revisions)) throw failure(409, '备份期间自由动画工程清单发生变化，请保存后重试。', 'BUNDLE_SOURCE_CHANGED');
      }
      const record = { filename, directory, manifest: snapshot.manifest, report: snapshot.report, createdAt: Date.now() }; exports.set(token, record);
      return { token, report: snapshot.report, bytes: (await stat(filename)).size, filename: `${String(snapshot.manifest.project.title).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 80) || 'Gx项目'}.gxproject`, downloadUrl: `/api/project-bundles/exports/${token}/file` };
    } catch (error) { await cleanup(directory); throw error; }
  }

  async function unpack(filename, directory, signal) {
    const source = createReadStream(filename), stream = createGunzip(), reader = new PackageReader(stream);
    const pumping = pipeline(source, stream); pumping.catch(() => {});
    try {
      if (!(await reader.exact(PROJECT_BUNDLE_MAGIC.length)).equals(PROJECT_BUNDLE_MAGIC)) throw failure(400, '所选文件不是Gx完整项目包。', 'BUNDLE_INVALID_FORMAT');
      const length = (await reader.exact(4)).readUInt32BE();
      if (!length || length > limits.manifestBytes) throw failure(413, '项目包清单超过限制。', 'BUNDLE_LIMIT_EXCEEDED');
      let manifest; try { const bytes = await reader.exact(length); secretScanner(secrets())(bytes); manifest = JSON.parse(bytes.toString('utf8')); } catch (error) { if (error instanceof AppError) throw error; throw failure(400, '项目包清单损坏。', 'BUNDLE_INVALID_MANIFEST'); }
      checkedManifest(manifest, limits);
      const entriesRoot = path.join(directory, 'entries'); await mkdir(entriesRoot);
      for (const file of manifest.files) {
        signal?.throwIfAborted();
        const target = path.join(entriesRoot, ...file.path.split('/')); await mkdir(path.dirname(target), { recursive: true });
        const digest = createHash('sha256');
        await pipeline(Readable.from(reader.payload(file.size, digest, secretScanner(secrets()), signal)), createWriteStream(target, { flags: 'wx', mode: 0o600 }));
        if (digest.digest('hex') !== file.sha256) throw failure(400, '项目包文件校验失败，原有项目未改动。', 'BUNDLE_HASH_MISMATCH', { ok: false, issues: [issue('BUNDLE_HASH_MISMATCH', file.path, '文件SHA256不一致。')] });
      }
      if (await reader.next(1)) throw failure(400, '项目包包含清单以外的数据。', 'BUNDLE_TRAILING_DATA');
      return { manifest, entriesRoot };
    } catch (error) { if (error instanceof AppError) throw error; throw failure(400, '项目包损坏或上传未完成。', 'BUNDLE_CORRUPT'); }
    finally { source.destroy(); stream.destroy(); await pumping.catch(() => {}); }
  }
  async function validateContents(manifest, entriesRoot) {
    const known = secrets(), records = new Map();
    for (const file of manifest.files) {
      const remotionFile = remotionBundlePath(file.path);
      if (!TEXT.test(file.path) && remotionFile?.kind !== 'source' && file.path.toLowerCase() !== 'native/.film/history/config') continue;
      if (file.size > limits.textBytes) throw failure(413, '包内文本过大。', 'BUNDLE_TEXT_TOO_LARGE');
      const bytes = await readFile(path.join(entriesRoot, ...file.path.split('/'))), text = bytes.toString('utf8');
      if (remotionFile?.kind === 'source') {
        if (!Buffer.from(text, 'utf8').equals(bytes)) throw failure(400, '自由动画源码不是完整UTF-8文本。', 'BUNDLE_REMOTION_INVALID');
        if (secretText(text, known) !== text) throw failure(400, '自由动画源码中含凭据，请移除后重新导出。', 'BUNDLE_PRIVATE_CONTENT');
        continue;
      }
      if (/\.json$/i.test(file.path)) {
        let value; try { value = JSON.parse(text); } catch { throw failure(400, '项目包状态文件无效。', 'BUNDLE_INVALID_DATA'); }
        if (JSON.stringify(value) !== JSON.stringify(cleanValue(value, known))) throw failure(400, '项目包含凭据字段，请从Gx重新导出。', 'BUNDLE_PRIVATE_CONTENT');
        records.set(file.path, value);
      } else if (secretText(text, known) !== text) throw failure(400, '项目包中含模型密钥，请移除后重新导出。', 'BUNDLE_PRIVATE_CONTENT');
    }
    for (const record of manifest.projects) {
      const project = records.get(record.file);
      if (!project || project.id !== record.sourceId || project.kind !== record.kind || !['video', 'writing', 'science'].includes(project.kind)) throw failure(400, '项目包元数据与归属不一致。', 'BUNDLE_WRONG_OWNER');
      if ((project.coverAssetId || '') !== (record.coverId || '')) throw failure(400, '项目包封面归属不一致。', 'BUNDLE_WRONG_OWNER');
    }
    for (const record of manifest.projects) if (record.coverId) validateCoverPng(await readFile(path.join(entriesRoot, 'covers', record.coverId + '.png')));
    const link = records.get('project-link.json'), primary = records.get('project.json');
    if (link && (primary.kind !== 'video' || link.version !== 1 || link.targetCreatedAt !== primary.createdAt)) throw failure(400, '项目包中的来源关联不属于当前项目。', 'BUNDLE_WRONG_OWNER');
    const references = records.get('references.json');
    if (references && (!Array.isArray(references.items) || references.items.length > 8 || references.version !== 1)) throw failure(400, '项目包参考库格式无效。', 'BUNDLE_INVALID_REFERENCES');
    const science = validateScienceBundleContents(manifest, records);
    validateSharedNovelBundle(manifest, records);
    validateRemotionBundle(manifest, records);
    const assets = new Set([...manifest.assets.map(item => item.sourceId), ...science.novelAssetIds]);
    for (const value of [...manifest.projects.map(record => records.get(record.file)), references]) for (const id of assetIds(value)) if (!assets.has(id)) throw failure(400, '项目包缺少已引用素材。', 'BUNDLE_MISSING_FILE');
    const filmIssues = await verifyFilmFiles(manifest, undefined, path.join(entriesRoot, 'native'));
    if (filmIssues.length) throw failure(400, '项目包中的原生工程缺少文件。', 'BUNDLE_FILM_INCOMPLETE', publicReport(manifest, [], filmIssues));
    return records;
  }
  async function receiveImport(readable, { signal } = {}) {
    signal = signal ? AbortSignal.any([serviceAbort.signal, signal]) : serviceAbort.signal;
    check();
    signal?.throwIfAborted();
    const token = randomUUID(), directory = jobDirectory(token); await mkdir(directory); const filename = path.join(directory, 'upload.gxproject');
    let bytes = 0;
    const limiter = new Transform({ transform(chunk, _encoding, done) { bytes += chunk.length; done(bytes > limits.packageBytes ? failure(413, '项目包超过体积限制。', 'BUNDLE_LIMIT_EXCEEDED') : null, chunk); } });
    const timeout = setTimeout(() => limiter.destroy(failure(408, '项目包上传超时，请重试。', 'BUNDLE_UPLOAD_TIMEOUT')), 30 * 60 * 1000); timeout.unref();
    const aborted = () => limiter.destroy(failure(499, '项目包上传已取消。', 'BUNDLE_CANCELLED'));
    signal?.addEventListener('abort', aborted, { once: true }); readable.once('aborted', aborted); readable.once('error', aborted);
    try {
      const completed = pipeline(limiter, createWriteStream(filename, { flags: 'wx', mode: 0o600 })); readable.pipe(limiter); await completed;
      if (!bytes) throw failure(400, '所选项目包为空。', 'BUNDLE_EMPTY');
      const unpacked = await unpack(filename, directory, signal), records = await validateContents(unpacked.manifest, unpacked.entriesRoot);
      signal?.throwIfAborted();
      const warnings = [];
      const project = records.get('project.json');
      if (project.sourceProjectId && !unpacked.manifest.projects.some(item => item.sourceId === project.sourceProjectId)) warnings.push(issue('BUNDLE_SOURCE_MISSING', 'project.json', '来源项目未随包提供，恢复时会保留来源快照并移除失效关联。'));
      const includedIds = new Set(unpacked.manifest.projects.map(item => item.sourceId));
      const missingLinks = new Set();
      const inspectLinks = value => { if (!value || typeof value !== 'object') return; for (const [key, item] of Object.entries(value)) { if (STALE_LINK.has(key) && typeof item === 'string' && !includedIds.has(item)) missingLinks.add(key); else if (item && typeof item === 'object') inspectLinks(item); } };
      for (const record of unpacked.manifest.projects) inspectLinks(records.get(record.file));
      for (const link of missingLinks) if (link !== 'sourceProjectId') warnings.push(issue('BUNDLE_LINK_NOT_INCLUDED', link, '关联的其它项目未随包提供，恢复时仅保留当前项目内容并移除失效指向。'));
      const report = publicReport(unpacked.manifest, warnings);
      imports.set(token, { ...unpacked, directory, filename, records, report, restoring: false, restored: null });
      return { token, report };
    } catch (error) { readable.unpipe(limiter); readable.resume?.(); await cleanup(directory); throw error; }
    finally { clearTimeout(timeout); readable.unpipe(limiter); readable.removeListener('aborted', aborted); readable.removeListener('error', aborted); signal?.removeEventListener('abort', aborted); }
  }

  async function freshProjectId(reserved) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const id = validateProjectId(idFactory());
      if (!reserved.has(id) && !await store.read(id) && !await exists(path.join(data, 'openfilm', 'projects', id)) && !await exists(path.join(restoredRoot, id))) { reserved.add(id); return id; }
    }
    throw failure(409, '无法分配新的项目编号，原有项目未改动。', 'BUNDLE_ID_CONFLICT');
  }
  async function restoreImport(token, { title, origin } = {}) {
    check(); const prepared = imports.get(token);
    if (!prepared) throw failure(404, '预检已失效，请重新选择项目包。', 'BUNDLE_NOT_FOUND');
    if (prepared.restored) return prepared.restored;
    if (prepared.restoring) throw failure(409, '此项目包正在恢复，请等待完成。', 'BUNDLE_RESTORE_BUSY');
    if (title !== undefined && (typeof title !== 'string' || !title.trim() || title.trim().length > 120)) throw failure(400, '恢复后的名称需为1—120字。', 'INVALID_PROJECT_TITLE');
    prepared.restoring = true;
    const created = [], savedIds = [], registered = [], sharedCreated = [], remotionCreated = [], projectMap = new Map(), createdAtMap = new Map(), assetMap = new Map(), coverMap = new Map(), referenceMap = new Map(), remotionMap = new Map(), warnings = [...prepared.report.warnings];
    let mediaScope;
    try {
      // Re-read and hash the staged files so a changed preflight never commits.
      for (const file of prepared.manifest.files) { const filename = path.join(prepared.entriesRoot, ...file.path.split('/')); await noLinks(prepared.entriesRoot, filename); const digest = createHash('sha256'); for await (const chunk of createReadStream(filename)) digest.update(chunk); if (digest.digest('hex') !== file.sha256) throw failure(400, '预检后的包内文件发生变化，请重新选择。', 'BUNDLE_HASH_MISMATCH'); }
      await validateContents(prepared.manifest, prepared.entriesRoot);
      const sharedMappings = await restoreSharedNovelBundle({ manifest: prepared.manifest, records: prepared.records, entriesRoot: prepared.entriesRoot, novelLibrary, created: sharedCreated });
      const reserved = new Set();
      for (const record of prepared.manifest.projects) { projectMap.set(record.sourceId, await freshProjectId(reserved)); createdAtMap.set(record.sourceId, new Date().toISOString()); }
      const primary = projectMap.get(prepared.manifest.project.sourceId);
      mediaScope = path.join(restoredRoot, primary); await mkdir(restoredRoot, { recursive: true }); await noLinks(data, restoredRoot); await mkdir(mediaScope); created.push(mediaScope);
      for (const record of prepared.manifest.projects) if (record.coverId && !coverMap.has(record.coverId)) {
        const id = randomUUID(), destination = path.join(data, 'project-covers', id + '.png'); await mkdir(path.dirname(destination), { recursive: true }); await noLinks(data, destination, { missing: true });
        await writeFile(destination, await readFile(path.join(prepared.entriesRoot, 'covers', record.coverId + '.png')), { flag: 'wx', mode: 0o600 }); created.push(destination); coverMap.set(record.coverId, id);
      }
      let nativeTarget;
      if (prepared.manifest.native) {
        nativeTarget = path.join(data, 'openfilm', 'projects', primary); await mkdir(path.dirname(nativeTarget), { recursive: true }); await noLinks(data, nativeTarget, { missing: true }); await mkdir(nativeTarget); created.push(nativeTarget);
        for (const file of prepared.manifest.files.filter(item => item.path.startsWith('native/'))) {
          const destination = path.join(nativeTarget, ...file.path.slice(7).split('/')); await mkdir(path.dirname(destination), { recursive: true });
          const sourceFile = path.join(prepared.entriesRoot, ...file.path.split('/'));
          if (file.path.toLowerCase() === 'native/.film/history/config') await writeFile(destination, historyConfig(await readFile(sourceFile, 'utf8')), { flag: 'wx', mode: 0o600 });
          else await copyFile(sourceFile, destination);
        }
      }
      for (const asset of prepared.manifest.assets) {
        if (!videoService?.registerOwnedAsset) throw failure(503, '媒体库尚未就绪，暂不能恢复包含素材的项目。', 'MEDIA_LIBRARY_UNAVAILABLE');
        const nativeAsset = asset.file.startsWith('native/');
        const scope = nativeAsset ? nativeTarget : mediaScope;
        const destination = nativeAsset ? path.join(nativeTarget, ...asset.file.slice(7).split('/')) : path.join(mediaScope, randomUUID() + path.extname(asset.file));
        if (!nativeAsset) await copyFile(path.join(prepared.entriesRoot, ...asset.file.split('/')), destination);
        const metadata = {}; for (const key of ['name', 'generated', 'generatedType', 'prompt', 'model', 'plan']) if (asset.metadata[key] !== undefined) metadata[key] = asset.metadata[key];
        const restored = await videoService.registerOwnedAsset(destination, scope, { ...metadata, expectedType: asset.metadata.type }); registered.push({ id: restored.id, scope }); assetMap.set(asset.sourceId, restored.id);
      }
      for (const [before, after] of await restoreRemotionBundle({ manifest: prepared.manifest, records: prepared.records, entriesRoot: prepared.entriesRoot, remotionProjects, projectMap, createdAtMap, created: remotionCreated })) remotionMap.set(before, after);
      const remapString = value => {
        if (projectMap.has(value)) return projectMap.get(value);
        if (assetMap.has(value)) return assetMap.get(value);
        if (referenceMap.has(value)) return referenceMap.get(value);
        if (remotionMap.has(value)) return remotionMap.get(value);
        return value.replace(/(\/api\/video\/media\/)([A-Za-z0-9_-]{12,80})/g, (all, prefix, id) => assetMap.has(id) ? prefix + assetMap.get(id) : all)
          .replace(/(\/api\/project-covers\/)([a-f0-9-]{36})/g, (all, prefix, id) => coverMap.has(id) ? prefix + coverMap.get(id) : all)
          .replace(/(\/api\/projects\/)([A-Za-z0-9_-]+)(?=[/?#"'\s]|$)/g, (all, prefix, id) => projectMap.has(id) ? prefix + projectMap.get(id) : all)
          .replace(/([?&](?:projectId|sourceProjectId|videoProjectId)=)([A-Za-z0-9_-]+)/g, (all, prefix, id) => projectMap.has(id) ? prefix + projectMap.get(id) : all);
      };
      const remap = (value, key = '') => {
        if (typeof value === 'string') return key === 'coverAssetId' ? coverMap.get(value) || '' : remapString(value);
        if (Array.isArray(value)) return value.map(item => remap(item, key));
        if (!value || typeof value !== 'object') return value;
        const result = {};
        for (const [field, item] of Object.entries(value)) {
          if (field === 'nativeProjectId') continue;
          if (STALE_LINK.has(field) && typeof item === 'string' && !projectMap.has(item)) { warnings.push(issue('BUNDLE_LINK_REMOVED', field, '未随包提供的项目关联已移除，来源文字快照保留。')); continue; }
          result[field] = remap(item, field);
        }
        return result;
      };
      const refs = prepared.records.get('references.json');
      for (const item of refs?.items || []) if (typeof item.id === 'string') referenceMap.set(item.id, randomUUID());
      if (prepared.manifest.native) {
        for (const file of prepared.manifest.files.filter(item => item.path.startsWith('native/'))) {
          const relative = file.path.slice(7), destination = path.join(nativeTarget, ...relative.split('/')); await mkdir(path.dirname(destination), { recursive: true });
          const sourceFile = path.join(prepared.entriesRoot, ...file.path.split('/'));
          if (/\.json$/i.test(relative)) await writeFile(destination, JSON.stringify(remap(prepared.records.get(file.path)), null, 2) + '\n', { mode: 0o600 });
          else if (relative.toLowerCase() === '.film/history/config') await writeFile(destination, historyConfig(await readFile(sourceFile, 'utf8')), { mode: 0o600 });
          else if (TEXT.test(relative)) {
            const bytes = rewriteText(await readFile(sourceFile), source => {
              let text = remapString(source);
              for (const [old, id] of assetMap) text = text.replaceAll(`data-guangxuan-asset-id="${old}"`, `data-guangxuan-asset-id="${id}"`).replaceAll(`data-guangxuan-asset-id='${old}'`, `data-guangxuan-asset-id='${id}'`);
              return text;
            });
            await writeFile(destination, bytes, { mode: 0o600 });
          }
        }
        const markerFile = path.join(nativeTarget, '.guangxuan-project.json');
        let marker = {}; if (await exists(markerFile)) marker = JSON.parse(await readFile(markerFile, 'utf8'));
        await writeFile(markerFile, JSON.stringify({ ...marker, app: 'GuangxuanStudio', projectId: primary, version: 1 }, null, 2), { mode: 0o600 });
      }
      const restoredRecords = [];
      let sessionStateChanged = false;
      for (const record of [...prepared.manifest.projects].reverse()) {
        const source = structuredClone(prepared.records.get(record.file)); remapRemotionProject(source, remotionMap); const value = remap(source);
        remapSharedNovelProject(value, prepared.records.get(record.file), sharedMappings);
        value.id = projectMap.get(record.sourceId); value.createdAt = createdAtMap.get(record.sourceId); value.metadataRevision = 0;
        if (record.file === 'project.json') value.title = title?.trim() || `${value.title || '未命名项目'}（恢复副本）`.slice(0, 120);
        if (value.video) {
          for (const field of TRANSIENT) { if (value.video[field]) sessionStateChanged = true; delete value.video[field]; }
          const restoredAssets = new Set(assetMap.values());
          for (const field of ['openfilmAnimationJob', 'lastAnimationJob']) {
            const job = value.video[field]; if (!job) continue;
            if (job.status === 'complete' && job.asset?.id && restoredAssets.has(job.asset.id)) value.video[field] = { ...job, jobId: randomUUID(), status: 'complete', progress: 1, downloadUrl: `/api/video/media/${job.asset.id}`, asset: { ...job.asset, url: `/api/video/media/${job.asset.id}` }, imported: true };
            else { delete value.video[field]; sessionStateChanged = true; }
          }
          for (const message of Array.isArray(value.video.assistantMessages) ? value.video.assistantMessages : []) {
            if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
            if (restoreDownloadHistory(message)) sessionStateChanged = true;
            if (restoreArtifactHistory(message)) sessionStateChanged = true;
            // Runs and undo receipts belong to the old service/project session.
            // Keep the conversation and result descriptions without offering
            // actions against tasks that were not restored with this copy.
            for (const field of ['jobId', 'undo', 'runId', 'runStatus', 'retryWatch', 'scopeImportedAssetIds']) {
              if (Object.hasOwn(message, field)) sessionStateChanged = true;
              delete message[field];
            }
            for (const effect of Array.isArray(message.effects) ? message.effects : []) {
              if (!effect || typeof effect !== 'object' || Array.isArray(effect)) continue;
              for (const field of ['undo', 'jobId']) { if (Object.hasOwn(effect, field)) sessionStateChanged = true; delete effect[field]; }
            }
            for (const step of Array.isArray(message.steps) ? message.steps : []) if (step?.status === 'running') { step.status = 'cancelled'; sessionStateChanged = true; }
            if (message.status === 'working') {
              sessionStateChanged = true; message.status = 'error';
              message.content = [typeof message.content === 'string' ? message.content : '', '恢复前的后台请求未继续执行，请重新提交。'].filter(Boolean).join('\n\n');
            }
          }
        }
        const saved = await store.save(value.id, value); savedIds.push(value.id); restoredRecords.push(saved);
      }
      const primaryRecord = restoredRecords.find(item => item.id === primary);
      await restoreScienceBundleFiles({ dataDir: data, manifest: prepared.manifest, entriesRoot: prepared.entriesRoot, records: prepared.records, projectMap, restoredRecords, created });
      if (remotionMap.size) warnings.push(issue('BUNDLE_REMOTION_SOURCE_RESTORED', 'remotion-projects', '自由动画当前源码、入口、输入参数和公开资源已恢复；历史版本与后台渲染任务未迁移，恢复时不会执行源码。'));
      if (sessionStateChanged) warnings.push(issue('BUNDLE_SESSION_RESTORED', 'project.json', '工程、对话和已生成素材已保留；旧任务进度、单次撤销及未迁移的下载原件与制作文件入口未沿用，未完成的后台请求需重新提交。'));
      if (refs) {
        const directory = path.join(data, 'references', primary); await mkdir(path.dirname(directory), { recursive: true }); await noLinks(data, directory, { missing: true }); await mkdir(directory); created.push(directory);
        await writeFile(path.join(directory, 'index.json'), JSON.stringify({ ...remap(refs), version: 1, projectCreatedAt: primaryRecord.createdAt }, null, 2), { flag: 'wx', mode: 0o600 });
      }
      const projectLink = prepared.records.get('project-link.json');
      if (projectLink) {
        const directory = path.join(data, 'project-links'); await mkdir(directory, { recursive: true }); await noLinks(data, directory); const filename = path.join(directory, primary + '.json');
        await writeFile(filename, JSON.stringify({ ...remap(projectLink), targetCreatedAt: primaryRecord.createdAt }, null, 2), { flag: 'wx', mode: 0o600 }); created.push(filename);
      }
      for (const file of prepared.manifest.files.filter(item => item.path.startsWith('analysis/'))) {
        const parts = file.path.slice(9).split('/'), first = parts.shift(), bare = first.replace(/\.json$/, '');
        const mapped = assetMap.get(bare) || projectMap.get(bare); if (!mapped) continue;
        const directory = path.join(data, 'source-analysis'); await mkdir(directory, { recursive: true }); await noLinks(data, directory);
        const owner = path.join(directory, mapped + (first.endsWith('.json') ? '.json' : ''));
        if (!created.includes(owner)) { if (await exists(owner)) throw failure(409, '恢复分析结果时发生目录冲突。', 'BUNDLE_ID_CONFLICT'); created.push(owner); }
        const destination = path.join(owner, ...parts); await mkdir(path.dirname(destination), { recursive: true });
        if (/\.json$/i.test(file.path)) await writeFile(destination, JSON.stringify(remap(prepared.records.get(file.path)), null, 2), { flag: 'wx', mode: 0o600 });
        else await copyFile(path.join(prepared.entriesRoot, ...file.path.split('/')), destination);
      }
      let analysis = null;
      if (prepared.manifest.files.some(file => file.path.startsWith('analysis/'))) {
        if (analysisService?.rebindCachedResults && primaryRecord.kind === 'video' && origin) {
          try { analysis = await analysisService.rebindCachedResults(primary, { assetMap: Object.fromEntries(assetMap), sourceOwnerCreatedAt: prepared.records.get('project.json').createdAt, newOwnerCreatedAt: primaryRecord.createdAt, origin }); }
          catch { analysis = null; }
        }
        if (!analysis || analysis.needsReanalysis?.length || !analysis.rebound?.length) warnings.push(issue('BUNDLE_ANALYSIS_RECHECK', 'source-analysis', '旧分析与转写已保留，未通过当前素材核验的记录需重新分析。'));
      }
      const result = { projectId: primary, project: primaryRecord, restoredProjects: restoredRecords.map(item => ({ id: item.id, title: item.title, kind: item.kind })), mapping: { projects: Object.fromEntries(projectMap), assets: Object.fromEntries(assetMap), covers: Object.fromEntries(coverMap), references: Object.fromEntries(referenceMap), ...(remotionMap.size ? { remotionProjects: Object.fromEntries(remotionMap) } : {}) }, ...(analysis ? { analysis } : {}), report: { ...prepared.report, restored: true, newProjectId: primary, verifiedFiles: prepared.manifest.files.length, warnings, ...(analysis ? { analysis: { rebound: analysis.rebound?.length || 0, needsReanalysis: analysis.needsReanalysis?.length || 0 } } : {}), existingProjectsOverwritten: false } };
      prepared.restored = result; return result;
    } catch (error) {
      const retained = [];
      for (const id of savedIds.reverse()) { try { await store.remove(id); } catch { retained.push(id); } }
      if (retained.length) throw failure(500, '恢复未完成，已保留本次新项目及其文件以免丢失；原有项目未改动，请在档案中核对。', 'BUNDLE_ROLLBACK_INCOMPLETE', { ok: false, retainedProjectIds: retained, issues: [issue('BUNDLE_ROLLBACK_INCOMPLETE', '', '无法清理本次新建记录，相关媒体和封面已一并保留。')] });
      const retainedRemotion = [];
      for (const resource of remotionCreated.reverse()) { try { await remotionProjects.discardArchive(resource.projectId, resource.id); } catch { retainedRemotion.push(resource); } }
      const retainedShared = [];
      for (const resources of sharedCreated.reverse()) { try { await novelLibrary.rollbackImport(resources); } catch { retainedShared.push(resources); } }
      const protectedScopes = new Set(), scopes = new Set(registered.map(item => item.scope));
      for (const scope of scopes) {
        try { if (!videoService?.unregisterOwnedAssets) throw new Error('Missing media rollback'); await videoService.unregisterOwnedAssets([...new Set(registered.filter(item => item.scope === scope).map(item => item.id))], scope); }
        catch { protectedScopes.add(scope); }
      }
      for (const filename of created.reverse()) {
        if (protectedScopes.has(filename)) continue;
        const resolved = path.resolve(filename);
        if (!inside(data, resolved)) throw new Error('Unsafe restore rollback');
        await rm(resolved, { recursive: true, force: true }).catch(() => {});
      }
      if (retainedShared.length) throw failure(500, '恢复未完成，部分本次导入的公用素材仍在使用，已保留以免影响其他项目。', 'BUNDLE_ROLLBACK_INCOMPLETE', { ok: false, issues: [issue('BUNDLE_ROLLBACK_INCOMPLETE', 'novel-library', '本次公用素材未能全部撤回，原有素材未改动。')] });
      if (retainedRemotion.length) throw failure(500, '恢复未完成，部分本次导入的自由动画源码未能撤回，原有项目未改动。', 'BUNDLE_ROLLBACK_INCOMPLETE', { ok: false, issues: [issue('BUNDLE_ROLLBACK_INCOMPLETE', 'remotion-projects', '已保留无法撤回的动画源码，请核对本次恢复记录。')] });
      throw error;
    } finally { prepared.restoring = false; }
  }

  async function discardImport(token) { const record = imports.get(token); if (!record) return; if (record.restoring) throw failure(409, '项目正在恢复，请稍候。', 'BUNDLE_RESTORE_BUSY'); imports.delete(token); await cleanup(record.directory); }
  const json = (res, status, value) => { const body = JSON.stringify(value); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' }); res.end(body); };
  async function requestJson(req) { if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw failure(415, '请使用JSON请求。', 'CONTENT_TYPE_REQUIRED'); let bytes = 0, chunks = []; for await (const chunk of req) { bytes += chunk.length; if (bytes > 65536) throw failure(413, '请求过大。', 'REQUEST_TOO_LARGE'); chunks.push(chunk); } let value; try { value = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw failure(400, '请求JSON无效。', 'INVALID_JSON'); } if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure(400, '请求格式无效。', 'INVALID_JSON'); return value; }
  async function handler(req, res, url) {
    if (!url.pathname.startsWith('/api/project-bundles/')) return false;
    const controller = new AbortController(), aborted = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', aborted);
    try {
      const route = url.pathname.slice('/api/project-bundles/'.length);
      if (route === 'exports' && req.method === 'POST') { const body = await requestJson(req); json(res, 201, await prepareExport(body.projectId, { signal: controller.signal })); return true; }
      if (route === 'imports' && req.method === 'POST') { if (!/^(?:application\/octet-stream|application\/gzip|application\/x-gxproject)(?:;|$)/i.test(req.headers['content-type'] || '')) throw failure(415, '请选择Gx完整项目包。', 'BUNDLE_CONTENT_TYPE'); json(res, 201, await receiveImport(req, { signal: controller.signal })); return true; }
      const restore = /^imports\/([^/]+)\/restore$/.exec(route);
      if (restore && req.method === 'POST') { const body = await requestJson(req); if (body.confirm !== true) throw failure(400, '请确认预检报告后恢复。', 'BUNDLE_CONFIRM_REQUIRED'); json(res, 201, await restoreImport(restore[1], { title: body.title, origin: url.origin })); return true; }
      const remove = /^imports\/([^/]+)$/.exec(route);
      if (remove && req.method === 'DELETE') { await discardImport(remove[1]); json(res, 200, { removed: true }); return true; }
      const download = /^exports\/([^/]+)\/file$/.exec(route);
      if (download && ['GET', 'HEAD'].includes(req.method)) {
        const record = exports.get(download[1]); if (!record) throw failure(404, '备份下载已失效，请重新导出。', 'BUNDLE_NOT_FOUND');
        const filename = `${String(record.manifest.project.title).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 80) || 'Gx项目'}.gxproject`;
        res.writeHead(200, { 'Content-Type': 'application/x-gxproject', 'Content-Length': (await stat(record.filename)).size, 'Content-Disposition': `attachment; filename="Gx-project.gxproject"; filename*=UTF-8''${encodeURIComponent(filename)}`, 'Cache-Control': 'no-store' });
        if (req.method === 'HEAD') res.end(); else await pipeline(createReadStream(record.filename), res, { signal: serviceAbort.signal }); return true;
      }
      throw failure(404, '找不到此项目包操作。', 'BUNDLE_ROUTE_NOT_FOUND');
    } catch (error) { if (res.headersSent || res.destroyed) { if (!res.destroyed) res.destroy(); return true; } json(res, error.status || 500, { error: error instanceof AppError ? error.message : '项目包操作未完成，请检查磁盘空间后重试。', code: error.code || 'BUNDLE_FAILED', ...(error.report ? { report: error.report } : {}) }); return true; }
    finally { res.removeListener('close', aborted); }
  }
  const tracked = operation => (...args) => {
    const pending = Promise.resolve().then(() => operation(...args)); activeOperations.add(pending);
    pending.finally(() => activeOperations.delete(pending)).catch(() => {}); return pending;
  };
  const activeHandler = tracked(handler);
  const handle = (req, res, url) => url.pathname.startsWith('/api/project-bundles/') ? activeHandler(req, res, url) : Promise.resolve(false);
  return {
    inspectProject: tracked(inspectProject), prepareExport: tracked(prepareExport), receiveImport: tracked(receiveImport), restoreImport: tracked(restoreImport), discardImport: tracked(discardImport), handler: handle, handle,
    close() {
      if (closePromise) return closePromise;
      closing = true; serviceAbort.abort();
      closePromise = (async () => { await Promise.allSettled([...activeOperations]); for (const record of [...imports.values(), ...exports.values()]) await cleanup(record.directory).catch(() => {}); imports.clear(); exports.clear(); })();
      return closePromise;
    },
  };
}
