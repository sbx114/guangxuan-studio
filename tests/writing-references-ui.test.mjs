import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { startServer } from '../server.mjs';
import { findAnimationBrowser } from '../animation/render.mjs';

const source = { title: '当前材料', text: '本次共读在社区书屋举行，安排以讨论为主。', url: '' }, referenceText = '对照实验需要只改变待研究因素，并保持其他条件相同。样本数量为30组。';
test('real writing UI keeps optional references off by default, persists chosen sources, cites them separately and protects edits from late work', { timeout: 90000 }, async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'gx-writing-reference-ui-')), dataDir = path.join(folder, 'data'), evidence = process.env.GUANGXUAN_WRITING_REFERENCE_EVIDENCE ? path.resolve(process.env.GUANGXUAN_WRITING_REFERENCE_EVIDENCE) : folder; await mkdir(evidence, { recursive: true });
  const calls = [], providerErrors = []; let app, hold, browser;
  const provider = http.createServer(async (req, res) => {
    try {
      const body = JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString()), payload = JSON.parse(body.messages[1].content); calls.push(payload);
      if (hold) { const wait = hold; hold = null; wait.admit(); await wait.promise; }
      const references = payload.可选参考, result = { channel: 'article', output: { title: '共读安排', lead: '', body: source.text, titles: [] }, evidence: [{ quote: source.text }, ...(references?.purpose !== 'style' ? (references?.items || []).map(item => ({ sourceId: item.id, quote: item.text.slice(0, 29), label: '参考内容' })) : [])], notes: [] };
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] }));
    } catch (error) { providerErrors.push(error.message); res.writeHead(500); res.end('{}'); }
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  t.after(async () => { if (hold) hold.release?.(); await browser?.close(); await app?.close(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); assert.equal(path.dirname(folder), os.tmpdir()); await rm(folder, { recursive: true, force: true }); });
  app = await startServer({ port: 0, dataDir }); assert.notEqual(new URL(app.url).port, '4417');
  const settings = { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'fixture-only-not-user-key', model: 'writing-reference-ui' };
  const api = async (route, body, method = body === undefined ? 'GET' : 'PUT') => { const response = await fetch(app.url + route, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result; };
  await api('/api/projects/writing-reference-ui', { kind: 'writing', title: '可选参考测试', source, facts: [], writing: { brief: { goal: '写一份清楚的邀请', channel: 'article' } } });
  const referenceProject = (await api('/api/projects/writing-reference-source', { kind: 'writing', title: '已有参考项目', source: { text: referenceText }, outputs: { article: { title: '已有作品', body: '先给结论，再用短句解释。', lead: '', titles: [] } } })).project;
  browser = await chromium.launch({ executablePath: await findAnimationBrowser(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1365, height: 980 }, reducedMotion: 'reduce' }), errors = [], external = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => { const target = new URL(route.request().url()); if (target.origin === app.url) return route.continue(); external.push(target.href); return route.abort(); });
  await page.route('**/__writing-reference-fixture', route => route.fulfill({ contentType: 'text/html;charset=utf-8', body: `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><main id="desk"></main><div id="modal-root"></div><div id="toast-region"></div><script type="module">import {api} from '/ui.js';import {createWritingWorkspace} from '/writing-workspace.js';import {readWritingPreferences} from '/writing-preferences.js';window.project=(await api('/api/projects/writing-reference-ui')).project;window.settings=${JSON.stringify(settings)};window.desk=createWritingWorkspace({requireConnection:()=>true,saveProject:async p=>{p.writingRevision??=0;const {project:saved}=await api('/api/projects/'+p.id,p,{method:'PUT'});p.writingRevision=saved.writingRevision;p.assistantRevision=saved.assistantRevision;return saved},callAi:(task,payload,{signal})=>api('/api/ai',{task,payload,settings},{signal})});desk.render(document.getElementById('desk'),project);window.preferences=readWritingPreferences;window.ready=true;</script>` }));
  await page.goto(app.url + '/__writing-reference-fixture'); await page.waitForFunction(() => window.ready);
  assert.equal(await page.locator('[data-writing-references]').getAttribute('open'), null); assert.equal(await page.locator('[data-writing-reference-enabled]').isChecked(), false);
  await page.locator('[data-writing-generate]').click(); await page.waitForFunction(() => !document.querySelector('[data-writing-generate]').disabled); assert.equal(calls[0].可选参考, undefined);
  await page.locator('[data-writing-references]>summary').click(); await page.locator('[data-writing-reference-enabled]').check();
  await page.locator('[data-writing-reference-purpose]').selectOption('content'); await page.locator('[data-writing-reference-text]').fill('粘贴参考：说明前提，再给出结论。');
  const projectOption = JSON.stringify(['writing-reference-source', 'material', referenceProject.createdAt]); await page.locator(`[data-writing-reference-project] option[value='${projectOption}']`).waitFor({ state: 'attached' }); await page.locator('[data-writing-reference-project]').selectOption(projectOption);
  await page.evaluate(() => desk.flush()); await page.reload(); await page.waitForFunction(() => window.ready);
  assert.equal(await page.locator('[data-writing-references]').getAttribute('open'), null); assert.equal(await page.locator('[data-writing-reference-enabled]').isChecked(), true); assert.equal(await page.locator('[data-writing-reference-text]').inputValue(), '粘贴参考：说明前提，再给出结论。'); assert.equal(await page.locator('[data-writing-reference-project]').inputValue(), projectOption);
  await page.locator('[data-writing-generate]').click(); await page.waitForFunction(() => !document.querySelector('[data-writing-generate]').disabled);
  assert.equal(calls.at(-1).可选参考.purpose, 'content'); assert.equal(calls.at(-1).可选参考.items.length, 2); assert.equal(calls.at(-1).可选参考.items[1].text, referenceText);
  await page.locator('[data-writing-evidence]>summary').click(); assert.equal(await page.locator('[data-writing-evidence-source="source"]').count(), 1); assert.equal(await page.locator('[data-writing-evidence-source="reference-project"]').count(), 1); assert.match(await page.locator('[data-writing-evidence-source="reference-project"]>span').innerText(), /参考｜已有参考项目 · 材料/);
  assert.equal(await page.evaluate(() => project.source.text), source.text); assert.equal(await page.evaluate(() => preferences().styleSample), '');
  await page.locator('[data-writing-quick="natural"]').click(); await page.waitForFunction(() => !document.querySelector('[data-writing-generate]').disabled); assert.equal(calls.at(-1).可选参考.items[1].text, referenceText, 'Revision also receives the real selected reference');
  await page.locator('[data-writing-references]>summary').click();
  let admit, release; const admitted = new Promise(resolve => { admit = resolve; }), promise = new Promise(resolve => { release = resolve; }); hold = { admit, promise, release };
  await page.locator('[data-writing-quick="natural"]').click(); await admitted;
  await page.locator('[data-writing-reference-purpose]').selectOption('style'); await page.locator('[data-writing-reference-text]').fill('生成期间换成新的写法参考。');
  await page.locator('[data-writing-edit]').click(); await page.locator('[data-writing-out="body"]').fill('生成期间手动写的新稿，不能覆盖。'); await page.evaluate(() => desk.flush());
  release(); await page.locator('[data-writing-view-proposal]').waitFor(); await page.waitForFunction(() => !document.querySelector('[data-writing-generate]').disabled);
  assert.equal(await page.locator('[data-writing-out="body"]').inputValue(), '生成期间手动写的新稿，不能覆盖。'); assert.equal(await page.locator('[data-writing-reference-purpose]').inputValue(), 'style'); assert.equal(await page.locator('[data-writing-reference-text]').inputValue(), '生成期间换成新的写法参考。');
  await page.locator('[data-writing-view-proposal]').click(); await page.locator('[data-writing-keep-current]').click(); assert.equal(await page.locator('[data-writing-out="body"]').inputValue(), '生成期间手动写的新稿，不能覆盖。');
  await api('/api/projects/writing-reference-source', undefined, 'DELETE');
  const recreated = (await api('/api/projects/writing-reference-source', { kind: 'writing', title: '同名重建的参考', createdAt: '2020-01-01T00:00:00.000Z', source: { text: '重新选择的新版本参考，必须使用新版本身份。' } })).project;
  if (await page.locator('[data-writing-references]').evaluate(node => node.open)) await page.locator('[data-writing-references]>summary').click();
  await page.locator('[data-writing-references]>summary').click();
  const recreatedOption = JSON.stringify([recreated.id, 'material', recreated.createdAt]); await page.locator(`[data-writing-reference-project] option[value='${recreatedOption}']`).waitFor({ state: 'attached' });
  assert.equal(await page.locator('[data-writing-reference-project]').inputValue(), projectOption); assert.match(await page.locator('[data-writing-reference-project] option:checked').innerText(), /失效/);
  await page.locator('[data-writing-reference-project]').selectOption(recreatedOption); await page.evaluate(() => desk.flush());
  const repinned = (await api('/api/projects/writing-reference-ui')).project; assert.equal(repinned.writing.references.projectCreatedAt, recreated.createdAt);
  const verified = await api('/api/ai', { task: 'writing-revise', payload: { projectId: repinned.id, writingBrief: repinned.writing.brief, writingReferences: repinned.writing.references, output: repinned.outputs.article, channel: 'article', instruction: '按新选择的参考修改' }, settings }, 'POST'); assert.equal(verified.meta?.inputChanged, undefined); assert.equal(calls.at(-1).可选参考.items[1].text, recreated.source.text);
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true); await page.screenshot({ path: path.join(evidence, 'writing-optional-references-mobile.png'), fullPage: true });
  await page.evaluate(() => desk.flush()); const saved = (await api('/api/projects/writing-reference-ui')).project; assert.equal(saved.writing.references.purpose, 'style'); assert.equal(saved.writing.references.projectId, 'writing-reference-source'); assert.equal(saved.outputs.article.body, '生成期间手动写的新稿，不能覆盖。');
  assert.deepEqual(errors, []); assert.deepEqual(providerErrors, []); assert.deepEqual(external, []);
  await writeFile(path.join(evidence, 'writing-optional-reference-ui-verification.json'), JSON.stringify({ status: 'passed', actualBrowser: true, productionWorkspaceAndServer: true, defaultOff: true, pastedAndProjectReferences: true, preservedAfterReload: true, draftAndRevisionReceivedReferences: true, originalAndReferenceEvidenceSeparated: true, changedReferencesAndManualEditsPreserved: true, recreatedProjectExplicitlyRepinnedInUi: true, writingPreferencesUnchanged: true, requests: calls.length, externalRequests: external.length, userKeysUsed: false, requested4417: false }, null, 2));
});
