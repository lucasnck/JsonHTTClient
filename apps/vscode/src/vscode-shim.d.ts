/** Temporary offline API shape for TypeScript checking. Replace with official @types/vscode
 * from the VS Code extension API before publishing the extension. Not a runtime polyfill. */
declare module 'vscode' {
  export interface Disposable {dispose():void}
  export type Event<T> = (listener:(event:T)=>unknown,thisArgs?:unknown,disposables?:Disposable[])=>Disposable;
  export class EventEmitter<T> implements Disposable {
    readonly event:Event<T>;
    fire(event:T):void;
    dispose():void;
  }
  export interface Uri {readonly scheme:string;readonly fsPath:string;readonly path:string}
  export interface WorkspaceFolder {readonly uri:Uri}
  export interface Position {readonly line:number;readonly character:number}
  export interface Range {readonly start:Position;readonly end:Position}
  export class Range {constructor(start:Position,end:Position)}
  export interface TextDocument {readonly uri:Uri;readonly fileName:string;getText():string;offsetAt(pos:Position):number;positionAt(offset:number):Position}
  export interface TextEditor {readonly document:TextDocument}
  export interface ExtensionContext {readonly subscriptions:Disposable[]}
  export class MarkdownString {isTrusted:boolean;appendMarkdown(value:string):void;appendText(value:string):void}
  export class Hover {constructor(content:MarkdownString|string,range?:Range)}
  export enum CompletionItemKind {Property=10,Variable=6}
  export class CompletionItem {constructor(label:string,kind?:CompletionItemKind);detail?:string}
  export class Diagnostic {constructor(range:Range,message:string,severity?:DiagnosticSeverity);code?:string|number}
  export enum DiagnosticSeverity {Warning=1}
  export interface DiagnosticCollection extends Disposable {set(uri:Uri,diagnostics:Diagnostic[]):void;delete(uri:Uri):void}
  export class ThemeColor {constructor(id:string)}
  export class FileDecoration {constructor(badge?:string,color?:ThemeColor,tooltip?:string)}
  export interface FileDecorationProvider {readonly onDidChangeFileDecorations?:Event<Uri|Uri[]|undefined>;provideFileDecoration(uri:Uri):FileDecoration|undefined|Promise<FileDecoration|undefined>}
  export interface Progress<T> {report(value:T):void}
  export interface CancellationToken {readonly isCancellationRequested:boolean;onCancellationRequested:Event<void>}
  export interface FileSystemWatcher extends Disposable {onDidChange:Event<Uri>;onDidCreate:Event<Uri>;onDidDelete:Event<Uri>}
  export enum ProgressLocation {Notification=15}
  export enum ViewColumn {Beside=-2}
  export namespace commands {function registerCommand(command:string,callback:(...args:any[])=>unknown):Disposable;function executeCommand<T=unknown>(command:string,...args:unknown[]):Thenable<T>}
  export namespace workspace {
    interface WorkspaceConfiguration {get<T>(section:string,defaultValue:T):T}
    function getConfiguration(section:string):WorkspaceConfiguration;
    const isTrusted:boolean;
    const textDocuments:readonly TextDocument[];
    function getWorkspaceFolder(uri:Uri):WorkspaceFolder|undefined;
    function openTextDocument(uri:Uri):Thenable<TextDocument>;
    function openTextDocument(options:{language:string;content:string}):Thenable<TextDocument>;
    function createFileSystemWatcher(glob:string):FileSystemWatcher;
    function onDidChangeTextDocument(listener:(e:{document:TextDocument})=>unknown):Disposable;
    function onDidOpenTextDocument(listener:(doc:TextDocument)=>unknown):Disposable;
  }
  export namespace window {
    const activeTextEditor:TextEditor|undefined;
    function showTextDocument(doc:TextDocument,options:{preview:boolean;viewColumn:ViewColumn;preserveFocus:boolean}):Thenable<TextEditor>;
    function showWarningMessage(message:string,...items:string[]):Thenable<string|undefined>;
    function showWarningMessage(message:string,options:{modal:boolean;detail?:string},...items:string[]):Thenable<string|undefined>;
    function showErrorMessage(message:string):Thenable<string|undefined>;
    function registerFileDecorationProvider(provider:FileDecorationProvider):Disposable;
    function withProgress<R>(options:{location:ProgressLocation;title:string;cancellable:boolean},task:(progress:Progress<{message?:string;increment?:number}>,token:CancellationToken)=>Thenable<R>|Promise<R>):Thenable<R>;
  }
  export namespace languages {
    function createDiagnosticCollection(name:string):DiagnosticCollection;
    function registerHoverProvider(selector:{language:string;scheme:string;pattern:string},provider:{provideHover:(doc:TextDocument,pos:Position)=>Promise<Hover|undefined>}):Disposable;
    function registerCompletionItemProvider(selector:{language:string;scheme:string;pattern:string},provider:{provideCompletionItems?:(doc:TextDocument,pos:Position)=>Promise<CompletionItem[]>;provideCompletion?:(doc:TextDocument,pos:Position)=>Promise<CompletionItem[]>},...triggerCharacters:string[]):Disposable;
  }
  interface Thenable<T> extends PromiseLike<T> {}
}
