import path from 'node:path';
import { access, copyFile, lstat, mkdir, readFile, realpath, rename, stat, writeFile, unlink } from 'node:fs/promises';
import { fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { createReadStream } from 'node:fs';
import { AppError, requireObject } from './errors.mjs';
import { MAX_TIME_SECONDS } from '../public/time-range.js';
import { validateProjectId, withoutSecrets } from './store.mjs';
import { findAnimationBrowser } from '../animation/render.mjs';
import { normalizeEditScope, scopedAssets, addsTimeline, resolveFreeEditScope } from './edit-scope.mjs';
import { normalizeEditEffects, normalizeClipEffects } from './edit-effects.mjs';
import { buildCaptionPage } from './typography-layout.mjs';
import { resolveCaptionTiming } from './editorial-plan.mjs';
import { inspectPlacement, placeSegment, applyPictureEffects, inspectRegion, replaceRegion } from './openfilm-placement.mjs';
import { planNativeAdjustments } from './native-adjustments.mjs';
import { nativeOperationContext, planNativeOperations } from './native-operations.mjs';
import { normalizeMaterialProvenance } from './assistant-materials.mjs';

const publicMaterialProvenance = value => { try { return value ? normalizeMaterialProvenance(value) : undefined; } catch { return undefined; } };
import { normalizeNativeExport } from './native-export-capabilities.mjs';
import { prepareNativeExportDownload } from './native-export-download.mjs';
import { readVtt } from '../integrations/openfilm/packages/openfilm/src/captions.mjs';
import { subtitleStyleSummary } from './native-subtitle-style.mjs';
import { clipSpan, clipFade, kindOf } from '../integrations/openfilm/packages/openfilm/src/film-doc.mjs';
import { readMotion } from '../integrations/openfilm/packages/openfilm/src/clip-motion.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const round = value => Math.round(value * 1000) / 1000;

async function atomic(filename, content) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, content, { mode: 0o600 }); await rename(temporary, filename); }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

function finite(value, fallback, label, min = 0, max = MAX_TIME_SECONDS) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new AppError(400, `${label}不在有效范围。`, 'INVALID_OPENFILM_PLAN');
  return parsed;
}

function stageFor(video = {}) {
  const short = String(video.resolution) === '1080' ? 1080 : 720;
  const long = short === 1080 ? 1920 : 1280;
  if (video.aspect === '9:16') return { w: short, h: long };
  if (video.aspect === '1:1') return { w: short, h: short };
  return { w: long, h: short };
}

function filmStats(value, known = {}) {
  let duration = 0;
  let clipCount = 0;
  let complete = true;
  for (const track of value?.tracks || []) {
    if (track.hidden) continue;
    for (const clip of track.clips || []) {
      if (clip.disabled) continue;
      const sound = clip.sound || /\.(?:mp3|wav|m4a|aac|flac|ogg|opus|aiff?)$/i.test(clip.src || '');
      if (!sound && clip.attrs?.['data-guangxuan-caption'] !== 'true') clipCount++;
      const start = Number(clip.time?.[0] || 0);
      const end = clip.time?.[1] ?? known[clip.src]?.duration;
      if (!Number.isFinite(end)) { complete = false; continue; }
      duration = Math.max(duration, Number(clip.at || 0) + (end - start) / Number(clip.speed || 1));
    }
  }
  return { duration: round(duration), clipCount, complete };
}

export async function createOpenFilmManager({ dataDir, root, store, resolveAsset, registerOwnedAsset } = {}) {
  const ownedHome = path.resolve(dataDir, 'openfilm');
  const stateHome = path.join(ownedHome, 'state');
  const library = path.join(ownedHome, 'projects');
  const integration = path.join(root, 'integrations', 'openfilm', 'packages', 'openfilm');
  const nativeEntry = path.join(integration, 'studio', 'server', 'server.mjs');
  const nativeEditor = path.join(integration, 'studio', 'ui', 'dist', 'index.html');
  const docModule = path.join(integration, 'src', 'film-doc.mjs');
  const queues = new Map();
  const opened = new Map();
  let runtimePromise;
  let runtime;
  let currentChild;
  let active = null;
  let closing = false;
  let lastError = '';

  function serial(id, operation) {
    const next = (queues.get(id) || Promise.resolve()).catch(() => {}).then(operation);
    queues.set(id, next);
    next.finally(() => { if (queues.get(id) === next) queues.delete(id); }).catch(() => {});
    return next;
  }

  async function documentTools() {
    try { return await import(pathToFileURL(docModule).href); }
    catch { throw new AppError(503, 'OpenFilm源码或依赖尚未准备完成。', 'OPENFILM_UNAVAILABLE'); }
  }

  async function status() {
    let available = false;
    try { await Promise.all([access(nativeEntry), access(nativeEditor)]); available = true; } catch { /* Build may be pending. */ }
    return { available, running: Boolean(runtime), projectId: active?.projectId || null, sessionId: runtime?.sessionId || null, ...(lastError ? { error: lastError } : {}), editorUrl: runtime && active ? '/openfilm/editor.html' : null };
  }

  function ensureRuntime(parentOrigin) {
    if (closing) throw new AppError(503, '应用正在关闭。', 'OPENFILM_CLOSING');
    if (runtimePromise) return runtimePromise;
    runtimePromise = (async () => {
      if (!(await status()).available) throw new AppError(503, 'OpenFilm原生编辑器尚未构建，请先完成OpenFilm构建。', 'OPENFILM_UNAVAILABLE');
      const parsed = new URL(parentOrigin);
      if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) throw new AppError(400, '编辑器仅支持本机来源。', 'INVALID_OPENFILM_ORIGIN');
      await Promise.all(['state', 'projects', 'exports', 'saved'].map(name => mkdir(path.join(ownedHome, name), { recursive: true })));
      let browserExecutable = process.env.OPENFILM_BROWSER_EXECUTABLE;
      if (browserExecutable) {
        try { await access(browserExecutable); }
        catch { throw new AppError(503, '配置的原生渲染浏览器不存在，请检查OPENFILM_BROWSER_EXECUTABLE。', 'OPENFILM_BROWSER_UNAVAILABLE'); }
      } else {
        try { browserExecutable = await findAnimationBrowser(); }
        catch { throw new AppError(503, '未找到已安装的Edge或Chrome，原生视频渲染无法启动。', 'OPENFILM_BROWSER_UNAVAILABLE'); }
      }
      const bin = process.env.GUANGXUAN_BIN_DIR || (process.env.GUANGXUAN_FFMPEG ? path.dirname(process.env.GUANGXUAN_FFMPEG) : path.join(root, 'bin'));
      const child = fork(path.join(HERE, 'openfilm-worker.mjs'), [], {
        execArgv: [], cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
          GUANGXUAN_OPENFILM_ENTRY: nativeEntry, OPENFILM_HOME: stateHome, OPENFILM_SHARED_HOME: stateHome,
          OPENFILM_LIBRARY: library, OPENFILM_EXPORTS: path.join(ownedHome, 'exports'), OPENFILM_SAVED: path.join(ownedHome, 'saved'),
          OPENFILM_NO_UPDATE_CHECK: '1', OPENFILM_LOCAL_ONLY: '1', OPENFILM_EMBED_ORIGIN: parsed.origin, OPENFILM_BROWSER_EXECUTABLE: browserExecutable },
      });
      currentChild = child;
      const pending = new Map();
      let readyResolve;
      let readyReject;
      let stderr = '';
      const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
      const timer = setTimeout(() => { child.kill(); readyReject(new AppError(504, 'OpenFilm启动超时。', 'OPENFILM_START_TIMEOUT')); }, 60000);
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
      child.on('message', message => {
        if (message?.type === 'ready') { clearTimeout(timer); readyResolve(message); return; }
        if (message?.type === 'failed') { clearTimeout(timer); readyReject(new AppError(503, `OpenFilm原生服务启动失败：${String(message.error || '请检查构建和本地运行环境。').slice(0, 600)}`, 'OPENFILM_START_FAILED')); child.kill(); return; }
        const call = pending.get(message?.id);
        if (!call) return;
        pending.delete(message.id); clearTimeout(call.timer);
        if (message.error) call.reject(new AppError([400, 403, 404, 409].includes(message.status) ? message.status : 502, `OpenFilm操作未完成：${message.error}`, /^[A-Z][A-Z0-9_]{2,80}$/.test(message.code || '') ? message.code : 'OPENFILM_REQUEST_FAILED'));
        else call.resolve(message.result);
      });
      const exited = () => {
        clearTimeout(timer);
        const error = new AppError(503, 'OpenFilm服务已退出，请重新打开项目。', 'OPENFILM_EXITED');
        error.diagnostic = stderr;
        readyReject(error);
        for (const call of pending.values()) { clearTimeout(call.timer); call.reject(error); }
        pending.clear();
        if (currentChild === child) { currentChild = null; runtime = null; runtimePromise = null; active = null; opened.clear(); }
      };
      child.once('error', exited); child.once('exit', exited);
      const info = await ready;
      for (const origin of [info.origin, info.filmOrigin]) {
        const url = new URL(origin);
        if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) { child.kill(); throw new AppError(503, 'OpenFilm返回了非本机地址。', 'INVALID_OPENFILM_ORIGIN'); }
      }
      const rpc = (action, values = {}) => new Promise((resolve, reject) => {
        if (!child.connected) { reject(new AppError(503, 'OpenFilm服务未连接。', 'OPENFILM_EXITED')); return; }
        const id = randomUUID();
        const callTimer = setTimeout(() => { pending.delete(id); reject(new AppError(504, 'OpenFilm操作超时。', 'OPENFILM_TIMEOUT')); }, 120000);
        pending.set(id, { resolve, reject, timer: callTimer });
        child.send({ id, action, ...values });
      });
      runtime = { child, rpc, origin: info.origin, filmOrigin: info.filmOrigin, parentOrigin: parsed.origin, sessionId: randomUUID() };
      lastError = '';
      return runtime;
    })().catch(error => { lastError = error.message; runtimePromise = null; throw error; });
    return runtimePromise;
  }

  function paths(id) {
    validateProjectId(id);
    const directory = path.join(library, id);
    return { directory, film: path.join(directory, 'film.html'), marker: path.join(directory, '.guangxuan-project.json'), snapshot: path.join(directory, 'legacy-project.json') };
  }

  async function ownedDirectory(id) {
    const locations = paths(id);
    await mkdir(locations.directory, { recursive: true });
    const actualLibrary = await realpath(library);
    const actualProject = await realpath(locations.directory);
    if (!actualProject.startsWith(actualLibrary + path.sep)) throw new AppError(403, '项目目录不在应用管理范围内。', 'OPENFILM_PATH_OUTSIDE');
    return locations;
  }

  async function readMarker(id) {
    try { return JSON.parse(await readFile(paths(id).marker, 'utf8')); } catch { return null; }
  }

  async function writeMarker(project, fields = {}) {
    const locations = paths(project.id);
    const previous = await readMarker(project.id);
    await atomic(locations.marker, JSON.stringify({ ...previous, ...fields, app: 'GuangxuanStudio', projectId: project.id, title: project.title || project.name || '未命名项目', description: project.description || '', version: 1 }, null, 2));
  }

  async function copyAsset(id, locations, known, { beforeCopy } = {}) {
    if (typeof resolveAsset !== 'function') throw new AppError(503, '媒体库尚未就绪。', 'MEDIA_LIBRARY_UNAVAILABLE');
    const asset = await resolveAsset(id);
    const extension = path.extname(asset.path).toLowerCase();
    const owned = path.relative(locations.directory, asset.path);
    const alreadyInside = owned && !owned.startsWith('..') && !path.isAbsolute(owned) && !owned.split(path.sep).some(part => part.startsWith('.'));
    let relative = alreadyInside ? owned.split(path.sep).join('/') : '';
    let retained = Boolean(alreadyInside);
    if (!relative) {
      const previous = Object.entries(known).filter(([, item]) => item?.assetId === asset.id || item?.originalAssetId === asset.id).map(([src]) => src);
      previous.push(`assets/guangxuan/${asset.id}${extension}`);
      for (const src of previous) {
        if (path.isAbsolute(src) || src.split(/[\\/]/).some(part => part === '..' || part.startsWith('.'))) continue;
        try {
          const existing = await realpath(path.join(locations.directory, ...src.split('/')));
          if (existing.startsWith(locations.directory + path.sep)) { relative = src; retained = true; break; }
        } catch { /* A new source can receive a readable name. */ }
      }
    }
    if (!relative) {
      let stem = path.basename(String(asset.name || '素材'));
      if (stem.toLowerCase().endsWith(extension)) stem = stem.slice(0, -extension.length);
      stem = Array.from(stem.replace(/[<>:"/\\|?*\x00-\x1F]/g, '-').replace(/\s+/g, '-').replace(/[ .]+$/g, '')).slice(0, 48).join('') || '素材';
      const short = asset.id.replace(/-/g, '').slice(0, 12);
      relative = `assets/guangxuan/${stem}-${short}${extension}`;
      for (let attempt = 0; attempt < 10; attempt++) {
        try { await access(path.join(locations.directory, ...relative.split('/'))); }
        catch (error) { if (error.code === 'ENOENT') break; throw error; }
        relative = `assets/guangxuan/${stem}-${randomUUID()}${extension}`;
        if (attempt === 9) throw new AppError(409, '无法分配唯一的素材文件名，请重试。', 'OPENFILM_MEDIA_NAME_CONFLICT');
      }
    }
    const target = path.join(locations.directory, ...relative.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    let same = retained;
    if (!same) { try { same = (await stat(target)).size === asset.size; } catch { /* Not imported yet. */ } }
    let copied = false;
    if (!same) {
      await beforeCopy?.();
      const temporary = `${target}.${randomUUID()}.tmp`;
      try { await copyFile(asset.path, temporary); await rename(temporary, target); copied = true; }
      catch { await unlink(temporary).catch(() => {}); throw new AppError(500, '无法复制项目媒体，请检查可用空间。', 'OPENFILM_MEDIA_COPY_FAILED'); }
    }
    known[relative] = { ...known[relative], originalAssetId: known[relative]?.originalAssetId || asset.id, assetId: asset.id, name: asset.name, duration: asset.duration, type: asset.type, generated: Boolean(asset.generated), ...(publicMaterialProvenance(asset.provenance) ? { provenance: publicMaterialProvenance(asset.provenance) } : {}) };
    return { asset, src: relative, copied };
  }

  async function materialize(video, locations, known = {}, requestedStage, existing = null, { durationLimit, captionOffset = 0 } = {}) {
    requireObject(video, '剪辑方案');
    const effects = normalizeEditEffects(video);
    const hasTimeline = Object.hasOwn(video, 'timeline');
    if ((!hasTimeline && !existing) || (hasTimeline && (!Array.isArray(video.timeline) || video.timeline.length > 200))) throw new AppError(400, '剪辑方案需要时间线，最多200个片段。', 'INVALID_OPENFILM_PLAN');
    const stage = requestedStage || stageFor(video);
    const picture = { attrs: { id: 'guangxuan-picture', title: '画面' }, clips: [] };
    const subtitles = { attrs: { id: 'guangxuan-captions', title: '字幕' }, clips: [] };
    const music = { attrs: { id: 'guangxuan-music', title: '配乐' }, clips: [] };
    const volume = finite(video.sourceVolume, 1, '原声音量', 0, 1);
    const keyframes = { ...(existing?.keyframes || {}) }, originalKeyframes = { ...keyframes }, sourceTiming = [];
    let cursor = hasTimeline ? 0 : durationLimit ?? filmStats(existing, known).duration;
    const previousClips = new Map((existing?.tracks?.[primaryTrackIndex(existing)]?.clips || []).map(clip => [clip.id, clip]));
    const reused = new Set();
    for (const clip of video.timeline || []) {
      const { asset, src } = await copyAsset(clip?.assetId, locations, known);
      if (asset.type === 'audio') throw new AppError(400, '音频请放入配乐轨道。', 'INVALID_OPENFILM_PLAN');
      const start = finite(clip.start, 0, '入点');
      const end = finite(clip.end, asset.duration, '出点');
      if (end <= start || (asset.type !== 'image' && end > asset.duration + 0.01)) throw new AppError(400, '片段出入点超出素材时长。', 'INVALID_OPENFILM_PLAN');
      const previous = clip.clipId ? previousClips.get(clip.clipId) : null;
      if (clip.clipId && (!previous || reused.has(clip.clipId) || known[previous.src]?.assetId !== asset.id)) throw new AppError(409, '要求引用的原片段已变化，请重新发送。', 'OPENFILM_REVISION_CONFLICT');
      if (previous) reused.add(clip.clipId);
      const speed = clip.speed === undefined ? Number(previous?.speed || 1) : finite(clip.speed, 1, '片段速度', .1, 16);
      if (asset.type === 'image' && speed !== 1 || (end - start) / speed < .001) throw new AppError(400, '图片展示不使用源变速，片段实际时长至少1毫秒。', 'INVALID_OPENFILM_PLAN');
      const pictureClip = previous ? { ...structuredClone(previous), at: round(cursor), time: [round(start), round(end)] } : { src, id: `gx-${randomUUID()}`, at: round(cursor), time: asset.type === 'image' ? [0, round(end - start)] : [round(start), round(end)],
        box: { x: 0, y: 0, w: stage.w, h: stage.h }, style: 'object-fit: contain', ...(asset.type === 'video' ? { volume } : {}), attrs: { title: asset.name, 'data-guangxuan-asset-id': asset.id } };
      if (clip.speed !== undefined) pictureClip.speed = speed;
      if (clip.purpose || clip.reason || clip.cueIds?.length) pictureClip.attrs = { ...(pictureClip.attrs || {}), ...(clip.purpose ? { 'data-guangxuan-purpose': String(clip.purpose).slice(0, 80) } : {}), ...(clip.reason ? { 'data-guangxuan-edit-reason': String(clip.reason).slice(0, 2000) } : {}), ...(clip.cueIds?.length ? { 'data-guangxuan-cue-ids': JSON.stringify(clip.cueIds) } : {}) };
      picture.clips.push(applyPictureEffects(pictureClip, { ...effects, ...normalizeClipEffects(clip) }, { stage, keyframes }));
      sourceTiming.push({ index: sourceTiming.length, clipId: pictureClip.id, start, end, speed, at: round(cursor) });
      cursor = round(cursor + (end - start) / speed);
    }
    if (!Number.isFinite(cursor) || cursor < 0 || cursor > MAX_TIME_SECONDS) throw new AppError(400, '时间线时长无法精确表示。', 'INVALID_OPENFILM_PLAN');
    if (video.captions !== undefined && (!Array.isArray(video.captions) || video.captions.length > 2000)) throw new AppError(400, '字幕格式或数量不正确。', 'INVALID_OPENFILM_PLAN');
    await mkdir(path.join(locations.directory, 'pages'), { recursive: true });
    if (!hasTimeline) for (const clip of previousClips.values()) sourceTiming.push({ index: sourceTiming.length, clipId: clip.id, start: Number(clip.time?.[0] || 0), end: Number(clip.time?.[1] ?? known[clip.src]?.duration), speed: Number(clip.speed || 1), at: Number(clip.at || 0) - captionOffset });
    for (const [captionIndex, caption] of (video.captions || []).entries()) {
      const timing = resolveCaptionTiming(caption, sourceTiming);
      const start = finite(timing.start, 0, '字幕开始时间', 0, Math.max(cursor, 0));
      const end = finite(timing.end, cursor, '字幕结束时间', 0, Math.max(cursor, 0));
      if (end <= start || typeof caption?.text !== 'string' || !caption.text.trim() || caption.text.length > 2000) throw new AppError(400, '字幕需要有效文字与时间。', 'INVALID_OPENFILM_PLAN');
      const name = `字幕-${String(captionIndex + 1).padStart(3, '0')}-${randomUUID().replace(/-/g, '').slice(0, 12)}.html`;
      const duration = round(end - start);
      const title = caption.placement === 'title';
      const { html, layout } = buildCaptionPage(caption.text, stage, duration, caption.layout || {}, caption.placement || 'bottom');
      await writeFile(path.join(locations.directory, 'pages', name), html, { mode: 0o600, flag: 'wx' });
      subtitles.clips.push({ src: `pages/${name}`, id: `gx-caption-${randomUUID()}`, at: round(start), time: [0, duration], size: stage, box: { x: 0, y: 0, w: stage.w, h: stage.h }, attrs: { title: `${title ? '标题' : '字幕'}${captionIndex + 1} · ${caption.text.slice(0, 30)}`, 'data-guangxuan-caption': 'true', 'data-guangxuan-text': caption.text, 'data-guangxuan-placement': caption.placement || 'bottom', 'data-guangxuan-layout': JSON.stringify({ role: layout.role, lookId: layout.lookId, motionId: layout.motionId, maxLines: layout.maxLines, safeMargin: layout.safeMargin, fontSize: layout.fontSize }) } });
    }
    if (video.music?.assetId && cursor > 0) {
      const { asset, src } = await copyAsset(video.music.assetId, locations, known);
      if (!asset.hasAudio || !(asset.duration > 0)) throw new AppError(400, '配乐素材没有可用音轨。', 'INVALID_OPENFILM_PLAN');
      const musicVolume = finite(video.music.volume, 0.2, '配乐音量', 0, 1);
      let at = 0;
      while (at < cursor - 0.001) {
        if (music.clips.length > 10000) throw new AppError(400, '配乐循环次数过多，请选择较长的音频。', 'INVALID_OPENFILM_PLAN');
        const length = Math.min(asset.duration, cursor - at);
        music.clips.push({ src, id: `gx-music-${randomUUID()}`, at: round(at), time: [0, round(length)], volume: musicVolume, ...(asset.type === 'video' ? { sound: true } : {}), attrs: { title: asset.name, 'data-guangxuan-asset-id': asset.id } });
        at += length;
      }
    }
    const value = { stage, tracks: [subtitles, picture, music].filter(track => track.clips.length), ...(Object.keys(keyframes).length ? { keyframes } : {}) };
    const { readFilm } = await documentTools();
    const checked = readFilm(structuredClone(value));
    if (!checked.doc) throw new AppError(422, '剪辑方案不能转换为有效OpenFilm工程。', 'OPENFILM_MIGRATION_INVALID');
    return { value, known, motionKeyframes: Object.fromEntries([...new Set([...Object.keys(originalKeyframes), ...Object.keys(keyframes)])].filter(name => originalKeyframes[name] !== keyframes[name]).map(name => [name, keyframes[name] ?? null])) };
  }

  async function prepare(id) {
    const project = await store.read(validateProjectId(id));
    if (!project) throw new AppError(404, '项目不存在。', 'PROJECT_NOT_FOUND');
    if (project.kind && project.kind !== 'video') throw new AppError(400, '请在文案工作区打开此项目。', 'OPENFILM_VIDEO_PROJECT_REQUIRED');
    if (!(await status()).available) throw new AppError(503, 'OpenFilm原生编辑器尚未构建，请先完成OpenFilm构建。', 'OPENFILM_UNAVAILABLE');
    const locations = await ownedDirectory(id);
    let exists = false;
    try { await access(locations.film); exists = true; } catch { /* First migration. */ }
    if (!exists) {
      const video = project.video || project.videoProject || { timeline: [], captions: [] };
      const { value, known } = await materialize(video, locations);
      const { filmHtml } = await documentTools();
      const snapshot = JSON.stringify(withoutSecrets(project), null, 2);
      try { await writeFile(locations.snapshot, snapshot, { flag: 'wx', mode: 0o600 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      await atomic(locations.film, filmHtml(value));
      await writeMarker(project, { migratedAt: new Date().toISOString(), legacyHash: createHash('sha256').update(snapshot).digest('hex'), media: known });
    } else await writeMarker(project);
    return { project, locations };
  }

  async function openNative(projectId, locations, parentOrigin, activate = true) {
    const service = await ensureRuntime(parentOrigin);
    if (!activate && opened.has(projectId)) return opened.get(projectId);
    const native = await service.rpc('open', { folder: locations.directory });
    const privateUrl = new URL(native.privateUrl);
    if (privateUrl.origin !== service.origin) throw new AppError(502, '原生编辑器地址不匹配。', 'INVALID_OPENFILM_ORIGIN');
    const entry = { projectId, nativeProjectId: native.nativeProjectId, privateUrl: native.privateUrl, sessionId: service.sessionId };
    opened.set(projectId, entry); active = entry;
    const project = await store.read(projectId);
    if (project) await writeMarker(project, { nativeProjectId: native.nativeProjectId });
    return entry;
  }

  async function open(projectId, parentOrigin) {
    return serial(validateProjectId(projectId), async () => {
      const { locations } = await prepare(projectId);
      const native = await openNative(projectId, locations, parentOrigin);
      return { projectId, nativeProjectId: native.nativeProjectId, sessionId: native.sessionId, editorUrl: '/openfilm/editor.html', native: true };
    });
  }

  async function importAsset(projectId, assetId, parentOrigin, { expectedRevision, requestId, signal } = {}) {
    validateProjectId(projectId);
    if (typeof assetId !== 'string' || !/^[A-Za-z0-9_-]{12,80}$/.test(assetId)) throw new AppError(400, '请使用已登记的视频或图片素材编号。', 'INVALID_OPENFILM_ASSET');
    if (typeof expectedRevision !== 'string' || !/^[a-f0-9]{16}$/.test(expectedRevision)) throw new AppError(400, '请先读取当前工程，再导入视频或图片素材。', 'OPENFILM_REVISION_REQUIRED');
    if (requestId !== undefined && (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(requestId))) throw new AppError(400, '素材导入操作编号无效。', 'INVALID_ASSISTANT_OPERATION');
    const checkCancelled = () => { if (signal?.aborted) throw new AppError(499, '视频素材导入已取消。', 'REQUEST_CANCELLED'); };
    checkCancelled();
    const owner = await store.read(projectId);
    if (!owner || owner.kind && owner.kind !== 'video') throw new AppError(404, '视频项目不存在。', 'PROJECT_NOT_FOUND');
    const assertOwner = async () => {
      const current = await store.read(projectId);
      if (!current || current.kind && current.kind !== 'video' || current.createdAt !== owner.createdAt) throw new AppError(409, '导入期间项目已移除或重建，未将素材登记给新项目。', 'OPENFILM_OWNER_CHANGED');
      return current;
    };
    const publicAsset = asset => ({ id: asset.id, name: asset.name, type: asset.type, duration: asset.duration, width: asset.width || 0, height: asset.height || 0, hasAudio: Boolean(asset.hasAudio), generated: Boolean(asset.generated), url: `/api/video/media/${asset.id}`, ...(publicMaterialProvenance(asset.provenance) ? { provenance: publicMaterialProvenance(asset.provenance) } : {}) });
    return serial(projectId, async () => {
      checkCancelled(); await assertOwner();
      const { project, locations } = await prepare(projectId);
      await assertOwner();
      const marker = await readMarker(projectId);
      // Older project folders carry their original owner in the migration
      // snapshot. Reusing an ID does not authorize an old import receipt.
      let nativeOwner = marker?.ownerCreatedAt;
      if (!nativeOwner) { try { nativeOwner = JSON.parse(await readFile(locations.snapshot, 'utf8')).createdAt; } catch {} }
      if (nativeOwner && nativeOwner !== owner.createdAt) throw new AppError(409, '此原生工程属于之前的同编号项目，请重新建立工程后导入。', 'OPENFILM_OWNER_CHANGED');
      const known = { ...marker?.media };
      const cached = requestId && marker?.assistantImports?.[requestId];
      if (cached) {
        if (cached.ownerCreatedAt !== owner.createdAt) throw new AppError(409, '这条素材导入记录不属于当前项目。', 'OPENFILM_OWNER_CHANGED');
        if (cached.sourceAssetId !== assetId) throw new AppError(409, '同一导入操作不能更换素材。', 'INVALID_ASSISTANT_OPERATION');
        const registered = await resolveAsset(cached.asset.id);
        const actual = await realpath(registered.path), owned = await realpath(locations.directory);
        const comparable = value => process.platform === 'win32' ? value.toLowerCase() : value;
        if (!comparable(actual).startsWith(comparable(owned + path.sep))) throw new AppError(403, '已导入素材不在当前工程目录内。', 'OPENFILM_PATH_OUTSIDE');
        await assertOwner();
        return { projectId, imported: true, asset: publicAsset(registered), revision: cached.revision, alreadyImported: true };
      }
      if (typeof registerOwnedAsset !== 'function') throw new AppError(503, '项目素材登记服务尚未就绪。', 'MEDIA_LIBRARY_UNAVAILABLE');
      const native = await openNative(projectId, locations, parentOrigin, false);
      const current = await runtime.rpc('read', native);
      if (current.rev !== expectedRevision) throw new AppError(409, '工程在素材导入前已有修改，请刷新上下文后重试。', 'OPENFILM_REVISION_CONFLICT');
      const source = await resolveAsset(assetId);
      if (!['video', 'image', 'audio'].includes(source.type)) throw new AppError(400, '此导入入口需要已登记的视频、图片或音频素材。', 'OPENFILM_VIDEO_ASSET_REQUIRED');
      await assertOwner(); checkCancelled();
      let imported, fingerprint;
      try {
        imported = await copyAsset(assetId, locations, known, { beforeCopy: async () => { await assertOwner(); checkCancelled(); } });
        const filename = path.join(locations.directory, ...imported.src.split('/'));
        if (imported.copied) fingerprint = await lstat(filename);
        // A completed copy is retained if Stop arrives now. Registration is
        // finished without passing the aborted signal so the real receipt is
        // available to the assistant and the user's project file list.
        await assertOwner();
        const registered = await registerOwnedAsset(filename, locations.directory, { name: imported.asset.name, generated: imported.asset.generated, ...(publicMaterialProvenance(imported.asset.provenance) ? { provenance: publicMaterialProvenance(imported.asset.provenance) } : {}) });
        if (!['video', 'image', 'audio'].includes(registered.type)) throw new AppError(422, '复制后的素材未通过媒体校验。', 'OPENFILM_VIDEO_ASSET_REQUIRED');
        await assertOwner();
        known[imported.src] = { ...known[imported.src], originalAssetId: known[imported.src]?.originalAssetId || assetId, assetId: registered.id, name: registered.name, type: registered.type, duration: registered.duration, generated: Boolean(registered.generated) };
        const response = { projectId, imported: true, asset: publicAsset(registered), revision: current.rev, ...(imported.copied ? {} : { alreadyImported: true }) };
        const imports = { ...marker?.assistantImports, ...(requestId ? { [requestId]: { ...response, ownerCreatedAt: owner.createdAt, sourceAssetId: assetId } } : {}) };
        await writeMarker(await assertOwner(), { ownerCreatedAt: owner.createdAt, media: known, ...(requestId ? { assistantImports: Object.fromEntries(Object.entries(imports).slice(-64)) } : {}) });
        await assertOwner();
        return response;
      } catch (error) {
        // Roll back only the exact file newly created by this import, and only
        // while it has not changed or become referenced by a native clip.
        if (imported?.copied && fingerprint) {
          const filename = path.join(locations.directory, ...imported.src.split('/'));
          try {
            const info = await lstat(filename);
            const latest = await runtime.rpc('read', native);
            const referenced = latest.doc?.tracks?.some(track => track.clips?.some(clip => clip.src === imported.src));
            if (!referenced && info.isFile() && !info.isSymbolicLink() && info.ino === fingerprint.ino && info.size === fingerprint.size && info.mtimeMs === fingerprint.mtimeMs) await unlink(filename);
          } catch { /* A changed or unavailable file is retained for the user. */ }
        }
        throw error;
      }
    });
  }

  async function assistantSnapshot(locations, current) {
    const id = randomUUID();
    const directory = path.join(locations.directory, '.guangxuan-assistant');
    await mkdir(directory, { recursive: true });
    if (!(await realpath(directory)).startsWith(locations.directory + path.sep)) throw new AppError(403, '撤销记录位置无效。', 'OPENFILM_PATH_OUTSIDE');
    const filename = path.join(directory, `${id}.json`);
    const value = { id, beforeRevision: current.rev, value: current.value || current.doc, createdAt: new Date().toISOString() };
    await atomic(filename, JSON.stringify(value));
    return { id, filename, value };
  }

  async function finishAssistantSnapshot(snapshot, revision) {
    if (!snapshot) return {};
    snapshot.value.afterRevision = revision;
    await atomic(snapshot.filename, JSON.stringify(snapshot.value));
    return { undo: { id: snapshot.id, revision } };
  }

  async function undoAssistant(projectId, undoId, parentOrigin) {
    if (typeof undoId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(undoId)) throw new AppError(400, '撤销记录编号无效。', 'INVALID_ASSISTANT_UNDO');
    return serial(validateProjectId(projectId), async () => {
      const { locations } = await prepare(projectId);
      const directory = path.join(locations.directory, '.guangxuan-assistant');
      let actual;
      try { actual = await realpath(directory); } catch { throw new AppError(404, '未找到这次操作的撤销记录。', 'ASSISTANT_UNDO_NOT_FOUND'); }
      if (!actual.startsWith(locations.directory + path.sep)) throw new AppError(403, '撤销记录位置无效。', 'OPENFILM_PATH_OUTSIDE');
      const filename = path.join(actual, `${undoId}.json`);
      let saved;
      try { saved = JSON.parse(await readFile(filename, 'utf8')); } catch { throw new AppError(404, '撤销记录无法读取，当前工程保留。', 'ASSISTANT_UNDO_NOT_FOUND'); }
      if (saved.id !== undoId || !/^[a-f0-9]{16}$/.test(saved.afterRevision || '') || saved.undone) throw new AppError(409, '这次操作已经撤销或尚未完成。', 'ASSISTANT_UNDO_UNAVAILABLE');
      const native = await openNative(projectId, locations, parentOrigin, false);
      const current = await runtime.rpc('read', native);
      if (current.rev !== saved.afterRevision) throw new AppError(409, '工程在这次AI操作后又有修改，不能覆盖后续编辑。请使用原生历史记录选择需要的版本。', 'OPENFILM_REVISION_CONFLICT');
      // filmHtml treats an omitted keyframe table as "preserve existing CSS".
      // A full undo must explicitly restore an empty table when there was none.
      const restoreValue = structuredClone(saved.value); restoreValue.keyframes ||= {};
      const result = await runtime.rpc('restore', { ...native, base: saved.afterRevision, value: restoreValue });
      saved.undone = true; saved.restoredAt = new Date().toISOString();
      await atomic(filename, JSON.stringify(saved));
      return { projectId, restored: true, revision: result.rev, ...filmStats(result.doc, (await readMarker(projectId))?.media || {}) };
    });
  }

  async function applyPlan(projectId, plan, parentOrigin, expectedRevision, { keepUndo = false, editScope } = {}) {
    requireObject(plan, '剪辑方案');
    if (typeof expectedRevision !== 'string' || !/^[a-f0-9]{16}$/.test(expectedRevision)) throw new AppError(400, '请先读取当前工程上下文，再应用剪辑计划。', 'OPENFILM_REVISION_REQUIRED');
    return serial(validateProjectId(projectId), async () => {
      const { project, locations } = await prepare(projectId);
      const known = { ...(await readMarker(projectId))?.media };
      const native = await openNative(projectId, locations, parentOrigin, false);
      const current = await runtime.rpc('read', native);
      if (current.rev !== expectedRevision) throw new AppError(409, '原生工程在生成计划后已修改，请刷新上下文再检查计划。', 'OPENFILM_REVISION_CONFLICT');
      let scope, freePlacement = false;
      if (editScope !== undefined) {
        const files = await runtime.rpc('files', native);
        const available = await collectContextAssets(current, files, locations, known);
        scope = normalizeEditScope(editScope, available.assets);
        freePlacement = scope.placement.mode === 'free';
        if (freePlacement && Object.hasOwn(plan, 'timeline')) scope = resolveFreeEditScope(scope, plan.placement, available.assets);
        const allowed = new Set(scopedAssets(available.assets, scope).map(asset => asset.id));
        if (Object.hasOwn(plan, 'timeline') && (!Array.isArray(plan.timeline) || plan.timeline.length > 200)) throw new AppError(400, '剪辑方案最多支持200个片段。', 'INVALID_OPENFILM_PLAN');
        if ((plan.timeline || []).some(clip => !clip || !allowed.has(clip.assetId)) || (plan.music?.assetId && !allowed.has(plan.music.assetId))) throw new AppError(403, '剪辑方案包含未选择的素材，请重新生成。', 'EDIT_SCOPE_ASSET_FORBIDDEN');
      }
      const effectivePlan = structuredClone(plan);
      delete effectivePlan.placement;
      const additive = addsTimeline(scope);
      if (additive && Object.hasOwn(effectivePlan, 'timeline')) {
        if (!effectivePlan.timeline.length) delete effectivePlan.timeline;
        else effectivePlan.timeline = effectivePlan.timeline.map(({ clipId, ...clip }) => clip);
      }
      const hasTimeline = Object.hasOwn(effectivePlan, 'timeline');
      if (!hasTimeline && !Object.hasOwn(plan, 'captions')) throw new AppError(400, '剪辑要求没有可执行的时间线或字幕操作。', 'INVALID_OPENFILM_PLAN');
      const regional = scope?.placement.mode === 'range';
      if (regional && Object.hasOwn(effectivePlan, 'music')) throw new AppError(400, '局部修改会保留现有配乐，请在原生编辑器调整音乐轨道。', 'OPENFILM_RANGE_TRACK_UNSUPPORTED');
      const mainTrack = primaryTrackIndex(current.doc);
      const region = regional ? inspectRegion(current.doc, scope.placement, known, { mainTrack, timeline: hasTimeline, replaceCaptions: Object.hasOwn(effectivePlan, 'captions') && effectivePlan.captionMode !== 'append' }) : null;
      if (freePlacement && scope.assetIds && hasTimeline && region?.clips.some(item => item.trackIndex === mainTrack && item.at < region.end && item.end > region.start && !scope.assetIds.includes(known[item.clip.src]?.assetId))) throw new AppError(403, '自由创作的放置范围包含未选择的素材，请缩小本次范围。', 'EDIT_SCOPE_ASSET_FORBIDDEN');
      if (region) {
        if (effectivePlan.captions !== undefined && (!Array.isArray(effectivePlan.captions) || effectivePlan.captions.length > 2000)) throw new AppError(400, '字幕格式或数量不正确。', 'INVALID_OPENFILM_PLAN');
        for (const clip of effectivePlan.timeline || []) if (clip?.clipId) {
          const localId = region.mainIds.get(clip.clipId);
          if (!localId) throw new AppError(400, '局部方案引用了区间外的片段，请重新生成。', 'OPENFILM_RANGE_CLIP_FORBIDDEN');
          clip.clipId = localId;
        }
        for (const caption of effectivePlan.captions || []) {
          if (caption.source?.clipId && region.mainIds.has(caption.source.clipId)) caption.source.clipId = region.mainIds.get(caption.source.clipId);
          if (!caption.source && (typeof caption.start !== 'number' || typeof caption.end !== 'number' || !Number.isFinite(caption.start) || !Number.isFinite(caption.end) || caption.start < 0 || caption.end <= caption.start || caption.end > region.rangeDuration + .001)) throw new AppError(400, '局部字幕时间须从所选区间0秒计时，且不能超出所选时长。', 'OPENFILM_RANGE_PLAN_OUTSIDE');
        }
      }
      const placed = additive && hasTimeline;
      const placement = placed ? inspectPlacement(current.doc, scope.placement, known) : null;
      if (hasTimeline && !placed && !region) {
        const editable = await assessMainTrack(current.doc, locations, known);
        if (!editable.mainTrackEditable) throw new AppError(409, editable.warnings.join(' '), 'OPENFILM_MAIN_TRACK_UNSUPPORTED');
      }
      const replaced = (index, track) => (hasTimeline && index === mainTrack) ||
        (Object.hasOwn(effectivePlan, 'captions') && effectivePlan.captionMode !== 'append' && track.attrs?.id === 'guangxuan-captions') ||
        (Object.hasOwn(effectivePlan, 'music') && track.attrs?.id === 'guangxuan-music');
      if (scope && !placed && !region && current.doc.tracks.some((track, index) => track.locked && replaced(index, track))) throw new AppError(409, '本次修改涉及锁定轨道，请先解锁。', 'OPENFILM_TRACK_LOCKED');
      const converted = await materialize(effectivePlan, locations, known, current.doc?.stage, region?.sliced || current.doc, { durationLimit: region?.rangeDuration, captionOffset: region?.start || 0 });
      let ops, placementInfo;
      if (region) {
        placementInfo = replaceRegion(region, converted.value, { known, hasTimeline, hasCaptions: Object.hasOwn(effectivePlan, 'captions') });
        ops = placementInfo.ops;
      } else if (placed) {
        placementInfo = placeSegment(placement, converted.value, { known, mainTrack });
        ops = placementInfo.ops;
      } else {
        ops = [];
        for (const [index, track] of (current.doc?.tracks || []).entries()) if (replaced(index, track)) {
          for (const clip of track.clips || []) ops.push({ op: 'remove', clip: clip.id });
        }
        let trackCount = current.doc?.tracks?.length || 0;
        const picture = converted.value.tracks.find(track => track.attrs?.id === 'guangxuan-picture');
        if (picture?.clips.length) {
          const target = mainTrack >= 0 ? mainTrack : trackCount++;
          picture.clips.forEach((clip, index) => ops.push({ op: 'insert', clip, ...(mainTrack < 0 && index === 0 ? { newTrack: target, newTrackAttrs: picture.attrs } : { track: target }) }));
        }
        for (const track of converted.value.tracks.filter(track => track !== picture)) {
          const target = track.attrs?.id === 'guangxuan-captions' ? 0 : trackCount;
          track.clips.forEach((clip, index) => ops.push({ op: 'insert', clip, ...(index === 0 ? { newTrack: target, newTrackAttrs: track.attrs } : { track: target }) }));
          trackCount++;
        }
      }
      if (Object.keys(converted.motionKeyframes || {}).length) ops.push({ op: 'keyframes', set: converted.motionKeyframes });
      if (!ops.length) return { projectId, editorUrl: '/openfilm/editor.html', applied: false, ...filmStats(current.doc, known) };
      const snapshot = keepUndo ? await assistantSnapshot(locations, current) : null;
      const result = await runtime.rpc('edit', { ...native, base: current.rev, ops, strict: true });
      const undo = await finishAssistantSnapshot(snapshot, result.rev);
      await writeMarker(project, { media: converted.known, lastPlanAppliedAt: new Date().toISOString() });
      return { projectId, editorUrl: '/openfilm/editor.html', applied: true, revision: result.rev, ...undo, ...(placementInfo ? { placement: { mode: scope.placement.mode, at: placementInfo.at, duration: placementInfo.duration, ...(region ? { start: region.start, end: region.end, outsidePreserved: true } : {}) } } : {}), ...filmStats(result.doc || converted.value, known) };
    });
  }

  async function adjustClips(projectId, edits, parentOrigin, expectedRevision, { keepUndo = true, editScope, signal } = {}) {
    if (typeof expectedRevision !== 'string' || !/^[a-f0-9]{16}$/.test(expectedRevision)) throw new AppError(400, '请先读取当前时间线，再精确调整片段。', 'OPENFILM_REVISION_REQUIRED');
    return serial(validateProjectId(projectId), async () => {
      if (signal?.aborted) throw new AppError(499, '操作已停止。', 'REQUEST_CANCELLED');
      const { project, locations } = await prepare(projectId), known = { ...(await readMarker(projectId))?.media };
      const native = await openNative(projectId, locations, parentOrigin, false), current = await runtime.rpc('read', native);
      if (current.rev !== expectedRevision) throw new AppError(409, '原生工程已变化，请重新读取后再调整。', 'OPENFILM_REVISION_CONFLICT');
      const files = await runtime.rpc('files', native), available = await collectContextAssets(current, files, locations, known);
      const scope = editScope ? normalizeEditScope(editScope, available.assets) : undefined;
      const planned = planNativeAdjustments(current.doc, edits, { known, editScope: scope });
      if (signal?.aborted) throw new AppError(499, '操作已停止。', 'REQUEST_CANCELLED');
      const snapshot = keepUndo ? await assistantSnapshot(locations, current) : null;
      if (signal?.aborted) throw new AppError(499, '操作已停止。', 'REQUEST_CANCELLED');
      const result = await runtime.rpc('edit', { ...native, base: current.rev, ops: planned.ops, strict: true });
      const undo = await finishAssistantSnapshot(snapshot, result.rev);
      await writeMarker(project, { media: known, lastPreciseEditAt: new Date().toISOString() });
      return { projectId, applied: true, revision: result.rev, ...undo, results: planned.results, touchedClipIds: planned.touchedClipIds, summary: planned.summary, ...filmStats(result.doc || planned.document, known) };
    });
  }

  async function ownedCaption(locations, src) {
    if (typeof src !== 'string' || path.isAbsolute(src) || !/\.vtt$/i.test(src) || src.split(/[\\/]/).some(part => !part || part === '..' || part.startsWith('.')) || /^[a-z][a-z0-9+.-]*:/i.test(src)) throw new AppError(403, '字幕不属于受控项目文件。', 'OPENFILM_SUBTITLE_SCOPE');
    const filename = path.resolve(locations.directory, ...src.split('/'));
    let checked = locations.directory;
    for (const part of src.split('/')) { checked = path.join(checked, part); if ((await lstat(checked)).isSymbolicLink()) throw new AppError(403, '字幕不能通过文件链接读取。', 'OPENFILM_SUBTITLE_SCOPE'); }
    if (!(await realpath(filename)).startsWith(locations.directory + path.sep)) throw new AppError(403, '字幕超出项目目录。', 'OPENFILM_SUBTITLE_SCOPE');
    const info = await stat(filename); if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new AppError(413, '字幕不是普通文件或超过2MiB。', 'OPENFILM_SUBTITLE_LIMIT');
    const content = await readFile(filename, 'utf8'); return { filename, hash: createHash('sha256').update(content).digest('hex'), value: readVtt(content) };
  }

  async function readSubtitles(projectId, trackIndex, parentOrigin, { offset = 0, limit = 100, editScope } = {}) {
    return serial(validateProjectId(projectId), async () => {
      const { locations } = await prepare(projectId), native = await openNative(projectId, locations, parentOrigin, false), current = await runtime.rpc('read', native);
      if (!Number.isInteger(trackIndex) || trackIndex < 0 || !current.doc.tracks[trackIndex]?.captions || !Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new AppError(400, '字幕轨道或读取范围不正确。', 'OPENFILM_SUBTITLE_OPTIONS');
      const source = await ownedCaption(locations, current.doc.tracks[trackIndex].captions.src), scope = editScope ? normalizeEditScope(editScope) : undefined;
      const cues = source.value.cues.map((cue, index) => ({ index, start: cue.start, end: cue.end, text: cue.text, editable: !current.doc.tracks[trackIndex].locked && !current.doc.tracks[trackIndex].hidden && (scope?.placement.mode !== 'range' || cue.start >= scope.placement.start && cue.end <= scope.placement.end) }));
      return { revision: current.rev, track: trackIndex, total: cues.length, offset, cues: cues.slice(offset, offset + limit), style: subtitleStyleSummary(source.value, { offset, limit }), textFormat: 'WebVTT原文字段；改写工具的新text按纯文本保存。' };
    });
  }

  async function operateClips(projectId, operations, parentOrigin, expectedRevision, { keepUndo = true, editScope, signal } = {}) {
    if (typeof expectedRevision !== 'string' || !/^[a-f0-9]{16}$/.test(expectedRevision)) throw new AppError(400, '请先读取当前时间线，再执行原生操作。', 'OPENFILM_REVISION_REQUIRED');
    return serial(validateProjectId(projectId), async () => {
      if (signal?.aborted) throw new AppError(499, '操作已停止。', 'REQUEST_CANCELLED');
      const { project, locations } = await prepare(projectId), known = { ...(await readMarker(projectId))?.media };
      const native = await openNative(projectId, locations, parentOrigin, false), current = await runtime.rpc('read', native);
      if (current.rev !== expectedRevision) throw new AppError(409, '原生工程已变化，请重新读取后再操作。', 'OPENFILM_REVISION_CONFLICT');
      const files = await runtime.rpc('files', native), available = await collectContextAssets(current, files, locations, known);
      const scope = editScope ? normalizeEditScope(editScope, available.assets) : undefined;
      const subtitleSources = {}, subtitleChecks = [];
      if (Array.isArray(operations) && operations.some(operation => ['subtitles_edit', 'subtitles_style'].includes(operation?.action))) for (const track of current.doc.tracks.filter(track => track.captions)) { const source = await ownedCaption(locations, track.captions.src); subtitleSources[track.captions.src] = source.value; subtitleChecks.push(source); }
      const planned = planNativeOperations(current.doc, operations, { known, editScope: scope, subtitleSources });
      if (signal?.aborted) throw new AppError(499, '操作已停止。', 'REQUEST_CANCELLED');
      const snapshot = keepUndo ? await assistantSnapshot(locations, current) : null;
      if (signal?.aborted) throw new AppError(499, '操作已停止。', 'REQUEST_CANCELLED');
      const createdFiles = [];
      let result, commitAttempted = false;
      try {
        for (const file of planned.files || []) {
          if (!/^(?:pages|captions)\/gx-operation-[a-f0-9-]+\.(?:html|vtt)$/.test(file.path)) throw new AppError(400, '生成的字幕文件名无效。', 'OPENFILM_GENERATED_PATH_INVALID');
          const target = path.join(locations.directory, ...file.path.split('/')), parent = path.dirname(target);
          await mkdir(parent, { recursive: true });
          const resolved = await realpath(parent);
          if ((await lstat(parent)).isSymbolicLink() || !resolved.startsWith(locations.directory + path.sep)) throw new AppError(403, '字幕文件不能写入工程之外。', 'OPENFILM_GENERATED_PATH_INVALID');
          if (signal?.aborted) throw new AppError(499, '操作已停止。', 'REQUEST_CANCELLED');
          await writeFile(target, file.content, { flag: 'wx', mode: 0o600 }); createdFiles.push(target);
        }
        if (signal?.aborted) throw new AppError(499, '操作已停止。', 'REQUEST_CANCELLED');
        for (const source of subtitleChecks) if (createHash('sha256').update(await readFile(source.filename, 'utf8')).digest('hex') !== source.hash) throw new AppError(409, '原字幕内容已有更新，本次改写未覆盖，请重新读取。', 'OPENFILM_SUBTITLE_CHANGED');
        commitAttempted = true;
        result = planned.requiresRestore ? await runtime.rpc('restore', { ...native, base: current.rev, value: planned.document }) : await runtime.rpc('edit', { ...native, base: current.rev, ops: planned.ops, strict: true });
      } catch (error) {
        // Losing the worker acknowledgement does not prove the film was not
        // committed. Its newly referenced pages/captions must remain readable.
        if (!commitAttempted) await Promise.allSettled(createdFiles.map(filename => unlink(filename)));
        throw error;
      }
      const undo = await finishAssistantSnapshot(snapshot, result.rev);
      await writeMarker(project, { media: known, lastNativeOperationAt: new Date().toISOString() });
      return { projectId, applied: true, revision: result.rev, ...undo, results: planned.results, touchedClipIds: planned.touchedClipIds, summary: planned.summary, ...filmStats(result.doc || planned.document, known) };
    });
  }

  async function appendAsset(projectId, assetId, parentOrigin, at, { keepUndo = false, expectedRevision, requestId, editScope, placement: chosenPlacement } = {}) {
    return serial(validateProjectId(projectId), async () => {
      if (requestId !== undefined && (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(requestId))) throw new AppError(400, '动画操作编号无效。', 'INVALID_ASSISTANT_OPERATION');
      const { project, locations } = await prepare(projectId);
      const marker = await readMarker(projectId);
      if (requestId && marker?.assistantOperations?.[requestId]?.appended) return marker.assistantOperations[requestId];
      const known = { ...marker?.media };
      const native = await openNative(projectId, locations, parentOrigin, false);
      const current = await runtime.rpc('read', native);
      if (requestId && current.doc?.tracks?.some(track => track.clips?.some(clip => clip.attrs?.['data-guangxuan-operation'] === requestId))) return { projectId, appended: true, alreadyApplied: true, revision: current.rev, ...filmStats(current.doc, known) };
      if (editScope !== undefined && (typeof expectedRevision !== 'string' || !/^[a-f0-9]{16}$/.test(expectedRevision))) throw new AppError(400, '请先读取当前工程，再按所选位置加入动画。', 'OPENFILM_REVISION_REQUIRED');
      if (expectedRevision !== undefined && current.rev !== expectedRevision) throw new AppError(409, '工程在生成动画后已变化，请刷新后再加入。', 'OPENFILM_REVISION_CONFLICT');
      let scope, freePlacement = false;
      if (editScope !== undefined) {
        const files = await runtime.rpc('files', native);
        const available = await collectContextAssets(current, files, locations, known);
        scope = normalizeEditScope(editScope, available.assets);
        freePlacement = scope.placement.mode === 'free';
        scope = resolveFreeEditScope(scope, chosenPlacement, available.assets);
      }
      const stage = current.doc?.stage || stageFor({});
      const stats = filmStats(current.doc, known);
      const placement = addsTimeline(scope) ? inspectPlacement(current.doc, scope.placement, known) : null;
      const mainTrack = primaryTrackIndex(current.doc);
      const region = scope?.placement.mode === 'range' ? inspectRegion(current.doc, scope.placement, known, { mainTrack }) : null;
      if (freePlacement && scope.assetIds && region?.clips.some(item => item.trackIndex === mainTrack && item.at < region.end && item.end > region.start && !scope.assetIds.includes(known[item.clip.src]?.assetId))) throw new AppError(403, '自由创作的放置范围包含未选择的素材，请缩小本次范围。', 'EDIT_SCOPE_ASSET_FORBIDDEN');
      if (scope?.placement.mode === 'replace') {
        if (current.doc.tracks[mainTrack]?.locked) throw new AppError(409, '主画面轨已锁定，请先解锁。', 'OPENFILM_TRACK_LOCKED');
        const editable = await assessMainTrack(current.doc, locations, known);
        if (!editable.mainTrackEditable) throw new AppError(409, editable.warnings.join(' '), 'OPENFILM_MAIN_TRACK_UNSUPPORTED');
      }
      const { asset, src } = await copyAsset(assetId, locations, known);
      if (['replace', 'range'].includes(scope?.placement.mode) && asset.type === 'audio') throw new AppError(400, '替换画面需要视频或图片素材。', 'INVALID_OPENFILM_PLAN');
      const startAt = scope ? 0 : finite(at, stats.duration, '片段开始时间');
      const assetDuration = finite(asset.duration, undefined, '素材时长', .001);
      if (startAt + assetDuration > MAX_TIME_SECONDS) throw new AppError(400, '插入后的时间无法精确表示。', 'OPENFILM_TIMELINE_TOO_LONG');
      const clip = { src, id: `gx-${randomUUID()}`, at: round(startAt), time: [0, round(assetDuration)], attrs: { title: asset.name, 'data-guangxuan-asset-id': asset.id, ...(requestId ? { 'data-guangxuan-operation': requestId } : {}) }, ...(asset.type === 'audio' ? {} : { box: { x: 0, y: 0, w: stage.w, h: stage.h }, style: 'object-fit: contain' }) };
      let ops, placementInfo;
      if (region) {
        const segment = { stage, tracks: [{ attrs: { id: 'guangxuan-picture', title: '画面' }, clips: [clip] }] };
        placementInfo = replaceRegion(region, segment, { known, hasTimeline: true, hasCaptions: false });
        ops = placementInfo.ops;
      } else if (placement) {
        const segment = { stage, tracks: [{ attrs: { id: asset.type === 'audio' ? 'guangxuan-music' : 'guangxuan-picture', title: asset.type === 'audio' ? '配乐' : '画面' }, clips: [clip] }] };
        placementInfo = placeSegment(placement, segment, { known, mainTrack });
        ops = placementInfo.ops;
      } else if (scope?.placement.mode === 'replace') {
        ops = (current.doc.tracks[mainTrack]?.clips || []).map(previous => ({ op: 'remove', clip: previous.id }));
        ops.push({ op: 'insert', clip, ...(mainTrack >= 0 ? { track: mainTrack } : { newTrack: current.doc.tracks.length, newTrackAttrs: { id: 'guangxuan-picture', title: '画面' } }) });
      } else ops = [{ op: 'insert', clip }];
      const snapshot = keepUndo ? await assistantSnapshot(locations, current) : null;
      const result = await runtime.rpc('edit', { ...native, base: current.rev, ops, strict: true });
      const undo = await finishAssistantSnapshot(snapshot, result.rev);
      const response = { projectId, appended: true, revision: result.rev, ...undo, ...(placementInfo ? { placement: { mode: scope.placement.mode, at: placementInfo.at, duration: placementInfo.duration } } : {}), ...filmStats(result.doc, known), editorUrl: '/openfilm/editor.html' };
      const operations = { ...marker?.assistantOperations, ...(requestId ? { [requestId]: response } : {}) };
      await writeMarker(project, { media: known, ...(requestId ? { assistantOperations: Object.fromEntries(Object.entries(operations).slice(-30)) } : {}) });
      return response;
    });
  }

  async function summary(id) {
    try {
      const locations = paths(id);
      const [text, info, canvas] = await Promise.all([
        readFile(locations.film, 'utf8'),
        stat(locations.film),
        stat(path.join(locations.directory, '.film/canvas.json')).catch(() => null),
      ]);
      const updatedAt = new Date(Math.max(info.mtimeMs, canvas?.mtimeMs || 0)).toISOString();
      const { readFilmFile } = await documentTools();
      const parsed = readFilmFile(text);
      if (!parsed.doc) return { updatedAt };
      const stats = filmStats(parsed.doc, (await readMarker(id))?.media || {});
      if (stats.complete) return { duration: stats.duration, clipCount: stats.clipCount, updatedAt };
      try {
        const cached = JSON.parse(await readFile(path.join(locations.directory, '.film/cache/film-duration.json'), 'utf8'));
        if (cached.film === `${info.mtimeMs}:${info.size}` && Number.isFinite(cached.duration)) return { duration: cached.duration, clipCount: stats.clipCount, updatedAt };
      } catch { /* Native HTML pages may not have been measured yet. */ }
      return { duration: null, clipCount: stats.clipCount, updatedAt };
    } catch { return null; }
  }

  async function syncMetadata(project) {
    if (!await readMarker(project.id)) return;
    return serial(project.id, () => writeMarker(project));
  }

  function primaryTrackIndex(doc) {
    const tracks = doc?.tracks || [];
    const marked = tracks.findIndex(track => track.attrs?.id === 'guangxuan-picture');
    if (marked >= 0) return marked;
    for (let index = tracks.length - 1; index >= 0; index--) {
      if (tracks[index].clips?.some(clip => !clip.sound && /\.(?:mp4|m4v|mov|webm|mkv|avi|ogv|png|jpe?g|webp|bmp)$/i.test(clip.src))) return index;
    }
    return -1;
  }

  async function assessMainTrack(doc, locations, known, representedAssets) {
    const clips = doc?.tracks?.[primaryTrackIndex(doc)]?.clips || [];
    const warnings = [];
    let represented = 0;
    for (const clip of clips) {
      if (clip.disabled) { warnings.push('主画面轨有禁用片段，AI粗剪暂不可应用，以免移除这些片段。'); continue; }
      const src = clip.src;
      if (typeof src !== 'string' || /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('/') || src.startsWith('\\') || src.split(/[\\/]/).some(part => part === '..' || part.startsWith('.'))) {
        warnings.push('主画面轨有外部或隐藏路径片段，AI粗剪暂不可应用。'); continue;
      }
      if (!/\.(?:mp4|m4v|mov|webm|mkv|avi|ogv|png|jpe?g|webp|bmp)$/i.test(src) || clip.sound) {
        warnings.push('主画面轨有HTML、音频或其它未表示的片段，AI粗剪暂不可应用；可将其放到独立原生轨道。'); continue;
      }
      let asset = representedAssets?.get(src);
      if (!representedAssets) {
        try { asset = await registerOwnedAsset(path.join(locations.directory, ...src.split('/')), locations.directory, { name: known[src]?.name || path.basename(src), generated: known[src]?.generated, ...(publicMaterialProvenance(known[src]?.provenance) ? { provenance: publicMaterialProvenance(known[src].provenance) } : {}) }); }
        catch { /* Report the unsupported clip without exposing file paths. */ }
      }
      if (!asset || !['video', 'image'].includes(asset.type)) {
        warnings.push('主画面轨有无法注册为项目媒体的片段，AI粗剪暂不可应用；请先修复或收集该素材。'); continue;
      }
      represented++;
    }
    return { mainTrackEditable: represented === clips.length, warnings: [...new Set(warnings)] };
  }

  async function collectContextAssets(current, files, locations, known) {
    const assets = [];
    const bySource = new Map();
    const warnings = [];
    const mainIndex = primaryTrackIndex(current.doc);
    const mainClips = current.doc?.tracks?.[mainIndex]?.clips || [];
    const sources = [...new Set([...mainClips.map(clip => clip.src), ...(files.files || []).map(file => file.path)])].filter(src => typeof src === 'string' && /\.(?:mp4|m4v|mov|webm|mkv|avi|ogv|png|jpe?g|webp|bmp|mp3|wav|m4a|aac|flac|ogg|opus)$/i.test(src));
    for (const src of sources) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('/') || src.startsWith('\\') || src.split(/[\\/]/).some(part => part === '..' || part.startsWith('.'))) { warnings.push('一个外部或隐藏素材未纳入AI上下文。'); continue; }
      try {
        const asset = await registerOwnedAsset(path.join(locations.directory, ...src.split('/')), locations.directory, { name: known[src]?.name || path.basename(src), generated: known[src]?.generated, ...(publicMaterialProvenance(known[src]?.provenance) ? { provenance: publicMaterialProvenance(known[src].provenance) } : {}) });
        bySource.set(src, asset);
        if (!assets.some(item => item.id === asset.id)) assets.push({ id: asset.id, name: asset.name, type: asset.type, duration: asset.duration, width: asset.width || 0, height: asset.height || 0, hasAudio: asset.hasAudio, generated: Boolean(asset.generated), url: `/api/video/media/${asset.id}`, ...(publicMaterialProvenance(asset.provenance) ? { provenance: publicMaterialProvenance(asset.provenance) } : {}) });
        known[src] = { ...known[src], assetId: asset.id, name: asset.name, type: asset.type, duration: asset.duration, generated: Boolean(asset.generated) };
      } catch { warnings.push(`素材“${path.basename(src)}”暂不可供AI处理；外部链接请先收集到项目。`); }
    }
    return { assets, bySource, warnings, mainClips, mainIndex };
  }

  function musicClipDescription(clip, asset) {
    const span = clipSpan(clip, asset.duration);
    return { id: clip.id, sourceStart: span.from, sourceEnd: span.to, timelineAt: Number(clip.at || 0), speed: span.speed, volume: Number(clip.volume ?? 1), fullSourceDuration: asset.duration };
  }

  async function musicSourceHash(filename, signal) {
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(filename)) { if (signal?.aborted) throw new AppError(499, '音乐处理已取消，尚未提交剪辑。', 'REQUEST_CANCELLED'); hash.update(bytes); }
    return hash.digest('hex');
  }

  async function readMusicRhythm(projectId, assetId, parentOrigin, { clipId, range, signal } = {}) {
    return serial(validateProjectId(projectId), async () => {
      const cancelled = () => { if (signal?.aborted) throw new AppError(499, '音乐节奏读取已取消。', 'REQUEST_CANCELLED'); }; cancelled();
      const { project, locations } = await prepare(projectId); await exportOwner(projectId);
      const native = await openNative(projectId, locations, parentOrigin, false), current = await runtime.rpc('read', native), files = await runtime.rpc('files', native);
      const known = { ...(await readMarker(projectId))?.media }, available = await collectContextAssets(current, files, locations, known); cancelled();
      const clip = clipId === undefined ? null : current.doc.tracks.flatMap(track => track.clips || []).find(item => item.id === clipId);
      if (clipId !== undefined && !clip) throw new AppError(404, '当前工程没有指定的音乐片段。', 'OPENFILM_MUSIC_CLIP_NOT_FOUND');
      const entry = clip ? [clip.src, available.bySource.get(clip.src)] : [...available.bySource].find(([, asset]) => asset.id === assetId);
      if (!entry?.[1] || assetId !== undefined && entry[1].id !== assetId) throw new AppError(403, '音乐素材与当前工程或指定片段不匹配。', 'OPENFILM_MUSIC_ASSET_SCOPE');
      const [sourcePath, asset] = entry;
      if (!(asset.type === 'audio' || asset.type === 'video' && asset.hasAudio)) throw new AppError(422, '此当前工程素材没有可分析的音频。', 'OPENFILM_MUSIC_NO_AUDIO');
      const descriptor = clip ? musicClipDescription(clip, asset) : null, selectedRange = range ?? (descriptor ? { start: descriptor.sourceStart, end: descriptor.sourceEnd } : null);
      if (selectedRange) { requireObject(selectedRange, '音乐源范围'); finite(selectedRange.start, undefined, '音乐源起点', 0, asset.duration); finite(selectedRange.end, undefined, '音乐源终点', 0, asset.duration + .001); if (!(selectedRange.end > selectedRange.start)) throw new AppError(400, '音乐分析源区间无效。', 'OPENFILM_MUSIC_RANGE'); }
      cancelled();
      const rhythm = await runtime.rpc('rhythm', { ...native, sourcePath, ...(selectedRange ? { from: selectedRange.start, to: selectedRange.end } : {}) }); cancelled();
      const owner = await store.read(projectId); if (!owner || owner.createdAt !== project.createdAt) throw new AppError(409, '读取期间工程已重建，请重新读取音乐。', 'OPENFILM_OWNER_CHANGED');
      if (!/^[a-f0-9]{64}$/.test(rhythm.sourceVersion || '') || await musicSourceHash(asset.path, signal) !== rhythm.sourceVersion) throw new AppError(409, '音乐源版本已变化，请重新识别。', 'OPENFILM_MUSIC_SOURCE_CHANGED');
      return { ...rhythm, assetId: asset.id, sourcePath, nativeRevision: current.rev, ...(descriptor ? { musicClip: descriptor } : {}) };
    });
  }

  async function applyMusicCutPlan(projectId, plan, parentOrigin, expectedRevision, { keepUndo = true, editScope, signal, existingMusicClipId, originalVolume = 0 } = {}) {
    requireObject(plan, '音乐卡点计划');
    if (typeof expectedRevision !== 'string' || !/^[a-f0-9]{16}$/.test(expectedRevision)) throw new AppError(400, '请先读取当前工程再卡点。', 'OPENFILM_REVISION_REQUIRED');
    return serial(validateProjectId(projectId), async () => {
      const cancelled = () => { if (signal?.aborted) throw new AppError(499, '音乐卡点已取消，尚未提交剪辑。', 'REQUEST_CANCELLED'); }; cancelled();
      if (plan.version !== 1 || plan.status !== 'ready' || plan.canApply !== true || !Array.isArray(plan.timeline) || !plan.timeline.length || plan.timeline.length > 2000 || !Array.isArray(plan.boundaries) || plan.boundaries.length !== plan.timeline.length + 1 || !Array.isArray(plan.cutTimes) || plan.cutTimes.length !== plan.timeline.length - 1 || !/^[a-f0-9]{64}$/.test(plan.sourceVersion || '')) throw new AppError(400, '需要完整、可应用且带真实源版本的音乐卡点计划。', 'OPENFILM_MUSIC_PLAN');
      const boundaries = plan.boundaries.map(time => finite(time, undefined, '作品边界', 0, MAX_TIME_SECONDS)), start = boundaries[0], end = boundaries.at(-1), length = round(end - start);
      if (length < .001 || boundaries.some((time, index) => index && time <= boundaries[index - 1]) || plan.cutTimes.some((time, index) => !Number.isFinite(time) || Math.abs(time - boundaries[index + 1]) > .001)) throw new AppError(400, '音乐计划的拍点和时间边界不一致。', 'OPENFILM_MUSIC_PLAN');
      const { project, locations } = await prepare(projectId); await exportOwner(projectId);
      const native = await openNative(projectId, locations, parentOrigin, false), current = await runtime.rpc('read', native);
      if (current.rev !== expectedRevision) throw new AppError(409, '原生工程已变化，请重新读取后卡点。', 'OPENFILM_REVISION_CONFLICT');
      const files = await runtime.rpc('files', native), known = { ...(await readMarker(projectId))?.media };
      const priorMusicPath = Object.entries(known).find(([, record]) => record.assetId === plan.music?.assetId)?.[0];
      const available = await collectContextAssets(current, files, locations, known), scope = editScope ? normalizeEditScope(editScope, available.assets) : undefined;
      if (scope?.placement.mode === 'range' && (start < scope.placement.start - .001 || end > scope.placement.end + .001)) throw new AppError(403, '音乐卡点计划超出本轮明确区间。', 'OPENFILM_MUSIC_SCOPE');
      const allowed = scope?.assetIds ? new Set(scope.assetIds) : null;
      const music = requireObject(plan.music, '音乐片段'), musicEntry = [...available.bySource].find(([, asset]) => asset.id === music.assetId);
      // Registering a changed file may produce a different canonical ID. An
      // old owned receipt still identifies its source for stale-SHA rejection;
      // it never authorizes using the newly registered asset under the old ID.
      if (!musicEntry && priorMusicPath && available.bySource.has(priorMusicPath) && await musicSourceHash(available.bySource.get(priorMusicPath).path, signal) !== plan.sourceVersion) throw new AppError(409, '音乐源在识别后已有变化，请重新分析。', 'OPENFILM_MUSIC_SOURCE_CHANGED');
      if (!musicEntry || !(musicEntry[1].type === 'audio' || musicEntry[1].type === 'video' && musicEntry[1].hasAudio) || !existingMusicClipId && allowed && !allowed.has(music.assetId)) throw new AppError(403, '音乐源不是当前工程允许的可用音频。', 'OPENFILM_MUSIC_ASSET_SCOPE');
      const [musicPath, musicAsset] = musicEntry;
      const sourceStart = finite(music.sourceStart, undefined, '音乐源起点', 0, musicAsset.duration), sourceEnd = finite(music.sourceEnd, undefined, '音乐源终点', 0, musicAsset.duration + .001), timelineAt = finite(music.timelineAt, undefined, '音乐作品起点'), speed = finite(music.speed, 1, '音乐速度', .1, 100), volume = finite(music.volume, 1, '音乐音量', 0, 4);
      if (sourceEnd <= sourceStart || Math.abs(timelineAt - start) > .001 || Math.abs((sourceEnd - sourceStart) / speed - length) > .001) throw new AppError(400, '音乐源区间与作品时长不一致。', 'OPENFILM_MUSIC_PLAN');
      const allClips = current.doc.tracks.flatMap((track, trackIndex) => (track.clips || []).map(clip => ({ clip, track, trackIndex }))), mainTrack = available.mainIndex;
      let existing, musicClipId;
      if (existingMusicClipId) {
        existing = allClips.find(item => item.clip.id === existingMusicClipId);
        if (!existing || existing.clip.src !== musicPath || existing.trackIndex === mainTrack || kindOf(existing.clip) !== 'sound' || existing.track.hidden || existing.track.muted || existing.clip.disabled) throw new AppError(409, '已有音乐不是可保全的独立活动音轨，请重新选择或先分离原声。', 'OPENFILM_MUSIC_CLIP_CHANGED');
        const descriptor = musicClipDescription(existing.clip, musicAsset);
        if (descriptor.speed !== speed || sourceStart < descriptor.sourceStart - .001 || sourceEnd > descriptor.sourceEnd + .001 || Math.abs(descriptor.timelineAt + (sourceStart - descriptor.sourceStart) / speed - timelineAt) > .001 || Math.abs(descriptor.volume - volume) > .001) throw new AppError(409, '已有音乐的源范围、速度或位置已变化；不会重切或复制音乐。', 'OPENFILM_MUSIC_CLIP_CHANGED');
        musicClipId = existing.clip.id;
      }
      const sourceVolume = finite(originalVolume, 0, '画面原声音量', 0, 4), stage = current.doc.stage || stageFor(project.video || {}), clips = [];
      for (const [index, row] of plan.timeline.entries()) {
        requireObject(row, '画面片段'); const entry = [...available.bySource].find(([, asset]) => asset.id === row.assetId);
        if (!entry || !['video', 'image'].includes(entry[1].type) || allowed && !allowed.has(row.assetId)) throw new AppError(403, '画面源不是当前工程已选视频或图片。', 'OPENFILM_MUSIC_ASSET_SCOPE');
        const [src, asset] = entry, from = finite(row.start, undefined, '画面源起点'), to = finite(row.end, undefined, '画面源终点'), span = round(boundaries[index + 1] - boundaries[index]);
        if (to <= from || Math.abs(to - from - span) > .001 || !Number.isFinite(row.at) || Math.abs(row.at - boundaries[index]) > .001 || row.speed !== undefined && row.speed !== 1 || asset.type === 'image' && from !== 0 || asset.type === 'video' && to > asset.duration + .001) throw new AppError(400, '画面源时长与卡点边界不一致；不会变速凑时长。', 'OPENFILM_MUSIC_PLAN');
        clips.push({ id: 'gx-music-cut-' + randomUUID(), src, at: round(boundaries[index] - start), time: asset.type === 'image' ? [0, span] : [from, to], box: { x: 0, y: 0, w: stage.w, h: stage.h }, style: 'object-fit: contain', ...(asset.type === 'video' ? { volume: sourceVolume } : {}), attrs: { title: asset.name, 'data-guangxuan-asset-id': asset.id } });
      }
      const picture = { stage, tracks: [{ attrs: { id: 'guangxuan-picture', title: '画面' }, clips }] }; let ops, placement;
      if (mainTrack >= 0 && available.mainClips.length) {
        for (const item of allClips.filter(item => item.trackIndex === mainTrack)) {
          const span = clipSpan(item.clip, known[item.clip.src]?.duration), at = Number(item.clip.at || 0), clipEnd = at + span.length;
          if (at >= end || clipEnd <= start) continue;
          if (item.clip.attrs?.['data-link'] || allowed && !allowed.has(known[item.clip.src]?.assetId) || scope?.placement.clipIds && !scope.placement.clipIds.includes(item.clip.id)) throw new AppError(403, '目标主画面含联动或本轮未选择片段，未重排。', 'OPENFILM_MUSIC_SCOPE');
          if ((at < start || clipEnd > end) && (Object.keys(readMotion(item.clip, current.doc.keyframes)).length || (clipFade(item.clip) || []).some(value => value > 0))) throw new AppError(409, '跨卡点区间边界的原片段含动效或淡入淡出，请先保真分割。', 'OPENFILM_MUSIC_RANGE_COMPLEX');
        }
        const region = inspectRegion(current.doc, { mode: 'range', start, end }, known, { mainTrack, timeline: true, replaceCaptions: false });
        placement = replaceRegion(region, picture, { known, hasTimeline: true, hasCaptions: false }); ops = placement.ops;
      } else {
        const target = mainTrack >= 0 ? mainTrack : current.doc.tracks.length;
        if (mainTrack >= 0 && (current.doc.tracks[mainTrack].locked || current.doc.tracks[mainTrack].hidden)) throw new AppError(409, '主画面轨已锁定或隐藏。', 'OPENFILM_TRACK_LOCKED');
        ops = clips.map((clip, index) => ({ op: 'insert', clip: { ...clip, at: round(start + clip.at) }, ...(mainTrack < 0 && index === 0 ? { newTrack: target, newTrackAttrs: picture.tracks[0].attrs } : { track: target }) }));
        placement = { at: start, start, end, duration: length };
      }
      if (!existing) {
        musicClipId = 'gx-music-' + randomUUID();
        ops.push({ op: 'insert', clip: { id: musicClipId, src: musicPath, at: timelineAt, time: [sourceStart, sourceEnd], speed, volume, ...(musicAsset.type === 'video' ? { sound: true } : {}), attrs: { title: musicAsset.name, 'data-guangxuan-asset-id': musicAsset.id } }, newTrack: current.doc.tracks.length + (mainTrack < 0 ? 1 : 0), newTrackAttrs: { title: '音乐卡点配乐' } });
      }
      cancelled();
      if (await musicSourceHash(musicAsset.path, signal) !== plan.sourceVersion) throw new AppError(409, '音乐源在识别后已有变化，请重新分析。', 'OPENFILM_MUSIC_SOURCE_CHANGED');
      const owner = await store.read(projectId); if (!owner || owner.createdAt !== project.createdAt) throw new AppError(409, '卡点准备期间工程已重建。', 'OPENFILM_OWNER_CHANGED');
      cancelled(); const snapshot = keepUndo ? await assistantSnapshot(locations, current) : null;
      if (signal?.aborted) { if (snapshot) await unlink(snapshot.filename).catch(() => {}); cancelled(); }
      let result;
      try { result = await runtime.rpc('music-edit', { ...native, base: current.rev, ops, strict: true, musicSource: { path: musicPath, version: plan.sourceVersion } }); }
      catch (error) { if (snapshot && [400, 403, 404, 409].includes(error.status)) await unlink(snapshot.filename).catch(() => {}); throw error; }
      // Once the worker confirms the edit, Stop cannot erase the real receipt.
      const undo = await finishAssistantSnapshot(snapshot, result.rev);
      return { projectId, applied: true, revision: result.rev, ...undo, nativeUndoId: undo.undo?.id, sourceVersion: plan.sourceVersion, cutTimes: boundaries.slice(1, -1), beatCount: plan.observedBeatCount ?? plan.cutTimes.length, placement: { mode: 'range', at: start, start, end, duration: length }, outsidePreserved: true, musicClipId, existingMusicPreserved: Boolean(existing), ownerCreatedAt: project.createdAt, cancelledAfterCommit: signal?.aborted === true,
        summary: `${clips.length}段主画面已按实际拍点重排；${existing ? '原音乐保持' : '音乐与画面同次提交'}，范围外和其它轨道保留。`, ...filmStats(result.doc, known) };
    });
  }

  async function context(projectId, parentOrigin, { editScope, inspection, inspectAll = false } = {}) {
    return serial(validateProjectId(projectId), async () => {
      const { project, locations } = await prepare(projectId);
      const native = await openNative(projectId, locations, parentOrigin, false);
      const [current, files] = await Promise.all([runtime.rpc('read', native), runtime.rpc('files', native)]);
      const known = { ...(await readMarker(projectId))?.media };
      const { assets, bySource, warnings, mainClips, mainIndex } = await collectContextAssets(current, files, locations, known);
      const timeline = [];
      for (const clip of mainClips) {
        const asset = bySource.get(clip.src);
        if (!asset || clip.disabled || !['video', 'image'].includes(asset.type)) continue;
        if (clip.speed && clip.speed !== 1) { warnings.push('主轨包含变速片段，请按speed计算时长；复用clipId可保留原变速，新片段按原速放置。'); }
        timeline.push({ id: clip.id, assetId: asset.id, start: Number(clip.time?.[0] || 0), end: Number(clip.time?.[1] ?? asset.duration), at: Number(clip.at || 0), speed: Number(clip.speed || 1) });
      }
      const editable = await assessMainTrack(current.doc, locations, known, bySource);
      warnings.push(...editable.warnings);
      if ((current.doc?.tracks || []).some((track, index) => index !== mainIndex && track.clips?.some(clip => /\.html?$/i.test(clip.src) && clip.attrs?.['data-guangxuan-caption'] !== 'true'))) warnings.push('其它原生轨道的HTML页面片段保留，暂不参与媒体粗剪。');
      await writeMarker(project, { media: known });
      const legacy = project.video || project.videoProject || {};
      const stage = current.doc?.stage || stageFor(legacy);
      const ratio = stage.w / stage.h;
      const aspect = Math.abs(ratio - 16 / 9) < 0.02 ? '16:9' : Math.abs(ratio - 9 / 16) < 0.02 ? '9:16' : Math.abs(ratio - 1) < 0.02 ? '1:1' : null;
      return { projectId, nativeProjectId: native.nativeProjectId, assets, timeline, editorTimeline: nativeOperationContext(current.doc, known, editScope, inspection, { inspectAll }), mainTrackEditable: editable.mainTrackEditable && timeline.length === mainClips.length, script: typeof legacy.script === 'string' ? legacy.script : '', stage, aspect, ...filmStats(current.doc, known), warnings: [...new Set(warnings)], revision: current.rev };
    });
  }

  async function preflightSnapshot(projectId) {
    validateProjectId(projectId);
    return serial(projectId, async () => {
      const owner = await store.read(projectId);
      if (!owner || owner.kind !== 'video') throw new AppError(404, '请选择已有视频项目。', 'PROJECT_NOT_FOUND');
      const directory = path.join(library, projectId), filename = path.join(directory, 'film.html');
      const dataRoot = await realpath(dataDir);
      const comparable = value => process.platform === 'win32' ? value.toLowerCase() : value;
      let actual;
      try { actual = await realpath(directory); }
      catch (error) { if (error.code === 'ENOENT') return { projectId, document: null, revision: null, sources: [], missing: true, runtime: { available: (await status()).available } }; throw error; }
      if (comparable(actual) !== comparable(path.join(dataRoot, 'openfilm', 'projects', projectId)) || (await lstat(directory)).isSymbolicLink()) throw new AppError(403, '工程目录不在应用管理范围。', 'OPENFILM_OUTSIDE_PROJECT');
      let info;
      try { info = await lstat(filename); }
      catch (error) { if (error.code === 'ENOENT') return { projectId, document: null, revision: null, sources: [], missing: true, runtime: { available: (await status()).available } }; throw error; }
      if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) throw new AppError(422, '工程文件无法安全检查。', 'OPENFILM_INVALID_DOCUMENT');
      const text = await readFile(filename, 'utf8');
      const { readFilmFile } = await documentTools();
      const parsed = readFilmFile(text);
      if (!parsed.doc) throw new AppError(422, '工程结构无法读取，请在编辑器中检查。', 'OPENFILM_INVALID_DOCUMENT');
      const document = structuredClone(parsed.doc);
      const known = (await readMarker(projectId))?.media || {};
      const values = [...new Set([...(document.tracks || []).flatMap(track => (track.clips || []).map(clip => clip.src)), ...(document.tracks || []).map(track => track.captions?.src), ...(document.sounds || []).map(sound => sound.src)].filter(source => typeof source === 'string'))];
      const sources = [];
      for (const src of values.slice(0, 10000)) {
        const record = { src, sourceId: src, ...(known[src]?.assetId ? { assetId: known[src].assetId } : {}), exists: false, readable: false, controlled: false };
        if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('/') || src.startsWith('\\') || src.split(/[\\/]/).some(part => part === '..')) { sources.push({ ...record, external: true }); continue; }
        const candidate = path.resolve(directory, ...src.split('/'));
        try {
          const resolved = await realpath(candidate);
          if (!comparable(resolved).startsWith(comparable(actual + path.sep))) { sources.push({ ...record, external: true }); continue; }
          const sourceInfo = await stat(resolved);
          if (!sourceInfo.isFile()) { sources.push(record); continue; }
          await access(resolved);
          sources.push({ ...record, exists: true, readable: true, controlled: true, path: resolved, size: sourceInfo.size });
        } catch { sources.push(record); }
      }
      return { projectId, document, revision: `sha256:${createHash('sha256').update(text).digest('hex')}`, stage: document.stage, sources, runtime: { available: (await status()).available } };
    });
  }

  function serveEditor(req, res, url) {
    const requested = url?.searchParams.get('projectId');
    const current = requested ? opened.get(validateProjectId(requested)) : active;
    if (!runtime || !current) throw new AppError(409, '请先从项目详情打开原生剪辑。', 'OPENFILM_NOT_OPEN');
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OpenFilm原生剪辑</title><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#111}iframe{border:0;width:100%;height:100%;display:block}</style></head><body data-project-id="${escapeHtml(current.projectId)}" data-native-project-id="${escapeHtml(current.nativeProjectId)}" data-session-id="${escapeHtml(runtime.sessionId)}"><iframe id="openfilm-studio" title="OpenFilm原生剪辑" src="${escapeHtml(current.privateUrl)}" allow="autoplay; fullscreen; clipboard-write"></iframe><script src="/openfilm-shell.js"></script></body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'SAMEORIGIN',
      'Content-Security-Policy': `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; frame-src ${runtime.origin}; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'` });
    res.end(req.method === 'HEAD' ? undefined : html);
  }

  async function nativeExports(projectId) {
    const native = opened.get(projectId);
    if (!native || !runtime) return { exports: [] };
    const result = await runtime.rpc('exports', native);
    await recordNativeExports(projectId, native, result.exports || []);
    const capabilities = Object.fromEntries(['h264', 'hevc', 'hevcAlpha', 'vp9', 'prores', 'proresChip', 'mp3'].filter(key => typeof result.can?.[key] === 'boolean').map(key => [key, result.can[key]]));
    return { capabilities, exports: (result.exports || []).map(job => ({ id: job.id, kind: job.kind || job.spec?.kind || 'video', name: String(job.name || job.label || '原生导出').slice(0, 160), outputCount: job.outputs?.length || 0, status: job.status, progress: job.progress, ...(job.error ? { error: '原生导出未完成，请在编辑器查看原因。' } : {}), ...(job.status === 'done' && job.outputs?.length ? { downloadUrl: `/api/openfilm/exports/${encodeURIComponent(projectId)}/${encodeURIComponent(job.id)}/file` } : {}) })) };
  }

  // Native Studio keeps its job list only for this launch. Save only actual
  // completed download receipts, so a task's URL survives an app restart.
  const exportCataloguePath = projectId => path.join(paths(projectId).directory, '.guangxuan-exports.json');
  async function exportOwner(projectId) {
    const owner = await store.read(validateProjectId(projectId)), locations = paths(projectId);
    if (!owner || owner.kind && owner.kind !== 'video') throw new AppError(404, '当前视频工程不存在。', 'PROJECT_NOT_FOUND');
    try {
      const directory = await lstat(locations.directory), film = await lstat(locations.film);
      if (directory.isSymbolicLink() || film.isSymbolicLink() || !directory.isDirectory() || !film.isFile()) throw new AppError(403, '原生导出工程目录无效。', 'OPENFILM_EXPORT_STORAGE');
      if (!(await realpath(locations.directory)).startsWith(await realpath(library) + path.sep)) throw new AppError(403, '原生导出工程目录超出应用范围。', 'OPENFILM_EXPORT_STORAGE');
      let originalOwner;
      try {
        if ((await lstat(locations.marker)).isSymbolicLink()) throw new AppError(403, '原生工程标记不能使用链接。', 'OPENFILM_EXPORT_STORAGE');
        const marker = await readMarker(projectId);
        if (marker?.app === 'GuangxuanStudio' && marker.projectId === projectId) originalOwner = marker.ownerCreatedAt;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!originalOwner) {
        if ((await lstat(locations.snapshot)).isSymbolicLink()) throw new AppError(403, '原生工程快照不能使用链接。', 'OPENFILM_EXPORT_STORAGE');
        originalOwner = JSON.parse(await readFile(locations.snapshot, 'utf8')).createdAt;
      }
      if (!originalOwner) throw new AppError(404, '没有可核验的原生导出工程身份。', 'OPENFILM_EXPORT_NOT_FOUND');
      if (originalOwner !== owner.createdAt) throw new AppError(409, '此导出属于之前的同编号工程。', 'OPENFILM_OWNER_CHANGED');
      return owner;
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) throw new AppError(404, '原生导出工程不存在或没有有效回执。', 'OPENFILM_EXPORT_NOT_FOUND');
      throw error;
    }
  }

  async function readExportCatalogue(projectId, owner) {
    let value;
    try {
      const file = exportCataloguePath(projectId), info = await lstat(file);
      if (info.isSymbolicLink() || !info.isFile()) throw new AppError(403, '导出回执不能使用链接。', 'OPENFILM_EXPORT_STORAGE');
      value = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, app: 'GuangxuanStudio', projectId, ownerCreatedAt: owner.createdAt, exports: [] };
      if (error instanceof SyntaxError) throw new AppError(404, '导出回执格式无效。', 'OPENFILM_EXPORT_NOT_FOUND');
      throw error;
    }
    if (value?.version !== 1 || value.app !== 'GuangxuanStudio' || value.projectId !== projectId || !Array.isArray(value.exports)) throw new AppError(404, '没有有效的原生导出回执。', 'OPENFILM_EXPORT_NOT_FOUND');
    if (value.ownerCreatedAt !== owner.createdAt) throw new AppError(409, '此导出回执属于之前的同编号工程。', 'OPENFILM_OWNER_CHANGED');
    return value;
  }

  async function fileHash(filename) {
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(filename)) hash.update(bytes);
    return hash.digest('hex');
  }

  async function recordNativeExports(projectId, native, jobs) {
    if (!jobs.some(job => job.status === 'done' && job.outputs?.length)) return;
    return serial(`exports:${projectId}`, async () => {
      const owner = await exportOwner(projectId), catalogue = await readExportCatalogue(projectId, owner);
      const known = new Set(catalogue.exports.map(item => item.id)); let changed = false;
      for (const job of jobs) {
        if (job.status !== 'done' || !job.outputs?.length || known.has(job.id)) continue;
        const prepared = await prepareNativeExportDownload({ exportsRoot: path.join(ownedHome, 'exports'), projectId: native.nativeProjectId, job });
        const sha256 = await fileHash(prepared.path);
        catalogue.exports.push({ id: job.id, nativeProjectId: native.nativeProjectId, status: 'done', recordedAt: new Date().toISOString(), ...prepared, sha256 });
        known.add(job.id); changed = true;
      }
      if (changed) {
        if ((await exportOwner(projectId)).createdAt !== owner.createdAt) throw new AppError(409, '保存导出回执期间工程已重建。', 'OPENFILM_OWNER_CHANGED');
        // A receipt contains IPC-only paths, never a guessed filename or a
        // persisted public task claiming unfinished work has succeeded.
        await atomic(exportCataloguePath(projectId), JSON.stringify({ ...catalogue, exports: catalogue.exports.slice(-1000) }, null, 2));
      }
    });
  }

  async function exportVideo(projectId, spec, parentOrigin, { expectedRevision } = {}) {
    requireObject(spec, '导出设置');
    return serial(validateProjectId(projectId), async () => {
      const { locations } = await prepare(projectId);
      const native = await openNative(projectId, locations, parentOrigin, false);
      if (expectedRevision !== undefined) {
        if (typeof expectedRevision !== 'string' || !/^[a-f0-9]{16}$/.test(expectedRevision)) throw new AppError(400, '请先读取当前时间线，再开始导出。', 'OPENFILM_REVISION_REQUIRED');
        const current = await runtime.rpc('read', native);
        if (current.rev !== expectedRevision) throw new AppError(409, '原生工程已变化，请重新体检后再导出。', 'OPENFILM_REVISION_CONFLICT');
      }
      const ask = { kind: 'video', fps: finite(spec.fps, 30, '帧率', 1, 120), hardware: false, name: String(spec.name || '光宣成片').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 100) };
      if (spec.range !== undefined) {
        if (!Array.isArray(spec.range) || spec.range.length !== 2) throw new AppError(400, '导出范围不正确。', 'INVALID_OPENFILM_EXPORT');
        ask.range = [finite(spec.range[0], 0, '开始时间'), finite(spec.range[1], 0, '结束时间')];
        if (ask.range[1] <= ask.range[0]) throw new AppError(400, '导出结束时间须晚于开始时间。', 'INVALID_OPENFILM_EXPORT');
      }
      const result = await runtime.rpc('export', { ...native, spec: ask, ...(expectedRevision !== undefined ? { base: expectedRevision } : {}) });
      return { projectId, export: { id: result.export.id, status: result.export.status, progress: result.export.progress } };
    });
  }

  async function exportNative(projectId, spec, parentOrigin, { expectedRevision } = {}) {
    const ask = normalizeNativeExport(spec);
    return serial(validateProjectId(projectId), async () => {
      const { locations } = await prepare(projectId), native = await openNative(projectId, locations, parentOrigin, false);
      if (expectedRevision !== undefined && (typeof expectedRevision !== 'string' || !/^[a-f0-9]{16}$/.test(expectedRevision))) throw new AppError(400, '请先读取当前时间线，再开始导出。', 'OPENFILM_REVISION_REQUIRED');
      const current = await runtime.rpc('read', native);
      if (expectedRevision !== undefined && current.rev !== expectedRevision) throw new AppError(409, '原生工程已变化，请重新体检后再导出。', 'OPENFILM_REVISION_CONFLICT');
      const result = await runtime.rpc('export', { ...native, spec: ask, base: current.rev });
      return { projectId, export: { id: result.export.id, kind: ask.kind, status: result.export.status, progress: result.export.progress } };
    });
  }

  async function cancelNativeExport(projectId, exportId, parentOrigin) {
    if (typeof exportId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(exportId)) throw new AppError(400, '原生导出编号不正确。', 'OPENFILM_EXPORT_INVALID');
    return serial(validateProjectId(projectId), async () => {
      const native = opened.get(projectId);
      if (!runtime || !native) throw new AppError(404, '当前项目没有运行中的原生导出服务。', 'OPENFILM_EXPORT_NOT_FOUND');
      const value = await runtime.rpc('cancel-export', { ...native, exportId });
      return { projectId, exportId, cancellationRequested: value.cancelled === true, ...(await nativeExports(projectId)) };
    });
  }

  async function projectCapabilityNative(projectId, parentOrigin) {
    const owner = await store.read(projectId), marker = await readMarker(projectId);
    if (!owner || owner.kind !== 'video') throw new AppError(404, '当前视频工程不存在。', 'PROJECT_NOT_FOUND');
    let ownerCreatedAt = marker?.ownerCreatedAt;
    if (!ownerCreatedAt) { try { ownerCreatedAt = JSON.parse(await readFile(paths(projectId).snapshot, 'utf8')).createdAt; } catch {} }
    if (ownerCreatedAt && ownerCreatedAt !== owner.createdAt) throw new AppError(409, '原生内容属于之前的同编号工程，不能覆盖当前项目。', 'OPENFILM_OWNER_CHANGED');
    const cached = opened.get(projectId);
    if (runtime && cached && ownerCreatedAt === owner.createdAt) return cached;
    const { locations } = await prepare(projectId); return openNative(projectId, locations, parentOrigin, false);
  }

  async function readProjectCapability(projectId, section, args, parentOrigin) {
    if (!['markers', 'history', 'page', 'canvas'].includes(section)) throw new AppError(400, '请选择标记、工程历史、页面内容或画布。', 'OPENFILM_PROJECT_CAPABILITY');
    requireObject(args || {}, '工程读取参数');
    return serial(validateProjectId(projectId), async () => {
      const native = await projectCapabilityNative(projectId, parentOrigin);
      return runtime.rpc('project-read', { ...native, section, args: args || {} });
    });
  }

  async function editProjectCapability(projectId, section, action, expectedRevision, args, parentOrigin, { expectedNativeRevision, editScope, signal } = {}) {
    if (!['markers', 'history', 'page', 'canvas'].includes(section) || typeof action !== 'string' || typeof expectedRevision !== 'string' || !expectedRevision || expectedRevision.length > 200) throw new AppError(400, '工程内容修改需要真实操作和当前版本。', 'OPENFILM_PROJECT_CAPABILITY');
    requireObject(args || {}, '工程修改参数');
    return serial(validateProjectId(projectId), async () => {
      if (signal?.aborted) throw new AppError(499, '操作已停止。', 'REQUEST_CANCELLED');
      const native = await projectCapabilityNative(projectId, parentOrigin);
      const current = await runtime.rpc('read', native);
      if (expectedNativeRevision !== undefined && current.rev !== expectedNativeRevision) throw new AppError(409, '原生工程已变化，请重新读取后再修改。', 'OPENFILM_REVISION_CONFLICT');
      if (signal?.aborted) throw new AppError(499, '操作已停止。', 'REQUEST_CANCELLED');
      return runtime.rpc('project-edit', { ...native, section, operation: action, expectedRevision, expectedFilmRevision: current.rev, args: args || {}, editScope });
    });
  }

  async function undoProjectCapability(projectId, undoId, parentOrigin, { editScope, signal } = {}) {
    if (typeof undoId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(undoId)) throw new AppError(400, '工程内容撤销编号不正确。', 'OPENFILM_PROJECT_UNDO');
    return serial(validateProjectId(projectId), async () => {
      if (signal?.aborted) throw new AppError(499, '操作已停止。', 'REQUEST_CANCELLED');
      const native = await projectCapabilityNative(projectId, parentOrigin);
      return runtime.rpc('project-undo', { ...native, undoId, editScope });
    });
  }

  async function download(req, res, projectId, exportId) {
    validateProjectId(projectId);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(exportId)) throw new AppError(404, '原生导出不存在。', 'OPENFILM_EXPORT_NOT_FOUND');
    const owner = await exportOwner(projectId);
    let catalogue = await readExportCatalogue(projectId, owner), prepared = catalogue.exports.find(item => item.id === exportId);
    if (!prepared && runtime && opened.has(projectId)) {
      await nativeExports(projectId);
      catalogue = await readExportCatalogue(projectId, owner); prepared = catalogue.exports.find(item => item.id === exportId);
    }
    if (!prepared || prepared.status !== 'done' || !/^[a-f0-9]{64}$/.test(prepared.sha256 || '') || !Number.isSafeInteger(prepared.size) || prepared.size < 1) throw new AppError(404, '没有当前工程可核验的已完成导出回执。', 'OPENFILM_EXPORT_NOT_FOUND');
    const exportsRoot = path.resolve(ownedHome, 'exports');
    if (typeof prepared.path !== 'string' || !path.isAbsolute(prepared.path)) throw new AppError(403, '导出文件路径无效。', 'OPENFILM_EXPORT_STORAGE');
    const relative = path.relative(exportsRoot, prepared.path);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new AppError(403, '导出文件超出应用目录。', 'OPENFILM_EXPORT_STORAGE');
    let checked = exportsRoot;
    try {
      for (const part of ['', ...relative.split(path.sep)]) { if (part) checked = path.join(checked, part); if ((await lstat(checked)).isSymbolicLink()) throw new AppError(403, '导出文件不能使用链接。', 'OPENFILM_EXPORT_STORAGE'); }
    } catch (error) { if (error.code === 'ENOENT') throw new AppError(404, '导出文件已被移动或删除。', 'OPENFILM_EXPORT_NOT_FOUND'); throw error; }
    const actualRoot = await realpath(exportsRoot), actualFile = await realpath(prepared.path), actualRelative = path.relative(actualRoot, actualFile), info = await stat(actualFile);
    if (!actualRelative || actualRelative === '..' || actualRelative.startsWith('..' + path.sep) || path.isAbsolute(actualRelative) || !info.isFile() || info.size !== prepared.size) throw new AppError(403, '导出文件未通过本机核验。', 'OPENFILM_EXPORT_STORAGE');
    if (await fileHash(actualFile) !== prepared.sha256) throw new AppError(409, '导出文件已被修改或覆盖，请重新导出。', 'OPENFILM_EXPORT_CHANGED');
    if ((await exportOwner(projectId)).createdAt !== owner.createdAt) throw new AppError(409, '下载期间工程已重建。', 'OPENFILM_OWNER_CHANGED');
    res.writeHead(200, { 'Content-Type': prepared.contentType || 'application/octet-stream', 'Content-Length': info.size, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(prepared.name || 'native-export')}`, 'Cache-Control': 'no-store' });
    if (req.method === 'HEAD') { res.end(); return; }
    try { await pipeline(createReadStream(actualFile), res); } catch { if (!res.destroyed) res.destroy(); }
  }

  return {
    status, open, importAsset, applyPlan, adjustClips, operateClips, readSubtitles, appendAsset, undoAssistant, context, preflightSnapshot, summary, syncMetadata, serveEditor, nativeExports, exportVideo, exportNative, cancelNativeExport, readProjectCapability, editProjectCapability, undoProjectCapability, download, readMusicRhythm, applyMusicCutPlan,
    async close() {
      closing = true;
      await Promise.allSettled([...queues.values()]);
      if (runtime) { const child = runtime.child; try { await runtime.rpc('close'); } catch { child.kill(); } }
      runtime = null; active = null;
    },
  };
}
