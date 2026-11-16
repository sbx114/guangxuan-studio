/** Build the vendored, original Studio UI. Never starts Studio, downloads Chromium, or reads an OpenFilm home. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findInstalledGit } from '../lib/git-runtime.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WORKSPACE = path.join(ROOT, 'integrations', 'openfilm');
const PACKAGE = path.join(WORKSPACE, 'packages', 'openfilm');
const UI = path.join(PACKAGE, 'studio', 'ui');
const vite = path.join(PACKAGE, 'node_modules', 'vite', 'bin', 'vite.js');
const exists = async file => { try { await fs.access(file); return true; } catch { return false; } };
const flags = new Set(process.argv.slice(2).filter(argument => argument !== '--'));

async function run(executable, args, cwd, verbatim = false) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, shell: false, windowsHide: true, windowsVerbatimArguments: verbatim, stdio: 'inherit', env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1', ELECTRON_SKIP_BINARY_DOWNLOAD: '1' } });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`构建命令退出码：${code}`)));
  });
}

async function install() {
  const cli = process.env.npm_execpath;
  const args = ['--filter', 'openfilm', '--filter', '@openfilm/shared', 'install', '--ignore-scripts', '--config.manage-package-manager-versions=false', '--config.package-manager-strict=false'];
  if (cli && /pnpm\.(?:c?js)$/i.test(path.basename(cli))) return run(process.execPath, [cli, ...args], WORKSPACE);
  let command;
  try {
    const found = await promisify(execFile)(process.platform === 'win32' ? 'where.exe' : 'which', [process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'], { windowsHide: true });
    command = found.stdout.split(/\r?\n/).find(Boolean)?.trim();
  } catch { /* An explicit, actionable error below. */ }
  if (!command || /["%&|<>^\r\n]/.test(command)) throw new Error('安装集成依赖需要已安装的 pnpm。请在 integrations/openfilm 中执行 pnpm install --ignore-scripts。');
  if (process.platform === 'win32') return run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${command}" ${args.join(' ')}"`], WORKSPACE, true);
  return run(command, args, WORKSPACE);
}

try {
  if ([...flags].some(flag => !['--check', '--install'].includes(flag))) throw new Error('仅支持 --check 或 --install。');
  const source = await exists(path.join(PACKAGE, 'studio/server/server.mjs'));
  const dependencies = await exists(vite);
  const built = await exists(path.join(UI, 'dist/index.html'));
  const runtimeDependency = await exists(path.join(ROOT, 'node_modules/playwright-core/package.json'));
  if (flags.has('--check')) {
    const git = await findInstalledGit();
    console.log(JSON.stringify({ source, uiBuildDependencies: dependencies, uiBuilt: built, rootPlaywrightCore: runtimeDependency, gitAvailable: git.available, gitSource: git.source, ui: path.join(UI, 'dist') }, null, 2));
    if (!source || !dependencies || !built || !runtimeDependency) process.exitCode = 1;
  } else {
    if (!source) throw new Error('缺少 integrations/openfilm 的完整可编辑源码。');
    if (!dependencies) {
      if (!flags.has('--install')) throw new Error('缺少 Studio 构建依赖。可显式运行 node scripts/build-openfilm.mjs --install。');
      await install();
    }
    await run(process.execPath, [vite, 'build', '--config', 'studio/ui/vite.config.ts'], PACKAGE);
    if (!await exists(path.join(UI, 'dist/index.html'))) throw new Error('Studio UI 没有生成 index.html。');
    console.log(`Studio UI 已构建：${path.join(UI, 'dist')}`);
  }
} catch (error) {
  console.error(`OpenFilm 构建失败：${String(error.message || error)}`);
  process.exitCode = 1;
}
