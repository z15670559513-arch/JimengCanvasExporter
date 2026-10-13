// Fully synthetic fixtures; no live account, board, signed asset or local path.
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
function chunk(type,data) {
  const name=Buffer.from(type),length=Buffer.alloc(4),checksum=Buffer.alloc(4);length.writeUInt32BE(data.length);
  let crc=0xffffffff;for(const byte of Buffer.concat([name,data])){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
  checksum.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([length,name,data,checksum]);
}
const header=Buffer.alloc(13);header.writeUInt32BE(1,0);header.writeUInt32BE(1,4);header[8]=8;header[9]=6;
// Valid synthetic RGBA PNG, including CRCs; browser decoder is not mocked in smoke tests.
export const pngBytes=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.from([0,0,0,0,255]))),chunk('IEND',Buffer.alloc(0))]);
export const sampleInfo={ext:'png',width:1,height:1,bytes:pngBytes.length,sha256:createHash('sha256').update(pngBytes).digest('hex')};
export const officialReferences=[{canvasId:'100',nodeId:'00000000-0000-4000-8000-000000000001',recordId:'42',itemId:'900000000000000001',...sampleInfo}];
// Development-only comparator retained as a regression gate, never shipped in runtime.
export function compareOfficial(info,reference) {
  if(info.ext!=='png')return{confirmed:false,reason:'返回文件不是 PNG'};
  if(!reference)return{confirmed:false,reason:'没有对照样本'};
  const dimensions=info.width===reference.width&&info.height===reference.height;
  const bytes=info.bytes===reference.bytes,hash=info.sha256.toLowerCase()===reference.sha256.toLowerCase();
  return{confirmed:dimensions&&bytes&&hash,dimensions,bytes,hash};
}
export function canvasFixture(count=288,canvasId='100',{uploads=54,records=60}={}) {
  const layers=[],aiGeneratorReference={};
  for(let i=0;i<count;i++) {
    const nodeId='00000000-0000-4000-8000-'+String(i+1).padStart(12,'0');
    const uploaded=i<uploads;
    layers.push({id:nodeId,type:'image',resourceId:uploaded?'synthetic-upload-'+i:'',resourceSource:uploaded?'userUpload':'aiGenerate'});
    if(!uploaded)aiGeneratorReference[nodeId]={recordId:String(42+(i-uploads)%records),itemId:'900000000000'+String(i+1).padStart(6,'0')};
  }
  const draft={meta:{},layers,aiGeneratorReference};
  return {draft,project:{ret:'0',data:{project:{id:canvasId,draft:{draft_id:'200',latest_version:525}}}},
    snapshot:{ret:'0',data:{snapshots:[{draft_id:'200',version:525,draft:JSON.stringify(draft)}]}}};
}
