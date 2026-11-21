import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { findAnimationBrowser } from '../animation/render.mjs';
import { runAi } from '../lib/ai.mjs';

const root = path.resolve(import.meta.dirname, '..');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const sourceProject = { id: 'rm-free-one', title: '已编译动画', revision: 1, entryPoint: 'src/index.jsx', compositionId: 'Free', inputProps: {}, assets: [], files: [{ path: 'src/index.jsx', content: "import {registerRoot} from 'remotion';registerRoot(()=>null);" }] };

async function fixture(t, type) {
  const temp = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(temp, { recursive: true });
  const folder = await mkdtemp(path.join(temp, 'gx-free-direct-ui-')), projectId = 'free-direct-' + type;
  const project = { id: projectId, kind: 'video', title: '自由放置隔离工程', video: { script: '', editScope: { assetIds: ['a'], placement: { mode: 'free' } } }, history: [], runs: [] };
  const control = { revision: 'native-1', editable: false, placement: { mode: 'insert', at: 2 }, modelReplies: [], aiCalls: [], applyCalls: [], appendCalls: [], jobs: new Map(), renderCalls: 0, nextJob: 0, bumpNativeOnPlacement: false, settingsMissing: false };
  const native = () => ({ projectId, revision: control.revision, duration: 8, aspect: '16:9', mainTrackEditable: control.editable, assets: [{ id: 'a', name: '选中素材.mp4', type: 'video', duration: 8 }, { id: 'b', name: '其它素材.mp4', type: 'video', duration: 8 }], timeline: [{ id: 'clip-a', assetId: 'a', start: 0, end: 8, at: 0, speed: 1 }] });
  const base = '/api/projects/' + projectId + '/remotion';
  const json = (res, value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  const readBody = async req => JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString() || '{}');
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/provider/v1/chat/completions') {
        const body = await readBody(req), last = control.aiCalls.at(-1), data = last.task === 'edit-plan' ? { title: '自由粗剪', summary: '根据节奏安排新序列。', timeline: [{ assetId: 'a', start: 0, end: 3, reason: '使用所选素材' }], captions: [], placement: structuredClone(control.placement) } : { placement: structuredClone(control.placement) };
        control.modelReplies.push(body);
        if (last.task === 'edit-placement' && control.bumpNativeOnPlacement) { control.bumpNativeOnPlacement = false; control.revision = 'native-after-manual'; }
        json(res, { choices: [{ message: { content: JSON.stringify(data) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }); return;
      }
      if (url.pathname === '/api/ai') { const body = await readBody(req); control.aiCalls.push(structuredClone(body)); const result = await runAi(body.task, body.payload, body.settings); json(res, result); return; }
      if (url.pathname === '/api/openfilm/context') { json(res, native()); return; }
      if (url.pathname === '/api/openfilm/apply-plan') { const body = await readBody(req); control.applyCalls.push(body); json(res, { applied: true, revision: control.revision, duration: 11, placement: body.plan.placement }); return; }
      if (url.pathname === base) { json(res, { items: [{ id: sourceProject.id, title: sourceProject.title, revision: sourceProject.revision }] }); return; }
      if (url.pathname === base + '/' + sourceProject.id) { json(res, { project: sourceProject }); return; }
      if (url.pathname === base + '/' + sourceProject.id + '/inspect') { json(res, { compositions: [{ id: 'Free', width: 320, height: 180, fps: 15, durationInFrames: 60 }] }); return; }
      if (url.pathname.endsWith('/preview') || url.pathname.endsWith('/render')) {
        const body = await readBody(req), preview = url.pathname.endsWith('/preview'), id = 'job-' + (++control.nextJob);
        if (!preview) control.renderCalls++;
        control.jobs.set(id, { id, status: 'complete', kind: preview ? 'preview' : 'render', progress: 1, remotionId: sourceProject.id, revision: 1, result: preview ? { frames: body.frames.map((frame, index) => ({ file: 'frame-' + index + '.png', frame })) } : { duration: 4, fps: 15, width: 320, height: 180 } }); json(res, { jobId: id }, 202); return;
      }
      const job = new RegExp('^' + base + '/jobs/([^/]+)(?:/files/([^/]+))?$').exec(url.pathname);
      if (job) { if (job[2]) { res.writeHead(200, { 'content-type': 'image/png' }); res.end(png); } else json(res, { job: control.jobs.get(job[1]) }); return; }
      if (url.pathname.endsWith('/append')) {
        const body = await readBody(req); control.appendCalls.push(body);
        if (body.expectedNativeRevision !== control.revision) { json(res, { error: '工程版本已变化，成片保留。', code: 'OPENFILM_REVISION_CONFLICT' }, 409); return; }
        json(res, { appended: true, revision: control.revision, placement: body.placement || body.editScope.placement }); return;
      }
      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html;charset=utf-8' });
        res.end(`<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body><main id="fixture"><button id="open">打开</button><div id="workspace"></div></main><div id="modal-root"></div><div id="toast-region"></div><script type="module">
import {api} from '/ui.js';import {createOpenfilmActions} from '/openfilm-actions.js';import {mountRemotionWorkspace} from '/remotion-workspace.js';window.project=${JSON.stringify(project)};window.settings={baseUrl:location.origin+'/provider/v1',model:'controlled-local-provider',apiKey:'fixture-not-a-user-key'};window.saves=[];
const options={project,getSettings:()=>window.settings,requireConnection:()=>Boolean(settings.baseUrl&&settings.model&&settings.apiKey),saveProject:async p=>{saves.push(structuredClone(p));return p;}};
if('${type}'==='rough'){window.actions=createOpenfilmActions({...options,callAi:(task,payload)=>api('/api/ai',{task,payload,settings:window.settings})});document.getElementById('open').onclick=()=>actions.showRoughCut(project);}else{document.getElementById('open').hidden=true;window.workspace=mountRemotionWorkspace(document.getElementById('workspace'),options);}window.ready=true;
</script></body></html>`); return;
      }
      if (/^\/[A-Za-z0-9_-]+\.(?:js|css)$/.test(url.pathname)) { res.writeHead(200, { 'content-type': url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript' }); res.end(await readFile(path.join(root, 'public', url.pathname.slice(1)))); return; }
      json(res, { error: '未找到夹具路由' }, 404);
    } catch (error) { json(res, { error: error.message, code: error.code }, error.status || 500); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = 'http://127.0.0.1:' + server.address().port;
  assert.ok(!['4317', '4417'].includes(new URL(origin).port));
  const browser = await chromium.launch({ executablePath: await findAnimationBrowser(), headless: true });
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); assert.equal(path.dirname(folder), temp); await rm(folder, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1240, height: 1000 }, reducedMotion: 'reduce' }), errors = [], external = [];
  page.on('pageerror', error => errors.push(error.message)); await page.route('**/*', route => { const url = new URL(route.request().url()); if (url.origin === origin) return route.continue(); external.push(url.href); return route.abort(); });
  await page.goto(origin); await page.waitForFunction(() => window.ready);
  return { page, control, errors, external, projectId, folder };
}

test('rough cut uses AI-selected concrete placement while preserving free preference and complex-track safeguards', { timeout: 45000 }, async t => {
  const { page, control, errors, external } = await fixture(t, 'rough'); await page.locator('#open').click(); await page.locator('[data-generate-cut]:not([disabled])').waitFor();
  await page.locator('[data-cut-instruction]').fill('用所选素材自由编排，位置由你决定。'); await page.locator('[data-generate-cut]').click(); await page.locator('[data-apply-cut]:not([disabled])').waitFor();
  assert.equal(control.aiCalls.length, 1); assert.equal(control.aiCalls[0].task, 'edit-plan'); assert.deepEqual(control.aiCalls[0].payload.editScope, { placement: { mode: 'free' }, assetIds: ['a'] });
  assert.deepEqual(control.aiCalls[0].payload.timeline[0], { id: 'clip-a', assetId: 'a', start: 0, end: 8, at: 0, speed: 1 });
  assert.equal(control.aiCalls[0].payload.timelineDuration, 8);
  assert.match(await page.locator('[data-cut-result]').innerText(), /00:02\.0 处插入/);
  await page.locator('[data-apply-cut]').click(); await page.waitForFunction(() => !document.querySelector('[data-cut-result]'));
  assert.deepEqual(control.applyCalls[0].editScope, { placement: { mode: 'free' }, assetIds: ['a'] }); assert.deepEqual(control.applyCalls[0].plan.placement, { mode: 'insert', at: 2 });
  assert.equal(await page.evaluate(() => project.video.editScope.placement.mode), 'free');
  control.placement = { mode: 'replace' }; await page.locator('#open').click(); await page.locator('[data-generate-cut]:not([disabled])').waitFor(); await page.locator('.gx-edit-scope summary').click(); await page.locator('[data-scope-all]').check(); await page.locator('[data-cut-instruction]').fill('使用全部素材重新剪辑整个主轨。'); await page.locator('[data-generate-cut]').click(); await page.waitForFunction(() => document.querySelector('[data-cut-result]')?.textContent.includes('替换当前主轨') && !document.querySelector('[data-generate-cut]').disabled);
  assert.equal(await page.locator('[data-apply-cut]').isEnabled(), false, 'Free mode must not authorize rebuilding an unsupported complex main track');
  assert.equal(control.applyCalls.length, 1); assert.deepEqual(errors, []); assert.deepEqual(external, []);
  const evidence = process.env.GUANGXUAN_FREE_PLACEMENT_UI_EVIDENCE && path.resolve(process.env.GUANGXUAN_FREE_PLACEMENT_UI_EVIDENCE);
  if (evidence) { await mkdir(evidence, { recursive: true }); await writeFile(path.join(evidence, 'free-placement-roughcut-ui.json'), JSON.stringify({ status: 'passed', realEdge: true, actualRunAi: true, controlledHttpProvider: true, concretePlacementApplied: true, complexReplaceNotApplied: true, timelineLocationGivenToModel: true, freePreferencePreserved: true, originalScopePassedWithPlanPlacement: true, externalRequests: external, pageErrors: errors }, null, 2)); }
});

test('direct Remotion free placement keeps rendered work on missing model or CAS conflict and retries without rerendering', { timeout: 45000 }, async t => {
  const { page, control, errors, external } = await fixture(t, 'remotion'); await page.locator('[data-rm-render]:not([disabled])').waitFor();
  await page.locator('[data-rm-instruction]').fill('四秒动画，按工程的节奏自由安排位置。'); await page.evaluate(() => { window.settings = {}; });
  await page.locator('[data-rm-render]').click(); await page.locator('[data-rm-append]:not([hidden])').waitFor();
  assert.match(await page.locator('[data-rm-error]').innerText(), /模型连接/); assert.equal(control.renderCalls, 1); assert.equal(control.aiCalls.length, 0); assert.equal(control.appendCalls.length, 0);
  await page.evaluate(() => { window.settings = { baseUrl: location.origin + '/provider/v1', model: 'controlled-local-provider', apiKey: 'fixture-not-a-user-key' }; });
  control.placement = { mode: 'insert', at: 5 }; await page.locator('[data-rm-append]').click(); await page.waitForFunction(() => document.querySelector('[data-rm-status]')?.textContent === '成片已加入时间线。');
  assert.equal(control.renderCalls, 1); assert.equal(control.aiCalls.length, 1); assert.equal(control.aiCalls[0].task, 'edit-placement'); assert.equal(control.aiCalls[0].payload.contentDuration, 4);
  assert.deepEqual(control.appendCalls[0].editScope, { placement: { mode: 'free' }, assetIds: ['a'] }); assert.deepEqual(control.appendCalls[0].placement, { mode: 'insert', at: 5 }); assert.equal(control.appendCalls[0].expectedNativeRevision, 'native-1');
  assert.equal(await page.evaluate(() => project.video.editScope.placement.mode), 'free');
  control.bumpNativeOnPlacement = true; await page.locator('[data-rm-render]').click(); await page.locator('[data-rm-append]:not([hidden])').waitFor();
  assert.match(await page.locator('[data-rm-error]').innerText(), /版本/); assert.equal(control.renderCalls, 2); assert.equal(control.appendCalls.at(-1).expectedNativeRevision, 'native-1');
  await page.locator('[data-rm-append]').click(); await page.waitForFunction(() => document.querySelector('[data-rm-status]')?.textContent === '成片已加入时间线。');
  assert.equal(control.renderCalls, 2); assert.equal(control.appendCalls.at(-1).expectedNativeRevision, 'native-after-manual'); assert.deepEqual(control.appendCalls.at(-1).placement, { mode: 'insert', at: 5 });
  const callsBeforeExplicit = control.aiCalls.length; await page.evaluate(() => { project.video.editScope.placement = { mode: 'append' }; window.settings = {}; });
  await page.locator('[data-rm-render]').click(); await page.waitForFunction(() => document.querySelector('[data-rm-status]')?.textContent === '成片已渲染并加入时间线。');
  assert.equal(control.aiCalls.length, callsBeforeExplicit, 'Explicit placement must not introduce another model request'); assert.equal(Object.hasOwn(control.appendCalls.at(-1), 'placement'), false); assert.deepEqual(control.appendCalls.at(-1).editScope.placement, { mode: 'append' });
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  const evidence = process.env.GUANGXUAN_FREE_PLACEMENT_UI_EVIDENCE && path.resolve(process.env.GUANGXUAN_FREE_PLACEMENT_UI_EVIDENCE);
  if (evidence) { await mkdir(evidence, { recursive: true }); await writeFile(path.join(evidence, 'free-placement-direct-ui.json'), JSON.stringify({ status: 'passed', realEdge: true, actualRunAi: true, controlledHttpProvider: true, realModelUsed: false, freePreferencePreserved: true, missingConnectionRetainsRenderedJob: true, casConflictRetainsRenderedJob: true, retryUsesFreshNativeRevision: true, retryDoesNotRerender: true, explicitPlacementAvoidsExtraAi: true, externalRequests: external, pageErrors: errors }, null, 2)); }
});
