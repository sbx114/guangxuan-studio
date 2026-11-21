import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const revision = text => createHash('sha256').update(text).digest('hex').slice(0, 16);
const fixtureStudio = `// guangxuan.mjs: construction-only local HTTP fixture for the actual worker protocol.
import http from 'node:http';import path from 'node:path';import {readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';
export async function startStudio({key}){
 const projects=new Map(),jobs=new Map();let sequence=0;
 const server=http.createServer(async(req,res)=>{try{
  if(req.headers['x-studio-key']!==key){res.writeHead(403);res.end('{}');return;}
  const raw=Buffer.concat(await Array.fromAsync(req)).toString(),body=raw?JSON.parse(raw):null;
  let value;
  if(req.url==='/api/open'){const id=path.basename(body.path);projects.set(id,body.path);value={project:{id},url:origin+'/project/'+id+'?key='+key};}
  else{const match=/^\\/api\\/projects\\/([^/]+)(?:\\/(.*))?$/.exec(req.url);const id=match?.[1],rest=match?.[2]||'';
   if(!projects.has(id)){res.writeHead(404);res.end('{}');return;}
   if(!rest){const text=await readFile(path.join(projects.get(id),'film.html'),'utf8');value={rev:createHash('sha256').update(text).digest('hex').slice(0,16)};}
   else if(rest==='exports'&&req.method==='POST'){const job={id:'export-'+(++sequence),project:id,status:'waiting',progress:0,ask:body,outputs:[]};jobs.set(job.id,job);value={export:job};}
   else if(rest==='exports'){value={exports:[...jobs.values()].filter(job=>job.project===id),can:{h264:true}};}
   else if(rest.startsWith('exports/')&&req.method==='DELETE'){const job=jobs.get(rest.slice(8));if(job?.project===id)job.status='cancelled';value={};}
   else{res.writeHead(404);res.end('{}');return;}}
  res.setHeader('content-type','application/json');res.end(JSON.stringify(value));
 }catch(error){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:error.message}));}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 return{origin,filmOrigin:origin,close:async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
`;

test('actual native worker validates advanced export settings, checks revision and cancels only the owning project job', { timeout: 30000 }, async t => {
  const parent = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'gx-native-export-worker-'));
  let child, rpc; const pending = new Map(); let closed;
  t.after(async () => {
    if (child?.connected) { try { await rpc('close'); } catch { child.kill(); } }
    if (closed) await closed;
    assert.equal(path.dirname(directory), parent); assert.ok(path.basename(directory).startsWith('gx-native-export-worker-'));
    await rm(directory, { recursive: true, force: true });
  });
  const fixture = path.join(directory, 'fixture'), entry = path.join(fixture, 'studio', 'server', 'server.mjs');
  const home = path.join(directory, 'state'), library = path.join(directory, 'projects'), exports = path.join(directory, 'exports'), saved = path.join(directory, 'saved');
  await Promise.all([path.dirname(entry), path.join(fixture, 'src'), home, library, exports, saved, path.join(library, 'one'), path.join(library, 'two')].map(name => mkdir(name, { recursive: true })));
  await writeFile(entry, fixtureStudio); await writeFile(path.join(fixture, 'src', 'guangxuan.mjs'), '// process.env.OPENFILM_LOCAL_ONLY construction fixture');
  for (const id of ['one', 'two']) await writeFile(path.join(library, id, 'film.html'), 'first');
  let readyResolve, readyReject; const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const readyTimer = setTimeout(() => readyReject(new Error('Worker did not become ready.')), 15000);
  child = fork(path.join(root, 'lib', 'openfilm-worker.mjs'), [], { cwd: root, execArgv: [], windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env, GUANGXUAN_OPENFILM_ENTRY: entry, OPENFILM_HOME: home, OPENFILM_SHARED_HOME: home, OPENFILM_LIBRARY: library, OPENFILM_EXPORTS: exports, OPENFILM_SAVED: saved, OPENFILM_LOCAL_ONLY: '1' } });
  closed = new Promise(resolve => child.once('close', resolve));
  child.on('message', message => {
    if (message.type === 'ready') { clearTimeout(readyTimer); readyResolve(); return; }
    if (message.type === 'failed') { clearTimeout(readyTimer); readyReject(new Error(message.error)); return; }
    const operation = pending.get(message.id); if (!operation) return;
    clearTimeout(operation.timer); pending.delete(message.id);
    if (message.error) operation.reject(Object.assign(new Error(message.error), { status: message.status, code: message.code })); else operation.resolve(message.result);
  });
  child.once('exit', () => { clearTimeout(readyTimer); for (const operation of pending.values()) { clearTimeout(operation.timer); operation.reject(new Error('Worker exited.')); } pending.clear(); });
  rpc = (action, values = {}) => new Promise((resolve, reject) => {
    const id = randomUUID(), timer = setTimeout(() => { pending.delete(id); reject(new Error('Worker response timed out.')); }, 5000);
    pending.set(id, { resolve, reject, timer }); child.send({ id, action, ...values });
  });
  await ready;
  const one = await rpc('open', { folder: path.join(library, 'one') }), two = await rpc('open', { folder: path.join(library, 'two') });
  const native = { nativeProjectId: one.nativeProjectId }, other = { nativeProjectId: two.nativeProjectId };
  const submitted = await rpc('export', { ...native, base: revision('first'), spec: { kind: 'audio', format: 'mp3', mix: false, stems: true, ranges: [[3, 5], [0, 1]] } });
  assert.deepEqual(submitted.export.ask, { kind: 'audio', format: 'mp3', mix: false, stems: true, ranges: [[3, 5], [0, 1]] });
  await assert.rejects(rpc('export-download', { ...native, exportId: submitted.export.id }), { status: 404, code: 'OPENFILM_EXPORT_NOT_FOUND' });
  await assert.rejects(rpc('export-download', { ...other, exportId: submitted.export.id }), { status: 404, code: 'OPENFILM_EXPORT_NOT_FOUND' });
  await assert.rejects(rpc('export', { ...native, base: revision('first'), spec: { kind: 'project', folder: 'C:/outside' } }), { status: 400, code: 'INVALID_OPENFILM_EXPORT' });
  assert.equal((await rpc('exports', native)).exports.length, 1);
  await writeFile(path.join(library, 'one', 'film.html'), 'changed');
  await assert.rejects(rpc('export', { ...native, base: revision('first'), spec: { kind: 'video' } }), { status: 409, code: 'OPENFILM_REVISION_CONFLICT' });
  assert.equal((await rpc('exports', native)).exports.length, 1);
  const legacy = await rpc('export', { ...native, spec: {} }); assert.deepEqual(legacy.export.ask, { kind: 'video', hardware: false });
  await assert.rejects(rpc('cancel-export', { ...other, exportId: submitted.export.id }), { status: 404, code: 'OPENFILM_EXPORT_NOT_FOUND' });
  assert.equal((await rpc('exports', native)).exports.find(job => job.id === submitted.export.id).status, 'waiting');
  const cancelled = await rpc('cancel-export', { ...native, exportId: submitted.export.id });
  assert.equal(cancelled.cancelled, true); assert.equal(cancelled.exports.find(job => job.id === submitted.export.id).status, 'cancelled');
  await assert.rejects(rpc('cancel-export', { ...native, exportId: '../outside' }), { status: 400, code: 'OPENFILM_EXPORT_INVALID' });
});
