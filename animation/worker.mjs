import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { bundle } from '@remotion/bundler';
import { makeCancelSignal, openBrowser, renderMedia, renderStill, selectComposition } from '@remotion/renderer';
import { validateAnimationPlan, animationDimensions, animationFrameCount } from './schema.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const cancellation = makeCancelSignal();
let cancelled = false;
let running = false;
const send = (message) => { if (process.connected) process.send(message); };

async function run({ type, plan: input, outputPath, outputDirectory, frames, rangeFrames, browserExecutable }) {
  const plan = validateAnimationPlan(input);
  const destination = type === 'preview' ? outputDirectory : path.dirname(outputPath);
  await mkdir(destination, { recursive: true });
  const workRoot = path.join(destination, '.animation-work');
  await mkdir(workRoot, { recursive: true });
  const temporaryDirectory = await mkdtemp(path.join(workRoot, 'render-'));
  let browser;
  try {
    send({ type: 'progress', progress: 0.02 });
    const bundleDirectory = await bundle({
      entryPoint: path.join(HERE, 'index.jsx'),
      outDir: path.join(temporaryDirectory, 'bundle'),
      publicDir: path.join(HERE, 'assets'),
      webpackOverride: config => ({ ...config, cache: false }),
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
    if (type === 'preview') {
      const pictures = [];
      for (const [index, frame] of frames.entries()) {
        if (cancelled) throw new Error('动画渲染已取消。');
        const file = `frame-${String(index).padStart(2, '0')}.png`, output = path.join(destination, file);
        await renderStill({
          composition, serveUrl: bundleDirectory, inputProps, frame, output, imageFormat: 'png',
          browserExecutable, puppeteerInstance: browser, logLevel: 'error', cancelSignal: cancellation.cancelSignal,
        });
        const image = await stat(output);
        if (image.size < 100) throw new Error('分镜预览未生成有效图像。');
        pictures.push({ file, frame, width: composition.width, height: composition.height });
        send({ type: 'progress', progress: .2 + (index + 1) / frames.length * .79 });
      }
      if (cancelled) throw new Error('动画渲染已取消。');
      return { duration: animationFrameCount(plan) / plan.fps, fps: plan.fps, ...animationDimensions(plan.aspect), frames: pictures };
    }
    await renderMedia({
      composition, serveUrl: bundleDirectory, inputProps,
      codec: 'h264', outputLocation: outputPath, pixelFormat: 'yuv420p',
      crf: 20, x264Preset: 'veryfast', concurrency: 2,
      browserExecutable, puppeteerInstance: browser, logLevel: 'error',
      cancelSignal: cancellation.cancelSignal,
      ...(rangeFrames ? { frameRange: [rangeFrames[0], rangeFrames[1] - 1] } : {}),
      onProgress: ({ progress }) => send({ type: 'progress', progress: 0.2 + progress * 0.79 }),
    });
    if (cancelled) throw new Error('动画渲染已取消。');
    const output = await stat(outputPath);
    if (output.size < 1000) throw new Error('动画未生成有效视频。');
    return { outputPath, duration: rangeFrames ? (rangeFrames[1] - rangeFrames[0]) / plan.fps : animationFrameCount(plan) / plan.fps, ...animationDimensions(plan.aspect), ...(rangeFrames ? { range: rangeFrames.map(frame => frame / plan.fps) } : {}) };
  } finally {
    if (browser) await browser.close({ silent: true }).catch(() => {});
    const resolvedWork = path.resolve(temporaryDirectory);
    if (path.dirname(resolvedWork) === path.resolve(workRoot) && path.basename(resolvedWork).startsWith('render-'))
      await rm(resolvedWork, { recursive: true, force: true }).catch(() => {});
  }
}

process.on('message', async (message) => {
  if (message?.type === 'cancel') { cancelled = true; cancellation.cancel(); return; }
  if (!['render', 'preview'].includes(message?.type) || running) return;
  running = true;
  try { const result = await run(message); send({ type: 'result', result }); process.exitCode = 0; }
  catch (error) { send({ type: 'error', message: cancelled ? '动画渲染已取消。' : String(error.message || '动画渲染失败。').slice(0, 1800) }); process.exitCode = 1; }
  finally { process.disconnect(); }
});

process.on('disconnect', () => { cancelled = true; cancellation.cancel(); });
