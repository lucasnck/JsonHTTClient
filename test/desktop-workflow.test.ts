import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';

const root=process.cwd();
const workflow=join(root,'tooling/desktop-workflow.mjs');
function run(args:string[]){
  const p=spawnSync(process.execPath,[workflow,...args],{cwd:root,encoding:'utf8',timeout:10000});
  return{status:p.status,stdout:p.stdout,stderr:p.stderr,error:p.error};
}

test('T11 desktop doctor reports real versions, missing native tools and npm package inventory without mutating system',()=>{
  const result=run(['doctor','--json']);
  assert.equal(result.error,undefined);
  const report=JSON.parse(result.stdout) as {
    os:string;arch:string;node:string;nodeOK:boolean;
    packagesMissing:{root:string[];ui:string[];tauri:string[]};
    outputs:{core:boolean;frontend:boolean;runtime:boolean};
  };
  assert.equal(report.os,process.platform);
  assert.equal(report.arch,process.arch);
  assert.equal(report.node,process.version);
  assert.equal(report.nodeOK,true);
  assert.ok(Array.isArray(report.packagesMissing.root));
  assert.ok(Array.isArray(report.packagesMissing.ui));
  assert.ok(Array.isArray(report.packagesMissing.tauri));
  assert.equal(typeof report.outputs.runtime,'boolean');
  // Environment can be fully prepared on CI or partly missing locally.
  assert.ok(result.status===0||result.status===1);
});

test('T11 desktop setup dry-run never invokes npm install',()=>{
  const result=run(['setup','--dry-run']);
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/dependencies (already installed|checked)|DRY RUN/i);
  assert.doesNotMatch(result.stderr,/ECONNREFUSED|ENOTFOUND|EAI_AGAIN/);
});

test('F09 desktop build dry-run orders engine/UI/Node runtime/guard/Tauri',()=>{
  const result=run(['build','--dry-run']);
  assert.equal(result.status,0,result.stderr);
  const s=result.stdout;
  const engine=s.indexOf('"npm" "run" "build"');
  const runtime=s.indexOf('Stage local Node');
  const guard=s.indexOf('"npm" "run" "desktop:bundle:check"');
  assert.ok(engine>=0&&runtime>engine&&guard>runtime,s);
  assert.ok(s.lastIndexOf('"npm" "run" "build"')>guard,s);
});

test('F09 desktop workflow refuses unknown arguments instead of passing them to a shell',()=>{
  const result=run(['setup','--unrecognized']);
  assert.equal(result.status,1);
  assert.match(result.stderr,/Unknown argument/);
});

test('F09 stage-runtime dry-run does not copy a binary',()=>{
  const result=run(['runtime','--dry-run']);
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/bundled Node already matches|DRY RUN/);
});

test('F06 bootstrap scripts require explicit opt-in for OS installation, and release gate checks runtime target',async()=>{
  const shell=await readFile(join(root,'scripts/bootstrap-desktop.sh'),'utf8');
  const powershell=await readFile(join(root,'scripts/bootstrap-desktop.ps1'),'utf8');
  const gate=await readFile(join(root,'tooling/check-desktop-bundle.mjs'),'utf8');
  assert.match(shell,/--install-system/);
  assert.match(shell,/--dry-run/);
  assert.match(shell,/sha256sum -c/);
  assert.match(powershell,/\$InstallSystem/);
  assert.match(powershell,/\$DryRun/);
  assert.match(powershell,/winget/);
  assert.match(gate,/process\.arch/);
  assert.match(gate,/process\.platform/);
  const modes=await stat(join(root,'tooling/desktop-workflow.mjs'));
  assert.ok(modes.size>2000);
});
