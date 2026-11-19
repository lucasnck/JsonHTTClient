import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readdir,symlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {discoverRequestFiles,executeRequestDirectory} from '../packages/runtime-node/src/execution/request-directory.js';
import {HttpEngineMcpServer} from '../apps/mcp-server/src/server.js';
const exec=promisify(execFile);
async function fixture(){const root=await mkdtemp(join(tmpdir(),'json-http-run-dir-'));await mkdir(join(root,'requests'));await mkdir(join(root,'requests','nested'));return {root,folder:join(root,'requests'),close:()=>rm(root,{recursive:true,force:true})};}
function call(id:number,name:string,args:Record<string,unknown>){return {jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args}};}
function response(reply:Record<string,unknown>){const r=reply.result as {content:[{text:string}];isError?:boolean};return {isError:r.isError===true,value:JSON.parse(r.content[0].text) as Record<string,any>};}
test('F01: discover request files only, sorted, skip symlinks and honor recursive flag',async()=>{
  const f=await fixture();const outside=await mkdtemp(join(tmpdir(),'json-http-run-dir-out-'));
  try{
    await writeFile(join(f.folder,'z.request.json'),'{}');await writeFile(join(f.folder,'a.request.json'),'{}');
    await writeFile(join(f.folder,'notes.json'),'{}');
    await writeFile(join(f.folder,'nested','inside.request.json'),'{}');
    await symlink(outside,join(f.folder,'external'));
    assert.deepEqual((await discoverRequestFiles(f.folder,f.root)).map(x=>x.split('/').at(-1)),['a.request.json','z.request.json']);
    assert.equal((await discoverRequestFiles(f.folder,f.root,true)).length,3);
    await assert.rejects(discoverRequestFiles(join(f.folder,'external'),f.root,true),(error:unknown)=>error instanceof Error&&'code' in error&&error.code==='UNSAFE_PATH');
    await assert.rejects(discoverRequestFiles(f.folder,f.root,true,2),/Too many request files/);
    await assert.rejects(discoverRequestFiles(f.folder,outside,true),/Outside authorized root/);
  }finally{await f.close();await rm(outside,{recursive:true,force:true});}
});
test('F01: executeDirectory aggregates independent canonical results in filename order and stops on abort',async()=>{
  const f=await fixture();let sent=0;
  const server=createServer((req,res)=>{sent++;res.statusCode=req.url==='/fail'?404:200;res.end(req.url==='/fail'?'missing':'success');});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try{
    await writeFile(join(f.folder,'variables.json'),JSON.stringify({enabled:true,baseUrl:url}));
    await writeFile(join(f.folder,'a.request.json'),JSON.stringify({request:{method:'GET',url:'{{baseUrl}}/good'}}));
    await writeFile(join(f.folder,'b.request.json'),JSON.stringify({request:{method:'GET',url:'{{baseUrl}}/fail'}}));
    await writeFile(join(f.folder,'c.request.json'),JSON.stringify({request:{method:'GET',url:'{{baseUrl}}/last'}}));
    const full=await executeRequestDirectory(f.folder,{authorizedRoot:f.root,policy:{allowHttp:true,allowPrivateNetworks:true}});
    assert.deepEqual(full.runs.map(x=>x.file),['requests/a.request.json','requests/b.request.json','requests/c.request.json']);
    assert.equal(full.summary.total,3);assert.equal(full.summary.executed,3);
    assert.equal(full.summary.succeeded,2);assert.equal(full.summary.failed,1);
    assert.equal((full.runs[1]?.result as {response:{status:number}}).response.status,404);
    assert.deepEqual(Object.keys(full.runs[1]?.result??{}),['request','response','timings']);
    const controller=new AbortController();
    const interrupted=await executeRequestDirectory(f.folder,{authorizedRoot:f.root,
      policy:{allowHttp:true,allowPrivateNetworks:true},signal:controller.signal,
      onFile:({ordinal})=>{if(ordinal===2)controller.abort();}});
    assert.equal(interrupted.summary.status,'cancelled');
    assert.ok(interrupted.summary.skipped>0);
    assert.ok(sent>=4);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await f.close();}
});
test('F01: CLI run-dir emits one JSON object, keeps diagnostics on stderr, supports --recursive',async()=>{
  const f=await fixture();const server=createServer((_req,res)=>res.end('ok'));
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await writeFile(join(f.folder,'variables.json'),JSON.stringify({enabled:true,baseUrl:url}));
    await writeFile(join(f.folder,'a.request.json'),JSON.stringify({request:{method:'GET',url:'{{baseUrl}}/a'}}));
    await writeFile(join(f.folder,'nested','b.request.json'),JSON.stringify({request:{method:'GET',url:'{{baseUrl}}/b'}}));
    const {stdout,stderr}=await exec(process.execPath,['dist/apps/cli/src/main.js','run-dir',f.folder,'--root',f.root,'--recursive','--allow-http','--allow-private-network']);
    const parsed=JSON.parse(stdout) as {summary:{total:number};runs:unknown[]};
    assert.equal(parsed.summary.total,2);assert.equal(parsed.runs.length,2);
    assert.match(stderr,/HTTP 1\/2/);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await f.close();}
});
test('F03/F08: MCP request_run_dir and import_apply require distinct host authorizations',async()=>{
  const f=await fixture();const source='curl -X GET https://public.example.com/v1/customers';
  try{
    const denied=new HttpEngineMcpServer({root:f.root,allowWrite:true});
    const noApply=response((await denied.process(call(1,'import_apply',{format:'curl',source,outputDir:'requests'})))!);
    assert.equal(noApply.isError,true);assert.equal(noApply.value.code,'PERMISSION_DENIED');
    const noRun=response((await denied.process(call(2,'request_run_dir',{directory:'requests',recursive:true})))!);
    assert.equal(noRun.isError,true);assert.equal(noRun.value.code,'PERMISSION_DENIED');
    const allowed=new HttpEngineMcpServer({root:f.root,allowWrite:true,allowImportApply:true,allowRun:true});
    const applied=response((await allowed.process(call(3,'import_apply',{format:'curl',source,outputDir:'requests'})))!);
    assert.equal(applied.isError,false);assert.equal((applied.value.files as string[]).length,1);
    assert.equal((await readdir(f.folder)).filter(x=>x.endsWith('.request.json')).length,1);
    const repeated=response((await allowed.process(call(4,'import_apply',{format:'curl',source,outputDir:'requests'})))!);
    assert.equal(repeated.isError,true);
    const outside=response((await allowed.process(call(5,'import_apply',{format:'curl',source,outputDir:'../../'})))!);
    assert.equal(outside.isError,true);assert.equal(outside.value.code,'OUTSIDE_ROOT');
    const empty=response((await allowed.process(call(6,'request_run_dir',{directory:'requests/nested'})))!);
    assert.equal(empty.isError,false);assert.equal(empty.value.summary.total,0);
  }finally{await f.close();}
});
