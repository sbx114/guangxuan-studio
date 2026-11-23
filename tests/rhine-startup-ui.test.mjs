import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { startServer } from '../server.mjs';

async function fixture(t, kind) {
  const parent = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'gx-home-startup-'));
  const app = await startServer({ port: 0, dataDir: path.join(directory, 'data') });
  assert.notEqual(new URL(app.url).port, '4417');
  let browser;
  t.after(async () => { await browser?.close(); await app.close(); assert.equal(path.dirname(directory), parent); await rm(directory, { recursive: true, force: true }); });
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce' });
  const errors = [], visualWarnings = [], modelRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'warning' && message.text().includes('homepage visual preparation')) visualWarnings.push(message.text()); });
  page.on('request', request => { if (request.method() === 'POST' && /\/api\/(?:ai|assistant\/runs)$/.test(new URL(request.url()).pathname)) modelRequests.push(request.url()); });
  await page.route('**/*', route => { const url = new URL(route.request().url()); return ['http:', 'https:'].includes(url.protocol) && url.origin !== app.url ? route.abort() : route.continue(); });
  await page.route('**/rhine/index.html?embed=1', route => route.continue({ url: route.request().url() + '&review=1&skipBoot=1&scene=archive' }));
  if (kind === 'webgl-unavailable') await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(type, ...args) { if (/^webgl/.test(type)) return null; return original.call(this, type, ...args); };
  });
  if (kind === 'async-gpu-unavailable') await page.addInitScript(() => {
    window.__homeGpuProbe = { extensionChecks: 0, forbiddenCalls: [] };
    for (const prototype of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype]) {
      const getExtension = prototype.getExtension;
      prototype.getExtension = function(name) {
        if (name === 'KHR_parallel_shader_compile') { window.__homeGpuProbe.extensionChecks++; return null; }
        return getExtension.call(this, name);
      };
      for (const method of ['compileShader', 'linkProgram', 'drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'finish', 'flush', 'fenceSync', 'clientWaitSync']) {
        if (typeof prototype[method] !== 'function') continue;
        prototype[method] = function() { window.__homeGpuProbe.forbiddenCalls.push(method); throw new Error('Unsupported homepage must not call GPU ' + method); };
      }
    }
  });
  const current = { title: '独立启动回归当前稿', body: '三维首页不可用时，文案工作区仍读取这份实际保存的当前稿。' };
  const response = await fetch(app.url + '/api/projects/startup-writing', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'writing', title: '独立启动回归', source: { text: '独立本地材料。' }, writing: { brief: { channel: 'article' }, draft: { channel: 'article', output: current, evidence: [], notes: [] } }, outputs: { article: current } }) });
  assert.equal(response.status, 200); const before = (await response.json()).project;
  async function state() {
    const frame = page.frames().find(frame => frame.url().includes('/rhine/index.html'));
    return frame.evaluate(() => ({ startup: window.rhine?.stats().startup, preparation: window.rhine?.stats().startupPreparation, threeState: window.rhine?.stats().threeState, ready: window.rhine?.stats().ready, mode: window.rhine?.stats().mode, loadingPresent: Boolean(document.querySelector('#loading')), canvasCount: document.querySelectorAll('#three-scene canvas').length, stageInert: document.querySelector('#stage').inert, gpuProbe: window.__homeGpuProbe, marks: performance.getEntriesByType('mark').filter(item => item.name.startsWith('gx:')).map(item => item.name) }));
  }
  async function ready() {
    await page.frameLocator('.rhine-home-frame').locator('#stage').waitFor({ state: 'attached', timeout: 10000 });
    const frame = page.frames().find(frame => frame.url().includes('/rhine/index.html'));
    await frame.waitForFunction(() => window.rhine?.stats().startup === 'started', null, { timeout: 20000 });
    await page.frameLocator('.rhine-home-frame').locator('#loading').waitFor({ state: 'detached', timeout: 2000 });
    const result = await state(); assert.equal(result.ready, true); assert.equal(result.stageInert, false); assert.equal(result.loadingPresent, false); assert.equal(result.mode, 'archive'); return result;
  }
  async function openCurrentWriting() {
    const home = page.frameLocator('.rhine-home-frame');
    await home.locator('[data-action="search"]').click({ timeout: 5000 }); await home.locator('#archive-search').fill('独立启动回归'); await home.locator('.result-row').first().click(); await home.locator('#edit-project').click();
    await page.locator('[data-writing-project="startup-writing"]').waitFor({ timeout: 5000 }); assert.match(await page.locator('[data-writing-paper]').innerText(), /独立启动回归当前稿/);
    const actual = (await (await fetch(app.url + '/api/projects/startup-writing')).json()).project;
    assert.deepEqual(actual, before, 'Opening the fallback navigation must not modify its independent project'); assert.deepEqual(modelRequests, []); assert.deepEqual(errors, []);
  }
  async function evidence(result) {
    if (!process.env.GUANGXUAN_RHINE_STARTUP_EVIDENCE) return;
    const output = path.resolve(process.env.GUANGXUAN_RHINE_STARTUP_EVIDENCE); await mkdir(output, { recursive: true });
    await writeFile(path.join(output, kind + '.json'), JSON.stringify({ passed: true, kind, state: result, errors, visualWarnings, actualEdge: true, softwareRendererRequested: true, modelRequests: 0, managedPort4417Used: false, productionDataUsed: false }, null, 2));
    await page.screenshot({ path: path.join(output, kind + '.png'), animations: 'disabled', timeout: 10000 });
  }
  return { app, page, ready, state, openCurrentWriting, evidence, visualWarnings };
}

test('real Edge software rendering reaches a truthful terminal homepage state and opens the saved writing workspace', { timeout: 60000 }, async t => {
  const f = await fixture(t, 'cpu'); await f.page.goto(f.app.url, { waitUntil: 'domcontentloaded' }); const state = await f.ready();
  assert.ok(['ready', 'fallback'].includes(state.preparation.state));
  if (state.preparation.state === 'fallback') { assert.equal(state.threeState, 'off'); assert.equal(state.canvasCount, 0); }
  await f.openCurrentWriting(); await f.evidence(state);
});

test('actual WebGL failure exposes a 2D fallback notice and keeps project navigation usable without forced clicks', { timeout: 60000 }, async t => {
  const f = await fixture(t, 'webgl-unavailable'); await f.page.goto(f.app.url, { waitUntil: 'domcontentloaded' }); const state = await f.ready();
  assert.equal(state.preparation.state, 'fallback'); assert.equal(state.preparation.reason, 'unavailable'); assert.equal(state.threeState, 'off'); assert.equal(state.canvasCount, 0);
  const notice = f.page.frameLocator('.rhine-home-frame').locator('.home-startup-notice'); await notice.waitFor(); assert.match(await notice.innerText(), /二维项目界面/); assert.equal(await notice.locator('button').isEnabled(), true);
  assert.ok(f.visualWarnings.length); await f.openCurrentWriting(); await f.evidence(state);
});

test('missing async shader capability never compiles or draws the homepage and real project navigation remains available', { timeout: 60000 }, async t => {
  const f = await fixture(t, 'async-gpu-unavailable'); let modelRequests = 0; f.page.on('request', request => { if (/\.glb(?:\?|$)/.test(request.url())) modelRequests++; });
  await f.page.goto(f.app.url, { waitUntil: 'domcontentloaded' }); const state = await f.ready();
  assert.equal(state.preparation.state, 'fallback'); assert.equal(state.preparation.reason, 'async-gpu-unavailable', JSON.stringify({ state, warnings: f.visualWarnings })); assert.equal(state.preparation.asyncShadersAvailable, false); assert.equal(state.threeState, 'off'); assert.equal(state.canvasCount, 0);
  assert.ok(state.gpuProbe.extensionChecks > 0, 'Actual WebGL extension lookup must have been observed'); assert.deepEqual(state.gpuProbe.forbiddenCalls, []); assert.equal(modelRequests, 0, 'Capability refusal must happen before model loading'); assert.ok(!state.marks.includes('gx:scene:prepare-start'));
  const notice = f.page.frameLocator('.rhine-home-frame').locator('.home-startup-notice'); assert.match(await notice.innerText(), /图形驱动不支持异步着色器编译/);
  await f.openCurrentWriting(); const final = await f.state(); assert.deepEqual(final.gpuProbe.forbiddenCalls, []); await f.evidence(final);
});

test('a stalled optional scene module has a bounded 2D fallback and its late response cannot activate a scene', { timeout: 60000 }, async t => {
  const f = await fixture(t, 'scene-module-timeout'); let release; const gate = new Promise(resolve => { release = resolve; }); let intercepted = 0;
  await f.page.route(/\/rhine\/assets\/scene-[^/]+\.js(?:\?|$)/, async route => { intercepted++; await gate; await route.continue().catch(() => {}); });
  t.after(() => release());
  await f.page.goto(f.app.url, { waitUntil: 'domcontentloaded' }); const state = await f.ready(); assert.ok(intercepted > 0, 'The actual optional scene module request must have been intercepted');
  assert.equal(state.preparation.state, 'fallback'); assert.equal(state.preparation.reason, 'timeout'); assert.equal(state.threeState, 'off'); assert.equal(state.canvasCount, 0);
  release(); await f.page.waitForTimeout(1500); const late = await f.state(); assert.equal(late.preparation.state, 'fallback'); assert.equal(late.threeState, 'off'); assert.equal(late.canvasCount, 0); assert.equal(late.loadingPresent, false);
  await f.openCurrentWriting(); await f.evidence(late);
});
