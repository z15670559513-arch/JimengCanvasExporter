export async function digest(blob) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))]
    .map(x=>x.toString(16).padStart(2,'0')).join('');
}
export async function inspect(blob) {
  const b = new Uint8Array(await blob.slice(0,24).arrayBuffer());
  const png = [137,80,78,71,13,10,26,10].every((v,i)=>b[i]===v);
  const jpeg = b[0]===255 && b[1]===216 && b[2]===255;
  const webp = b[0]===82 && b[1]===73 && b[2]===70 && b[3]===70 && b[8]===87 && b[9]===69 && b[10]===66 && b[11]===80;
  if (!png && !jpeg && !webp) throw new Error('原始文件不是有效 PNG/JPEG/WebP，拒绝保存');
  if(blob.type && ![png?'image/png':jpeg?'image/jpeg':'image/webp','application/octet-stream'].includes(blob.type.split(';')[0])) throw new Error('文件类型与真实字节不一致');
  const bitmap = await createImageBitmap(blob);
  try {
    const info = {width:bitmap.width,height:bitmap.height,bytes:blob.size,ext:png?'png':jpeg?'jpg':'webp',sha256:await digest(blob)};
    if (!info.width || !info.height || !info.bytes) throw new Error('图片解码失败或为空');
    return info;
  } finally {bitmap.close();}
}
export async function unusedName(dir, base, ext) {
  for (let i=0;i<10000;i++) {
    const name = base + (i ? '_' + i : '') + '.' + ext;
    try { await dir.getFileHandle(name); }
    catch(e) { if(e.name==='NotFoundError') return name; throw e; }
  }
  throw new Error('同名文件过多，未覆盖任何文件');
}
export async function saveImage(dir, blob, base, onPlan) {
  const info = await inspect(blob);
  const name = await unusedName(dir,base,info.ext);
  await onPlan({name,...info});
  const handle = await dir.getFileHandle(name,{create:true});
  // A racing external writer must not be overwritten.
  if ((await handle.getFile()).size) throw new Error('目标文件已被其他程序创建，已保留它');
  const stream = await handle.createWritable();
  try { await stream.write(blob); await stream.close(); }
  catch(e) { await stream.abort().catch(()=>{}); throw e; }
  const actual = await inspect(await handle.getFile());
  if (actual.sha256!==info.sha256) throw new Error('磁盘回读 SHA-256 不一致');
  return {name,...actual};
}
export async function verifyImage(dir, record) {
  const actual = await inspect(await (await dir.getFileHandle(record.name)).getFile());
  if (actual.sha256!==record.sha256 || actual.bytes!==record.bytes) throw new Error('已保存文件发生变化');
  return actual;
}
export async function writeReport(dir, task) {
  const name=await unusedName(dir,'导出报告_'+Date.now(),'json');
  const handle=await dir.getFileHandle(name,{create:true});
  const stream=await handle.createWritable();
  const successes=task.nodes.filter(n=>n.status==='done');
  const report={...task,complete:false,integrity:'完整性未确认：仅能确认当前页面已加载节点；不等于服务端全部作品',
    saved:successes.length,failed:task.nodes.filter(n=>n.status==='failed').length,
    identicalContent:successes.length-new Set(successes.map(n=>n.sha256)).size};
  await stream.write(JSON.stringify(report,null,2)); await stream.close();
  return name;
}
