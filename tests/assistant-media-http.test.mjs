import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { startServer } from '../server.mjs';

const bin = process.env.GUANGXUAN_BIN_DIR, command = promisify(execFile);
const publicHost = 'media.example.org', videoUrl = `https://${publicHost}/lecture.mp4`, imageUrl = `https://${publicHost}/scan.png`;
const key = 'fixture-media-http-no-user-key', asrText = '实际受控ASR返回：对照实验需要只改变待研究因素，并保持其他条件相同。';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function evidence(name, value) {
  if (!process.env.GUANGXUAN_MEDIA_HTTP_EVIDENCE) return;
  const folder = path.resolve(process.env.GUANGXUAN_MEDIA_HTTP_EVIDENCE); await mkdir(folder, { recursive: true }); await writeFile(path.join(folder, name + '.json'), JSON.stringify(value, null, 2));
}

async function fixture(t, { kind = 'video', videoSeconds = 3.2 } = {}) {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'gx-assistant-media-http-')), dataDir = path.join(folder, 'data');
  const source = path.join(folder, kind === 'image' ? 'scan.png' : 'lecture.mp4');
  const args = kind === 'image'
    ? ['-f', 'lavfi', '-i', 'color=c=white:s=480x320', '-vf', "drawtext=font='Arial':text='F = m a':fontcolor=black:fontsize=38:x=20:y=20", '-frames:v', '1', source]
    : ['-f', 'lavfi', '-i', `color=c=navy:s=160x90:r=15:d=${videoSeconds}`, '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=16000:duration=${videoSeconds}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source];
  await command(path.join(bin, 'ffmpeg.exe'), ['-hide_banner', '-nostdin', '-v', 'error', ...args], { windowsHide: true, timeout: 30000 });
  const bytes = await readFile(source), calls = { downloads: 0, agent: 0, edits: [], visions: [], asr: [], transport: [], errors: [] };
  let plan, app;
  const sockets = new Set();
  const provider = http.createServer(async (req, res) => {
    try {
      if (['/lecture.mp4', '/scan.png'].includes(req.url)) {
        calls.downloads++; assert.equal(req.headers.host, publicHost); assert.equal(req.headers.authorization, undefined);
        res.writeHead(200, { 'content-type': kind === 'image' ? 'image/png' : 'video/mp4', 'content-length': bytes.length, 'content-disposition': `attachment; filename="${kind === 'image' ? 'scan.png' : 'lecture.mp4'}"` }); res.end(bytes); return;
      }
      assert.equal(req.headers.authorization, 'Bearer ' + key);
      const raw = Buffer.concat(await Array.fromAsync(req));
      if (req.url === '/v1/audio/transcriptions') {
        assert.match(req.headers['content-type'], /^multipart\/form-data/);
        const form = await new Response(raw, { headers: { 'content-type': req.headers['content-type'] } }).formData();
        const file = Buffer.from(await form.get('file').arrayBuffer()); assert.equal(file.subarray(0, 4).toString(), 'RIFF'); assert.equal(file.subarray(8, 12).toString(), 'WAVE'); assert.ok(file.length > 1000);
        assert.equal(form.get('model'), 'whisper-1'); calls.asr.push({ bytes: file.length, sha256: sha(file), model: form.get('model'), responseFormat: form.get('response_format') });
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ text: asrText, segments: [{ start: 0, end: 1.1, text: asrText }], language: 'zh' })); return;
      }
      assert.equal(req.url, '/v1/chat/completions');
      const body = JSON.parse(raw.toString()), content = body.messages[1].content;
      const payload = JSON.parse(Array.isArray(content) ? content.find(part => part.type === 'text').text : content);
      let output;
      if (Array.isArray(content) && payload.coverage && payload.source) {
        const images = content.filter(part => part.type === 'image_url').map(part => part.image_url.url);
        assert.equal(images.length, payload.frames.length); assert.ok(images.length > 0);
        const imageEvidence = images.map(image => { assert.match(image, /^data:image\/(?:jpeg|png|webp);base64,/); const bytes = Buffer.from(image.split(',')[1], 'base64'); assert.ok(bytes.length > 100); return { bytes: bytes.length, sha256: sha(bytes) }; });
        assert.ok(!JSON.stringify(body).includes(folder) && !JSON.stringify(body).includes(key));
        calls.visions.push({ payload, images: imageEvidence });
        output = { usable: true, title: kind === 'image' ? '牛顿第二定律图示' : '控制变量视频讲解', frames: payload.frames.map(frame => ({ index: frame.index, visibleText: kind === 'image' ? 'F = m a' : '', description: kind === 'image' ? '白色背景上可见F、m和a的公式。' : '抽样画面为深蓝色背景；音频内容单独记录。', keyPoints: kind === 'image' ? ['所示公式需要结合原图与教材核对。'] : [], uncertainties: ['这是本机模型协议夹具返回，实际内容引用前需复核。'] })), warnings: [] };
      } else if (payload['当前工程']) {
        const context = payload['当前工程']; calls.edits.push(payload);
        assert.equal(context.assets.length, 1); const asset = context.assets[0]; assert.ok(asset.duration >= 20);
        output = { action: 'edit', message: '已拟定20秒原生剪辑。', plan: { timeline: [{ assetId: asset.id, start: 0, end: 20 }], captions: [{ start: 0, end: 3, text: '20秒宣传片 · 隔离媒体测试', placement: 'title' }] } };
      } else { calls.agent++; output = plan(payload); }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] }));
    } catch (error) { calls.errors.push(error.stack || error.message); if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }); if (!res.writableEnded) res.end(JSON.stringify({ error: 'controlled fixture rejected an unexpected request' })); }
  });
  provider.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const dependencies = {
    lookup: async host => { assert.equal(host, publicHost); return [{ address: '93.184.216.34', family: 4 }]; },
    request: async (target, options) => {
      assert.equal(target.address, '93.184.216.34'); calls.transport.push(target.url.href);
      return new Promise((resolve, reject) => { const request = http.request({ host: '127.0.0.1', port: provider.address().port, path: target.url.pathname + target.url.search, signal: options.signal, headers: { Host: target.url.host } }, resolve); request.once('error', reject); request.end(); });
    },
  };
  app = await startServer({ port: 0, dataDir, assistantWebDependencies: dependencies, assistantVideoDependencies: dependencies }); assert.notEqual(new URL(app.url).port, '4417');
  t.after(async () => { await app?.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => provider.close(resolve)); assert.equal(path.dirname(folder), os.tmpdir()); assert.ok(path.basename(folder).startsWith('gx-assistant-media-http-')); await rm(folder, { recursive: true, force: true }); });
  const settings = { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: key, model: 'media-http-fixture', timeoutSeconds: 30 };
  const json = async (route, body, method = body === undefined ? 'GET' : 'POST', expected = 200) => { const response = await fetch(app.url + route, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }); const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result)); return result; };
  const run = async body => {
    const started = await json('/api/assistant/runs', { settings, ...body }, 'POST', 202);
    for (let count = 0; count < 1200; count++) { const { job } = await json('/api/assistant/runs/' + started.runId); if (['completed', 'failed', 'cancelled', 'interrupted'].includes(job.status)) return job; await pause(20); }
    throw new Error('Assistant media fixture timed out');
  };
  return { dataDir, folder, bytes, calls, json, run, get url() { return app.url; }, setPlan(value) { plan = value; } };
}

test('real assistant HTTP imports a URL video into an empty selection and edits the canonical asset into a 20-second native film', { skip: !bin, timeout: 60000 }, async t => {
  const f = await fixture(t, { videoSeconds: 21 });
  const original = (await f.json('/api/projects/video-http', { kind: 'video', title: '隔离20秒宣传片', video: { timeline: [], captions: [], editScope: { assetIds: [], placement: { mode: 'append' } }, aspect: '16:9', resolution: '720' } }, 'PUT')).project;
  f.setPlan(context => {
    const index = context.observations.length;
    if (index === 0) return { type: 'tool', tool: 'media_import_url', arguments: { url: videoUrl, kind: 'video' }, summary: '下载并导入可编辑视频素材' };
    if (index === 1) { assert.equal(context.observations[0].result.data.imported, true); return { type: 'tool', tool: 'native_read', arguments: {}, summary: '读取真实工程素材ID' }; }
    if (index === 2) { assert.equal(context.observations[1].result.data.assets.length, 1); assert.equal(context.observations[1].result.data.duration, 0); return { type: 'tool', tool: 'native_edit', arguments: { instruction: '用刚导入的素材制作20秒宣传片，添加标题。' }, summary: '执行20秒剪辑' }; }
    assert.equal(context.observations[2].status, 'completed'); assert.equal(context.observations[2].result.data.duration, 20);
    return { type: 'final', message: '原生工程已完成20秒剪辑。[S1]', sourceIds: ['S1'] };
  });
  const job = await f.run({ projectId: original.id, instruction: `请下载导入 ${videoUrl} 并制作20秒宣传片`, editScope: original.video.editScope });
  assert.equal(job.status, 'completed', JSON.stringify({ job, fixtureErrors: f.calls.errors })); assert.deepEqual(f.calls.errors, []);
  const media = job.effects.find(effect => effect.type === 'media' && effect.importedAssetId); assert.ok(media);
  const current = await f.json('/api/openfilm/context?projectId=' + original.id);
  assert.equal(current.duration, 20); assert.equal(current.timeline.length, 1); assert.equal(current.timeline[0].assetId, media.importedAssetId); assert.equal(current.timeline[0].end, 20);
  const saved = (await f.json('/api/projects/' + original.id)).project;
  await evidence('http-native-video-20s-policy-observed', { originalScope: original.video.editScope, persistedScope: saved.video.editScope, importScope: media.editScope, effectiveEditScope: f.calls.edits[0]['用户选定范围与位置'], originalAssistantRevision: original.assistantRevision, savedAssistantRevision: saved.assistantRevision, originalMetadataRevision: original.metadataRevision, savedMetadataRevision: saved.metadataRevision, canonicalAssetId: media.importedAssetId, duration: current.duration, projectEffects: job.effects.filter(effect => effect.type === 'project').map(effect => effect.label) });
  // Dialog authority may use the whole current project, while the older empty
  // UI selection remains a preference rather than an implicit write target.
  assert.deepEqual(saved.video.editScope, original.video.editScope, 'Importing and editing must not silently expand the stored UI selection');
  assert.deepEqual(media.editScope, { placement: { mode: 'append' } });
  assert.equal(job.effects.some(effect => effect.type === 'project' && /选择|选中/.test(effect.label || '')), false, 'Native import does not claim a selection-writing project commit');
  assert.equal(f.calls.edits.length, 1); assert.deepEqual(f.calls.edits[0]['用户选定范围与位置'], { placement: { mode: 'append' } }); assert.equal(f.calls.downloads, 1);
  // Metadata has its own optimistic revision. An autosave based on the latest
  // content may succeed after a rename, but must keep the newer title and film.
  const staleAutosave = structuredClone(saved);
  const renamed = (await f.json('/api/projects/' + original.id, { title: '必须保留的并发项目名称' }, 'PATCH')).project;
  assert.ok(renamed.metadataRevision > saved.metadataRevision);
  await f.json('/api/projects/' + original.id, staleAutosave, 'PUT');
  const afterAutosave = (await f.json('/api/projects/' + original.id)).project;
  assert.equal(afterAutosave.title, renamed.title); assert.equal(afterAutosave.metadataRevision, renamed.metadataRevision); assert.deepEqual(afterAutosave.video.editScope, original.video.editScope);
  const filmAfterAutosave = await f.json('/api/openfilm/context?projectId=' + original.id);
  assert.equal(filmAfterAutosave.duration, 20); assert.deepEqual(filmAfterAutosave.timeline, current.timeline);
  // The full project remains readable. The dialogue's range is returned as a
  // separate write boundary; overview metadata is the actual untrimmed film.
  let explicitScope;
  f.setPlan(context => {
    if (!context.observations.length) return { type: 'tool', tool: 'native_read', arguments: {}, summary: '读取当前工程概览和对话指定的2至5秒边界' };
    const observed = context.observations[0]; assert.equal(observed.status, 'completed');
    explicitScope = observed.result.data.editScope;
    assert.deepEqual(explicitScope.placement, { mode: 'range', start: 2, end: 5 });
    assert.equal(observed.result.data.timeline.length, 1); assert.equal(observed.result.data.timeline[0].assetId, media.importedAssetId);
    assert.equal(observed.result.data.timeline[0].at, 0); assert.equal(observed.result.data.timeline[0].start, 0); assert.equal(observed.result.data.timeline[0].end, 20);
    return { type: 'final', message: '已读取真实工程概览，2至5秒边界已单列；未改动工程。', sourceIds: [] };
  });
  const rangedRead = await f.run({ projectId: original.id, instruction: '只读取2到5秒范围，不修改任何内容', mode: 'ask', editScope: original.video.editScope });
  assert.equal(rangedRead.status, 'completed', JSON.stringify({ job: rangedRead, fixtureErrors: f.calls.errors })); assert.deepEqual(f.calls.errors, []); assert.deepEqual(rangedRead.effects, []);
  assert.deepEqual((await f.json('/api/openfilm/context?projectId=' + original.id)).timeline, current.timeline);
  const mediaResponse = await fetch(f.url + current.assets.find(asset => asset.id === media.importedAssetId).url); assert.equal(sha(Buffer.from(await mediaResponse.arrayBuffer())), sha(f.bytes));
  await evidence('http-native-video-20s', { passed: true, sourceSha256: sha(f.bytes), canonicalAssetId: media.importedAssetId, duration: current.duration, timeline: current.timeline, persistedScope: saved.video.editScope, uiSelectionUnchanged: true, effectiveDialogScope: media.editScope, explicitDialogScope: explicitScope, readOnlyFollowupChangedNothing: true, concurrentMetadataPreserved: afterAutosave.title === renamed.title && afterAutosave.metadataRevision === renamed.metadataRevision, assistantRevision: saved.assistantRevision, requests: { media: f.calls.downloads, agent: f.calls.agent, edit: f.calls.edits.length } });
});

async function scienceProject(f, id) {
  const project = (await f.json('/api/projects/' + id, { kind: 'science', title: '科普识别导入', source: { text: '' }, science: { novelConfig: { selectedCharacterId: 'keep-character', selectedBackgroundId: 'keep-scene', interactionDensity: 'dense' } } }, 'PUT')).project;
  const imported = await f.json(`/api/projects/${id}/science-documents/text`, { title: '当前选择的原有资料', text: '原有资料只用于验证当前选择不被媒体识别导入替换。'.repeat(4) }, 'POST', 201);
  project.science.documentSelection = { documentId: imported.document.id, unitIds: [imported.document.units[0].id] };
  return (await f.json('/api/projects/' + id, project, 'PUT')).project;
}
function sciencePlan(url, kind) { return context => context.observations.length ? { type: 'final', message: '识别资料已导入，原有设置保留。[S1]', sourceIds: ['S1'] } : { type: 'tool', tool: 'media_import_url', arguments: { url, kind }, summary: '读取媒体内容并导入科普资料' }; }

test('real assistant HTTP downloads an image, sends actual visual blocks and imports sourced OCR without changing selected science assets/pages', { skip: !bin, timeout: 60000 }, async t => {
  const f = await fixture(t, { kind: 'image' }), original = await scienceProject(f, 'science-image-http');
  f.setPlan(sciencePlan(imageUrl, 'image'));
  const job = await f.run({ projectId: original.id, instruction: `请下载识别 ${imageUrl} 图片中的知识并导入当前科普资料库` });
  assert.equal(job.status, 'completed', JSON.stringify({ job, fixtureErrors: f.calls.errors })); assert.deepEqual(f.calls.errors, []);
  const docs = (await f.json(`/api/projects/${original.id}/science-documents`)).documents; assert.equal(docs.length, 2);
  const added = docs.find(doc => doc.id !== original.science.documentSelection.documentId); assert.ok(added);
  const { document } = await f.json(`/api/projects/${original.id}/science-documents/${added.id}`), text = document.units.map(unit => unit.text).join('\n');
  assert.match(text, /F = m a/); assert.ok(text.includes(imageUrl)); assert.match(text, /AI OCR，非人工校对/);
  const saved = (await f.json('/api/projects/' + original.id)).project; assert.deepEqual(saved.science, original.science);
  assert.equal(f.calls.visions.length, 1); assert.equal(f.calls.visions[0].images.length, 1); assert.equal(f.calls.visions[0].payload.transcriptStatus, 'not-applicable'); assert.equal(f.calls.asr.length, 0);
  const downloaded = (await f.json('/api/assistant/downloads?projectId=' + original.id)).downloads; assert.equal(downloaded.length, 1); assert.equal(downloaded[0].sha256, sha(f.bytes));
  assert.equal(sha(Buffer.from(await (await fetch(f.url + downloaded[0].downloadUrl)).arrayBuffer())), sha(f.bytes));
  const rawText = await readFile(path.join(f.dataDir, 'science-documents', original.id, added.id, 'source.txt'), 'utf8'); assert.ok(rawText.includes('F = m a') && rawText.includes(imageUrl));
  await evidence('http-science-image-ocr', { passed: true, originalSha256: sha(f.bytes), documentId: added.id, sourceUrl: imageUrl, actualImageBlocks: f.calls.visions[0].images, selectedPagesUnchanged: true, personaSceneUnchanged: true, rawTextSha256: sha(rawText) });
});

test('real assistant HTTP samples a complete twelve-frame source page, extracts real WAV and imports bounded sourced knowledge', { skip: !bin, timeout: 60000 }, async t => {
  const f = await fixture(t, { videoSeconds: 3.2 }), original = await scienceProject(f, 'science-video-http');
  f.setPlan(sciencePlan(videoUrl, 'video'));
  const job = await f.run({ projectId: original.id, instruction: `请处理 ${videoUrl} 视频的画面和音频，整理知识后导入当前科普资料库` });
  assert.equal(job.status, 'completed', JSON.stringify({ job, fixtureErrors: f.calls.errors })); assert.deepEqual(f.calls.errors, []);
  const docs = (await f.json(`/api/projects/${original.id}/science-documents`)).documents, added = docs.find(doc => doc.id !== original.science.documentSelection.documentId); assert.equal(docs.length, 2); assert.ok(added);
  const { document } = await f.json(`/api/projects/${original.id}/science-documents/${added.id}`), text = document.units.map(unit => unit.text).join('\n');
  assert.ok(text.includes(asrText) && text.includes(videoUrl)); assert.match(text, /实际音频转写（AI ASR，非人工校对）/); assert.match(text, /视频抽样范围：00:00.000—00:03.200/); assert.match(text, /共12帧，未逐帧/);
  assert.equal(f.calls.asr.length, 1); assert.ok(f.calls.asr[0].bytes > 1000); assert.equal(f.calls.visions.length, 1);
  const visual = f.calls.visions[0]; assert.equal(visual.images.length, 12); assert.equal(visual.payload.transcriptStatus, 'complete'); assert.equal(visual.payload.transcript.text, asrText); assert.equal(visual.payload.coverage.frameByFrame, false); assert.equal(visual.payload.coverage.frameCount, 12);
  const actualTimes = visual.payload.frames.map(frame => frame.timestamp);
  assert.deepEqual(actualTimes, Array.from({ length: 12 }, (_, index) => Math.round(3.2 * (index + 1) / 13 * 1000) / 1000));
  assert.deepEqual(visual.payload.coverage.timestamps, actualTimes);
  assert.deepEqual(visual.payload.coverage.framePagination, { offset: 0, returned: 12, plannedFrames: 12, plannedPageHonored: true, hasMore: false, nextOffset: null });
  assert.equal(visual.payload.coverage.nextRangeStart, null); assert.equal(visual.payload.coverage.truncated, false);
  assert.deepEqual((await f.json('/api/projects/' + original.id)).project.science, original.science);
  assert.deepEqual(await readdir(path.join(f.dataDir, 'source-analysis', '.work')), []);
  const rawText = await readFile(path.join(f.dataDir, 'science-documents', original.id, added.id, 'source.txt'), 'utf8'); assert.ok(rawText.includes(asrText));
  await evidence('http-science-video-asr', { passed: true, sourceSha256: sha(f.bytes), documentId: added.id, sourceUrl: videoUrl, actualWav: f.calls.asr[0], frames: visual.images, coverage: visual.payload.coverage, transcriptStatus: visual.payload.transcriptStatus, rawTextSha256: sha(rawText), currentSelectionAndProfilesUnchanged: true });
});
