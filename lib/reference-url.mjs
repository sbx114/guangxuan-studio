import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, lstat, realpath, readFile, rename, rm, stat } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError } from './errors.mjs';

export const MAX_REFERENCE_URL_BYTES = 200 * 1024 * 1024;
const MAX_URL = 16384, MAX_REDIRECTS = 5, TOTAL_TIMEOUT = 180000, IDLE_TIMEOUT = 20000;
const METADATA_BYTES = 8 * 1024 * 1024, PROXY_BYTES = 24 * 1024 * 1024;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36';
const fail = (status, code, message) => new AppError(status, message, code);
const cancelled = () => fail(499, 'REFERENCE_URL_CANCELLED', '网址参考导入已取消。');
const timedOut = () => fail(504, 'REFERENCE_URL_TIMEOUT', '网址参考读取超时，请换用较短的视频或本地文件。');
function abortReason(signal) { return signal?.reason instanceof AppError ? signal.reason : cancelled(); }
function checkAbort(signal) { if (signal?.aborted) throw abortReason(signal); }
async function abortable(promise, signal) {
  checkAbort(signal);
  if (!signal) return promise;
  let abort;
  try { return await Promise.race([promise, new Promise((_, reject) => { abort = () => reject(abortReason(signal)); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); })]); }
  finally { if (abort) signal.removeEventListener('abort', abort); }
}

function ipv4Public(address) {
  const p = address.split('.').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b, c] = p;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113) || address === '168.63.129.16');
}
function ipv6Words(address) {
  let value = address.toLowerCase();
  if (value.includes('.')) {
    const tail = value.slice(value.lastIndexOf(':') + 1).split('.').map(Number);
    value = value.slice(0, value.lastIndexOf(':') + 1) + ((tail[0] << 8) | tail[1]).toString(16) + ':' + ((tail[2] << 8) | tail[3]).toString(16);
  }
  const halves = value.split('::');
  const left = halves[0] ? halves[0].split(':') : [], right = halves[1] ? halves[1].split(':') : [];
  return [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right].map(word => Number.parseInt(word, 16));
}
export function isPublicReferenceAddress(address) {
  if (typeof address !== 'string' || address.includes('%')) return false;
  const family = net.isIP(address);
  if (family === 4) return ipv4Public(address);
  if (family !== 6) return false;
  const words = ipv6Words(address);
  if (words.length !== 8 || words.some(n => !Number.isInteger(n))) return false;
  if (words.slice(0, 5).every(n => n === 0) && words[5] === 0xffff)
    return ipv4Public([words[6] >> 8, words[6] & 255, words[7] >> 8, words[7] & 255].join('.'));
  // Only global unicast; exclude transition/special-use and documentation ranges.
  return (words[0] & 0xe000) === 0x2000 && words[0] !== 0x2002 &&
    !(words[0] === 0x2001 && (words[1] < 0x0200 || words[1] === 0x0db8)) &&
    !(words[0] === 0x3fff && words[1] < 0x1000);
}
function parseUrl(value, { httpsOnly = false } = {}) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_URL || /[\u0000-\u0020\u007f]/.test(value.trim()))
    throw fail(400, 'REFERENCE_URL_INVALID', '请填写完整的视频网址。');
  let url;
  try { url = new URL(value.trim()); } catch { throw fail(400, 'REFERENCE_URL_INVALID', '视频网址格式不正确。'); }
  if (!['http:', 'https:'].includes(url.protocol) || (httpsOnly && url.protocol !== 'https:') || url.username || url.password)
    throw fail(400, 'REFERENCE_URL_INVALID', '仅支持不含账号密码的 HTTP 或 HTTPS 视频网址。');
  if (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80'))
    throw fail(400, 'REFERENCE_URL_PORT', '网址参考仅支持标准 HTTP / HTTPS 端口。');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!hostname || hostname === 'localhost' || /(?:^|\.)(?:localhost|local|internal|lan|home|invalid|test)$/.test(hostname) || !hostname.includes('.') && !net.isIP(hostname))
    throw fail(400, 'REFERENCE_URL_PRIVATE', '不支持本机、内网或云元数据地址。');
  if (net.isIP(hostname) && !isPublicReferenceAddress(hostname)) throw fail(400, 'REFERENCE_URL_PRIVATE', '不支持本机、内网或云元数据地址。');
  url.hash = '';
  return { url, hostname };
}
export async function resolvePublicReferenceUrl(value, { lookup = dnsLookup, signal, httpsOnly = false } = {}) {
  checkAbort(signal);
  const parsed = parseUrl(value, { httpsOnly });
  let addresses;
  if (net.isIP(parsed.hostname)) addresses = [{ address: parsed.hostname, family: net.isIP(parsed.hostname) }];
  else {
    try { addresses = await abortable(lookup(parsed.hostname, { all: true, verbatim: true }), signal); }
    catch (error) { checkAbort(signal); if (error instanceof AppError) throw error; throw fail(422, 'REFERENCE_URL_DNS', '无法解析视频网址，请检查网址或网络。'); }
  }
  if (!Array.isArray(addresses) || !addresses.length || addresses.length > 64 || addresses.some(item => !isPublicReferenceAddress(item?.address)))
    throw fail(400, 'REFERENCE_URL_PRIVATE', '网址解析到了非公网地址，已停止读取。');
  const selected = addresses.find(item => net.isIP(item.address) === 4) || addresses[0];
  return { ...parsed, address: selected.address, family: net.isIP(selected.address) };
}

// Every request resolves and validates first, then connects to that exact address.
// Agents and DNS fallback are disabled so a second lookup cannot rebind the host.
export function requestPinnedReference(target, { signal, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const client = target.url.protocol === 'https:' ? https : http;
    const request = client.request(target.url, {
      method: 'GET', agent: false, signal, autoSelectFamily: false, family: target.family,
      lookup: (_host, options, callback) => options?.all ? callback(null, [{ address: target.address, family: target.family }]) : callback(null, target.address, target.family),
      headers: { 'User-Agent': USER_AGENT, Accept: '*/*', 'Accept-Encoding': 'identity', ...headers },
    }, resolve);
    request.setTimeout(IDLE_TIMEOUT, () => request.destroy(timedOut()));
    request.once('error', reject); request.end();
  });
}
const header = (response, name) => { const value = response.headers?.[name]; return Array.isArray(value) ? value[0] : value; };
async function openResponse(value, { lookup, request, signal, headers, httpsOnly = false }) {
  let next = value;
  for (let count = 0; count <= MAX_REDIRECTS; count++) {
    const target = await resolvePublicReferenceUrl(next, { lookup, signal, httpsOnly });
    const response = await abortable(request(target, { signal, headers }), signal);
    if (!REDIRECTS.has(response.statusCode)) return { response, finalUrl: target.url.href };
    const location = header(response, 'location'); response.destroy();
    if (!location || count === MAX_REDIRECTS) throw fail(422, 'REFERENCE_URL_REDIRECT', '视频网址跳转过多或跳转地址无效。');
    try { next = new URL(location, target.url).href; } catch { throw fail(422, 'REFERENCE_URL_REDIRECT', '视频网址的跳转地址无效。'); }
    // HTTPS requests never downgrade to plaintext, including every redirect hop.
    if (target.url.protocol === 'https:') httpsOnly = true;
  }
}

function platformUrl(url) {
  const host = url.hostname.toLowerCase().replace(/\.$/, ''), pathname = url.pathname;
  if (['www.youtube.com', 'youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(host)) {
    const id = host === 'youtu.be' ? /^\/([\w-]{11})\/?$/.exec(pathname)?.[1]
      : pathname === '/watch' ? url.searchParams.get('v') : /^\/(?:shorts|embed)\/([\w-]{11})\/?$/.exec(pathname)?.[1];
    if (!/^[\w-]{11}$/.test(id || '')) throw fail(400, 'REFERENCE_PAGE_UNSUPPORTED', '请提供 YouTube 单个视频的网址，不支持频道或播放列表。');
    return { platform: 'youtube', url: `https://www.youtube.com/watch?v=${id}` };
  }
  if (['www.bilibili.com', 'bilibili.com', 'm.bilibili.com'].includes(host)) {
    // Known language variants still identify the same single BV/av video.
    // Never treat arbitrary prefixes, lists or extra path segments as videos.
    const id = /^\/(?:(?:zh-Hans|zh-Hant|pt)\/)?video\/(BV[0-9A-Za-z]{10}|av\d{1,20})\/?$/i.exec(pathname)?.[1];
    if (!id) throw fail(400, 'REFERENCE_PAGE_UNSUPPORTED', '请提供 B站 BV / av 单个视频网址，不支持番剧、直播或合集。');
    const page = url.searchParams.get('p') || '1';
    if (!/^[1-9]\d{0,2}$/.test(page)) throw fail(400, 'REFERENCE_PAGE_UNSUPPORTED', 'B站分P序号无效。');
    return { platform: 'bilibili', url: `https://www.bilibili.com/video/${id}?p=${page}` };
  }
  return null;
}
const platformHost = (host, platform) => platform === 'youtube'
  ? host === 'youtubei.googleapis.com' || ['youtube.com', 'youtube-nocookie.com', 'googlevideo.com', 'ytimg.com'].some(domain => host === domain || host.endsWith('.' + domain))
  : ['bilibili.com', 'bilivideo.com', 'bilivideo.cn', 'hdslb.com'].some(domain => host === domain || host.endsWith('.' + domain));

/** Local authenticated CONNECT proxy; yt-dlp never receives an unrestricted route. */
export async function createReferenceMetadataProxy({ platform, lookup = dnsLookup, connect = net.connect, signal, maxBytes = PROXY_BYTES }) {
  const token = randomBytes(24).toString('hex'), authorization = 'Basic ' + Buffer.from('reference:' + token).toString('base64');
  const sockets = new Set(); let transferred = 0, connections = 0, violation = null;
  const server = http.createServer((_req, res) => { violation ||= fail(422, 'REFERENCE_PAGE_NETWORK', '视频平台请求了不支持的地址。'); res.writeHead(403); res.end(); });
  function destroyAll() { for (const socket of sockets) socket.destroy(); }
  function track(socket) { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); socket.setTimeout(IDLE_TIMEOUT, () => socket.destroy()); }
  server.on('connection', socket => track(socket));
  server.on('connect', async (req, client, head) => {
    if (req.headers['proxy-authorization'] !== authorization) { client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return; }
    try {
      checkAbort(signal);
      if (++connections > 32) throw fail(422, 'REFERENCE_PAGE_NETWORK', '视频平台请求过多，请稍后重试。');
      const target = await resolvePublicReferenceUrl('https://' + req.url, { lookup, signal, httpsOnly: true });
      if (!platformHost(target.hostname, platform)) throw fail(422, 'REFERENCE_PAGE_NETWORK', '视频平台跳转到了不受支持的地址。');
      checkAbort(signal);
      const upstream = connect({ host: target.address, port: 443, family: target.family }); track(upstream);
      const count = chunk => { transferred += chunk.length; if (transferred > maxBytes) { violation ||= fail(413, 'REFERENCE_METADATA_TOO_LARGE', '视频网页信息过大，请改用视频直链。'); destroyAll(); } };
      upstream.once('connect', () => { if (signal?.aborted || client.destroyed) { upstream.destroy(); return; } client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client); });
      client.on('data', count); upstream.on('data', count);
      upstream.once('error', () => client.destroy()); client.once('close', () => upstream.destroy()); upstream.once('close', () => client.destroy());
    } catch (error) { violation ||= error; client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const abort = () => destroyAll(); signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) destroyAll();
  return {
    url: `http://reference:${token}@127.0.0.1:${server.address().port}`,
    get violation() { return violation; },
    async close() { signal?.removeEventListener('abort', abort); destroyAll(); await new Promise(resolve => server.close(resolve)); },
  };
}

export function referenceDownloaderArgs(url, proxy, platform) {
  return ['--ignore-config', '--no-config-locations', '--no-plugin-dirs', '--no-cookies', '--no-cookies-from-browser',
    '--no-cache-dir', '--no-exec', '--no-remote-components', '--no-js-runtimes', '--no-playlist', '--skip-download', '--simulate',
    '--dump-single-json', '--no-progress', '--no-warnings', '--no-check-formats', '--ignore-no-formats-error',
    '--socket-timeout', '15', '--retries', '0', '--extractor-retries', '0', '--xff', 'never', '--proxy', proxy,
    '--use-extractors', platform === 'youtube' ? 'youtube' : 'bilibili',
    ...(platform === 'youtube' ? ['--extractor-args', 'youtube:player_client=visionos;skip=hls,dash,translated_subs'] : []),
    '--format', 'bestvideo[protocol=https]/best[protocol=https]', '--', url];
}
async function downloaderFile(root, explicit) {
  const manifest = JSON.parse(await readFile(new URL('../scripts/reference-downloader-manifest.json', import.meta.url), 'utf8'));
  const candidates = [explicit, process.env.GUANGXUAN_REFERENCE_DOWNLOADER,
    process.env.GUANGXUAN_BIN_DIR && path.join(process.env.GUANGXUAN_BIN_DIR, manifest.filename),
    process.resourcesPath && path.join(process.resourcesPath, 'bin', manifest.filename),
    root && path.resolve(root, '..', 'bin', manifest.filename), root && path.join(root, 'bin', manifest.filename)].filter(Boolean);
  for (const candidate of [...new Set(candidates)]) {
    let info; try { info = await lstat(candidate); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!info.isFile() || info.isSymbolicLink() || info.size !== manifest.bytes) throw fail(503, 'REFERENCE_TOOL_INVALID', '网页解析工具版本不匹配，请重新安装工具。');
    const hash = createHash('sha256'); for await (const chunk of createReadStream(candidate)) hash.update(chunk);
    if (hash.digest('hex') !== manifest.sha256) throw fail(503, 'REFERENCE_TOOL_INVALID', '网页解析工具校验失败，请重新安装工具。');
    return candidate;
  }
  throw fail(503, 'REFERENCE_TOOL_MISSING', '尚未安装网页解析工具，可先使用视频直链或本地视频。');
}
async function extractWithDownloader(target, { root, downloaderPath, directory, lookup, signal }) {
  const executable = await downloaderFile(root, downloaderPath);
  checkAbort(signal);
  const proxy = await createReferenceMetadataProxy({ platform: target.platform, lookup, signal });
  try {
    return await new Promise((resolve, reject) => {
      const env = { TEMP: directory, TMP: directory, TMPDIR: directory, PYTHONNOUSERSITE: '1', PYTHONSAFEPATH: '1' };
      // Do not hand model credentials, browser-profile locations, proxies or Python overrides to the child.
      for (const [key, value] of Object.entries(process.env)) if (/^(?:systemroot|windir|path|pathext|comspec|os|processor_architecture|number_of_processors|lang|lc_all)$/i.test(key)) env[key] = value;
      let child, stderr = '', settled = false, size = 0, overLimit = false, terminationError;
      const output = [];
      const timer = setTimeout(() => { terminationError = timedOut(); child?.kill(); }, 90000); timer.unref();
      const abort = () => { terminationError = abortReason(signal); child?.kill(); };
      function finish(error, value) { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value); }
      try { child = spawn(executable, referenceDownloaderArgs(target.url, proxy.url, target.platform), { shell: false, windowsHide: true, cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch { finish(fail(503, 'REFERENCE_TOOL_BLOCKED', '网页解析工具无法启动，请使用视频直链或本地文件。')); return; }
      signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
      child.stdout.on('data', chunk => { size += chunk.length; if (size > METADATA_BYTES) { overLimit = true; child.kill(); } else output.push(chunk); });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-4000); });
      child.once('error', error => finish(fail(503, error.code === 'ENOENT' ? 'REFERENCE_TOOL_MISSING' : 'REFERENCE_TOOL_BLOCKED', '网页解析工具被系统阻止或无法启动，可使用视频直链或本地文件。')));
      child.once('close', code => {
        if (terminationError) return finish(terminationError);
        if (signal?.aborted) return finish(abortReason(signal));
        if (proxy.violation) return finish(proxy.violation);
        if (overLimit) return finish(fail(413, 'REFERENCE_METADATA_TOO_LARGE', '视频网页信息过大，请改用视频直链。'));
        if (code !== 0) {
          const timeout = /timed? out|read timeout|TimeoutError/i.test(stderr);
          const error = timeout
            ? fail(504, 'REFERENCE_PAGE_TIMEOUT', '视频平台响应超时，请检查网络或改用视频直链、本地文件。')
            : fail(422, 'REFERENCE_PAGE_UNAVAILABLE', '该视频无法公开读取，可能需要登录、受地区限制或平台校验。请使用可公开读取的直链或本地视频。');
          error.diagnostic = stderr.replaceAll(proxy.url, '[local-metadata-proxy]'); return finish(error);
        }
        try { finish(null, JSON.parse(Buffer.concat(output).toString('utf8'))); } catch { finish(fail(422, 'REFERENCE_METADATA_INVALID', '无法读取视频网页信息，请换用直链或本地视频。')); }
      });
    });
  } finally { await proxy.close(); }
}

function selectVideo(info) {
  if (!info || typeof info !== 'object' || Array.isArray(info) || (info._type && info._type !== 'video') || Array.isArray(info.entries))
    throw fail(422, 'REFERENCE_PLAYLIST_UNSUPPORTED', '只支持单个视频，不支持播放列表或合集。');
  if (info.has_drm || info.is_drm || ['private', 'premium_only', 'subscriber_only', 'needs_auth'].includes(info.availability) || ['is_live', 'is_upcoming'].includes(info.live_status))
    throw fail(422, 'REFERENCE_PAGE_RESTRICTED', '不支持需要登录、受保护或正在直播的视频。');
  const formats = Array.isArray(info.formats) ? info.formats : [info];
  const candidates = formats.filter(format => format && typeof format.url === 'string' &&
    (format.protocol || 'https') === 'https' && !format.has_drm && !format.is_drm && !format.fragments && !format.manifest_url &&
    ['mp4', 'webm', 'mov', 'm4v', 'mkv'].includes(format.ext) && format.vcodec !== 'none' &&
    (format.vcodec || Number(format.height) > 0) && !/\.(?:m3u8?|mpd)(?:[?#]|$)/i.test(format.url));
  if (!candidates.length) throw fail(422, 'REFERENCE_FORMAT_UNSUPPORTED', '未找到可直接读取的单文件视频流；分段、DRM或需要登录的视频暂不支持。');
  const muxed = candidates.filter(format => typeof format.acodec === 'string' && format.acodec !== 'none');
  const preferred = muxed.length ? muxed : candidates;
  preferred.sort((a, b) => {
    const rank = item => (item.ext === 'mp4' ? 10000000 : 0) + (Number(item.height) > 720 ? -1000000 - Number(item.height) : Number(item.height || 0) * 1000) + Number(item.tbr || 0);
    return rank(b) - rank(a);
  });
  return preferred[0];
}
function selectAudio(info, video) {
  if (video.acodec !== 'none') return null;
  const formats = Array.isArray(info.formats) ? info.formats : [info];
  const audio = formats.filter(format => format && format.vcodec === 'none' && typeof format.acodec === 'string' && format.acodec !== 'none');
  if (!audio.length) return null;
  if (video.ext !== 'mp4') throw fail(415, 'REFERENCE_AUDIO_FORMAT_UNSUPPORTED', '此公开源的分离音轨暂不兼容安全合并，未导入静音替代品。');
  const candidates = audio.filter(format => typeof format.url === 'string' && (format.protocol || 'https') === 'https' && !format.has_drm && !format.is_drm && !format.fragments && !format.manifest_url && ['m4a', 'mp4'].includes(format.ext) && /^(?:mp4a(?:\.|$)|aac$)/i.test(format.acodec) && !/\.(?:m3u8?|mpd)(?:[?#]|$)/i.test(format.url));
  if (!candidates.length) throw fail(415, 'REFERENCE_AUDIO_FORMAT_UNSUPPORTED', '此公开源有音轨，但未提供可安全合并的单文件AAC音轨，未导入静音替代品。');
  candidates.sort((a, b) => Number(b.abr || b.tbr || 0) - Number(a.abr || a.tbr || 0));
  return candidates[0];
}
function runLocalMedia(binary, args, { directory, signal, capture = false }) {
  checkAbort(signal);
  if (typeof binary !== 'string' || !binary) throw fail(503, 'REFERENCE_AUDIO_RUNTIME_MISSING', '保留原音轨需要本机媒体运行时，请重新打开或修复安装。');
  return new Promise((resolve, reject) => {
    let child, startupError, terminationError, killTimer, size = 0;
    const chunks = [];
    try { child = spawn(binary, args, { shell: false, windowsHide: true, cwd: directory, stdio: ['ignore', capture ? 'pipe' : 'ignore', 'pipe'] }); }
    catch { reject(fail(503, 'REFERENCE_AUDIO_RUNTIME_MISSING', '本机媒体运行时无法启动。')); return; }
    const stop = () => { terminationError = abortReason(signal); child.kill(); killTimer = setTimeout(() => child.kill('SIGKILL'), 2000); };
    signal?.addEventListener('abort', stop, { once: true }); if (signal?.aborted) stop();
    child.stderr.on('data', () => {}); // Never forward local paths or media diagnostics.
    child.stdout?.on('data', chunk => { size += chunk.length; if (size > 256 * 1024) { terminationError = fail(422, 'REFERENCE_AUDIO_PROBE_INVALID', '音视频校验结果过大。'); child.kill(); } else chunks.push(chunk); });
    child.once('error', error => { startupError = error; });
    // Settle only on real close; Windows still owns the CWD/file handles at an
    // earlier error or successful IPC/process acknowledgement.
    child.once('close', code => {
      clearTimeout(killTimer); signal?.removeEventListener('abort', stop);
      if (terminationError || signal?.aborted) return reject(terminationError || abortReason(signal));
      if (startupError) return reject(fail(503, 'REFERENCE_AUDIO_RUNTIME_MISSING', '本机媒体运行时被阻止或无法启动。'));
      if (code !== 0) return reject(fail(422, capture ? 'REFERENCE_AUDIO_PROBE_FAILED' : 'REFERENCE_AUDIO_MUX_FAILED', '原音轨保留或校验未完成，未导入静音替代品。'));
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}
async function muxLocalAudio(video, audio, output, { ffmpegPath, ffprobePath, directory, signal, maxBytes, expectedDuration }) {
  await runLocalMedia(ffmpegPath, ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-protocol_whitelist', 'file,pipe', '-i', video, '-protocol_whitelist', 'file,pipe', '-i', audio, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-shortest', '-movflags', '+faststart', '-f', 'mp4', output], { directory, signal });
  checkAbort(signal); const info = await stat(output);
  if (!info.isFile() || info.size < 12 || info.size > maxBytes) throw fail(413, 'REFERENCE_URL_TOO_LARGE', '合并后的音视频超过本次容量上限，未登记素材。');
  const raw = await runLocalMedia(ffprobePath, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', output], { directory, signal, capture: true });
  let probe; try { probe = JSON.parse(raw); } catch { throw fail(422, 'REFERENCE_AUDIO_PROBE_INVALID', '无法确认合并结果包含原音轨。'); }
  const duration = Number(probe.format?.duration);
  if (!probe.streams?.some(stream => stream.codec_type === 'video') || !probe.streams?.some(stream => stream.codec_type === 'audio') || !Number.isFinite(duration) || duration <= 0 || Number.isFinite(expectedDuration) && expectedDuration > 0 && Math.abs(duration - expectedDuration) > Math.max(2, expectedDuration * .01)) throw fail(422, 'REFERENCE_AUDIO_PROBE_INVALID', '合并结果的音轨或时长不完整，未登记素材。');
  return { status: 'preserved', method: 'copy-mux', duration };
}
function containerExtension(prefix) {
  if (prefix.length >= 12 && prefix.toString('ascii', 4, 8) === 'ftyp') return '.mp4';
  if (prefix.length >= 4 && prefix.readUInt32BE(0) === 0x1a45dfa3) return '.webm';
  if (prefix.length >= 12 && prefix.toString('ascii', 0, 4) === 'RIFF' && prefix.toString('ascii', 8, 12) === 'AVI ') return '.avi';
  if (prefix.length >= 4 && prefix.toString('ascii', 0, 4) === 'OggS') return '.ogv';
  if (prefix.length >= 377 && prefix[0] === 0x47 && prefix[188] === 0x47 && prefix[376] === 0x47) return '.ts';
  throw fail(415, 'REFERENCE_FORMAT_UNSUPPORTED', '链接未返回支持的视频文件。请提供 MP4 / WebM 等视频直链或本地文件。');
}
const cleanTitle = value => String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 180);

/** Dependencies are trusted process configuration for tests; never populate them from request JSON. */
export function createReferenceUrlImporter({ dataDir, root, importLocal, downloaderPath, ffmpegPath, ffprobePath, timeoutMs = TOTAL_TIMEOUT, maxBytes = MAX_REFERENCE_URL_BYTES, dependencies = {} } = {}) {
  if (!path.isAbsolute(dataDir || '') || typeof importLocal !== 'function') throw new TypeError('An absolute dataDir and an importLocal callback are required.');
  const lookup = dependencies.lookup || dnsLookup, request = dependencies.request || requestPinnedReference;
  maxBytes = Math.max(1, Math.min(MAX_REFERENCE_URL_BYTES, Number(maxBytes) || MAX_REFERENCE_URL_BYTES));
  timeoutMs = Math.max(1, Math.min(TOTAL_TIMEOUT, Number(timeoutMs) || TOTAL_TIMEOUT));
  const active = new Set(), serviceAbort = new AbortController(); let closed = false, scopePromise;
  async function scope() {
    scopePromise ||= (async () => {
      await mkdir(dataDir, { recursive: true }); const realData = await realpath(dataDir), directory = path.join(realData, 'reference-url');
      await mkdir(directory, { recursive: true }); const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) throw fail(500, 'REFERENCE_DIRECTORY_INVALID', '参考文件目录无效。');
      return directory;
    })();
    return scopePromise;
  }
  async function perform(value, { signal, retainCommittedReceipt = false, onProgress } = {}) {
    if (closed) throw cancelled();
    if (active.size >= 2) throw fail(429, 'REFERENCE_IMPORT_BUSY', '已有视频网址正在处理，请稍后重试。');
    const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(timedOut()), timeoutMs); timer.unref();
    const combined = AbortSignal.any([serviceAbort.signal, timeout.signal, ...(signal ? [signal] : [])]);
    let directory, rootDirectory, imported = false;
    let lastProgressAt = 0;
    const report = (phase, values = {}, force = true) => {
      if (typeof onProgress !== 'function' || !force && Date.now() - lastProgressAt < 200) return;
      lastProgressAt = Date.now();
      try { Promise.resolve(onProgress({ phase, ...values })).catch(() => {}); } catch { /* Observers must not change registration or cancellation semantics. */ }
    };
    try {
      report('preparing');
      const initial = await resolvePublicReferenceUrl(value, { lookup, signal: combined });
      let pageUrl = initial.url;
      if (pageUrl.hostname.toLowerCase() === 'b23.tv') {
        if (!/^\/[0-9A-Za-z]+\/?$/.test(pageUrl.pathname)) throw fail(400, 'REFERENCE_PAGE_UNSUPPORTED', 'B站短链接格式无效。');
        const resolved = await openResponse(pageUrl.href, { lookup, request, signal: combined, httpsOnly: true });
        resolved.response.destroy(); pageUrl = new URL(resolved.finalUrl);
        if (!['www.bilibili.com', 'bilibili.com', 'm.bilibili.com'].includes(pageUrl.hostname.toLowerCase())) throw fail(422, 'REFERENCE_PAGE_UNSUPPORTED', '短链接没有指向受支持的 B站视频。');
      }
      const target = platformUrl(pageUrl);
      rootDirectory = await scope(); directory = await mkdtemp(path.join(rootDirectory, 'import-'));
      let mediaUrl = pageUrl.href, title = '', headers = {}, audioHeaders = {}, sourceUrl = pageUrl.href, audioFormat = null, expectedDuration;
      if (target) {
        report('metadata');
        await resolvePublicReferenceUrl(target.url, { lookup, signal: combined, httpsOnly: true });
        const info = await (dependencies.extractMetadata || extractWithDownloader)(target, { root, downloaderPath, directory, lookup, signal: combined });
        checkAbort(combined);
        const format = selectVideo(info); audioFormat = selectAudio(info, format); mediaUrl = format.url; title = cleanTitle(info.title); sourceUrl = target.url; expectedDuration = Number(info.duration);
        headers.Referer = target.url;
        const agent = format.http_headers?.['User-Agent'] || info.http_headers?.['User-Agent'];
        if (typeof agent === 'string' && agent.length <= 512 && /^[\x20-\x7e]+$/.test(agent)) headers['User-Agent'] = agent;
        if (audioFormat) {
          if (!ffmpegPath || !ffprobePath) throw fail(503, 'REFERENCE_AUDIO_RUNTIME_MISSING', '此视频需要保留分离音轨，但本机媒体运行时尚未配置。');
          audioHeaders.Referer = target.url;
          const audioAgent = audioFormat.http_headers?.['User-Agent'] || info.http_headers?.['User-Agent'];
          if (typeof audioAgent === 'string' && audioAgent.length <= 512 && /^[\x20-\x7e]+$/.test(audioAgent)) audioHeaders['User-Agent'] = audioAgent;
        }
      }
      let receivedBytes = 0; const declaredStreams = new Map(), expectedStreams = audioFormat ? 2 : 1;
      const progressValue = () => ({ receivedBytes, ...(declaredStreams.size === expectedStreams && [...declaredStreams.values()].every(value => Number.isFinite(value) && value > 0) ? { totalBytes: [...declaredStreams.values()].reduce((sum, value) => sum + value, 0) } : {}) });
      const download = async (url, stream, requestHeaders) => {
        if (/\.(?:m3u8?|mpd)(?:[?#]|$)/i.test(url)) throw fail(415, 'REFERENCE_FORMAT_UNSUPPORTED', '暂不支持分段播放清单，请提供单个媒体文件。');
        const { response, finalUrl } = await openResponse(url, { lookup, request, signal: combined, headers: requestHeaders, httpsOnly: Boolean(target) });
        if (response.statusCode !== 200) { response.destroy(); throw fail(422, stream === 'audio' ? 'REFERENCE_AUDIO_DOWNLOAD_FAILED' : 'REFERENCE_DOWNLOAD_FAILED', stream === 'audio' ? '原音轨无法公开下载，未导入静音替代品。' : '视频无法公开下载，请检查网址或改用本地文件。'); }
        const contentType = String(header(response, 'content-type') || '').toLowerCase();
        if (/text\/|json|xml|mpegurl|dash\+/.test(contentType)) { response.destroy(); throw fail(415, stream === 'audio' ? 'REFERENCE_AUDIO_FORMAT_UNSUPPORTED' : 'REFERENCE_PAGE_UNSUPPORTED', '该链接返回了网页或播放清单，未作为有效媒体导入。'); }
        if (String(header(response, 'content-encoding') || 'identity').toLowerCase() !== 'identity') { response.destroy(); throw fail(415, 'REFERENCE_FORMAT_UNSUPPORTED', '媒体响应使用了不支持的压缩方式。'); }
        const declared = Number(header(response, 'content-length')); declaredStreams.set(stream, declared);
        if (Number.isFinite(declared) && receivedBytes + declared > maxBytes) { response.destroy(); throw fail(413, 'REFERENCE_URL_TOO_LARGE', '本次下载的音视频总量超过容量上限，未登记素材。'); }
        const temporary = path.join(directory, stream + '.partial'); let size = 0, prefix = Buffer.alloc(0);
        report('downloading', { ...progressValue(), stream });
        const limiter = new Transform({ transform(chunk, _encoding, callback) {
          size += chunk.length; receivedBytes += chunk.length;
          if (receivedBytes > maxBytes) return callback(fail(413, 'REFERENCE_URL_TOO_LARGE', '本次下载的音视频总量超过容量上限，未登记素材。'));
          report('downloading', { ...progressValue(), stream }, false);
          if (prefix.length < 512) prefix = Buffer.concat([prefix, chunk.subarray(0, 512 - prefix.length)]);
          callback(null, chunk);
        } });
        await pipeline(response, limiter, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal: combined }); checkAbort(combined);
        if (!size) throw fail(415, 'REFERENCE_DOWNLOAD_EMPTY', '下载的媒体为空，请换一个链接。');
        const extension = containerExtension(prefix);
        if (stream === 'audio' && extension !== '.mp4') throw fail(415, 'REFERENCE_AUDIO_FORMAT_UNSUPPORTED', '音轨不是受支持的AAC/MP4单文件。');
        const filename = path.join(directory, stream + (stream === 'audio' ? '.m4a' : extension)); await rename(temporary, filename);
        return { filename, extension, finalUrl };
      };
      const video = await download(mediaUrl, 'video', headers); let filename = video.filename, extension = video.extension, audio;
      if (audioFormat) {
        if (extension !== '.mp4') throw fail(415, 'REFERENCE_AUDIO_FORMAT_UNSUPPORTED', '分离音轨只对MP4视频安全合并。');
        const sound = await download(audioFormat.url, 'audio', audioHeaders); filename = path.join(directory, 'media.mp4');
        report('muxing', progressValue());
        audio = await muxLocalAudio(video.filename, sound.filename, filename, { ffmpegPath, ffprobePath, directory, signal: combined, maxBytes, expectedDuration });
        await Promise.all([rm(video.filename), rm(sound.filename)]); checkAbort(combined);
      }
      if (!title) { try { title = cleanTitle(decodeURIComponent(path.basename(new URL(video.finalUrl).pathname)).replace(/\.[^.]+$/, '')); } catch {} }
      title ||= '网址视频参考';
      const name = title.replace(/[\\/:*?"<>|]/g, '_') + extension;
      report('registering', progressValue());
      const asset = await importLocal(filename, { name, expectedType: 'video', signal: combined });
      imported = true; // The media service keeps this managed path; never delete a registered file.
      if (!asset || asset.type !== 'video' || !asset.id) throw fail(415, 'REFERENCE_FORMAT_UNSUPPORTED', '链接中没有可用的视频画面。');
      // The assistant records this receipt even if Stop arrives during the
      // registrar's successful commit. Default reference UI behavior is kept.
      if (retainCommittedReceipt !== true) checkAbort(combined);
      report('complete', progressValue());
      return { asset, sourceUrl, title, audio: audio || { status: asset.hasAudio === true ? 'present' : asset.hasAudio === false ? 'none' : 'unknown', method: 'original-file', ...(asset.hasAudio === false ? { note: '此公开文件未提供可用音轨。' } : {}) } };
    } catch (error) {
      if (combined.aborted) throw abortReason(combined);
      if (error instanceof AppError) throw error;
      throw fail(422, 'REFERENCE_DOWNLOAD_FAILED', '读取视频参考失败，请检查网络或改用本地文件。');
    } finally {
      clearTimeout(timer);
      if (directory && !imported) {
        const resolved = path.resolve(directory);
        if (path.dirname(resolved) !== rootDirectory || !path.basename(resolved).startsWith('import-')) throw new Error('Refusing cleanup outside the owned reference directory.');
        const info = await lstat(resolved).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
        if (info && !info.isSymbolicLink()) await rm(resolved, { recursive: true, force: true });
      }
    }
  }
  return {
    import(url, options) {
      const pending = perform(url, options); active.add(pending);
      pending.then(() => active.delete(pending), () => active.delete(pending));
      return pending;
    },
    async close() { closed = true; serviceAbort.abort(cancelled()); await Promise.allSettled([...active]); },
  };
}
