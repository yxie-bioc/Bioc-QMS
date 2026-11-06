import { z } from "zod";
import {
  transaction,
  versioned,
  getRecord,
  requireRole,
  hasRole,
  must,
  accessibleUser,
  uuid,
  reason,
  sha,
  Fault,
  evidence,
  one,
  addTask,
  text,
} from "./core";
interface Task {
  id: string;
  record_id: string;
  revision_id: string | null;
  training_id: string | null;
  kind: string;
  assignee_id: string;
  status: string;
  version: number;
  requires_evidence: boolean;
}
export async function taskAction(
  actorId: string,
  id: string,
  action: string,
  input: unknown,
  key: string,
) {
  const d = z
    .object({
      version: z.number().int().positive(),
      reason,
      assigneeId: uuid.optional(),
      dueAt: z.iso.datetime().optional(),
      evidenceId: uuid.optional(),
    })
    .parse(input);
  return transaction(
    actorId,
    `Task.${action}`,
    d.reason,
    async (db, a) => {
      const t = await versioned<Task>(db, "tasks", id, d.version, "id");
      const r = await getRecord(db, t.record_id);
      must(t.status === "Open", "Task is no longer open");
      if (action === "reassign") {
        requireRole(a, ["QA", "System Administrator"], r.site_id);
        must(d.assigneeId, "New assignee required", 400);
        let roles: string[] | undefined;
        if (t.kind === "Review") roles = ["Reviewer", "QA"];
        if (t.kind === "Approve") roles = ["Approver"];
        await accessibleUser(db, d.assigneeId, r.id, roles, r.site_id);
        must(
          !["Training", "Question"].includes(t.kind),
          "Training and question tasks must be managed through their record workflow",
        );
        if (t.revision_id && ["Review", "Approve"].includes(t.kind)) {
          const rev = await one<{
            created_by: string;
            owner_id: string;
            reviewer_id: string;
            approver_id: string;
            status: string;
            uploaded_by: string;
          }>(
            db,
            "SELECT v.*,d.owner_id,f.uploaded_by FROM revisions v JOIN documents d ON d.record_id=v.record_id JOIN attachments f ON f.id=v.file_id WHERE v.id=$1 FOR UPDATE OF v",
            [t.revision_id],
          );
          must(rev.status === "In Review", "Revision is no longer in review");
          must(
            ![
              rev.created_by,
              rev.owner_id,
              rev.uploaded_by,
              t.kind === "Review" ? rev.approver_id : rev.reviewer_id,
            ].includes(d.assigneeId),
            "Reassignment would violate independent review or approval",
          );
          await db.query(
            `UPDATE revisions SET ${t.kind === "Review" ? "reviewer_id" : "approver_id"}=$1,version=version+1 WHERE id=$2`,
            [d.assigneeId, t.revision_id],
          );
        }
        await db.query(
          "UPDATE tasks SET assignee_id=$1,version=version+1 WHERE id=$2",
          [d.assigneeId, id],
        );
        await db.query(
          "UPDATE notification_outbox SET status='Cancelled',last_error='Task reassigned' WHERE task_id=$1 AND status IN ('Pending','Failed')",
          [id],
        );
      } else if (action === "extend") {
        requireRole(a, ["QA", "System Administrator"], r.site_id);
        must(
          d.dueAt && new Date(d.dueAt) > new Date(),
          "A future due date is required",
          400,
        );
        await db.query(
          "UPDATE tasks SET due_at=$1,version=version+1 WHERE id=$2",
          [d.dueAt, id],
        );
      } else if (action === "complete") {
        must(
          ![
            "Review",
            "Approve",
            "Training",
            "Effectiveness",
            "Question",
            "Implementation",
            "Finding",
            "EHS review",
          ].includes(t.kind),
          "Complete this task through its business workflow",
        );
        must(
          t.assignee_id === a.id || hasRole(a, ["QA"], r.site_id),
          "Only assignee or site QA can complete this task",
          403,
        );
        if (t.requires_evidence)
          must(d.evidenceId, "Completion evidence is required", 400);
        if (d.evidenceId) await evidence(db, d.evidenceId, r.id);
        await db.query(
          "UPDATE tasks SET status='Complete',completed_at=now(),completion_note=$1,evidence_id=$2,version=version+1 WHERE id=$3",
          [d.reason, d.evidenceId ?? null, id],
        );
      } else throw new Fault(400, "Unsupported task action");
      return { id: t.record_id };
    },
    { key, fingerprint: sha(JSON.stringify([id, action, d])) },
  );
}

export async function createTask(actorId: string, input: unknown, key: string) {
  const d = z
    .object({
      recordId: uuid,
      title: text,
      assigneeId: uuid,
      dueAt: z.iso.datetime(),
      completionCondition: text,
      requiresEvidence: z.boolean().default(false),
      reason,
    })
    .parse(input);
  return transaction(
    actorId,
    "Task.assign",
    d.reason,
    async (db, a) => {
      const r = await getRecord(db, d.recordId);
      requireRole(
        a,
        ["QA", "Document Owner", "Inventory Custodian", "EHS Coordinator"],
        r.site_id,
      );
      const task = await addTask(
        db,
        r.id,
        d.assigneeId,
        "Follow-up",
        d.title,
        d.dueAt,
        d.completionCondition,
      );
      await db.query("UPDATE tasks SET requires_evidence=$1 WHERE id=$2", [
        d.requiresEvidence,
        task.id,
      ]);
      return { id: r.id, taskId: task.id };
    },
    { key, fingerprint: sha(JSON.stringify(d)) },
  );
}
