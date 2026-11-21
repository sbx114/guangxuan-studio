import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
test('real workspace task links and stale autosaves preserve server changes and only merge assistant conversation', { timeout: 90000 }, async t => {
  let chromium; try { ({ chromium } = await import('playwright-core')); } catch { t.skip('Playwright is required.'); return; }
  let browser; try { browser = await chromium.launch({ channel: 'msedge', headless: true }); } catch { t.skip('Installed Edge is required.'); return; }
  const project = (id, kind, title) => ({ id, kind, title, assistantRevision: 0, description: '', cover: 'classic', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), source: { title: '', text: '服务器材料', url: '' }, brief: { scenario: '活动预告', audience: '公众', tone: '清晰', length: '标准' }, facts: [], missing: [], history: [], runs: [], outputs: null, ...(kind === 'video' ? { video: { timeline: [], captions: [], script: '', aspect: '16:9' } } : {}) });
  const projects = new Map([['writing-a', project('writing-a', 'writing', '隔离文案项目')], ['video-a', project('video-a', 'video', '隔离视频项目')]]);
  const puts = [], reads = [], starts = [], jobs = new Map(); let raceConversation = true, count = 0;
  const json = (res, value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json;charset=utf-8' }); res.end(JSON.stringify(value)); };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString() || '{}') : null;
      if (url.pathname === '/fixture/bump-writing') { const value = projects.get('writing-a'); value.assistantRevision++; value.outputs = { article: { title: '助手保留的新文案', body: '服务器正文' } }; json(res, {}); return; }
      if (url.pathname === '/api/projects/summary') { json(res, { projects: [...projects.values()].map(({ id, kind, title, createdAt, updatedAt }) => ({ id, kind, title, createdAt, updatedAt })) }); return; }
      if (/\/references$/.test(url.pathname)) { json(res, { items: [], revision: 1, includeImages: true }); return; }
      if (/\/source-link$/.test(url.pathname)) { json(res, { status: 'unlinked', changes: [] }); return; }
      const target = /^\/api\/projects\/([^/]+)$/.exec(url.pathname);
      if (target) {
        const id = target[1], value = projects.get(id);
        if (req.method === 'PUT') {
          if (id === 'video-a' && raceConversation && body.video?.assistantMessages?.some(message => message.runStatus === 'completed')) { raceConversation = false; value.assistantRevision++; value.outputs.article.title = '并发后保留的文案'; value.video.editScope = { placement: { mode: 'append' } }; }
          const stale = Number(body.assistantRevision || 0) < Number(value.assistantRevision || 0); puts.push({ id, stale, body: structuredClone(body) });
          if (stale) { json(res, { code: 'ASSISTANT_STALE_PROJECT', error: '助手已更新项目' }, 409); return; }
          projects.set(id, body);
        } else reads.push(id);
        json(res, { project: projects.get(id) }); return;
      }
      if (url.pathname === '/api/assistant/runs' && req.method === 'POST') { const id = 'save-run-' + (++count); starts.push(body); const job = { id, runId: id, projectId: body.projectId || null, status: 'running', instruction: body.instruction, mode: body.mode, steps: [], message: '', sources: [], effects: [] }; jobs.set(id, job); json(res, { runId: id, job }, 202); return; }
      const run = /^\/api\/assistant\/runs\/([^/]+)$/.exec(url.pathname);
      if (run) {
        if (run[1] === 'external-task-run') { json(res, { job: { id: run[1], projectId: null, status: 'completed', instruction: '任务中心的问题', message: '任务中心的真实任务回复', sources: [], steps: [], effects: [] } }); return; }
        const job = jobs.get(run[1]);
        if (job.status === 'running') {
          job.status = 'completed'; job.message = '助手处理完成。';
          if (job.mode === 'auto') { const value = projects.get(job.projectId); value.assistantRevision++; value.title = '助手更新后的名称'; value.outputs = { article: { title: '助手更新的文案', body: '新正文' } }; job.effects = [{ type: 'project', label: '已更新文案', changed: true, projectId: value.id }]; }
        }
        json(res, { job }); return;
      }
      if (url.pathname === '/api/tasks') { json(res, { items: [{ id: 'external-task', type: 'assistant', sourceJobId: 'external-task-run', projectId: null, title: '独立问答', status: 'succeeded', progress: 100 }] }); return; }
      if (url.pathname === '/api/openfilm/open') { json(res, { editorUrl: '/openfilm/editor.html', nativeProjectId: 'native-video-a', sessionId: 'fixture-session' }); return; }
      if (url.pathname === '/api/openfilm/context') { json(res, { projectId: 'video-a', revision: 'film-revision', duration: 10, assets: [], timeline: [], mainTrackEditable: true }); return; }
      if (url.pathname === '/openfilm/editor.html') { res.writeHead(200, { 'content-type': 'text/html;charset=utf-8' }); res.end('<!doctype html><body>隔离时间线<script>addEventListener("message",e=>{if(e.data.type==="guangxuan:studio-project")parent.postMessage({type:"guangxuan:studio-ready",projectId:"video-a",sessionId:"fixture-session"},location.origin);if(e.data.type==="guangxuan:studio-flush")parent.postMessage({type:"guangxuan:studio-flushed",projectId:"video-a",requestId:e.data.requestId,sessionId:"fixture-session"},location.origin)});parent.postMessage({type:"guangxuan:studio-loaded",sessionId:"fixture-session"},location.origin)</script>'); return; }
      if (url.pathname === '/rhine/index.html') { res.writeHead(200, { 'content-type': 'text/html;charset=utf-8' }); res.end('<!doctype html><body id="viewport"><button id="open-writing" onclick="parent.postMessage({type:\'guangxuan:edit-project\',projectId:\'writing-a\'},location.origin)">文案</button><button id="open-video" onclick="parent.postMessage({type:\'guangxuan:edit-project\',projectId:\'video-a\'},location.origin)">视频</button><script>parent.postMessage({type:"guangxuan:ready"},location.origin)</script>'); return; }
      if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html;charset=utf-8' }); res.end(await readFile(path.join(root, 'public/index.html'))); return; }
      if (/^\/[a-zA-Z0-9_-]+\.(js|css)$/.test(url.pathname)) { res.writeHead(200, { 'content-type': url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript' }); res.end(await readFile(path.join(root, 'public', url.pathname.slice(1)))); return; }
      res.writeHead(404); res.end();
    } catch (error) { if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }); if (!res.writableEnded) res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const url = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' }), errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { window.desktopApi = { loadConnectionSettings: async () => ({ settings: { baseUrl: 'https://fixture.invalid/v1', model: 'fixture', apiKey: 'fixture-key' } }) }; });
  await page.goto(url); await page.frameLocator('.rhine-home-frame').locator('#open-writing').click(); await page.locator('[data-writing-source="text"]').fill('尚未保存的旧版本编辑'); await page.request.post(url + '/fixture/bump-writing');
  await page.locator('[data-writing-load-latest]').waitFor(); assert.equal(projects.get('writing-a').source.text, '服务器材料'); assert.equal(projects.get('writing-a').outputs.article.title, '助手保留的新文案'); assert.equal(puts.filter(item => item.id === 'writing-a').length, 1, 'stale business content is never automatically resubmitted'); assert.equal(await page.locator('[data-writing-source="text"]').inputValue(), '尚未保存的旧版本编辑', 'the new writing desk retains unsaved local edits during a conflict');
  await page.locator('[data-writing-load-latest]').click(); assert.equal(await page.locator('[data-writing-source="text"]').inputValue(), '服务器材料'); assert.equal(await page.locator('[data-writing-restore-local]').count(), 1, 'loading the newer version still retains a local recovery copy');
  const readsBefore = reads.length; await page.locator('[data-open-assistant]').click(); await page.locator('[data-app-assistant-input]').fill('修改文案'); await page.locator('[data-app-assistant-send]').click(); await page.waitForFunction(() => !document.querySelector('[data-app-assistant-input]').disabled); await page.locator('#modal-root [data-close]').click(); assert.equal(await page.locator('[data-writing-title]').inputValue(), '助手更新后的名称'); assert.ok(reads.length > readsBefore, 'global effects force a fresh project GET');
  await page.locator('[data-tasks]').click(); await page.locator('[data-task-id="external-task"] [data-task-action="assistant"]').click(); await page.waitForFunction(() => !document.querySelector('[data-app-assistant-input]').disabled); assert.equal(await page.locator('[data-app-assistant-project]').inputValue(), ''); assert.match(await page.locator('[data-app-assistant-messages]').innerText(), /任务中心的真实任务回复/); assert.equal(starts.length, 1, 'task link reads an existing run without starting a duplicate'); await page.locator('#modal-root [data-close]').click();
  await page.locator('[data-nav="home"]').first().click(); await page.frameLocator('.rhine-home-frame').locator('#open-video').click(); await page.locator('[data-assistant-input]').waitFor();
  await page.frameLocator('.gx-native-studio').locator('body').evaluate(() => parent.postMessage({ type: 'guangxuan:studio-edit-range', projectId: 'video-a', sessionId: 'fixture-session', selection: { range: { start: 2, end: 5 }, clipIds: [] } }, location.origin));
  await page.locator('[data-assistant-input]').fill('修改文案'); await page.locator('[data-assistant-send]').click(); await page.waitForFunction(() => !document.querySelector('[data-assistant-input]').disabled);
  const videoPuts = puts.filter(item => item.id === 'video-a'), staleIndex = videoPuts.findIndex(item => item.stale); assert.ok(staleIndex >= 0); assert.equal(videoPuts.length, staleIndex + 2, 'chat persistence retries the stale write only once'); assert.equal(videoPuts.at(-1).stale, false); assert.equal(videoPuts.at(-1).body.outputs.article.title, '并发后保留的文案'); assert.equal(projects.get('video-a').outputs.article.title, '并发后保留的文案'); assert.ok(projects.get('video-a').video.assistantMessages.some(message => message.runStatus === 'completed'));
  await page.locator('[data-assistant-mode]').selectOption('ask'); await page.locator('[data-assistant-input]').fill('解释材料'); await page.locator('[data-assistant-send]').click(); await page.waitForFunction(() => !document.querySelector('[data-assistant-input]').disabled); assert.equal(starts.at(-1).editScope.placement.start, 2); assert.equal(starts.at(-1).editScope.placement.end, 5); assert.deepEqual(errors, []);
});
