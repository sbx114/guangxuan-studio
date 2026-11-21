import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { findAnimationBrowser } from '../animation/render.mjs';
import { AppError } from './errors.mjs';

/** Execute only the application's fixed Canvas exporter in an isolated browser. */
export async function renderAssistantPoster(output, { root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), signal } = {}) {
  signal?.throwIfAborted();
  const module = await readFile(path.join(root, 'public', 'poster-export.js'));
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' || !['/', '/poster-export.js'].includes(req.url)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': req.url === '/' ? 'text/html; charset=utf-8' : 'application/javascript; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; script-src 'self'; connect-src 'none'; font-src 'none'; img-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'" });
    res.end(req.url === '/' ? '<!doctype html><meta charset="utf-8"><title>Gx 本机海报导出</title>' : module);
  });
  let browser;
  const stop = () => { void browser?.close().catch(() => {}); };
  signal?.addEventListener('abort', stop, { once: true });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: await findAnimationBrowser(), headless: true, timeout: 30000 });
    signal?.throwIfAborted();
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', route => ['/', '/poster-export.js'].some(relative => route.request().url() === origin + relative) ? route.continue() : route.abort());
    const page = await context.newPage(); page.setDefaultTimeout(30000);
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    const bytes = await page.evaluate(async value => {
      const { exportPosterImage } = await import('/poster-export.js');
      return exportPosterImage(value, { document, safeName: () => 'poster', saveFile: async (_name, blob) => Array.from(new Uint8Array(await blob.arrayBuffer())) });
    }, output);
    signal?.throwIfAborted();
    const buffer = Buffer.from(bytes);
    if (buffer.length < 24 || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || buffer.readUInt32BE(16) !== 1080) throw new AppError(422, '海报没有返回有效PNG，尚未保存。', 'ASSISTANT_POSTER_FAILED');
    return buffer;
  } catch (error) {
    if (signal?.aborted) throw new AppError(499, '海报导出已停止。', 'REQUEST_CANCELLED');
    if (error instanceof AppError) throw error;
    const message = String(error.message || '本机画布未能完成导出。').split('\n')[0].replace(/^page\.evaluate:\s*(?:Error:\s*)?/, '').replace(/[A-Za-z]:[\\/][^\s)]+/g, '[运行时文件]').slice(0, 1000);
    throw new AppError(422, '海报图片未生成：' + message, 'ASSISTANT_POSTER_FAILED');
  } finally {
    signal?.removeEventListener('abort', stop); await browser?.close().catch(() => {});
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
}
