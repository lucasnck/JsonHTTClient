import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {mkdtemp,writeFile,mkdir,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {executeLoop} from '../packages/sdk-js/src/loop-execution.js';
import {createVariableSnapshot} from '../packages/core/src/variables/variables.js';
import {validateExecutionBatchResult} from '../packages/core/src/contracts/validation.js';
import {LoopSourceError} from '../packages/runtime-node/src/execution/loop-data.js';
import {HttpPolicyError} from '../packages/core/src/security/policies.js';

async function fixture() {
  let count=0;
  const server=createServer((req,res)=>{
    count++;
    res.setHeader('content-type','application/json');
    const error=req.url?.includes('/missing');
    const delay=req.url?.includes('/wait');
    const send=()=>{if(res.destroyed)return;res.statusCode=error?404:200;res.end(JSON.stringify({url:req.url,ok:!error}));};
    if(delay)setTimeout(send,90);else send();
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {base,count:()=>count,close:()=>new Promise<void>(resolve=>server.close(()=>resolve()))};
}
const snapshot=(base:string,protectedSource=false)=>createVariableSnapshot([{folderPath:'/root',files:[{
  filename:'dev.variables.json',filePath:'/root/dev.variables.json',content:{baseUrl:base,enabled:true,protected:protectedSource},
}]}]);
const policy={allowHttp:true,allowPrivateNetworks:true};
const requestFile=(items:Array<Record<string,unknown>>,onError:'stop'|'continue'='continue')=>({
  request:{method:'GET',url:'{{baseUrl}}/{{endpoint}}'},
  loop:{source:{kind:'inline' as const,items},mode:'sequential' as const,onError},
});

test('T05: 2-item loop returns canonical batch and item result shapes',async()=>{
  const s=await fixture();
  try{
    const progress:string[]=[];
    const run=await executeLoop(requestFile([{endpoint:'a'},{endpoint:'b'}]),{snapshot:snapshot(s.base),policy,onProgress:e=>progress.push(e.type)});
    assert.equal(run.result.summary.status,'succeeded');
    assert.deepEqual(run.result.summary,{status:'succeeded',total:2,executed:2,succeeded:2,failed:0,cancelled:0,skipped:0});
    assert.equal(run.result.results.length,2);
    assert.deepEqual(Object.keys(run.result),['summary','timings','results']);
    assert.deepEqual(Object.keys(run.result.results[0]!),['request','response','timings']);
    assert.equal(validateExecutionBatchResult(run.result).valid,true);
    assert.equal(progress.filter(x=>x==='iteration_started').length,2);
  }finally{await s.close();}
});
test('T05: HTTP 404 counts failed, body remains original and next request continues',async()=>{
  const s=await fixture();
  try{
    const run=await executeLoop(requestFile([{endpoint:'first'},{endpoint:'missing'},{endpoint:'last'}]),{snapshot:snapshot(s.base),policy});
    assert.deepEqual(run.result.summary,{status:'partial_failed',total:3,executed:3,succeeded:2,failed:1,cancelled:0,skipped:0});
    assert.equal(run.result.results[1]?.response?.status,404);
    assert.deepEqual(run.result.results[1]?.response?.body,{type:'json',value:{url:'/missing',ok:false}});
  }finally{await s.close();}
});
test('T05: stop on error skips remaining items without fabricated results',async()=>{
  const s=await fixture();
  try{
    const run=await executeLoop(requestFile([{endpoint:'first'},{endpoint:'missing'},{endpoint:'last'}],'stop'),{snapshot:snapshot(s.base),policy});
    assert.equal(s.count(),2);
    assert.equal(run.result.summary.skipped,1);
    assert.equal(run.result.results.length,2);
    assert.equal(validateExecutionBatchResult(run.result).valid,true);
  }finally{await s.close();}
});
test('T05: AbortSignal after item 2 cancels pending items with truthful summary',async()=>{
  const s=await fixture();
  try{
    const ctl=new AbortController();
    const progress:string[]=[];
    const run=await executeLoop(requestFile([{endpoint:'wait'},{endpoint:'wait'},{endpoint:'wait'},{endpoint:'wait'}]),{
      snapshot:snapshot(s.base),policy,signal:ctl.signal,
      onProgress:e=>{progress.push(e.type);if(e.type==='iteration_completed'&&e.ordinal===2)ctl.abort();},
    });
    assert.equal(s.count(),2);
    assert.equal(run.result.summary.status,'cancelled');
    assert.equal(run.result.summary.executed,2);
    assert.equal(run.result.summary.skipped,2);
    assert.ok(progress.includes('cancelled'));
  }finally{await s.close();}
});
test('T05: empty dataset generates a successful empty batch',async()=>{
  const s=await fixture();
  try{
    const run=await executeLoop(requestFile([]),{snapshot:snapshot(s.base),policy});
    assert.deepEqual(run.result.summary,{status:'succeeded',total:0,executed:0,succeeded:0,failed:0,cancelled:0,skipped:0});
    assert.equal(s.count(),0);
  }finally{await s.close();}
});
test('T09: preflight rejects missing variable before ANY request is issued',async()=>{
  const s=await fixture();
  try{
    await assert.rejects(executeLoop(requestFile([{endpoint:'good'},{}]),{snapshot:snapshot(s.base),policy}));
    assert.equal(s.count(),0);
  }finally{await s.close();}
});
test('T09: protected loop obtains ONE approval before HTTP with count and destinations',async()=>{
  const s=await fixture();
  try{
    let approvalCount=0,summaryCount=0;
    const approved=await executeLoop(requestFile([{endpoint:'a'},{endpoint:'b'}]),{
      snapshot:snapshot(s.base,true),policy,approval:async data=>{approvalCount++;summaryCount=data.count??0;return true;},
    });
    assert.equal(approved.result.summary.executed,2);
    assert.equal(approvalCount,1);
    assert.equal(summaryCount,2);
  }finally{await s.close();}
});
test('T09: protected loop DENIED before sending ANY HTTP',async()=>{
  const s=await fixture();
  try{
    await assert.rejects(executeLoop(requestFile([{endpoint:'a'},{endpoint:'b'}]),{snapshot:snapshot(s.base,true),policy}),HttpPolicyError);
    assert.equal(s.count(),0);
  }finally{await s.close();}
});
test('T05: file-backed data uses authorized relative JSON dataset',async()=>{
  const s=await fixture();
  const root=await mkdtemp(join(tmpdir(),'http-loop-'));
  try{
    const dir=join(root,'requests');await mkdir(dir);
    const req=join(dir,'list.request.json');await writeFile(req,'{}');
    await writeFile(join(dir,'items.json'),JSON.stringify([{endpoint:'one'},{endpoint:'two'}]));
    const file={request:{method:'GET',url:'{{baseUrl}}/{{endpoint}}'},loop:{source:{kind:'file' as const,path:'./items.json'}}};
    const run=await executeLoop(file,{snapshot:snapshot(s.base),policy,requestPath:req,authorizedRoot:root});
    assert.equal(run.result.summary.executed,2);
  }finally{await rm(root,{recursive:true,force:true});await s.close();}
});
test('T05: dataset must remain inside root and cannot be a symlink',async()=>{
  const s=await fixture();
  const root=await mkdtemp(join(tmpdir(),'http-loop-'));const other=await mkdtemp(join(tmpdir(),'http-loop-else-'));
  try{
    const dir=join(root,'requests');await mkdir(dir);
    const req=join(dir,'list.request.json');await writeFile(req,'{}');
    await writeFile(join(other,'items.json'),'[]');
    await symlink(join(other,'items.json'),join(dir,'alias.json'));
    const file=(path:string)=>({request:{method:'GET',url:'{{baseUrl}}/{{endpoint}}'},loop:{source:{kind:'file' as const,path}}});
    await assert.rejects(executeLoop(file('../../outside.json'),{snapshot:snapshot(s.base),policy,requestPath:req,authorizedRoot:root}),LoopSourceError);
    await assert.rejects(executeLoop(file('alias.json'),{snapshot:snapshot(s.base),policy,requestPath:req,authorizedRoot:root}),(e:unknown)=>e instanceof LoopSourceError&&e.code==='UNSAFE_DATASET');
    assert.equal(s.count(),0);
  }finally{await rm(root,{recursive:true,force:true});await rm(other,{recursive:true,force:true});await s.close();}
});
