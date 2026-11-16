import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile, realpath, stat } from 'node:fs/promises';
import { AppError, requireObject } from './lib/errors.mjs';
import { runAi, connectProvider, listProviderModels } from './lib/ai.mjs';
import { getPromptCatalog } from './lib/prompts.mjs';
import { importDocument, createDocx } from './lib/documents.mjs';
import { createProjectStore, validateProjectId } from './lib/store.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = path.join(ROOT, 'public');
const MAX_BODY = 30 * 1024 * 1024;
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
}

function json(res, status, data) {
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readJson(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw new AppError(415, '请求需要使用 JSON 格式。', 'CONTENT_TYPE_REQUIRED');
  const lengthHeader = Number(req.headers['content-length']);
  if (Number.isFinite(lengthHeader) && lengthHeader > MAX_BODY) { req.resume(); throw new AppError(413, '请求内容过大。', 'REQUEST_TOO_LARGE'); }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', chunk => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY) { settled = true; reject(new AppError(413, '请求内容过大。', 'REQUEST_TOO_LARGE')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try { resolve(requireObject(JSON.parse(Buffer.concat(chunks).toString('utf8')))); }
      catch (error) { reject(error instanceof AppError ? error : new AppError(400, '请求不是有效的 JSON。', 'INVALID_JSON')); }
    });
    req.on('error', () => { if (!settled) { settled = true; reject(new AppError(400, '读取请求失败。', 'REQUEST_READ_ERROR')); } });
    req.on('aborted', () => { if (!settled) { settled = true; reject(new AppError(499, '操作已取消。', 'REQUEST_CANCELLED')); } });
  });
}

async function serveStatic(req, res, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { throw new AppError(400, '资源地址不正确。', 'INVALID_PATH'); }
  if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').some(part => part.startsWith('.'))) throw new AppError(404, '找不到资源。', 'NOT_FOUND');
  const candidate = path.resolve(PUBLIC_ROOT, decoded === '/' ? 'index.html' : `.${decoded}`);
  const prefix = `${PUBLIC_ROOT}${path.sep}`;
  if (candidate !== PUBLIC_ROOT && !candidate.startsWith(prefix)) throw new AppError(404, '找不到资源。', 'NOT_FOUND');
  let resolved;
  let info;
  try { resolved = await realpath(candidate); info = await stat(resolved); }
  catch { throw new AppError(404, '找不到资源。', 'NOT_FOUND'); }
  if (!resolved.startsWith(prefix) || !info.isFile()) throw new AppError(404, '找不到资源。', 'NOT_FOUND');
  const content = await readFile(resolved);
  res.writeHead(200, { 'Content-Type': MIME[path.extname(candidate).toLowerCase()] || 'application/octet-stream', 'Content-Length': content.length, 'Cache-Control': 'no-cache' });
  res.end(req.method === 'HEAD' ? undefined : content);
}

export async function startServer({ port = 0, host = '127.0.0.1', dataDir = process.env.GUANGXUAN_DATA_DIR || path.join(ROOT, '.data') } = {}) {
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new AppError(400, '桌面服务仅允许绑定本机地址。', 'LOOPBACK_ONLY');
  if (!Number.isInteger(Number(port)) || Number(port) < 0 || Number(port) > 65535) throw new AppError(400, '端口设置不正确。', 'INVALID_PORT');
  const sessionSecrets = new Set();
  const store = await createProjectStore(dataDir, { sensitiveStrings: () => [...sessionSecrets] });
  let videoService = null;
  const videoModulePath = path.join(ROOT, 'lib', 'video.mjs');
  try {
    await stat(videoModulePath);
    const videoModule = await import(pathToFileURL(videoModulePath).href);
    videoService = await videoModule.createVideoService({ dataDir, root: ROOT });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const active = new Set();
  let actualPort;
  const server = http.createServer(async (req, res) => {
    securityHeaders(res);
    const controller = new AbortController();
    active.add(controller);
    res.on('close', () => { active.delete(controller); if (!res.writableEnded) controller.abort(); });
    try {
      const allowedHosts = new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`, `[::1]:${actualPort}`]);
      if (!allowedHosts.has((req.headers.host || '').toLowerCase())) throw new AppError(403, '仅允许从本机工作台访问。', 'INVALID_HOST');
      if (req.headers.origin && ![...allowedHosts].some(allowed => req.headers.origin === `http://${allowed}`)) throw new AppError(403, '不允许来自其他网页的请求。', 'INVALID_ORIGIN');
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new AppError(403, '不允许跨站请求。', 'CROSS_SITE_REQUEST');
      let requestUrl;
      try { requestUrl = new URL(req.url, `http://${req.headers.host}`); } catch { throw new AppError(400, '请求地址不正确。', 'INVALID_PATH'); }
      const pathname = requestUrl.pathname;
      const method = req.method || 'GET';
      if (videoService && await videoService.handler(req, res, requestUrl)) return;
      if (pathname === '/api/health' && method === 'GET') return json(res, 200, { ok: true, name: 'Guangxuan Studio', version: '0.1.0', mode: 'local' });
      if (pathname === '/api/prompts' && method === 'GET') return json(res, 200, getPromptCatalog());
      if (pathname === '/api/projects' && method === 'GET') return json(res, 200, await store.list());
      const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
      if (projectMatch) {
        const id = validateProjectId(decodeURIComponent(projectMatch[1]));
        if (method === 'GET') {
          const project = await store.read(id);
          if (!project) throw new AppError(404, '项目不存在。', 'PROJECT_NOT_FOUND');
          return json(res, 200, { project });
        }
        if (method === 'PUT') return json(res, 200, { project: await store.save(id, await readJson(req)) });
        if (method === 'DELETE') { const deleted = await store.remove(id); return json(res, 200, { ok: true, deleted }); }
      }
      if (method === 'POST' && ['/api/ai', '/api/connect', '/api/models', '/api/import', '/api/export/docx'].includes(pathname)) {
        const body = await readJson(req);
        const requestKey = body.settings?.apiKey || ((pathname === '/api/connect' || pathname === '/api/models') ? body.apiKey : null);
        if (typeof requestKey === 'string' && requestKey.trim() && requestKey.length <= 4096) sessionSecrets.add(requestKey.trim());
        if (pathname === '/api/ai') return json(res, 200, await runAi(body.task, body.payload, body.settings, { signal: controller.signal }));
        if (pathname === '/api/connect') return json(res, 200, await connectProvider(body.settings || body, { signal: controller.signal }));
        if (pathname === '/api/models') return json(res, 200, await listProviderModels(body.settings || body, { signal: controller.signal }));
        if (pathname === '/api/import') return json(res, 200, importDocument(body));
        const document = createDocx(body);
        const filename = `${body.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 100) || '宣传文稿'}.docx`;
        res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Content-Length': document.length, 'Content-Disposition': `attachment; filename="guangxuan-export.docx"; filename*=UTF-8''${encodeURIComponent(filename)}`, 'Cache-Control': 'no-store' });
        return res.end(document);
      }
      if (pathname.startsWith('/api/')) throw new AppError(404, '找不到这个操作。', 'NOT_FOUND');
      if (method !== 'GET' && method !== 'HEAD') throw new AppError(405, '该资源不支持此操作。', 'METHOD_NOT_ALLOWED');
      await serveStatic(req, res, pathname);
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      if (error instanceof AppError) json(res, error.status, { error: error.message, code: error.code });
      else json(res, 500, { error: '本地服务处理失败，请重试。项目文件不会因此被删除。', code: 'INTERNAL_ERROR' });
    }
  });
  server.requestTimeout = 200000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(port), host, () => { server.off('error', reject); resolve(); }); });
  actualPort = server.address().port;
  const displayHost = host === '::1' ? '[::1]' : host;
  let closing;
  return {
    server,
    url: `http://${displayHost}:${actualPort}`,
    close() {
      if (closing) return closing;
      for (const controller of active) controller.abort();
      closing = new Promise((resolve, reject) => {
        const force = setTimeout(() => server.closeAllConnections(), 1500);
        force.unref();
        server.close(error => { clearTimeout(force); error ? reject(error) : resolve(); });
        server.closeIdleConnections();
      }).then(async () => { await store.settle(); await videoService?.close?.(); sessionSecrets.clear(); });
      return closing;
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const app = await startServer({ port: Number(process.env.PORT || 4317) });
  console.log(`光宣工作台已启动：${app.url}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { app.close().finally(() => process.exit(0)); });
}
