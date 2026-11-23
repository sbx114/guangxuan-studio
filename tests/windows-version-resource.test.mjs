import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), execute = promisify(execFile);
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function executableSections(bytes) {
  assert.equal(bytes.subarray(0, 2).toString(), 'MZ'); const pe = bytes.readUInt32LE(0x3c); assert.equal(bytes.readUInt32LE(pe), 0x4550);
  const sections = [], count = bytes.readUInt16LE(pe + 6), start = pe + 24 + bytes.readUInt16LE(pe + 20);
  for (let index = 0; index < count; index++) {
    const at = start + index * 40, flags = bytes.readUInt32LE(at + 36); if (!(flags & 0x20) && !(flags & 0x20000000)) continue;
    const name = bytes.subarray(at, at + 8).toString().replace(/\0.*$/, ''), size = bytes.readUInt32LE(at + 16), offset = bytes.readUInt32LE(at + 20);
    assert.ok(offset + size <= bytes.length); sections.push({ name, size, sha256: digest(bytes.subarray(offset, offset + size)) });
  }
  assert.ok(sections.length, 'The fixture must contain a real executable code section'); return sections;
}

test('local Windows PE work copy gets Gx application version resources while executable code and original bytes stay unchanged', { timeout: 60000 }, async t => {
  if (process.platform !== 'win32') { t.skip('Windows resource APIs are required.'); return; }
  const base = path.resolve(process.env.GUANGXUAN_WINDOWS_VERSION_EXE || path.join(root, 'node_modules/electron/dist/electron.exe'));
  if (!await fs.stat(base).catch(() => null)) { t.skip('A local Electron executable fixture is required; this test never downloads one.'); return; }
  const parent = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await fs.mkdir(parent, { recursive: true });
  const folder = await fs.mkdtemp(path.join(parent, 'gx-version-resource-')); t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const filename = path.join(folder, 'Gx.exe'), marker = path.join(folder, '.guangxuan-build.json'), helper = path.join(root, 'scripts/set-windows-version.ps1');
  const original = await fs.readFile(base), originalDigest = digest(original), code = executableSections(original);
  await fs.copyFile(base, filename); await fs.chmod(filename, 0o666); await fs.writeFile(marker, JSON.stringify({ product: 'Gx', version: '0.2.1', state: 'building' }));
  const shell = process.env.GUANGXUAN_PWSH || 'powershell.exe';
  const stamp = target => execute(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-ExecutablePath', target, '-Version', '0.2.1'], { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
  const result = JSON.parse((await stamp(filename)).stdout); assert.equal(result.verified, true); assert.equal(result.version, '0.2.1'); assert.equal(result.fileVersion, '0.2.1'); assert.equal(result.productVersion, '0.2.1'); assert.equal(result.productName, 'Gx'); assert.equal(result.fileDescription, 'Gx');
  const branded = await fs.readFile(filename); assert.notEqual(digest(branded), originalDigest); assert.deepEqual(executableSections(branded), code); assert.equal(digest(await fs.readFile(base)), originalDigest, 'The original local runtime fixture must never be changed or executed');
  const expected = digest(branded);
  await fs.writeFile(marker, JSON.stringify({ product: 'Gx', version: '0.2.1', state: 'complete' })); await assert.rejects(stamp(filename), /completed installations|in-progress/); assert.equal(digest(await fs.readFile(filename)), expected);
  await fs.writeFile(marker, JSON.stringify({ product: 'Gx', version: '0.2.0', state: 'building' })); await assert.rejects(stamp(filename), /current in-progress/); assert.equal(digest(await fs.readFile(filename)), expected);
  const wrongName = path.join(folder, 'Other.exe'); await fs.copyFile(filename, wrongName); await assert.rejects(stamp(wrongName), /named Gx.exe/); assert.equal(digest(await fs.readFile(wrongName)), expected);
  if (process.env.GUANGXUAN_WINDOWS_VERSION_EVIDENCE) {
    const evidence = path.resolve(process.env.GUANGXUAN_WINDOWS_VERSION_EVIDENCE); await fs.mkdir(evidence, { recursive: true });
    await fs.writeFile(path.join(evidence, 'windows-version-resource-verification.json'), JSON.stringify({ passed: true, actualWindowsResourceAPI: true, version: result.version, fileVersion: result.fileVersion, productVersion: result.productVersion, productName: result.productName, executableCodeSections: code, originalRuntimeUnchanged: true, runtimeExecutableNeverStarted: true, completedBuildRejected: true, mismatchedBuildRejected: true, wrongNameRejected: true, downloaded: false, networkCalls: 0 }, null, 2));
  }
});
