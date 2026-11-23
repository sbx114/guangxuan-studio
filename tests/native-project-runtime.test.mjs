import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { access, copyFile, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { copyOpenFilmRuntime } from '../scripts/package-openfilm-runtime.mjs';
import { filmHtml } from '../integrations/openfilm/packages/openfilm/src/film-doc.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appFiles = ['lib/openfilm-worker.mjs', 'lib/git-runtime.mjs', 'lib/errors.mjs', 'lib/native-export-capabilities.mjs', 'lib/native-export-download.mjs', 'lib/native-project-capabilities.mjs', 'lib/native-html-source.mjs', 'lib/native-caption-edits.mjs', 'lib/native-caption-look.mjs', 'lib/native-text-look.mjs', 'lib/native-word-effects.mjs', 'lib/native-caption-library.mjs', 'lib/native-subtitle-style.mjs'];

test('copied installation runtime runs project/canvas capabilities and full VTT style without UI TypeScript sources', { timeout: 240000 }, async t => {
  const parent = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'gx-native-project-runtime-')), appRoot = path.join(directory, 'resources', 'app'), library = path.join(directory, 'data', 'projects'), projectRoot = path.join(library, 'current');
  const home = path.join(directory, 'data', 'state'), exports = path.join(directory, 'data', 'exports'), saved = path.join(directory, 'data', 'saved');
  let running;
  t.after(async () => {
    await running?.close();
    assert.equal(path.dirname(directory), parent); assert.ok(path.basename(directory).startsWith('gx-native-project-runtime-'));
    await rm(directory, { recursive: true, force: true });
  });
  const inventory = await copyOpenFilmRuntime(appRoot, root);
  assert.deepEqual(await readFile(path.join(appRoot, 'integrations/openfilm/packages/openfilm/lib/music-rhythm.mjs')), await readFile(path.join(root, 'integrations/openfilm/packages/openfilm/lib/music-rhythm.mjs')));
  for (const relative of appFiles) { const to = path.join(appRoot, relative); await mkdir(path.dirname(to), { recursive: true }); await copyFile(path.join(root, relative), to); }
  const playwright = path.dirname(await realpath(fileURLToPath(import.meta.resolve('playwright-core/package.json'))));
  await cp(playwright, path.join(appRoot, 'node_modules', 'playwright-core'), { recursive: true, dereference: true });
  await writeFile(path.join(appRoot, 'package.json'), JSON.stringify({ type: 'module' }));
  await assert.rejects(access(path.join(appRoot, 'integrations/openfilm/packages/openfilm/studio/ui/src')), { code: 'ENOENT' });
  const subtitle = await import(pathToFileURL(path.join(appRoot, 'lib', 'native-subtitle-style.mjs')).href), captions = await import(pathToFileURL(path.join(appRoot, 'integrations/openfilm/packages/openfilm/src/captions.mjs')).href);
  const styled = subtitle.applySubtitleStyle(captions.readVtt('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n<00:00:00.000>Runtime subtitle\n'), { variables: { '--color': '#EEDD88', '--size': '6cqmin' }, wordEffect: 'pop' });
  assert.equal(subtitle.subtitleStyleSummary(styled).wordEffect.id, 'pop'); assert.ok(styled.styles.join('\n').includes('#EEDD88')); assert.equal(styled.cues.length, 1);
  for (const folder of [home, exports, saved, path.join(projectRoot, 'pages')]) await mkdir(folder, { recursive: true });
  const source = '<!doctype html><body><h1 id="title">Version A</h1><script>window.film={duration:3,frame(t){}};</script></body>';
  await writeFile(path.join(projectRoot, 'pages', 'scene.html'), source);
  await writeFile(path.join(projectRoot, 'film.html'), filmHtml({ stage: { w: 320, h: 180 }, tracks: [{ clips: [{ id: 'hero', src: 'pages/scene.html', at: 0, time: [0, 3], size: { w: 320, h: 180 } }] }] }));
  async function start() {
    const calls = new Map(); let readyResolve, readyReject, stderr = '';
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const worker = fork(path.join(appRoot, 'lib', 'openfilm-worker.mjs'), [], { cwd: appRoot, execArgv: [], windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env, GUANGXUAN_OPENFILM_ENTRY: path.join(appRoot, 'integrations/openfilm/packages/openfilm/studio/server/server.mjs'), OPENFILM_HOME: home, OPENFILM_SHARED_HOME: home, OPENFILM_LIBRARY: library, OPENFILM_EXPORTS: exports, OPENFILM_SAVED: saved, OPENFILM_LOCAL_ONLY: '1', OPENFILM_NO_UPDATE_CHECK: '1', OPENFILM_TRASH_DIR: path.join(directory, 'data', 'trash') } });
    const closed = new Promise(resolve => worker.once('close', resolve)), timer = setTimeout(() => readyReject(new Error('Native worker startup timeout: ' + stderr)), 30000);
    worker.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-4000); });
    worker.on('message', message => {
      if (message.type === 'ready') { clearTimeout(timer); readyResolve(message); return; }
      if (message.type === 'failed') { clearTimeout(timer); readyReject(new Error(message.error)); return; }
      const call = calls.get(message.id); if (!call) return; clearTimeout(call.timer); calls.delete(message.id);
      if (message.error) call.reject(Object.assign(new Error(message.error), { code: message.code, status: message.status })); else call.resolve(message.result);
    });
    worker.once('exit', () => { clearTimeout(timer); readyReject(new Error('Worker exited: ' + stderr)); for (const call of calls.values()) { clearTimeout(call.timer); call.reject(new Error('Worker exited.')); } calls.clear(); });
    const rpc = (action, values = {}) => new Promise((resolve, reject) => { const id = randomUUID(), timer = setTimeout(() => { calls.delete(id); reject(new Error('Worker operation timed out.')); }, 90000); calls.set(id, { resolve, reject, timer }); worker.send({ id, action, ...values }); });
    const result = { rpc, async close() { if (worker.connected) { try { await rpc('close'); } catch { worker.kill(); } } await closed; } };
    running = result;
    const info = await ready; assert.equal(info.gitAvailable, true);
    const opened = await rpc('open', { folder: projectRoot }); result.nativeProjectId = opened.nativeProjectId;
    result.read = (section, args = {}) => rpc('project-read', { nativeProjectId: result.nativeProjectId, section, args });
    result.edit = async (section, operation, args) => { const before = await result.read(section, section === 'page' ? { path: args.path } : {}); return rpc('project-edit', { nativeProjectId: result.nativeProjectId, section, operation, expectedRevision: before.revision, expectedFilmRevision: before.filmRevision, args }); };
    return result;
  }
  let worker = await start();
  const emptyCanvas = await worker.read('canvas');
  const canvasChanged = await worker.edit('canvas', 'apply', { ops: [{ op: 'add', kind: 'note', id: 'note-one', text: '真实复制运行结构的画板节点' }, { op: 'add', kind: 'file', id: 'page-node', path: 'pages/scene.html', inputs: ['note-one'] }] });
  assert.equal(canvasChanged.filmRevision, emptyCanvas.filmRevision); assert.equal(canvasChanged.data.total, 2);
  await assert.rejects(worker.rpc('project-edit', { nativeProjectId: worker.nativeProjectId, section: 'canvas', operation: 'apply', expectedRevision: emptyCanvas.revision, args: { ops: [{ op: 'remove', id: 'note-one' }] } }), { code: 'NATIVE_PROJECT_REVISION_CONFLICT' });
  const pages = await worker.read('page'); assert.equal(pages.data.pages[0].path, 'pages/scene.html');
  const mark = await worker.edit('markers', 'add', { marker: { id: 'mark-one', t: 1, name: '主动作落定', color: 'green' } }); assert.equal(mark.data.markers[0].t, 1);
  const changed = await worker.edit('page', 'text', { path: 'pages/scene.html', target: [0], text: 'Transient edit' });
  await worker.close(); worker = await start();
  await worker.rpc('project-undo', { nativeProjectId: worker.nativeProjectId, undoId: changed.undo.id }); assert.equal(await readFile(path.join(projectRoot, 'pages/scene.html'), 'utf8'), source);
  await worker.rpc('project-undo', { nativeProjectId: worker.nativeProjectId, undoId: canvasChanged.undo.id }); assert.equal((await worker.read('canvas')).data.total, 0);
  const createdBoard = await worker.edit('canvas', 'create', { name: '真实画板' }), boardId = createdBoard.data.boardId;
  await worker.edit('canvas', 'rename', { board: boardId, name: '已重命名画板' });
  const deletedBoard = await worker.edit('canvas', 'remove', { board: boardId }); assert.equal(deletedBoard.data.boards.length, 1);
  await worker.rpc('project-undo', { nativeProjectId: worker.nativeProjectId, undoId: deletedBoard.undo.id }); assert.equal((await worker.read('canvas', { board: boardId })).data.canvas.name, '已重命名画板');
  const savedA = await worker.edit('history', 'save', { message: 'Version A' }); assert.equal(savedA.undo, null); const commitA = savedA.data.status.head; assert.match(commitA, /^[a-f0-9]{40}$/);
  await worker.edit('page', 'text', { path: 'pages/scene.html', target: [0], text: 'Version B' });
  const restored = await worker.edit('history', 'revert', { commit: commitA }); assert.ok((await readFile(path.join(projectRoot, 'pages/scene.html'), 'utf8')).includes('Version A'));
  const history = await worker.read('history', { commit: commitA }); assert.ok(history.data.diff.files.some(item => item.path === 'pages/scene.html'));
  await worker.rpc('project-undo', { nativeProjectId: worker.nativeProjectId, undoId: restored.undo.id }); assert.ok((await readFile(path.join(projectRoot, 'pages/scene.html'), 'utf8')).includes('Version B'));
  await assert.rejects(worker.read('page', { path: '../outside.html' }), { code: 'NATIVE_PROJECT_INVALID' });
  const evidence = process.env.GUANGXUAN_NATIVE_PROJECT_EVIDENCE;
  if (evidence) { await mkdir(evidence, { recursive: true }); await writeFile(path.join(evidence, 'copied-runtime-verification.json'), JSON.stringify({ status: 'passed', actualWorker: true, actualNativeCore: true, copiedRuntimeInventory: true, nativeRuntimeFiles: inventory.copiedFiles, copiedAppFiles: appFiles, uiTypeScriptPresent: false, actualMarkers: true, actualPageEdit: true, durableUndoAfterWorkerRestart: true, actualCanvasApplyAndFileHashCAS: true, durableCanvasUndoAfterWorkerRestart: true, actualCanvasBoardCreateRenameRemoveUndo: true, actualVttStyleAndWordEffectFromCopiedApp: true, systemTrashUsed: false, actualHistorySaveDiffRevertUndo: true, usedRealUserData: false, usedUserKeys: false, requested4417: false }, null, 2)); }
});
