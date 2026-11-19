#!/usr/bin/env node
import {readFile,readdir,lstat,realpath} from 'node:fs/promises';
import {importCurl} from '../../../packages/importers/src/curl.js';
import {importOpenApi} from '../../../packages/importers/src/openapi.js';
import {applyImportPlan} from '../../../packages/runtime-node/src/importers/apply.js';
import {discoverOAuthIssuer} from '../../../packages/runtime-node/src/oauth/discovery.js';
import {saveOAuthVariable} from '../../../packages/runtime-node/src/oauth/variable-writer.js';
import {createOAuthDefinition} from '../../../packages/core/src/oauth/discovery.js';
import {setVariableFileEnabled} from '../../../packages/runtime-node/src/variable-files.js';
import {basename,dirname,relative,resolve,sep,isAbsolute} from 'node:path';
import {loadVariableSnapshot} from '../../../packages/runtime-node/src/variable-files.js';
import {executeRequestFile} from '../../../packages/sdk-js/src/execution.js';
import {executeLoop} from '../../../packages/sdk-js/src/loop-execution.js';
import {executeRequestDirectory} from '../../../packages/runtime-node/src/execution/request-directory.js';
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
    if(['--root','--name','--file','--output-dir','--client-id','--issuer','--scopes'].includes(arg)){
      const value=args[++i];if(!value)throw new Error(`Falta valor para ${arg}`);
      values.set(arg,value);
    }else if(arg.startsWith('--')){
      if(!['--allow-http','--allow-private-network','--allow-protected','--show-sensitive','--help','--save','--overwrite','--apply','--dry-run','--allow-run','--allow-write','--allow-oauth-discovery','--allow-import-apply','--recursive'].includes(arg))throw new Error(`Flag desconhecida: ${arg}`);
      flags.add(arg);
    }else positional.push(arg);
  }
  return {positional,flags,values};
}
const help=`json-http — HTTP Engine (CLI MVP)
  json-http run ./file.request.json --root . [--allow-http] [--allow-private-network] [--allow-protected] [--show-sensitive]
  json-http run-dir ./folder --root . [--recursive] [--allow-http] [--allow-private-network] [--allow-protected]
  json-http list ./folder
  json-http variables explain ./file.request.json --root . --name baseUrl
  json-http variables activate ./dev.variables.json --root .
  json-http variables deactivate ./dev.variables.json --root .
  json-http oauth discover https://issuer.example --root . [--save --file ./dev.variables.json --name OAuthToken --client-id client --scopes read,write]
  json-http oauth save --issuer https://issuer.example --file ./dev.variables.json --name OAuthToken --client-id client --root .
  json-http import curl|bash|openapi --file ./input.txt --root . [--apply --output-dir ./folder]
  json-http mcp serve --root . [--allow-run] [--allow-write] [--allow-protected] [--allow-oauth-discovery] [--allow-import-apply]
  json-http --help

O Core é compartilhado; OAuth login/PKCE e OpenAPI YAML ainda não estão disponíveis.
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
  const controller=new AbortController();
  const interrupt=()=>controller.abort();
  process.once('SIGINT',interrupt);
  try {
  const options={
    signal:controller.signal,
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
  } finally {
    process.removeListener('SIGINT',interrupt);
  }
}
async function runDirectory(dirName:string,args:CliArguments):Promise<number>{
  const root=await realpath(resolve(args.values.get('--root')??'.'));
  const controller=new AbortController();
  const interrupt=()=>controller.abort();
  process.once('SIGINT',interrupt);
  try{
    const output=await executeRequestDirectory(resolve(dirName),{
      authorizedRoot:root,recursive:args.flags.has('--recursive'),signal:controller.signal,
      policy:{allowHttp:args.flags.has('--allow-http'),allowPrivateNetworks:args.flags.has('--allow-private-network')},
      approval:async()=>args.flags.has('--allow-protected'),
      revealSensitiveHeaders:args.flags.has('--show-sensitive'),
      onFile:event=>process.stderr.write(`HTTP ${event.ordinal}/${event.total}: ${event.file}\n`),
    });
    process.stdout.write(JSON.stringify(output,null,2)+'\n');
    return output.summary.status==='succeeded'?0:1;
  }finally{process.removeListener('SIGINT',interrupt);}
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
async function oauthCommand(action:string,args:CliArguments,issuerPos?:string):Promise<number>{
  if(action!=='discover'&&action!=='save')throw new Error('Operação OAuth desconhecida');
  const issuer=action==='discover'?issuerPos:args.values.get('--issuer');
  if(!issuer)throw new Error('OAuth issuer obrigatório');
  const plan=action==='discover'?await discoverOAuthIssuer(issuer):undefined;
  if(action==='discover'&&!args.flags.has('--save')){
    process.stdout.write(JSON.stringify(plan,null,2)+'\n');return 0;
  }
  const dest=args.values.get('--file'),name=args.values.get('--name'),clientId=args.values.get('--client-id');
  if(!dest||!name||!clientId)throw new Error('OAuth save exige --file, --name e --client-id');
  const root=await realpath(resolve(args.values.get('--root')??'.'));
  const definition=createOAuthDefinition({issuer:plan?.issuer??issuer},{clientId,scopes:args.values.get('--scopes')?.split(',').filter(Boolean)??[]});
  const saved=await saveOAuthVariable(definition,{targetFile:dest,variableName:name,authorizedRoot:root,overwrite:args.flags.has('--overwrite')});
  process.stdout.write(JSON.stringify({configurationSaved:true,...saved},null,2)+'\n');
  return 0;
}
async function importCommand(format:string,args:CliArguments,inline?:string):Promise<number>{
  if(format!=='curl'&&format!=='bash'&&format!=='openapi')throw new Error('Formato de importação não suportado');
  const root=await realpath(resolve(args.values.get('--root')??'.'));
  const file=args.values.get('--file');
  if(!file&&!inline)throw new Error('Fornecer texto de importação ou --file');
  let source=inline;
  if(file){
    const path=resolve(file);assertInside(root,path);
    const stat=await lstat(path);
    if(!stat.isFile()||stat.isSymbolicLink())throw new Error('Arquivo de importação inválido');
    assertInside(root,await realpath(path));
    source=await readFile(path,'utf8');
  }
  const plan=format==='openapi'?importOpenApi(source!):importCurl(source!,format);
  if(args.flags.has('--apply')){
    const output=args.values.get('--output-dir');
    if(!output)throw new Error('--apply exige --output-dir');
    const files=await applyImportPlan(plan,output,root);
    process.stdout.write(JSON.stringify({files,warnings:plan.warnings},null,2)+'\n');
  }else process.stdout.write(JSON.stringify(plan,null,2)+'\n');
  return 0;
}
async function variableAction(action:string,file:string,args:CliArguments):Promise<number>{
  const root=await realpath(resolve(args.values.get('--root')??'.'));
  const result=await setVariableFileEnabled(resolve(file),action==='activate',root);
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
  return 0;
}
export async function cliMain(argv:string[]):Promise<number>{
  const args=parseArgs(argv);
  if(args.flags.has('--help') || args.positional.length===0){process.stdout.write(help);return 0;}
  const [action,...rest]=args.positional;
  if(action==='mcp'&&rest[0]==='serve'&&rest.length===1){
    const {startMcpFromCli}=await import('../../mcp-server/src/server.js');
    const mcpArgs:string[]=['--root',args.values.get('--root')??'.',...args.flags];
    await startMcpFromCli(mcpArgs);return 0;
  }
  if(action==='run' && rest.length===1)return run(rest[0]!,args);
  if(action==='run-dir' && rest.length===1)return runDirectory(rest[0]!,args);
  if(action==='list'&&rest.length===1)return list(rest[0]!);
  if(action==='oauth'&&rest[0]==='discover'&&rest.length===2)return oauthCommand('discover',args,rest[1]);
  if(action==='oauth'&&rest[0]==='save'&&rest.length===1)return oauthCommand('save',args);
  if(action==='import'&&rest.length>=1&&rest.length<=2)return importCommand(rest[0]!,args,rest[1]);
  if(action==='variables'&&['activate','deactivate'].includes(rest[0]??'')&&rest.length===2)return variableAction(rest[0]!,rest[1]!,args);
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
