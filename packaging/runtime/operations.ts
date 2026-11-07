// Trusted maintenance controller only. Never import this module into Next.js.
import pg from "pg";
import { randomUUID } from "node:crypto";
import { hashPassword, getPool } from "../../src/server/core";
import { seed } from "../../scripts/seed";
import { populate } from "../../scripts/sample-data";
export { migrate } from "../../scripts/migrate";
export { makeBackup, restoreBackup } from "../../scripts/backup";

export async function query(url: string, sql: string, args: unknown[] = []) {
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  try { return (await db.query(sql, args)).rows; }
  finally { await db.end(); }
}
export async function demo(owner: string, web: string, attachments: string, credentials: string) {
  await seed(owner, credentials);
  process.env.APP_ENV = "development";
  process.env.DATABASE_URL = web;
  process.env.MIGRATION_DATABASE_URL = owner;
  process.env.ATTACHMENT_DIR = attachments;
  try { await populate(credentials); }
  finally { await getPool().end(); }
}
export async function bootstrap(url: string, input: { email: string; password: string; name: string }) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email) || input.email.length > 254 ||
      input.password.length < 14 || input.password.length > 200 || !input.name.trim() || input.name.length > 200)
    throw new Error("请填写有效邮箱、姓名和至少 14 位的独立密码。");
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(420918)");
    if ((await db.query("SELECT 1 FROM users LIMIT 1")).rowCount) throw new Error("此实例已设置管理员，不能再次初始化。");
    await db.query("SELECT set_config('app.action','System.provision',true), set_config('app.reason','Local first administrator setup; no approval qualification',true)");
    const site = (await db.query("INSERT INTO sites(code,name) VALUES('WAL','Waltham') RETURNING id")).rows[0].id;
    const user = (await db.query("INSERT INTO users(email,name,password_hash) VALUES($1,$2,$3) RETURNING id",
      [input.email.toLowerCase(), input.name.trim(), hashPassword(input.password)])).rows[0].id;
    await db.query("INSERT INTO user_roles(user_id,role) VALUES($1,'System Administrator')", [user]);
    await db.query("INSERT INTO access_scopes(user_id,site_id,granted_by,reason) VALUES($1,$2,$1,'Initial technical administration; no business approval role')", [user,site]);
    const worker = (await db.query("INSERT INTO users(email,name,password_hash,system_account) VALUES('worker@internal.invalid','Reminder Service',$1,true) RETURNING id", [hashPassword(randomUUID()+randomUUID())])).rows[0].id;
    await db.query("INSERT INTO user_roles(user_id,role) VALUES($1,'System Worker')", [worker]);
    await db.query("INSERT INTO access_scopes(user_id,site_id,granted_by,reason) VALUES($1,$2,$3,'Server reminder scope')", [worker,site,user]);
    await db.query("INSERT INTO workflow_rules(name,version,rules) VALUES('SOP internal review',1,$1)", [JSON.stringify({independentReview:true,independentApproval:true,reviewerDistinctFromApprover:true,requireTrainingAudience:true,label:'SAMPLE RULE — pending BBC approval'})]);
    await db.query("COMMIT");
  } catch(e) { await db.query("ROLLBACK"); throw e; }
  finally { await db.end(); }
}
