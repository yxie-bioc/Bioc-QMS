import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { migrate } from "../scripts/migrate";
import { seed } from "../scripts/seed";
import { getPool, transaction, one, sha, addTask } from "../src/server/core";
import {
  createDocument,
  documentAction,
  reviseDocument,
  completeTraining,
  configureTraining,
  editDraft,
} from "../src/server/documents";
import { upload, download } from "../src/server/files";
import { listRecords, detail } from "../src/server/queries";
import {
  createQuality,
  qualityAction,
  findingAction,
} from "../src/server/quality";
import {
  createAnswer,
  answerAction,
  createQuestionnaire,
  addQuestion,
  questionnaireAction,
  updateQuestion,
} from "../src/server/questionnaires";
import {
  createMaterial,
  receiveLot,
  lotAction,
  containerAction,
} from "../src/server/inventory";
import { taskAction, createTask } from "../src/server/tasks";
import { manageUser, login } from "../src/server/auth";
import { runWorker } from "../src/server/worker";
import { GET, POST } from "../src/app/api/[...path]/route";
import { NextRequest } from "next/server";
import { makeBackup, restoreBackup } from "../scripts/backup";
const testRoot = process.env.TEST_WORK_DIR!;
let s: NonNullable<Awaited<ReturnType<typeof seed>>>;
let doc: { id: string; revisionId: string }, fileId: string;
let owner: pg.Client;
const key = () => randomUUID();
const why = "Synthetic test evidence for controlled transition";
const file = (title = "Synthetic test PDF") =>
  new File([Buffer.from(`%PDF-1.4\n${title}\n%%EOF\n`)], "synthetic.pdf", {
    type: "application/pdf",
  });
const who = (name: string) => s.users[name].id;
const scope = () => ({
  siteId: s.site,
  customerId: s.customer,
  projectId: s.project,
});
const revision = async (id = doc.revisionId) =>
  transaction(who("owner"), "Read.test", "Read current revision", (db) =>
    one<{ version: number; status: string }>(
      db,
      "SELECT version,status FROM revisions WHERE id=$1",
      [id],
    ),
  );
const business = async (id: string, table: string) =>
  transaction(who("qa"), "Read.test", "Read current record", (db) =>
    one<{ version: number; status: string }>(
      db,
      `SELECT version,status FROM ${table} WHERE record_id=$1`,
      [id],
    ),
  );
async function actDoc(
  user: string,
  action: string,
  extra: object = {},
  id = doc.revisionId,
) {
  return documentAction(
    who(user),
    id,
    action,
    { version: (await revision(id)).version, reason: why, ...extra },
    key(),
  );
}
async function apiGet(path: string, token?: string) {
  return GET(
    new NextRequest(`http://localhost:3000/api/${path}`, {
      headers: token ? { cookie: `bbc_session=${token}` } : {},
    }),
    { params: Promise.resolve({ path: path.split("?")[0].split("/") }) },
  );
}
async function apiPost(
  path: string,
  body: unknown,
  token?: string,
  origin = "http://localhost:3000",
) {
  return POST(
    new NextRequest(`http://localhost:3000/api/${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        "Idempotency-Key": key(),
        ...(token ? { cookie: `bbc_session=${token}` } : {}),
      },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ path: path.split("/") }) },
  );
}
before(async () => {
  assert.equal(process.env.APP_ENV, "test");
  assert.ok(process.env.TEST_MIGRATION_DATABASE_URL?.endsWith("/bbc_test"));
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  owner = new pg.Client({
    connectionString: process.env.TEST_MIGRATION_DATABASE_URL,
  });
  await owner.connect();
  await owner.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  await migrate(process.env.TEST_MIGRATION_DATABASE_URL!);
  s = (await seed(process.env.TEST_MIGRATION_DATABASE_URL!))!;
  await mkdir(testRoot, { recursive: true });
  await writeFile(`${testRoot}/fixtures.json`, JSON.stringify(s), {
    mode: 0o600,
  });
});
after(async () => {
  await getPool().end();
  await owner.end();
});
test("Runtime identity is non-owner, non-superuser, NOBYPASSRLS; record RLS is active", async () => {
  const r = await getPool().query(
    "SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
  );
  assert.equal(r.rows[0].current_user, "bbc_web");
  assert.equal(r.rows[0].rolsuper, false);
  assert.equal(r.rows[0].rolbypassrls, false);
  const worker = new pg.Client({
    connectionString: process.env.WORKER_DATABASE_URL!.replace(
      "/bbc_dev",
      "/bbc_test",
    ),
  });
  await worker.connect();
  try {
    const identity = (
      await worker.query(
        "SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
      )
    ).rows[0];
    assert.equal(identity.current_user, "bbc_worker");
    assert.equal(identity.rolsuper, false);
    assert.equal(identity.rolbypassrls, false);
    assert.equal((await worker.query("SELECT * FROM records")).rowCount, 0);
  } finally {
    await worker.end();
  }

  const policy = await getPool().query(
    "SELECT relrowsecurity,pg_get_userbyid(relowner) owner FROM pg_class WHERE relname='records'",
  );
  assert.equal(policy.rows[0].relrowsecurity, true);
  assert.equal(policy.rows[0].owner, "bbc_owner");
  assert.equal((await getPool().query("SELECT * FROM records")).rowCount, 0);
});
test("Public API, search, exports and mutations require authentication; login checks origin", async () => {
  for (const path of [
    "overview",
    "records",
    "search?q=secret",
    "export",
    "attachments/" + key(),
  ])
    assert.equal((await apiGet(path)).status, 401);
  assert.equal((await apiPost("documents", {})).status, 401);
  assert.equal(
    (
      await apiPost(
        "auth/login",
        { email: s.users.owner.email, password: s.users.owner.password },
        undefined,
        "https://untrusted.example",
      )
    ).status,
    403,
  );
  const response = await apiPost("auth/login", {
    email: s.users.owner.email,
    password: s.users.owner.password,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie")!, /HttpOnly/i);
  assert.match(response.headers.get("set-cookie")!, /SameSite=strict/i);
});
test("Create a real SOP with a private file; scope is enforced for API, search, export and download", async () => {
  doc = await createDocument(
    who("owner"),
    {
      ...scope(),
      title: "Synthetic controlled SOP",
      number: "SYN-SOP-001",
      department: "QA",
      changeReason: why,
      trainingMode: "Read acknowledgement",
      trainingBeforeEffective: true,
      reviewDue: "2030-12-31",
    },
    key(),
  );
  fileId = (await upload(who("owner"), doc.id, file(), doc.revisionId, 1)).id;
  assert.equal(
    (await download(who("owner"), fileId)).bytes.subarray(0, 5).toString(),
    "%PDF-",
  );
  const outsider = await login({
    email: s.users.outsider.email,
    password: s.users.outsider.password,
  });
  for (const path of [`records/${doc.id}`, `attachments/${fileId}`])
    assert.equal((await apiGet(path, outsider.token)).status, 404);
  assert.deepEqual(
    await (await apiGet("search?q=Synthetic", outsider.token)).json(),
    [],
  );
  assert.equal(
    (await (await apiGet("export", outsider.token)).json()).records.length,
    0,
  );
  await assert.rejects(download(who("outsider"), fileId), /not found|denied/i);
});
test("Assignment does not grant access; self-review, self-approval and technical-admin approval are rejected", async () => {
  const base = {
    reviewerId: who("reviewer"),
    approverId: who("approver"),
    traineeIds: [who("employee")],
    dueAt: "2030-01-01T00:00:00Z",
  };
  await assert.rejects(
    actDoc("owner", "submit", { ...base, reviewerId: who("outsider") }),
    /already have access/,
  );
  await assert.rejects(
    actDoc("owner", "submit", { ...base, reviewerId: who("owner") }),
    /role|Independent/,
  );
  await assert.rejects(
    actDoc("owner", "submit", { ...base, approverId: who("admin") }),
    /business role/,
  );
  assert.equal((await revision()).status, "Draft");
  await actDoc("owner", "submit", base);
  await assert.rejects(actDoc("admin", "approve"), /business role/);
  const adminSession = await login({
    email: s.users.admin.email,
    password: s.users.admin.password,
  });
  assert.equal(
    (
      await apiPost(
        `revisions/${doc.revisionId}/approve`,
        {
          version: (await revision()).version,
          reason: why,
          actorId: who("approver"),
        },
        adminSession.token,
      )
    ).status,
    403,
  );
});
test("Submitted content is frozen and stale/unauthorized review attempts are rejected", async () => {
  await assert.rejects(
    upload(
      who("owner"),
      doc.id,
      file("changed"),
      doc.revisionId,
      (await revision()).version,
    ),
    /draft/,
  );
  await assert.rejects(
    editDraft(
      who("owner"),
      doc.id,
      {
        version: (await revision()).version,
        title: "Modified review",
        changeReason: why,
        trainingMode: "None",
        trainingBeforeEffective: false,
        reviewDue: "2030-01-01",
      },
      key(),
    ),
    /require a draft/,
  );
  await assert.rejects(actDoc("owner", "review"), /business role|reviewer/);
  const old = (await revision()).version;
  await actDoc("reviewer", "review");
  await assert.rejects(
    documentAction(
      who("approver"),
      doc.revisionId,
      "approve",
      { version: old, reason: why },
      key(),
    ),
    /changed/,
  );
  await actDoc("approver", "approve");
  assert.equal((await revision()).status, "Approved");
  const approved = await owner.query(
    "SELECT file_hash FROM approvals WHERE revision_id=$1 AND action='Approve'",
    [doc.revisionId],
  );
  assert.equal(
    approved.rows[0].file_hash,
    sha((await download(who("owner"), fileId)).bytes),
  );
});
test("Activation requires training and a verified archived snapshot; legitimate completion enables effectiveness", async () => {
  await assert.rejects(actDoc("qa", "activate"), /training is incomplete/i);
  const t = await owner.query("SELECT id FROM training WHERE revision_id=$1", [
    doc.revisionId,
  ]);
  await assert.rejects(
    completeTraining(who("owner"), t.rows[0].id, { reason: why }, key()),
    /assigned trainee/,
  );
  await completeTraining(who("employee"), t.rows[0].id, { reason: why }, key());
  await owner.query(
    "UPDATE revisions SET archive_status='Failed' WHERE id=$1",
    [doc.revisionId],
  );
  await assert.rejects(actDoc("qa", "activate"), /not archived/);
  await owner.query(
    "UPDATE revisions SET archive_status='Complete' WHERE id=$1",
    [doc.revisionId],
  );
  await actDoc("qa", "activate");
  assert.equal((await revision()).status, "Effective");
});
test("Second revision preserves old approval/training; competency cannot be completed by a read click", async () => {
  const next = await reviseDocument(
    who("owner"),
    doc.id,
    {
      title: "Synthetic controlled SOP revision 2",
      changeReason: why,
      trainingMode: "Competency",
      trainingBeforeEffective: true,
      reviewDue: "2031-01-01",
    },
    key(),
  );
  const v2 = next.revisionId;
  await upload(who("owner"), doc.id, file("revision 2"), v2, 1);
  await actDoc(
    "owner",
    "submit",
    {
      reviewerId: who("reviewer"),
      approverId: who("approver"),
      traineeIds: [who("employee")],
      dueAt: "2030-01-01T00:00:00Z",
    },
    v2,
  );
  await actDoc("reviewer", "review", {}, v2);
  await actDoc("approver", "approve", {}, v2);
  const t = (
    await owner.query("SELECT id FROM training WHERE revision_id=$1", [v2])
  ).rows[0].id;
  await assert.rejects(
    completeTraining(who("employee"), t, { reason: why }, key()),
    /business role/,
  );
  await assert.rejects(
    completeTraining(who("qa"), t, { reason: why }, key()),
    /evidence/,
  );
  await completeTraining(
    who("qa"),
    t,
    { reason: why, evidenceId: fileId },
    key(),
  );
  await actDoc("qa", "activate", {}, v2);
  assert.equal((await revision()).status, "Superseded");
  assert.equal((await revision(v2)).status, "Effective");
  assert.equal(
    (
      await owner.query(
        "SELECT count(*) FROM training WHERE revision_id=$1 AND status='Complete'",
        [doc.revisionId],
      )
    ).rows[0].count,
    "1",
  );
  assert.equal(
    (
      await owner.query(
        "SELECT count(*) FROM revisions WHERE record_id=$1 AND status='Effective'",
        [doc.id],
      )
    ).rows[0].count,
    "1",
  );
});
test("Task reassignment validates access; disabled accounts lose API access and assignments remain traceable", async () => {
  const t = await transaction(who("qa"), "Task.create", why, (db) =>
    addTask(
      db,
      doc.id,
      who("employee"),
      "Follow-up",
      "Synthetic follow-up",
      "2030-01-01T00:00:00Z",
      "Document completion rationale",
    ),
  );
  await assert.rejects(
    taskAction(
      who("admin"),
      t.id,
      "reassign",
      { version: 1, assigneeId: who("outsider"), reason: why },
      key(),
    ),
    /already have access/,
  );
  const session = await login({
    email: s.users.employee.email,
    password: s.users.employee.password,
  });
  await manageUser(
    who("admin"),
    "disable",
    { userId: who("employee"), reason: why },
    key(),
  );
  assert.equal((await apiGet("overview", session.token)).status, 401);
  await taskAction(
    who("admin"),
    t.id,
    "reassign",
    { version: 1, assigneeId: who("owner"), reason: why },
    key(),
  );
  assert.equal(
    (await owner.query("SELECT assignee_id FROM tasks WHERE id=$1", [t.id]))
      .rows[0].assignee_id,
    who("owner"),
  );
  await manageUser(
    who("admin"),
    "enable",
    { userId: who("employee"), reason: why },
    key(),
  );
});
test("Audit events are atomic and runtime cannot insert, update, delete or truncate historical audit", async () => {
  for (const sql of [
    "UPDATE audit_events SET reason='tampered'",
    "DELETE FROM audit_events",
    "TRUNCATE audit_events",
    "INSERT INTO audit_events(entity,entity_id,action) VALUES('x','x','fake')",
  ])
    await assert.rejects(getPool().query(sql), /permission denied/);
  const events = await owner.query(
    "SELECT * FROM audit_events WHERE record_id=$1 AND action=$2",
    [doc.id, "Document.approve"],
  );
  assert.ok(events.rowCount! >= 2);
  assert.ok(events.rows.every((e) => e.actor_id === who("approver")));
  const n = (await owner.query("SELECT count(*) FROM records")).rows[0].count;
  await assert.rejects(
    transaction(who("owner"), "Synthetic.rollback", why, async (db) => {
      await db.query("UPDATE records SET title=$1 WHERE id=$2", [
        "Should rollback",
        doc.id,
      ]);
      throw new Error("rollback");
    }),
  );
  assert.equal(
    (await owner.query("SELECT count(*) FROM records")).rows[0].count,
    n,
  );
  assert.equal(
    (
      await owner.query(
        "SELECT count(*) FROM audit_events WHERE action='Synthetic.rollback'",
      )
    ).rows[0].count,
    "0",
  );
});
test("Deviation CAPA Not Required needs rationale and independent QA closure", async () => {
  const d = await createQuality(
    who("qa"),
    "Deviation",
    {
      ...scope(),
      title: "Synthetic deviation",
      description: "Synthetic handling discrepancy",
      occurredOn: "2026-01-01",
      reportedOn: "2026-01-02",
      risk: "Low",
      ownerId: who("qa"),
      impact: "No impact on synthetic results",
      containment: "Isolated synthetic activity",
    },
    key(),
  );
  await assert.rejects(
    qualityAction(
      who("qa"),
      d.id,
      "investigate",
      {
        version: 1,
        reason: why,
        impact: "Reviewed",
        containment: "Contained",
        investigation: "Documented",
        disposition: "Accepted",
        capaDecision: "Not Required",
      },
      key(),
    ),
    /rationale required/,
  );
  await qualityAction(
    who("qa"),
    d.id,
    "investigate",
    {
      version: 1,
      reason: why,
      impact: "Reviewed",
      containment: "Contained",
      investigation: "Documented limited event",
      disposition: "Accepted with documented rationale",
      capaDecision: "Not Required",
      capaReason: "Isolated issue; existing controls are sufficient",
    },
    key(),
  );
  await qualityAction(
    who("qa"),
    d.id,
    "submit",
    { ...(await business(d.id, "deviations")), reason: why },
    key(),
  );
  await assert.rejects(
    qualityAction(
      who("qa"),
      d.id,
      "close",
      { ...(await business(d.id, "deviations")), reason: why },
      key(),
    ),
    /Independent/,
  );
  await qualityAction(
    who("qa_reviewer"),
    d.id,
    "close",
    { ...(await business(d.id, "deviations")), reason: why },
    key(),
  );
  assert.equal((await business(d.id, "deviations")).status, "Closed");
});
test("CAPA implementation cannot bypass required effectiveness review", async () => {
  const c = await createQuality(
    who("qa"),
    "CAPA",
    {
      ...scope(),
      title: "Synthetic CAPA",
      plan: "Improve and evaluate synthetic control",
      ownerId: who("qa"),
      dueAt: "2030-01-01T00:00:00Z",
      effectivenessRequired: true,
      effectivenessPlan: "Verify three synthetic runs",
    },
    key(),
  );
  const evidenceId = (await upload(who("qa"), c.id, file("CAPA evidence"))).id;
  const act = async (user: string, action: string, extra: object = {}) =>
    qualityAction(
      who(user),
      c.id,
      action,
      { ...(await business(c.id, "capas")), reason: why, ...extra },
      key(),
    );
  await act("approver", "approve-plan");
  await act("qa", "implement", { evidenceId });
  await assert.rejects(
    act("qa_reviewer", "close"),
    /effectiveness check is incomplete/,
  );
  await act("qa_reviewer", "effectiveness", {
    evidenceId,
    effectivenessResult: "Pass",
  });
  await act("qa_reviewer", "close");
  assert.equal((await business(c.id, "capas")).status, "Closed");
});
test("Questionnaire submission freezes answer and file versions; subsequent answer revision cannot alter it", async () => {
  const source = (
    await owner.query(
      "SELECT id FROM revisions WHERE record_id=$1 AND status='Effective'",
      [doc.id],
    )
  ).rows[0].id;
  const a = await createAnswer(
    who("qa"),
    {
      ...scope(),
      title: "Synthetic site answer",
      topic: "Document control",
      answer: "Synthetic reviewed statement",
      businessScope: "Waltham synthetic testing only",
      limitations: "Not a company qualification claim",
      sourceRevisionId: source,
      validUntil: "2030-01-01",
    },
    key(),
  );
  await answerAction(
    who("qa_reviewer"),
    a.id,
    "approve",
    { version: 1, reason: why },
    key(),
  );
  const q = await createQuestionnaire(
    who("qa"),
    {
      ...scope(),
      title: "Synthetic customer questionnaire",
      ownerId: who("qa"),
    },
    key(),
  );
  await addQuestion(
    who("qa"),
    q.id,
    {
      question: "How are documents controlled?",
      assigneeId: who("qa"),
      answerId: a.id,
      promisedDocument: "Synthetic procedure copy",
      reason: why,
    },
    key(),
  );
  const question = (
    await owner.query("SELECT * FROM questions WHERE record_id=$1", [q.id])
  ).rows[0];
  await updateQuestion(
    who("qa"),
    question.id,
    {
      version: 1,
      question: question.question,
      assigneeId: who("qa"),
      answerId: a.id,
      draftAnswer: question.draft_answer,
      reason: why,
    },
    key(),
  );
  await questionnaireAction(
    who("qa"),
    q.id,
    "review",
    { ...(await business(q.id, "questionnaires")), reason: why },
    key(),
  );
  await questionnaireAction(
    who("qa_reviewer"),
    q.id,
    "submit",
    { ...(await business(q.id, "questionnaires")), reason: why },
    key(),
  );
  const snapshot = (
    await owner.query(
      "SELECT snapshot FROM questionnaire_submissions WHERE record_id=$1",
      [q.id],
    )
  ).rows[0].snapshot;
  assert.equal(snapshot.questions[0].source.version, 2);
  assert.equal(snapshot.questions[0].files.length, 1);
  await answerAction(
    who("qa"),
    a.id,
    "revise",
    {
      version: 2,
      reason: why,
      answer: "Changed future draft",
      limitations: "Synthetic use only",
      validUntil: "2031-01-01",
      sourceRevisionId: source,
    },
    key(),
  );
  assert.deepEqual(
    (
      await owner.query(
        "SELECT snapshot FROM questionnaire_submissions WHERE record_id=$1",
        [q.id],
      )
    ).rows[0].snapshot,
    snapshot,
  );
  await assert.rejects(
    addQuestion(
      who("qa"),
      q.id,
      { question: "Changed question", assigneeId: who("qa"), reason: why },
      key(),
    ),
    /Only a draft/,
  );
  await assert.rejects(
    getPool().query("UPDATE questionnaire_submissions SET snapshot=$1", ["{}"]),
    /permission denied/,
  );
  // An accessible answer at another site remains invalid for this questionnaire.
  await owner.query(
    "INSERT INTO access_scopes(user_id,site_id,reason) VALUES($1,$2,$3)",
    [who("qa"), s.otherSite, why],
  );
  await owner.query(
    "INSERT INTO user_roles(user_id,role,site_id) VALUES($1,$2,$3)",
    [who("qa"), "QA", s.otherSite],
  );
  const other = await createQuestionnaire(
    who("qa"),
    {
      siteId: s.otherSite,
      title: "Other site questionnaire",
      ownerId: who("qa"),
    },
    key(),
  );
  await assert.rejects(
    addQuestion(
      who("qa"),
      other.id,
      {
        question: "Cross-site answer?",
        assigneeId: who("qa"),
        answerId: a.id,
        reason: why,
      },
      key(),
    ),
    /another site/,
  );
});
let material: string, container: string;
test("Inventory receipt, release and aliquot preserve lineage, units and ledger totals", async () => {
  material = (
    await createMaterial(
      who("qa"),
      {
        ...scope(),
        title: "Synthetic antibody TA",
        materialType: "Antibody",
        ownership: "Client",
        supplier: "Synthetic supplier",
        storageRequirements: "2–8 °C",
        clone: "SYN-01",
        useRole: "TA",
      },
      key(),
    )
  ).id;
  const received = await receiveLot(
    who("qa"),
    material,
    {
      lotNumber: "SYN-LOT-A",
      expiresOn: "2030-01-01",
      quantity: "10.000000",
      unit: "mL",
      locationId: s.location,
      containerLabel: "SYN-C01",
      reason: why,
    },
    key(),
  );
  container = received.containerId;
  await assert.rejects(
    containerAction(
      who("qa"),
      container,
      "use",
      {
        version: 1,
        amount: "1",
        unit: "mL",
        projectId: s.project,
        reason: why,
      },
      key(),
    ),
    /on hold/,
  );
  await lotAction(
    who("qa"),
    received.lotId,
    "release",
    { version: 1, reason: why },
    key(),
  );
  await assert.rejects(
    containerAction(
      who("qa"),
      container,
      "use",
      {
        version: 1,
        amount: "1",
        unit: "mg",
        projectId: s.project,
        reason: why,
      },
      key(),
    ),
    /Units must/,
  );
  const child = await containerAction(
    who("qa"),
    container,
    "aliquot",
    {
      version: 1,
      amount: "2.250000",
      unit: "mL",
      label: "SYN-A01",
      locationId: s.location,
      reason: why,
    },
    key(),
  );
  assert.ok(child.childId);
  const total = await owner.query(
    "SELECT sum(quantity) total FROM containers WHERE record_id=$1",
    [material],
  );
  assert.equal(total.rows[0].total, "10.000000");
  const lineage = await owner.query(
    "SELECT parent_id FROM containers WHERE id=$1",
    [child.childId],
  );
  assert.equal(lineage.rows[0].parent_id, container);
});
test("Duplicate and concurrent inventory consumption cannot double-deduct or overspend", async () => {
  const cmd = {
    version: 2,
    amount: "1.000000",
    unit: "mL" as const,
    projectId: s.project,
    reason: why,
  };
  const k = key();
  const x = await containerAction(who("qa"), container, "use", cmd, k);
  assert.deepEqual(
    await containerAction(who("qa"), container, "use", cmd, k),
    x,
  );
  await assert.rejects(
    containerAction(who("qa"), container, "use", { ...cmd, amount: "2" }, k),
    /different request/,
  );
  const concurrent = await Promise.allSettled(
    [1, 2].map(() =>
      containerAction(
        who("qa"),
        container,
        "use",
        { ...cmd, version: 3, amount: "5" },
        key(),
      ),
    ),
  );
  assert.equal(concurrent.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(
    (
      await owner.query("SELECT quantity FROM containers WHERE id=$1", [
        container,
      ])
    ).rows[0].quantity,
    "1.750000",
  );
  await assert.rejects(
    containerAction(
      who("qa"),
      container,
      "use",
      { ...cmd, version: 4, amount: "5" },
      key(),
    ),
    /Insufficient/,
  );
  const explain = await owner.query(
    "SELECT c.id,c.quantity,sum(t.delta) explained FROM containers c JOIN inventory_transactions t ON t.container_id=c.id WHERE c.record_id=$1 GROUP BY c.id",
    [material],
  );
  assert.ok(explain.rows.every((x) => x.quantity === x.explained));
  await assert.rejects(
    getPool().query("UPDATE inventory_transactions SET reason='tampered'"),
    /permission denied/,
  );
});
test("Server notifications fail visibly, retry and deduplicate without completing business tasks", async () => {
  const t = await transaction(who("qa"), "Task.create", why, (db) =>
    addTask(
      db,
      doc.id,
      who("owner"),
      "Follow-up",
      "Synthetic overdue reminder",
      "2020-01-01T00:00:00Z",
      "Complete actual work",
    ),
  );
  const failed = await runWorker("test-fail");
  assert.ok(failed.failed > 0);
  assert.equal(
    (await owner.query("SELECT status FROM tasks WHERE id=$1", [t.id])).rows[0]
      .status,
    "Open",
  );
  await owner.query(
    "UPDATE notification_outbox SET next_attempt_at=now() WHERE status='Failed'",
  );
  const retried = await runWorker();
  assert.ok(retried.delivered > 0);
  assert.equal((await runWorker()).delivered, 0);
  const n = await owner.query(
    "SELECT count(*) FROM notifications n JOIN notification_outbox o ON o.id=n.outbox_id WHERE o.task_id=$1",
    [t.id],
  );
  assert.equal(n.rows[0].count, "1");
});

test("Change control requires independent approval, evidence and independent closure", async () => {
  const c = await createQuality(
    who("qa"),
    "Change",
    {
      ...scope(),
      title: "Synthetic controlled change",
      description: "Change synthetic handling sequence",
      impact: "Synthetic training and document impact considered",
      implementationPlan: "Document and demonstrate the changed sequence",
      ownerId: who("qa"),
    },
    key(),
  );
  const evidenceId = (await upload(who("qa"), c.id, file("Change evidence")))
    .id;
  const act = async (user: string, action: string, extra: object = {}) =>
    qualityAction(
      who(user),
      c.id,
      action,
      { ...(await business(c.id, "changes")), reason: why, ...extra },
      key(),
    );
  await assert.rejects(act("qa", "implement", { evidenceId }), /not approved/);
  await act("approver", "approve");
  await act("qa", "implement", { evidenceId });
  await assert.rejects(act("qa", "close"), /Independent/);
  await act("qa_reviewer", "close");
  assert.equal((await business(c.id, "changes")).status, "Closed");
});
test("Audit report and open findings gate closure without forcing CAPA on every finding", async () => {
  const a = await createQuality(
    who("qa"),
    "Audit",
    {
      ...scope(),
      title: "Synthetic audit",
      auditType: "Internal",
      scope: "Synthetic records",
      target: "Synthetic workflow",
      plannedOn: "2030-01-01",
      ownerId: who("qa"),
    },
    key(),
  );
  const evidenceId = (await upload(who("qa"), a.id, file("Audit evidence"))).id;
  const finding = await findingAction(
    who("qa"),
    a.id,
    "create",
    {
      description: "Synthetic documentation gap",
      grade: "Observation",
      ownerId: who("qa"),
      dueAt: "2030-01-01T00:00:00Z",
      reason: why,
    },
    key(),
  );
  const act = async (user: string, action: string, extra: object = {}) =>
    qualityAction(
      who(user),
      a.id,
      action,
      { ...(await business(a.id, "audits")), reason: why, ...extra },
      key(),
    );
  await act("qa", "start");
  await act("qa", "submit", { evidenceId });
  await assert.rejects(act("qa_reviewer", "close"), /Open findings/);
  await findingAction(
    who("qa_reviewer"),
    a.id,
    "close",
    {
      id: finding.findingId,
      version: 1,
      response: "Evidence reviewed; isolated finding corrected without CAPA",
      evidenceId,
      reason: why,
    },
    key(),
  );
  await act("qa_reviewer", "close");
  assert.equal((await business(a.id, "audits")).status, "Closed");
});
test("EHS requires documented assessment, evidence and a distinct authorized closer", async () => {
  const e = await createQuality(
    who("qa"),
    "EHS",
    {
      ...scope(),
      title: "Synthetic material introduction",
      category: "Material introduction",
      description: "Synthetic material review only",
      ownerId: who("qa"),
      dueAt: "2030-01-01T00:00:00Z",
    },
    key(),
  );
  const evidenceId = (await upload(who("qa"), e.id, file("EHS evidence"))).id;
  const act = async (user: string, action: string, extra: object = {}) =>
    qualityAction(
      who(user),
      e.id,
      action,
      { ...(await business(e.id, "ehs_records")), reason: why, ...extra },
      key(),
    );
  await assert.rejects(
    act("qa_reviewer", "close", { evidenceId }),
    /Assessment/,
  );
  await act("qa", "assess", {
    assessment: "Synthetic assessment complete",
    interimMeasures: "Synthetic restriction",
    correctiveAction: "Synthetic control documented",
  });
  await assert.rejects(act("qa", "close", { evidenceId }), /Independent/);
  await act("qa_reviewer", "close", { evidenceId });
  assert.equal((await business(e.id, "ehs_records")).status, "Closed");
});
test("Record-specific access expires/revokes without widening project or site access", async () => {
  const newUser = await manageUser(
    who("admin"),
    "create",
    {
      email: "scoped@example.test",
      name: "Synthetic limited user",
      password: "Synthetic-only-long-password-123",
      reason: why,
    },
    key(),
  );
  await manageUser(
    who("admin"),
    "grant-role",
    { userId: newUser.id, role: "Employee", siteId: s.site, reason: why },
    key(),
  );
  await manageUser(
    who("admin"),
    "grant-scope",
    { userId: newUser.id, siteId: s.site, recordId: doc.id, reason: why },
    key(),
  );
  assert.equal((await listRecords(newUser.id)).length, 1);
  await assert.rejects(detail(newUser.id, material), /not found/);
  const grant = (
    await owner.query("SELECT id FROM access_scopes WHERE user_id=$1", [
      newUser.id,
    ])
  ).rows[0].id;
  await manageUser(
    who("admin"),
    "revoke-scope",
    { userId: newUser.id, scopeId: grant, reason: why },
    key(),
  );
  assert.equal((await listRecords(newUser.id)).length, 0);
  await manageUser(
    who("admin"),
    "grant-scope",
    {
      userId: newUser.id,
      siteId: s.site,
      recordId: doc.id,
      expiresAt: "2020-01-01T00:00:00Z",
      reason: why,
    },
    key(),
  );
  assert.equal((await listRecords(newUser.id)).length, 0);
  await assert.rejects(
    getPool().query("DELETE FROM records"),
    /permission denied/,
  );
});
test("Reservations, adjustments and returns preserve balances and force returned material on hold", async () => {
  let version = (
    await owner.query("SELECT version FROM containers WHERE id=$1", [container])
  ).rows[0].version;
  const act = async (action: string, extra: object) => {
    const r = await containerAction(
      who("qa"),
      container,
      action,
      { version, unit: "mL", reason: why, ...extra },
      key(),
    );
    version++;
    return r;
  };
  await act("reserve", { amount: "1" });
  await assert.rejects(
    containerAction(
      who("qa"),
      container,
      "use",
      { version, unit: "mL", amount: "1", projectId: s.project, reason: why },
      key(),
    ),
    /Insufficient/,
  );
  await act("unreserve", { amount: "1" });
  await act("adjust", { delta: "0.250000" });
  await act("return", { amount: "0.5", projectId: s.project });
  assert.equal(
    (
      await owner.query("SELECT quantity FROM containers WHERE id=$1", [
        container,
      ])
    ).rows[0].quantity,
    "2.500000",
  );
  assert.equal(
    (
      await owner.query(
        "SELECT l.status FROM lots l JOIN containers c ON c.lot_id=l.id WHERE c.id=$1",
        [container],
      )
    ).rows[0].status,
    "On Hold",
  );
  assert.equal(
    (
      await owner.query(
        "SELECT reserved_after FROM inventory_transactions WHERE container_id=$1 AND operation='Reserve'",
        [container],
      )
    ).rows[0].reserved_after,
    "1.000000",
  );
});
test("Question contributors must have access and complete the draft response before QA review", async () => {
  const q = await createQuestionnaire(
    who("qa"),
    { ...scope(), title: "Synthetic contributor test", ownerId: who("qa") },
    key(),
  );
  await addQuestion(
    who("qa"),
    q.id,
    {
      question: "Unconfirmed site-specific question",
      assigneeId: who("employee"),
      reason: why,
    },
    key(),
  );
  await assert.rejects(
    questionnaireAction(
      who("qa"),
      q.id,
      "review",
      { ...(await business(q.id, "questionnaires")), reason: why },
      key(),
    ),
    /responses must be saved/,
  );
  const question = (
    await owner.query("SELECT id FROM questions WHERE record_id=$1", [q.id])
  ).rows[0].id;
  await updateQuestion(
    who("employee"),
    question,
    {
      version: 1,
      question: "Unconfirmed site-specific question",
      assigneeId: who("employee"),
      draftAnswer: "Cannot answer",
      reason: why,
    },
    key(),
  );
  await questionnaireAction(
    who("qa"),
    q.id,
    "review",
    { ...(await business(q.id, "questionnaires")), reason: why },
    key(),
  );
  assert.equal((await business(q.id, "questionnaires")).status, "In Review");
});

test("Authenticated dashboard and detail APIs return usable scoped data; browser identity fields cannot authorize actions", async () => {
  const session = await login({
    email: s.users.owner.email,
    password: s.users.owner.password,
  });
  const overview = await apiGet("overview", session.token);
  assert.equal(overview.status, 200);
  const body = await overview.json();
  assert.ok(Array.isArray(body.records));
  assert.ok(body.records.length > 0);
  assert.equal(body.actor.id, who("owner"));
  assert.equal((await apiGet(`records/${doc.id}`, session.token)).status, 200);
  const employee = await login({
    email: s.users.employee.email,
    password: s.users.employee.password,
  });
  assert.equal(
    (
      await apiPost(
        "documents",
        {
          ...scope(),
          title: "Forged actor",
          number: "SYN-FORGE",
          department: "QA",
          changeReason: why,
          reviewDue: "2030-01-01",
          actorId: who("qa"),
          createdBy: who("qa"),
        },
        employee.token,
      )
    ).status,
    403,
  );
});
test("Manual task assignment enforces evidence completion conditions", async () => {
  const t = await createTask(
    who("qa"),
    {
      recordId: doc.id,
      title: "Synthetic evidence task",
      assigneeId: who("owner"),
      dueAt: "2030-01-01T00:00:00Z",
      completionCondition: "Attach the reviewed record",
      requiresEvidence: true,
      reason: why,
    },
    key(),
  );
  await assert.rejects(
    taskAction(
      who("owner"),
      t.taskId,
      "complete",
      { version: 1, reason: why },
      key(),
    ),
    /evidence is required/,
  );
  await taskAction(
    who("owner"),
    t.taskId,
    "complete",
    { version: 1, evidenceId: fileId, reason: why },
    key(),
  );
});

test("Workflow tasks cannot be completed through the generic task endpoint", async () => {
  const c = await createQuality(
    who("qa"),
    "CAPA",
    {
      ...scope(),
      title: "Synthetic workflow task guard",
      plan: "Controlled implementation",
      ownerId: who("qa"),
      dueAt: "2030-01-01T00:00:00Z",
      effectivenessRequired: false,
    },
    key(),
  );
  const t = (
    await owner.query("SELECT id,version FROM tasks WHERE record_id=$1", [c.id])
  ).rows[0];
  await assert.rejects(
    taskAction(
      who("qa"),
      t.id,
      "complete",
      { version: t.version, reason: why },
      key(),
    ),
    /business workflow/,
  );
  assert.equal((await business(c.id, "capas")).status, "Draft");
});
test("Returned approved content starts a new review cycle and uploader cannot review their own file", async () => {
  const c = await createDocument(
    who("owner"),
    {
      ...scope(),
      title: "Synthetic return cycle",
      number: "SYN-RETURN-001",
      department: "QA",
      changeReason: why,
      trainingMode: "None",
      trainingBeforeEffective: false,
      reviewDue: "2030-01-01",
    },
    key(),
  );
  await upload(
    who("qa"),
    c.id,
    file("QA-authored synthetic content"),
    c.revisionId,
    1,
  );
  const act = async (user: string, action: string, extra: object = {}) =>
    documentAction(
      who(user),
      c.revisionId,
      action,
      { ...(await revision(c.revisionId)), reason: why, ...extra },
      key(),
    );
  const submit = {
    reviewerId: who("reviewer"),
    approverId: who("approver"),
    traineeIds: [],
    dueAt: "2030-01-01T00:00:00Z",
  };
  await assert.rejects(
    act("owner", "submit", { ...submit, reviewerId: who("qa") }),
    /Independent reviewer/,
  );
  await act("owner", "submit", submit);
  await act("reviewer", "review");
  await act("approver", "approve");
  await act("qa", "return");
  await upload(
    who("owner"),
    c.id,
    file("Corrected synthetic content"),
    c.revisionId,
    (await revision(c.revisionId)).version,
  );
  await act("owner", "submit", submit);
  await assert.rejects(act("approver", "approve"), /not found/);
  await act("reviewer", "review");
  await act("approver", "approve");
  assert.equal(
    (
      await owner.query(
        "SELECT count(DISTINCT cycle) n FROM approvals WHERE revision_id=$1 AND action='Approve'",
        [c.revisionId],
      )
    ).rows[0].n,
    "2",
  );
});

test("Role-to-SOP training rules expand only accessible people and freeze a revision-specific audience", async () => {
  const c = await createDocument(
    who("owner"),
    {
      ...scope(),
      title: "Synthetic role training matrix",
      number: "SYN-MATRIX-001",
      department: "QA",
      changeReason: why,
      trainingMode: "Read acknowledgement",
      trainingBeforeEffective: true,
      reviewDue: "2030-01-01",
    },
    key(),
  );
  await upload(who("owner"), c.id, file(), c.revisionId, 1);
  await configureTraining(
    who("qa"),
    c.id,
    { version: 2, role: "Employee", dueDays: 7, active: true, reason: why },
    key(),
  );
  await documentAction(
    who("owner"),
    c.revisionId,
    "submit",
    {
      version: 3,
      reviewerId: who("reviewer"),
      approverId: who("approver"),
      traineeIds: [],
      dueAt: "2030-01-01T00:00:00Z",
      reason: why,
    },
    key(),
  );
  const rev = (
    await owner.query(
      "SELECT trainee_ids,training_policy_snapshot FROM revisions WHERE id=$1",
      [c.revisionId],
    )
  ).rows[0];
  assert.ok(rev.trainee_ids.includes(who("employee")));
  assert.ok(!rev.trainee_ids.includes(who("outsider")));
  assert.ok(
    rev.training_policy_snapshot.every(
      (x: { dueDays: number }) => x.dueDays === 7,
    ),
  );
  await assert.rejects(
    configureTraining(
      who("qa"),
      c.id,
      { version: 4, role: "Employee", dueDays: 30, active: false, reason: why },
      key(),
    ),
    /only change for a draft/,
  );
});
test(
  "Independent worker process delivers reminders and shuts down cleanly without a browser",
  { timeout: 15000 },
  async () => {
    const workerUrl = process.env.WORKER_DATABASE_URL!.replace(
      "/bbc_dev",
      "/bbc_test",
    );
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "scripts/worker.ts"],
      {
        env: {
          ...process.env,
          DATABASE_URL: workerUrl,
          WORKER_DATABASE_URL: workerUrl,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    child.stdout.on("data", (b) => {
      output += b.toString();
      if (output.includes('"delivered"')) child.kill("SIGTERM");
    });
    const code = await new Promise<number | null>((r) => child.on("exit", r));
    clearTimeout(timer);
    assert.equal(code, 0);
    assert.match(output, /"delivered"/);
  },
);

test("Database and actual attachment bytes restore into an independent database and storage directory", async () => {
  await rm(`${testRoot}/backup`, { recursive: true, force: true });
  await rm(`${testRoot}/restored-attachments`, { recursive: true, force: true });
  const backup = await makeBackup(
    process.env.TEST_MIGRATION_DATABASE_URL!,
    process.env.ATTACHMENT_DIR!,
    `${testRoot}/backup`,
  );
  const admin = new pg.Client({
    connectionString: process.env.ADMIN_DATABASE_URL,
  });
  await admin.connect();
  try {
    await admin.query("DROP DATABASE IF EXISTS bbc_restore_test");
    await admin.query("CREATE DATABASE bbc_restore_test OWNER bbc_owner");
  } finally {
    await admin.end();
  }
  const restoreUrl = process.env.TEST_MIGRATION_DATABASE_URL!.replace(
    "/bbc_test",
    "/bbc_restore_test",
  );
  const result = await restoreBackup(
    restoreUrl,
    `${testRoot}/backup`,
    `${testRoot}/restored-attachments`,
  );
  assert.equal(result.files, backup.files);
  assert.ok(result.records > 0);
  assert.equal(result.ledgerMismatches, 0);
  assert.equal(result.brokenRevisionLinks, 0);
});
