/**
 * F06: narrow JSON-line protocol for the Tauri host. No shell execution, no
 * network requests from the webview, no long-lived network listener.
 */
import {lstat,readdir,realpath} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {basename,isAbsolute,relative,resolve,sep} from 'node:path';
import {DesktopTabSessions} from './tab-sessions.js';
import {createNodeDesktopBridge} from './node-bridge.js';
import {NodeDesktopSessionStore} from './node-session-store.js';
import {isVariablesFileName} from '../../../packages/core/src/variables/variables.js';
import {setVariableFileEnabled} from '../../../packages/runtime-node/src/variable-files.js';
import {importCurl} from '../../../packages/importers/src/curl.js';
import {importOpenApi} from '../../../packages/importers/src/openapi.js';
import {applyImportPlan} from '../../../packages/runtime-node/src/importers/apply.js';
import type {ImportFormat,ImportPlan} from '../../../packages/importers/src/import-plan.js';
import type {HttpNetworkPolicy} from '../../../packages/core/src/security/policies.js';

export interface DesktopPacket {id:string;op:string;args?:unknown}
export type DesktopMessage =
  | {id:string;ok:true;result:unknown}
  | {id:string;ok:false;error:{code:string}}
  | {event:'progress';id:string;message:string};
export interface DesktopProtocolOptions {
  root:string;
  appData:string;
  policy?:HttpNetworkPolicy;
  /** Only the privileged host can grant this, never a packet argument. */
  importWriteEnabled?:boolean;
  emit:(message:DesktopMessage)=>void;
}
const MAX_MESSAGE_BYTES=2*1024*1024;
const isRecord=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value);
const str=(input:unknown,name:string,limit=8192,allowEmpty=false):string=>{
  if(typeof input!=='string'||(!allowEmpty&&!input)||input.length>limit)throw new ProtocolError('INVALID_ARGUMENT',`Invalid ${name}`);
  return input;
};
const argsObject=(value:unknown):Record<string,unknown>=>{
  if(value===undefined)return {};
  if(!isRecord(value))throw new ProtocolError('INVALID_ARGUMENT','Expected args object');
  return value;
};
class ProtocolError extends Error {
  constructor(readonly code:string,message:string){super(message);this.name='ProtocolError';}
}
export function workspaceId(root:string):string{return createHash('sha256').update(root).digest('hex').slice(0,24);}
export async function createDesktopProtocol(options:DesktopProtocolOptions){
  const root=await realpath(resolve(options.root));
  const appData=resolve(options.appData);
  const relData=relative(root,appData);
  if(!relData.startsWith('..'+sep)&&relData!=='..'&&!isAbsolute(relData))
    throw new ProtocolError('INVALID_APP_DATA','Session storage must not be inside workspace');
  const bridge=await createNodeDesktopBridge({root,...(options.policy?{policy:options.policy}:{})});
  // No approval adapter: protected files fail closed. A host-owned native approval
  // handshake is needed before enabling protected execution in Tauri.
  const sessions=new DesktopTabSessions(bridge,new NodeDesktopSessionStore(appData,workspaceId(root)));
  const plans=new Map<string,ImportPlan>();
  const allowedOperations=new Set(['restore','state','list','open','edit','select','run','stop','close','saveAs','importPreview','importApply','activateVariables','deactivateVariables']);
  async function authorizedFolder(input:unknown):Promise<string>{
    const path=resolve(str(input,'folder'));
    const rel=relative(root,path);
    if(rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))throw new ProtocolError('OUTSIDE_ROOT','Folder outside workspace');
    const st=await lstat(path);
    if(!st.isDirectory()||st.isSymbolicLink())throw new ProtocolError('UNSAFE_FOLDER','Not a regular folder');
    const real=await realpath(path);
    const phys=relative(root,real);
    if(phys==='..'||phys.startsWith('..'+sep)||isAbsolute(phys))throw new ProtocolError('OUTSIDE_ROOT','Folder outside workspace');
    return real;
  }
  function state(){return{tabs:sessions.openTabs,activeTabId:sessions.activeTabId};}
  async function dispatch(packet:DesktopPacket):Promise<void>{
    const id=typeof packet?.id==='string'&&/^[A-Za-z0-9_-]{1,90}$/.test(packet.id)?packet.id:'';
    if(!id){options.emit({id:'invalid',ok:false,error:{code:'INVALID_ID'}});return;}
    try{
      if(!allowedOperations.has(packet.op))throw new ProtocolError('UNKNOWN_OPERATION','Unknown operation');
      const arg=argsObject(packet.args);
      let result:unknown;
      switch(packet.op){
        case 'restore':await sessions.restore();result=state();break;
        case 'state':result=state();break;
        case 'list':{
          const dir=await authorizedFolder(arg.folder??root);
          const names=await readdir(dir,{withFileTypes:true});
          if(names.length>2000)throw new ProtocolError('TOO_MANY_FILES','Directory too large');
          const items=names.filter(item=>!item.isSymbolicLink() && (item.isDirectory()||item.isFile()&&(
            item.name.endsWith('.request.json')||isVariablesFileName(item.name)))).map(item=>({
              path:resolve(dir,item.name),name:item.name,kind:item.isDirectory()?'folder':isVariablesFileName(item.name)?'variables':'request',
            })).sort((a,b)=>a.name.localeCompare(b.name));
          result={folder:dir,items};break;
        }
        case 'open':{
          const path=str(arg.path,'request path');
          if(!basename(path).endsWith('.request.json'))throw new ProtocolError('NOT_REQUEST_FILE','Only request JSON files may be opened');
          await sessions.openRequest(path);result=state();break;
        }
        case 'edit':sessions.editTab(str(arg.tabId,'tab id'),str(arg.content,'editor content',1024*1024,true));result=state();break;
        case 'select':await sessions.selectTab(str(arg.tabId,'tab id'));result=state();break;
        case 'run':{
          const tabId=str(arg.tabId,'tab id');
          await sessions.run(tabId,message=>options.emit({event:'progress',id,message}));
          result=state();break;
        }
        case 'stop':result={stopped:sessions.stop(str(arg.tabId,'tab id'))};break;
        case 'close':await sessions.close(str(arg.tabId,'tab id'));result=state();break;
        case 'saveAs':await sessions.saveResponseAs(str(arg.tabId,'tab id'),str(arg.path,'destination'));result=state();break;
        case 'activateVariables':
        case 'deactivateVariables':{
          const path=str(arg.path,'variable file');
          if(!isVariablesFileName(basename(path)))throw new ProtocolError('INVALID_VARIABLE_FILE','Invalid variable file');
          result=await setVariableFileEnabled(path,packet.op==='activateVariables',root);break;
        }
        case 'importPreview':{
          const format=str(arg.format,'format',40) as ImportFormat;
          if(!['curl','bash','openapi'].includes(format))throw new ProtocolError('INVALID_FORMAT','Unsupported format');
          const text=str(arg.text,'import text',512*1024);
          const plan=format==='openapi'?importOpenApi(text):importCurl(text,format);
          // The plan is scoped to the current process and never stored on disk.
          const planId=randomUUID();
          plans.clear();plans.set(planId,plan);
          result={planId,plan};break;
        }
        case 'importApply':{
          if(!options.importWriteEnabled)throw new ProtocolError('IMPORT_APPLY_NOT_AUTHORIZED','Host did not authorize file creation');
          const planId=str(arg.planId,'preview identifier');
          const plan=plans.get(planId);
          if(!plan)throw new ProtocolError('PREVIEW_REQUIRED','Preview must be generated first');
          const folder=await authorizedFolder(arg.folder);
          plans.delete(planId); // single use, including on failure
          const files=await applyImportPlan(plan,folder,root);
          result={files};break;
        }
        default:throw new ProtocolError('UNKNOWN_OPERATION','Unknown operation');
      }
      options.emit({id,ok:true,result});
    }catch(error){
      // Never serialize raw error messages (may contain secrets, URLs, paths).
      const code=error instanceof ProtocolError?error.code:error instanceof Error&&'code' in error&&typeof error.code==='string'&&/^[A-Z_]+$/.test(error.code)?error.code:'OPERATION_FAILED';
      options.emit({id,ok:false,error:{code}});
    }
  }
  return {root,dispatch};
}
export function maxDesktopProtocolBytes():number{return MAX_MESSAGE_BYTES;}
