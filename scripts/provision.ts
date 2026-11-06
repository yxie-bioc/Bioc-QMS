import pg from "pg";
import { randomUUID } from "node:crypto";
import { hashPassword } from "../src/server/core";
import { migrate } from "./migrate";
// One-off provisioning only. Never run in the web/worker process.
const required = [
  "ADMIN_DATABASE_URL",
  "BBC_OWNER_PASSWORD",
  "BBC_WEB_PASSWORD",
  "BBC_WORKER_PASSWORD",
  "MIGRATION_DATABASE_URL",
  "BOOTSTRAP_EMAIL",
  "BOOTSTRAP_PASSWORD",
];
for (const name of required)
  if (!process.env[name]) throw new Error(`Missing ${name}`);
if (process.env.BOOTSTRAP_PASSWORD!.length < 14)
  throw new Error("Bootstrap password must have at least 14 characters");
const admin = new pg.Client({
  connectionString: process.env.ADMIN_DATABASE_URL,
});
await admin.connect();
try {
  for (const [name, env] of [
    ["bbc_owner", "BBC_OWNER_PASSWORD"],
    ["bbc_web", "BBC_WEB_PASSWORD"],
    ["bbc_worker", "BBC_WORKER_PASSWORD"],
  ]) {
    if (
      !(await admin.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [name]))
        .rowCount
    ) {
      const password = process.env[env]!;
      const quoted = "'" + password.replace(/'/g, "''") + "'";
      await admin.query(
        `CREATE ROLE ${name} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD ${quoted}`,
      );
    }
  }
  if (
    !(await admin.query("SELECT 1 FROM pg_roles WHERE rolname='bbc_runtime'"))
      .rowCount
  )
    await admin.query(
      "CREATE ROLE bbc_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS",
    );
  await admin.query("GRANT bbc_runtime TO bbc_web,bbc_worker");
  if (
    !(await admin.query("SELECT 1 FROM pg_database WHERE datname='bbc_prod'"))
      .rowCount
  )
    await admin.query("CREATE DATABASE bbc_prod OWNER bbc_owner");
} finally {
  await admin.end();
}
await migrate(process.env.MIGRATION_DATABASE_URL!);
const db = new pg.Client({
  connectionString: process.env.MIGRATION_DATABASE_URL,
});
await db.connect();
try {
  if ((await db.query("SELECT id FROM users LIMIT 1")).rowCount) {
    console.log("Provisioning complete; existing users preserved.");
  } else {
    await db.query("BEGIN");
    await db.query(
      "SELECT set_config('app.action','System.provision',true),set_config('app.reason','Initial company-controlled installation; sample workflow pending approval',true)",
    );
    const site = (
      await db.query(
        "INSERT INTO sites(code,name) VALUES('WAL','Waltham') RETURNING id",
      )
    ).rows[0].id;
    const person = (
      await db.query(
        "INSERT INTO users(email,name,password_hash) VALUES($1,$2,$3) RETURNING id",
        [
          process.env.BOOTSTRAP_EMAIL!.toLowerCase(),
          process.env.BOOTSTRAP_NAME ?? "Platform Administrator",
          hashPassword(process.env.BOOTSTRAP_PASSWORD!),
        ],
      )
    ).rows[0].id;
    await db.query(
      "INSERT INTO user_roles(user_id,role) VALUES($1,'System Administrator')",
      [person],
    );
    await db.query(
      "INSERT INTO access_scopes(user_id,site_id,granted_by,reason) VALUES($1,$2,$1,$3)",
      [
        person,
        site,
        "Initial site administration grant; no business approval role",
      ],
    );
    const service = (
      await db.query(
        "INSERT INTO users(email,name,password_hash,system_account) VALUES('worker@internal.invalid','Reminder Service',$1,true) RETURNING id",
        [hashPassword(randomUUID() + randomUUID())],
      )
    ).rows[0].id;
    await db.query(
      "INSERT INTO user_roles(user_id,role) VALUES($1,'System Worker')",
      [service],
    );
    await db.query(
      "INSERT INTO access_scopes(user_id,site_id,granted_by,reason) VALUES($1,$2,$3,$4)",
      [service, site, person, "Server reminders for Waltham records"],
    );
    await db.query(
      "INSERT INTO workflow_rules(name,version,rules) VALUES($1,1,$2)",
      [
        "SOP internal review",
        JSON.stringify({
          independentReview: true,
          independentApproval: true,
          reviewerDistinctFromApprover: true,
          requireTrainingAudience: true,
          label: "SAMPLE RULE — not a BBC-approved procedure",
        }),
      ],
    );
    await db.query("COMMIT");
    console.log(
      "Provisioned Waltham and one technical administrator. No business approval roles or synthetic business records were added.",
    );
  }
} catch (e) {
  await db.query("ROLLBACK");
  throw e;
} finally {
  await db.end();
}
