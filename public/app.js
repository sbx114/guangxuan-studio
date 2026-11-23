import {icon,escapeHtml as h,api,fetchLocal,checkLocalService,toast,showModal,clone,uid,formatDate,timecode,saveFile,copyText,safeName,paragraphs} from './ui.js';

import {createProjectWorkspace} from './project-workspace.js';
import {workspaceHeader,installWorkspaceTools} from './workspace-chrome.js';
import {createScienceWorkspace} from './science-workspace.js';
import {createWritingWorkspace} from './writing-workspace.js';
import {exportPosterImage} from './poster-export.js';
import {createConnectionClient} from './connection-client.js';

const app=document.querySelector('#app');
const state={view:'home',projects:[],writerId:null,videoId:null,scienceId:null,step:'source',channel:'article',editing:false,busy:null,connectionOk:false,settings:{baseUrl:'',model:'',apiKey:'',apiStyle:'chat',jsonMode:false,timeoutSeconds:90},rememberKey:false,saveTimer:null,saveQueue:Promise.resolve()};
const connections=createConnectionClient();
let connectionStorage={encryptionAvailable:false,notice:'',hasSavedKey:false};
const channelLabels={article:'公众号推文',poster:'宣传海报',video:'视频分镜',social:'社群文案'};
const channelIcons={article:'file',poster:'layers',video:'video',social:'text'};
const taskNames={extract:'提取事实',generate:'生成宣传内容',review:'核对内容',rewrite:'改写文案','edit-plan':'编排剪辑','animation-plan':'编排动画'};
const writer=()=>state.projects.find(p=>p.id===state.writerId);
const science=()=>state.projects.find(p=>p.id===state.scienceId);
const videoProject=()=>state.projects.find(p=>p.id===state.videoId);
const writerPositions=new Map();
const workspace=createProjectWorkspace({app,state,saveProject,callAi,requireConnection,onWriting:resumeWriting,onScience:p=>{state.scienceId=p.id;state.view='science';renderShell();},beforeLeave:async({leaving=true}={})=>{if(state.view==='writer'){await writingDesk.flush();if(leaving)writerPositions.set(state.writerId,{step:state.step,channel:state.channel,editing:state.editing,scroll:window.scrollY,outputScroll:app.querySelector('#output-content')?.scrollTop||0});}if(state.view==='science')await scienceDesk.flush();},onLeave:view=>{if(view==='science')scienceDesk.deactivate();if(view==='writer')writingDesk.deactivate();},onOtherView:view=>navigate(view),onAssistantChanged:async p=>{if((state.view==='writer'&&state.writerId===p.id)||(state.view==='science'&&state.scienceId===p.id))renderShell();}});
const scienceDesk=createScienceWorkspace({saveProject,callAi,requireConnection,onAnimation:p=>workspace.showScienceAnimation(p),onVideo:p=>workspace.sendScriptToVideo(p),onNew:()=>workspace.newProjectDialog('science'),onMetadata:(id,changes)=>workspace.updateMetadata(id,changes)});
const writingDesk=createWritingWorkspace({saveProject:p=>saveProject(p,{writingOnly:true,throwOnError:true}),callAi,requireConnection,onNew:()=>workspace.newProjectDialog('writing'),onMetadata:(id,changes)=>workspace.updateMetadata(id,changes),onAssistant:options=>workspace.openAssistant(options),onExport:(p,options={})=>{state.channel=options.channel||'article';exportMenu(p,options);}});
function resumeWriting(p){
 const remembered=writerPositions.get(p.id);
 state.writerId=p.id;state.view='writer';state.step=remembered?.step||(p.outputs?'create':p.facts?.length?'facts':'source');state.channel=remembered?.channel||'article';state.editing=remembered?.editing||false;
 renderShell();requestAnimationFrame(()=>{if(state.view!=='writer'||state.writerId!==p.id)return;window.scrollTo(0,remembered?.scroll||0);const output=app.querySelector('#output-content');if(output)output.scrollTop=remembered?.outputScroll||0;});
}

async function saveProject(p,{assistantOnly=false,writingOnly=false,throwOnError=false}={}){
 if(!p)return null;
 p.updatedAt=new Date().toISOString();
 const index=state.projects.findIndex(x=>x.id===p.id);if(index<0)state.projects.push(p);else state.projects[index]=p;
 const data=writingOnly?null:clone(p);
 const pending=state.saveQueue.catch(()=>{}).then(async()=>{
  const outgoing=writingOnly?clone(p):data;
  if(writingOnly&&outgoing.writingRevision===undefined)outgoing.writingRevision=0;
  try{return await api(`/api/projects/${encodeURIComponent(p.id)}`,outgoing,{method:'PUT'});}
  catch(error){
   if(writingOnly&&['ASSISTANT_STALE_PROJECT','WRITING_STALE_PROJECT'].includes(error.code)){error.latestProject=(await api(`/api/projects/${encodeURIComponent(p.id)}`)).project;error.message='文稿已有较新修改。你的当前输入已保留，可查看新版本后再决定使用哪份。';throw error;}
   if(error.code!=='ASSISTANT_STALE_PROJECT')throw error;
   const fresh=(await api(`/api/projects/${encodeURIComponent(p.id)}`)).project;
   if(!fresh)throw error;
   if(!assistantOnly){workspace.putProject(fresh);workspace.recordSaved(fresh);if((state.view==='writer'&&state.writerId===p.id)||(state.view==='science'&&state.scienceId===p.id))renderShell();error.projectRefreshed=true;error.message='AI 助手已更新项目，界面已刷新。旧版本的修改没有覆盖新内容，请基于当前内容继续编辑。';throw error;}
   const conversation={};
   for(const key of ['assistantMessages','assistantDraft','assistantMode'])if(Object.hasOwn(p.video||{},key))conversation[key]=p.video[key];
   const localScope=p.video?.editScope===undefined?undefined:clone(p.video.editScope);
   fresh.video={...(fresh.video||{}),...clone(conversation)};
   const result=await api(`/api/projects/${encodeURIComponent(p.id)}`,fresh,{method:'PUT'});
   for(const key of Object.keys(p))delete p[key];Object.assign(p,result.project);
   p.video={...(p.video||{}),...conversation};
   if(localScope!==undefined)p.video.editScope=localScope;
   const index=state.projects.findIndex(value=>value.id===p.id);if(index>=0)state.projects[index]=p;
   return result;
  }
 });
 state.saveQueue=pending;
 try{const result=await pending;if(writingOnly){p.writingRevision=result.project.writingRevision;p.assistantRevision=result.project.assistantRevision;}workspace.recordSaved(result.project);const label=document.querySelector('#save-status');if(label)label.textContent=`已保存 · ${formatDate(result.project.updatedAt)}`;return result.project;}
 catch(error){if((error.projectRefreshed||writingOnly)&&state.saveQueue===pending)state.saveQueue=Promise.resolve();if(throwOnError)throw error;toast(`项目保存失败：${error.message}`,'error');return null;}
}
function scheduleSave(p){clearTimeout(state.saveTimer);state.saveTimer=setTimeout(()=>{state.saveTimer=null;void saveProject(p);},650);}
function snapshot(p,label){if(!p)return;p.history||=[];p.history.unshift({id:uid(),at:new Date().toISOString(),label,outputs:clone(p.outputs),facts:clone(p.facts),review:clone(p.review)});p.history=p.history.slice(0,30);}
function requireConnection(){if(!state.settings.baseUrl||!state.settings.model||!state.settings.apiKey){toast('先在模型连接中填写接口地址、模型和密钥');navigate('settings');return false;}return true;}
async function callAi(task,payload,options={}){if(!requireConnection())throw new Error('请完成模型连接设置后再试');const projectId=payload.referenceProjectId||payload.projectId||(state.view==='writer'?state.writerId:state.view==='science'?state.scienceId:state.view==='video'?state.videoId:'');return api('/api/ai',{task,payload:{...payload,...(projectId?{projectId}:{})},settings:state.settings},options);}
function renderShell(){
 if(state.view==='home'){workspace.showHome();return;}
 if(state.view==='video'){void workspace.openLast('video');return;}
 if(state.view==='writer'&&!writer()){workspace.showHome();workspace.newProjectDialog('writing');return;}
 if(state.view==='science'&&!science()){workspace.showHome();workspace.newProjectDialog('science');return;}
  app.innerHTML=`${workspaceHeader(state.view)}<main class="app-main" id="page"></main><footer class="app-footer"><span id="save-status">${['writer','science'].includes(state.view)?'自动保存':''}</span><span>v0.2.3</span></footer>`;
 app.querySelectorAll('[data-nav]').forEach(b=>b.onclick=()=>navigate(b.dataset.nav));
 installWorkspaceTools(app);
 const page=app.querySelector('#page');
 if(state.view==='writer')renderWriter(page);
 if(state.view==='science')scienceDesk.render(page,science());
 if(state.view==='settings')renderSettings(page);
 if(state.view==='archive')renderArchive(page);
}
async function navigate(view){
 if(state.busy&&view!=='writer'){toast('AI正在处理，你可以等待完成或先取消');return;}
 if(view==='home')return workspace.showHome();
 if(['video','writer','science'].includes(view))return workspace.openLast(view);
 if(!await workspace.leaveForWorkspace())return;state.view=view;renderShell();
}
function openProject(id){workspace.showHome(id);}


function renderWriter(page){return writingDesk.render(page,writer());}

function exportOutput(p,channel){const draft=p.writing?.draft;return draft?.channel===channel&&draft.output&&typeof draft.output==='object'&&!Array.isArray(draft.output)?draft.output:p.outputs?.[channel];}
function outputText(p,channel){const o=exportOutput(p,channel);if(!o)return'';if(channel==='article')return `${o.title}\n\n${o.lead||''}\n\n${o.body||''}`;if(channel==='social')return `${o.title}\n\n${o.text}\n\n${(o.tags||[]).map(t=>'#'+t.replace(/^#/,'')).join(' ')}`;if(channel==='poster')return `${o.title}\n${o.subtitle}\n\n${(o.highlights||[]).join('\n')}\n\n${(o.details||[]).map(d=>`${d.label}：${d.value}`).join('\n')}\n\n${o.footer||''}`;return `${o.title}\n总时长：${o.durationSeconds}秒\n\n${(o.shots||[]).map((s,i)=>`镜头${i+1}（${s.duration}秒）\n画面：${s.visual}\n旁白：${s.narration}\n字幕：${s.caption}`).join('\n\n')}`;}
function processReport(p){return `# ${p.title} · 制作记录\n\n导出时间：${new Date().toLocaleString('zh-CN')}\n内容状态：${p.generationMode==='live'?'包含实时AI生成内容':p.isDemo?'预置演示内容':'人工准备'}\n来源：${p.source?.url||'用户输入'}\n\n## 事实与原文依据\n\n${(p.facts||[]).map(f=>`- ${f.label}：${f.value}\n  确认状态：${f.confirmed?'用户已确认':'待确认'}\n  引句：${f.quote}`).join('\n\n')}\n\n## AI调用\n\n${(p.runs||[]).map(r=>`### ${taskNames[r.task]||r.task}\n\n时间：${r.at}\n模型：${r.meta?.model||'未记录'}\n提示词版本：${r.meta?.promptVersion||'未记录'}\n等待时长：${((r.meta?.durationMs||0)/1000).toFixed(1)}秒\n\n系统提示词：\n${r.prompt?.system||''}\n\n用户提示词：\n${r.prompt?.user||''}`).join('\n\n')}\n\n## 修改记录\n\n${(p.history||[]).map(x=>`- ${x.at} ${x.label}`).join('\n')}\n`;}
function exportMenu(p,{channel=state.channel,text}={}){
 const output=exportOutput(p,channel),content=typeof text==='string'?text:outputText(p,channel),title=output?.title||p.title||'我的文稿',name=safeName(title);
 if(!content.trim()){toast('先完成一份稿件再导出');return;}
 showModal({title:'导出当前稿件',body:`<p class="small muted">只导出当前这份${h(channelLabels[channel]||'文稿')}。</p><div class="stack"><button class="btn" data-export="docx">${icon('file')}Word 文档</button><button class="btn" data-export="txt">${icon('text')}纯文本 TXT</button><button class="btn" data-export="md">${icon('download')}Markdown</button>${channel==='poster'?`<button class="btn" data-export="poster">${icon('layers')}海报图片 PNG</button>`:''}${channel==='video'?`<button class="btn" data-export="video">${icon('video')}将这份分镜送入剪辑</button>`:''}</div>`,onMount:(root,close)=>root.querySelectorAll('[data-export]').forEach(b=>b.onclick=async()=>{
  const label=b.innerHTML;b.disabled=true;
  try{
   const type=b.dataset.export;
   if(type==='video')await workspace.sendScriptToVideo(p);
   else if(type==='poster')await exportPoster(p);
   else if(type==='docx'){
    b.textContent='正在生成文档…';
    const response=await fetchLocal('/api/export/docx',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title,sections:[{heading:channelLabels[channel]||'文稿',content}]})});
    if(!response.ok)throw new Error((await response.json()).error||'文档导出未完成，请重试');
    await saveFile(`${name}.docx`,await response.blob());
   }else await saveFile(`${name}.${type}`,content,type==='txt'?'text/plain;charset=utf-8':'text/markdown;charset=utf-8');
   close();
  }catch(error){toast(error.message,'error');b.disabled=false;b.innerHTML=label;}
 })});
}
async function exportPoster(p){return exportPosterImage(exportOutput(p,'poster'),{document,saveFile,safeName});}
async function sendToVideo(p){try{await workspace.sendScriptToVideo(p);}catch(error){toast(error.message,'error');}}
function renderArchiveBase(page){
 const items=state.summaries.slice().sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)));
 page.innerHTML=`<section class="workspace"><div class="workspace-title"><div><h1>项目列表</h1></div><div class="row"><label class="btn" for="import-project">${icon('upload')}导入存档</label><input type="file" id="import-project" accept=".json" class="hidden"><button class="btn primary" id="archive-new">${icon('plus')}新建项目</button></div></div><div class="project-grid">${items.map(p=>`<article class="project-card"><div class="row spread"><span class="eyebrow">${p.kind==='video'?'视频项目':p.kind==='science'?'科普项目':'文案项目'}</span><span class="tiny muted">${formatDate(p.updatedAt)}</span></div><h3>${h(p.title)}</h3>${p.description?`<p>${h(p.description)}</p>`:''}<div class="row spread"><button class="btn small" data-open="${h(p.id)}">项目信息 ${icon('arrow')}</button><div class="row">${p.kind!=='video'?`<button class="icon-btn" data-backup="${h(p.id)}" aria-label="备份${h(p.title)}">${icon('download')}</button>`:''}<button class="icon-btn" data-delete="${h(p.id)}" aria-label="移除${h(p.title)}">${icon('trash')}</button></div></div></article>`).join('')||'<div class="empty-state"><h3>还没有项目</h3></div>'}</div></section>`;
 page.querySelector('#archive-new').onclick=()=>workspace.newProjectDialog();
 page.querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>openProject(b.dataset.open));
 page.querySelectorAll('[data-backup]').forEach(b=>b.onclick=async()=>{try{const p=await workspace.readBackup(b.dataset.backup);await saveFile(`${safeName(p.title)}-项目.json`,JSON.stringify(p,null,2),'application/json');}catch(error){toast(error.message,'error');}});
 page.querySelectorAll('[data-delete]').forEach(b=>b.onclick=()=>{const p=state.summaries.find(x=>x.id===b.dataset.delete);showModal({title:'移除项目存档',body:`<p class="small">从项目列表移除“${h(p.title)}”？媒体和原生工程文件会保留。</p><div class="modal-actions"><button class="btn danger" id="confirm-delete">移除存档</button></div>`,onMount:(root,close)=>root.querySelector('#confirm-delete').onclick=async()=>{try{if(workspace.isBusy(p.id)){toast('此项目的AI操作仍在进行，请完成或取消后再移除');return;}await writingDesk.cancelProject(p.id);await scienceDesk.cancelProject(p.id);await workspace.cancelProject(p.id);clearTimeout(state.saveTimer);await state.saveQueue.catch(()=>{});await api(`/api/projects/${p.id}`,undefined,{method:'DELETE'});workspace.removeProject(p.id);if(state.writerId===p.id)state.writerId=null;if(state.videoId===p.id)state.videoId=null;if(state.scienceId===p.id)state.scienceId=null;await workspace.refreshSummaries();close();renderShell();toast('存档记录已移除');}catch(error){toast(error.message,'error');}}});});
 page.querySelector('#import-project').onchange=async e=>{try{const file=e.target.files[0];if(!file)return;if(file.size>10*1024*1024)throw new Error('存档文件请控制在10MB以内');const p=JSON.parse(await file.text());if(!p||typeof p.title!=='string'||!['video','writing','science',undefined].includes(p.kind))throw new Error('不是有效的光宣存档');if(p.kind==='video'&&(!p.video||!Array.isArray(p.video.timeline)))throw new Error('旧剪辑存档缺少时间线');if(p.kind!=='video'&&(!p.source||typeof p.source.text!=='string'||p.facts!==undefined&&!Array.isArray(p.facts)))throw new Error('文案存档缺少素材或事实');p.id=uid();delete p.writingRevision;delete p.assistantRevision;delete p.metadataRevision;p.kind||='writing';p.facts||=[];p.createdAt=p.updatedAt=new Date().toISOString();p.history||=[];p.runs||=[];p.brief||={audience:'学院师生',scenario:'活动预告',tone:'清晰亲切',length:'标准'};const result=await api(`/api/projects/${p.id}`,p,{method:'PUT'});workspace.putProject(result.project);await workspace.refreshSummaries();workspace.showHome(p.id);toast('存档已导入');}catch(error){toast(error.message,'error');}};
}

function renderArchive(page){
 renderArchiveBase(page);
 const restore=document.createElement('button');restore.type='button';restore.className='btn small';restore.innerHTML=icon('upload')+'恢复完整项目包';restore.onclick=()=>workspace.restoreBundle();page.querySelector('.workspace-title .row')?.append(restore);
 page.querySelectorAll('[data-open]').forEach(open=>{const tools=document.createElement('button');tools.className='btn small';tools.type='button';tools.dataset.openProjectTools=open.dataset.open;tools.textContent='工具';(open.parentElement.querySelector('.row')||open.parentElement).prepend(tools);});
}

function renderSettings(page){
 const s=state.settings;
 const advanced=s.apiStyle==='responses'||s.jsonMode||Number(s.timeoutSeconds||90)!==90;
 const rememberControl=`<div class="native-check"><label class="checkbox-line"><input type="checkbox" id="remember-key" ${state.rememberKey?'checked':''} ${connectionStorage.encryptionAvailable?'':'disabled'}>在本机加密保存密钥</label></div>`;
 page.innerHTML=`<section class="workspace settings-workspace"><div class="workspace-title"><h1>模型连接</h1><span class="pill ${state.connectionOk?'olive':''}" id="connection-label">${state.connectionOk?'已连接':'未测试'}</span></div><div class="settings-layout"><section class="surface"><form id="settings-form"><div class="form-field"><label for="setting-base">接口地址</label><input id="setting-base" type="url" placeholder="https://…/v1" value="${h(s.baseUrl)}" required autocomplete="off"><span class="hint">填写服务商提供的 API 地址。</span></div><div class="form-field"><label for="setting-key">API 密钥</label><div class="settings-key-row"><input id="setting-key" type="password" placeholder="输入密钥" value="${h(s.apiKey)}" required autocomplete="off" spellcheck="false"><button type="button" id="toggle-key" aria-label="显示或隐藏密钥">${icon('eye')}</button></div></div><div class="form-field"><label for="setting-model">模型</label><div class="row"><input class="grow" id="setting-model" list="available-models" placeholder="选择或填写模型名称" value="${h(s.model)}" required autocomplete="off"><datalist id="available-models"></datalist><button type="button" class="btn" id="fetch-models">获取列表</button></div></div><details class="connection-advanced" ${advanced?'open':''}><summary>高级设置</summary><div class="form-grid"><div class="form-field"><label for="setting-style">接口类型</label><select id="setting-style"><option value="chat" ${s.apiStyle==='chat'?'selected':''}>Chat Completions</option><option value="responses" ${s.apiStyle==='responses'?'selected':''}>Responses</option></select></div><div class="form-field"><label for="setting-timeout">超时（秒）</label><input id="setting-timeout" type="number" min="10" max="180" value="${h(s.timeoutSeconds||90)}"></div></div><label class="checkbox-line"><input type="checkbox" id="setting-json" ${s.jsonMode?'checked':''}>JSON 模式</label><p class="hint">仅在服务商支持时开启。</p><div class="notice" id="local-service-notice"><span class="grow" id="local-service-status">正在检查本地服务…</span><button class="btn small" type="button" id="check-local-service">检查</button></div></details>${rememberControl}<div class="row settings-actions"><button class="btn primary" type="submit">${icon('check')}保存</button><button class="btn" type="button" id="test-connection">测试连接</button><button class="btn subtle small" type="button" id="clear-key">清除密钥</button></div><p id="settings-result" class="small muted" role="status" aria-live="polite"></p><p id="connection-storage-notice" class="small muted" role="status">${h(connectionStorage.notice)}</p><p class="settings-privacy">AI 请求会将相关内容发送到上述接口。</p></form></section></div></section>`;

 const localStatus=page.querySelector('#local-service-status');
 const localNotice=page.querySelector('#local-service-notice');
 async function ensureLocalConnection(){
  localStatus.textContent='正在检查本地服务…';localNotice.className='notice';
  try{await checkLocalService();localStatus.textContent='本地服务正常';localNotice.className='notice good';}
  catch(error){localStatus.textContent=error.message;localNotice.className='notice error';page.querySelector('.connection-advanced').open=true;throw error;}
 }
 page.querySelector('#check-local-service').onclick=()=>ensureLocalConnection().catch(error=>toast(error.message,'error'));
 ensureLocalConnection().catch(()=>{});
 const read=()=>({baseUrl:page.querySelector('#setting-base').value.trim(),apiKey:page.querySelector('#setting-key').value.trim(),model:page.querySelector('#setting-model').value.trim(),apiStyle:page.querySelector('#setting-style').value,jsonMode:page.querySelector('#setting-json').checked,timeoutSeconds:Number(page.querySelector('#setting-timeout').value)||90});
 const showStorage=result=>{connectionStorage=result;state.rememberKey=result.rememberKey;const choice=page.querySelector('#remember-key');choice.checked=state.rememberKey;choice.disabled=saving||!result.encryptionAvailable;page.querySelector('#connection-storage-notice').textContent=result.notice||'';};
 let saving=false;
 const lock=value=>{saving=value;for(const id of ['#test-connection','#clear-key','[type="submit"]'])page.querySelector(id).disabled=value;page.querySelector('#remember-key').disabled=value||!connectionStorage.encryptionAvailable;};
 const invalidateConnection=()=>{state.connectionOk=false;const label=page.querySelector('#connection-label');label.textContent='未测试';label.className='pill';};
 async function persist(){const next=read();invalidateConnection();const result=await connections.save(next,Boolean(page.querySelector('#remember-key')?.checked));state.settings=next;showStorage(result);return {settings:next,receipt:result};}
 page.querySelector('#toggle-key').onclick=()=>{const input=page.querySelector('#setting-key');input.type=input.type==='password'?'text':'password';};
 page.querySelector('#settings-form').onsubmit=async e=>{e.preventDefault();if(saving)return;lock(true);try{const {receipt}=await persist();toast(receipt.saved===false?receipt.notice:receipt.notice||'模型配置已保存',receipt.saved===false?'error':'info');}catch(error){toast(error.message,'error');}finally{lock(false);}};
 page.querySelector('#test-connection').onclick=async()=>{if(saving)return;lock(true);const result=page.querySelector('#settings-result');result.textContent='正在测试所选模型…';try{await ensureLocalConnection();const {settings:s}=await persist();const response=await api('/api/connect',{settings:s});state.connectionOk=true;result.textContent=`连接成功 · ${s.model}${response.latencyMs?` · ${(response.latencyMs/1000).toFixed(1)}秒`:''}`;page.querySelector('#connection-label').textContent='已连接';page.querySelector('#connection-label').className='pill olive';toast('中转接口和模型调用成功');}catch(error){result.textContent=error.message;toast(error.message,'error');}finally{lock(false);}};
 page.querySelector('#fetch-models').onclick=async e=>{const b=e.currentTarget;b.disabled=true;const result=page.querySelector('#settings-result');result.textContent='正在获取模型列表…';try{await ensureLocalConnection();const response=await api('/api/models',{settings:read()});page.querySelector('#available-models').innerHTML=(response.models||[]).map(m=>`<option value="${h(m.id)}"></option>`).join('');result.textContent=`已获取 ${response.models.length} 个模型。`;page.querySelector('#setting-model').focus();}catch(error){result.textContent=error.code?.startsWith('LOCAL_SERVICE_')?error.message:`${error.message} 可手动填写模型名称。`;}finally{b.disabled=false;}};
 page.querySelector('#clear-key').onclick=async()=>{if(saving)return;lock(true);state.settings={...read(),apiKey:''};state.rememberKey=false;invalidateConnection();page.querySelector('#settings-result').textContent='';page.querySelector('#setting-key').value='';try{const result=await connections.clear(state.settings);showStorage(result);toast(result.cleared?'当前与已保存的密钥已清除':result.notice,result.cleared?'info':'error');}finally{lock(false);}};
}
async function init(){
 try{
  const results=await Promise.allSettled([api('/api/projects/summary'),connections.load()]);
  const settings=results[1];
  if(settings.status==='fulfilled'&&settings.value){state.settings={...state.settings,...settings.value.settings};state.rememberKey=settings.value.rememberKey;connectionStorage=settings.value;}
  const projects=results[0];
  if(projects.status!=='fulfilled'){
   const error=projects.reason;
   const updateNeeded=error?.code==='PROJECT_NOT_FOUND'||error?.code==='NOT_FOUND';
   app.classList.remove('gx-workspace-hidden');
   app.innerHTML='<div class="boot-message"><section style="max-width:560px;padding:24px"><h2>'+ (updateNeeded?'请完成应用更新':'项目档案暂时未能读取') +'</h2><p>'+ (updateNeeded?'请双击桌面“重启光宣工作台”，让新版后台接管后再继续。':h(error?.message||'本地服务尚未就绪，请稍后重试。')) +'</p><p class="muted small">现有存档仍保存在本机，不会按空项目处理。</p><button class="btn primary" id="retry-startup">重新检查</button></section></div>';
   app.querySelector('#retry-startup').onclick=()=>init();return;
  }
  state.summaries=Array.isArray(projects.value.projects)?projects.value.projects:[];
  state.summaryLoadedAt=Date.now();
  if(projects.value.warning)toast(projects.value.warning);
  state.writerId=state.summaries.find(p=>p.kind==='writing')?.id;
  state.videoId=state.summaries.find(p=>p.kind==='video')?.id;
  state.scienceId=state.summaries.find(p=>p.kind==='science')?.id;
  renderShell();
 }catch(error){app.innerHTML='<div class="boot-message"><p>启动失败：'+h(error.message)+'</p></div>';}
}
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();if(state.view==='writer'){void writingDesk.flush().then(()=>toast('文稿已保存')).catch(error=>toast(error.message,'error'));return;}if(state.view==='video'||state.view==='science'){void workspace.flush().then(()=>toast('编辑内容已保存')).catch(error=>toast(error.message,'error'));}}});
document.addEventListener('click',event=>{const assistant=event.target.closest('[data-open-assistant]');if(assistant){workspace.openAssistant();return;}const tasks=event.target.closest('[data-tasks]');if(tasks){workspace.openTasks();return;}const tools=event.target.closest('[data-open-project-tools]');if(tools)void workspace.openTools(tools.dataset.openProjectTools);});
window.addEventListener('pagehide',()=>{writingDesk.dispose();scienceDesk.dispose();workspace.dispose();});
window.addEventListener('error',()=>toast('界面遇到问题，请保存项目后重新打开','error'));
init();
