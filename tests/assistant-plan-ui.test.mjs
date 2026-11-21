import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRemotionProjectsService } from '../lib/remotion-projects.mjs';
import { startServer } from '../server.mjs';

const wait = async (read, predicate, milliseconds = 30000) => { const end = Date.now() + milliseconds; while (Date.now() < end) { const result = await read(); if (predicate(result)) return result; await new Promise(resolve => setTimeout(resolve, 25)); } assert.fail('Plan UI fixture did not settle.'); };

test('real Edge shares a persistent plan, committed source diff, truthful report and source undo', { timeout: 120000 }, async t => {
  let chromium; try { ({ chromium } = await import('playwright-core')); } catch { t.skip('Playwright is required.'); return; }
  let browser; try { browser = await chromium.launch({ channel: 'msedge', headless: true }); } catch { t.skip('Installed Edge is required.'); return; }
  const parent = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(parent, { recursive: true }); const directory = await mkdtemp(path.join(parent, 'gx-plan-ui-')), dataDir = path.join(directory, 'data');
  const evidence = process.env.GUANGXUAN_PLAN_UI_EVIDENCE ? path.resolve(process.env.GUANGXUAN_PLAN_UI_EVIDENCE) : directory; await mkdir(evidence, { recursive: true });
  let app, source, release, gateEntered = false; const gate = new Promise(resolve => { release = resolve; }), counts = new Map(), modelErrors = [], builtinNames = new Set(), posts = [];
  const projectId = 'plan-ui-project', initial = 'export const title = "原始标题";\nexport const opacity = 0.5;\n';
  const fixture = http.createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/v1/chat/completions'); const body = JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString()), input = JSON.parse(body.messages[1].content);
      const key = input.request.includes('第二版') ? 'partial' : 'success', index = counts.get(key) || 0; counts.set(key, index + 1);
      for (const name of ['assistant_plan', 'assistant_recall', 'web_search', 'web_read']) if (input.tools.some(tool => tool.name === name)) builtinNames.add(name);
      const call = (tool, args = {}) => ({ type: 'tool', tool, arguments: args, summary: '处理当前源码要求' }); let answer;
      if (key === 'success') {
        if (index === 0) answer = call('assistant_plan', { items: [{ id: 'read', label: '读取现有源码', kind: 'read', status: 'in_progress' }, { id: 'edit', label: '精确修改标题文字', kind: 'change', status: 'pending' }] });
        else if (index === 1) { gateEntered = true; await gate; answer = call('remotion_code_read', { remotionId: source.id, expectedRevision: 1, path: 'src/Main.tsx' }); }
        else if (index === 2) answer = call('remotion_code_patch', { remotionId: source.id, expectedRevision: 1, patches: [{ path: 'src/Main.tsx', oldText: '"原始标题"', newText: '"经过修改的新标题"' }] });
        else if (index === 3) answer = call('assistant_plan', { items: [{ id: 'read', label: '读取现有源码', kind: 'read', status: 'completed', evidenceIds: [input.taskState.evidence.find(entry => entry.tool === 'remotion_code_read' && entry.role === 'read').id] }, { id: 'edit', label: '精确修改标题文字', kind: 'change', status: 'completed', evidenceIds: [input.taskState.evidence.find(entry => entry.role === 'execution').id] }] });
        else answer = { type: 'final', message: '已精确修改并保存源码。尚未编译或渲染。', sourceIds: [] };
      } else {
        if (index === 0) answer = call('assistant_plan', { items: [{ id: 'edit2', label: '修改为第二版', kind: 'change', status: 'in_progress' }, { id: 'check2', label: '核对修改结果', kind: 'verify', status: 'pending' }] });
        else if (index === 1) answer = call('remotion_code_patch', { remotionId: source.id, expectedRevision: 3, patches: [{ path: 'src/Main.tsx', oldText: 42, newText: '第二版' }] });
        else answer = { type: 'final', message: index === 2 ? '全部完成。' : '修改参数无效，未保存第二版。', sourceIds: [] };
      }
      if (res.destroyed) return; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) }, finish_reason: 'stop' }] }));
    } catch (error) { modelErrors.push(error.message); if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }); if (!res.writableEnded) res.end(JSON.stringify({ error: 'controlled plan fixture failed' })); }
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve)); const fixtureUrl = 'http://127.0.0.1:' + fixture.address().port;
  t.after(async () => { release(); await browser.close(); await app?.close(); fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)); assert.equal(path.dirname(directory), parent); await rm(directory, { recursive: true, force: true }); });
  app = await startServer({ port: 0, dataDir }); assert.notEqual(new URL(app.url).port, '4417');
  const request = async (route, body, method = body === undefined ? 'GET' : 'POST') => { const response = await fetch(app.url + route, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result; };
  const project = (await request('/api/projects/' + projectId, { id: projectId, kind: 'video', title: '工程助手展示', video: { timeline: [], captions: [] } }, 'PUT')).project;
  const localProjects = await createRemotionProjectsService({ dataDir, root: path.resolve(import.meta.dirname, '..') });
  source = await localProjects.create(projectId, { ownerCreatedAt: project.createdAt, title: '已有自由动画', entryPoint: 'src/Main.tsx', files: [{ path: 'src/Main.tsx', content: initial }] });
  t.after(() => localProjects.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, reducedMotion: 'reduce' }), pageErrors = [], failedModules = [];
  page.on('pageerror', error => pageErrors.push(error.message)); page.on('response', response => { if (response.status() >= 400 && /assistant-(?:client|task|source-diff-model)/.test(response.url())) failedModules.push(response.url()); });
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/assistant/runs' && request.method() === 'POST') posts.push(request.postDataJSON()); });
  await page.addInitScript(baseUrl => { window.desktopApi = { loadConnectionSettings: async () => ({ settings: { baseUrl, apiKey: 'fixture-plan-ui-key', model: 'http-fixture', timeoutSeconds: 90 } }) }; }, fixtureUrl + '/v1');
  await page.route('**/rhine/index.html?embed=1', route => route.continue({ url: route.request().url() + '&review=1&skipBoot=1&scene=archive' }));
  const open = async () => { await page.frameLocator('.rhine-home-frame').locator('[data-action="assistant"]').click({ timeout: 45000 }); await page.locator('[data-app-assistant-project]').selectOption(projectId); };
  await page.goto(app.url); await open(); await page.locator('[data-app-assistant-input]').fill('精确修改当前动画源码的标题文字，不用编译或渲染，先维护计划。'); await page.locator('[data-app-assistant-send]').click(); await wait(() => Promise.resolve(gateEntered), Boolean);
  await page.locator('[data-assistant-plan] .is-in_progress').waitFor(); assert.equal(await page.locator('[data-assistant-report]').count(), 0); await page.screenshot({ path: path.join(evidence, 'plan-running-desktop.png') }); release();
  await page.waitForFunction(() => !document.querySelector('[data-app-assistant-input]').disabled); const success = (await request('/api/assistant/runs')).jobs[0], successMessage = page.locator(`[data-assistant-run="${success.id}"]`);
  assert.equal(success.report.outcome, 'complete'); assert.deepEqual(success.report.verified, []); assert.equal(success.plan.items.every(item => item.status === 'completed'), true); assert.equal((await localProjects.read(projectId, source.id)).revision, 2);
  const difference = successMessage.locator('[data-assistant-source-diff]'); assert.equal(await difference.getAttribute('open'), null); await difference.locator(':scope > summary').click(); assert.match(await difference.innerText(), /原始标题/); assert.match(await difference.innerText(), /经过修改的新标题/);
  await successMessage.locator('[data-assistant-report] > summary').click(); assert.match(await successMessage.innerText(), /暂无额外检查记录/); assert.equal(await successMessage.locator('[data-evidence-kind="visual_review"]').count(), 0);
  await difference.screenshot({ path: path.join(evidence, 'source-diff-desktop.png') }); await page.screenshot({ path: path.join(evidence, 'plan-result-desktop.png') });
  await successMessage.locator('[data-app-assistant-undo]').click(); await page.waitForFunction(() => !document.querySelector('[data-app-assistant-input]').disabled); const undone = await localProjects.read(projectId, source.id); assert.equal(undone.revision, 3); assert.equal(undone.files[0].content, initial);
  await page.setViewportSize({ width: 390, height: 844 }); await page.locator('[data-app-assistant-input]').fill('修改当前动画源码为第二版，并维护计划。'); await page.locator('[data-app-assistant-send]').click(); await page.waitForFunction(() => !document.querySelector('[data-app-assistant-input]').disabled);
  const partial = (await request('/api/assistant/runs')).jobs.find(job => job.instruction.includes('第二版')), partialMessage = page.locator(`[data-assistant-run="${partial.id}"]`);
  assert.equal(partial.report.outcome, 'partial'); assert.match(await partialMessage.innerText(), /本次尚未全部完成/); assert.match(await partialMessage.innerText(), /未完成/); assert.equal((await localProjects.read(projectId, source.id)).revision, 3); assert.equal(counts.get('partial'), 4);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true); await page.screenshot({ path: path.join(evidence, 'plan-partial-mobile.png') });
  await page.reload(); await open(); await page.locator(`[data-assistant-run="${partial.id}"] [data-assistant-report="partial"]`).waitFor(); assert.equal(posts.length, 2, 'Reload must not replay source writes');
  assert.deepEqual([...builtinNames].sort(), ['assistant_plan', 'assistant_recall', 'web_read', 'web_search']); assert.deepEqual(modelErrors, []); assert.deepEqual(pageErrors, []); assert.deepEqual(failedModules, []);
  await writeFile(path.join(evidence, 'plan-ui-verification.json'), JSON.stringify({ realApplicationServer: true, randomPort: new URL(app.url).port, realEdge: true, modelFixtureOnly: true, actualCodePatch: true, sourceRevisionAfterWrite: 2, undoRevision: 3, undoRestored: undone.files[0].content === initial, planItems: success.plan.items.length, persistedAfterReload: true, falseVerificationAvoided: success.report.verified.length === 0, partialOutcome: partial.report.outcome, correctionChanceBounded: counts.get('partial') === 4, postRequests: posts.length, builtins: [...builtinNames].sort(), module404s: failedModules, pageErrors }, null, 2));
});
