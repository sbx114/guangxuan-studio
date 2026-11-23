import path from 'node:path';
import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { AppError } from './errors.mjs';

export const WINDOWS_DPAPI_METHOD = 'windows-dpapi-current-user';
const MAX_OUTPUT = 64 * 1024;
const fail = (status, message, code) => new AppError(status, message, code);
const cancelled = () => Object.assign(fail(499, '连接配置操作已取消。', 'CONNECTION_CANCELLED'), { name: 'AbortError' });
const check = signal => { if (signal?.aborted) throw cancelled(); };

// The command is fixed. API keys and encrypted blobs travel only through stdin
// and stdout, never command arguments, process environment, temp files or logs.
export const WINDOWS_DPAPI_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$bytes = $null
$result = $null
try {
  Add-Type -AssemblyName System.Security
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
  $entropy = [Text.Encoding]::UTF8.GetBytes('GuangxuanStudio.connection-key.v1')
  if ($request.operation -eq 'probe') {
    $bytes = [Text.Encoding]::UTF8.GetBytes('gx-dpapi-capability-probe')
    $sealed = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, $scope)
    $opened = [System.Security.Cryptography.ProtectedData]::Unprotect($sealed, $entropy, $scope)
    if ([Text.Encoding]::UTF8.GetString($opened) -ne 'gx-dpapi-capability-probe') { throw 'probe failed' }
    $result = [Text.Encoding]::UTF8.GetBytes('ok')
  } elseif ($request.operation -eq 'protect' -or $request.operation -eq 'unprotect') {
    $bytes = [Convert]::FromBase64String([string]$request.payload)
    if ($request.operation -eq 'protect') {
      $result = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, $scope)
    } else {
      $result = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $entropy, $scope)
    }
  } else { throw 'unsupported operation' }
  [Console]::Out.Write((@{ok=$true; payload=[Convert]::ToBase64String($result)} | ConvertTo-Json -Compress))
  exit 0
} catch {
  [Console]::Out.Write('{"ok":false,"code":"DPAPI_FAILED"}')
  exit 1
} finally {
  if ($null -ne $bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
  if ($null -ne $result) { [Array]::Clear($result, 0, $result.Length) }
}`;

export function createWindowsDpapiProtector({ platform = process.platform, powershellPath, timeoutMs = 10000, retryDelayMs = 1000, spawnProcess = spawn } = {}) {
  let probe, retryAfter = Infinity;
  const retryDelay = Math.max(50, Math.min(30000, Number(retryDelayMs) || 1000));
  async function executable() {
    if (powershellPath !== undefined) return powershellPath;
    // Prefer the installed modern host when present. The legacy host can hang
    // loading System.Security on hosted Windows even before stdin is read.
    // Both hosts use the same CurrentUser DPAPI/entropy protocol. Do not search
    // PATH for an executable or change machine execution policy.
    const modern = path.join(process.env.ProgramFiles || 'C:/Program Files', 'PowerShell', '7', 'pwsh.exe');
    try { const info = await lstat(modern); if (info.isFile() && !info.isSymbolicLink()) return modern; } catch {}
    return path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  }
  async function invoke(operation, payload, { signal } = {}) {
    check(signal);
    if (platform !== 'win32') throw fail(503, '当前系统没有Windows用户加密存储。', 'DPAPI_PLATFORM_UNAVAILABLE');
    const binary = await executable(); check(signal);
    const input = JSON.stringify({ operation, payload }), args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_DPAPI_SCRIPT, 'utf16le').toString('base64')];
    const env = {};
    for (const [key, value] of Object.entries(process.env)) if (/^(?:SystemRoot|WINDIR|PATH|PATHEXT|COMSPEC|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA|USERNAME|USERDOMAIN|HOMEDRIVE|HOMEPATH|OS|PROCESSOR_ARCHITECTURE)$/i.test(key)) env[key] = value;
    return new Promise((resolve, reject) => {
      let child, failure, size = 0, timer, killTimer, hardTimer, closed = false, settled = false;
      const output = [];
      try { child = spawnProcess(binary, args, { windowsHide: true, shell: false, env, stdio: ['pipe', 'pipe', 'ignore'] }); }
      catch { reject(fail(503, '无法启动Windows安全存储。', 'DPAPI_PROCESS_UNAVAILABLE')); return; }
      const clear = () => { clearTimeout(timer); clearTimeout(killTimer); clearTimeout(hardTimer); signal?.removeEventListener('abort', abort); };
      const terminate = () => {
        child.kill();
        killTimer = setTimeout(() => child.kill('SIGKILL'), 1500);
        hardTimer = setTimeout(() => {
          if (closed || settled) return;
          settled = true; clear(); child.stdin?.destroy(); child.stdout?.destroy(); child.unref?.();
          reject(fail(503, 'Windows安全存储进程没有正常结束，本次未保存密钥。', 'DPAPI_PROCESS_EXIT_FAILED'));
        }, 4000);
      };
      const abort = () => { if (failure) return; failure = cancelled(); terminate(); };
      timer = setTimeout(() => { if (failure) return; failure = fail(503, 'Windows安全存储响应超时，本次未保存密钥。', 'DPAPI_TIMEOUT'); terminate(); }, Math.max(50, Math.min(30000, Number(timeoutMs) || 10000)));
      signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
      child.stdin.on('error', () => {});
      child.stdout.on('data', chunk => { size += chunk.length; if (size > MAX_OUTPUT) { if (!failure) { failure = fail(503, 'Windows安全存储返回无效结果。', 'DPAPI_OUTPUT_INVALID'); terminate(); } } else output.push(chunk); });
      child.once('error', () => { failure ||= fail(503, 'Windows安全存储不可用。', 'DPAPI_PROCESS_UNAVAILABLE'); });
      child.once('close', code => {
        closed = true; clear(); if (settled) return; settled = true;
        if (failure) return reject(failure);
        let response; try { response = JSON.parse(Buffer.concat(output).toString('utf8').replace(/^\uFEFF/, '')); } catch { return reject(fail(503, 'Windows安全存储返回无效结果。', 'DPAPI_OUTPUT_INVALID')); }
        if (code !== 0 || response?.ok !== true || typeof response.payload !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(response.payload)) return reject(fail(503, operation === 'unprotect' ? '已保存的密钥无法用当前Windows账户解密，请重新输入。' : 'Windows用户加密存储暂不可用。', operation === 'unprotect' ? 'DPAPI_DECRYPT_FAILED' : 'DPAPI_ENCRYPT_FAILED'));
        resolve(response.payload);
      });
      child.stdin.end(input);
    });
  }
  async function capability({ signal } = {}) {
    check(signal);
    if (platform !== 'win32') return { available: false, method: null, reasonCode: 'DPAPI_PLATFORM_UNAVAILABLE', message: '当前系统不支持Windows用户加密存储，密钥仅限当前会话。' };
    // A failed child has already exited before its probe settles. Allow one
    // later explicit operation to recheck, rather than caching a transient
    // startup failure forever. In-flight and successful probes stay shared;
    // no timer or background retry starts another process.
    if (probe && Date.now() >= retryAfter) probe = null;
    if (!probe) probe = (async () => {
      retryAfter = Infinity;
      try { await invoke('probe', '', { signal }); return { available: true, method: WINDOWS_DPAPI_METHOD, message: '可使用当前Windows账户加密保存密钥。' }; }
      catch (error) { if (error.name === 'AbortError' || error.status === 499) { probe = null; throw error; } retryAfter = Date.now() + retryDelay; return { available: false, method: null, reasonCode: error.code || 'DPAPI_UNAVAILABLE', message: '当前无法使用Windows用户加密存储，密钥仅限当前会话。' }; }
    })();
    const value = await probe; check(signal); return { ...value };
  }
  async function protect(value, { signal } = {}) {
    if (typeof value !== 'string' || !value || value.length > 4096 || /[\r\n]/.test(value)) throw fail(400, '密钥格式或长度无效。', 'CONNECTION_KEY_INVALID');
    const available = await capability({ signal }); if (!available.available) throw fail(503, available.message, available.reasonCode);
    return invoke('protect', Buffer.from(value, 'utf8').toString('base64'), { signal });
  }
  async function unprotect(value, { signal } = {}) {
    if (typeof value !== 'string' || !value || value.length > 32768 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw fail(503, '已保存的密钥密文无效，请重新输入。', 'DPAPI_DECRYPT_FAILED');
    const available = await capability({ signal }); if (!available.available) throw fail(503, available.message, available.reasonCode);
    const output = await invoke('unprotect', value, { signal });
    const key = Buffer.from(output, 'base64').toString('utf8');
    if (!key || key.length > 4096 || /[\r\n]/.test(key)) throw fail(503, '已保存的密钥无法读取，请重新输入。', 'DPAPI_DECRYPT_FAILED');
    return key;
  }
  return { capability, protect, unprotect };
}
