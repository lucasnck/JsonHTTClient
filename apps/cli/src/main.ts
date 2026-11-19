#!/usr/bin/env node
import {readFile,readdir,lstat,realpath} from 'node:fs/promises';
import {basename,dirname,relative,resolve,sep,isAbsolute} from 'node:path';
import {loadVariableSnapshot} from '../../../packages/runtime-node/src/variable-files.js';
import {executeRequestFile} from '../../../packages/sdk-js/src/execution.js';
import {executeLoop} from '../../../packages/sdk-js/src/loop-execution.js';
import {hoverVariable} from '../../../packages/language-service/src/language-service.js';
import {isVariablesFileName,validateVariablesFile} from '../../../packages/core/src/variables/variables.js';
import {validateRequestFile} from '../../../packages/core/src/contracts/validation.js';
import type {ExecutionBatchResult, RequestFile} from '../../../packages/core/src/contracts/types.js';

interface CliArguments { positional:string[]; flags:Set<string>; values:Map<string,string> }
function parseArgs(args:string[]):CliArguments {
  const positional:string[]=[];
  const flags=new Set<string>();
  const values=new Map<string,string>();
  for(let i=0;i<args.length;i++){
    const arg=args[i]!;
    if(['--root','--name'].includes(arg)){
      const value=args[++i];if(!value)throw new Error(`Falta valor para ${arg}`);
      values.set(arg,value);
    }else if(arg.startsWith('--')){
      if(!['--allow-http','--allow-private-network','--allow-protected','--show-sensitive','--help'].includes(arg))throw new Error(`Flag desconhecida: ${arg}`);
      flags.add(arg);
    }else positional.push(arg);
  }
  return {positional,flags,values};
}
const help=`json-http — HTTP Engine (CLI MVP)
  json-http run ./file.request.json --root . [--allow-http] [--allow-private-network] [--allow-protected] [--show-sensitive]
  json-http list ./folder
  json-http variables explain ./file.request.json --root . --name baseUrl
  json-http --help

O Core é compartilhado; esta CLI inicial não oferece ainda run-dir, OAuth login ou importadores.
`;
function assertInside(root:string,path:string){
  const rel=relative(root,path);
  if(rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))throw new Error('Caminho fora da raiz autorizada');
}
async function run(fileName:string,args:CliArguments):Promise<number>{
  const root=await realpath(resolve(args.values.get('--root')??'.'));
  const path=resolve(fileName);
  assertInside(root,path);
  const stat=await lstat(path);
  if(!stat.isFile() || stat.isSymbolicLink())throw new Error('Request deve ser arquivo real, sem symlink');
  assertInside(root,await realpath(path));
  const source=JSON.parse(await readFile(path,'utf8')) as unknown;
  const validation=validateRequestFile(source,basename(path));
  if(!validation.valid)throw new Error(validation.issues.map(i=>`${i.path}: ${i.message}`).join('; '));
  const file=validation.value as RequestFile;
  const snapshot=await loadVariableSnapshot(path,root);
  const options={
    snapshot,
    policy:{allowHttp:args.flags.has('--allow-http'),allowPrivateNetworks:args.flags.has('--allow-private-network')},
    approval:async()=>args.flags.has('--allow-protected'),
    requestPath:path,
    authorizedRoot:root,
  };
  if(file.loop){
    const batch=await executeLoop(file,{...options,onProgress:event=>{
      if(event.type==='iteration_started')process.stderr.write(`HTTP ${event.ordinal}/${event.total}\n`);
    }});
    const result:ExecutionBatchResult=args.flags.has('--show-sensitive')?{
      ...batch.result,
      results:batch.sessions.map(session=>session.viewOriginalHeaders()),
    }:batch.result;
    process.stdout.write(JSON.stringify(result,null,2)+'\n');
    if(batch.diagnostics.length)process.stderr.write(batch.diagnostics.map(x=>`[${x.ordinal}] ${x.code}: ${x.message}`).join('\n')+'\n');
    batch.dispose();
    return batch.result.summary.status==='succeeded'?0:1;
  }
  const session=await executeRequestFile(file,options);
  process.stdout.write(JSON.stringify(args.flags.has('--show-sensitive')?session.viewOriginalHeaders():session.result,null,2)+'\n');
  if(session.diagnostic)process.stderr.write(`${session.diagnostic.code}: ${session.diagnostic.message}\n`);
  const status=session.result.response?.status;
  const failed=!!session.diagnostic || (status!==undefined&&status>=400);
  session.dispose();
  return failed?1:0;
}
async function list(dirName:string):Promise<number>{
  const dir=resolve(dirName);const entries=await readdir(dir,{withFileTypes:true});
  const requests:string[]=[];
  const variables:Array<{file:string;enabled:boolean;protected:boolean;keys:string[]}>=[];
  for(const entry of entries){
    if(!entry.isFile())continue;
    if(entry.name.endsWith('.request.json'))requests.push(entry.name);
    if(isVariablesFileName(entry.name)){
      const parsed=validateVariablesFile(JSON.parse(await readFile(resolve(dir,entry.name),'utf8')) as unknown);
      if(!parsed.valid)throw new Error(`Variáveis inválidas: ${entry.name}`);
      variables.push({file:entry.name,enabled:parsed.value.enabled!==false,protected:parsed.value.protected===true,
        keys:Object.keys(parsed.value).filter(x=>x!=='enabled'&&x!=='protected')});
    }
  }
  process.stdout.write(JSON.stringify({requests:requests.sort(),variableFiles:variables.sort((a,b)=>a.file.localeCompare(b.file))},null,2)+'\n');
  return 0;
}
async function explain(requestPath:string,name:string,rootArg:string):Promise<number>{
  const root=await realpath(resolve(rootArg));
  const path=resolve(requestPath);assertInside(root,path);
  const snapshot=await loadVariableSnapshot(path,root);
  const hover=hoverVariable(name,snapshot);
  if(!hover)throw new Error(`Variável não encontrada: ${name}`);
  process.stdout.write(JSON.stringify(hover,null,2)+'\n');
  return 0;
}
export async function cliMain(argv:string[]):Promise<number>{
  const args=parseArgs(argv);
  if(args.flags.has('--help') || args.positional.length===0){process.stdout.write(help);return 0;}
  const [action,...rest]=args.positional;
  if(action==='run' && rest.length===1)return run(rest[0]!,args);
  if(action==='list'&&rest.length===1)return list(rest[0]!);
  if(action==='variables'&&rest[0]==='explain'&&rest.length===2 && args.values.get('--name')){
    return explain(rest[1]!,args.values.get('--name')!,args.values.get('--root')??'.');
  }
  throw new Error(`Comando inválido. Use --help`);
}
if(process.argv[1] && import.meta.url===new URL(`file://${resolve(process.argv[1])}`).href){
  cliMain(process.argv.slice(2)).then(code=>{process.exitCode=code;}).catch(error=>{
    // Avoid logging raw request, tokens, URLs with sensitive query parameters or stack traces.
    const safe=error instanceof Error&&'code' in error ? String((error as {code:unknown}).code) : 'INVALID_COMMAND';
    process.stderr.write(`json-http: ${safe} — operação não concluída\n`);
    process.exitCode=1;
  });
}
