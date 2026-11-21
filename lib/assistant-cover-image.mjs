import { chromium } from 'playwright-core';
import { findAnimationBrowser } from '../animation/render.mjs';
import { AppError } from './errors.mjs';
import { validateCoverPng } from './project-covers.mjs';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
export function requireAssistantCoverMime(value) {
  const type = typeof value === 'string' ? value.split(';')[0].trim().toLowerCase() : '';
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(type)) throw new AppError(415, '封面需要PNG、JPEG或WebP图片；ZIP或视频请先执行poster封面图片导出，再使用该图片。', 'ASSISTANT_COVER_IMAGE_REQUIRED');
  return type;
}
async function boundedCoverStream(stream, signal) {
  const chunks = []; let size = 0;
  for await (const chunk of stream) {
    signal?.throwIfAborted(); size += chunk.length;
    if (size > MAX_SOURCE_BYTES) throw new AppError(413, '原始封面图片需在20MB以内。', 'COVER_TOO_LARGE');
    chunks.push(Buffer.from(chunk));
  }
  signal?.throwIfAborted(); return Buffer.concat(chunks);
}
/** filename comes only from the verified media service, never from tool input. */
export async function readAssistantCoverFile(filename, { signal } = {}) {
  signal?.throwIfAborted(); const info = await stat(filename);
  if (!info.isFile() || info.size < 1 || info.size > MAX_SOURCE_BYTES) throw new AppError(413, '原始封面图片需为20MB以内的文件。', 'COVER_TOO_LARGE');
  return boundedCoverStream(createReadStream(filename, { signal }), signal);
}
/** Only the caller's fixed local export response is admitted here. */
export async function readAssistantCoverResponse(response, { signal } = {}) {
  try {
    requireAssistantCoverMime(response.headers.get('content-type'));
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_SOURCE_BYTES)) throw new AppError(413, '原始封面图片需在20MB以内。', 'COVER_TOO_LARGE');
    if (!response.body) throw new AppError(422, '封面导出没有返回图片文件。', 'ASSISTANT_COVER_EXPORT_UNAVAILABLE');
    return await boundedCoverStream(response.body, signal);
  } catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
}

/** Fixed raster decoder/Canvas encoder, with no external URL, script or profile. */
export async function prepareAssistantCover(buffer, { signal } = {}) {
  signal?.throwIfAborted();
  if (!Buffer.isBuffer(buffer) || buffer.length < 12 || buffer.length > MAX_SOURCE_BYTES) throw new AppError(413, '原始封面图片需在20MB以内。', 'COVER_TOO_LARGE');
  const png = buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a', jpeg = buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255, webp = buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP';
  if (!png && !jpeg && !webp) throw new AppError(415, '封面仅支持真实PNG、JPEG或WebP图片。', 'INVALID_COVER_IMAGE');
  if (png && (buffer.length < 24 || buffer.readUInt32BE(16) * buffer.readUInt32BE(20) > 64000000)) throw new AppError(413, '封面原图不能超过6400万像素。', 'COVER_PIXEL_LIMIT');
  let browser; const stop = () => { void browser?.close().catch(() => {}); };
  signal?.addEventListener('abort', stop, { once: true });
  try {
    browser = await chromium.launch({ executablePath: await findAnimationBrowser(), headless: true, timeout: 30000 }); signal?.throwIfAborted();
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', route => route.abort());
    const page = await context.newPage();
    await page.setContent('<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src blob:; connect-src \'none\'; object-src \'none\'; base-uri \'none\'">');
    const result = await page.evaluate(async ({ base64, type }) => {
      const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
      const image = await createImageBitmap(new Blob([bytes], { type }));
      try {
        if (image.width < 1 || image.height < 1 || image.width * image.height > 64000000) throw new Error('封面原图不能超过6400万像素。');
        const scale = Math.min(1, 1280 / Math.max(image.width, image.height));
        const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(image.width * scale)); canvas.height = Math.max(1, Math.round(image.height * scale));
        const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('本机无法创建封面画布。');
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('封面PNG编码失败。')), 'image/png'));
        return { bytes: Array.from(new Uint8Array(await blob.arrayBuffer())), originalWidth: image.width, originalHeight: image.height };
      } finally { image.close(); }
    }, { base64: buffer.toString('base64'), type: png ? 'image/png' : jpeg ? 'image/jpeg' : 'image/webp' });
    signal?.throwIfAborted(); const validated = validateCoverPng(Buffer.from(result.bytes));
    return { buffer: validated.bytes, width: validated.width, height: validated.height, originalWidth: result.originalWidth, originalHeight: result.originalHeight };
  } catch (error) {
    if (signal?.aborted) throw new AppError(499, '封面处理已停止。', 'REQUEST_CANCELLED');
    if (error instanceof AppError) throw error;
    throw new AppError(415, '封面图片未能解码为可用PNG，请检查图片是否完整。', 'INVALID_COVER_IMAGE');
  } finally { signal?.removeEventListener('abort', stop); await browser?.close().catch(() => {}); }
}
