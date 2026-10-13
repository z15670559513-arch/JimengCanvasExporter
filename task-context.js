// Keep task identity and directory selection independent of transient UI state.
export function latestTask(tasks,canvasId,saveMode) {
  return tasks.filter(t=>t.schema===3&&t.canvasId===canvasId&&(!saveMode||t.saveMode===saveMode))
    .sort((a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')))[0]||null;
}
export function restoreTask(value) {
  const task=structuredClone(value);
  let interrupted=task.status==='running';
  for(const r of task.resources||[])if(r.status==='working'){r.status='pending';interrupted=true;}
  if(interrupted)task.status='recovery';
  // A writing plan must survive until file/download audit proves its outcome.
  return task;
}
export async function taskDirectory(prior,base,getHandle,subfolders=true,canvasId) {
  if(prior?.saveMode==='folder') {
    const stored=await getHandle(prior.id);
    if(stored)return stored;
    if((prior.resources||[]).some(r=>['done','writing'].includes(r.status)))
      throw new Error('旧任务的目录授权句柄不可用，请恢复原目录；未改变已完成记录');
    if(!base)return null;
    return prior.directoryMode==='subfolder'?base.getDirectoryHandle('画板_'+prior.canvasId,{create:true}):base;
  }
  if(!base)return null;
  return subfolders?base.getDirectoryHandle('画板_'+canvasId,{create:true}):base;
}
