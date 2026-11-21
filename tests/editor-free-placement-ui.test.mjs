import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { findAnimationBrowser } from '../animation/render.mjs';
import { createProjectStore } from '../lib/store.mjs';

const root = path.resolve(import.meta.dirname, '..');
const context = { projectId: 'video-free-ui', revision: 'fixture-native-revision', duration: 8, assets: [{ id: 'a', name: '素材 A.mp4', type: 'video', duration: 8 }, { id: 'b', name: '素材 B.mp4', type: 'video', duration: 6 }], timeline: [{ id: 'one', assetId: 'a', start: 0, end: 8, at: 0, speed: 1 }], mainTrackEditable: true };

test('real editor offers free placement, ignores unfinished time drafts and submits persistent material choices with no range', { timeout: 45000 }, async t => {
  const base = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(base, { recursive: true });
  const folder = await mkdtemp(path.join(base, 'gx-free-placement-ui-')), store = await createProjectStore(path.join(folder, 'data'));
  const requests = [], saves = [], jobs = new Map(), errors = [], external = [];
  await store.save(context.projectId, { id: context.projectId, kind: 'video', title: '自由创作隔离测试', video: { timeline: [], captions: [], editScope: { assetIds: ['a'], placement: { mode: 'range', start: 2, end: 5 } } } });
  const json = (res, value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/api/projects/' + context.projectId) {
        if (req.method === 'PUT') { const body = JSON.parse(Buffer.concat(await Array.fromAsync(req))); saves.push(structuredClone(body)); json(res, { project: await store.save(context.projectId, body) }); }
        else json(res, { project: await store.read(context.projectId) });
        return;
      }
      if (url.pathname === '/api/openfilm/context') { json(res, context); return; }
      if (url.pathname === '/api/assistant/runs' && req.method === 'POST') {
        const body = JSON.parse(Buffer.concat(await Array.fromAsync(req))); requests.push(body);
        const id = 'free-ui-run-' + requests.length, job = { id, runId: id, projectId: context.projectId, status: 'completed', instruction: body.instruction, message: '已读取当前创作要求。', effects: [], sources: [], steps: [] }; jobs.set(id, job);
        json(res, { runId: id, job }, 202); return;
      }
      const run = /^\/api\/assistant\/runs\/([^/]+)$/.exec(url.pathname);
      if (run) { json(res, { job: jobs.get(run[1]) }); return; }
      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html;charset=utf-8' });
        res.end(`<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/editor-assistant.css"></head><body><main id="fixture"></main><div id="modal-root"></div><div id="toast-region"></div><script type="module">
import {api} from '/ui.js';import {createEditorAssistant} from '/editor-assistant.js';import {editScopeSnapshot} from '/editor-scope.js';
window.project=(await api('/api/projects/${context.projectId}')).project;window.context=${JSON.stringify(context)};window.snapshot=()=>editScopeSnapshot(project,context);
window.editor=createEditorAssistant({getSettings:()=>({baseUrl:'https://fixture.invalid/v1',model:'fixture',apiKey:'fixture-only-not-a-user-key'}),requireConnection:()=>true,saveProject:async p=>(await api('/api/projects/'+p.id,p,{method:'PUT'})).project});editor.mount(document.getElementById('fixture'),project);window.ready=true;
</script></body></html>`); return;
      }
      if (/^\/[a-zA-Z0-9_-]+\.(?:js|css)$/.test(url.pathname)) { res.writeHead(200, { 'content-type': url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript' }); res.end(await readFile(path.join(root, 'public', url.pathname.slice(1)))); return; }
      res.writeHead(404); res.end();
    } catch (error) { json(res, { error: error.message }, 500); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = 'http://127.0.0.1:' + server.address().port;
  assert.ok(!['4317', '4417'].includes(new URL(origin).port));
  const browser = await chromium.launch({ executablePath: await findAnimationBrowser(), headless: true });
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await store.settle(); assert.equal(path.dirname(folder), base); await rm(folder, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 950 }, reducedMotion: 'reduce' });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => { const url = new URL(route.request().url()); if (url.origin === origin) return route.continue(); external.push(url.href); return route.abort(); });
  await page.goto(origin); await page.waitForFunction(() => window.ready);
  const details = page.locator('.gx-edit-scope'); await details.locator('summary').click(); await page.locator('[data-scope-asset]').nth(1).waitFor();
  const placement = page.locator('[data-scope-placement]');
  assert.equal(await placement.locator('option[value="free"]').innerText(), '自由创作');
  assert.equal(await placement.inputValue(), 'range');
  await page.locator('[data-scope-range-start]').fill('未完成'); await page.locator('[data-scope-range-end]').fill('');
  await assert.rejects(page.evaluate(() => snapshot()), /时间|区间/);
  await placement.selectOption('free');
  for (const selector of ['[data-scope-time]', '[data-scope-range-start]', '[data-scope-range-end]', '[data-scope-clear-range]']) assert.equal(await page.locator(selector).isVisible(), false, selector);
  assert.deepEqual(await page.evaluate(() => snapshot()), { placement: { mode: 'free' }, assetIds: ['a'] });
  assert.match(await page.locator('[data-scope-summary]').innerText(), /1 项素材 · 自由创作/);
  assert.equal(await page.locator('[data-scope-asset="a"]').isChecked(), true); assert.equal(await page.locator('[data-scope-asset="b"]').isChecked(), false);
  await placement.selectOption('insert'); await page.locator('[data-scope-time]').fill('未完成'); await assert.rejects(page.evaluate(() => snapshot()), /时间/);
  await placement.selectOption('free'); assert.deepEqual(await page.evaluate(() => snapshot()), { placement: { mode: 'free' }, assetIds: ['a'] });
  await page.evaluate(() => editor.flush()); await page.reload(); await page.waitForFunction(() => window.ready); await details.locator('summary').click(); await page.locator('[data-scope-asset]').nth(1).waitFor();
  assert.equal(await placement.inputValue(), 'free');
  for (const selector of ['[data-scope-time]', '[data-scope-range-start]', '[data-scope-range-end]']) assert.equal(await page.locator(selector).isVisible(), false);
  assert.deepEqual(await page.evaluate(() => snapshot()), { placement: { mode: 'free' }, assetIds: ['a'] });
  await page.locator('[data-assistant-input]').fill('根据素材自由创作，时间与片段位置由你安排。'); await page.locator('[data-assistant-send]').click();
  await page.waitForFunction(() => !document.querySelector('[data-assistant-input]').disabled);
  assert.equal(requests.length, 1); assert.equal(requests[0].projectId, context.projectId); assert.equal(requests[0].mode, 'auto');
  assert.deepEqual(requests[0].editScope, { placement: { mode: 'free' }, assetIds: ['a'] });
  assert.equal(requests[0].instruction, '根据素材自由创作，时间与片段位置由你安排。');
  assert.equal(await placement.inputValue(), 'free');
  const saved = await store.read(context.projectId); assert.deepEqual(JSON.parse(JSON.stringify(saved.video.editScope)), { placement: { mode: 'free' }, assetIds: ['a'] });
  await placement.selectOption('append'); assert.deepEqual(await page.evaluate(() => snapshot()), { placement: { mode: 'append' }, assetIds: ['a'] });
  await placement.selectOption('free'); await page.locator('[data-scope-all]').check();
  assert.deepEqual(await page.evaluate(() => snapshot()), { placement: { mode: 'free' } });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  const evidence = process.env.GUANGXUAN_FREE_PLACEMENT_UI_EVIDENCE && path.resolve(process.env.GUANGXUAN_FREE_PLACEMENT_UI_EVIDENCE);
  if (evidence) { await mkdir(evidence, { recursive: true }); await page.screenshot({ path: path.join(evidence, 'free-placement-mobile.png') }); await writeFile(path.join(evidence, 'free-placement-ui.json'), JSON.stringify({ status: 'passed', realEdge: true, actualEditorAssistant: true, realProjectStore: true, freeOptionShown: true, noTimeInputs: true, incompleteRangeAndInsertionIgnored: true, selectedAssetsPreserved: true, allAssetsPreserved: true, modePersistedAfterReload: true, actualRunTransportNoTimeFields: true, explicitAppendRetained: true, mobileWidth: 390, mobileNoOverflow: true, externalRequests: external, pageErrors: errors, providerCalls: 0, productionPortUsed: false }, null, 2)); }
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.ok(saves.some(project => project.video?.editScope?.placement?.mode === 'free'));
});
