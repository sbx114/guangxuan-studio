import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile, realpath, stat } from 'node:fs/promises';
import { AppError, requireObject, boundedString } from './lib/errors.mjs';
import { runAi, connectProvider, listProviderModels } from './lib/ai.mjs';
import { getPromptCatalog } from './lib/prompts.mjs';
import { importDocument, createDocx } from './lib/documents.mjs';
import { createProjectStore, validateProjectId, assistantContentHash } from './lib/store.mjs';
import { createOpenFilmManager } from './lib/openfilm.mjs';
import { createProjectCovers } from './lib/project-covers.mjs';
import { createReferenceService } from './lib/references.mjs';
import { createTaskService } from './lib/tasks.mjs';
import { createTaskAdapters } from './lib/task-adapters.mjs';
import { createSourceAnalysisService } from './lib/source-analysis.mjs';
import { createProjectBundleService } from './lib/project-bundles.mjs';
import { createExportPreflight } from './lib/export-preflight.mjs';
import { createProjectLinkService } from './lib/project-links.mjs';
import { createMotionPreviewService } from './lib/motion-preview.mjs';
import { createScienceDocumentService } from './lib/science-documents.mjs';
import { createNovelAssetService } from './lib/novel-assets.mjs';
import { createNovelLibraryService } from './lib/novel-library.mjs';
import { createAssistantWebService } from './lib/assistant-web.mjs';
import { createAssistantAgentService } from './lib/assistant-agent.mjs';
import { normalizeAssistantWritingContext } from './lib/assistant-writing-context.mjs';
import { createAssistantAppTools } from './lib/assistant-app-tools.mjs';
import { createAssistantDownloadService } from './lib/assistant-downloads.mjs';
import { createAssistantMediaUnderstanding } from './lib/assistant-media-understanding.mjs';
import { createAssistantFrameReader } from './lib/assistant-frame-reader.mjs';
import { importWritingDocument } from './lib/writing-import.mjs';
import { normalizeWritingInput } from './lib/writing.mjs';
import { createWritingReferenceService, normalizeWritingReferenceConfig } from './lib/writing-references.mjs';
import { createRemotionProjectsService } from './lib/remotion-projects.mjs';
import { createRemotionIntegration } from './lib/remotion-integration.mjs';
import { createLocalDiagnostics } from './lib/local-diagnostics.mjs';
import { createAssistantArtifactService } from './lib/assistant-artifacts.mjs';
import { createConnectionStore } from './lib/connection-store.mjs';
import { createMusicCutService } from './lib/music-cut-service.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP_VERSION = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')).version;
const PUBLIC_ROOT = path.join(ROOT, 'public');
const MAX_BODY = 30 * 1024 * 1024;
const currentWritingOutput = (project, channel) => project.writing?.draft?.channel === channel ? project.writing.draft.output : project.outputs?.[channel];
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.wasm': 'application/wasm', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8' };

function securityHeaders(res, embeddedHome = false) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', embeddedHome ? 'SAMEORIGIN' : 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: data:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors ${embeddedHome ? "'self'" : "'none'"}; form-action 'self'`);
}

function json(res, status, data) {
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readJson(req, maximum = MAX_BODY) {
  const limit = Number.isSafeInteger(maximum) && maximum > 0 ? Math.min(MAX_BODY, maximum) : MAX_BODY;
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw new AppError(415, '请求需要使用 JSON 格式。', 'CONTENT_TYPE_REQUIRED');
  const lengthHeader = Number(req.headers['content-length']);
  if (Number.isFinite(lengthHeader) && lengthHeader > limit) { req.resume(); throw new AppError(413, '请求内容过大。', 'REQUEST_TOO_LARGE'); }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', chunk => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) { settled = true; reject(new AppError(413, '请求内容过大。', 'REQUEST_TOO_LARGE')); return; }
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

export async function startServer({ port = 0, host = '127.0.0.1', dataDir = process.env.GUANGXUAN_DATA_DIR || path.join(ROOT, '.data'), assistantWebDependencies, assistantVideoDependencies, remotionDependencies, connectionStoreDependencies, connectionAccessToken } = {}) {
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new AppError(400, '桌面服务仅允许绑定本机地址。', 'LOOPBACK_ONLY');
  if (!Number.isInteger(Number(port)) || Number(port) < 0 || Number(port) > 65535) throw new AppError(400, '端口设置不正确。', 'INVALID_PORT');
  // Supplied only by the trusted launcher. A bare local URL must not become
  // an oracle for decrypting the current Windows user's saved credentials.
  const connectionSession = typeof connectionAccessToken === 'string' && /^[A-Za-z0-9_-]{43}$/.test(connectionAccessToken) ? Buffer.from(connectionAccessToken) : null;
  const sessionSecrets = new Set(connectionSession ? [connectionAccessToken] : []);
  const diagnostics = await createLocalDiagnostics({ dataDir, sensitiveStrings: () => [...sessionSecrets] });
  const store = await createProjectStore(dataDir, { sensitiveStrings: () => [...sessionSecrets] });
  let connectionStorePromise;
  const connectionStore = () => (connectionStorePromise ||= createConnectionStore({ dataDir, protector: connectionStoreDependencies?.protector }).catch(error => { connectionStorePromise = null; throw error; }));
  const projectCovers = await createProjectCovers(dataDir);
  const writingReferences = createWritingReferenceService({ store });
  let videoService = null;
  const videoModulePath = path.join(ROOT, 'lib', 'video.mjs');
  try {
    await stat(videoModulePath);
    const videoModule = await import(pathToFileURL(videoModulePath).href);
    videoService = await videoModule.createVideoService({ dataDir, root: ROOT });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const references = await createReferenceService({ dataDir, store, videoService });
  let referenceUrls;
  let referenceUrlsPromise;
  async function urlReferences() {
    referenceUrlsPromise ||= import('./lib/reference-url.mjs').then(({ createReferenceUrlImporter }) => createReferenceUrlImporter({ dataDir, root: ROOT, ffmpegPath: videoService.runtimeTools().ffmpeg, ffprobePath: videoService.runtimeTools().ffprobe, dependencies: assistantVideoDependencies, importLocal: (filename, metadata) => videoService.importLocalFile(filename, metadata) })).then(value => (referenceUrls = value)).catch(error => { referenceUrlsPromise = null; throw error; });
    return referenceUrlsPromise;
  }
  const openFilm = await createOpenFilmManager({ dataDir, root: ROOT, store, registerOwnedAsset: (...args) => videoService.registerOwnedAsset(...args), resolveAsset: id => {
    if (!videoService?.resolveAsset) throw new AppError(503, '媒体库尚未就绪。', 'MEDIA_LIBRARY_UNAVAILABLE');
    return videoService.resolveAsset(id);
  } });
  const active = new Set();
  const tasks = await createTaskService({ dataDir, projectName: async id => (await store.read(id))?.title || '已移除项目', sensitiveStrings: () => [...sessionSecrets] });
  let sourceAnalysis;
  const taskAdapters = createTaskAdapters({ tasks, videoService, openFilm, sourceAnalysis: () => sourceAnalysis });
  sourceAnalysis = await createSourceAnalysisService({ dataDir, root: ROOT, store, videoService, openFilm, references, onJob(job, metadata) { void taskAdapters.analysisJob(job, metadata).catch(() => {}); } });
  const scienceDocuments = await createScienceDocumentService({ dataDir, root: ROOT, store });
  const novelAssets = await createNovelAssetService({ dataDir, store, videoService });
  const novelLibrary = await createNovelLibraryService({ dataDir, store, videoService });
  let bundles;
  const preflight = await createExportPreflight({ dataDir, root: ROOT, openFilm, videoService });
  const sourceLinks = await createProjectLinkService({ dataDir, store, sensitiveStrings: () => [...sessionSecrets] });
  const motionPreviews = await createMotionPreviewService({ dataDir, root: ROOT });
  let remotion;
  const remotionProjects = await createRemotionProjectsService({ dataDir, root: ROOT,
    resolveAsset: async (projectId, assetId) => {
      const parent = await store.read(projectId);
      if (!parent || parent.kind !== 'video') throw new AppError(404, '视频项目不存在。', 'PROJECT_NOT_FOUND');
      const native = await openFilm.context(projectId);
      if (!(native.assets || []).some(asset => asset.id === assetId)) throw new AppError(403, '素材不属于当前视频工程。', 'REMOTION_ASSET_SCOPE');
      return videoService.resolveAsset(assetId);
    },
    onJob: job => { void remotion?.onJob(job).catch(() => {}); },
  });
  remotion = createRemotionIntegration({ projects: remotionProjects, store, openFilm, videoService, references, sourceAnalysis, tasks, ...(remotionDependencies?.ai ? { ai: remotionDependencies.ai } : {}) });
  bundles = await createProjectBundleService({ dataDir, root: ROOT, store, videoService, openFilm, references, analysisService: sourceAnalysis, scienceDocuments, novelAssets, novelLibrary, remotionProjects, sensitiveStrings: () => [...sessionSecrets] });
  const rememberSecret = settings => {
    const key = settings?.apiKey;
    // Short local-provider placeholders are not safe global text patterns:
    // masking key "1" would corrupt ordinary project IDs, numbers and source.
    // Named credential fields and provider-error sanitization remain separate.
    if (typeof key === 'string' && key.trim().length >= 8 && key.length <= 4096) sessionSecrets.add(key.trim());
  };
  // Construction-time test transport only; never accepted from HTTP inputs.
  const assistantWeb = createAssistantWebService({ root: ROOT, dependencies: assistantWebDependencies });
  const assistantDownloads = await createAssistantDownloadService({ dataDir, webTools: assistantWeb, store, scienceDocuments, videoService });
  const mediaUnderstanding = await createAssistantMediaUnderstanding({ videoService, scienceDocuments, store, root: ROOT, transcribeAsset: (...args) => sourceAnalysis.transcribeAsset(...args) });
  const frameReader = videoService ? createAssistantFrameReader({ videoService, store, openFilm, sourceAnalysis, references }) : null;
  const artifacts = await createAssistantArtifactService({ dataDir, store, root: ROOT });
  const musicCuts = await createMusicCutService({ dataDir, store, openFilm });
  const assistantApps = createAssistantAppTools({ store, openFilm, videoService, references, writingReferences, sourceAnalysis, sourceLinks, scienceDocuments, novelLibrary, webTools: assistantWeb, downloads: assistantDownloads, videoImporter: urlReferences, mediaUnderstanding, frameReader, remotion, remotionProjects, preflight, tasks, taskAdapters, bundles, artifacts, projectCovers, musicCuts, root: ROOT });
  let assistant, assistantTaskQueue = Promise.resolve();
  const assistantTaskStates = new Map();
  function assistantJob(job) {
    assistantApps.finishRun(job);
    // The task centre only needs its compact latest status. Long-running jobs
    // must not queue copies of their entire log and all prior receipts.
    const last = job.steps?.at(-1);
    const partial = job.status === 'completed' && job.report?.outcome === 'partial';
    const snapshot = { id: job.id, projectId: job.projectId, instruction: String(job.instruction || '').slice(0, 100), status: partial ? 'failed' : job.status, batch: job.batch || 1, message: job.message?.slice(0, 360) || '', step: { label: last?.label || '', message: last?.message || '' }, error: job.error ? structuredClone(job.error) : partial ? { code:'ASSISTANT_PARTIAL',message:'本次制作尚未完成，请查看助手返回的具体原因。' } : null };
    const stateKey = JSON.stringify(snapshot);
    if (assistantTaskStates.get(job.id) === stateKey) return assistantTaskQueue;
    assistantTaskStates.set(job.id, stateKey);
    while (assistantTaskStates.size > 512) assistantTaskStates.delete(assistantTaskStates.keys().next().value);
    assistantTaskQueue = assistantTaskQueue.catch(() => {}).then(async () => {
      const step = snapshot.step;
      const runningPhase = (snapshot.batch > 1 ? `继续处理 · 第${snapshot.batch}批 · ` : '') + (step.label || '助手正在处理');
      await tasks.upsertExternal('assistant:' + snapshot.id, { type: 'assistant', title: 'AI助手 · ' + snapshot.instruction.slice(0, 100), projectId: snapshot.projectId || '', sourceJobId: snapshot.id }, {
        status: snapshot.status, progress: snapshot.status === 'completed' ? 100 : 0,
        phase: ({ queued: '等待助手处理', running: runningPhase, completed: '助手已完成', failed: '助手未完成', cancelled: '助手已停止', interrupted: '服务重启，助手已中断' })[snapshot.status] || '助手正在处理',
        message: snapshot.message?.slice(0, 360) || step?.message || '', error: snapshot.error || null,
      }, { safeRetry: false, cancel: async () => {
        const latest = await assistant.cancel(snapshot.id);
        // Cancellation can race with a completed run whose task snapshot is
        // still queued. Publish its real terminal state before tasks.cancel
        // applies its fallback cancelled status.
        await assistantJob(latest);
        return latest;
      } });
    });
    return assistantTaskQueue;
  }
  assistant = createAssistantAgentService({ dataDir, webTools: assistantWeb, appTools: assistantApps.tools, buildContext: assistantApps.buildContext, progressContext: assistantApps.progressContext, checkpoint: assistantApps.checkpoint, restoreCheckpoint: assistantApps.restoreCheckpoint, sensitiveStrings: () => [...sessionSecrets], onJob: assistantJob });
  for (const job of await assistant.list()) await assistantJob(job);
  async function commitTask(meta, operation) {
    const task = await tasks.create(meta);
    await tasks.update(task.id, { status: 'running', phase: meta.type === 'project-restore' ? '正在恢复项目' : '正在导入素材' });
    try {
      const result = await operation();
      await tasks.update(task.id, { ...(result?.projectId ? { projectId: result.projectId } : {}), status: 'succeeded', progress: 100, phase: meta.type === 'project-restore' ? '已恢复为新项目' : '已完成' });
      return result;
    } catch (error) {
      await tasks.update(task.id, { status: 'failed', error: { code: error.code || (meta.type === 'project-restore' ? 'PROJECT_RESTORE_FAILED' : 'MEDIA_IMPORT_FAILED'), message: error.message } });
      throw error;
    }
  }
  let actualPort;
  const server = http.createServer(async (req, res) => {
    securityHeaders(res, /^\/rhine\/index\.html(?:\?|$)/.test(req.url || ''));
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
      const connectionRoute = /^\/api\/connection\/(load|save|clear)$/.exec(pathname);
      if (connectionRoute) {
        if (method !== 'POST') { res.setHeader('Allow', 'POST'); throw new AppError(405, '连接配置仅支持同源JSON请求。', 'CONNECTION_METHOD_REQUIRED'); }
        const workbenchOrigin = new URL(`http://${req.headers.host}`).origin;
        if (!req.url.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\') || requestUrl.origin !== workbenchOrigin || req.headers.origin !== workbenchOrigin || requestUrl.search || requestUrl.hash) throw new AppError(403, '只能从当前工作台访问连接配置。', 'CONNECTION_ORIGIN_REQUIRED');
        const candidate = req.headers['x-gx-connection-session'];
        const received = typeof candidate === 'string' && /^[A-Za-z0-9_-]{43}$/.test(candidate) ? Buffer.from(candidate) : null;
        if (!connectionSession || !received || !timingSafeEqual(received, connectionSession)) throw new AppError(401, '请从 Gx 启动入口打开，以读取或保存密钥。', 'CONNECTION_SESSION_REQUIRED');
        const body = await readJson(req, 64 * 1024), action = connectionRoute[1];
        if (action === 'save') {
          rememberSecret(body.settings);
          if (Object.keys(body).some(key => !['settings', 'rememberKey'].includes(key)) || typeof body.rememberKey !== 'boolean') throw new AppError(400, '连接保存参数不正确。', 'CONNECTION_INPUT_INVALID');
          return json(res, 200, await (await connectionStore()).save({ settings: body.settings, rememberKey: body.rememberKey }, { signal: controller.signal }));
        }
        if (Object.keys(body).length) throw new AppError(400, '连接配置请求参数不正确。', 'CONNECTION_INPUT_INVALID');
        if (action === 'clear') return json(res, 200, await (await connectionStore()).clear({ signal: controller.signal }));
        const saved = await (await connectionStore()).load({ signal: controller.signal });
        rememberSecret(saved.settings);
        return json(res, 200, saved);
      }
      if (await artifacts.handler(req, res, requestUrl)) return;
      if (pathname === '/api/assistant/capabilities' && method === 'GET') return json(res, 200, { tools: assistantApps.capabilities() });
      if (pathname.startsWith('/api/projects/') && pathname.includes('/remotion') && await remotion.handler(req, res, requestUrl, { readJson, json, signal: controller.signal, rememberSecret })) return;
      if (pathname === '/api/writing/import' && method === 'POST') return json(res, 200, await importWritingDocument(await readJson(req), { signal: controller.signal }));
      const writingReferenceRoute = pathname.match(/^\/api\/projects\/([^/]+)\/writing-references$/);
      if (writingReferenceRoute && method === 'GET') return json(res, 200, await writingReferences.options(validateProjectId(decodeURIComponent(writingReferenceRoute[1]))));
      if (pathname === '/api/assistant/downloads' || pathname.startsWith('/api/assistant/downloads/')) {
        if (await assistantDownloads.handler(req, res, requestUrl)) return;
        throw new AppError(404, '找不到这个下载文件操作。', 'NOT_FOUND');
      }
      if (pathname === '/api/assistant/runs') {
        if (method === 'GET') return json(res, 200, { jobs: await assistant.list(requestUrl.searchParams.has('projectId') ? { projectId: validateProjectId(requestUrl.searchParams.get('projectId')) } : {}) });
        if (method === 'POST') {
          const body = await readJson(req);
          if (body.projectId) {
            validateProjectId(body.projectId);
            const project = await store.read(body.projectId);
            if (!project) throw new AppError(404, '请先打开仍存在的项目。', 'PROJECT_NOT_FOUND');
            if (body.writingContext != null) body.writingContext = normalizeAssistantWritingContext(body.writingContext, project);
          }
          else if (body.writingContext != null) throw new AppError(400, '文案助手需要选择当前文案项目。', 'ASSISTANT_WRITING_PROJECT_REQUIRED');
          rememberSecret(body.settings);
          return json(res, 202, await assistant.start(body, { origin: requestUrl.origin }));
        }
        throw new AppError(405, '助手任务不支持此操作。', 'METHOD_NOT_ALLOWED');
      }
      const assistantMatch = /^\/api\/assistant\/runs\/([a-f0-9-]{36})(?:\/(cancel|resume))?$/.exec(pathname);
      if (assistantMatch) {
        if (!assistantMatch[2] && method === 'GET') return json(res, 200, { job: await assistant.get(assistantMatch[1]) });
        if (assistantMatch[2] === 'cancel' && method === 'POST') { await readJson(req); return json(res, 200, { job: await assistant.cancel(assistantMatch[1]) }); }
        if (assistantMatch[2] === 'resume' && method === 'POST') { const body = await readJson(req); rememberSecret(body.settings); return json(res, 202, await assistant.resume(assistantMatch[1], body, { origin: requestUrl.origin })); }
        throw new AppError(405, '助手任务不支持此操作。', 'METHOD_NOT_ALLOWED');
      }
      if (pathname === '/api/assistant/undo' && method === 'POST') return json(res, 200, await assistantApps.undo(await readJson(req), { origin: requestUrl.origin }));
      if (pathname === '/api/novel-library' || pathname.startsWith('/api/novel-library/')) {
        if (method === 'POST' && pathname === '/api/novel-library/assets/upload') {
          await tasks.track({ type: 'shared-novel-asset-import', title: '导入公用人物或场景图片' }, async ({ signal }) => {
            const handled = await novelLibrary.handler(req, res, requestUrl, { signal });
            if (!handled) throw new AppError(404, '找不到公用素材操作。', 'NOT_FOUND');
            if (res.statusCode >= 400) throw new AppError(res.statusCode, '图片导入未完成，请查看素材库中的具体说明。', 'NOVEL_LIBRARY_UPLOAD_FAILED');
            return handled;
          }, { signal: controller.signal, safeRetry: false });
        } else if (!await novelLibrary.handler(req, res, requestUrl, { signal: controller.signal })) throw new AppError(404, '找不到公用素材操作。', 'NOT_FOUND');
        return;
      }
      const scienceDocumentRoute = pathname.match(/^\/api\/projects\/([^/]+)\/science-documents(?:\/([^/]+))?(?:\/source)?$/);
      if (scienceDocumentRoute) {
        const projectId = validateProjectId(decodeURIComponent(scienceDocumentRoute[1]));
        if (method === 'POST' && ['text', 'upload'].includes(scienceDocumentRoute[2])) {
          await tasks.track({ projectId, type: 'science-import', title: '导入论文与教材' }, async ({ signal, update }) => {
            await update({ phase: '正在解析资料与页段' });
            const handled = await scienceDocuments.handler(req, res, requestUrl, { signal });
            if (res.statusCode >= 400) throw new AppError(res.statusCode, '资料导入未完成，请查看导入窗口中的具体说明。', 'SCIENCE_DOCUMENT_IMPORT_FAILED');
            return handled;
          }, { signal: controller.signal, safeRetry: false });
        } else await scienceDocuments.handler(req, res, requestUrl, { signal: controller.signal });
        return;
      }
      const novelAssetRoute = pathname.match(/^\/api\/projects\/([^/]+)\/novel-assets(?:\/.*)?$/);
      if (novelAssetRoute) {
        const projectId = validateProjectId(decodeURIComponent(novelAssetRoute[1]));
        if (method === 'POST' && pathname.endsWith('/upload')) {
          await tasks.track({ projectId, type: 'novel-asset-import', title: '导入场景或人物图片' }, ({ signal }) => novelAssets.handler(req, res, requestUrl, { signal }), { signal: controller.signal, safeRetry: false });
        } else if (!await novelAssets.handler(req, res, requestUrl, { signal: controller.signal })) throw new AppError(404, '找不到此图片操作。', 'NOT_FOUND');
        return;
      }
      if (pathname === '/api/openfilm/import-progress' && method === 'POST') {
        const body = await readJson(req), projectId = validateProjectId(body.projectId);
        const owner = await store.read(projectId);
        if (!owner || owner.kind !== 'video') throw new AppError(404, '视频项目不存在。', 'PROJECT_NOT_FOUND');
        if (typeof body.id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(body.id) || !['queued', 'running', 'succeeded', 'failed'].includes(body.status) || typeof body.progress !== 'number' || !Number.isFinite(body.progress) || body.progress < 0 || body.progress > 1) throw new AppError(400, '导入进度格式不正确。', 'IMPORT_PROGRESS_INVALID');
        const name = boundedString(body.name, '导入名称', 160, { optional: true });
        if (/[\\/\x00-\x1f]/.test(name)) throw new AppError(400, '导入名称不能包含目录。', 'IMPORT_PROGRESS_INVALID');
        const task = await tasks.upsertExternal('native-import:' + projectId + ':' + body.id, { projectId, sourceJobId: body.id, type: 'media-import', title: '导入 · ' + (name || '媒体文件') }, { status: body.status, progress: body.progress * 100, phase: body.status === 'succeeded' ? '导入完成' : body.status === 'failed' ? '导入未完成' : '正在导入素材', error: body.status === 'failed' ? { code: 'NATIVE_IMPORT_FAILED', message: '导入未完成，请返回项目查看。' } : null }, { safeRetry: false });
        return json(res, 200, { task });
      }
      if (await tasks.handler(req, res, requestUrl)) return;
      if (await motionPreviews.handler(req, res, requestUrl)) return;
      if (pathname === '/api/source-links/candidates' && method === 'GET') return json(res, 200, await sourceLinks.candidates());
      const sourceLinkMatch = pathname.match(/^\/api\/projects\/([^/]+)\/source-link(?:\/(unlink|sync))?$/);
      if (sourceLinkMatch) {
        const id = validateProjectId(decodeURIComponent(sourceLinkMatch[1])), action = sourceLinkMatch[2];
        if (!action && method === 'GET') return json(res, 200, await sourceLinks.status(id));
        if (method === 'POST') {
          const body = await readJson(req);
          const result = action === 'unlink' ? await sourceLinks.unlink(id) : action === 'sync' ? await sourceLinks.sync(id, body) : await sourceLinks.bind(id, body);
          return json(res, 200, result);
        }
        throw new AppError(405, '来源版本不支持此操作。', 'METHOD_NOT_ALLOWED');
      }
      if (/^\/api\/projects\/[^/]+\/source-analysis(?:\/|$)/.test(pathname)) {
        const body = method === 'POST' ? await readJson(req) : undefined;
        rememberSecret(body?.settings);
        if (await sourceAnalysis.handler(req, res, requestUrl, { body, settings: body?.settings, origin: requestUrl.origin })) return;
      }
      const preflightMatch = pathname.match(/^\/api\/projects\/([^/]+)\/export-preflight$/);
      if (preflightMatch && ['GET', 'POST'].includes(method)) {
        const id = validateProjectId(decodeURIComponent(preflightMatch[1])), body = method === 'POST' ? await readJson(req) : {};
        const report = await tasks.track({ projectId: id, type: 'export-preflight', title: body.deep === true ? '导出深度体检' : '导出前体检' }, ({ signal }) => preflight.check(id, { range: body.range, fps: body.fps, deep: body.deep === true, signal, origin: requestUrl.origin }), { signal: controller.signal, safeRetry: true });
        return json(res, 200, report);
      }
      if (pathname === '/api/video/preview-animation' && method === 'POST') {
        const body = await readJson(req), projectId = body.projectId ? validateProjectId(body.projectId) : '';
        if (projectId && !await store.read(projectId)) throw new AppError(404, '项目不存在。', 'PROJECT_NOT_FOUND');
        const result = await tasks.track({ projectId, type: 'motion-preview', title: '动画分镜预览' }, async ({ signal, update }) => {
          const value = await motionPreviews.preview(body.plan, { sceneIndexes: body.sceneIndexes, times: body.times, signal, onProgress: progress => { void update({ progress: Math.round(progress * 100), phase: '正在生成分镜画面' }).catch(() => {}); } });
          await update({ outputs: value.frames.map(frame => ({ label: frame.label || '分镜画面', url: frame.url })) });
          return value;
        }, { signal: controller.signal, safeRetry: true });
        return json(res, 200, result);
      }
      if (pathname === '/api/project-bundles/exports' && method === 'POST') {
        const body = await readJson(req), projectId = validateProjectId(body.projectId);
        const result = await tasks.track({ projectId, type: 'project-backup', title: '完整项目备份' }, async ({ signal, update }) => {
          const value = await bundles.prepareExport(projectId, { signal, onProgress: progress => { void update({ progress: progress.totalBytes > 0 ? Math.round(progress.bytes / progress.totalBytes * 100) : 0, phase: '正在打包工程与素材' }).catch(() => {}); } });
          await update({ outputs: [{ label: '保存完整项目包', url: value.downloadUrl }] });
          return value;
        }, { signal: controller.signal, safeRetry: false });
        return json(res, 201, result);
      }
      if (pathname === '/api/project-bundles/imports' && method === 'POST') {
        if (!/^(?:application\/octet-stream|application\/gzip|application\/x-gxproject)(?:;|$)/i.test(req.headers['content-type'] || '')) throw new AppError(415, '请选择Gx完整项目包。', 'BUNDLE_CONTENT_TYPE');
        const result = await tasks.track({ type: 'project-verify', title: '核验完整项目包' }, ({ signal }) => bundles.receiveImport(req, { signal }), { signal: controller.signal, safeRetry: false });
        return json(res, 201, result);
      }
      const restoreMatch = pathname.match(/^\/api\/project-bundles\/imports\/([^/]+)\/restore$/);
      if (restoreMatch && method === 'POST') {
        const body = await readJson(req);
        if (body.confirm !== true) throw new AppError(400, '请确认预检报告后恢复。', 'BUNDLE_CONFIRM_REQUIRED');
        const result = await commitTask({ type: 'project-restore', title: '恢复完整项目包' }, () => bundles.restoreImport(restoreMatch[1], { title: body.title, origin: requestUrl.origin }));
        return json(res, 201, result);
      }
      if (await bundles.handler(req, res, requestUrl)) return;
      if (pathname === '/api/project-covers' && method === 'POST') return json(res, 201, await projectCovers.upload(req));
      const coverMatch = pathname.match(/^\/api\/project-covers\/([a-f0-9-]+)$/);
      if (coverMatch && ['GET', 'HEAD'].includes(method)) {
        const bytes = await projectCovers.read(coverMatch[1]);
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': bytes.length, 'Cache-Control': 'private, max-age=31536000, immutable' });
        return res.end(method === 'HEAD' ? undefined : bytes);
      }
      if (pathname === '/openfilm/editor.html' && ['GET', 'HEAD'].includes(method)) return openFilm.serveEditor(req, res, requestUrl);
      const musicRoute = /^\/api\/projects\/([^/]+)\/music-(rhythm|cut|cut-undo)(?:\/([a-f0-9-]{36}))?$/.exec(pathname);
      if (musicRoute) {
        const projectId = validateProjectId(decodeURIComponent(musicRoute[1]));
        if (method === 'GET' && musicRoute[2] === 'cut' && musicRoute[3]) return json(res, 200, await musicCuts.status(projectId, musicRoute[3]));
        if (method !== 'POST' || musicRoute[3]) throw new AppError(405, '该音乐操作需要POST。', 'METHOD_NOT_ALLOWED');
        const body = await readJson(req);
        const allowed = musicRoute[2] === 'cut-undo' ? ['undoId'] : ['musicAssetId', 'musicClipId', 'sourceRange', 'sourcePath', 'sourceVersion', 'expectedRevision', ...(musicRoute[2] === 'cut' ? ['requestId', 'assetIds', 'range', 'timelineAt', 'musicSpeed', 'musicVolume', 'cadence', 'allowUncertain', 'reuseSources', 'originalVolume'] : [])];
        if (Object.keys(body).some(key => !allowed.includes(key))) throw new AppError(400, '音乐操作不接受外部拍点或未知参数。', 'MUSIC_CUT_INPUT');
        const context = { origin: requestUrl.origin, signal: controller.signal };
        if (musicRoute[2] === 'rhythm') return json(res, 200, await musicCuts.analyze({ ...body, projectId }, context));
        if (musicRoute[2] === 'cut-undo') return json(res, 200, await musicCuts.undo({ ...body, projectId }, context));
        return json(res, 200, await tasks.track({ projectId, type: 'editing', title: '按音乐节奏自动卡点' }, async ({ update, signal }) => musicCuts.cut({ ...body, projectId }, { ...context, signal, update: phase => update({ phase }) }), { signal: controller.signal, safeRetry: false, acceptCommittedResult: result => result?.applied === true && typeof result.nativeUndoId === 'string' && /^[a-f0-9]{16}$/.test(result.revision || '') && /^[a-f0-9]{64}$/.test(result.sourceVersion || '') }));
      }
      if (pathname === '/api/openfilm/status' && method === 'GET') return json(res, 200, await openFilm.status());
      if (pathname === '/api/openfilm/context' && method === 'GET') return json(res, 200, await openFilm.context(requestUrl.searchParams.get('projectId'), req.headers.origin || requestUrl.origin));
      if (pathname === '/api/openfilm/exports' && method === 'GET') return json(res, 200, await openFilm.nativeExports(validateProjectId(requestUrl.searchParams.get('projectId'))));
      const nativeDownload = pathname.match(/^\/api\/openfilm\/exports\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\/file$/);
      if (nativeDownload && ['GET', 'HEAD'].includes(method)) return await openFilm.download(req, res, nativeDownload[1], nativeDownload[2]);
      if (method === 'POST' && ['/api/openfilm/open', '/api/openfilm/context', '/api/openfilm/apply-plan', '/api/openfilm/append-asset', '/api/openfilm/import-asset', '/api/openfilm/assistant-undo', '/api/openfilm/export'].includes(pathname)) {
        const body = await readJson(req);
        const origin = req.headers.origin || requestUrl.origin;
        if (pathname === '/api/openfilm/open') {
          const result = await openFilm.open(body.projectId, origin);
          await taskAdapters.watchNativeProject(body.projectId).catch(() => {});
          return json(res, 200, result);
        }
        if (pathname === '/api/openfilm/context') return json(res, 200, await openFilm.context(body.projectId, origin));
        if (pathname === '/api/openfilm/import-asset') return json(res, 200, await openFilm.importAsset(body.projectId, body.assetId, origin, { expectedRevision: body.expectedRevision || body.revision, requestId: body.requestId, signal: controller.signal }));
        if (pathname === '/api/openfilm/apply-plan') return json(res, 200, await openFilm.applyPlan(body.projectId, body.plan || body, origin, body.expectedRevision || body.revision, { keepUndo: body.keepUndo === true, editScope: body.editScope }));
        if (pathname === '/api/openfilm/assistant-undo') return json(res, 200, await openFilm.undoAssistant(body.projectId, body.undoId, origin));
        if (pathname === '/api/openfilm/export') {
          const report = await preflight.check(body.projectId, { range: body.spec?.range, fps: body.spec?.fps, signal: controller.signal, origin });
          if (!report.canExport) throw Object.assign(new AppError(409, '导出前检查发现必须修复的问题。', 'EXPORT_PREFLIGHT_BLOCKED'), { report });
          const result = await openFilm.exportVideo(body.projectId, body.spec || {}, origin);
          await taskAdapters.watchNativeProject(body.projectId).catch(() => {});
          return json(res, 200, result);
        }
        return json(res, 200, await openFilm.appendAsset(body.projectId, body.assetId, origin, body.at, { keepUndo: body.keepUndo === true, expectedRevision: body.expectedRevision, requestId: body.requestId, editScope: body.editScope, placement: body.placement }));
      }
      if (videoService && method === 'POST' && ['/api/video/upload', '/api/video/import-local', '/api/video/import-generated'].includes(pathname)) {
        await commitTask({ type: 'media-import', title: '导入媒体素材' }, () => videoService.handler(req, res, requestUrl));
        return;
      }
      if (videoService && await videoService.handler(req, res, requestUrl)) return;
      const referenceMatch = pathname.match(/^\/api\/projects\/([^/]+)\/references(?:\/([^/]+))?$/);
      if (referenceMatch) {
        const projectId = validateProjectId(decodeURIComponent(referenceMatch[1]));
        const referenceId = referenceMatch[2] ? decodeURIComponent(referenceMatch[2]) : null;
        if (referenceId === 'url' && method === 'POST') {
          const current = await references.list(projectId);
          if (current.items.length >= 8) throw new AppError(400, '最多支持8条参考。', 'REFERENCE_LIMIT');
          const body = await readJson(req);
          const url = boundedString(body.url, '视频网址', 4000);
          const focus = boundedString(body.focus, '参考重点', 1500, { optional: true });
          const imported = await (await urlReferences()).import(url, { signal: controller.signal });
          if (imported.asset?.type !== 'video') throw new AppError(415, '网址未返回可用视频，请选择公开视频链接。', 'REFERENCE_URL_NOT_VIDEO');
          controller.signal.throwIfAborted();
          return json(res, 201, await references.add(projectId, { type: 'video', assetId: imported.asset.id, name: String(imported.title || imported.asset.name || '网址视频').slice(0, 120), sourceUrl: imported.sourceUrl, focus, aspects: body.aspects, sourceRange: body.sourceRange, targetRange: body.targetRange }));
        }
        if (!referenceId && method === 'GET') return json(res, 200, await references.list(projectId));
        if (!referenceId && method === 'POST') return json(res, 201, await references.add(projectId, await readJson(req)));
        if (!referenceId && method === 'PATCH') return json(res, 200, await references.configure(projectId, await readJson(req)));
        if (referenceId && method === 'PATCH') return json(res, 200, await references.update(projectId, referenceId, await readJson(req)));
        if (referenceId && method === 'DELETE') return json(res, 200, await references.remove(projectId, referenceId));
        throw new AppError(405, '参考内容不支持此操作。', 'METHOD_NOT_ALLOWED');
      }
      if (pathname === '/api/health' && method === 'GET') return json(res, 200, { ok: true, name: 'Guangxuan Studio', version: APP_VERSION, mode: 'local' });
      if (pathname === '/api/prompts' && method === 'GET') return json(res, 200, getPromptCatalog());
      if (pathname === '/api/projects' && method === 'GET') return json(res, 200, await store.list());
      if (pathname === '/api/projects/summary' && method === 'GET') {
        const result = await store.summary();
        for (const project of result.projects) {
          const native = await openFilm.summary(project.id);
          if (!native) continue;
          const rootTime = Date.parse(project.updatedAt);
          const nativeTime = Date.parse(native.updatedAt);
          const updatedAt = Number.isFinite(nativeTime) && (!Number.isFinite(rootTime) || nativeTime > rootTime) ? native.updatedAt : project.updatedAt;
          Object.assign(project, native, { updatedAt });
        }
        result.projects.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
        return json(res, 200, result);
      }
      const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
      if (projectMatch) {
        const id = validateProjectId(decodeURIComponent(projectMatch[1]));
        if (method === 'GET') {
          const project = await store.read(id);
          if (!project) throw new AppError(404, '项目不存在。', 'PROJECT_NOT_FOUND');
          return json(res, 200, { project });
        }
        if (method === 'PUT') { const body=await readJson(req); return json(res, 200, { project: await store.save(id, body, { requireExisting: Object.hasOwn(body, 'writingRevision') }) }); }
        if (method === 'PATCH') {
          const project = await store.patchMetadata(id, await readJson(req));
          await openFilm.syncMetadata(project).catch(() => {});
          return json(res, 200, { project });
        }
        if (method === 'DELETE') { const deleted = await store.remove(id); return json(res, 200, { ok: true, deleted }); }
      }
      if (method === 'POST' && ['/api/ai', '/api/connect', '/api/models', '/api/import', '/api/export/docx'].includes(pathname)) {
        const body = await readJson(req);
        const requestKey = body.settings?.apiKey || ((pathname === '/api/connect' || pathname === '/api/models') ? body.apiKey : null);
        if (typeof requestKey === 'string' && requestKey.trim() && requestKey.length <= 4096) sessionSecrets.add(requestKey.trim());
        if (pathname === '/api/ai') {
          if (body.task === 'remotion-reference-review') throw new AppError(403, '参考对照需要由工程中的真实画面凭据发起。', 'REMOTION_REFERENCE_TRUST_REQUIRED');
          const payload = { ...requireObject(body.payload, '任务参数') };
          delete payload.references;
          delete payload.sourceAnalysis;
          delete payload.sourceDraft;
          delete payload.document;
          delete payload.assetCatalog;
          delete payload.referenceFrameAnalysis;
          delete payload.referenceEvidence;
          let referenceContext;
          let projectId = payload.referenceProjectId || payload.projectId || '';
          if (['edit-assistant', 'edit-plan', 'animation-plan'].includes(body.task) && payload.referenceProjectId !== undefined) {
            referenceContext = await references.context(validateProjectId(payload.referenceProjectId), { signal: controller.signal });
            payload.references = referenceContext.references;
          }
          if (projectId) projectId = validateProjectId(projectId);
          let writingBase;
          if (['writing-draft', 'writing-revise'].includes(body.task)) {
            if (!projectId) throw new AppError(400, '请先打开文案项目。', 'WRITING_PROJECT_REQUIRED');
            const project = await store.read(projectId);
            if (!project || project.kind !== 'writing') throw new AppError(404, '请先打开仍存在的文案项目。', 'WRITING_PROJECT_REQUIRED');
            payload.source = project.source || { title: '', text: '', url: '' };
            payload.facts = project.sourceChanged ? [] : project.facts || [];
            const referenceConfig = normalizeWritingReferenceConfig(project.writing?.references);
            if (payload.writingReferences !== undefined && assistantContentHash({ references: normalizeWritingReferenceConfig(payload.writingReferences) }) !== assistantContentHash({ references: referenceConfig })) throw new AppError(409, '参考设置已有更新，请重试。', 'WRITING_REFERENCE_CHANGED');
            payload.writingReferences = await writingReferences.context(project, referenceConfig);
            if (body.task === 'writing-revise' && payload.channel) payload.writingBrief = { ...payload.writingBrief, channel: payload.channel };
            const channel = normalizeWritingInput(body.task, payload).channel;
            const output = currentWritingOutput(project, channel);
            if (body.task === 'writing-revise' && assistantContentHash({ output: payload.output }) !== assistantContentHash({ output })) throw new AppError(409, '当前稿件已有更新，你的改写要求已保留，请基于最新稿件再试。', 'WRITING_INPUT_CHANGED');
            writingBase = { id: project.id, createdAt: project.createdAt, writingRevision: project.writingRevision || 0, source: assistantContentHash({ source: project.source, facts: project.facts }), output: body.task === 'writing-revise' ? assistantContentHash({ output }) : null, channel, referenceConfig: assistantContentHash({ references: referenceConfig }), referenceHash: payload.writingReferences.fingerprint };
          }
          if (body.task === 'visual-novel') {
            if (!projectId || (await store.read(projectId))?.kind !== 'science') throw new AppError(400, '请先打开一个科普项目。', 'SCIENCE_PROJECT_REQUIRED');
            payload.document = await scienceDocuments.context(projectId, payload.documentSelection, { signal: controller.signal, maxCharacters: 60000 });
            const selection = payload.librarySelection || payload.config?.librarySelection || { characterId: payload.config?.selectedCharacterId, backgroundId: payload.config?.selectedBackgroundId };
            const resolved = await novelLibrary.resolveSelection(selection, { signal: controller.signal });
            payload.config = { ...resolved.config, interactionDensity: payload.config?.interactionDensity || 'balanced', instruction: payload.config?.instruction || '' };
            payload.assetCatalog = resolved.assetCatalog;
          }
          if (projectId && ['edit-assistant', 'edit-plan', 'animation-plan'].includes(body.task)) payload.sourceDraft = await sourceLinks.context(projectId);
          if (projectId && ['edit-assistant', 'edit-plan'].includes(body.task)) {
            const assets = body.task === 'edit-assistant' ? payload.context?.assets : payload.assets;
            const selectedIds = Array.isArray(payload.editScope?.assetIds) ? payload.editScope.assetIds : assets?.map(asset => asset.id);
            const evidence = await sourceAnalysis.context(projectId, { origin: requestUrl.origin, assetIds: selectedIds });
            payload.sourceAnalysis = evidence.sourceAnalysis;
          }
          const title = ({ extract: '提取事实', generate: '生成宣传内容', review: '核对内容', rewrite: '改写文案', 'writing-draft': '起草当前文案', 'writing-revise': '精修当前文案', 'edit-plan': 'AI粗剪方案', 'edit-assistant': 'AI剪辑助手', 'animation-plan': 'AI动画编排', 'visual-novel': '生成互动讲解' })[body.task] || 'AI处理';
          const result = await tasks.track({ projectId, type: 'ai', title }, async ({ signal }) => {
            const result = await runAi(body.task, payload, body.settings, { signal, images: referenceContext?.images || [] });
            if (writingBase) {
            const latest = await store.read(writingBase.id);
            if (!latest || latest.createdAt !== writingBase.createdAt) throw new AppError(409, '原项目已移除或重建，生成结果没有重新创建项目。', 'WRITING_INPUT_CHANGED');
            let referencesChanged = false;
            try { referencesChanged = assistantContentHash({ references: normalizeWritingReferenceConfig(latest.writing?.references) }) !== writingBase.referenceConfig || (await writingReferences.context(latest)).fingerprint !== writingBase.referenceHash; }
            catch (error) { if (String(error.code || '').startsWith('WRITING_REFERENCE_')) referencesChanged = true; else throw error; }
            if (referencesChanged || (latest.writingRevision || 0) !== writingBase.writingRevision || assistantContentHash({ source: latest.source, facts: latest.facts }) !== writingBase.source || (writingBase.output !== null && assistantContentHash({ output: currentWritingOutput(latest, writingBase.channel) }) !== writingBase.output)) result.meta = { ...result.meta, inputChanged: true, inputChangeNote: '材料、稿件或参考已更新，新稿保留为候选。' };
            }
            return result;
          }, { signal: controller.signal, safeRetry: false });
          return json(res, 200, result);
        }
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
      if (error instanceof AppError) json(res, error.status, { error: error.message, code: error.code, ...(error.report ? { report: error.report } : {}) });
      else {
        const incident = await diagnostics.capture(error, { method: req.method, route: typeof req.url === 'string' ? req.url.split('?')[0] : '' }).catch(() => null);
        json(res, 500, { error: `本地服务处理失败${incident ? '（错误编号 ' + incident.id.slice(0, 8) + '）' : ''}，请重试。项目文件不会因此被删除。`, code: 'INTERNAL_ERROR', ...(incident ? { errorId: incident.id } : {}) });
      }
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
      }).then(async () => {
        await assistant.close();
        await assistantApps.close();
        await musicCuts.close();
        await artifacts.close();
        await remotionProjects.close(); await remotion.close();
        await mediaUnderstanding.close?.();
        await assistantDownloads.close();
        // A stopped tool can finish its commit while the adapter is draining.
        // Flush the late receipt before the desktop process exits.
        await assistant.close();
        await assistantWeb.close();
        await assistantTaskQueue.catch(() => {});
        await bundles.close();
        await novelLibrary.close();
        await scienceDocuments.close();
        await novelAssets.close();
        await sourceAnalysis.close();
        await motionPreviews.close();
        await preflight.close();
        await taskAdapters.close();
        await sourceLinks.close();
        await tasks.close();
        const connections = await connectionStorePromise?.catch(() => null); await connections?.close?.();
        await diagnostics.close();
        await references.close?.(); await referenceUrls?.close?.();
        await frameReader?.close(); await store.settle(); await openFilm.close(); await videoService?.close?.(); sessionSecrets.clear();
      });
      return closing;
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const app = await startServer({ port: Number(process.env.PORT || 4317) });
  console.log(`光宣工作台已启动：${app.url}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { app.close().finally(() => process.exit(0)); });
}
