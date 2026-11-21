import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { normalizeAssistantArtifact } from '../public/assistant-artifacts-model.js';
import { assistantArtifacts, assistantDetails, applyAssistantJob } from '../public/assistant-client.js';
import { createAssistantArtifactService } from '../lib/assistant-artifacts.mjs';
import { createProjectStore } from '../lib/store.mjs';
import { findAnimationBrowser } from '../animation/render.mjs';

const root = path.resolve(import.meta.dirname, '..'), projectId = 'artifact-current';
const token = '91d6f743-3872-4531-8a3c-efbf237512bd', another = 'a1d6f743-3872-4531-8a3c-efbf237512bd';
const receipt = (downloadUrl, patch = {}) => ({ projectId, name: '真实制作文件', downloadUrl, ...patch });
const effect = artifact => ({ type: 'artifact', projectId, label: '真实制作结果', changed: false, artifact });
const legitimate = [
  receipt(`/api/assistant/exports/${token}/file`, { kind: 'writing', id: token, name: '文案.docx' }),
  receipt(`/api/assistant/exports/${another}/file`, { kind: 'novel', id: another, name: '互动讲解.gxnovel.json' }),
  receipt(`/api/openfilm/exports/${projectId}/single-video/file`, { kind: 'native', name: '视频.mp4' }),
  receipt(`/api/openfilm/exports/${projectId}/multiple-exports/file`, { kind: 'native', name: '多个片段.zip' }),
  receipt(`/api/projects/${projectId}/remotion/jobs/${token}/files/video.mp4`, { kind: 'remotion', name: '动画.mp4' }),
  receipt(`/api/projects/${projectId}/remotion/jobs/${token}/files/frame-02.png`, { kind: 'remotion', name: '动画预览.png' }),
  receipt(`/api/project-bundles/exports/${token}/file`, { kind: 'backup', name: '完整项目.gxproject' }),
];

test('artifact URL allowlist accepts real writing, novel, native single/ZIP, Remotion and backup routes', () => {
  for (const artifact of legitimate) {
    const result = normalizeAssistantArtifact(artifact, projectId);
    assert.ok(result, artifact.downloadUrl); assert.equal(result.downloadUrl, artifact.downloadUrl); assert.equal(result.projectId, projectId);
  }
  const cards = assistantArtifacts([...legitimate.map(effect), effect(legitimate[0]), { type: 'download', artifact: legitimate[0] }], projectId);
  assert.equal(cards.length, legitimate.length); assert.equal(new Set(cards.map(file => file.downloadUrl)).size, legitimate.length);
  const details = assistantDetails({ projectId, status: 'complete', effects: legitimate.map(effect) });
  assert.equal((details.match(/data-assistant-artifact-save/g) || []).length, legitimate.length);
  assert.ok(!details.includes('target="_blank"')); assert.ok(details.includes('download="完整项目.gxproject"'));
});

test('artifact normalization rejects external, executable, escaped, malformed and foreign-project links', () => {
  const local = `/api/assistant/exports/${token}/file`;
  const invalid = [
    'javascript:alert(1)', 'https://outside.example/result.mp4', '//outside.example/result.mp4', 'file:///C:/private', 'data:text/html,bad',
    `${local}?redirect=https://outside.example`, `${local}#section`, `/api/assistant/exports/../${token}/file`, `/api/assistant/exports/%2e%2e/${token}/file`,
    `/api/assistant/exports/${token}/%66ile`, `/api\\assistant\\exports\\${token}\\file`, `/api/assistant/exports/${token}/file\n`,
    `/api/openfilm/exports/${projectId}/../file`, `/api/projects/${projectId}/remotion/jobs/${token}/files/source.js`,
    `/api/projects/${projectId}/remotion/jobs/${token}/files/../../project.json`, '/api/assistant/downloads/' + token + '/file',
    '/api/project-bundles/exports/not-a-uuid/file', `/API/ASSISTANT/EXPORTS/${token}/FILE`,
  ];
  for (const downloadUrl of invalid) {
    assert.equal(normalizeAssistantArtifact(receipt(downloadUrl), projectId), null, downloadUrl);
    assert.equal(assistantArtifacts([effect(receipt(downloadUrl))], projectId).length, 0, downloadUrl);
  }
  assert.equal(normalizeAssistantArtifact(receipt(local, { projectId: 'foreign-project' }), projectId), null);
  assert.equal(normalizeAssistantArtifact(receipt(`/api/openfilm/exports/foreign-project/job/file`), projectId), null);
  assert.equal(normalizeAssistantArtifact(receipt(`/api/projects/foreign-project/remotion/jobs/${token}/files/video.mp4`), projectId), null);
  assert.equal(normalizeAssistantArtifact(receipt(local, { id: another }), projectId), null, 'A managed artifact id must identify its actual local route');
  for (const owner of ['', '../foreign', {}, 42, true]) assert.equal(normalizeAssistantArtifact(receipt(local), owner), null, 'Owner must be a real project id');
  assert.equal(assistantArtifacts([{ ...effect(receipt(local, { projectId: 'foreign-project' })), projectId: 'foreign-project' }], projectId).length, 0);
  const restored = applyAssistantJob({}, { id: 'real-run', projectId, status: 'completed', effects: [effect(legitimate[0])], message: '已生成' });
  assert.equal(restored.projectId, projectId);
  const markup = assistantDetails({ projectId, effects: [{ ...effect(receipt(local, { projectId: 'foreign-project' })), projectId: 'foreign-project' }] });
  assert.doesNotMatch(markup, /data-assistant-artifact-save/, 'A reply may only expose its own project file cards');
  assert.doesNotMatch(assistantDetails({ projectId, effects: [{ ...effect(receipt('javascript:bad()')), label: '伪造动画已生成' }] }), /伪造动画已生成/, 'An invalid file receipt must not retain an unvalidated success label');
});

test('artifact cards escape names and deduplicate only actual valid local receipts', () => {
  const artifact = receipt(`/api/assistant/exports/${token}/file`, { name: '<img src=x onerror=window.bad=true>.txt', size: 1024, sha256: 'A'.repeat(64), kind: '<script>bad()</script>', id: token });
  const cards = assistantArtifacts([effect(artifact), effect({ ...artifact }), null, { label: '已生成文件' }], projectId);
  assert.equal(cards.length, 1); assert.equal(cards[0].sha256, 'a'.repeat(64));
  const markup = assistantDetails({ projectId, effects: [effect(artifact)] });
  assert.match(markup, /&lt;img/); assert.doesNotMatch(markup, /<img|<script/); assert.match(markup, /1.0 KB/);
  const many = Array.from({ length: 40 }, () => effect(receipt(`/api/assistant/exports/${randomUUID()}/file`)));
  assert.equal(assistantArtifacts(many, projectId).length, 30);
  for (const artifact of [null, [], {}, receipt('/api/assistant/exports/' + token + '/file', { name: '' }), receipt('/api/assistant/exports/' + token + '/file', { name: ' '.repeat(5) })]) assert.equal(normalizeAssistantArtifact(artifact, projectId), null);
});

test('Edge artifact cards save the exact managed export bytes without automatic downloads or unsafe navigation', { timeout: 60000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gx-artifact-ui-')), dataDir = path.join(directory, 'data');
  const evidence = process.env.GUANGXUAN_ARTIFACT_UI_EVIDENCE ? path.resolve(process.env.GUANGXUAN_ARTIFACT_UI_EVIDENCE) : directory; await mkdir(evidence, { recursive: true });
  const store = await createProjectStore(dataDir); await store.save(projectId, { kind: 'writing', title: '隔离产物测试', source: { text: '' } });
  const artifacts = await createAssistantArtifactService({ dataDir, store, root });
  const original = Buffer.concat([Buffer.from('真正导出的文案原始字节\n'), Buffer.from([0, 1, 2, 128, 254, 255])]);
  const writing = await artifacts.create({ projectId, name: '真正导出的文案.txt', contentType: 'text/plain; charset=utf-8', buffer: original });
  const novelBytes = Buffer.from(JSON.stringify({ format: 'gx-visual-novel', version: 2, fixture: '离线作品字节' }));
  const novel = await artifacts.create({ projectId, name: '互动作品.gxnovel.json', contentType: 'application/json', buffer: novelBytes });
  const controlled = [receipt(writing.downloadUrl, { ...writing, kind: 'writing' }), receipt(novel.downloadUrl, { ...novel, kind: 'novel' }), ...legitimate.slice(2)];
  const hostile = [receipt('javascript:window.bad=true'), receipt('https://outside.example/result.mp4'), receipt(`/api/openfilm/exports/foreign-project/job/file`), receipt(writing.downloadUrl, { projectId: 'foreign-project' })];
  const allowed = new Set(['assistant-client.js', 'assistant-artifacts-model.js', 'assistant-source-diff-model.js', 'ui.js', 'styles.css', 'editor-assistant.css', 'app-assistant.css']);
  const gets = [], unexpected = [], json = (res, value) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (await artifacts.handler(req, res, url)) { gets.push(url.pathname); return; }
      if (url.pathname === '/fixture/effects') { json(res, { projectId, effects: [...controlled.map(effect), ...hostile.map(effect)] }); return; }
      if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html;charset=utf-8' }); res.end('<!doctype html><html lang="zh"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/editor-assistant.css"><link rel="stylesheet" href="/app-assistant.css"></head><body><main id="fixture" style="width:min(100%,760px);margin:auto;padding:16px;box-sizing:border-box"></main><script type="module">import {assistantDetails} from "/assistant-client.js";const message=await(await fetch("/fixture/effects")).json();document.getElementById("fixture").innerHTML=assistantDetails(message);window.ready=true;</script></body></html>'); return; }
      if (allowed.has(url.pathname.slice(1))) { res.writeHead(200, { 'content-type': url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript' }); res.end(await readFile(path.join(root, 'public', url.pathname.slice(1)))); return; }
      if (url.pathname !== '/favicon.ico') unexpected.push(url.pathname); res.writeHead(404); res.end();
    } catch (error) { unexpected.push(error.message); if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${server.address().port}`; assert.notEqual(server.address().port, 4417);
  const browser = await chromium.launch({ executablePath: await findAnimationBrowser(), headless: true });
  t.after(async () => { await browser.close(); await artifacts.close(); await store.settle(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); assert.equal(path.dirname(directory), os.tmpdir()); await rm(directory, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, acceptDownloads: true }), errors = [], downloads = [], external = [];
  page.on('pageerror', error => errors.push(error.message)); page.on('download', value => downloads.push(value.suggestedFilename()));
  await page.route('**/*', route => { if (new URL(route.request().url()).origin === origin) return route.continue(); external.push(route.request().url()); return route.abort(); });
  await page.goto(origin); await page.waitForFunction(() => window.ready);
  assert.equal(await page.locator('[data-assistant-artifact-save]').count(), controlled.length); assert.deepEqual(downloads, [], 'Showing a local file receipt never saves it automatically');
  assert.equal(await page.locator('[data-assistant-artifact-save][href^="http"],[data-assistant-artifact-save][href^="javascript:"]').count(), 0);
  const saved = [];
  for (const [file, bytes] of [[writing, original], [novel, novelBytes]]) {
    const link = page.locator('[data-assistant-artifact-save]').filter({ hasText: '保存文件' }).locator(`xpath=self::*[@href="${file.downloadUrl}"]`);
    const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
    assert.equal(download.suggestedFilename(), file.name); const actual = await readFile(await download.path());
    assert.deepEqual(actual, bytes); assert.deepEqual(actual, (await artifacts.read(file.id)).buffer);
    saved.push({ name: file.name, size: actual.length, sha256: createHash('sha256').update(actual).digest('hex') });
  }
  assert.equal(new URL(page.url()).origin, origin); assert.equal(await page.evaluate(() => window.bad), undefined);
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  await page.screenshot({ path: path.join(evidence, 'artifact-cards-mobile.png'), fullPage: true });
  await page.reload(); await page.waitForFunction(() => window.ready); assert.equal(await page.locator('[data-assistant-artifact-save]').count(), controlled.length); assert.equal(downloads.length, 2);
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(unexpected, []); assert.deepEqual(gets, [writing.downloadUrl, novel.downloadUrl]);
  await writeFile(path.join(evidence, 'artifact-ui-verification.json'), JSON.stringify({ realBrowser: 'Edge', nativeCards: 2, remotionCards: 2, backupCards: 1, managedCards: 2, actualSaves: saved, unsafeCardsRejected: hostile.length, automaticDownloads: 0, userProjectWrites: 0, liveNetworkRequests: 0 }, null, 2));
});
