import test from 'node:test';
import assert from 'node:assert/strict';
import { api, fetchLocal, checkLocalService } from '../public/ui.js';

test('browser transport failure identifies the current local endpoint without sending to another port', async t => {
  const oldLocation=globalThis.location;
  globalThis.location={protocol:'http:',host:'127.0.0.1:4317'};
  t.after(()=>{if(oldLocation===undefined)delete globalThis.location;else globalThis.location=oldLocation;});
  const requests=[];
  t.mock.method(globalThis,'fetch',async (...args)=>{requests.push(args);throw new TypeError('Failed to fetch');});
  await assert.rejects(api('/api/models',{settings:{apiKey:'test-secret-do-not-echo'}}),error=>{
    assert.equal(error.code,'LOCAL_SERVICE_UNAVAILABLE');
    assert.match(error.message,/127\.0\.0\.1:4317/);
    assert.match(error.message,/启动光宣工作台/);
    assert.doesNotMatch(error.message,/test-secret-do-not-echo/);
    return true;
  });
  assert.equal(requests.length,1);
  assert.equal(requests[0][0],'/api/models');
});

test('upstream authentication errors remain distinct from a disconnected local app', async t => {
  t.mock.method(globalThis,'fetch',async ()=>new Response(JSON.stringify({error:'接口未通过身份验证，请检查 API 密钥。',code:'UPSTREAM_HTTP_401'}),{status:502,headers:{'Content-Type':'application/json'}}));
  await assert.rejects(api('/api/connect',{}),error=>{
    assert.equal(error.code,'UPSTREAM_HTTP_401');
    assert.match(error.message,/身份验证/);
    assert.doesNotMatch(error.message,/本地工作服务/);
    return true;
  });
});

test('health preflight only probes the local service and rejects an unexpected server', async t => {
  const calls=[];
  t.mock.method(globalThis,'fetch',async (url,options)=>{calls.push({url,options});return new Response(JSON.stringify({ok:true,name:'Some other service'}),{status:200});});
  await assert.rejects(checkLocalService(),{code:'LOCAL_SERVICE_MISMATCH'});
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,'/api/health');
  assert.equal(calls[0].options.method,'GET');
  assert.equal(calls[0].options.body,undefined);
});

test('health preflight recognizes the app and invalid JSON cannot silently become an empty result', async t => {
  let healthy=true;
  t.mock.method(globalThis,'fetch',async ()=>new Response(healthy?JSON.stringify({ok:true,name:'Guangxuan Studio'}):'<html>proxy failure</html>',{status:200}));
  assert.equal((await checkLocalService()).ok,true);
  healthy=false;
  await assert.rejects(api('/api/models',{}),{code:'LOCAL_SERVICE_INVALID_RESPONSE'});
});

test('user cancellation is not misreported as a broken service', async t => {
  const aborted=new DOMException('Cancelled','AbortError');
  t.mock.method(globalThis,'fetch',async ()=>{throw aborted;});
  await assert.rejects(fetchLocal('/api/ai'),error=>error===aborted);
});
