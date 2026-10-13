// Investigation parser: only response bodies, never headers, cookies or replayed requests.
const own=(value,key)=>value && typeof value==='object' && Object.hasOwn(value,key)?value[key]:undefined;
const identifier=value=>typeof value==='string'?value:(Number.isSafeInteger(value)?String(value):'');
const canvasPattern=/^https:\/\/jimeng\.jianying\.com\/ai-tool\/canvas\/(\d+)(?:[/?#]|$)/;
export function canvasIdentity(value) {
  const id=canvasPattern.exec(value||'')?.[1] || (/^\d+$/.test(value||'')?String(value):'');
  if(!id) throw new Error('需要有效的即梦画板链接或画板 ID');
  return id;
}
function dataOf(response,label) {
  if(!response || typeof response!=='object' || Array.isArray(response)) throw new Error(label+' 响应必须是 JSON 对象');
  if(response.ret!=null && String(response.ret)!=='0') throw new Error(label+' 响应未成功，ret='+String(response.ret));
  if(!response.data || typeof response.data!=='object') throw new Error(label+' 缺少 data');
  return response.data;
}
function parseDraft(value) {
  let draft;try{draft=typeof value==='string'?JSON.parse(value):value;}catch{throw new Error('draft 不是有效 JSON，未输出原始响应正文');}
  if(!draft || !Array.isArray(draft.layers)) throw new Error('draft.layers 不是数组，不能继续统计');
  return draft;
}
function imageURL(value) {
  if(typeof value!=='string') return null;
  try {
    const url=new URL(value);
    if(url.protocol!=='https:' || url.username || url.password || !/^[a-z0-9-]+-dreamina-sign\.byteimg\.com$/i.test(url.hostname)) return null;
    if(/aigc_resize|thumbnail|resize:(?!0:0)/i.test(url.pathname)) return null;
    return value; // Preserve the original string; URL is validation only.
  } catch {return null;}
}
export function analyzeSnapshot(snapshotResponse,projectResponse,canvas) {
  const canvasId=canvasIdentity(canvas);
  const projectData=dataOf(projectResponse,'project_detail');
  const project=projectData.project;
  if(identifier(project?.id)!==canvasId) throw new Error('project_detail 与输入画板不匹配；禁止使用其他画板资源');
  const projectDraft=project?.draft;
  const draftId=identifier(projectDraft?.draft_id ?? projectDraft?.draftId);
  if(!draftId) throw new Error('project.draft 未提供 draft_id 映射；不能用画板 ID 猜测');
  const snapshots=dataOf(snapshotResponse,'fetch_snapshot').snapshots;
  if(!Array.isArray(snapshots)) throw new Error('fetch_snapshot 缺少 snapshots 数组');
  const matching=snapshots.filter(s=>identifier(s.draft_id ?? s.draftId)===draftId);
  if(!matching.length) throw new Error('快照没有包含 project_detail 指向的 draft_id');
  for(const s of matching) if(s.version==null || !/^\d+$/.test(String(s.version)) || !Number.isSafeInteger(Number(s.version))) throw new Error('快照 version 无效');
  const latest=Math.max(...matching.map(s=>Number(s.version)));
  const chosen=matching.filter(s=>Number(s.version)===latest);
  if(chosen.length!==1) throw new Error('同一 draft_id 存在多个同版本快照，不能任意选择');
  const draft=parseDraft(chosen[0].draft);
  const warnings=[];
  const expectedVersion=Number(projectDraft.latest_version ?? projectDraft.latestVersion);
  if(Number.isFinite(expectedVersion) && latest<expectedVersion) warnings.push('快照早于项目声明的最新版本，不能视为当前完整画板');
  const reference=draft.aiGeneratorReference;
  const validReference=reference&&typeof reference==='object'&&!Array.isArray(reference);
  if(!draft.meta) warnings.push('缺少 meta，与网页当前快照解析器要求不一致');
  const nodes=[],layers=[],nodeIds=new Set();
  function visit(items,path,depth=0) {
    if(depth>64) throw new Error('图层嵌套深度异常');
    if(!Array.isArray(items)) {warnings.push(path+' 不是图层数组');return;}
    items.forEach((layer,index)=>{
      const location=path+'['+index+']';
      if(!layer || typeof layer!=='object' || Array.isArray(layer)) {warnings.push(location+' 不是有效图层');return;}
      const nodeId=identifier(layer.id);
      if(!nodeId) warnings.push(location+' 缺少节点 ID');
      if(nodeId && nodeIds.has(nodeId)) throw new Error('重复节点 ID，需核对嵌套结构：'+nodeId);
      if(nodeId) nodeIds.add(nodeId);
      layers.push({nodeId,type:layer.type,path:location});
      if(layer.type==='image') {
        const association=own(reference,nodeId);
        const recordId=identifier(association?.recordId);
        const itemId=identifier(association?.itemId);
        const resourceId=identifier(layer.resourceId);
        const source=typeof layer.resourceSource==='string'?layer.resourceSource:'unknown';
        // AI assets have an independent record/item identity, not necessarily resourceId.
        const resourceKey=source==='aiGenerate' && recordId && itemId?
          JSON.stringify(['aiGenerate',recordId,itemId]):resourceId?
          JSON.stringify([source,resourceId]):JSON.stringify(['unresolved-node',nodeId||location]);
        nodes.push({canvasId,nodeId,resourceId,resourceSource:source,resourceKey,recordId,itemId,
          title:typeof layer.title==='string'?layer.title:'',layout:layer.layout||null,path:location});
      }
      if(layer.type==='frame') {
        if(!Array.isArray(layer.children)) warnings.push(location+' frame 缺少二维 children');
        else layer.children.forEach((row,rowIndex)=>visit(row,location+'.children['+rowIndex+']',depth+1));
      } else if(layer.type==='free-layout-frame') visit(layer.children,location+'.children',depth+1);
      else if(layer.children!=null) warnings.push(location+' 存在尚未确认的 children 结构，未混入历史或未知对象');
    });
  }
  visit(draft.layers,'layers');
  if(!validReference&&nodes.some(n=>n.resourceSource==='aiGenerate'))warnings.push('缺少有效 aiGeneratorReference，生成图关联无法确认');
  const resources=new Map(),sourceCounts=Object.create(null);
  const rawResources=projectData.draft_resources || projectData.draftResources || {};
  for(const node of nodes) {
    sourceCounts[node.resourceSource]=(sourceCounts[node.resourceSource]||0)+1;
    let resource=resources.get(node.resourceKey);
    if(!resource) {
      resource={resourceKey:node.resourceKey,resourceId:node.resourceId,resourceSource:node.resourceSource,
        recordId:node.recordId,itemId:node.itemId,nodeIds:[],candidates:[],status:'unresolved'};
      resources.set(node.resourceKey,resource);
      const add=(url,origin)=>{const valid=imageURL(url);if(valid&&!resource.candidates.some(c=>c.url===valid))resource.candidates.push({url:valid,origin,verified:false});};
      if(node.resourceSource==='userUpload') {
        const image=own(rawResources.images,node.resourceId);
        add(image?.image_url ?? image?.imageUrl,'project_detail.draft_resources.images');
      } else if(node.resourceSource==='aiGenerate' && node.recordId && node.itemId) {
        const history=own(rawResources.historys,node.recordId);
        const itemList=history?.item_list ?? history?.itemList;
        const item=Array.isArray(itemList)?itemList.find(i=>identifier(i.common_attr?.id ?? i.commonAttr?.id ?? i.id ?? i.item_id)===node.itemId):null;
        const large=item?.image?.large_images ?? item?.image?.largeImages;
        if(Array.isArray(large)) for(const image of large) add(image.image_url ?? image.imageUrl,'project_detail.draft_resources.historys.item.image.large_images');
      }
      if(resource.candidates.length) resource.status='candidate-unverified';
    }
    resource.nodeIds.push(node.nodeId);
  }
  const pagination=[];
  for(const [label,value] of [['snapshot.data',snapshotResponse.data],['project.data',projectData]]) {
    for(const key of ['has_more','next_cursor','cursor','offset','total','total_count']) {
      if(Object.hasOwn(value,key)) pagination.push({path:label+'.'+key,value:value[key]});
    }
  }
  if(pagination.length) warnings.push('发现可能的分页/总数字段，需要结合实际请求验证语义');
  warnings.push('候选 URL 尚未经过 HTTP、Content-Type 和文件回读验证，不计下载成功');
  return {canvasId,draftId,version:latest,complete:false,
    integrity:'当前快照结构统计；服务端完整性、实际资源映射和下载尚待实测',
    snapshotsReceived:snapshots.length,matchingSnapshots:matching.length,topLevelLayers:draft.layers.length,
    layerCount:layers.length,imageNodeCount:nodes.length,uniqueResourceIdCount:new Set(nodes.map(n=>n.resourceId).filter(Boolean)).size,
    uniqueResourceCount:resources.size,duplicateReferences:nodes.length-resources.size,
    missingResourceIdCount:nodes.filter(n=>!n.resourceId).length,
    missingAiAssociationCount:nodes.filter(n=>n.resourceSource==='aiGenerate'&&(!n.recordId||!n.itemId)).length,
    resourceSourceCounts:sourceCounts,candidateResourceCount:[...resources.values()].filter(r=>r.candidates.length).length,
    pagination,warnings,nodes,resources:[...resources.values()]};
}
export function investigationReport(analysis) {
  // Output identity/statistics, never the complete signed URL or arbitrary raw response.
  const {nodes,resources,pagination,...summary}=analysis;
  return {...summary,pagination:pagination.map(p=>({path:p.path,present:true})),
    nodes:nodes.map(({canvasId,nodeId,resourceId,resourceSource,resourceKey,recordId,itemId,path})=>
      ({canvasId,nodeId,resourceId,resourceSource,resourceKey,recordId,itemId,path})),
    resources:resources.map(({candidates,...resource})=>({...resource,candidates:candidates.map(c=>{
      const u=new URL(c.url);return{origin:c.origin,verified:false,host:u.hostname,path:u.pathname,hasAccessParameters:!!u.search};
    })}))};
}
