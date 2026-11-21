import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { deflateSync, crc32 } from 'node:zlib';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { startServer } from '../server.mjs';
import { findAnimationBrowser } from '../animation/render.mjs';

const png = () => {
  const chunk = (kind, data) => { const result = Buffer.alloc(data.length + 12); result.writeUInt32BE(data.length); result.write(kind, 4); data.copy(result, 8); result.writeUInt32BE(crc32(result.subarray(4, data.length + 8)), data.length + 8); return result; };
  const header = Buffer.alloc(13); header.writeUInt32BE(8); header.writeUInt32BE(8, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc((8 * 4 + 1) * 8, 180); for (let row = 0; row < 8; row++) pixels[row * 33] = 0;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
};
async function fixture(t) {
  const base = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'gx-library-editor-conflict-')), dataDir = path.join(directory, 'data'), app = await startServer({ port: 0, dataDir }); assert.notEqual(new URL(app.url).port, '4417');
  t.after(async () => { await app.close(); assert.equal(path.dirname(directory), base); await rm(directory, { recursive: true, force: true }); });
  const api = async (route, body, method = body === undefined ? 'GET' : 'POST', status = 200) => { const response = await fetch(app.url + route, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const result = await response.json(); assert.equal(response.status, status, JSON.stringify(result)); return result; };
  const current = await api('/api/novel-library/characters', { id: 'editor-guide', name: '讲解人物', role: '原始人设', tone: '原始语气', personality: '耐心', portraits: [] });
  return { directory, app, api, character: current.character };
}

test('real shared-library HTTP rejects stale profile writes and deletes instead of losing another edit', async t => {
  const fx = await fixture(t), initial = await fx.api('/api/novel-library');
  await fx.api('/api/novel-library/characters', { ...fx.character, tone: '另一个窗口新保存的语气', expectedRevision: initial.revision });
  await fx.api('/api/novel-library/characters', { ...fx.character, role: '旧窗口本机编辑', expectedRevision: initial.revision }, 'POST', 409);
  await fx.api(`/api/novel-library/characters/${fx.character.id}?expectedRevision=${initial.revision}`, undefined, 'DELETE', 409);
  const latest = await fx.api('/api/novel-library'); assert.equal(latest.characters[0].tone, '另一个窗口新保存的语气'); assert.equal(latest.characters[0].role, '原始人设');
  const scene = await fx.api('/api/novel-library/backgrounds', { id: 'editor-room', name: '原场景', assetId: '', fit: 'cover' }), beforeScene = await fx.api('/api/novel-library');
  await fx.api('/api/novel-library/backgrounds', { ...scene.background, fit: 'contain', expectedRevision: beforeScene.revision });
  await fx.api('/api/novel-library/backgrounds', { ...scene.background, name: '旧窗口场景改名', expectedRevision: beforeScene.revision }, 'POST', 409);
  await fx.api(`/api/novel-library/backgrounds/editor-room?expectedRevision=${beforeScene.revision}`, undefined, 'DELETE', 409);
  assert.equal((await fx.api('/api/novel-library')).backgrounds[0].fit, 'contain');
  await fx.api('/api/novel-library/characters', null, 'POST', 400);
});

test('two actual library editor windows preserve local input and expose a conflict before reloading the latest profile', { skip: !process.env.GUANGXUAN_BIN_DIR, timeout: 60000 }, async t => {
  const fx = await fixture(t), image = await fetch(fx.app.url + '/api/novel-library/assets/upload', { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent('立绘.png'), 'x-asset-kind': 'portrait' }, body: png() });
  assert.equal(image.status, 201); const { asset } = await image.json();
  await fx.api('/api/novel-library/characters', { ...fx.character, portraits: [{ id: 'calm', name: '平静', assetId: asset.id }] });
  await fx.api('/api/projects/library-conflict-science', { kind: 'science', title: '隔离库编辑', science: { novelConfig: { selectedCharacterId: '', selectedBackgroundId: '' } } }, 'PUT');
  const browser = await chromium.launch({ executablePath: await findAnimationBrowser(), headless: true }); t.after(() => browser.close());
  const errors = [], pages = await Promise.all([browser.newPage(), browser.newPage()]);
  for (const page of pages) {
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/__library-conflict-fixture', route => route.fulfill({ contentType: 'text/html;charset=utf-8', body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/visual-novel.css"><main id="library"></main><div id="modal-root"></div><div id="toast-region"></div><script type="module">import {api} from "/ui.js";import {createNovelAssetManager} from "/novel-assets.js";const project=(await api("/api/projects/library-conflict-science")).project;window.manager=createNovelAssetManager({onSave:()=>{}});manager.mount(document.getElementById("library"),project);window.ready=true;</script>' }));
    await page.goto(fx.app.url + '/__library-conflict-fixture'); await page.waitForFunction(() => window.ready); await page.locator('[data-vn-library-open]').click(); await page.locator('[data-library-edit="editor-guide"]').click();
  }
  await pages[0].locator('[data-library-field="tone"]').fill('第一窗口未保存的语气');
  await pages[1].locator('[data-library-field="role"]').fill('第二窗口已保存的新的人设'); await pages[1].locator('[data-library-form] button[type="submit"]').click(); await pages[1].locator('[data-library-edit="editor-guide"]').waitFor();
  await pages[0].locator('[data-library-form] button[type="submit"]').click();
  await pages[0].waitForFunction(() => !document.querySelector('[data-library-form]') || Boolean(document.querySelector('[data-novel-shared-library] [role="alert"]')), undefined, { timeout: 5000 });
  const after = await fx.api('/api/novel-library'); assert.equal(after.characters[0].role, '第二窗口已保存的新的人设', 'A stale UI save must not overwrite the other window'); assert.equal(after.characters[0].tone, '原始语气');
  assert.equal(await pages[0].locator('[data-library-field="tone"]').inputValue(), '第一窗口未保存的语气'); assert.match(await pages[0].locator('[data-novel-shared-library] [role="alert"]').innerText(), /更新|保留/);
  await pages[0].locator('[data-library-reload-latest]').click(); await pages[0].waitForFunction(() => document.querySelector('[data-library-field="role"]').value === '第二窗口已保存的新的人设');
  assert.equal(await pages[0].locator('[data-library-field="tone"]').inputValue(), '原始语气'); assert.ok((await pages[0].locator('[data-library-local-recovery] textarea').evaluateAll(nodes => nodes.map(node => node.value))).includes('第一窗口未保存的语气'));
  assert.deepEqual(errors, []);
  if (process.env.GUANGXUAN_AUTHORING_AUDIT_EVIDENCE) { const evidence = path.resolve(process.env.GUANGXUAN_AUTHORING_AUDIT_EVIDENCE); await mkdir(evidence, { recursive: true }); await pages[0].locator('[data-library-local-recovery]').scrollIntoViewIfNeeded(); await pages[0].screenshot({ path: path.join(evidence, 'library-conflict-recovery.png'), fullPage: true }); await writeFile(path.join(evidence, 'library-conflict-ui-verification.json'), JSON.stringify({ status: 'passed', actualServer: true, actualWindows: 2, staleSaveRejected: true, remoteProfilePreserved: true, localInputRetainedOnConflict: true, localRecoveryRetainedAfterExplicitReload: true, modelRequests: 0, requested4417: false }, null, 2)); }
});
