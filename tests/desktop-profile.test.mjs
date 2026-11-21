import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const desktopDirectory = fileURLToPath(new URL('../desktop/', import.meta.url));
const source = await fs.readFile(new URL('../desktop/main.cjs', import.meta.url), 'utf8');

function initializeDesktopProfile(override) {
  const appData = path.join(os.tmpdir(), 'gx-profile-check-appdata');
  const createdDirectories = [];
  const paths = {};
  let name = 'guangxuan-studio';
  let lockedProfile;
  const app = {
    setName(value) { name = value; },
    getPath(key) { return paths[key] || (key === 'appData' ? appData : path.join(appData, name)); },
    setPath(key, value) { paths[key] = value; },
    setAppUserModelId() {},
    requestSingleInstanceLock() { lockedProfile = this.getPath('userData'); return false; },
    quit() {},
  };
  vm.runInNewContext(source, {
    require(specifier) {
      if (specifier === 'electron') return { app };
      if (specifier === 'node:fs') return { ...require(specifier), mkdirSync: directory => createdDirectories.push(directory) };
      return require(specifier);
    },
    process: { platform: process.platform, env: { ...process.env, GUANGXUAN_USER_DATA: override } },
    __dirname: desktopDirectory,
  }, { filename: path.join(desktopDirectory, 'main.cjs') });
  return { appData, name, profile: paths.userData, lockedProfile, createdDirectories };
}

test('renaming the desktop app to Gx keeps its existing Electron profile', () => {
  const actual = initializeDesktopProfile(undefined);
  const legacyProfile = path.resolve(actual.appData, 'Guangxuan Studio');
  assert.equal(actual.name, 'Gx');
  assert.equal(actual.profile, legacyProfile);
  assert.equal(actual.lockedProfile, legacyProfile);
  assert.deepEqual(actual.createdDirectories, [legacyProfile]);
});

test('a configured desktop profile remains in use after the name change', () => {
  const selected = path.resolve(os.tmpdir(), 'gx-selected-profile');
  const actual = initializeDesktopProfile(selected);
  assert.equal(actual.profile, selected);
  assert.equal(actual.lockedProfile, selected);
  assert.deepEqual(actual.createdDirectories, [selected]);
});
