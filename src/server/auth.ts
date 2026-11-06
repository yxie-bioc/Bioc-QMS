import {
  getPool,
  hashPassword,
  verifyPassword,
  sha,
  must,
  Fault,
  transaction,
  requireRole,
  one,
  uuid,
  reason,
  scopeInput,
} from "./core";
import { randomBytes } from "node:crypto";
import { z } from "zod";
const dummyHash = hashPassword(randomBytes(32).toString("hex"));
export async function login(input: unknown) {
  const data = z
    .object({
      email: z
        .email()
        .max(254)
        .transform((x) => x.toLowerCase()),
      password: z.string().min(1).max(200),
    })
    .parse(input);
  const db = await getPool().connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,1))", [
      data.email,
    ]);
    const attempt = await db.query(
      "SELECT * FROM login_attempts WHERE email=$1",
      [data.email],
    );
    if (
      attempt.rows[0]?.blocked_until &&
      new Date(attempt.rows[0].blocked_until) > new Date()
    ) {
      await db.query("COMMIT");
      throw new Fault(429, "Too many sign-in attempts. Try again later.");
    }
    const result = await db.query(
      "SELECT * FROM users WHERE email=$1 AND NOT system_account",
      [data.email],
    );
    const u = result.rows[0];
    if (
      !verifyPassword(data.password, u?.password_hash ?? dummyHash) ||
      !u?.active
    ) {
      await db.query(
        `INSERT INTO login_attempts(email,failures,blocked_until) VALUES($1,1,NULL) ON CONFLICT(email) DO UPDATE SET failures=CASE WHEN login_attempts.blocked_until<now() THEN 1 ELSE login_attempts.failures+1 END, blocked_until=CASE WHEN login_attempts.failures>=4 THEN now()+interval '15 minutes' ELSE NULL END`,
        [data.email],
      );
      await db.query("COMMIT");
      throw new Fault(401, "Invalid email or password");
    }
    await db.query(
      "UPDATE login_attempts SET failures=0,blocked_until=NULL WHERE email=$1",
      [data.email],
    );
    const token = randomBytes(32).toString("hex");
    await db.query(
      "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '8 hours')",
      [sha(token), u.id],
    );
    await db.query("COMMIT");
    return { token, userId: u.id };
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
}
export async function authenticate(request: Request) {
  const token = request.headers
    .get("cookie")
    ?.split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith("bbc_session="))
    ?.slice(12);
  must(token && /^[a-f0-9]{64}$/.test(token), "Sign in required", 401);
  const r = await getPool().query(
    "SELECT s.user_id FROM sessions s JOIN users u ON u.id=s.user_id WHERE token_hash=$1 AND expires_at>now() AND u.active AND NOT u.system_account",
    [sha(token)],
  );
  must(r.rows[0], "Session expired or account disabled", 401);
  return r.rows[0].user_id as string;
}
export async function logout(request: Request) {
  const token = request.headers
    .get("cookie")
    ?.split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith("bbc_session="))
    ?.slice(12);
  if (token)
    await getPool().query("DELETE FROM sessions WHERE token_hash=$1", [
      sha(token),
    ]);
}
export function checkOrigin(req: Request) {
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const allowed = new Set([process.env.APP_ORIGIN, new URL(req.url).origin]);
  if (host) allowed.add(`${new URL(req.url).protocol}//${host}`);
  must(origin && allowed.has(origin), "Request origin is not allowed", 403);
  must(
    req.headers.get("sec-fetch-site") !== "cross-site",
    "Cross-site request denied",
    403,
  );
}
export const roles = [
  "Employee",
  "Document Owner",
  "Reviewer",
  "Approver",
  "QA",
  "Investigator",
  "Inventory Custodian",
  "EHS Coordinator",
  "System Administrator",
] as const;
export async function manageUser(
  actorId: string,
  action: string,
  input: unknown,
  key: string,
) {
  const schema = z.object({
    userId: uuid.optional(),
    scopeId: uuid.optional(),
    email: z.email().optional(),
    name: z.string().min(2).max(100).optional(),
    password: z.string().min(14).max(200).optional(),
    role: z.enum(roles).optional(),
    siteId: uuid.optional(),
    customerId: uuid.nullable().optional(),
    projectId: uuid.nullable().optional(),
    recordId: uuid.nullable().optional(),
    expiresAt: z.iso.datetime().nullable().optional(),
    reason,
  });
  const d = schema.parse(input);
  return transaction(
    actorId,
    `User.${action}`,
    d.reason,
    async (db, a) => {
      requireRole(a, ["System Administrator"]);
      if (action === "create") {
        must(
          d.email && d.name && d.password,
          "Email, name and password required",
          400,
        );
        const u = await one<{ id: string }>(
          db,
          "INSERT INTO users(email,name,password_hash) VALUES($1,$2,$3) RETURNING id",
          [d.email.toLowerCase(), d.name, hashPassword(d.password)],
        );
        return u;
      }
      must(d.userId, "User is required", 400);
      const u = await one<{ id: string; system_account: boolean }>(
        db,
        "SELECT id,system_account FROM users WHERE id=$1 FOR UPDATE",
        [d.userId],
      );
      must(!u.system_account, "System account cannot be managed here");
      if (action === "disable") {
        must(
          u.id !== a.id,
          "Use another administrator to disable this account",
        );
        await db.query("UPDATE users SET active=false WHERE id=$1", [u.id]);
        await db.query("DELETE FROM sessions WHERE user_id=$1", [u.id]);
      } else if (action === "enable")
        await db.query("UPDATE users SET active=true WHERE id=$1", [u.id]);
      else if (action === "revoke-scope") {
        must(d.scopeId, "Scope grant required", 400);
        const grant = await one<{ user_id: string }>(
          db,
          "SELECT user_id FROM access_scopes WHERE id=$1",
          [d.scopeId],
        );
        must(grant.user_id === u.id, "Scope does not belong to this user", 400);
        must(
          u.id !== a.id,
          "Use another administrator to revoke your own scope",
        );
        await db.query("DELETE FROM access_scopes WHERE id=$1", [d.scopeId]);
      } else if (action === "grant-role") {
        must(d.role, "Role required", 400);
        must(
          d.siteId || d.role === "System Administrator",
          "Business roles require a site",
          400,
        );
        await db.query(
          "INSERT INTO user_roles(user_id,role,site_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [u.id, d.role, d.siteId ?? null],
        );
      } else if (action === "revoke-role") {
        must(d.role, "Role required", 400);
        must(
          !(u.id === a.id && d.role === "System Administrator"),
          "Cannot remove your own administrator role",
        );
        await db.query(
          "DELETE FROM user_roles WHERE user_id=$1 AND role=$2 AND site_id IS NOT DISTINCT FROM $3",
          [u.id, d.role, d.siteId ?? null],
        );
      } else if (action === "grant-scope") {
        must(d.siteId, "Site required", 400);
        if (d.projectId) {
          const p = await one<{ site_id: string; customer_id: string | null }>(
            db,
            "SELECT site_id,customer_id FROM projects WHERE id=$1",
            [d.projectId],
          );
          must(
            p.site_id === d.siteId && p.customer_id === (d.customerId ?? null),
            "Project scope must match site and customer",
            400,
          );
        }
        if (d.recordId) {
          const r = await one<{
            site_id: string;
            customer_id: string | null;
            project_id: string | null;
          }>(db, "SELECT * FROM records WHERE id=$1", [d.recordId]);
          must(
            r.site_id === d.siteId &&
              (!d.customerId || r.customer_id === d.customerId) &&
              (!d.projectId || r.project_id === d.projectId),
            "Record scope mismatch",
            400,
          );
        }
        await db.query(
          "INSERT INTO access_scopes(user_id,site_id,customer_id,project_id,record_id,expires_at,granted_by,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            u.id,
            d.siteId,
            d.customerId ?? null,
            d.projectId ?? null,
            d.recordId ?? null,
            d.expiresAt ?? null,
            a.id,
            d.reason,
          ],
        );
      } else throw new Fault(400, "Unsupported account action");
      return { id: u.id };
    },
    { key, fingerprint: sha(JSON.stringify([action, d])) },
  );
}
