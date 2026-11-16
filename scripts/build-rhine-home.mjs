import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const INTEGRATION = path.join(ROOT, 'integrations', 'rhinelab-ui');
const DIST = path.join(INTEGRATION, 'dist');
const TARGET = path.join(ROOT, 'public', 'rhine');
const DEPENDENCIES = ['vite', 'typescript', 'three', '@kitlangton/rolling-number'];
const REQUIRED_DIST = ['index.html', 'fonts/MiSans-license.pdf', 'fonts/NOTICE.txt', 'licenses/rolling-number.txt', 'assets/boot-lettering-notice.txt'];
const EXTRA_LICENSES = [
  { source: path.join(INTEGRATION, 'LICENSE'), relative: 'licenses/RhineLabUI-MIT.txt' },
  { source: path.join(INTEGRATION, 'node_modules', 'three', 'LICENSE'), relative: 'licenses/Three-MIT.txt' },
];

function contained(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function exists(file) {
  try { await fs.access(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function inspect() {
  const missingDependencies = [];
  for (const dependency of DEPENDENCIES)
    if (!await exists(path.join(INTEGRATION, 'node_modules', dependency, 'package.json'))) missingDependencies.push(dependency);
  const missingDistFiles = [];
  for (const relative of REQUIRED_DIST) if (!await exists(path.join(DIST, relative))) missingDistFiles.push(relative);
  const missingLicenseSources = [];
  for (const { source } of EXTRA_LICENSES) if (!await exists(source)) missingLicenseSources.push(path.relative(ROOT, source));
  return { integration: INTEGRATION, destination: TARGET, dependenciesReady: !missingDependencies.length, missingDependencies, distReady: !missingDistFiles.length, missingDistFiles, licensesReady: !missingLicenseSources.length, missingLicenseSources };
}

async function findManager() {
  const inherited = process.env.npm_execpath;
  if (inherited && /(?:npm-cli|pnpm)\.(?:c?js)$/i.test(path.basename(inherited)) && await exists(inherited))
    return { name: /pnpm/i.test(path.basename(inherited)) ? 'pnpm' : 'npm', executable: process.execPath, prefix: [inherited] };
  for (const name of ['npm', 'pnpm']) {
    try {
      const search = await execFileAsync(process.platform === 'win32' ? 'where.exe' : 'which', [process.platform === 'win32' ? `${name}.cmd` : name], { windowsHide: true });
      const executable = search.stdout.split(/\r?\n/).map(line => line.trim()).find(Boolean);
      if (executable && await exists(executable)) return { name, executable, prefix: [] };
    } catch { /* Try the next installed package manager. */ }
  }
  throw new Error('没有找到 npm 或 pnpm。请安装 Node.js 包管理器，或在已有 npm/pnpm 的终端运行此命令。');
}

async function managerCommand(manager, argumentsList) {
  // Only fixed installation/build arguments reach a shell. User-provided
  // command fragments, project paths and model text are never interpolated.
  const args = [...manager.prefix, ...argumentsList];
  let executable = manager.executable;
  let commandArgs = args;
  let verbatim = false;
  if (process.platform === 'win32' && /\.cmd$/i.test(executable)) {
    if (/["%&|<>^\r\n]/.test(executable) || !argumentsList.every(argument => /^[A-Za-z0-9:=._-]+$/.test(argument)))
      throw new Error('包管理器路径无法安全调用，请通过 npm run build:home 或 pnpm run build:home 运行。');
    commandArgs = ['/d', '/s', '/c', `""${executable}" ${argumentsList.join(' ')}"`];
    executable = process.env.ComSpec || 'cmd.exe';
    verbatim = true;
  }
  await new Promise((resolve, reject) => {
    const child = spawn(executable, commandArgs, { cwd: INTEGRATION, stdio: 'inherit', windowsHide: true, windowsVerbatimArguments: verbatim, shell: false });
    child.once('error', () => reject(new Error(`无法启动 ${manager.name}。`)));
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${manager.name} 命令失败（${code}）。当前首页入口未更新。`)));
  });
}

async function regularFiles(directory, prefix = '') {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`构建产物含符号链接，拒绝复制：${relative}`);
    if (entry.isDirectory()) files.push(...await regularFiles(path.join(directory, entry.name), relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

async function prepareTarget() {
  const rootReal = await fs.realpath(ROOT);
  for (const directory of [path.join(ROOT, 'public'), TARGET]) {
    if (!contained(path.resolve(directory), ROOT)) throw new Error('目标目录越出项目。');
    try { if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error('目标目录是符号链接，拒绝复制。'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.mkdir(directory, { recursive: true });
    if (!contained(await fs.realpath(directory), rootReal)) throw new Error('目标目录链接到了项目外部，拒绝复制。');
  }
  return fs.realpath(TARGET);
}

async function atomicCopy(source, relative, targetReal) {
  const destination = path.resolve(TARGET, relative);
  if (!contained(destination, TARGET)) throw new Error('目标文件越出首页目录。');
  let parent = TARGET;
  for (const part of path.relative(TARGET, path.dirname(destination)).split(path.sep).filter(Boolean)) {
    parent = path.join(parent, part);
    try {
      const existing = await fs.lstat(parent);
      if (existing.isSymbolicLink() || !existing.isDirectory()) throw new Error('目标父路径不是普通目录，拒绝复制。');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await fs.mkdir(parent);
    }
    if (!contained(await fs.realpath(parent), targetReal)) throw new Error('目标父目录越出首页目录。');
  }
  try {
    const current = await fs.lstat(destination);
    if (current.isSymbolicLink() || !current.isFile()) throw new Error(`目标不是普通文件，拒绝覆盖：${relative}`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = `${destination}.gx-${randomUUID()}.tmp`;
  try { await fs.copyFile(source, temporary); await fs.rename(temporary, destination); }
  catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
}

async function copyHome() {
  const state = await inspect();
  if (!state.distReady) throw new Error(`首页产物不完整：${state.missingDistFiles.join('、')}。请先运行 npm run build:home。`);
  if (!state.licensesReady) throw new Error(`缺少许可源文件：${state.missingLicenseSources.join('、')}。请安装集成项目依赖后重试。`);
  const sourceReal = await fs.realpath(DIST);
  if (!contained(sourceReal, await fs.realpath(INTEGRATION))) throw new Error('dist 链接到了集成项目外部，拒绝复制。');
  const files = (await regularFiles(DIST)).sort();
  const index = await fs.readFile(path.join(DIST, 'index.html'), 'utf8');
  if (/src=["'][^"']*\/src\/main\.ts["']/.test(index)) throw new Error('首页仍是开发入口，请先完成生产构建。');
  const targetReal = await prepareTarget();
  let copied = 0;
  for (const relative of files) {
    if (relative === 'index.html') continue;
    await atomicCopy(path.join(DIST, relative), relative, targetReal);
    copied++;
  }
  for (const license of EXTRA_LICENSES) { await atomicCopy(license.source, license.relative, targetReal); copied++; }
  // Keep old hashed assets and unknown files intact. Publish the entry point
  // only after all of its resources and required license notices are present.
  await atomicCopy(path.join(DIST, 'index.html'), 'index.html', targetReal);
  console.log(JSON.stringify({ copiedFiles: copied + 1, destination: TARGET, indexCopiedLast: true, preservedExistingFiles: true }));
}

async function main() {
  const flags = new Set(process.argv.slice(2).filter(argument => argument !== '--'));
  if ([...flags].some(flag => !['--check', '--copy-only', '--install'].includes(flag)))
    throw new Error('支持的参数为 --check、--copy-only 或 --install。');
  if ((flags.has('--check') || flags.has('--copy-only')) && flags.has('--install'))
    throw new Error('--check/--copy-only 不安装依赖；需要安装时请单独使用 --install。');
  if (!await exists(path.join(INTEGRATION, 'package.json'))) throw new Error('缺少 integrations/rhinelab-ui 源码，请使用完整源码包。');
  const state = await inspect();
  if (flags.has('--check')) {
    console.log(JSON.stringify(state, null, 2));
    if (!state.dependenciesReady || !state.distReady || !state.licensesReady) process.exitCode = 1;
    return;
  }
  if (!flags.has('--copy-only')) {
    const pkg = JSON.parse(await fs.readFile(path.join(INTEGRATION, 'package.json'), 'utf8'));
    if (/prepare-webfonts/.test(`${pkg.scripts?.prebuild || ''} ${pkg.scripts?.build || ''}`))
      throw new Error('集成项目仍引用作者专用字体恢复脚本，请先使用已适配的嵌入构建配置。');
    const manager = await findManager();
    if (!state.dependenciesReady) {
      if (!flags.has('--install')) throw new Error(`缺少集成依赖：${state.missingDependencies.join('、')}。请运行 npm run build:home -- --install（或 pnpm run build:home --install）。`);
      const install = manager.name === 'npm' && await exists(path.join(INTEGRATION, 'package-lock.json')) ? ['ci'] : ['install'];
      await managerCommand(manager, install);
    }
    await managerCommand(manager, ['run', 'build']);
  }
  await copyHome();
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const thisPath = fileURLToPath(import.meta.url);
if (invokedPath && (process.platform === 'win32' ? invokedPath.toLowerCase() === thisPath.toLowerCase() : invokedPath === thisPath)) {
  await main().catch(error => { console.error(`首页构建失败：${String(error.message || error)}`); process.exitCode = 1; });
}
