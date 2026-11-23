import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { startServer } from '../server.mjs';
import { readZipEntry } from '../lib/documents.mjs';

test('real writing workspace exports the current draft Word title and complete PNG without mutating its project', { timeout: 60000 }, async t => {
  const parent = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await fs.mkdir(parent, { recursive: true });
  const folder = await fs.mkdtemp(path.join(parent, 'gx-writing-export-'));
  let app, browser;
  t.after(async () => { await browser?.close(); await app?.close(); await fs.rm(folder, { recursive: true, force: true }); });
  app = await startServer({ port: 0, dataDir: path.join(folder, 'data') });
  const api = async (route, body) => {
    const response = await fetch(app.url + route, { method: body ? 'PUT' : 'GET', headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
  };
  const cases = [
    { id: 'current-export-article', channel: 'article', current: { title: '当前文章标题', lead: '当前导语', body: '当前文章正文，不能导出旧副本。' }, old: { title: '旧文章标题', lead: '旧导语', body: '旧文章正文' } },
    { id: 'current-export-poster', channel: 'poster', current: { eyebrow: '当前栏目', title: '当前海报标题', subtitle: '当前海报副标题', highlights: ['当前海报亮点'], details: [{ label: '当前字段', value: '当前值' }], footer: '当前页尾' }, old: { eyebrow: '旧栏目', title: '旧海报标题', subtitle: '旧海报副标题', highlights: ['旧海报亮点'], details: [{ label: '旧字段', value: '旧值' }], footer: '旧页尾' } },
  ];
  for (const item of cases) await api('/api/projects/' + item.id, { kind: 'writing', title: item.id, source: { title: '本地原文', text: '本地导出回归材料。', url: '' }, writing: { brief: { channel: item.channel, goal: '导出当前稿' }, draft: { channel: item.channel, output: item.current, evidence: [], notes: [], origin: 'manual' } }, outputs: { [item.channel]: item.old } });
  try { browser = await chromium.launch({ channel: 'msedge', headless: true }); } catch { t.skip('Installed Edge is required.'); return; }
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce', acceptDownloads: true });
  const modelRequests = [], pageErrors = [];
  page.on('request', request => { if (request.url().endsWith('/api/ai') || request.url().endsWith('/api/assistant/runs') && request.method() === 'POST') modelRequests.push(request.url()); });
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => {
    const original = CanvasRenderingContext2D.prototype.fillText; window.__writingExportDrawn = [];
    CanvasRenderingContext2D.prototype.fillText = function(text, ...rest) { window.__writingExportDrawn.push(text); return original.call(this, text, ...rest); };
  });
  await page.route('**/rhine/index.html?embed=1', route => route.continue({ url: route.request().url() + '&review=1&skipBoot=1&scene=archive' }));
  await page.goto(app.url);
  for (const item of cases) {
    if (await page.locator('.gx-workspace-header [data-nav="home"]').count()) await page.locator('.gx-workspace-header [data-nav="home"]').last().click();
    const home = page.frameLocator('.rhine-home-frame');
    await home.locator('[data-action="search"]').click({ timeout: 30000 }); await home.locator('#archive-search').fill(item.id); await home.locator('.result-row').first().click(); await home.locator('#edit-project').click();
    await page.locator(`[data-writing-project="${item.id}"]`).waitFor(); await page.evaluate(() => document.fonts.ready);
    const before = JSON.stringify((await api('/api/projects/' + item.id)).project);
    assert.ok((await page.locator('[data-writing-paper]').innerText()).includes(item.current.title));
    await page.locator('[data-writing-export]').click(); await page.evaluate(() => { window.__writingExportDrawn = []; });
    const waiting = page.waitForEvent('download'); await page.locator(`[data-export="${item.channel === 'article' ? 'docx' : 'poster'}"]`).click(); const download = await waiting;
    const filename = `${item.current.title}${item.channel === 'article' ? '.docx' : '-海报.png'}`;
    assert.equal(download.suggestedFilename(), filename); const saved = path.join(folder, filename); await download.saveAs(saved); const bytes = await fs.readFile(saved);
    if (item.channel === 'article') {
      const xml = readZipEntry(bytes, 'word/document.xml').toString('utf8'), core = readZipEntry(bytes, 'docProps/core.xml').toString('utf8');
      assert.ok(core.includes(item.current.title)); assert.ok(!core.includes(item.old.title));
      for (const text of Object.values(item.current)) assert.ok(xml.includes(text), 'Current Word text missing: ' + text);
      for (const text of Object.values(item.old)) assert.ok(!xml.includes(text), 'Stale Word text exported: ' + text);
    } else {
      assert.ok(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))); assert.equal(bytes.readUInt32BE(16), 1080);
      const painted = await page.evaluate(() => window.__writingExportDrawn.join('\n'));
      for (const text of [item.current.eyebrow, item.current.title, item.current.subtitle, ...item.current.highlights, item.current.details[0].label, item.current.details[0].value, item.current.footer]) assert.ok(painted.includes(text), 'Current PNG text missing: ' + text);
      assert.ok(!painted.includes(item.old.title)); assert.ok(!painted.includes(item.old.footer));
    }
    assert.equal(JSON.stringify((await api('/api/projects/' + item.id)).project), before, 'Export must not normalize or overwrite the saved draft/outputs divergence');
  }
  assert.deepEqual(modelRequests, []); assert.deepEqual(pageErrors, []);
});
