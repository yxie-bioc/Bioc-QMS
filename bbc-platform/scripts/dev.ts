import { startLocal } from "./local-postgres";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
// Dev-only service composition also works in isolated execution environments.
if (process.env.APP_ENV === "production")
  throw new Error("Use the production start command with external PostgreSQL.");
const db = await startLocal();
for (const line of (await readFile(".env.ops.local", "utf8"))
  .trim()
  .split("\n")) {
  const i = line.indexOf("=");
  process.env[line.slice(0, i)] = line.slice(i + 1);
}
const { migrate } = await import("./migrate");
const { seed } = await import("./seed");
await migrate(process.env.MIGRATION_DATABASE_URL!);
await seed(process.env.MIGRATION_DATABASE_URL!, ".local/demo-credentials.json");
const { populate } = await import("./sample-data");
await populate();
const { getPool } = await import("../src/server/core");
await getPool().end();
const runtimeEnv = { ...process.env };
for (const name of [
  "MIGRATION_DATABASE_URL",
  "ADMIN_DATABASE_URL",
  "TEST_DATABASE_URL",
  "TEST_MIGRATION_DATABASE_URL",
  "WORKER_DATABASE_URL",
])
  delete runtimeEnv[name];
const workerEnv = {
  ...runtimeEnv,
  DATABASE_URL: process.env.WORKER_DATABASE_URL,
};
const worker = spawn(
  process.execPath,
  ["--import", "tsx", "scripts/worker.ts"],
  { stdio: "inherit", env: workerEnv },
);
const workerExit = new Promise<void>((r) => worker.on("exit", () => r()));
const portAt = process.argv.indexOf("--port");
const hostAt = process.argv.indexOf("--host");
const next = spawn(
  process.execPath,
  [
    "node_modules/next/dist/bin/next",
    "dev",
    "--hostname",
    hostAt >= 0 ? process.argv[hostAt + 1] : "0.0.0.0",
    "--port",
    portAt >= 0 ? process.argv[portAt + 1] : (process.env.PORT ?? "3000"),
  ],
  { stdio: "inherit", env: runtimeEnv },
);
const stop = () => {
  next.kill("SIGTERM");
  worker.kill("SIGTERM");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
const exit = await new Promise<number>((r) =>
  next.on("exit", (c) => r(c ?? 0)),
);
worker.kill("SIGTERM");
await workerExit;
await db.stop();
process.exitCode = exit;
