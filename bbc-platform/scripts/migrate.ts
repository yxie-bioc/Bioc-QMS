import pg from "pg";
import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
export async function migrate(url: string) {
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  try {
    await db.query("SELECT pg_advisory_lock(420917)");
    await db.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const f of (await readdir("db/migrations"))
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      const sql = await readFile(`db/migrations/${f}`, "utf8"),
        hash = createHash("sha256").update(sql).digest("hex");
      const existing = await db.query(
        "SELECT sha256 FROM schema_migrations WHERE name=$1",
        [f],
      );
      if (existing.rowCount) {
        if (existing.rows[0].sha256 !== hash)
          throw new Error(`Applied migration changed: ${f}`);
        continue;
      }
      await db.query("BEGIN");
      try {
        await db.query(
          "SELECT set_config('app.action','Migration.apply',true),set_config('app.reason',$1,true)",
          [f],
        );
        await db.query(sql);
        await db.query(
          "INSERT INTO schema_migrations(name,sha256) VALUES($1,$2)",
          [f, hash],
        );
        await db.query("COMMIT");
        console.log(`Applied ${f}`);
      } catch (e) {
        await db.query("ROLLBACK");
        throw e;
      }
    }
  } finally {
    await db.query("SELECT pg_advisory_unlock(420917)");
    await db.end();
  }
}
if (process.argv[1]?.endsWith("migrate.ts")) {
  if (!process.env.MIGRATION_DATABASE_URL)
    throw new Error("MIGRATION_DATABASE_URL required");
  await migrate(process.env.MIGRATION_DATABASE_URL);
}
