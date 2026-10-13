import {readPage} from './page-api.js';
import {readGeneratedPage} from './generated-resource.js';
import {withTimeout} from './async.js';
const BUILD=chrome.runtime.getManifest().version;
const pattern=/^https:\/\/jimeng\.jianying\.com\/ai-tool\/canvas\/(\d+)(?:[/?#]|$)/;
const id=url=>pattern.exec(url||'')?.[1];
const ports=new Map(),jobs=new Map();let lease=null;
const failure=(code,message)=>Object.assign(new Error(message),{code});
async function tabFor(tabId,canvasId) {
  const tab=await chrome.tabs.get(tabId);
  if(!id(tab.url) || (canvasId && id(tab.url)!==canvasId)) throw failure('CANVAS_CHANGED','画板已切换，请重新扫描');
  return tab;
}
async function execute(tabId,request) {
  const generated=request.operation==='GENERATED'&&typeof request.recordId==='string'&&typeof request.itemId==='string';
  const func=generated?readGeneratedPage:readPage;
  const result=await withTimeout(chrome.scripting.executeScript({target:{tabId},world:'MAIN',func,args:[request]}),45000,'读取画板资源');
  if(!result[0]?.result) throw new Error('网页资源读取没有返回');
  return result[0].result;
}
async function stop(owner) {
  const active=[...jobs.entries()].filter(([,j])=>j.owner===owner);
  // Release before awaiting cancellation: a later recovered lease is not ours.
  if(lease?.owner===owner) lease=null;
  await Promise.allSettled(active.map(([jobId,j])=>execute(j.tabId,{operation:'CANCEL',canvasId:j.canvasId,jobId})));
}
async function start(m,ensure=false) {
  if(lease) {
    if(!ensure||lease.owner!==m.owner||lease.tabId!==m.tabId||lease.canvasId!==m.canvasId)
      throw failure('SESSION_BUSY','另一个任务正在启动或下载');
    const current=lease;await current.ready;
    if(lease!==current||!ports.has(m.owner))throw failure('SESSION_STOPPED','任务已暂停');
    await tabFor(m.tabId,m.canvasId);
    if(lease!==current||!ports.has(m.owner))throw failure('SESSION_STOPPED','任务已暂停');
    return{ok:true};
  }
  const reservation={owner:m.owner,tabId:m.tabId,canvasId:m.canvasId};lease=reservation;
  reservation.ready=tabFor(m.tabId,m.canvasId).then(()=>{
    if(lease!==reservation||!ports.has(m.owner))throw failure('SESSION_STOPPED','任务已暂停');
  });
  try{await reservation.ready;}catch(e){if(lease===reservation)lease=null;throw e;}
  return{ok:true};
}
chrome.runtime.onConnect.addListener(port=>{
  if(!port.name.startsWith('jce:')) return;
  const owner=port.name.slice(4);ports.set(owner,port);
  port.onDisconnect.addListener(()=>{
    if(ports.get(owner)!==port)return;
    ports.delete(owner);stop(owner).catch(()=>{});
  });
  try{port.postMessage({type:'READY',build:BUILD});}catch{}
});
chrome.runtime.onInstalled.addListener(()=>chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true}).catch(()=>{}));
chrome.runtime.onMessage.addListener((m,sender,respond)=>{
  if(sender.id!==chrome.runtime.id || (sender.tab&&sender.url!==chrome.runtime.getURL('sidepanel.html'))) return;
  (async()=>{
    if(m.type==='GET_BUILD') return{ok:true,build:BUILD,capabilities:['SNAPSHOT','RESOURCE_RESOLVE','GENERATED_READ','SESSION_RECOVERY']};
    if(m.type==='GET_ACTIVE_CANVAS') {
      const expected=m.preferredUrl?id(m.preferredUrl):null;
      if(m.preferredUrl&&!expected) throw new Error('画板链接格式错误');
      const scope=Number.isInteger(m.windowId)?{windowId:m.windowId}:{lastFocusedWindow:true};
      const tabs=await chrome.tabs.query({url:'https://jimeng.jianying.com/ai-tool/canvas/*',...scope});
      const matches=tabs.filter(t=>expected?id(t.url)===expected:t.active);
      const tab=matches.find(t=>t.active)||(matches.length===1?matches[0]:null);
      if(!tab) throw new Error('请打开目标画板并切换到它');
      return{ok:true,tabId:tab.id,url:tab.url};
    }
    if(m.type==='OPEN_CANVAS') {
      if(!id(m.url)) throw new Error('画板链接格式错误');
      const tab=await chrome.tabs.create({url:m.url,active:true,...(Number.isInteger(m.windowId)?{windowId:m.windowId}:{})});return{ok:true,tabId:tab.id};
    }
    if(m.type==='END_SESSION') {await stop(m.owner);return{ok:true};}
    if(!ports.has(m.owner)) throw failure('BACKGROUND_OWNER_LOST','后台已失去侧栏连接登记');
    if(m.type==='START_SESSION'||m.type==='ENSURE_SESSION')return start(m,m.type==='ENSURE_SESSION');
    if(m.type==='READ_PAGE') {
      if(lease && (lease.owner!==m.owner || lease.tabId!==m.tabId)) throw failure('SESSION_BUSY','另一个任务正在下载');
      const tab=await tabFor(m.tabId,m.canvasId);
      if(!ports.has(m.owner))throw failure('BACKGROUND_OWNER_LOST','后台已失去侧栏连接登记');
      const jobId=crypto.randomUUID();jobs.set(jobId,{owner:m.owner,tabId:m.tabId,canvasId:id(tab.url)});
      try{return await execute(m.tabId,{...m.request,canvasId:id(tab.url),jobId});}
      finally{jobs.delete(jobId);}
    }
    throw new Error('后台不支持该请求');
  })().then(respond,e=>respond({ok:false,code:e.code||'BACKGROUND_REQUEST_FAILED',error:'插件请求失败：'+String(e.message).replace(/https?:\/\/[^\s]+/g,'[地址已隐藏]').slice(0,200)}));
  return true;
});
