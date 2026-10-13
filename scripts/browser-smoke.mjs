// Isolated Chrome profile and synthetic responses only. No existing login is used.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {runtimeFiles,auditRelease} from './release-audit.mjs';
import {canvasFixture,pngBytes} from './fixtures.mjs';
const require=createRequire(process.env.JCE_MODULE_ROOT?path.join(process.env.JCE_MODULE_ROOT,'package.json'):import.meta.url);
const {chromium}=require('playwright');
const project=path.resolve(process.argv[2]||'.'),output=path.resolve(process.argv[3]||'backups/browser-test');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'jimeng-release-test-')),stage=path.join(temporary,'extension'),profile=path.join(temporary,'profile');
fs.mkdirSync(stage);fs.mkdirSync(output,{recursive:true});
for(const file of runtimeFiles)fs.copyFileSync(path.join(project,file),path.join(stage,file));
auditRelease(stage);
const boards=new Map([['100',canvasFixture(3,'100',{uploads:3})],['101',canvasFixture(3,'101',{uploads:0})],['102',canvasFixture(4,'102',{uploads:2})]]);
for(const [id,f] of boards){f.project.data.project.draft.draft_id='200'+id;f.snapshot.data.snapshots[0].draft_id='200'+id;}
let context,extensionId,lastPanel;const errors=[],result={schema:1,synthetic:true,loggedInAccount:false,tests:[],metrics:{}};
const chromePath=process.env.JCE_CHROME_PATH||path.join(process.env.ProgramFiles||'','Google','Chrome','Application','chrome.exe');
const largePNG=process.env.JCE_LARGE_PNG?fs.readFileSync(process.env.JCE_LARGE_PNG):null;
async function launch() {
  context=await chromium.launchPersistentContext(profile,{executablePath:chromePath,headless:true,
    ignoreDefaultArgs:['--disable-extensions'],args:['--enable-unsafe-extension-debugging'],viewport:{width:400,height:1050}});
  const cdp=await context.browser().newBrowserCDPSession();
  // CDP loading is ephemeral; re-load the same path after restart, not a new ID.
  const loaded=await cdp.send('Extensions.loadUnpacked',{path:stage});
  if(extensionId)assert.equal(loaded.id,extensionId);extensionId=loaded.id;
  await cdp.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:path.join(temporary,'downloads'),eventsEnabled:true});
  result.chromeVersion=await context.browser().version();
  await context.route('https://**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.hostname.endsWith('-dreamina-sign.byteimg.com')){
      const bytes=largePNG&&url.pathname==='/large-synthetic.png'?largePNG:pngBytes;
      return route.fulfill({status:200,contentType:'image/png',body:bytes,headers:{'content-length':String(bytes.length)}});
    }
    if(url.hostname!=='jimeng.jianying.com')return route.abort();
    if(url.pathname.startsWith('/ai-tool/canvas/'))return route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><html><title>Synthetic canvas</title><body>Offline fixture</body></html>'});
    const body=route.request().postDataJSON()||{};let response;
    if(url.pathname.endsWith('/project_detail'))response=boards.get(body.project_id)?.project;
    else if(url.pathname.endsWith('/fetch_snapshot'))response=[...boards.values()].find(f=>f.project.data.project.draft.draft_id===body.draft_ids?.[0]?.draft_id)?.snapshot;
    else if(url.pathname.endsWith('/get_image_by_uri'))response={ret:'0',uri2image:Object.fromEntries(body.uris.map(uri=>[uri,{width:1,height:1,image_url:'https://p11-dreamina-sign.byteimg.com/'+uri+'.png'}]))};
    else if(url.pathname.endsWith('/get_history_by_ids')) {
      const recordId=body.history_ids[0],refs=[...boards.values()].flatMap(f=>Object.values(f.draft.aiGeneratorReference)).filter(ref=>ref.recordId===recordId);
      const ids=[...new Set(refs.map(ref=>ref.itemId))];
      response={ret:'0',data:{[recordId]:{history_record_id:recordId,item_list:ids.map(id=>({common_attr:{id},image:{large_images:[{width:1,height:1,image_url:'https://p11-dreamina-sign.byteimg.com/'+id+'~aigc_resize:0:0.png'}]}}))}}};
    }
    if(!response)return route.fulfill({status:404,body:'Fixture endpoint not supported'});
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(response)});
  });
}
async function panel() {
  const page=await context.newPage();lastPanel=page;page.on('pageerror',e=>errors.push(e.message));
  await page.goto('chrome-extension://'+extensionId+'/sidepanel.html');
  await page.waitForFunction(()=>document.getElementById('scan').disabled===false);
  return page;
}
async function records(page){return page.evaluate(async()=>{const store=await import(chrome.runtime.getURL('task-store.js'));return store.listTasks();});}
async function downloadBoard(page,id) {
  const expectedMode=await page.locator('#saveMode').inputValue();
  result.stage='scan-'+id;console.log('Browser check: '+result.stage);
  await page.locator('#canvasUrl').fill('https://jimeng.jianying.com/ai-tool/canvas/'+id);
  await page.locator('#scan').click();await page.waitForFunction(()=>!document.getElementById('scan').disabled);
  result.stage='download-'+id;console.log('Browser check: '+result.stage);
  await page.locator('#start').click();await page.waitForFunction(()=>!document.getElementById('scan').disabled,undefined,{timeout:45000});
  const selectedTaskId=await page.locator('#history').inputValue();
  const task=(await records(page)).find(t=>t.id===selectedTaskId);
  assert.ok(task,'The displayed history task must exist');assert.equal(task.canvasId,id);assert.equal(task.saveMode,expectedMode);
  assert.equal(task.status,'completed',await page.locator('#log').textContent());assert.equal(task.resources.length,boards.get(id).draft.layers.length);
  assert.ok(task.resources.every(r=>r.status==='done'));assert.equal(task.complete,true);
  return task;
}
try {
  await launch();let page=await panel();assert.equal((await records(page)).length,0);result.tests.push('empty-profile-install-and-ui');
  for(const id of boards.keys()){const canvas=await context.newPage();await canvas.goto('https://jimeng.jianying.com/ai-tool/canvas/'+id);}
  const a=await downloadBoard(page,'100'),b=await downloadBoard(page,'101'),c=await downloadBoard(page,'102');
  result.tests.push('uploaded-generated-mixed-boards','cross-board-resource-isolation');
  result.stage='automatic-board-switch';
  await page.evaluate(async()=>{const tabs=await chrome.tabs.query({url:'https://jimeng.jianying.com/ai-tool/canvas/100'});await chrome.tabs.update(tabs[0].id,{active:true});document.getElementById('useCurrent').click();});
  await page.waitForFunction(id=>document.getElementById('history').value===id,a.id);
  await page.evaluate(async()=>{const tabs=await chrome.tabs.query({url:'https://jimeng.jianying.com/ai-tool/canvas/101'});await chrome.tabs.update(tabs[0].id,{active:true});});
  await page.waitForFunction(id=>document.getElementById('history').value===id,b.id);
  const otherWindow=await page.evaluate(async()=>{const window=await chrome.windows.create({url:'https://jimeng.jianying.com/ai-tool/canvas/100',focused:true});return window.id;});
  await page.waitForTimeout(250);
  assert.equal(await page.locator('#history').inputValue(),b.id);
  await page.evaluate(id=>chrome.windows.remove(id),otherWindow);
  result.tests.push('native-tab-switch-and-other-window-isolation');
  for(const task of [a,b,c])for(const r of task.resources){assert.ok(path.resolve(r.filename).startsWith(path.join(temporary,'downloads')+path.sep));const bytes=fs.readFileSync(r.filename);assert.equal(createHash('sha256').update(bytes).digest('hex'),r.sha256);assert.deepEqual(bytes,pngBytes);}
  result.tests.push('native-png-and-disk-hash');
  const f=boards.get('100');f.draft.layers.unshift({id:'added',type:'image',resourceId:'synthetic-added',resourceSource:'userUpload'});f.snapshot.data.snapshots[0].draft=JSON.stringify(f.draft);
  const incremented=await downloadBoard(page,'100');assert.equal(incremented.resources[0].index,4);
  for(const old of a.resources)assert.equal(incremented.resources.find(r=>r.resourceKey===old.resourceKey).filename,old.filename);
  result.tests.push('incremental-addition-no-rename-no-redownload');
  const opfs=await page.evaluate(async()=>{
    const {saveImage,verifyImage,unusedName}=await import(chrome.runtime.getURL('files.js'));
    const root=await navigator.storage.getDirectory(),dir=await root.getDirectoryHandle('file-check',{create:true});
    const bytes=new Uint8Array(await (await fetch('https://p11-dreamina-sign.byteimg.com/synthetic.png')).arrayBuffer());
    const saved=await saveImage(dir,new Blob([bytes],{type:'image/png'}),'proof',async()=>{});await verifyImage(dir,saved);
    const {saveHandle,getHandle}=await import(chrome.runtime.getURL('task-store.js'));await saveHandle('synthetic-opfs',dir);
    const restored=await getHandle('synthetic-opfs');await verifyImage(restored,saved);
    for(let i=0;i<300;i++)await dir.getFileHandle('old_'+i+'.png',{create:true});
    const start=performance.now();for(let i=0;i<100;i++)await unusedName(dir,'new_'+i,'png');
    return{readbackHash:saved.sha256,filenameChecks:100,existingFiles:301,elapsedMs:performance.now()-start};
  });result.metrics.fileChecks=opfs;result.tests.push('actual-opfs-sha-handle-persistence-and-filename-checks');
  result.metrics.snapshotParsing=[];
  for(const count of [100,300,500]){
    const f=canvasFixture(count,'900',{uploads:Math.floor(count/5)});
    const timing=await page.evaluate(async({snapshot,project})=>{const {analyzeSnapshot}=await import(chrome.runtime.getURL('snapshot.js'));const start=performance.now();let value;
      for(let i=0;i<10;i++)value=analyzeSnapshot(snapshot,project,'900');return{nodes:value.imageNodeCount,averageMs:(performance.now()-start)/10};},f);
    result.metrics.snapshotParsing.push(timing);
  }
  if(largePNG)result.metrics.largePNG=await page.evaluate(async()=>{
    const {inspect,saveImage}=await import(chrome.runtime.getURL('files.js')),blob=await(await fetch('https://p11-dreamina-sign.byteimg.com/large-synthetic.png')).blob();
    const start=performance.now(),info=await inspect(blob),inspected=performance.now();
    const root=await navigator.storage.getDirectory(),dir=await root.getDirectoryHandle('large-image',{create:true});
    const saved=await saveImage(dir,blob,'large',async()=>{});if(info.sha256!==saved.sha256)throw new Error('Large PNG readback hash mismatch');
    return{width:info.width,height:info.height,bytes:info.bytes,inspectMs:inspected-start,saveReadbackMs:performance.now()-inspected};
  });
  result.metrics.chromeDownload=await page.evaluate(async()=>{
    const {saveChromeDownload}=await import(chrome.runtime.getURL('download.js')),blob=await(await fetch('https://p11-dreamina-sign.byteimg.com/large-synthetic.png')).blob();
    const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));const samples={oldPoll350:[],eventDriven:[]};
    for(let i=0;i<5;i++){
      const started=performance.now(),url=URL.createObjectURL(blob);
      try{const id=await chrome.downloads.download({url,filename:'bench/old_'+i+'.png',conflictAction:'uniquify',saveAs:false});
        const deadline=Date.now()+120000;
        while(true){const [item]=await chrome.downloads.search({id});if(!item||item.state==='interrupted'||Date.now()>deadline)throw new Error('Baseline save interrupted or timed out');if(item.state==='complete'){if(item.fileSize!==blob.size)throw new Error('Baseline size mismatch');break;}await delay(350);}
      }finally{URL.revokeObjectURL(url);}samples.oldPoll350.push(performance.now()-started);
    }
    for(let i=0;i<5;i++){const started=performance.now();await saveChromeDownload(blob,'bench/new_'+i,async()=>{},new AbortController().signal);samples.eventDriven.push(performance.now()-started);}
    return{...samples,bytesPerFile:blob.size,scope:'local Chrome blob saves, not CDN throughput'};
  });
  result.stage='authorized-folder-ui';
  // Test-only picker returns native origin-private storage. It is not a system permission-dialog test.
  await page.evaluate(()=>{window.showDirectoryPicker=()=>navigator.storage.getDirectory();});
  await page.locator('#chooseFolder').click();
  await page.waitForFunction(()=>document.getElementById('saveMode').value==='folder');
  const folderTask=await downloadBoard(page,'102');assert.equal(folderTask.saveMode,'folder');assert.equal(folderTask.directoryMode,'subfolder');
  const folderVerified=await page.evaluate(async id=>{
    const store=await import(chrome.runtime.getURL('task-store.js')),files=await import(chrome.runtime.getURL('files.js'));
    const task=(await store.listTasks()).find(t=>t.id===id),dir=await store.getHandle(id);
    for(const r of task.resources)await files.verifyImage(dir,r);return{directory:dir.name,count:task.resources.length};
  },folderTask.id);
  assert.equal(folderVerified.directory,'画板_102');assert.equal(folderVerified.count,4);
  result.tests.push('folder-ui-subdirectory-native-opfs-readback-sha-with-test-picker');
  const secondFolder=await downloadBoard(page,'101');
  await page.locator('details.options > summary').click();
  await page.locator('#history').selectOption(folderTask.id);
  await page.waitForFunction(()=>document.getElementById('folderName').textContent.includes('画板_102'));
  await page.locator('#history').selectOption(secondFolder.id);
  await page.waitForFunction(()=>document.getElementById('folderName').textContent.includes('画板_101'));
  assert.equal(await page.locator('#canvasUrl').inputValue(),'https://jimeng.jianying.com/ai-tool/canvas/101');
  result.tests.push('history-switch-restores-matching-directory');
  await page.screenshot({path:path.join(output,'sidebar-completed.png'),fullPage:true});
  result.stage='browser-restart';await context.close();context=null;await launch();page=await panel();
  const restored=await records(page);assert.equal(restored.length,5);assert.ok(restored.every(t=>t.resources.every(r=>r.status==='done')));
  const handleOK=await page.evaluate(async()=>{const store=await import(chrome.runtime.getURL('task-store.js'));const dir=await store.getHandle('synthetic-opfs');return!!(await dir.getFileHandle('proof.png'));});
  assert.equal(handleOK,true);result.tests.push('browser-restart-same-path-reload-history-and-directory-handle');
  assert.deepEqual(errors,[]);result.tests.push('no-extension-page-errors');result.state='passed';
} catch(e){
  result.state='failed';result.error=e.message;result.pageErrors=errors;process.exitCode=1;
  if(lastPanel&&!lastPanel.isClosed()){
    result.panelLog=await lastPanel.locator('#log').textContent().catch(()=>null);
    await lastPanel.screenshot({path:path.join(output,'sidebar-failure.png'),fullPage:true}).catch(()=>{});
  }
}
finally {
  if(context)await context.close();result.finishedAt=new Date().toISOString();
  fs.writeFileSync(path.join(output,'browser-smoke.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
  console.log('Test artifacts: '+output);
}
