import test from 'node:test';
import assert from 'node:assert/strict';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';

const exec=promisify(execFile);
const cli=resolve(process.cwd(),'dist/apps/cli/src/main.js');
async function fixture(protectedFile=false){
  let hits=0;
  const server=createServer((req,res)=>{hits++;res.setHeader('content-type','application/json');res.end(JSON.stringify({path:req.url}));});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const root=await mkdtemp(join(tmpdir(),'cli-http-'));
  const dir=join(root,'customers');await mkdir(dir);
  const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await writeFile(join(dir,'dev.variables.json'),JSON.stringify({enabled:true,protected:protectedFile,baseUrl:url,OAuthToken:{type:'oauth2',issuer:'https://dev-id.test',clientId:'dev'}}));
  await writeFile(join(dir,'prod.variables.json'),JSON.stringify({enabled:true,baseUrl:'https://prod.example.test',OAuthToken:{type:'oauth2',issuer:'https://prod-id.test',clientId:'prod'}}));
  await writeFile(join(dir,'one.request.json'),JSON.stringify({request:{method:'GET',url:'{{baseUrl}}/ok',headers:[{name:'Authorization',value:'Bearer fixed-secret'}]}}));
  await writeFile(join(dir,'loop.request.json'),JSON.stringify({request:{method:'GET',url:'{{baseUrl}}/{{endpoint}}'},loop:{source:{kind:'inline',items:[{endpoint:'a'},{endpoint:'b'}]}}}));
  return {root,dir,hits:()=>hits,close:async()=>{await new Promise<void>(r=>server.close(()=>r()));await rm(root,{recursive:true,force:true});}};
}
async function cliCall(args:string[]){return exec(process.execPath,[cli,...args],{encoding:'utf8'});}
const allows=['--allow-http','--allow-private-network'];

test('F01: CLI list shows real requests and variable filenames, but no OAuth tokens',async()=>{
  const f=await fixture();
  try{
    const {stdout}=await cliCall(['list',f.dir]);
    const json=JSON.parse(stdout) as {requests:string[];variableFiles:Array<{file:string,enabled:boolean,keys:string[]}>};
    assert.deepEqual(json.requests,['loop.request.json','one.request.json']);
    assert.deepEqual(json.variableFiles.map(x=>x.file),['dev.variables.json','prod.variables.json']);
    assert.equal(json.variableFiles[0]?.enabled,true);
    assert.deepEqual(json.variableFiles[0]?.keys,['baseUrl','OAuthToken']);
    assert.doesNotMatch(stdout,/accessToken|refreshToken/);
  }finally{await f.close();}
});
test('F01: CLI explain uses same effective D35 precedence as engine',async()=>{
  const f=await fixture();
  try{
    const {stdout}=await cliCall(['variables','explain',join(f.dir,'one.request.json'),'--root',f.root,'--name','OAuthToken']);
    const json=JSON.parse(stdout) as {origin:string,preview:string};
    assert.match(json.origin,/dev\.variables\.json$/);
    assert.match(json.preview,/dev-id\.test/);
    assert.doesNotMatch(json.preview,/access_token/i);
  }finally{await f.close();}
});
test('F01: CLI run emits canonical parseable JSON with masked Authorization by default',async()=>{
  const f=await fixture();
  try{
    const {stdout}=await cliCall(['run',join(f.dir,'one.request.json'),'--root',f.root,...allows]);
    const data=JSON.parse(stdout) as {request:{headers:Array<{name:string,value:string}>},response:{status:number}};
    assert.deepEqual(Object.keys(data),['request','response','timings']);
    assert.equal(data.response.status,200);
    assert.equal(data.request.headers.find(h=>h.name==='authorization')?.value,'Bearer [REDACTED]');
    assert.equal(f.hits(),1);
  }finally{await f.close();}
});
test('F01: CLI allows original headers ONLY with explicit --show-sensitive',async()=>{
  const f=await fixture();
  try{
    const {stdout}=await cliCall(['run',join(f.dir,'one.request.json'),'--root',f.root,...allows,'--show-sensitive']);
    const data=JSON.parse(stdout) as {request:{headers:Array<{name:string,value:string}>}};
    assert.equal(data.request.headers.find(h=>h.name==='authorization')?.value,'Bearer fixed-secret');
  }finally{await f.close();}
});
test('F01: CLI loop outputs canonical batch and progress on stderr',async()=>{
  const f=await fixture();
  try{
    const {stdout,stderr}=await cliCall(['run',join(f.dir,'loop.request.json'),'--root',f.root,...allows]);
    const data=JSON.parse(stdout) as {results:unknown[];summary:{total:number,executed:number}};
    assert.deepEqual(Object.keys(data),['summary','timings','results']);
    assert.equal(data.results.length,2);
    assert.equal(data.summary.executed,2);
    assert.match(stderr,/HTTP 1\/2/);
  }finally{await f.close();}
});
test('F01: protected variables deny CLI execution without --allow-protected',async()=>{
  const f=await fixture(true);
  try{
    await assert.rejects(cliCall(['run',join(f.dir,'one.request.json'),'--root',f.root,...allows]));
    assert.equal(f.hits(),0);
    const {stdout}=await cliCall(['run',join(f.dir,'one.request.json'),'--root',f.root,...allows,'--allow-protected']);
    assert.equal((JSON.parse(stdout) as {response:{status:number}}).response.status,200);
    assert.equal(f.hits(),1);
  }finally{await f.close();}
});
