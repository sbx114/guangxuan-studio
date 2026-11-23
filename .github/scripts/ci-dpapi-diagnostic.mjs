import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

// This diagnostic sends only the fixed synthetic capability probe. It never
// reads application data, credentials, tokens or an existing encrypted record.
const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(name); return at < 0 ? fallback : args[at + 1]; };
const sourceRoot = path.resolve(option('--source', process.cwd()));
const outputRoot = path.resolve(option('--output', path.dirname(fileURLToPath(import.meta.url))));
const pwshPath = option('--pwsh', path.join(process.env.ProgramFiles || 'C:/Program Files', 'PowerShell', '7', 'pwsh.exe'));
const { createWindowsDpapiProtector, WINDOWS_DPAPI_SCRIPT } = await import(pathToFileURL(path.join(sourceRoot, 'lib/windows-dpapi.mjs')));
const env = {};
for (const [name, value] of Object.entries(process.env)) if (/^(?:SystemRoot|WINDIR|PATH|PATHEXT|COMSPEC|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA|USERNAME|USERDOMAIN|HOMEDRIVE|HOMEPATH|OS|PROCESSOR_ARCHITECTURE)$/i.test(name)) env[name] = value;
const systemPath = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const stage = name => `[Console]::Error.WriteLine('GX_DPAPI_STAGE=${name}')`;
let script = WINDOWS_DPAPI_SCRIPT
  .replace('try {', `try {\n  ${stage('entered')}`)
  .replace('Add-Type -AssemblyName System.Security', `Add-Type -AssemblyName System.Security\n  ${stage('assembly')}`)
  .replace('$request = [Console]::In.ReadToEnd() | ConvertFrom-Json', `$request = [Console]::In.ReadToEnd() | ConvertFrom-Json\n  ${stage('stdin')}`)
  .replace('$sealed = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, $scope)', `$sealed = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, $scope)\n    ${stage('protected')}`)
  .replace('$opened = [System.Security.Cryptography.ProtectedData]::Unprotect($sealed, $entropy, $scope)', `$opened = [System.Security.Cryptography.ProtectedData]::Unprotect($sealed, $entropy, $scope)\n    ${stage('unprotected')}`)
  .replace('[Console]::Out.Write((@{ok=$true;', `${stage('response')}\n  [Console]::Out.Write((@{ok=$true;`)
  .replace('} catch {', `} catch {\n  ${stage('caught')}`);

async function run(label, binary, formatting = []) {
  const present = await stat(binary).then(info => info.isFile()).catch(() => false);
  if (!present) return { label, executablePresent: false, skippedReason: 'diagnostic comparison executable absent' };
  const started = Date.now(), stages = [], parts = [], errors = [];
  return new Promise(resolve => {
    let child, timedOut = false, stdoutTooLarge = false, stdoutBytes = 0, stderrOtherObserved = false, spawnFailed = false, killTimer;
    const command = ['-NoLogo', '-NoProfile', '-NonInteractive', ...formatting, '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
    try { child = spawn(binary, command, { windowsHide: true, shell: false, env, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { resolve({ label, executablePresent: true, spawnFailed: true }); return; }
    const timer = setTimeout(() => { timedOut = true; child.kill(); killTimer = setTimeout(() => child.kill('SIGKILL'), 1000); }, 12000);
    child.stdin.on('error', () => {});
    child.stdout.on('data', bytes => { stdoutBytes += bytes.length; if (stdoutBytes <= 65536) parts.push(bytes); else { stdoutTooLarge = true; child.kill(); } });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', text => { errors.push(text); for (const match of text.matchAll(/GX_DPAPI_STAGE=(entered|assembly|stdin|protected|unprotected|response|caught)/g)) stages.push({ stage: match[1], elapsedMs: Date.now() - started }); if (text.replace(/GX_DPAPI_STAGE=(entered|assembly|stdin|protected|unprotected|response|caught)\s*/g, '').trim()) stderrOtherObserved = true; });
    child.once('error', () => { spawnFailed = true; });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer); clearTimeout(killTimer);
      let response; try { response = JSON.parse(Buffer.concat(parts).toString('utf8').replace(/^\uFEFF/, '')); } catch {}
      resolve({ label, executablePresent: true, elapsedMs: Date.now() - started, timedOut, spawnFailed, stdoutTooLarge, exitCode, signal, stages, stderrOtherObserved, responseJson: Boolean(response), roundtripSucceeded: exitCode === 0 && response?.ok === true && response?.payload === 'b2s=' });
    });
    child.stdin.end(JSON.stringify({ operation: 'probe', payload: '' }));
  });
}
const started = Date.now();
const capability = await createWindowsDpapiProtector().capability();
const original = { available: capability.available, reasonCode: capability.reasonCode || null, elapsedMs: Date.now() - started };
const comparisons = [];
for (const [label, binary, formatting] of [['system-original-flags', systemPath, []], ['system-explicit-text', systemPath, ['-InputFormat', 'Text', '-OutputFormat', 'Text']], ['pwsh-explicit-text', pwshPath, ['-InputFormat', 'Text', '-OutputFormat', 'Text']]]) comparisons.push(await run(label, binary, formatting));
const report = { schemaVersion: 1, createdAt: new Date().toISOString(), platform: process.platform, nodeMajor: Number(process.versions.node.split('.')[0]), original, comparisons, syntheticProbeOnly: true, noDataStoreRead: true, noCredentialRead: true, noSecretsInArgumentsEnvironmentFilesOrReport: true, machinePolicyChanged: false };
await mkdir(outputRoot, { recursive: true });
await writeFile(path.join(outputRoot, 'safe-probe.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
