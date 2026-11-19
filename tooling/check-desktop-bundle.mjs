/** Refuse a desktop release that would unexpectedly depend on global Node. */
import {existsSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
const root=process.cwd();
const config=JSON.parse(readFileSync(resolve(root,'apps/desktop/src-tauri/tauri.conf.json'),'utf8'));
const native=process.platform==='win32'?'node.exe':'node';
const paths=[
  'dist/apps/desktop/src/sidecar.js',
  'apps/desktop/ui/dist/index.html',
  `apps/desktop/src-tauri/resources/runtime/${native}`,
  'apps/desktop/src-tauri/src/main.rs',
];
const missing=paths.filter(path=>!existsSync(resolve(root,path)));
if(config.bundle.active!==true||missing.length){
  console.error(`Desktop bundle NOT READY: ${missing.join(', ')||'Invalid Tauri bundle config'}`);
  process.exitCode=1;
}else{
  console.log('Desktop bundle prerequisites found. Run Tauri native build and smoke tests before release.');
}
