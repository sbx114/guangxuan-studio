import path from 'node:path';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { AppError } from './errors.mjs';
import { validateProjectId } from './store.mjs';
import { clipSpan, kindOf } from '../integrations/openfilm/packages/openfilm/src/film-doc.mjs';
import { findAnimationBrowser } from '../animation/render.mjs';

const LIMITS = Object.freeze({ maxClips: 2000, maxProbes: 24, probeBudgetMs: 12000, maxDeepSamples: 6, maxSampleSeconds: 12, maxDeepSeconds: 60, deepBudgetMs: 30000 });
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const round = value => Math.round(value * 1000) / 1000;
const failed = (status, message, code) => new AppError(status, message, code);
const cancelled = () => failed(499, '导出体检已取消。', 'EXPORT_PREFLIGHT_CANCELLED');
const checkAbort = signal => { if (signal?.aborted) throw cancelled(); };
const inside = (parent, child) => { const rel = path.relative(parent, child); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); };
function display(value, fallback = '项目素材') {
  if (typeof value !== 'string') return fallback;
  const text = value.replace(/(?:https?|file):\/\/[^\s]+/gi, '[地址已隐藏]').replace(/\bsk-[A-Za-z0-9_-]{6,}/g, '[密钥已隐藏]').split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 120);
  return text || fallback;
}
function processRun(executable, args, { signal, timeoutMs = 6000, children } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled());
    let child, settled = false, timedOut = false, size = 0, stdout = '', stderr = '';
    try { child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { reject(failed(503, '本地媒体检测程序无法启动。', 'PREFLIGHT_PROCESS_UNAVAILABLE')); return; }
    children?.add(child);
    const abort = () => child.kill(); signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, Math.max(100, timeoutMs)); timer.unref?.();
    const finish = error => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); children?.delete(child);
      error ? reject(error) : resolve({ stdout, stderr });
    };
    const collect = (chunk, error) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) { child.kill(); finish(failed(422, '检测输出超过限额。', 'PREFLIGHT_OUTPUT_LIMIT')); return; }
      if (error) stderr += chunk.toString(); else stdout += chunk.toString();
    };
    child.stdout.on('data', chunk => collect(chunk, false)); child.stderr.on('data', chunk => collect(chunk, true));
    child.once('error', () => finish(failed(503, '本地媒体检测程序不可用。', 'PREFLIGHT_PROCESS_UNAVAILABLE')));
    child.once('close', code => finish(signal?.aborted ? cancelled() : timedOut ? failed(504, '本次媒体检测超时。', 'PREFLIGHT_PROCESS_TIMEOUT') : code !== 0 ? failed(422, '素材无法完成媒体检测。', 'PREFLIGHT_MEDIA_UNREADABLE') : null));
    if (signal?.aborted) abort();
  });
}
async function findBinary(name, root, explicit) {
  if (explicit === false) return null;
  const binary = `${name}${process.platform === 'win32' ? '.exe' : ''}`;
  const candidates = [typeof explicit === 'string' ? explicit : explicit?.path, process.env[`GUANGXUAN_${name.toUpperCase()}`], process.env.GUANGXUAN_BIN_DIR && path.join(process.env.GUANGXUAN_BIN_DIR, binary), root && path.join(root, 'bin', binary), process.resourcesPath && path.join(process.resourcesPath, 'bin', binary), name].filter(Boolean);
  for (const candidate of [...new Set(candidates)]) { try { await processRun(candidate, ['-version'], { timeoutMs: 2500 }); return candidate; } catch { /* Try the next existing local runtime. */ } }
  return null;
}
function mergeIntervals(items, start, end) {
  const list = items.map(([a, b]) => [Math.max(a, start), Math.min(b, end)]).filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const item of list) { const last = merged.at(-1); if (last && item[0] <= last[1] + .001) last[1] = Math.max(last[1], item[1]); else merged.push([...item]); }
  return merged;
}
function gaps(intervals, start, end, tolerance) {
  const result = []; let cursor = start;
  for (const [a, b] of mergeIntervals(intervals, start, end)) { if (a - cursor > tolerance) result.push([cursor, a]); cursor = Math.max(cursor, b); }
  if (end - cursor > tolerance) result.push([cursor, end]); return result;
}
function detections(log, duration) {
  const intervals = { black: [], silence: [] }, pending = {};
  for (const match of log.matchAll(/\b(black|silence)_(start|end):\s*(-?\d+(?:\.\d+)?)/g)) {
    const [, kind, boundary, text] = match, value = Math.max(0, Math.min(duration, Number(text)));
    if (boundary === 'start') pending[kind] = value;
    else if (pending[kind] !== undefined) { if (value > pending[kind]) intervals[kind].push([pending[kind], value]); delete pending[kind]; }
  }
  for (const kind of ['black', 'silence']) if (pending[kind] !== undefined && duration > pending[kind]) intervals[kind].push([pending[kind], duration]);
  return intervals;
}
function vttCues(text) {
  const seconds = value => { const parts = value.split(':').map(Number); return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1]; };
  return [...text.matchAll(/((?:\d{2,}:)?\d{2}:\d{2}\.\d{3})\s*-->\s*((?:\d{2,}:)?\d{2}:\d{2}\.\d{3})([^\r\n]*)/g)].slice(0, 2000).map(match => ({ start: seconds(match[1]), end: seconds(match[2]), settings: match[3] }));
}

/** Read-only structural checks and bounded source-media samples. This does not render the final film. */
export async function createExportPreflight({ dataDir, root, openFilm, videoService, capabilities } = {}) {
  if (!dataDir || !openFilm) throw failed(500, '导出体检服务尚未配置。', 'EXPORT_PREFLIGHT_NOT_CONFIGURED');
  const children = new Set(), controllers = new Set(); let closed = false, binariesPromise;
  async function binaries() {
    binariesPromise ||= (async () => {
      const caps = (typeof capabilities === 'function' ? await capabilities() : capabilities) || {}, tools = await videoService?.runtimeTools?.() || {};
      const [ffmpeg, ffprobe, browser] = await Promise.all([findBinary('ffmpeg', root, caps.ffmpegPath ?? caps.ffmpeg ?? tools.ffmpeg), findBinary('ffprobe', root, caps.ffprobePath ?? caps.ffprobe ?? tools.ffprobe), caps.browserAvailable === undefined ? findAnimationBrowser().then(() => true).catch(() => false) : Promise.resolve(caps.browserAvailable === true)]);
      return { ffmpeg, ffprobe, browser, exportReady: caps.exportReady ?? caps.ready };
    })();
    return binariesPromise;
  }
  async function snapshot(projectId, origin) {
    if (typeof openFilm.preflightSnapshot === 'function') return openFilm.preflightSnapshot(projectId, origin);
    const context = await openFilm.context(projectId, origin);
    const assets = Array.isArray(context.assets) ? context.assets : [], sourceMap = new Map(assets.map(asset => [asset.id, asset]));
    const sources = [], clips = (context.timeline || []).map((item, index) => {
      const asset = sourceMap.get(item.assetId), src = `media/${ID.test(item.assetId || '') ? item.assetId : index}.${asset?.type === 'image' ? 'png' : asset?.type === 'audio' ? 'wav' : 'mp4'}`;
      sources.push({ src, assetId: item.assetId, name: asset?.name, duration: asset?.duration });
      return { id: item.id || `clip-${index}`, src, at: item.at || 0, time: [item.start || 0, item.end], speed: item.speed || 1, attrs: { 'data-guangxuan-asset-id': item.assetId } };
    });
    return { ...context, document: { stage: context.stage, tracks: [{ attrs: { id: 'guangxuan-picture' }, clips }] }, sources, partial: true };
  }
  async function check(projectId, { range, fps = 30, signal: parentSignal, origin, deep = false } = {}) {
    validateProjectId(projectId);
    if (closed) throw failed(503, '导出体检服务正在关闭。', 'EXPORT_PREFLIGHT_CLOSED');
    if (!Number.isFinite(Number(fps)) || Number(fps) < 1 || Number(fps) > 120) throw failed(400, '导出帧率须在1至120之间。', 'EXPORT_PREFLIGHT_INVALID_FPS');
    if (range !== undefined && (!Array.isArray(range) || range.length !== 2 || !range.every(value => Number.isFinite(value) && value >= 0 && value <= 3600) || range[1] <= range[0])) throw failed(400, '导出范围须为有效的开始、结束秒数。', 'EXPORT_PREFLIGHT_INVALID_RANGE');
    const controller = new AbortController(); controllers.add(controller);
    const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
    const issues = [], checks = { rendered: false, structure: { status: 'pending', scope: 'native-document' }, media: { status: 'pending', total: 0, probed: 0 }, captions: { status: 'partial', scope: 'explicit-timing-and-boxes', finalTextPixelsChecked: false }, audio: { status: 'pending' }, deep: { enabled: deep === true, scope: 'used-source-samples', finalCompositeChecked: false, samples: [], limits: { ...LIMITS } } };
    const add = (severity, code, message, details = {}) => {
      if (issues.length >= 200) return;
      const issue = { severity, code, message };
      for (const key of ['start', 'end']) if (Number.isFinite(details[key])) issue[key] = round(Math.max(0, details[key]));
      if (ID.test(details.clipId || '')) issue.clipId = details.clipId;
      if (details.source) issue.source = display(details.source);
      issue.action = details.action || (severity === 'error' ? '修复后重新体检' : '前往检查');
      issues.push(issue);
    };
    let current, doc, revision = '', duration = 0, exportRange = range || [0, 0], clipCount = 0, captionCount = 0, sourceCount = 0;
    const finish = () => {
      const errors = issues.filter(issue => issue.severity === 'error').length, warnings = issues.filter(issue => issue.severity === 'warning').length;
      return { projectId, ok: errors === 0 && warnings === 0, canExport: errors === 0, revision, summary: { duration: round(duration), exportDuration: round(Math.max(0, exportRange[1] - exportRange[0])), range: exportRange.map(round), fps: Number(fps), clipCount, sourceCount, captionCount, errors, warnings, checkedAt: new Date().toISOString(), deep: deep === true }, issues, checks };
    };
    try {
      checkAbort(signal);
      try { current = await snapshot(projectId, origin); }
      catch { checkAbort(signal); add('error', 'NATIVE_CONTEXT_UNAVAILABLE', '无法读取当前原生工程，请先打开项目并确认工程可用。'); return finish(); }
      checkAbort(signal);
      if (current?.projectId && current.projectId !== projectId) throw failed(403, '体检工程与当前项目不匹配。', 'EXPORT_PREFLIGHT_PROJECT_MISMATCH');
      doc = current?.document || current?.doc || current?.film?.doc; revision = typeof current?.revision === 'string' ? current.revision.replace(/[^A-Za-z0-9_:-]/g, '').slice(0, 128) : '';
      if (!doc || !Array.isArray(doc.tracks)) { add('error', 'NATIVE_DOCUMENT_INVALID', '原生时间线结构无法读取，请在编辑器中修复工程。'); return finish(); }
      if (current.partial) { checks.structure.scope = 'main-track-summary'; add('warning', 'PARTIAL_TIMELINE', '本次只能读取主画面轨摘要，其它原生轨道、字幕和音频仍需在编辑器检查。'); }
      const stage = doc.stage || current.stage || {}, w = Number(stage.w ?? stage.width), h = Number(stage.h ?? stage.height);
      if (!(Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0)) add('error', 'STAGE_INVALID', '工程画幅尺寸无效，请先在编辑器设置画幅。');
      else { checks.structure.stage = { width: w, height: h }; if (w % 2 || h % 2) add('warning', 'ODD_STAGE_DIMENSIONS', '画幅含奇数像素边长，部分视频编码器可能调整尺寸，请检查导出画幅。'); if (Math.max(w, h) > 4096) add('warning', 'LARGE_STAGE', '画幅超过4K，导出会使用较多内存，请确认输出尺寸。'); }
      const runtime = await binaries(); checkAbort(signal);
      const nativeRuntime = current.runtime || (typeof openFilm.status === 'function' ? await openFilm.status() : {});
      const ready = runtime.exportReady ?? nativeRuntime?.available;
      checks.runtime = { exportAvailable: ready !== false && Boolean(runtime.ffmpeg) && runtime.browser, ffmpegAvailable: Boolean(runtime.ffmpeg), ffprobeAvailable: Boolean(runtime.ffprobe), browserAvailable: runtime.browser };
      if (ready === false || !runtime.ffmpeg) add('error', 'EXPORT_RUNTIME_UNAVAILABLE', '当前导出运行时不可用，请恢复本地视频运行时后重新体检。');
      if (!runtime.browser) add('error', 'EXPORT_BROWSER_UNAVAILABLE', '未找到导出画面所需的本地浏览器，请恢复浏览器运行时后重试。');
      if (!runtime.ffprobe) add('warning', 'MEDIA_PROBE_UNAVAILABLE', '本地媒体信息检测程序不可用，暂不能核实源素材时长和音轨。');
      const declared = Array.isArray(current.sources) ? current.sources : [], sourceMap = new Map(declared.map(item => [item.src || item.source || item.sourceId, item]));
      const assets = new Map((Array.isArray(current.assets) ? current.assets : []).map(asset => [asset.id, asset]));
      const references = new Map(), rows = [], captions = [], captionTracks = [];
      let nativeCount = 0;
      for (const [trackIndex, track] of doc.tracks.entries()) {
        if (track.hidden) continue;
        if (track.captions?.src) captionTracks.push({ trackIndex, src: track.captions.src });
        for (const clip of Array.isArray(track.clips) ? track.clips : []) {
          if (clip.disabled) continue;
          if (++nativeCount > LIMITS.maxClips) { add('error', 'TIMELINE_LIMIT', '工程片段数量超过本次体检上限，请分段检查后导出。'); break; }
          const src = clip.src, source = sourceMap.get(src) || {}, assetId = source.assetId || clip.attrs?.['data-guangxuan-asset-id'], asset = assets.get(assetId) || {};
          const caption = clip.attrs?.['data-guangxuan-caption'] === 'true' || /caption|subtitle/i.test(track.attrs?.id || '');
          const row = { clip, track, trackIndex, src, caption, kind: kindOf(clip), assetId, name: display(source.name || asset.name || src), declared: source };
          rows.push(row); if (caption) captions.push(row);
          if (!references.has(src)) references.set(src, { src, assetId, name: row.name, declared: source, asset, rows: [] });
          references.get(src).rows.push(row);
        }
      }
      for (const item of captionTracks) if (!references.has(item.src)) references.set(item.src, { src: item.src, name: display(item.src, '字幕文件'), declared: sourceMap.get(item.src) || {}, asset: {}, rows: [], vtt: true });
      clipCount = rows.length; captionCount = captions.length; sourceCount = references.size; checks.media.total = sourceCount;
      if (!rows.length) add('error', 'EMPTY_TIMELINE', '时间线上没有启用的片段，请先加入画面或音频。');
      const dataRoot = await realpath(dataDir).catch(() => path.resolve(dataDir)), probeDeadline = Date.now() + LIMITS.probeBudgetMs;
      for (const ref of references.values()) {
        checkAbort(signal);
        const source = ref.declared;
        if (source.exists === false || source.readable === false) { ref.missing = true; add('error', 'SOURCE_MISSING', `素材“${ref.name}”缺失或不可读取，请重新链接素材。`, { clipId: ref.rows[0]?.clip.id, source: ref.name }); continue; }
        if (typeof ref.src !== 'string' || /^(?:[a-z][a-z0-9+.-]*:|[\\/])/i.test(ref.src) || ref.src.split(/[\\/]/).some(part => part === '..')) { ref.missing = true; add('error', 'SOURCE_OUTSIDE_PROJECT', '时间线包含项目范围外的素材，请先将其收集到项目。', { clipId: ref.rows[0]?.clip.id, source: ref.name }); continue; }
        try {
          if (source.controlled === true && typeof (source.path || source.filename) === 'string') {
            const actual = await realpath(source.path || source.filename);
            if (!inside(dataRoot, actual)) throw Error('uncontrolled'); ref.path = actual;
          } else if (ref.assetId && typeof videoService?.resolveAsset === 'function') {
            const resolved = await videoService.resolveAsset(ref.assetId); checkAbort(signal); ref.asset = { ...ref.asset, ...resolved }; ref.path = resolved.path;
          }
          if (ref.path) { const info = await stat(ref.path); if (!info.isFile() || !info.size) throw Error('unreadable'); await access(ref.path, constants.R_OK); }
          else if (source.exists !== true || source.readable !== true) { add('warning', 'SOURCE_NOT_VERIFIED', `暂不能核实素材“${ref.name}”的本地文件，请在编辑器确认可播放。`, { source: ref.name, clipId: ref.rows[0]?.clip.id }); }
        } catch { checkAbort(signal); ref.missing = true; add('error', 'SOURCE_MISSING', `素材“${ref.name}”缺失或不可读取，请重新链接素材。`, { source: ref.name, clipId: ref.rows[0]?.clip.id }); continue; }
        ref.meta = { duration: Number(ref.asset.duration || source.duration) || 0, hasAudio: typeof ref.asset.hasAudio === 'boolean' ? ref.asset.hasAudio : undefined, width: Number(ref.asset.width || 0), height: Number(ref.asset.height || 0) };
        if (ref.path && runtime.ffprobe && ref.rows.some(row => ['video', 'sound', 'still'].includes(row.kind)) && checks.media.probed < LIMITS.maxProbes && Date.now() < probeDeadline) {
          try {
            const result = await processRun(runtime.ffprobe, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries', 'format=duration,format_name:stream=codec_type,width,height,duration:stream_disposition=attached_pic', '-of', 'json', ref.path], { signal, children, timeoutMs: Math.min(5000, probeDeadline - Date.now()) });
            const probe = JSON.parse(result.stdout), streams = Array.isArray(probe.streams) ? probe.streams : [], video = streams.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
            if (/hls|dash|concat/i.test(probe.format?.format_name || '')) throw Error('playlist');
            ref.meta = { duration: Number(probe.format?.duration) || Math.max(0, ...streams.map(stream => Number(stream.duration) || 0)) || ref.meta.duration, hasAudio: streams.some(stream => stream.codec_type === 'audio'), hasVideo: Boolean(video), width: Number(video?.width || 0), height: Number(video?.height || 0) };
            checks.media.probed += 1; ref.probed = true;
          } catch (error) { checkAbort(signal); if (error.code === 'PREFLIGHT_PROCESS_TIMEOUT') add('warning', 'MEDIA_PROBE_TIMEOUT', `素材“${ref.name}”的信息检测超时，请确认文件可播放。`, { source: ref.name, clipId: ref.rows[0]?.clip.id }); else { ref.missing = true; add('error', 'MEDIA_UNREADABLE', `素材“${ref.name}”无法读取为有效媒体，请重新导入或转码。`, { source: ref.name, clipId: ref.rows[0]?.clip.id }); } }
        }
        for (const row of ref.rows) row.ref = ref;
      }
      checks.media.status = issues.some(issue => ['SOURCE_MISSING', 'SOURCE_OUTSIDE_PROJECT', 'MEDIA_UNREADABLE'].includes(issue.code)) ? 'failed' : 'checked';
      const probeEligible = [...references.values()].filter(ref => ref.path && ref.rows.some(row => ['video', 'sound', 'still'].includes(row.kind)) && !ref.missing).length;
      if (runtime.ffprobe && checks.media.probed < probeEligible) add('warning', 'MEDIA_PROBE_PARTIAL', `已在快速检查预算内核实 ${checks.media.probed} 个媒体文件，其余素材仍需在编辑器确认。`);
      for (const row of rows) {
        const { clip, ref, kind } = row;
        if (!kind || !Number.isFinite(clip.at ?? 0) || (clip.at ?? 0) < 0 || typeof clip.id !== 'string' || !clip.id) { add('error', 'CLIP_TIMING_INVALID', '有片段编号、类型或时间位置无效，请在编辑器修复。', { clipId: clip.id, source: row.name }); continue; }
        try {
          const native = ref?.meta?.duration || row.declared.duration;
          const span = clipSpan(clip, native);
          if (![span.from, span.to, span.length, span.speed].every(Number.isFinite) || span.length <= 0 || span.speed <= 0) throw Error('invalid span');
          Object.assign(row, { start: clip.at ?? 0, end: (clip.at ?? 0) + span.length, from: span.from, to: span.to, speed: span.speed }); duration = Math.max(duration, row.end);
        } catch { add('error', ref?.meta?.duration > 0 ? 'MEDIA_TRIM_OUT_OF_BOUNDS' : 'CLIP_DURATION_UNKNOWN', ref?.meta?.duration > 0 ? `片段“${row.name}”的源入点或出点超出素材时长。` : `片段“${row.name}”尚无有效时长，请设置明确出入点。`, { clipId: clip.id, source: row.name, start: Number(clip.at) || 0 }); }
      }
      duration = round(duration); exportRange = range || [0, duration]; checks.structure.status = issues.some(issue => issue.severity === 'error' && /TIMELINE|CLIP_|TRIM/.test(issue.code)) ? 'failed' : 'checked'; checks.structure.trackCount = doc.tracks.length;
      if (range && (range[1] > duration + .04 || range[0] >= duration)) add('error', 'EXPORT_RANGE_OUTSIDE_TIMELINE', '导出范围超出当前时间线，请调整结束时间后重试。', { start: range[0], end: range[1] });
      const pictures = rows.filter(row => Number.isFinite(row.end) && !row.caption && row.kind !== 'sound'), pictureEnd = Math.max(0, ...pictures.map(row => row.end));
      if (duration > 0) for (const [start, end] of gaps(pictures.map(row => [row.start, row.end]), exportRange[0], exportRange[1], Math.max(.04, 1 / Number(fps)))) add('warning', 'TIMELINE_GAP', '此区间没有画面片段覆盖；如为有意留白，可继续导出。', { start, end, action: '检查留白区间' });
      for (const row of captions) {
        const details = { start: row.start, end: row.end, clipId: row.clip.id, source: row.name };
        if (pictureEnd > 0 && row.end > pictureEnd + .04) add('warning', 'CAPTION_AFTER_PICTURE', '字幕延伸到最后一个画面片段之后，请检查片尾字幕时长。', details);
        const box = row.clip.box;
        if (box && [box.x, box.y, box.w, box.h, w, h].every(Number.isFinite) && box.w > 0 && box.h > 0) {
          if (box.x < 0 || box.y < 0 || box.x + box.w > w || box.y + box.h > h) add('warning', 'CAPTION_OUTSIDE_STAGE', '字幕的显式画框超出画幅，部分文字可能被裁切。', details);
          else if ((box.w < w * .95 || box.h < h * .95) && (box.x < w * .05 || box.y < h * .05 || box.x + box.w > w * .95 || box.y + box.h > h * .95)) add('warning', 'CAPTION_SAFE_MARGIN', '字幕的显式画框靠近画幅边缘，请检查安全边距。', details);
        }
      }
      for (const item of captionTracks) {
        const ref = references.get(item.src); if (!ref?.path || ref.missing) continue;
        try {
          if ((await stat(ref.path)).size > 2 * 1024 * 1024) throw Error('oversize');
          const cues = vttCues(await readFile(ref.path, 'utf8')); captionCount += cues.length;
          for (const cue of cues) {
            if (cue.end <= cue.start) add('warning', 'CAPTION_TIMING_INVALID', 'WebVTT字幕的结束时间没有晚于开始时间。', { ...cue, source: ref.name });
            if (pictureEnd > 0 && cue.end > pictureEnd + .04) add('warning', 'CAPTION_AFTER_PICTURE', 'WebVTT字幕延伸到最后一个画面片段之后。', { ...cue, source: ref.name });
            const position = /\bposition:(-?[\d.]+)%/.exec(cue.settings), size = /\bsize:(-?[\d.]+)%/.exec(cue.settings);
            if (position && (Number(position[1]) < 0 || Number(position[1]) > 100) || size && (Number(size[1]) <= 0 || Number(size[1]) > 100)) add('warning', 'CAPTION_POSITION_INVALID', 'WebVTT字幕的位置或宽度超出有效百分比范围。', { ...cue, source: ref.name });
          }
        } catch { checkAbort(signal); add('warning', 'CAPTION_FILE_UNVERIFIED', '字幕文件暂时无法解析，需在编辑器检查字幕时序。', { source: ref.name }); }
      }
      checks.captions.count = captionCount;
      const audioCandidates = rows.filter(row => Number.isFinite(row.end) && (row.kind === 'sound' || row.ref?.meta?.hasAudio === true));
      const audible = audioCandidates.filter(row => !row.track.muted && row.clip.volume !== 0), unknownAudio = rows.some(row => row.kind === 'page' || row.kind === 'video' && row.ref?.meta?.hasAudio === undefined);
      checks.audio = { status: 'structural', audibleClipCount: audible.length, waveformMeasured: false, sourceSilenceMeasured: false, mixedOutputMeasured: false };
      if (!audible.length && audioCandidates.length) add('warning', 'ALL_AUDIO_MUTED', '有音轨的片段均已静音；如要导出无声视频，可继续。');
      else if (!audible.length && !unknownAudio && rows.length) add('warning', 'NO_AUDIO', '未发现可发声的音轨；如为无声视频，可继续。');
      else if (audible.length && pictureEnd > 0) for (const [start, end] of gaps(audible.map(row => [row.start, row.end]), exportRange[0], Math.min(exportRange[1], pictureEnd), 2)) add('warning', 'AUDIO_GAP', '此区间没有已知的可发声音轨，可能出现静音。', { start, end });
      for (const row of audible) if (Number(row.clip.volume) > 1.5) add('warning', 'HIGH_AUDIO_GAIN', '片段音量增益较高，可能削波，请试听确认。', { start: row.start, end: row.end, clipId: row.clip.id, source: row.name });
      if (deep === true && runtime.ffmpeg) {
        const deadline = Date.now() + LIMITS.deepBudgetMs, seen = new Set(); let sampledSeconds = 0;
        for (const row of rows) {
          checkAbort(signal);
          if (!row.ref?.path || row.ref.missing || !['video', 'sound'].includes(row.kind) || !Number.isFinite(row.end)) continue;
          const overlapStart = Math.max(row.start, exportRange[0]), overlapEnd = Math.min(row.end, exportRange[1]); if (overlapEnd <= overlapStart) continue;
          if (checks.deep.samples.length >= LIMITS.maxDeepSamples || sampledSeconds >= LIMITS.maxDeepSeconds || Date.now() >= deadline) break;
          const from = row.from + (overlapStart - row.start) * row.speed, available = (overlapEnd - overlapStart) * row.speed;
          const seconds = Math.min(available, LIMITS.maxSampleSeconds, LIMITS.maxDeepSeconds - sampledSeconds), key = `${row.src}:${round(from)}:${round(seconds)}`;
          if (seen.has(key) || seconds < .25) continue; seen.add(key);
          const video = row.kind === 'video' && row.ref.meta?.hasVideo !== false, audio = row.ref.meta?.hasAudio === true && !row.track.muted && row.clip.volume !== 0;
          if (!video && !audio) continue;
          const sample = { source: row.name, clipId: row.clip.id, sourceStart: round(from), sourceEnd: round(from + seconds), start: round(overlapStart), end: round(overlapStart + seconds / row.speed), status: 'checked' };
          const args = ['-hide_banner', '-nostdin', '-v', 'info', '-protocol_whitelist', 'file,pipe', '-ss', String(round(from)), '-i', row.ref.path, '-t', String(round(seconds)), '-map', ...(video ? ['0:v:0?'] : ['0:a:0?']), ...(video && audio ? ['-map', '0:a:0?'] : []), ...(video ? ['-vf', 'scale=320:-2,blackdetect=d=0.25:pix_th=0.10:pic_th=0.98'] : []), ...(audio ? ['-af', 'silencedetect=noise=-50dB:d=0.4'] : []), ...(audio ? [] : ['-an']), '-threads', '1', '-f', 'null', '-'];
          try {
            const result = await processRun(runtime.ffmpeg, args, { signal, children, timeoutMs: Math.min(15000, deadline - Date.now()) }), found = detections(result.stderr, seconds);
            if (audio) checks.audio.sourceSilenceMeasured = true;
            for (const [kind, intervals] of Object.entries(found)) for (const [start, end] of intervals) add('warning', kind === 'black' ? 'SOURCE_BLACK_DETECTED' : 'SOURCE_SILENCE_DETECTED', kind === 'black' ? '所用源片段含近黑画面，可能是有意黑场；请结合最终画面确认。' : '所用源片段的音轨检测到静音；其它音轨可能覆盖此区间。', { start: row.start + (from + start - row.from) / row.speed, end: row.start + (from + end - row.from) / row.speed, clipId: row.clip.id, source: row.name });
          } catch (error) { checkAbort(signal); sample.status = 'unverified'; add('warning', 'DEEP_SAMPLE_UNVERIFIED', '一个源片段未能在采样预算内完成检测，请在编辑器试听预览。', { clipId: row.clip.id, source: row.name, start: overlapStart, end: sample.end }); }
          checks.deep.samples.push(sample); sampledSeconds += seconds;
        }
        checks.deep.sampledSourceSeconds = round(sampledSeconds); checks.deep.note = '仅检测所用源素材片段的有限采样，不包含叠加、字幕、转场或最终混音；没有渲染最终合成全片。';
      } else checks.deep.note = '快速检查只核对结构和媒体信息，没有检测黑场、波形或最终合成画面。';
      checkAbort(signal);
      try {
        const after = await snapshot(projectId, origin); checkAbort(signal);
        const afterRevision = typeof after?.revision === 'string' ? after.revision.replace(/[^A-Za-z0-9_:-]/g, '').slice(0, 128) : '';
        checks.revision = { stable: !revision || !afterRevision || revision === afterRevision };
        if (!checks.revision.stable) add('error', 'PROJECT_CHANGED_DURING_CHECK', '体检期间工程已修改，请重新体检当前版本。', { action: '重新体检' });
      } catch { checkAbort(signal); add('warning', 'REVISION_NOT_RECHECKED', '暂时无法复核工程版本，请确认体检后没有继续修改。'); }
      return finish();
    } finally { controllers.delete(controller); }
  }
  const json = (res, status, value) => { const body = JSON.stringify(value); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) }); res.end(body); };
  async function handler(req, res, url, options = {}) {
    const match = /^\/api\/projects\/([A-Za-z0-9_-]+)\/export-preflight$/.exec(url.pathname); if (!match) return false;
    const controller = new AbortController(), aborted = () => controller.abort(), disconnected = () => { if (!res.writableEnded) controller.abort(); };
    req.once('aborted', aborted); res.once('close', disconnected);
    try {
      if (!['GET', 'POST'].includes(req.method)) throw failed(405, '体检操作不支持该请求方法。', 'EXPORT_PREFLIGHT_METHOD');
      let body = options.body;
      if (req.method === 'POST' && body === undefined) {
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 16384) throw failed(413, '体检选项过大。', 'EXPORT_PREFLIGHT_INPUT_LIMIT'); chunks.push(chunk); }
        try { body = size ? JSON.parse(Buffer.concat(chunks).toString()) : {}; } catch { throw failed(400, '体检选项不是有效JSON。', 'EXPORT_PREFLIGHT_INVALID_OPTIONS'); }
      }
      body ||= {};
      if (typeof body !== 'object' || Array.isArray(body)) throw failed(400, '体检选项格式不正确。', 'EXPORT_PREFLIGHT_INVALID_OPTIONS');
      const result = await check(match[1], { range: body.range, fps: body.fps, deep: body.deep === true, origin: options.origin || url.origin, signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal });
      if (!res.destroyed) json(res, 200, result); return true;
    } catch (error) { if (!res.destroyed) json(res, error instanceof AppError ? error.status : 500, { error: error instanceof AppError ? error.message : '本次导出体检未完成，请重新打开项目后重试。', code: error instanceof AppError ? error.code : 'EXPORT_PREFLIGHT_FAILED' }); return true; }
    finally { req.removeListener('aborted', aborted); res.removeListener('close', disconnected); }
  }
  return { check, handler, handle: handler, limits: { ...LIMITS }, async close() { closed = true; for (const controller of controllers) controller.abort(); for (const child of children) child.kill(); } };
}
