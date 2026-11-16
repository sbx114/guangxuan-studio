import { execFile, fork } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAnimationPlan } from './schema.mjs';

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

export async function renderAnimation({ plan: input, outputPath, onProgress = () => {}, signal } = {}) {
  const plan = validateAnimationPlan(input);
  if (typeof outputPath !== 'string' || !path.isAbsolute(outputPath) || path.extname(outputPath).toLowerCase() !== '.mp4')
    throw new Error('动画输出需要一个有效的 MP4 绝对路径。');
  if (signal?.aborted) throw new Error('动画渲染已取消。');
  const browserExecutable = await findAnimationBrowser();
  return new Promise((resolve, reject) => {
    const child = fork(path.join(HERE, 'worker.mjs'), [], {
      cwd: path.dirname(HERE), execArgv: [], windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let settled = false;
    let errorTail = '';
    let cancelTimer;
    const timer = setTimeout(() => cancel('动画渲染超过时间限制，请减少场景后重试。'), 15 * 60 * 1000);
    const cleanup = () => { clearTimeout(timer); clearTimeout(cancelTimer); signal?.removeEventListener('abort', aborted); };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error); else { onProgress(1); resolve(result); }
    };
    const cancel = (message = '动画渲染已取消。') => {
      if (settled) return;
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
      if (message?.type === 'progress') onProgress(Math.max(0, Math.min(1, Number(message.progress) || 0)));
      if (message?.type === 'result') finish(null, message.result);
      if (message?.type === 'error') finish(new Error(message.message || '动画渲染失败。'));
    });
    child.on('error', () => finish(new Error('无法启动动画渲染进程。')));
    child.on('exit', (code) => {
      if (!settled) finish(new Error(signal?.aborted ? '动画渲染已取消。' : `动画渲染进程提前退出${code === null ? '' : `（${code}）`}。${errorTail ? ` ${errorTail.slice(-900)}` : ''}`));
    });
    if (signal?.aborted) cancel();
    else child.send({ type: 'render', plan, outputPath, browserExecutable });
  });
}
