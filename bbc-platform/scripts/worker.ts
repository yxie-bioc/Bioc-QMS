if (process.env.WORKER_DATABASE_URL)
  process.env.DATABASE_URL = process.env.WORKER_DATABASE_URL;
const { runWorker } = await import("../src/server/worker");
const { getPool } = await import("../src/server/core");
let stopping = false;
let wake: (() => void) | undefined;
for (const s of ["SIGINT", "SIGTERM"])
  process.on(s, () => {
    stopping = true;
    wake?.();
  });
console.log(
  "Server reminder worker started. Delivery: in-app; no external email integration.",
);
do {
  try {
    console.log(
      JSON.stringify({ at: new Date().toISOString(), ...(await runWorker()) }),
    );
  } catch {
    console.error(
      "Worker iteration failed; database/runtime connection requires attention.",
    );
  }
  if (process.argv.includes("--once")) break;
  if (!stopping)
    await new Promise<void>((r) => {
      const timer = setTimeout(r, 30000);
      wake = () => {
        clearTimeout(timer);
        r();
      };
    });
} while (!stopping);
await getPool().end();

export {};
