import { z } from "zod";
import {
  transaction,
  one,
  getRecord,
  createRecord,
  scopeInput,
  text,
  reason,
  uuid,
  must,
  requireRole,
  hasRole,
  accessibleUser,
  addTask,
  versioned,
  sha,
  Fault,
  type Tx,
  type Actor,
  type RecordRow,
} from "./core";
import { readBytes, type FileRow, verifyEvidence } from "./files";
const trainingMode = z.enum([
  "None",
  "Read acknowledgement",
  "Instructor led",
  "Competency",
]);
const createSchema = scopeInput.extend({
  number: z.string().regex(/^[A-Z0-9-]{3,40}$/),
  department: z.string().min(1).max(100),
  documentType: z
    .enum(["SOP", "Policy", "Form", "Work instruction"])
    .default("SOP"),
  changeReason: reason,
  trainingMode: trainingMode.default("Read acknowledgement"),
  trainingBeforeEffective: z.boolean().default(true),
  reviewDue: z.iso.date(),
  effectiveAfter: z.iso.datetime().nullable().optional(),
});
export interface Revision {
  id: string;
  record_id: string;
  number: number;
  title: string;
  change_reason: string;
  status: string;
  file_id: string | null;
  workflow_id: string;
  review_due: string;
  effective_after: string | null;
  archive_status: string;
  signing_mode: string;
  training_mode: string;
  training_before_effective: boolean;
  trainee_ids: string[];
  reviewer_id: string | null;
  approver_id: string | null;
  version: number;
  created_by: string;
  cycle: number;
  training_policy_snapshot: {
    userId: string;
    dueDays: number;
    source: string;
  }[];
}
export interface Rule {
  independentReview: boolean;
  independentApproval: boolean;
  reviewerDistinctFromApprover: boolean;
  requireTrainingAudience: boolean;
}
export async function createDocument(
  actorId: string,
  input: unknown,
  key: string,
) {
  const d = createSchema.parse(input);
  return transaction(
    actorId,
    "Document.create",
    d.changeReason,
    async (db, a) => {
      requireRole(a, ["Document Owner", "QA"], d.siteId);
      const r = await createRecord(db, a, "Document", d);
      await db.query(
        "INSERT INTO documents(record_id,number,owner_id,department,document_type) VALUES($1,$2,$3,$4,$5)",
        [r.id, d.number, a.id, d.department, d.documentType],
      );
      const rule = await one<{ id: string }>(
        db,
        "SELECT id FROM workflow_rules WHERE name='SOP internal review' ORDER BY version DESC LIMIT 1",
      );
      const rev = await one<Revision>(
        db,
        `INSERT INTO revisions(record_id,number,title,change_reason,workflow_id,review_due,effective_after,training_mode,training_before_effective,created_by) VALUES($1,1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [
          r.id,
          d.title,
          d.changeReason,
          rule.id,
          d.reviewDue,
          d.effectiveAfter ?? null,
          d.trainingMode,
          d.trainingBeforeEffective,
          a.id,
        ],
      );
      return { id: r.id, revisionId: rev.id };
    },
    { key, fingerprint: sha(JSON.stringify(d)) },
  );
}
export async function reviseDocument(
  actorId: string,
  recordId: string,
  input: unknown,
  key: string,
) {
  const d = z
    .object({
      changeReason: reason,
      title: text,
      trainingMode,
      trainingBeforeEffective: z.boolean(),
      reviewDue: z.iso.date(),
      effectiveAfter: z.iso.datetime().nullable().optional(),
    })
    .parse(input);
  return transaction(
    actorId,
    "Document.revise",
    d.changeReason,
    async (db, a) => {
      const r = await getRecord(db, recordId, "Document");
      requireRole(a, ["Document Owner", "QA"], r.site_id);
      const doc = await one<{ owner_id: string }>(
        db,
        "SELECT * FROM documents WHERE record_id=$1 FOR UPDATE",
        [recordId],
      );
      must(
        doc.owner_id === a.id || hasRole(a, ["QA"], r.site_id),
        "Only the owner or site QA can revise",
        403,
      );
      const prev = await one<Revision>(
        db,
        "SELECT * FROM revisions WHERE record_id=$1 ORDER BY number DESC LIMIT 1",
        [recordId],
      );
      must(
        ["Effective", "Superseded", "Obsolete"].includes(prev.status),
        "Finish or return the current working revision first",
      );
      const rule = await one<{ id: string }>(
        db,
        "SELECT id FROM workflow_rules WHERE name='SOP internal review' ORDER BY version DESC LIMIT 1",
      );
      const rev = await one<Revision>(
        db,
        `INSERT INTO revisions(record_id,number,title,change_reason,workflow_id,review_due,effective_after,training_mode,training_before_effective,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [
          recordId,
          prev.number + 1,
          d.title,
          d.changeReason,
          rule.id,
          d.reviewDue,
          d.effectiveAfter ?? null,
          d.trainingMode,
          d.trainingBeforeEffective,
          a.id,
        ],
      );
      return { id: recordId, revisionId: rev.id };
    },
    { key, fingerprint: sha(JSON.stringify([recordId, d])) },
  );
}
const actionSchema = z.object({
  version: z.number().int().positive(),
  reason,
  reviewerId: uuid.optional(),
  approverId: uuid.optional(),
  traineeIds: z.array(uuid).max(500).optional(),
  dueAt: z.iso.datetime().optional(),
});
export async function documentAction(
  actorId: string,
  id: string,
  action: string,
  input: unknown,
  key: string,
) {
  const d = actionSchema.parse(input);
  return transaction(
    actorId,
    `Document.${action}`,
    d.reason,
    async (db, a) => {
      const rev = await versioned<Revision>(
        db,
        "revisions",
        id,
        d.version,
        "id",
      );
      const r = await getRecord(db, rev.record_id, "Document");
      const doc = await one<{ owner_id: string; number: string }>(
        db,
        "SELECT * FROM documents WHERE record_id=$1",
        [r.id],
      );
      const rule = (
        await one<{ rules: Rule }>(
          db,
          "SELECT rules FROM workflow_rules WHERE id=$1",
          [rev.workflow_id],
        )
      ).rules;
      const f = rev.file_id
        ? await one<FileRow>(db, "SELECT * FROM attachments WHERE id=$1", [
            rev.file_id,
          ])
        : null;
      const owner = () => {
        requireRole(a, ["Document Owner", "QA"], r.site_id);
        must(
          a.id === doc.owner_id || hasRole(a, ["QA"], r.site_id),
          "Only the owner or site QA may perform this action",
          403,
        );
      };
      if (action === "submit") {
        owner();
        must(rev.status === "Draft", "Only a draft can be submitted");
        must(f, "Upload a controlled document first");
        await readBytes(f);
        must(
          d.reviewerId && d.approverId && d.dueAt,
          "Reviewer, approver and deadline are required",
          400,
        );
        await accessibleUser(
          db,
          d.reviewerId,
          r.id,
          ["Reviewer", "QA"],
          r.site_id,
        );
        await accessibleUser(db, d.approverId, r.id, ["Approver"], r.site_id);
        if (rule.independentReview)
          must(
            ![doc.owner_id, rev.created_by, f.uploaded_by].includes(
              d.reviewerId,
            ),
            "Independent reviewer required",
          );
        if (rule.independentApproval)
          must(
            ![doc.owner_id, rev.created_by, f.uploaded_by].includes(
              d.approverId,
            ),
            "Independent approver required",
          );
        if (rule.reviewerDistinctFromApprover)
          must(
            d.reviewerId !== d.approverId,
            "Reviewer and approver must be different people",
          );
        const matrix = (
          await db.query<{ role: string; due_days: number }>(
            "SELECT role,due_days FROM training_requirements WHERE record_id=$1 AND active",
            [r.id],
          )
        ).rows;
        const targets = new Map<
          string,
          { userId: string; dueDays: number; source: string }
        >(
          (d.traineeIds ?? []).map((userId) => [
            userId,
            { userId, dueDays: 14, source: "Explicit assignment" },
          ]),
        );
        for (const requirement of matrix) {
          must(
            rev.training_mode !== "None",
            "An active training matrix requires a training method",
          );
          const users = (
            await db.query<{ id: string }>(
              "SELECT DISTINCT u.id FROM users u JOIN user_roles g ON g.user_id=u.id WHERE u.active AND NOT u.system_account AND g.role=$1 AND (g.site_id=$2 OR g.site_id IS NULL) AND user_can_record(u.id,$3)",
              [requirement.role, r.site_id, r.id],
            )
          ).rows;
          for (const u of users) {
            const prior = targets.get(u.id);
            targets.set(u.id, {
              userId: u.id,
              dueDays: Math.min(prior?.dueDays ?? 365, requirement.due_days),
              source: prior
                ? prior.source + ", " + requirement.role
                : requirement.role,
            });
          }
        }
        const trainees = [...targets.keys()];
        if (rev.training_mode !== "None" && rule.requireTrainingAudience)
          must(trainees.length, "Select a training audience");
        if (rev.training_mode === "None")
          must(
            !trainees.length,
            "No-training revisions must have an empty audience",
            400,
          );
        for (const uid of trainees) await accessibleUser(db, uid, r.id);
        await db.query(
          "UPDATE revisions SET status='In Review',reviewer_id=$1,approver_id=$2,trainee_ids=$3,training_policy_snapshot=$5,version=version+1,cycle=cycle+1 WHERE id=$4",
          [
            d.reviewerId,
            d.approverId,
            trainees,
            id,
            JSON.stringify([...targets.values()]),
          ],
        );
        await addTask(
          db,
          r.id,
          d.reviewerId,
          "Review",
          `Review ${doc.number} · revision ${rev.number}`,
          d.dueAt,
          "Complete independent review of the frozen file",
          id,
        );
      } else if (action === "review") {
        must(rev.status === "In Review", "Revision is not in review");
        requireRole(a, ["Reviewer", "QA"], r.site_id);
        must(
          a.id === rev.reviewer_id,
          "Only the assigned reviewer may review",
          403,
        );
        must(f, "No document attached");
        await readBytes(f);
        must(
          !(
            await db.query(
              "SELECT id FROM approvals WHERE revision_id=$1 AND cycle=$2 AND action='Review'",
              [id, rev.cycle],
            )
          ).rowCount,
          "Review already recorded",
        );
        await db.query(
          "INSERT INTO approvals(record_id,revision_id,action,actor_id,file_id,file_hash,reason,cycle) VALUES($1,$2,'Review',$3,$4,$5,$6,$7)",
          [r.id, id, a.id, f.id, f.sha256, d.reason, rev.cycle],
        );
        await db.query(
          "UPDATE tasks SET status='Complete',completed_at=now(),completion_note=$1,version=version+1 WHERE revision_id=$2 AND kind='Review' AND status='Open'",
          [d.reason, id],
        );
        await addTask(
          db,
          r.id,
          rev.approver_id!,
          "Approve",
          `Approve ${doc.number} · revision ${rev.number}`,
          d.dueAt ?? new Date(Date.now() + 7 * 86400000).toISOString(),
          "Approve the independently reviewed frozen revision",
          id,
        );
        await db.query("UPDATE revisions SET version=version+1 WHERE id=$1", [
          id,
        ]);
      } else if (action === "approve") {
        must(rev.status === "In Review", "Revision is not awaiting approval");
        requireRole(a, ["Approver"], r.site_id);
        must(
          a.id === rev.approver_id,
          "Only the assigned approver may approve",
          403,
        );
        must(f, "No document attached");
        if (rule.independentApproval)
          must(
            ![doc.owner_id, rev.created_by, f.uploaded_by].includes(a.id),
            "Self-approval is prohibited",
          );
        await readBytes(f);
        const review = await one<{ file_hash: string; actor_id: string }>(
          db,
          "SELECT file_hash,actor_id FROM approvals WHERE revision_id=$1 AND cycle=$2 AND action='Review' ORDER BY created_at DESC LIMIT 1",
          [id, rev.cycle],
        );
        must(review.file_hash === f.sha256, "File changed after review");
        if (rule.reviewerDistinctFromApprover)
          must(review.actor_id !== a.id, "Reviewer cannot also approve");
        must(
          rev.signing_mode === "Internal",
          "External signing is not connected",
        );
        await db.query(
          "INSERT INTO approvals(record_id,revision_id,action,actor_id,file_id,file_hash,reason,cycle) VALUES($1,$2,'Approve',$3,$4,$5,$6,$7)",
          [r.id, id, a.id, f.id, f.sha256, d.reason, rev.cycle],
        );
        await db.query(
          "UPDATE revisions SET status='Approved',archive_status='Complete',version=version+1 WHERE id=$1",
          [id],
        );
        await db.query(
          "UPDATE tasks SET status='Complete',completed_at=now(),completion_note=$1,version=version+1 WHERE revision_id=$2 AND kind='Approve' AND status='Open'",
          [d.reason, id],
        );
        for (const uid of rev.trainee_ids) {
          await accessibleUser(db, uid, r.id);
          const tr = await one<{ id: string }>(
            db,
            "INSERT INTO training(record_id,revision_id,user_id,method) VALUES($1,$2,$3,$4) RETURNING id",
            [r.id, id, uid, rev.training_mode],
          );
          await addTask(
            db,
            r.id,
            uid,
            "Training",
            `Train on ${doc.number} · revision ${rev.number}`,
            d.dueAt ??
              new Date(
                Date.now() +
                  (rev.training_policy_snapshot.find((x) => x.userId === uid)
                    ?.dueDays ?? 14) *
                    86400000,
              ).toISOString(),
            rev.training_mode === "Read acknowledgement"
              ? "Read the fixed revision and confirm understanding"
              : "Qualified independent confirmation and evidence are required",
            id,
            tr.id,
          );
        }
      } else if (action === "return") {
        must(
          ["In Review", "Approved"].includes(rev.status),
          "Only a review or approved revision can be returned",
        );
        requireRole(a, ["Reviewer", "Approver", "QA"], r.site_id);
        must(
          hasRole(a, ["QA"], r.site_id) ||
            [rev.reviewer_id, rev.approver_id].includes(a.id),
          "Only assigned reviewers or site QA may return",
          403,
        );
        must(f, "No document attached");
        await db.query(
          "INSERT INTO approvals(record_id,revision_id,action,actor_id,file_id,file_hash,reason,cycle) VALUES($1,$2,'Return',$3,$4,$5,$6,$7)",
          [r.id, id, a.id, f.id, f.sha256, d.reason, rev.cycle],
        );
        // A return keeps immutable historical approvals. A new submission starts a new approval cycle.
        must(
          !(
            await db.query("SELECT id FROM training WHERE revision_id=$1", [id])
          ).rowCount,
          "This approved revision has training records; create a controlled withdrawal instead of changing content",
        );
        await db.query(
          "UPDATE revisions SET status='Draft',archive_status='Pending',version=version+1 WHERE id=$1",
          [id],
        );
        await db.query(
          "UPDATE tasks SET status='Cancelled',completion_note=$1,version=version+1 WHERE revision_id=$2 AND status='Open'",
          [d.reason, id],
        );
      } else if (action === "activate") {
        requireRole(a, ["QA"], r.site_id);
        must(
          rev.status === "Approved",
          "Only an approved revision can become effective",
        );
        must(
          rev.archive_status === "Complete",
          "Controlled snapshot is not archived",
        );
        must(
          !rev.effective_after || new Date(rev.effective_after) <= new Date(),
          "Planned effective date has not arrived",
        );
        must(f, "No document attached");
        await readBytes(f);
        const ap = await one<{ file_hash: string }>(
          db,
          "SELECT file_hash FROM approvals WHERE revision_id=$1 AND cycle=$2 AND action='Approve'",
          [id, rev.cycle],
        );
        must(ap.file_hash === f.sha256, "Approval does not match file");
        if (rev.training_before_effective) {
          const incomplete = await db.query(
            "SELECT id FROM training WHERE revision_id=$1 AND status<>'Complete'",
            [id],
          );
          must(!incomplete.rowCount, "Required training is incomplete");
          if (rev.training_mode !== "None")
            must(rev.trainee_ids.length, "Training audience is empty");
        }
        const prev = await db.query<{ id: string }>(
          "UPDATE revisions SET status='Superseded',version=version+1 WHERE record_id=$1 AND status='Effective' RETURNING id",
          [r.id],
        );
        await db.query(
          "UPDATE revisions SET status='Effective',effective_at=now(),version=version+1 WHERE id=$1",
          [id],
        );
        await db.query("UPDATE records SET title=$1 WHERE id=$2", [
          rev.title,
          r.id,
        ]);
        if (prev.rowCount)
          await db.query(
            "UPDATE approved_answers SET status='Needs Review',version=version+1 WHERE source_revision_id=ANY($1::uuid[]) AND status='Approved'",
            [prev.rows.map((x) => x.id)],
          );
        await addTask(
          db,
          r.id,
          doc.owner_id,
          "Periodic review",
          `Periodic review · ${doc.number}`,
          new Date(rev.review_due).toISOString(),
          "Document the periodic review decision; changes require a new revision",
          id,
        );
      } else if (action === "obsolete") {
        requireRole(a, ["QA"], r.site_id);
        must(
          ["Approved", "Effective"].includes(rev.status),
          "Only approved or effective revisions may be withdrawn",
        );
        await db.query(
          "UPDATE revisions SET status='Obsolete',version=version+1 WHERE id=$1",
          [id],
        );
        await db.query(
          "UPDATE tasks SET status='Cancelled',completion_note=$1,version=version+1 WHERE revision_id=$2 AND status='Open'",
          [d.reason, id],
        );
        await db.query(
          "UPDATE training SET status='Cancelled' WHERE revision_id=$1 AND status='Assigned'",
          [id],
        );
        await db.query(
          "UPDATE approved_answers SET status='Needs Review',version=version+1 WHERE source_revision_id=$1 AND status='Approved'",
          [id],
        );
      } else throw new Fault(400, "Unsupported document action");
      return { id: r.id, revisionId: id };
    },
    { key, fingerprint: sha(JSON.stringify([id, action, d])) },
  );
}
export async function completeTraining(
  actorId: string,
  id: string,
  input: unknown,
  key: string,
) {
  const d = z.object({ reason, evidenceId: uuid.optional() }).parse(input);
  return transaction(
    actorId,
    "Training.complete",
    d.reason,
    async (db, a) => {
      const t = await one<{
        id: string;
        record_id: string;
        revision_id: string;
        user_id: string;
        method: string;
        status: string;
      }>(db, "SELECT * FROM training WHERE id=$1 FOR UPDATE", [id]);
      const r = await getRecord(db, t.record_id);
      must(
        t.status === "Assigned",
        "Training is already complete or cancelled",
      );
      const rev = await one<Revision>(
        db,
        "SELECT * FROM revisions WHERE id=$1",
        [t.revision_id],
      );
      must(
        ["Approved", "Effective"].includes(rev.status),
        "Revision is not available for training",
      );
      must(rev.file_id, "No training document");
      await verifyEvidence(db, rev.file_id, r.id);
      if (t.method === "Read acknowledgement")
        must(
          t.user_id === a.id,
          "Only the assigned trainee can acknowledge reading",
          403,
        );
      else {
        requireRole(a, ["Reviewer", "QA"], r.site_id);
        must(
          t.user_id !== a.id,
          "Independent competency confirmation is required",
        );
        must(d.evidenceId, "Training evidence is required", 400);
        await verifyEvidence(db, d.evidenceId, r.id);
      }
      await db.query(
        "UPDATE training SET status='Complete',evidence_id=$1,completion_note=$2,completed_by=$3,completed_at=now() WHERE id=$4",
        [d.evidenceId ?? null, d.reason, a.id, id],
      );
      await db.query(
        "UPDATE tasks SET status='Complete',evidence_id=$1,completion_note=$2,completed_at=now(),version=version+1 WHERE training_id=$3 AND status='Open'",
        [d.evidenceId ?? null, d.reason, id],
      );
      return { id: t.record_id };
    },
    { key, fingerprint: sha(JSON.stringify([id, d])) },
  );
}

export async function configureTraining(
  actorId: string,
  recordId: string,
  input: unknown,
  key: string,
) {
  const d = z
    .object({
      version: z.number().int().positive(),
      role: z.enum([
        "Employee",
        "Document Owner",
        "Reviewer",
        "Approver",
        "QA",
        "Investigator",
        "Inventory Custodian",
        "EHS Coordinator",
      ]),
      dueDays: z.number().int().min(1).max(365),
      active: z.boolean(),
      reason,
    })
    .parse(input);
  return transaction(
    actorId,
    "Training.configure",
    d.reason,
    async (db, a) => {
      const r = await getRecord(db, recordId, "Document");
      requireRole(a, ["QA"], r.site_id);
      const latest = await one<{ id: string }>(
        db,
        "SELECT id FROM revisions WHERE record_id=$1 ORDER BY number DESC LIMIT 1",
        [recordId],
      );
      const v = await versioned<Revision>(
        db,
        "revisions",
        latest.id,
        d.version,
        "id",
      );
      must(
        v.status === "Draft",
        "Training matrix can only change for a draft; active review snapshots are fixed",
      );
      await db.query(
        "INSERT INTO training_requirements(record_id,role,due_days,active) VALUES($1,$2,$3,$4) ON CONFLICT(record_id,role) DO UPDATE SET due_days=excluded.due_days,active=excluded.active,version=training_requirements.version+1",
        [recordId, d.role, d.dueDays, d.active],
      );
      await db.query("UPDATE revisions SET version=version+1 WHERE id=$1", [
        latest.id,
      ]);
      return { id: recordId };
    },
    { key, fingerprint: sha(JSON.stringify([recordId, d])) },
  );
}

export async function editDraft(
  actorId: string,
  recordId: string,
  input: unknown,
  key: string,
) {
  const d = z
    .object({
      version: z.number().int().positive(),
      title: text,
      changeReason: reason,
      trainingMode,
      trainingBeforeEffective: z.boolean(),
      reviewDue: z.iso.date(),
      effectiveAfter: z.iso.datetime().nullable().optional(),
    })
    .parse(input);
  return transaction(
    actorId,
    "Document.editDraft",
    d.changeReason,
    async (db, a) => {
      const r = await getRecord(db, recordId, "Document");
      requireRole(a, ["Document Owner", "QA"], r.site_id);
      const doc = await one<{ owner_id: string }>(
        db,
        "SELECT owner_id FROM documents WHERE record_id=$1",
        [recordId],
      );
      must(
        doc.owner_id === a.id || hasRole(a, ["QA"], r.site_id),
        "Only owner or site QA can edit",
        403,
      );
      const latest = await one<{ id: string }>(
        db,
        "SELECT id FROM revisions WHERE record_id=$1 ORDER BY number DESC LIMIT 1",
        [recordId],
      );
      const v = await versioned<Revision>(
        db,
        "revisions",
        latest.id,
        d.version,
        "id",
      );
      must(
        v.status === "Draft",
        "Content changes require a draft or a new revision",
      );
      await db.query(
        "UPDATE revisions SET title=$1,change_reason=$2,training_mode=$3,training_before_effective=$4,review_due=$5,effective_after=$6,version=version+1 WHERE id=$7",
        [
          d.title,
          d.changeReason,
          d.trainingMode,
          d.trainingBeforeEffective,
          d.reviewDue,
          d.effectiveAfter ?? null,
          latest.id,
        ],
      );
      return { id: recordId };
    },
    { key, fingerprint: sha(JSON.stringify([recordId, d])) },
  );
}
