import { resolve, dirname, join } from "node:path";
import { writeFile } from "node:fs/promises";
import pg from "pg";
import { Cluster } from "../packaging/runtime/cluster.mjs";
export async function startWindows(isTest: boolean) {
  const nativeName = "@embedded-postgres/windows-x64";
  const native = await import(nativeName);
  const dir = resolve(isTest ? `.local/test-runtime-${process.pid}` : '.local/windows-dev');
  const query = async (url: string, sql: string, args: unknown[] = []) => {
    const c = new pg.Client({connectionString:url}); await c.connect();
    try { return (await c.query(sql,args)).rows; } finally { await c.end(); }
  };
  const server = new Cluster(dir, resolve(dirname(native.postgres), '..'), query);
  await server.start();
  for(const db of ['bbc_dev','bbc_test']) if(!(await query(server.url('postgres','postgres'),'SELECT 1 FROM pg_database WHERE datname=$1',[db])).length)
    await query(server.url('postgres','postgres'),`CREATE DATABASE ${db} OWNER bbc_owner`);
  const runtime = [
    `DATABASE_URL=${server.url('bbc_web','bbc_dev')}`, `ATTACHMENT_DIR=${join(dir,'attachments')}`,`TEST_WORK_DIR=${dir}`,
    `APP_ENV=${isTest?'test':'development'}`, 'APP_ORIGIN=http://localhost:3000','COOKIE_SECURE=false','NOTIFICATION_ADAPTER=in-app','NEXT_TELEMETRY_DISABLED=1'
  ];
  const ops=[...runtime,`MIGRATION_DATABASE_URL=${server.url('bbc_owner','bbc_dev')}`,`WORKER_DATABASE_URL=${server.url('bbc_worker','bbc_dev')}`,`TEST_DATABASE_URL=${server.url('bbc_web','bbc_test')}`,`TEST_MIGRATION_DATABASE_URL=${server.url('bbc_owner','bbc_test')}`,`ADMIN_DATABASE_URL=${server.url('postgres','postgres')}`];
  const file=isTest?join(dir,'test.env'):'.env.local';
  if(isTest) await writeFile(file,ops.join('\n'));
  else {await writeFile(file,runtime.join('\n'));await writeFile('.env.ops.local',ops.join('\n'));}
  return {stop:()=>server.stop(),envFile:file};
}
