/** Minimal deterministic VSIX/ZIP packager. No external npm/zip executable needed. */
import {readFile,writeFile,readdir,mkdir} from 'node:fs/promises';
import {join,resolve,relative,sep} from 'node:path';
const cwd=process.cwd();
const ext=JSON.parse(await readFile(join(cwd,'apps/vscode/package.json'),'utf8'));
const root=resolve(cwd,'dist');
const entries=[];
const add=(filename,data)=>entries.push({name:filename,data:Buffer.isBuffer(data)?data:Buffer.from(data,'utf8')});
const xmlEscape=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const manifest=`<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
 <Metadata>
  <Identity Id="${xmlEscape(ext.name)}" Version="${xmlEscape(ext.version)}" Publisher="${xmlEscape(ext.publisher)}" />
  <DisplayName>${xmlEscape(ext.displayName)}</DisplayName>
  <Description xml:space="preserve">${xmlEscape(ext.description)}</Description>
  <Categories>${xmlEscape(ext.categories.join(','))}</Categories>
  <Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="${xmlEscape(ext.engines.vscode)}" /><Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" /></Properties>
 </Metadata>
 <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" /></Installation>
 <Dependencies />
 <Assets>
  <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
  <Asset Type="Microsoft.VisualStudio.Code.Contents" Path="extension" Addressable="true" />
 </Assets>
</PackageManifest>`;
add('extension.vsixmanifest',manifest);
add('_rels/.rels','<?xml version="1.0" encoding="utf-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="R1" Type="http://schemas.microsoft.com/developer/vsx-schema/2011/vsixmanifest" Target="/extension.vsixmanifest" /></Relationships>');
add('[Content_Types].xml','<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="js" ContentType="application/javascript"/><Default Extension="json" ContentType="application/json"/><Default Extension="md" ContentType="text/markdown"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="vsixmanifest" ContentType="text/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>');
add('extension/package.json',JSON.stringify(ext,null,2)+'\n');
add('extension/README.md',await readFile(join(cwd,'apps/vscode/README.md')));
for(const schema of ['request-file.schema.json','variables-file.schema.json']){
  add('extension/contracts/'+schema,await readFile(join(cwd,'contracts',schema)));
}
async function gather(dir){
  for(const file of await readdir(dir,{withFileTypes:true})){
    const path=join(dir,file.name);
    if(file.isDirectory())await gather(path);
    else if(file.isFile()&&file.name.endsWith('.js')){
      add('extension/dist/'+relative(root,path).split(sep).join('/'),await readFile(path));
    }
  }
}
await gather(join(root,'packages'));
await gather(join(root,'apps/vscode'));
for(const path of [ext.main.replace(/^\.\//,''),'contracts/request-file.schema.json','contracts/variables-file.schema.json']){
  if(!entries.some(x=>x.name==='extension/'+path))throw new Error('VSIX sem asset declarado: '+path);
}
const crcTable=Array.from({length:256},(_,i)=>{let v=i;for(let j=0;j<8;j++)v=(v&1)?(0xEDB88320^(v>>>1)):(v>>>1);return v>>>0;});
function crc32(bytes){let crc=0xffffffff;for(const byte of bytes)crc=crcTable[(crc^byte)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}
const files=[];const central=[];let offset=0;
const fixedDate=(1<<5)|1; // 1980-01-01, reproducible ZIP timestamps.
for(const {name,data} of entries){
  const filename=Buffer.from(name,'utf8');const crc=crc32(data);
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(0x0800,6);local.writeUInt16LE(0,8);local.writeUInt16LE(0,10);local.writeUInt16LE(fixedDate,12);
  local.writeUInt32LE(crc,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(filename.length,26);
  files.push(local,filename,data);
  const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50,0);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt16LE(0x0800,8);c.writeUInt16LE(0,10);c.writeUInt16LE(0,12);c.writeUInt16LE(fixedDate,14);
  c.writeUInt32LE(crc,16);c.writeUInt32LE(data.length,20);c.writeUInt32LE(data.length,24);c.writeUInt16LE(filename.length,28);c.writeUInt32LE(0,38);c.writeUInt32LE(offset,42);
  central.push(c,filename);offset+=local.length+filename.length+data.length;
}
const centralLength=central.reduce((n,b)=>n+b.length,0);
const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(centralLength,12);end.writeUInt32LE(offset,16);
const out=resolve(cwd,'artifacts',`${ext.name}-${ext.version}.vsix`);await mkdir(resolve(cwd,'artifacts'),{recursive:true});
await writeFile(out,Buffer.concat([...files,...central,end]));
process.stdout.write(`VSIX criado: ${out} (${entries.length} arquivos)\n`);
