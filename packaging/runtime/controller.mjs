import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Cluster } from './cluster.mjs';
import { Stack, privateAddresses, validateNetwork } from './stack.mjs';
import { readJson, jsonFile, exists, protectDirectory, alive, safeEnv } from './common.mjs';
import { migrate, demo, bootstrap, query, makeBackup, restoreBackup } from './operations.mjs';
const appRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const root=path.resolve(process.env.BBC_DATA_HOME || path.join(process.env.LOCALAPPDATA || process.env.HOME,'BBC-QMS'));
const manifest=await readJson(path.join(appRoot,'release.json'));
process.chdir(path.join(appRoot,'app'));
await protectDirectory(root);
const lockPath=path.join(root,'controller.lock');
try {
  const fd=await fs.open(lockPath,'wx',0o600); await fd.writeFile(JSON.stringify({pid:process.pid,appRoot})); await fd.close();
} catch(e) {
  if(e.code!=='EEXIST')throw e;
  const old=await readJson(lockPath);
  if(alive(old.pid))process.exit(0);
  await fs.rm(lockPath); // This is our controller lock, NEVER PostgreSQL's postmaster.pid.
  const fd=await fs.open(lockPath,'wx',0o600);await fd.writeFile(JSON.stringify({pid:process.pid,appRoot}));await fd.close();
}
const controlFile=path.join(root,'controller.json');
const prefsFile=path.join(root,'preferences.json');
let prefs=await exists(prefsFile)?await readJson(prefsFile):{instance:'demo',backupRoot:path.join(root,'backups')};
await fs.mkdir(path.join(root,'instances'),{recursive:true,mode:0o700});
await fs.mkdir(prefs.backupRoot,{recursive:true,mode:0o700});
let cluster=null,stack=null,config=null,busy=false,operation='Ready',lastError='',lastResult=null;
const token=randomBytes(32).toString('hex');
const pgRoot=path.join(appRoot,'postgres');
const instancePath=(name=prefs.instance)=>path.join(root,'instances',name);
const validName=s=>typeof s==='string'&&/^[a-z][a-z0-9-]{0,39}$/.test(s);
const publicConfig=c=>c?{kind:c.kind,network:c.network,version:c.release?.version,sourceCommit:c.release?.sourceCommit,initialized:c.initialized,lastBackup:c.lastBackup,upgrade:c.upgrade}:null;
async function saveConfig(){await jsonFile(path.join(instancePath(),'instance.json'),config);}
async function log(action,outcome){await fs.appendFile(path.join(root,'maintenance.jsonl'),JSON.stringify({at:new Date().toISOString(),action,outcome,instance:prefs.instance,version:manifest.version})+'\n',{mode:0o600});}
async function loadConfig() {
  const file=path.join(instancePath(),'instance.json');
  config=await exists(file)?await readJson(file):null;
}
async function ensureCluster(){if(!cluster){cluster=new Cluster(instancePath(),pgRoot,query);await cluster.start();}}
async function stop(){
  if(stack){await stack.stop();stack=null;}
  if(cluster){await cluster.stop();cluster=null;}
}
async function restoreCheck(backup,api={restoreBackup},base=path.join(root,'recovery-checks')) {
  const target=path.join(base,`check-${Date.now()}-${randomBytes(3).toString('hex')}`);
  const c=new Cluster(target,pgRoot,query);
  try {await c.start();return {...await api.restoreBackup(c.url('bbc_owner'),backup,path.join(target,'attachments')),target};}
  finally {await c.stop();}
}
async function backup(label='manual',api={makeBackup}) {
  if(!config?.initialized)throw new Error('请先初始化实例。');
  await ensureCluster();
  const target=path.join(prefs.backupRoot,`${prefs.instance}-${label}-${new Date().toISOString().replace(/[:.]/g,'-')}`);
  try {
    const result=await api.makeBackup(cluster.url('bbc_owner'),path.join(instancePath(),'attachments'),target);
    await jsonFile(path.join(target,'instance-info.json'),{kind:config.kind,release:config.release,instance:prefs.instance});
    config.lastBackup={ok:true,at:new Date().toISOString(),...result};await saveConfig();await log('Backup','Succeeded');return result;
  } catch(e) {config.lastBackup={ok:false,at:new Date().toISOString()};await saveConfig();await log('Backup','Failed');throw e;}
}
async function upgradeIfNeeded() {
  if(!config.release || config.release.sourceCommit===manifest.sourceCommit)return;
  const oldRoot=config.releaseRoot;
  if(!oldRoot||!await exists(path.join(oldRoot,'runtime','operations.mjs')))throw new Error('升级前需要保留上一个运行包以验证旧版备份。请恢复原程序目录后重试。');
  if(manifest.version.localeCompare(config.release.version,undefined,{numeric:true})<0)throw new Error('不允许直接降级程序。请使用匹配版本将升级前备份恢复到新实例。');
  operation='升级前备份与独立恢复核对';
  const old=await import(pathToFileURL(path.join(oldRoot,'runtime','operations.mjs')).href);
  const current=process.cwd();
  try {
    process.chdir(path.join(oldRoot,'app'));
    const b=await backup('before-upgrade',old);
    const verification=await restoreCheck(b.path,old);
    config.upgrade={from:config.release,to:manifest,backup:b.path,verification,at:new Date().toISOString()};
    await saveConfig();
  } finally {process.chdir(current);}
}
async function start() {
  if(stack)return {address:stack.address};
  await loadConfig();
  if(!config)return {needsSetup:true};
  if(!config.initialized)throw new Error('初始化未完成，保留了现有数据，请查看诊断。不要覆盖实例。');
  try {
    await ensureCluster();
    await upgradeIfNeeded();
    await migrate(cluster.url('bbc_owner'));
    config.release=manifest;config.releaseRoot=appRoot;await saveConfig();
    stack=new Stack(appRoot,instancePath(),cluster,config,manifest);await stack.start();
    await log('Start','Succeeded');return {address:stack.address};
  } catch(e) {if(stack){await stack.stop();stack=null;}throw e;}
}
async function initialize(input) {
  if(config?.initialized)throw new Error('实例已存在。请选择其他实例名称。');
  if(input.kind==='clean'&&(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email||'')||(input.password||'').length<14||(input.password||'').length>200||!input.name?.trim()))throw new Error('请填写有效邮箱、姓名和至少 14 位密码。');
  if(config&&config.kind!==input.kind)throw new Error('不能更改未完成实例的用途。请选择新的实例名称。');
  if(!['demo','clean'].includes(input.kind))throw new Error('请选择合成测试实例或独立空实例。');
  config={kind:input.kind,network:{mode:'local',port:8765},initialized:false,release:manifest,releaseRoot:appRoot};
  await fs.mkdir(instancePath(),{recursive:true,mode:0o700});await saveConfig();
  await ensureCluster();await migrate(cluster.url('bbc_owner'));
  if(input.kind==='demo')await demo(cluster.url('bbc_owner'),cluster.url('bbc_web'),path.join(instancePath(),'attachments'),path.join(instancePath(),'demo-credentials.json'));
  else await bootstrap(cluster.url('bbc_owner'),input);
  config.initialized=true;await saveConfig();return start();
}
async function switchInstance(input) {
  if(!validName(input.name))throw new Error('实例名称只用小写字母、数字和连字符，最长 40 位。');
  await stop();prefs.instance=input.name;await jsonFile(prefsFile,prefs);await loadConfig();return {selected:prefs.instance};
}
async function restore(input) {
  if(!validName(input.name)||await exists(instancePath(input.name)))throw new Error('恢复必须使用一个尚不存在的新实例名称。');
  if(!path.isAbsolute(input.backupPath||''))throw new Error('请选择完整备份文件夹路径。');
  const info=await readJson(path.join(input.backupPath,'instance-info.json'));
  if(info.release.sourceCommit!==manifest.sourceCommit)throw new Error('请先用该备份对应的原运行包恢复，再通过升级入口更新。不能直接混用数据库版本。');
  const target=instancePath(input.name);const c=new Cluster(target,pgRoot,query);
  try {
    await c.start();
    const result=await restoreBackup(c.url('bbc_owner'),input.backupPath,path.join(target,'attachments'));
    await jsonFile(path.join(target,'instance.json'),{kind:info.kind,initialized:true,network:{mode:'local',port:8765},release:manifest,releaseRoot:appRoot,restoredFrom:input.backupPath});
    await log('Restore','Succeeded');return {...result,instance:input.name};
  } finally {await c.stop();}
}
async function status() {
  const instances=[];
  for(const name of await fs.readdir(path.join(root,'instances'))) if(validName(name)) {
    const file=path.join(instancePath(name),'instance.json');
    if(await exists(file)) instances.push({name,...publicConfig(await readJson(file))});
  }
  const backups=[];
  for(const name of (await fs.readdir(prefs.backupRoot)).sort().reverse().slice(0,100)){
    const dir=path.join(prefs.backupRoot,name);
    if(await exists(path.join(dir,'manifest.json'))&&await exists(path.join(dir,'instance-info.json')))backups.push({name,path:dir});
  }
  let heartbeat=null;
  if(cluster?.started&&config?.initialized)try {heartbeat=(await query(cluster.url('bbc_owner'),'SELECT started_at,finished_at,delivered,failed,error FROM worker_runs ORDER BY started_at DESC LIMIT 1'))[0]??null;}catch{}
  return {manifest,appRoot,dataRoot:root,instance:prefs.instance,config:publicConfig(config),instances,backups,backupRoot:prefs.backupRoot,
    busy,operation,lastError,lastResult,address:stack?.address??null,web:stack?.status.web??'Stopped',worker:stack?.status.worker??'Stopped',database:cluster?.started?'Running':'Stopped',heartbeat,addresses:privateAddresses()};
}
let shuttingDown=false;
async function shutdown(){
  if(shuttingDown)return;shuttingDown=true;
  try{await stop();await log('Shutdown','Succeeded');await fs.rm(controlFile,{force:true});await fs.rm(lockPath,{force:true});server.close(()=>process.exit(0));}
  catch(e){shuttingDown=false;lastError=e.message;}
}
const html=await fs.readFile(path.join(appRoot,'runtime','manager.html'));
const server=http.createServer(async(req,res)=>{
  const send=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
  const expected=`127.0.0.1:${server.address().port}`;
  if(req.headers.host!==expected)return send(403,{error:'Local controller host rejected.'});
  if(req.method==='GET'&&req.url==='/'){
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY',
      'Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});return res.end(html);
  }
  const given=Buffer.from((req.headers.authorization||'').replace(/^Bearer /,''));
  if(given.length!==64||!timingSafeEqual(given,Buffer.from(token)))return send(403,{error:'请从主机上的“启动网站”入口打开管理页。'});
  if(req.method==='GET'&&req.url==='/status'){try{return send(200,await status());}catch{return send(503,{error:'无法读取状态，请检查数据目录权限。'});}}
  if(req.method!=='POST'||req.headers.origin!==`http://${expected}`||req.headers['sec-fetch-site']==='cross-site')return send(403,{error:'Local controller origin rejected.'});
  if(busy)return send(409,{error:'上一项维护操作仍在进行，请等待。'});
  busy=true;operation=req.url.slice(1);lastError='';
  try {
    let size=0;const chunks=[];for await(const b of req){size+=b.length;if(size>65536)throw new Error('管理请求过大。');chunks.push(b);}
    const input=JSON.parse(Buffer.concat(chunks).toString()||'{}');let result;
    if(req.url==='/initialize')result=await initialize(input);
    else if(req.url==='/start')result=await start();
    else if(req.url==='/stop'){await stop();result={ok:true};}
    else if(req.url==='/switch')result=await switchInstance(input);
    else if(req.url==='/backup')result=await backup();
    else if(req.url==='/restore')result=await restore(input);
    else if(req.url==='/verify-backup'){
      if(!path.isAbsolute(input.backupPath||''))throw new Error('请选择备份文件夹。');
      const info=await readJson(path.join(input.backupPath,'instance-info.json'));
      if(info.release.sourceCommit!==manifest.sourceCommit)throw new Error('请使用备份对应版本验证。');
      result=await restoreCheck(input.backupPath);
    }
    else if(req.url==='/network'){
      if(!config)throw new Error('请先创建实例。');
      const network=validateNetwork(input,config.kind);await stop();config.network=network;await saveConfig();result=await start();
    }
    else if(req.url==='/credentials'){
      if(config?.kind!=='demo')throw new Error('此实例不提供测试密码。');
      const data=await readJson(path.join(instancePath(),'demo-credentials.json'));
      result=Object.entries(data.users).filter(([k])=>k!=='worker').map(([key,u])=>({key,email:u.email,password:u.password,name:u.name}));
    }
    else if(req.url==='/backup-path'){
      if(!path.isAbsolute(input.path||''))throw new Error('备份位置必须为完整路径。');
      // Only create a dedicated subfolder; never change ACLs on the chosen parent.
      prefs.backupRoot=path.join(input.path,'BBC-QMS-Backups');await protectDirectory(prefs.backupRoot);await jsonFile(prefsFile,prefs);result={path:prefs.backupRoot};
    }
    else if(req.url==='/shutdown'){send(200,{ok:true});busy=false;setImmediate(shutdown);return;}
    else throw new Error('未知维护操作。');
    lastResult=req.url==='/credentials'?{ok:true}:result;await log(operation,'Succeeded');send(200,result??{ok:true});
  }catch(e){lastError=e.message;await log(operation,'Failed');send(400,{error:lastError});}
  finally{busy=false;operation='Ready';}
});
server.requestTimeout=120000;server.headersTimeout=15000;
await new Promise((r,j)=>{server.once('error',j);server.listen(0,'127.0.0.1',r);});
await jsonFile(controlFile,{pid:process.pid,port:server.address().port,token,appRoot});
await loadConfig();
if(config){busy=true;operation='Starting';try{await start();}catch(e){lastError=e.message;}finally{busy=false;operation='Ready';}}
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,shutdown);
