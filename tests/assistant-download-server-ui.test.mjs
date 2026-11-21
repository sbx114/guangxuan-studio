import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { startServer } from '../server.mjs';

test('real assistant server download receipt lets Edge save the original PDF bytes after a page refresh', { timeout: 90000 }, async t => {
  let chromium; try { ({ chromium } = await import('playwright-core')); } catch { t.skip('Playwright is required.'); return; }
  let browser; try { browser = await chromium.launch({ channel: 'msedge', headless: true }); } catch { t.skip('Installed Edge is required.'); return; }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gx-download-server-ui-')), dataDir = path.join(directory, 'data');
  const evidence = process.env.GUANGXUAN_DOWNLOAD_UI_EVIDENCE ? path.resolve(process.env.GUANGXUAN_DOWNLOAD_UI_EVIDENCE) : directory; await mkdir(evidence, { recursive: true });
  const original = await readFile(new URL('./fixtures/science-documents/bilingual-paper.pdf', import.meta.url)), filename = '论文教材原件.pdf', publicUrl = 'https://papers.example.org/paper.pdf', expectedHash = createHash('sha256').update(original).digest('hex');
  const steps = [], errors = [], targets = []; let fileRequests = 0, app;
  const fixture = http.createServer(async (req, res) => {
    try {
      if (req.url === '/paper.pdf') { fileRequests++; res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': original.length, 'content-disposition': `attachment; filename="paper.pdf"; filename*=UTF-8''${encodeURIComponent(filename)}` }); res.end(original); return; }
      assert.equal(req.url, '/v1/chat/completions'); const body = JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString()), payload = JSON.parse(body.messages.find(message => message.role === 'user').content); steps.push(payload);
      const observed = payload.observations.find(observation => observation.tool === 'web_download');
      if (observed) assert.equal(observed.status, 'completed', JSON.stringify(observed));
      const result = observed ? { type: 'final', message: '论文原文件已下载到本机资料区，可保存原文件。[S1]', sourceIds: ['S1'] } : { type: 'tool', tool: 'web_download', arguments: { url: publicUrl }, summary: '下载论文原文件' };
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) }, finish_reason: 'stop' }] }));
    } catch (error) { errors.push(error.message); if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }); if (!res.writableEnded) res.end(JSON.stringify({ error: 'controlled HTTP fixture failed' })); }
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve)); const fixtureUrl = 'http://127.0.0.1:' + fixture.address().port;
  t.after(async () => { await browser.close(); await app?.close(); fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)); assert.equal(path.dirname(directory), os.tmpdir()); await rm(directory, { recursive: true, force: true }); });
  // Only constructor-time transport is controlled. The production web/download,
  // agent, original-file store and HTTP attachment routes all execute normally.
  app = await startServer({ port: 0, dataDir, assistantWebDependencies: {
    lookup: async host => { assert.equal(host, 'papers.example.org'); return [{ address: '8.8.8.8', family: 4 }]; },
    request: (target, { signal }) => new Promise((resolve, reject) => { targets.push({ url: target.url.href, address: target.address }); const request = http.get(fixtureUrl + '/paper.pdf', { signal }, resolve); request.once('error', reject); }),
  } }); assert.notEqual(new URL(app.url).port, '4417');
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce', acceptDownloads: true }), pageErrors = [], saves = []; page.on('pageerror', error => pageErrors.push(error.message)); page.on('download', download => saves.push(download.suggestedFilename()));
  await page.addInitScript(baseUrl => { window.desktopApi = { loadConnectionSettings: async () => ({ settings: { baseUrl, apiKey: 'fixture-download-model-key', model: 'http-fixture', timeoutSeconds: 30 } }) }; }, fixtureUrl + '/v1');
  await page.route('**/rhine/index.html?embed=1', route => route.continue({ url: route.request().url() + '&review=1&skipBoot=1&scene=archive' }));
  const open = async () => { await page.frameLocator('.rhine-home-frame').locator('[data-action="assistant"]').click({ timeout: 45000 }); };
  await page.goto(app.url); await open(); await page.locator('[data-app-assistant-input]').fill('下载这篇论文的原文件 ' + publicUrl); await page.locator('[data-app-assistant-send]').click(); await page.waitForFunction(() => !document.querySelector('[data-app-assistant-input]').disabled); if(!await page.locator('[data-assistant-download-save]').count()){t.diagnostic(await page.locator('[data-app-assistant-messages]').innerText());t.diagnostic(JSON.stringify({jobs:await(await page.request.get(app.url+'/api/assistant/runs')).json(),errors,targets,steps:steps.map(value=>({request:value.request,observations:value.observations}))}));} assert.equal(await page.locator('[data-assistant-download-save]').count(),1); assert.deepEqual(saves, []);
  const response = await page.request.get(app.url + '/api/assistant/downloads'), list = await response.json(); assert.equal(response.status(), 200); assert.equal(list.downloads.length, 1); const file = list.downloads[0]; assert.equal(file.name, filename); assert.equal(file.size, original.length); assert.equal(file.sha256, expectedHash); assert.equal(file.projectId, null); assert.equal(fileRequests, 1); assert.deepEqual(targets, [{ url: publicUrl, address: '8.8.8.8' }]); assert.deepEqual(await readFile(path.join(dataDir, 'assistant/downloads', file.id, 'payload')), original);
  const save = async () => { const [download] = await Promise.all([page.waitForEvent('download'), page.locator('[data-assistant-download-save]').click()]); assert.equal(download.suggestedFilename(), filename); const bytes = await readFile(await download.path()); assert.deepEqual(bytes, original); return bytes; };
  await save(); await page.screenshot({ path: path.join(evidence, 'download-real-server.png') }); await page.reload(); await open(); assert.equal(await page.locator('[data-assistant-download-save]').getAttribute('href'), file.downloadUrl); const saved = await save(); await writeFile(path.join(evidence, 'real-server-original-saved.pdf'), saved);
  const runs = await (await page.request.get(app.url + '/api/assistant/runs')).json(); assert.equal(runs.jobs.length, 1); assert.equal(runs.jobs[0].status, 'completed'); assert.equal(runs.jobs[0].effects[0].download.downloadUrl, file.downloadUrl); assert.equal(runs.jobs[0].steps.find(step => step.tool === 'web_download').status, 'completed'); assert.equal(steps.length, 2); assert.equal(saves.length, 2); assert.deepEqual(errors, []); assert.deepEqual(pageErrors, []);
  await writeFile(path.join(evidence, 'download-server-ui-verification.json'), JSON.stringify({ realApplicationServer: true, controlledWebTransport: true, liveNetwork: false, filename, size: original.length, sha256: expectedHash, browserSaves: saves.length, pageRefreshPreservesFile: true, downloadEffects: runs.jobs[0].effects.length }, null, 2));
});
