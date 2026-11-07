import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { readJson, exists, waitFor, safeEnv, openBrowser, alive, delay, verifyPackage } from './common.mjs';
const appRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const root=path.resolve(process.env.BBC_DATA_HOME||path.join(process.env.LOCALAPPDATA||process.env.HOME,'BBC-QMS'));
const statePath=path.join(root,'controller.json');
async function connect(){
  if(!await exists(statePath))return null;
  const s=await readJson(statePath);if(!alive(s.pid))return null;
  const response=await fetch(`http://127.0.0.1:${s.port}/status`,{headers:{authorization:`Bearer ${s.token}`},signal:AbortSignal.timeout(2000)});
  return response.ok?s:null;
}
async function command(s,action){return fetch(`http://127.0.0.1:${s.port}/${action}`,{method:'POST',headers:{origin:`http://127.0.0.1:${s.port}`,authorization:`Bearer ${s.token}`,'content-type':'application/json'},body:'{}'});}
try {
  let state;try{state=await connect();}catch{}
  if(process.argv.includes('--stop')){
    if(state){const response=await command(state,'shutdown');if(!response.ok)throw new Error('维护操作仍在运行，请从管理页查看进度后停止。');await waitFor(async()=>!alive(state.pid));}
    console.log('网站、提醒 worker 和数据库已停止。');process.exit(0);
  }
  if(state&&path.resolve(state.appRoot)!==appRoot){
    const response=await command(state,'shutdown');
    if(!response.ok)throw new Error('旧版正在执行维护任务。请完成后重试升级。');
    await waitFor(async()=>!alive(state.pid));state=null;
  }
  if(!state){
    await verifyPackage(appRoot);
    await fs.mkdir(root,{recursive:true,mode:0o700});
    const child=spawn(process.execPath,[path.join(appRoot,'runtime','controller.mjs')],{cwd:appRoot,env:safeEnv({BBC_DATA_HOME:root}),detached:true,stdio:'ignore',windowsHide:true});
    child.on('error',()=>{});child.unref();state=await waitFor(connect,45000);
  }
  // Fragment avoids sending the management token to a web server or a log.
  openBrowser(`http://127.0.0.1:${state.port}/#${state.token}`);
  console.log('本机管理页已打开。关闭浏览器不会停止网站。');
} catch(e) {
  console.error(`BBC 网站未能启动：${e.message}\n检查是否已完整解压运行包，以及当前用户是否有数据目录写入权限。\n数据目录：${root}`);
  process.exitCode=1;
}
