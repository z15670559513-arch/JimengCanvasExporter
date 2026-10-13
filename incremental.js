export function mergeResources(analysis,previous={}) {
  previous ||= {};
  if(previous.canvasId&&previous.canvasId!==analysis.canvasId)previous={};
  const old=new Map([...(previous.archivedResources||[]),...(previous.resources||[])].map(r=>[r.resourceKey,r]));
  let nextIndex=Math.max(0,...[...(previous.resources||[]),...(previous.archivedResources||[])].map(r=>Number.isSafeInteger(r.index)?r.index:0));
  return analysis.resources.map((resource,index)=>{
    const prior=old.get(resource.resourceKey);
    return{...prior,canvasId:analysis.canvasId,resourceKey:resource.resourceKey,nodeId:resource.nodeIds[0],
      nodeIds:resource.nodeIds,resourceId:resource.resourceId,resourceSource:resource.resourceSource,
      recordId:resource.recordId,itemId:resource.itemId,index:prior?.index??++nextIndex,
      status:prior?.status==='working'?'pending':prior?.status||'pending',error:prior?.error||null,
      resolution:resource.candidates?.length?'candidate':prior?.resolution||'unknown'};
  });
}
export function archiveRemoved(analysis,previous={}) {
  if(previous.canvasId&&previous.canvasId!==analysis.canvasId)return[];
  const current=new Set(analysis.resources.map(r=>r.resourceKey));
  return [...new Map([...(previous.archivedResources||[]),...(previous.resources||[])]
    .filter(r=>!current.has(r.resourceKey)).map(r=>[r.resourceKey,r])).values()];
}
export function taskState(task,{running=false,scanning=false,connected=true}={}) {
  if(scanning)return'scanning';
  if(running)return'downloading';
  if(!task)return'waiting';
  const resources=task.resources||[];
  if(resources.length&&resources.every(r=>r.status==='done'))return'completed';
  if(task.status==='cancelled')return'cancelled';
  if(task.status==='paused')return'paused';
  if(!connected||resources.some(r=>['working','writing'].includes(r.status))||task.status==='running')return'recovery';
  if(resources.some(r=>['failed','unresolved'].includes(r.status)))return'partial';
  return task.status==='paused'?'paused':'ready';
}
export const stateLabels={waiting:'等待扫描',scanning:'正在扫描',ready:'待下载',downloading:'正在下载',paused:'已暂停',recovery:'等待恢复',completed:'全部完成',partial:'部分未完成',cancelled:'已取消'};
export function pendingResources(task,retry=false) {
  return task.resources.filter(r=>retry?['failed','unresolved'].includes(r.status):r.status!=='done'&&r.status!=='skipped');
}
export function safeError(error) {
  return String(error?.message||'操作失败').replace(/https?:\/\/[^\s"'<>]+/gi,'[资源地址已隐藏]').slice(0,260);
}
export async function runBatches(resources,options,work,signal,onBatch=async()=>{}) {
  const size=Number(options.batchSize),concurrency=Number(options.concurrency),interval=Number(options.interval);
  if(![50,100,200].includes(size) || !Number.isInteger(concurrency) || concurrency<1 || concurrency>3 ||
    !Number.isFinite(interval) || interval<300 || interval>10000) throw new Error('调度参数超出允许范围');
  const wait=ms=>new Promise((resolve,reject)=>{
    if(signal.aborted) return reject(signal.reason);
    const abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(signal.reason);};
    const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},ms);
    signal.addEventListener('abort',abort,{once:true});
  });
  let nextStart=0,total=0;
  for(let offset=0;offset<resources.length && !signal.aborted;offset+=size) {
    const batch=resources.slice(offset,offset+size);let index=0;
    const results=await Promise.allSettled(Array.from({length:Math.min(concurrency,batch.length)},async()=>{
      while(!signal.aborted && index<batch.length) {
        const resource=batch[index++];
        const delay=Math.max(0,nextStart-Date.now());nextStart=Math.max(Date.now(),nextStart)+interval;
        if(delay) await wait(delay);
        if(signal.aborted) break;
        await work(resource);total++;
      }
    }));
    const failed=results.find(r=>r.status==='rejected');
    if(failed) throw failed.reason;
    await onBatch(total);
    if(offset+size<resources.length) await wait(2000);
  }
  return total;
}
