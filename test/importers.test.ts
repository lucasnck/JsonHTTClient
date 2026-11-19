import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readdir,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {importCurl} from '../packages/importers/src/curl.js';
import {importOpenApi} from '../packages/importers/src/openapi.js';
import {applyImportPlan} from '../packages/runtime-node/src/importers/apply.js';

const command=`curl -X POST 'https://api.example.test/customers' -H 'Accept: application/json' -H 'Authorization: Bearer secret-token' -d '{"name":"Ada"}'`;
test('T07: cURL imports method, headers and JSON body without copying Authorization secret',()=>{
  const plan=importCurl(command);
  assert.equal(plan.operations.length,1);
  assert.equal(plan.operations[0]?.file.request.method,'POST');
  assert.deepEqual(plan.operations[0]?.file.request.body,{type:'json',value:{name:'Ada'}});
  assert.equal(plan.operations[0]?.file.request.headers?.[1]?.value,'{{authorizationToken}}');
  assert.match(JSON.stringify(plan),/CREDENTIAL_REPLACED/);
  assert.doesNotMatch(JSON.stringify(plan),/secret-token/);
});
test('T07: cURL supports line continuation, -G and urlencoded query',()=>{
  const plan=importCurl("curl -G \\\n 'https://api.example.test/search' --data-urlencode 'name=Ada Lovelace'");
  assert.deepEqual(plan.operations[0]?.file.request.query,[{name:'name',value:'Ada Lovelace'}]);
  assert.equal(plan.operations[0]?.file.request.method,'GET');
});
test('T07: static Bash importer supports multiple curl commands but does not run shell',()=>{
  const plan=importCurl("#!/bin/bash\ncurl 'https://api.example.test/users'\ncurl 'https://api.example.test/orders'",'bash');
  assert.equal(plan.operations.length,2);
  assert.equal(plan.operations[0]?.file.request.method,'GET');
  assert.equal(plan.operations[1]?.file.request.method,'GET');
  assert.throws(()=>importCurl("curl https://api.example.test/users; touch /tmp/pwned",'bash'));
  assert.throws(()=>importCurl('curl "https://api.example.test/$(whoami)"','curl'));
  assert.throws(()=>importCurl('curl https://api.example.test | sh','bash'));
});
test('T07: unsupported remote-file upload and dangerous flags fail closed',()=>{
  assert.throws(()=>importCurl('curl https://api.example.test -F file=@/etc/passwd'),{code:'UNSUPPORTED_FLAG'});
  assert.throws(()=>importCurl('curl -k https://api.example.test'),{code:'UNSUPPORTED_FLAG'});
});
test('T07: OpenAPI 3 JSON makes deterministic requests with template path/query and warns about auth',()=>{
  const plan=importOpenApi({openapi:'3.0.3',servers:[{url:'https://api.example.test'}],paths:{
    '/users/{userId}':{get:{operationId:'getUser',parameters:[{in:'query',name:'verbose'}],security:[{bearerAuth:[]}]},
    post:{operationId:'createUser',requestBody:{content:{'application/json':{schema:{example:{name:'Ada'}}}}}}}
  }});
  assert.equal(plan.operations.length,2);
  assert.equal(plan.operations[0]?.filename,'getuser.request.json');
  assert.equal(plan.operations[0]?.file.request.url,'https://api.example.test/users/{{userId}}');
  assert.deepEqual(plan.operations[0]?.file.request.query,[{name:'verbose',value:'{{verbose}}'}]);
  assert.equal(plan.operations[0]?.file.request.headers?.[0]?.value,'Bearer {{authorizationToken}}');
  assert.equal(plan.operations[1]?.file.request.body?.type,'json');
  assert.ok(plan.warnings.some(w=>w.code==='AUTH_PLACEHOLDER'));
});
test('T07: OpenAPI collisions produce distinct safe filenames, unknown $refs not fetched',()=>{
  const plan=importOpenApi({openapi:'3.1.0',paths:{
    '/one':{get:{operationId:'same'}},'/two':{get:{operationId:'same'}},'/else':{'$ref':'https://internal.test/private'}
  }});
  assert.deepEqual(plan.operations.map(x=>x.filename),['same.request.json','same-2.request.json']);
  assert.ok(plan.warnings.some(w=>w.code==='REF_UNRESOLVED'));
});
test('T07: OpenAPI YAML explicitly unsupported until parser is available',()=>{
  assert.throws(()=>importOpenApi('openapi: 3.0.1\npaths: {}'),{code:'UNSUPPORTED_FORMAT'});
});
test('T07: import preview does not write; Apply uses authorized root and never overwrites',async()=>{
  const root=await mkdtemp(join(tmpdir(),'json-import-'));const output=join(root,'requests');await mkdir(output);
  try{
    const plan=importCurl('curl https://api.example.test/items');
    assert.deepEqual(await readdir(output),[]);
    const saved=await applyImportPlan(plan,output,root);
    assert.equal(saved.length,1);
    const file=JSON.parse(await readFile(saved[0]!,'utf8')) as {request:{method:string}};
    assert.equal(file.request.method,'GET');
    await assert.rejects(applyImportPlan(plan,output,root),{code:'WRITE_FAILED'});
    assert.equal((await readdir(output)).length,1);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('T07: Apply refuses paths outside authorized root',async()=>{
  const root=await mkdtemp(join(tmpdir(),'json-import-'));const other=await mkdtemp(join(tmpdir(),'json-import-other-'));
  try{await assert.rejects(applyImportPlan(importCurl('curl https://api.example.test'),other,root),{code:'WRITE_FAILED'});}
  finally{await rm(root,{recursive:true,force:true});await rm(other,{recursive:true,force:true});}
});
