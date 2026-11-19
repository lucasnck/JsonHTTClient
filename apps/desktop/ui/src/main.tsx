import React from 'react';
import {createRoot} from 'react-dom/client';
import {App} from './App';
import {loader} from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
// Avoid Monaco CDN loading: all assets must be included in the desktop bundle.
const workerScope=self as unknown as {MonacoEnvironment:{getWorker:(moduleId:string,label:string)=>Worker}};
workerScope.MonacoEnvironment={getWorker:(_moduleId,label)=>label==='json'?new JsonWorker():new EditorWorker()};
loader.config({monaco});
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App/></React.StrictMode>,
);
