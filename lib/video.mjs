import path from 'node:path';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, copyFile, mkdir, readFile, realpath, rename, stat, writeFile, unlink, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { AppError } from './errors.mjs';

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.mpg', '.mpeg', '.ts', '.mts', '.m2ts', '.ogv']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.aiff', '.aif', '.wma']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp']);
const MIME = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.bmp': 'image/bmp' };
const MAX_BODY = 30 * 1024 * 1024;
const MAX_UPLOAD = 2 * 1024 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 180000;
const ID_PATTERN = /^[a-zA-Z0-9_-]{12,80}$/;

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}

async function readJson(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw new AppError(415, '请使用JSON请求。', 'CONTENT_TYPE_REQUIRED');
  if (Number(req.headers['content-length']) > MAX_BODY) { req.resume(); throw new AppError(413, '请求内容超过30MB限制。', 'REQUEST_TOO_LARGE'); }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new AppError(413, '请求内容超过30MB限制。', 'REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AppError(400, '请求不是有效JSON。', 'INVALID_JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError(400, '请求需要是一个对象。', 'INVALID_BODY');
  return body;
}

async function receiveUpload(req, filename) {
  const declaredSize = Number(req.headers['content-length']);
  if (Number.isFinite(declaredSize) && declaredSize > MAX_UPLOAD) {
    req.resume();
    throw new AppError(413, '单个上传素材不能超过2GB。', 'MEDIA_UPLOAD_TOO_LARGE');
  }
  let size = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > MAX_UPLOAD) callback(new AppError(413, '单个上传素材不能超过2GB。', 'MEDIA_UPLOAD_TOO_LARGE'));
      else callback(null, chunk);
    },
  });
  // The IncomingMessage is deliberately outside pipeline: rejecting a file
  // must still allow the HTTP layer to return a small, safe JSON error.
  const destination = createWriteStream(filename, { flags: 'wx', mode: 0o600 });
  const timer = setTimeout(() => limiter.destroy(new AppError(408, '素材上传超时，请重试或选择较小文件。', 'MEDIA_UPLOAD_TIMEOUT')), UPLOAD_TIMEOUT_MS);
  timer.unref();
  req.once('aborted', () => limiter.destroy(new AppError(499, '素材上传已取消。', 'MEDIA_UPLOAD_CANCELLED')));
  req.once('error', () => limiter.destroy(new AppError(400, '素材上传中断，请重试。', 'MEDIA_UPLOAD_INTERRUPTED')));
  try {
    const completion = pipeline(limiter, destination);
    req.pipe(limiter);
    await completion;
    if (!size) throw new AppError(400, '上传文件为空。', 'EMPTY_MEDIA_UPLOAD');
    return size;
  } catch (error) {
    req.unpipe(limiter);
    req.resume();
    throw error instanceof AppError ? error : new AppError(500, '无法保存上传素材，请检查本机可用空间后重试。', 'MEDIA_UPLOAD_WRITE_FAILED');
  } finally {
    clearTimeout(timer);
    req.unpipe(limiter);
  }
}

function number(value, fallback, label, min, max) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new AppError(400, `${label}不在有效范围内。`, 'INVALID_VIDEO_ARGUMENT');
  return parsed;
}

function runProcess(binary, args, { cwd, timeoutMs = 30000, onOutput, children, signal, capture = true } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let timedOut = false;
    let stdout = '';
    let stderr = '';
    try { child = spawn(binary, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { reject(new AppError(503, '无法启动媒体处理程序。', 'MEDIA_RUNTIME_UNAVAILABLE')); return; }
    children?.add(child);
    const abort = () => child.kill();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    timer.unref();
    function done(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      children?.delete(child);
      error ? reject(error) : resolve({ stdout, stderr });
    }
    child.stdout.on('data', chunk => {
      const text = chunk.toString();
      if (capture) {
        stdout += text;
        if (stdout.length > 4 * 1024 * 1024) { child.kill(); done(new AppError(502, '媒体信息响应过大。', 'MEDIA_METADATA_TOO_LARGE')); }
      }
      onOutput?.(text);
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-32000); });
    child.on('error', () => done(new AppError(503, '未找到或无法启动FFmpeg/FFprobe，请检查媒体运行时。', 'MEDIA_RUNTIME_UNAVAILABLE')));
    child.on('close', code => {
      if (signal?.aborted) return done(new AppError(499, '媒体操作已取消。', 'MEDIA_CANCELLED'));
      if (timedOut) return done(new AppError(504, '媒体处理超时，请尝试更短的素材。', 'MEDIA_TIMEOUT'));
      if (code !== 0) {
        const error = new AppError(422, '媒体处理失败，请检查文件能否播放、编码格式及可用磁盘空间。', 'MEDIA_PROCESS_FAILED');
        error.diagnostic = stderr;
        return done(error);
      }
      done();
    });
  });
}

async function findBinary(name, explicit, root) {
  const filename = `${name}${process.platform === 'win32' ? '.exe' : ''}`;
  const candidates = [explicit, process.env[`GUANGXUAN_${name.toUpperCase()}`], process.env.GUANGXUAN_BIN_DIR && path.join(process.env.GUANGXUAN_BIN_DIR, filename), root && path.join(root, 'bin', filename), process.resourcesPath && path.join(process.resourcesPath, 'bin', filename), name].filter(Boolean);
  for (const candidate of [...new Set(candidates)]) {
    try {
      const result = await runProcess(candidate, ['-version'], { timeoutMs: 10000 });
      return { path: candidate, version: result.stdout.split(/\r?\n/)[0].slice(0, 200) };
    } catch { /* A different configured or bundled location may be available. */ }
  }
  return null;
}

function publicAsset(asset) {
  return {
    id: asset.id, name: asset.name, type: asset.type, duration: asset.duration,
    width: asset.width || 0, height: asset.height || 0, hasAudio: asset.hasAudio,
    url: `/api/video/media/${asset.id}`, createdAt: asset.createdAt,
    generated: Boolean(asset.generated), ...(asset.generatedType ? { generatedType: asset.generatedType } : {}),
    ...(asset.prompt ? { prompt: asset.prompt } : {}), ...(asset.model ? { model: asset.model } : {}),
    ...(asset.plan ? { plan: asset.plan } : {}),
  };
}

function assTime(seconds) {
  const centiseconds = Math.max(0, Math.round(seconds * 100));
  return `${Math.floor(centiseconds / 360000)}:${String(Math.floor(centiseconds / 6000) % 60).padStart(2, '0')}:${String(Math.floor(centiseconds / 100) % 60).padStart(2, '0')}.${String(centiseconds % 100).padStart(2, '0')}`;
}

// ASS override syntax is never accepted from user text. Visible full-width
// equivalents preserve punctuation without allowing positioning/style commands.
function escapeAss(text) {
  return text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0B-\x1F]/g, '')
    .replace(/\\/g, '＼').replace(/\{/g, '｛').replace(/\}/g, '｝').replace(/\n/g, '\\N');
}

function makeAss(captions, width, height) {
  const size = Math.round(Math.min(width, height) * 0.047);
  const margin = Math.round(width * 0.07);
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\nStyle: Default,Microsoft YaHei,${size},&H00FFFFFF,&H000000FF,&H00101010,&H80000000,-1,0,0,0,100,100,0,0,1,2,1,2,${margin},${margin},${Math.round(height * 0.07)},1\n\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n${captions.map(caption => `Dialogue: 0,${assTime(caption.start)},${assTime(caption.end)},Default,,0,0,0,,${escapeAss(caption.text)}`).join('\n')}\n`;
}

async function streamFile(req, res, filename, { downloadName } = {}) {
  let info;
  try { info = await stat(filename); } catch { throw new AppError(404, '媒体文件已移动或删除，请重新导入。', 'MEDIA_FILE_MISSING'); }
  if (!info.isFile()) throw new AppError(404, '媒体文件不存在。', 'MEDIA_FILE_MISSING');
  let start = 0;
  let end = info.size - 1;
  let partial = false;
  const headers = { 'Content-Type': MIME[path.extname(filename).toLowerCase()] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store' };
  if (downloadName) headers['Content-Disposition'] = `attachment; filename="guangxuan-video.mp4"; filename*=UTF-8''${encodeURIComponent(downloadName)}`;
  if (req.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!match || (!match[1] && !match[2])) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${info.size}`, 'Content-Length': 0 }); res.end(); return;
    }
    if (!match[1]) {
      const suffix = Number(match[2]);
      start = Math.max(0, info.size - suffix);
      if (suffix < 1) start = info.size;
    } else {
      start = Number(match[1]);
      end = match[2] ? Math.min(Number(match[2]), end) : end;
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= info.size) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${info.size}`, 'Content-Length': 0 }); res.end(); return;
    }
    partial = true;
    headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
  }
  headers['Content-Length'] = Math.max(0, end - start + 1);
  res.writeHead(partial ? 206 : 200, headers);
  if (req.method === 'HEAD' || !info.size) { res.end(); return; }
  try { await pipeline(createReadStream(filename, { start, end }), res); }
  catch { if (!res.destroyed) res.destroy(); }
}

export async function createVideoService({ dataDir, root, ffmpegPath, ffprobePath } = {}) {
  if (!dataDir) throw new AppError(500, '媒体数据目录未配置。', 'VIDEO_DATA_DIR_REQUIRED');
  const videoRoot = path.resolve(dataDir, 'video');
  const mediaRoot = path.join(videoRoot, 'generated');
  const importsRoot = path.resolve(dataDir, 'media', 'imports');
  const exportsRoot = path.join(videoRoot, 'exports');
  const jobsRoot = path.join(videoRoot, 'jobs');
  await Promise.all([mkdir(mediaRoot, { recursive: true }), mkdir(importsRoot, { recursive: true }), mkdir(exportsRoot, { recursive: true }), mkdir(jobsRoot, { recursive: true })]);
  const [ffmpeg, ffprobe] = await Promise.all([findBinary('ffmpeg', ffmpegPath, root), findBinary('ffprobe', ffprobePath, root)]);
  const catalogPath = path.join(videoRoot, 'catalog.json');
  let catalog = { version: 1, assets: [], exports: [] };
  try {
    const parsed = JSON.parse(await readFile(catalogPath, 'utf8'));
    if (Array.isArray(parsed.assets) && Array.isArray(parsed.exports)) catalog = parsed;
  } catch (error) { if (error.code !== 'ENOENT') throw new AppError(500, '媒体索引无法读取，请保留原文件并检查数据目录。', 'VIDEO_CATALOG_INVALID'); }
  const assets = new Map(catalog.assets.filter(asset => ID_PATTERN.test(asset.id)).map(asset => [asset.id, asset]));
  const exports = new Map(catalog.exports.filter(item => ID_PATTERN.test(item.id)).map(item => [item.id, item]));
  const jobs = new Map([...exports.values()].filter(item => item.jobId).map(item => [item.jobId, { id: item.jobId, status: 'complete', progress: 1, exportId: item.id, title: item.title, duration: item.duration, width: item.width, height: item.height, ...(item.assetId && assets.has(item.assetId) ? { asset: publicAsset(assets.get(item.assetId)) } : {}) }]));
  const queue = [];
  const children = new Set();
  let persistence = Promise.resolve();
  let worker = null;
  let closing = false;
  let activeController = null;

  function persist() {
    const serialized = JSON.stringify({ version: 1, assets: [...assets.values()], exports: [...exports.values()] });
    persistence = persistence.catch(() => {}).then(async () => {
      const temporary = `${catalogPath}.tmp`;
      await writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, catalogPath);
    });
    return persistence;
  }

  function requireRuntime() {
    if (!ffprobe || !ffmpeg) throw new AppError(503, '未找到完整FFmpeg运行时。请使用含ffmpeg和ffprobe的桌面版本，或配置GUANGXUAN_BIN_DIR。', 'MEDIA_RUNTIME_UNAVAILABLE');
  }

  async function probe(filename) {
    requireRuntime();
    const { stdout } = await runProcess(ffprobe.path, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries', 'format=duration,format_name:stream=index,codec_type,width,height,duration:stream_disposition=attached_pic', '-of', 'json', filename], { children, timeoutMs: 30000 });
    try { return JSON.parse(stdout); } catch { throw new AppError(422, '无法读取媒体文件信息。', 'MEDIA_METADATA_INVALID'); }
  }

  async function registerFile(inputPath, metadata = {}) {
    requireRuntime();
    if (typeof inputPath !== 'string' || !path.isAbsolute(inputPath) || inputPath.includes('\0')) throw new AppError(400, '请选择本地媒体文件。', 'INVALID_MEDIA_PATH');
    let filename;
    let info;
    try { filename = await realpath(inputPath); info = await stat(filename); } catch { throw new AppError(404, '选择的文件无法读取。', 'MEDIA_FILE_MISSING'); }
    if (!info.isFile()) throw new AppError(400, '请选择文件，不要选择目录。', 'INVALID_MEDIA_FILE');
    const extension = path.extname(filename).toLowerCase();
    if (![VIDEO_EXTENSIONS, AUDIO_EXTENSIONS, IMAGE_EXTENSIONS].some(group => group.has(extension))) throw new AppError(415, '此格式暂不支持，请导入常见视频、音频或PNG/JPEG/WebP图片。', 'UNSUPPORTED_MEDIA');
    const old = [...assets.values()].find(asset => asset.path === filename && asset.size === info.size && asset.mtimeMs === info.mtimeMs);
    if (old && !metadata.generated) return old;
    const details = await probe(filename);
    const streams = Array.isArray(details.streams) ? details.streams : [];
    const visual = streams.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
    const audio = streams.find(stream => stream.codec_type === 'audio');
    const type = IMAGE_EXTENSIONS.has(extension) && visual ? 'image' : visual ? 'video' : audio ? 'audio' : null;
    if (!type) throw new AppError(415, '文件中没有可用的视频、图片或音频流。', 'UNSUPPORTED_MEDIA');
    if (/hls|dash|concat/i.test(details.format?.format_name || '')) throw new AppError(415, '请导入本地单个媒体文件，暂不支持播放列表。', 'UNSUPPORTED_MEDIA');
    const duration = type === 'image' ? 4 : Number(details.format?.duration || visual?.duration || audio?.duration);
    if (!Number.isFinite(duration) || duration <= 0) throw new AppError(422, '无法确定素材时长，请转换为常见格式后重试。', 'INVALID_MEDIA_DURATION');
    if (visual && (!Number.isFinite(visual.width) || !Number.isFinite(visual.height) || visual.width < 1 || visual.height < 1 || visual.width * visual.height > 100000000)) throw new AppError(415, '图片或视频尺寸无效或过大。', 'INVALID_MEDIA_DIMENSIONS');
    const asset = {
      id: randomUUID(), name: String(metadata.name || path.basename(filename)).slice(0, 240), type, duration,
      width: visual?.width || 0, height: visual?.height || 0, hasAudio: Boolean(audio),
      path: filename, size: info.size, mtimeMs: info.mtimeMs, createdAt: new Date().toISOString(),
      generated: Boolean(metadata.generated), ...(metadata.generatedType ? { generatedType: metadata.generatedType } : {}),
      ...(metadata.prompt ? { prompt: String(metadata.prompt).slice(0, 12000) } : {}),
      ...(metadata.model ? { model: String(metadata.model).slice(0, 300) } : {}),
      ...(metadata.plan ? { plan: metadata.plan } : {}),
    };
    assets.set(asset.id, asset);
    await persist();
    return asset;
  }

  function getAsset(id) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id) || !assets.has(id)) throw new AppError(404, '素材不存在，请重新导入。', 'MEDIA_NOT_FOUND');
    return assets.get(id);
  }

  async function unchanged(asset) {
    let info;
    try { info = await stat(asset.path); } catch { throw new AppError(404, '素材已移动或删除，请重新导入。', 'MEDIA_FILE_MISSING'); }
    if (info.size !== asset.size || Math.abs(info.mtimeMs - asset.mtimeMs) > 1) throw new AppError(409, '素材文件已变化，请重新导入后再导出。', 'MEDIA_FILE_CHANGED');
  }

  function validateExport(body) {
    requireRuntime();
    if (!Array.isArray(body.timeline) || !body.timeline.length || body.timeline.length > 200) throw new AppError(400, '时间线需要1至200个视频或图片片段。', 'INVALID_TIMELINE');
    const timeline = body.timeline.map((clip, index) => {
      const asset = getAsset(clip?.assetId);
      if (asset.type === 'audio') throw new AppError(400, '音频素材请添加到配乐轨道。', 'INVALID_TIMELINE_MEDIA');
      const start = number(clip.start, 0, '入点', 0, 86400);
      const end = number(clip.end, asset.duration, '出点', 0, 86400);
      if (end - start < 0.04 || (asset.type !== 'image' && end > asset.duration + 0.05)) throw new AppError(400, '片段出入点超出素材时长或片段过短。', 'INVALID_CLIP_RANGE');
      return { id: String(clip.id || `clip-${index + 1}`).slice(0, 100), asset, start, end, duration: end - start };
    });
    const duration = timeline.reduce((total, clip) => total + clip.duration, 0);
    if (duration > 3600) throw new AppError(400, '本版单次导出支持不超过60分钟的时间线。', 'TIMELINE_TOO_LONG');
    const aspect = body.aspect || '16:9';
    const resolution = String(body.resolution || '720');
    if (!['16:9', '9:16', '1:1'].includes(aspect) || !['720', '1080'].includes(resolution)) throw new AppError(400, '请选择支持的画幅和分辨率。', 'INVALID_VIDEO_SIZE');
    const short = Number(resolution);
    const long = resolution === '1080' ? 1920 : 1280;
    const [width, height] = aspect === '16:9' ? [long, short] : aspect === '9:16' ? [short, long] : [short, short];
    if (body.captions !== undefined && (!Array.isArray(body.captions) || body.captions.length > 2000)) throw new AppError(400, '字幕数量或格式不正确。', 'INVALID_CAPTIONS');
    const captions = (body.captions || []).map(caption => {
      if (!caption || typeof caption !== 'object' || Array.isArray(caption)) throw new AppError(400, '字幕条目格式不正确。', 'INVALID_CAPTION');
      const start = number(caption?.start, 0, '字幕开始时间', 0, duration);
      const end = number(caption?.end, duration, '字幕结束时间', 0, duration + 0.05);
      if (end <= start || typeof caption.text !== 'string' || !caption.text.trim() || caption.text.length > 1000) throw new AppError(400, '字幕需要有效时间和不超过1000字的文字。', 'INVALID_CAPTION');
      return { start, end: Math.min(end, duration), text: caption.text };
    });
    let music = null;
    if (body.music?.assetId) {
      const asset = getAsset(body.music.assetId);
      if (!asset.hasAudio) throw new AppError(400, '配乐素材没有可用音轨。', 'INVALID_MUSIC');
      music = { asset, volume: number(body.music.volume, 0.2, '配乐音量', 0, 1) };
    }
    return { timeline, captions, duration, width, height, aspect, resolution, music, sourceVolume: number(body.sourceVolume, 1, '原声音量', 0, 1), title: String(body.title || '光宣剪辑').slice(0, 120) };
  }

  function publicJob(job) {
    return {
      jobId: job.id, status: job.status, progress: job.progress, ...(job.error ? { error: job.error } : {}),
      ...(job.exportId ? { exportId: job.exportId, downloadUrl: `/api/video/exports/${job.exportId}/file` } : {}),
      ...(job.asset ? { asset: job.asset } : {}), ...(job.duration ? { duration: job.duration, width: job.width, height: job.height } : {}),
    };
  }

  async function encode(args, directory, duration, onProgress, signal) {
    let pending = '';
    await runProcess(ffmpeg.path, ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats', ...args], {
      cwd: directory, children, signal, timeoutMs: 30 * 60 * 1000, capture: false,
      onOutput(text) {
        pending += text;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop().slice(-2000);
        for (const line of lines) {
          const match = /^out_time_us=(\d+)$/.exec(line);
          if (match) onProgress(Math.min(1, Number(match[1]) / 1000000 / duration));
          if (line === 'progress=end') onProgress(1);
        }
      },
    });
  }

  async function subtitleFont(directory) {
    const windowsRoot = process.env.WINDIR || 'C:\\Windows';
    const candidates = [process.env.GUANGXUAN_SUBTITLE_FONT, path.join(windowsRoot, 'Fonts', 'msyh.ttc'), path.join(windowsRoot, 'Fonts', 'simhei.ttf')].filter(Boolean);
    for (const candidate of candidates) {
      try {
        await access(candidate);
        await mkdir(path.join(directory, 'fonts'), { recursive: true });
        await copyFile(candidate, path.join(directory, 'fonts', `subtitle${path.extname(candidate)}`));
        return true;
      } catch { /* libass can also use fonts installed on this system. */ }
    }
    return false;
  }

  async function completeJob(job, outputPath, asset) {
    const details = await probe(outputPath);
    const stream = details.streams?.find(item => item.codec_type === 'video');
    const item = { id: job.id, jobId: job.id, path: outputPath, title: job.title || '光宣剪辑', duration: Number(details.format?.duration), width: stream?.width || 0, height: stream?.height || 0, createdAt: new Date().toISOString(), ...(asset ? { assetId: asset.id } : {}) };
    exports.set(item.id, item);
    await persist();
    Object.assign(job, { status: 'complete', progress: 1, exportId: item.id, duration: item.duration, width: item.width, height: item.height, ...(asset ? { asset: publicAsset(asset) } : {}) });
  }

  async function renderExport(job, signal) {
    const spec = job.spec;
    for (const asset of new Set([...spec.timeline.map(clip => clip.asset), ...(spec.music ? [spec.music.asset] : [])])) await unchanged(asset);
    const directory = path.join(jobsRoot, job.id);
    await mkdir(directory, { recursive: true });
    const outputPath = path.join(exportsRoot, `${job.id}.mp4`);
    const segments = [];
    let finishedDuration = 0;
    for (let index = 0; index < spec.timeline.length; index++) {
      const clip = spec.timeline[index];
      const filename = `segment-${String(index).padStart(4, '0')}.mp4`;
      segments.push(filename);
      const input = clip.asset.type === 'image'
        ? ['-loop', '1', '-framerate', '30', '-i', clip.asset.path]
        : ['-ss', clip.start.toFixed(6), '-i', clip.asset.path];
      if (!clip.asset.hasAudio) input.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
      const filter = `scale=${spec.width}:${spec.height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${spec.width}:${spec.height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,format=yuv420p`;
      const args = [...input, '-map', '0:v:0', '-map', clip.asset.hasAudio ? '0:a:0' : '1:a:0', '-vf', filter, '-af', 'aresample=48000,apad', '-t', clip.duration.toFixed(6), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-threads', '2', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2', '-video_track_timescale', '15360', '-movflags', '+faststart', filename];
      await encode(args, directory, clip.duration, fraction => { job.progress = Math.min(0.7, (finishedDuration + fraction * clip.duration) / spec.duration * 0.7); }, signal);
      finishedDuration += clip.duration;
    }
    await writeFile(path.join(directory, 'concat.txt'), segments.map(filename => `file '${filename}'`).join('\n'), 'utf8');
    const args = ['-f', 'concat', '-safe', '1', '-i', 'concat.txt'];
    if (spec.music) args.push('-stream_loop', '-1', '-i', spec.music.asset.path);
    args.push('-map', '0:v:0');
    if (spec.music) {
      args.push('-filter_complex', `[0:a:0]volume=${spec.sourceVolume}[original];[1:a:0]aresample=48000,volume=${spec.music.volume}[music];[original][music]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95[audio]`, '-map', '[audio]');
    } else args.push('-map', '0:a:0', '-af', `volume=${spec.sourceVolume}`);
    if (spec.captions.length) {
      await writeFile(path.join(directory, 'captions.ass'), makeAss(spec.captions, spec.width, spec.height), 'utf8');
      const hasFont = await subtitleFont(directory);
      args.push('-vf', `ass=filename=captions.ass${hasFont ? ':fontsdir=fonts' : ''}`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-threads', '2');
    } else args.push('-c:v', 'copy');
    args.push('-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2', '-t', spec.duration.toFixed(6), '-movflags', '+faststart', outputPath);
    await encode(args, directory, spec.duration, fraction => { job.progress = 0.7 + fraction * 0.29; }, signal);
    await completeJob(job, outputPath);
    // Delete only this service-created intermediate directory, never original media.
    if (path.dirname(path.resolve(directory)) === jobsRoot && ID_PATTERN.test(path.basename(directory))) await rm(directory, { recursive: true, force: true }).catch(() => {});
  }

  async function renderAnimation(job, signal) {
    if (!root) throw new AppError(503, '动画运行时未配置。', 'ANIMATION_RUNTIME_UNAVAILABLE');
    const modulePath = path.join(root, 'animation', 'render.mjs');
    try { await access(modulePath); } catch { throw new AppError(503, '此版本尚未安装动画渲染运行时。', 'ANIMATION_RUNTIME_UNAVAILABLE'); }
    const module = await import(pathToFileURL(modulePath).href);
    if (typeof module.renderAnimation !== 'function') throw new AppError(503, '动画渲染运行时不完整。', 'ANIMATION_RUNTIME_UNAVAILABLE');
    const outputPath = path.join(exportsRoot, `${job.id}.mp4`);
    await module.renderAnimation({ plan: job.plan, outputPath, signal, onProgress: value => {
      const progress = typeof value === 'number' ? value : value?.progress;
      if (Number.isFinite(progress)) job.progress = Math.min(0.98, Math.max(0, progress));
    } });
    const asset = await registerFile(outputPath, { name: `${job.title || '动画画面'}.mp4`, generated: true, generatedType: 'animation', plan: job.plan, prompt: job.prompt, model: job.model });
    await completeJob(job, outputPath, asset);
  }

  function startWorker() {
    if (worker || closing) return;
    worker = (async () => {
      while (queue.length && !closing) {
        const job = queue.shift();
        job.status = 'running';
        activeController = new AbortController();
        try {
          if (job.kind === 'animation') await renderAnimation(job, activeController.signal);
          else await renderExport(job, activeController.signal);
        } catch (error) {
          job.status = 'error';
          job.error = error instanceof AppError ? error.message : job.kind === 'animation' ? String(error.message || '动画渲染未完成。').slice(0, 500) : '渲染未完成，请检查素材或动画运行时后重试。';
          job.diagnostic = error.diagnostic || String(error.message || '');
        } finally { activeController = null; delete job.spec; }
      }
    })().finally(() => { worker = null; if (queue.length && !closing) startWorker(); });
  }

  function enqueue(job) {
    if (closing) throw new AppError(503, '应用正在关闭。', 'VIDEO_SERVICE_CLOSING');
    if (queue.length >= 10) throw new AppError(429, '等待中的渲染任务较多，请稍后再试。', 'VIDEO_QUEUE_FULL');
    jobs.set(job.id, job);
    queue.push(job);
    startWorker();
    return { jobId: job.id };
  }

  async function handler(req, res, url) {
    if (!url.pathname.startsWith('/api/video/')) return false;
    const method = req.method || 'GET';
    const pathname = url.pathname;
    if (pathname === '/api/video/status' && method === 'GET') {
      json(res, 200, { ready: Boolean(ffmpeg && ffprobe), ffmpegAvailable: Boolean(ffmpeg), ffprobeAvailable: Boolean(ffprobe), ffmpegVersion: ffmpeg?.version || '', supportedAspects: ['16:9', '9:16', '1:1'], supportedResolutions: ['720', '1080'] }); return true;
    }
    if (pathname === '/api/video/assets' && method === 'GET') { json(res, 200, { assets: [...assets.values()].map(publicAsset) }); return true; }
    const mediaMatch = /^\/api\/video\/media\/([a-zA-Z0-9_-]+)$/.exec(pathname);
    if (mediaMatch && ['GET', 'HEAD'].includes(method)) { await streamFile(req, res, getAsset(mediaMatch[1]).path); return true; }
    const downloadMatch = /^\/api\/video\/exports\/([a-zA-Z0-9_-]+)\/file$/.exec(pathname);
    if (downloadMatch && ['GET', 'HEAD'].includes(method)) {
      const item = exports.get(downloadMatch[1]);
      if (!item) throw new AppError(404, '导出文件不存在或尚未完成。', 'EXPORT_NOT_FOUND');
      const safeTitle = String(item.title || '光宣剪辑').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 120);
      await streamFile(req, res, item.path, { downloadName: `${safeTitle}.mp4` }); return true;
    }
    const jobMatch = /^\/api\/video\/jobs\/([a-zA-Z0-9_-]+)$/.exec(pathname);
    if (jobMatch && method === 'GET') {
      const job = jobs.get(jobMatch[1]);
      if (!job) throw new AppError(404, '渲染任务不存在。', 'VIDEO_JOB_NOT_FOUND');
      json(res, 200, publicJob(job)); return true;
    }
    if (pathname === '/api/video/import-local' && method === 'POST') {
      const body = await readJson(req);
      if (!Array.isArray(body.paths) || !body.paths.length || body.paths.length > 50) throw new AppError(400, '每次请选择1至50个媒体文件。', 'INVALID_MEDIA_SELECTION');
      const selected = [];
      for (const filename of body.paths) selected.push(publicAsset(await registerFile(filename)));
      json(res, 200, { assets: selected }); return true;
    }
    if (pathname === '/api/video/upload' && method === 'POST') {
      try { requireRuntime(); } catch (error) { req.resume(); throw error; }
      if (!/^application\/octet-stream(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
        req.resume();
        throw new AppError(415, '上传请使用application/octet-stream二进制格式。', 'INVALID_UPLOAD_CONTENT_TYPE');
      }
      const encodedName = req.headers['x-file-name'];
      let name;
      try {
        if (typeof encodedName !== 'string' || encodedName.length > 3000) throw new Error();
        name = decodeURIComponent(encodedName);
        if (!name.trim() || name.length > 240 || /[\\/\x00-\x1F]/.test(name) || name !== path.basename(name)) throw new Error();
      } catch {
        req.resume();
        throw new AppError(400, '请提供有效的上传文件名。', 'INVALID_UPLOAD_NAME');
      }
      const extension = path.extname(name).toLowerCase();
      if (![VIDEO_EXTENSIONS, AUDIO_EXTENSIONS, IMAGE_EXTENSIONS].some(group => group.has(extension))) {
        req.resume();
        throw new AppError(415, '此媒体格式暂不支持。', 'UNSUPPORTED_MEDIA');
      }
      const filename = path.join(importsRoot, `${randomUUID()}${extension}`);
      let asset;
      try {
        await receiveUpload(req, filename);
        asset = await registerFile(filename, { name });
      } catch (error) {
        await unlink(filename).catch(() => {});
        throw error;
      }
      json(res, 200, { assets: [publicAsset(asset)] }); return true;
    }
    if (pathname === '/api/video/import-generated' && method === 'POST') {
      const body = await readJson(req);
      const extensions = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };
      const extension = extensions[body.mimeType];
      if (!extension || typeof body.dataBase64 !== 'string') throw new AppError(415, '生成图片仅支持PNG、JPEG或WebP。', 'INVALID_GENERATED_IMAGE');
      const encoded = body.dataBase64.replace(/\s/g, '');
      if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new AppError(400, '图片数据不是有效Base64。', 'INVALID_IMAGE_DATA');
      const buffer = Buffer.from(encoded, 'base64');
      if (!buffer.length || buffer.length > 20 * 1024 * 1024) throw new AppError(413, '生成图片需要小于20MB。', 'IMAGE_TOO_LARGE');
      const signatureValid = extension === '.png' ? buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) : extension === '.jpg' ? buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255 : buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP';
      if (!signatureValid) throw new AppError(415, '图片类型与内容不一致。', 'INVALID_GENERATED_IMAGE');
      requireRuntime();
      const filename = path.join(mediaRoot, `${randomUUID()}${extension}`);
      await writeFile(filename, buffer, { mode: 0o600 });
      let asset;
      try { asset = await registerFile(filename, { name: String(body.name || 'AI生成图片').slice(0, 220), generated: true, generatedType: 'image', prompt: body.prompt, model: body.model }); }
      catch (error) { await unlink(filename).catch(() => {}); throw error; }
      json(res, 200, { assets: [publicAsset(asset)] }); return true;
    }
    if (pathname === '/api/video/export' && method === 'POST') {
      const spec = validateExport(await readJson(req));
      const job = { id: randomUUID(), kind: 'export', title: spec.title, status: 'queued', progress: 0, spec };
      json(res, 202, enqueue(job)); return true;
    }
    if (pathname === '/api/video/render-animation' && method === 'POST') {
      requireRuntime();
      const body = await readJson(req);
      if (!body.plan || typeof body.plan !== 'object' || Array.isArray(body.plan) || JSON.stringify(body.plan).length > 200000) throw new AppError(400, '动画计划格式不正确或过长。', 'INVALID_ANIMATION_PLAN');
      if (!root) throw new AppError(503, '动画运行时未配置。', 'ANIMATION_RUNTIME_UNAVAILABLE');
      const schemaPath = path.join(root, 'animation', 'schema.mjs');
      try { await access(schemaPath); } catch { throw new AppError(503, '此版本尚未安装动画运行时。', 'ANIMATION_RUNTIME_UNAVAILABLE'); }
      const { validateAnimationPlan } = await import(pathToFileURL(schemaPath).href);
      let plan;
      try { plan = validateAnimationPlan(body.plan); } catch (error) { throw new AppError(400, String(error.message || '动画计划格式不正确。').slice(0, 500), 'INVALID_ANIMATION_PLAN'); }
      const job = { id: randomUUID(), kind: 'animation', title: String(plan.title || '动画画面').slice(0, 120), status: 'queued', progress: 0, plan, prompt: typeof body.prompt === 'string' ? body.prompt.slice(0, 12000) : '', model: typeof body.model === 'string' ? body.model.slice(0, 300) : '' };
      json(res, 202, enqueue(job)); return true;
    }
    throw new AppError(404, '找不到此视频操作。', 'VIDEO_ROUTE_NOT_FOUND');
  }

  return {
    handler, handle: handler,
    async close() {
      closing = true;
      for (const job of queue.splice(0)) { job.status = 'error'; job.error = '应用关闭，渲染已取消。'; }
      activeController?.abort();
      for (const child of children) child.kill();
      await worker;
      await persistence;
    },
  };
}
