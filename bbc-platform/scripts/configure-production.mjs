import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
const [origin, email] = process.argv.slice(2);
if (!origin?.startsWith("https://") || !email?.includes("@"))
  throw new Error(
    "Usage: node scripts/configure-production.mjs https://your-internal-host administrator@company.com",
  );
const secret = () => randomBytes(32).toString("hex");
const config = {
  APP_ORIGIN: origin,
  POSTGRES_PASSWORD: secret(),
  BBC_OWNER_PASSWORD: secret(),
  BBC_WEB_PASSWORD: secret(),
  BBC_WORKER_PASSWORD: secret(),
  BOOTSTRAP_EMAIL: email,
  BOOTSTRAP_NAME: "Platform Administrator",
  BOOTSTRAP_PASSWORD: secret(),
};
await writeFile(
  ".env.deploy",
  Object.entries(config)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n") + "\n",
  { mode: 0o600, flag: "wx" },
);
console.log(
  "Created private .env.deploy. Move secrets to company-controlled secret management before deployment. No services were started.",
);
