import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { assistantDetails, assistantDownloads, assistantFileSize } from '../public/assistant-client.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), fileId = 'c0be2d93-d9e5-4db4-b0f4-a22ad5fa3d40';
const original = Buffer.concat([Buffer.from('%PDF-1.7\n论文教材原文件\n'), Buffer.from([0, 1, 2, 128, 254, 255]), Buffer.alloc(4096, 73)]);
const file = { id: fileId, name: '量子实验教材.pdf', size: original.length, contentType: 'application/pdf', sha256: createHash('sha256').update(original).digest('hex'), url: 'https://example.com/original.pdf', downloadUrl: `/api/assistant/downloads/${fileId}/file`, canImport: true };
const effect = { type: 'download', label: '已下载原文件', projectId: 'science-a', changed: true, download: file };
test('download cards require an actual file receipt and only link the exact local controlled file route', () => {
  assert.equal(assistantDownloads([{ label: '下载成功', download: file }]).length, 0);
  assert.equal(assistantDownloads([{ ...effect, download: { ...file, sha256: undefined } }]).length, 0);
  for (const downloadUrl of ['https://outside.example/paper.pdf', '//outside.example/paper.pdf', 'file:///C:/private.pdf', 'data:application/pdf;base64,JVBERg==', file.downloadUrl + '?redirect=https://outside.example', file.downloadUrl + '#file', file.downloadUrl.replace(fileId, 'a0be2d93-d9e5-4db4-b0f4-a22ad5fa3d40')]) {
    const markup = assistantDetails({ effects: [{ ...effect, download: { ...file, downloadUrl } }] }); assert.doesNotMatch(markup, /data-assistant-download|已下载|outside\.example|file:\/\//);
  }
  assert.equal(assistantDownloads([effect, effect]).length, 1);
  const markup = assistantDetails({ effects: [{ ...effect, download: { ...file, name: '<img onerror=bad()>.pdf' } }] }); assert.match(markup, /&lt;img/); assert.doesNotMatch(markup, /<img /); assert.match(markup, /保存原文件/); assert.match(markup, /data-assistant-download=/); assert.equal(assistantFileSize(1024), '1.0 KB');
  assert.doesNotMatch(assistantDetails({ sources: [{ id: 'S1', title: '刚读取的论文网页', url: file.url }], steps: [{ type: 'tool', label: '读取网页', status: 'completed' }] }), /保存原文件|data-assistant-download=/);
});

test('Edge saves exact original bytes from download cards after Stop, background reload and task review', { timeout: 90000 }, async t => {
  let chromium; try { ({ chromium } = await import('playwright-core')); } catch { t.skip('Playwright is required.'); return; }
  let browser; try { browser = await chromium.launch({ channel: 'msedge', headless: true }); } catch { t.skip('Installed Edge is required.'); return; }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gx-assistant-download-ui-'));
  const evidence = process.env.GUANGXUAN_DOWNLOAD_UI_EVIDENCE ? path.resolve(process.env.GUANGXUAN_DOWNLOAD_UI_EVIDENCE) : directory; await mkdir(evidence, { recursive: true });
  const jobs = new Map(), downloads = [], gets = []; let counter = 0;
  const json = (res, value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json;charset=utf-8' }); res.end(JSON.stringify(value)); };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1'); const body = req.method === 'POST' ? JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString() || '{}') : null;
      if (url.pathname === file.downloadUrl) { gets.push(url.pathname); res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': original.length, 'content-disposition': `attachment; filename="original.pdf"; filename*=UTF-8''${encodeURIComponent(file.name)}` }); res.end(original); return; }
      if (url.pathname === '/api/assistant/runs' && req.method === 'POST') { const id = 'file-run-' + (++counter); const job = { id, runId: id, projectId: body.projectId || null, status: 'running', instruction: body.instruction, mode: body.mode, steps: [{ id: 'tool1', type: 'tool', tool: 'web_download', status: 'running', label: '下载论文原文件' }], effects: [], sources: [], message: '' }; jobs.set(id, { job, count: 0 }); json(res, { runId: id, job }, 202); return; }
      const run = /^\/api\/assistant\/runs\/([^/]+)(\/cancel)?$/.exec(url.pathname);
      if (run) {
        const state = jobs.get(run[1]);
        if (run[2]) { state.job.status = 'cancelled'; state.job.message = '已停止后续处理，已下载的原文件仍可保存。'; json(res, { job: state.job }); return; }
        if (state.job.status === 'running') { state.count++; state.job.effects = [{ ...effect, projectId: state.job.projectId }]; state.job.steps[0].status = 'completed'; if (!/停止/.test(state.job.instruction) && state.count >= 4) { state.job.status = 'completed'; state.job.message = '原文件已保存在本机资料区。'; } }
        json(res, { job: state.job }); return;
      }
      if (url.pathname === '/api/tasks') { json(res, { items: [...jobs.values()].map(({ job }) => ({ id: 'task-' + job.id, type: 'assistant', sourceJobId: job.id, projectId: job.projectId, title: job.instruction, status: job.status === 'completed' ? 'succeeded' : job.status, progress: job.status === 'running' ? 50 : 100 })) }); return; }
      if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html;charset=utf-8' }); res.end(`<!doctype html><html lang="zh"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/editor-assistant.css"><link rel="stylesheet" href="/app-assistant.css"></head><body><main id="fixture"><button id="open">AI 助手</button><button id="tasks">任务</button><div id="editor-host" style="width:328px;height:740px"></div></main><div id="modal-root"></div><div id="toast-region"></div><script type="module">
import {createAppAssistant} from '/app-assistant.js';import {createTaskCenter} from '/task-center.js';import {createEditorAssistant} from '/editor-assistant.js';
window.changed=[];window.saved=[];window.appAssistant=createAppAssistant({getSettings:()=>({baseUrl:'https://fixture.invalid/v1',model:'fixture',apiKey:'fixture-only'}),requireConnection:()=>true,getProjects:()=>[{id:'science-a',title:'隔离科普项目'}],getProjectId:()=> 'science-a',onChanged:id=>changed.push(id)});const tasks=createTaskCenter();document.querySelector('#open').onclick=()=>appAssistant.open();document.querySelector('#tasks').onclick=()=>tasks.open({scope:'all'});document.addEventListener('gx:assistant-open',event=>appAssistant.open(event.detail));window.mountEditor=effect=>{appAssistant.dispose();window.editor=createEditorAssistant({saveProject:async p=>{saved.push(p);return p}});editor.mount(document.querySelector('#editor-host'),{id:'video-a',title:'隔离视频项目',video:{timeline:[],captions:[],assistantMessages:[{id:'download-reply',role:'assistant',content:'已取得原文件。',status:'complete',effects:[effect]}]}})};window.ready=true;
</script></body></html>`); return; }
      if (/^\/[a-zA-Z0-9_-]+\.(js|css)$/.test(url.pathname)) { res.writeHead(200, { 'content-type': url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript' }); res.end(await readFile(path.join(root, 'public', url.pathname.slice(1)))); return; }
      res.writeHead(404); res.end();
    } catch (error) { if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }); if (!res.writableEnded) res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const url = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); assert.equal(path.dirname(directory), os.tmpdir()); await rm(directory, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce', acceptDownloads: true }), errors = []; page.on('pageerror', error => errors.push(error.message)); page.on('download', download => downloads.push(download.suggestedFilename()));
  const saveOriginal = async target => { const [download] = await Promise.all([page.waitForEvent('download'), target.click()]); assert.equal(download.suggestedFilename(), file.name); const bytes = await readFile(await download.path()); assert.deepEqual(bytes, original); return bytes; };
  await page.goto(url); await page.waitForFunction(() => window.ready); await page.locator('#open').click(); assert.equal(await page.locator('[data-app-assistant-example="下载这篇论文，导入当前科普项目"]').count(), 1);
  await page.locator('[data-app-assistant-input]').fill('下载论文原文件后停止'); await page.locator('[data-app-assistant-send]').click(); await page.locator('[data-assistant-download-save]').waitFor(); assert.deepEqual(downloads, [], 'Receiving a file receipt never starts a browser download automatically'); await page.locator('[data-app-assistant-stop]').click(); await page.waitForFunction(() => !document.querySelector('[data-app-assistant-input]').disabled); assert.equal(jobs.get('file-run-1').job.status, 'cancelled'); await saveOriginal(page.locator('[data-assistant-download-save]')); assert.equal(await page.locator('[data-app-assistant-undo]').count(), 0);
  await page.locator('[data-app-assistant-input]').fill('后台下载论文原文件'); await page.locator('[data-app-assistant-send]').click(); await page.waitForFunction(() => document.querySelectorAll('[data-assistant-download-save]').length === 2); await page.locator('#modal-root [data-close]').click(); await page.reload(); await page.waitForFunction(() => window.ready); await page.locator('#open').click(); await page.waitForFunction(() => !document.querySelector('[data-app-assistant-input]').disabled); assert.equal(jobs.get('file-run-2').job.status, 'completed'); assert.equal(await page.locator('[data-assistant-download-save]').count(), 2); const bytes = await saveOriginal(page.locator('[data-assistant-download-save]').last()); await writeFile(path.join(evidence, 'fixture-original-saved.pdf'), bytes); assert.deepEqual(await page.evaluate(() => changed), [], 'A download receipt does not refresh or modify project content');
  await page.screenshot({ path: path.join(evidence, 'download-global-desktop.png') }); await page.locator('#modal-root [data-close]').click(); await page.locator('#tasks').click(); await page.locator('[data-task-id="task-file-run-1"] [data-task-action="assistant"]').click(); await page.waitForFunction(() => !document.querySelector('[data-app-assistant-input]').disabled); await saveOriginal(page.locator('[data-assistant-run="file-run-1"] [data-assistant-download-save]'));
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true); await page.screenshot({ path: path.join(evidence, 'download-global-mobile.png') }); await page.locator('#modal-root [data-close]').click(); await page.evaluate(value => mountEditor(value), effect); await saveOriginal(page.locator('#editor-host [data-assistant-download-save]')); await page.screenshot({ path: path.join(evidence, 'download-editor-mobile.png') }); assert.deepEqual(errors, []); assert.equal(gets.length, 4); assert.deepEqual(downloads, Array(4).fill(file.name)); await writeFile(path.join(evidence, 'download-ui-verification.json'), JSON.stringify({ filename: file.name, size: original.length, sha256: file.sha256, browserSaves: downloads.length, backgroundReload: true, stopPreservesFile: true, taskReview: true, projectWrites: 0 }, null, 2));
});
