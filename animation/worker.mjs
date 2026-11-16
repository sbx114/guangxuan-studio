import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { bundle } from '@remotion/bundler';
import { makeCancelSignal, openBrowser, renderMedia, selectComposition } from '@remotion/renderer';
import { validateAnimationPlan, animationDimensions, animationFrameCount } from './schema.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const cancellation = makeCancelSignal();
let cancelled = false;
let running = false;
const send = (message) => { if (process.connected) process.send(message); };

async function run({ plan: input, outputPath, browserExecutable }) {
  const plan = validateAnimationPlan(input);
  await mkdir(path.dirname(outputPath), { recursive: true });
  const workRoot = path.join(path.dirname(outputPath), '.animation-work');
  await mkdir(workRoot, { recursive: true });
  const temporaryDirectory = await mkdtemp(path.join(workRoot, 'render-'));
  let browser;
  try {
    send({ type: 'progress', progress: 0.02 });
    const bundleDirectory = await bundle({
      entryPoint: path.join(HERE, 'index.jsx'),
      outDir: path.join(temporaryDirectory, 'bundle'),
      publicDir: path.join(HERE, 'assets'),
      onProgress: (progress) => send({ type: 'progress', progress: 0.02 + Math.min(100, progress) / 100 * 0.16 }),
    });
    if (cancelled) throw new Error('动画渲染已取消。');
    browser = await openBrowser('chrome', {
      browserExecutable, logLevel: 'error',
      chromiumOptions: { enableMultiProcessOnLinux: true },
    });
    const inputProps = { plan };
    const composition = await selectComposition({
      serveUrl: bundleDirectory, id: 'GuangxuanAnimation', inputProps,
      puppeteerInstance: browser, browserExecutable, logLevel: 'error',
    });
    send({ type: 'progress', progress: 0.2 });
    await renderMedia({
      composition, serveUrl: bundleDirectory, inputProps,
      codec: 'h264', outputLocation: outputPath, pixelFormat: 'yuv420p',
      crf: 20, x264Preset: 'veryfast', concurrency: 2,
      browserExecutable, puppeteerInstance: browser, logLevel: 'error',
      cancelSignal: cancellation.cancelSignal,
      onProgress: ({ progress }) => send({ type: 'progress', progress: 0.2 + progress * 0.79 }),
    });
    if (cancelled) throw new Error('动画渲染已取消。');
    const output = await stat(outputPath);
    if (output.size < 1000) throw new Error('动画未生成有效视频。');
    send({ type: 'result', result: { outputPath, duration: animationFrameCount(plan) / 30, ...animationDimensions(plan.aspect) } });
  } finally {
    if (browser) await browser.close({ silent: true }).catch(() => {});
    const resolvedWork = path.resolve(temporaryDirectory);
    if (path.dirname(resolvedWork) === path.resolve(workRoot) && path.basename(resolvedWork).startsWith('render-'))
      await rm(resolvedWork, { recursive: true, force: true }).catch(() => {});
  }
}

process.on('message', async (message) => {
  if (message?.type === 'cancel') { cancelled = true; cancellation.cancel(); return; }
  if (message?.type !== 'render' || running) return;
  running = true;
  try { await run(message); process.exitCode = 0; }
  catch (error) { send({ type: 'error', message: cancelled ? '动画渲染已取消。' : String(error.message || '动画渲染失败。').slice(0, 1800) }); process.exitCode = 1; }
  finally { process.disconnect(); }
});

process.on('disconnect', () => { cancelled = true; cancellation.cancel(); });
