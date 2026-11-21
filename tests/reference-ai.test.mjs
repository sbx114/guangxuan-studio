import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { runAi } from '../lib/ai.mjs';
import { buildPrompt, normalizeModelData } from '../lib/prompts.mjs';

const picture='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const context={assets:[{id:'one',name:'已选素材.mp4',type:'video',duration:8},{id:'two',name:'未选素材.mp4',type:'video',duration:9}],timeline:[{id:'clip-one',assetId:'one',start:0,end:8,at:0,speed:1},{id:'clip-two',assetId:'two',start:0,end:9,at:8,speed:1}],duration:17,mainTrackEditable:true,aspect:'16:9'};
const references={includeImages:true,items:[{id:'reference-only',type:'image',name:'参考图片',focus:'借鉴构图',sourceUrl:'https://example.com/image?private=do-not-send',frames:[{label:'参考图片'}]},{id:'text-only',type:'text',name:'参考文字',text:'开场简短，后面分三部分介绍。',focus:'结构',frames:[]}]};
const payload=()=>({instruction:'先分析参考并给剪辑建议',title:'剪辑测试',context:structuredClone(context),references:structuredClone(references),editScope:{assetIds:['one'],placement:{mode:'insert',at:4}}});
const images=[{dataUrl:picture,label:'参考图片',referenceId:'reference-only'}];
let provider,url,last,count=0,mode='ok';

before(async()=>{
 provider=http.createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  last={url:req.url,body:JSON.parse(Buffer.concat(chunks).toString())};count++;
  res.setHeader('content-type','application/json');
  if(mode==='reject'){res.writeHead(400);res.end(JSON.stringify({error:{message:'image input unsupported sk-private-test'}}));return;}
  const answer=JSON.stringify({action:'reply',message:'可以按参考结构组织已选素材。'});
  res.end(req.url.endsWith('/responses')?JSON.stringify({output:[{type:'message',content:[{type:'output_text',text:answer}]}]}):JSON.stringify({choices:[{finish_reason:'stop',message:{content:answer}}]}));
 });
 await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
 url='http://127.0.0.1:'+provider.address().port;
});
after(async()=>{provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));});
const settings=apiStyle=>({baseUrl:url,model:'fixture',apiKey:'sk-private-test',apiStyle});

test('Chat reference images are real image content blocks, with text context kept separately',async()=>{
 mode='ok';const result=await runAi('edit-assistant',payload(),settings('chat'),{images});
 const parts=last.body.messages[1].content;
 assert.ok(Array.isArray(parts));assert.equal(parts[2].type,'image_url');assert.equal(parts[2].image_url.url,picture);
 const data=JSON.parse(parts[0].text);
 assert.deepEqual(data['当前工程'].assets.map(asset=>asset.id),['one']);
 assert.ok(!JSON.stringify(data).includes('未选素材'));assert.ok(!JSON.stringify(data).includes('private=do-not-send'));
 assert.equal(data['项目参考'].items[1].text,references.items[1].text);
 assert.equal(result.meta.referenceCount,2);assert.equal(result.meta.referenceImageCount,1);
 assert.ok(!JSON.stringify(result).includes('base64'));assert.ok(!JSON.stringify(result).includes('sk-private-test'));
});

test('Responses reference images use input_image alongside input_text',async()=>{
 const result=await runAi('edit-assistant',payload(),settings('responses'),{images});
 assert.equal(last.url,'/v1/responses');
 assert.equal(last.body.input[0].content[0].type,'input_text');
 assert.equal(last.body.input[0].content[2].type,'input_image');
 assert.equal(last.body.input[0].content[2].image_url,picture);
 assert.equal(result.data.action,'reply');
});

test('text-only reference requests do not send pictures or claim visual access',async()=>{
 const input=payload();input.references={...references,includeImages:false};
 const result=await runAi('edit-assistant',input,settings('chat'));
 assert.equal(typeof last.body.messages[1].content,'string');
 const sent=JSON.parse(last.body.messages[1].content);
 assert.ok(sent['项目参考'].items.every(item=>item.frames.length===0));
 assert.equal(result.meta.referenceImageCount,0);
});

test('a visual rejection is explicit and never silently retried without the image',async()=>{
 mode='reject';const previous=count;
 await assert.rejects(runAi('edit-assistant',payload(),settings('chat'),{images}),error=>error.code==='REFERENCE_VISION_REJECTED'&&!error.message.includes('sk-private-test'));
 assert.equal(count,previous+1);mode='ok';
});

test('model plans cannot select unchosen or reference-only IDs',()=>{
 const normalized=buildPrompt('edit-assistant',payload()).payload;
 for(const assetId of ['two','reference-only'])assert.throws(()=>normalizeModelData('edit-assistant',{action:'edit',message:'准备剪辑',plan:{timeline:[{assetId,start:0,end:3}]}},normalized),error=>error.code==='MODEL_ASSET_INVALID');
 const response=normalizeModelData('edit-assistant',{action:'edit',message:'准备插入',plan:{timeline:[{assetId:'one',clipId:'clip-one',start:1,end:3}],captions:[{start:0,end:2,text:'新片段'}]}},normalized);
 assert.equal(response.plan.timeline[0].assetId,'one');assert.equal(response.plan.timeline[0].clipId,undefined);
 assert.equal(response.plan.captions[0].end,2);
});

test('partial selection cannot replace the main track; an empty selection remains empty',()=>{
 const input=payload();input.editScope.placement={mode:'replace'};
 assert.throws(()=>buildPrompt('edit-assistant',input),error=>error.code==='EDIT_SCOPE_REPLACE_REQUIRES_ALL');
 const empty=payload();empty.editScope.assetIds=[];
 const normalized=buildPrompt('edit-assistant',empty).payload;
 assert.deepEqual(normalized.context.assets,[]);assert.deepEqual(normalized.context.timeline,[]);
 assert.throws(()=>normalizeModelData('edit-assistant',{action:'edit',message:'准备剪辑',plan:{timeline:[{assetId:'one',start:0,end:2}]}},normalized),error=>error.code==='MODEL_ASSET_INVALID');
});

test('selected reference aspects reach the prompt and effect output stays bounded',()=>{
 const input=payload();input.references.items[0].aspects=['style','color'];
 const result=buildPrompt('edit-assistant',input);
 assert.deepEqual(JSON.parse(result.user)['项目参考'].items[0].aspects,['style','color']);
 const valid={action:'edit',message:'加入暖色片段',plan:{timeline:[{assetId:'one',start:0,end:3}],look:{preset:'warm',strength:.4},fade:{duration:.2}}};
 const data=normalizeModelData('edit-assistant',valid,result.payload);
 assert.deepEqual(data.plan.look,{preset:'warm',strength:.4});assert.equal(data.plan.fade.duration,.2);
 for(const look of [{preset:'url(file:///private)'},{preset:'warm',strength:2}])assert.throws(()=>normalizeModelData('edit-assistant',{...valid,plan:{...valid.plan,look}},result.payload),error=>error.code==='MODEL_EFFECT_INVALID');
 assert.throws(()=>normalizeModelData('edit-assistant',{...valid,plan:{...valid.plan,fade:{duration:3}}},result.payload),error=>error.code==='MODEL_EFFECT_INVALID');
});

test('reference and attachment limits are rejected before contacting the provider',async()=>{
 const previous=count;
 const input=payload();input.references.items=Array.from({length:9},(_,index)=>({...references.items[1],id:'r'+index}));
 await assert.rejects(runAi('edit-assistant',input,settings('chat')),error=>error.code==='REFERENCE_LIMIT');
 await assert.rejects(runAi('edit-assistant',payload(),settings('chat'),{images:Array(13).fill(images[0])}),error=>error.code==='REFERENCE_IMAGES_LIMIT');
 await assert.rejects(runAi('edit-assistant',payload(),settings('chat'),{images:[{dataUrl:'file:///private.png',label:'bad'}]}),error=>error.code==='REFERENCE_IMAGE_INVALID');
 assert.equal(count,previous);
});
