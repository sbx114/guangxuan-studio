import path from 'node:path';
import { access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';

const execute = promisify(execFile);
const pathValue = env => env[Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH'] || '';

/** Find an installed Git without changing PATH, installing anything, or reading Git credentials. */
export async function findInstalledGit({ env = process.env, platform = process.platform } = {}) {
  const commandEnv = { ...env };
  if (platform === 'win32') {
    for (const key of Object.keys(commandEnv)) if (key.toLowerCase() === 'path') delete commandEnv[key];
    commandEnv.PATH = pathValue(env);
  }
  const probe = async executable => {
    const { stdout } = await execute(executable, ['--version'], { env: commandEnv, windowsHide: true, timeout: 5000, maxBuffer: 32 * 1024 });
    if (!/^git version /i.test(stdout.trim())) throw new Error('The installed command did not identify itself as Git.');
    return stdout.trim().split(/\r?\n/, 1)[0];
  };
  try { return { available: true, source: 'PATH', directory: null, version: await probe('git') }; }
  catch (error) {
    // A present command refused by a policy or failing to run is not bypassed.
    if (platform !== 'win32' || error.code !== 'ENOENT') return { available: false, source: 'unavailable', directory: null, version: null };
  }
  const profile = env.USERPROFILE || homedir();
  const candidates = [
    env.ProgramW6432 && path.join(env.ProgramW6432, 'Git', 'cmd'),
    env.ProgramFiles && path.join(env.ProgramFiles, 'Git', 'cmd'),
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Git', 'cmd'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Git', 'cmd'),
    path.join(profile, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'native', 'git', 'cmd'),
  ].filter(Boolean);
  for (const directory of [...new Set(candidates)]) {
    const executable = path.join(directory, 'git.exe');
    try { await access(executable); }
    catch (error) { if (error.code === 'ENOENT') continue; return { available: false, source: 'unavailable', directory: null, version: null }; }
    try { return { available: true, source: 'installed-fallback', directory, version: await probe(executable) }; }
    catch { return { available: false, source: 'unavailable', directory: null, version: null }; }
  }
  return { available: false, source: 'not-installed', directory: null, version: null };
}

/** Called only inside the dedicated Studio worker; the parent environment is untouched. */
export async function configureWorkerGit() {
  const found = await findInstalledGit();
  if (process.platform === 'win32' && found.available && found.directory)
    process.env.PATH = `${found.directory}${path.delimiter}${pathValue(process.env)}`;
  return found;
}
