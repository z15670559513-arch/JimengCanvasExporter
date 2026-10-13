import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {inspect,unusedName} from '../files.js';
import {pngBytes} from './fixtures.mjs';
globalThis.crypto ??= webcrypto;
test('成功和 SHA 异常路径均释放 bitmap；SHA 算法和结果不改',async()=>{
  const native=globalThis.createImageBitmap;let closed=0;
  try {
    globalThis.createImageBitmap=async()=>({width:1,height:1,close(){closed++;}});
    const blob=new Blob([pngBytes],{type:'image/png'}),info=await inspect(blob);
    assert.equal(info.sha256.length,64);assert.equal(closed,1);
    const failing=new Blob([pngBytes],{type:'image/png'});failing.arrayBuffer=async()=>{throw new Error('hash failed');};
    await assert.rejects(inspect(failing),/hash failed/);assert.equal(closed,2);
  } finally{globalThis.createImageBitmap=native;}
});
test('解码为空的异常路径也释放 bitmap',async()=>{
  const native=globalThis.createImageBitmap;let closed=0;
  try{globalThis.createImageBitmap=async()=>({width:0,height:0,close(){closed++;}});
    await assert.rejects(inspect(new Blob([pngBytes],{type:'image/png'})),/为空/);assert.equal(closed,1);
  }finally{globalThis.createImageBitmap=native;}
});
test('大量既有文件但默认唯一编号只需一次存在检查；碰撞仍不覆盖',async()=>{
  const names=new Set(Array.from({length:1500},(_,i)=>'image_'+i+'.png'));let checks=0;
  const dir={getFileHandle:async name=>{checks++;if(!names.has(name))throw Object.assign(new Error('missing'),{name:'NotFoundError'});return{};}};
  assert.equal(await unusedName(dir,'image_new','png'),'image_new.png');assert.equal(checks,1);
  names.add('image.png');assert.equal(await unusedName(dir,'image','png'),'image_1500.png');
  assert.equal(names.size,1501);
});
