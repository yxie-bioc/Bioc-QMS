import pg, { type PoolClient, type QueryResultRow } from "pg";
import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
pg.types.setTypeParser(1082, (value: string) => value);
export class Fault extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function must(ok: unknown, message: string, status = 409): asserts ok {
  if (!ok) throw new Fault(status, message);
}
export const uuid = z.string().uuid();
export const reason = z.string().trim().min(5).max(4000);
export const text = z.string().trim().min(1).max(20000);
export const actionBase = z.object({
  version: z.number().int().positive(),
  reason,
});
export interface RoleGrant {
  role: string;
  site_id: string | null;
}
export interface Actor {
  id: string;
  email: string;
  name: string;
  roles: RoleGrant[];
  system_account: boolean;
}
export interface RecordRow {
  id: string;
  kind: string;
  site_id: string;
  customer_id: string | null;
  project_id: string | null;
  title: string;
  created_by: string;
  archived: boolean;
}
export type Tx = PoolClient;
let pool: pg.Pool | undefined;
export function getPool() {
  if (!pool) {
    must(process.env.DATABASE_URL, "DATABASE_URL is required", 503);
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: 12,
      connectionTimeoutMillis: 5000,
    });
  }
  return pool;
}
export async function closePool() {
  const current = pool; pool = undefined; await current?.end();
}
export const sha = (s: string | Buffer) =>
  createHash("sha256").update(s).digest("hex");
export const hashPassword = (s: string) => {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(s, salt, 64).toString("hex")}`;
};
export function verifyPassword(s: string, h: string) {
  const [salt, key] = h.split(":");
  if (!salt || !key) return false;
  const expected = Buffer.from(key, "hex");
  const actual = scryptSync(s, salt, 64);
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}
export async function one<T extends QueryResultRow>(
  db: Tx,
  sql: string,
  args: unknown[] = [],
): Promise<T> {
  const r = await db.query<T>(sql, args);
  must(r.rows[0], "Record not found or access denied", 404);
  return r.rows[0];
}
export async function loadActor(db: Tx, id: string): Promise<Actor> {
  const a = await one<Actor>(
    db,
    "SELECT id,email,name,system_account FROM users WHERE id=$1 AND active",
    [id],
  );
  a.roles = (
    await db.query<RoleGrant>(
      "SELECT role,site_id FROM user_roles WHERE user_id=$1",
      [id],
    )
  ).rows;
  return a;
}
export function hasRole(a: Actor, roles: string[], site?: string) {
  return a.roles.some(
    (g) => roles.includes(g.role) && (!g.site_id || g.site_id === site),
  );
}
export function requireRole(a: Actor, roles: string[], site?: string) {
  must(
    hasRole(a, roles, site),
    "You do not have the required business role",
    403,
  );
}
export async function getRecord(db: Tx, id: string, kind?: string) {
  const r = await one<RecordRow>(db, "SELECT * FROM records WHERE id=$1", [id]);
  if (kind) must(r.kind === kind, "Record type mismatch", 400);
  must(!r.archived, "Record is archived");
  return r;
}
export async function accessibleUser(
  db: Tx,
  userId: string,
  recordId: string,
  roles?: string[],
  site?: string,
) {
  must(
    (
      await one<{ ok: boolean }>(db, "SELECT user_can_record($1,$2) ok", [
        userId,
        recordId,
      ])
    ).ok,
    "Assignee must already have access; assigning a task never grants access",
    403,
  );
  const u = await loadActor(db, userId);
  if (roles) requireRole(u, roles, site);
  return u;
}
export async function transaction<T>(
  actorId: string,
  action: string,
  why: string,
  fn: (db: Tx, a: Actor) => Promise<T>,
  idempotency?: { key: string; fingerprint: string },
): Promise<T> {
  const db = await getPool().connect();
  try {
    await db.query("BEGIN");
    await db.query(
      "SELECT set_config('app.actor_id',$1,true),set_config('app.action',$2,true),set_config('app.reason',$3,true)",
      [actorId, action, why],
    );
    const a = await loadActor(db, actorId);
    if (idempotency) {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `${actorId}:${idempotency.key}`,
      ]);
      const prev = await db.query(
        "SELECT fingerprint,response FROM idempotency WHERE actor_id=$1 AND key=$2",
        [actorId, idempotency.key],
      );
      if (prev.rowCount) {
        must(
          prev.rows[0].fingerprint === idempotency.fingerprint,
          "Idempotency key already used for a different request",
        );
        await db.query("COMMIT");
        return prev.rows[0].response as T;
      }
    }
    const result = await fn(db, a);
    if (idempotency)
      await db.query(
        "INSERT INTO idempotency(actor_id,key,fingerprint,response) VALUES($1,$2,$3,$4)",
        [
          actorId,
          idempotency.key,
          idempotency.fingerprint,
          JSON.stringify(result),
        ],
      );
    await db.query("COMMIT");
    return result;
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
}
export const scopeInput = z.object({
  siteId: uuid,
  customerId: uuid.nullable().optional(),
  projectId: uuid.nullable().optional(),
  title: text,
});
export type ScopeInput = z.infer<typeof scopeInput>;
export async function createRecord(
  db: Tx,
  a: Actor,
  kind: string,
  input: ScopeInput,
) {
  if (input.projectId) {
    const p = await one<{ site_id: string; customer_id: string | null }>(
      db,
      "SELECT site_id,customer_id FROM projects WHERE id=$1",
      [input.projectId],
    );
    must(
      p.site_id === input.siteId &&
        p.customer_id === (input.customerId ?? null),
      "Project must match site and customer",
      400,
    );
  }
  return one<RecordRow>(
    db,
    "INSERT INTO records(kind,site_id,customer_id,project_id,title,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
    [
      kind,
      input.siteId,
      input.customerId ?? null,
      input.projectId ?? null,
      input.title,
      a.id,
    ],
  );
}
export async function evidence(
  db: Tx,
  id: string | undefined | null,
  recordId: string,
) {
  must(id, "Evidence attachment is required", 400);
  const f = await one<{ id: string; record_id: string }>(
    db,
    "SELECT id,record_id FROM attachments WHERE id=$1",
    [id],
  );
  must(f.record_id === recordId, "Evidence must belong to this record", 400);
  return id;
}
export async function addTask(
  db: Tx,
  r: string,
  assignee: string,
  kind: string,
  title: string,
  due: string,
  condition: string,
  revisionId: string | null = null,
  trainingId: string | null = null,
) {
  await accessibleUser(db, assignee, r);
  return one<{ id: string }>(
    db,
    `INSERT INTO tasks(record_id,assignee_id,kind,title,due_at,completion_condition,revision_id,training_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [r, assignee, kind, title, due, condition, revisionId, trainingId],
  );
}
export async function versioned<T extends QueryResultRow & { version: number }>(
  db: Tx,
  table: string,
  id: string,
  version: number,
  key = "record_id",
): Promise<T> {
  const tables = [
    "revisions",
    "tasks",
    "deviations",
    "capas",
    "changes",
    "audits",
    "findings",
    "approved_answers",
    "questionnaires",
    "questions",
    "lots",
    "containers",
    "ehs_records",
  ];
  must(
    tables.includes(table) && ["record_id", "id"].includes(key),
    "Invalid entity",
    400,
  );
  const row = await one<T>(
    db,
    `SELECT * FROM ${table} WHERE ${key}=$1 FOR UPDATE`,
    [id],
  );
  must(
    row.version === version,
    "This record changed. Refresh before retrying.",
  );
  return row;
}
