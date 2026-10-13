// Self-contained: chrome.scripting serializes this function into the MAIN world.
// Query one existing history only. No creation, benefits, credential extraction,
// DOM fallback or signed-URL rewriting. Item matching is exact.
export async function readGeneratedPage(request) {
  const canvas=()=>/^https:\/\/jimeng\.jianying\.com\/ai-tool\/canvas\/(\d+)(?:[/?#]|$)/.exec(location.href)?.[1];
  const diagnostic={stage:'request',endpoint:'/mweb/v1/get_history_by_ids',historyIdConfirmed:false,itemMatched:false};
  const identifier=value=>typeof value==='string'?value:Number.isSafeInteger(value)?String(value):'';
  const fail=(message,code)=>{throw Object.assign(new Error(message),{code});};
  if(canvas()!==request.canvasId)return{ok:false,code:'CANVAS_CHANGED',error:'画板已切换',diagnostic};
  if(![request.recordId,request.itemId].every(v=>typeof v==='string'&&/^\d{1,40}$/.test(v)))
    return{ok:false,code:'INVALID_ID',error:'recordId/itemId 必须是无精度损失的字符串',diagnostic};
  const controller=new AbortController(),jobs=window.__JCE_READ_JOBS__ ||= new Map();
  jobs.set(request.jobId,controller);
  const timer=setTimeout(()=>controller.abort(),40000);
  try {
    const response=await fetch('/mweb/v1/get_history_by_ids',{method:'POST',credentials:'include',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({history_ids:[request.recordId]}),signal:controller.signal});
    diagnostic.httpStatus=response.status;
    if(!response.ok)fail('历史查询 HTTP '+response.status,'API_HTTP_'+response.status);
    let body;try{body=await response.json();}catch{fail('历史接口返回非 JSON 数据，未输出响应正文','API_INVALID_RESPONSE');}
    if(canvas()!==request.canvasId)fail('画板已切换','CANVAS_CHANGED');
    diagnostic.ret=String(body.ret).replace(/[^\d-]/g,'').slice(0,20);
    if(String(body.ret)!=='0')fail('历史查询被网站拒绝，ret='+diagnostic.ret,'API_REJECTED');
    diagnostic.stage='record-match';
    const data=body.data;
    const fields=value=>value&&typeof value==='object'?Object.keys(value).filter(k=>/^[A-Za-z_][A-Za-z0-9_]{0,80}$/.test(k)).slice(0,60):[];
    diagnostic.responseFields=fields(body);diagnostic.dataFields=fields(data);
    diagnostic.returnedRecordIds=data&&typeof data==='object'?Object.keys(data).filter(k=>/^\d{1,40}$/.test(k)).slice(0,20):[];
    const record=data&&Object.hasOwn(data,request.recordId)?data[request.recordId]:null;
    diagnostic.requestedRecordPresent=!!record;
    if(!record||typeof record!=='object')fail('响应 data 中没有以该 recordId 为键的历史记录；对应 history_id 尚未证实','HISTORY_NOT_FOUND');
    diagnostic.recordFields=fields(record);
    const explicit={};
    for(const field of ['history_record_id','history_id'])if(record[field]!=null) {
      explicit[field]=identifier(record[field]);
      if(explicit[field]!==request.recordId)fail('返回的历史记录身份与请求 recordId 不一致','IDENTITY_MISMATCH');
    }
    diagnostic.explicitRecordIds=explicit;
    diagnostic.stage='item-match';
    const items=record.item_list;
    diagnostic.hasItemList=Array.isArray(items);diagnostic.itemCount=Array.isArray(items)?items.length:0;
    if(!Array.isArray(items))fail('匹配记录没有 item_list；不能定位目标图片','ITEM_LIST_MISSING');
    diagnostic.items=items.slice(0,100).map(item=>({
      commonAttrId:identifier(item.common_attr?.id),itemId:identifier(item.item_id),
      unsafeNumericId:typeof item.common_attr?.id==='number'&&!Number.isSafeInteger(item.common_attr.id),
      hasImage:!!item.image,largeImageCount:Array.isArray(item.image?.large_images)?item.image.large_images.length:0,
      fields:fields(item),imageFields:fields(item.image),
      hasImageURI:typeof item.image?.image_uri==='string',hasCover:typeof item.common_attr?.cover_url==='string'}));
    // Website's raw-item identity is common_attr.id; do not substitute outer id.
    const matches=items.filter(item=>identifier(item.common_attr?.id)===request.itemId);
    diagnostic.targetMatchCount=matches.length;
    if(matches.length!==1)fail(matches.length?'目标 itemId 返回多项，拒绝歧义下载':'item_list 中没有精确匹配目标 common_attr.id 的图片','ITEM_ID_MISMATCH');
    const item=matches[0];
    if(item.item_id!=null&&identifier(item.item_id)!==request.itemId)fail('目标 item_id 与 common_attr.id 冲突','IDENTITY_MISMATCH');
    diagnostic.itemMatched=true;diagnostic.historyIdConfirmed=true;
    diagnostic.recordEvidence='响应 data[recordId] 存在，显式历史 ID 无冲突，且其 item_list 唯一匹配快照 itemId；仅证实本次记录';
    diagnostic.stage='image-url';
    const images=Array.isArray(item.image?.large_images)?item.image.large_images:[];
    diagnostic.declaredFormat=typeof item.image?.format==='string'&&/^[a-z0-9_-]{1,20}$/i.test(item.image.format)?item.image.format:null;
    diagnostic.largeImages=images.slice(0,20).map(image=>{
      let parsed;try{parsed=new URL(image.image_url);}catch{}
      const resize=parsed&&/(?:aigc_)?resize:(\d+):(\d+)/i.exec(parsed.pathname);
      return{hasURL:typeof image.image_url==='string',host:parsed&&/^[a-z0-9-]+-dreamina-sign\.byteimg\.com$/i.test(parsed.hostname)?parsed.hostname:null,
        fields:fields(image),hasImageURI:typeof image.image_uri==='string',
        hasResizeMarker:!!parsed&&/resize|thumbnail/i.test(parsed.pathname),
        resizeHint:resize?{width:Number(resize[1]),height:Number(resize[2])}:null,
        width:Number.isSafeInteger(image.width)?image.width:null,height:Number.isSafeInteger(image.height)?image.height:null};
    });
    const valid=images.map((image,index)=>({image,index})).filter(({image})=>{
      try{const u=new URL(image.image_url);return u.protocol==='https:'&&!u.username&&!u.password&&
        /^[a-z0-9-]+-dreamina-sign\.byteimg\.com$/i.test(u.hostname);}catch{return false;}
    });
    diagnostic.validLargeImageCount=valid.length;
    if(!valid.length)fail('目标图片没有授权 CDN 上的 large_images 候选；不使用 cover_url','ORIGINAL_URL_MISSING');
    // Native implementations select index 0. Do not guess a different variant.
    const selected=valid.find(v=>v.index===0);
    if(!selected)fail('large_images[0] 不是可接受的候选，未改用其他规格','ORIGINAL_URL_MISSING');
    diagnostic.selectedImageIndex=0;
    diagnostic.stage='candidate-found';
    diagnostic.originalConfirmed=false;
    diagnostic.originalGate='URL 原样读取；须以同节点官方 PNG 尺寸、字节数和 SHA-256 判定，不能依据路径或元数据宣称原图';
    // URI is an opaque resource identity, never a replacement for an original URL.
    const uri=item.image?.image_uri??selected.image.image_uri;
    if(typeof uri==='string'&&uri.length<2048&&!/https?:|signature|token|[?]/i.test(uri))diagnostic.imageURI=uri;
    return{ok:true,url:selected.image.image_url,itemId:request.itemId,recordId:request.recordId,
      width:Number.isSafeInteger(selected.image.width)?selected.image.width:null,
      height:Number.isSafeInteger(selected.image.height)?selected.image.height:null,
      origin:'get_history_by_ids.item_list.common_attr.id.large_images[0]',diagnostic};
  } catch(error) {
    return{ok:false,code:controller.signal.aborted?'ABORTED':error.code||'HISTORY_QUERY_FAILED',
      error:controller.signal.aborted?'历史查询已暂停或超过 40 秒':String(error.message).replace(/https?:\/\/\S+/gi,'[地址已隐藏]').slice(0,200),diagnostic};
  } finally{clearTimeout(timer);jobs.delete(request.jobId);}
}
