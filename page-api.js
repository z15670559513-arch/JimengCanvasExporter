// Runs in the page through chrome.scripting. Observed read-only endpoints only.
export async function readPage(request) {
  const current=/^https:\/\/jimeng\.jianying\.com\/ai-tool\/canvas\/(\d+)(?:[/?#]|$)/.exec(location.href)?.[1];
  if(!current || current!==request.canvasId) return{ok:false,error:'画板已切换，请重新扫描',code:'CANVAS_CHANGED'};
  const jobs=window.__JCE_READ_JOBS__ ||= new Map();
  if(request.operation==='CANCEL') {jobs.get(request.jobId)?.abort();return{ok:true};}
  if(!['SCAN','UPLOAD','GENERATED'].includes(request.operation)) return{ok:false,error:'不允许的资源操作',code:'INVALID_OPERATION'};
  const controller=new AbortController();jobs.set(request.jobId,controller);
  const timer=setTimeout(()=>controller.abort(),40000);
  const id=value=>typeof value==='string'?value:Number.isSafeInteger(value)?String(value):'';
  const url=value=>{
    try {const parsed=new URL(value);return parsed.protocol==='https:' && !parsed.username && !parsed.password &&
      /^[a-z0-9-]+-dreamina-sign\.byteimg\.com$/i.test(parsed.hostname) &&
      !/aigc_resize|thumbnail|resize:(?!0:0)/i.test(parsed.pathname)?value:null;} catch{return null;}
  };
  // Only current-canvas read responses are retained briefly in page memory.
  // No cookies/tokens or signed addresses are persisted in extension records.
  let cache=window.__JCE_RESOURCE_CACHE__;
  if(!cache || cache.canvasId!==current || Date.now()-cache.at>60000)
    cache=window.__JCE_RESOURCE_CACHE__={canvasId:current,at:Date.now(),images:{},histories:{},checkedHistory:{}};
  cache.checkedHistory ||= {};
  const own=(object,key)=>object && Object.hasOwn(object,key)?object[key]:null;
  const matchedItem=(record,itemId)=>{
    const items=record?.item_list ?? record?.itemList;
    return Array.isArray(items)?items.find(item=>id(item.common_attr?.id ?? item.commonAttr?.id ?? item.id ?? item.item_id)===itemId):null;
  };
  function fromItem(item,origin) {
    const images=item?.image?.large_images ?? item?.image?.largeImages;
    const image=Array.isArray(images)?images.find(image=>url(image.image_url ?? image.imageUrl)):null;
    const original=url(image?.image_url ?? image?.imageUrl);
    if(!original)return null;
    return{ok:true,url:original,origin,itemId:request.itemId,width:image.width,height:image.height,format:item.image.format};
  }
  function domOriginal() {
    if(typeof document==='undefined' || !Array.isArray(request.nodeIds))return null;
    for(const nodeId of request.nodeIds.slice(0,100)) {
      if(typeof nodeId!=='string' || !/^[\da-f-]{36}$/i.test(nodeId))continue;
      const img=document.getElementById(nodeId)?.querySelector('img');
      const value=img?.currentSrc||img?.src;
      // DOM fallback is deliberately narrow: explicit original marker only.
      if(url(value) && /resize:0:0(?:[.~/]|$)/i.test(new URL(value).pathname))
        return{ok:true,url:value,origin:'node-dom.explicit-original',nodeId,itemId:request.itemId,resourceId:request.resourceId};
    }
    return null;
  }
  async function post(path,body) {
    const response=await fetch(path,{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},
      body:JSON.stringify(body),signal:controller.signal});
    if(!response.ok) throw Object.assign(new Error('接口 HTTP '+response.status),{code:'API_HTTP_'+response.status});
    let data;try{data=await response.json();}catch{throw Object.assign(new Error('资源接口返回非 JSON 数据，未输出响应正文'),{code:'API_INVALID_RESPONSE'});}
    if(String(data.ret)!=='0') throw Object.assign(new Error('网站拒绝资源读取，ret='+String(data.ret).replace(/[^\d-]/g,'').slice(0,20)),{code:'API_REJECTED'});
    if(/^https:\/\/jimeng\.jianying\.com\/ai-tool\/canvas\/(\d+)/.exec(location.href)?.[1]!==current) throw new Error('画板已切换');
    return data;
  }
  try {
    if(request.operation==='SCAN') {
      let project;
      try {project=await post('/mweb/v1/infinite_canvas/project_detail',{project_id:current,option:{need_draft_resource:true}});}
      catch(e) {
        if(!['API_REJECTED','API_HTTP_400'].includes(e.code))throw e;
        // Resource packing is optional; preserve the working snapshot-only scan.
        project=await post('/mweb/v1/infinite_canvas/project_detail',{project_id:current,option:{need_draft_resource:false}});
      }
      if(id(project.data?.project?.id)!==current) throw new Error('项目身份不一致');
      const draftId=id(project.data?.project?.draft?.draft_id);
      if(!draftId) throw new Error('缺少项目与草稿映射');
      const snapshot=await post('/mweb/v1/infinite_canvas/v1/fetch_snapshot',{draft_ids:[{draft_id:draftId}]});
      cache.images=project.data.draft_resources?.images||{};
      cache.histories=project.data.draft_resources?.historys||{};
      cache.checkedHistory={};cache.at=Date.now();
      return{ok:true,project:{ret:'0',data:{project:project.data.project,draft_resources:project.data.draft_resources}},snapshot};
    }
    if(request.operation==='UPLOAD') {
      if(typeof request.resourceId!=='string' || !request.resourceId || request.resourceId.length>2048) throw new Error('无效上传资源 ID');
      if(request.refresh===true)delete cache.images[request.resourceId];
      const cached=own(cache.images,request.resourceId);
      const cachedURL=url(cached?.image_url ?? cached?.imageUrl);
      if(cachedURL)return{ok:true,url:cachedURL,origin:'project_detail.draft_resources.images',resourceId:request.resourceId,width:cached.width,height:cached.height};
      const data=await post('/mweb/v1/get_image_by_uri',{uris:[request.resourceId]});
      const image=Object.hasOwn(data.uri2image||{},request.resourceId)?data.uri2image[request.resourceId]:null;
      const original=url(image?.image_url);
      if(!original){const direct=domOriginal();if(direct)return direct;}
      if(!original) throw Object.assign(new Error('上传资源未返回有效原始地址；不拼接签名'),{code:'RESOURCE_UNRESOLVED'});
      return{ok:true,url:original,origin:'get_image_by_uri',resourceId:request.resourceId,width:image.width,height:image.height};
    }
    if(!/^\d+$/.test(request.itemId||'') || typeof request.itemId!=='string') throw new Error('无效生成图 itemId');
    const sources=[];
    if(request.recordId!=null && (typeof request.recordId!=='string' || !/^\d+$/.test(request.recordId)))throw new Error('无效生成记录 ID');
    if(request.recordId) {
      if(request.refresh===true){delete cache.histories[request.recordId];delete cache.checkedHistory[request.recordId];}
      const existing=fromItem(matchedItem(own(cache.histories,request.recordId),request.itemId),'project-or-history.large_images');
      if(existing)return existing;
      if(!own(cache.checkedHistory,request.recordId))try {
        // Observed canvas load flow: aiGeneratorReference.recordId -> history.
        const response=await post('/mweb/v1/get_history_by_ids',{history_ids:[request.recordId]});
        const record=own(response.data,request.recordId);
        if(record?.history_record_id!=null && id(record.history_record_id)!==request.recordId)
          throw Object.assign(new Error('历史记录身份不一致'),{code:'IDENTITY_MISMATCH'});
        if(record)cache.histories[request.recordId]=record;
        cache.checkedHistory[request.recordId]=true;
        const original=fromItem(matchedItem(record,request.itemId),'get_history_by_ids.large_images');
        if(original)return original;
        sources.push({source:'history',matched:!!matchedItem(record,request.itemId),hasRecord:!!record});
      } catch(e) {
        if(controller.signal.aborted || ['API_HTTP_401','API_HTTP_403','API_HTTP_429','IDENTITY_MISMATCH'].includes(e.code))throw e;
        cache.checkedHistory[request.recordId]=true;
        sources.push({source:'history',available:false,code:e.code||'API_UNAVAILABLE'});
      }
      else sources.push({source:'history',matched:!!matchedItem(own(cache.histories,request.recordId),request.itemId),previouslyChecked:true});
    }
    const direct=domOriginal();if(direct)return direct;
    // Optional compatibility source, disabled unless the user explicitly enables it.
    if(request.optionalDetails!==true)throw Object.assign(new Error('当前来源尚未解析出生成图原图；已跳过，继续其他资源'),
      {code:'RESOURCE_UNRESOLVED',diagnostic:{stage:'resource-sources',sources,optionalDetails:false}});
    // Default metadata scene: no paid watermark removal/benefit deduction request.
    let data;
    try {data=await post('/mweb/v1/get_local_item_list',{item_id_list:[request.itemId],
      pack_item_opt:{scene:0,need_data_integrity:true}});}
    catch(e) {
      if(controller.signal.aborted || ['API_HTTP_401','API_HTTP_403','API_HTTP_429'].includes(e.code))throw e;
      throw Object.assign(new Error('可选详情来源暂不可用；已跳过，继续其他资源'),
        {code:'RESOURCE_SOURCE_UNAVAILABLE',diagnostic:{stage:'optional-details',sources,sourceCode:e.code||'API_UNAVAILABLE'}});
    }
    const items=data.data?.item_list;
    // The raw endpoint uses common_attr.id. The website formatter promotes it
    // to item.id (473966 / 651792); raw responses are not formatted here.
    const item=Array.isArray(items)?items.find(item=>id(item.common_attr?.id ?? item.id ?? item.item_id)===request.itemId):null;
    if(!item) throw Object.assign(new Error('生成图详情未返回匹配的图片身份（返回 '+(Array.isArray(items)?items.length:0)+' 项）；未下载其他图片'),
      {code:'RESOURCE_ID_MISSING',diagnostic:{stage:'item-match',itemCount:Array.isArray(items)?items.length:0,
        hasCommonAttrId:Array.isArray(items)&&items.some(item=>item.common_attr?.id!=null),
        unsafeNumericId:Array.isArray(items)&&items.some(item=>typeof(item.common_attr?.id ?? item.id ?? item.item_id)==='number'&&!Number.isSafeInteger(item.common_attr?.id ?? item.id ?? item.item_id))}});
    const image=item?.image?.large_images?.[0];
    const original=url(image?.image_url);
    if(!original) throw Object.assign(new Error('已匹配生成图身份，但未返回可用原图地址；未使用预览或自造签名'),
      {code:'RESOURCE_UNRESOLVED',diagnostic:{stage:'original-url',itemCount:items.length,
        imageCount:Array.isArray(item.image?.large_images)?item.image.large_images.length:0,
        hasImageURL:typeof image?.image_url==='string',
        previewRejected:typeof image?.image_url==='string'&&/aigc_resize|thumbnail|resize:(?!0:0)/i.test(image.image_url)}});
    return{ok:true,url:original,origin:'get_local_item_list.large_images',itemId:request.itemId,
      width:image.width,height:image.height,format:item.image.format};
  } catch(error) {
    return{ok:false,error:controller.signal.aborted?'资源请求已暂停或超时':String(error.message).replace(/https?:\/\/[^\s]+/gi,'[地址已隐藏]').slice(0,200),
      code:controller.signal.aborted?'ABORTED':error.code||'API_UNAVAILABLE',diagnostic:error.diagnostic};
  } finally {clearTimeout(timer);jobs.delete(request.jobId);}
}
