/** Native VS Code desktop integration: no webviews, custom explorer or HTTP engine fork. */
import * as vscode from 'vscode';
import {readFile} from 'node:fs/promises';
import {basename} from 'node:path';
import {runEditorRequest} from './runner.js';
import {loadVariableSnapshot,setVariableFileEnabled} from '../../../packages/runtime-node/src/variable-files.js';
import {completeAt,diagnosePlaceholders,findPlaceholders,hoverVariable} from '../../../packages/language-service/src/language-service.js';
import {isVariablesFileName,validateVariablesFile} from '../../../packages/core/src/variables/variables.js';
import {validateRequestFile} from '../../../packages/core/src/contracts/validation.js';
import type {LoopEvent} from '../../../packages/sdk-js/src/loop-execution.js';
import type {ApprovalRequest} from '../../../packages/core/src/security/policies.js';

const requestMatcher={language:'json',scheme:'file',pattern:'**/*.request.json'} as const;
const variableMatcher={language:'json',scheme:'file',pattern:'**/*variables.json'} as const;
const active=new Map<number,AbortController>();
let nextExecution=0;

function localRoot(uri:vscode.Uri):string {
  if(uri.scheme!=='file' || !vscode.workspace.isTrusted)
    throw new Error('A extensão exige um workspace local confiável');
  const folder=vscode.workspace.getWorkspaceFolder(uri);
  if(!folder || folder.uri.scheme!=='file')throw new Error('Abra a request dentro de uma pasta do workspace');
  return folder.uri.fsPath;
}
function safeErrorMessage(error:unknown):string{
  // Avoid exposing raw request URLs, query parameters, OAuth credentials or server error bodies.
  if(error && typeof error==='object' && 'code' in error && typeof error.code==='string')return error.code;
  if(error instanceof SyntaxError)return 'INVALID_JSON';
  return 'A execução não foi concluída; verifique o JSON, as variáveis e as permissões';
}
async function approveProtected(data:ApprovalRequest):Promise<boolean>{
  const targets=data.destinations?.join(', ') || new URL(data.url).origin;
  const message=`${data.method} · ${targets}\nArquivos protected: ${data.protectedFiles.map(path=>basename(path)).join(', ')}${data.count?`\nIterações: ${data.count}`:''}`;
  const choice=await vscode.window.showWarningMessage(message,{modal:true,detail:'Autorizar somente esta execução?'},'Executar');
  return choice==='Executar';
}
function signalProgress(progress:vscode.Progress<{message?:string;increment?:number}>,event:LoopEvent){
  if(event.type==='iteration_started')progress.report({message:`Request ${event.ordinal}/${event.total}`});
  if(event.type==='batch_completed')progress.report({message:'Execução concluída'});
  if(event.type==='cancelled')progress.report({message:'Execução cancelada'});
}
async function runRequest(uri?:vscode.Uri):Promise<void>{
  try { await runTrustedRequest(uri); } catch(error) {void vscode.window.showErrorMessage(`HTTP Engine: ${safeErrorMessage(error)}`);}
}
async function runTrustedRequest(uri?:vscode.Uri):Promise<void>{
  const doc=uri ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
  if(!doc || !doc.fileName.endsWith('.request.json'))return;
  const root=localRoot(doc.uri);
  const id=++nextExecution;
  const controller=new AbortController();
  active.set(id,controller);
  await vscode.commands.executeCommand('setContext','jsonHttp.running',true);
  try {
    await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:`HTTP ${basename(doc.fileName)}`,cancellable:true},async(progress,token)=>{
      const subscription=token.onCancellationRequested(()=>controller.abort());
      try {
        const output=await runEditorRequest({
          requestPath:doc.uri.fsPath,authorizedRoot:root,text:doc.getText(),signal:controller.signal,
          policy:{
            allowHttp:vscode.workspace.getConfiguration('jsonHttp').get('allowHttp',false),
            allowPrivateNetworks:vscode.workspace.getConfiguration('jsonHttp').get('allowPrivateNetworks',false),
          },
          approval:approveProtected,
          onProgress:event=>signalProgress(progress,event),
        });
        // Untitled native JSON editors are fully editable and support Save As, without special guarding.
        const response=await vscode.workspace.openTextDocument({language:'json',content:output.json});
        await vscode.window.showTextDocument(response,{preview:false,viewColumn:vscode.ViewColumn.Beside,preserveFocus:false});
        if(output.warnings.length)void vscode.window.showWarningMessage(`HTTP: ${output.warnings.join(', ')}`);
      } finally {subscription.dispose();}
    });
  }catch(error){void vscode.window.showErrorMessage(`HTTP Engine: ${safeErrorMessage(error)}`);}
  finally{
    active.delete(id);
    await vscode.commands.executeCommand('setContext','jsonHttp.running',active.size>0);
  }
}
function stopRequests():void{for(const controller of active.values())controller.abort();}
async function updateVariable(uri:vscode.Uri|undefined,enabled:boolean,refresh:()=>void):Promise<void>{
  if(!uri || !isVariablesFileName(basename(uri.fsPath)))return;
  try {
    const root=localRoot(uri);
    await setVariableFileEnabled(uri.fsPath,enabled,root);
    refresh();
  }catch(error){void vscode.window.showErrorMessage(`Variáveis: ${safeErrorMessage(error)}`);}
}

async function snapshotFor(doc:vscode.TextDocument){
  return loadVariableSnapshot(doc.uri.fsPath,localRoot(doc.uri));
}
async function provideHover(doc:vscode.TextDocument,pos:vscode.Position):Promise<vscode.Hover|undefined>{
  try {
    const offset=doc.offsetAt(pos);
    const found=findPlaceholders(doc.getText()).find(span=>span.start<=offset&&span.end>=offset);
    if(!found)return undefined;
    const hover=hoverVariable(found.name,await snapshotFor(doc));
    if(!hover)return undefined;
    const message=new vscode.MarkdownString();
    message.isTrusted=false;
    message.appendMarkdown(`**${hover.name}** (${hover.type})\n\n`);
    message.appendText(`${hover.preview}\nOrigem: ${hover.origin}${hover.protected?' (protected)':''}`);
    return new vscode.Hover(message,new vscode.Range(doc.positionAt(found.start),doc.positionAt(found.end)));
  }catch{return undefined;}
}
async function provideCompletion(doc:vscode.TextDocument,pos:vscode.Position):Promise<vscode.CompletionItem[]>{
  try {
    const snapshot=await snapshotFor(doc);
    const suggestions=completeAt(doc.getText(),doc.offsetAt(pos),basename(doc.fileName),snapshot);
    return suggestions.map(s=>{
      const item=new vscode.CompletionItem(s.label,s.kind==='variable'?vscode.CompletionItemKind.Variable:vscode.CompletionItemKind.Property);
      item.detail=s.detail;
      return item;
    });
  }catch{return [];}
}
async function provideDiagnostics(doc:vscode.TextDocument,collection:vscode.DiagnosticCollection){
  if(!doc.fileName.endsWith('.request.json') || doc.uri.scheme!=='file')return;
  try{
    const diagnostics=diagnosePlaceholders(doc.getText(),basename(doc.fileName),await snapshotFor(doc));
    collection.set(doc.uri,diagnostics.map(x=>{
      const d=new vscode.Diagnostic(new vscode.Range(doc.positionAt(x.start),doc.positionAt(x.end)),x.message,vscode.DiagnosticSeverity.Warning);
      d.code=x.code;return d;
    }));
  }catch{collection.delete(doc.uri);}
}

/** File decorations are native built-in Explorer adornments; no duplicated TreeView. */
class MethodFileDecorations implements vscode.FileDecorationProvider {
  private readonly emitter=new vscode.EventEmitter<vscode.Uri|vscode.Uri[]|undefined>();
  readonly onDidChangeFileDecorations=this.emitter.event;
  refresh(){this.emitter.fire(undefined);}
  async provideFileDecoration(uri:vscode.Uri):Promise<vscode.FileDecoration|undefined>{
    if(uri.scheme!=='file')return undefined;
    const name=basename(uri.fsPath);
    if(!name.endsWith('.request.json') && !isVariablesFileName(name))return undefined;
    try{
      const parsed:unknown=JSON.parse(await readFile(uri.fsPath,'utf8'));
      if(isVariablesFileName(name)){
        const result=validateVariablesFile(parsed);
        if(!result.valid)return undefined;
        const enabled=result.value.enabled!==false;
        const protectedFile=result.value.protected===true;
        return new vscode.FileDecoration(protectedFile?'L':(enabled?'✓':'–'),new vscode.ThemeColor(enabled?'charts.green':'disabledForeground'),
          `Variáveis ${enabled?'ativas':'inativas'}${protectedFile?' · protected':''}`);
      }
      const validated=validateRequestFile(parsed,name);
      if(!validated.valid)return undefined;
      const method=validated.value.request.method.toUpperCase();
      const colors:Record<string,string>={GET:'charts.green',POST:'charts.orange',PUT:'charts.blue',PATCH:'charts.purple',DELETE:'charts.red'};
      return new vscode.FileDecoration(method[0],new vscode.ThemeColor(colors[method]??'foreground'),method);
    }catch{return undefined;}
  }
  dispose(){this.emitter.dispose();}
}

export function activate(context:vscode.ExtensionContext):void{
  const decorations=new MethodFileDecorations();
  const diagnostics=vscode.languages.createDiagnosticCollection('jsonHttp');
  context.subscriptions.push(
    decorations, diagnostics,
    vscode.window.registerFileDecorationProvider(decorations),
    vscode.commands.registerCommand('jsonHttp.run',runRequest),
    vscode.commands.registerCommand('jsonHttp.stop',stopRequests),
    vscode.commands.registerCommand('jsonHttp.activateVariables',(uri:vscode.Uri)=>updateVariable(uri,true,()=>decorations.refresh())),
    vscode.commands.registerCommand('jsonHttp.deactivateVariables',(uri:vscode.Uri)=>updateVariable(uri,false,()=>decorations.refresh())),
    vscode.languages.registerHoverProvider(requestMatcher,{provideHover}),
    vscode.languages.registerCompletionItemProvider(requestMatcher,{provideCompletionItems:provideCompletion},'{'),
    vscode.languages.registerCompletionItemProvider(variableMatcher,{provideCompletionItems:provideCompletion},'{'),
  );
  const watcher=vscode.workspace.createFileSystemWatcher('**/{variables.json,*.variables.json,*.request.json}');
  watcher.onDidChange(()=>decorations.refresh(),undefined,context.subscriptions);
  watcher.onDidCreate(()=>decorations.refresh(),undefined,context.subscriptions);
  watcher.onDidDelete(()=>decorations.refresh(),undefined,context.subscriptions);
  context.subscriptions.push(watcher);
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(e=>{void provideDiagnostics(e.document,diagnostics);}));
  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(doc=>{void provideDiagnostics(doc,diagnostics);}));
  for(const doc of vscode.workspace.textDocuments)void provideDiagnostics(doc,diagnostics);
}
export function deactivate():void{stopRequests();}
