import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareVariableFileNames, createVariableSnapshot, planVariableFileActivation, validateVariablesFile } from '../packages/core/src/variables/variables.js';
import { loadVariableSnapshot, setVariableFileEnabled, VariableFileError } from '../packages/runtime-node/src/variable-files.js';

async function makeFixture(){
  const root=await mkdtemp(join(tmpdir(),'json-http-test-'));
  const dir=join(root,'Customers');
  await mkdir(dir);
  const request=join(dir,'list.request.json');
  await writeFile(request,'{"request":{"method":"GET","url":"{{baseUrl}}"}}');
  return {root,dir,request,cleanup:()=>rm(root,{recursive:true,force:true})};
}
const writeJson = (path:string,content:unknown)=>writeFile(path,JSON.stringify(content,null,2)+'\n');
test('T02: accept canonical object and reject legacy variables[]',()=>{
  assert.equal(validateVariablesFile({enabled:true,protected:false,baseUrl:'https://a.test'}).valid,true);
  assert.equal(validateVariablesFile({variables:[{name:'baseUrl',value:'a'}]}).valid,false);
  assert.equal(validateVariablesFile([{name:'baseUrl',value:'a'}]).valid,false);
  assert.equal(validateVariablesFile({enabled:'true'}).valid,false);
});
test('T02: OAuthToken is a property in any variables file without actual tokens',()=>{
  assert.equal(validateVariablesFile({baseUrl:'https://api.test',OAuthToken:{type:'oauth2',issuer:'https://issuer.test',clientId:'dev-client',scopes:['api.read']}}).valid,true);
  assert.equal(validateVariablesFile({OAuthToken:{type:'oauth2',issuer:'https://issuer.test',clientId:'dev-client',refreshToken:'secret'}}).valid,false);
});
test('T02: deterministic case-insensitive alphabetical order and raw tie-break',()=>{
  assert.equal(compareVariableFileNames('dev.variables.json','prod.variables.json')<0,true);
  assert.equal(compareVariableFileNames('A.variables.json','a.variables.json')<0,true);
  const names=['prod.variables.json','A.variables.json','dev.variables.json','a.variables.json'].sort(compareVariableFileNames);
  assert.deepEqual(names,['A.variables.json','a.variables.json','dev.variables.json','prod.variables.json']);
});
test('T02: first active file with key wins, next active supplies missing keys',()=>{
  const snap=createVariableSnapshot([{folderPath:'/root/Customers',files:[
    {filename:'prod.variables.json',filePath:'/root/Customers/prod.variables.json',content:{enabled:true,baseUrl:'https://prod.test',OAuthToken:{type:'oauth2',issuer:'https://p.test',clientId:'prod'}}},
    {filename:'dev.variables.json',filePath:'/root/Customers/dev.variables.json',content:{enabled:true,baseUrl:'https://dev.test',OAuthToken:{type:'oauth2',issuer:'https://d.test',clientId:'dev'},extra:'from-dev'}},
    {filename:'a.variables.json',filePath:'/root/Customers/a.variables.json',content:{enabled:false,baseUrl:'should-skip'}}
  ]}]);
  assert.equal(snap.get('baseUrl')?.value,'https://dev.test');
  assert.equal((snap.get('OAuthToken')?.value as {clientId:string}).clientId,'dev');
  assert.ok(snap.get('baseUrl')?.filePath.endsWith('dev.variables.json'));
  assert.equal(snap.get('extra')?.value,'from-dev');
});
test('T02: physical nearest folder takes priority over parent even when parent name sorts earlier',async()=>{
  const ctx=await makeFixture();
  try{
    await writeJson(join(ctx.root,'a.variables.json'),{enabled:true,baseUrl:'https://root.test',shared:'root'});
    await writeJson(join(ctx.dir,'prod.variables.json'),{enabled:true,baseUrl:'https://prod.test',onlyProd:123});
    await writeJson(join(ctx.dir,'dev.variables.json'),{enabled:true,baseUrl:'https://dev.test'});
    const s=await loadVariableSnapshot(ctx.request,ctx.root);
    assert.equal(s.get('baseUrl')?.value,'https://dev.test');
    assert.equal(s.get('shared')?.value,'root');
    assert.equal(s.get('onlyProd')?.value,123);
  }finally{await ctx.cleanup();}
});
test('T02: disabled file ignored with fallback to parent',async()=>{
  const ctx=await makeFixture();
  try{
    await writeJson(join(ctx.root,'variables.json'),{enabled:true,baseUrl:'https://root.test'});
    await writeJson(join(ctx.dir,'dev.variables.json'),{enabled:false,baseUrl:'https://dev.test'});
    const s=await loadVariableSnapshot(ctx.request,ctx.root);
    assert.equal(s.get('baseUrl')?.value,'https://root.test');
  }finally{await ctx.cleanup();}
});
test('T02: explicit Activate disables all siblings; Disable changes only selected',async()=>{
  const ctx=await makeFixture();
  try{
    const dev=join(ctx.dir,'dev.variables.json'),prod=join(ctx.dir,'prod.variables.json'),other=join(ctx.dir,'variables.json');
    await writeJson(dev,{enabled:true,baseUrl:'dev'});
    await writeJson(prod,{enabled:true,protected:true,baseUrl:'prod'});
    await writeJson(other,{enabled:true,extra:123});
    let r=await setVariableFileEnabled(prod,true,ctx.root);
    assert.ok(r.changedFiles.length>=2);
    const read=async(p:string)=>JSON.parse(await readFile(p,'utf8'));
    assert.equal((await read(dev)).enabled,false);
    assert.equal((await read(prod)).enabled,true);
    assert.equal((await read(other)).enabled,false);
    assert.equal((await read(prod)).protected,true);
    r=await setVariableFileEnabled(prod,false,ctx.root);
    assert.equal((await read(prod)).enabled,false);
    assert.equal((await read(dev)).enabled,false);
    assert.equal((await read(other)).enabled,false);
  }finally{await ctx.cleanup();}
});
test('T02: protected provenance follows winning definition only',async()=>{
  const s=createVariableSnapshot([{folderPath:'/root',files:[
    {filename:'prod.variables.json',filePath:'/root/prod.variables.json',content:{enabled:true,protected:true,baseUrl:'prod'}},
    {filename:'dev.variables.json',filePath:'/root/dev.variables.json',content:{enabled:true,protected:false,baseUrl:'dev'}}
  ]}]);
  assert.equal(s.get('baseUrl')?.protected,false);
});
test('T02: runtime rejects outside-root reads and symlink variable files',async()=>{
  const ctx=await makeFixture();
  const outside=await mkdtemp(join(tmpdir(),'json-http-outside-'));
  try{
    await assert.rejects(loadVariableSnapshot(ctx.request,outside),VariableFileError);
    const target=join(outside,'secret.txt');
    await writeFile(target,'{"enabled":true}');
    await symlink(target,join(ctx.dir,'linked.variables.json'));
    await assert.rejects(loadVariableSnapshot(ctx.request,ctx.root),VariableFileError);
  }finally{await ctx.cleanup();await rm(outside,{recursive:true,force:true});}
});
