import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createProjectStore } from '../lib/store.mjs';
import { createRemotionProjectsService } from '../lib/remotion-projects.mjs';
import { createRemotionIntegration } from '../lib/remotion-integration.mjs';
import { createAssistantAppTools } from '../lib/assistant-app-tools.mjs';
import { startServer } from '../server.mjs';

const root = path.resolve(import.meta.dirname, '..');
const code = wanted => error => error.code === wanted;
const files = () => [
  { path: 'src/Main.tsx', content: 'export const title = "原始标题";\r\nexport const opacity = 0.5;\r\nexport const emoji = "🙂";\r\n' },
  { path: 'src/helpers.ts', content: 'export const left = 1;\nexport const right = 2;\nexport const repeat = "anchor anchor";\nexport const special = "foo.*(";\n' },
  { path: 'src/style.css', content: 'body { color: red; }\n' },
];
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t) {
  const parent = path.resolve(process.env.GUANGXUAN_TEST_DIR || os.tmpdir()); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'gx-remotion-code-tools-')), store = await createProjectStore(directory), project = await store.save('current-code-project', { kind: 'video', title: '当前源码工程', video: { timeline: [] } });
  let jobs = 0;
  const projects = await createRemotionProjectsService({ dataDir: directory, root, onJob: () => { jobs++; } }), remotion = createRemotionIntegration({ projects, store });
  const record = await projects.create(project.id, { ownerCreatedAt: project.createdAt, title: '已有自由动画', entryPoint: 'src/Main.tsx', compositionId: 'Main', inputProps: { preserve: true }, files: files() });
  const adapter = createAssistantAppTools({ store, remotion, remotionProjects: projects });
  t.after(async () => { await adapter.close(); await remotion.close(); await projects.close(); await store.settle(); assert.equal(path.dirname(directory), parent); await rm(directory, { recursive: true, force: true }); });
  const ctx = overrides => ({ projectId: project.id, runId: randomUUID(), instruction: '按当前对话精确修改整个项目的已有动画源码', scopeAuthority: 'dialog', mode: 'auto', signal: new AbortController().signal, update() {}, settings: { apiKey: 'fixture-only-connection-key-123456' }, ...overrides });
  const call = (name, args, context = ctx()) => { const selected = adapter.tools.find(tool => tool.name === name); assert.ok(selected, 'Missing ' + name); return selected.execute(args || {}, context); };
  const base = () => ({ remotionId: record.id, expectedRevision: record.revision });
  return { directory, store, project, projects, remotion, adapter, record, ctx, call, base, jobs: () => jobs };
}

test('bounded source reads preserve exact CRLF and search returns literal current-file positions without host paths', async t => {
  const fx = await fixture(t), read = await fx.call('remotion_code_read', { ...fx.base(), path: 'src/Main.tsx', startLine: 2, endLine: 2 }, fx.ctx({ mode: 'ask' }));
  assert.equal(read.data.content, 'export const opacity = 0.5;\r\n'); assert.equal(read.data.start.line, 2); assert.equal(read.data.revision, 1); assert.equal(read.data.lineEnding, 'CRLF');
  const literal = await fx.call('remotion_code_search', { ...fx.base(), query: 'foo.*(', paths: ['src/helpers.ts'] }); assert.equal(literal.data.totalMatches, 1); assert.equal(literal.data.matches[0].line, 4);
  const first = await fx.call('remotion_code_search', { ...fx.base(), query: 'export', limit: 2 }), second = await fx.call('remotion_code_search', { ...fx.base(), query: 'export', limit: 2, offset: first.data.nextOffset });
  assert.equal(first.data.matches.length, 2); assert.ok(first.data.totalMatches > 2); assert.equal(second.data.offset, 2); assert.ok(!JSON.stringify([read,literal,first,second]).includes(fx.directory));
  await assert.rejects(fx.call('remotion_code_read', { ...fx.base(), path: 'src/Main.tsx', startLine: 4, endLine: 2 }), error => error.status === 400);
});

test('one multi-file exact patch publishes one revision, returns actual diff, preserves untouched files and really undoes', async t => {
  const fx = await fixture(t), context = fx.ctx();
  const args = { ...fx.base(), patches: [{ path: 'src/Main.tsx', oldText: '"原始标题"', newText: '"新的标题"' }, { path: 'src/helpers.ts', oldText: 'left = 1', newText: 'left = 3' }, { path: 'src/helpers.ts', oldText: 'right = 2', newText: 'right = 4' }] };
  const result = await fx.call('remotion_code_patch', args, context), repeated = await fx.call('remotion_code_patch', args, context), saved = await fx.projects.read(fx.project.id, fx.record.id);
  assert.deepEqual(repeated, result); assert.equal(saved.revision, 2); assert.equal(result.data.revision, 2); assert.equal(result.effects[0].undo.kind, 'remotion-source');
  assert.equal(saved.files.find(file => file.path === 'src/style.css').content, files()[2].content); assert.equal(saved.inputProps.preserve, true);
  assert.ok(result.data.changes.files.find(file => file.path === 'src/Main.tsx').hunks.some(hunk => hunk.before.includes('原始标题') && hunk.after.includes('新的标题')));
  assert.deepEqual(result.effects[0].sourceChanges.files,result.data.changes.files); assert.equal(result.effects[0].sourceChanges.fromRevision,1); assert.equal(result.effects[0].sourceChanges.toRevision,2);
  assert.equal(result.data.changes.files[0].addedLines,1); assert.equal(result.data.changes.files[0].removedLines,1);
  assert.equal(result.data.files, undefined); assert.equal(fx.jobs(), 0, 'Saving a patch cannot claim compilation or start a render');
  await fx.call('assistant_undo_apply', { undoId: result.effects[0].undo.id });
  const restored = await fx.projects.read(fx.project.id, fx.record.id); assert.equal(restored.revision, 3); assert.deepEqual(restored.files, fx.record.files); assert.equal(restored.title, fx.record.title);
});

test('missing, ambiguous, overlapping and stale matches reject the whole batch with no source write or undo', async t => {
  const fx = await fixture(t), before = await fx.projects.read(fx.project.id, fx.record.id);
  for (const [patches, wanted] of [
    [[{ path:'src/Main.tsx',oldText:'原始标题',newText:'不该先写' },{ path:'src/helpers.ts',oldText:'missing source anchor',newText:'bad' }], 'ASSISTANT_CODE_OLD_TEXT_MISSING'],
    [[{ path:'src/helpers.ts',oldText:'anchor',newText:'bad' }], 'ASSISTANT_CODE_OLD_TEXT_AMBIGUOUS'],
    [[{ path:'src/helpers.ts',oldText:'left = 1',newText:'left = 2' },{ path:'src/helpers.ts',oldText:'= 1;',newText:'= 9;' }], 'ASSISTANT_CODE_PATCH_OVERLAP'],
  ]) await assert.rejects(fx.call('remotion_code_patch', { ...fx.base(), patches }), code(wanted));
  await assert.rejects(fx.call('remotion_code_patch', { remotionId: fx.record.id, expectedRevision: 9, patches:[{path:'src/Main.tsx',oldText:'原始标题',newText:'bad'}] }), code('REMOTION_REVISION_CONFLICT'));
  assert.deepEqual(await fx.projects.read(fx.project.id, fx.record.id), before); assert.deepEqual((await fx.call('assistant_undo_list', {})).data.items, []);
});

test('code tools retain project ownership, path guards, ask-mode write blocks and connection-secret protection', async t => {
  const fx = await fixture(t), original = await fx.projects.read(fx.project.id, fx.record.id);
  for (const path of ['../outside.tsx','C:/private/secret.tsx','/etc/passwd','package.json','tsconfig.json','remotion.config.ts','.env.txt','node_modules/any.ts','public/media/source.svg']) await assert.rejects(fx.call('remotion_code_read', { ...fx.base(), path }), error => error.status === 400);
  const patch = { ...fx.base(), patches:[{path:'src/Main.tsx',oldText:'原始标题',newText:'new'}] };
  await assert.rejects(fx.call('remotion_code_patch', patch, fx.ctx({ mode:'ask' })), code('ASSISTANT_READ_ONLY'));
  await assert.rejects(fx.call('remotion_code_patch', { ...patch,patches:[{...patch.patches[0],newText:'fixture-only-connection-key-123456'}] }), code('ASSISTANT_CODE_SECRET'));
  await fx.store.save('foreign-code-owner', {kind:'video',title:'另一工程'}); const foreign = await fx.projects.create('foreign-code-owner',{files:files()});
  await assert.rejects(fx.call('remotion_code_read',{remotionId:foreign.id,expectedRevision:1,path:'src/Main.tsx'}),code('REMOTION_PROJECT_NOT_FOUND'));
  assert.deepEqual(await fx.projects.read(fx.project.id, fx.record.id), original);
});

test('a concurrent source change cancels pending patch undo and preserves the actual user revision', async t => {
  const fx = await fixture(t), admitted = deferred(), release = deferred(), update = fx.projects.update.bind(fx.projects);
  fx.projects.update = async (...args) => { admitted.resolve(); await release.promise; return update(...args); };
  let pending;
  try {
    pending = fx.call('remotion_code_patch',{...fx.base(),patches:[{path:'src/Main.tsx',oldText:'原始标题',newText:'stale patch'}]}); await admitted.promise;
    assert.deepEqual((await fx.call('assistant_undo_list',{})).data.items, []);
    await update(fx.project.id,fx.record.id,{expectedRevision:1,title:'User live source revision'}); release.resolve(); await assert.rejects(pending,code('REMOTION_REVISION_CONFLICT'));
    assert.equal((await fx.projects.read(fx.project.id,fx.record.id)).title,'User live source revision'); assert.deepEqual((await fx.call('assistant_undo_list',{})).data.items, []);
  } finally { release.resolve(); await pending?.catch(()=>{}); fx.projects.update=update; }
});

test('long-line paging and Unicode boundaries remain explicit; identical text produces no fake revision', async t => {
  const fx = await fixture(t), updated = await fx.projects.update(fx.project.id,fx.record.id,{expectedRevision:1,files:[{path:'src/long.txt',content:'x'.repeat(14000)+'🙂tail'}]});
  const first=await fx.call('remotion_code_read',{remotionId:fx.record.id,expectedRevision:updated.revision,path:'src/long.txt',startLine:1}); assert.equal(first.data.truncated,true); assert.equal(first.data.next.line,1);
  const next=await fx.call('remotion_code_read',{remotionId:fx.record.id,expectedRevision:updated.revision,path:'src/long.txt',startLine:first.data.next.line,startColumn:first.data.next.column}); assert.ok(next.data.content.endsWith('🙂tail'));
  await assert.rejects(fx.call('remotion_code_read',{remotionId:fx.record.id,expectedRevision:updated.revision,path:'src/long.txt',startLine:1,startColumn:14002}),error=>error.status===400);
  const same=await fx.call('remotion_code_patch',{remotionId:fx.record.id,expectedRevision:updated.revision,patches:[{path:'src/Main.tsx',oldText:'原始标题',newText:'原始标题'}]}); assert.equal(same.data.changed,false); assert.deepEqual(same.effects,[]); assert.equal((await fx.projects.read(fx.project.id,fx.record.id)).revision,updated.revision);
});

test('CRLF page boundaries can resume exactly and search/diff never split Unicode characters', async t => {
  const fx = await fixture(t), content = 'x'.repeat(11999)+'\r\nend', preview = 'a🙂'+'x'.repeat(79)+'FIND'+'🙂'.repeat(4000);
  const record=await fx.projects.update(fx.project.id,fx.record.id,{expectedRevision:1,files:[{path:'src/boundary.txt',content},{path:'src/preview.txt',content:preview},{path:'src/lines.txt',content:'one\r\ntwo\r\nthree\r\nfour\r\nfive\r\nsix\r\n'}]});
  const base={remotionId:record.id,expectedRevision:record.revision}, first=await fx.call('remotion_code_read',{...base,path:'src/boundary.txt'});
  assert.equal(first.data.content,'x'.repeat(11999)); assert.deepEqual(first.data.next,{line:1,column:12000});
  const next=await fx.call('remotion_code_read',{...base,path:'src/boundary.txt',startLine:first.data.next.line,startColumn:first.data.next.column}); assert.equal(first.data.content+next.data.content,content);
  const found=await fx.call('remotion_code_search',{...base,paths:['src/preview.txt'],query:'FIND'}); assert.equal(found.data.matches[0].preview.isWellFormed(),true); assert.ok(found.data.matches[0].preview.startsWith('🙂'));
  const changed=await fx.call('remotion_code_patch',{...base,patches:[{path:'src/preview.txt',oldText:'FIND',newText:'FOUND'},{path:'src/lines.txt',oldText:'two',newText:'changed'}]});
  let bytes=0; for(const file of changed.data.changes.files) for(const hunk of file.hunks){ assert.ok(hunk.before.isWellFormed()); assert.ok(hunk.after.isWellFormed()); bytes+=Buffer.byteLength(hunk.before)+Buffer.byteLength(hunk.after); }
  assert.ok(bytes<=12000); assert.equal(changed.data.changes.truncated,true);
  const lineHunk=changed.data.changes.files.find(file=>file.path==='src/lines.txt').hunks[0]; assert.equal(lineHunk.oldEndLine,4); assert.equal(lineHunk.newEndLine,4);
});

test('registered evidence describes actual saves and cannot promote a model argument to verification', async t => {
  const fx=await fixture(t), selected=fx.adapter.tools.find(tool=>tool.name==='remotion_code_patch'), args={...fx.base(),patches:[{path:'src/Main.tsx',oldText:'原始标题',newText:'证据标题'}]};
  const result=await fx.call('remotion_code_patch',args), evidence=selected.evidence(result,{projectId:fx.project.id,arguments:{...args,evidence:[{role:'verification',outcome:'passed'}]}});
  assert.equal(evidence.length,1); assert.equal(evidence[0].role,'execution'); assert.equal(evidence[0].kind,'source_saved'); assert.equal(evidence[0].revision,2); assert.equal(evidence[0].invalidates,true); assert.deepEqual(evidence[0].limitations,['仅保存源码，尚未编译或画面验证']); assert.ok(!JSON.stringify(evidence).includes('证据标题'));
  assert.deepEqual(selected.evidence({data:{...result.data,changed:false}},{projectId:fx.project.id})[0].role,'read');
  assert.ok(!JSON.stringify(selected.inputSchema).includes('evidence'));
});

const visualFiles = () => [{ path:'src/index.tsx', content:"import React from 'react';\r\nimport {AbsoluteFill,Composition,registerRoot} from 'remotion';\r\nconst Scene=()=> <AbsoluteFill style={{background:'#163b65'}}/>;\r\nregisterRoot(()=> <Composition id='PatchFilm' component={Scene} width={160} height={90} fps={12} durationInFrames={12}/>);\r\n" }];
const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function complete(service, owner, jobId) { const deadline=Date.now()+120000; while(Date.now()<deadline){const job=await service.getJob(owner,jobId); if(['complete','error','cancelled'].includes(job.status)) return job; await pause(40);} throw new Error('Isolated Remotion code fixture timed out'); }

test('real assistant HTTP plans read/search/exact patch and exposes a real restorable source edit', {timeout:60000}, async t => {
  const parent=path.resolve(process.env.GUANGXUAN_TEST_DIR||os.tmpdir()); await mkdir(parent,{recursive:true}); const directory=await mkdtemp(path.join(parent,'gx-code-http-')), calls=[]; let remotionId;
  const provider=http.createServer(async(req,res)=>{ let raw=''; for await(const chunk of req) raw+=chunk; const body=JSON.parse(raw); calls.push(body);
    const sequence=[
      {type:'tool',tool:'remotion_code_read',arguments:{remotionId,expectedRevision:1,path:'src/index.tsx'},summary:'读取实际源码'},
      {type:'tool',tool:'remotion_code_search',arguments:{remotionId,expectedRevision:1,query:'#163b65'},summary:'查找实际配色'},
      {type:'tool',tool:'remotion_code_patch',arguments:{remotionId,expectedRevision:1,patches:[{path:'src/index.tsx',oldText:"'#163b65'",newText:"'#c95832'"}]},summary:'精确修改配色'},
      {type:'final',message:'已保存配色修改，尚未编译和画面验证。',sourceIds:[]},
    ];
    res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(sequence[calls.length-1])}}]}));
  }); await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
  const app=await startServer({port:0,dataDir:directory});
  t.after(async()=>{ await app.close(); provider.closeAllConnections(); await new Promise(resolve=>provider.close(resolve)); assert.equal(path.dirname(directory),parent); await rm(directory,{recursive:true,force:true}); });
  const request=async(url,body,method=body===undefined?'GET':'POST')=>{ const response=await fetch(app.url+url,{method,headers:body===undefined?{}:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}); return {status:response.status,data:await response.json()}; };
  const project=(await request('/api/projects/code-http-current',{kind:'video',title:'隔离源码HTTP',video:{timeline:[]}},'PUT')).data.project;
  const created=await request(`/api/projects/${project.id}/remotion`,{title:'HTTP已有工程',entryPoint:'src/index.tsx',compositionId:'PatchFilm',files:visualFiles()}); assert.equal(created.status,201); remotionId=created.data.project?.id||created.data.id;
  assert.ok(remotionId,JSON.stringify(created));
  const started=await request('/api/assistant/runs',{projectId:project.id,instruction:'把当前Remotion工程配色从#163b65精确修改为#c95832并保存，先读取源码搜索定位。',settings:{baseUrl:`http://127.0.0.1:${provider.address().port}/v1`,apiKey:'code-http-fixture-only-not-real',model:'fixture'}}); assert.equal(started.status,202);
  let job; for(let index=0;index<1000;index++){job=(await request('/api/assistant/runs/'+started.data.runId)).data.job;if(['completed','failed','cancelled'].includes(job?.status))break;await pause(10);}
  assert.equal(job.status,'completed',JSON.stringify(job)); assert.deepEqual(job.steps.filter(step=>step.type==='tool').map(step=>step.tool),['remotion_code_read','remotion_code_search','remotion_code_patch']);
  assert.equal(calls.length,4); const planner=JSON.parse(calls[0].messages[1].content), patchSchema=planner.tools.find(tool=>tool.name==='remotion_code_patch'); assert.ok(patchSchema); assert.equal(Object.hasOwn(patchSchema,'evidence'),false); assert.equal(patchSchema.inputSchema?.properties?.evidence,undefined);
  const source=(await request(`/api/projects/${project.id}/remotion/${remotionId}`)).data.project; assert.equal(source.revision,2); assert.ok(source.files[0].content.includes('#c95832'));
  const effect=job.effects.find(effect=>effect.sourceChanges); assert.ok(effect?.undo?.id,JSON.stringify(job.effects)); assert.equal(effect.sourceChanges.toRevision,2); assert.equal(effect.sourceChanges.files[0].addedLines,1); assert.ok(effect.sourceChanges.files[0].hunks[0].after.includes('#c95832'));
  const undone=await request('/api/assistant/undo',{projectId:project.id,undoId:effect.undo.id}); assert.equal(undone.status,200); const restored=(await request(`/api/projects/${project.id}/remotion/${remotionId}`)).data.project; assert.equal(restored.revision,3); assert.deepEqual(restored.files,visualFiles());
});

test('actual Remotion inspect and PNG prove patch changes pixels and source undo restores them exactly', {timeout:240000,skip:process.env.GUANGXUAN_TEST_REMOTION!=='1'}, async t => {
  const fx=await fixture(t), record=await fx.projects.create(fx.project.id,{ownerCreatedAt:fx.project.createdAt,title:'真实像素验收',entryPoint:'src/index.tsx',compositionId:'PatchFilm',files:visualFiles()});
  const inspected=await fx.call('remotion_inspect_advanced',{remotionId:record.id,expectedRevision:1}); assert.equal(inspected.data.compositions[0].id,'PatchFilm');
  const binary=process.env.GUANGXUAN_FFMPEG||(process.env.GUANGXUAN_BIN_DIR?path.join(process.env.GUANGXUAN_BIN_DIR,process.platform==='win32'?'ffmpeg.exe':'ffmpeg'):'ffmpeg'), execute=promisify(execFile), evidenceDir=process.env.GUANGXUAN_CODE_TOOLS_EVIDENCE;
  if(evidenceDir) await mkdir(evidenceDir,{recursive:true});
  async function pixels(revision,label){const started=await fx.projects.render(fx.project.id,record.id,{expectedRevision:revision,kind:'preview',frames:[0]}),job=await complete(fx.projects,fx.project.id,started.jobId); assert.equal(job.status,'complete',JSON.stringify(job.error)); const file=(await fx.projects.file(fx.project.id,started.jobId,'frame-00.png')).path, bytes=await readFile(file); if(evidenceDir)await writeFile(path.join(evidenceDir,label+'.png'),bytes); const decoded=await execute(binary,['-hide_banner','-loglevel','error','-nostdin','-i',file,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','-'],{windowsHide:true,encoding:'buffer',maxBuffer:160*90*3+1024}); return decoded.stdout;}
  const before=await pixels(1,'before'), patch=await fx.call('remotion_code_patch',{remotionId:record.id,expectedRevision:1,patches:[{path:'src/index.tsx',oldText:"'#163b65'",newText:"'#c95832'"}]});
  const compiled=await fx.call('remotion_inspect_advanced',{remotionId:record.id,expectedRevision:2}); assert.equal(compiled.data.compositions[0].width,160); const after=await pixels(2,'after'); assert.notDeepEqual(after,before);
  await fx.call('assistant_undo_apply',{undoId:patch.effects[0].undo.id}); const restored=await pixels(3,'undo'); assert.deepEqual(restored,before); assert.deepEqual((await fx.projects.read(fx.project.id,record.id)).files,record.files);
  if(evidenceDir) await writeFile(path.join(evidenceDir,'result.json'),JSON.stringify({status:'passed',realInspect:true,realPng:true,dimensions:[160,90],patchChangedPixels:true,undoRestoredPixels:true,sourceExact:true,revisions:[1,2,3],pixelSHA256:Object.fromEntries([['before',before],['after',after],['undo',restored]].map(([key,value])=>[key,createHash('sha256').update(value).digest('hex')]))},null,2));
});


