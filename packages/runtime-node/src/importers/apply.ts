import {realpath,lstat,writeFile,unlink} from 'node:fs/promises';
import {basename,join,relative,sep,isAbsolute,resolve} from 'node:path';
import {validateRequestFile} from '../../../core/src/contracts/validation.js';
import {ImportError} from '../../../importers/src/import-plan.js';
import type {ImportPlan} from '../../../importers/src/import-plan.js';
/** Explicit Apply; atomic no-overwrite creation with best-effort rollback. Never executes imported content. */
export async function applyImportPlan(plan:ImportPlan,outputDir:string,authorizedRoot:string):Promise<string[]>{
  const root=await realpath(resolve(authorizedRoot)),folder=await realpath(resolve(outputDir));
  const rel=relative(root,folder);
  if(rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))throw new ImportError('WRITE_FAILED','Destino fora do root');
  const created:string[]=[];
  try{
    for(const {filename,file} of plan.operations){
      if(basename(filename)!==filename||!filename.endsWith('.request.json'))throw new ImportError('UNSAFE_FILENAME','Filename inválido');
      const valid=validateRequestFile(file,filename);
      if(!valid.valid)throw new ImportError('INVALID_SOURCE',`Request gerada é inválida: ${filename}`);
      const target=join(folder,filename);
      try{await lstat(target);throw new ImportError('WRITE_FAILED',`Arquivo já existe: ${filename}`);}
      catch(error){if(!(error instanceof Error&&'code' in error&&error.code==='ENOENT'))throw error;}
      await writeFile(target,JSON.stringify(file,null,2)+'\n',{flag:'wx',mode:0o600});
      created.push(target);
    }
    return created;
  }catch(error){for(const p of created.reverse())await unlink(p).catch(()=>undefined);throw error;}
}
