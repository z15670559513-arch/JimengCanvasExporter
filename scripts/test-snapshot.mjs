import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeSnapshot,investigationReport} from '../snapshot.js';
// Synthetic structural fixtures. They are NOT real site acceptance evidence.
function fixtures() {
  const draft={meta:{},aiGeneratorReference:{b:{recordId:'record',itemId:'item'},c:{recordId:'record',itemId:'item'}},layers:[
    {id:'a',type:'image',resourceId:'upload',resourceSource:'userUpload'},
    {id:'frame',type:'frame',children:[[{id:'b',type:'image',resourceSource:'aiGenerate'}]]},
    {id:'free',type:'free-layout-frame',children:[{id:'c',type:'image',resourceSource:'aiGenerate'}]},
    {id:'text',type:'text'}]};
  const original='https://p26-dreamina-sign.byteimg.com/asset.png?x-signature=DO_NOT_LOG&x-expires=123';
  return{draft,original,project:{ret:'0',data:{project:{id:'100',draft:{draft_id:'200',latest_version:525}},
    draft_resources:{images:{upload:{image_url:original}},historys:{record:{item_list:[{id:'item',image:{large_images:[{image_url:original}]}}]}}}}},
    snapshot:{ret:'0',data:{snapshots:[{draft_id:'200',version:525,draft:JSON.stringify(draft)}]}}};
}
test('画板 ID 与 draft ID 分开映射；二维/一维嵌套完整遍历；版本不是数量',()=>{
  const f=fixtures(),a=analyzeSnapshot(f.snapshot,f.project,'100');
  assert.equal(a.draftId,'200');assert.equal(a.version,525);assert.equal(a.layerCount,6);assert.equal(a.imageNodeCount,3);
  assert.equal(a.uniqueResourceCount,2);assert.equal(a.uniqueResourceIdCount,1);assert.equal(a.duplicateReferences,1);
  assert.equal(a.missingResourceIdCount,2);assert.equal(a.missingAiAssociationCount,0);assert.equal(a.complete,false);
  assert.equal(a.candidateResourceCount,2);assert.equal(a.resources[1].nodeIds.length,2);
});
test('跨画板、无 draft 映射、匹配快照缺失均拒绝，不硬编码或回退',()=>{
  const f=fixtures();assert.throws(()=>analyzeSnapshot(f.snapshot,f.project,'999'),/不匹配/);
  delete f.project.data.project.draft.draft_id;assert.throws(()=>analyzeSnapshot(f.snapshot,f.project,'100'),/映射/);
  f.project.data.project.draft.draft_id='333';assert.throws(()=>analyzeSnapshot(f.snapshot,f.project,'100'),/没有包含/);
});
test('历史快照不混入当前统计，同版本歧义拒绝',()=>{
  const f=fixtures();f.snapshot.data.snapshots.unshift({draft_id:'200',version:1,draft:JSON.stringify({layers:[]})});
  f.snapshot.data.snapshots.push({draft_id:'other',version:999,draft:JSON.stringify({layers:[]})});
  assert.equal(analyzeSnapshot(f.snapshot,f.project,'100').imageNodeCount,3);
  f.snapshot.data.snapshots.push(f.snapshot.data.snapshots[1]);assert.throws(()=>analyzeSnapshot(f.snapshot,f.project,'100'),/同版本/);
});
test('预览地址和其他域名不能成为原图候选；没有自行剥离参数',()=>{
  const f=fixtures();f.project.data.draft_resources.images.upload.image_url=f.original.replace('asset.png','a~tplv-tb4s082cfz-aigc_resize:360:360.webp');
  assert.equal(analyzeSnapshot(f.snapshot,f.project,'100').candidateResourceCount,1);
  f.project.data.draft_resources.images.upload.image_url='https://other.example/asset.png';
  assert.equal(analyzeSnapshot(f.snapshot,f.project,'100').resources[0].candidates.length,0);
});
test('报告不包含完整签名 URL、标题、布局或任意响应内容',()=>{
  const f=fixtures();f.draft.layers[0].title='PRIVATE_TITLE';f.snapshot.data.snapshots[0].draft=JSON.stringify(f.draft);
  const a=analyzeSnapshot(f.snapshot,f.project,'100');assert.equal(a.resources[0].candidates[0].url,f.original);
  const text=JSON.stringify(investigationReport(a));assert.ok(!text.includes('DO_NOT_LOG'));assert.ok(!text.includes('PRIVATE_TITLE'));
  assert.ok(!text.includes('x-signature'));assert.ok(text.includes('hasAccessParameters'));
});
test('未知嵌套结构及分页字段不能被默默视为完整',()=>{
  const f=fixtures();f.draft.layers.push({id:'unknown',type:'unknown',children:[]});
  f.snapshot.data.snapshots[0].draft=JSON.stringify(f.draft);f.snapshot.data.has_more=true;
  const a=analyzeSnapshot(f.snapshot,f.project,'100');assert.ok(a.warnings.some(w=>w.includes('尚未确认')));
  assert.equal(a.pagination.length,1);assert.equal(a.complete,false);
});
test('重复节点 ID、失败响应、损坏 draft 不制造成功',()=>{
  const f=fixtures();f.draft.layers.push({...f.draft.layers[0]});f.snapshot.data.snapshots[0].draft=JSON.stringify(f.draft);
  assert.throws(()=>analyzeSnapshot(f.snapshot,f.project,'100'),/重复节点/);
  f.snapshot.ret='1020';assert.throws(()=>analyzeSnapshot(f.snapshot,f.project,'100'),/未成功/);
});

test('损坏 draft 不把响应正文或其中敏感字符串写入错误',()=>{
  const f=fixtures();f.snapshot.data.snapshots[0].draft='{"token":"TEST_SECRET"';
  assert.throws(()=>analyzeSnapshot(f.snapshot,f.project,'100'),e=>/有效 JSON/.test(e.message)&&!e.message.includes('TEST_SECRET'));
});
