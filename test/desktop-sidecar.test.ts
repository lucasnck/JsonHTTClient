import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import {createDesktopProtocol} from '../apps/desktop/src/sidecar-protocol.js';
import type {DesktopMessage} from '../apps/desktop/src/sidecar-protocol.js';

const makeWorkspace=async()=>{
  const root=await mkdtemp(join(tmpdir(),'jhc-sidecar-'));
  const appData=await mkdtemp(join(tmpdir(),'jhc-appdata-'));
  await mkdir(join(root,'examples'));
  return{root,appData,cleanup:async()=>{await rm(root,{recursive:true,force:true});await rm(appData,{recursive:true,force:true});}};
};
class SidecarClient {
  private sequence=0;
  readonly output:DesktopMessage[]=[];
  private readonly waiting=new Map<string,{resolve:(value:DesktopMessage)=>void,reject:(error:Error)=>void}>();
  constructor(readonly child:ReturnType<typeof spawn>){
    const lines=createInterface({input:child.stdout!,crlfDelay:Infinity});
    lines.on('line',(text)=>{
      let packet:DesktopMessage;try{packet=JSON.parse(text) as DesktopMessage;}catch{return;}
      this.output.push(packet);
      if('event' in packet)return;
      const deferred=this.waiting.get(packet.id);
      if(deferred){this.waiting.delete(packet.id);deferred.resolve(packet);}
    });
    child.on('exit',()=>{
      for(const waiter of this.waiting.values())waiter.reject(new Error('Sidecar exited'));
      this.waiting.clear();
    });
  }
  async send(op:string,args:Record<string,unknown>={}):Promise<DesktopMessage>{
    const id=`test-${++this.sequence}`;
    const answer=new Promise<DesktopMessage>((resolve,reject)=>this.waiting.set(id,{resolve,reject}));
    this.child.stdin!.write(JSON.stringify({id,op,args})+'\n');
    return answer;
  }
  close(){this.child.stdin!.end();}
}
function startClient(root:string,appData:string,flags:string[]=[]){
  return new SidecarClient(spawn(process.execPath,[join(process.cwd(),'dist/apps/desktop/src/sidecar.js'),'--root',root,'--app-data',appData,...flags],{stdio:['pipe','pipe','pipe']}));
}
function ok(message:DesktopMessage):any{
  assert.equal('ok' in message&&message.ok,true,JSON.stringify(message));
  return (message as Extract<DesktopMessage,{ok:true}>).result;
}

test('F06 sidecar lists files, runs via shared engine, restores without rerunning and saves response',async()=>{
  const w=await makeWorkspace();
  let count=0;
  const server=createServer((_req,res)=>{count++;res.end(JSON.stringify({ok:true}));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const client=startClient(w.root,w.appData,['--allow-http','--allow-private-network']);
  try{
    const request=join(w.root,'examples','hello.request.json');
    await writeFile(request,JSON.stringify({request:{method:'GET',url:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,headers:[{name:'Authorization',value:'Bearer test-secret'}]}}));
    const list=ok(await client.send('list',{folder:join(w.root,'examples')}));
    assert.deepEqual(list.items.map((i:{name:string})=>i.name),['hello.request.json']);
    const first=ok(await client.send('open',{path:request}));
    assert.equal(first.tabs.length,1);const tabId=first.activeTabId;
    const after=ok(await client.send('run',{tabId}));
    assert.equal(after.tabs.length,2);
    const json=after.tabs[1].content as string;
    assert.match(json,/'status':?\s*200|"status":\s*200/);
    assert.match(json,/\[REDACTED\]/);assert.doesNotMatch(json,/test-secret/);
    assert.equal(count,1);
    await client.send('edit',{tabId:after.tabs[1].id,content:'{ edited by user }'});
    await client.send('saveAs',{tabId:after.tabs[1].id,path:join(w.root,'examples','output.json')});
    assert.equal(await readFile(join(w.root,'examples','output.json'),'utf8'),'{ edited by user }');
    const closed=ok(await client.send('close',{tabId:after.tabs[1].id}));
    assert.equal(closed.tabs.length,1);
    client.close();
    await new Promise<void>(resolve=>client.child.once('exit',()=>resolve()));
    const restored=startClient(w.root,w.appData);
    try{
      const snapshot=ok(await restored.send('restore'));
      assert.equal(snapshot.tabs.length,1);
      assert.equal(snapshot.tabs[0].id,tabId);
      assert.equal(count,1,'Restoring a request must not execute HTTP');
    }finally{restored.child.kill();}
  }finally{client.child.kill();await new Promise<void>(resolve=>server.close(()=>resolve()));await w.cleanup();}
});

test('F06 sidecar confines paths and denies protected requests and arbitrary operations',async()=>{
  const w=await makeWorkspace();
  const messages:DesktopMessage[]=[];
  try{
    const p=await createDesktopProtocol({root:w.root,appData:w.appData,emit:m=>messages.push(m)});
    const protectedFile=join(w.root,'a.variables.json');
    await writeFile(protectedFile,JSON.stringify({enabled:true,protected:true,baseUrl:'https://example.com'}));
    const request=join(w.root,'test.request.json');
    await writeFile(request,JSON.stringify({request:{method:'GET',url:'{{baseUrl}}'}}));
    await p.dispatch({id:'1',op:'open',args:{path:request}});
    const id=(messages.at(-1) as any).result.activeTabId;
    await p.dispatch({id:'2',op:'run',args:{tabId:id,approval:true}});
    assert.equal((messages.at(-1) as any).ok,false,'webview cannot approve protected files');
    await p.dispatch({id:'3',op:'open',args:{path:'/etc/passwd'}});
    assert.equal((messages.at(-1) as any).ok,false);
    await p.dispatch({id:'4',op:'executeShell',args:{command:'echo untrusted'}});
    assert.equal((messages.at(-1) as any).error.code,'UNKNOWN_OPERATION');
    await p.dispatch({id:'5',op:'importPreview',args:{format:'curl',text:'curl https://example.com'}});
    const preview=(messages.at(-1) as any).result;
    await p.dispatch({id:'6',op:'importApply',args:{planId:preview.planId,folder:w.root,confirmed:true}});
    assert.equal((messages.at(-1) as any).error.code,'IMPORT_APPLY_NOT_AUTHORIZED');
    assert.equal((await readdir(w.root)).some(x=>x.endsWith('.request.json')&&x!=='test.request.json'),false);
  }finally{await w.cleanup();}
});

test('F06 import plans are single-use, require host authorization and do not overwrite',async()=>{
  const w=await makeWorkspace();const messages:DesktopMessage[]=[];
  try{
    const p=await createDesktopProtocol({root:w.root,appData:w.appData,importWriteEnabled:true,emit:m=>messages.push(m)});
    await p.dispatch({id:'1',op:'importPreview',args:{format:'curl',text:'curl -H "Authorization: Bearer raw-token" https://example.com/hello'}});
    const preview=(messages.at(-1) as any).result;
    assert.equal(preview.plan.operations.length,1);
    assert.doesNotMatch(JSON.stringify(preview.plan),/raw-token/);
    await p.dispatch({id:'2',op:'importApply',args:{planId:preview.planId,folder:w.root}});
    assert.equal((messages.at(-1) as any).ok,true);
    const file=(messages.at(-1) as any).result.files[0] as string;
    assert.match(await readFile(file,'utf8'),/authorizationToken/);
    await p.dispatch({id:'3',op:'importApply',args:{planId:preview.planId,folder:w.root}});
    assert.equal((messages.at(-1) as any).error.code,'PREVIEW_REQUIRED');
  }finally{await w.cleanup();}
});

test('F06 sidecar supports concurrent Stop while a request is in flight',async()=>{
  const w=await makeWorkspace();let hits=0;
  const server=createServer((_req,res)=>{hits++;setTimeout(()=>{if(!res.writableEnded)res.end('late');},800);});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const client=startClient(w.root,w.appData,['--allow-http','--allow-private-network']);
  try{
    const file=join(w.root,'slow.request.json');
    await writeFile(file,JSON.stringify({request:{method:'GET',url:`http://127.0.0.1:${(server.address() as AddressInfo).port}`}}));
    const tab=ok(await client.send('open',{path:file})).activeTabId;
    const run=client.send('run',{tabId:tab});
    // The JSON line protocol does not block on run, allowing Stop concurrently.
    const stop=await client.send('stop',{tabId:tab});
    assert.equal(ok(stop).stopped,true);
    const final=await run;
    assert.equal('ok' in final&&final.ok,false);
    const state=ok(await client.send('state'));
    assert.deepEqual(state.tabs.map((x:{kind:string})=>x.kind),['request']);
    assert.ok(hits<=1);
  }finally{client.child.kill();await new Promise<void>(resolve=>server.close(()=>resolve()));await w.cleanup();}
});

test('F06 app-data inside workspace is rejected for session snapshots',async()=>{
  const w=await makeWorkspace();try{
    await assert.rejects(createDesktopProtocol({root:w.root,appData:join(w.root,'session'),emit:()=>{}}),/must not be inside workspace/);
  }finally{await w.cleanup();}
});
