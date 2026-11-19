import test from 'node:test';
import assert from 'node:assert/strict';
import {createVariableSnapshot} from '../packages/core/src/variables/variables.js';
import {executeBrowserRequest,BROWSER_CAPABILITIES} from '../packages/sdk-js/src/index.browser.js';
const root='/browser';
const snapshot=(vars:Record<string,unknown>,protectedFile=false)=>createVariableSnapshot([{
  folderPath:root,files:[{filePath:`${root}/dev.variables.json`,filename:'dev.variables.json',content:{enabled:true,protected:protectedFile,...vars}}],
}]);
test('T08 browser fetch preserves JSON 200 and masks request headers, no filesystem capability',async()=>{
  const vars=snapshot({baseUrl:'https://api.example.com'});
  let sent='';
  const response=await executeBrowserRequest({request:{method:'GET',url:'{{baseUrl}}/x',headers:[{name:'Authorization',value:'Bearer secret'}]}},{
    snapshot:vars,fetch:async(input,init)=>{
      sent=String(input);assert.equal((init?.headers as Headers).get('authorization'),'Bearer secret');
      assert.equal(init?.redirect,'error');
      return new Response('{"ok":true}',{status:200,headers:{'Content-Type':'application/json'}});
    },
  });
  assert.equal(sent,'https://api.example.com/x');
  assert.equal(response.result.response?.status,200);
  assert.deepEqual(response.result.response?.body,{type:'json',value:{ok:true}});
  assert.equal(response.result.request.headers[0]?.value,'Bearer [REDACTED]');
  assert.equal(BROWSER_CAPABILITIES.filesystem,false);
});
test('T08 browser keeps HTTP 404 body and reports blocked fetch/CORS separately',async()=>{
  const vars=snapshot({});
  const notFound=await executeBrowserRequest({request:{method:'GET',url:'https://api.example.com/missing'}},{snapshot:vars,
    fetch:async()=>new Response('missing',{status:404,headers:{'Content-Type':'text/plain'}})});
  assert.equal(notFound.result.response?.status,404);
  assert.deepEqual(notFound.result.response?.body,{type:'text',value:'missing'});
  const cors=await executeBrowserRequest({request:{method:'GET',url:'https://api.example.com/x'}},{snapshot:vars,
    fetch:async()=>{throw new TypeError('Failed to fetch');}});
  assert.equal(cors.result.response,null);
  assert.equal(cors.diagnostic?.code,'NETWORK_OR_CORS_BLOCKED');
});
test('T08 browser denies untrusted HTTP, blocked protected use before fetch and binary bodies',async()=>{
  let calls=0;
  const vars=snapshot({url:'https://api.example.com'},true);
  const fake=async()=>{calls++;return new Response('ok');};
  await assert.rejects(executeBrowserRequest({request:{method:'GET',url:'{{url}}'}},{snapshot:vars,fetch:fake}));
  assert.equal(calls,0);
  const approved=await executeBrowserRequest({request:{method:'GET',url:'{{url}}'}},{snapshot:vars,approval:async()=>true,fetch:fake});
  assert.equal(approved.result.response?.status,200);
  await assert.rejects(executeBrowserRequest({request:{method:'GET',url:'http://example.com'}},{snapshot:vars,fetch:fake}));
  await assert.rejects(executeBrowserRequest({request:{method:'POST',url:'https://example.com',body:{type:'binary',path:'a.bin'}}},{snapshot:vars,fetch:fake}));
  assert.equal(calls,1);
});
