import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
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
async function startController(){
 daemon=spawn(node,[path.join(program,'runtime','controller.mjs')],{cwd:scratch,env,stdio:['ignore','pipe','pipe']});let errors='';
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
  assert.equal((await fetch(origin+'/api/health',{headers:{host:'evil.example'}})).status,403);
  const outsider=await login('outsider');const scope=await (await get('/api/search',outsider)).json();assert.equal(scope.length,0);
  // The packaged launcher is idempotent, uses the bundled runtime, and needs no npm/Git.
  const launcher=spawn(node,[path.join(program,'runtime','launch.mjs')],{env,stdio:'ignore'});
  assert.equal(await new Promise(r=>launcher.on('exit',r)),0);assert.equal(JSON.parse(await fs.readFile(path.join(dataRoot,'controller.json'))).pid,control.pid);
  await wait(async()=>Boolean((await status()).heartbeat?.finished_at));
  if(process.env.BBC_BROWSER_TEST==='1')await browserWorkflow(t);
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
  await action('switch',{name:'company'});
  const admin={email:'admin@synthetic.example',password:randomUUID()+randomUUID(),name:'Synthetic technical administrator'};
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
  if(context)await context.close();context=await browser.newContext({viewport:{width:1440,height:1000}});page=await context.newPage();
  await page.goto(origin);await page.locator('[name=email]').fill(users[who].email);await page.locator('[name=password]').fill(users[who].password);await page.getByRole('button',{name:'Sign in to workspace'}).click();await expect(page.getByRole('button',{name:'Sign out',exact:true})).toBeVisible();
 };
 const openDoc=async()=>{await page.getByRole('button',{name:'Document control',exact:true}).click();await page.getByRole('button',{name:title,exact:true}).click();};
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
  await page.getByRole('button',{name:/Acknowledge reading|Complete training|Record completion/i}).first().click();
  await page.getByRole('dialog').locator('[name=reason]').fill('Read the fixed synthetic revision');await confirm();
  await signin('qa');await openDoc();await decision('Make effective');
  await signin('owner');await openDoc();const downloadEvent=page.waitForEvent('download');await page.getByRole('link',{name:/Download/i}).first().click();const download=await downloadEvent;assert.ok((await fs.readFile(await download.path())).toString().startsWith('%PDF-1.4'));
  await page.getByRole('button',{name:'New revision',exact:true}).click();const revision=page.getByRole('dialog');await revision.locator('[name=changeReason]').fill('Synthetic second revision preserves history');await revision.locator('[name=reviewDue]').fill('2028-12-31');await confirm();await expect(page.getByRole('button',{name:/Revision 1/})).toBeVisible();
  await fs.mkdir('test-results',{recursive:true});await page.screenshot({path:'test-results/portable-sop.png',fullPage:true});
  await page.getByRole('button',{name:'Sign out',exact:true}).click();await expect(page.getByRole('button',{name:'Sign in to workspace'})).toBeVisible();
  t.diagnostic('Chromium UI: login, SOP creation/upload/independent review/approval/training/effectiveness, download, new revision/history and logout passed.');
 }catch(e){await fs.mkdir('test-results',{recursive:true});if(page){await page.screenshot({path:'test-results/browser-failure.png',fullPage:true});await fs.writeFile('test-results/browser-failure.txt',await page.locator('body').innerText());}throw e;}
 finally{await browser.close();}
}
