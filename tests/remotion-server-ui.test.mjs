import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startServer } from '../server.mjs';
import { findAnimationBrowser } from '../animation/render.mjs';

const execute = promisify(execFile);
const authored = {
  title: '自由轨迹示意', entryPoint: 'src/index.jsx', compositionId: 'FreeMotion', inputProps: { label: '自由轨迹示意' }, assetIds: [], notes: ['本机受控模型返回真实多文件源码，非固定场景计划。'],
  files: [
    { path: 'src/index.jsx', content: "import React from 'react';import {registerRoot} from 'remotion';import {Root} from './Root.jsx';registerRoot(Root);" },
    { path: 'src/Root.jsx', content: "import React from 'react';import {Composition} from 'remotion';import {Motion} from './Motion.jsx';export const Root=()=> <><Composition id='FreeMotion' component={Motion} durationInFrames={60} fps={15} width={320} height={180}/><Composition id='TallMotion' component={Motion} durationInFrames={30} fps={15} width={180} height={320}/></>;" },
    { path: 'src/Motion.jsx', content: "import React from 'react';import {AbsoluteFill,useCurrentFrame,useVideoConfig} from 'remotion';export const Motion=({label='自由轨迹示意'})=>{const frame=useCurrentFrame(),{fps,width,height}=useVideoConfig();return <AbsoluteFill style={{background:'#10232f',color:'#f4f2dc',fontFamily:'sans-serif'}}><svg width={width} height={height}><ellipse cx={width/2} cy={height/2-8} rx={width*.32} ry={height*.25} fill='none' stroke='#4e7080' strokeWidth='2'/>{['#efb35d','#7bd6c2','#f47d8c'].map((color,index)=>{const a=frame/fps*1.5+index*Math.PI*2/3;return <circle key={color} cx={width/2+Math.cos(a)*width*.32} cy={height/2-8+Math.sin(a)*height*.25} r={9+index*2} fill={color}/>})}</svg><div style={{position:'absolute',bottom:12,left:12,right:12,fontSize:15,textAlign:'center'}}>{label}</div></AbsoluteFill>};" },
  ],
};

test('real server UI creates multi-file Remotion, inspects, previews, renders a three-second sample and full native clip with undo', { timeout: 240000, skip: process.env.GUANGXUAN_TEST_ANIMATION !== '1' }, async t => {
  let chromium; try { ({ chromium } = await import('playwright-core')); } catch { t.skip('Playwright is required.'); return; }
  const executablePath = await findAnimationBrowser();
  const temporary = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await fs.mkdir(temporary, { recursive: true });
  const directory = await fs.mkdtemp(path.join(temporary, 'gx-remotion-server-ui-')), dataDir = path.join(directory, 'data');
  let app, browser; const modelCalls = [], responses = [], traces = [], pageErrors = [], responseReads = [];
  t.after(async () => { await browser?.close(); await app?.close(); assert.equal(path.dirname(directory), temporary); assert.ok(path.basename(directory).startsWith('gx-remotion-server-ui-')); if (process.env.GUANGXUAN_KEEP_REMOTION_SERVER_UI !== '1') await fs.rm(directory, { recursive: true, force: true }); });
  app = await startServer({ dataDir, port: 0, remotionDependencies: { ai: async (task, payload) => { assert.equal(task, 'remotion-project'); modelCalls.push({ task, instruction: payload.instruction }); return { data: structuredClone(authored), meta: { model: 'local-controlled-source' } }; } } });
  assert.notEqual(new URL(app.url).port, '4417');
  async function request(route, body, method = body === undefined ? 'GET' : 'POST') { const response = await fetch(app.url + route, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }); const result = await response.json(); assert.equal(response.ok, true, JSON.stringify(result)); return result; }
  const appId = 'real-remotion-ui', created = (await request(`/api/projects/${appId}`, { id: appId, kind: 'video', title: '自由Remotion真实链路', video: { timeline: [], captions: [], aspect: '16:9', script: '' }, source: { text: '' }, history: [], runs: [] }, 'PUT')).project;
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1240, height: 1000 } }); page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/free-remotion-component.html', route => route.fulfill({ contentType: 'text/html;charset=utf-8', body: `<!doctype html><html lang="zh"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body><main id="app"><button id="open">打开自由创作</button></main><div id="modal-root"></div><div id="toast-region"></div><script type="module">import {createOpenfilmActions} from '/openfilm-actions.js';import {api} from '/ui.js';window.project=${JSON.stringify(created).replaceAll('<', '\\u003c')};window.actions=createOpenfilmActions({getSettings:()=>({baseUrl:'http://127.0.0.1:1/v1',model:'controlled-source',apiKey:'fixture-no-external-call'}),requireConnection:()=>true,saveProject:async p=>(await api('/api/projects/'+p.id,p,{method:'PUT'})).project});document.querySelector('#open').onclick=()=>actions.showAnimation(project);</script></body></html>` }));
  page.on('request', req => { const url = new URL(req.url()); if (url.pathname.includes('/remotion') && req.method() === 'POST') { const body = req.postDataJSON(); traces.push({ path: url.pathname, ...(body.range ? { range: body.range } : {}), ...(body.expectedNativeRevision ? { expectedNativeRevision: body.expectedNativeRevision } : {}) }); } });
  page.on('response', response => { const pathname = new URL(response.url()).pathname; if (response.request().method() === 'POST' && /\/(preview|render|append)$/.test(pathname) && response.ok()) responseReads.push(response.json().then(body => responses.push({ pathname, body }))); });
  await page.goto(app.url + '/free-remotion-component.html'); await page.locator('#open').click(); await page.waitForFunction(() => document.querySelector('[data-rm-generate]') && !document.querySelector('[data-rm-generate]').disabled);
  assert.equal(await page.locator('[data-animation-theme]').count(), 0);
  await page.locator('[data-rm-auto-improve]').uncheck(); // This flow exercises manual source/preview/render; automatic improvement has its own real-worker HTTP regression.
  await page.locator('[data-rm-instruction]').fill('用真正的源码让三个圆沿椭圆轨迹运动，4秒，另外给一个竖版Composition，不要模板。'); await page.locator('[data-rm-generate]').click();
  await page.waitForFunction(() => document.querySelector('[data-rm-metadata]').textContent.includes('15 fps') && !document.querySelector('[data-rm-generate]').disabled, null, { timeout: 90000 });
  assert.match(await page.locator('[data-rm-metadata]').innerText(), /320 × 180.*4\.00 秒/); assert.equal(await page.locator('[data-rm-composition] option').count(), 2);
  await page.locator('.rm-source>summary').click(); assert.equal(await page.locator('[data-rm-file] option').count(), 3); await page.locator('[data-rm-file]').selectOption('src/Motion.jsx'); assert.match(await page.locator('[data-rm-code]').inputValue(), /Math\.cos/);
  await page.locator('[data-rm-preview]').click(); await page.waitForFunction(() => document.querySelectorAll('.rm-frames figure').length === 3 && !document.querySelector('[data-rm-generate]').disabled, null, { timeout: 90000 });
  const frameUrls = await page.locator('.rm-frames img').evaluateAll(nodes => nodes.map(node => node.src)); const frameBytes = await Promise.all(frameUrls.map(async url => Buffer.from(await (await fetch(url)).arrayBuffer()))); for (const bytes of frameBytes) assert.ok(bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))); assert.notDeepEqual(frameBytes[0], frameBytes[1]);
  await page.locator('[data-rm-sample]').click(); await page.waitForFunction(() => !document.querySelector('[data-rm-video]').hidden && !document.querySelector('[data-rm-generate]').disabled, null, { timeout: 90000 });
  const sampleUrl = await page.locator('[data-rm-video]').getAttribute('src'); assert.ok(sampleUrl.endsWith('/video.mp4'));
  const sampleBytes = Buffer.from(await (await fetch(new URL(sampleUrl, app.url))).arrayBuffer()); const sampleFile = path.join(directory, 'actual-sample.mp4'); await fs.writeFile(sampleFile, sampleBytes);
  const ffprobe = process.env.GUANGXUAN_FFPROBE || (process.env.GUANGXUAN_BIN_DIR ? path.join(process.env.GUANGXUAN_BIN_DIR, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe') : 'ffprobe');
  const probe = async filename => JSON.parse((await execute(ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height,r_frame_rate', '-of', 'json', filename], { windowsHide: true })).stdout);
  const sampleProbe = await probe(sampleFile); assert.ok(Math.abs(Number(sampleProbe.format.duration) - 3) < .1, 'The sample range is seconds, not three video frames');
  const beforeNative = await request(`/api/openfilm/context?projectId=${appId}`); assert.equal(beforeNative.timeline.length, 0);
  await page.locator('[data-rm-render]').click(); await page.waitForFunction(() => document.querySelector('[data-rm-status]').textContent.includes('并加入时间线') && !document.querySelector('[data-rm-generate]').disabled || !document.querySelector('[data-rm-error]').classList.contains('hidden'), null, { timeout: 90000 });
  assert.equal(await page.locator('[data-rm-error]').isVisible(), false, await page.locator('[data-rm-error]').innerText());
  await Promise.all(responseReads);
  const appended = responses.findLast(item => item.pathname.endsWith('/append'))?.body; assert.equal(appended?.appended, true); assert.ok(appended.asset?.id); assert.ok(appended.undo?.id);
  const afterNative = await request(`/api/openfilm/context?projectId=${appId}`); assert.equal(afterNative.timeline.length, 1); const canonical = afterNative.assets.find(asset => asset.id === afterNative.timeline[0].assetId); assert.ok(canonical, 'The clip references a registered project-owned asset'); assert.match(canonical.name, /自由轨迹示意/); assert.ok(Math.abs(afterNative.duration - 4) < .1);
  const fullJobId = responses.filter(item => item.pathname.endsWith('/render')).at(-1).body.jobId; const fullBytes = Buffer.from(await (await fetch(`${app.url}/api/projects/${appId}/remotion/jobs/${fullJobId}/files/video.mp4`)).arrayBuffer()); const fullFile = path.join(directory, 'actual-full.mp4'); await fs.writeFile(fullFile, fullBytes); const fullProbe = await probe(fullFile); assert.ok(Math.abs(Number(fullProbe.format.duration) - 4) < .1); const canonicalBytes = Buffer.from(await (await fetch(new URL(canonical.url, app.url))).arrayBuffer()); assert.deepEqual(canonicalBytes, fullBytes, 'The native owned asset preserves the actual rendered video bytes');
  assert.equal(await page.locator('[data-rm-undo]').isVisible(), true); await page.locator('[data-rm-undo]').click(); await page.waitForFunction(() => document.querySelector('[data-rm-status]').textContent.includes('已撤销')); const restoredNative = await request(`/api/openfilm/context?projectId=${appId}`); assert.equal(restoredNative.timeline.length, 0);
  await page.locator('.rm-composition-panel').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(directory, 'actual-free-ui-desktop.png'), fullPage: true }); await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true); await page.screenshot({ path: path.join(directory, 'actual-free-ui-mobile.png'), fullPage: true });
  assert.deepEqual(pageErrors, []); assert.equal(modelCalls.length, 1);
  const report = { status: 'passed', actualProductionDialog: true, actualApplicationServer: true, actualRemotionWorker: true, actualMultiFileSource: true, actualNativeImportAndUndo: true, controlledAiOnly: true, externalModelUsed: false, requested4417: false, modelCalls, sampleDuration: Number(sampleProbe.format.duration), fullDuration: Number(fullProbe.format.duration), sampleBytes: sampleBytes.length, fullBytes: fullBytes.length, sourceFiles: authored.files.map(file => file.path), compositions: ['FreeMotion', 'TallMotion'], frameCount: frameBytes.length, nativeClipsAfterAppend: afterNative.timeline.length, nativeClipsAfterUndo: restoredNative.timeline.length, traces, pageErrors };
  await fs.writeFile(path.join(directory, 'actual-server-verification.json'), JSON.stringify(report, null, 2));
  if (process.env.GUANGXUAN_REMOTION_SERVER_UI_EVIDENCE) { const target = path.resolve(process.env.GUANGXUAN_REMOTION_SERVER_UI_EVIDENCE); await fs.mkdir(target, { recursive: true }); for (const file of ['actual-sample.mp4', 'actual-full.mp4', 'actual-free-ui-desktop.png', 'actual-free-ui-mobile.png', 'actual-server-verification.json']) await fs.copyFile(path.join(directory, file), path.join(target, file)); for (let index = 0; index < frameBytes.length; index++) await fs.writeFile(path.join(target, `actual-frame-${index}.png`), frameBytes[index]); }
});
