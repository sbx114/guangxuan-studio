import { execFile, fork } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAnimationPlan, animationFrameCount } from './schema.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export async function findAnimationBrowser() {
  const candidates = [
    process.env.GUANGXUAN_BROWSER_EXECUTABLE,
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    process.platform === 'linux' ? '/usr/bin/google-chrome' : null,
    process.platform === 'linux' ? '/usr/bin/chromium' : null,
    process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : null,
  ].filter(Boolean);
  for (const candidate of [...new Set(candidates)]) {
    try { await access(candidate); return candidate; } catch { /* Try the next installed browser. */ }
  }
  throw new Error('动画渲染需要本机安装 Microsoft Edge 或 Google Chrome。安装后重新打开光宣工作台即可。');
}

function renderRange(plan, range) {
  if (range === undefined) return null;
  const length = animationFrameCount(plan);
  if (!Array.isArray(range) || range.length !== 2 || range.some(value => typeof value !== 'number' || !Number.isFinite(value)) || range[0] < 0 || range[1] > length / plan.fps || range[1] <= range[0]) throw new Error('动画小样需要有效的项目起止秒数。');
  const frames = range.map(value => Math.round(value * plan.fps));
  if (frames[1] <= frames[0] || frames[1] > length) throw new Error('动画小样区间至少需要一帧。');
  return frames;
}

export async function renderAnimation({ plan: input, outputPath, onProgress = () => {}, signal, range } = {}) {
  const plan = validateAnimationPlan(input);
  if (typeof outputPath !== 'string' || !path.isAbsolute(outputPath) || path.extname(outputPath).toLowerCase() !== '.mp4')
    throw new Error('动画输出需要一个有效的 MP4 绝对路径。');
  return runWorker({ type: 'render', plan, outputPath, rangeFrames: renderRange(plan, range) }, { signal, onProgress });
}

export async function renderAnimationFrames({ plan: input, outputDirectory, frames, signal, onProgress = () => {} } = {}) {
  const plan = validateAnimationPlan(input), length = animationFrameCount(plan);
  if (typeof outputDirectory !== 'string' || !path.isAbsolute(outputDirectory)) throw new Error('分镜预览需要有效的内部输出目录。');
  if (!Array.isArray(frames) || !frames.length || frames.length > 16 || frames.some(frame => !Number.isInteger(frame) || frame < 0 || frame >= length)) throw new Error('分镜预览需要1至16个有效项目帧。');
  return runWorker({ type: 'preview', plan, outputDirectory, frames: [...frames] }, { signal, onProgress, timeoutMs: 180000 });
}

async function runWorker(request, { onProgress, signal, timeoutMs = 15 * 60 * 1000 }) {
  if (signal?.aborted) throw new Error('动画渲染已取消。');
  const browserExecutable = await findAnimationBrowser();
  if (signal?.aborted) throw new Error('动画渲染已取消。');
  return new Promise((resolve, reject) => {
    const child = fork(path.join(HERE, 'worker.mjs'), [], {
      cwd: path.dirname(HERE), execArgv: [], windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let settled = false;
    let errorTail = '';
    let cancelTimer;
    let cancelRequested = false;
    const timer = setTimeout(() => cancel('动画渲染超过时间限制，请减少场景后重试。'), timeoutMs);
    const progress = value => { try { onProgress(value); } catch { /* Optional observers do not own render lifetime. */ } };
    const cleanup = () => { clearTimeout(timer); clearTimeout(cancelTimer); signal?.removeEventListener('abort', aborted); };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error); else { progress(1); resolve(result); }
    };
    const cancel = (message = '动画渲染已取消。') => {
      if (settled || cancelRequested) return;
      cancelRequested = true;
      if (child.connected) child.send({ type: 'cancel' });
      cancelTimer = setTimeout(() => {
        if (process.platform === 'win32' && Number.isInteger(child.pid)) {
          execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
        } else child.kill();
        finish(new Error(message));
      }, 8000);
    };
    const aborted = () => cancel();
    signal?.addEventListener('abort', aborted, { once: true });
    child.stderr.on('data', (chunk) => { errorTail = `${errorTail}${chunk.toString()}`.slice(-3000); });
    child.on('message', (message) => {
      if (message?.type === 'progress') progress(Math.max(0, Math.min(1, Number(message.progress) || 0)));
      if (message?.type === 'result') finish(signal?.aborted || cancelRequested ? new Error('动画渲染已取消。') : null, message.result);
      if (message?.type === 'error') finish(new Error(signal?.aborted || cancelRequested ? '动画渲染已取消。' : message.message || '动画渲染失败。'));
    });
    child.on('error', () => finish(new Error('无法启动动画渲染进程。')));
    child.on('exit', (code) => {
      if (!settled) finish(new Error(signal?.aborted ? '动画渲染已取消。' : `动画渲染进程提前退出${code === null ? '' : `（${code}）`}。${errorTail ? ` ${errorTail.slice(-900)}` : ''}`));
    });
    if (signal?.aborted) cancel();
    else child.send({ ...request, browserExecutable });
  });
}
