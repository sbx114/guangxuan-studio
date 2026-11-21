import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { startServer } from '../server.mjs';

const until = async (read, predicate, milliseconds = 10000) => { const end = Date.now() + milliseconds; while (Date.now() < end) { const result = await read(); if (predicate(result)) return result; await new Promise(resolve => setTimeout(resolve, 30)); } assert.fail('Expected state did not settle.'); };
test('real UI and server complete HTTP model tool runs, save and undo a draft, reopen tasks and restore a running conversation', { timeout: 120000 }, async t => {
  let chromium; try { ({ chromium } = await import('playwright-core')); } catch { t.skip('Playwright is required.'); return; }
  let browser; try { browser = await chromium.launch({ channel: 'msedge', headless: true }); } catch { t.skip('Installed Edge is required.'); return; }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gx-assistant-server-ui-')), dataDir = path.join(directory, 'data');
  const evidence = process.env.GUANGXUAN_ASSISTANT_UI_EVIDENCE ? path.resolve(process.env.GUANGXUAN_ASSISTANT_UI_EVIDENCE) : directory; await mkdir(evidence, { recursive: true });
  const calls = [], failures = [], authorizations = [], key = 'fixture-assistant-integration-secret'; let cancelledModelCalls = 0, app;
  const model = http.createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/v1/chat/completions'); authorizations.push(req.headers.authorization);
      const body = JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString());
      const payload = JSON.parse(body.messages.find(message => message.role === 'user').content); calls.push(payload);
      if (/刷新恢复|取消慢任务/.test(payload.request)) {
        const finished = await new Promise(resolve => { const timer = setTimeout(() => { res.off('close', close); resolve(true); }, /取消/.test(payload.request) ? 10000 : 2500); const close = () => { clearTimeout(timer); cancelledModelCalls++; resolve(false); }; res.once('close', close); });
        if (!finished || res.destroyed) return;
      }
      let step;
      if (/写入公众号草稿/.test(payload.request)) {
        if (!payload.observations.some(observation => observation.tool === 'project_read')) step = { type: 'tool', tool: 'project_read', arguments: {}, summary: '读取项目材料' };
        else if (!payload.observations.some(observation => observation.tool === 'draft_write')) step = { type: 'tool', tool: 'draft_write', arguments: { channel: 'article', content: { title: '校园实验室开放日', titles: ['一起走进实验室'], lead: '从项目材料认识实验步骤。', body: '校园实验室开放日将介绍实验步骤。内容来自当前项目提供的材料。' } }, summary: '保存公众号草稿' };
        else {
          const receipt = payload.observations.find(observation => observation.tool === 'draft_write'); assert.equal(receipt.status, 'completed', JSON.stringify(receipt)); step = { type: 'final', message: '已根据项目材料保存公众号草稿，可在对话中撤销。', sourceIds: [] };
        }
      } else step = { type: 'final', message: /刷新恢复/.test(payload.request) ? '刷新后已恢复本轮回复。' : /取消/.test(payload.request) ? '慢任务完成。' : '可以阅读项目材料、按需联网查资料，并在明确要求时完成软件内的修改。[S99]', sourceIds: ['S99'] };
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(step) }, finish_reason: 'stop' }] }));
    } catch (error) { failures.push(error.message); if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }); if (!res.writableEnded) res.end(JSON.stringify({ error: 'model fixture failed' })); }
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve)); const modelUrl = 'http://127.0.0.1:' + model.address().port;
  t.after(async () => { await browser.close(); await app?.close(); model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); assert.equal(path.dirname(directory), os.tmpdir()); await rm(directory, { recursive: true, force: true }); });
  app = await startServer({ port: 0, dataDir }); assert.notEqual(new URL(app.url).port, '4417');
  const request = async (route, body, method = body === undefined ? 'GET' : 'POST') => { const response = await fetch(app.url + route, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result; };
  const id = 'assistant-ui-writing', initial = { id, kind: 'writing', title: '隔离实验室活动', description: '真实服务集成测试', source: { title: '开放日材料', text: '校园实验室开放日将介绍实验步骤。所有描述以提供的材料为依据。', url: '' }, brief: { scenario: '活动预告', audience: '校园师生', tone: '清晰亲切', length: '标准' }, facts: [], missing: [], history: [], runs: [], outputs: null };
  await request('/api/projects/' + id, initial, 'PUT');
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' }), errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ baseUrl, apiKey }) => { window.desktopApi = { loadConnectionSettings: async () => ({ settings: { baseUrl, apiKey, model: 'http-fixture', timeoutSeconds: 30, apiStyle: 'chat' } }) }; }, { baseUrl: modelUrl + '/v1', apiKey: key });
  await page.route('**/rhine/index.html?embed=1', route => route.continue({ url: route.request().url() + '&review=1&skipBoot=1&scene=archive' }));
  const home = () => page.frameLocator('.rhine-home-frame');
  await page.goto(app.url); await home().locator('[data-action="assistant"]').click({ timeout: 45000 });
  await page.locator('[data-app-assistant-project]').selectOption(''); await page.locator('[data-app-assistant-input]').fill('你可以做什么？'); await page.locator('[data-app-assistant-send]').click(); await page.waitForFunction(() => !document.querySelector('[data-app-assistant-input]').disabled); assert.match(await page.locator('[data-app-assistant-messages]').innerText(), /按需联网查资料/); assert.equal(await page.locator('.gx-assistant-sources').count(), 0); assert.doesNotMatch(await page.locator('[data-app-assistant-messages]').innerText(), /S99/);
  let jobs = (await request('/api/assistant/runs')).jobs; assert.equal(jobs[0].status, 'completed'); assert.equal(jobs[0].projectId, null); assert.deepEqual(jobs[0].sources, []);
  await page.locator('[data-app-assistant-project]').selectOption(id); await page.locator('[data-app-assistant-input]').fill('根据当前项目材料写入公众号草稿'); await page.locator('[data-app-assistant-send]').click(); await page.waitForFunction(() => !document.querySelector('[data-app-assistant-input]').disabled); await page.locator('[data-app-assistant-undo]').waitFor();
  const written = (await request('/api/projects/' + id)).project; assert.equal(written.outputs.article.title, '校园实验室开放日'); assert.ok(written.assistantRevision > 0);
  const rawProject = JSON.parse(await readFile(path.join(dataDir, 'projects', id + '.json'), 'utf8')); assert.equal(rawProject.outputs.article.body, written.outputs.article.body);
  jobs = (await request('/api/assistant/runs')).jobs; const writeJob = jobs.find(job => /写入公众号草稿/.test(job.instruction)); assert.equal(writeJob.status, 'completed'); assert.deepEqual(writeJob.steps.filter(step => step.type === 'tool').map(step => [step.tool, step.status]), [['project_read', 'completed'], ['draft_write', 'completed']]); assert.equal(writeJob.effects[0].undo.kind, 'project');
  await page.screenshot({ path: path.join(evidence, 'assistant-real-server-write.png') });
  await page.locator('[data-app-assistant-undo]').click(); await page.waitForFunction(() => !document.querySelector('[data-app-assistant-input]').disabled); const restored = (await request('/api/projects/' + id)).project; assert.equal(restored.outputs, null); assert.equal(restored.source.text, initial.source.text);
  await page.locator('#modal-root [data-close]').click(); await home().locator('[data-action="tasks"]').click();
  const tasks = await until(() => request('/api/tasks'), value => value.items.some(task => task.type === 'assistant' && task.sourceJobId === writeJob.id)); const writeTask = tasks.items.find(task => task.sourceJobId === writeJob.id); assert.equal(writeTask.projectId, id); assert.equal(writeTask.status, 'succeeded');
  await page.locator(`[data-task-id="${writeTask.id}"] [data-task-action="assistant"]`).click(); await page.waitForFunction(() => !document.querySelector('[data-app-assistant-input]').disabled); assert.equal(await page.locator('[data-app-assistant-project]').inputValue(), id); assert.match(await page.locator(`[data-assistant-run="${writeJob.id}"]`).innerText(), /已根据项目材料保存公众号草稿/); assert.equal(await page.locator('[data-app-assistant-undo]').count(), 0, 'reopening a real job preserves its locally used undo receipt');
  await page.locator('[data-app-assistant-input]').fill('刷新恢复这轮问答'); await page.locator('[data-app-assistant-send]').click();
  await until(() => Promise.resolve(calls), value => value.some(call => /刷新恢复/.test(call.request))); const pendingJob = (await request('/api/assistant/runs')).jobs.find(job => /刷新恢复/.test(job.instruction)); assert.ok(['queued', 'running'].includes(pendingJob.status));
  await page.reload(); await home().locator('[data-action="assistant"]').click({ timeout: 45000 }); await page.locator('[data-app-assistant-project]').selectOption(id); await page.waitForFunction(() => !document.querySelector('[data-app-assistant-input]').disabled); assert.match(await page.locator('[data-app-assistant-messages]').innerText(), /刷新后已恢复本轮回复/); assert.equal((await request('/api/assistant/runs')).jobs.filter(job => /刷新恢复/.test(job.instruction)).length, 1);
  await page.locator('[data-app-assistant-input]').fill('取消慢任务'); await page.locator('[data-app-assistant-send]').click(); await until(() => Promise.resolve(calls), value => value.some(call => /取消慢任务/.test(call.request))); await page.locator('[data-app-assistant-stop]').click(); await page.waitForFunction(() => !document.querySelector('[data-app-assistant-input]').disabled); const stopped = (await request('/api/assistant/runs')).jobs.find(job => /取消慢任务/.test(job.instruction)); assert.equal(stopped.status, 'cancelled'); await until(() => Promise.resolve(cancelledModelCalls), value => value > 0);
  const persisted = await readFile(path.join(dataDir, 'assistant', 'runs.json'), 'utf8'); assert.equal(persisted.includes(key), false); assert.equal(persisted.includes(modelUrl), false); assert.equal((await page.evaluate(() => JSON.stringify(localStorage))).includes(key), false); assert.ok(authorizations.every(value => value === 'Bearer ' + key)); assert.deepEqual(failures, []); assert.deepEqual(errors, []);
});
