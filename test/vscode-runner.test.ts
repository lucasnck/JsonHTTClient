import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {runEditorRequest} from '../apps/vscode/src/runner.js';
import type {ExecutionBatchResult} from '../packages/core/src/contracts/types.js';

async function fixture(protectedFile=false){
  let requests=0;
  const server=createServer((req,res)=>{
    requests++;
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({path:req.url,status:200}));
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const workspace=await mkdtemp(join(tmpdir(),'json-http-vscode-'));
  const folder=join(workspace,'folder');await mkdir(folder);
  const path=join(folder,'customers.request.json');
  const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await writeFile(join(folder,'dev.variables.json'),JSON.stringify({enabled:true,protected:protectedFile,baseUrl:url}));
  await writeFile(path,JSON.stringify({request:{method:'GET',url:'{{baseUrl}}/on-disk'}}));
  return {
    workspace,path,url,requests:()=>requests,
    close:async()=>{await new Promise<void>(r=>server.close(()=>r()));await rm(workspace,{recursive:true,force:true});},
  };
}
const policy={allowHttp:true,allowPrivateNetworks:true};

test('F04 native adapter uses unsaved editor content and produces editable canonical JSON',async()=>{
  const f=await fixture();
  try{
    const text=JSON.stringify({request:{method:'GET',url:'{{baseUrl}}/unsaved',headers:[{name:'Authorization',value:'Bearer local-secret'}]}});
    const output=await runEditorRequest({requestPath:f.path,authorizedRoot:f.workspace,text,policy});
    const data=JSON.parse(output.json) as {request:{url:string;headers:Array<{name:string;value:string}>},response:{status:number;body:{type:string;value:{path:string}}}};
    assert.deepEqual(Object.keys(data),['request','response','timings']);
    assert.equal(data.response.status,200);
    assert.equal(data.response.body.value.path,'/unsaved');
    assert.equal(data.request.headers.find(h=>h.name==='authorization')?.value,'Bearer [REDACTED]');
    assert.doesNotMatch(output.json,/local-secret/);
    assert.equal((JSON.parse(await readFile(f.path,'utf8')) as {request:{url:string}}).request.url,'{{baseUrl}}/on-disk');
    assert.equal(f.requests(),1);
  }finally{await f.close();}
});

test('F04 adapter denies protected run before sending HTTP unless host approves',async()=>{
  const f=await fixture(true);
  try{
    const text=JSON.stringify({request:{method:'GET',url:'{{baseUrl}}/protected'}});
    await assert.rejects(runEditorRequest({requestPath:f.path,authorizedRoot:f.workspace,text,policy}));
    assert.equal(f.requests(),0);
    const approved=await runEditorRequest({requestPath:f.path,authorizedRoot:f.workspace,text,policy,approval:async p=>{
      assert.match(p.protectedFiles[0]??'',/dev\.variables\.json$/);
      return true;
    }});
    assert.equal((approved.result as {response:{status:number}}).response.status,200);
    assert.equal(f.requests(),1);
  }finally{await f.close();}
});

test('F04 progress/AbortSignal stops loop before the next request',async()=>{
  const f=await fixture();
  try{
    const controller=new AbortController();
    const events:string[]=[];
    const output=await runEditorRequest({
      requestPath:f.path,authorizedRoot:f.workspace,policy,signal:controller.signal,
      text:JSON.stringify({request:{method:'GET',url:'{{baseUrl}}/{{id}}'},loop:{source:{kind:'inline',items:[{id:1},{id:2},{id:3}]}}}),
      onProgress:e=>{
        events.push(e.type);
        if(e.type==='iteration_completed'&&e.ordinal===1)controller.abort();
      },
    });
    const result=output.result as ExecutionBatchResult;
    assert.equal(result.summary.status,'cancelled');
    assert.equal(result.summary.executed,1);
    assert.equal(result.summary.skipped,2);
    assert.equal(f.requests(),1);
    assert(events.includes('batch_started'));
    assert(events.includes('cancelled'));
  }finally{await f.close();}
});

test('F04 invalid, non-HTTP and outside-workspace files never send an HTTP request',async()=>{
  const f=await fixture();
  try{
    await assert.rejects(runEditorRequest({requestPath:f.path,authorizedRoot:f.workspace,text:'{"request": ',policy}));
    await assert.rejects(runEditorRequest({requestPath:f.path.replace('customers.request.json','customers.json'),authorizedRoot:f.workspace,text:'{}',policy}));
    await assert.rejects(runEditorRequest({requestPath:f.path,authorizedRoot:resolve(f.workspace,'folder','subdir'),text:'{}',policy}));
    assert.equal(f.requests(),0);
  }finally{await f.close();}
});
