import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
export const readJson = async (p) => JSON.parse(await fs.readFile(p, 'utf8'));
export async function exists(p) { try { await fs.access(p); return true; } catch(e) { if(e.code==='ENOENT') return false; throw e; } }
export async function jsonFile(p, value) {
  const temp = `${p}.${randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
  await fs.rename(temp, p);
}
export function safeEnv(extra = {}) {
  // Explicit allowlist: no inherited database, cloud, npm, bootstrap or test secrets.
  const env = {};
  for(const key of ['SystemRoot','SYSTEMROOT','WINDIR','ComSpec','COMSPEC','TEMP','TMP','PATH','Path','LOCALAPPDATA','USERPROFILE','HOME','LANG','LC_ALL','TZ'])
    if(process.env[key]) env[key]=process.env[key];
  return {...env, NEXT_TELEMETRY_DISABLED:'1', NODE_ENV:'production', ...extra};
}
export function execute(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide:true, shell:false, env:safeEnv(), ...options });
    let output='';
    child.stdout?.on('data', b => { output=(output+b).slice(-16000); });
    child.stderr?.on('data', b => { output=(output+b).slice(-16000); });
    child.on('error', reject);
    child.on('exit', code => code===0 ? resolve(output) : reject(Object.assign(new Error(`运行 ${path.basename(file)} 失败（${code}）。请查看本机诊断日志。`), {code:'CHILD_FAILED',detail:output})));
  });
}
export async function protectDirectory(dir) {
  await fs.mkdir(dir, {recursive:true, mode:0o700});
  if(process.platform==='win32') {
    const sid = (await execute('whoami.exe', ['/user','/fo','csv','/nh'])).match(/S-1-5-[\d-]+/)?.[0];
    if(!sid) throw new Error('无法确认当前 Windows 用户，未创建运行数据。');
    await execute('icacls.exe', [dir,'/inheritance:r','/grant:r',`*${sid}:(OI)(CI)F`,'*S-1-5-18:(OI)(CI)F']);
  } else await fs.chmod(dir,0o700);
}
export function alive(pid) { try { process.kill(pid,0); return true; } catch(e) { return e.code==='EPERM'; } }
export async function freePort(port=0, host='127.0.0.1') {
  return new Promise((resolve,reject)=>{
    const s=net.createServer(); s.once('error',()=>reject(new Error(`端口 ${port} 已占用。请在设置中选择其他端口；不会停止其他程序。`)));
    s.listen(port,host,()=>{const chosen=s.address().port; s.close(()=>resolve(chosen));});
  });
}
export const delay=ms=>new Promise(r=>setTimeout(r,ms));
export async function waitFor(fn, milliseconds=60000) {
  const end=Date.now()+milliseconds; let last;
  do { try { const result=await fn(); if(result) return result; } catch(e) {last=e;} await delay(250); } while(Date.now()<end);
  throw last ?? new Error('启动等待超时。请查看运行状态。');
}
export function openBrowser(url) {
  if(process.env.BBC_NO_BROWSER==='1') return;
  // URL is generated locally; never interpolate input into a shell command.
  const env=safeEnv({BBC_OPEN_URL:url});
  const child=process.platform==='win32'
    ? spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command','Start-Process -FilePath $env:BBC_OPEN_URL'],{env,windowsHide:true,stdio:'ignore'})
    : spawn('xdg-open',[url],{env,stdio:'ignore'});
  child.on('error',()=>{}); child.unref();
}

export async function verifyPackage(root) {
  const manifest=await readJson(path.join(root,'SHA256SUMS.json'));
  for(const [relative,expected] of Object.entries(manifest)){
    if(relative.includes('..')||path.isAbsolute(relative))throw new Error('运行包清单路径无效。');
    const bytes=await fs.readFile(path.join(root,relative));
    if(createHash('sha256').update(bytes).digest('hex')!==expected)throw new Error(`运行包文件损坏：${relative}。请重新完整解压。`);
  }
}
