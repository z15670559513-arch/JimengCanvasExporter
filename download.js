import {inspect} from './files.js';
import {withTimeout} from './async.js';
export function originalURL(value) {
  try {const u=new URL(value);return u.protocol==='https:' && !u.username && !u.password &&
    /^[a-z0-9-]+-dreamina-sign\.byteimg\.com$/i.test(u.hostname) &&
    // The proven official PNG uses aigc_resize:0:0. Accept the native zero-size
    // marker, not arbitrary resized versions; preserve the signed URL verbatim.
    !/(?:aigc_)?resize(?!:0:0(?:[.~/]|$))|thumbnail/i.test(u.pathname)?value:null;} catch{return null;}
}
export function delay(ms,signal) {
  return new Promise((resolve,reject)=>{
    if(signal?.aborted) return reject(signal.reason);
    const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(signal.reason);};
    const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);
    signal?.addEventListener('abort',abort,{once:true});
  });
}
export const fetchOriginal=(value,signal,options)=>fetchImage(value,signal,originalURL,options);
async function fetchImage(value,signal,acceptURL,{timeoutMs=120000,onProgress}={}) {
  if(!acceptURL(value)) throw Object.assign(new Error('拒绝未授权资源候选地址'),{code:'INVALID_RESOURCE'});
  if(!Number.isFinite(timeoutMs)||timeoutMs<=0||timeoutMs>120000)throw new Error('图片超时参数无效');
  const controller=new AbortController();
  const abort=()=>controller.abort(signal.reason);signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted) abort();
  const diagnostic={stage:'response',hostname:new URL(value).hostname,httpStatus:null,receivedBytes:0,declaredBytes:null};
  const timeout=Object.assign(new Error('图片请求超过 '+timeoutMs/1000+' 秒'),{code:'IMAGE_TIMEOUT',diagnostic});
  const timer=setTimeout(()=>controller.abort(timeout),timeoutMs);
  const startedAt=Date.now();let lastProgress=0;
  const progress=force=>{
    const now=Date.now();if(!force&&now-lastProgress<200)return;lastProgress=now;
    const elapsedMs=now-startedAt;
    try{onProgress?.({receivedBytes:diagnostic.receivedBytes,totalBytes:diagnostic.declaredBytes,elapsedMs,
      bytesPerSecond:elapsedMs>0?diagnostic.receivedBytes*1000/elapsedMs:null});}catch{}
  };
  let reader;
  try {
    const response=await fetch(value,{credentials:'omit',signal:controller.signal,referrerPolicy:'no-referrer'});
    diagnostic.httpStatus=response.status;
    if(!response.ok) throw Object.assign(new Error('图片 HTTP '+response.status),{code:'IMAGE_HTTP_'+response.status});
    if(response.url && !acceptURL(response.url)) throw new Error('图片跳转到非授权资源域名，拒绝保存');
    const mime=(response.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
    if(!['image/png','image/jpeg','image/webp'].includes(mime)) throw new Error('资源不是支持的原生 PNG/JPEG/WebP 文件');
    const length=Number(response.headers.get('content-length'));
    diagnostic.declaredBytes=length>0?length:null;diagnostic.stage='body';
    progress(true);
    if(length>128*1024*1024) throw new Error('文件超过 128 MiB，未继续读取');
    reader=response.body?.getReader();if(!reader) throw new Error('资源没有文件数据');
    const chunks=[];let bytes=0;
    while(true) {
      const part=await reader.read();if(part.done)break;
      bytes+=part.value.byteLength;
      diagnostic.receivedBytes=bytes;
      progress(false);
      if(bytes>128*1024*1024) throw new Error('文件超过 128 MiB，已中止读取');
      chunks.push(part.value);
    }
    if(controller.signal.aborted)throw controller.signal.reason;
    if(length>0&&!response.headers.get('content-encoding')&&bytes!==length)
      throw Object.assign(new Error('图片数据长度不完整，未保存'),{code:'IMAGE_INCOMPLETE',diagnostic});
    progress(true);
    return new Blob(chunks,{type:mime});
  } catch(e) {
    if(signal?.aborted)throw signal.reason;
    if(controller.signal.aborted)throw controller.signal.reason;
    throw e;
  } finally {
    if(reader) await reader.cancel().catch(()=>{});
    controller.abort();clearTimeout(timer);signal?.removeEventListener('abort',abort);
  }
}
export async function waitChromeDownload(downloadId,signal,{timeoutMs=120000,fallbackMs=5000,restoring=false}={}) {
  const events=chrome.downloads.onChanged;let revision=0,wake;
  const listener=delta=>{if(delta.id===downloadId&&(delta.state||delta.error||delta.exists||delta.fileSize)){revision++;wake?.();}};
  events?.addListener(listener);const deadline=Date.now()+timeoutMs;
  try {
    while(Date.now()<deadline) {
      if(signal?.aborted)throw signal.reason;
      const before=revision;
      const [item]=await withTimeout(chrome.downloads.search({id:downloadId}),8000,'核对 Chrome 下载状态',signal);
      if(item?.state!=='in_progress')return item;
      if(revision!==before)continue;
      await new Promise((resolve,reject)=>{
        const finish=(fn,value)=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);wake=null;fn(value);};
        const abort=()=>finish(reject,signal.reason);
        const timer=setTimeout(()=>finish(resolve),Math.min(events?fallbackMs:350,Math.max(1,deadline-Date.now())));
        wake=()=>finish(resolve);signal?.addEventListener('abort',abort,{once:true});
        if(signal?.aborted)abort();else if(revision!==before)wake();
      });
    }
    throw Object.assign(new Error(restoring?'旧下载仍进行中，请稍后继续；未重复创建下载':'Chrome 下载未在时限内完成'),{code:restoring?'ACTIVE_DOWNLOAD':'DOWNLOAD_TIMEOUT'});
  } finally{events?.removeListener(listener);}
}
export async function saveChromeDownload(blob,base,onPlan,signal) {
  const info=await inspect(blob),url=URL.createObjectURL(blob);let downloadId;
  try {
    if(signal.aborted)throw signal.reason;
    downloadId=await chrome.downloads.download({url,filename:base+'.'+info.ext,conflictAction:'uniquify',saveAs:false});
    await onPlan({downloadId,...info,proof:'chrome-completion'});
    const item=await waitChromeDownload(downloadId,signal);
    if(!item)throw new Error('Chrome 下载记录丢失');
    if(item.state==='interrupted')throw new Error('Chrome 下载中断：'+item.error);
    if(item.state!=='complete'||item.exists===false||item.fileSize!==info.bytes)throw new Error('Chrome 完成状态与文件大小不一致');
    return{...info,downloadId,name:item.filename.split(/[\\/]/).pop(),filename:item.filename,proof:'chrome-completion'};
  } catch(error) {
    if(downloadId!=null)await chrome.downloads.cancel(downloadId).catch(()=>{});
    throw error;
  } finally {URL.revokeObjectURL(url);}
}
export async function verifyChrome(record,signal) {
  const item=await waitChromeDownload(record.downloadId,signal,{restoring:true});
  if(!item || item.state!=='complete' || item.exists===false || item.fileSize!==record.bytes)throw new Error('旧下载未完成、已丢失或大小不一致');
  return{...record,name:item.filename.split(/[\\/]/).pop(),filename:item.filename};
}
