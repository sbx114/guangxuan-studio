import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { startServer } from '../server.mjs';
import { findAnimationBrowser } from '../animation/render.mjs';

test('a reopened source-version modal cannot apply cached narration over a newer manual draft', { timeout: 60000 }, async t => {
  const base = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(base, { recursive: true }); const directory = await mkdtemp(path.join(base, 'gx-source-modal-race-')), app = await startServer({ port: 0, dataDir: path.join(directory, 'data') }); assert.notEqual(new URL(app.url).port, '4417');
  const browser = await chromium.launch({ executablePath: await findAnimationBrowser(), headless: true });
  t.after(async () => { await browser.close(); await app.close(); assert.equal(path.dirname(directory), base); await rm(directory, { recursive: true, force: true }); });
  const api = async (route, body, method = body === undefined ? 'GET' : 'POST') => { const response = await fetch(app.url + route, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result; };
  await api('/api/projects/source-modal-doc', { kind: 'writing', title: '旁白来源', outputs: { video: { shots: [{ narration: '原始旁白', caption: '原字幕', visual: '原画面', duration: 6 }] } } }, 'PUT');
  await api('/api/projects/source-modal-video', { kind: 'video', title: '当前视频', video: { script: '原始旁白', timeline: [], captions: [] } }, 'PUT');
  await api('/api/projects/source-modal-video/source-link', { sourceProjectId: 'source-modal-doc' });
  const page = await browser.newPage(), requests = [], errors = [];
  page.on('pageerror', error => errors.push(error.message)); page.on('request', request => { if (new URL(request.url()).pathname.endsWith('/source-link/sync')) requests.push(request.postDataJSON()); });
  await page.route('**/__source-modal-fixture', route => route.fulfill({ contentType: 'text/html;charset=utf-8', body: '<!doctype html><link rel="stylesheet" href="/styles.css"><button id="open">来源版本</button><div id="modal-root"></div><div id="toast-region"></div><script type="module">import {createSourceVersions} from "/source-versions.js";window.versions=createSourceVersions();document.getElementById("open").onclick=()=>versions.open("source-modal-video");window.ready=true;</script>' }));
  await page.goto(app.url + '/__source-modal-fixture'); await page.waitForFunction(() => window.ready); await page.locator('#open').click(); await page.waitForFunction(() => !document.querySelector('[data-version-sync]').disabled);
  await page.locator('[data-version-script]').locator('xpath=..').locator('summary').click(); await page.locator('[data-version-script]').fill('第一处尚未提交的本机旁白'); await page.keyboard.press('Escape');
  const latest = (await api('/api/projects/source-modal-video')).project; latest.video.script = '第二处已保存的新旁白'; await api('/api/projects/' + latest.id, latest, 'PUT');
  await page.locator('#open').click(); await page.waitForFunction(() => !document.querySelector('[data-version-sync]').disabled); await page.locator('[data-version-sync]').click();
  await page.waitForFunction(() => !document.querySelector('[data-version-sync]').disabled);
  const saved = (await api('/api/projects/source-modal-video')).project; assert.equal(saved.video.script, '第二处已保存的新旁白', 'A cached local draft must not acquire a fresh targetHash merely by reopening the modal');
  assert.equal(await page.locator('[data-version-script]').inputValue(), '第一处尚未提交的本机旁白'); assert.match(await page.locator('[data-version-error]').innerText(), /改变|更新|比较/);
  assert.equal(await page.locator('[data-version-current-script]').inputValue(), '第二处已保存的新旁白');
  if (process.env.GUANGXUAN_AUTHORING_AUDIT_EVIDENCE) { const evidence = path.resolve(process.env.GUANGXUAN_AUTHORING_AUDIT_EVIDENCE); await mkdir(evidence, { recursive: true }); await page.locator('[data-version-current]>summary').click(); await page.locator('[data-version-current-script]').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(evidence, 'source-version-conflict.png') }); }
  await page.locator('[data-version-script]').locator('xpath=..').locator('summary').click();
  const merged = '第二处已保存的新旁白\n合并第一处的本机补充'; await page.locator('[data-version-script]').fill(merged); await page.locator('[data-version-sync]').click(); await page.waitForFunction(() => !document.querySelector('[data-version-sync]').disabled);
  assert.equal((await api('/api/projects/source-modal-video')).project.video.script, merged); assert.notEqual(requests[0].targetHash, requests[1].targetHash);
  assert.equal(requests.length, 2); assert.deepEqual(errors, []);
  if (process.env.GUANGXUAN_AUTHORING_AUDIT_EVIDENCE) { const evidence = path.resolve(process.env.GUANGXUAN_AUTHORING_AUDIT_EVIDENCE); await mkdir(evidence, { recursive: true }); await page.screenshot({ path: path.join(evidence, 'source-version-merged.png') }); await writeFile(path.join(evidence, 'source-version-conflict-verification.json'), JSON.stringify({ status: 'passed', actualUi: true, actualServer: true, cachedLocalDraftRetained: true, newerSavedDraftRetained: true, staleTargetHashRejected: true, explicitMergedDraftSaved: true, modelRequests: 0, requested4417: false }, null, 2)); }
});
