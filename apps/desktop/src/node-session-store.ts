/**
 * Development adapter for F06. A Tauri host must choose an app-data directory
 * OUTSIDE the workspace. The session JSON is not an OAuth credential store.
 */
import {mkdir,lstat,readFile,rename,unlink,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join,resolve} from 'node:path';
import type {PersistedWorkspaceSession,SessionStore} from './tab-sessions.js';
const MAX_BYTES=2*1024*1024;
export class NodeDesktopSessionStore implements SessionStore {
  private readonly dir:string;
  private readonly file:string;
  constructor(appDataDirectory:string,workspaceId:string){
    if(!/^[a-zA-Z0-9_-]{1,80}$/.test(workspaceId))throw new Error('Invalid workspace identity');
    this.dir=resolve(appDataDirectory);
    this.file=join(this.dir,`session-${workspaceId}.json`);
  }
  async read():Promise<unknown>{
    try{
      const entry=await lstat(this.file);
      if(!entry.isFile()||entry.isSymbolicLink()||entry.size>MAX_BYTES)throw new Error('Invalid stored session file');
      return JSON.parse(await readFile(this.file,'utf8')) as unknown;
    }catch(e){if(e instanceof Error&&'code' in e&&e.code==='ENOENT')return null;throw e;}
  }
  async write(snapshot:PersistedWorkspaceSession):Promise<void>{
    const serialized=JSON.stringify(snapshot);
    if(Buffer.byteLength(serialized,'utf8')>MAX_BYTES)throw new Error('Desktop session is too large');
    await mkdir(this.dir,{recursive:true,mode:0o700});
    const temp=join(this.dir,`.session-${randomUUID()}.tmp`);
    try{
      await writeFile(temp,serialized+'\n',{flag:'wx',mode:0o600});
      const target=await lstat(this.file).catch(e=>{
        if(e instanceof Error&&'code' in e&&e.code==='ENOENT')return null;
        throw e;
      });
      if(target && (!target.isFile()||target.isSymbolicLink()))throw new Error('Unsafe desktop session destination');
      await rename(temp,this.file);
    }finally{await unlink(temp).catch(()=>undefined);}
  }
}
