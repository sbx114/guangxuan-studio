import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { startServer } from '../server.mjs';

test('actual index handoff sends the current video draft and its caption timing without rewriting source outputs', { timeout: 60000 }, async t => {
  const base = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(base, { recursive: true });
  const dataDir = await mkdtemp(path.join(base, 'gx-writing-handoff-')); let browser;
  const app = await startServer({ port: 0, dataDir });
  t.after(async () => { await browser?.close(); await app.close(); assert.equal(path.dirname(dataDir), base); await rm(dataDir, { recursive: true, force: true }); });
  const api = async (route, body) => { const response = await fetch(app.url + route, { method: body === undefined ? 'GET' : 'PUT', headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result; };
  const current = { title: '当前分镜', shots: [{ narration: '当前旁白。', caption: '当前字幕。', visual: '当前画面。', duration: 3 }] };
  const old = { title: '旧分镜', shots: [{ narration: '旧旁白。', caption: '旧字幕。', visual: '旧画面。', duration: 9 }] };
  const before = (await api('/api/projects/handoff-current', { kind: 'writing', title: '当前分镜交接测试', source: { title: '材料', text: '原始资料。', url: '' }, writing: { brief: { channel: 'video' }, draft: { channel: 'video', output: current, evidence: [], notes: [] } }, outputs: { video: old, article: { title: '独立文章', body: '文章渠道正文。' } } })).project;
  browser = await chromium.launchPersistentContext(path.join(dataDir, 'browser-profile'), { channel: 'msedge', headless: true, viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce' });
  const page = browser.pages()[0] || await browser.newPage(); let aiCalls = 0;
  await page.route('**/*', route => { const url = new URL(route.request().url()); return ['http:', 'https:'].includes(url.protocol) && url.origin !== app.url ? route.abort() : route.continue(); });
  await page.route('**/rhine/index.html?embed=1', route => route.continue({ url: route.request().url() + '&review=1&skipBoot=1&scene=archive' }));
  page.on('request', request => { if (request.method() === 'POST' && /\/api\/(?:ai|assistant\/runs)$/.test(new URL(request.url()).pathname)) aiCalls++; });
  await page.goto(app.url);
  const home = page.frameLocator('.rhine-home-frame'); await home.locator('[data-action="search"]').click({ timeout: 45000 }); await home.locator('#archive-search').fill('当前分镜交接测试'); await home.locator('.result-row').first().click(); await home.locator('#edit-project').click();
  await page.locator('[data-writing-project="handoff-current"]').waitFor(); assert.match(await page.locator('[data-writing-paper]').innerText(), /当前旁白/);
  await page.locator('[data-writing-export]').click(); await page.locator('[data-export="video"]').click();
  let source, target;
  for (let index = 0; index < 600; index++) { source = (await api('/api/projects/handoff-current')).project; if (source.videoProjectId) { target = (await api('/api/projects/' + source.videoProjectId)).project; if (target.video.openfilmDraftCaptions?.length) break; } await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.ok(target?.video.openfilmDraftCaptions?.length); assert.equal(target.video.script, '当前旁白。'); assert.deepEqual(target.video.openfilmDraftCaptions, [{ start: 0, end: 3, text: '当前字幕。' }]);
  const linked = await api('/api/projects/' + target.id + '/source-link'); assert.equal(linked.storyboard[0].narration, '当前旁白。'); assert.equal(linked.storyboard[0].duration, 3);
  const baseline = JSON.parse(await readFile(path.join(dataDir, 'project-links', target.id + '.json'), 'utf8')).baseline; assert.equal(baseline.body, '文章渠道正文。');
  assert.deepEqual(source.writing.draft, before.writing.draft); assert.deepEqual(source.outputs, before.outputs); assert.deepEqual(source.source, before.source);
  assert.ok(!target.video.timeline?.length); assert.equal(aiCalls, 0);
});
