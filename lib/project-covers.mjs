import path from 'node:path';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { AppError } from './errors.mjs';

export const MAX_COVER_BYTES = 8 * 1024 * 1024;
export const COVER_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const validCoverAssetId = value => typeof value === 'string' && COVER_ID.test(value);
export const projectCoverUrl = value => validCoverAssetId(value) ? `/api/project-covers/${value}` : '';
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(buffer) { let crc = 0xffffffff; for (const byte of buffer) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
const invalidImage = () => new AppError(415, '封面图片无法读取，请重新选择 JPG、PNG 或 WebP 图片。', 'INVALID_COVER_IMAGE');

/** The browser decodes and scales uploads to a standard, non-interlaced RGB(A) PNG. */
export function validateCoverPng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 57 || buffer.length > MAX_COVER_BYTES || !buffer.subarray(0, 8).equals(signature)) throw invalidImage();
  let offset = 8, header, ended = false, width = 0, height = 0, channels = 0;
  const imageChunks = [], compressed = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    if (length > MAX_COVER_BYTES || offset + 12 + length > buffer.length) throw invalidImage();
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    const full = buffer.subarray(offset, offset + 12 + length);
    if (crc32(buffer.subarray(offset + 4, offset + 8 + length)) !== buffer.readUInt32BE(offset + 8 + length)) throw invalidImage();
    if (!header && type !== 'IHDR') throw invalidImage();
    if (type === 'IHDR') {
      if (header || length !== 13) throw invalidImage();
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      channels = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0;
      if (!width || !height || width > 2048 || height > 2048 || data[8] !== 8 || !channels || data[10] || data[11] || data[12]) throw invalidImage();
      header = full;
    } else if (type === 'IDAT') { imageChunks.push(full); compressed.push(data); }
    else if (type === 'IEND') { if (length || !imageChunks.length || offset + 12 !== buffer.length) throw invalidImage(); ended = true; imageChunks.push(full); break; }
    else if (type === 'acTL' || !/^[a-z]/.test(type)) throw invalidImage();
    offset += 12 + length;
  }
  if (!ended) throw invalidImage();
  const stride = width * channels + 1, expected = stride * height;
  let pixels;
  try { pixels = inflateSync(Buffer.concat(compressed), { maxOutputLength: expected + 1 }); } catch { throw invalidImage(); }
  if (pixels.length !== expected) throw invalidImage();
  for (let row = 0; row < height; row++) if (pixels[row * stride] > 4) throw invalidImage();
  return { bytes: Buffer.concat([signature, header, ...imageChunks]), width, height };
}

async function receive(req) {
  if (!/^image\/png(?:\s*;|$)/i.test(req.headers['content-type'] || '')) { req.resume(); throw new AppError(415, '封面上传需要使用 PNG 图片。', 'INVALID_COVER_CONTENT_TYPE'); }
  if (Number(req.headers['content-length']) > MAX_COVER_BYTES) { req.resume(); throw new AppError(413, '处理后的封面图片不能超过8MB。', 'COVER_TOO_LARGE'); }
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, settled = false;
    req.on('data', chunk => { if (settled) return; size += chunk.length; if (size > MAX_COVER_BYTES) { settled = true; chunks.length = 0; reject(new AppError(413, '处理后的封面图片不能超过8MB。', 'COVER_TOO_LARGE')); return; } chunks.push(chunk); });
    req.on('end', () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', () => { if (!settled) { settled = true; reject(new AppError(400, '封面上传中断，请重试。', 'COVER_UPLOAD_FAILED')); } });
    req.on('aborted', () => { if (!settled) { settled = true; reject(new AppError(400, '封面上传已取消。', 'COVER_UPLOAD_FAILED')); } });
  });
}

export async function createProjectCovers(dataDir) {
  const directory = path.join(path.resolve(dataDir), 'project-covers');
  await mkdir(directory, { recursive: true });
  const root = await realpath(directory);
  async function resolve(id) {
    if (!validCoverAssetId(id)) throw new AppError(400, '封面编号不正确。', 'INVALID_COVER_ASSET');
    let filename;
    try { filename = await realpath(path.join(root, `${id}.png`)); } catch { throw new AppError(404, '封面图片不存在，请重新上传。', 'COVER_NOT_FOUND'); }
    if (path.dirname(filename) !== root) throw new AppError(404, '封面图片不存在。', 'COVER_NOT_FOUND');
    return filename;
  }
  async function importBytes(buffer, { signal } = {}) {
    signal?.throwIfAborted(); const image = validateCoverPng(buffer), coverAssetId = randomUUID();
    await writeFile(path.join(root, `${coverAssetId}.png`), image.bytes, { flag: 'wx', mode: 0o600 });
    return { coverAssetId, coverUrl: projectCoverUrl(coverAssetId), width: image.width, height: image.height };
  }
  return {
    assertExists: resolve,
    async read(id) { return readFile(await resolve(id)); },
    importBytes,
    async upload(req) { return importBytes(await receive(req)); },
  };
}
