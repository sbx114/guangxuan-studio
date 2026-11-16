import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = path.resolve(process.env.GUANGXUAN_USER_DATA || path.join(process.env.LOCALAPPDATA || process.env.APPDATA || ROOT, 'GuangxuanStudio'));
const stateFile = path.join(dataDir, 'desktop-runtime.json');
const preferencesFile = path.join(dataDir, 'desktop-preferences.json');
const instanceId = randomUUID();
const controlToken = randomUUID();
let localServer;
let closing = false;

async function shutdown() {
  if (closing) return;
  closing = true;
  try {
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    if (state.instanceId === instanceId) await fs.unlink(stateFile);
  } catch { /* The state may already be absent. */ }
  await localServer?.close().catch(() => {});
  process.exit(0);
}

function tokenMatches(candidate) {
  const received = Buffer.from(typeof candidate === 'string' ? candidate : '');
  const expected = Buffer.from(controlToken);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

try {
  await fs.mkdir(dataDir, { recursive: true });
  if (!process.env.GUANGXUAN_BIN_DIR) {
    const candidates = [
      path.join(ROOT, 'bin'),
      path.resolve(ROOT, '..', 'bin'),
      path.resolve(ROOT, '..', '光宣工作台-Windows-x64', 'resources', 'bin'),
    ];
    for (const candidate of candidates) {
      try { await fs.access(path.join(candidate, 'ffmpeg.exe')); await fs.access(path.join(candidate, 'ffprobe.exe')); process.env.GUANGXUAN_BIN_DIR = candidate; break; }
      catch { /* A developer may also provide executables through PATH. */ }
    }
  }
  let previousPort = 4417;
  try {
    const preferences = JSON.parse(await fs.readFile(preferencesFile, 'utf8'));
    if ([4317, 4417].includes(preferences.port)) previousPort = preferences.port;
  } catch { /* The first launch uses the dedicated application port. */ }
  for (const port of [previousPort, ...[4417, 4317].filter(value => value !== previousPort)]) {
    try { localServer = await startServer({ port, host: '127.0.0.1', dataDir }); break; }
    catch (error) { if (error.code !== 'EADDRINUSE') throw error; }
  }
  if (!localServer) throw new Error('4317 和 4417 端口均被占用，请关闭占用程序后重试。');
  const normalHandlers = localServer.server.listeners('request');
  localServer.server.removeAllListeners('request');
  localServer.server.on('request', (req, res) => {
    if (req.url?.startsWith('/api/desktop/')) {
      const origin = new URL(localServer.url).origin;
      if (req.headers.host !== new URL(localServer.url).host || (req.headers.origin && req.headers.origin !== origin)) {
        res.writeHead(403); res.end(); return;
      }
    }
    if (req.url === '/api/desktop/status' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify({ app: 'GuangxuanStudioDesktopLauncher', instanceId, version: '0.1.0' }));
      return;
    }
    if (req.url === '/api/desktop/shutdown' && req.method === 'POST') {
      if (!tokenMatches(req.headers['x-guangxuan-control'])) { res.writeHead(403); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end('{"stopped":true}');
      setImmediate(shutdown);
      return;
    }
    for (const handler of normalHandlers) handler.call(localServer.server, req, res);
  });
  await fs.writeFile(`${stateFile}.tmp`, JSON.stringify({ instanceId, controlToken, url: localServer.url, pid: process.pid, appRoot: ROOT }), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(`${stateFile}.tmp`, stateFile);
  await fs.writeFile(`${preferencesFile}.tmp`, JSON.stringify({ port: Number(new URL(localServer.url).port) }), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(`${preferencesFile}.tmp`, preferencesFile);
  if (process.connected) process.send({ type: 'ready', url: localServer.url, instanceId });
} catch (error) {
  if (process.connected) process.send({ type: 'error', message: String(error.message || '本地服务启动失败。') });
  else console.error(String(error.message || '本地服务启动失败。'));
  await localServer?.close().catch(() => {});
  process.exit(1);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
