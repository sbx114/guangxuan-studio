import path from 'node:path';
import { access, copyFile, mkdir, readFile, realpath, rename, stat, writeFile, unlink } from 'node:fs/promises';
import { fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { AppError, requireObject } from './errors.mjs';
import { validateProjectId, withoutSecrets } from './store.mjs';
import { findAnimationBrowser } from '../animation/render.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const round = value => Math.round(value * 1000) / 1000;

async function atomic(filename, content) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, content, { mode: 0o600 }); await rename(temporary, filename); }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

function finite(value, fallback, label, min = 0, max = 86400) {
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
        if (message.error) call.reject(new AppError(message.status === 409 ? 409 : 502, `OpenFilm操作未完成：${message.error}`, 'OPENFILM_REQUEST_FAILED'));
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

  async function copyAsset(id, locations, known) {
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
    if (!same) {
      const temporary = `${target}.${randomUUID()}.tmp`;
      try { await copyFile(asset.path, temporary); await rename(temporary, target); }
      catch { await unlink(temporary).catch(() => {}); throw new AppError(500, '无法复制项目媒体，请检查可用空间。', 'OPENFILM_MEDIA_COPY_FAILED'); }
    }
    known[relative] = { ...known[relative], originalAssetId: known[relative]?.originalAssetId || asset.id, assetId: asset.id, name: asset.name, duration: asset.duration, type: asset.type, generated: Boolean(asset.generated) };
    return { asset, src: relative };
  }

  async function materialize(video, locations, known = {}, requestedStage) {
    requireObject(video, '剪辑方案');
    if (!Array.isArray(video.timeline) || video.timeline.length > 200) throw new AppError(400, '剪辑方案需要时间线，最多200个片段。', 'INVALID_OPENFILM_PLAN');
    const stage = requestedStage || stageFor(video);
    const picture = { attrs: { id: 'guangxuan-picture', title: '画面' }, clips: [] };
    const subtitles = { attrs: { id: 'guangxuan-captions', title: '字幕' }, clips: [] };
    const music = { attrs: { id: 'guangxuan-music', title: '配乐' }, clips: [] };
    const volume = finite(video.sourceVolume, 1, '原声音量', 0, 1);
    let cursor = 0;
    for (const clip of video.timeline) {
      const { asset, src } = await copyAsset(clip?.assetId, locations, known);
      if (asset.type === 'audio') throw new AppError(400, '音频请放入配乐轨道。', 'INVALID_OPENFILM_PLAN');
      const start = finite(clip.start, 0, '入点');
      const end = finite(clip.end, asset.duration, '出点');
      if (end <= start || (asset.type !== 'image' && end > asset.duration + 0.01)) throw new AppError(400, '片段出入点超出素材时长。', 'INVALID_OPENFILM_PLAN');
      picture.clips.push({ src, id: `gx-${randomUUID()}`, at: round(cursor), time: asset.type === 'image' ? [0, round(end - start)] : [round(start), round(end)],
        box: { x: 0, y: 0, w: stage.w, h: stage.h }, style: 'object-fit: contain', ...(asset.type === 'video' ? { volume } : {}), attrs: { title: asset.name, 'data-guangxuan-asset-id': asset.id } });
      cursor = round(cursor + end - start);
    }
    if (cursor > 3600) throw new AppError(400, '此桥接支持不超过60分钟的时间线。', 'INVALID_OPENFILM_PLAN');
    if (video.captions !== undefined && (!Array.isArray(video.captions) || video.captions.length > 2000)) throw new AppError(400, '字幕格式或数量不正确。', 'INVALID_OPENFILM_PLAN');
    await mkdir(path.join(locations.directory, 'pages'), { recursive: true });
    for (const [captionIndex, caption] of (video.captions || []).entries()) {
      const start = finite(caption?.start, 0, '字幕开始时间', 0, Math.max(cursor, 0));
      const end = finite(caption?.end, cursor, '字幕结束时间', 0, Math.max(cursor, 0));
      if (end <= start || typeof caption?.text !== 'string' || !caption.text.trim() || caption.text.length > 2000) throw new AppError(400, '字幕需要有效文字与时间。', 'INVALID_OPENFILM_PLAN');
      const name = `字幕-${String(captionIndex + 1).padStart(3, '0')}-${randomUUID().replace(/-/g, '').slice(0, 12)}.html`;
      const duration = round(end - start);
      const size = Math.round(Math.min(stage.w, stage.h) * 0.047);
      const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;background:transparent}body{display:flex;align-items:flex-end;justify-content:center;box-sizing:border-box;padding:0 7% 7%;font-family:"Microsoft YaHei",sans-serif;color:white;text-align:center}#caption{white-space:pre-wrap;font-size:${size}px;font-weight:700;line-height:1.4;text-shadow:0 2px 4px #000,-1px -1px 2px #000}</style></head><body><div id="caption">${escapeHtml(caption.text)}</div><script>window.film={duration:${duration},frame(t){}};</script></body></html>`;
      await writeFile(path.join(locations.directory, 'pages', name), html, { mode: 0o600, flag: 'wx' });
      subtitles.clips.push({ src: `pages/${name}`, id: `gx-caption-${randomUUID()}`, at: round(start), time: [0, duration], size: stage, box: { x: 0, y: 0, w: stage.w, h: stage.h }, attrs: { title: `字幕${captionIndex + 1} · ${caption.text.slice(0, 30)}`, 'data-guangxuan-caption': 'true' } });
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
    const value = { stage, tracks: [subtitles, picture, music].filter(track => track.clips.length) };
    const { readFilm } = await documentTools();
    const checked = readFilm(structuredClone(value));
    if (!checked.doc) throw new AppError(422, '剪辑方案不能转换为有效OpenFilm工程。', 'OPENFILM_MIGRATION_INVALID');
    return { value, known };
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

  async function applyPlan(projectId, plan, parentOrigin, expectedRevision) {
    if (typeof expectedRevision !== 'string' || !/^[a-f0-9]{16}$/.test(expectedRevision)) throw new AppError(400, '请先读取当前工程上下文，再应用剪辑计划。', 'OPENFILM_REVISION_REQUIRED');
    return serial(validateProjectId(projectId), async () => {
      const { project, locations } = await prepare(projectId);
      const known = { ...(await readMarker(projectId))?.media };
      const native = await openNative(projectId, locations, parentOrigin, false);
      const current = await runtime.rpc('read', native);
      if (current.rev !== expectedRevision) throw new AppError(409, '原生工程在生成计划后已修改，请刷新上下文再检查计划。', 'OPENFILM_REVISION_CONFLICT');
      const editable = await assessMainTrack(current.doc, locations, known);
      if (!editable.mainTrackEditable) throw new AppError(409, editable.warnings.join(' '), 'OPENFILM_MAIN_TRACK_UNSUPPORTED');
      const converted = await materialize(plan, locations, known, current.doc?.stage);
      const mainTrack = primaryTrackIndex(current.doc);
      const ops = [];
      for (const [index, track] of (current.doc?.tracks || []).entries()) {
        const replace = index === mainTrack ||
          (Object.hasOwn(plan, 'captions') && track.attrs?.id === 'guangxuan-captions') ||
          (Object.hasOwn(plan, 'music') && track.attrs?.id === 'guangxuan-music');
        if (replace) for (const clip of track.clips || []) ops.push({ op: 'remove', clip: clip.id });
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
      if (!ops.length) return { projectId, editorUrl: '/openfilm/editor.html', applied: false, ...filmStats(current.doc, known) };
      const result = await runtime.rpc('edit', { ...native, base: current.rev, ops });
      await writeMarker(project, { media: converted.known, lastPlanAppliedAt: new Date().toISOString() });
      return { projectId, editorUrl: '/openfilm/editor.html', applied: true, revision: result.rev, ...filmStats(result.doc || converted.value, known) };
    });
  }

  async function appendAsset(projectId, assetId, parentOrigin, at) {
    return serial(validateProjectId(projectId), async () => {
      const { project, locations } = await prepare(projectId);
      const known = { ...(await readMarker(projectId))?.media };
      const { asset, src } = await copyAsset(assetId, locations, known);
      const native = await openNative(projectId, locations, parentOrigin, false);
      const current = await runtime.rpc('read', native);
      const stage = current.doc?.stage || stageFor({});
      const stats = filmStats(current.doc, known);
      const startAt = finite(at, stats.duration, '片段开始时间', 0, 3600);
      const clip = { src, id: `gx-${randomUUID()}`, at: round(startAt), time: [0, round(asset.duration)], attrs: { title: asset.name, 'data-guangxuan-asset-id': asset.id }, ...(asset.type === 'audio' ? {} : { box: { x: 0, y: 0, w: stage.w, h: stage.h }, style: 'object-fit: contain' }) };
      const result = await runtime.rpc('edit', { ...native, base: current.rev, ops: [{ op: 'insert', clip }] });
      await writeMarker(project, { media: known });
      return { projectId, appended: true, ...filmStats(result.doc, known), editorUrl: '/openfilm/editor.html' };
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
    if (new Set(clips.map(clip => clip.src)).size > 500) return { mainTrackEditable: false, warnings: ['主画面轨的独立素材超过AI上下文上限，暂不可应用粗剪。'] };
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
        try { asset = await registerOwnedAsset(path.join(locations.directory, ...src.split('/')), locations.directory, { name: known[src]?.name || path.basename(src), generated: known[src]?.generated }); }
        catch { /* Report the unsupported clip without exposing file paths. */ }
      }
      if (!asset || !['video', 'image'].includes(asset.type)) {
        warnings.push('主画面轨有无法注册为项目媒体的片段，AI粗剪暂不可应用；请先修复或收集该素材。'); continue;
      }
      represented++;
    }
    return { mainTrackEditable: represented === clips.length, warnings: [...new Set(warnings)] };
  }

  async function context(projectId, parentOrigin) {
    return serial(validateProjectId(projectId), async () => {
      const { project, locations } = await prepare(projectId);
      const native = await openNative(projectId, locations, parentOrigin, false);
      const [current, files] = await Promise.all([runtime.rpc('read', native), runtime.rpc('files', native)]);
      const known = { ...(await readMarker(projectId))?.media };
      const assets = [];
      const bySource = new Map();
      const warnings = [];
      const mainIndex = primaryTrackIndex(current.doc);
      const mainClips = current.doc?.tracks?.[mainIndex]?.clips || [];
      const sources = [...new Set([...mainClips.map(clip => clip.src), ...(files.files || []).map(file => file.path)])].filter(src => typeof src === 'string' && /\.(?:mp4|m4v|mov|webm|mkv|avi|ogv|png|jpe?g|webp|bmp|mp3|wav|m4a|aac|flac|ogg|opus)$/i.test(src)).slice(0, 500);
      for (const src of sources) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('/') || src.startsWith('\\') || src.split(/[\\/]/).some(part => part === '..' || part.startsWith('.'))) { warnings.push('一个外部或隐藏素材未纳入AI上下文。'); continue; }
        try {
          const asset = await registerOwnedAsset(path.join(locations.directory, ...src.split('/')), locations.directory, { name: known[src]?.name || path.basename(src), generated: known[src]?.generated });
          bySource.set(src, asset);
          if (!assets.some(item => item.id === asset.id)) assets.push({ id: asset.id, name: asset.name, type: asset.type, duration: asset.duration, width: asset.width || 0, height: asset.height || 0, hasAudio: asset.hasAudio, generated: Boolean(asset.generated), url: `/api/video/media/${asset.id}` });
          known[src] = { ...known[src], assetId: asset.id, name: asset.name, type: asset.type, duration: asset.duration, generated: Boolean(asset.generated) };
        } catch { warnings.push(`素材“${path.basename(src)}”暂不可供AI处理；外部链接请先收集到项目。`); }
      }
      const timeline = [];
      for (const clip of mainClips) {
        const asset = bySource.get(clip.src);
        if (!asset || clip.disabled || !['video', 'image'].includes(asset.type)) continue;
        if (clip.speed && clip.speed !== 1) { warnings.push('主轨包含变速片段，AI粗剪应用后按原速片段重新编排。'); }
        timeline.push({ id: clip.id, assetId: asset.id, start: Number(clip.time?.[0] || 0), end: Number(clip.time?.[1] ?? asset.duration), at: Number(clip.at || 0) });
      }
      const editable = await assessMainTrack(current.doc, locations, known, bySource);
      warnings.push(...editable.warnings);
      if ((current.doc?.tracks || []).some((track, index) => index !== mainIndex && track.clips?.some(clip => /\.html?$/i.test(clip.src) && clip.attrs?.['data-guangxuan-caption'] !== 'true'))) warnings.push('其它原生轨道的HTML页面片段保留，暂不参与媒体粗剪。');
      await writeMarker(project, { media: known });
      const legacy = project.video || project.videoProject || {};
      const stage = current.doc?.stage || stageFor(legacy);
      const ratio = stage.w / stage.h;
      const aspect = Math.abs(ratio - 16 / 9) < 0.02 ? '16:9' : Math.abs(ratio - 9 / 16) < 0.02 ? '9:16' : Math.abs(ratio - 1) < 0.02 ? '1:1' : null;
      return { projectId, nativeProjectId: native.nativeProjectId, assets, timeline, mainTrackEditable: editable.mainTrackEditable && timeline.length === mainClips.length, script: typeof legacy.script === 'string' ? legacy.script : '', stage, aspect, ...filmStats(current.doc, known), warnings: [...new Set(warnings)], revision: current.rev };
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
    return { exports: (result.exports || []).map(job => ({ id: job.id, status: job.status, progress: job.progress, ...(job.error ? { error: '原生导出未完成，请在编辑器查看原因。' } : {}), ...(job.status === 'done' ? { downloadUrl: `/api/openfilm/exports/${encodeURIComponent(projectId)}/${encodeURIComponent(job.id)}/file` } : {}) })) };
  }

  async function exportVideo(projectId, spec, parentOrigin) {
    requireObject(spec, '导出设置');
    return serial(validateProjectId(projectId), async () => {
      const { locations } = await prepare(projectId);
      const native = await openNative(projectId, locations, parentOrigin, false);
      const ask = { kind: 'video', fps: finite(spec.fps, 30, '帧率', 1, 120), hardware: false, name: String(spec.name || '光宣成片').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 100) };
      if (spec.range !== undefined) {
        if (!Array.isArray(spec.range) || spec.range.length !== 2) throw new AppError(400, '导出范围不正确。', 'INVALID_OPENFILM_EXPORT');
        ask.range = [finite(spec.range[0], 0, '开始时间', 0, 3600), finite(spec.range[1], 0, '结束时间', 0, 3600)];
        if (ask.range[1] <= ask.range[0]) throw new AppError(400, '导出结束时间须晚于开始时间。', 'INVALID_OPENFILM_EXPORT');
      }
      const result = await runtime.rpc('export', { ...native, spec: ask });
      return { projectId, export: { id: result.export.id, status: result.export.status, progress: result.export.progress } };
    });
  }

  async function download(req, res, projectId, exportId) {
    const native = opened.get(validateProjectId(projectId));
    if (!runtime || !native || !/^[A-Za-z0-9_-]{1,128}$/.test(exportId)) throw new AppError(404, '原生导出不存在。', 'OPENFILM_EXPORT_NOT_FOUND');
    const key = new URL(native.privateUrl).searchParams.get('key');
    const response = await fetch(`${runtime.origin}/api/projects/${encodeURIComponent(native.nativeProjectId)}/exports/${exportId}/file`, { headers: { 'x-studio-key': key }, signal: AbortSignal.timeout(120000) });
    if (!response.ok) { await response.body?.cancel(); throw new AppError(404, '原生导出文件尚未完成或已移除。', 'OPENFILM_EXPORT_NOT_FOUND'); }
    res.writeHead(200, { 'Content-Type': response.headers.get('content-type') || 'video/mp4', 'Content-Disposition': response.headers.get('content-disposition') || 'attachment; filename="openfilm-export.mp4"', 'Cache-Control': 'no-store', ...(response.headers.get('content-length') ? { 'Content-Length': response.headers.get('content-length') } : {}) });
    if (req.method === 'HEAD') { await response.body?.cancel(); res.end(); return; }
    try { await pipeline(Readable.fromWeb(response.body), res); } catch { if (!res.destroyed) res.destroy(); }
  }

  return {
    status, open, applyPlan, appendAsset, context, summary, syncMetadata, serveEditor, nativeExports, exportVideo, download,
    async close() {
      closing = true;
      await Promise.allSettled([...queues.values()]);
      if (runtime) { const child = runtime.child; try { await runtime.rpc('close'); } catch { child.kill(); } }
      runtime = null; active = null;
    },
  };
}
