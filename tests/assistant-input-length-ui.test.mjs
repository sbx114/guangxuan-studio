import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const draft = '要求'.repeat(3750), longerInstruction = '剪辑'.repeat(5500), reply = '讲解'.repeat(5000) + '【完整末尾】';
const hash = value => createHash('sha256').update(value).digest('hex');

test('isolated real Edge restores and submits 7500-character drafts and preserves long assistant replies in both entry points', { timeout: 60000 }, async t => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  let project = { id: 'length-video', kind: 'video', title: '隔离长度夹具', video: { script: '保持原工程内容', timeline: [], captions: [], assistantDraft: draft, assistantMessages: [], assistantMode: 'ask', editScope: { placement: { mode: 'free' } } } };
  const untouchedEngineering = JSON.stringify({ script: project.video.script, timeline: project.video.timeline, captions: project.video.captions });
  const requests = [], saves = [], jobs = new Map(), pageErrors = [];
  const respond = (res, value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json;charset=utf-8' }); res.end(JSON.stringify(value)); };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const body = ['POST', 'PUT'].includes(req.method) ? JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString() || '{}') : null;
      if (url.pathname === '/api/assistant/runs' && req.method === 'POST') {
        requests.push(body); const id = 'length-run-' + requests.length;
        const job = { id, runId: id, projectId: project.id, status: 'completed', instruction: body.instruction, mode: body.mode, message: reply, sources: [], steps: [], effects: [] };
        jobs.set(id, job); respond(res, { runId: id, job }, 202); return;
      }
      const run = /^\/api\/assistant\/runs\/([^/]+)$/.exec(url.pathname);
      if (run) { respond(res, { job: jobs.get(run[1]) }); return; }
      if (url.pathname === '/api/projects/length-video') {
        if (req.method === 'PUT') { project = body; saves.push(structuredClone(body)); }
        respond(res, { project }); return;
      }
      if (url.pathname === '/api/openfilm/context') { respond(res, { projectId: project.id, revision: 'length-native-r1', duration: 0, assets: [], timeline: [], mainTrackEditable: true, aspect: '16:9' }); return; }
      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html;charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><body><div id="editor-host"></div><div id="modal-root"></div><div id="toast-region"></div><script type="module">
import {createAppAssistant} from '/app-assistant.js';import {createEditorAssistant} from '/editor-assistant.js';import {api} from '/ui.js';
const settings={baseUrl:'https://fixture.invalid/v1',model:'fixture',apiKey:'fixture-not-a-real-key'};
window.openGlobal=seed=>{window.global?.dispose();if(seed!==undefined)localStorage.setItem('gx-assistant-conversations-v1',JSON.stringify([{key:'length-video',draft:seed,mode:'ask',messages:[]}]))
;window.global=createAppAssistant({getSettings:()=>settings,requireConnection:()=>true,getProjects:()=>[{id:'length-video',title:'隔离长度夹具'}],getProjectId:()=> 'length-video'});window.global.open();};
window.openEditor=async()=>{window.global?.dispose();window.editor?.dispose();window.editorProject=(await api('/api/projects/length-video')).project;window.editor=createEditorAssistant({getSettings:()=>settings,requireConnection:()=>true,saveProject:async p=>(await api('/api/projects/'+p.id,p,{method:'PUT'})).project});window.editor.mount(document.querySelector('#editor-host'),window.editorProject);};
window.ready=true;</script>`); return;
      }
      if (/^\/[A-Za-z0-9_.-]+\.(js|css)$/.test(url.pathname)) { res.writeHead(200, { 'content-type': url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript' }); res.end(await readFile(path.join(source, 'public', url.pathname.slice(1)))); return; }
      res.writeHead(404); res.end();
    } catch (error) { if (!res.headersSent) respond(res, { error: error.message }, 500); else res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.on('pageerror', error => pageErrors.push(error.message));
  const origin = 'http://127.0.0.1:' + server.address().port;
  await page.goto(origin); await page.waitForFunction(() => window.ready);
  await page.evaluate(value => window.openGlobal(value), draft);
  assert.equal(await page.locator('[data-app-assistant-input]').getAttribute('maxlength'), '12000');
  assert.equal(await page.locator('[data-app-assistant-input]').inputValue(), draft);
  await page.locator('[data-app-assistant-send]').click();
  await page.waitForFunction(expected => !window.global.isBusy('length-video') && JSON.parse(localStorage.getItem('gx-assistant-conversations-v1')).find(item => item.key === 'length-video').messages.some(message => message.role === 'assistant' && message.content === expected), reply);
  assert.equal(requests[0].instruction, draft);
  await page.reload(); await page.waitForFunction(() => window.ready); await page.evaluate(() => window.openGlobal());
  const globalMessages = await page.evaluate(() => JSON.parse(localStorage.getItem('gx-assistant-conversations-v1')).find(item => item.key === 'length-video').messages);
  assert.equal(globalMessages.find(message => message.role === 'user').content, draft); assert.equal(globalMessages.find(message => message.role === 'assistant').content, reply);
  assert.ok((await page.locator('[data-app-assistant-messages]').textContent()).includes('【完整末尾】'));

  await page.evaluate(() => window.openEditor());
  assert.equal(await page.locator('[data-assistant-input]').getAttribute('maxlength'), '12000');
  assert.equal(await page.locator('[data-assistant-input]').inputValue(), draft);
  await page.locator('[data-assistant-send]').click();
  await page.waitForFunction(expected => !window.editor.isBusy('length-video') && window.editorProject.video.assistantMessages.some(message => message.role === 'assistant' && message.content === expected), reply);
  await page.evaluate(() => window.editor.flush()); assert.equal(requests[1].instruction, draft);
  assert.equal(project.video.assistantMessages.find(message => message.role === 'user').content, draft); assert.equal(project.video.assistantMessages.find(message => message.role === 'assistant').content, reply);
  await page.reload(); await page.waitForFunction(() => window.ready); await page.evaluate(() => window.openEditor());
  assert.ok((await page.locator('[data-assistant-messages]').textContent()).includes('【完整末尾】'));
  const reopened = await page.evaluate(() => window.editorProject.video.assistantMessages);
  assert.equal(reopened.find(message => message.role === 'user').content, draft); assert.equal(reopened.find(message => message.role === 'assistant').content, reply);

  await page.locator('[data-assistant-input]').fill(longerInstruction); await page.locator('[data-assistant-send]').click();
  await page.waitForFunction(() => !window.editor.isBusy('length-video')); await page.evaluate(() => window.editor.flush());
  assert.equal(requests[2].instruction, longerInstruction);
  assert.equal(project.video.assistantMessages.filter(message => message.role === 'user').at(-1).content, longerInstruction);
  assert.equal(JSON.stringify({ script: project.video.script, timeline: project.video.timeline, captions: project.video.captions }), untouchedEngineering);
  assert.deepEqual(pageErrors, []); assert.ok(saves.length > 0);
  if (process.env.GUANGXUAN_ASSISTANT_INPUT_EVIDENCE) {
    const directory = path.resolve(process.env.GUANGXUAN_ASSISTANT_INPUT_EVIDENCE); await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'verification.json'), JSON.stringify({ status: 'passed', browser: 'msedge', browserVersion: browser.version(), actualEdge: true, isolatedBrowserContext: true, projectFixtureOnly: true, userKeyRead: false, actualModelUsed: false, paidModelCalls: 0, draftCharacters: draft.length, restoredDraftHash: hash(draft), submittedCharacters: requests.map(item => item.instruction.length), editorUserMessageCharacters: longerInstruction.length, assistantReplyCharacters: reply.length, assistantReplyHash: hash(reply), globalReopenedReplyComplete: true, editorSavedAndReopenedReplyComplete: true, engineeringContentUnchanged: true, pageErrors }, null, 2));
  }
});
