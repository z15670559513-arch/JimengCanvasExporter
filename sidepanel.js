import {saveImage,verifyImage,inspect,unusedName} from './files.js';
import {saveTask,listTasks,saveHandle,getHandle} from './task-store.js';
import {analyzeSnapshot,canvasIdentity} from './snapshot.js';
import {mergeResources,archiveRemoved,pendingResources,safeError,runBatches,taskState,stateLabels} from './incremental.js';
import {latestTask,restoreTask,taskDirectory} from './task-context.js';
import {fetchOriginal,saveChromeDownload,verifyChrome,delay} from './download.js';
import {withTimeout} from './async.js';
const BUILD=chrome.runtime.getManifest().version,$=id=>document.getElementById(id),owner=crypto.randomUUID();
let port=chrome.runtime.connect({name:'jce:'+owner}),recovery=null,sessionActive=false,panelClosed=false;
let task=null,dir=null,baseDir=null,tabId=null,windowId=null,running=false,scanning=false,controller=null,connected=false,writes=Promise.resolve(),requestSlot=0;
let contextRevision=0,manualCanvas=false,following=false,followQueued=false;
const transfers=new Map();let roundStartedAt=0;
function transferProgress() {
  const rows=[...transfers.values()];
  $('transferDetails').textContent=rows.length?rows.map(p=>'第 '+p.index+' 个资源：'+(p.receivedBytes/1048576).toFixed(2)+' MiB'+
    (p.totalBytes?' / '+(p.totalBytes/1048576).toFixed(2)+' MiB':' / 大小未知')+' · '+(p.bytesPerSecond>0?(p.bytesPerSecond/1048576).toFixed(2)+' MiB/s':'速度计算中')).join('\n'):'';
  $('elapsed').textContent=roundStartedAt?'本轮用时 '+Math.floor((Date.now()-roundStartedAt)/1000)+' 秒 · 剩余时间未知':
    task?.lastRunStats?'上轮用时 '+Math.floor(task.lastRunStats.elapsedMs/1000)+' 秒':'';
}
let runtimeInfo=null;
const addresses=new Map(); // Signed URLs live here only, never in IndexedDB/reports.
function log(message) {
  const text=safeError({message});$('latestStatus').textContent=text;
  $('log').textContent=($('log').textContent+'\n['+new Date().toLocaleTimeString()+'] '+text).split('\n').slice(-100).join('\n');
}
function render() {
  $('version').textContent=chrome.runtime.getManifest().version_name||BUILD;
  const resources=task?.resources||[],done=resources.filter(r=>r.status==='done').length,failed=resources.filter(r=>r.status==='failed').length;
  $('found').textContent=task?.imageNodeCount||0;$('unique').textContent=resources.length;
  $('completed').textContent=done;$('remaining').textContent=resources.filter(r=>r.status!=='done'&&r.status!=='skipped').length;
  $('failed').textContent=failed;$('progress').max=Math.max(1,resources.length);$('progress').value=done;
  const unresolved=resources.filter(r=>r.status==='unresolved').length;
  $('coverage').textContent='原图链接已解析 '+resources.filter(r=>['resolved','saved'].includes(r.resolution)||r.status==='done').length+
    ' · 已校验 '+resources.filter(r=>r.status==='done'&&(r.verifiedAt||r.proof)).length+
    ' · 未解析 '+unresolved+' · 待解析 '+resources.filter(r=>r.status!=='done'&&r.status!=='unresolved'&&!['candidate','resolved'].includes(r.resolution)).length;
  const state=taskState(task,{running,scanning,connected}),needsScan=$('canvasUrl').value&&canvasIdentityOrNull($('canvasUrl').value)!==task?.canvasId;
  $('progressText').textContent=done+' / '+resources.length+' · '+Math.round(done/Math.max(1,resources.length)*100)+'% · '+stateLabels[state];
  for(const id of ['scan','chooseFolder','useCurrent','openCanvas','history','canvasUrl','saveMode','batchSize','concurrency','retries','interval','report','probe','verifyGenerated','subfolders']) $(id).disabled=running;
  $('start').disabled=running||!connected||!resources.length||needsScan;$('scan').disabled=running||!connected;
  $('start').textContent=state==='completed'?'核验已保存文件':'开始下载';
  $('pause').disabled=!running;$('retry').disabled=running||!connected||!(failed+unresolved)||needsScan;$('resume').disabled=running||!connected||!resources.length||needsScan||state==='completed';
  $('reconnect').hidden=connected;$('reconnect').disabled=running;
  $('folderName').textContent=$('saveMode').value==='chrome'?'Chrome 默认下载目录 / '+(task?chromeDirectory():'即梦导出/画板_ID'):
    (dir?'已授权：'+(task?.directoryMode==='subfolder'&&baseDir?baseDir.name+' / ':'')+dir.name:baseDir?'导出根目录：'+baseDir.name+'（扫描后建立画板目录）':'请选择文件夹');
  $('historySummary').textContent=task?'画板 '+task.canvasId+' · '+stateLabels[state]+' · '+(task.directoryLabel||($('saveMode').value==='chrome'?'Chrome 默认下载目录':'已授权目录'))+
    (task.lastDownloadedAt?' · 最近下载 '+new Date(task.lastDownloadedAt).toLocaleString('zh-CN'):''):'';
  $('integrity').textContent=task?'快照 '+task.snapshotVersion+' · 图片节点 '+task.imageNodeCount+'；画板新增或修改后请重新扫描':'扫描读取快照，不依赖图片是否在屏幕中。';
  transferProgress();
}
async function persist() {
  task.updatedAt=new Date().toISOString();const snapshot=structuredClone(task);
  const write=writes.then(()=>saveTask(snapshot));writes=write.catch(()=>{});await write;render();
}
async function rawRpc(type,args={},signal) {
  if(signal?.aborted)throw signal.reason;
  let response;
  try{response=await withTimeout(chrome.runtime.sendMessage({type,owner,tabId,windowId,canvasId:task?.canvasId,...args}),type==='READ_PAGE'?95000:8000,'后台请求',signal);}
  catch(e){
    if(!signal?.aborted&&/Receiving end does not exist|message (?:port|channel) closed|Could not establish connection|Extension context invalidated|后台请求 超时/i.test(e.message))
      throw Object.assign(new Error('后台通信中断'),{code:'BACKGROUND_UNAVAILABLE'});
    throw e;
  }
  if(!response?.ok)throw Object.assign(new Error(response?.error||'后台没有响应'),{code:response?.code||'BACKGROUND_UNAVAILABLE',diagnostic:response?.diagnostic});
  return response;
}
function watchPort(active) {
  active.onDisconnect.addListener(()=>{
    if(active!==port||panelClosed)return;
    connected=false;render();
    if(controller?.signal.aborted||recovery)return;
    recoverConnection(controller?.signal).catch(e=>{
      controller?.abort(e);log('后台连接恢复失败，进度已保留：'+safeError(e));render();
    });
  });
}
function recoverConnection(signal) {
  if(signal?.aborted)return Promise.reject(signal.reason);
  if(panelClosed)return Promise.reject(new Error('侧栏已关闭'));
  if(recovery)return recovery;
  recovery=(async()=>{
    connected=false;render();log('正在自动恢复后台连接，保留当前下载进度');
    const previous=port;let next;
    const ready=new Promise((resolve,reject)=>{
      next=chrome.runtime.connect({name:'jce:'+owner});port=next;watchPort(next);
      next.onMessage.addListener(message=>{
        if(message.type!=='READY')return;
        if(message.build!==BUILD)return reject(Object.assign(new Error('插件版本已变化，请更新插件连接'),{code:'VALIDATOR_NOT_LOADED'}));
        resolve();
      });
      next.onDisconnect.addListener(()=>reject(Object.assign(new Error('后台连接未建立'),{code:'BACKGROUND_UNAVAILABLE'})));
    });
    try {
      await withTimeout(ready,5000,'恢复后台连接',signal);
      if(panelClosed||signal?.aborted)throw signal?.reason||new Error('侧栏已关闭');
      if(sessionActive)await rawRpc('ENSURE_SESSION',{},signal);
      connected=true;log('后台连接已恢复，继续未完成资源');render();
    } catch(e) {
      connected=false;try{next?.disconnect();}catch{}
      throw Object.assign(e,{code:e.code||'BACKGROUND_UNAVAILABLE'});
    } finally{try{previous.disconnect();}catch{}}
  })().finally(()=>{recovery=null;});
  return recovery;
}
async function rpc(type,args={},cleanup=false) {
  if(type==='END_SESSION')sessionActive=false;
  const signal=cleanup?undefined:controller?.signal;
  // Recheck/reacquire the lease even if a worker restart left the UI port stale.
  if(type==='READ_PAGE'&&sessionActive)await rpc('ENSURE_SESSION');
  let response;
  try{response=await rawRpc(type,args,signal);}
  catch(e){
    if(cleanup||signal?.aborted||panelClosed||!['BACKGROUND_OWNER_LOST','BACKGROUND_UNAVAILABLE'].includes(e.code))throw e;
    await recoverConnection(signal);response=await rawRpc(type,args,signal);
  }
  if(type==='START_SESSION')sessionActive=true;
  return response;
}
function keepAlive() {
  const active=controller;
  return setInterval(()=>{
    if(!sessionActive||active.signal.aborted||panelClosed)return;
    rpc('ENSURE_SESSION').catch(e=>{if(controller===active&&!active.signal.aborted){active.abort(e);log('任务连接异常，已暂停：'+safeError(e));}});
  },15000);
}
async function checkBuild() {
  try {
    const info=await rpc('GET_BUILD');
    runtimeInfo={extensionId:chrome.runtime.id,frontBuild:BUILD,
      backgroundBuild:typeof info.build==='string'?info.build.replace(/[^a-z0-9._-]/gi,'').slice(0,60):null,
      capabilities:Array.isArray(info.capabilities)?info.capabilities.filter(v=>typeof v==='string'&&/^[A-Z0-9_]{1,60}$/.test(v)):[]};
    if(info.build!==BUILD||!info.capabilities?.includes('SNAPSHOT')||!info.capabilities?.includes('GENERATED_READ'))
      throw Object.assign(new Error('前台 '+BUILD+' / 后台 '+runtimeInfo.backgroundBuild+'，后台实例尚未更新'),{code:'VALIDATOR_NOT_LOADED'});
    connected=true;
  } catch(e){connected=false;throw Object.assign(new Error('请点“更新插件连接”以重载当前插件，再重新打开侧栏。'+safeError(e)),{code:e.code||'BACKGROUND_UNAVAILABLE'});}
  finally{render();}
}
async function locate(preferred=$('canvasUrl').value.trim()) {
  const tab=await rpc('GET_ACTIVE_CANVAS',{preferredUrl:preferred});tabId=tab.tabId;$('canvasUrl').value=tab.url;return tab;
}
async function histories() {
  const tasks=(await listTasks()).filter(t=>t.schema===3).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
  $('history').replaceChildren(new Option('选择历史任务',''));
  for(const t of tasks)$('history').add(new Option('画板 '+t.canvasId+' · '+t.resources.filter(r=>r.status==='done').length+'/'+t.resources.length+
    ' · 失败 '+t.resources.filter(r=>r.status==='failed').length+' · '+stateLabels[taskState(t)]+' · '+(t.saveMode==='chrome'?'默认下载':t.directoryLabel||'授权目录')+(t.lastDownloadedAt?' · '+new Date(t.lastDownloadedAt).toLocaleString('zh-CN'):'') ,t.id));
  if(task)$('history').value=task.id;
}
async function bindCanvas(canvasId) {
  if(running||task?.canvasId===canvasId)return;
  const revision=++contextRevision;
  const saved=latestTask(await listTasks(),canvasId);
  const handle=saved?.saveMode==='folder'?await getHandle(saved.id):null;
  const savedBase=handle?await getHandle('base:'+saved.id):null;
  if(revision!==contextRevision||running)return;
  task=saved?restoreTask(saved):null;dir=handle;addresses.clear();
  if(task){$('saveMode').value=task.saveMode;if(handle)baseDir=savedBase||(task.directoryMode==='subfolder'?baseDir:handle);}
  await histories();render();
  if(revision!==contextRevision||running)return;
  log(task?'已关联画板 '+canvasId+' 的历史任务；开始前核验已有文件':'已切换到新画板 '+canvasId+'，请扫描图片');
}
async function followCanvas() {
  if(running||manualCanvas||document.activeElement===$('canvasUrl'))return;
  if(following){followQueued=true;return;}
  following=true;const revision=contextRevision;
  try{
    const tab=await rpc('GET_ACTIVE_CANVAS',{preferredUrl:''});
    if(running||manualCanvas||revision!==contextRevision)return;
    tabId=tab.tabId;$('canvasUrl').value=tab.url;await bindCanvas(canvasIdentity(tab.url));
  }catch{}
  finally{following=false;if(followQueued){followQueued=false;queueMicrotask(()=>followCanvas());}}
}
async function settings() {
  windowId=(await chrome.windows.getCurrent()).id;
  const {preferences={}}=await chrome.storage.local.get('preferences');
  const allowed={saveMode:['chrome','folder'],batchSize:['50','100','200'],concurrency:['1','2','3'],retries:['0','1','2'],interval:['1000','2000','3000']};
  for(const [key,values] of Object.entries(allowed))if(values.includes(String(preferences[key])))$(key).value=String(preferences[key]);
  $('subfolders').checked=preferences.subfolders!==false;
  baseDir=await getHandle('preferred-root');
}
async function saveSettings() {
  const preferences=Object.fromEntries(['saveMode','batchSize','concurrency','retries','interval'].map(key=>[key,$(key).value]));
  preferences.subfolders=$('subfolders').checked;
  await chrome.storage.local.set({preferences});
}
function chromeDirectory() {return task.downloadSubdir||'即梦_'+task.canvasId;}
async function permission() {
  if($('saveMode').value==='chrome')return;
  if(!dir)throw new Error('请先选择保存文件夹');
  if(await dir.queryPermission({mode:'readwrite'})!=='granted' && await dir.requestPermission({mode:'readwrite'})!=='granted')throw new Error('文件夹写入权限未获授权');
}
async function audit() {
  let restored=0;
  for(const r of task.resources) {
    if(!['done','writing'].includes(r.status))continue;
    try {
      if(task.saveMode==='chrome')Object.assign(r,await verifyChrome(r,controller?.signal));
      else await verifyImage(dir,r);
      r.status='done';r.resolution='saved';r.error=null;r.completedAt ||= new Date().toISOString();r.verifiedAt=new Date().toISOString();
      r.imageWidth=r.width;r.imageHeight=r.height;r.fileSize=r.bytes;r.filename=task.saveMode==='chrome'?(r.filename||r.name):r.name;restored++;
    } catch(e) {
      if(controller?.signal.aborted || e.code==='ACTIVE_DOWNLOAD' || ['NotAllowedError','SecurityError'].includes(e.name))throw e;
      r.status='pending';r.error='旧文件未通过核验：'+safeError(e);
    }
  }
  await persist();return restored;
}
async function scan() {
  if(running)return;++contextRevision;running=true;scanning=true;controller=new AbortController();render();
  try {
    await checkBuild();const tab=await locate();const canvasId=canvasIdentity(tab.url);
    const response=await rpc('READ_PAGE',{canvasId,request:{operation:'SCAN'}});
    const analysis=analyzeSnapshot(response.snapshot,response.project,canvasId);
    if(analysis.warnings.some(w=>/早于|未知|尚未确认的 children|不是图层|缺少节点|分页/.test(w)))throw new Error('快照结构或版本尚不完整，请查看调查响应；未替换已有任务');
    const mode=$('saveMode').value;
    const tasks=await listTasks();
    const prior=task?.schema===3&&task.canvasId===canvasId&&task.saveMode===mode?task:latestTask(tasks,canvasId,mode);
    if(mode==='folder')dir=await taskDirectory(prior,baseDir||(task?.canvasId===canvasId?dir:null),getHandle,$('subfolders').checked,canvasId);
    else dir=null;
    task={...prior,id:prior?.id||crypto.randomUUID(),schema:3,version:BUILD,canvasId,canvasUrl:tab.url,
      draftId:analysis.draftId,snapshotVersion:analysis.version,imageNodeCount:analysis.imageNodeCount,
      sourceCounts:analysis.resourceSourceCounts,resources:mergeResources(analysis,prior),archivedResources:archiveRemoved(analysis,prior||{}),saveMode:mode,status:'ready',complete:false,
      directoryMode:prior?.directoryMode||(prior?'legacy':$('subfolders').checked?'subfolder':'direct'),directoryLabel:dir?.name||null,
      downloadSubdir:prior?.downloadSubdir||(prior?'即梦_'+canvasId:'即梦导出/画板_'+canvasId)};
    addresses.clear();
    for(const resource of analysis.resources)if(resource.candidates?.length)addresses.set(resource.resourceKey,{...resource.candidates[0],at:Date.now()});
    if(dir&&mode==='folder'){await saveHandle(task.id,dir);if(baseDir)await saveHandle('base:'+task.id,baseDir);}
    if(taskState(task)==='completed'){task.status='completed';task.complete=true;}
    await persist();await histories();
    log('已读取 '+analysis.imageNodeCount+' 个图片节点、'+task.resources.length+' 个唯一资源；项目已提供 '+addresses.size+' 个原图候选。下载时只保存通过校验的原图，未解析资源单独记录。');
  } finally {running=false;scanning=false;controller=null;render();}
}
async function readResource(resource,refresh=false) {
  const known=addresses.get(resource.resourceKey);
  if(refresh)addresses.delete(resource.resourceKey);
  else if(resource.resourceSource==='userUpload'&&known&&Date.now()-known.at<60000)return{...known,itemId:resource.itemId,resourceId:resource.resourceId};
  const wait=Math.max(0,requestSlot-Date.now());requestSlot=Math.max(Date.now(),requestSlot)+Number($('interval').value);
  if(wait)await delay(wait,controller.signal);
  const request=resource.resourceSource==='userUpload'?{operation:'UPLOAD',resourceId:resource.resourceId}:
    resource.resourceSource==='aiGenerate'&&resource.itemId?{operation:'GENERATED',itemId:resource.itemId,recordId:resource.recordId}:null;
  if(!request)throw Object.assign(new Error('资源身份缺失或类型不支持'),{code:'RESOURCE_UNRESOLVED'});
  const result=await rpc('READ_PAGE',{request:{...request,nodeIds:resource.nodeIds||[resource.nodeId],refresh}});
  if(request.operation==='UPLOAD'&&result.resourceId!==resource.resourceId || request.operation==='GENERATED'&&result.itemId!==resource.itemId)throw new Error('资源返回身份不一致，未计成功');
  if(request.operation==='GENERATED'&&resource.recordId&&
    (result.recordId!==resource.recordId||!result.diagnostic?.historyIdConfirmed))
    throw Object.assign(new Error('生成记录返回身份未证实，拒绝保存其他图片'),{code:'IDENTITY_MISMATCH'});
  addresses.set(resource.resourceKey,{url:result.url,origin:result.origin,at:Date.now()});return result;
}
async function phase(resource,name) {
  resource.phase=name;resource.updatedAt=new Date().toISOString();
  resource.trace=[...(resource.trace||[]),{phase:name,at:resource.updatedAt,attempt:resource.attempts}].slice(-24);
  log('第 '+resource.index+' 个资源：'+name);await persist();
}
async function report() {
  if(!task)return;
  const snapshot=structuredClone(task);
  snapshot.saved=task.resources.filter(r=>r.status==='done').length;snapshot.failed=task.resources.filter(r=>r.status==='failed').length;
  snapshot.unresolved=task.resources.filter(r=>r.status==='unresolved').length;
  const blob=new Blob([JSON.stringify(snapshot,null,2)],{type:'application/json'});
  if(task.saveMode==='folder'&&dir) {
    const name=await unusedName(dir,'导出报告_'+Date.now(),'json');
    const stream=await(await dir.getFileHandle(name,{create:true})).createWritable();
    try{await stream.write(blob);await stream.close();}catch(e){await stream.abort().catch(()=>{});throw e;}
  } else {
    const url=URL.createObjectURL(blob);
    try{await chrome.downloads.download({url,filename:chromeDirectory()+'/导出报告_'+Date.now()+'.json',conflictAction:'uniquify',saveAs:false});}
    finally{setTimeout(()=>URL.revokeObjectURL(url),30000);}
  }
}
async function verifyGenerated() {
  if(running)return;
  await scan();log('试下载 1 个未完成生成资源；使用正式下载链路和文件校验，不启动全量下载');
  await run(false,1,'generated');
}

async function run(retry=false,limit=Infinity,scope='all') {
  if(running)return;if(!task)throw new Error('请先扫描图片');
  if($('canvasUrl').value.trim()&&canvasIdentity($('canvasUrl').value.trim())!==task.canvasId)throw new Error('画板链接已改变，请先扫描或恢复对应画板任务');
  running=true;controller=new AbortController();requestSlot=0;roundStartedAt=Date.now();transfers.clear();render();let consecutiveFailures=0,heartbeat,newSaved=0;
  const progressTimer=setInterval(transferProgress,1000);
  const refreshedSources=new Set();
  try {
    await checkBuild();await locate(task.canvasUrl);await permission();
    if(task.saveMode!==$('saveMode').value)throw new Error('保存方式与任务记录不一致，请重新扫描');
    await rpc('START_SESSION');heartbeat=keepAlive();
    await audit();
    const queue=pendingResources(task,retry).filter(r=>scope!=='generated'||r.resourceSource==='aiGenerate').slice(0,limit);
    if(!queue.length){log('没有待下载资源，已有文件已核验');return;}
    const opts={batchSize:$('batchSize').value,concurrency:$('concurrency').value,interval:$('interval').value};
    const retries=Number($('retries').value);if(!Number.isInteger(retries)||retries<0||retries>2)throw new Error('重试次数仅支持 0–2');
    task.status='running';task.version=BUILD;await persist();
    await runBatches(queue,opts,async resource=>{
      resource.status='working';
      try {
        for(let attempt=0;;attempt++) {
          if(controller.signal.aborted)throw controller.signal.reason;
          resource.attempts=(resource.attempts||0)+1;await phase(resource,'解析原始资源');
          try {
            const sourceKey=resource.recordId||resource.resourceKey;
            const refresh=attempt>0||(retry&&!refreshedSources.has(sourceKey));refreshedSources.add(sourceKey);
            const resolved=await readResource(resource,refresh);
            resource.origin=resolved.origin;resource.resolution='resolved';
            if(resource.resourceSource==='aiGenerate'&&resource.recordId)resource.provenance={
              provider:resolved.origin,recordId:resolved.recordId,itemId:resolved.itemId,
              historyIdConfirmed:resolved.diagnostic?.historyIdConfirmed===true,
              imageURI:resolved.diagnostic?.imageURI||null,sourceWidth:resolved.width,sourceHeight:resolved.height,
              resizeHint:resolved.diagnostic?.largeImages?.[0]?.resizeHint||null};
            await phase(resource,'读取原始图片');
            transfers.set(resource.resourceKey,{index:resource.index,receivedBytes:0});transferProgress();
            const blob=await fetchOriginal(resolved.url,controller.signal,{onProgress:progress=>{
              transfers.set(resource.resourceKey,{index:resource.index,...progress});transferProgress();
            }});
            transfers.delete(resource.resourceKey);transferProgress();
            const info=await inspect(blob);
            if(resource.resourceSource==='aiGenerate'&&resource.recordId) {
              if(info.ext!=='png'||blob.type!=='image/png')throw Object.assign(new Error('生成图接口返回非 PNG，未转码或冒充已确认的 PNG 原图'),{code:'NOT_OFFICIAL_PNG'});
              if(resolved.width>0&&info.width!==resolved.width||resolved.height>0&&info.height!==resolved.height)
                throw Object.assign(new Error('实际 PNG 尺寸与目标历史图片元数据不一致'),{code:'IMAGE_DIMENSION_MISMATCH'});
            }
            if(controller.signal.aborted)throw controller.signal.reason;
            await phase(resource,'保存文件并核验');
            const onPlan=async plan=>{Object.assign(resource,plan,{status:'writing'});await persist();};
            const result=task.saveMode==='chrome'?
              await saveChromeDownload(blob,chromeDirectory()+'/图片_'+String(resource.index).padStart(4,'0'),onPlan,controller.signal):
              {...await saveImage(dir,blob,'即梦_'+task.canvasId+'_'+String(resource.index).padStart(4,'0'),onPlan),proof:'readback-sha256'};
            Object.assign(resource,result,{status:'done',resolution:'saved',error:null,errorCode:null,diagnostic:null,completedAt:new Date().toISOString(),verifiedAt:new Date().toISOString()});
            task.lastDownloadedAt=resource.completedAt;
            newSaved++;
            resource.filename=result.filename||result.name;resource.imageWidth=result.width;resource.imageHeight=result.height;resource.fileSize=result.bytes;
            await phase(resource,'完成');consecutiveFailures=0;break;
          } catch(e) {
            const transient=/^(IMAGE_TIMEOUT|IMAGE_INCOMPLETE|IMAGE_HTTP_(401|403|408|429|5\d\d)|API_HTTP_(408|429|5\d\d))$/.test(e.code||'') || e instanceof TypeError;
            if(controller.signal.aborted || !transient || attempt>=retries)throw e;
            await phase(resource,'请求失败，重新获取地址后重试');await delay(Math.max(1000,Number(opts.interval)*(attempt+1)),controller.signal);
          }
        }
      } catch(e) {
        if(['BACKGROUND_OWNER_LOST','BACKGROUND_UNAVAILABLE','SESSION_BUSY','SESSION_STOPPED','VALIDATOR_NOT_LOADED'].includes(e.code))controller.abort(e);
        if(resource.status!=='done' && resource.status!=='writing')resource.status=controller.signal.aborted?'pending':'failed';
        resource.error=safeError(e);resource.errorCode=e.code||null;resource.diagnostic=e.diagnostic||null;
        const unresolved=!controller.signal.aborted&&['RESOURCE_UNRESOLVED','RESOURCE_ID_MISSING','RESOURCE_SOURCE_UNAVAILABLE','INVALID_ID','HISTORY_NOT_FOUND','ITEM_LIST_MISSING','ITEM_ID_MISMATCH','ORIGINAL_URL_MISSING','ABORTED'].includes(e.code);
        if(unresolved){resource.status='unresolved';resource.resolution='unresolved';addresses.delete(resource.resourceKey);}
        try{await persist();}catch(storageError){controller.abort(storageError);throw storageError;}
        if(unresolved){log('原图未解析，继续其他资源：第 '+resource.index+' 个');return;}
        if(resource.status==='done'||resource.status==='writing'){controller.abort(e);throw e;}
        if(controller.signal.aborted)throw e;
        transfers.delete(resource.resourceKey);transferProgress();consecutiveFailures++;
        log('资源失败：'+resource.error);
        if(consecutiveFailures>=3 || ['API_REJECTED','API_HTTP_401','API_HTTP_403','API_HTTP_429','IMAGE_HTTP_429','CANVAS_CHANGED','IDENTITY_MISMATCH'].includes(e.code) ||
          ['NotAllowedError','SecurityError'].includes(e.name) || /权限|回读|身份不一致|签名|后台|画板已切换/.test(e.message)) {
          controller.abort(e);await rpc('END_SESSION',{},true).catch(()=>{});throw e;
        }
      }
    },controller.signal,async total=>{await persist();log('本批结束，已处理 '+total+' 个资源');await report();});
    log('本轮结束：已保存 '+task.resources.filter(r=>r.status==='done').length+'，未解析 '+task.resources.filter(r=>r.status==='unresolved').length+'，下载失败 '+task.resources.filter(r=>r.status==='failed').length+'；只保存校验通过的原图');
  } finally {
    clearInterval(heartbeat);clearInterval(progressTimer);transfers.clear();transferProgress();
    try {
      await rpc('END_SESSION',{},true).catch(()=>{});task.status=controller.signal.aborted?'paused':'ready';
      for(const r of task.resources)if(r.status==='working')r.status='pending';
      task.status=taskState(task);task.complete=task.status==='completed';
      task.lastRunStats={startedAt:new Date(roundStartedAt).toISOString(),finishedAt:new Date().toISOString(),elapsedMs:Date.now()-roundStartedAt,newSaved};
      try{await persist();}catch(e){log('进度保存失败：'+safeError(e));}
      try{await histories();}catch(e){log('历史刷新失败：'+safeError(e));}
      try{await report();}catch(e){log('报告保存失败：'+safeError(e));}
    } finally {roundStartedAt=0;running=false;controller=null;render();if(task.complete)log('全部完成：'+task.resources.length+' 个唯一资源已保存并核验，对应 '+task.imageNodeCount+' 个图片节点');}
  }
}
async function verifyGeneratedBatch() {
  if(running)return;
  // Restore this board's existing task and directory before a small sample run.
  running=true;controller=new AbortController();render();
  try {
    await checkBuild();const tab=await locate();const canvasId=canvasIdentity(tab.url);
    if(!task&&!dir) {
      const prior=latestTask(await listTasks(),canvasId);
      if(prior){task=restoreTask(prior);dir=await getHandle(prior.id);$('saveMode').value=prior.saveMode;}
    }
  } finally{running=false;controller=null;render();}
  await scan();
  log('仅验证 10 个未完成生成资源；已保存文件核验后跳过，不启动全画板下载');
  await run(false,10,'generated');
}
function action(id,fn){$(id).addEventListener('click',()=>Promise.resolve().then(fn).catch(e=>{log(safeError(e));render();}));}
action('useCurrent',async()=>{manualCanvas=false;const tab=await locate('');await bindCanvas(canvasIdentity(tab.url));});action('openCanvas',()=>rpc('OPEN_CANVAS',{url:$('canvasUrl').value.trim()}));
action('chooseFolder',async()=>{
  if(running)return;++contextRevision;manualCanvas=true;const chosen=await window.showDirectoryPicker({mode:'readwrite'});
  if(task?.saveMode==='folder') {
    const same=dir&&await chosen.isSameEntry(dir),sameRoot=baseDir&&await chosen.isSameEntry(baseDir);
    if(dir&&!same&&!sameRoot)throw new Error('请恢复原保存目录，避免把其他目录文件当作已完成');
    if(!dir){
      const candidate=task.directoryMode==='subfolder'?await chosen.getDirectoryHandle('画板_'+task.canvasId,{create:false}):chosen;
      for(const record of task.resources.filter(r=>r.status==='done'))await verifyImage(candidate,record);
      dir=candidate;
    }
    if(!same)baseDir=chosen;
  } else {
    task=null;dir=null;baseDir=chosen;log('已选择导出根目录，请扫描画板；新任务可按画板 ID 建立子目录');
  }
  $('saveMode').value='folder';
  await saveHandle('preferred-root',baseDir||chosen);
  if(task?.saveMode==='folder'){await saveHandle(task.id,dir);if(baseDir)await saveHandle('base:'+task.id,baseDir);}
  await saveSettings();render();
});
action('scan',scan);action('start',()=>run());action('resume',()=>run());action('retry',()=>run(true));
action('probe',verifyGeneratedBatch);action('report',report);
action('verifyGenerated',verifyGenerated);
action('pause',async()=>{controller?.abort(new Error('用户暂停'));log('已暂停新请求；正在写入的文件会完成核验');await rpc('END_SESSION',{},true);});
action('reconnect',()=>chrome.runtime.reload());
$('saveMode').addEventListener('change',()=>{++contextRevision;manualCanvas=true;if(task&&task.saveMode!==$('saveMode').value){task=null;dir=null;addresses.clear();log('保存方式已改变，请重新扫描或恢复对应历史任务');}saveSettings().catch(e=>log(safeError(e)));render();});
for(const id of ['batchSize','concurrency','retries','interval','subfolders'])$(id).addEventListener('change',()=>saveSettings().catch(e=>log(safeError(e))));
$('canvasUrl').addEventListener('input',()=>{++contextRevision;manualCanvas=true;render();});
$('history').addEventListener('change',async()=>{
  if(running||!$('history').value)return;
  const selectedId=$('history').value,revision=++contextRevision;
  manualCanvas=true;addresses.clear();task=null;dir=null;render();
  try {
    const saved=(await listTasks()).find(t=>t.id===selectedId);
    if(!saved)throw new Error('历史任务已不存在，请重新扫描画板');
    const nextTask=restoreTask(saved);
    const [nextDir,nextBase]=nextTask.saveMode==='folder'?
      await Promise.all([getHandle(nextTask.id),getHandle('base:'+nextTask.id)]):[null,null];
    if(revision!==contextRevision||running)return;
    task=nextTask;dir=nextDir;baseDir=nextBase||nextDir||baseDir;
    $('saveMode').value=task.saveMode;$('canvasUrl').value=task.canvasUrl;render();log('已恢复记录；开始前会重新核验文件');
  } catch(e){if(revision===contextRevision)log(safeError(e));}
});
watchPort(port);
chrome.tabs.onActivated.addListener(()=>followCanvas());
chrome.tabs.onUpdated.addListener((changedId,change,tab)=>{
  if(running&&changedId===tabId&&change.url&&canvasIdentityOrNull(change.url)!==task?.canvasId)controller?.abort(Object.assign(new Error('画板已切换，已暂停原任务'),{code:'CANVAS_CHANGED'}));
  else if(!running&&(change.url||change.status==='complete'))followCanvas();
});
function canvasIdentityOrNull(url){try{return canvasIdentity(url);}catch{return null;}}
addEventListener('pagehide',()=>{panelClosed=true;sessionActive=false;controller?.abort(new Error('侧栏已关闭'));chrome.runtime.sendMessage({type:'END_SESSION',owner}).catch(()=>{});});
await settings();await histories();await followCanvas();await checkBuild().catch(e=>log(safeError(e)));render();
