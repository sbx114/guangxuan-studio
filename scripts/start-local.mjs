import { fork, spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDesktopRuntime } from '../lib/desktop-session.mjs';
import { ensureDistributionRuntime } from '../lib/distribution-runtime.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const dataDir = path.resolve(process.env.GUANGXUAN_USER_DATA || path.join(process.env.LOCALAPPDATA || process.env.APPDATA || ROOT, 'GuangxuanStudio'));
const stateFile = path.join(dataDir, 'desktop-runtime.json');

async function installedEdge() {
  const candidates = [
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].filter(Boolean);
  for (const executable of [...new Set(candidates)]) { try { await fs.access(executable); return executable; } catch { /* Next installed location. */ } }
  throw new Error('未找到 Microsoft Edge，请先安装 Edge 后重试。');
}

async function existingService() {
  try {
    const state = await readDesktopRuntime(stateFile);
    const url = new URL(state.url);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !['4317', '4417'].includes(url.port)) return null;
    const status = await (await fetch(`${url.origin}/api/desktop/status`, { signal: AbortSignal.timeout(1800) })).json();
    if (status.app === 'GuangxuanStudioDesktopLauncher' && status.instanceId === state.instanceId) return state;
  } catch { /* An old launcher state is harmless. */ }
  return null;
}

async function stopService(state) {
  if (!state) return;
  const response = await fetch(`${new URL(state.url).origin}/api/desktop/shutdown`, {
    method: 'POST', headers: { 'x-guangxuan-control': state.controlToken }, signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('本地服务未能停止，请关闭应用后重试。');
}

async function startService() {
  await fs.mkdir(dataDir, { recursive: true });
  const bin = await ensureDistributionRuntime({ root: ROOT, dataDir });
  if (bin) { process.env.GUANGXUAN_BIN_DIR = bin; process.env.GUANGXUAN_REMOTION_BIN_DIR = path.join(path.dirname(bin), 'compositor'); }
  const log = openSync(path.join(dataDir, 'desktop-server.log'), 'a');
  const child = fork(path.join(HERE, 'local-server.mjs'), [], {
    execPath: process.execPath, execArgv: [], cwd: ROOT,
    windowsHide: true, detached: true,
    env: { ...process.env, GUANGXUAN_USER_DATA: dataDir },
    stdio: ['ignore', log, log, 'ipc'],
  });
  closeSync(log);
  return new Promise((resolve, reject) => {
    let complete = false;
    const timeout = setTimeout(() => finish(new Error('本地服务启动超时，请查看应用数据目录中的 desktop-server.log。')), 30000);
    const finish = (error, result) => {
      if (complete) return;
      complete = true;
      clearTimeout(timeout);
      if (child.connected) child.disconnect();
      child.unref();
      if (error) reject(error); else resolve(result);
    };
    child.on('message', (message) => {
      if (message?.type === 'ready') finish(null, message);
      if (message?.type === 'error') finish(new Error(message.message));
    });
    child.on('error', () => finish(new Error('无法启动已安装的 Node.js 本地服务。')));
    child.on('exit', (code) => { if (!complete) finish(new Error(`本地服务提前退出（${code}）。`)); });
  });
}

export async function resolveLaunchService(healthyService, startNewService = startService) {
  // A healthy instance owns the shared workspace, regardless of which copy of
  // the launcher opened it. Upgrades use the explicit stop command instead.
  if (healthyService) return healthyService;
  return startNewService();
}

export function connectionLaunchUrl(state) {
  const url = new URL(state.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !['4317', '4417'].includes(url.port) || url.username || url.password) throw new Error('本地服务地址不正确。');
  if (typeof state.connectionAccessToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(state.connectionAccessToken)) throw new Error('请重新启动 Gx 本地服务，以启用密钥保存。');
  const launch = new URL(url.origin);
  // Fragments do not enter HTTP requests, referrers, or server logs. The
  // client consumes this independent capability before removing the fragment.
  launch.hash = `gx-connection-session=${state.connectionAccessToken}`;
  return launch;
}

async function runLauncher() {
 try {
  if (process.platform !== 'win32') throw new Error('此启动入口用于 Windows；其他系统请使用 node server.mjs。');
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('需要 Node.js 24 或更新版本。');
  let state = await existingService();
  if (process.argv.includes('--check')) {
    await installedEdge();
    await fs.access(path.join(ROOT, 'node_modules', '@remotion', 'renderer'));
    console.log(JSON.stringify({ node: process.versions.node, edgeInstalled: true, renderingDependencies: true, running: state ? new URL(state.url).origin : null }));
  } else if (process.argv.includes('--stop')) {
    await stopService(state);
    console.log(state ? 'Gx 本地服务已停止。' : 'Gx 本地服务当前未运行。');
  } else {
    const edge = await installedEdge();
    state = await resolveLaunchService(state);
    const url = connectionLaunchUrl(state);
    const edgeWindow = spawn(edge, [
      `--app=${url.href}`, `--user-data-dir=${path.join(dataDir, 'browser-profile')}`,
      '--window-size=1460,960', '--no-first-run', '--no-default-browser-check',
    ], { detached: true, stdio: 'ignore', windowsHide: false });
    await new Promise((resolve, reject) => { edgeWindow.once('spawn', resolve); edgeWindow.once('error', () => reject(new Error('无法打开 Edge 应用窗口。'))); });
    edgeWindow.unref();
    console.log(`Gx 已打开独立窗口。本地服务：${url.origin}`);
  }
} catch (error) {
  console.error(`启动失败：${String(error.message || error)}`);
  process.exitCode = 1;
}
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const thisPath = fileURLToPath(import.meta.url);
if (invokedPath && (process.platform === 'win32' ? invokedPath.toLowerCase() === thisPath.toLowerCase() : invokedPath === thisPath)) {
  await runLauncher();
}
