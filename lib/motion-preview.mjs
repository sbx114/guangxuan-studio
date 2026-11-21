import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { AppError } from './errors.mjs';

const ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const FILE = /^frame-\d{2}\.png$/;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const fail = (status, message, code) => new AppError(status, message, code);
const stopped = () => fail(499, '分镜预览已取消。', 'MOTION_PREVIEW_CANCELLED');
const check = signal => { if (signal?.aborted) throw stopped(); };

/** Real Remotion stills share one bundle/browser per storyboard request. */
export async function createMotionPreviewService({ dataDir, root } = {}) {
  if (!dataDir || !root) throw fail(500, '分镜预览运行时未配置。', 'MOTION_PREVIEW_NOT_CONFIGURED');
  const previewRoot = path.resolve(dataDir, 'video', 'previews');
  await mkdir(previewRoot, { recursive: true });
  const realRoot = await realpath(previewRoot);
  const schema = await import(pathToFileURL(path.resolve(root, 'animation', 'schema.mjs')).href);
  const renderer = await import(pathToFileURL(path.resolve(root, 'animation', 'render.mjs')).href);
  const controllers = new Set();
  let tail = Promise.resolve(), closed = false;
  async function directory(id, create = false) {
    if (typeof id !== 'string' || !ID.test(id)) throw fail(404, '分镜预览不存在。', 'MOTION_PREVIEW_NOT_FOUND');
    const target = path.join(previewRoot, id.toLowerCase());
    if (create) await mkdir(target);
    let info, resolved;
    try { info = await lstat(target); resolved = await realpath(target); }
    catch { throw fail(404, '分镜预览不存在或已清理。', 'MOTION_PREVIEW_NOT_FOUND'); }
    const relative = path.relative(realRoot, resolved);
    if (!info.isDirectory() || info.isSymbolicLink() || !relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep)) throw fail(403, '分镜预览目录无效。', 'MOTION_PREVIEW_INVALID_STORAGE');
    return target;
  }
  async function cleanup(target) {
    const relative = path.relative(previewRoot, path.resolve(target));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !ID.test(relative)) throw fail(500, '分镜预览临时目录无效。', 'MOTION_PREVIEW_INVALID_STORAGE');
    await rm(target, { recursive: true, force: true });
  }
  function samples(plan, { sceneIndexes, times }) {
    if (sceneIndexes !== undefined && times !== undefined) throw fail(400, '逐场预览与指定时间点请只选一种。', 'MOTION_PREVIEW_INVALID_SAMPLES');
    const schedule = schema.animationSchedule(plan), length = schema.animationFrameCount(plan), duration = length / plan.fps;
    let frames;
    if (times !== undefined) {
      if (!Array.isArray(times) || !times.length || times.length > 16 || times.some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > duration)) throw fail(400, '请提供1至16个有效的绝对项目秒数。', 'MOTION_PREVIEW_INVALID_SAMPLES');
      frames = times.map(time => Math.min(length - 1, Math.round(time * plan.fps)));
    } else {
      const selected = sceneIndexes === undefined ? schedule.map(scene => scene.index) : sceneIndexes;
      if (!Array.isArray(selected) || !selected.length || selected.length > plan.scenes.length || new Set(selected).size !== selected.length || selected.some(value => !Number.isInteger(value) || value < 0 || value >= plan.scenes.length)) throw fail(400, '逐场预览索引不正确。', 'MOTION_PREVIEW_INVALID_SAMPLES');
      frames = selected.map(index => schedule[index].startFrame + Math.floor(schedule[index].durationInFrames / 2));
    }
    return frames.map(frame => {
      const scene = schedule.find(scene => frame >= scene.startFrame && frame < scene.endFrame) || schedule.at(-1);
      return { index: scene.index, frame, time: frame / plan.fps, label: scene.label };
    });
  }
  async function preview(input, options = {}) {
    if (closed) throw fail(503, '分镜预览服务正在关闭。', 'MOTION_PREVIEW_CLOSED');
    let plan;
    try { plan = schema.validateAnimationPlan(input); } catch (error) { throw fail(400, error.message || '动画方案格式不正确。', 'MOTION_PREVIEW_INVALID_PLAN'); }
    const selected = samples(plan, options), controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    check(signal); controllers.add(controller);
    let started = false, output;
    const progress = value => { try { options.onProgress?.(value); } catch { /* Optional host observer. */ } };
    const work = tail.catch(() => {}).then(async () => {
      started = true; check(signal);
      const id = randomUUID(), planHash = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
      output = await directory(id, true); progress(.005);
      try {
        const result = await renderer.renderAnimationFrames({ plan, outputDirectory: output, frames: selected.map(item => item.frame), signal, onProgress: value => progress(Math.min(.99, value)) });
        check(signal);
        if (!Array.isArray(result.frames) || result.frames.length !== selected.length) throw fail(502, '分镜预览没有返回完整图像。', 'MOTION_PREVIEW_INCOMPLETE');
        const frames = [];
        for (const [index, frame] of result.frames.entries()) {
          if (!FILE.test(frame.file) || frame.frame !== selected[index].frame) throw fail(502, '分镜预览返回了无效帧。', 'MOTION_PREVIEW_INCOMPLETE');
          const bytes = await readFile(path.join(output, frame.file));
          if (!bytes.subarray(0, 8).equals(PNG) || bytes.length > 10 * 1024 * 1024) throw fail(502, '分镜预览图像无效。', 'MOTION_PREVIEW_INVALID_IMAGE');
          frames.push({ ...selected[index], file: frame.file, width: frame.width, height: frame.height, url: `/api/video/previews/${id}/${frame.file}` });
        }
        const value = { id, planHash, duration: result.duration, fps: plan.fps, width: result.width, height: result.height, frames, createdAt: new Date().toISOString() };
        check(signal);
        const temporary = path.join(output, '.manifest.tmp');
        await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 }); check(signal); await rename(temporary, path.join(output, 'manifest.json'));
        progress(1); return value;
      } catch (error) {
        await cleanup(output).catch(() => {});
        if (signal.aborted) throw stopped();
        if (error instanceof AppError) throw error;
        throw fail(502, '分镜预览未完成，请确认本机Edge或Chrome可用并重试。', 'MOTION_PREVIEW_FAILED');
      }
    });
    tail = work.catch(() => {});
    try {
      // A queued cancellation is immediate and never starts another browser.
      // Once rendering begins, wait for the worker to release its resources.
      return await new Promise((resolve, reject) => {
        const abort = () => { if (!started) reject(stopped()); };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      });
    } finally { controllers.delete(controller); }
  }
  async function file(id, name) {
    if (typeof name !== 'string' || !FILE.test(name)) throw fail(404, '分镜预览图像不存在。', 'MOTION_PREVIEW_FILE_NOT_FOUND');
    const target = await directory(id), manifestPath = path.join(target, 'manifest.json');
    let manifest;
    try {
      const info = await lstat(manifestPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 128000) throw new Error('invalid manifest');
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    } catch { throw fail(404, '分镜预览尚未完成或已清理。', 'MOTION_PREVIEW_NOT_FOUND'); }
    if (manifest.id !== id.toLowerCase() || !Array.isArray(manifest.frames) || !manifest.frames.some(frame => frame.file === name)) throw fail(404, '分镜预览图像不属于该次预览。', 'MOTION_PREVIEW_FILE_NOT_FOUND');
    const filename = path.join(target, name);
    let info, actual;
    try { info = await lstat(filename); actual = await realpath(filename); }
    catch { throw fail(404, '分镜预览图像不存在或已清理。', 'MOTION_PREVIEW_FILE_NOT_FOUND'); }
    const compare = value => process.platform === 'win32' ? value.toLowerCase() : value;
    if (!info.isFile() || info.isSymbolicLink() || info.size > 10 * 1024 * 1024 || compare(path.dirname(actual)) !== compare(await realpath(target))) throw fail(403, '分镜预览文件位置无效。', 'MOTION_PREVIEW_INVALID_STORAGE');
    const bytes = await readFile(actual);
    if (!bytes.subarray(0, 8).equals(PNG)) throw fail(422, '分镜预览图像格式无效。', 'MOTION_PREVIEW_INVALID_IMAGE');
    return { bytes, contentType: 'image/png', planHash: manifest.planHash };
  }
  async function handler(req, res, url) {
    const target = url instanceof URL ? url : new URL(req.url, `http://${req.headers.host}`), match = target.pathname.match(/^\/api\/video\/previews\/([a-f0-9-]+)\/([^/]+)$/i);
    if (!match || !['GET', 'HEAD'].includes(req.method || 'GET')) return false;
    const result = await file(match[1], decodeURIComponent(match[2]));
    res.writeHead(200, { 'Content-Type': result.contentType, 'Content-Length': result.bytes.length, 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' }); res.end(req.method === 'HEAD' ? undefined : result.bytes); return true;
  }
  return { preview, file, handler, handle: handler,
    async close() { closed = true; for (const controller of controllers) controller.abort(); await tail; },
  };
}
