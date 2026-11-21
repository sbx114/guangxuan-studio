import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { startServer } from '../server.mjs';

const sourceUrl = 'https://papers.example.org/paper.pdf';
const secret = 'fixture-download-http-key-123456';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'gx-assistant-download-http-'));
  const pdf = await readFile(new URL('./fixtures/science-documents/bilingual-paper.pdf', import.meta.url));
  const calls = { pdf: 0, model: 0, publicTargets: [] };
  let plan = () => ({ type: 'final', message: '夹具已就绪。', sourceIds: [] }), app;
  const sockets = new Set();
  const upstream = http.createServer(async (req, res) => {
    try {
      if (req.url === '/paper.pdf') {
        calls.pdf++;
        assert.equal(req.headers.host, 'papers.example.org');
        assert.equal(req.headers.authorization, undefined);
        res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': pdf.length, 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent('双语原始论文.pdf')}` }); res.end(pdf); return;
      }
      assert.equal(req.url, '/v1/chat/completions'); assert.equal(req.headers.authorization, `Bearer ${secret}`);
      const body = JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString());
      calls.model++;
      const context = JSON.parse(body.messages[1].content);
      const next = plan(context);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(next) } }] }));
    } catch (error) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'fixture failed', message: error.message })); }
  });
  upstream.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const assistantWebDependencies = {
    lookup: async hostname => { assert.equal(hostname, 'papers.example.org'); return [{ address: '93.184.216.34', family: 4 }]; },
    request: async (target, options) => {
      calls.publicTargets.push(target.url.href); assert.equal(target.address, '93.184.216.34');
      return new Promise((resolve, reject) => {
        const request = http.request({ host: '127.0.0.1', port: upstream.address().port, path: target.url.pathname + target.url.search, signal: options.signal, headers: { Host: target.url.host } }, resolve);
        request.once('error', reject); request.end();
      });
    },
  };
  const boot = async () => { app = await startServer({ dataDir, port: 0, assistantWebDependencies }); assert.notEqual(new URL(app.url).port, '4417'); };
  t.after(async () => {
    await app?.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => upstream.close(resolve));
    assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir())); assert.ok(path.basename(dataDir).startsWith('gx-assistant-download-http-'));
    await rm(dataDir, { recursive: true, force: true });
  });
  await boot();
  const settings = { baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: secret, model: 'local-fixture', timeoutSeconds: 10 };
  async function json(route, body, method = body === undefined ? 'GET' : 'POST', expected = 200) {
    const response = await fetch(app.url + route, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
    const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result)); return result;
  }
  async function run(body) {
    const started = await json('/api/assistant/runs', { settings, ...body }, 'POST', 202);
    for (let count = 0; count < 600; count++) {
      const { job } = await json('/api/assistant/runs/' + started.runId);
      if (['completed', 'failed', 'cancelled', 'interrupted'].includes(job.status)) return job;
      await delay(20);
    }
    throw new Error('HTTP assistant run did not finish');
  }
  return { dataDir, pdf, calls, settings, json, run, get url() { return app.url; }, setPlan(value) { plan = value; }, async restart() { await app.close(); await boot(); } };
}

test('real assistant HTTP download/import preserves original PDF bytes, download effects and restart history without replay', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  f.setPlan(context => context.observations.length ? { type: 'final', message: '原文件已下载，可保存到电脑。[S1]', sourceIds: ['S1'] } : { type: 'tool', tool: 'web_download', arguments: { url: sourceUrl }, summary: '下载论文原文件' });
  const downloaded = await f.run({ instruction: `请下载 ${sourceUrl} 原文件` });
  assert.equal(downloaded.status, 'completed', JSON.stringify(downloaded)); assert.equal(downloaded.projectId, null);
  const file = downloaded.effects.find(effect => effect.type === 'download')?.download;
  assert.ok(file, JSON.stringify(downloaded)); assert.equal(file.name, '双语原始论文.pdf'); assert.equal(file.sha256, hash(f.pdf)); assert.equal(file.size, f.pdf.length);
  assert.equal(file.canImport, true); assert.equal(downloaded.sources[0].url, sourceUrl);
  assert.equal((await f.json('/api/projects')).projects.length, 0, 'Downloading does not create a hidden project');
  const response = await fetch(f.url + file.downloadUrl);
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'application/octet-stream'); assert.match(response.headers.get('content-disposition'), /attachment;.*filename\*=UTF-8''/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.pdf);
  const head = await fetch(f.url + file.downloadUrl, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(f.pdf.length));
  await f.json('/api/projects/science-download-target', { kind: 'science', title: '原文件导入目标', source: { title: '', text: '', url: '' }, facts: [], brief: {}, science: {} }, 'PUT');
  f.setPlan(context => {
    if (!context.observations.length) return { type: 'tool', tool: 'download_list', arguments: {}, summary: '找回已保存的原文件' };
    if (context.observations.length === 1) {
      const listed = context.observations[0].result.data.downloads; assert.equal(listed.length, 1);
      return { type: 'tool', tool: 'download_import', arguments: { downloadId: listed[0].id }, summary: '从原文件解析并导入科普资料' };
    }
    return { type: 'final', message: '已从原PDF导入资料，等待你选择页段。[S1]', sourceIds: ['S1'] };
  });
  const imported = await f.run({ projectId: 'science-download-target', instruction: '请把刚才已下载的原始PDF导入当前科普项目' });
  assert.equal(imported.status, 'completed', JSON.stringify(imported));
  const listedEffect = imported.effects.find(effect => effect.type === 'download'); assert.equal(listedEffect.changed, false); assert.equal(listedEffect.download.id, file.id);
  const documentEffect = imported.effects.find(effect => effect.type === 'document'); assert.ok(documentEffect?.undo?.id);
  const { documents } = await f.json('/api/projects/science-download-target/science-documents'); assert.equal(documents.length, 1); assert.equal(documents[0].sourceHash, hash(f.pdf)); assert.equal(documents[0].pageCount, 3);
  const { document } = await f.json('/api/projects/science-download-target/science-documents/' + documents[0].id);
  assert.ok(document.units.some(unit => unit.text.includes('牛顿第二定律')));
  assert.deepEqual(await readFile(path.join(f.dataDir, 'science-documents', 'science-download-target', document.id, 'source.pdf')), f.pdf);
  const owner = (await f.json('/api/projects/science-download-target')).project;
  assert.equal(owner.science.documentSelection, undefined, 'Import leaves page selection to the user');
  await f.json('/api/assistant/undo', { projectId: owner.id, undoId: documentEffect.undo.id });
  assert.equal((await f.json('/api/projects/science-download-target/science-documents')).documents.length, 0);
  assert.deepEqual(Buffer.from(await (await fetch(f.url + file.downloadUrl)).arrayBuffer()), f.pdf, 'Undo import keeps the saved original file');
  assert.equal(f.calls.pdf, 1); assert.deepEqual(f.calls.publicTargets, [sourceUrl]);
  const modelCalls = f.calls.model;
  await f.restart();
  assert.equal(f.calls.model, modelCalls); assert.equal(f.calls.pdf, 1, 'Restart never replays network/model work');
  const restored = (await f.json('/api/assistant/runs/' + downloaded.id)).job;
  assert.equal(restored.status, 'completed'); assert.equal(restored.effects[0].download.downloadUrl, file.downloadUrl);
  assert.equal((await f.json('/api/assistant/downloads')).downloads[0].sha256, hash(f.pdf));
  assert.deepEqual(Buffer.from(await (await fetch(f.url + file.downloadUrl)).arrayBuffer()), f.pdf);
  const persisted = await readFile(path.join(f.dataDir, 'assistant', 'runs.json'), 'utf8'); assert.ok(!persisted.includes(secret) && !persisted.includes('%PDF-'));
});

test('ask mode over real assistant HTTP cannot download a file even if the model requests the write tool', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  f.setPlan(context => context.observations.length ? { type: 'final', message: '这里只说明下载方法，尚未保存文件。', sourceIds: [] } : { type: 'tool', tool: 'web_download', arguments: { url: sourceUrl }, summary: '不应执行的下载' });
  const job = await f.run({ instruction: `请下载 ${sourceUrl}`, mode: 'ask' });
  assert.equal(job.status, 'completed', JSON.stringify(job)); assert.deepEqual(job.effects, []);
  assert.equal(job.steps.find(step => step.tool === 'web_download').status, 'failed');
  assert.equal(f.calls.pdf, 0); assert.deepEqual(f.calls.publicTargets, []);
  assert.deepEqual((await f.json('/api/assistant/downloads')).downloads, []);
});
