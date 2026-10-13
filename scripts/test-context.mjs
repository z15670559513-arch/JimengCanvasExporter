import test from 'node:test';
import assert from 'node:assert/strict';
import {canvasFixture} from './fixtures.mjs';
import {analyzeSnapshot} from '../snapshot.js';
import {mergeResources,archiveRemoved,taskState} from '../incremental.js';
import {latestTask,restoreTask,taskDirectory} from '../task-context.js';

test('不同画板引用相同资源，也不复用对方完成记录',()=>{
  const a=canvasFixture(2,'100',{uploads:2}),b=canvasFixture(2,'101',{uploads:2});
  const analysisA=analyzeSnapshot(a.snapshot,a.project,'100'),analysisB=analyzeSnapshot(b.snapshot,b.project,'101');
  const previous={canvasId:'100',resources:mergeResources(analysisA)};previous.resources[0].status='done';
  assert.equal(previous.resources[0].resourceKey,analysisB.resources[0].resourceKey);
  assert.equal(mergeResources(analysisB,previous)[0].status,'pending');
  assert.equal(latestTask([{...previous,schema:3,saveMode:'folder'}],'101'),null);
});
test('新增图片插入前面时使用新编号，不撞号、不重命名旧完成文件',()=>{
  const f=canvasFixture(3,'100',{uploads:3}),analysis=analyzeSnapshot(f.snapshot,f.project,'100');
  const previous={canvasId:'100',resources:mergeResources(analysis)};
  Object.assign(previous.resources[1],{status:'done',name:'old_0002.png',sha256:'proof'});
  f.draft.layers.unshift({id:'new',type:'image',resourceId:'new-upload',resourceSource:'userUpload'});
  f.snapshot.data.snapshots[0].draft=JSON.stringify(f.draft);
  const next=mergeResources(analyzeSnapshot(f.snapshot,f.project,'100'),previous);
  assert.equal(next[0].index,4);assert.equal(next[2].index,2);assert.equal(next[2].name,'old_0002.png');
  assert.equal(next[2].status,'done');assert.equal(new Set(next.map(r=>r.index)).size,4);
});
test('当前快照删除的资源只归档记录；恢复出现仍保留文件和校验结果',()=>{
  const f=canvasFixture(2,'100',{uploads:2}),analysis=analyzeSnapshot(f.snapshot,f.project,'100');
  const previous={canvasId:'100',resources:mergeResources(analysis)};
  Object.assign(previous.resources[0],{status:'done',name:'keep.png',sha256:'proof'});
  const reduced={...analysis,resources:analysis.resources.slice(1)};
  const archive=archiveRemoved(reduced,previous);assert.equal(archive[0].name,'keep.png');
  assert.equal(archive[0].sha256,'proof');assert.equal(archiveRemoved({...analysis,canvasId:'101'},previous).length,0);
  const restored=mergeResources(analysis,{canvasId:'100',resources:mergeResources(reduced,previous),archivedResources:archive});
  assert.equal(restored[0].status,'done');assert.equal(restored[0].name,'keep.png');assert.equal(restored[0].index,1);
});
test('重复节点引用同一原图只排一个资源，跨画板统计互不混入',()=>{
  const f=canvasFixture(2,'100',{uploads:2});f.draft.layers[1].resourceId=f.draft.layers[0].resourceId;
  f.snapshot.data.snapshots[0].draft=JSON.stringify(f.draft);
  const analysis=analyzeSnapshot(f.snapshot,f.project,'100');
  assert.equal(analysis.imageNodeCount,2);assert.equal(analysis.uniqueResourceCount,1);assert.equal(analysis.resources[0].nodeIds.length,2);
});
test('纯上传画板没有 aiGeneratorReference 不导致误阻断',()=>{
  const f=canvasFixture(2,'100',{uploads:2});delete f.draft.aiGeneratorReference;f.snapshot.data.snapshots[0].draft=JSON.stringify(f.draft);
  const analysis=analyzeSnapshot(f.snapshot,f.project,'100');assert.ok(!analysis.warnings.some(w=>w.includes('缺少有效')));
  assert.equal(analysis.imageNodeCount,2);
});
test('新任务独立子目录；旧任务采用已存句柄，无目录移动或重建',async()=>{
  const calls=[],base={getDirectoryHandle:async name=>{calls.push(name);return{name};}},old={name:'legacy'};
  assert.equal((await taskDirectory(null,base,async()=>null,true,'100')).name,'画板_100');
  assert.equal((await taskDirectory(null,base,async()=>null,true,'101')).name,'画板_101');
  const prior={id:'old',canvasId:'100',saveMode:'folder',resources:[{status:'done'}]};
  assert.equal(await taskDirectory(prior,base,async()=>old,true,'100'),old);assert.equal(calls.length,2);
  await assert.rejects(taskDirectory(prior,base,async()=>null,true,'100'),/旧任务/);
});
test('历史选择按画板、保存方式和最近更新；恢复不启动网络或改掉完成结果',()=>{
  const a={id:'a',schema:3,canvasId:'100',saveMode:'folder',updatedAt:'2026-01-01'},b={...a,id:'b',updatedAt:'2026-02-01'},other={...b,id:'other',canvasId:'101'};
  assert.equal(latestTask([a,b,other],'100').id,'b');assert.equal(latestTask([a,b],'100','chrome'),null);
  const original={...b,status:'running',resources:[{status:'done',sha256:'hash'},{status:'working'},{status:'writing',name:'plan.png'}]};
  const restored=restoreTask(original);assert.equal(restored.status,'recovery');assert.equal(restored.resources[0].sha256,'hash');
  assert.equal(restored.resources[1].status,'pending');assert.equal(restored.resources[2].name,'plan.png');assert.equal(original.resources[1].status,'working');
});
test('完成状态仅来自全部资源完成，暂停/失败/扫描/恢复都有独立状态',()=>{
  assert.equal(taskState(null),'waiting');assert.equal(taskState(null,{scanning:true}),'scanning');
  assert.equal(taskState({resources:[{status:'done'}],status:'paused'}),'completed');
  assert.equal(taskState({resources:[{status:'pending'}],status:'paused'}),'paused');
  assert.equal(taskState({resources:[{status:'failed'}]}),'partial');
  assert.equal(taskState({resources:[{status:'writing'}]}),'recovery');
  assert.equal(taskState({resources:[{status:'pending'}],status:'cancelled'}),'cancelled');
  assert.equal(taskState({resources:[{status:'pending'}]},{running:true}),'downloading');
});
