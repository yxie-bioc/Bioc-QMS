import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
const source=process.cwd();
const windows=process.argv.includes('--windows');
if(windows && (process.platform!=='win32'||process.arch!=='x64'))throw new Error('Windows deliverables must be built and tested on Windows x64. Use --local for development verification.');
const pkg=JSON.parse(await fs.readFile('package.json','utf8'));
const pins=JSON.parse(await fs.readFile('packaging/runtimes.json','utf8'));
const name=windows?'BBC-QMS-Windows-x64':`BBC-QMS-${process.platform}-${process.arch}-test`;
const output=path.resolve('dist',name),cache=path.resolve('.cache','runtimes');
const run=(file,args,options={})=>new Promise((resolve,reject)=>{
 const c=spawn(file,args,{cwd:source,env:{...process.env,NEXT_TELEMETRY_DISABLED:'1'},shell:false,stdio:'inherit',...options});c.on('error',reject);c.on('exit',code=>code===0?resolve():reject(new Error(`${path.basename(file)} exited ${code}`)));
});
const hash=(data,alg='sha256',encoding='hex')=>createHash(alg).update(data).digest(encoding);
async function download(url,to,expected,alg='sha256',encoding='hex'){
 if(!await fs.access(to).then(()=>true,()=>false))await run(process.platform==='win32'?'curl.exe':'curl',['--fail','--location','--silent','--show-error','--retry','2','--max-time','180',url,'--output',to]);
 if(hash(await fs.readFile(to),alg,encoding)!==expected)throw new Error(`Checksum mismatch: ${path.basename(to)}`);
}
await fs.mkdir(cache,{recursive:true});
// The build works on a clean checkout. Never include an environment file in tracing.
for(const name of await fs.readdir(source))if(name.startsWith('.env')&&name!=='.env.example')throw new Error('Remove private .env files from the build checkout. Build in a clean worktree.');
await run(process.execPath,['node_modules/next/dist/bin/next','build']);
await fs.rm(output,{recursive:true,force:true});await fs.mkdir(output,{recursive:true});
await fs.cp('.next/standalone',path.join(output,'app'),{recursive:true,dereference:true});
await fs.cp('.next/static',path.join(output,'app','.next','static'),{recursive:true});
await fs.cp('db',path.join(output,'app','db'),{recursive:true});
await fs.cp('packaging/runtime',path.join(output,'runtime'),{recursive:true,filter:p=>!p.endsWith('.ts')});
await fs.mkdir(path.join(output,'licenses'),{recursive:true});
const nodeRoot=path.join(output,'node');await fs.mkdir(nodeRoot);
if(windows){
 const archive=path.join(cache,'node.zip');await download(pins.node.url,archive,pins.node.sha256);
 const expanded=path.join(cache,'node');await fs.mkdir(expanded,{recursive:true});
 await run('tar.exe',['-xf',archive,'-C',expanded]);
 const origin=path.join(expanded,`node-v${pins.node.version}-win-x64`);
 await fs.copyFile(path.join(origin,'node.exe'),path.join(nodeRoot,'node.exe'));
 await fs.copyFile(path.join(origin,'LICENSE'),path.join(output,'licenses','NODE-LICENSE.txt'));
 await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',"if ((Get-AuthenticodeSignature -LiteralPath $env:BBC_VERIFY_NODE).Status -ne 'Valid') { throw 'Node Authenticode verification failed' }"],{env:{...process.env,BBC_VERIFY_NODE:path.join(nodeRoot,'node.exe')}});
 const pgArchive=path.join(cache,'postgres.tgz');await download(pins.postgres.url,pgArchive,pins.postgres.integrity.slice(7),'sha512','base64');
 const pgExtract=path.join(cache,'pg');await fs.mkdir(pgExtract,{recursive:true});await run('tar.exe',['-xf',pgArchive,'-C',pgExtract]);
 await fs.cp(path.join(pgExtract,'package','native'),path.join(output,'postgres'),{recursive:true,dereference:true});
 for(const f of await fs.readdir(path.join(pgExtract,'package')))if(/license|notice|readme/i.test(f))await fs.copyFile(path.join(pgExtract,'package',f),path.join(output,'licenses','postgres-package-'+f));
}else{
 const mod=await import('@embedded-postgres/linux-x64');
 await fs.cp(path.resolve(path.dirname(mod.postgres),'..'),path.join(output,'postgres'),{recursive:true,dereference:true});
 await fs.copyFile(process.execPath,path.join(nodeRoot,'node'));await fs.chmod(path.join(nodeRoot,'node'),0o755);
}
await build({entryPoints:['packaging/runtime/operations.ts','scripts/worker.ts'],outdir:path.join(output,'runtime'),outExtension:{'.js':'.mjs'},bundle:true,platform:'node',format:'esm',target:'node24',external:['pg-native'],
 banner:{js:"import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);"},logLevel:'info'});
// esbuild's common ancestor preserves directories for multiple entries; move to stable runtime filenames.
for(const [from,to] of [['packaging/runtime/operations.mjs','operations.mjs'],['scripts/worker.mjs','worker.mjs']]){
 const p=path.join(output,'runtime',from);if(await fs.access(p).then(()=>true,()=>false))await fs.rename(p,path.join(output,'runtime',to));
}
await fs.rm(path.join(output,'runtime','packaging'),{recursive:true,force:true});await fs.rm(path.join(output,'runtime','scripts'),{recursive:true,force:true});
// Preserve all installed third-party notices, including bundled pure-JS maintenance dependencies.
async function notices(dir,prefix=''){
 for(const e of await fs.readdir(dir,{withFileTypes:true})){
  if(e.isSymbolicLink())continue;
  const p=path.join(dir,e.name),rel=path.join(prefix,e.name);
  if(e.isDirectory())await notices(p,rel);
  else if(/^(license|licence|notice|copyright)([.\-_]|$)/i.test(e.name)){
   const target=path.join(output,'licenses','npm',rel);await fs.mkdir(path.dirname(target),{recursive:true});await fs.copyFile(p,target);
  }
 }
}
await notices('node_modules');
await fs.copyFile('package-lock.json',path.join(output,'licenses','package-lock.json'));
await fs.copyFile('packaging/runtimes.json',path.join(output,'licenses','runtimes.json'));
for(const [from,to] of [['Start.cmd','启动网站.cmd'],['Stop.cmd','停止网站.cmd'],['Start.cmd','Start.cmd'],['Stop.cmd','Stop.cmd']])await fs.copyFile(path.join('packaging/windows',from),path.join(output,to));
for(const doc of ['WINDOWS_QUICKSTART.zh-CN.md','WINDOWS_MAINTENANCE.md'])if(await fs.access(path.join('docs',doc)).then(()=>true,()=>false))await fs.copyFile(path.join('docs',doc),path.join(output,doc.replace('.md','.txt')));
let commit=process.env.BBC_SOURCE_COMMIT||process.env.GITHUB_SHA||'local-uncommitted-test';
const release={product:'BBC Internal Quality & Operations Platform',version:pkg.version,sourceCommit:commit,platform:windows?'win32-x64':`${process.platform}-${process.arch}-test`,
 builtAt:new Date().toISOString(),node:pins.node.version,postgres:pins.postgres.version,lockSha256:hash(await fs.readFile('package-lock.json')),runtimePins:pins};
await fs.writeFile(path.join(output,'release.json'),JSON.stringify(release,null,2));
// Inventory catches omissions/corruption and makes upgrades auditable. This is not a digital signature.
const files={};
async function inventory(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){
 const p=path.join(dir,e.name),rel=path.relative(output,p).replaceAll('\\','/');
 if(e.isSymbolicLink())throw new Error(`Nonportable symlink left in package: ${rel}`);
 if(e.isDirectory())await inventory(p);else {
  if(/(^|\/)(\.env[^/]*|secrets\.json|demo-credentials\.json|postmaster.pid|PG_VERSION|database.json|controller.json)$/.test(rel))throw new Error(`Private/runtime data in package: ${rel}`);
  files[rel]=hash(await fs.readFile(p));
 }
}}
await inventory(output);await fs.writeFile(path.join(output,'SHA256SUMS.json'),JSON.stringify(files,null,2));
console.log(JSON.stringify({output,files:Object.keys(files).length,release}));
