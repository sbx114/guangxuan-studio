const LEGACY_KEY = 'gx-connection';
const SESSION_TOKEN_KEY='gx-connection-session';
const validSessionToken=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{43}$/.test(value);
const text = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const invalidSettings=()=>Object.assign(new Error('连接设置格式无效，请检查接口地址、模型名称和密钥。'),{code:'CONNECTION_SETTINGS_INVALID'});
function validPublicUrl(value){if(!value)return true;try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&!url.search&&!url.hash;}catch{return false;}}
function publicUrl(value){return typeof value==='string'&&value.length<=2000&&!/[\r\n]/.test(value)&&validPublicUrl(value.trim())?value.trim():'';}
function publicSettings(value) {
 const raw=object(value); return {baseUrl:publicUrl(raw.baseUrl),model:text(raw.model,300),apiStyle:raw.apiStyle==='responses'?'responses':'chat',jsonMode:raw.jsonMode===true,timeoutSeconds:Math.max(10,Math.min(180,Number(raw.timeoutSeconds)||90))};
}
function saveSettings(value){
 if(!value||typeof value!=='object'||Array.isArray(value))throw invalidSettings();
 for(const [field,maximum]of [['baseUrl',2000],['model',300],['apiKey',4096]]){const raw=value[field];if(raw!==undefined&&(raw!==null||field==='apiKey')&&(typeof raw!=='string'||raw.length>maximum||/[\r\n]/.test(raw)))throw invalidSettings();}
 const next={...publicSettings(value),apiKey:typeof value.apiKey==='string'?value.apiKey.trim():''};if(typeof value.baseUrl==='string'&&!validPublicUrl(value.baseUrl.trim()))throw invalidSettings();return next;
}
const SESSION_NOTICE='本机加密保存暂不可用，密钥仅用于本次连接。';
const LAUNCH_NOTICE='请从 Gx 启动入口打开，当前仍可手填用于本次连接。';
const sessionRequired=()=>Object.assign(new Error(LAUNCH_NOTICE),{code:'CONNECTION_SESSION_REQUIRED'});
function rejectPublicKeyCopy(settings){
 const key=typeof settings?.apiKey==='string'?settings.apiKey.trim():'';if(key.length<8)return;
 const decode=value=>{try{return decodeURIComponent(value);}catch{return value.replace(/(?:%[0-9a-f]{2})+/gi,part=>{try{return decodeURIComponent(part);}catch{return part;}});}};
 for(const value of [settings.model,settings.baseUrl]){if(typeof value!=='string')continue;let decoded=value;for(let attempt=0;attempt<4;attempt++){if(decoded.includes(key))throw Object.assign(new Error('密钥请只填写在“API 密钥”栏，不要填入接口地址或模型名称。'),{code:'CONNECTION_PUBLIC_KEY_REPEATED'});if(attempt===3)break;const next=decode(decoded);if(next===decoded)break;decoded=next;}}
}

/** Fixed same-origin routes or existing Electron IPC. Keys never enter web storage. */
export function createConnectionClient(options={}) {
 const desktopApi=Object.hasOwn(options,'desktopApi')?options.desktopApi:globalThis.window?.desktopApi;
 const fetcher=options.fetch??globalThis.fetch?.bind(globalThis);
 let storage; try{storage=Object.hasOwn(options,'storage')?options.storage:globalThis.localStorage;}catch{}
 let sessionStorage;try{sessionStorage=Object.hasOwn(options,'sessionStorage')?options.sessionStorage:globalThis.sessionStorage;}catch{}
 const location=options.location??globalThis.location,history=options.history??globalThis.history;
 let sessionToken='';
 // Consume the trusted launch fragment before any asynchronous request. It is
 // never copied to public settings, localStorage or general fetch defaults.
 try{const fragment=new URLSearchParams((location?.hash||'').replace(/^#/,''));if(fragment.has(SESSION_TOKEN_KEY)){const candidate=fragment.get(SESSION_TOKEN_KEY);fragment.delete(SESSION_TOKEN_KEY);const suffix=fragment.toString();history?.replaceState(history.state,'',(location.pathname||'/')+(location.search||'')+(suffix?'#'+suffix:''));if(validSessionToken(candidate)){sessionToken=candidate;try{sessionStorage?.setItem(SESSION_TOKEN_KEY,candidate);}catch{}}}}catch{}
 if(!sessionToken)try{const stored=sessionStorage?.getItem(SESSION_TOKEN_KEY);if(validSessionToken(stored))sessionToken=stored;}catch{}
 let last={encryptionAvailable:false,rememberKey:false,configured:false,hasSavedKey:false,notice:''};
 function legacy(){let raw={};try{raw=object(JSON.parse(storage?.getItem(LEGACY_KEY)||'{}'));}catch{}
  const settings=publicSettings(raw),remember=typeof raw.rememberKey==='boolean'?raw.rememberKey:null;
  // Rewrite an old record through a strict public-field whitelist, even when
  // an earlier version or imported browser profile left extra fields behind.
  try{if(storage?.getItem(LEGACY_KEY)!==null)storage?.setItem(LEGACY_KEY,JSON.stringify({...settings,...(remember===null?{}:{rememberKey:remember})}));}catch{}
  return {settings,remember};
 }
 function keepPublic(settings,remember){try{storage?.setItem(LEGACY_KEY,JSON.stringify({...publicSettings(settings),...(typeof remember==='boolean'?{rememberKey:remember}:{})}));}catch{}}
 async function request(action,body){if(!sessionToken)throw sessionRequired();if(typeof fetcher!=='function')throw new Error('unavailable');
  const response=await fetcher('/api/connection/'+action,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json','X-Gx-Connection-Session':sessionToken},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
  if(response.status===401){sessionToken='';try{sessionStorage?.removeItem(SESSION_TOKEN_KEY);}catch{}throw sessionRequired();}
  let value;try{value=await response.json();}catch{throw new Error('invalid');}
  if(!response.ok||!value||typeof value!=='object'||Array.isArray(value))throw new Error(response.status===404?'legacy':'unavailable');
  if(action==='load'&&typeof value.encryptionAvailable!=='boolean'||action==='save'&&typeof value.saved!=='boolean'||action==='clear'&&typeof value.cleared!=='boolean')throw new Error('invalid'); return value;
 }
 function normalized(value,{fallback={},remember,sessionKey,action='load'}={}){
  const raw=object(value),settings=object(raw.settings||raw),available=typeof raw.encryptionAvailable==='boolean'?raw.encryptionAvailable:last.encryptionAvailable;
  const configured=typeof raw.configured==='boolean'?raw.configured:typeof raw.saved==='boolean'?raw.saved:Boolean(settings.baseUrl||settings.model||settings.apiKey);
  const next=publicSettings(configured?settings:fallback),key=action==='load'?text(settings.apiKey,16384):sessionKey||'';
  const explicit=typeof raw.rememberKey==='boolean'&&(configured||raw.rememberKey||action!=='load')?raw.rememberKey:remember;
  const rememberKey=available&&(typeof explicit==='boolean'?explicit:true);
  const hasSavedKey=typeof raw.hasSavedKey==='boolean'?raw.hasSavedKey:action==='load'?Boolean(key):raw.rememberKey===true;
  const result={settings:{...next,apiKey:key},configured,encryptionAvailable:available,rememberKey,hasSavedKey,notice:text(raw.notice,500),...(typeof raw.saved==='boolean'?{saved:raw.saved}:{}),...(typeof raw.cleared==='boolean'?{cleared:raw.cleared}:{})};
  last={...result,settings:undefined}; return result;
 }
 return {
  async load(){const old=legacy();try{const raw=typeof desktopApi?.loadConnectionSettings==='function'?await desktopApi.loadConnectionSettings():await request('load',{});return normalized(raw,{fallback:old.settings,remember:old.remember});}
   catch(error){return normalized({settings:{},configured:false,encryptionAvailable:false,rememberKey:false,saved:false,notice:error?.code==='CONNECTION_SESSION_REQUIRED'?LAUNCH_NOTICE:SESSION_NOTICE},{fallback:old.settings,remember:false});}},
  async save(settings,rememberKey){const next=saveSettings(settings);rejectPublicKeyCopy(next);const remember=rememberKey===true;keepPublic(next,remember);
   try{const raw=typeof desktopApi?.saveConnectionSettings==='function'?await desktopApi.saveConnectionSettings(next,remember):await request('save',{settings:next,rememberKey:remember});
    const result=normalized(raw,{fallback:next,remember,sessionKey:next.apiKey,action:'save'});
    // Older Electron IPC returns only a receipt. Keep the just-entered public
    // fields as well as the session key; a receipt is not a new configuration.
    result.settings=next;
    if(result.saved===false)result.notice||=SESSION_NOTICE;
    if(next.apiKey&&(!result.rememberKey||!result.hasSavedKey))result.notice||=remember?'密钥未能加密保存，仅用于本次连接。':'密钥仅用于本次连接。';
    return result;
   }catch(error){const denied=error?.code==='CONNECTION_SESSION_REQUIRED',available=!denied&&last.encryptionAvailable;return normalized({settings:next,configured:false,encryptionAvailable:available,rememberKey:available?remember:false,hasSavedKey:last.hasSavedKey,saved:false,notice:denied?LAUNCH_NOTICE:available?'本次设置已更新，本机保存结果未确认，请重试。':SESSION_NOTICE},{fallback:next,remember:available?remember:false,sessionKey:next.apiKey,action:'save'});}},
  async clear(settings={}){keepPublic(settings,false);try{const raw=typeof desktopApi?.clearConnectionSettings==='function'?await desktopApi.clearConnectionSettings():typeof desktopApi?.saveConnectionSettings==='function'?await desktopApi.saveConnectionSettings({...publicSettings(settings),apiKey:''},false):await request('clear',{});
    return normalized({...raw,settings:publicSettings(settings),configured:true,rememberKey:false,hasSavedKey:false,cleared:raw?.cleared!==false,saved:raw?.saved!==false},{fallback:settings,remember:false,sessionKey:'',action:'clear'});
   }catch(error){return normalized({settings,configured:true,encryptionAvailable:error?.code==='CONNECTION_SESSION_REQUIRED'?false:last.encryptionAvailable,rememberKey:false,hasSavedKey:last.hasSavedKey,saved:false,cleared:false,notice:error?.code==='CONNECTION_SESSION_REQUIRED'?LAUNCH_NOTICE:'当前密钥已清除，本机清除结果未确认，请重试。'},{fallback:settings,remember:false,sessionKey:'',action:'clear'});}}
 };
}
