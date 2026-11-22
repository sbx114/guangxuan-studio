import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
test('analysis UI continues the evidence page without changing selected range or enabling providers', async () => {
  const requests = [], errors = [], cache = 'a'.repeat(64);
  const cue = { kind: 'visual-sampled', subjects: [{ label: '<蓝色主体>', role: 'primary' }], composition: { focus: '右侧留白' }, motion: { status: 'paired-observation', description: '主体从左侧移至中间' }, usableSegments: [{ start: 10, end: 12, purpose: 'action', rationale: '两帧支持位置变化' }] };
  const first = { name: '隔离素材', assetId: 'owned', cacheKey: cache, analyzedAt: 'first', range: { start: 10, end: 20, timecode: '00:00:10.000–00:00:20.000' }, summary: { text: '第一页' }, shots: [{ id: 's1', timecode: '10–12', cues: cue }, { id: 's2', timecode: '12–20' }], keyframes: [], pagination: { shotOffset: 0, shotLimit: 12, totalShots: 2, returnedShots: 1, hasMore: true, nextShotOffset: 1 } };
  const second = { ...first, cacheKey: 'b'.repeat(64), analyzedAt: 'second', summary: { text: '第二页已完成' }, pagination: { ...first.pagination, shotOffset: 1, hasMore: false, nextShotOffset: null }, shots: [{ id: 's2', timecode: '12–20', cues: { ...cue, subjects: [{ label: '后续主体', role: 'primary' }] } }] };
  const files = { '/source-analysis.js': 'public/source-analysis.js', '/source-analysis.css': 'public/source-analysis.css', '/styles.css': 'public/styles.css', '/ui.js': 'public/ui.js' };
  let finish = false, browser;
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (files[url.pathname]) { res.setHeader('Content-Type', url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript'); res.end(await readFile(path.join(root, files[url.pathname]))); return; }
      if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(`<!doctype html><html lang="zh"><head><link rel="stylesheet" href="/styles.css"></head><body><div id="app"><button id="open">分析</button></div><div id="modal-root"></div><div id="toast-region"></div><script type="module">import {createSourceAnalysis} from '/source-analysis.js';const client=createSourceAnalysis({getSettings:()=>({apiKey:'test-only-settings'})});document.querySelector('#open').onclick=()=>client.show({id:'isolated',title:'分页测试'});</script></body></html>`); return; }
      res.setHeader('Content-Type', 'application/json');
      if (url.pathname.endsWith('/jobs/page-job')) { res.end(JSON.stringify(finish ? { id: 'page-job', status: 'complete', progress: 1, phase: 'complete', result: { items: [second] } } : { id: 'page-job', status: 'running', progress: .3 })); return; }
      if (req.method === 'POST') { let body = ''; for await (const chunk of req) body += chunk; requests.push(JSON.parse(body)); res.end(JSON.stringify({ id: 'page-job', status: 'queued' })); return; }
      res.end(JSON.stringify({ assets: [{ id: 'owned', type: 'video', name: '隔离素材', duration: 30 }], items: [first], jobs: [], runtimeAvailable: true }));
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const { chromium } = await import(pathToFileURL(path.join(root, 'node_modules/playwright-core/index.mjs')));
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`); await page.locator('#open').click();
    const next = page.locator('[data-sa-next]').first(); await next.waitFor();
    assert.match(await page.locator('[data-sa-results]').innerText(), /本页 1 \/ 2/);
    await page.locator('details.sa-result').first().locator('summary').click();
    assert.match(await page.locator('[data-sa-results]').innerText(), /<蓝色主体>.*主体/);
    assert.equal(await page.locator('[data-sa-results] 蓝色主体').count(), 0, 'cue labels are escaped');
    await page.locator('[data-sa-start="owned"]').fill('1'); await page.locator('[data-sa-end="owned"]').fill('5');
    await next.click();
    await page.waitForFunction(() => document.querySelector('[data-sa-next]')?.disabled === true);
    assert.deepEqual(requests[0].sources, [{ assetId: 'owned', start: 10, end: 20 }]);
    assert.equal(requests[0].options.shotOffset, 1); assert.equal(requests[0].options.shotLimit, 6); assert.equal(requests[0].options.maxFrames, 12);
    assert.equal(requests[0].options.visualSummary, false); assert.equal(requests[0].options.transcribe, false); assert.equal('settings' in requests[0], false);
    finish = true;
    await page.getByText('第二页已完成', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-sa-start="owned"]').inputValue(), '1'); assert.equal(await page.locator('[data-sa-end="owned"]').inputValue(), '5');
    assert.equal(await page.locator('[data-sa-option="visualSummary"]').isChecked(), false);
    assert.equal(await page.locator('[data-sa-next]').count(), 1, 'the previous evidence page remains available');
    if (process.env.GUANGXUAN_ANALYSIS_PAGE_UI_EVIDENCE) { await mkdir(process.env.GUANGXUAN_ANALYSIS_PAGE_UI_EVIDENCE, { recursive: true }); await page.screenshot({ path: path.join(process.env.GUANGXUAN_ANALYSIS_PAGE_UI_EVIDENCE, 'continued-page.png') }); }
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
