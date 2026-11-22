import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAssistantAgentService } from '../lib/assistant-agent.mjs';
import { describeNativeTimeline } from '../lib/native-adjustments.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms)), terminal = new Set(['completed','failed','cancelled']);
const done = { type: 'final', message: '已完成这次隔离剪辑。', sourceIds: [] };
const adjust = id => ({ type: 'tool', tool: 'native_adjust', arguments: { edits: [{ action: 'volume', clipId: id, value: .5 }] }, summary: '调整一小批片段' });
async function finish(service,id) { for(let i=0;i<400;i++){const job=await service.get(id);if(terminal.has(job.status))return job;await pause(5);}throw new Error('Recovery fixture did not settle'); }
async function until(predicate) { for(let i=0;i<400;i++){if(predicate())return;await pause(5);}throw new Error('Recovery fixture did not reach expected state'); }
async function fixture(t,responder,apiStyle='chat',appTools,agentOptions={}) {
  const requests=[],applied=[],server=createServer(async(req,res)=>{
    const body=JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString()),parts=apiStyle==='responses'?body.input:body.messages[1].content;
    const content=Array.isArray(parts)?apiStyle==='responses'?parts[0].content:parts:null,payload=JSON.parse(content?content[0].text:parts);
    const entry={body,payload,images:content?.filter(part=>['input_image','image_url'].includes(part.type))||[],res};requests.push(entry);
    const answer=await responder(entry,requests.length-1);if(answer===undefined||res.destroyed)return;
    if(answer.status){res.writeHead(answer.status,{'content-type':'application/json'});res.end(JSON.stringify({error:'controlled fixture'}));return;}
    const text=answer.truncated?' {"type":"tool","tool":"native_adjust","arguments":{"edits":[{"action":"remove","clipId":"poison-partial"}':JSON.stringify(answer.data||answer);
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(apiStyle==='responses'?{status:answer.truncated?'incomplete':'completed',output:[{content:[{type:'output_text',text}]}]}:{choices:[{finish_reason:answer.truncated?'length':'stop',message:{content:text}}]}));
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const directory=await mkdtemp(path.join(tmpdir(),'gx-edit-recovery-'));
  const tools=appTools||[{name:'native_adjust',description:'精确一批调整',mutating:true,inputSchema:{type:'object',required:['edits'],properties:{edits:{type:'array',maxItems:40}}},execute:async args=>{applied.push(args.edits);return{summary:'已调整这一批。',data:{revision:`rev-${applied.length}`},effects:[{type:'native',changed:true,label:`已调整第${applied.length}批`}]};}}];
  const service=createAssistantAgentService({dataDir:directory,appTools:tools,...agentOptions});
  t.after(async()=>{await service.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});});
  return{service,requests,applied,settings:{baseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiStyle,apiKey:'fixture-only-never-user-key',model:'controlled-local',timeoutSeconds:10}};
}

for(const apiStyle of ['chat','responses'])test(`${apiStyle} output length recovers once in the same run without replaying a committed edit or parsing the partial tool`,async t=>{
  const instruction='调整第一个和第二个片段音量';
  const fx=await fixture(t,(entry,index)=>{
    assert.equal(entry.payload.request,instruction);
    if(index===0)return adjust('first');if(index===1)return{truncated:true};
    if(index===2){assert.equal(entry.payload.taskState.recovery.code,'MODEL_OUTPUT_TRUNCATED');assert.match(entry.payload.taskState.recovery.action,/小批|分批/);assert.match(entry.payload.taskState.recovery.action,/不能重播已成功写入/);assert.ok(entry.payload.recentEffects.length===1);return adjust('second');}return done;
  },apiStyle);
  const {runId}=await fx.service.start({projectId:'isolated-project',instruction,settings:fx.settings}),job=await finish(fx.service,runId);
  assert.equal(job.status,'completed');assert.equal(job.report.outcome,'complete');assert.equal(fx.requests.length,4);assert.deepEqual(fx.applied.flat().map(edit=>edit.clipId),['first','second']);
  assert.equal(job.responseRecovery.attempts,1);assert.deepEqual(fx.requests.map(entry=>apiStyle==='chat'?entry.body.max_tokens:entry.body.max_output_tokens),[4096,4096,8192,8192]);
  assert.ok(job.steps.some(step=>step.type==='model'&&step.status==='failed'&&step.message.includes('继续分批')));assert.doesNotMatch(JSON.stringify(job),/poison-partial|fixture-only-never-user-key/);
});

test('a second truncated output stops with the original goal and committed change preserved',async t=>{
  const fx=await fixture(t,(_entry,index)=>index===0?adjust('first'):{truncated:true});
  const {runId}=await fx.service.start({projectId:'isolated-project',instruction:'调整两个片段音量',settings:fx.settings}),job=await finish(fx.service,runId);
  assert.equal(job.status,'failed');assert.equal(job.error.code,'MODEL_OUTPUT_TRUNCATED');assert.equal(fx.requests.length,3);assert.equal(fx.applied.length,1);assert.equal(job.effects.length,1);assert.match(job.error.message,/已完成的操作已保留/);assert.doesNotMatch(job.error.message,/缩短|缩小/);
});

for(const status of [401,504])test(`HTTP ${status} is a real failure and never triggers output-length recovery`,async t=>{
  const fx=await fixture(t,()=>({status})),{runId}=await fx.service.start({projectId:'isolated-project',instruction:'调整音量',settings:fx.settings}),job=await finish(fx.service,runId);
  assert.equal(job.status,'failed');assert.equal(job.error.code,`UPSTREAM_HTTP_${status}`);assert.equal(fx.requests.length,status===504?3:1);assert.equal(fx.applied.length,0);assert.equal(job.responseRecovery,undefined);
});

test('Stop during the recovery HTTP call aborts it and does not execute or replay writes',async t=>{
  let closed=false;const fx=await fixture(t,(entry,index)=>{if(index===0)return adjust('first');if(index===1)return{truncated:true};entry.res.once('close',()=>{closed=true;});return undefined;});
  const {runId}=await fx.service.start({projectId:'isolated-project',instruction:'调整两个片段音量',settings:fx.settings});await until(()=>fx.requests.length===3);
  const job=await fx.service.cancel(runId);await until(()=>closed);assert.equal(job.status,'cancelled');assert.equal(fx.applied.length,1);assert.equal(fx.requests.length,3);
});

for(const apiStyle of ['chat','responses'])test(`${apiStyle} visual recovery reuses only its trusted current picture without reading it again`,async t=>{
  const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  let reads=0,writes=0;
  const tools=[{name:'media_frames_read',description:'读实际图片',execute:async()=>{reads++;return{summary:'已读图片。',imageBatch:[{dataUrl:png,label:'本批实际图片'}]};},images:raw=>raw.imageBatch},{name:'native_adjust',description:'调整片段',mutating:true,execute:async()=>{writes++;return{summary:'已写一批。',effects:[{type:'native',changed:true}]};}}];
  const fx=await fixture(t,(entry,index)=>{if(index===0)return{type:'tool',tool:'media_frames_read',arguments:{},summary:'先读图片'};if(index===1){assert.equal(entry.images.length,1);return{truncated:true};}if(index===2){assert.equal(entry.images.length,1);assert.equal(apiStyle==='chat'?entry.images[0].image_url.url:entry.images[0].image_url,png);return adjust('first');}return done;},apiStyle,tools);
  const {runId}=await fx.service.start({projectId:'isolated-project',instruction:'读取图片，然后调整片段音量',settings:fx.settings}),job=await finish(fx.service,runId);
  assert.equal(job.status,'completed');assert.equal(reads,1);assert.equal(writes,1);assert.doesNotMatch(JSON.stringify(job),/base64/);
});

test('oversized native pages keep structured total/source facts and resume exactly at the first omitted clip',async t=>{
  const doc={stage:{w:1280,h:720},tracks:[{clips:Array.from({length:1000},(_,i)=>({id:`clip-${i+1}`,src:'a.mp4',at:i*3,time:[0,2]}))}]},known={'a.mp4':{assetId:'asset-a',duration:2,name:'可编辑素材'}};
  const native={name:'native_inspect',description:'分页读取',execute:async args=>({summary:'已读取一页。',data:describeNativeTimeline(doc,known,undefined,args)})};
  let shown,next;
  const fx=await fixture(t,(entry,index)=>{if(index===0)return{type:'tool',tool:'native_inspect',arguments:{offset:0,limit:300},summary:'读取大页'};
    if(index===1){const result=entry.payload.observations[0].result;assert.ok(result.data);shown=result.data.clips.length;next=result.data.pagination.nextOffset;assert.ok(shown>0&&shown<300);assert.equal(result.data.sourcePagination.nextOffset,300);assert.equal(result.data.total,1000);assert.equal(result.data.returnedToModel,shown);assert.equal(result.data.omittedFromSourcePage,300-shown);assert.equal(next,shown);assert.equal(result.data.responsePartial,true);assert.doesNotMatch(JSON.stringify(result),/"summary":"\{.*clips/);return{type:'tool',tool:'native_inspect',arguments:{offset:next,limit:2},summary:'继续被省略部分'};}
    assert.equal(entry.payload.observations.at(-1).result.data.clips[0].id,`clip-${shown+1}`);return done;
  },'chat',[native]);
  const {runId}=await fx.service.start({projectId:'isolated-project',instruction:'只读取所有片段信息',mode:'ask',settings:fx.settings}),job=await finish(fx.service,runId);
  assert.equal(job.status,'completed');assert.equal(fx.requests.length,3);assert.equal(fx.applied.length,0);
});

test('an independent track page survives clip compaction and exposes its own omitted range',async t=>{
  const clips=Array.from({length:300},(_,i)=>({id:`clip-${i+1}`,clipId:`clip-${i+1}`,track:0,assetId:'asset-a',at:i*3,end:i*3+2,name:'片段'.repeat(70)}));
  const tracks=Array.from({length:100},(_,i)=>({index:i+100,name:'独立轨道'.repeat(25),clipCount:0,matchingClipCount:0,locked:false,muted:false}));
  const native={name:'native_inspect',description:'独立分页',execute:async()=>({summary:'已读取两页。',data:{clips,tracks,pagination:{offset:0,total:1000,limit:300,nextOffset:300},trackPagination:{offset:100,total:200,limit:100,nextOffset:null},scopeFiltered:true,extraText:'X'.repeat(50000)}})};
  const fx=await fixture(t,(entry,index)=>{if(index===0)return{type:'tool',tool:'native_inspect',arguments:{},summary:'读大页'};const data=entry.payload.observations[0].result.data;assert.ok(data);assert.equal(data.sourcePagination.nextOffset,300);assert.equal(data.sourceTrackPagination.offset,100);assert.equal(data.tracks[0].index,100);assert.ok(data.tracks.length>0);assert.equal(data.trackPagination.nextOffset,data.tracks.length===100?null:100+data.tracks.length);assert.equal(data.omittedTracksFromSourcePage,100-data.tracks.length);assert.ok(data.responseOmittedFields.includes('extraText'));assert.equal(data.extraText,undefined);return done;},'chat',[native]);
  const {runId}=await fx.service.start({projectId:'isolated-project',instruction:'只读片段与独立轨道',mode:'ask',settings:fx.settings});assert.equal((await finish(fx.service,runId)).status,'completed');
});

test('a long native motion page preserves hash/total and continues at the first undisplayed key',async t=>{
  const keys=Array.from({length:200},(_,i)=>({time:i/10,x:i,y:0,easing:'curve-'.repeat(30)})),hash='a'.repeat(64);
  const tool={name:'native_motion_read',description:'完整曲线页',execute:async()=>({summary:'读关键帧。',data:{clipId:'motion',property:'translate',revision:'motion-r1',sha256:hash,keys,totalKeys:400,offset:100,returnedKeys:200,nextOffset:300,editable:true}})};
  const fx=await fixture(t,(entry,index)=>{if(index===0)return{type:'tool',tool:'native_motion_read',arguments:{},summary:'读取长曲线'};const data=entry.payload.observations[0].result.data;assert.ok(data);assert.equal(data.sha256,hash);assert.equal(data.totalKeys,400);assert.ok(data.returnedKeys>0&&data.returnedKeys<200);assert.equal(data.nextOffset,100+data.returnedKeys);assert.equal(data.sourceNextOffset,300);assert.equal(data.omittedKeys,200-data.returnedKeys);assert.equal(data.responsePartial,true);return done;},'chat',[tool]);
  const {runId}=await fx.service.start({projectId:'isolated-project',instruction:'只读取完整关键帧',mode:'ask',settings:fx.settings});assert.equal((await finish(fx.service,runId)).status,'completed');
});

test('native asset pages remain JSON under the total model budget and continue at the first omitted asset',async t=>{
  const editScope={placement:{mode:'range',start:40,end:45}},ownerCreatedAt='2026-11-19T00:00:00.000Z';let shown;
  const native={name:'native_read',description:'可用工程资料'.repeat(22000),execute:async args=>{
    const offset=args.assetOffset??150,limit=args.assetLimit??200;
    return{summary:'已读取当前工程素材页。',data:{assets:Array.from({length:limit},(_,i)=>({id:`asset-${offset+i}`,name:'长但完整的素材名'.repeat(24),type:'video',source:'native',sources:['native'],registration:{nativeImported:true,referenceIds:[],projectId:'isolated-project',ownerCreatedAt}})),assetCount:700,totalAssetCount:1000,nativeAssetCount:600,referenceAssetCount:100,assetOffset:offset,assetLimit:limit,assetCatalogVersion:'catalog-version-1',nextAssetOffset:offset+limit,assetPage:{offset,limit,total:700,totalInProject:1000,returned:limit,nextOffset:offset+limit,hasMore:true,type:'video',query:'长素材'},editScope,ownerCreatedAt,revision:'native-r1',timeline:[],timelineCount:0,timelineComplete:true,assetsComplete:false,overviewComplete:false}};
  }};
  const fx=await fixture(t,(entry,index)=>{
    if(index===0)return{type:'tool',tool:'native_read',arguments:{assetOffset:150,assetLimit:200},summary:'读取较大素材页'};
    const data=entry.payload.observations.at(-1).result.data;assert.ok(data&&Array.isArray(data.assets));
    if(index===1){shown=data.assets.length;assert.ok(shown>0&&shown<200);assert.equal(data.assetCount,700);assert.equal(data.totalAssetCount,1000);assert.equal(data.sourceAssetPagination.nextOffset,350);assert.equal(data.sourceNextAssetOffset,350);assert.equal(data.sourceReturnedAssetCount,200);assert.equal(data.omittedAssetsFromSourcePage,200-shown);assert.equal(data.nextAssetOffset,150+shown);assert.equal(data.assetPage.nextOffset,data.nextAssetOffset);assert.equal(data.assetPage.type,'video');assert.equal(data.assetPage.query,'长素材');assert.equal(data.assetCatalogVersion,'catalog-version-1');assert.equal(data.ownerCreatedAt,ownerCreatedAt);assert.deepEqual(data.editScope,editScope);assert.equal(data.assets[0].registration.nativeImported,true);assert.equal(data.assets[0].registration.ownerCreatedAt,ownerCreatedAt);assert.equal(data.assets[0].detailsIncomplete,undefined);return{type:'tool',tool:'native_read',arguments:{assetOffset:data.nextAssetOffset,assetLimit:2},summary:'从未呈现素材继续'};}
    assert.equal(data.assets[0].id,`asset-${150+shown}`);return done;
  },'chat',[native],{buildContext:()=>({text:'项目资料'.repeat(9000)})});
  const {runId}=await fx.service.start({projectId:'isolated-project',instruction:'只读取完整素材库',mode:'ask',settings:fx.settings});assert.equal((await finish(fx.service,runId)).status,'completed');assert.equal(fx.requests.length,3);assert.equal(fx.applied.length,0);
});

test('a single oversized asset retains its exact ID, owner and registration while marking omitted details and timeline',async t=>{
  const ownerCreatedAt='2026-11-19T00:00:00.000Z';
  const native={name:'native_read',description:'读取大条目',execute:async()=>({summary:'已读取素材。',data:{projectId:'isolated-project',ownerCreatedAt,assetCatalogVersion:'single-catalog',assetCount:1,totalAssetCount:1,nativeAssetCount:0,referenceAssetCount:1,assetOffset:0,assetLimit:100,nextAssetOffset:null,assetPage:{offset:0,limit:100,total:1,returned:1,nextOffset:null,hasMore:false},assets:[{id:'exact-large-asset-id',name:'超长名称'.repeat(10000),type:'video',source:'reference',sources:['reference'],projectId:'isolated-project',ownerCreatedAt,registration:{nativeImported:false,projectId:'isolated-project',ownerCreatedAt,referenceIds:Array.from({length:300},(_,i)=>`ref-${i}`)},description:'额外细节'.repeat(30000)}],assetsComplete:true,timeline:[{id:'huge-clip',assetId:'exact-large-asset-id',details:'时间线内容'.repeat(10000)}],timelineCount:1000,timelineComplete:false,overviewComplete:false,editScope:{placement:{mode:'free'}}}})};
  const fx=await fixture(t,(entry,index)=>{
    if(index===0)return{type:'tool',tool:'native_read',arguments:{},summary:'读取单条大素材'};
    const data=entry.payload.observations.at(-1).result.data,asset=data.assets[0];assert.ok(JSON.stringify(entry.payload.observations.at(-1).result).length<=22000);assert.equal(asset.id,'exact-large-asset-id');assert.equal(asset.source,'reference');assert.equal(asset.ownerCreatedAt,ownerCreatedAt);assert.equal(asset.registration.projectId,'isolated-project');assert.equal(asset.registration.nativeImported,false);assert.equal(asset.registration.totalReferenceIds,300);assert.equal(asset.registration.referenceIdsComplete,false);assert.equal(asset.detailsIncomplete,true);assert.equal(data.returnedAssetCount,1);assert.equal(data.nextAssetOffset,null);assert.equal(data.assetsComplete,false);assert.equal(data.timelineCount,1000);assert.equal(data.timelineComplete,false);assert.equal(data.omittedTimelineFromSourcePage,1);assert.equal(data.overviewComplete,false);return done;
  },'chat',[native]);
  const {runId}=await fx.service.start({projectId:'isolated-project',instruction:'只读取当前素材',mode:'ask',settings:fx.settings});assert.equal((await finish(fx.service,runId)).status,'completed');
});
