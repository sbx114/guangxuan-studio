import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PREFIX = 'integrations/openfilm/';
export const PLAYWRIGHT_VERSION = '1.61.1';

// Copy runtime code/assets explicitly. A source checkout's node_modules and
// user data must never hitch a ride, and ignored UI dist files must not be lost.
export const OPENFILM_RUNTIME_PATHS = [
  'LICENSE', 'TRADEMARK.md',
  'packages/openfilm/package.json', 'packages/openfilm/LICENSE',
  'packages/openfilm/TRADEMARK.md', 'packages/openfilm/THIRD_PARTY_NOTICES.md',
  'packages/openfilm/README.md', 'packages/openfilm/SPEC.md', 'packages/openfilm/MANUAL.md',
  'packages/openfilm/product.json', 'packages/openfilm/skill-catalog-seed.json',
  'packages/openfilm/bin', 'packages/openfilm/manual', 'packages/openfilm/examples-index',
  'packages/openfilm/src', 'packages/openfilm/library',
  'packages/openfilm/lib/music-rhythm.mjs',
  'packages/openfilm/studio/server', 'packages/openfilm/studio/client.mjs',
  'packages/openfilm/studio/ui/dist',
  'packages/shared/package.json', 'packages/shared/LICENSE', 'packages/shared/src',
].map(relative => PREFIX + relative);

const REQUIRED_RUNTIME_FILES = [
  'integrations/openfilm/LICENSE', 'integrations/openfilm/TRADEMARK.md',
  'integrations/openfilm/packages/openfilm/library/LICENSE.md',
  'integrations/openfilm/packages/openfilm/studio/server/server.mjs',
  'integrations/openfilm/packages/openfilm/lib/music-rhythm.mjs',
  'integrations/openfilm/packages/openfilm/src/film-doc.mjs',
  'integrations/openfilm/packages/openfilm/src/shared.mjs',
  'integrations/openfilm/packages/openfilm/src/guangxuan.mjs',
  'integrations/openfilm/packages/openfilm/studio/ui/dist/index.html',
  'integrations/openfilm/packages/shared/LICENSE',
];
const PRIVATE_DIRECTORIES = new Set(['node_modules', '.git', '.pnpm-store', '.dev', '.film', '.openfilm', '.data', '.cache', '.build-cache', '.animation-work', 'user-data', 'userdata', 'browser-profile', 'logs', 'test-results', 'playwright-report']);
const privateFile = name => /^\.env(?:\.|$)/i.test(name) || /\.(?:log|tmp|dmp|key|pem)$/i.test(name) || /^(?:connection-settings|desktop-runtime|settings\.local|credentials[^.]*)\.json(?:\.|$)/i.test(name) || /\.(?:test|spec)\.[^.]+$/i.test(name);
const inside = (candidate, root) => { const relative = path.relative(root, candidate); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); };

export async function inspectOpenFilmRuntime(root = ROOT) {
  const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  if (packageJson.dependencies?.['playwright-core'] !== PLAYWRIGHT_VERSION) throw new Error(`Root production dependencies must pin playwright-core ${PLAYWRIGHT_VERSION}.`);
  const files = new Map();
  async function collect(relative) {
    const absolute = path.join(root, ...relative.split('/'));
    let info;
    try { info = await fs.lstat(absolute); }
    catch { throw new Error(`Missing OpenFilm runtime path: ${relative}. Build the native Studio UI before packaging.`); }
    if (info.isSymbolicLink()) throw new Error(`A runtime source must be a regular file/directory, not a link: ${relative}`);
    if (info.isDirectory()) {
      for (const entry of await fs.readdir(absolute, { withFileTypes: true })) {
        if (entry.isDirectory() && PRIVATE_DIRECTORIES.has(entry.name.toLowerCase())) continue;
        if (privateFile(entry.name)) continue;
        await collect(`${relative}/${entry.name}`);
      }
    } else if (info.isFile() && !privateFile(path.basename(relative))) files.set(relative, info.size);
  }
  for (const relative of OPENFILM_RUNTIME_PATHS) await collect(relative);
  for (const required of REQUIRED_RUNTIME_FILES) if (!files.has(required)) throw new Error(`Required runtime/license file was not collected: ${required}`);
  const list = [...files.keys()].sort();
  if (list.some(relative => relative.split('/').some(part => PRIVATE_DIRECTORIES.has(part.toLowerCase())))) throw new Error('Private/runtime dependency folders entered the OpenFilm manifest.');
  return { root, files: list, totalBytes: [...files.values()].reduce((total, size) => total + size, 0), playwrightVersion: PLAYWRIGHT_VERSION };
}

export async function copyOpenFilmRuntime(destination, root = ROOT) {
  const target = path.resolve(destination);
  if (target === path.resolve(root) || inside(target, path.join(root, 'integrations'))) throw new Error('Choose a separate packaged application directory.');
  const inventory = await inspectOpenFilmRuntime(root);
  for (let start = 0; start < inventory.files.length; start += 16) {
    await Promise.all(inventory.files.slice(start, start + 16).map(async relative => {
      const output = path.join(target, ...relative.split('/'));
      if (!inside(output, target)) throw new Error('Runtime destination escaped its package.');
      await fs.mkdir(path.dirname(output), { recursive: true });
      await fs.copyFile(path.join(root, ...relative.split('/')), output);
    }));
  }
  for (const required of REQUIRED_RUNTIME_FILES) await fs.access(path.join(target, ...required.split('/')));
  async function inspectDestination(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || (entry.isDirectory() && PRIVATE_DIRECTORIES.has(entry.name.toLowerCase()))) throw new Error(`Unexpected dependency/private directory in packaged OpenFilm runtime: ${path.relative(target, path.join(directory, entry.name))}. Use a clean package destination.`);
      if (entry.isDirectory()) await inspectDestination(path.join(directory, entry.name));
      else if (/^\.env(?:\.|$)|\.(?:log|key|pem)$|^(?:connection-settings|desktop-runtime|settings\.local|credentials[^.]*)\.json(?:\.|$)/i.test(entry.name)) throw new Error('Private configuration must not be present in the packaged OpenFilm runtime.');
    }
  }
  await inspectDestination(path.join(target, 'integrations', 'openfilm'));
  return { destination: target, copiedFiles: inventory.files.length, totalBytes: inventory.totalBytes, playwrightVersion: PLAYWRIGHT_VERSION };
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked && (process.platform === 'win32' ? invoked.toLowerCase() === fileURLToPath(import.meta.url).toLowerCase() : invoked === fileURLToPath(import.meta.url))) {
  try {
    const args = process.argv.slice(2);
    if (args.includes('--check')) {
      const result = await inspectOpenFilmRuntime();
      console.log(JSON.stringify({ ready: true, runtimeFiles: result.files.length, totalBytes: result.totalBytes, playwrightVersion: result.playwrightVersion }));
    } else {
      const index = args.indexOf('--destination');
      if (index < 0 || !args[index + 1]) throw new Error('Use --check or --destination <packaged resources/app directory>.');
      console.log(JSON.stringify(await copyOpenFilmRuntime(args[index + 1])));
    }
  } catch (error) { console.error(String(error.message || error)); process.exitCode = 1; }
}
