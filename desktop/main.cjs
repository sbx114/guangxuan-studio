const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } = require('electron');
const fs = require('node:fs/promises');
const { createWriteStream, mkdirSync } = require('node:fs');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

app.setName('Guangxuan Studio');
if (process.env.GUANGXUAN_USER_DATA) {
  const selectedDataDirectory = path.resolve(process.env.GUANGXUAN_USER_DATA);
  mkdirSync(selectedDataDirectory, { recursive: true });
  app.setPath('userData', selectedDataDirectory);
}
if (process.platform === 'win32') app.setAppUserModelId('studio.guangxuan.desktop');

let mainWindow = null;
let localServer = null;
let expectedOrigin = null;
let isQuitting = false;
const hasInstanceLock = app.requestSingleInstanceLock();

function configurationPath() {
  return path.join(app.getPath('userData'), 'connection-settings.json');
}

function assertTrustedSender(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents ||
      event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error('当前窗口不能执行此操作。');
  }
  let origin;
  try { origin = new URL(event.senderFrame.url).origin; } catch { /* invalid */ }
  if (origin !== expectedOrigin) throw new Error('当前页面不能执行此操作。');
}

function publicSettings(raw = {}) {
  const text = (value, limit) => typeof value === 'string' ? value.slice(0, limit).trim() : '';
  return {
    baseUrl: text(raw.baseUrl, 2048),
    model: text(raw.model, 200),
    apiStyle: raw.apiStyle === 'responses' ? 'responses' : 'chat',
    jsonMode: raw.jsonMode === true,
    timeoutSeconds: Math.max(10, Math.min(180, Number(raw.timeoutSeconds) || 90)),
  };
}

async function readConnection() {
  let stored = {};
  try { stored = JSON.parse(await fs.readFile(configurationPath(), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  const encryptionAvailable = safeStorage.isEncryptionAvailable();
  let apiKey = '';
  if (encryptionAvailable && typeof stored.encryptedApiKey === 'string') {
    try { apiKey = safeStorage.decryptString(Buffer.from(stored.encryptedApiKey, 'base64')); }
    catch { /* A moved profile or changed OS account must re-enter its key. */ }
  }
  return {
    ...publicSettings(stored), apiKey,
    rememberKey: Boolean(apiKey), encryptionAvailable,
  };
}

function registerIPC() {
  const handle = (channel, handler) => ipcMain.handle(channel, async (event, value) => {
    assertTrustedSender(event);
    return handler(value);
  });
  handle('gx:app-info', () => ({
    name: '光宣工作台', version: app.getVersion(), platform: process.platform,
    desktop: true, encryptionAvailable: safeStorage.isEncryptionAvailable(),
  }));
  handle('gx:load-connection', () => readConnection());
  handle('gx:save-connection', async ({ settings = {}, rememberKey = false } = {}) => {
    const stored = publicSettings(settings);
    const apiKey = typeof settings.apiKey === 'string' ? settings.apiKey.trim() : '';
    if (apiKey.length > 16384) throw new Error('密钥长度超出允许范围。');
    if (rememberKey && apiKey) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密存储不可用，请使用当前会话连接。');
      stored.encryptedApiKey = safeStorage.encryptString(apiKey).toString('base64');
    }
    await fs.mkdir(app.getPath('userData'), { recursive: true });
    const target = configurationPath();
    const temporary = `${target}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(stored, null, 2), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, target);
    return { saved: true, rememberKey: Boolean(stored.encryptedApiKey) };
  });
  handle('gx:clear-connection', async () => {
    try { await fs.unlink(configurationPath()); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { cleared: true };
  });
  handle('gx:choose-media', async () => {
    const selected = await dialog.showOpenDialog(mainWindow, {
      title: '导入视频、音频或图片', properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '媒体素材', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'png', 'jpg', 'jpeg', 'webp', 'bmp'] },
        { name: '视频', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v'] },
        { name: '音频', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'] },
        { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] },
      ],
    });
    if (selected.canceled) return [];
    if (selected.filePaths.length > 200) throw new Error('请每次导入不超过 200 个素材。');
    return selected.filePaths;
  });
  handle('gx:save-export', async ({ exportId, name } = {}) => {
    if (typeof exportId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(exportId))
      throw new Error('导出任务标识不正确。');
    const baseName = path.basename(String(name || '光宣工作台成片.mp4'))
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\.mp4$/i, '').slice(0, 170) + '.mp4';
    const selected = await dialog.showSaveDialog(mainWindow, {
      title: '保存导出视频', defaultPath: path.join(app.getPath('downloads'), baseName),
      filters: [{ name: 'MP4 视频', extensions: ['mp4'] }],
      properties: ['showOverwriteConfirmation', 'createDirectory'],
    });
    if (selected.canceled || !selected.filePath) return { canceled: true };
    const temporaryPath = `${selected.filePath}.guangxuan-${randomUUID()}.part`;
    try {
      const response = await fetch(`${expectedOrigin}/api/video/exports/${encodeURIComponent(exportId)}/file`, {
        signal: AbortSignal.timeout(10 * 60 * 1000),
      });
      if (!response.ok || !response.body) throw new Error('找不到完成的视频，请重新导出。');
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temporaryPath, { flags: 'wx' }));
      await fs.rename(temporaryPath, selected.filePath);
      return { canceled: false, filePath: selected.filePath };
    } catch (error) {
      try { await fs.unlink(temporaryPath); } catch { /* No temporary output remains. */ }
      if (error.message === '找不到完成的视频，请重新导出。') throw error;
      throw new Error('视频保存失败，请检查目标文件是否被占用或磁盘空间是否充足。');
    }
  });
  handle('gx:save-file', async (file = {}) => {
    if (typeof file.content !== 'string' || file.content.length > 90 * 1024 * 1024)
      throw new Error('导出内容为空或超过大小限制。');
    const name = path.basename(String(file.name || '光宣工作台导出.txt'))
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 180);
    const filters = Array.isArray(file.filters) ? file.filters.slice(0, 6).map((filter) => ({
      name: String(filter.name || '文件').slice(0, 30),
      extensions: Array.isArray(filter.extensions) ? filter.extensions
        .filter((extension) => typeof extension === 'string' && /^[a-z0-9]{1,10}$/i.test(extension))
        .slice(0, 8) : [],
    })).filter((filter) => filter.extensions.length) : undefined;
    const selected = await dialog.showSaveDialog(mainWindow, {
      title: '保存宣传材料', defaultPath: path.join(app.getPath('downloads'), name),
      filters, properties: ['showOverwriteConfirmation', 'createDirectory'],
    });
    if (selected.canceled || !selected.filePath) return { canceled: true };
    const buffer = Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8');
    if (buffer.length > 64 * 1024 * 1024) throw new Error('导出文件超过大小限制。');
    await fs.writeFile(selected.filePath, buffer);
    return { canceled: false, filePath: selected.filePath };
  });
}

function openExternal(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return;
    void shell.openExternal(url.href).catch(() => {});
  } catch { /* Invalid links stay inside the application. */ }
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    title: '光宣工作台', width: 1460, height: 960, minWidth: 1040, minHeight: 720,
    show: false, autoHideMenuBar: true, backgroundColor: '#f5f6f3',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });
  mainWindow.removeMenu();
  const contents = mainWindow.webContents;
  contents.session.setPermissionRequestHandler((wc, permission, callback) => {
    callback(wc === contents && permission === 'clipboard-sanitized-write');
  });
  contents.session.setPermissionCheckHandler((wc, permission) => wc === contents && permission === 'clipboard-sanitized-write');
  contents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  contents.on('will-navigate', (event, url) => {
    let destination;
    try { destination = new URL(url); } catch { event.preventDefault(); return; }
    if (destination.origin !== expectedOrigin) { event.preventDefault(); openExternal(url); }
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  await mainWindow.loadURL(localServer.url);
}

if (!hasInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.whenReady().then(async () => {
    if (!process.env.GUANGXUAN_BIN_DIR) {
      const binaryDirectory = app.isPackaged ? path.join(process.resourcesPath, 'bin') : path.join(__dirname, '..', 'bin');
      try { await fs.access(binaryDirectory); process.env.GUANGXUAN_BIN_DIR = binaryDirectory; }
      catch { /* A source checkout may provide FFmpeg through PATH instead. */ }
    }
    const serverModule = await import(pathToFileURL(path.join(__dirname, '..', 'server.mjs')).href);
    localServer = await serverModule.startServer({
      port: 0, host: '127.0.0.1', dataDir: app.getPath('userData'),
    });
    expectedOrigin = new URL(localServer.url).origin;
    registerIPC();
    await createWindow();
  }).catch(() => {
    dialog.showErrorBox('光宣工作台启动失败', '应用未能启动本地工作服务。请确认程序已完整解压，再重新打开。');
    app.exit(1);
  });
  app.on('activate', () => { if (!mainWindow && localServer) void createWindow(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', (event) => {
    if (isQuitting || !localServer) return;
    event.preventDefault();
    isQuitting = true;
    Promise.resolve(localServer.close()).finally(() => app.exit(0));
  });
}
