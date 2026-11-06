import { startLocal } from "./local-postgres";
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
const server = await startLocal(true);
try {
  const tests = (await readdir("tests"))
    .filter((x) => x.endsWith(".test.ts"))
    .map((x) => `tests/${x}`);
  const child = spawn(
    process.execPath,
    [
      "--env-file=" + server.envFile,
      "--import",
      "tsx",
      "--test",
      "--test-concurrency=1",
      ...tests,
    ],
    { stdio: "inherit", env: process.env },
  );
  process.exitCode = await new Promise<number>((r) =>
    child.on("exit", (c) => r(c ?? 1)),
  );
} finally {
  await server.stop();
}
