import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { access, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createProjectStore } from '../lib/store.mjs';
import { createOpenFilmManager } from '../lib/openfilm.mjs';
import { readFilmFile } from '../integrations/openfilm/packages/openfilm/src/film-doc.mjs';

const root = path.resolve(import.meta.dirname, '..'), require = createRequire(import.meta.url), childProcess = require('node:child_process'), fs = require('node:fs/promises');
async function fixture(t) {
  const parent = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(parent, { recursive: true }); const directory = await mkdtemp(path.join(parent, 'gx-native-commit-')), dataDir = path.join(directory, 'data');
  const store = await createProjectStore(dataDir), projectId = 'native-commit-fixture'; await store.save(projectId, { kind: 'video', title: 'Synthetic transaction fixture', video: { timeline: [], captions: [] } });
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = 'http://127.0.0.1:' + server.address().port; assert.notEqual(new URL(origin).port, '4417');
  const manager = await createOpenFilmManager({ dataDir, root, store });
  t.after(async () => { await manager.close(); await store.settle(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); assert.equal(path.dirname(directory), parent); await rm(directory, { recursive: true, force: true }); });
  const current = await manager.context(projectId, origin), home = path.join(dataDir, 'openfilm/projects', projectId), film = path.join(home, 'film.html');
  return { manager, projectId, origin, current, home, film };
}

test('known cancellation after generated files but before native submission cleans only the uncommitted files', { skip: process.env.GUANGXUAN_TEST_OPENFILM !== '1', timeout: 60000 }, async t => {
  const f = await fixture(t), before = await readFile(f.film, 'utf8'), controller = new AbortController(), realWrite = fs.writeFile;
  let generatedFile;
  fs.writeFile = async (filename, ...args) => { const result = await realWrite(filename, ...args); if (String(filename).startsWith(f.home + path.sep) && /gx-operation-.*\.html$/.test(String(filename))) { generatedFile = filename; controller.abort(); } return result; };
  syncBuiltinESMExports();
  try { await assert.rejects(f.manager.operateClips(f.projectId, [{ action: 'caption_add', text: 'Not committed', at: 0, duration: 2 }], f.origin, f.current.revision, { signal: controller.signal }), { code: 'REQUEST_CANCELLED' }); }
  finally { fs.writeFile = realWrite; syncBuiltinESMExports(); }
  assert.ok(generatedFile, 'The fixture aborted after a real page write'); await assert.rejects(access(generatedFile), { code: 'ENOENT' }); assert.equal(await readFile(f.film, 'utf8'), before);
});

test('lost acknowledgement after actual native commit never removes sources referenced by the committed film', { skip: process.env.GUANGXUAN_TEST_OPENFILM !== '1', timeout: 60000 }, async t => {
  const realFork = childProcess.fork; let injected = false;
  childProcess.fork = (...args) => {
    const child = realFork(...args), send = child.send.bind(child), on = child.on.bind(child); let targetId;
    child.send = (message, ...rest) => { if (message.action === 'edit' && message.strict && message.ops?.some(op => op.op === 'insert' && op.clip?.src?.startsWith('pages/gx-operation-'))) targetId = message.id; return send(message, ...rest); };
    child.on = (event, handler) => on(event, event === 'message' ? message => { if (!injected && targetId && message.id === targetId && !message.error) { injected = true; child.kill(); return; } handler(message); } : handler); return child;
  };
  syncBuiltinESMExports(); let f;
  try {
    f = await fixture(t);
    await assert.rejects(f.manager.operateClips(f.projectId, [{ action: 'caption_add', text: 'Committed before the lost reply', at: 0, duration: 2 }], f.origin, f.current.revision), { code: 'OPENFILM_EXITED' });
  } finally { childProcess.fork = realFork; syncBuiltinESMExports(); }
  assert.equal(injected, true); const doc = readFilmFile(await readFile(f.film, 'utf8')).doc; assert.ok(doc);
  const source = doc.tracks.flatMap(track => track.clips).find(clip => clip.attrs?.['data-guangxuan-caption'] === 'true')?.src; assert.ok(source); await access(path.join(f.home, source));
  assert.match(await readFile(path.join(f.home, source), 'utf8'), /Committed before the lost reply/);
  assert.equal((await readdir(path.join(f.home, 'pages'))).filter(name => name.startsWith('gx-operation-')).length, 1);
});
