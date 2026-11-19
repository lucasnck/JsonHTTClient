/** Refuse a desktop release that would depend on global Node or incomplete build outputs. */
import {existsSync,lstatSync,readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const config=JSON.parse(readFileSync(resolve(root,'apps/desktop/src-tauri/tauri.conf.json'),'utf8'));
const runtime=`apps/desktop/src-tauri/resources/runtime/${process.platform==='win32'?'node.exe':'node'}`;
const paths=[
  'dist/apps/desktop/src/sidecar.js',
  'apps/desktop/ui/dist/index.html',
  runtime,
  'apps/desktop/src-tauri/src/main.rs',
];
const missing=paths.filter(path=>!existsSync(resolve(root,path)));
const errors=[...missing.map(x=>`Missing ${x}`)];
if(config.bundle?.active!==true)errors.push('Tauri bundle.active must be true');
if(config.bundle?.resources?.['../../../dist/']!=='dist/')errors.push('Tauri must embed dist/ as resource dist/');
if(config.bundle?.resources?.['resources/runtime/']!=='runtime/')errors.push('Tauri must embed Node as resource runtime/');
if(!missing.includes(runtime)){
  const path=resolve(root,runtime);
  if(lstatSync(path).isSymbolicLink())errors.push('Bundled runtime must not be symlink');
  else {
    const check=spawnSync(path,['-p','JSON.stringify([process.platform,process.arch,Number(process.versions.node.split(".")[0])])'],{
      encoding:'utf8',timeout:8000,shell:false,windowsHide:true,
    });
    try{
      const result=JSON.parse(check.stdout??'');
      if(check.status!==0||result[0]!==process.platform||result[1]!==process.arch||result[2]<22){
        errors.push('Bundled Node must run on the build OS/arch and be v22+');
      }
    }catch{errors.push('Bundled Node could not execute as expected');}
  }
}
if(errors.length){
  console.error('Desktop bundle NOT READY:\n'+errors.map(s=>`  - ${s}`).join('\n'));
  process.exitCode=1;
}else{
  console.log('Desktop bundle input verification PASS: engine, UI and local Node runtime. Native Tauri build and platform smoke tests are still required.');
}
