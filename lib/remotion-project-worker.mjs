import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { bundle } from '@remotion/bundler';
import { getCompositions, makeCancelSignal, openBrowser, renderMedia, renderStill, selectComposition } from '@remotion/renderer';

const cancellation = makeCancelSignal(), builtins = new Set(builtinModules.map(name => name.replace(/^node:/, '')));
let cancelled = false, running = false;
const send = value => { if (process.connected) process.send(value); };
const sendFinal = value => new Promise(resolve => { if (!process.connected) return resolve(); process.send(value, () => resolve()); });
const within = (root, candidate) => { const relative = path.relative(root, candidate); return relative === '' || !relative.startsWith('..') && !path.isAbsolute(relative); };
const stopped = () => { if (cancelled) throw new Error('Remotion任务已取消。'); };
const mime = filename => ({ '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.woff': 'font/woff', '.woff2': 'font/woff2' }[path.extname(filename).toLowerCase()] || 'application/octet-stream');

/** Fixed compilation policy: source files may import local components or installed dependencies only. */
export class RemotionModuleBoundaryPlugin {
  constructor(sourceRoot, dependencyRoot) { this.roots = [path.resolve(sourceRoot), path.resolve(dependencyRoot)]; }
  allowed(filename) { return this.roots.some(root => within(root, path.resolve(filename))); }
  request(request, context) {
    if (!request) return;
    if (request.includes('!')) {
      // style-loader emits explicit requests for its fixed installed runtime and
      // css-loader rule options. Do not treat those as model-supplied loaders.
      const parts = request.split('!'), resource = parts.pop();
      for (const loader of parts.filter(part => part && part !== '-')) {
        const [filename, query = ''] = loader.split(/\?(.*)/s), resolved = path.resolve(context || this.roots[0], filename);
        if (!within(this.roots[1], resolved) || !/[\\/](?:css-loader|style-loader)[\\/]dist[\\/]/.test(resolved) || query && !/^\?ruleSet[\w.[\]$]+$/.test(query)) throw new Error('Remotion工程不允许使用自定义内联loader。');
      }
      this.request(resource, context); return;
    }
    if (/^(?:node:|https?:|file:|data:|\\\\)/i.test(request) || builtins.has(request.split('?')[0])) throw new Error('Remotion源码不能使用Node模块、网络模块或外部文件路径：' + request.slice(0, 180));
    if (path.isAbsolute(request) && !this.allowed(request) || request.startsWith('.') && context && !this.allowed(path.resolve(context, request.split('?')[0]))) throw new Error('Remotion导入超出当前工程与已安装依赖。');
  }
  resource(resource) {
    if (!resource) return;
    const filename = resource.split('?')[0];
    if (!this.allowed(filename)) throw new Error('Remotion模块解析超出当前工程与已安装依赖。');
  }
  apply(compiler) {
    const name = 'GxRemotionModuleBoundary';
    compiler.hooks.normalModuleFactory.tap(name, factory => {
      factory.hooks.beforeResolve.tap(name, request => { if (request) this.request(request.request, request.context); });
      factory.hooks.afterResolve.tap(name, request => { if (request) this.resource(request.createData?.resource); });
    });
    compiler.hooks.contextModuleFactory.tap(name, factory => {
      factory.hooks.beforeResolve.tap(name, request => { if (request) this.request(request.request, request.context); });
      factory.hooks.afterResolve.tap(name, request => { if (request) this.resource(request.resource); });
    });
    // Loaders are fixed installed build tools, never supplied by a generated file.
    compiler.hooks.compilation.tap(name, compilation => {
      compilation.hooks.buildModule.tap(name, module => {
        if (module.resource) this.resource(module.resource);
        for (const loader of module.loaders || []) if (!within(this.roots[1], path.resolve(loader.loader))) throw new Error('Remotion工程不允许使用外部loader。');
      });
    });
  }
}

async function assertSources(sourceRoot, directory = sourceRoot) {
  for (const entry of await (await import('node:fs/promises')).readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isSymbolicLink() || !within(sourceRoot, await realpath(filename))) throw new Error('Remotion源码目录不能包含链接或外部文件。');
    if (entry.isDirectory()) await assertSources(sourceRoot, filename);
    else if (!entry.isFile()) throw new Error('Remotion源码包含非普通文件。');
  }
}
async function serve(directory) {
  const server = http.createServer(async (req, res) => {
    try {
      if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
      const url = new URL(req.url, 'http://127.0.0.1'), relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname).slice(1);
      if (relative.split('/').some(part => part === '..' || part === '.' || part.includes('\\') || part.includes(':'))) throw new Error('Invalid asset path');
      const filename = path.resolve(directory, relative);
      if (!within(directory, filename) || !within(directory, await realpath(filename))) throw new Error('Asset outside bundle');
      const info = await lstat(filename); if (!info.isFile() || info.isSymbolicLink()) throw new Error('Not a bundle file');
      const headers = { 'Content-Type': mime(filename), 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self' data: blob:; script-src 'self' 'unsafe-eval' 'unsafe-inline' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: http://localhost:* http://127.0.0.1:*; media-src 'self' data: blob:; connect-src 'self' http://localhost:* http://127.0.0.1:*; font-src 'self' data:; frame-src 'none'; worker-src 'none'; object-src 'none'" };
      const range = typeof req.headers.range === 'string' && /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
      let start = 0, end = info.size - 1;
      if (range) { start = Number(range[1]); end = range[2] ? Math.min(Number(range[2]), end) : end; if (start > end || start >= info.size) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); res.end(); return; } headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`; }
      headers['Content-Length'] = Math.max(0, end - start + 1); res.writeHead(range ? 206 : 200, headers);
      if (req.method === 'HEAD' || !info.size) res.end(); else createReadStream(filename, { start, end }).pipe(res);
    } catch { if (!res.headersSent) res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
function safeMediaSource(value, origin) {
  if (typeof value !== 'string') return false;
  if (value.startsWith('data:')) return true;
  try { const url = new URL(value); return url.origin === origin && !url.username && !url.password; } catch { return false; }
}
export function allowedRenderRequest(value, origin, proxyPorts = new Set()) {
  try {
    const url = new URL(value);
    if (['data:', 'blob:', 'about:'].includes(url.protocol)) return true;
    if (url.username || url.password) return false;
    if (url.origin === origin) return true;
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && proxyPorts.has(Number(url.port)) && url.pathname === '/proxy' && safeMediaSource(url.searchParams.get('src'), origin);
  } catch { return false; }
}
async function guardBrowser(browser, origin) {
  const originalNewPage = browser.newPage.bind(browser), proxyPorts = new Set();
  browser.newPage = async (...args) => {
    const page = await originalNewPage(...args), client = page._client();
    client.on('Fetch.requestPaused', async event => {
      const allowed = allowedRenderRequest(event.request.url, origin, proxyPorts);
      try { await client.send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', { requestId: event.requestId, ...(allowed ? {} : { errorReason: 'BlockedByClient' }) }); } catch { /* The page can close while a request is paused. */ }
    });
    await client.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    const originalEvaluate = page.evaluateOnNewDocument.bind(page);
    page.evaluateOnNewDocument = async (fn, ...values) => {
      if (String(fn).includes('remotion_proxyPort') && Number.isInteger(values[2]) && values[2] > 0) proxyPorts.add(values[2]);
      return originalEvaluate(fn, ...values);
    };
    await originalEvaluate(() => {
      // Free React components run without app credentials, service workers or
      // secondary browsing contexts. Assets are copied into this bundle.
      for (const key of ['WebSocket', 'Worker', 'SharedWorker']) Object.defineProperty(window, key, { configurable: false, writable: false, value: class { constructor() { throw new Error('请使用当前Remotion工程内的资源。外部连接及后台Worker未开放。'); } } });
      window.open = () => null;
      if (navigator.serviceWorker) navigator.serviceWorker.register = async () => { throw new Error('当前渲染环境不注册Service Worker。'); };
    });
    return page;
  };
}
function guardNodeMediaNetwork(origin) {
  const allowed = value => { try { const url = new URL(value); return url.origin === origin && !url.username && !url.password; } catch { return false; } };
  const describe = (input, options) => {
    if (typeof input === 'string' || input instanceof URL) return String(input);
    const value = input || options || {}; return `${value.protocol || 'http:'}//${value.hostname || value.host || 'localhost'}${value.port ? ':' + value.port : ''}${value.path || '/'}`;
  };
  for (const transport of [http, https]) for (const key of ['request', 'get']) {
    const original = transport[key].bind(transport);
    transport[key] = (...args) => { if (!allowed(describe(args[0], args[1]))) throw new Error('Remotion媒体只能读取当前工程内资源，请先导入素材。'); return original(...args); };
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (...args) => { if (!allowed(String(args[0]?.url || args[0]))) return Promise.reject(new Error('Remotion媒体不允许读取外部地址。')); return originalFetch(...args); };
}

async function run(request) {
  const { kind, sourceRoot: sourceInput, engineRoot, entryPoint, outputDirectory, browserExecutable, inputProps = {}, frames, range } = request;
  const sourceRoot = await realpath(sourceInput), dependencies = await realpath(path.join(engineRoot, 'node_modules'));
  if (!within(sourceRoot, path.resolve(sourceRoot, entryPoint))) throw new Error('Remotion入口超出工程目录。');
  await assertSources(sourceRoot); stopped();
  const bundleDirectory = path.join(outputDirectory, 'bundle'); await mkdir(outputDirectory, { recursive: true });
  let browser, server;
  try {
    send({ type: 'progress', progress: .01 });
    await bundle({ entryPoint: path.join(sourceRoot, entryPoint), outDir: bundleDirectory, publicDir: path.join(sourceRoot, 'public'),
      webpackOverride: config => ({ ...config, cache: false, resolve: { ...config.resolve, modules: ['node_modules', dependencies], symlinks: true }, module: { ...config.module, rules: [...(config.module?.rules || []), { test: /\.(?:glsl|vert|frag|wgsl)$/i, type: 'asset/source' }] }, plugins: [...(config.plugins || []), new RemotionModuleBoundaryPlugin(sourceRoot, dependencies)] }),
      onProgress: progress => send({ type: 'progress', progress: .01 + Math.min(100, progress) / 100 * .23 }),
    });
    stopped(); server = await serve(bundleDirectory);
    browser = await openBrowser('chrome', { browserExecutable, logLevel: 'error', chromiumOptions: { enableMultiProcessOnLinux: true } });
    await guardBrowser(browser, server.origin); guardNodeMediaNetwork(server.origin);
    const common = { serveUrl: server.origin, inputProps, puppeteerInstance: browser, browserExecutable, logLevel: 'error', timeoutInMilliseconds: 60000, ...(process.env.GUANGXUAN_REMOTION_BIN_DIR ? { binariesDirectory: process.env.GUANGXUAN_REMOTION_BIN_DIR } : {}) };
    const available = await getCompositions(common); stopped(); send({ type: 'progress', progress: .3 });
    const compositions = available.map(item => ({ id: item.id, width: item.width, height: item.height, fps: item.fps, durationInFrames: item.durationInFrames, duration: item.durationInFrames / item.fps }));
    if (kind === 'inspect') return { compositions };
    const compositionId = request.compositionId || (compositions.length === 1 ? compositions[0].id : '');
    if (!compositionId || !compositions.some(item => item.id === compositionId)) throw new Error('请先从真实Composition列表中选择要渲染的一项。');
    const composition = await selectComposition({ ...common, id: compositionId }); stopped();
    const metadata = { compositionId, width: composition.width, height: composition.height, fps: composition.fps, durationInFrames: composition.durationInFrames, duration: composition.durationInFrames / composition.fps };
    if (kind === 'preview') {
      const samples = frames || [Math.floor(composition.durationInFrames / 2)];
      if (!Array.isArray(samples) || !samples.length || samples.length > 16 || samples.some(frame => !Number.isSafeInteger(frame) || frame < 0 || frame >= composition.durationInFrames)) throw new Error('预览帧超出当前Composition的实际时长。');
      const results = [];
      for (const [index, frame] of samples.entries()) {
        stopped(); const file = `frame-${String(index).padStart(2, '0')}.png`, output = path.join(outputDirectory, file);
        await renderStill({ ...common, composition, frame, output, imageFormat: 'png', cancelSignal: cancellation.cancelSignal });
        const info = await stat(output); if (info.size < 100) throw new Error('Remotion未生成有效PNG。');
        results.push({ file, frame, width: composition.width, height: composition.height }); send({ type: 'progress', progress: .3 + (index + 1) / samples.length * .69 });
      }
      return { ...metadata, frames: results };
    }
    if (kind !== 'video') throw new Error('未知Remotion任务。');
    let frameRange;
    if (range !== undefined) {
      if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isSafeInteger) || range[0] < 0 || range[1] <= range[0] || range[1] > composition.durationInFrames) throw new Error('渲染帧区间超出实际Composition。');
      frameRange = [range[0], range[1] - 1];
    }
    const outputPath = path.join(outputDirectory, 'video.mp4');
    await renderMedia({ ...common, composition, codec: 'h264', outputLocation: outputPath, pixelFormat: 'yuv420p', crf: 20, x264Preset: 'veryfast', concurrency: 2, cancelSignal: cancellation.cancelSignal, ...(frameRange ? { frameRange } : {}), onProgress: ({ progress }) => send({ type: 'progress', progress: .3 + progress * .69 }) });
    stopped(); if ((await stat(outputPath)).size < 1000) throw new Error('Remotion未生成有效MP4。');
    return { ...metadata, ...(frameRange ? { renderedRange: range, duration: (range[1] - range[0]) / composition.fps } : {}), outputPath, file: 'video.mp4' };
  } finally {
    if (browser) await browser.close({ silent: true }).catch(() => {});
    if (server) await server.close();
    if (within(outputDirectory, bundleDirectory)) await rm(bundleDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

process.on('message', async request => {
  if (request?.type === 'cancel') { cancelled = true; cancellation.cancel(); return; }
  if (request?.type !== 'run' || running) return;
  running = true;
  try { const result = await run(request); stopped(); await sendFinal({ type: 'result', result }); }
  catch (error) { await sendFinal({ type: 'error', code: 'REMOTION_EXECUTION_FAILED', message: cancelled ? 'Remotion任务已取消。' : String(error.message || error).slice(0, 2000) }); }
  finally { if (process.connected) process.disconnect(); process.exit(0); }
});
process.on('disconnect', () => { cancelled = true; cancellation.cancel(); });
