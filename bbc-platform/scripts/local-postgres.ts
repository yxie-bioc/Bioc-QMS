import EmbeddedPostgres from "embedded-postgres";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { spawn } from "node:child_process";
export async function startLocal(isTest = false) {
  const dir = isTest ? ".local/test-runtime" : ".local";
  await mkdir(dir, { recursive: true, mode: 0o700 });
  let secret: { admin: string; owner: string; web: string; worker: string };
  try {
    secret = JSON.parse(await readFile(`${dir}/db-secrets.json`, "utf8"));
  } catch {
    secret = Object.fromEntries(
      ["admin", "owner", "web", "worker"].map((k) => [
        k,
        randomBytes(32).toString("hex"),
      ]),
    ) as typeof secret;
    await writeFile(`${dir}/db-secrets.json`, JSON.stringify(secret), {
      mode: 0o600,
    });
  }
  const port = 55432;
  const server = new EmbeddedPostgres({
    databaseDir: `${dir}/postgres`,
    user: "postgres",
    password: secret.admin,
    port,
    persistent: true,
    authMethod: "scram-sha-256",
    postgresFlags: ["-h", "127.0.0.1", "-c", "unix_socket_directories="],
    onLog: () => {},
    onError: (e) => {
      if (String(e).includes("FATAL")) console.error(e);
    },
  });
  try {
    await access(`${dir}/postgres/PG_VERSION`);
  } catch {
    await server.initialise();
  }
  await server.start();
  const client = new pg.Client({
    host: "127.0.0.1",
    port,
    user: "postgres",
    password: secret.admin,
    database: "postgres",
  });
  await client.connect();
  for (const [role, pwd] of [
    ["bbc_owner", secret.owner],
    ["bbc_web", secret.web],
    ["bbc_worker", secret.worker],
  ]) {
    if (
      !(await client.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role]))
        .rowCount
    )
      await client.query(
        `CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${pwd}'`,
      );
  }
  if (
    !(await client.query("SELECT 1 FROM pg_roles WHERE rolname='bbc_runtime'"))
      .rowCount
  )
    await client.query(
      "CREATE ROLE bbc_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS",
    );
  await client.query("GRANT bbc_runtime TO bbc_web,bbc_worker");
  for (const db of ["bbc_dev", "bbc_test"])
    if (
      !(await client.query("SELECT 1 FROM pg_database WHERE datname=$1", [db]))
        .rowCount
    )
      await client.query(`CREATE DATABASE ${db} OWNER bbc_owner`);
  await client.end();
  const url = (u: string, p: string, db: string) =>
    `postgresql://${u}:${p}@127.0.0.1:${port}/${db}`;
  const runtime = [
    `DATABASE_URL=${url("bbc_web", secret.web, "bbc_dev")}`,
    `ATTACHMENT_DIR=${isTest ? "./var/test-attachments" : "./var/attachments"}`,
    `APP_ENV=${isTest ? "test" : "development"}`,
    "APP_ORIGIN=http://localhost:3000",
    "NOTIFICATION_ADAPTER=in-app",
    "COOKIE_SECURE=false",
    "NEXT_TELEMETRY_DISABLED=1",
  ];
  const operations = [
    ...runtime,
    `MIGRATION_DATABASE_URL=${url("bbc_owner", secret.owner, "bbc_dev")}`,
    `WORKER_DATABASE_URL=${url("bbc_worker", secret.worker, "bbc_dev")}`,
    `TEST_DATABASE_URL=${url("bbc_web", secret.web, "bbc_test")}`,
    `TEST_MIGRATION_DATABASE_URL=${url("bbc_owner", secret.owner, "bbc_test")}`,
    `ADMIN_DATABASE_URL=${url("postgres", secret.admin, "postgres")}`,
  ];
  if (isTest)
    await writeFile(".env.test.local", operations.join("\n") + "\n", {
      mode: 0o600,
    });
  else {
    await writeFile(".env.local", runtime.join("\n") + "\n", { mode: 0o600 });
    await writeFile(".env.ops.local", operations.join("\n") + "\n", {
      mode: 0o600,
    });
    await writeFile(
      ".env.worker.local",
      [
        ...runtime.filter((x) => !x.startsWith("DATABASE_URL=")),
        `DATABASE_URL=${url("bbc_worker", secret.worker, "bbc_dev")}`,
      ].join("\n") + "\n",
      { mode: 0o600 },
    );
  }
  console.log(
    `PostgreSQL 17 ready. Environment: ${isTest ? "test" : "development"}. Credentials remain private.`,
  );
  return {
    stop: () => server.stop(),
    envFile: isTest ? ".env.test.local" : ".env.local",
  };
}
if (process.argv[1]?.endsWith("/local-postgres.ts")) {
  const server = await startLocal(process.argv.includes("--test"));
  let resolveStop: () => void = () => {};
  const stopped = new Promise<void>((r) => {
    resolveStop = r;
  });
  const stop = async () => {
    await server.stop();
    resolveStop();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const runAt = process.argv.indexOf("--run");
  if (runAt >= 0) {
    const child = spawn(
      process.argv[runAt + 1],
      process.argv.slice(runAt + 2),
      { stdio: "inherit", env: process.env },
    );
    const code = await new Promise<number>((resolve) =>
      child.on("exit", (c) => resolve(c ?? 1)),
    );
    await server.stop();
    process.exitCode = code;
  } else await stopped;
}
