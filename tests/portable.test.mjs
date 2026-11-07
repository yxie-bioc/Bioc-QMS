import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
const windows=process.platform==='win32';
const source=path.resolve(process.env.BBC_PACKAGE||`dist/BBC-QMS-${windows?'Windows-x64':process.platform+'-'+process.arch+'-test'}`);
const scratch=path.resolve('.local',`portable-${Date.now()}`),program=path.join(scratch,'程序 with spaces'),dataRoot=path.join(scratch,'用户 数据');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(fn,seconds=90){let last;for(let i=0;i<seconds*4;i++){try{const value=await fn();if(value)return value;}catch(e){last=e;}await pause(250);}throw last??new Error('Timed out');}
let daemon,control,origin,users,backup;
const node=path.join(program,'node',windows?'node.exe':'node');
const env={...process.env,BBC_DATA_HOME:dataRoot,BBC_NO_BROWSER:'1',PATH:windows?`${process.env.SystemRoot}\\System32;${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0`:'/usr/bin:/bin'};
const action=async(name,input={},ok=true)=>{
 const response=await fetch(`http://127.0.0.1:${control.port}/${name}`,{method:'POST',headers:{authorization:`Bearer ${control.token}`,origin:`http://127.0.0.1:${control.port}`,'content-type':'application/json'},body:JSON.stringify(input)});
 const value=await response.json();if(ok)assert.equal(response.status,200,JSON.stringify(value));return {response,value};
};
const status=async()=> (await fetch(`http://127.0.0.1:${control.port}/status`,{headers:{authorization:`Bearer ${control.token}`}})).json();
async function startController(directory=program){
 daemon=spawn(node,[path.join(directory,'runtime','controller.mjs')],{cwd:scratch,env,stdio:['ignore','pipe','pipe']});let errors='';
 daemon.stdout.on('data',()=>{});daemon.stderr.on('data',b=>{errors=(errors+b).slice(-6000);});
 daemon.on('error',e=>{errors+=e.message;});
 control=await wait(async()=>{if(daemon.exitCode!==null)throw new Error('Controller exited: '+errors);const s=JSON.parse(await fs.readFile(path.join(dataRoot,'controller.json')));if(s.pid!==daemon.pid)throw new Error(`Controller PID mismatch ${s.pid}/${daemon.pid}`);const r=await fetch(`http://127.0.0.1:${s.port}/status`,{headers:{authorization:`Bearer ${s.token}`}});if(!r.ok)throw new Error(`Controller HTTP ${r.status}: ${await r.text()}`);return s;});
}
async function login(who){
 const response=await fetch(origin+'/api/auth/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(users[who])});
 assert.equal(response.status,200);return response.headers.get('set-cookie').split(';')[0];
}
async function get(url,cookie){return fetch(origin+url,{headers:cookie?{cookie}:{}});}
test('Packaged runtime: isolated Unicode paths, local setup, persistence, origin checks, backup, restore and clean bootstrap',{timeout:300000},async(t)=>{
 await fs.mkdir(scratch,{recursive:true});await fs.cp(source,program,{recursive:true,dereference:true});
 try{
  await commandLauncherSmoke();
  await startController(); console.log('Portable: controller ready');
  assert.equal((await fetch(`http://127.0.0.1:${control.port}/status`)).status,403);
  const init=await action('initialize',{kind:'demo'});origin=init.value.address;assert.match(origin,/^http:\/\/127\.0\.0\.1:/);
  users=Object.fromEntries((await action('credentials')).value.map(u=>[u.key,u]));
  assert.equal(new Set(Object.values(users).map(u=>u.password)).size,Object.keys(users).length);
  assert.equal((await get('/api/health')).status,200);
  const cookie=await login('owner');
  const before=await (await get('/api/overview',cookie)).json();assert.ok(before.records.length>0);
  for(const p of ['/api/overview','/api/search','/api/export'])assert.equal((await get(p)).status,401);
  const forged=await fetch(origin+'/api/auth/login',{method:'POST',headers:{origin:'https://evil.example',host:'evil.example','x-forwarded-host':'evil.example','content-type':'application/json'},body:JSON.stringify(users.owner)});assert.equal(forged.status,403);
  const forgedHost=await new Promise((resolve,reject)=>{const req=http.get(origin+'/api/health',{headers:{host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);});assert.equal(forgedHost,403);
  const outsider=await login('outsider');const scope=await (await get('/api/search',outsider)).json();assert.equal(scope.length,0);
  // The packaged launcher is idempotent, uses the bundled runtime, and needs no npm/Git.
  const launcher=spawn(node,[path.join(program,'runtime','launch.mjs')],{env,stdio:'ignore'});
  assert.equal(await new Promise(r=>launcher.on('exit',r)),0);assert.equal(JSON.parse(await fs.readFile(path.join(dataRoot,'controller.json'))).pid,control.pid);
  await wait(async()=>Boolean((await status()).heartbeat?.finished_at));
  if(process.env.BBC_BROWSER_TEST==='1')await browserWorkflow(t);
  await networkWorkflow(t);
  backup=(await action('backup')).value;assert.ok(backup.files>0);
  const check=(await action('verify-backup',{backupPath:backup.path})).value;assert.equal(check.files,backup.files);assert.equal(check.ledgerMismatches,0);assert.equal(check.brokenRevisionLinks,0);
  const restored=(await action('restore',{backupPath:backup.path,name:'restored'})).value;assert.equal(restored.records,backup.records);
  const forbidden=await action('restore',{backupPath:backup.path,name:'demo'},false);assert.equal(forbidden.response.status,400);
  await action('stop');const stopped=await status();assert.equal(stopped.database,'Stopped');assert.equal(stopped.web,'Stopped');assert.equal(stopped.worker,'Stopped');
  await action('start');assert.equal((await (await get('/api/overview',cookie)).json()).records.length,backup.records);
  // Deliberately crash only this test-owned controller; PostgreSQL recovery owns its PID file.
  daemon.kill('SIGKILL');await new Promise(r=>daemon.once('exit',r));await pause(1000);await startController();
  await wait(async()=>!(await status()).busy);assert.equal((await get('/api/health')).status,200);
  await action('stop');
  const occupied=net.createServer();await new Promise(r=>occupied.listen(0,'127.0.0.1',r));
  const conflict=await action('network',{mode:'local',port:occupied.address().port},false);assert.equal(conflict.response.status,400);assert.match(conflict.value.error,/端口/);
  await new Promise(r=>occupied.close(r));await action('network',{mode:'local',port:Number(new URL(origin).port)});
  await action('switch',{name:'restored'});await action('start');const restoredCookie=await login('owner');assert.equal((await (await get('/api/overview',restoredCookie)).json()).records.length,backup.records);
  await upgradeWorkflow(t);
  await action('switch',{name:'company'});
  const admin={email:'admin@synthetic.example',password:randomUUID()+randomUUID(),name:'Synthetic technical administrator'};
  assert.equal((await action('initialize',{kind:'clean',...admin,password:'short'},false)).response.status,400);
  await action('initialize',{kind:'clean',...admin});users.clean=admin;
  const cleanCookie=await login('clean');const clean=await (await get('/api/overview',cleanCookie)).json();assert.equal(clean.records.length,0);assert.deepEqual(clean.actor.roles.map(r=>r.role),['System Administrator']);
  assert.equal((await action('network',{mode:'lan-test',bind:(await status()).addresses[0],port:8765},false)).response.status,400);
  assert.equal((await action('credentials',{},false)).response.status,400);
  t.diagnostic('Actual packaged processes used; no development server. This is same-host automation, not a second physical LAN client or desktop Windows certification.');
 }finally{if(control){try{await action('shutdown');}catch{}}if(daemon&&daemon.exitCode===null)await wait(()=>daemon.exitCode!==null,70);}
});
async function browserWorkflow(t){
 const {chromium,expect}=await import('@playwright/test');const browser=await chromium.launch({headless:true});
 let context,page;const title='Portable acceptance SOP '+randomUUID().slice(0,8);
 const signin=async who=>{
  if(context)await context.close();context=await browser.newContext({viewport:{width:1440,height:1000},timezoneId:'America/New_York'});page=await context.newPage();
  await page.goto(origin);await page.locator('[name=email]').fill(users[who].email);await page.locator('[name=password]').fill(users[who].password);await page.getByRole('button',{name:'Sign in to workspace'}).click();await expect(page.getByRole('button',{name:'Sign out',exact:true})).toBeVisible();
 };
 const openDoc=async()=>{await page.getByRole('button',{name:'Document control',exact:true}).click();await page.getByRole('button',{name:'Open '+title,exact:true}).click();};
 const confirm=async()=>{await page.getByRole('dialog').getByRole('button',{name:'Confirm action'}).click();await expect(page.getByRole('dialog')).toBeHidden();};
 const decision=async label=>{await page.getByRole('button',{name:label,exact:true}).click();await page.getByRole('dialog').locator('[name=reason]').fill('Synthetic Windows package browser acceptance');await confirm();};
 try{
  await signin('owner');await page.getByRole('button',{name:'Document control',exact:true}).click();await page.getByRole('button',{name:'New document',exact:true}).click();
  const d=page.getByRole('dialog');await d.locator('[name=number]').fill('SOP-PORTABLE-'+Date.now());await d.locator('[name=title]').fill(title);await d.locator('[name=changeReason]').fill('Synthetic browser acceptance first revision');await d.locator('[name=reviewDue]').fill('2027-12-31');await confirm();
  await page.locator('input[type=file]').first().setInputFiles({name:'测试 evidence.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4\nSynthetic browser attachment\n%%EOF')});
  await expect(page.getByText('测试 evidence.pdf',{exact:true}).first()).toBeVisible();
  await page.getByRole('button',{name:'Submit for review',exact:true}).click();const submit=page.getByRole('dialog');await submit.locator('[name=reviewerId]').selectOption({label:users.reviewer.name});await submit.locator('[name=approverId]').selectOption({label:users.approver.name});await submit.locator('[name=traineeIds]').selectOption({label:users.employee.name});await submit.locator('[name=dueAt]').fill('2027-01-01T12:00');await submit.locator('[name=reason]').fill('Independent synthetic review required');await confirm();
  await signin('reviewer');await openDoc();await decision('Record review');
  await signin('approver');await openDoc();await decision('Approve revision');
  await signin('employee');await openDoc();
  // Reading acknowledgement is a revision-bound training action in the document detail.
  await page.locator('.module-tabs').getByRole('button',{name:'Training',exact:true}).click();
  await page.getByRole('button',{name:'Acknowledge',exact:true}).click();
  await page.getByRole('dialog').locator('[name=reason]').fill('Read the fixed synthetic revision');await confirm();
  await signin('qa');await openDoc();await decision('Make effective');
  await signin('owner');await openDoc();const downloadEvent=page.waitForEvent('download');await page.getByRole('link',{name:/Download/i}).first().click();const download=await downloadEvent;assert.ok((await fs.readFile(await download.path())).toString().startsWith('%PDF-1.4'));
  await page.getByRole('button',{name:'New revision',exact:true}).click();const revision=page.getByRole('dialog');await revision.locator('[name=changeReason]').fill('Synthetic second revision preserves history');await revision.locator('[name=reviewDue]').fill('2028-12-31');await confirm();await expect(page.getByRole('button',{name:/Revision 1/})).toBeVisible();
  await expect(page.getByText('Dec 31, 2028',{exact:true})).toBeVisible();
  await fs.mkdir('test-results',{recursive:true});await page.screenshot({path:'test-results/portable-sop.png',fullPage:true});
  await page.getByRole('button',{name:'Sign out',exact:true}).click();await expect(page.getByRole('button',{name:'Sign in to workspace'})).toBeVisible();
  t.diagnostic('Chromium UI: login, SOP creation/upload/independent review/approval/training/effectiveness, download, new revision/history and logout passed.');
 }catch(e){await fs.mkdir('test-results',{recursive:true});if(page){await page.screenshot({path:'test-results/browser-failure.png',fullPage:true});await fs.writeFile('test-results/browser-failure.txt',await page.locator('body').innerText());}throw e;}
 finally{await browser.close();}
}

async function run(file,args,options={}){
 const child=spawn(file,args,{env,stdio:['ignore','pipe','pipe'],...options});let output='';
 child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
 await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(`${path.basename(file)} failed (${code}): ${output.slice(-2000)}`)));});
 return output;
}
async function commandLauncherSmoke(){
 const home=path.join(scratch,'启动入口 数据');
 const options={env:{...env,BBC_DATA_HOME:home,BBC_LAUNCH_CMD:path.join(program,'启动网站.cmd')},windowsVerbatimArguments:true};
 const output=windows?await run('cmd.exe',['/d','/s','/c','call "%BBC_LAUNCH_CMD%"'],options):await run(node,[path.join(program,'runtime','launch.mjs')],{env:options.env});
 const state=await fs.readFile(path.join(home,'controller.json')).then(b=>JSON.parse(b)).catch(()=>{throw new Error('Windows launcher did not start: '+output);});
 assert.equal((await fetch(`http://127.0.0.1:${state.port}/status`,{headers:{authorization:`Bearer ${state.token}`}})).status,200);
 options.env.BBC_LAUNCH_CMD=path.join(program,'停止网站.cmd');
 if(windows)await run('cmd.exe',['/d','/s','/c','call "%BBC_LAUNCH_CMD%"'],options);else await run(node,[path.join(program,'runtime','launch.mjs'),'--stop'],{env:options.env});
 await assert.rejects(fs.access(path.join(home,'controller.json')));
}
async function networkWorkflow(t){
 const addresses=(await status()).addresses;
 if(!addresses.length){t.diagnostic('LAN/TLS transport skipped on this host: no usable private IPv4 interface. Windows CI runs it when a private interface exists.');return;}
 const localOrigin=origin,bind=addresses[0],port=Number(new URL(origin).port);
 // The local mode has no listener on the host's LAN interface.
 await assert.rejects(fetch(`http://${bind}:${port}/api/health`,{signal:AbortSignal.timeout(2500)}));
 origin=(await action('network',{mode:'lan-test',bind,port})).value.address;
 const cookie=await login('owner');assert.equal((await get('/api/overview',cookie)).status,200);
 const dbState=JSON.parse(await fs.readFile(path.join(dataRoot,'instances','demo','database-state.json')));
 await new Promise((resolve,reject)=>{const c=net.connect({host:bind,port:dbState.port});c.setTimeout(2500);c.once('connect',()=>{c.destroy();reject(new Error('Database exposed on LAN'));});c.once('error',resolve);c.once('timeout',()=>{c.destroy();resolve();});});
 const cert=path.join(scratch,'test-cert.pem'),key=path.join(scratch,'test-key.pem');
 const openssl=windows?path.join(process.env.ProgramFiles,'Git','usr','bin','openssl.exe'):'openssl';
 await run(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','2','-subj','/CN=BBC synthetic acceptance','-addext',`subjectAltName=IP:${bind}`]);
 const ca=await fs.readFile(cert);
 origin=(await action('network',{mode:'lan-https',bind,port,origin:`https://${bind}:${port}`,cert,key})).value.address;
 const request=(p,method='GET',headers={},body)=>new Promise((resolve,reject)=>{
  const r=https.request(origin+p,{method,ca,headers},response=>{const chunks=[];response.on('data',b=>chunks.push(b));response.on('end',()=>resolve({status:response.statusCode,headers:response.headers,bytes:Buffer.concat(chunks)}));});r.on('error',reject);r.end(body);
 });
 const logged=await request('/api/auth/login','POST',{origin,'content-type':'application/json'},JSON.stringify(users.owner));assert.equal(logged.status,200);
 const cookies=logged.headers['set-cookie'];assert.match(cookies[0],/; Secure/i);assert.match(cookies[0],/; HttpOnly/i);assert.match(cookies[0],/SameSite=Strict/i);
 const auth={cookie:cookies[0].split(';')[0],origin};
 assert.equal((await request('/api/overview','GET',auth)).status,200);
 assert.equal((await request('/api/health','GET',{host:'evil.example'})).status,403);
 assert.equal((await request('/api/auth/logout','POST',{...auth,origin:'https://evil.example'},'{}')).status,403);
 const overview=JSON.parse((await request('/api/overview','GET',auth)).bytes);
 const draft=overview.records.find(r=>r.kind==='Document'&&r.status==='Draft');assert.ok(draft);
 const detail=JSON.parse((await request('/api/records/'+draft.id,'GET',auth)).bytes),revision=detail.revisions[0];
 const form=new FormData();form.set('recordId',draft.id);form.set('revisionId',revision.id);form.set('version',String(revision.version));form.set('file',new Blob(['%PDF-1.4\nSynthetic TLS attachment\n%%EOF'],{type:'application/pdf'}),'TLS 测试.pdf');
 const encoded=new Response(form);const uploaded=await request('/api/attachments','POST',{...auth,'idempotency-key':randomUUID(),'content-type':encoded.headers.get('content-type')},Buffer.from(await encoded.arrayBuffer()));assert.equal(uploaded.status,200,uploaded.bytes.toString());
 const attachment=JSON.parse(uploaded.bytes);assert.ok(attachment.id);const downloaded=await request('/api/attachments/'+attachment.id,'GET',auth);assert.equal(downloaded.status,200);assert.match(downloaded.bytes.toString(),/Synthetic TLS attachment/);
 origin=(await action('network',{mode:'local',port})).value.address;assert.equal(origin,localOrigin);
 t.diagnostic('Same-host LAN interface and HTTPS: CA-verified TLS, independent login, upload/download, Secure/HttpOnly/SameSite cookies, Host/Origin rejection, and database not listening on LAN passed. No OS certificate trust or firewall setting changed.');
}
async function upgradeWorkflow(t){
 const upgraded=path.join(scratch,'升级 program'),broken=path.join(scratch,'失败 program');
 await fs.cp(program,upgraded,{recursive:true});
 const release=JSON.parse(await fs.readFile(path.join(upgraded,'release.json')));release.version='0.2.1';release.sourceCommit+='-synthetic-upgrade';
 await fs.writeFile(path.join(upgraded,'release.json'),JSON.stringify(release));
 await fs.writeFile(path.join(upgraded,'app','db','migrations','009_synthetic_upgrade.sql'),'CREATE INDEX portable_acceptance_title_idx ON records(title);\n');
 await action('shutdown');await wait(()=>daemon.exitCode!==null);await startController(upgraded);await wait(async()=>!(await status()).busy);
 const upgradedStatus=await status();assert.equal(upgradedStatus.web,'Running',upgradedStatus.lastError);assert.equal(upgradedStatus.config.version,'0.2.1');assert.ok(upgradedStatus.config.upgrade.backup);assert.equal(upgradedStatus.config.upgrade.verification.ledgerMismatches,0);
 assert.equal((await (await get('/api/overview',await login('owner'))).json()).records.length,backup.records);
 await fs.cp(upgraded,broken,{recursive:true});release.version='0.2.2';release.sourceCommit+='-synthetic-failure';await fs.writeFile(path.join(broken,'release.json'),JSON.stringify(release));
 await fs.writeFile(path.join(broken,'app','db','migrations','010_synthetic_failure.sql'),'CREATE TABLE portable_should_rollback (id int); SELECT undefined_acceptance_function();\n');
 await action('shutdown');await wait(()=>daemon.exitCode!==null);await startController(broken);await wait(async()=>!(await status()).busy);
 const failed=await status();assert.equal(failed.web,'Stopped');assert.equal(failed.worker,'Stopped');assert.match(failed.lastError,/undefined_acceptance_function/);assert.equal(failed.config.version,'0.2.1');assert.ok(failed.config.upgrade.backup);
 const {query}=await import(pathToFileURL(path.join(program,'runtime','operations.mjs')).href);
 const secrets=JSON.parse(await fs.readFile(path.join(dataRoot,'instances','restored','secrets.json'))),db=JSON.parse(await fs.readFile(path.join(dataRoot,'instances','restored','database-state.json')));
 const rows=await query(`postgresql://bbc_owner:${secrets.bbc_owner}@127.0.0.1:${db.port}/bbc_app`,"SELECT to_regclass('portable_should_rollback') AS failed_table, (SELECT count(*) FROM schema_migrations) AS migrations");assert.equal(rows[0].failed_table,null);assert.equal(Number(rows[0].migrations),9);
 await action('shutdown');await wait(()=>daemon.exitCode!==null);await startController(upgraded);await wait(async()=>!(await status()).busy);assert.equal((await status()).web,'Running');
 t.diagnostic('Synthetic package upgrade: mandatory old-version backup and independent restore check, new migration, record preservation, failed migration rollback and stopped website, and recovery with last working package passed.');
}
