import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { exists, jsonFile, readJson, execute, freePort, postgresPaths } from './common.mjs';
export class Cluster {
  constructor(instance, pgRoot, executeQuery) { this.query=executeQuery; this.root=instance; this.pgRoot=pgRoot; this.data=path.join(instance,'postgres'); this.started=false; }
  bin(name) { return path.join(this.pgRoot,'bin',name+(process.platform==='win32'?'.exe':'')); }
  url(role, database='bbc_app') {
    const password=this.secrets[role];
    return `postgresql://${role}:${password}@127.0.0.1:${this.port}/${database}`;
  }
  async start() {
    await fs.mkdir(this.root,{recursive:true,mode:0o700});
    const compatible=await postgresPaths(this.root,this.pgRoot);
    this.root=compatible.instance;this.pgRoot=compatible.binaries;this.data=path.join(this.root,'postgres');
    await fs.mkdir(path.join(this.root,'logs'),{recursive:true,mode:0o700});
    const secretsFile=path.join(this.root,'secrets.json');
    if(await exists(secretsFile)) this.secrets=await readJson(secretsFile);
    else {
      if(await exists(path.join(this.data,'PG_VERSION'))) throw new Error('数据库已存在但密钥缺失。请恢复完整实例配置；不会重置密码。');
      this.secrets=Object.fromEntries(['postgres','bbc_owner','bbc_web','bbc_worker'].map(r=>[r,randomBytes(32).toString('hex')]));
      await jsonFile(secretsFile,this.secrets);
    }
    const stateFile=path.join(this.root,'database-state.json');
    let state=await exists(stateFile)?await readJson(stateFile):null;
    if(await exists(path.join(this.data,'PG_VERSION'))) {
      const major=(await fs.readFile(path.join(this.data,'PG_VERSION'),'utf8')).trim();
      if(major!=='17') throw new Error(`数据库主版本 ${major} 与本运行包不匹配，需要受控迁移。`);
      // Only adopt an authenticated database with the exact owned data directory.
      if(state && await exists(path.join(this.data,"postmaster.pid"))) {
        this.port=state.port;
        try {
          const rows=await this.query(this.url('postgres','postgres'),'SHOW data_directory');
          if(path.resolve(rows[0].data_directory)!==path.resolve(this.data)) throw new Error('数据库目录不匹配');
          this.started=true; await this.provision(); return;
        } catch(e) {
          if(!['ECONNREFUSED','57P03','ECONNRESET'].includes(e.code)) throw new Error('已有端口上的数据库不属于本实例或不可验证。不会停止该进程。');
        }
      }
      // PostgreSQL itself decides whether a stale PID file is safe. Never unlink it.
    } else {
      const passwordFile=path.join(this.root,`init-${randomBytes(8).toString('hex')}.tmp`);
      await fs.writeFile(passwordFile,this.secrets.postgres,{mode:0o600,flag:'wx'});
      try { await execute(this.bin('initdb'),['-D',this.data,'-U','postgres','--auth=scram-sha-256','--encoding=UTF8','--locale=C',`--pwfile=${passwordFile}`],{cwd:this.pgRoot}); }
      catch(e){
        let detail=e.detail||e.message;
        for(const value of Object.values(this.secrets))detail=detail.replaceAll(value,'[redacted]');
        await fs.writeFile(path.join(this.root,'logs','initialization-error.log'),detail,{mode:0o600});
        throw new Error(`${e.message}\n${detail.slice(-3000)}`);
      }
      finally { await fs.rm(passwordFile,{force:true}); }
    }
    this.port=await freePort();
    await fs.writeFile(path.join(this.data,'pg_hba.conf'),'host all all 127.0.0.1/32 scram-sha-256\nhost all all ::1/128 scram-sha-256\n',{mode:0o600});
    await fs.writeFile(path.join(this.data,'postgresql.auto.conf'),[
      "listen_addresses = '127.0.0.1'",`port = ${this.port}`,"unix_socket_directories = ''",
      "password_encryption = 'scram-sha-256'", "log_statement = 'none'", "log_min_error_statement = 'panic'",
      "log_parameter_max_length_on_error = 0", "max_connections = 60", "shared_buffers = '64MB'", ''
    ].join('\n'),{mode:0o600});
    await jsonFile(stateFile,{port:this.port,dataDirectory:this.data});
    await execute(this.bin('pg_ctl'),['-D',this.data,'-l',path.join(this.root,'logs','postgres.log'),'-w','-t','60','start'],{cwd:this.pgRoot});
    this.started=true;
    await this.provision();
  }
  async provision() {
    const admin=this.url('postgres','postgres');
    for(const role of ['bbc_owner','bbc_web','bbc_worker']) {
      if(!(await this.query(admin,'SELECT 1 FROM pg_roles WHERE rolname=$1',[role])).length)
        await this.query(admin,`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${this.secrets[role]}'`);
    }
    if(!(await this.query(admin,"SELECT 1 FROM pg_roles WHERE rolname='bbc_runtime'")).length)
      await this.query(admin,'CREATE ROLE bbc_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS');
    await this.query(admin,'GRANT bbc_runtime TO bbc_web,bbc_worker');
    if(!(await this.query(admin,"SELECT 1 FROM pg_database WHERE datname='bbc_app'")).length)
      await this.query(admin,'CREATE DATABASE bbc_app OWNER bbc_owner');
  }
  async stop() {
    if(!this.started) return;
    const actual=await this.query(this.url('postgres','postgres'),'SHOW data_directory');
    if(path.resolve(actual[0].data_directory)!==path.resolve(this.data)) throw new Error('拒绝停止不属于此实例的数据库。');
    await execute(this.bin('pg_ctl'),['-D',this.data,'-m','fast','-w','-t','60','stop'],{cwd:this.pgRoot});
    this.started=false;
  }
}
