import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import os from 'node:os';
import { fork } from 'node:child_process';
import { safeEnv, freePort, waitFor, exists } from './common.mjs';
export function privateAddresses() {
  let interfaces;try{interfaces=os.networkInterfaces();}catch{return [];}
  return Object.values(interfaces).flat().filter(a=>a && a.family==='IPv4' && !a.internal &&
    (/^10\./.test(a.address)||/^192\.168\./.test(a.address)||/^172\.(1[6-9]|2\d|3[01])\./.test(a.address)))
    .map(a=>a.address);
}
export function validateNetwork(input, kind) {
  const mode=input.mode??'local';
  if(!['local','lan-test','lan-https'].includes(mode)) throw new Error('请选择有效的访问模式。');
  const port=Number(input.port??8765);
  if(!Number.isInteger(port)||port<1024||port>65535) throw new Error('网站端口须为 1024 至 65535 的整数。');
  if(mode==='local') return {mode,port,bind:'127.0.0.1',origins:[`http://127.0.0.1:${port}`,`http://localhost:${port}`]};
  if(!privateAddresses().includes(input.bind)) throw new Error('请选择当前主机实际存在的内网 IPv4 地址。地址变化后需重新选择。');
  if(mode==='lan-test' && kind!=='demo') throw new Error('HTTP 内网试验仅允许合成数据实例；空白业务实例需要 HTTPS。');
  const scheme=mode==='lan-https'?'https':'http';
  const origin=new URL(input.origin||`${scheme}://${input.bind}:${port}`);
  if(origin.protocol!==scheme+':'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash||Number(origin.port||443)!==port)
    throw new Error('请填写与所选端口一致的完整访问地址，例如 https://qms.internal.example:8765。');
  return {mode,port,bind:input.bind,origins:[origin.origin],cert:input.cert||'',key:input.key||''};
}
export class Stack {
  constructor(appRoot, instance, cluster, config, manifest) {
    Object.assign(this,{appRoot,instance,cluster,config,manifest}); this.children=[]; this.status={web:'Stopped',worker:'Stopped'};
  }
  child(name,script,env) {
    const child=fork(script,[],{cwd:path.join(this.appRoot,'app'),execPath:process.execPath,execArgv:[],env:safeEnv(env),silent:true,windowsHide:true});
    // Do not collect SQL/business bodies, tokens or environment in diagnostics.
    const output=b=>{
      let text=String(b).replace(/postgres(?:ql)?:\/\/[^\s]+/gi,'[database connection redacted]');
      for(const secret of Object.values(this.cluster.secrets))text=text.replaceAll(secret,'[redacted]');
      void fs.appendFile(path.join(this.instance,'logs',name+'.log'),text,{mode:0o600});
    };
    child.stdout.on('data',output); child.stderr.on('data',output);
    this.status[name]='Starting';
    child.on('error',()=>{this.status[name]='Failed';});
    child.on('exit',code=>{this.status[name]=this.stopping?'Stopped':`Exited (${code})`;});
    this.children.push(child); return child;
  }
  async start() {
    const net=validateNetwork(this.config.network,this.config.kind);
    await freePort(net.port,net.bind);
    let tlsOptions;
    if(net.mode==='lan-https') {
      if(!net.cert||!net.key) throw new Error('HTTPS 需要公司提供的 PEM 证书链和私钥。');
      tlsOptions={cert:await fs.readFile(net.cert),key:await fs.readFile(net.key),minVersion:'TLSv1.2'};
      tls.createSecureContext(tlsOptions); // fail before exposing an endpoint
      const { X509Certificate }=await import('node:crypto');
      const cert=new X509Certificate(tlsOptions.cert);
      const hostname=new URL(net.origins[0]).hostname;
      if(!(cert.checkHost(hostname)||cert.checkIP(hostname))||Date.parse(cert.validTo)<Date.now()||Date.parse(cert.validFrom)>Date.now())
        throw new Error('证书主机名或有效期与访问地址不匹配，请联系 IT。');
    }
    for(const name of ['web','worker']){const log=path.join(this.instance,'logs',name+'.log');if(await exists(log)&&(await fs.stat(log)).size>1024*1024)await fs.rename(log,log+'.previous').catch(()=>{});}
    const internalPort=await freePort();
    const base={APP_ENV:this.config.kind==='demo'?'development':'production',APP_ORIGIN:net.origins[0],APP_ORIGINS:net.origins.join(','),
      ATTACHMENT_DIR:path.join(this.instance,'attachments'),COOKIE_SECURE:String(net.mode==='lan-https'),
      NOTIFICATION_ADAPTER:'in-app',BBC_VERSION:this.manifest.version,BBC_INTERNAL_HOST:`127.0.0.1:${internalPort}`};
    this.child('web',path.join(this.appRoot,'runtime','server-process.mjs'),{...base,DATABASE_URL:this.cluster.url('bbc_web'),
      BBC_SERVER_ENTRY:path.join(this.appRoot,'app','server.js'),HOSTNAME:'127.0.0.1',PORT:String(internalPort)});
    try {
      await waitFor(async()=>{
        const response=await fetch(`http://127.0.0.1:${internalPort}/api/health`,{headers:{host:new URL(net.origins[0]).host},signal:AbortSignal.timeout(2000)});
        if(!response.ok)throw new Error(`网站健康检查返回 ${response.status}：${await response.text()}`);
        return true;
      });
      this.status.web='Running';
      this.child('worker',path.join(this.appRoot,'runtime','worker.mjs'),{...base,DATABASE_URL:this.cluster.url('bbc_worker')});
      this.status.worker='Running';
      const hosts=new Set(net.origins.map(o=>new URL(o).host));
      const handler=async(req,res)=>{
        const deny=(code,message)=>{res.writeHead(code,{'content-type':'text/plain; charset=utf-8','cache-control':'no-store'});res.end(message);};
        if(!hosts.has((req.headers.host||'').toLowerCase())) return deny(403,'Host is not configured. Open the address shown by the local controller.');
        if(req.headers.origin && !net.origins.includes(req.headers.origin)) return deny(403,'Origin is not allowed.');
        if(!['GET','HEAD','POST'].includes(req.method)) return deny(405,'Method not allowed.');
        if(net.mode==='lan-https') res.setHeader('Strict-Transport-Security','max-age=86400');
        let length=0; const chunks=[];
        try {
          for await(const chunk of req) {
            length+=chunk.length;
            if(length>12*1024*1024) {deny(413,'Upload exceeds 12 MiB.');return;}
            chunks.push(chunk);
          }
          const headers={...req.headers,host:req.headers.host,'content-length':String(length)};
          for(const key of Object.keys(headers)) if(key.startsWith('x-forwarded-')||['forwarded','connection','transfer-encoding','upgrade'].includes(key)) delete headers[key];
          const upstream=http.request({hostname:'127.0.0.1',port:internalPort,path:req.url,method:req.method,headers},u=>{res.writeHead(u.statusCode,u.headers);u.pipe(res);});
          upstream.setTimeout(60000,()=>upstream.destroy());
          upstream.on('error',()=>{if(!res.headersSent)deny(503,'Website is unavailable. Check the local controller.');else res.destroy();});
          res.on('close',()=>upstream.destroy());
          upstream.end(Buffer.concat(chunks));
        } catch {if(!res.headersSent)deny(400,'Incomplete request.');}
      };
      this.gateway=tlsOptions?https.createServer(tlsOptions,handler):http.createServer(handler);
      this.gateway.requestTimeout=60000; this.gateway.headersTimeout=15000;
      await new Promise((resolve,reject)=>{this.gateway.once('error',reject);this.gateway.listen(net.port,net.bind,resolve);});
      this.address=net.origins[0]; this.network=net;
    } catch(e) {await this.stop();throw e;}
  }
  async stop() {
    this.stopping=true;
    if(this.gateway) {
      this.gateway.closeIdleConnections();
      await new Promise(resolve=>{const timeout=setTimeout(()=>this.gateway.closeAllConnections(),5000);this.gateway.close(()=>{clearTimeout(timeout);resolve();});});
      this.gateway=null;
    }
    for(const child of this.children) if(child.exitCode===null && child.connected) child.send('stop');
    for(const child of this.children) {
      if(child.exitCode!==null)continue;
      await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('网站或 worker 未在 30 秒内正常停止。数据库仍保留运行，请查看状态后重试。')),30000);
        child.once('exit',()=>{clearTimeout(timer);resolve();});
      });
    }
    this.children=[]; this.status={web:'Stopped',worker:'Stopped'};
  }
}
