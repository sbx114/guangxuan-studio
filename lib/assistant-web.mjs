import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { createHash } from 'node:crypto';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { AppError } from './errors.mjs';
import { isPublicReferenceAddress } from './reference-url.mjs';
import { discoverMaterialCandidates, rankMaterialCandidates, normalizeMaterialProvenance } from './assistant-materials.mjs';

const MAX_URL = 8192, MAX_QUERY = 800, MAX_REDIRECTS = 5;
const TIMEOUT = 30000, IDLE_TIMEOUT = 12000, MAX_BYTES = 12 * 1024 * 1024, MAX_DECODED = 16 * 1024 * 1024;
const DOWNLOAD_TIMEOUT = 120000, MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const TRACKING = /^(?:utm_.+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|yclid|_ga)$/i;
const SENSITIVE_PARAMETER = /^(?:key|api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|passwd|secret|authorization|auth|signature|x-amz-.+|x-goog-.+)$/i;
const SECRET = /(?:\b(?:sk|sess|ghp|gho|github_pat)[-_][A-Za-z0-9_-]{12,}|\b(?:AKIA[A-Z\d]{16}|AIza[A-Za-z\d_-]{30,})\b|\bBearer\s+\S+|(?:api[-_ ]?key|access[-_ ]?token|authorization|password|secret)\s*[:=]\s*\S+)/i;
const PRIVATE_PATH = /(?:\b[A-Z]:[\\/]|\\\\[A-Za-z0-9_.-]+[\\/]|(?:^|\s)\/(?:Users|home|root|etc|private|AppData)(?:\/|\b))/i;
const USER_AGENT = 'GxAssistant/1.0';
const fail = (status, code, message) => new AppError(status, message, 'ASSISTANT_WEB_' + code);
const cancelled = () => fail(499, 'CANCELLED', '联网操作已取消。');
const timedOut = () => fail(504, 'TIMEOUT', '联网读取超时，请稍后重试或更换网址。');
const abortReason = signal => signal?.reason instanceof AppError ? signal.reason : cancelled();
const check = signal => { if (signal?.aborted) throw abortReason(signal); };
const sourceId = url => 'web-' + createHash('sha256').update(url).digest('hex').slice(0, 20);
const header = (response, name) => { const value = response.headers?.[name]; return Array.isArray(value) ? value[0] : value; };

async function abortable(promise, signal) {
  check(signal); if (!signal) return promise;
  let stop;
  try { return await Promise.race([promise, new Promise((_, reject) => { stop = () => reject(abortReason(signal)); signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop(); })]); }
  finally { if (stop) signal.removeEventListener('abort', stop); }
}

function parseUrl(value, { httpsOnly = false } = {}) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_URL || /[\u0000-\u0020\u007f]/.test(value.trim())) throw fail(400, 'URL_INVALID', '请提供完整的 HTTP 或 HTTPS 网址。');
  let url;
  try { url = new URL(value.trim()); } catch { throw fail(400, 'URL_INVALID', '网址格式不正确。'); }
  if (!['http:', 'https:'].includes(url.protocol) || (httpsOnly && url.protocol !== 'https:') || url.username || url.password) throw fail(400, 'URL_INVALID', '仅支持不含账号密码的公开 HTTP 或 HTTPS 网址。');
  if (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80')) throw fail(400, 'URL_PORT', '联网读取只支持标准 HTTP 和 HTTPS 端口。');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!hostname || hostname === 'localhost' || /(?:^|\.)(?:localhost|local|internal|lan|home|invalid|test)$/.test(hostname) || !hostname.includes('.') && !net.isIP(hostname)) throw fail(400, 'URL_PRIVATE', '不能访问本机、内网或云元数据地址。');
  if (net.isIP(hostname) && !isPublicReferenceAddress(hostname)) throw fail(400, 'URL_PRIVATE', '不能访问本机、内网或云元数据地址。');
  if (SECRET.test(decodeURIComponentSafe(url.href)) || [...url.searchParams.keys()].some(key => SENSITIVE_PARAMETER.test(key))) throw fail(400, 'URL_SENSITIVE', '网址含有登录凭据或访问密钥，请提供公开网址。');
  url.hash = ''; for (const key of [...url.searchParams.keys()]) if (TRACKING.test(key)) url.searchParams.delete(key);
  return { url, hostname };
}
function decodeURIComponentSafe(value) { try { return decodeURIComponent(value); } catch { return value; } }

/** Syntactic public-URL policy only; the actual request must still resolve and pin DNS. */
export function normalizePublicAssistantUrl(value) { return parseUrl(value).url.href; }

export async function resolvePublicAssistantUrl(value, { lookup = dnsLookup, signal, httpsOnly = false } = {}) {
  check(signal); const parsed = parseUrl(value, { httpsOnly }); let addresses;
  if (net.isIP(parsed.hostname)) addresses = [{ address: parsed.hostname, family: net.isIP(parsed.hostname) }];
  else {
    try { addresses = await abortable(lookup(parsed.hostname, { all: true, verbatim: true }), signal); }
    catch (error) { check(signal); if (error instanceof AppError) throw error; throw fail(422, 'DNS', '无法解析该网址，请检查网址或网络。'); }
  }
  check(signal);
  if (!Array.isArray(addresses) || !addresses.length || addresses.length > 64 || addresses.some(item => !isPublicReferenceAddress(item?.address))) throw fail(400, 'URL_PRIVATE', '网址解析到了非公网地址，已停止读取。');
  const selected = addresses.find(item => net.isIP(item.address) === 4) || addresses[0];
  return { ...parsed, address: selected.address, family: net.isIP(selected.address) };
}

// Re-resolution by the OS or HTTP pool would permit DNS rebinding. Connect only
// to the validated address; retain the URL hostname for Host and TLS validation.
export function requestPinnedAssistantUrl(target, { signal, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const client = target.url.protocol === 'https:' ? https : http;
    const request = client.request(target.url, {
      method: 'GET', agent: false, signal, autoSelectFamily: false, family: target.family,
      lookup: (_host, options, done) => options?.all ? done(null, [{ address: target.address, family: target.family }]) : done(null, target.address, target.family),
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml,application/pdf,text/plain,application/xml;q=0.9,*/*;q=0.2', 'Accept-Encoding': 'gzip, deflate, br', ...headers },
    }, resolve);
    request.setTimeout(IDLE_TIMEOUT, () => request.destroy(timedOut()));
    request.once('error', reject); request.end();
  });
}

async function openResponse(value, { lookup, request, signal }) {
  let next = value, httpsOnly = false;
  for (let count = 0; count <= MAX_REDIRECTS; count++) {
    const target = await resolvePublicAssistantUrl(next, { lookup, signal, httpsOnly });
    const response = await abortable(request(target, { signal }), signal);
    check(signal);
    if (!REDIRECTS.has(response.statusCode)) return { response, url: target.url.href };
    const location = header(response, 'location'); response.destroy();
    if (!location || count === MAX_REDIRECTS) throw fail(422, 'REDIRECT', '网址跳转过多或跳转地址无效。');
    try { next = new URL(location, target.url).href; } catch { throw fail(422, 'REDIRECT', '网址的跳转地址无效。'); }
    if (target.url.protocol === 'https:') httpsOnly = true;
  }
}

async function responseBytes(response, { signal, maxBytes, maxDecodedBytes, onProgress }) {
  const length = Number(header(response, 'content-length'));
  if (Number.isFinite(length) && length > maxBytes) { response.destroy(); throw fail(413, 'TOO_LARGE', '网页或文件过大，请提供更短的网页或分段材料。'); }
  const encoding = (header(response, 'content-encoding') || 'identity').trim().toLowerCase();
  const decoder = encoding === 'gzip' || encoding === 'x-gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : null;
  if (!decoder && encoding !== 'identity') { response.destroy(); throw fail(415, 'ENCODING', '该网页的压缩格式暂不支持。'); }
  let wireBytes = 0, decodedBytes = 0, lastProgress = 0; const chunks = [];
  const progress = (force = false) => {
    if (typeof onProgress !== 'function' || !force && Date.now() - lastProgress < 200) return;
    lastProgress = Date.now();
    try { Promise.resolve(onProgress({ receivedBytes: wireBytes, ...(Number.isFinite(length) && length > 0 ? { totalBytes: length } : {}) })).catch(() => {}); } catch {}
  };
  progress(true);
  const wireLimit = new Transform({ transform(chunk, _encoding, done) { wireBytes += chunk.length; progress(); done(wireBytes > maxBytes ? fail(413, 'TOO_LARGE', '网页下载超过大小限制。') : null, chunk); } });
  const output = new Writable({ write(chunk, _encoding, done) { decodedBytes += chunk.length; if (decodedBytes > maxDecodedBytes) return done(fail(413, 'TOO_LARGE', '网页解压后的内容超过大小限制。')); chunks.push(chunk); done(); } });
  try { await pipeline(response, wireLimit, ...(decoder ? [decoder] : []), output, { signal }); check(signal); progress(true); return Buffer.concat(chunks); }
  catch (error) { check(signal); if (error instanceof AppError) throw error; throw fail(422, 'BODY', '网页内容读取失败，可能传输中断或压缩数据损坏。'); }
}

const FILE_TYPES = Object.freeze({
  pdf: { mime: 'application/pdf', extensions: ['pdf'] },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', extensions: ['docx'] },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', extensions: ['pptx'] },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', extensions: ['xlsx'] },
  zip: { mime: 'application/zip', extensions: ['zip'] }, epub: { mime: 'application/epub+zip', extensions: ['epub'] },
  txt: { mime: 'text/plain', extensions: ['txt'] }, md: { mime: 'text/markdown', extensions: ['md', 'markdown'] },
  csv: { mime: 'text/csv', extensions: ['csv'] }, json: { mime: 'application/json', extensions: ['json'] },
  html: { mime: 'text/html', extensions: ['html', 'htm', 'xhtml'] },
  png: { mime: 'image/png', extensions: ['png'] }, jpg: { mime: 'image/jpeg', extensions: ['jpg', 'jpeg'] },
  gif: { mime: 'image/gif', extensions: ['gif'] }, webp: { mime: 'image/webp', extensions: ['webp'] },
  bmp: { mime: 'image/bmp', extensions: ['bmp'] }, ico: { mime: 'image/vnd.microsoft.icon', extensions: ['ico'] },
  avif: { mime: 'image/avif', extensions: ['avif'] }, tiff: { mime: 'image/tiff', extensions: ['tif', 'tiff'] },
  mp4: { mime: 'video/mp4', extensions: ['mp4', 'm4v'] }, mov: { mime: 'video/quicktime', extensions: ['mov'] }, webm: { mime: 'video/webm', extensions: ['webm'] },
  mp3: { mime: 'audio/mpeg', extensions: ['mp3'] }, wav: { mime: 'audio/wav', extensions: ['wav'] }, m4a: { mime: 'audio/mp4', extensions: ['m4a'] },
});
const FILE_EXTENSIONS = new Map(Object.entries(FILE_TYPES).flatMap(([kind, value]) => value.extensions.map(extension => [extension, kind])));
const FILE_MIMES = new Map(Object.entries(FILE_TYPES).map(([kind, value]) => [value.mime, kind]));
for (const [mime, kind] of [
  ['application/x-pdf', 'pdf'], ['application/x-zip-compressed', 'zip'], ['application/x-zip', 'zip'],
  ['text/x-markdown', 'md'], ['application/csv', 'csv'], ['text/comma-separated-values', 'csv'],
  ['application/ld+json', 'json'], ['text/json', 'json'], ['application/xhtml+xml', 'html'],
  ['image/jpg', 'jpg'], ['image/pjpeg', 'jpg'], ['image/x-icon', 'ico'], ['image/x-ms-bmp', 'bmp'],
  ['video/x-m4v', 'mp4'], ['audio/mp3', 'mp3'], ['audio/x-wav', 'wav'], ['audio/wave', 'wav'], ['audio/x-m4a', 'm4a'],
]) FILE_MIMES.set(mime, kind);
const ZIP_TYPES = new Set(['zip', 'docx', 'pptx', 'xlsx', 'epub']);
const TEXT_TYPES = new Set(['txt', 'md', 'csv', 'json', 'html']);
const GENERIC_MIMES = new Set(['', 'application/octet-stream', 'application/binary', 'binary/octet-stream', 'application/download', 'application/x-download', 'application/force-download']);
const ACTIVE_EXTENSION = /^(?:exe|com|bat|cmd|ps1|psm1|psd1|js|mjs|cjs|jsx|ts|tsx|vbs|vbe|wsf|wsh|hta|lnk|url|scf|dll|msi|msp|mst|scr|pif|cpl|ocx|sys|drv|reg|jar|jse|chm|application|appref-ms|gadget|sh|bash|zsh|fish|py|pyw|pl|pm|rb|php\d*|phar|asp|aspx|jsp|jspx|cgi|docm|dotm|xlsm|xlam|xltm|pptm|ppam|potm|ppsm|sldm)$/i;
const ACTIVE_MIME = /(?:javascript|ecmascript|x-msdownload|x-msdos-program|x-dosexec|portable-executable|x-msi|x-bat|x-sh(?:$|;)|x-powershell|x-python|x-perl|x-php|x-ruby|x-java-archive|macroenabled)/i;
const extensionOf = name => /\.([^.]*)$/.exec(name)?.[1]?.toLowerCase() || '';
function safeDownloadName(value) {
  let name = String(value || '').normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '');
  name = name.split(/[\\/]/).filter(Boolean).at(-1) || '';
  name = name.replace(/[<>:"|?*]/g, '_').replace(/^\.+/, '').replace(/[. ]+$/, '').trim();
  if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$|clock\$)(?:\.|$)/i.test(name)) name = '_' + name;
  name ||= 'download';
  const suffix = /\.[a-z\d]{1,16}$/i.exec(name)?.[0] || '';
  return Array.from(suffix ? name.slice(0, -suffix.length) : name).slice(0, 180 - suffix.length).join('') + suffix;
}
function dispositionFilename(value) {
  if (typeof value !== 'string' || value.length > 16384) return '';
  const extended = /(?:^|;)\s*filename\*\s*=\s*(?:"([^"]*)"|([^;]*))/i.exec(value);
  if (extended) {
    const raw = (extended[1] ?? extended[2]).trim(), parts = /^([^']*)'[^']*'(.*)$/.exec(raw);
    if (parts) {
      try {
        const values = [];
        for (let at = 0; at < parts[2].length; at++) {
          if (parts[2][at] === '%') { if (!/^[\da-f]{2}$/i.test(parts[2].slice(at + 1, at + 3))) throw new Error('Invalid encoded filename'); values.push(Number.parseInt(parts[2].slice(at + 1, at + 3), 16)); at += 2; }
          else { const number = parts[2].charCodeAt(at); if (number > 127) throw new Error('Invalid encoded filename'); values.push(number); }
        }
        return new TextDecoder(parts[1] || 'utf-8', { fatal: true }).decode(new Uint8Array(values));
      } catch {}
    }
  }
  const ordinary = /(?:^|;)\s*filename\s*=\s*(?:"((?:\\.|[^"])*)"|([^;]*))/i.exec(value);
  return (ordinary?.[1]?.replace(/\\(["\\])/g, '$1') ?? ordinary?.[2] ?? '').trim();
}
function urlFilename(url) { return decodeURIComponentSafe(new URL(url).pathname.split('/').filter(Boolean).at(-1) || 'download'); }
function textFile(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe || buffer[0] === 0xfe && buffer[1] === 0xff) return true;
  if (buffer.includes(0)) return false;
  const sample = buffer.subarray(0, 65536); let controls = 0;
  for (const byte of sample) if (byte < 32 && ![9, 10, 12, 13].includes(byte) || byte === 127) controls++;
  return controls <= Math.max(0, sample.length * .005);
}
function detectedFileKind(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (buffer.length >= 4 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'jpg';
  if (buffer.length >= 13 && /^(?:GIF87a|GIF89a)$/.test(buffer.subarray(0, 6).toString('ascii'))) return 'gif';
  if (buffer.length >= 16 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (buffer.length >= 14 && buffer.subarray(0, 2).toString('ascii') === 'BM') return 'bmp';
  if (buffer.length >= 6 && buffer.readUInt32LE(0) === 0x10000 && buffer.readUInt16LE(4) > 0) return 'ico';
  if (buffer.length >= 16 && buffer.subarray(4, 8).toString('ascii') === 'ftyp' && /(?:avif|avis)/.test(buffer.subarray(8, 64).toString('ascii'))) return 'avif';
  if (buffer.length >= 16 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') { const brands = buffer.subarray(8, 64).toString('ascii'); return /M4A |M4B /.test(brands) ? 'm4a' : /qt  /.test(brands) ? 'mov' : 'mp4'; }
  if (buffer.length >= 16 && buffer.subarray(0, 4).toString('hex') === '1a45dfa3' && buffer.subarray(0, 4096).includes(Buffer.from('webm'))) return 'webm';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WAVE') return 'wav';
  if (buffer.length >= 4 && (buffer.subarray(0, 3).toString('ascii') === 'ID3' || buffer[0] === 255 && (buffer[1] & 224) === 224 && (buffer[1] & 6) !== 0)) return 'mp3';
  if (buffer.length >= 8 && ['49492a00', '4d4d002a', '49492b00', '4d4d002b'].includes(buffer.subarray(0, 4).toString('hex'))) return 'tiff';
  if (/^[\x09\x0a\x0c\x0d\x20]*%PDF-[12]\.\d\b/.test(buffer.subarray(0, 1024).toString('latin1').replace(/^\xef\xbb\xbf/, ''))) return 'pdf';
  if (buffer.length >= 4 && ['504b0304', '504b0506', '504b0708'].includes(buffer.subarray(0, 4).toString('hex'))) return 'zip';
  const start = buffer.subarray(0, 4096).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (/^(?:<\?xml[^>]*>\s*)?(?:<!doctype\s+html\b|<(?:html|head|body|title|meta|main|article|section|div|p|h[1-6]|script|table)\b)/i.test(start)) return 'html';
  return '';
}
function validateJsonDownload(buffer, contentType, signal) {
  if (buffer.length <= 256 * 1024) {
    try { JSON.parse(textDecode(buffer, contentType).replace(/^\uFEFF/, '')); return Promise.resolve(); }
    catch { return Promise.reject(fail(422, 'DOWNLOAD_TYPE_MISMATCH', '网站返回的内容不是有效JSON，未保存下载。')); }
  }
  return new Promise((resolve, reject) => {
    check(signal);
    const worker = new Worker(new URL(import.meta.url), { workerData: { operation: 'gx-assistant-json', bytes: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength), contentType }, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 8 } });
    let settled = false;
    const stop = () => finish(abortReason(signal));
    async function finish(error) { if (settled) return; settled = true; signal?.removeEventListener('abort', stop); await worker.terminate().catch(() => {}); error ? reject(error) : resolve(); }
    signal?.addEventListener('abort', stop, { once: true }); if (signal?.aborted) return stop();
    worker.once('message', value => finish(value?.ok ? null : fail(422, 'DOWNLOAD_TYPE_MISMATCH', '网站返回的内容不是有效JSON，未保存下载。')));
    worker.once('error', () => finish(fail(422, 'DOWNLOAD_FORMAT_RESOURCE', 'JSON校验超过可用解析资源，请下载更小的文件。')));
    worker.once('exit', () => { if (!settled) finish(fail(422, 'DOWNLOAD_TYPE_MISMATCH', 'JSON未能完成格式校验，未保存下载。')); });
  });
}
async function validateDownloadedFile(buffer, { url, originalUrl, contentType, disposition, signal }) {
  if (!buffer.length) throw fail(422, 'DOWNLOAD_EMPTY', '网站返回了空文件，未保存下载。');
  if (buffer.subarray(0, 2).toString('ascii') === 'MZ' || buffer.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]))) throw fail(415, 'DOWNLOAD_ACTIVE', '不支持下载可执行程序、脚本或系统组件。');
  const mime = contentType.split(';')[0].trim().toLowerCase(), supplied = dispositionFilename(disposition);
  const rawNames = [supplied, urlFilename(url), urlFilename(originalUrl)].filter(Boolean);
  const names = rawNames.map(safeDownloadName);
  if (ACTIVE_MIME.test(mime) || names.some(name => ACTIVE_EXTENSION.test(extensionOf(name))) || rawNames.some(name => ACTIVE_EXTENSION.test(extensionOf(name.trim().replace(/[. ]+$/, ''))))) throw fail(415, 'DOWNLOAD_ACTIVE', '不支持下载可执行程序、脚本、宏文档或系统组件。');
  const candidate = names[0] || 'download', extension = extensionOf(candidate), extensionKind = FILE_EXTENSIONS.get(extension);
  const mimeKind = FILE_MIMES.get(mime), generic = GENERIC_MIMES.has(mime), detected = detectedFileKind(buffer), warnings = [];
  if (!mimeKind && !generic) throw fail(415, 'DOWNLOAD_TYPE', '该文件格式暂不支持下载，请提供文档、图片、常用单文件音视频或ZIP/EPUB。');
  if (generic && !extensionKind) throw fail(415, 'DOWNLOAD_TYPE', '网站未声明文件类型，也没有可识别的允许扩展名，未保存下载。');
  if (detected === 'html' && names.some(name => { const kind = FILE_EXTENSIONS.get(extensionOf(name)); return kind && !TEXT_TYPES.has(kind); })) throw fail(422, 'DOWNLOAD_TYPE_MISMATCH', '下载地址返回了网页或登录页，而非所需原文件。请提供可公开下载的文件直链。');
  if (mimeKind === 'pdf' && detected !== 'pdf' || ZIP_TYPES.has(mimeKind) && detected !== 'zip' || mimeKind && !TEXT_TYPES.has(mimeKind) && !ZIP_TYPES.has(mimeKind) && mimeKind !== 'pdf' && mimeKind !== detected) throw fail(422, 'DOWNLOAD_TYPE_MISMATCH', '文件正文与网站声明的格式不符，未保存下载。');
  let kind;
  if (detected === 'zip') kind = mimeKind !== 'zip' && ZIP_TYPES.has(mimeKind) ? mimeKind : ZIP_TYPES.has(extensionKind) ? extensionKind : 'zip';
  else if (detected && detected !== 'html') kind = detected;
  else if (detected === 'html') kind = 'html';
  else {
    kind = mimeKind || extensionKind;
    if (!TEXT_TYPES.has(kind) || !textFile(buffer)) throw fail(422, 'DOWNLOAD_TYPE_MISMATCH', '文件没有匹配的格式标记或有效文本内容，未保存下载。');
    if (kind === 'html') throw fail(422, 'DOWNLOAD_TYPE_MISMATCH', '网站声明HTML，但未获取到可识别的HTML文件。');
    if (kind === 'json') await validateJsonDownload(buffer, contentType, signal);
  }
  if (generic && kind !== extensionKind && !(ZIP_TYPES.has(kind) && ZIP_TYPES.has(extensionKind))) throw fail(422, 'DOWNLOAD_TYPE_MISMATCH', '文件标记与扩展名不符，未保存下载。');
  if (!FILE_TYPES[kind]) throw fail(415, 'DOWNLOAD_TYPE', '该文件格式暂不支持下载。');
  const acceptedExtensions = FILE_TYPES[kind].extensions;
  let fileName = candidate;
  if (!acceptedExtensions.includes(extension)) {
    const stem = extension ? candidate.slice(0, -(extension.length + 1)) : candidate;
    fileName = safeDownloadName((stem || 'download') + '.' + acceptedExtensions[0]);
    warnings.push({ code: 'DOWNLOAD_EXTENSION_NORMALIZED', message: '已根据实际文件类型设置下载扩展名。' });
  }
  if (ZIP_TYPES.has(kind)) warnings.push({ code: 'DOWNLOAD_ARCHIVE_NOT_EXTRACTED', message: '已核对ZIP容器标记，仅保存原文件，未解压或执行其中内容。' });
  if (kind === 'html') warnings.push({ code: 'DOWNLOAD_HTML_SAVED', message: '保存的是原始HTML网页文件；未执行网页脚本或将其伪装成PDF。' });
  if (/^(?:video|audio)\//.test(FILE_TYPES[kind].mime)) warnings.push({ code: 'DOWNLOAD_MEDIA_UNPROBED', message: '已保存完整原媒体字节；实际时长、画幅和音轨需在媒体导入后核对。' });
  return { fileName, contentType: FILE_TYPES[kind].mime, warnings };
}

const ENTITIES = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', ndash: '–', mdash: '—', hellip: '…', copy: '©', reg: '®', trade: '™', laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', middot: '·', times: '×', divide: '÷', minus: '−', micro: 'µ', alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', theta: 'θ', lambda: 'λ', pi: 'π', sigma: 'σ', phi: 'φ', omega: 'ω', prime: '′', deg: '°', plusmn: '±', le: '≤', ge: '≥', ne: '≠', rarr: '→', larr: '←' });
function entities(value) {
  return String(value || '').replace(/&(#x[\da-f]{1,6}|#\d{1,7}|[a-z][a-z\d]{1,20});/gi, (whole, entity) => {
    if (entity[0] !== '#') return ENTITIES[entity] ?? ENTITIES[entity.toLowerCase()] ?? whole;
    const number = Number.parseInt(entity.slice(entity[1].toLowerCase() === 'x' ? 2 : 1), entity[1].toLowerCase() === 'x' ? 16 : 10);
    return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : ' ';
  });
}
function plain(value) { return entities(value.replace(/<[^>]*>/g, ' ')).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\s+/g, ' ').replace(/\s+([,.;:!?，。；：！？])/g, '$1').trim(); }
function attribute(tag, name) {
  const match = new RegExp('(?:^|\\s)' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i').exec(tag);
  return entities(match?.[1] ?? match?.[2] ?? match?.[3] ?? '');
}
function textDecode(bytes, contentType) {
  const head = bytes.subarray(0, 4096).toString('ascii');
  const charset = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1] || /<meta[^>]*charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1] || 'utf-8';
  try { return new TextDecoder(charset).decode(bytes); } catch { return bytes.toString('utf8'); }
}
function paragraphBudget(text, maxChars) {
  const paragraphs = []; let used = 0, truncated = false;
  for (const match of text.replace(/\r\n?/g, '\n').matchAll(/[^\n]+/g)) {
    let remaining = match[0].replace(/[ \t\f\v]+/g, ' ').trim();
    while (remaining) {
      const available = maxChars - used - (paragraphs.length ? 2 : 0);
      if (available <= 0) { truncated = true; break; }
      let end = Math.min(remaining.length, available, 2500);
      if (end < remaining.length && end > 100) { const split = Math.max(remaining.lastIndexOf(' ', end), remaining.lastIndexOf('。', end)); if (split > end / 2) end = split + 1; }
      const part = remaining.slice(0, end).trim(); remaining = remaining.slice(end).trim();
      if (part) { used += part.length + (paragraphs.length ? 2 : 0); paragraphs.push({ id: 'p' + (paragraphs.length + 1), text: part }); }
      if (used >= maxChars && remaining) truncated = true;
    }
    if (truncated) break;
  }
  return { text: paragraphs.map(item => item.text).join('\n\n'), paragraphs, truncated };
}
function htmlDocument(html, url, maxChars) {
  const title = plain(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1] || '').slice(0, 300);
  let body = html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|template|svg|canvas|iframe|object)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  const sourceHtml = body;
  const materials = discoverMaterialCandidates(sourceHtml, url, { attribute, plain, normalizeUrl: normalizePublicAssistantUrl, title });
  let baseUrl = url;
  const baseHref = [...sourceHtml.matchAll(/<base\b([^>]*)>/gi)].map(match => attribute(match[1], 'href')).find(Boolean);
  if (baseHref) try { baseUrl = new URL(baseHref, url).href; } catch { baseUrl = 'data:invalid-base'; }
  body = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec(body)?.[1] || body.replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/i, ' ');
  const main = /<main\b[^>]*>([\s\S]*?)<\/main\s*>/i.exec(body)?.[1];
  let article = ''; for (const match of body.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article\s*>/gi)) if (match[1].length > article.length) article = match[1];
  body = (main && plain(main).length > 80 ? main : article && plain(article).length > 120 ? article : body).replace(/<(nav|footer|header|aside|form|button|select)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  const links = [], seen = new Set();
  const addLink = (href, label) => {
    if (links.length >= 20 || !href || !label || href.startsWith('#')) return;
    try { const link = normalizePublicAssistantUrl(new URL(href, baseUrl).href); if (!seen.has(link)) { seen.add(link); links.push({ title: plain(label).slice(0, 180), url: link }); } } catch {}
  };
  // These are literal URLs already present in the fetched HTML. Discovering a
  // media candidate never downloads it or treats it as an already-read source.
  for (const match of sourceHtml.matchAll(/<(video|source)\b([^>]*)>/gi)) {
    const type = attribute(match[2], 'type'); if (type && !/^video\//i.test(type)) continue;
    addLink(attribute(match[2], 'src'), attribute(match[2], 'title') || attribute(match[2], 'aria-label') || (title || new URL(url).hostname) + ' · 视频');
  }
  for (const match of sourceHtml.matchAll(/<meta\b([^>]*)>/gi)) {
    if (!/^og:video(?::(?:url|secure_url))?$/i.test(attribute(match[1], 'property') || attribute(match[1], 'name'))) continue;
    addLink(attribute(match[1], 'content'), (title || new URL(url).hostname) + ' · 视频');
  }
  for (const match of sourceHtml.matchAll(/<img\b([^>]*)>/gi)) {
    if (links.length >= 12) break;
    const label = attribute(match[1], 'alt') || attribute(match[1], 'title') || (title || new URL(url).hostname) + ' · 图片';
    for (const key of ['data-original', 'data-src', 'src']) addLink(attribute(match[1], key), label);
  }
  for (const match of sourceHtml.matchAll(/<meta\b([^>]*)>/gi)) {
    if (!/^og:image(?::(?:url|secure_url))?$/i.test(attribute(match[1], 'property') || attribute(match[1], 'name'))) continue;
    if (links.length < 14) addLink(attribute(match[1], 'content'), (title || new URL(url).hostname) + ' · 图片');
  }
  for (const match of body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const href = attribute(match[1], 'href');
    if (/\.(?:mp4|webm|mov|m4v|avi|ogv|ts)(?:[?#]|$)/i.test(href)) addLink(href, plain(match[2]) || (title || new URL(url).hostname) + ' · 视频');
  }
  for (const match of body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    if (links.length >= 20) break;
    const href = attribute(match[1], 'href'), label = plain(match[2]).slice(0, 180);
    addLink(href, label);
  }
  const text = body.replace(/<(?:br|hr)\b[^>]*\/?\s*>/gi, '\n').replace(/<\/(?:p|div|section|article|main|h[1-6]|li|tr|pre|blockquote|ul|ol|table)\s*>/gi, '\n').replace(/<li\b[^>]*>/gi, '\n• ').replace(/<[^>]*>/g, ' ');
  const cleaned = entities(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  const result = paragraphBudget(cleaned, maxChars);
  if (result.text.length < 5000 && /(?:just a moment|checking your browser|verify (?:that )?you are human|enable javascript and cookies|access denied|robot check|captcha|安全验证|访问验证|人机验证|请完成验证)/i.test(title + '\n' + result.text)) throw fail(422, 'BLOCKED', '网站要求登录或访问验证，当前无法读取正文。请换用公开页面或粘贴材料。');
  if (result.text.length < 40 && !materials.materialCandidates.length) throw fail(422, 'NO_TEXT', /<script\b/i.test(html) ? '该页面主要由脚本加载或需要登录，未获取到可用正文。可以换用公开页面或粘贴材料。' : '该网页没有可提取的正文。');
  return { title: title || new URL(url).hostname, ...result, links, ...materials, textAvailable: result.text.length >= 40 };
}

// HTML is untrusted input. Keep malformed-markup regular expressions away from
// the server event loop, with an abortable, memory-bounded parsing worker.
function htmlDocumentWorker(html, url, maxChars, signal) {
  return new Promise((resolve, reject) => {
    check(signal);
    const worker = new Worker(new URL(import.meta.url), { workerData: { operation: 'gx-assistant-html', html, url, maxChars }, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 8 } });
    let settled = false;
    const stop = () => finish(abortReason(signal));
    async function finish(error, value) { if (settled) return; settled = true; signal?.removeEventListener('abort', stop); await worker.terminate().catch(() => {}); error ? reject(error) : resolve(value); }
    signal?.addEventListener('abort', stop, { once: true }); if (signal?.aborted) return stop();
    worker.once('message', value => {
      if (!value?.ok) return finish(new AppError(value?.error?.status || 422, value?.error?.message || '该网页未能完成正文提取。', value?.error?.code || 'ASSISTANT_WEB_HTML_INVALID'));
      finish(null, value.result);
    });
    worker.once('error', () => finish(fail(422, 'HTML_INVALID', '该网页无法解析或超过资源限制，可以换用其他页面或粘贴正文。')));
    worker.once('exit', () => { if (!settled) finish(fail(422, 'HTML_INVALID', '该网页未能完成正文提取。')); });
  });
}

function pdfDocument(bytes, signal) {
  return new Promise((resolve, reject) => {
    check(signal);
    const worker = new Worker(new URL('./science-document-worker.mjs', import.meta.url), { workerData: { bytes: new Uint8Array(bytes), format: 'pdf' }, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 8 } });
    let settled = false;
    const stop = () => finish(abortReason(signal));
    async function finish(error, value) { if (settled) return; settled = true; signal?.removeEventListener('abort', stop); await worker.terminate().catch(() => {}); error ? reject(error) : resolve(value); }
    signal?.addEventListener('abort', stop, { once: true }); if (signal?.aborted) return stop();
    worker.once('message', value => {
      if (!value?.ok) return finish(fail(422, value?.error?.code === 'SCIENCE_PDF_NO_TEXT' ? 'PDF_NO_TEXT' : 'PDF_INVALID', value?.error?.message || '该PDF无法提取正文；扫描件尚未执行OCR。'));
      finish(null, value.result);
    });
    worker.once('error', () => finish(fail(422, 'PDF_INVALID', '该PDF解析失败或超过资源限制，请拆分后重试。')));
    worker.once('exit', () => { if (!settled) finish(fail(422, 'PDF_INVALID', '该PDF未能完成文字提取。')); });
  });
}

function queryValue(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_QUERY || /[\u0000-\u001f\u007f]/.test(value)) throw fail(400, 'QUERY_INVALID', '请提供不超过800字的搜索关键词。');
  if (SECRET.test(value) || PRIVATE_PATH.test(value) || /[?&](?:key|token|password|api_key|access_token)=/i.test(value)) throw fail(400, 'QUERY_SENSITIVE', '搜索词包含访问密钥或本机文件路径，请删除后重试。');
  return value.trim();
}
function rssResults(xml, limit) {
  if (!/<rss\b/i.test(xml)) throw fail(502, 'SEARCH_BLOCKED', '搜索服务未返回检索结果，可能暂时受限。');
  const result = [], seen = new Set();
  const field = (item, tag) => plain(entities((new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)<\\/' + tag + '\\s*>', 'i').exec(item)?.[1] || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')));
  for (const match of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item\s*>/gi)) {
    try {
      const item = match[1], url = parseUrl(field(item, 'link')).url.href, title = field(item, 'title').slice(0, 300), snippet = field(item, 'description').slice(0, 1400);
      if (!title || seen.has(url)) continue;
      seen.add(url); const id = sourceId(url); result.push({ id, sourceId: id, title, url, snippet });
      if (result.length >= limit) break;
    } catch {}
  }
  if (!result.length) throw fail(422, 'SEARCH_EMPTY', '未检索到可用的公开结果，请调整关键词或直接提供网址。');
  return result;
}

/** Public GET tools only. Dependency injection is construction-time test plumbing;
 * it is deliberately not accepted in search/read inputs or HTTP request fields. */
export function createAssistantWebService({ root: _root, dependencies = {}, timeoutMs = TIMEOUT, maxBytes = MAX_BYTES, maxDecodedBytes = MAX_DECODED, downloadTimeoutMs = DOWNLOAD_TIMEOUT, maxDownloadBytes = MAX_DOWNLOAD_BYTES } = {}) {
  const lookup = dependencies.lookup || dnsLookup, request = dependencies.request || requestPinnedAssistantUrl;
  const serviceAbort = new AbortController(), operations = new Set(); let closed = false, activeDownloads = 0;
  const candidates = new Map();
  timeoutMs = Math.max(1, Math.min(60000, Number(timeoutMs) || TIMEOUT));
  maxBytes = Math.max(1, Math.min(MAX_BYTES, Number(maxBytes) || MAX_BYTES));
  maxDecodedBytes = Math.max(1, Math.min(MAX_DECODED, Number(maxDecodedBytes) || MAX_DECODED));
  downloadTimeoutMs = Math.max(1, Math.min(DOWNLOAD_TIMEOUT, Number(downloadTimeoutMs) || DOWNLOAD_TIMEOUT));
  maxDownloadBytes = Math.max(1, Math.min(MAX_DOWNLOAD_BYTES, Number(maxDownloadBytes) || MAX_DOWNLOAD_BYTES));
  function operation(external, run, duration = timeoutMs) {
    if (closed) return Promise.reject(cancelled());
    if (operations.size >= 8) return Promise.reject(fail(429, 'BUSY', '同时联网操作过多，请稍后重试。'));
    const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(timedOut()), duration); timer.unref();
    const signal = AbortSignal.any([serviceAbort.signal, timeout.signal, ...(external ? [external] : [])]);
    const pending = Promise.resolve().then(() => { check(signal); return run(signal); }).catch(error => { check(signal); if (error instanceof AppError) throw error; throw fail(502, 'NETWORK', '无法连接公开网站，请检查网络或更换网址。'); }).finally(() => { clearTimeout(timer); operations.delete(pending); });
    operations.add(pending); return pending;
  }
  async function fetchBytes(value, signal, { download = false, onProgress } = {}) {
    const { response, url } = await openResponse(value, { lookup, request, signal });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const status = response.statusCode; response.destroy();
      throw fail(422, status === 401 || status === 403 || status === 429 ? 'BLOCKED' : 'HTTP', status === 401 || status === 403 || status === 429 ? '网站拒绝公开读取或要求访问验证，请更换网址。' : '网页未能成功返回（HTTP ' + status + '）。');
    }
    if (download && (response.statusCode === 206 || header(response, 'content-range'))) { response.destroy(); throw fail(422, 'DOWNLOAD_PARTIAL', '网站只返回了部分文件，未保存不完整下载。请换用完整文件直链。'); }
    const contentType = header(response, 'content-type') || '';
    const disposition = header(response, 'content-disposition') || '';
    return { bytes: await responseBytes(response, { signal, maxBytes: download ? maxDownloadBytes : maxBytes, maxDecodedBytes: download ? maxDownloadBytes : maxDecodedBytes, onProgress }), url, contentType, disposition };
  }
  const service = {
    search(query, { signal, limit = 5 } = {}) {
      return operation(signal, async signal => {
        query = queryValue(query); limit = Math.max(1, Math.min(8, Math.floor(Number(limit) || 5)));
        let lastError;
        for (const host of ['www.bing.com', 'cn.bing.com']) {
          check(signal);
          try {
            const endpoint = new URL('https://' + host + '/search'); endpoint.searchParams.set('q', query); endpoint.searchParams.set('format', 'rss');
            const { bytes, contentType } = await fetchBytes(endpoint.href, signal);
            const results = rssResults(textDecode(bytes, contentType), limit);
            return { query, provider: 'Bing', results, retrievedAt: new Date().toISOString(), warnings: [] };
          } catch (error) { check(signal); lastError = error; if (error?.code === 'ASSISTANT_WEB_SEARCH_EMPTY') break; }
        }
        throw lastError || fail(502, 'SEARCH_UNAVAILABLE', '搜索暂时不可用，可以直接提供公开网址。');
      });
    },
    read(value, { signal, maxChars = 16000 } = {}) {
      return operation(signal, async signal => {
        maxChars = Math.max(200, Math.min(40000, Math.floor(Number(maxChars) || 16000)));
        const { bytes, url, contentType } = await fetchBytes(value, signal), id = sourceId(url);
        let data, warnings = [];
        if (/application\/pdf/i.test(contentType) || bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) {
          const parsed = await pdfDocument(bytes, signal);
          data = { title: parsed.title || decodeURIComponentSafe(new URL(url).pathname.split('/').pop()) || new URL(url).hostname, ...paragraphBudget(parsed.pages.map(page => '[' + page.label + ']\n' + page.text).join('\n\n'), maxChars), links: [], pageCount: parsed.pageCount };
          warnings = parsed.warnings || [];
        } else {
          const text = textDecode(bytes, contentType);
          if (/html|xhtml/i.test(contentType) || /^\s*(?:<!doctype\s+html|<html\b)/i.test(text)) data = await htmlDocumentWorker(text, url, maxChars, signal);
          else if (/^(?:text\/(?:plain|markdown|x-markdown|xml)|application\/(?:json|xml|rss\+xml|atom\+xml))(?:;|$)/i.test(contentType)) {
            if (text.includes('\0') || text.replace(/\s/g, '').length < 20) throw fail(422, 'NO_TEXT', '该网址没有可用正文。');
            data = { title: decodeURIComponentSafe(new URL(url).pathname.split('/').pop()) || new URL(url).hostname, ...paragraphBudget(text, maxChars), links: [] };
          } else throw fail(415, 'CONTENT_TYPE', '该网址未返回可读网页、文本或PDF。暂不支持音视频、图片或可执行文件。');
        }
        check(signal);
        const retrievedAt = new Date().toISOString();
        if (data.textAvailable === true) (data.materialCandidates ||= []).unshift({ id: 'material-' + createHash('sha256').update(url + '\n' + url).digest('hex').slice(0, 24), kind: 'document', url, title: data.title, usage: 'web-text-reference', sourcePage: { id, url, title: data.title }, discoveredBy: 'read-page-text', contentVerified: true, verifiedCoverage: 'retrieved-text-excerpt', truncated: data.truncated, rights: data.rightsDeclaration || { status: 'unknown', verification: 'not-legally-verified' }, inspectionRequired: false, nextSteps: ['import-read-web-text', 'cite-source'] });
        if (!data.materialCandidates && /application\/pdf|text\/(?:plain|markdown|x-markdown)/i.test(contentType)) data.materialCandidates = [{ id: 'material-' + createHash('sha256').update(url + '\n' + url).digest('hex').slice(0, 24), kind: 'document', url, title: data.title, sourcePage: { id, url, title: data.title }, discoveredBy: 'read-original-document', contentVerified: true, rights: { status: 'unknown' }, inspectionRequired: false, nextSteps: ['download-original', 'import-and-read-original', 'cite-source'] }];
        for (const candidate of data.materialCandidates || []) { candidate.sourcePage.retrievedAt = retrievedAt; candidates.set(candidate.id, candidate); }
        while (candidates.size > 256) candidates.delete(candidates.keys().next().value);
        return { id, sourceId: id, url, ...data, contentType: contentType.split(';')[0].trim().toLowerCase() || 'text/html', retrievedAt, warnings };
      });
    },
    searchMaterials(query, { signal, kind, aspect, limit = 5, readLimit = 3 } = {}) {
      return operation(signal, async signal => {
      if (kind !== undefined && !['image', 'video', 'audio', 'document'].includes(kind) || aspect !== undefined && !['16:9', '9:16', '1:1'].includes(aspect) || !Number.isInteger(readLimit) || readLimit < 1 || readLimit > 3) throw fail(400, 'MATERIAL_QUERY', '材料检索类型、画幅或页面数量无效。');
      const found = await service.search(query, { signal, limit }), pages = [], warnings = [];
      for (const result of found.results.slice(0, readLimit)) {
        check(signal);
        try { pages.push(await service.read(result.url, { signal, maxChars: 4000 })); }
        catch (error) { check(signal); warnings.push({ url: result.url, code: error.code || 'ASSISTANT_WEB_PAGE_UNAVAILABLE', message: error instanceof AppError ? error.message : '来源页未能读取。' }); }
      }
      const materialCandidates = rankMaterialCandidates(pages.flatMap(page => page.materialCandidates || []), { query, kind, aspect });
      return { ...found, pages, materialCandidates, unreadResults: found.results.slice(readLimit), warnings, preparationOnly: true, note: '候选和匹配只依据已读取的页面声明，不证明文件内容、运动或许可可用；创作需继续真实下载、导入、检查并保留来源。' };
      }, Math.min(60000, timeoutMs * 2));
    },
    download(value, { signal, onProgress, candidateId } = {}) {
      if (activeDownloads >= 2) return Promise.reject(fail(429, 'DOWNLOAD_BUSY', '同时最多下载两个文件，请等待完成后重试。'));
      activeDownloads++;
      return operation(signal, async signal => {
        const originalUrl = parseUrl(value).url.href;
        const matches = [...candidates.values()].filter(item => item.url === originalUrl);
        const candidate = candidateId === undefined ? matches.length === 1 ? matches[0] : null : candidates.get(candidateId);
        if (candidateId !== undefined && (!candidate || candidate.url !== originalUrl)) throw fail(400, 'MATERIAL_CANDIDATE', '请使用本服务实际读取过且网址一致的材料候选编号。');
        const { bytes, url, contentType, disposition } = await fetchBytes(originalUrl, signal, { download: true, onProgress });
        const metadata = await validateDownloadedFile(bytes, { url, originalUrl, contentType, disposition, signal });
        check(signal);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const provenance = normalizeMaterialProvenance(candidate ? { sourcePage: candidate.sourcePage, candidateId: candidate.id, rights: candidate.rights } : {}, { requestedUrl: originalUrl, finalUrl: url, sha256, size: bytes.length });
        return { url, buffer: bytes, ...metadata, sha256, size: bytes.length, provenance };
      }, downloadTimeoutMs).finally(() => { activeDownloads--; });
    },
    materialCandidate(candidateId, value) {
      const candidate = candidates.get(candidateId);
      if (!candidate || value !== undefined && candidate.url !== parseUrl(value).url.href) throw fail(400, 'MATERIAL_CANDIDATE', '候选需要来自本服务实际读取的同一公开网址。');
      return structuredClone(candidate);
    },
    async close() { if (closed) return; closed = true; serviceAbort.abort(cancelled()); await Promise.allSettled([...operations]); candidates.clear(); },
  };
  return service;
}

if (!isMainThread && workerData?.operation === 'gx-assistant-html') {
  try { parentPort.postMessage({ ok: true, result: htmlDocument(workerData.html, workerData.url, workerData.maxChars) }); }
  catch (error) { parentPort.postMessage({ ok: false, error: { status: error instanceof AppError ? error.status : 422, code: error instanceof AppError ? error.code : 'ASSISTANT_WEB_HTML_INVALID', message: error instanceof AppError ? error.message : '该网页未能完成正文提取。' } }); }
  finally { parentPort.close(); }
}
if (!isMainThread && workerData?.operation === 'gx-assistant-json') {
  try { JSON.parse(textDecode(Buffer.from(workerData.bytes), workerData.contentType).replace(/^\uFEFF/, '')); parentPort.postMessage({ ok: true }); }
  catch { parentPort.postMessage({ ok: false }); }
  finally { parentPort.close(); }
}
