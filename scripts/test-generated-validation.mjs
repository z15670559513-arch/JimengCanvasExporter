import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {readGeneratedPage as verifyGeneratedPage} from '../generated-resource.js';
import {officialReferences,compareOfficial,pngBytes} from './fixtures.mjs';
const recordId='42',itemId='900000000000000001';
const signed='https://p26-dreamina-sign.byteimg.com/native.png?x-signature=PRIVATE_SIGNATURE';
function fixture(body,status=200) {
  const calls=[],context={window:{},location:{href:'https://jimeng.jianying.com/ai-tool/canvas/100'},
    URL,AbortController,Map,setTimeout,clearTimeout,fetch:async(path,opts)=>{
      calls.push({path,opts,body:JSON.parse(opts.body)});
      return new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
    }};
  const fn=vm.runInNewContext('('+verifyGeneratedPage.toString()+')',context);
  return{calls,context,call:(extra={})=>fn({canvasId:'100',recordId,itemId,jobId:'one',...extra})};
}
const item=(id=itemId,url=signed)=>({common_attr:{id,cover_url:signed},image:{image_uri:'tos-cn-example/opaque',large_images:[{image_url:url,width:1687,height:2160}]}});
const response=items=>({ret:'0',data:{[recordId]:{item_list:items}}});
test('脱敏 PNG 对照保持真实字节哈希门槛，不依赖开发者文件',()=>{
  const ref=officialReferences[0],bytes=pngBytes;
  assert.equal(bytes.length,ref.bytes);assert.equal(bytes.readUInt32BE(16),ref.width);assert.equal(bytes.readUInt32BE(20),ref.height);
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),ref.sha256);
});
test('仅查询一条既有历史；精确匹配后证明本次 recordId→history_id 关联',async()=>{
  const f=fixture(response([item('900000000000000002',signed.replace('native','wrong')),item()]));
  const actual=await f.call();
  assert.equal(actual.ok,true);assert.equal(actual.url,signed);assert.equal(actual.itemId,itemId);
  assert.equal(actual.diagnostic.historyIdConfirmed,true);assert.equal(actual.diagnostic.targetMatchCount,1);
  assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].body,{history_ids:[recordId]});
  assert.equal(f.calls[0].path,'/mweb/v1/get_history_by_ids');assert.equal(f.calls[0].opts.credentials,'include');
  assert.deepEqual(Object.keys(f.calls[0].opts.headers),['Content-Type']);
  assert.ok(!JSON.stringify(actual.diagnostic).includes('PRIVATE_SIGNATURE'));
  assert.equal(f.context.window.__JCE_READ_JOBS__.size,0);
});
test('没有对应记录、错误历史 ID 或没有目标 item 时不得声称映射已证实',async()=>{
  for(const [body,code] of [
    [{ret:'0',data:{other:{item_list:[item()]}}},'HISTORY_NOT_FOUND'],
    [{ret:'0',data:{[recordId]:{history_id:'999',item_list:[item()]}}},'IDENTITY_MISMATCH'],
    [response([item('900000000000000002')]),'ITEM_ID_MISMATCH'],
    [{ret:'0',data:{[recordId]:{}}},'ITEM_LIST_MISSING']
  ]) {
    const result=await fixture(body).call();assert.equal(result.ok,false);assert.equal(result.code,code);
    assert.equal(result.diagnostic.historyIdConfirmed,false);assert.ok(!JSON.stringify(result).includes('PRIVATE_SIGNATURE'));
  }
});
test('拒绝大整数 Number、歧义 item、冲突 item_id 和外层伪 ID',async()=>{
  assert.equal((await fixture(response([item()])).call({itemId:Number(itemId)})).code,'INVALID_ID');
  for(const [items,code] of [
    [[item(),item()],'ITEM_ID_MISMATCH'],
    [[{...item(),item_id:'999'}],'IDENTITY_MISMATCH'],
    [[{...item('other'),id:itemId}],'ITEM_ID_MISMATCH'],
    [[item(Number(itemId))],'ITEM_ID_MISMATCH']
  ])assert.equal((await fixture(response(items)).call()).code,code);
});
test('带 resize 的候选原样返回但不宣称原图；cover_url 与其他域名不作候选',async()=>{
  for(const marker of ['aigc_resize:0:0.png','aigc_resize:360:360.webp']) {
    const candidate=signed.replace('native.png',marker);
    const result=await fixture(response([item(itemId,candidate)])).call();
    assert.equal(result.ok,true);assert.equal(result.url,candidate);assert.equal(result.diagnostic.historyIdConfirmed,true);
    assert.equal(result.diagnostic.originalConfirmed,false);assert.equal(result.diagnostic.largeImages[0].hasResizeMarker,true);
    assert.ok(!JSON.stringify(result.diagnostic).includes('PRIVATE_SIGNATURE'));
  }
  assert.equal((await fixture(response([item(itemId,'https://example.com/native.png')])).call()).code,'ORIGINAL_URL_MISSING');
  const target=item();target.image.large_images.unshift({image_url:'https://example.com/invalid.png'});
  assert.equal((await fixture(response([target])).call()).code,'ORIGINAL_URL_MISSING');
  const noLarge=item();delete noLarge.image.large_images;
  assert.equal((await fixture(response([noLarge])).call()).code,'ORIGINAL_URL_MISSING');
});
test('授权/限流/ret 拒绝保留失败原因；错误画板不发请求',async()=>{
  for(const status of [401,403,429])assert.equal((await fixture({},status).call()).code,'API_HTTP_'+status);
  assert.equal((await fixture({ret:'1020'}).call()).code,'API_REJECTED');
  const f=fixture(response([item()]));assert.equal((await f.call({canvasId:'other'})).code,'CANVAS_CHANGED');assert.equal(f.calls.length,0);
});
test('官方比对必须 PNG、尺寸、字节数、SHA 全相同；新节点无样本不能自动确认原图',()=>{
  const reference=officialReferences[0];assert.equal(compareOfficial(reference,reference).confirmed,true);
  for(const info of [{...reference,ext:'webp'},{...reference,width:2},{...reference,bytes:1},{...reference,sha256:'wrong'}])
    assert.equal(compareOfficial(info,reference).confirmed,false);
  assert.equal(compareOfficial(reference,null).confirmed,false);
});
