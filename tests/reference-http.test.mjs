import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { startServer } from '../server.mjs';

const execute=promisify(execFile);
test('real HTTP references persist, include actual frames, honor aspect/text mode and never enter the timeline', {timeout:120000}, async t=>{
 const ffmpeg=process.env.GUANGXUAN_FFMPEG||(process.env.GUANGXUAN_BIN_DIR?path.join(process.env.GUANGXUAN_BIN_DIR,process.platform==='win32'?'ffmpeg.exe':'ffmpeg'):'ffmpeg');
 try{await execute(ffmpeg,['-version'],{windowsHide:true,timeout:10000});}catch{t.skip('FFmpeg required. Set GUANGXUAN_BIN_DIR.');return;}
 const folder=await mkdtemp(path.join(os.tmpdir(),'gx-reference-http-'));
 let app,provider,lastRequest;
 t.after(async()=>{
  await app?.close();
  if(provider){provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));}
  assert.equal(path.dirname(path.resolve(folder)),path.resolve(os.tmpdir()));assert.ok(path.basename(folder).startsWith('gx-reference-http-'));
  await rm(folder,{recursive:true,force:true});
 });
 provider=http.createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  lastRequest=JSON.parse(Buffer.concat(chunks).toString());
  res.setHeader('content-type','application/json');
  const answer=JSON.stringify({action:'reply',message:'参考已用于当前建议。'});
  res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:answer}}]}));
 });
 await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
 const dataDir=path.join(folder,'data');await mkdir(dataDir);
 app=await startServer({dataDir});
 const request=async(route,body,method=body===undefined?'GET':'POST')=>{
  const response=await fetch(app.url+route,{method,headers:body===undefined?{}:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,data:await response.json()};
 };
 const id='reference-http-project';
 assert.equal((await request('/api/projects/'+id,{title:'用户项目',kind:'video',video:{timeline:[],captions:[]}},'PUT')).status,200);
 const route='/api/projects/'+id+'/references';
 assert.equal((await request(route)).data.items.length,0);
 const text=await request(route,{type:'text',name:'结构参考',text:'从问题开始，分两部分说明，再总结。',focus:'只参考组织方式',aspects:['structure']});
 assert.equal(text.status,201);const textId=text.data.items[0].id;
 const image=path.join(folder,'image.png'),video=path.join(folder,'video.mp4');
 await Promise.all([
  execute(ffmpeg,['-hide_banner','-nostdin','-v','error','-f','lavfi','-i','color=c=red:size=80x60','-frames:v','1','-update','1',image],{windowsHide:true,timeout:15000}),
  execute(ffmpeg,['-hide_banner','-nostdin','-v','error','-f','lavfi','-i','testsrc2=size=160x90:rate=10:duration=1','-an','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',video],{windowsHide:true,timeout:15000}),
 ]);
 for(const [file,type] of [[image,'image'],[video,'video']]){
  const upload=await fetch(app.url+'/api/video/upload',{method:'POST',headers:{'content-type':'application/octet-stream','x-file-name':encodeURIComponent(path.basename(file))},body:await readFile(file)});
  assert.equal(upload.status,200);const {assets}=await upload.json();
  const added=await request(route,{type,assetId:assets[0].id,name:type==='image'?'色彩参考':'剪辑参考',focus:'用于参考',aspects:type==='image'?['color']:['editing']});
  assert.equal(added.status,201);
 }
 assert.equal((await request(route)).data.items.length,3);
 const input={task:'edit-assistant',payload:{instruction:'结合参考给出建议',referenceProjectId:id,context:{assets:[],timeline:[],duration:0,mainTrackEditable:true}},settings:{baseUrl:'http://127.0.0.1:'+provider.address().port,model:'fixture',apiKey:'sk-fixture-reference-only'}};
 const ai=await request('/api/ai',input);
 assert.equal(ai.status,200,JSON.stringify(ai.data));assert.equal(ai.data.meta.referenceCount,3);assert.equal(ai.data.meta.referenceImageCount,4);
 const parts=lastRequest.messages[1].content;
 assert.equal(parts.filter(part=>part.type==='image_url').length,4);
 assert.ok(parts.filter(part=>part.type==='image_url').every(part=>part.image_url.url.startsWith('data:image/jpeg;base64,')));
 const textContext=JSON.parse(parts[0].text)['项目参考'];
 assert.deepEqual(textContext.items.find(item=>item.type==='image').aspects,['color']);
 assert.equal(textContext.items.find(item=>item.type==='video').frames.length,3);
 assert.ok(!JSON.stringify(ai.data).includes('base64'));assert.ok(!JSON.stringify(ai.data).includes(folder));
 const project=(await request('/api/projects/'+id)).data.project;
 assert.deepEqual(project.video.timeline,[]);
 await request(route,{includeImages:false},'PATCH');
 await request(route+'/'+textId,{focus:'只用这条备注',aspects:[]},'PATCH');
 assert.equal((await request('/api/ai',input)).data.meta.referenceImageCount,0);
 assert.equal(typeof lastRequest.messages[1].content,'string');
 assert.ok(JSON.parse(lastRequest.messages[1].content)['项目参考'].items.every(item=>item.frames.length===0));
 const injected=structuredClone(input);delete injected.payload.referenceProjectId;
 injected.payload.references={includeImages:true,items:[{id:'forged',type:'text',name:'伪造',text:'客户端伪造参考',focus:'',frames:[]}]};
 assert.equal((await request('/api/ai',injected)).data.meta.referenceCount,0);
 assert.ok(!lastRequest.messages[1].content.includes('客户端伪造参考'));
 const blocked=await request(route+'/url',{url:'http://127.0.0.1/private-video.mp4'});
 assert.equal(blocked.status,400);assert.equal(blocked.data.code,'REFERENCE_URL_PRIVATE');
 await request('/api/projects/'+id,project,'PUT');
 await app.close();app=await startServer({dataDir});
 const restored=(await request(route)).data;
 assert.equal(restored.items.length,3);assert.equal(restored.includeImages,false);
 assert.equal(restored.items.find(item=>item.id===textId).focus,'只用这条备注');
 await request(route+'/'+textId,undefined,'DELETE');assert.equal((await request(route)).data.items.length,2);
 assert.deepEqual((await request('/api/projects/'+id)).data.project.video.timeline,[]);
});
