import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('actual browser keeps watching the same run after four HTTP failures, and respects cancellation and a real missing run', { timeout: 60000 }, async () => {
  let requests = 0, mode = 'recover', browser;
  const server = http.createServer(async (req, res) => {
    if (req.url.startsWith('/api/assistant/runs/')) {
      requests++; res.setHeader('Content-Type', 'application/json');
      if (mode === 'missing') { res.statusCode = 404; res.end(JSON.stringify({ error: '任务不存在', code: 'ASSISTANT_RUN_NOT_FOUND' })); }
      else if (mode === 'cancel' || requests <= 4) { res.statusCode = 503; res.end(JSON.stringify({ error: '暂时连接失败' })); }
      else res.end(JSON.stringify({ job: { id: 'same-run', status: 'completed' } }));
      return;
    }
    if (/^\/[a-z-]+\.js$/.test(req.url)) { res.setHeader('Content-Type', 'text/javascript'); res.end(await readFile(path.join(root, 'public', req.url.slice(1)))); return; }
    res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html><body>Isolated progress transport</body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true }); const page = await browser.newPage(); await page.goto(`http://127.0.0.1:${server.address().port}`);
    const result = await page.evaluate(async () => {
      const { watchAssistantRun } = await import('/assistant-client.js'), connections = [];
      const job = await watchAssistantRun('same-run', { interval: 1, onConnection: value => connections.push(value) });
      return { job, connections };
    });
    assert.equal(requests, 5); assert.equal(result.job.id, 'same-run'); assert.equal(result.job.status, 'completed');
    assert.equal(result.connections.filter(value => value.status === 'reconnecting').length, 4); assert.equal(result.connections.at(-1).status, 'connected');
    mode = 'cancel'; requests = 0;
    const cancelled = await page.evaluate(async () => {
      const { watchAssistantRun } = await import('/assistant-client.js'), controller = new AbortController();
      try { await watchAssistantRun('same-run', { signal: controller.signal, onConnection: () => controller.abort() }); } catch (error) { return error.name; }
    });
    assert.equal(cancelled, 'AbortError'); assert.equal(requests, 1);
    mode = 'missing'; requests = 0;
    const missing = await page.evaluate(async () => { const { watchAssistantRun } = await import('/assistant-client.js'); try { await watchAssistantRun('same-run'); } catch (error) { return { code: error.code, status: error.status }; } });
    assert.deepEqual(missing, { code: 'ASSISTANT_RUN_NOT_FOUND', status: 404 }); assert.equal(requests, 1);
  } finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
