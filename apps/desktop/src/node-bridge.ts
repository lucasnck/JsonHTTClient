/** Host-only bridge for developing and testing the Tauri desktop adapter. */
import {readFile,writeFile,lstat,realpath} from 'node:fs/promises';
import {relative,resolve,sep,isAbsolute,dirname} from 'node:path';
import {runEditorRequest} from '../../../packages/runtime-node/src/editor-execution.js';
import type {DesktopEngineBridge} from './tab-sessions.js';
import type {ApprovalRequest,HttpNetworkPolicy} from '../../../packages/core/src/security/policies.js';
export interface NodeDesktopBridgeOptions {
  readonly root:string;
  readonly policy?:HttpNetworkPolicy;
  readonly approval?:(request:ApprovalRequest,signal:AbortSignal)=>Promise<boolean>;
}
export async function createNodeDesktopBridge(options:NodeDesktopBridgeOptions):Promise<DesktopEngineBridge>{
  const root=await realpath(resolve(options.root));
  async function authorized(file:string,existing:boolean):Promise<string>{
    const path=resolve(file);const rel=relative(root,path);
    if(rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))throw new Error('OUTSIDE_ROOT');
    if(existing){const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('UNSAFE_PATH');
      const physical=await realpath(path);const p=relative(root,physical);
      if(p==='..'||p.startsWith('..'+sep)||isAbsolute(p))throw new Error('OUTSIDE_ROOT');}
    if(!existing){
      const parent=await realpath(dirname(path));const p=relative(root,parent);
      if(p==='..'||p.startsWith('..'+sep)||isAbsolute(p))throw new Error('OUTSIDE_ROOT');
    }
    return path;
  }
  return {
    async readRequest(path){return readFile(await authorized(path,true),'utf8');},
    async runRequest(requestPath,text,signal,onProgress){
      const path=await authorized(requestPath,true);
      const output=await runEditorRequest({requestPath:path,authorizedRoot:root,text,signal,onProgress:event=>{
        if(event.type==='iteration_started')onProgress(`${event.ordinal}/${event.total}`);
      },...(options.policy?{policy:options.policy}:{}),...(options.approval?{approval:(request:ApprovalRequest)=>options.approval!(request,signal)}:{})});
      return {json:output.json,warnings:output.warnings};
    },
    async saveAs(destination,content){
      // No general arbitrary write to untrusted paths. The Tauri host will expose an explicit save-dialog capability.
      const path=await authorized(destination,false);
      await writeFile(path,content,{flag:'wx',mode:0o600});
    },
  };
}
