export function withTimeout(promise, milliseconds, label, signal) {
  return new Promise((resolve,reject)=>{
    let finished=false;
    const finish=(callback,value)=>{
      if(finished) return;
      finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);
      callback(value);
    };
    const abort=()=>finish(reject,signal.reason || new Error('任务已暂停'));
    const timer=setTimeout(()=>finish(reject,new Error(label+' 超时（'+Math.round(milliseconds/1000)+' 秒），任务已停止')),milliseconds);
    Promise.resolve(promise).then(value=>finish(resolve,value),error=>finish(reject,error));
    if(signal?.aborted) abort();else signal?.addEventListener('abort',abort,{once:true});
  });
}
