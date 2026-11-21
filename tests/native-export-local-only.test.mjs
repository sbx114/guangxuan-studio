import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';

const execute = promisify(execFile);
test('local-only export avoids other app draft directories while standalone native Studio retains discovery', { skip: process.platform !== 'win32' }, async t => {
  const parent = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'gx-export-local-only-'));
  t.after(async () => { assert.equal(path.dirname(directory), parent); assert.ok(path.basename(directory).startsWith('gx-export-local-only-')); await rm(directory, { recursive: true, force: true }); });
  for (const app of ['JianyingPro', 'CapCut']) await mkdir(path.join(directory, app, 'User Data', 'Projects', 'com.lveditor.draft'), { recursive: true });
  const url = pathToFileURL(path.resolve('integrations/openfilm/packages/openfilm/studio/server/exports.mjs')).href;
  const source = `const {draftApps}=await import(${JSON.stringify(url)});process.stdout.write(JSON.stringify(draftApps()));`;
  for (const local of ['0', '1']) {
    const result = await execute(process.execPath, ['--input-type=module', '-e', source], { windowsHide: true, timeout: 20000, env: { ...process.env, LOCALAPPDATA: directory, OPENFILM_LOCAL_ONLY: local } });
    assert.deepEqual(JSON.parse(result.stdout), { jianying: local !== '1', capcut: local !== '1' });
  }
});
