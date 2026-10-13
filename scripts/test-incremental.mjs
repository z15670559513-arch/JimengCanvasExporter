import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {readPage} from '../page-api.js';
import {analyzeSnapshot,canvasIdentity} from '../snapshot.js';
import {mergeResources,archiveRemoved,pendingResources,safeError,runBatches,taskState,stateLabels} from '../incremental.js';
import {latestTask,restoreTask,taskDirectory} from '../task-context.js';
import {fetchOriginal,saveChromeDownload,verifyChrome,originalURL,delay} from '../download.js';
import {saveImage,verifyImage} from '../files.js';
import {withTimeout} from '../async.js';
import {readGeneratedPage} from '../generated-resource.js';
import {canvasFixture,pngBytes} from './fixtures.mjs';
const version=JSON.parse(fs.readFileSync(new URL('../manifest.json',import.meta.url),'utf8')).version;
globalThis.crypto ??= webcrypto;
globalThis.createImageBitmap=async()=>({width:1,height:1,close(){}});
const png=new Blob([pngBytes],{type:'image/png'});
const signed='https://p26-dreamina-sign.byteimg.com/native.png?x-signature=NOT_IN_REPORT';
function page(responses,canvas='100') {
  const requests=[];
  const context={location:{href:'https://jimeng.jianying.com/ai-tool/canvas/'+canvas},window:{},Map,URL,AbortController,
    setTimeout,clearTimeout,fetch:async(path,options)=>{requests.push({path,body:JSON.parse(options.body),options});
      const response=responses[path];if(typeof response==='function')return response(options,context);
      return new Response(JSON.stringify(response),{headers:{'content-type':'application/json'}});}};
  return{context,requests,call:vm.runInNewContext('('+readPage.toString()+')',context)};
}
test('脱敏结构：288 节点与 60 个生成记录，唯一资源身份可重复扫描',()=>{
  const {snapshot,project}=canvasFixture();
  const analysis=analyzeSnapshot(snapshot,project,'100');
  assert.equal(analysis.imageNodeCount,288);assert.equal(analysis.uniqueResourceCount,288);
  assert.equal(new Set(analysis.nodes.map(n=>n.recordId).filter(Boolean)).size,60);
  const first=mergeResources(analysis);first[0].status='done';first[0].name='already.jpg';
  const second=mergeResources(analysis,{resources:first});
  assert.equal(second[0].status,'done');assert.equal(second[0].name,'already.jpg');
  assert.equal(pendingResources({resources:second}).length,287);
});
test('中断的 writing 保留计划供回读，working 回 pending，重试只取失败',()=>{
  const analysis={canvasId:'a',resources:[{resourceKey:'a',nodeIds:['n'],resourceId:'u',resourceSource:'userUpload'}]};
  const next=mergeResources(analysis,{resources:[{resourceKey:'a',status:'writing',name:'planned.png',sha256:'proof'}]});
  assert.equal(next[0].status,'writing');assert.equal(next[0].sha256,'proof');
  assert.equal(mergeResources(analysis,{resources:[{resourceKey:'a',status:'working'}]})[0].status,'pending');
  assert.deepEqual(pendingResources({resources:[{status:'done'},{status:'failed'},{status:'pending'},{status:'skipped'},{status:'unresolved'}]},true),[{status:'failed'},{status:'unresolved'}]);
});
test('扫描使用项目真实 draft 映射，不将画板 ID 作为 draft ID',async()=>{
  const p=page({'/mweb/v1/infinite_canvas/project_detail':{ret:'0',data:{project:{id:'100',draft:{draft_id:'200'}}}},
    '/mweb/v1/infinite_canvas/v1/fetch_snapshot':{ret:'0',data:{snapshots:[]}}});
  const result=await p.call({canvasId:'100',jobId:'scan',operation:'SCAN'});assert.equal(result.ok,true);
  assert.equal(p.requests[1].body.draft_ids[0].draft_id,'200');assert.equal(p.requests[0].options.credentials,'include');
  assert.equal((await p.call({canvasId:'other',jobId:'bad',operation:'SCAN'})).ok,false);assert.equal(p.requests.length,2);
});
test('上传/生成资源身份核对；大整数 ID 不转 Number；普通场景不请求权益',async()=>{
  const id='900000000000000001';
  const p=page({'/mweb/v1/get_image_by_uri':{ret:'0',uri2image:{upload:{image_url:signed}}},
    '/mweb/v1/get_local_item_list':{ret:'0',data:{item_list:[{id,image:{large_images:[{image_url:signed}],format:'png'}}]}}});
  const uploaded=await p.call({canvasId:'100',jobId:'a',operation:'UPLOAD',resourceId:'upload'});
  assert.equal(uploaded.url,signed);assert.equal(uploaded.resourceId,'upload');
  const generated=await p.call({canvasId:'100',jobId:'b',operation:'GENERATED',itemId:id,optionalDetails:true});
  assert.equal(generated.url,signed);assert.equal(p.requests[1].body.item_id_list[0],id);
  assert.equal(p.requests[1].body.pack_item_opt.scene,0);assert.ok(!JSON.stringify(p.requests[1].body).includes('benefit'));
  assert.equal((await p.call({canvasId:'100',jobId:'c',operation:'GENERATED',itemId:Number(id)})).ok,false);
});
test('网页原始详情 common_attr.id 匹配大整数，不误用外层 ID 或其他图片',async()=>{
  const itemId='900000000000000001';
  const p=page({'/mweb/v1/get_local_item_list':{ret:'0',data:{item_list:[
    {id:itemId,common_attr:{id:'other'},image:{large_images:[{image_url:signed.replace('native','wrong')}] }},
    {common_attr:{id:itemId},image:{large_images:[{image_url:signed,width:1687,height:2160}],format:'png'}}]}}});
  const result=await p.call({canvasId:'100',jobId:'raw',operation:'GENERATED',itemId,optionalDetails:true});
  assert.equal(result.ok,true);assert.equal(result.url,signed);assert.equal(result.itemId,itemId);
  assert.equal(result.width,1687);assert.equal(result.height,2160);
});

test('详情缺失身份或原图时返回安全诊断，不暴露签名，不接受大整数精度丢失',async()=>{
  const itemId='900000000000000001';
  for(const [items,code,stage] of [
    [[], 'RESOURCE_ID_MISSING','item-match'],
    [[{common_attr:{id:Number(itemId)},image:{large_images:[{image_url:signed}]}}], 'RESOURCE_ID_MISSING','item-match'],
    [[{common_attr:{id:itemId},image:{large_images:[{image_url:signed.replace('native.png','aigc_resize:360:360.webp')}]}}], 'RESOURCE_UNRESOLVED','original-url']
  ]) {
    const p=page({'/mweb/v1/get_local_item_list':{ret:'0',data:{item_list:items}}});
    const result=await p.call({canvasId:'100',jobId:'safe',operation:'GENERATED',itemId,optionalDetails:true});
    assert.equal(result.ok,false);assert.equal(result.code,code);assert.equal(result.diagnostic.stage,stage);
    assert.ok(!JSON.stringify(result).includes('NOT_IN_REPORT'));
  }
});

test('失败接口、错 item、预览以及其他域名都不能成为成功原图',async()=>{
  for(const value of [signed.replace('native.png','aigc_resize:360:360.webp'),'https://other.example/native.png']) {
    const p=page({'/mweb/v1/get_image_by_uri':{ret:'0',uri2image:{upload:{image_url:value}}}});
    assert.equal((await p.call({canvasId:'100',jobId:'a',operation:'UPLOAD',resourceId:'upload'})).ok,false);
    assert.equal(originalURL(value),null);
  }
  const p=page({'/mweb/v1/get_local_item_list':{ret:'1020'}});
  assert.equal((await p.call({canvasId:'100',jobId:'bad',operation:'GENERATED',itemId:'123',optionalDetails:true})).code,'RESOURCE_SOURCE_UNAVAILABLE');
  assert.ok(!safeError(new Error('failed '+signed)).includes('NOT_IN_REPORT'));
});
test('生成记录为主要来源，同记录复用原样签名，不要求作品详情请求',async()=>{
  const recordId='42',itemId='900000000000000001',nextId='900000000000000002';
  const p=page({'/mweb/v1/get_history_by_ids':{ret:'0',data:{[recordId]:{item_list:[
    {common_attr:{id:itemId},image:{large_images:[{image_url:signed}]}},
    {common_attr:{id:nextId},image:{large_images:[{image_url:signed.replace('native','next')}]}}
  ]}}}});
  const result=await p.call({canvasId:'100',jobId:'history',operation:'GENERATED',recordId,itemId});
  assert.equal(result.url,signed);assert.equal(result.origin,'get_history_by_ids.large_images');
  assert.deepEqual(p.requests[0].body.history_ids,[recordId]);
  assert.equal((await p.call({canvasId:'100',jobId:'cached',operation:'GENERATED',recordId,itemId:nextId})).ok,true);
  assert.equal(p.requests.length,1);assert.ok(!p.requests.some(r=>r.path.includes('get_local_item_list')));
});

test('项目资源 packing 失败回退快照扫描，成功 packing 保留精确资源绑定',async()=>{
  let fail=true;
  const project={id:'100',draft:{draft_id:'200'}};
  const p=page({'/mweb/v1/infinite_canvas/project_detail':opts=>new Response(JSON.stringify(
    JSON.parse(opts.body).option.need_draft_resource&&fail?{ret:'900'}:
    {ret:'0',data:{project,draft_resources:{images:{upload:{image_url:signed}},historys:{record:{item_list:[]}}}}})),
    '/mweb/v1/infinite_canvas/v1/fetch_snapshot':{ret:'0',data:{snapshots:[]}}});
  const result=await p.call({canvasId:'100',jobId:'scan',operation:'SCAN'});
  assert.equal(result.ok,true);assert.equal(p.requests[0].body.option.need_draft_resource,true);
  assert.equal(p.requests[1].body.option.need_draft_resource,false);assert.ok(result.project.data.draft_resources);
  fail=false;await p.call({canvasId:'100',jobId:'scan2',operation:'SCAN'});
  const uploaded=await p.call({canvasId:'100',jobId:'upload',operation:'UPLOAD',resourceId:'upload'});
  assert.equal(uploaded.url,signed);assert.equal(uploaded.origin,'project_detail.draft_resources.images');
  assert.ok(!p.requests.some(r=>r.path.includes('get_image_by_uri')));
});

test('未解析记录短时负缓存减少重复请求，主动刷新和扫描可重新读取',async()=>{
  const p=page({'/mweb/v1/get_history_by_ids':{ret:'0',data:{}}});
  const request={canvasId:'100',jobId:'no',operation:'GENERATED',recordId:'42',itemId:'123'};
  assert.equal((await p.call(request)).code,'RESOURCE_UNRESOLVED');
  await p.call({...request,jobId:'next',itemId:'124'});assert.equal(p.requests.length,1);
  await p.call({...request,jobId:'refresh',refresh:true});assert.equal(p.requests.length,2);
});

test('历史无图/来源不可用不强制详情；身份、权限、限流错误保留为致命原因',async()=>{
  for(const response of [{ret:'0',data:{}},{ret:'900'}]) {
    const p=page({'/mweb/v1/get_history_by_ids':response});
    const result=await p.call({canvasId:'100',jobId:'missing',operation:'GENERATED',recordId:'42',itemId:'123'});
    assert.equal(result.code,'RESOURCE_UNRESOLVED');assert.equal(p.requests.length,1);
  }
  for(const status of [401,403,429]) {
    const p=page({'/mweb/v1/get_history_by_ids':()=>new Response('{}',{status})});
    assert.equal((await p.call({canvasId:'100',jobId:'auth',operation:'GENERATED',recordId:'42',itemId:'123'})).code,'API_HTTP_'+status);
  }
  const p=page({'/mweb/v1/get_history_by_ids':{ret:'0',data:{42:{history_record_id:'other',item_list:[]}}}});
  assert.equal((await p.call({canvasId:'100',jobId:'identity',operation:'GENERATED',recordId:'42',itemId:'123'})).code,'IDENTITY_MISMATCH');
});

test('DOM 备用只使用对应节点的显式未缩放原始地址，不保存预览或无关 PNG',async()=>{
  const nodeId='00000000-0000-4000-8000-000000000001';
  for(const [value,ok] of [[signed.replace('native.png','resize:0:0.image'),true],[signed,false],[signed.replace('native.png','aigc_resize:360:360.webp'),false]]) {
    const p=page({});p.context.document={getElementById:id=>id===nodeId?{querySelector:()=>({src:value})}:null};
    const result=await p.call({canvasId:'100',jobId:'dom',operation:'GENERATED',itemId:'123',nodeIds:[nodeId]});
    assert.equal(result.ok,ok);if(ok)assert.equal(result.url,value);
    assert.equal(p.requests.length,0);
  }
});

test('脱敏快照利用项目历史原始 common_attr 身份，不改变资源去重键',()=>{
  const {snapshot,project,draft}=canvasFixture(),ref=Object.values(draft.aiGeneratorReference)[0];
  project.data.draft_resources={historys:{[ref.recordId]:{item_list:[{common_attr:{id:ref.itemId},image:{large_images:[{image_url:signed}]}}]}}};
  const analysis=analyzeSnapshot(snapshot,project,'100');
  assert.equal(analysis.uniqueResourceCount,288);assert.equal(analysis.candidateResourceCount,1);
  const records=mergeResources(analysis);assert.ok(!JSON.stringify(records).includes('NOT_IN_REPORT'));
  assert.equal(records.find(r=>r.itemId===ref.itemId).resolution,'candidate');
});

test('网页请求可取消，取消不变成图片完成',async()=>{
  const p=page({'/mweb/v1/get_image_by_uri':options=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}))});
  const request=p.call({canvasId:'100',jobId:'job',operation:'UPLOAD',resourceId:'upload'});
  await p.call({canvasId:'100',jobId:'job',operation:'CANCEL'});
  assert.equal((await request).code,'ABORTED');
});
test('CDN 文件下载保留地址，omit 凭据，拒绝 HTML 与 HTTP 错误',async()=>{
  const native=globalThis.fetch;const requests=[];
  try {
    globalThis.fetch=async(url,options)=>{requests.push({url,options});return new Response(png,{headers:{'content-type':'image/png'}});};
    const blob=await fetchOriginal(signed,new AbortController().signal);
    assert.deepEqual(Buffer.from(await blob.arrayBuffer()),Buffer.from(await png.arrayBuffer()));
    assert.equal(requests[0].url,signed);assert.equal(requests[0].options.credentials,'omit');
    globalThis.fetch=async()=>new Response('HTML',{headers:{'content-type':'text/html'}});
    await assert.rejects(fetchOriginal(signed,new AbortController().signal),/不是/);
    globalThis.fetch=async()=>new Response('denied',{status:403});
    await assert.rejects(fetchOriginal(signed,new AbortController().signal),/403/);
  } finally {globalThis.fetch=native;}
});
test('正式运行只允许原图读取，旧非零 resize 候选通道不再开放',async()=>{
  const native=globalThis.fetch,candidate=signed.replace('native.png','aigc_resize:360:360.webp');let calls=0;
  try {
    globalThis.fetch=async(value,options)=>{calls++;assert.equal(value,candidate);assert.equal(options.credentials,'omit');
      return new Response(png,{headers:{'content-type':'image/png'}});};
    await assert.rejects(fetchOriginal(candidate,new AbortController().signal),/拒绝/);assert.equal(calls,0);
    assert.ok(!fs.readFileSync(new URL('../download.js',import.meta.url),'utf8').includes('fetchValidationCandidate'));
  } finally{globalThis.fetch=native;}
});
test('真实已验证的 aigc_resize:0:0 可作为原图，非零或歧义尺寸仍拒绝，签名不改写',()=>{
  const original=signed.replace('native.png','aigc_resize:0:0.png');assert.equal(originalURL(original),original);
  for(const suffix of ['aigc_resize:360:360.webp','aigc_resize:0:00.png','aigc_resize:0:0:90.png','thumbnail.png'])
    assert.equal(originalURL(signed.replace('native.png',suffix)),null);
});
test('原图读取拒绝非授权域名和重定向，不放开任意下载地址',async()=>{
  const native=globalThis.fetch;
  try {
    await assert.rejects(fetchOriginal('https://example.com/image.png',new AbortController().signal),/拒绝/);
    globalThis.fetch=async()=>{const response=new Response(png,{headers:{'content-type':'image/png'}});
      Object.defineProperty(response,'url',{value:'https://example.com/redirect.png'});return response;};
    await assert.rejects(fetchOriginal(signed,new AbortController().signal),/跳转/);
  } finally{globalThis.fetch=native;}
});

test('图片响应超时有稳定可重试代码和安全阶段信息，不泄露签名',async()=>{
  const native=globalThis.fetch;
  try {
    globalThis.fetch=async(value,options)=>new Promise((resolve,reject)=>{
      options.signal.addEventListener('abort',()=>reject(new Error('native abort')),{once:true});
    });
    await assert.rejects(fetchOriginal(signed,new AbortController().signal,{timeoutMs:20}),e=>{
      assert.equal(e.code,'IMAGE_TIMEOUT');assert.equal(e.diagnostic.stage,'response');
      assert.equal(e.diagnostic.receivedBytes,0);assert.ok(!JSON.stringify(e).includes('NOT_IN_REPORT'));return true;
    });
  } finally{globalThis.fetch=native;}
});

test('图片流读取超时记录已收字节；用户取消不会改成网络超时',async()=>{
  const native=globalThis.fetch;
  try {
    globalThis.fetch=async(value,options)=>new Response(new ReadableStream({start(c){
      c.enqueue(new Uint8Array([1,2,3]));options.signal.addEventListener('abort',()=>c.error(new Error('native abort')),{once:true});
    }}),{headers:{'content-type':'image/png','content-length':'100'}});
    await assert.rejects(fetchOriginal(signed,new AbortController().signal,{timeoutMs:20}),e=>{
      assert.equal(e.code,'IMAGE_TIMEOUT');assert.equal(e.diagnostic.stage,'body');
      assert.equal(e.diagnostic.receivedBytes,3);assert.equal(e.diagnostic.declaredBytes,100);return true;
    });
    const controller=new AbortController(),reason=new Error('用户暂停');
    const request=fetchOriginal(signed,controller.signal,{timeoutMs:100});controller.abort(reason);
    await assert.rejects(request,e=>e===reason);
  } finally{globalThis.fetch=native;}
});

test('图片实际字节与声明长度不符不能保存为完整原图',async()=>{
  const native=globalThis.fetch;
  try {
    globalThis.fetch=async()=>new Response(png,{headers:{'content-type':'image/png','content-length':String(png.size+1)}});
    await assert.rejects(fetchOriginal(signed,new AbortController().signal),e=>e.code==='IMAGE_INCOMPLETE'&&e.diagnostic.receivedBytes===png.size);
  } finally{globalThis.fetch=native;}
});
test('Chrome 只有完成状态且大小匹配才计成功；错误时取消但不删文件',async()=>{
  let cancelled=0,planned,filename,state='complete',size=png.size;
  globalThis.chrome={downloads:{download:async opts=>{filename=opts.filename;assert.ok(!filename.includes('NOT_IN_REPORT'));return 7;},
    search:async()=>[{state,fileSize:size,exists:true,filename:'C:\\Downloads\\'+filename}],cancel:async()=>{cancelled++;}}};
  const saved=await saveChromeDownload(png,'board/image',async p=>planned=p,new AbortController().signal);
  assert.equal(saved.downloadId,7);assert.equal(planned.bytes,png.size);await verifyChrome(saved);
  state='interrupted';await assert.rejects(saveChromeDownload(png,'board/image',async()=>{},new AbortController().signal),/中断/);
  assert.equal(cancelled,1);state='complete';size=10;await assert.rejects(verifyChrome(saved),/不一致/);
});
test('目录模式继续回读 SHA；已有文件不会覆盖，损坏不能跳过',async()=>{
  const files=new Map([['image.png',new Blob(['user original'])]]);
  const dir={async getFileHandle(name,opts={}){
    if(!files.has(name)){if(!opts.create)throw Object.assign(new Error('missing'),{name:'NotFoundError'});files.set(name,new Blob());}
    return{getFile:async()=>files.get(name),createWritable:async()=>{let data;return{write:async value=>{data=value;},close:async()=>files.set(name,data),abort:async()=>{}};}};
  }};
  const result=await saveImage(dir,png,'image',async()=>{});assert.equal(result.name,'image_1.png');
  await verifyImage(dir,result);assert.equal(await files.get('image.png').text(),'user original');
  files.set(result.name,new Blob(['corrupt']));await assert.rejects(verifyImage(dir,result));
});
test('限速并发、暂停阻止后续任务，非法参数拒绝',async()=>{
  const controller=new AbortController(),started=[];let active=0,peak=0;
  await runBatches([1,2,3,4],{batchSize:50,concurrency:2,interval:300},async item=>{
    started.push(Date.now());active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,400));active--;
  },controller.signal);
  assert.ok(peak<=2);for(let i=1;i<started.length;i++)assert.ok(started[i]-started[i-1]>=270);
  const paused=new AbortController();let count=0;
  await runBatches([1,2,3],{batchSize:50,concurrency:1,interval:300},async()=>{count++;paused.abort(new Error('pause'));},paused.signal);
  assert.equal(count,1);
  await assert.rejects(runBatches([],{batchSize:525,concurrency:20,interval:0},()=>{},controller.signal),/参数/);
});
test('后台启动互斥、当前窗口选择和来源限制，不使用 debugger/Input',async()=>{
  const event=()=>({addListener(f){this.f=f;}});let resolveTab,executed;
  const gate=new Promise(r=>resolveTab=r);
  const chrome={runtime:{id:'self',getManifest:()=>({version}),getURL:p=>'chrome-extension://self/'+p,onConnect:event(),onMessage:event(),onInstalled:event()},
    tabs:{get:async()=>{await gate;return{url:'https://jimeng.jianying.com/ai-tool/canvas/100'};},query:async opts=>{if(opts.windowId!==undefined){assert.equal(opts.windowId,9);assert.equal(opts.lastFocusedWindow,undefined);}else assert.equal(opts.lastFocusedWindow,true);return[{id:7,active:true,url:'https://jimeng.jianying.com/ai-tool/canvas/100'}];}},sidePanel:{},
    scripting:{executeScript:async options=>{executed=options;return[{result:{ok:true}}];}}};
  const source=fs.readFileSync(new URL('../background.js',import.meta.url),'utf8').replace(/^import .*\n/gm,'');
  vm.runInNewContext(source,{chrome,readPage,readGeneratedPage,withTimeout,crypto:webcrypto});
  chrome.runtime.onConnect.f({name:'jce:owner',onDisconnect:event()});
  const rpc=m=>new Promise(r=>chrome.runtime.onMessage.f({owner:'owner',...m},{id:'self'},r));
  const first=rpc({type:'START_SESSION',tabId:7});assert.equal((await rpc({type:'START_SESSION',tabId:7})).ok,false);
  resolveTab();assert.equal((await first).ok,true);assert.equal((await rpc({type:'GET_ACTIVE_CANVAS'})).tabId,7);
  assert.equal((await rpc({type:'GET_ACTIVE_CANVAS',windowId:9})).tabId,7);
  assert.equal((await rpc({type:'GET_BUILD'})).build,version);
  await rpc({type:'READ_PAGE',tabId:7,request:{operation:'GENERATED',recordId:'42',itemId:'123'}});
  assert.equal(executed.func,readGeneratedPage);assert.equal(executed.world,'MAIN');
  await rpc({type:'END_SESSION'});
  assert.equal(chrome.runtime.onMessage.f({type:'READ_PAGE'},{id:'self',tab:{}},()=>{}),undefined);
  assert.equal(chrome.runtime.onMessage.f({type:'GET_BUILD'},{id:'self',tab:{},url:'https://jimeng.jianying.com/'},()=>{}),undefined);
  const ownPage=await new Promise(resolve=>chrome.runtime.onMessage.f({type:'GET_BUILD'},{id:'self',tab:{},url:'chrome-extension://self/sidepanel.html'},resolve));
  assert.equal(ownPage.build,version);
});

function backgroundFixture(executeScript=async()=>[{result:{ok:true}}]) {
  const event=()=>({addListener(fn){this.fn=fn;}}),chrome={
    runtime:{id:'self',getManifest:()=>({version}),getURL:p=>'chrome-extension://self/'+p,onConnect:event(),onMessage:event(),onInstalled:event()},
    tabs:{get:async()=>({url:'https://jimeng.jianying.com/ai-tool/canvas/100'})},scripting:{executeScript},sidePanel:{}};
  const source=fs.readFileSync(new URL('../background.js',import.meta.url),'utf8').replace(/^import .*\n/gm,'');
  const restart=()=>vm.runInNewContext(source,{chrome,readPage,readGeneratedPage,withTimeout,crypto:webcrypto});restart();
  const connect=(owner='owner')=>{const messages=[],port={name:'jce:'+owner,onDisconnect:event(),postMessage:m=>messages.push(m)};
    chrome.runtime.onConnect.fn(port);return{port,messages};};
  const rpc=m=>new Promise(resolve=>chrome.runtime.onMessage.fn({owner:'owner',tabId:7,canvasId:'100',...m},{id:'self'},resolve));
  return{rpc,connect,restart};
}

test('后台重启丢失登记可重建；旧端口断开不删除新端口，恢复不抢占其他任务',async()=>{
  const f=backgroundFixture(),old=f.connect();await f.rpc({type:'START_SESSION'});
  f.restart();assert.equal((await f.rpc({type:'ENSURE_SESSION'})).code,'BACKGROUND_OWNER_LOST');
  const recovered=f.connect();assert.equal(recovered.messages[0].type,'READY');
  assert.equal((await f.rpc({type:'ENSURE_SESSION'})).ok,true);
  const newer=f.connect();recovered.port.onDisconnect.fn();
  assert.equal((await f.rpc({type:'ENSURE_SESSION'})).ok,true);
  f.connect('other');assert.equal((await f.rpc({type:'ENSURE_SESSION',owner:'other'})).code,'SESSION_BUSY');
  assert.equal((await f.rpc({type:'START_SESSION'})).code,'SESSION_BUSY');
  newer.port.onDisconnect.fn();assert.equal((await f.rpc({type:'ENSURE_SESSION'})).code,'BACKGROUND_OWNER_LOST');
  old.port.onDisconnect.fn();
});

test('旧会话异步清理不会释放恢复后的新会话',async()=>{
  let finishRead,finishCancel,cancelling=false;
  const read=new Promise(resolve=>finishRead=resolve),cancel=new Promise(resolve=>finishCancel=resolve);
  const f=backgroundFixture(async options=>{
    if(options.args[0].operation==='CANCEL'){cancelling=true;await cancel;return[{result:{ok:true}}];}
    await read;return[{result:{ok:true}}];
  });
  f.connect();await f.rpc({type:'START_SESSION'});
  const pending=f.rpc({type:'READ_PAGE',request:{operation:'SCAN'}});
  // Let READ_PAGE register the job, then stop with a blocked cancellation.
  await new Promise(resolve=>setTimeout(resolve,0));const stopping=f.rpc({type:'END_SESSION'});
  while(!cancelling)await new Promise(resolve=>setTimeout(resolve,1));
  assert.equal((await f.rpc({type:'ENSURE_SESSION'})).ok,true);
  finishCancel();await stopping;f.connect('other');
  assert.equal((await f.rpc({type:'START_SESSION',owner:'other'})).code,'SESSION_BUSY');
  finishRead();await pending;
});

function panelFixture(options={}) {
  const elements=new Map();
  const element=id=>{
    if(!elements.has(id))elements.set(id,{value:({saveMode:'chrome',batchSize:'50',concurrency:'1',retries:options.retries||'0',interval:'300'})[id]||'',
      checked:id==='subfolders',textContent:'',listeners:{},addEventListener(name,fn){this.listeners[name]=fn;},replaceChildren(){},add(){}});
    return elements.get(id);
  };
  const records=[],calls=[],ports=[],pageEvents={},event=()=>({listeners:[],addListener(fn){this.listeners.push(fn);this.fn=fn;},fire(value){for(const fn of this.listeners)fn(value);}});
  const chrome={runtime:{getManifest:()=>({version}),connect:()=>{
    const port={onDisconnect:event(),onMessage:event(),disconnect(){this.onDisconnect.fire();}};ports.push(port);
    queueMicrotask(()=>{
      if(ports.length>1&&options.onReconnect)options.onReconnect(port,pageEvents);
      if(!options.noReady)port.onMessage.fire({type:'READY',build:version});
    });return port;
  },sendMessage:async m=>{
    calls.push(m);
    if(options.sendMessage){const response=await options.sendMessage(m);if(response!==undefined)return response;}
    if(m.type==='GET_BUILD')return options.buildInfo||{ok:true,build:version,capabilities:['SNAPSHOT','GENERATED_READ','SESSION_RECOVERY']};
    if(m.type==='GET_ACTIVE_CANVAS')return{ok:true,tabId:7,url:'https://jimeng.jianying.com/ai-tool/canvas/100'};
    if(m.type==='READ_PAGE'){if(options.blockRead)return options.blockRead;
      if(options.readPage)return options.readPage(m);
      return{ok:true,itemId:m.request.itemId,resourceId:m.request.resourceId,recordId:m.request.recordId,url:signed,
        width:1,height:1,origin:'verified-test-fixture',diagnostic:{historyIdConfirmed:!!m.request.recordId}};}
    return{ok:true};
  }},tabs:{onActivated:event(),onUpdated:event()},storage:{local:{get:async()=>({}),set:async value=>{records.push(value);}}},downloads:{search:async()=>[{state:'complete',exists:true,fileSize:png.size,filename:'test.json'}],download:async()=>7}};
  const source=fs.readFileSync(new URL('../sidepanel.js',import.meta.url),'utf8').replace(/^import .*\n/gm,'');
  const context={document:{getElementById:element},chrome,crypto:webcrypto,AbortController,structuredClone,URL,Blob,Option:class{},
    console,Date,queueMicrotask,setTimeout,clearTimeout,setInterval,clearInterval,addEventListener(name,fn){pageEvents[name]=fn;},
    analyzeSnapshot,canvasIdentity,mergeResources,archiveRemoved,pendingResources,safeError,runBatches,taskState,stateLabels,latestTask,restoreTask,taskDirectory,withTimeout,delay,inspect:async()=>options.info||{},
    saveTask:async task=>{if(options.failPersist&&['paused','completed'].includes(task.status))throw new Error('storage failed');records.push(task);},
    listTasks:async()=>options.tasks||[],getHandle:options.getHandle||(async id=>options.handles?options.handles.get(id)||null:options.dir||null),saveHandle:async(id,value)=>{if(options.handles)options.handles.set(id,value);},fetchOriginal:options.fetchOriginal||(async()=>options.blob||png),
    unusedName:async(dir,base,ext)=>base+'.'+ext,saveImage:async(dir,blob,base,onPlan)=>{
      await onPlan({name:base+'.png',bytes:png.size,sha256:'verified',width:1,height:1});
      return{name:base+'.png',bytes:png.size,sha256:'verified',width:1,height:1,ext:'png'};
    },
    verifyChrome:async r=>r,verifyImage:async()=>{},saveChromeDownload:async(blob,base,onPlan)=>{
      await onPlan({bytes:png.size,sha256:'verified',downloadId:7,width:1,height:1});
      if(options.saveError)throw options.saveError;
      return{bytes:png.size,sha256:'verified',downloadId:7,width:1,height:1,name:'image.png'};
    }};
  const api=vm.runInNewContext(source.slice(0,source.lastIndexOf('\nawait settings();'))+
    '\n({run,scan,verifyGenerated,verifyGeneratedBatch,bindCanvas,followCanvas,render,setTask:t=>{task=t;},state:()=>({task,running,connected,dir,baseDir})})',context);
  const task={id:'task',schema:3,canvasId:'100',canvasUrl:'https://jimeng.jianying.com/ai-tool/canvas/100',saveMode:'chrome',status:'ready',
    resources:[{resourceKey:'one',resourceSource:'aiGenerate',itemId:'123',index:1,status:'pending'}]};
  api.setTask(task);
  return{api,port:ports[0],ports,pageEvents,records,calls,task,elements,element};
}
test('新版侧栏：完成资源保存持久化，重复开始不再下载',async()=>{
  const f=panelFixture();await f.api.run();
  assert.equal(f.task.resources[0].status,'done');assert.equal(f.task.resources[0].fileSize,png.size);
  assert.ok(f.records.some(r=>r.resources[0].status==='done'));assert.ok(!JSON.stringify(f.records).includes('NOT_IN_REPORT'));
  const reads=f.calls.filter(m=>m.type==='READ_PAGE').length;await f.api.run();
  assert.equal(f.calls.filter(m=>m.type==='READ_PAGE').length,reads);assert.equal(f.api.state().running,false);
});

test('正在自动识别时用户粘贴另一画板链接，旧回调不能覆盖输入或换任务',async()=>{
  let finish;const response=new Promise(resolve=>finish=resolve);
  const f=panelFixture({sendMessage:m=>m.type==='GET_ACTIVE_CANVAS'?response:undefined});
  const following=f.api.followCanvas();f.element('canvasUrl').value='https://jimeng.jianying.com/ai-tool/canvas/101';
  f.element('canvasUrl').listeners.input();finish({ok:true,tabId:8,url:'https://jimeng.jianying.com/ai-tool/canvas/102'});await following;
  assert.equal(f.element('canvasUrl').value,'https://jimeng.jianying.com/ai-tool/canvas/101');assert.equal(f.api.state().task.canvasId,'100');
});
test('不同画板历史切换各取自己的授权句柄，不沿用前一画板目录',async()=>{
  const a={id:'A',schema:3,canvasId:'100',saveMode:'folder',resources:[],updatedAt:'2026-01-01'},b={...a,id:'B',canvasId:'101'};
  const dirA={name:'A'},dirB={name:'B'},f=panelFixture({tasks:[a,b],handles:new Map([['A',dirA],['B',dirB]])});
  f.api.setTask(a);await f.api.bindCanvas('101');assert.equal(f.api.state().task.id,'B');assert.equal(f.api.state().dir,dirB);
  await f.api.bindCanvas('100');assert.equal(f.api.state().dir,dirA);
});

test('快速选择两个历史任务，迟到的目录读取不能把后一画板写入前一目录',async()=>{
  const a={id:'A',schema:3,canvasId:'100',canvasUrl:'https://jimeng.jianying.com/ai-tool/canvas/100',saveMode:'folder',resources:[],updatedAt:'2026-01-01'};
  const b={...a,id:'B',canvasId:'101',canvasUrl:'https://jimeng.jianying.com/ai-tool/canvas/101'};
  const dirA={name:'A'},dirB={name:'B'};let releaseA,readingA;
  const waitA=new Promise(resolve=>releaseA=resolve),startedA=new Promise(resolve=>readingA=resolve);
  const f=panelFixture({tasks:[a,b],getHandle:async id=>{
    if(id==='A'){readingA();await waitA;return dirA;}return id==='B'?dirB:null;
  }});
  f.element('history').value='A';const first=f.element('history').listeners.change();await startedA;
  f.element('history').value='B';await f.element('history').listeners.change();releaseA();await first;
  assert.equal(f.api.state().task.id,'B');assert.equal(f.api.state().dir,dirB);assert.equal(f.api.state().baseDir,dirB);
  assert.equal(f.element('canvasUrl').value,b.canvasUrl);
});

test('历史恢复目录未读完时不能启动旧画板任务，粘贴新链接使恢复结果失效',async()=>{
  const saved={id:'B',schema:3,canvasId:'101',canvasUrl:'https://jimeng.jianying.com/ai-tool/canvas/101',saveMode:'folder',resources:[],updatedAt:'2026-01-01'};
  let finish,started;const delayed=new Promise(resolve=>finish=resolve),reading=new Promise(resolve=>started=resolve);
  const f=panelFixture({tasks:[saved],getHandle:async id=>{if(id==='B'){started();return delayed;}return null;}});
  f.element('history').value='B';const restore=f.element('history').listeners.change();await reading;
  assert.equal(f.element('start').disabled,true);
  f.element('canvasUrl').value='https://jimeng.jianying.com/ai-tool/canvas/102';f.element('canvasUrl').listeners.input();
  finish({name:'B'});await restore;
  assert.equal(f.element('canvasUrl').value,'https://jimeng.jianying.com/ai-tool/canvas/102');assert.equal(f.api.state().task,null);
});

test('关联缺失只保留为未解析，不阻断整板扫描或丢弃图片节点',async()=>{
  const data=canvasFixture(3,'100',{uploads:0});delete data.draft.aiGeneratorReference;
  data.snapshot.data.snapshots[0].draft=JSON.stringify(data.draft);
  const f=panelFixture({readPage:()=>({ok:true,snapshot:data.snapshot,project:data.project})});await f.api.scan();
  assert.equal(f.api.state().task.imageNodeCount,3);assert.equal(f.api.state().task.resources.length,3);
  assert.equal(f.api.state().task.complete,false);
});

test('生成身份字段无效属于未解析，后续上传原图仍可下载',async()=>{
  const f=panelFixture({readPage:m=>m.request.operation==='UPLOAD'?{ok:true,resourceId:'upload',url:signed,origin:'fixture'}:
    {ok:false,code:'INVALID_ID',error:'生成图关联字段无效'}});
  f.task.resources.push({resourceKey:'uploaded',resourceSource:'userUpload',resourceId:'upload',index:2,status:'pending'});
  await f.api.run();assert.equal(f.task.resources[0].status,'unresolved');assert.equal(f.task.resources[1].status,'done');
});

test('非 JSON 的接口错误不将响应内可能的敏感字符串带入日志',async()=>{
  const p=page({'/mweb/v1/get_image_by_uri':()=>({ok:true,json:async()=>{throw new SyntaxError('Cookie=TEST_SECRET response invalid');}})});
  const result=await p.call({canvasId:'100',jobId:'private',operation:'UPLOAD',resourceId:'upload'});
  assert.equal(result.code,'API_INVALID_RESPONSE');assert.ok(!JSON.stringify(result).includes('TEST_SECRET'));
});
test('新版侧栏：收尾持久化异常也能解锁，连点不启动两轮',async()=>{
  const f=panelFixture({failPersist:true});
  const first=f.api.run();await f.api.run();await first;
  assert.equal(f.api.state().running,false);
  assert.equal(f.calls.filter(m=>m.type==='START_SESSION').length,1);
});
test('新版侧栏：实际关闭面板中断等待，资源恢复 pending，不自动重连或计成功',async()=>{
  const f=panelFixture({blockRead:new Promise(()=>{})});
  const running=f.api.run();
  while(!f.calls.some(m=>m.type==='READ_PAGE'))await new Promise(r=>setTimeout(r,1));
  f.pageEvents.pagehide();f.port.onDisconnect.fire();await assert.rejects(running,/关闭/);
  assert.equal(f.task.resources[0].status,'pending');assert.equal(f.api.state().running,false);
  assert.equal(f.ports.length,1);
});

test('实际故障回归：端口未报断开但后台登记丢失时自动重连，已完成资源不重下',async()=>{
  let checks=0;
  const f=panelFixture({sendMessage:m=>{
    if(m.type==='ENSURE_SESSION'&&++checks===2)return{ok:false,code:'BACKGROUND_OWNER_LOST',error:'后台已失去侧栏连接登记'};
  }});
  f.task.resources.push({...f.task.resources[0],resourceKey:'two',index:2},
    {...f.task.resources[0],resourceKey:'saved',index:3,status:'done'});
  await f.api.run();
  assert.equal(f.ports.length,2);assert.equal(f.task.resources.every(r=>r.status==='done'),true);
  assert.equal(f.calls.filter(m=>m.type==='READ_PAGE').length,2);assert.ok(checks>=4);
  assert.equal(f.api.state().connected,true);assert.ok(!JSON.stringify(f.records).includes('NOT_IN_REPORT'));
});

test('后台消息通道突然关闭时只重试一次只读查询，不重复保存文件',async()=>{
  let reads=0;
  const f=panelFixture({sendMessage:m=>{
    if(m.type==='READ_PAGE'&&++reads===1)throw new Error('The message port closed before a response was received.');
  }});
  await f.api.run();assert.equal(reads,2);assert.equal(f.ports.length,2);
  assert.equal(f.task.resources[0].status,'done');assert.equal(f.task.resources[0].attempts,1);
  assert.equal(f.calls.filter(m=>m.type==='END_SESSION').length,1);
});

test('读取图片时后台端口断开可恢复，不取消正在读取的图片或再下同一张',async()=>{
  let finish,reading=false;
  const wait=new Promise(resolve=>finish=resolve);
  const f=panelFixture({fetchOriginal:async()=>{reading=true;await wait;return png;}});
  const running=f.api.run();while(!reading)await new Promise(resolve=>setTimeout(resolve,1));
  f.port.onDisconnect.fire();while(f.ports.length<2||!f.api.state().connected)await new Promise(resolve=>setTimeout(resolve,1));
  finish();await running;assert.equal(f.task.resources[0].status,'done');
  assert.equal(f.calls.filter(m=>m.type==='READ_PAGE').length,1);
});

test('用户在恢复连接期间关闭侧栏，立即停止，未误记图片失败或继续请求',async()=>{
  const f=panelFixture({noReady:true,onReconnect:(port,events)=>events.pagehide(),
    sendMessage:m=>m.type==='ENSURE_SESSION'?{ok:false,code:'BACKGROUND_OWNER_LOST',error:'登记丢失'}:undefined});
  await assert.rejects(f.api.run(),/关闭/);
  assert.equal(f.task.resources[0].status,'pending');assert.equal(f.calls.filter(m=>m.type==='READ_PAGE').length,0);
  assert.equal(f.ports.length,2);assert.equal(f.api.state().running,false);
});

test('自动恢复不能抢占其他任务：会话忙时暂停且当前资源留待下载，不累计图片失败',async()=>{
  let checks=0;
  const f=panelFixture({sendMessage:m=>{
    if(m.type==='ENSURE_SESSION')return ++checks===1?{ok:false,code:'BACKGROUND_OWNER_LOST',error:'登记丢失'}:
      {ok:false,code:'SESSION_BUSY',error:'另一个任务正在下载'};
  }});
  f.task.resources.push({...f.task.resources[0],resourceKey:'two',index:2});
  await assert.rejects(f.api.run(),/另一个任务/);
  assert.equal(f.task.resources.every(r=>r.status==='pending'),true);
  assert.equal(f.calls.filter(m=>m.type==='READ_PAGE').length,0);assert.equal(f.api.state().running,false);
});

test('图片超时按配置重新解析地址再重试，最终成功；签名不写入报告',async()=>{
  let fetched=0;
  const f=panelFixture({retries:'1',info:{ext:'png',width:1,height:1,bytes:png.size,sha256:'verified'},fetchOriginal:async()=>{
    if(++fetched===1)throw Object.assign(new Error('图片请求超过 120 秒'),{code:'IMAGE_TIMEOUT',diagnostic:{stage:'body',receivedBytes:10}});
    return png;
  }});
  f.task.resources[0].recordId='42';await f.api.run();
  const reads=f.calls.filter(m=>m.type==='READ_PAGE');assert.equal(reads.length,2);assert.equal(reads[1].request.refresh,true);
  assert.equal(f.task.resources[0].status,'done');assert.equal(f.task.resources[0].attempts,2);
  assert.ok(!JSON.stringify(f.records).includes('NOT_IN_REPORT'));
});

test('重试耗尽的单图超时保留可重试记录和字节阶段，继续其他图片',async()=>{
  let fetched=0;
  const f=panelFixture({fetchOriginal:async()=>{
    if(++fetched===1)throw Object.assign(new Error('图片请求超过 120 秒'),{code:'IMAGE_TIMEOUT',diagnostic:{stage:'body',receivedBytes:10}});
    return png;
  }});
  f.task.resources.push({...f.task.resources[0],resourceKey:'two',index:2});await f.api.run();
  assert.equal(f.task.resources[0].status,'failed');assert.equal(f.task.resources[0].errorCode,'IMAGE_TIMEOUT');
  assert.equal(f.task.resources[0].diagnostic.receivedBytes,10);assert.equal(f.task.resources[1].status,'done');
  assert.equal(pendingResources(f.task,true).length,1);
});
test('多个原图未解析不阻断后续已解析原图；增量和重试保留范围',async()=>{
  const f=panelFixture({readPage:m=>m.request.operation==='UPLOAD'?{ok:true,resourceId:'upload',url:signed,origin:'fixture'}:
    {ok:false,code:'RESOURCE_UNRESOLVED',error:'未解析原图；未使用预览或自造签名'}});
  f.task.resources=[1,2,3].map(index=>({resourceKey:'g'+index,resourceSource:'aiGenerate',recordId:'42',itemId:String(index),index,status:'pending'}));
  f.task.resources.push({resourceKey:'upload',resourceSource:'userUpload',resourceId:'upload',index:4,status:'pending'});
  await f.api.run();
  assert.deepEqual(f.task.resources.map(r=>r.status),['unresolved','unresolved','unresolved','done']);
  assert.equal(f.api.state().running,false);assert.ok(!JSON.stringify(f.records).includes('NOT_IN_REPORT'));
  assert.equal(pendingResources(f.task,true).length,3);
  assert.ok(f.calls.filter(c=>c.type==='READ_PAGE').every(c=>c.request.optionalDetails!==true));
});

test('网页权限错误仍会停止，不继续请求后面的资源',async()=>{
  const f=panelFixture({readPage:()=>({ok:false,code:'API_HTTP_403',error:'接口 HTTP 403'})});
  f.task.resources.push({...f.task.resources[0],resourceKey:'two',index:2});
  await assert.rejects(f.api.run(),/403/);
  assert.equal(f.calls.filter(c=>c.type==='READ_PAGE').length,1);assert.equal(f.task.resources[1].status,'pending');
});

test('新版界面字段齐全，旧模拟点击不在活动入口中',()=>{
  const source=fs.readFileSync(new URL('../sidepanel.js',import.meta.url),'utf8');
  const html=fs.readFileSync(new URL('../sidepanel.html',import.meta.url),'utf8');
  const ids=new Set([...html.matchAll(/id="([^"]+)"/g)].map(m=>m[1]));
  for(const match of source.matchAll(/\$\('([^']+)'\)/g))assert.ok(ids.has(match[1]),'missing '+match[1]);
  assert.ok(!/RIGHT_CLICK_AT|LEFT_CLICK_AT|FIT_CANVAS|ARM_CAPTURE/.test(source));
  const manifest=JSON.parse(fs.readFileSync(new URL('../manifest.json',import.meta.url),'utf8'));
  assert.ok(!manifest.permissions.includes('debugger'));assert.ok(manifest.permissions.includes('downloads'));
});

function generatedPanel(options={}) {
  const ids=['123','124'],layers=ids.map((id,i)=>({id:'node'+i,type:'image',resourceSource:'aiGenerate',resourceId:''}));
  const refs=Object.fromEntries(ids.map((itemId,i)=>['node'+i,{recordId:'42',itemId}]));
  const scan={ok:true,project:{ret:'0',data:{project:{id:'100',draft:{draft_id:'200'}}}},
    snapshot:{ret:'0',data:{snapshots:[{draft_id:'200',version:1,draft:JSON.stringify({layers,meta:{},aiGeneratorReference:refs})}]}}};
  const info={ext:'png',width:1,height:1,bytes:png.size,sha256:'verified'};
  const f=panelFixture({info,...options,
    readPage:m=>m.request.operation==='SCAN'?scan:options.failure||{ok:true,recordId:'42',itemId:m.request.itemId,url:signed,
      origin:'get_history_by_ids.large_images',diagnostic:{stage:'candidate-found',historyIdConfirmed:true,itemMatched:true}}});
  f.api.setTask(null);return f;
}
test('通用单图试下载使用正式原图链路，仅保存一张且报告不含签名',async()=>{
  const f=generatedPanel();await f.api.verifyGenerated();const task=f.api.state().task;
  assert.deepEqual([...task.resources.map(r=>r.status)],['done','pending']);
  assert.equal(f.calls.filter(m=>m.type==='READ_PAGE'&&m.request.operation==='GENERATED').length,1);
  assert.ok(!JSON.stringify(f.records).includes('NOT_IN_REPORT'));assert.equal(f.api.state().running,false);
});
test('单图试下载的接口缺失保留节点、失败代码和阶段，不启动第二张',async()=>{
  const f=generatedPanel({failure:{ok:false,code:'HISTORY_NOT_FOUND',error:'没有对应记录',diagnostic:{stage:'record-match',historyIdConfirmed:false}}});
  await f.api.verifyGenerated();const task=f.api.state().task;
  assert.deepEqual([...task.resources.map(r=>r.status)],['unresolved','pending']);
  assert.equal(task.resources[0].diagnostic.stage,'record-match');assert.equal(task.resources[0].errorCode,'HISTORY_NOT_FOUND');
  assert.equal(f.calls.filter(m=>m.type==='READ_PAGE'&&m.request.operation==='GENERATED').length,1);
});
test('单图保存校验失败仍不能计完成，保留 writing 计划供回读恢复',async()=>{
  const f=generatedPanel({saveError:new Error('磁盘回读 SHA-256 不一致')});
  await assert.rejects(f.api.verifyGenerated(),/SHA/);const task=f.api.state().task;
  assert.equal(task.resources[0].status,'writing');assert.equal(task.resources[1].status,'pending');
  assert.equal(f.api.state().running,false);
});
test('非 PNG 仍明确失败，不转码、不保存为已确认原图',async()=>{
  const f=generatedPanel({info:{ext:'webp',width:1,height:1,bytes:png.size,sha256:'verified'}});
  await f.api.verifyGenerated();const task=f.api.state().task;
  assert.equal(task.resources[0].status,'failed');assert.equal(task.resources[0].errorCode,'NOT_OFFICIAL_PNG');
  assert.equal(task.resources[0].filename,undefined);
});
test('单图试下载不会重复下载已经完成的图片',async()=>{
  const f=generatedPanel();await f.api.verifyGenerated();const task=f.api.state().task;
  task.resources[1].status='done';await f.api.verifyGenerated();
  assert.equal(f.calls.filter(m=>m.type==='READ_PAGE'&&m.request.operation==='GENERATED').length,1);
  assert.equal(f.api.state().task.complete,true);assert.equal(f.api.state().running,false);
});
test('旧后台版本或缺能力时不扫描，显示更新入口',async()=>{
  const f=generatedPanel({buildInfo:{ok:true,build:'0.4.0',capabilities:['SNAPSHOT','RESOURCE_RESOLVE']}});
  await assert.rejects(f.api.verifyGenerated(),e=>e.code==='VALIDATOR_NOT_LOADED');
  assert.equal(f.api.state().connected,false);assert.equal(f.elements.get('reconnect').hidden,false);
  assert.equal(f.calls.filter(m=>m.type==='READ_PAGE').length,0);
});
test('相同新 build 但缺生成图读取能力仍拒绝，不能只比较版本',async()=>{
  const f=generatedPanel({buildInfo:{ok:true,build:version,capabilities:['SNAPSHOT']}});
  await assert.rejects(f.api.verifyGenerated(),e=>e.code==='VALIDATOR_NOT_LOADED');
  assert.equal(f.api.state().connected,false);assert.equal(f.calls.filter(m=>m.type==='READ_PAGE').length,0);
  assert.equal(f.elements.get('reconnect').hidden,false);
});
test('10 张小批仅处理未完成生成图，已完成和上传资源不重复下载，保留余下节点',async()=>{
  const f=panelFixture({info:{ext:'png',width:1,height:1,bytes:png.size,sha256:'verified'}});
  f.task.resources=[{resourceKey:'uploaded',resourceSource:'userUpload',index:1,status:'pending'},
    {resourceKey:'saved-ai',resourceSource:'aiGenerate',recordId:'42',itemId:'100',index:2,status:'done',bytes:png.size},
    ...Array.from({length:12},(_,i)=>({resourceKey:'ai'+i,resourceSource:'aiGenerate',recordId:'42',itemId:String(200+i),index:3+i,status:'unresolved'}))];
  await f.api.run(false,10,'generated');
  assert.equal(f.task.resources[0].status,'pending');assert.equal(f.task.resources[1].status,'done');
  assert.equal(f.task.resources.filter(r=>r.resourceSource==='aiGenerate'&&r.status==='done').length,11);
  assert.equal(f.task.resources.slice(-2).every(r=>r.status==='unresolved'),true);
  assert.equal(f.calls.filter(m=>m.type==='READ_PAGE').length,10);
  assert.ok(f.task.resources[2].provenance.historyIdConfirmed);assert.ok(!JSON.stringify(f.records).includes('NOT_IN_REPORT'));
});
test('批量生成图必须匹配记录身份和实际 PNG 尺寸；异常不计完成',async()=>{
  for(const options of [
    {readPage:()=>({ok:true,itemId:'123',recordId:'other',url:signed,diagnostic:{historyIdConfirmed:true}})},
    {info:{ext:'png',width:2,height:1,bytes:png.size,sha256:'verified'}},
    {info:{ext:'webp',width:1,height:1,bytes:png.size,sha256:'verified'}}
  ]) {
    const f=panelFixture(options);f.task.resources[0].recordId='42';
    await f.api.run().catch(()=>{});assert.notEqual(f.task.resources[0].status,'done');
    assert.ok(f.task.resources[0].errorCode);
  }
});
test('重开侧栏的小批入口自动恢复同画板授权目录及已完成记录，而不另建 Chrome 空任务',async()=>{
  const draft={meta:{},layers:['123','124','125'].map((id,i)=>({id:'node'+i,type:'image',resourceSource:'aiGenerate',resourceId:''})),
    aiGeneratorReference:Object.fromEntries(['123','124','125'].map((id,i)=>['node'+i,{recordId:'42',itemId:id}]))};
  const project={ret:'0',data:{project:{id:'100',draft:{draft_id:'200'}}}};
  const snapshot={ret:'0',data:{snapshots:[{draft_id:'200',version:1,draft:JSON.stringify(draft)}]}};
  const prior={id:'restored',schema:3,canvasId:'100',canvasUrl:'https://jimeng.jianying.com/ai-tool/canvas/100',saveMode:'folder',
    updatedAt:'2026-10-12T13:08:43Z',resources:mergeResources(analyzeSnapshot(snapshot,project,'100'))};
  Object.assign(prior.resources[0],{status:'done',name:'existing.png',bytes:png.size,sha256:'verified'});
  const dir={name:'original-folder',queryPermission:async()=> 'granted',isSameEntry:async()=>true,
    getFileHandle:async()=>({createWritable:async()=>({write:async()=>{},close:async()=>{},abort:async()=>{}})})};
  const f=panelFixture({tasks:[prior],dir,info:{ext:'png',width:1,height:1,bytes:png.size,sha256:'verified'},
    readPage:m=>m.request.operation==='SCAN'?{ok:true,snapshot,project}:
      {ok:true,url:signed,itemId:m.request.itemId,recordId:'42',width:1,height:1,origin:'fixture',diagnostic:{historyIdConfirmed:true}}});
  f.api.setTask(null);await f.api.verifyGeneratedBatch();
  const task=f.api.state().task;assert.equal(task.id,'restored');assert.equal(task.saveMode,'folder');
  assert.equal(task.resources[0].name,'existing.png');assert.equal(task.resources.filter(r=>r.status==='done').length,3);
  assert.equal(f.calls.filter(m=>m.type==='READ_PAGE'&&m.request.operation==='GENERATED').length,2);
  assert.ok(!f.calls.some(m=>m.type==='READ_PAGE'&&m.request.itemId==='123'));
});
