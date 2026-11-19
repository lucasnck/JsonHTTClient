/** F06 webview side: only Tauri commands; NO Node, fs, fetch, shell or OAuth tokens. */
import {invoke} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';

export interface DesktopTab {
  id:string;
  kind:'request'|'response';
  title:string;
  requestPath:string|null;
  content:string;
  dirty:boolean;
  running:boolean;
  responseTo:string|null;
}
export interface DesktopState {tabs:DesktopTab[];activeTabId:string|null}
export interface ExplorerItem {path:string;name:string;kind:'folder'|'variables'|'request'}
export interface ExplorerListing {folder:string;items:ExplorerItem[]}
interface ResponsePacket {id:string;ok:boolean;result?:unknown;error?:{code:string}}
interface ProgressPacket {event:'progress';id:string;message:string}
type Packet=ResponsePacket|ProgressPacket;

/**
 * Install listener once before issuing requests. Correlated responses allow
 * Stop while a long-running request is pending; the privileged Tauri host owns
 * the filesystem and sidecar lifecycle.
 */
export class NativeDesktopBridge {
  private pending=new Map<string,{resolve:(value:unknown)=>void,reject:(error:Error)=>void}>();
  private progressListeners=new Set<(message:string)=>void>();
  private unlisten:(()=>void)|null=null;
  private counter=0;
  private lifecycle=0;
  private disconnected:(()=>void)|null=null;
  async connect():Promise<void>{
    const version=++this.lifecycle;
    const unlisten=await listen<Packet>('desktop-message',event=>{
      const data=event.payload;
      if('event' in data){
        if(data.event==='progress')this.progressListeners.forEach(listener=>listener(data.message));
        return;
      }
      const p=this.pending.get(data.id);
      if(!p)return;
      this.pending.delete(data.id);
      if(data.ok)p.resolve(data.result);
      else p.reject(new Error(data.error?.code??'DESKTOP_REQUEST_FAILED'));
    });
    if(version!==this.lifecycle){unlisten();return;}
    this.unlisten=unlisten;
    const disconnect=await listen('desktop-disconnected',()=>{
      for(const pending of this.pending.values())pending.reject(new Error('SIDECAR_DISCONNECTED'));
      this.pending.clear();
    });
    if(version!==this.lifecycle){disconnect();return;}
    this.disconnected=disconnect;
  }
  onProgress(fn:(message:string)=>void){this.progressListeners.add(fn);return()=>this.progressListeners.delete(fn);}
  async selectWorkspace():Promise<string|null>{
    return invoke<string|null>('desktop_choose_workspace');
  }
  async selectSaveDestination():Promise<string|null>{
    return invoke<string|null>('desktop_choose_save_file');
  }
  async send<T=unknown>(op:string,args:Record<string,unknown>={}):Promise<T>{
    const id=`ui-${++this.counter}`;
    const promise=new Promise<T>((resolve,reject)=>this.pending.set(id,{resolve:resolve as (v:unknown)=>void,reject}));
    try{await invoke('desktop_send',{packet:{id,op,args}});}catch(error){
      this.pending.get(id)?.reject(new Error(String(error)));
      this.pending.delete(id);
    }
    return promise;
  }
  dispose():void{
    this.lifecycle++;
    this.unlisten?.();this.unlisten=null;
    this.disconnected?.();this.disconnected=null;
    for(const waiter of this.pending.values())waiter.reject(new Error('DESKTOP_DISCONNECTED'));
    this.pending.clear();this.progressListeners.clear();
  }
}
