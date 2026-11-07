import pg from "pg";
import { dirname } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { hashPassword } from "../src/server/core";
export async function seed(url: string, credentialFile?: string) {
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  try {
    const existing = await db.query("SELECT id FROM sites LIMIT 1");
    if (existing.rowCount) {
      console.log("Seed skipped: database already has site data.");
      return null;
    }
    const site = randomUUID(),
      otherSite = randomUUID(),
      customer = randomUUID(),
      project = randomUUID();
    const people = [
      ["owner", "Alex Morgan", ["Employee", "Document Owner"]],
      ["reviewer", "Taylor Reed", ["Employee", "Reviewer"]],
      ["approver", "Jordan Chen", ["Employee", "Approver"]],
      [
        "qa",
        "Sam Patel",
        [
          "Employee",
          "QA",
          "Document Owner",
          "Investigator",
          "Inventory Custodian",
          "EHS Coordinator",
        ],
      ],
      [
        "qa_reviewer",
        "Morgan Lee",
        ["Employee", "QA", "Approver", "EHS Coordinator"],
      ],
      ["employee", "Casey Brooks", ["Employee"]],
      ["admin", "Platform Administrator", ["System Administrator"]],
      ["outsider", "Other Site User", ["Employee"]],
      ["worker", "Reminder Service", ["System Worker"]],
    ] as const;
    const users: Record<
      string,
      { id: string; email: string; password: string; name: string }
    > = {};
    await db.query("BEGIN");
    await db.query(
      "SELECT set_config('app.action','Seed.synthetic',true),set_config('app.reason','Explicit synthetic development/test bootstrap',true)",
    );
    await db.query(
      "INSERT INTO sites(id,code,name) VALUES($1,$2,$3),($4,$5,$6)",
      [
        site,
        "WAL",
        "Waltham",
        otherSite,
        "TEST-OTHER",
        "Other site · synthetic",
      ],
    );
    await db.query("INSERT INTO customers(id,name) VALUES($1,$2)", [
      customer,
      "Synthetic Research Client",
    ]);
    await db.query(
      "INSERT INTO projects(id,site_id,customer_id,code,title) VALUES($1,$2,$3,$4,$5)",
      [project, site, customer, "DEMO-P001", "Synthetic evaluation project"],
    );
    for (const [key, name, roles] of people) {
      const id = randomUUID(),
        password = randomBytes(18).toString("base64url"),
        email = `${key}@example.test`;
      users[key] = { id, email, password, name };
      await db.query(
        "INSERT INTO users(id,email,name,password_hash,system_account) VALUES($1,$2,$3,$4,$5)",
        [id, email, name, hashPassword(password), key === "worker"],
      );
      for (const role of roles)
        await db.query(
          "INSERT INTO user_roles(user_id,role,site_id) VALUES($1,$2,$3)",
          [
            id,
            role,
            role === "System Administrator" || role === "System Worker"
              ? null
              : key === "outsider"
                ? otherSite
                : site,
          ],
        );
      await db.query(
        "INSERT INTO access_scopes(user_id,site_id,reason) VALUES($1,$2,$3)",
        [
          id,
          key === "outsider" ? otherSite : site,
          "Synthetic development access; not company authorization",
        ],
      );
      if (key === "worker")
        await db.query(
          "INSERT INTO access_scopes(user_id,site_id,reason) VALUES($1,$2,$3)",
          [id, otherSite, "Synthetic worker scope"],
        );
    }
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
    const location = await db.query(
      "INSERT INTO locations(site_id,name,storage_condition) VALUES($1,$2,$3) RETURNING id",
      [site, "WAL / Lab / Freezer 01", "-80 °C · synthetic location"],
    );
    const location2 = await db.query(
      "INSERT INTO locations(site_id,parent_id,name,storage_condition) VALUES($1,$2,$3,$4) RETURNING id",
      [
        site,
        location.rows[0].id,
        "WAL / Lab / Freezer 01 / Rack A",
        "-80 °C · synthetic location",
      ],
    );
    await db.query("COMMIT");
    const result = {
      site,
      otherSite,
      customer,
      project,
      location: location2.rows[0].id,
      users,
    };
    if (credentialFile) {
      await mkdir(dirname(credentialFile), { recursive: true, mode: 0o700 });
      await writeFile(credentialFile, JSON.stringify(result, null, 2), {
        mode: 0o600,
      });
      console.log(
        `Synthetic users created. Private login details: ${credentialFile}`,
      );
    }
    return result;
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    await db.end();
  }
}
if (process.argv[1]?.endsWith("seed.ts")) {
  if (process.env.APP_ENV === "production")
    throw new Error("Synthetic seed is disabled in production");
  await seed(
    process.env.MIGRATION_DATABASE_URL!,
    ".local/demo-credentials.json",
  );
}
