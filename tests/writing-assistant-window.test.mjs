import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { startServer } from '../server.mjs';

const until = async (read, check, timeout = 15000) => { const end = Date.now() + timeout; while (Date.now() < end) { const value = await read(); if (check(value)) return value; await new Promise(resolve => setTimeout(resolve, 25)); } assert.fail('Expected writing assistant state did not settle.'); };
async function fixture(t) {
  const parent = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(parent, { recursive: true });
  const folder = await mkdtemp(path.join(parent, 'gx-writing-window-')), dataDir = path.join(folder, 'data');
  const plans = [], drafts = [], errors = [], authorizations = []; let block = '', blocked = false, release, app;
  const provider = http.createServer(async (req, res) => {
    try {
      const body = JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString()), input = JSON.parse(body.messages.find(message => message.role === 'user').content);
      authorizations.push(req.headers.authorization); assert.equal(body.model, 'window-local-fixture'); let answer;
      if (body.messages[0].content.includes('Gx 软件内')) {
        plans.push(input); const observations = input.observations || [];
        if (observations.some(value => value.status === 'failed')) answer = { type: 'final', message: '文稿出现并发修改，本次写入未覆盖新版本。', sourceIds: [] };
        else if (!observations.some(value => value.tool === 'writing_read')) answer = { type: 'tool', tool: 'writing_read', arguments: { channel: 'article' }, summary: '读取当前实际文稿' };
        else if (/仅评价/.test(input.request)) answer = { type: 'final', message: '已读取当前实际文稿并评价，没有改写正文。', sourceIds: [] };
        else if (!observations.some(value => value.tool === 'writing_revise' && value.status === 'completed')) {
          const selection = /只改选中/.test(input.request) ? input.projectContext.writingContext.selection : null;
          answer = { type: 'tool', tool: 'writing_revise', arguments: { channel: 'article', instruction: input.request, ...(selection ? { selection } : {}) }, summary: '按当前要求精修并保存文稿' };
        } else {
          if (block === 'final' && /中断/.test(input.request)) { blocked = true; const finished = await new Promise(resolve => { release = resolve; res.once('close', () => resolve(false)); }); if (!finished) return; }
          answer = { type: 'final', message: /中断/.test(input.request) ? '原任务已完成，文稿已经保存。' : '已在文案工作区保存精修结果，可撤销。', sourceIds: [] };
        }
      } else {
        drafts.push(input);
        if (block === 'draft' && /并发/.test(input.本次调整?.instruction)) { blocked = true; await new Promise(resolve => { release = resolve; }); }
        if (input.当前稿件.selection) answer = { channel: 'article', replacement: '选中的新句', evidence: [], notes: [] };
        else answer = { channel: 'article', output: { ...input.当前稿件, body: input.当前稿件.body + '\n全文更自然。' }, evidence: [], notes: [] };
      }
      if (!res.destroyed) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(answer) } }] })); }
    } catch (error) { errors.push(error.message); if (!res.headersSent) res.writeHead(500); if (!res.writableEnded) res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  app = await startServer({ port: 0, dataDir });
  const api = async (route, body, method = body === undefined ? 'GET' : 'POST') => { const response = await fetch(app.url + route, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const data = await response.json(); assert.ok(response.ok, JSON.stringify(data)); return data; };
  const id = 'writing-window-fixture', output = { title: '原标题', lead: '导语', body: '开头👋。选中的原句。结尾保留。' };
  await api('/api/projects/' + id, { kind: 'writing', title: '隔离文案窗口', source: { title: '原材料', text: '材料仅用于本地文案窗口验证。', url: '' }, outputs: { article: output, social: { title: '社群稿', text: '其它渠道不改。', tags: [] } }, writing: { brief: { goal: '清楚表达', channel: 'article' }, draft: { channel: 'article', output, evidence: [], notes: [], origin: 'manual' } } }, 'PUT');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1360, height: 950 } }), starts = [], resumes = [], pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message)); page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/assistant/runs')) starts.push(request.postDataJSON()); if (request.method() === 'POST' && request.url().endsWith('/resume')) resumes.push(request.postDataJSON()); });
  const settings = { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'local-window-fixture-key', model: 'window-local-fixture', apiStyle: 'chat', timeoutSeconds: 30 };
  const html = `<!doctype html><html><head><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/editor-assistant.css"><link rel="stylesheet" href="/app-assistant.css"><link rel="stylesheet" href="/interface-cleanup.css"></head><body><div id="writer"></div><div id="toast-region"></div><div id="modal-root"></div><script type="module">
import {createWritingWorkspace} from '/writing-workspace.js';import {createAppAssistant} from '/app-assistant.js';
const request=async(route,body,method=body===undefined?'GET':'POST')=>{const response=await fetch(route,{method,headers:body===undefined?{}:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await response.json();if(!response.ok)throw Object.assign(new Error(value.error),{code:value.code});return value;};
window.project=(await request('/api/projects/${id}')).project;
window.shared=createAppAssistant({getSettings:()=>(${JSON.stringify(settings)}),requireConnection:()=>true,getProjects:()=>[{id:project.id,title:project.title,kind:project.kind}],getProjectId:()=>project.id,beforeStart:()=>desk.flush(),onChanged:async()=>{window.project=(await request('/api/projects/${id}')).project;desk.render(document.getElementById('writer'),project);},onUndo:async(projectId,undo)=>request('/api/assistant/undo',{projectId,undoId:undo.id})});
window.desk=createWritingWorkspace({saveProject:async p=>{const saved=(await request('/api/projects/'+p.id,p,'PUT')).project;p.writingRevision=saved.writingRevision;p.assistantRevision=saved.assistantRevision;return saved;},requireConnection:()=>true,onAssistant:options=>shared.open(options)});desk.render(document.getElementById('writer'),project);window.ready=true;
window.addEventListener('pagehide',()=>{desk.dispose();shared.dispose()});</script></body></html>`;
  await page.route('**/fixture-writing-assistant', route => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
  await page.goto(app.url + '/fixture-writing-assistant'); await page.waitForFunction(() => window.ready); await page.evaluate(() => document.fonts.ready);
  t.after(async () => { release?.(false); await browser.close(); await app.close(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); assert.equal(path.dirname(folder), parent); await rm(folder, { recursive: true, force: true }); });
  return { page, api, id, plans, drafts, errors, starts, resumes, pageErrors, authorizations, settings, setBlock(value) { block = value; blocked = false; }, get blocked() { return blocked; }, release() { block = ''; release?.(true); }, async restart() { const port = Number(new URL(app.url).port); await app.close(); block = ''; app = await startServer({ port, dataDir }); } };
}

async function send(page, instruction) { await page.locator('[data-app-assistant-input]').fill(instruction); await page.locator('[data-app-assistant-send]').click(); await page.waitForFunction(() => !document.querySelector('[data-app-assistant-input]').disabled); }
async function modalGeometry(page) {
  const actual = await page.evaluate(() => {
    const rectangle = selector => { const rect = document.querySelector(selector).getBoundingClientRect(); return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }; };
    const log = document.querySelector('[data-app-assistant-messages]');
    return { viewport: { width: innerWidth, height: innerHeight }, modal: rectangle('.gx-app-assistant-modal'), input: rectangle('[data-app-assistant-input]'), send: rectangle('[data-app-assistant-send]'), log: { ...rectangle('[data-app-assistant-messages]'), overflowY: getComputedStyle(log).overflowY, clientHeight: log.clientHeight, scrollHeight: log.scrollHeight } };
  });
  for (const rect of [actual.modal, actual.input, actual.send]) { assert.ok(rect.x >= 0 && rect.y >= 0 && rect.right <= actual.viewport.width + .5 && rect.bottom <= actual.viewport.height + .5, JSON.stringify(actual)); }
  assert.ok(['auto', 'scroll'].includes(actual.log.overflowY)); assert.ok(actual.log.height > 120);
  return actual;
}
test('writing page opens the shared selectable assistant and performs real read/write, selection, undo and CAS', { timeout: 120000 }, async t => {
  const f = await fixture(t), page = f.page;
  await page.locator('[data-writing-assistant]').click(); await page.waitForTimeout(250); assert.equal(await page.locator('[data-app-assistant-window]').count(), 1, JSON.stringify({ feedback: await page.locator('[data-writing-feedback]').innerText(), errors: f.pageErrors })); await page.locator('[data-app-assistant-window]').waitFor(); assert.equal(await page.locator('[data-app-assistant-window]').inputValue(), 'writing');
  await page.locator('[data-app-assistant-window]').selectOption('project'); assert.equal(await page.locator('[data-app-assistant-writing-target]').count(), 0);
  await page.locator('[data-app-assistant-window]').selectOption('writing'); await page.locator('[data-app-assistant-mode]').selectOption('ask');
  const before = (await f.api('/api/projects/' + f.id)).project; await send(page, '仅评价当前文稿，不做修改');
  assert.equal(f.drafts.length, 0); assert.match(await page.locator('[data-app-assistant-messages]').innerText(), /已读取当前实际文稿/); assert.equal((await f.api('/api/projects/' + f.id)).project.outputs.article.body, before.outputs.article.body);
  await page.locator('[data-close]').click(); await page.locator('[data-writing-edit]').click();
  const manual = '手改开头👋。选中的原句。手改结尾。'; await page.locator('[data-writing-out="body"]').fill(manual);
  await page.locator('[data-writing-out="body"]').evaluate((node, text) => { const start = node.value.indexOf(text); node.setSelectionRange(start, start + text.length); node.dispatchEvent(new Event('select', { bubbles: true })); }, '选中的原句');
  await page.locator('[data-writing-assistant]').click(); await page.locator('[data-app-assistant-mode]').selectOption('auto'); await page.locator('[data-app-assistant-writing-target]').selectOption('selection');
  await send(page, '请只改选中的原句，保留前后其他文字');
  assert.equal((await f.api('/api/projects/' + f.id)).project.outputs.article.body, manual.replace('选中的原句', '选中的新句'));
  const started = f.starts.at(-1); assert.equal(started.mode, 'auto'); assert.equal(started.writingContext.channel, 'article'); assert.match(started.writingContext.outputFingerprint, /^[a-f0-9]{64}$/); assert.deepEqual(started.writingContext.selection.path, ['body']); assert.equal(started.writingContext.selection.start, manual.indexOf('选中的原句')); assert.equal(started.settings.apiKey, f.settings.apiKey);
  const selectionGeometry = await modalGeometry(page);
  const evidence = process.env.GUANGXUAN_WRITING_ASSISTANT_EVIDENCE; if (evidence) { await mkdir(evidence, { recursive: true }); await page.screenshot({ path: path.join(evidence, 'writing-assistant-selection.png') }); }
  await page.locator('[data-app-assistant-undo]').last().click(); await until(() => f.api('/api/projects/' + f.id), value => value.project.outputs.article.body === manual);
  await send(page, '把全稿改得更自然并保存'); assert.equal((await f.api('/api/projects/' + f.id)).project.outputs.article.body, manual + '\n全文更自然。'); assert.equal((await f.api('/api/projects/' + f.id)).project.outputs.social.text, '其它渠道不改。');
  f.setBlock('draft'); await page.locator('[data-app-assistant-input]').fill('改写全文并保存，等待并发检查'); await page.locator('[data-app-assistant-send]').click(); await until(() => f.blocked, Boolean);
  const concurrent = (await f.api('/api/projects/' + f.id)).project; concurrent.writing.draft.output.body = concurrent.outputs.article.body = '服务端并发手稿，必须保留。'; await f.api('/api/projects/' + f.id, concurrent, 'PUT'); f.release();
  await page.waitForFunction(() => !document.querySelector('[data-app-assistant-input]').disabled); assert.equal((await f.api('/api/projects/' + f.id)).project.outputs.article.body, '服务端并发手稿，必须保留。');
  const conflict = (await f.api('/api/assistant/runs')).jobs[0]; assert.equal(conflict.report.outcome, 'partial'); assert.ok(conflict.report.unfinished.some(item => item.code === 'ASSISTANT_CONFLICT')); assert.match(await page.locator('[data-app-assistant-messages]').innerText(), /未完成/);
  assert.equal(await page.locator('[data-writing-out="body"]').inputValue(), '服务端并发手稿，必须保留。');
  const finalGeometry = await modalGeometry(page); assert.ok(finalGeometry.log.scrollHeight > finalGeometry.log.clientHeight);
  assert.deepEqual(f.errors, []); assert.deepEqual(f.pageErrors, []); assert.ok(f.authorizations.every(value => value === 'Bearer ' + f.settings.apiKey));
  if (evidence) { await mkdir(evidence, { recursive: true }); await page.screenshot({ path: path.join(evidence, 'writing-assistant-window.png') }); await writeFile(path.join(evidence, 'writing-window-verification.json'), JSON.stringify({ status: 'passed', actualEdgeAndServer: true, sharedAssistantRuns: f.starts.length, actualReadAndWrite: true, readonlyPreserved: true, selectedRangePreservedOutside: true, actualUndo: true, casKeptConcurrentDraft: true, uiRefreshedCurrentDraft: true, sameModelConnection: true, realSharedStylesLoaded: true, selectionGeometry, finalGeometry, externalModelsUsed: false, userProjectsUsed: false }, null, 2)); }
});

test('writing assistant resumes the same interrupted run after a server restart without repeating its successful write', { timeout: 120000 }, async t => {
  const f = await fixture(t), page = f.page;
  f.setBlock('final'); await page.locator('[data-writing-assistant]').click(); await page.locator('[data-app-assistant-input]').fill('改写全文，中断后继续原任务'); await page.locator('[data-app-assistant-send]').click();
  await until(() => f.blocked, Boolean); assert.equal(f.drafts.length, 1); const originalRunId = (await f.api('/api/assistant/runs')).jobs[0].id;
  await f.restart(); await page.getByRole('button', { name: '继续完成', exact: true }).waitFor({ timeout: 30000 });
  const interrupted = (await f.api('/api/assistant/runs/' + originalRunId)).job; assert.equal(interrupted.status, 'interrupted'); assert.equal(interrupted.resumable, true);
  await page.getByRole('button', { name: '继续完成', exact: true }).click(); await page.waitForFunction(() => !document.querySelector('[data-app-assistant-input]').disabled);
  const final = (await f.api('/api/assistant/runs/' + originalRunId)).job; assert.equal(final.status, 'completed'); assert.equal(final.resumeCount, 1); assert.equal(f.drafts.length, 1); assert.equal(f.starts.length, 1); assert.equal(f.resumes.length, 1);
  assert.match(await page.locator('[data-app-assistant-messages]').innerText(), /原任务已完成/); assert.deepEqual(f.errors, []); assert.deepEqual(f.pageErrors, []);
  const evidence = process.env.GUANGXUAN_WRITING_ASSISTANT_EVIDENCE; if (evidence) { await mkdir(evidence, { recursive: true }); await writeFile(path.join(evidence, 'writing-resume-verification.json'), JSON.stringify({ status: 'passed', actualServiceRestart: true, originalRunId, sameRunResumed: true, resumeCount: final.resumeCount, writingModelCalls: f.drafts.length, startCalls: f.starts.length, resumeCalls: f.resumes.length, successfulWriteNotReplayed: true, externalModelsUsed: false, userProjectsUsed: false }, null, 2)); }
});
