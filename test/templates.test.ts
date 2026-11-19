import test from 'node:test';
import assert from 'node:assert/strict';
import {createVariableSnapshot} from '../packages/core/src/variables/variables.js';
import {interpolateRequest, TemplateResolver, TemplateError} from '../packages/core/src/templates/interpolation.js';
import {completeAt, diagnosePlaceholders, findPlaceholders, hoverVariable} from '../packages/language-service/src/language-service.js';

const snapshot = createVariableSnapshot([{folderPath:'/root',files:[
  {filename:'prod.variables.json',filePath:'/root/prod.variables.json',content:{enabled:true,baseUrl:'https://prod.test',OAuthToken:{type:'oauth2',issuer:'https://prod-id.test',clientId:'prod'}}},
  {filename:'dev.variables.json',filePath:'/root/dev.variables.json',content:{enabled:true,protected:true,baseUrl:'https://dev.test',OAuthToken:{type:'oauth2',issuer:'https://dev-id.test',clientId:'dev'},userId:42,shared:'{{baseUrl}}/customers', nested:{id:'{{userId}}'}}},
]}]);
const resolver = (options: ConstructorParameters<typeof TemplateResolver>[1] = {}) => new TemplateResolver(snapshot, options);
const mustError = (fn:()=>unknown,code:TemplateError['code'])=>assert.throws(fn,(error:unknown)=>error instanceof TemplateError && error.code===code);

test('T03: full JSON placeholder retains native number and object types',()=>{
  const out=resolver().resolveValue({id:'{{userId}}',nested:'{{nested}}',nullable:null});
  assert.deepEqual(JSON.parse(JSON.stringify(out)),{id:42,nested:{id:42},nullable:null});
});
test('T03: mixed placeholders stringify scalars in strings',()=>{
  assert.equal(resolver().resolveString('{{baseUrl}}/users/{{userId}}'),'https://dev.test/users/42');
  mustError(()=>resolver().resolveString('prefix {{nested}}'),'NON_SCALAR_INTERPOLATION');
});
test('T03: recursive names inherit first active alphabetical file',()=>{
  assert.equal(resolver().resolveValue('{{shared}}'),'https://dev.test/customers');
  assert.equal(snapshot.get('OAuthToken')?.filePath,'/root/dev.variables.json');
});
test('T03: locals override effective file values for loop item',()=>{
  assert.equal(resolver({locals:{userId:99}}).resolveString('user-{{userId}}'),'user-99');
  assert.equal(snapshot.get('userId')?.value,42);
});
test('T03: interpolation reports real protected origins including references',()=>{
  const res=interpolateRequest({method:'GET',url:'{{shared}}/{{userId}}'},snapshot);
  assert.equal(res.request.url,'https://dev.test/customers/42');
  assert.deepEqual(res.resolution.usedProtectedFiles,['/root/dev.variables.json']);
});
test('T03: request URL, header, query, body and auth are interpolated with correct types',()=>{
  const result=interpolateRequest({
    method:'POST',url:'{{baseUrl}}/users',headers:[{name:'X-User',value:'{{userId}}'}],
    query:[{name:'id',value:'{{userId}}'}],auth:{type:'basic',username:'u',password:'{{userId}}'},
    body:{type:'json',value:{id:'{{userId}}',label:'u-{{userId}}', '{{userId}}':'ok'}},
  },snapshot).request;
  assert.equal(result.url,'https://dev.test/users');
  assert.deepEqual(result.headers,[{name:'X-User',value:'42'}]);
  assert.deepEqual(JSON.parse(JSON.stringify(result.body)),{type:'json',value:{'42':'ok',id:42,label:'u-42'}});
  assert.deepEqual(result.auth,{type:'basic',username:'u',password:'42'});
});
test('T03: duplicate output keys are rejected',()=>{
  mustError(()=>resolver({locals:{key:'same'}}).resolveValue({'same':1,'{{key}}':2}),'DUPLICATE_KEY');
});
test('T03: unsafe keys and missing names fail without prototype pollution',()=>{
  mustError(()=>resolver({locals:{key:'__proto__'}}).resolveValue({'{{key}}':2}),'UNSAFE_KEY');
  mustError(()=>resolver().resolveValue('{{missing}}'),'MISSING_VARIABLE');
  mustError(()=>resolver().resolveString('{{missing'),'UNTERMINATED_PLACEHOLDER');
});
test('T03: cyclic references and depth/size limits prevent expansion runaway',()=>{
  mustError(()=>resolver({locals:{a:'{{b}}',b:'{{a}}'}}).resolveString('{{a}}'),'VARIABLE_CYCLE');
  mustError(()=>resolver({maxDepth:1}).resolveString('{{shared}}'),'LIMIT_EXCEEDED');
  mustError(()=>resolver({maxBytes:8}).resolveString('{{baseUrl}}'),'LIMIT_EXCEEDED');
});
test('T03: OAuth access token can only come from runtime callback',()=>{
  mustError(()=>resolver().resolveString('{{OAuthToken}}'),'OAUTH_ADAPTER_REQUIRED');
  let called='';
  const r=resolver({resolveOAuth:(name,config,source)=>{called=`${name}:${source?.filePath}:${String((config as {clientId:string}).clientId)}`;return 'runtime-token';}});
  assert.equal(r.resolveString('Bearer {{OAuthToken}}'),'Bearer runtime-token');
  assert.match(called,/dev.variables.json:dev/);
});
test('T03: language-service hover shares resolver, protected provenance and never authenticates OAuth',()=>{
  const ordinary=hoverVariable('shared',snapshot);
  assert.equal(ordinary?.preview,'"https://dev.test/customers"');
  assert.equal(ordinary?.origin,'/root/dev.variables.json');
  assert.equal(ordinary?.protected,true);
  const oauth=hoverVariable('OAuthToken',snapshot);
  assert.equal(oauth?.type,'oauth2');
  assert.match(oauth?.preview??'',/dev-id\.test/);
  assert.doesNotMatch(oauth?.preview??'',/runtime-token/);
});
test('T03: partial-document completion and diagnostics ignore unrelated JSON',()=>{
  const draft='{"request":{"url":"{{base';
  assert.ok(completeAt(draft,draft.length,'sample.request.json',snapshot).some(x=>x.label==='baseUrl'));
  assert.deepEqual(completeAt(draft,draft.length,'ordinary.json',snapshot),[]);
  const str='{{baseUrl}} then {{notDefined}}';
  assert.deepEqual(findPlaceholders(str).map(x=>x.name),['baseUrl','notDefined']);
  assert.deepEqual(diagnosePlaceholders(str,'sample.request.json',snapshot).map(x=>x.code),['UNDEFINED_VARIABLE']);
  assert.deepEqual(diagnosePlaceholders(str,'notes.json',snapshot),[]);
});
