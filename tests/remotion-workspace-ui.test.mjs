import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRemotionApi } from '../public/remotion-workspace.js';
import { findAnimationBrowser } from '../animation/render.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const sourceProject = (id = 'rm-one', revision = 1) => ({ id, title: '自由运动工程', revision, entryPoint: 'src/index.jsx', compositionId: 'Orbit', inputProps: { title: '可调整内容' }, assets: [], files: [
  { path: 'src/index.jsx', content: "import {registerRoot} from 'remotion';\nimport {Root} from './Root.jsx';\nregisterRoot(Root);" },
  { path: 'src/Root.jsx', content: "import React from 'react';\nexport const Root=()=> <div>自由运动画面</div>;" },
] });

test('Remotion workspace adapter preserves project scope and revision parameters', async () => {
  const calls = [], service = createRemotionApi('project/a', async (...args) => { calls.push(args); return {}; });
  await service.save('source/one', { expectedRevision: 4, files: [{ path: 'src/Root.jsx', content: 'changed' }] });
  await service.preview('source/one', { expectedRevision: 4, compositionId: 'Main', frames: [4, 20] });
  await service.cancel('job/one');
  await service.review('source/one', { expectedRevision: 4, compositionId: 'Main', inputProps: {}, settings: { model: 'fixture' }, instruction: '检查实际画面' });
  assert.equal(calls[0][0], '/api/projects/project%2Fa/remotion/source%2Fone'); assert.equal(calls[0][2].method, 'PUT'); assert.equal(calls[0][1].expectedRevision, 4);
  assert.ok(calls[1][0].endsWith('/preview')); assert.deepEqual(calls[1][1].frames, [4, 20]); assert.ok(calls[2][0].endsWith('/jobs/job%2Fone/cancel'));
  assert.ok(calls[3][0].endsWith('/source%2Fone/review')); assert.equal(calls[3][1].expectedRevision, 4);
});

async function fixture(t, key) {
  let chromium, executable;
  try { executable = await findAnimationBrowser(); ({ chromium } = await import('playwright-core')); } catch { t.skip('An installed Edge/Chrome is required.'); return; }
  const temp = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await fs.mkdir(temp, { recursive: true });
  const directory = await fs.mkdtemp(path.join(temp, 'gx-free-remotion-ui-'));
  const control = { items: [], calls: [], jobs: new Map(), nextJob: 0, generateDelay: 0, generationStarted: false, inspectError: '', saveConflict: false, runningPreview: false, cancelled: [], nativeRevision: 'native-before', appendCalls: [], bumpNativeDuringRender: false, reviewDelay: 0, reviewError: '', reviewResponse: { status: 'reviewed', verdict: 'revise', summary: '采样画面中标题与主体重叠。', issues: [{ severity: 'blocking', frame: 60, category: '构图', detail: '标题遮挡运动中的主体。', fix: '将标题移到左上安全区，给主体留出完整运动空间。' }], previewJobId: 'review-preview-job', frames: [{ file: 'review-0.png', frame: 12 }, { file: 'review-1.png', frame: 60 }, { file: 'review-2.png', frame: 120 }] } };
  const appId = `creative-ui-${key}`, base = `/api/projects/${appId}/remotion`;
  const json = (res, value, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  const readBody = async req => JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString() || '{}');
  const allowed = new Set(['openfilm-actions.js', 'remotion-workspace.js', 'remotion-workspace.css', 'ui.js', 'editor-scope.js', 'time-range.js', 'styles.css']);
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html;charset=utf-8' }); res.end(`<!doctype html><html lang="zh"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body><main id="app"><button id="open">打开动画</button></main><div id="modal-root"></div><div id="toast-region"></div><script type="module">import {createOpenfilmActions} from '/openfilm-actions.js';window.project={id:'${appId}',title:'隔离自由创作',video:{script:'',openfilmAnimationPlan:{title:'旧方案保留',scenes:[{type:'title',title:'旧方案',duration:3}]}},history:[],runs:[]};window.actions=createOpenfilmActions({getSettings:()=>({baseUrl:'http://127.0.0.1:1/v1',model:'fixture',apiKey:'fixture-no-network'}),requireConnection:()=>true,saveProject:async p=>p});document.querySelector('#open').onclick=()=>actions.showAnimation(project);</script></body></html>`); return; }
      if (allowed.has(url.pathname.slice(1))) { res.writeHead(200, { 'content-type': url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript' }); res.end(await fs.readFile(path.join(root, 'public', url.pathname.slice(1)))); return; }
      if (url.pathname === '/api/openfilm/context') { json(res, { revision: control.nativeRevision, duration: 10, aspect: '16:9', assets: [], timeline: [], mainTrackEditable: true }); return; }
      if (!url.pathname.startsWith(base)) { json(res, { error: 'missing fixture route' }, 404); return; }
      const suffix = url.pathname.slice(base.length), body = req.method === 'GET' ? undefined : await readBody(req);
      control.calls.push({ method: req.method, suffix, body });
      if (!suffix && req.method === 'GET') { json(res, { items: control.items.map(({ id, title, revision }) => ({ id, title, revision })) }); return; }
      if (!suffix && req.method === 'POST') { const value = { ...sourceProject(`rm-copy-${control.items.length + 1}`), ...body, revision: 1 }; control.items.push(value); json(res, { project: value }); return; }
      if (suffix === '/generate') { control.generationStarted = true; if (control.generateDelay) await pause(control.generateDelay); let value = control.items.find(item => item.id === body.remotionId); if (value) { value = { ...value, revision: value.revision + 1, files: value.files.map(file => ({ ...file, content: file.content + '\n// generated update' })) }; control.items[control.items.findIndex(item => item.id === value.id)] = value; } else { value = sourceProject(); control.items.push(value); } if (body.autoImprove && control.autoReply) { const extra = structuredClone(control.autoReply); if (extra.review?.previewJobId) control.jobs.set(extra.review.previewJobId, { id: extra.review.previewJobId, status: 'complete', kind: 'preview', result: { frames: extra.review.frames } }); json(res, { project: value, ...extra }); } else json(res, { project: value }); return; }
      const jobMatch = /^\/jobs\/([^/]+)(?:\/(cancel|files)\/?([^/]+)?)?$/.exec(suffix);
      if (jobMatch) {
        const job = control.jobs.get(jobMatch[1]);
        if (!job) { json(res, { error: 'job missing' }, 404); return; }
        if (jobMatch[2] === 'cancel') { job.status = 'cancelled'; control.cancelled.push(jobMatch[1]); json(res, { job }); return; }
        if (jobMatch[2] === 'files') { res.writeHead(200, { 'content-type': jobMatch[3].endsWith('.png') ? 'image/png' : 'video/mp4' }); res.end(jobMatch[3].endsWith('.png') ? png : Buffer.alloc(0)); return; }
        json(res, { job }); return;
      }
      const match = /^\/([^/]+)(?:\/(inspect|preview|review|render|append))?$/.exec(suffix), value = control.items.find(item => item.id === match?.[1]);
      if (!value) { json(res, { error: 'project missing' }, 404); return; }
      if (!match[2] && req.method === 'GET') { json(res, { project: value }); return; }
      if (!match[2] && req.method === 'PUT') {
        if (control.saveConflict) { json(res, { error: '工程版本冲突，当前输入已保留。', code: 'REMOTION_REVISION_CONFLICT' }, 409); return; }
        const files = new Map(value.files.map(file => [file.path, file.content])); for (const file of body.files) files.set(file.path, file.content);
        Object.assign(value, body, { files: [...files].map(([path, content]) => ({ path, content })), revision: value.revision + 1 }); delete value.expectedRevision; json(res, { project: value }); return;
      }
      if (match[2] === 'inspect') { if (control.inspectError) { json(res, { error: control.inspectError }, 422); return; } json(res, { compositions: [{ id: 'Orbit', width: 900, height: 900, fps: 24, durationInFrames: 144 }, { id: 'Portrait', width: 720, height: 1280, fps: 30, durationInFrames: 120 }] }); return; }
      if (match[2] === 'review') { if (control.reviewDelay) await pause(control.reviewDelay); if (control.reviewError) { json(res, { error: control.reviewError }, 422); return; } const review = structuredClone(control.reviewResponse); control.jobs.set(review.previewJobId, { id: review.previewJobId, status: 'complete', kind: 'preview', result: { frames: review.frames } }); json(res, { review }); return; }
      if (['preview', 'render'].includes(match[2])) {
        const id = `rm-job-${++control.nextJob}`, preview = match[2] === 'preview';
        const job = { id, status: preview && control.runningPreview ? 'running' : 'complete', type: match[2], progress: 1, remotionId: value.id, revision: value.revision, result: preview ? { frames: body.frames.map((frame, index) => ({ file: `frame-${index}.png`, frame })) } : { duration: body.range ? body.range[1] - body.range[0] : 6, width: 900, height: 900, fps: 24 } };
        if (!preview && control.bumpNativeDuringRender) control.nativeRevision = 'native-after-manual-edit';
        control.jobs.set(id, job); json(res, { jobId: id }, 202); return;
      }
      if (match[2] === 'append') { control.appendCalls.push(body); if (body.expectedNativeRevision !== control.nativeRevision) { json(res, { error: '原生工程在渲染期间已修改，未加入旧结果。' }, 409); return; } json(res, { appended: true }); return; }
      json(res, { error: 'missing fixture action' }, 404);
    } catch (error) { if (!res.headersSent) json(res, { error: error.message }, 500); else res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: executable, headless: true });
  t.after(async () => { await browser.close(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); assert.equal(path.dirname(directory), temp); assert.ok(path.basename(directory).startsWith('gx-free-remotion-ui-')); if (process.env.GUANGXUAN_KEEP_FREE_REMOTION_UI !== '1') await fs.rm(directory, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } }), errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`); await page.locator('#open').click();
  if (!await page.locator('[data-rm-generate]').count()) throw new Error(JSON.stringify({ errors, body: await page.locator('body').innerText() }));
  await page.waitForFunction(() => !document.querySelector('[data-rm-generate]').disabled);
  return { page, control, errors, directory, async generate() { await page.locator('[data-rm-instruction]').fill('三个圆球自由绕行，使用镜头跟随与轨迹，不用固定模板。'); await page.locator('[data-rm-generate]').click(); await page.waitForFunction(() => document.querySelector('[data-rm-metadata]').textContent.includes('24 fps') && !document.querySelector('[data-rm-generate]').disabled); }, async codeFile() { await page.locator('.rm-source>summary').click(); await page.locator('[data-rm-file]').selectOption('src/Root.jsx'); } };
}

test('free animation entry edits multiple files and real composition metadata, previews, samples and appends with captured revision', { timeout: 90000 }, async t => {
  const f = await fixture(t, 'flow'); if (!f) return; const { page, control } = f;
  assert.equal(await page.locator('[data-animation-theme]').count(), 0); assert.equal(await page.locator('[data-scene]').count(), 0); assert.ok((await page.locator('.modal').innerText()).includes('查看旧版方案'));
  await f.generate(); await f.codeFile();
  assert.equal(await page.locator('[data-rm-file] option').count(), 2); assert.equal(await page.locator('[data-rm-composition] option').count(), 2); assert.match(await page.locator('[data-rm-metadata]').innerText(), /900 × 900.*24 fps.*6\.00 秒/);
  const edited = (await page.locator('[data-rm-code]').inputValue()) + '\n// user edit'; await page.locator('[data-rm-code]').fill(edited); await page.locator('[data-rm-props]').fill('{"title":"手动参数"}'); await page.locator('[data-rm-save]').click(); await page.waitForFunction(() => !document.querySelector('[data-rm-save]').disabled && document.querySelector('[data-rm-dirty]').textContent === '已保存');
  const put = control.calls.findLast(call => call.method === 'PUT'); assert.equal(put.body.expectedRevision, 1); assert.deepEqual(put.body.files, [{ path: 'src/Root.jsx', content: edited }]); assert.deepEqual(put.body.inputProps, { title: '手动参数' });
  await page.locator('[data-rm-preview]').click(); await page.locator('.rm-frames figure').first().waitFor(); assert.equal(await page.locator('.rm-frames figure').count(), 3);
  await page.locator('[data-rm-code]').fill(edited + '\n// changed after preview'); assert.equal(await page.locator('.rm-frames figure').count(), 0);
  await page.locator('[data-rm-save]').click(); await page.waitForFunction(() => !document.querySelector('[data-rm-save]').disabled);
  await page.locator('[data-rm-sample]').click(); await page.waitForFunction(() => !document.querySelector('[data-rm-video]').hidden && !document.querySelector('[data-rm-generate]').disabled); const sample = control.calls.findLast(call => call.suffix.endsWith('/render')); assert.deepEqual(sample.body.range, [0, 3]);
  await page.locator('[data-rm-render]').click(); await page.waitForFunction(() => document.querySelector('[data-rm-status]').textContent.includes('并加入时间线'));
  assert.equal(control.appendCalls.length, 1); assert.equal(control.appendCalls[0].expectedNativeRevision, 'native-before'); assert.equal(control.appendCalls[0].editScope.placement.mode, 'append');
  assert.ok(control.calls.filter(call => call.suffix.endsWith('/preview')).length >= 2, 'The full render gets a current preview first');
  await page.locator('[data-rm-composition]').selectOption('Portrait'); assert.match(await page.locator('[data-rm-metadata]').innerText(), /720 × 1280.*30 fps.*4\.00 秒/);
  await page.screenshot({ path: path.join(f.directory, 'free-remotion-desktop.png'), fullPage: true }); await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true); await page.screenshot({ path: path.join(f.directory, 'free-remotion-mobile.png'), fullPage: true });
  assert.deepEqual(f.errors, []);
  if (process.env.GUANGXUAN_FREE_REMOTION_UI_EVIDENCE) { const target = path.resolve(process.env.GUANGXUAN_FREE_REMOTION_UI_EVIDENCE); await fs.mkdir(target, { recursive: true }); for (const file of ['free-remotion-desktop.png', 'free-remotion-mobile.png']) await fs.copyFile(path.join(f.directory, file), path.join(target, file)); await fs.writeFile(path.join(target, 'verification.json'), JSON.stringify({ status: 'passed', actualProductionEntry: true, actualBrowser: true, controlledGenerateCompilePreviewRenderFixture: true, multiFileChangedOnlySave: true, actualCompositionMetadataShown: true, previewInvalidated: true, renderFirstPreviews: true, appendCapturedNativeRevision: true, pageErrors: f.errors }, null, 2)); }
});

test('compile errors, revision conflicts and render-time native changes preserve source without importing stale output', { timeout: 90000 }, async t => {
  const f = await fixture(t, 'errors'); if (!f) return; const { page, control } = f; await f.generate(); await f.codeFile();
  const source = (await page.locator('[data-rm-code]').inputValue()) + '\nsyntax that needs fixing'; await page.locator('[data-rm-code]').fill(source); control.inspectError = 'src/Root.jsx:4 SyntaxError: unexpected token'; await page.locator('[data-rm-save]').click(); await page.locator('[data-rm-error]:not(.hidden)').waitFor(); assert.match(await page.locator('[data-rm-error]').innerText(), /SyntaxError/); assert.equal(await page.locator('[data-rm-code]').inputValue(), source);
  control.inspectError = ''; await page.locator('[data-rm-inspect]').click(); await page.waitForFunction(() => !document.querySelector('[data-rm-generate]').disabled && document.querySelector('[data-rm-metadata]').textContent.includes('24 fps'));
  await page.locator('[data-rm-code]').fill(source + '\n// newer manual edit'); control.saveConflict = true; await page.locator('[data-rm-save]').click(); await page.locator('[data-rm-save-copy]').waitFor(); assert.match(await page.locator('[data-rm-error]').innerText(), /版本冲突/); assert.ok((await page.locator('[data-rm-code]').inputValue()).endsWith('// newer manual edit'));
  control.saveConflict = false; await page.locator('[data-rm-save-copy]').click(); await page.waitForFunction(() => !document.querySelector('[data-rm-generate]').disabled && document.querySelector('[data-rm-file]').value);
  control.bumpNativeDuringRender = true; await page.locator('[data-rm-render]').click(); await page.locator('[data-rm-error]:not(.hidden)').waitFor(); assert.match(await page.locator('[data-rm-error]').innerText(), /渲染期间已修改/); assert.equal(control.appendCalls.at(-1).expectedNativeRevision, 'native-before'); assert.notEqual(control.appendCalls.at(-1).expectedNativeRevision, control.nativeRevision); assert.ok((await page.locator('[data-rm-code]').inputValue()).endsWith('// newer manual edit'));
  await page.locator('[data-rm-append]').click(); await page.waitForFunction(() => document.querySelector('[data-rm-status]').textContent.includes('成片已加入时间线'));
  assert.equal(control.appendCalls.at(-1).expectedNativeRevision, 'native-after-manual-edit', 'An explicit later append captures the current native revision instead of silently reusing the failed one');
  assert.deepEqual(f.errors, []);
});

test('cancelled preview and late generated code cannot replace current manual source', { timeout: 90000 }, async t => {
  const f = await fixture(t, 'cancel'); if (!f) return; const { page, control } = f; await f.generate(); await f.codeFile();
  control.runningPreview = true; await page.locator('[data-rm-preview]').click(); await page.waitForFunction(() => !document.querySelector('[data-rm-cancel]').hidden); await page.locator('[data-rm-cancel]').click(); await page.waitForFunction(() => !document.querySelector('[data-rm-generate]').disabled); assert.equal(control.cancelled.length, 1); assert.equal(await page.locator('[data-rm-code]').inputValue(), sourceProject().files[1].content);
  control.generateDelay = 350; await page.locator('[data-rm-generate]').click(); await page.waitForFunction(() => document.querySelector('[data-rm-code]').readOnly);
  const manual = (await page.locator('[data-rm-code]').inputValue()) + '\n// manual input arriving during generation';
  await page.locator('[data-rm-code]').evaluate((node, value) => { node.value = value; node.dispatchEvent(new Event('input', { bubbles: true })); }, manual);
  await page.locator('[data-rm-error]:not(.hidden)').waitFor(); assert.match(await page.locator('[data-rm-error]').innerText(), /生成期间又有手工修改/); assert.equal(await page.locator('[data-rm-code]').inputValue(), manual); assert.equal(await page.locator('[data-rm-save-copy]').isVisible(), true);
  assert.deepEqual(f.errors, []);
});

test('visual review shows sampled evidence and applies concrete feedback only after an explicit click', { timeout: 90000 }, async t => {
  const f = await fixture(t, 'review-feedback'); if (!f) return; const { page, control } = f;
  assert.equal(await page.locator('[data-rm-review]').isDisabled(), true); await f.generate();
  const original = await page.locator('[data-rm-instruction]').inputValue(), before = control.calls.filter(call => call.suffix === '/generate').length;
  await page.locator('[data-rm-review]').click(); await page.locator('[data-rm-review-result]:not([hidden])').waitFor(); await page.waitForFunction(() => !document.querySelector('[data-rm-generate]').disabled);
  assert.match(await page.locator('[data-rm-review-heading]').innerText(), /有待调整/); assert.match(await page.locator('[data-rm-review-scope]').innerText(), /3 张采样画面/);
  assert.equal(await page.locator('.rm-review-frames figure').count(), 3); assert.equal(await page.locator('.rm-review-issue').count(), 1); assert.match(await page.locator('.rm-review-issue').innerText(), /需要修正.*第 60 帧/s); assert.match(await page.locator('.rm-review-issue').innerText(), /左上安全区/);
  assert.equal(control.calls.filter(call => call.suffix === '/generate').length, before, 'Review itself never rewrites source');
  const reviewCall = control.calls.findLast(call => call.suffix.endsWith('/review')); assert.equal(reviewCall.body.expectedRevision, 1); assert.equal(reviewCall.body.compositionId, 'Orbit'); assert.equal(reviewCall.body.instruction, original);
  await page.locator('[data-rm-review-result]').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(f.directory, 'visual-review-desktop.png'), fullPage: true }); await page.setViewportSize({ width: 390, height: 844 }); await page.locator('[data-rm-review-heading]').scrollIntoViewIfNeeded(); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true); await page.screenshot({ path: path.join(f.directory, 'visual-review-mobile.png'), fullPage: true });
  await page.locator('[data-rm-improve]').click(); await page.waitForFunction(() => !document.querySelector('[data-rm-generate]').disabled && document.querySelector('[data-rm-status]').textContent.includes('重新复核'));
  const improved = control.calls.findLast(call => call.suffix === '/generate'); assert.equal(improved.body.expectedRevision, 1); assert.equal(improved.body.remotionId, 'rm-one'); assert.ok(improved.body.instruction.includes(original)); assert.match(improved.body.diagnostics, /将标题移到左上安全区/); assert.equal(await page.locator('[data-rm-instruction]').inputValue(), original); assert.equal(await page.locator('[data-rm-review-result]').isHidden(), true);
  assert.deepEqual(f.errors, []);
  if (process.env.GUANGXUAN_REMOTION_REVIEW_UI_EVIDENCE) { const target = path.resolve(process.env.GUANGXUAN_REMOTION_REVIEW_UI_EVIDENCE); await fs.mkdir(target, { recursive: true }); for (const file of ['visual-review-desktop.png', 'visual-review-mobile.png']) await fs.copyFile(path.join(f.directory, file), path.join(target, file)); await fs.writeFile(path.join(target, 'review-ui-verification.json'), JSON.stringify({ status: 'passed', actualProductionDialog: true, actualBrowser: true, controlledReviewFixture: true, sampledFramesShown: 3, concreteFixOnlyAfterClick: true, originalInstructionPreserved: true, sourceRevisionBound: true, actualVisionModelUsed: false, pageErrors: f.errors }, null, 2)); }
});

test('unavailable review, absent frame evidence and review errors never display a pass', { timeout: 90000 }, async t => {
  const f = await fixture(t, 'review-unavailable'); if (!f) return; const { page, control } = f; await f.generate();
  const before = await page.locator('[data-rm-code]').inputValue();
  control.reviewResponse = { ...control.reviewResponse, status: 'unavailable', verdict: 'unknown', summary: '当前模型不支持图像输入，未完成画面复核。', issues: [] };
  await page.locator('[data-rm-review]').click(); await page.locator('[data-rm-review-result]:not([hidden])').waitFor(); await page.waitForFunction(() => !document.querySelector('[data-rm-generate]').disabled);
  assert.match(await page.locator('[data-rm-review-heading]').innerText(), /未完成/); assert.match(await page.locator('[data-rm-review-summary]').innerText(), /不支持图像/); assert.equal(await page.locator('[data-rm-improve]').isHidden(), true); assert.ok(!(await page.locator('[data-rm-review-heading]').innerText()).includes('通过'));
  control.reviewResponse = { ...control.reviewResponse, status: 'reviewed', verdict: 'pass', frames: [], summary: '缺少实际帧的错误响应' };
  await page.locator('[data-rm-review]').click(); await page.waitForFunction(() => !document.querySelector('[data-rm-generate]').disabled && document.querySelector('[data-rm-review-summary]').textContent.includes('错误响应'));
  assert.match(await page.locator('[data-rm-review-heading]').innerText(), /未完成/); assert.equal(await page.locator('[data-rm-improve]').isHidden(), true);
  control.reviewResponse = { ...control.reviewResponse, summary: '采样画面清楚', frames: [{ file: 'review-pass.png', frame: 60 }] };
  await page.locator('[data-rm-review]').click(); await page.waitForFunction(() => !document.querySelector('[data-rm-generate]').disabled && document.querySelector('[data-rm-review-heading]').textContent.includes('采样检查通过'));
  assert.equal(await page.locator('[data-rm-review-result]').getAttribute('data-review-status'), 'reviewed'); assert.equal(await page.locator('[data-rm-review-result]').getAttribute('data-review-verdict'), 'pass'); assert.equal(await page.locator('[data-rm-improve]').isHidden(), true);
  control.reviewError = '视觉模型暂时不可用，请稍后重试'; await page.locator('[data-rm-review]').click(); await page.locator('[data-rm-error]:not(.hidden)').waitFor(); assert.match(await page.locator('[data-rm-error]').innerText(), /视觉模型暂时不可用/); assert.equal(await page.locator('[data-rm-code]').inputValue(), before); assert.equal(await page.locator('[data-rm-review-result]').isHidden(), true);
  assert.deepEqual(f.errors, []);
});

test('late and cancelled visual reviews preserve manual source and cannot attach a stale passing verdict', { timeout: 90000 }, async t => {
  const f = await fixture(t, 'review-late'); if (!f) return; const { page, control } = f; await f.generate(); await f.codeFile();
  control.reviewDelay = 350; control.reviewResponse = { ...control.reviewResponse, verdict: 'pass', issues: [], summary: '采样画面清楚' };
  await page.locator('[data-rm-review]').click(); await page.waitForFunction(() => document.querySelector('[data-rm-code]').readOnly);
  const manual = (await page.locator('[data-rm-code]').inputValue()) + '\n// manual edit during visual review'; await page.locator('[data-rm-code]').evaluate((node, value) => { node.value = value; node.dispatchEvent(new Event('input', { bubbles: true })); }, manual);
  await page.waitForFunction(() => !document.querySelector('[data-rm-generate]').disabled && document.querySelector('[data-rm-status]').textContent.includes('复核期间源码已有新修改'));
  assert.equal(await page.locator('[data-rm-code]').inputValue(), manual); assert.equal(await page.locator('[data-rm-review-result]').isHidden(), true); assert.equal(await page.locator('[data-rm-review]').isDisabled(), true);
  await page.locator('[data-rm-save]').click(); await page.waitForFunction(() => !document.querySelector('[data-rm-generate]').disabled);
  control.reviewDelay = 1000; await page.locator('[data-rm-review]').click(); await page.locator('[data-rm-cancel]').click(); await page.waitForFunction(() => !document.querySelector('[data-rm-generate]').disabled);
  assert.equal(await page.locator('[data-rm-code]').inputValue(), manual); assert.equal(await page.locator('[data-rm-review-result]').isHidden(), true); assert.match(await page.locator('[data-rm-status]').innerText(), /已停止等待/);
  assert.deepEqual(f.errors, []);
});

test('generation defaults to visual improvement and displays the returned inspected source and evidence without recompiling it', { timeout: 90000 }, async t => {
  const f = await fixture(t, 'auto-quality'); if (!f) return;
  const { page, control } = f;
  assert.equal(await page.locator('[data-rm-auto-improve]').isChecked(), true);
  control.autoReply = { inspection: { compositions: [{ id: 'Orbit', width: 900, height: 900, fps: 24, durationInFrames: 144 }] }, review: { ...control.reviewResponse, verdict: 'pass', summary: '优化后的实际采样画面清楚。', issues: [] }, workflow: { generations: 2, compileRepairs: 0, visualRepairs: 1, reviews: 2 } };
  await f.generate();
  assert.equal(control.calls.find(call => call.suffix === '/generate').body.autoImprove, true);
  assert.equal(control.calls.filter(call => call.suffix.endsWith('/inspect')).length, 0);
  assert.equal(await page.locator('[data-rm-review-result]').getAttribute('data-review-verdict'), 'pass');
  assert.equal(await page.locator('[data-rm-review-frames] figure').count(), 3);
  assert.match(await page.locator('[data-rm-status]').innerText(), /已生成并完成采样检查/);
  assert.deepEqual(f.errors, []);
});

test('unavailable automatic review remains unknown and the user can turn improvement off for source generation', { timeout: 90000 }, async t => {
  const f = await fixture(t, 'auto-quality-off'); if (!f) return;
  const { page, control } = f;
  control.autoReply = { inspection: { compositions: [{ id: 'Orbit', width: 900, height: 900, fps: 24, durationInFrames: 144 }] }, review: { status: 'unavailable', verdict: 'unknown', summary: '当前模型不支持图片。', issues: [], frames: [] } };
  await f.generate();
  assert.equal(await page.locator('[data-rm-review-result]').getAttribute('data-review-verdict'), 'unknown');
  assert.match(await page.locator('[data-rm-status]').innerText(), /画面检查未完成/);
  await page.locator('[data-rm-auto-improve]').uncheck(); await f.generate();
  assert.equal(control.calls.findLast(call => call.suffix === '/generate').body.autoImprove, false);
  assert.equal(control.calls.filter(call => call.suffix.endsWith('/inspect')).length, 1);
  assert.equal(await page.locator('[data-rm-review-result]').isHidden(), true);
  assert.deepEqual(f.errors, []);
});
