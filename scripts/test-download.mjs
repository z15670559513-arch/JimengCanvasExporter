import test from 'node:test';
import assert from 'node:assert/strict';
import {waitChromeDownload,fetchOriginal,saveChromeDownload} from '../download.js';
import {pngBytes} from './fixtures.mjs';
import {webcrypto} from 'node:crypto';
globalThis.crypto ??=webcrypto;
globalThis.createImageBitmap=async()=>({width:1,height:1,close(){}});
function fixture() {
  const listeners=new Set(),items=new Map(),calls=[];
  globalThis.chrome={downloads:{onChanged:{addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn)},search:async({id})=>{calls.push(id);return items.has(id)?[items.get(id)]:[];}}};
  return{listeners,items,calls,fire:delta=>{for(const fn of listeners)fn(delta);}};
}
test('下载监听初始查询已完成项，结束移除监听器',async()=>{
  const f=fixture();f.items.set(1,{state:'complete'});
  assert.equal((await waitChromeDownload(1)).state,'complete');assert.equal(f.listeners.size,0);assert.equal(f.calls.length,1);
});
test('并发下载准确匹配 ID，别的文件事件不误判完成',async()=>{
  const f=fixture();for(const id of [1,2])f.items.set(id,{state:'in_progress'});
  const first=waitChromeDownload(1),second=waitChromeDownload(2);
  await new Promise(resolve=>setTimeout(resolve,5));f.fire({id:999,state:{current:'complete'}});
  f.items.set(1,{state:'complete'});f.fire({id:1,state:{current:'complete'}});
  assert.equal((await first).state,'complete');assert.equal(f.listeners.size,1);
  f.items.set(2,{state:'interrupted',error:'NETWORK_FAILED'});f.fire({id:2,state:{current:'interrupted'}});
  assert.equal((await second).error,'NETWORK_FAILED');assert.equal(f.listeners.size,0);
});
test('漏事件的兜底查询与恢复超时仍工作，不重新创建下载',async()=>{
  const f=fixture();f.items.set(1,{state:'in_progress'});
  const pending=waitChromeDownload(1,undefined,{fallbackMs:10});
  setTimeout(()=>f.items.set(1,{state:'complete'}),15);
  assert.equal((await pending).state,'complete');assert.equal(f.listeners.size,0);
  f.items.set(1,{state:'in_progress'});
  await assert.rejects(waitChromeDownload(1,undefined,{fallbackMs:5,timeoutMs:15,restoring:true}),e=>e.code==='ACTIVE_DOWNLOAD');
  assert.equal(f.listeners.size,0);
});
test('用户暂停立即停止监听，不靠 completed 事件独自计成功',async()=>{
  const f=fixture(),controller=new AbortController();f.items.set(1,{state:'in_progress'});
  const pending=waitChromeDownload(1,controller.signal);controller.abort(new Error('用户暂停'));
  await assert.rejects(pending,/用户暂停/);assert.equal(f.listeners.size,0);
});
test('事件完成后仍查询实际大小，错误时取消、不删除文件',async()=>{
  const f=fixture();let cancelled=0;
  chrome.downloads.download=async()=>{f.items.set(1,{state:'complete',exists:true,fileSize:1,filename:'bad.png'});return 1;};
  chrome.downloads.cancel=async()=>{cancelled++;};
  await assert.rejects(saveChromeDownload(new Blob([pngBytes],{type:'image/png'}),'test',async()=>{},new AbortController().signal),/大小/);
  assert.equal(cancelled,1);assert.equal(f.listeners.size,0);
});
test('实时进度来自实际接收字节和耗时，不包含资源地址',async()=>{
  const native=globalThis.fetch,seen=[];
  try{globalThis.fetch=async()=>new Response(pngBytes,{headers:{'content-type':'image/png','content-length':String(pngBytes.length)}});
    const blob=await fetchOriginal('https://p11-dreamina-sign.byteimg.com/synthetic.png',undefined,{onProgress:p=>seen.push(p)});
    assert.equal(blob.size,pngBytes.length);assert.equal(seen.at(-1).receivedBytes,pngBytes.length);assert.equal(seen.at(-1).totalBytes,pngBytes.length);
    assert.ok(!JSON.stringify(seen).includes('https://'));
  }finally{globalThis.fetch=native;}
});
