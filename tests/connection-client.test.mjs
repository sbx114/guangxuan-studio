import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import { createConnectionClient as createActualConnectionClient } from '../public/connection-client.js';
import { createConnectionStore } from '../lib/connection-store.mjs';

const KEY='fixture-key-no-real-provider-connection';
const TOKEN='T'.repeat(43);
const settings={baseUrl:'https://fixture.invalid/v1',model:'fixture',apiKey:KEY,apiStyle:'responses',jsonMode:true,timeoutSeconds:123};
const memory=initial=>{const values=new Map(Object.entries(initial||{}));return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key),values};};
const createConnectionClient=options=>createActualConnectionClient({sessionStorage:memory({'gx-connection-session':TOKEN}),...options});
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});

test('browser migration keeps only public legacy fields and encrypted save uses fixed same-origin JSON routes',async()=>{
 const storage=memory({'gx-connection':JSON.stringify({...settings,authorization:KEY,unexpected:'drop'})}),calls=[];
 const client=createConnectionClient({desktopApi:null,storage,fetch:async(url,options)=>{calls.push({url,options,body:JSON.parse(options.body)});return url.endsWith('/load')?json({settings:{},configured:false,rememberKey:null,encryptionAvailable:true,hasSavedKey:false}):json({saved:true,settings:{baseUrl:settings.baseUrl},configured:true,rememberKey:true,encryptionAvailable:true,hasSavedKey:true});}});
 const loaded=await client.load();assert.equal(loaded.settings.baseUrl,settings.baseUrl);assert.equal(loaded.settings.apiKey,'');assert.equal(loaded.rememberKey,true);assert.ok(!JSON.stringify([...storage.values]).includes(KEY));
 const saved=await client.save(settings,true);assert.equal(saved.settings.apiKey,KEY);assert.equal(saved.settings.model,'fixture');assert.equal(saved.hasSavedKey,true);assert.equal(saved.saved,true);
 assert.deepEqual(calls.map(call=>call.url),['/api/connection/load','/api/connection/save']);assert.deepEqual(calls[0].body,{});assert.deepEqual(calls[1].body,{settings,rememberKey:true});
 for(const call of calls){assert.equal(call.options.method,'POST');assert.equal(call.options.cache,'no-store');assert.equal(call.options.credentials,'same-origin');assert.ok(!call.url.includes(KEY));}assert.ok(!JSON.stringify([...storage.values]).includes(KEY));
});

test('Electron still uses the original flat IPC load, save receipt and clear without browser HTTP',async()=>{
 const calls=[],storage=memory(),client=createConnectionClient({storage,fetch:()=>assert.fail('Electron must retain IPC'),desktopApi:{loadConnectionSettings:async()=>({...settings,encryptionAvailable:true,rememberKey:true}),saveConnectionSettings:async(...args)=>{calls.push(args);return {saved:true,rememberKey:true};},clearConnectionSettings:async()=>{calls.push('clear');return {cleared:true};}}});
 assert.equal((await client.load()).settings.apiKey,KEY);const saved=await client.save(settings,true);assert.deepEqual(saved.settings,settings);assert.equal(saved.hasSavedKey,true);assert.equal(saved.encryptionAvailable,true);
 const clear=await client.clear(settings);assert.equal(clear.cleared,true);assert.equal(clear.settings.apiKey,'');assert.equal(clear.rememberKey,false);assert.equal(clear.hasSavedKey,false);assert.deepEqual(calls,[[settings,true],'clear']);assert.ok(!JSON.stringify([...storage.values]).includes(KEY));
});

test('explicit do-not-remember survives reopening while a new capable installation defaults on',async()=>{
 for(const [configured,remember,wanted] of [[false,null,true],[true,false,false],[true,true,true]]){
  const client=createConnectionClient({storage:memory(),desktopApi:null,fetch:async()=>json({settings:{baseUrl:'https://fixture.invalid/v1',model:'fixture'},configured,rememberKey:remember,encryptionAvailable:true,hasSavedKey:remember===true})});assert.equal((await client.load()).rememberKey,wanted);
 }
});

test('old server, invalid JSON and unavailable storage remain session-only without a false save or clear receipt',async()=>{
 for(const fetcher of [async()=>json({code:'NOT_FOUND'},404),async()=>new Response('<html>bad</html>'),async()=>{throw new Error('network key='+KEY);}]){
  const storage=memory({'gx-connection':JSON.stringify({baseUrl:settings.baseUrl,model:settings.model})}),client=createConnectionClient({desktopApi:null,storage,fetch:fetcher});
  const loaded=await client.load();assert.equal(loaded.settings.baseUrl,settings.baseUrl);assert.equal(loaded.settings.apiKey,'');assert.equal(loaded.encryptionAvailable,false);assert.match(loaded.notice,/本次/);
  const saved=await client.save(settings,true);assert.equal(saved.saved,false);assert.equal(saved.settings.apiKey,KEY);assert.match(saved.notice,/本次/);assert.ok(!saved.notice.includes(KEY));
  const cleared=await client.clear(settings);assert.equal(cleared.cleared,false);assert.equal(cleared.settings.apiKey,'');assert.match(cleared.notice,/清除结果未确认/);assert.ok(!JSON.stringify([...storage.values]).includes(KEY));
 }
 const denied={getItem(){throw new Error('denied');},setItem(){throw new Error('denied');}},client=createConnectionClient({desktopApi:null,storage:denied,fetch:async()=>json({settings:{},configured:false,encryptionAvailable:false,rememberKey:null,notice:'系统加密不可用'})});assert.equal((await client.load()).encryptionAvailable,false);
});

test('decryption failure and unavailable encryption show safe notices while the session retains newly entered credentials',async()=>{
 const client=createConnectionClient({desktopApi:null,storage:memory(),fetch:async url=>url.endsWith('/load')?json({settings:{...settings,apiKey:''},configured:true,encryptionAvailable:true,rememberKey:true,hasSavedKey:true,notice:'已保存的密钥无法解密，请重新填写。'}):json({settings:{...settings,apiKey:''},configured:true,encryptionAvailable:false,rememberKey:false,hasSavedKey:false,saved:true,notice:'系统加密不可用，密钥仅用于本次连接。'})});
 const loaded=await client.load();assert.equal(loaded.settings.apiKey,'');assert.match(loaded.notice,/无法解密/);assert.equal(loaded.rememberKey,true);
 const saved=await client.save(settings,false);assert.equal(saved.settings.apiKey,KEY);assert.equal(saved.rememberKey,false);assert.match(saved.notice,/本次/);
});

test('a known long key copied into a public model or encoded URL is rejected before any public storage write',async()=>{
 const original=JSON.stringify({baseUrl:'https://fixture.invalid/v1',model:'existing-public-model'});
 const encoded=[...KEY].map(character=>'%'+character.charCodeAt(0).toString(16)).join('');
 for(const changes of [{model:KEY},{baseUrl:'https://fixture.invalid/'+KEY+'/v1'},...[encoded,encoded.replaceAll('%','%25'),encoded.replaceAll('%','%2525')].map(value=>({baseUrl:'https://fixture.invalid/'+value+'/v1'}))]){
  const storage=memory({'gx-connection':original});let requests=0;const client=createConnectionClient({desktopApi:null,storage,fetch:async()=>{requests++;return json({saved:true});}});
  await assert.rejects(client.save({...settings,...changes},true),error=>{assert.equal(error.code,'CONNECTION_PUBLIC_KEY_REPEATED');assert.ok(!error.message.includes(KEY));return true;});
  assert.equal(storage.getItem('gx-connection'),original);assert.equal(requests,0);assert.ok(!JSON.stringify([...storage.values]).includes(KEY));
 }
});

test('a short key is not confused with an ordinary model suffix or the v1 API path',async()=>{
 const storage=memory();let requests=0;const client=createConnectionClient({desktopApi:null,storage,fetch:async()=>{requests++;return json({saved:true,rememberKey:true,encryptionAvailable:true,hasSavedKey:true});}});
 const saved=await client.save({...settings,baseUrl:'https://fixture.invalid/v1',model:'model-1',apiKey:'1'},true);assert.equal(saved.saved,true);assert.equal(saved.settings.apiKey,'1');assert.equal(requests,1);assert.equal(JSON.parse(storage.getItem('gx-connection')).model,'model-1');assert.equal(JSON.parse(storage.getItem('gx-connection')).apiKey,undefined);
});

test('invalid connection input is rejected before touching existing public storage or requesting the server',async()=>{
 const original=JSON.stringify({baseUrl:'https://fixture.invalid/v1',model:'existing-public-model'});
 const invalid=[{baseUrl:'https://user:other-password@fixture.invalid/v1'},{baseUrl:'https://fixture.invalid/v1?token=other-password'},{baseUrl:'https://fixture.invalid/v1#other-password'},{baseUrl:'file:///private/connection'},{baseUrl:'not a URL'},{baseUrl:'https://fixture.invalid/'+ 'x'.repeat(2000)},{model:'x'.repeat(301)},{apiKey:'x'.repeat(4097)},{baseUrl:settings.baseUrl+'\r\n'},{model:'fixture\nmodel'},{apiKey:KEY+'\r'},{model:42}];
 for(const changes of invalid){const storage=memory({'gx-connection':original});let requests=0;const client=createConnectionClient({desktopApi:null,storage,fetch:async()=>{requests++;return json({saved:true});}});await assert.rejects(client.save({...settings,...changes},true),error=>{assert.equal(error.code,'CONNECTION_SETTINGS_INVALID');assert.ok(!error.message.includes('other-password'));assert.ok(!error.message.includes(KEY));return true;});assert.equal(storage.getItem('gx-connection'),original);assert.equal(requests,0);}
 const client=createConnectionClient({desktopApi:null,storage:memory(),fetch:async()=>json({saved:true,rememberKey:false,encryptionAvailable:true,hasSavedKey:false})});const empty=await client.save({baseUrl:'',model:'',apiKey:''},false);assert.equal(empty.saved,true);assert.equal(empty.settings.baseUrl,'');
});

test('legacy migration removes invalid public URLs while preserving ordinary public connection fields',async()=>{
 for(const baseUrl of ['https://user:other-password@fixture.invalid/v1','https://fixture.invalid/v1?token=other-password','https://fixture.invalid/v1#other-password']){const storage=memory({'gx-connection':JSON.stringify({...settings,baseUrl,apiKey:undefined})});const client=createConnectionClient({desktopApi:null,storage,fetch:async()=>json({settings:{},configured:false,rememberKey:null,encryptionAvailable:true})});const loaded=await client.load(),persisted=storage.getItem('gx-connection');assert.equal(loaded.settings.baseUrl,'');assert.equal(loaded.settings.model,settings.model);assert.equal(loaded.settings.apiStyle,'responses');assert.equal(loaded.settings.timeoutSeconds,123);assert.equal(JSON.parse(persisted).baseUrl,'');assert.ok(!persisted.includes('other-password'));}
});

test('a lost response after a real encrypted commit preserves remember choice and retry cannot delete the saved key', {timeout:30000},async t=>{
 const parent=path.resolve(process.env.GUANGXUAN_TEST_DIR||os.tmpdir());await mkdir(parent,{recursive:true});const directory=await mkdtemp(path.join(parent,'gx-connection-response-loss-')),store=await createConnectionStore({dataDir:directory}),reopened=await createConnectionStore({dataDir:directory}),storage=memory(),choices=[];let loseSave=true;
 t.after(async()=>{await reopened.close();await store.close();assert.equal(path.dirname(directory),parent);await rm(directory,{recursive:true,force:true});});
 const client=createConnectionClient({desktopApi:null,storage,fetch:async(url,options)=>{if(url.endsWith('/load'))return json(await store.load());if(url.endsWith('/clear')){await store.clear();throw new TypeError('Simulated response lost after clear');}const input=JSON.parse(options.body);choices.push(input.rememberKey);const result=await store.save(input);if(loseSave){loseSave=false;throw new TypeError('Simulated response lost after commit');}return json(result);}});
 assert.equal((await client.load()).encryptionAvailable,true);const lost=await client.save(settings,true);assert.equal(lost.saved,false);assert.equal(lost.rememberKey,true);assert.equal(lost.settings.apiKey,KEY);assert.match(lost.notice,/结果未确认/);assert.doesNotMatch(lost.notice,/仅用于本次|未能安全保存/);
 const restored=await reopened.load();assert.equal(restored.settings.apiKey,KEY);assert.equal(restored.hasSavedKey,true);const disk=await readFile(path.join(directory,'connection-settings.json'),'utf8');assert.ok(JSON.parse(disk).encryptedApiKey);assert.ok(!disk.includes(KEY));
 const retried=await client.save(settings,lost.rememberKey);assert.equal(retried.saved,true);assert.equal(retried.rememberKey,true);assert.deepEqual(choices,[true,true]);assert.equal((await reopened.load()).settings.apiKey,KEY);assert.ok(!JSON.stringify([...storage.values]).includes(KEY));
 const cleared=await client.clear(settings);assert.equal(cleared.cleared,false);assert.match(cleared.notice,/清除结果未确认/);assert.doesNotMatch(cleared.notice,/未能删除/);assert.equal((await reopened.load()).settings.apiKey,'');
 if(process.env.GUANGXUAN_CONNECTION_UI_EVIDENCE){const evidence=path.resolve(process.env.GUANGXUAN_CONNECTION_UI_EVIDENCE);await mkdir(evidence,{recursive:true});await writeFile(path.join(evidence,'response-loss.json'),JSON.stringify({status:'passed',actualStore:true,actualWindowsEncryption:true,simulatedResponseLossAfterCommit:true,ciphertextActuallyReopened:true,saveUnconfirmed:true,rememberChoicePreserved:true,retryChoices:choices,clearResponseLossAfterCommit:true,clearUnconfirmed:true,clearActuallyCompleted:true,noPlaintextInDataOrWebStorage:true},null,2));}
});

test('trusted launch fragment is consumed synchronously and session token is attached only to fixed connection requests',async()=>{
 const session=memory(),storage=memory(),changes=[],calls=[],location={pathname:'/index.html',search:'?view=connection',hash:'#gx-connection-session='+TOKEN},history={state:null,replaceState(...args){changes.push(args);location.hash='';}};
 const client=createActualConnectionClient({desktopApi:null,sessionStorage:session,storage,location,history,fetch:async(url,options)=>{calls.push({url,options});return json({settings:{},configured:false,rememberKey:null,encryptionAvailable:true,...(url.endsWith('/save')?{saved:true,rememberKey:true,hasSavedKey:true}:{}),...(url.endsWith('/clear')?{cleared:true}:{})});}});
 assert.equal(changes.length,1);assert.equal(changes[0][2],'/index.html?view=connection');assert.equal(location.hash,'');assert.equal(session.getItem('gx-connection-session'),TOKEN);assert.ok(!JSON.stringify([...storage.values]).includes(TOKEN));assert.equal(calls.length,0);
 await client.load();await client.save(settings,true);await client.clear(settings);assert.deepEqual(calls.map(call=>call.url),['/api/connection/load','/api/connection/save','/api/connection/clear']);for(const call of calls)assert.equal(call.options.headers['X-Gx-Connection-Session'],TOKEN);assert.ok(!JSON.stringify([...storage.values]).includes(TOKEN));assert.ok(!JSON.stringify([...session.values]).includes(KEY));
});

test('missing or rejected session token keeps manual session settings usable and cannot access encrypted storage',async()=>{
 let requests=0;const empty=memory(),missing=createActualConnectionClient({desktopApi:null,sessionStorage:empty,storage:memory(),fetch:async()=>{requests++;return json({});}});
 const absent=await missing.load();assert.match(absent.notice,/启动入口/);assert.equal(absent.encryptionAvailable,false);const temporary=await missing.save(settings,true);assert.equal(temporary.settings.apiKey,KEY);assert.equal(temporary.saved,false);assert.equal(temporary.rememberKey,false);assert.match(temporary.notice,/启动入口/);assert.equal(requests,0);
 const session=memory({'gx-connection-session':TOKEN}),rejected=createActualConnectionClient({desktopApi:null,sessionStorage:session,storage:memory(),fetch:async()=>{requests++;return json({code:'CONNECTION_SESSION_REQUIRED'},401);}});const denied=await rejected.load();assert.match(denied.notice,/启动入口/);assert.equal(session.getItem('gx-connection-session'),null);assert.equal((await rejected.save(settings,true)).settings.apiKey,KEY);assert.equal(requests,1,'401 clears the invalid token instead of retrying persistence with it');
});
