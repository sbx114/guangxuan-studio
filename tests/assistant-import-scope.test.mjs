import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { assistantContentHash, createProjectStore } from '../lib/store.mjs';
import { mergeImportedAssetScope } from '../public/editor-assistant.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetId = 'canonical-imported-asset';
const effect = overrides => ({ type: 'media', projectId: 'video-scope', changed: true, importedAssetId: assetId, ...overrides });

test('imported asset scope merge preserves all/empty/partial choices and current human placement', () => {
  const placement = { mode: 'range', start: 2, end: 5, clipIds: ['manual-clip'] };
  const effects = [effect({ editScope: { assetIds: ['unselected-other'], placement: { mode: 'replace' } } }), effect(), effect({ projectId: 'other', importedAssetId: 'foreign-project' }), effect({ type: 'download', importedAssetId: 'download-is-not-native' }), effect({ changed: false, importedAssetId: 'not-imported' }), effect({ undone: true, importedAssetId: 'undone-import' }), effect({ importedAssetId: 'file:///private' })];
  assert.deepEqual(mergeImportedAssetScope('video-scope', { assetIds: [], placement }, effects), { assetIds: [assetId], placement });
  const partial = { assetIds: ['manually-selected'], placement };
  assert.deepEqual(mergeImportedAssetScope('video-scope', partial, effects), { assetIds: ['manually-selected', assetId], placement });
  assert.deepEqual(partial.assetIds, ['manually-selected'], 'The helper does not mutate the caller selection');
  assert.deepEqual(mergeImportedAssetScope('video-scope', { placement }, effects), { placement });
  assert.equal(mergeImportedAssetScope('video-scope', { placement, assetIds: undefined }, effects).assetIds, undefined);
  assert.equal(mergeImportedAssetScope('video-scope', undefined, effects), undefined);
});

test('assistant CAS persists normalized editScope, hashes it and rejects old autosaves without changing draft counters', async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'gx-import-scope-store-')), store = await createProjectStore(folder);
  t.after(async () => { await store.settle(); assert.equal(path.dirname(folder), os.tmpdir()); await rm(folder, { recursive: true, force: true }); });
  const originalScope = { assetIds: [], placement: { mode: 'insert', at: 2 } };
  const project = await store.save('video-scope', { kind: 'video', title: '范围测试', video: { timeline: [], editScope: originalScope, sourceSyncRevision: 7 } });
  const originalHash = assistantContentHash(project);
  const changed = await store.updateAssistant(project.id, { expectedHash: originalHash, patch: [{ path: ['video', 'editScope'], value: { assetIds: [assetId, assetId], placement: originalScope.placement, arbitraryScopeField: 'ignored' } }] });
  assert.deepEqual(changed.project.video.editScope, { assetIds: [assetId], placement: originalScope.placement });
  assert.equal(changed.project.video.sourceSyncRevision, 7); assert.equal(changed.project.assistantRevision, 1); assert.notEqual(changed.afterHash, originalHash);
  await assert.rejects(store.save(project.id, project), error => error.code === 'ASSISTANT_STALE_PROJECT');
  const source = await readFile(path.join(folder, 'projects', project.id + '.json'), 'utf8');
  for (const invalid of [null, [], 'all', { assetIds: 'all', placement: { mode: 'append' } }, { placement: { mode: 'anywhere' } }, { placement: { mode: 'range', start: 3, end: 2 } }, { assetIds: Array.from({ length: 101 }, (_, index) => 'asset-' + index), placement: { mode: 'append' } }]) {
    await assert.rejects(store.updateAssistant(project.id, { expectedHash: changed.afterHash, patch: [{ path: ['video', 'editScope'], value: invalid }] }), error => error.status === 400);
    assert.equal(await readFile(path.join(folder, 'projects', project.id + '.json'), 'utf8'), source);
  }
  const restored = await store.updateAssistant(project.id, { expectedHash: changed.afterHash, patch: changed.before.map(item => ({ path: item.path, ...(item.exists ? { value: item.value } : { remove: true }) })) });
  assert.equal(restored.afterHash, originalHash); assert.equal(restored.project.video.sourceSyncRevision, 7);
});

test('real editor run merges the server import ID before autosave and the next dialogue keeps that exact selection', { timeout: 20000 }, async t => {
  let chromium; try { ({ chromium } = await import('playwright-core')); } catch { t.skip('Playwright required'); return; }
  let browser; try { browser = await chromium.launch({ channel: 'msedge', headless: true }); } catch { t.skip('Installed Edge required'); return; }
  const folder = await mkdtemp(path.join(os.tmpdir(), 'gx-import-scope-ui-')), store = await createProjectStore(folder);
  const placement = { mode: 'insert', at: 2 }, requests = [], saves = [], pageErrors = [];
  await store.save('video-scope', { kind: 'video', title: '空选择导入测试', video: { timeline: [], captions: [], editScope: { assetIds: [], placement } } });
  const json = (res, value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  let imported = false;
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/api/projects/video-scope') {
        if (req.method === 'PUT') { const body = JSON.parse(Buffer.concat(await Array.fromAsync(req))); saves.push(body); json(res, { project: await store.save('video-scope', body) }); }
        else json(res, { project: await store.read('video-scope') });
        return;
      }
      if (url.pathname === '/api/openfilm/context') { json(res, { projectId: 'video-scope', revision: '0123456789abcdef', duration: 0, assets: imported ? [{ id: assetId, name: '导入素材.mp4', type: 'video', duration: 4 }] : [], timeline: [], mainTrackEditable: true }); return; }
      if (url.pathname === '/api/assistant/runs' && req.method === 'POST') {
        const body = JSON.parse(Buffer.concat(await Array.fromAsync(req))); requests.push(body);
        const effects = [];
        if (!imported) {
          const project = await store.read('video-scope');
          await store.updateAssistant(project.id, { expectedHash: assistantContentHash(project), patch: [{ path: ['video', 'editScope'], value: { assetIds: [assetId], placement } }] }); imported = true;
          effects.push(effect({ editScope: { assetIds: ['not-selected-by-user'], placement: { mode: 'replace' } } }));
        }
        const id = 'scope-run-' + requests.length;
        json(res, { runId: id, job: { id, runId: id, projectId: 'video-scope', status: 'completed', instruction: body.instruction, message: '已导入项目文件。', effects, sources: [], steps: [] } }, 202); return;
      }
      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html;charset=utf-8' });
        res.end(`<!doctype html><html><body><main id="fixture"></main><div id="modal-root"></div><div id="toast-region"></div><script type="module">
import {api} from '/ui.js';import {createEditorAssistant} from '/editor-assistant.js';
window.changedCount=0;window.project=(await api('/api/projects/video-scope')).project;
window.editor=createEditorAssistant({getSettings:()=>({baseUrl:'https://fixture.invalid/v1',model:'fixture',apiKey:'fixture'}),requireConnection:()=>true,saveProject:async p=>(await api('/api/projects/'+p.id,p,{method:'PUT'})).project,onChanged:async()=>{changedCount++}});
editor.mount(document.getElementById('fixture'),project);window.ready=true;
</script></body></html>`); return;
      }
      if (/^\/[a-zA-Z0-9_-]+\.js$/.test(url.pathname)) { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(await readFile(path.join(root, 'public', url.pathname.slice(1)))); return; }
      res.writeHead(404); res.end();
    } catch (error) { json(res, { error: error.message, code: error.code }, error.status || 500); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const url = `http://127.0.0.1:${server.address().port}`; assert.notEqual(new URL(url).port, '4417');
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await store.settle(); assert.equal(path.dirname(folder), os.tmpdir()); await rm(folder, { recursive: true, force: true }); });
  const page = await browser.newPage(); page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(url); await page.waitForFunction(() => window.ready);
  await page.locator('[data-assistant-input]').fill('请导入网上视频'); await page.locator('[data-assistant-send]').click();
  await page.waitForFunction(() => window.changedCount === 1 && !document.querySelector('[data-assistant-input]').disabled);
  assert.deepEqual(requests[0].editScope.assetIds, []);
  assert.deepEqual((await store.read('video-scope')).video.editScope.assetIds, [assetId]);
  assert.deepEqual(await page.evaluate(() => project.video.editScope), { assetIds: [assetId], placement });
  assert.ok(saves.some(project => project.assistantRevision === 1 && project.video.editScope.assetIds.includes(assetId)), 'Editor chat save keeps the exact server import selection');
  await page.locator('[data-assistant-input]').fill('继续用刚才导入的素材剪辑'); await page.locator('[data-assistant-send]').click();
  await page.waitForFunction(() => window.changedCount === 2 && !document.querySelector('[data-assistant-input]').disabled);
  assert.deepEqual(requests[1].editScope, { assetIds: [assetId], placement }); assert.deepEqual(pageErrors, []);
});
