import { createHash } from 'node:crypto';
import { AppError } from './errors.mjs';

export const ASSISTANT_TOOL_IMAGE_LIMITS = Object.freeze({ count: 12, imageEncodedBytes: 2 * 1024 * 1024, batchEncodedBytes: 8 * 1024 * 1024 });
const dataImage = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
const fail = (message, code = 'ASSISTANT_TOOL_IMAGE_INVALID') => new AppError(422, message, code);
const check = signal => { if (signal?.aborted) throw new AppError(499, '操作已取消。', 'REQUEST_CANCELLED'); };

function imageMatchesMime(bytes, mime) {
  if (mime === 'png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === 'jpeg') return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  return bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
}

function label(value, index, clean) {
  const source = typeof value === 'string' && value.trim() ? value : `工具画面${index}`;
  return String(clean(source)).replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/gi, 'Bearer [已隐藏]')
    .replace(/\b(?:sk|sess)-[A-Za-z0-9_-]{12,}/g, '[已隐藏]')
    .replace(/\b[A-Z]:[\\/](?:[^\s<>"'`，。；）)\]}]+[\\/]?)+/gi, '[本机路径]')
    .replace(/\/(?:Users|home|root)\/[^\s<>"'`，。；）)\]}]+/g, '[本机路径]')
    .replace(/[\x00-\x1F\x7F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500) || `工具画面${index}`;
}

/**
 * Normalize only the output of a server-registered tool.images callback.
 * This helper never discovers images in tool arguments/results and never reads
 * paths or URLs. Keep `images` in the current model-call memory; only `summary`
 * is suitable for observations or persisted task evidence.
 */
export function normalizeAssistantToolImages(input, { clean = String, signal } = {}) {
  check(signal);
  if (!Array.isArray(input) || input.length > ASSISTANT_TOOL_IMAGE_LIMITS.count) throw fail('本批工具画面需要是最多12张图片的列表。', 'ASSISTANT_TOOL_IMAGES_LIMIT');
  if (typeof clean !== 'function') throw fail('工具画面标注清理未配置。');
  const images = [], frames = [];
  let totalEncodedBytes = 0;
  for (let position = 0; position < input.length; position++) {
    check(signal);
    const packet = input[position];
    if (!packet || typeof packet !== 'object' || Array.isArray(packet) || typeof packet.dataUrl !== 'string') throw fail('工具没有提供有效的内联画面。');
    const encodedBytes = Buffer.byteLength(packet.dataUrl, 'utf8');
    if (encodedBytes > ASSISTANT_TOOL_IMAGE_LIMITS.imageEncodedBytes) throw fail('单张工具画面超过2MiB，请缩小抽帧尺寸。', 'ASSISTANT_TOOL_IMAGES_BYTES');
    totalEncodedBytes += encodedBytes;
    if (totalEncodedBytes > ASSISTANT_TOOL_IMAGE_LIMITS.batchEncodedBytes) throw fail('本批工具画面超过8MiB，请减少每批数量或缩小抽帧尺寸。', 'ASSISTANT_TOOL_IMAGES_BYTES');
    const match = dataImage.exec(packet.dataUrl);
    if (!match) throw fail('工具画面必须是JPEG、PNG或WebP内联图片，不能使用路径或网址。');
    const bytes = Buffer.from(match[2], 'base64');
    if (!bytes.length || bytes.toString('base64').replace(/=+$/, '') !== match[2].replace(/=+$/, '') || !imageMatchesMime(bytes, match[1])) throw fail('工具画面的实际编码与图片类型不一致。');
    const index = packet.index === undefined ? position + 1 : packet.index;
    if (!Number.isSafeInteger(index) || index < 1 || packet.timestamp !== undefined && (!Number.isFinite(packet.timestamp) || packet.timestamp < 0)) throw fail('工具画面缺少有效的编号或时间位置。', 'ASSISTANT_TOOL_IMAGE_METADATA');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (packet.sha256 !== undefined && (typeof packet.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(packet.sha256) || packet.sha256.toLowerCase() !== sha256)) throw fail('工具画面与来源校验值不一致，请重新读取。', 'ASSISTANT_TOOL_IMAGE_PROVENANCE');
    const detail = packet.detail === undefined ? 'low' : packet.detail;
    if (!['low', 'high', 'auto'].includes(detail)) throw fail('工具画面清晰度选项无效。', 'ASSISTANT_TOOL_IMAGE_METADATA');
    const safeLabel = label(packet.label, index, clean);
    images.push({ dataUrl: packet.dataUrl, label: safeLabel, detail });
    frames.push({ index, ...(packet.timestamp === undefined ? {} : { timestamp: packet.timestamp }), label: safeLabel, mimeType: `image/${match[1]}`, bytes: bytes.length, encodedBytes, sha256, detail });
  }
  check(signal);
  return { images, summary: { frameCount: frames.length, totalEncodedBytes, frames } };
}
