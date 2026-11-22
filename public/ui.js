export const escapeHtml = (value='') => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const clone = (v) => structuredClone(v);
export const uid = () => crypto.randomUUID();
export const timecode = (n=0) => { n=Math.max(0,Number(n)||0); return `${Math.floor(n/60).toString().padStart(2,'0')}:${Math.floor(n%60).toString().padStart(2,'0')}.${Math.floor(n%1*10)}`; };
export const formatDate = (s) => s ? new Date(s).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}) : '尚未保存';
const paths = {
 home:'M3 11 12 3l9 8M5 10v11h5v-7h4v7h5V10',
 video:'M3 5h18v14H3zM8 5v14M16 5v14M3 9h5M3 15h5M16 9h5M16 15h5',
 pen:'m4 16 12-12 4 4L8 20l-5 1zM13 7l4 4',
 science:'M9 3h6M10 3v6l-6 11h16L14 9V3M7 15h10',
 folder:'M3 6h6l2 3h10v11H3z',
 settings:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2',
 plus:'M12 4v16M4 12h16',
 arrow:'M4 12h15M13 6l6 6-6 6',
 back:'M20 12H5M11 6l-6 6 6 6',
 spark:'m12 2 2.6 7.4L22 12l-7.4 2.6L12 22l-2.6-7.4L2 12l7.4-2.6z',
 check:'m4 12 5 5L20 6',
 close:'M5 5l14 14M19 5 5 19',
 upload:'M12 16V3M7 8l5-5 5 5M3 15v6h18v-6',
 download:'M12 3v13M7 11l5 5 5-5M3 17v4h18v-4',
 copy:'M8 8h12v13H8zM16 8V3H3v13h5',
 file:'M5 2h9l5 5v15H5zM14 2v6h5M8 12h8M8 16h8',
 link:'m10 14 4-4M8 15l-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0M16 9l1-1a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0',
 clock:'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 7v5l4 2',
 shield:'m12 2 9 4v6c0 6-9 10-9 10S3 18 3 12V6zM8 12l3 3 5-6',
 play:'m8 4 13 8-13 8z',
 pause:'M8 4v16M16 4v16',
 cut:'M9 9 21 3M9 15l12 6M6 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8M6 12a4 4 0 1 0 0 8 4 4 0 0 0 0-8',
 trash:'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
 undo:'M3 10h10a7 7 0 0 1 0 14M3 10l6-6M3 10l6 6',
 text:'M4 4h16M12 4v17M8 21h8M4 4v4M20 4v4',
 audio:'M9 18V5l11-2v13M9 9l11-2M9 18a3 3 0 1 1-3-3M20 16a3 3 0 1 1-3-3',
 layers:'m12 2 10 6-10 6L2 8zM2 12l10 6 10-6M2 16l10 6 10-6',
 animation:'M3 3h18v18H3zM8 8l9 4-9 4z',
 chevron:'m8 4 8 8-8 8',
 eye:'M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
 refresh:'M21 4v6h-6M3 20v-6h6M20 10a8 8 0 0 0-14-5M4 14a8 8 0 0 0 14 5',
 more:'M5 12h.01M12 12h.01M19 12h.01',
 info:'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 11v6M12 7v.1',
 search:'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14M15 15l7 7'
};
export function icon(name,cls='') { return `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name]||paths.file}"/></svg>`; }
export function toast(text,type='info') { const el=document.createElement('div'); el.className=`toast ${type}`; el.innerHTML=`${icon(type==='error'?'info':'check')}<span>${escapeHtml(text)}</span>`; document.querySelector('#toast-region').append(el); setTimeout(()=>el.remove(),6500); }
function localConnectionError(code='LOCAL_SERVICE_UNAVAILABLE') {
 const address=globalThis.location?.host || '当前窗口';
 const message=globalThis.location?.protocol==='file:'
  ? '请通过“启动光宣工作台.cmd”打开应用，直接打开网页文件无法连接本地工作服务。'
  : `应用没有收到本地工作服务的响应（${address}）。请重新双击“启动光宣工作台.cmd”，在新打开的窗口中重试。`;
 const error=new Error(message);error.code=code;return error;
}
export async function fetchLocal(path,options={}) {
 try { return await fetch(path,options); }
 catch(error) {
  if(error?.name==='AbortError'||options.signal?.aborted&&options.signal.reason?.name==='AbortError')throw error;
  throw localConnectionError(error?.name==='TimeoutError'?'LOCAL_SERVICE_TIMEOUT':'LOCAL_SERVICE_UNAVAILABLE');
 }
}
export async function api(path,body,options={}) {
 const response=await fetchLocal(path,{...options,method:options.method||(body!==undefined?'POST':'GET'),headers:{...(body!==undefined?{'Content-Type':'application/json'}:{}),...options.headers},...(body!==undefined?{body:JSON.stringify(body)}:{})});
 let data;
 try { data=await response.json(); }
 catch(error) {
  if(error?.name==='AbortError')throw error;
  const invalid=new Error(`本地工作服务返回了无法读取的响应（HTTP ${response.status}）。请重新打开应用后重试。`);
  invalid.code='LOCAL_SERVICE_INVALID_RESPONSE';invalid.status=response.status;throw invalid;
 }
 if(!response.ok) {
  const error=new Error(typeof data?.error==='string'?data.error:data?.error?.message||data?.message||`请求失败（${response.status}）`);
  error.code=data?.code||'REQUEST_FAILED';error.status=response.status;throw error;
 }
 return data;
}
export async function checkLocalService() {
 const result=await api('/api/health',undefined,{signal:AbortSignal.timeout(3500)});
 if(result?.ok!==true||result?.name!=='Guangxuan Studio') {
  const error=new Error('当前地址没有连接到光宣工作台服务，请使用桌面启动入口重新打开。');
  error.code='LOCAL_SERVICE_MISMATCH';throw error;
 }
 return result;
}
let activeModal = null;
let modalRequest = 0;
export function showModal({title,kicker='',body,wide=false,onMount,onClose}) {
 const root = document.querySelector('#modal-root');
 const request = ++modalRequest;
 const previous = activeModal?.previous || document.activeElement;
 activeModal?.finish(false);
 // A close callback may itself open a newer dialog.
 if (request !== modalRequest) return () => {};
 root.innerHTML=`<div class="modal-backdrop"><section class="modal ${wide?'wide':''}" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}" tabindex="-1"><div class="modal-top"><span class="eyebrow">${escapeHtml(kicker)}</span><button class="icon-btn" data-close aria-label="关闭">${icon('close')}</button></div><h2>${escapeHtml(title)}</h2><div class="modal-body">${body}</div></section></div>`;
 const panel = root.querySelector('.modal');
 panel.style.overscrollBehavior = 'contain';
 const background = [...document.body.children].filter(node => !node.contains(root) && node.id !== 'toast-region').map(node => ({ node, inert: node.inert }));
 const scroll = [document.documentElement, document.body].map(node => ({ node, values: ['overflow', 'overflow-x', 'overflow-y'].map(name => [name, node.style.getPropertyValue(name), node.style.getPropertyPriority(name)]) }));
 let closed = false;
 const items = () => [...root.querySelectorAll('button,input,select,textarea,a[href],summary,audio[controls],video[controls],[tabindex]')].filter(node => node.tabIndex >= 0 && !node.disabled && !node.closest('[hidden],[inert]') && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
 const focusFirst = () => (items()[0] || panel).focus({ preventScroll: true });
 const session = { previous, finish };
 function finish(restoreFocus = true) {
  if (closed) return;
  closed = true;
  document.removeEventListener('keydown', key, true);
  document.removeEventListener('focusin', containFocus, true);
  if (activeModal === session) {
   activeModal = null;
   root.replaceChildren();
   for (const { node, inert } of background) node.inert = inert;
   for (const { node, values } of scroll) {
    node.style.removeProperty('overflow');
    for (const [name, value, priority] of values) if (value) node.style.setProperty(name, value, priority);
   }
   if (restoreFocus && previous?.isConnected && !previous.closest('[inert]')) previous.focus({ preventScroll: true });
  }
  onClose?.();
 }
 const close = () => finish();
 const key = event => {
  if (activeModal !== session) return;
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
  if (event.key !== 'Tab') return;
  const targets = items(), first = targets[0], last = targets.at(-1), focused = document.activeElement;
  if (!targets.length) { event.preventDefault(); panel.focus({ preventScroll: true }); }
  else if (!root.contains(focused) || focused === panel || (event.shiftKey ? focused === first : focused === last)) {
   event.preventDefault(); (event.shiftKey ? last : first).focus({ preventScroll: true });
  }
 };
 const containFocus = event => { if (activeModal === session && !root.contains(event.target)) focusFirst(); };
 activeModal = session;
 for (const { node } of background) node.inert = true;
 for (const { node } of scroll) node.style.setProperty('overflow', 'hidden');
 root.querySelector('[data-close]').onclick = close;
 root.querySelector('.modal-backdrop').onclick = event => { if (event.target === event.currentTarget) close(); };
 document.addEventListener('keydown', key, true);
 document.addEventListener('focusin', containFocus, true);
 focusFirst();
 try { onMount?.(root, close); }
 catch (error) { close(); throw error; }
 return close;
}
export async function saveFile(name,content,mime='text/plain;charset=utf-8') {
 if(window.desktopApi?.saveFile){
  let data=content,encoding='utf8';
  if(content instanceof Blob){ const bytes=new Uint8Array(await content.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));data=btoa(binary);encoding='base64'; }
  const result=await window.desktopApi.saveFile({name,content:data,encoding});
  if(!result?.canceled)toast('文件已保存');
  return result;
 }
 const blob=content instanceof Blob?content:new Blob([content],{type:mime});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1500);
}
export async function copyText(text) { try{await navigator.clipboard.writeText(text);toast('已复制到剪贴板');}catch{toast('复制失败，请使用导出文件','error');} }
export const safeName = s => String(s||'光宣作品').replace(/[\\/:*?"<>|\u0000-\u001f]/g,'_').slice(0,70);
export function paragraphs(text='') {return escapeHtml(text).split(/\n{2,}/).map(p=>`<p>${p.replace(/\n/g,'<br>')}</p>`).join('');}
