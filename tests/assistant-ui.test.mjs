import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { assistantDetails, assistantSources, applyAssistantJob } from '../public/assistant-client.js';
import { rhineCommand } from '../public/rhine-host.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
test('assistant output escapes untrusted text and only links HTTP sources', () => {
  const content = assistantDetails({ steps: [{ type: 'tool', label: '<script>bad()</script>', message: '<img onerror=bad()>', status: 'completed' }], sources: [{ id: 'S1', title: '<svg/onload=bad()>', url: 'https://example.com/?q=%22' }, { title: 'bad', url: 'javascript:bad()' }], effects: [{ label: '<b>changed</b>' }] });
  assert.doesNotMatch(content, /<script>|<img |<svg\/onload|javascript:/);
  assert.match(content, /&lt;script&gt;/); assert.match(content, /rel="noopener noreferrer"/);
  assert.equal(assistantSources([{ url: 'https://user:password@example.com/' }, { url: 'file:///C:/private' }]).length, 0);
  const message = {}; applyAssistantJob(message, { id: 'r1', status: 'failed', error: { message: '模型连接失败' }, steps: [] }); assert.equal(message.status, 'error'); assert.equal(message.content, '模型连接失败');
  const frame = {}, origin = 'http://127.0.0.1:1234'; assert.deepEqual(rhineCommand({ type: 'guangxuan:open', view: 'assistant' }, origin, frame, origin, frame), { type: 'open', view: 'assistant' });
});

test('global and editor assistants run, show sources, stop, resume, retry and preserve scoped project changes', { timeout: 90000 }, async t => {
  let chromium; try { ({ chromium } = await import('playwright-core')); } catch { t.skip('Playwright is required.'); return; }
  let browser; try { browser = await chromium.launch({ channel: 'msedge', headless: true }); } catch { t.skip('Installed Edge is required.'); return; }
  const folder = await mkdtemp(path.join(os.tmpdir(), 'gx-assistant-ui-'));
  const evidence = process.env.GUANGXUAN_ASSISTANT_UI_EVIDENCE ? path.resolve(process.env.GUANGXUAN_ASSISTANT_UI_EVIDENCE) : folder; await mkdir(evidence, { recursive: true });
  const projects = new Map([['video-a', { id: 'video-a', kind: 'video', title: '隔离视频项目', video: { timeline: [], captions: [], script: '原稿' } }], ['writing-a', { id: 'writing-a', kind: 'writing', title: '隔离写作项目', source: { text: '项目材料' } }]]);
  const runs = new Map([['external-run', {job:{id:'external-run',runId:'external-run',projectId:null,status:'completed',instruction:'从任务中心恢复的外部问答',message:'外部任务已完成，来源可追溯。',steps:[],sources:[{id:'S1',title:'外部任务来源',url:'https://example.com/external'}],effects:[]},count:0}], ['legacy-failed', { job: { id: 'legacy-failed', runId: 'legacy-failed', projectId: 'writing-a', status: 'failed', instruction: '旧版未完成任务', error: { message: '旧任务尚未完成。' }, resumable: false, resumeBlockReason: '旧任务没有可核对的恢复状态，已有结果保留。', steps: [], effects: [], sources: [] }, count: 0 }]]), requests = [], resumeRequests = [], readRequests = [], undoCalls = [], saveRequests = [];
  let counter = 0, failNext = false, effectWrites = 0;
  const writeOnce = run => {
    if (run.written || !run.job.projectId || run.job.mode !== 'auto' || !/修改/.test(run.job.instruction)) return;
    const project = projects.get(run.job.projectId); project.outputs = { article: { title: '服务器新文案', body: '保留服务器修改' } }; run.written = true; effectWrites++;
    run.job.effects = [{ type: 'project', projectId: project.id, changed: true, label: '已更新文案', undo: { kind: 'project', id: 'opaque-undo' } }];
  };
  const json = (res, value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json;charset=utf-8' }); res.end(JSON.stringify(value)); };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const body = req.method === 'POST' || req.method === 'PUT' ? JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString() || '{}') : null;
      if (url.pathname === '/api/tasks') { json(res, {items:[...runs.values()].map(({job})=>({id:'task-'+job.id,type:'assistant',sourceJobId:job.id,projectId:job.projectId,status:job.status==='completed'?'succeeded':job.status==='running'?'running':job.status,title:job.instruction,progress:job.status==='running'?25:100})).concat({id:'invalid-source-task',type:'assistant',sourceJobId:'../invalid',status:'succeeded',title:'无效来源任务'})});return; }
      if (url.pathname === '/fixture/fail-next') { failNext = true; json(res, {}); return; }
      if (url.pathname === '/api/assistant/runs' && req.method === 'POST') {
        requests.push(body); const id = 'run-' + (++counter); const job = { id, runId: id, projectId: body.projectId || null, status: 'running', instruction: body.instruction, mode: body.mode, steps: [{ id: 'step1', type: 'tool', tool: 'web_search', status: 'running', label: '搜索网页' }], message: '', sources: [], effects: [] };
        runs.set(id, { job, count: 0, slow: /慢|后台|恢复/.test(body.instruction), fail: failNext }); failNext = false; json(res, { runId: id, job }, 202); return;
      }
      const resume = /^\/api\/assistant\/runs\/([^/]+)\/resume$/.exec(url.pathname);
      if (resume && req.method === 'POST') {
        const run = runs.get(resume[1]); if (!run?.job.resumable) { json(res, { error: '任务缺少可恢复状态' }, 409); return; }
        assert.ok(!['instruction', 'projectId', 'mode'].some(key => Object.hasOwn(body, key)), 'Resume cannot replace the goal, project or original mode');
        resumeRequests.push({ runId: run.job.id, body: structuredClone(body), originalMode: run.job.mode, originalInstruction: run.job.instruction });
        run.fail = false; run.count = 0; run.job.status = 'running'; run.job.resumable = false; run.job.resumeCount = (run.job.resumeCount || 0) + 1; delete run.job.error; delete run.job.resumeBlockReason; run.job.steps[0].status = 'running';
        json(res, { runId: run.job.id, job: run.job }, 202); return;
      }
      const match = /^\/api\/assistant\/runs\/([^/]+)(\/cancel)?$/.exec(url.pathname);
      if (match) {
        const run = runs.get(match[1]); if (!run) { json(res, { error: '未找到助手任务' }, 404); return; }
        if (match[2]) { run.job.status = 'cancelled'; run.job.steps[0].status = 'cancelled'; json(res, { job: run.job }); return; }
        readRequests.push(run.job.id);
        if (run.job.status === 'running') {
          run.count++;
          if (run.count >= (run.slow ? 4 : 2)) {
            writeOnce(run);
            run.job.status = run.fail ? 'failed' : 'completed'; run.job.resumable = run.fail; run.job.steps[0].status = run.fail ? 'failed' : 'completed'; if (!run.job.steps.some(step => step.id === 'step2')) run.job.steps.push({ id: 'step2', type: 'tool', tool: 'web_read', status: 'completed', label: '读取网页', message: '<img src=x onerror=window.bad=true>' });
            run.job.message = run.fail ? '' : '已检索并阅读资料，主要结论来自真实工具响应 [S1]。<script>window.bad=true</script>';
            if (run.fail) run.job.error = { code: 'MODEL_ERROR', message: '隔离模型暂时失败' };
            else { run.job.sources = [{ id: 'S1', title: '来源 <b>原文</b>', url: 'https://example.com/reference' }];
            }
          }
        }
        json(res, { job: run.job }); return;
      }
      if (url.pathname === '/api/assistant/undo') { undoCalls.push(body); delete projects.get(body.projectId).outputs; json(res, { restored: true, project: projects.get(body.projectId) }); return; }
      if (url.pathname.startsWith('/api/projects/')) { const id = url.pathname.split('/').at(-1); if (req.method === 'PUT') { projects.set(id, body); saveRequests.push(structuredClone(body)); } json(res, { project: projects.get(id) }); return; }
      if (url.pathname === '/api/openfilm/context') { json(res, { projectId: 'video-a', revision: 'revision-a', duration: 10, assets: [], timeline: [], mainTrackEditable: true }); return; }
      if (url.pathname === '/api/openfilm/open') { json(res, { editorUrl: '/openfilm/editor.html', nativeProjectId: 'native-video-a', sessionId: 'fixture-session' }); return; }
      if (url.pathname === '/openfilm/editor.html') { res.writeHead(200, { 'content-type': 'text/html;charset=utf-8' }); res.end('<!doctype html><body>隔离时间线<script>addEventListener("message",e=>{if(e.data.type==="guangxuan:studio-project")parent.postMessage({type:"guangxuan:studio-ready",projectId:"video-a",sessionId:"fixture-session"},location.origin);if(e.data.type==="guangxuan:studio-flush")parent.postMessage({type:"guangxuan:studio-flushed",projectId:"video-a",requestId:e.data.requestId,sessionId:"fixture-session"},location.origin)});parent.postMessage({type:"guangxuan:studio-loaded",sessionId:"fixture-session"},location.origin)</script>'); return; }
      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html;charset=utf-8' }); res.end(`<!doctype html><html lang="zh"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/workspace-chrome.css"><link rel="stylesheet" href="/workspace-transition.css"><link rel="stylesheet" href="/editor-assistant.css"><link rel="stylesheet" href="/app-assistant.css"></head><body><main id="fixture"></main><div id="modal-root"></div><div id="toast-region"></div><script type="module">
import {createTaskCenter} from '/task-center.js';import {api} from '/ui.js';import {createAppAssistant} from '/app-assistant.js';import {createEditorAssistant} from '/editor-assistant.js';import {createNativeStudio} from '/native-studio.js';import {workspaceHeader,installWorkspaceTools} from '/workspace-chrome.js';
const settings={baseUrl:'https://fixture.invalid/v1',model:'fixture',apiKey:'fixture-secret'}, undo=async(id,value)=>api('/api/assistant/undo',{projectId:id,undoId:value.id});window.changed=[];window.appAssistant=createAppAssistant({getSettings:()=>settings,requireConnection:()=>true,getProjects:()=>[{id:'video-a',title:'隔离视频项目'},{id:'writing-a',title:'隔离写作项目'}],getProjectId:()=>window.defaultProject||null,onChanged:async id=>changed.push(id),onUndo:undo});
window.tasks=createTaskCenter({getProjectId:()=>null});document.addEventListener('gx:assistant-open',event=>appAssistant.open(event.detail));const fixture=document.querySelector('#fixture');fixture.innerHTML=workspaceHeader('writer');installWorkspaceTools(fixture);document.addEventListener('click',event=>{if(event.target.closest('[data-open-assistant]'))appAssistant.open()});
window.mountEditor=async()=>{appAssistant.dispose();fixture.innerHTML='';window.project=(await api('/api/projects/video-a')).project;window.editor=createEditorAssistant({getSettings:()=>settings,requireConnection:()=>true,saveProject:async p=>(await api('/api/projects/'+p.id,p,{method:'PUT'})).project,beforeAction:()=>native.flush(),onChanged:async id=>changed.push(id),onUndo:undo,onVisibilityChange:value=>native.setAssistantVisible(value)});window.native=createNativeStudio(fixture,{assistant:editor});await native.prepare(project);native.setVisible(true);};window.ready=true;
</script></body></html>`); return;
      }
      if (/^\/[a-zA-Z0-9_-]+\.(js|css)$/.test(url.pathname)) { res.writeHead(200, { 'content-type': url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript' }); res.end(await readFile(path.join(root, 'public', url.pathname.slice(1)))); return; }
      res.writeHead(404); res.end();
    } catch (error) { if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }); if (!res.writableEnded) res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const url = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); assert.equal(path.dirname(folder), os.tmpdir()); await rm(folder, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' }), errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(url); await page.waitForFunction(() => window.ready); await page.locator('[data-open-assistant]').click();
  await page.locator('[data-app-assistant-input]').fill('搜索材料'); await page.locator('[data-app-assistant-send]').click(); await page.locator('.gx-assistant-sources a').waitFor();
  assert.equal(requests[0].mode, 'auto'); assert.equal(requests[0].projectId, undefined); assert.equal(await page.locator('.gx-assistant-steps li').count(), 2); assert.equal(await page.locator('.gx-assistant-sources a').getAttribute('href'), 'https://example.com/reference'); assert.equal(await page.evaluate(() => window.bad), undefined); assert.equal(await page.locator('[data-app-assistant-stop]').isVisible(), false);
  await page.screenshot({ path: path.join(evidence, 'assistant-global-desktop.png') });
  await page.locator('#modal-root [data-close]').click();await page.evaluate(()=>{window.defaultProject='video-a';tasks.open({scope:'all'})});await page.locator('[data-task-id="task-external-run"] [data-task-action="assistant"]').waitFor();assert.equal(await page.locator('[data-task-id="invalid-source-task"] [data-task-action="assistant"]').count(),0);const postedBeforeTask=requests.length;await page.locator('[data-task-id="task-external-run"] [data-task-action="assistant"]').click();await page.waitForFunction(()=>!document.querySelector('[data-app-assistant-input]').disabled);assert.equal(await page.locator('[data-app-assistant-project]').inputValue(),'');assert.match(await page.locator('[data-app-assistant-messages]').innerText(),/从任务中心恢复的外部问答/);assert.match(await page.locator('[data-assistant-run="external-run"]').innerText(),/外部任务已完成/);assert.equal(requests.length,postedBeforeTask,'Opening an assistant task only reads its run');await page.evaluate(()=>window.defaultProject=null);
  await page.locator('[data-app-assistant-project]').selectOption('writing-a'); await page.locator('[data-app-assistant-mode]').selectOption('ask'); await page.locator('[data-app-assistant-input]').fill('只解释材料'); await page.locator('[data-app-assistant-send]').click(); await page.waitForFunction(() => !document.querySelector('[data-app-assistant-input]').disabled); assert.equal(requests.at(-1).mode, 'ask'); assert.equal(requests.at(-1).projectId, 'writing-a');
  await page.locator('[data-app-assistant-input]').fill('慢任务'); await page.locator('[data-app-assistant-send]').click(); await page.locator('[data-app-assistant-stop]').click(); await page.waitForFunction(() => !document.querySelector('[data-app-assistant-input]').disabled); assert.equal([...runs.values()].at(-1).job.status, 'cancelled');
  await page.locator('[data-app-assistant-mode]').selectOption('auto'); await page.request.post(url + '/fixture/fail-next'); await page.locator('[data-app-assistant-input]').fill('修改文案后重新核对资料'); await page.locator('[data-app-assistant-send]').click(); await page.locator('[data-app-assistant-retry]').last().waitFor(); assert.match(await page.locator('[data-app-assistant-messages]').innerText(), /隔离模型暂时失败/);
  const failedRun = [...runs.values()].at(-1).job, previousCount = requests.length, previousResumeCount = resumeRequests.length, previousWrites = effectWrites;
  assert.equal(previousWrites, 1); assert.equal(projects.get('writing-a').outputs.article.body, '保留服务器修改');
  await page.locator('[data-app-assistant-mode]').selectOption('ask'); await page.locator('[data-app-assistant-retry]').last().click(); await page.waitForFunction(() => !document.querySelector('[data-app-assistant-input]').disabled);
  assert.equal(requests.length, previousCount, 'Continue must not start another run'); assert.equal(resumeRequests.length, previousResumeCount + 1); assert.equal(resumeRequests.at(-1).runId, failedRun.id); assert.equal(resumeRequests.at(-1).originalMode, 'auto'); assert.equal(failedRun.mode, 'auto'); assert.equal(failedRun.status, 'completed'); assert.equal(failedRun.resumeCount, 1); assert.equal(effectWrites, previousWrites, 'A successful earlier write is not replayed');
  assert.equal(failedRun.steps.filter(step => step.id === 'step2').length, 1);
  await page.evaluate(() => appAssistant.open({ projectId: 'writing-a', runId: 'legacy-failed' })); await page.waitForFunction(() => !document.querySelector('[data-app-assistant-input]').disabled);
  const legacy = page.locator('[data-assistant-run="legacy-failed"]'); assert.match(await legacy.innerText(), /旧任务没有可核对的恢复状态/); const previousReads = readRequests.filter(id => id === 'legacy-failed').length;
  await legacy.locator('[data-app-assistant-retry]').click(); await page.waitForFunction(() => !document.querySelector('[data-app-assistant-input]').disabled);
  assert.equal(readRequests.filter(id => id === 'legacy-failed').length, previousReads + 1); assert.equal(requests.length, previousCount); assert.equal(resumeRequests.length, previousResumeCount + 1); assert.equal(runs.get('legacy-failed').job.status, 'failed');
  await page.locator('[data-app-assistant-input]').fill('后台任务'); await page.locator('[data-app-assistant-send]').click(); await page.locator('#modal-root [data-close]').click(); await new Promise(resolve => setTimeout(resolve, 4500)); await page.evaluate(() => appAssistant.open({projectId:'writing-a'})); await page.waitForFunction(() => !document.querySelector('[data-app-assistant-input]').disabled); assert.match(await page.locator('[data-app-assistant-messages]').innerText(), /主要结论/);
  await page.locator('[data-app-assistant-input]').fill('恢复任务'); await page.locator('[data-app-assistant-send]').click(); await page.waitForFunction(() => JSON.parse(localStorage.getItem('gx-assistant-conversations-v1')).some(session => session.messages.some(message => message.status === 'working' && message.runId))); await page.reload(); await page.waitForFunction(() => window.ready); await page.evaluate(() => appAssistant.open({projectId:'writing-a'})); await page.waitForFunction(() => !document.querySelector('[data-app-assistant-input]').disabled); assert.equal([...runs.values()].at(-1).job.status, 'completed');
  await page.locator('#modal-root [data-close]').click();await page.evaluate(()=>tasks.open({scope:'all'}));await page.locator('[data-task-id="task-run-2"] [data-task-action="assistant"]').click();await page.waitForFunction(()=>!document.querySelector('[data-app-assistant-input]').disabled);assert.equal(await page.locator('[data-app-assistant-project]').inputValue(),'writing-a');const targetBox=await page.locator('[data-assistant-run="run-2"]').boundingBox(),logBox=await page.locator('[data-app-assistant-messages]').boundingBox();assert.ok(targetBox.y+targetBox.height>logBox.y&&targetBox.y<logBox.y+logBox.height,'Task entry locates the requested historical run: '+JSON.stringify({targetBox,logBox}));
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true); await page.screenshot({ path: path.join(evidence, 'assistant-global-mobile.png') }); await page.keyboard.press('Escape'); assert.equal(await page.locator('[role="dialog"]').count(), 0);
  await page.evaluate(() => mountEditor()); await page.locator('[data-studio-assistant]').click(); await page.locator('[data-assistant-input]').waitFor(); assert.equal(await page.locator('.gx-native-studio').evaluate(node => node.inert), true); await page.keyboard.press('Escape'); assert.equal(await page.locator('.gx-assistant-container').isVisible(), false); await page.locator('[data-studio-assistant]').click();
  await page.evaluate(() => editor.selectRange({ range: { start: 2, end: 5 }, clipIds: [] })); await page.locator('[data-assistant-input]').fill('搜索资料并修改文案'); await page.locator('[data-assistant-send]').click(); await page.waitForFunction(() => !document.querySelector('[data-assistant-input]').disabled); assert.deepEqual(requests.at(-1).editScope.placement.start, 2); assert.deepEqual(requests.at(-1).editScope.placement.end, 5); assert.equal(requests.at(-1).projectId, 'video-a'); assert.equal(projects.get('video-a').outputs.article.title, '服务器新文案'); assert.ok(saveRequests.some(value => value.outputs?.article?.title === '服务器新文案'), 'chat persistence merges fresh project content');
  await page.locator('[data-assistant-effect-undo]').click(); await page.waitForFunction(() => !document.querySelector('[data-assistant-input]').disabled); assert.deepEqual(undoCalls.at(-1), { projectId: 'video-a', undoId: 'opaque-undo' }); assert.equal(projects.get('video-a').outputs, undefined);
  await page.locator('[data-assistant-mode]').selectOption('ask'); await page.locator('[data-assistant-input]').fill('慢任务'); await page.locator('[data-assistant-send]').click(); await page.locator('[data-assistant-cancel]').click(); await page.waitForFunction(() => !document.querySelector('[data-assistant-input]').disabled); assert.equal(requests.at(-1).mode, 'ask'); assert.equal([...runs.values()].at(-1).job.status, 'cancelled');
  await page.screenshot({ path: path.join(evidence, 'assistant-editor-mobile.png') }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true); assert.deepEqual(errors, []);
});
