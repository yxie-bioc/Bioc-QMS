import pg from "pg";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
// Versioned application-consistent logical backup. Immutable attachment bytes are
// copied from the same REPEATABLE READ snapshot. This is not PostgreSQL PITR.
const tables = [
  "sites",
  "customers",
  "projects",
  "users",
  "user_roles",
  "records",
  "access_scopes",
  "workflow_rules",
  "attachments",
  "documents",
  "training_requirements",
  "revisions",
  "approvals",
  "training",
  "deviations",
  "capas",
  "quality_links",
  "changes",
  "audits",
  "findings",
  "approved_answers",
  "questionnaires",
  "questions",
  "questionnaire_submissions",
  "locations",
  "materials",
  "material_uses",
  "lots",
  "containers",
  "inventory_transactions",
  "ehs_records",
  "tasks",
  "idempotency",
  "notification_outbox",
  "notifications",
  "worker_runs",
  "audit_events",
] as const;
interface Dump {
  format: 1;
  createdAt: string;
  serverVersion: string;
  migrations: { name: string; sha256: string }[];
  tables: Record<string, Record<string, unknown>[]>;
  jsonColumns: Record<string, string[]>;
  files: { key: string; sha256: string; size: number }[];
}
const hash = (b: Buffer | string) =>
  createHash("sha256").update(b).digest("hex");
async function emptyDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if ((await readdir(path)).length)
    throw new Error(`Destination must be empty: ${path}`);
}
export async function makeBackup(
  databaseUrl: string,
  attachmentDir: string,
  target: string,
) {
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  try {
    await emptyDirectory(target);
    await mkdir(join(target, "attachments"), { mode: 0o700 });
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const identity = await db.query(
      "SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
    );
    if (identity.rows[0].current_user !== "bbc_owner")
      throw new Error(
        "Use the dedicated migration/backup owner account; runtime RLS would omit records.",
      );
    const known = new Set<string>([
      ...tables,
      "schema_migrations",
      "sessions",
      "login_attempts",
    ]);
    const observed = (
      await db.query(
        "SELECT tablename FROM pg_tables WHERE schemaname='public'",
      )
    ).rows;
    if (observed.some((r) => !known.has(r.tablename)))
      throw new Error(
        "Unregistered table found: update the backup inventory before proceeding",
      );
    const dump: Dump = {
      format: 1,
      createdAt: new Date().toISOString(),
      serverVersion: (await db.query("SHOW server_version")).rows[0]
        .server_version,
      migrations: (
        await db.query(
          "SELECT name,sha256 FROM schema_migrations ORDER BY name",
        )
      ).rows,
      tables: {},
      jsonColumns: {},
      files: [],
    };
    for (const table of tables) {
      dump.tables[table] = (await db.query(`SELECT * FROM ${table}`)).rows;
      dump.jsonColumns[table] = (
        await db.query(
          "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND udt_name IN ('json','jsonb')",
          [table],
        )
      ).rows.map((r) => r.column_name);
    }
    for (const f of dump.tables.attachments) {
      const key = String(f.storage_key);
      if (!/^[a-f0-9-]{36}$/.test(key))
        throw new Error("Invalid attachment key");
      const bytes = await readFile(join(attachmentDir, key));
      if (hash(bytes) !== f.sha256)
        throw new Error(`Attachment checksum mismatch: ${key}`);
      await writeFile(join(target, "attachments", key), bytes, {
        mode: 0o400,
        flag: "wx",
      });
      dump.files.push({ key, sha256: String(f.sha256), size: bytes.length });
    }
    const bytes = JSON.stringify(dump);
    await writeFile(join(target, "database.json"), bytes, {
      mode: 0o600,
      flag: "wx",
    });
    await writeFile(
      join(target, "manifest.json"),
      JSON.stringify({
        format: 1,
        createdAt: dump.createdAt,
        databaseSha256: hash(bytes),
        files: dump.files.length,
        records: dump.tables.records.length,
      }),
      { mode: 0o600, flag: "wx" },
    );
    await db.query("COMMIT");
    return {
      files: dump.files.length,
      records: dump.tables.records.length,
      path: resolve(target),
    };
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    await db.end();
  }
}
export async function restoreBackup(
  databaseUrl: string,
  backupPath: string,
  attachmentDir: string,
) {
  const manifest = JSON.parse(
    await readFile(join(backupPath, "manifest.json"), "utf8"),
  );
  const raw = await readFile(join(backupPath, "database.json"), "utf8");
  if (hash(raw) !== manifest.databaseSha256)
    throw new Error("Database backup checksum mismatch");
  const dump = JSON.parse(raw) as Dump;
  if (dump.format !== 1) throw new Error("Unsupported backup format");
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  try {
    const existing = await db.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='records'",
    );
    if (
      existing.rowCount &&
      (await db.query("SELECT id FROM records LIMIT 1")).rowCount
    )
      throw new Error(
        "Restore requires a new empty database; refusing overwrite",
      );
    const { migrate } = await import("./migrate");
    await migrate(databaseUrl);
    const migrations = (
      await db.query("SELECT name,sha256 FROM schema_migrations ORDER BY name")
    ).rows;
    if (JSON.stringify(migrations) !== JSON.stringify(dump.migrations))
      throw new Error("Restore source schema does not match this release");
    await emptyDirectory(attachmentDir);
    for (const file of dump.files) {
      if (!/^[a-f0-9-]{36}$/.test(file.key))
        throw new Error("Invalid file key");
      const bytes = await readFile(join(backupPath, "attachments", file.key));
      if (hash(bytes) !== file.sha256 || bytes.length !== file.size)
        throw new Error("Attachment backup checksum mismatch");
      await writeFile(join(attachmentDir, file.key), bytes, {
        mode: 0o440,
        flag: "wx",
      });
    }
    await db.query("BEGIN");
    for (const table of tables)
      await db.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
    for (const table of tables) {
      let rows = dump.tables[table];
      if (["containers", "locations"].includes(table)) {
        const pending = [...rows],
          ordered: Record<string, unknown>[] = [],
          seen = new Set<unknown>();
        while (pending.length) {
          const i = pending.findIndex(
            (x) => !x.parent_id || seen.has(x.parent_id),
          );
          if (i < 0)
            throw new Error("Broken or cyclic parent lineage in backup");
          const [row] = pending.splice(i, 1);
          ordered.push(row);
          seen.add(row.id);
        }
        rows = ordered;
      }
      for (const row of rows) {
        const columns = Object.keys(row);
        if (columns.some((c) => !/^[a-z_][a-z0-9_]*$/.test(c)))
          throw new Error("Invalid column");
        const values = columns.map((c) =>
          dump.jsonColumns[table].includes(c) && row[c] !== null
            ? JSON.stringify(row[c])
            : row[c],
        );
        await db.query(
          `INSERT INTO ${table} (${columns.map((c) => '"' + c + '"').join(",")}) OVERRIDING SYSTEM VALUE VALUES (${values.map((_, i) => "$" + (i + 1)).join(",")})`,
          values,
        );
      }
    }
    for (const table of tables)
      await db.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
    await db.query(
      "SELECT setval(pg_get_serial_sequence('audit_events','id'),greatest(coalesce((SELECT max(id) FROM audit_events),0),1))",
    );
    const ledgerMismatches = Number(
      (
        await db.query(
          "SELECT count(*) n FROM (SELECT c.id,c.quantity,coalesce(sum(t.delta),0) ledger FROM containers c LEFT JOIN inventory_transactions t ON t.container_id=c.id GROUP BY c.id HAVING c.quantity<>coalesce(sum(t.delta),0)) x",
        )
      ).rows[0].n,
    );
    const brokenRevisionLinks = Number(
      (
        await db.query(
          "SELECT count(*) n FROM revisions v LEFT JOIN attachments f ON f.id=v.file_id WHERE v.file_id IS NOT NULL AND (f.id IS NULL OR f.record_id<>v.record_id)",
        )
      ).rows[0].n,
    );
    if (ledgerMismatches || brokenRevisionLinks)
      throw new Error("Restored relationship or ledger mismatch");
    const counts: Record<string, number> = {};
    for (const table of tables) {
      counts[table] = Number(
        (await db.query(`SELECT count(*) n FROM ${table}`)).rows[0].n,
      );
      if (counts[table] !== dump.tables[table].length)
        throw new Error(`Restored row count mismatch: ${table}`);
    }
    await db.query(
      "INSERT INTO audit_events(entity,entity_id,action,reason,after_data) VALUES($1,$2,$3,$4,$5)",
      [
        "maintenance",
        randomUUID(),
        "Backup.restore",
        "Restored into a new database with file checksum and relationship checks",
        JSON.stringify({
          sourceCreatedAt: dump.createdAt,
          databaseSha256: manifest.databaseSha256,
          counts,
        }),
      ],
    );
    await db.query("COMMIT");
    return {
      files: dump.files.length,
      records: counts.records,
      ledgerMismatches,
      brokenRevisionLinks,
      counts,
    };
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    await db.end();
  }
}
if (process.argv[1]?.endsWith("/backup.ts")) {
  const target =
    process.argv[2] ??
    `backups/${new Date().toISOString().replace(/[:.]/g, "-")}`;
  console.log(
    await makeBackup(
      process.env.MIGRATION_DATABASE_URL!,
      process.env.ATTACHMENT_DIR ?? "var/attachments",
      target,
    ),
  );
}
