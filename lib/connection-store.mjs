import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { AppError } from './errors.mjs';
import { renameWithRetry } from './atomic-file.mjs';
import { createWindowsDpapiProtector, WINDOWS_DPAPI_METHOD } from './windows-dpapi.mjs';

export const CONNECTION_SETTINGS_FILENAME = 'connection-settings.json';
const fail = (status, message, code) => new AppError(status, message, code);
const check = signal => { if (signal?.aborted) throw Object.assign(fail(499, '连接配置操作已取消。', 'CONNECTION_CANCELLED'), { name: 'AbortError' }); };
const comparable = value => process.platform === 'win32' ? value.toLowerCase() : value;
const empty = () => ({ baseUrl: '', model: '', apiStyle: 'chat', jsonMode: false, timeoutSeconds: 90 });

function publicSettings(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail(400, '连接配置需为对象。', 'CONNECTION_SETTINGS_INVALID');
  const string = (value, limit, label) => { if (value === undefined || value === null) return ''; if (typeof value !== 'string' || value.length > limit || /[\r\n]/.test(value)) throw fail(400, `${label}格式或长度无效。`, 'CONNECTION_SETTINGS_INVALID'); return value.trim(); };
  const baseUrl = string(input.baseUrl, 2000, '接口地址'), model = string(input.model, 300, '模型名称');
  if (baseUrl) { let url; try { url = new URL(baseUrl); } catch { throw fail(400, '接口地址需为完整HTTP(S)网址。', 'CONNECTION_SETTINGS_INVALID'); } if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw fail(400, '接口地址不能包含账号密码、查询参数或片段。', 'CONNECTION_SETTINGS_INVALID'); }
  return { baseUrl, model, apiStyle: input.apiStyle === 'responses' ? 'responses' : 'chat', jsonMode: input.jsonMode === true, timeoutSeconds: Math.max(10, Math.min(180, Number(input.timeoutSeconds) || 90)) };
}
function keyInput(input) {
  if (input === undefined) return undefined;
  if (typeof input !== 'string' || input.length > 4096 || /[\r\n]/.test(input)) throw fail(400, '密钥格式或长度无效。', 'CONNECTION_KEY_INVALID');
  return input.trim();
}
function rejectKnownKeyInPublicSettings(settings, key) {
  if (typeof key !== 'string' || key.length < 8) return;
  for (const field of [settings.baseUrl, settings.model]) {
    let decoded = field;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (decoded.includes(key)) throw fail(400, '密钥不能填写在接口地址或模型名称中，请更正后再保存。', 'CONNECTION_PUBLIC_SECRET');
      let next; try { next = decodeURIComponent(decoded); } catch { break; }
      if (next === decoded) break; decoded = next;
    }
  }
}
async function unlinked(candidate, { missing = false } = {}) {
  const absolute = path.resolve(candidate), root = path.parse(absolute).root;
  let current = root;
  for (const part of ['', ...path.relative(root, absolute).split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    try { const info = await lstat(current); if (info.isSymbolicLink() || info.isFile() && info.nlink > 1) throw fail(403, '连接配置目录或文件不能使用链接。', 'CONNECTION_STORAGE_LINK'); }
    catch (error) { if (missing && error.code === 'ENOENT') return; throw error; }
  }
}

/** Public connection values and CurrentUser ciphertext share one atomic record. */
export async function createConnectionStore({ dataDir, protector = createWindowsDpapiProtector() } = {}) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || !protector?.capability || !protector?.protect || !protector?.unprotect) throw fail(500, '连接存储未正确配置。', 'CONNECTION_STORAGE_INVALID');
  const directory = path.resolve(dataDir), filename = path.join(directory, CONNECTION_SETTINGS_FILENAME);
  let closed = false, tail = Promise.resolve();
  function serial(operation) { if (closed) return Promise.reject(fail(503, '连接存储正在关闭。', 'CONNECTION_STORE_CLOSED')); const result = tail.catch(() => {}).then(operation); tail = result; return result; }
  async function capabilityValue(options = {}) {
    check(options.signal);
    let value;
    try { value = await protector.capability(options); }
    catch (error) { check(options.signal); if (error.name === 'AbortError' || error.status === 499) throw error; return { available: false, method: null, reasonCode: 'DPAPI_UNAVAILABLE', message: '当前安全存储不可用，密钥仅限当前会话。' }; }
    return { available: value?.available === true, method: value?.available === true ? WINDOWS_DPAPI_METHOD : null, ...(typeof value?.reasonCode === 'string' && /^[A-Z0-9_]{1,100}$/.test(value.reasonCode) ? { reasonCode: value.reasonCode } : {}), message: value?.available === true ? '可使用当前Windows账户加密保存密钥。' : '当前安全存储不可用，密钥仅限当前会话。' };
  }
  async function readRecord(signal) {
    check(signal); await unlinked(filename, { missing: true });
    let handle;
    try {
      handle = await open(filename, 'r'); const info = await handle.stat();
      if (!info.isFile() || info.size > 64 * 1024 || comparable(await realpath(filename)) !== comparable(filename)) throw fail(403, '连接配置文件不是有效的普通文件。', 'CONNECTION_STORAGE_INVALID');
      const raw = await handle.readFile('utf8'); check(signal);
      let value; try { value = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch { return { value: null, invalid: true }; }
      if (!value || typeof value !== 'object' || Array.isArray(value)) return { value: null, invalid: true };
      return { value, invalid: false };
    } catch (error) { if (error.code === 'ENOENT') return { value: null, invalid: false }; throw error; }
    finally { await handle?.close(); }
  }
  function stateOf(record) {
    const value = record.value;
    if (!value) return { settings: empty(), configured: false, rememberKey: null, encrypted: '', format: '', invalid: record.invalid };
    let settings; try { settings = publicSettings(value.settings || value); } catch { return { settings: empty(), configured: false, rememberKey: null, encrypted: '', format: '', invalid: true }; }
    const native = value.provider === WINDOWS_DPAPI_METHOD && value.version === 1;
    return { settings, configured: value.configured !== false, rememberKey: native && typeof value.rememberKey === 'boolean' ? value.rememberKey : null, encrypted: typeof value.encryptedApiKey === 'string' ? value.encryptedApiKey : '', format: native ? WINDOWS_DPAPI_METHOD : 'legacy', invalid: false, plaintextIgnored: Object.hasOwn(value, 'apiKey') || Boolean(value.settings && Object.hasOwn(value.settings, 'apiKey')) };
  }
  async function writeRecord(record, signal) {
    check(signal); await unlinked(directory, { missing: true }); await mkdir(directory, { recursive: true }); await unlinked(filename, { missing: true });
    const temporary = filename + '.' + randomUUID() + '.tmp'; let handle;
    try {
      handle = await open(temporary, 'wx', 0o600); await handle.writeFile(JSON.stringify(record, null, 2), 'utf8'); await handle.sync(); await handle.close(); handle = null;
      check(signal); await unlinked(directory); await unlinked(filename, { missing: true }); await unlinked(temporary);
      await renameWithRetry(temporary, filename);
    } finally { await handle?.close(); await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  function response(state, capability, extra = {}) {
    return { settings: { ...state.settings }, configured: state.configured, hasSavedKey: Boolean(state.encrypted), rememberKey: state.rememberKey, encryptionAvailable: capability.available, capability, notice: '', noticeCode: '', ...extra };
  }
  function recordFor(settings, configured, rememberKey, encrypted = '') { return { version: 1, provider: WINDOWS_DPAPI_METHOD, configured, ...settings, rememberKey, ...(encrypted ? { encryptedApiKey: encrypted } : {}) }; }
  function load({ signal } = {}) {
    return serial(async () => {
      const state = stateOf(await readRecord(signal)), capability = await capabilityValue({ signal }); let apiKey = '', notice = '', noticeCode = '';
      if (state.invalid) { notice = '连接配置文件损坏，未读取密钥，请重新输入并保存。'; noticeCode = 'CONNECTION_RECORD_INVALID'; }
      else if (state.encrypted && state.format !== WINDOWS_DPAPI_METHOD) { notice = '现有密钥使用桌面版加密格式，当前启动方式不能直接读取，请重新输入一次。'; noticeCode = 'CONNECTION_LEGACY_ENCRYPTION'; }
      else if (state.encrypted && state.rememberKey === true && capability.available) {
        try { apiKey = keyInput(await protector.unprotect(state.encrypted, { signal })) || ''; }
        catch (error) { check(signal); if (error.name === 'AbortError' || error.status === 499) throw error; notice = '已保存的密钥无法用当前Windows账户解密，请重新输入；公开连接配置仍保留。'; noticeCode = 'CONNECTION_DECRYPT_FAILED'; }
      } else if (!capability.available) { notice = capability.message; noticeCode = capability.reasonCode || 'DPAPI_UNAVAILABLE'; }
      else if (state.plaintextIgnored) { notice = '不安全的明文密钥记录未读取，请重新输入并使用安全存储。'; noticeCode = 'CONNECTION_PLAINTEXT_IGNORED'; }
      check(signal); return response(state, capability, { settings: { ...state.settings, apiKey }, notice, noticeCode });
    });
  }
  function save(input = {}, { signal } = {}) {
    return serial(async () => {
      check(signal); if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail(400, '连接保存参数无效。', 'CONNECTION_SETTINGS_INVALID');
      const previous = stateOf(await readRecord(signal)), settings = publicSettings(input.settings || {}), requestedKey = keyInput(input.settings && Object.hasOwn(input.settings, 'apiKey') ? input.settings.apiKey : input.apiKey);
      rejectKnownKeyInPublicSettings(settings, requestedKey);
      const capability = await capabilityValue({ signal });
      if (input.rememberKey !== undefined && typeof input.rememberKey !== 'boolean') throw fail(400, '请选择是否记住密钥。', 'CONNECTION_SETTINGS_INVALID');
      const rememberKey = capability.available && (input.rememberKey ?? previous.rememberKey ?? true); let encrypted = '';
      if (rememberKey && requestedKey) {
        try { encrypted = await protector.protect(requestedKey, { signal }); }
        catch (error) { check(signal); if (error.name === 'AbortError' || error.status === 499) throw error; throw fail(503, '密钥未能安全保存，当前会话仍可使用，请重试。', 'CONNECTION_ENCRYPT_FAILED'); }
        if (typeof encrypted !== 'string' || !encrypted || encrypted.length > 32768 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encrypted) || encrypted === requestedKey || encrypted === Buffer.from(requestedKey).toString('base64')) throw fail(503, '安全存储未返回有效密文，本次未保存。', 'CONNECTION_ENCRYPT_FAILED');
      } else if (rememberKey && requestedKey === undefined && previous.format === WINDOWS_DPAPI_METHOD) encrypted = previous.encrypted;
      const record = recordFor(settings, true, rememberKey, encrypted); await writeRecord(record, signal);
      return response({ settings, configured: true, rememberKey, encrypted }, capability, { saved: true, keySaved: Boolean(encrypted), ...(!capability.available ? { notice: capability.message, noticeCode: capability.reasonCode || 'DPAPI_UNAVAILABLE' } : {}) });
    });
  }
  function clear({ signal } = {}) {
    return serial(async () => {
      const previous = stateOf(await readRecord(signal)); await writeRecord(recordFor(previous.settings, previous.configured, false), signal);
      const capability = await capabilityValue({ signal }); return response({ ...previous, encrypted: '', rememberKey: false }, capability, { cleared: true });
    });
  }
  function capability(options = {}) { return serial(() => capabilityValue(options)); }
  async function close() { closed = true; await tail.catch(() => {}); }
  return { load, save, clear, capability, close };
}
