import { z } from "zod";
import {
  scopeInput,
  transaction,
  createRecord,
  getRecord,
  one,
  versioned,
  requireRole,
  hasRole,
  accessibleUser,
  addTask,
  evidence,
  must,
  uuid,
  text,
  reason,
  sha,
  Fault,
} from "./core";
const answerSchema = scopeInput.extend({
  topic: text,
  answer: text,
  businessScope: text,
  limitations: text,
  sourceRevisionId: uuid.optional(),
  evidenceId: uuid.optional(),
  validUntil: z.iso.date(),
  status: z
    .enum(["Draft", "Cannot answer", "Pending confirmation"])
    .default("Draft"),
});
export async function createAnswer(
  actorId: string,
  input: unknown,
  key: string,
) {
  const d = answerSchema.parse(input);
  return transaction(
    actorId,
    "Answer.create",
    "Created a site-scoped answer draft",
    async (db, a) => {
      requireRole(a, ["QA"], d.siteId);
      const r = await createRecord(db, a, "Answer", d);
      if (d.sourceRevisionId) {
        const source = await one<{ site_id: string }>(
          db,
          "SELECT r.site_id FROM revisions v JOIN records r ON r.id=v.record_id WHERE v.id=$1",
          [d.sourceRevisionId],
        );
        must(
          source.site_id === d.siteId,
          "Source must belong to the answer site",
        );
      }
      if (d.evidenceId) {
        const ev = await one<{ site_id: string }>(
          db,
          "SELECT r.site_id FROM attachments f JOIN records r ON r.id=f.record_id WHERE f.id=$1",
          [d.evidenceId],
        );
        must(
          ev.site_id === d.siteId,
          "Evidence must belong to the answer site",
        );
      }
      await db.query(
        "INSERT INTO approved_answers(record_id,topic,answer,business_scope,limitations,source_revision_id,evidence_id,valid_until,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          r.id,
          d.topic,
          d.answer,
          d.businessScope,
          d.limitations,
          d.sourceRevisionId ?? null,
          d.evidenceId ?? null,
          d.validUntil,
          d.status,
        ],
      );
      return { id: r.id };
    },
    { key, fingerprint: sha(JSON.stringify(d)) },
  );
}
interface Answer {
  record_id: string;
  topic: string;
  answer: string;
  business_scope: string;
  limitations: string;
  source_revision_id: string | null;
  evidence_id: string | null;
  status: string;
  reviewed_by: string | null;
  valid_until: string;
  version: number;
}
async function validAnswer(
  db: Parameters<typeof one>[0],
  id: string,
  siteId: string,
) {
  const r = await getRecord(db, id, "Answer");
  must(r.site_id === siteId, "Answer belongs to another site");
  const answer = await one<Answer>(
    db,
    "SELECT * FROM approved_answers WHERE record_id=$1",
    [id],
  );
  must(answer.status === "Approved", "Answer needs review or confirmation");
  must(
    new Date(answer.valid_until + "T23:59:59Z") >= new Date(),
    "Answer review date has expired",
  );
  if (answer.source_revision_id) {
    const source = await one<{ status: string }>(
      db,
      "SELECT status FROM revisions WHERE id=$1",
      [answer.source_revision_id],
    );
    must(
      source.status === "Effective",
      "Source revision is no longer effective; answer requires review",
    );
  }
  must(
    answer.source_revision_id || answer.evidence_id,
    "Approved answer needs source evidence",
  );
  return { r, answer };
}
export async function answerAction(
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
      answer: text.optional(),
      limitations: text.optional(),
      sourceRevisionId: uuid.optional(),
      evidenceId: uuid.optional(),
      validUntil: z.iso.date().optional(),
    })
    .parse(input);
  return transaction(
    actorId,
    `Answer.${action}`,
    d.reason,
    async (db, a) => {
      const r = await getRecord(db, id, "Answer");
      requireRole(a, ["QA"], r.site_id);
      const row = await versioned<Answer>(
        db,
        "approved_answers",
        id,
        d.version,
      );
      if (action === "approve") {
        requireRole(a, ["Approver"], r.site_id);
        must(a.id !== r.created_by, "Independent answer approval required");
        must(
          ["Draft", "Needs Review"].includes(row.status),
          "Answer is not ready for approval",
        );
        must(row.source_revision_id || row.evidence_id, "Evidence required");
        if (row.source_revision_id) {
          const source = await one<{ status: string; site_id: string }>(
            db,
            "SELECT v.status,r.site_id FROM revisions v JOIN records r ON r.id=v.record_id WHERE v.id=$1",
            [row.source_revision_id],
          );
          must(
            source.status === "Effective" && source.site_id === r.site_id,
            "Source must be effective at the same site",
          );
        }
        must(
          new Date(row.valid_until + "T23:59:59Z") >= new Date(),
          "Review date has expired",
        );
        await db.query(
          "UPDATE approved_answers SET status='Approved',reviewed_by=$1,reviewed_at=now(),version=version+1 WHERE record_id=$2",
          [a.id, id],
        );
      } else if (action === "revise") {
        must(
          d.answer && d.limitations && d.validUntil,
          "Answer, limitations and next review date required",
          400,
        );
        if (d.sourceRevisionId) {
          const source = await one<{ site_id: string }>(
            db,
            "SELECT r.site_id FROM revisions v JOIN records r ON r.id=v.record_id WHERE v.id=$1",
            [d.sourceRevisionId],
          );
          must(source.site_id === r.site_id, "Source site mismatch");
        }
        if (d.evidenceId) await evidence(db, d.evidenceId, id);
        await db.query(
          "UPDATE approved_answers SET answer=$1,limitations=$2,source_revision_id=$3,evidence_id=$4,valid_until=$5,status='Draft',reviewed_by=NULL,reviewed_at=NULL,version=version+1 WHERE record_id=$6",
          [
            d.answer,
            d.limitations,
            d.sourceRevisionId ?? null,
            d.evidenceId ?? null,
            d.validUntil,
            id,
          ],
        );
      } else throw new Fault(400, "Unsupported answer action");
      return { id };
    },
    { key, fingerprint: sha(JSON.stringify([id, action, d])) },
  );
}
export async function createQuestionnaire(
  actorId: string,
  input: unknown,
  key: string,
) {
  const d = scopeInput.extend({ ownerId: uuid }).parse(input);
  return transaction(
    actorId,
    "Questionnaire.create",
    "Created questionnaire",
    async (db, a) => {
      requireRole(a, ["QA"], d.siteId);
      const r = await createRecord(db, a, "Questionnaire", d);
      await accessibleUser(db, d.ownerId, r.id);
      await db.query(
        "INSERT INTO questionnaires(record_id,owner_id) VALUES($1,$2)",
        [r.id, d.ownerId],
      );
      return { id: r.id };
    },
    { key, fingerprint: sha(JSON.stringify(d)) },
  );
}
const questionSchema = z.object({
  question: text,
  assigneeId: uuid,
  answerId: uuid.optional(),
  draftAnswer: text.default("Pending confirmation"),
  evidenceId: uuid.optional(),
  promisedDocument: z.string().max(300).optional(),
  reason,
});
export async function addQuestion(
  actorId: string,
  id: string,
  input: unknown,
  key: string,
) {
  const d = questionSchema.parse(input);
  return transaction(
    actorId,
    "Questionnaire.addQuestion",
    d.reason,
    async (db, a) => {
      const r = await getRecord(db, id, "Questionnaire");
      requireRole(a, ["QA"], r.site_id);
      const q = await one<{ status: string }>(
        db,
        "SELECT status FROM questionnaires WHERE record_id=$1 FOR UPDATE",
        [id],
      );
      must(q.status === "Draft", "Only a draft questionnaire can change");
      await accessibleUser(db, d.assigneeId, id);
      if (d.evidenceId) await evidence(db, d.evidenceId, id);
      let answer = d.draftAnswer;
      if (d.answerId) {
        const approved = await validAnswer(db, d.answerId, r.site_id);
        must(
          (!approved.r.customer_id ||
            approved.r.customer_id === r.customer_id) &&
            (!approved.r.project_id || approved.r.project_id === r.project_id),
          "Answer customer/project scope does not match",
        );
        answer = approved.answer.answer;
      }
      const question = await one<{ id: string }>(
        db,
        "INSERT INTO questions(record_id,question,assignee_id,answer_id,draft_answer,evidence_id,promised_document) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id",
        [
          id,
          d.question,
          d.assigneeId,
          d.answerId ?? null,
          answer,
          d.evidenceId ?? null,
          d.promisedDocument ?? null,
        ],
      );
      const task = await addTask(
        db,
        id,
        d.assigneeId,
        "Question",
        `Draft response: ${d.question.slice(0, 80)}`,
        new Date(Date.now() + 7 * 86400000).toISOString(),
        "Save the assigned question response; QA review and submission are separate",
      );
      await db.query("UPDATE tasks SET question_id=$1 WHERE id=$2", [
        question.id,
        task.id,
      ]);
      await db.query(
        "UPDATE questionnaires SET version=version+1 WHERE record_id=$1",
        [id],
      );
      return { id };
    },
    { key, fingerprint: sha(JSON.stringify([id, d])) },
  );
}
export async function questionnaireAction(
  actorId: string,
  id: string,
  action: string,
  input: unknown,
  key: string,
) {
  const d = z
    .object({ version: z.number().int().positive(), reason })
    .parse(input);
  return transaction(
    actorId,
    `Questionnaire.${action}`,
    d.reason,
    async (db, a) => {
      const r = await getRecord(db, id, "Questionnaire");
      requireRole(a, ["QA"], r.site_id);
      const q = await versioned<{
        status: string;
        owner_id: string;
        version: number;
      }>(db, "questionnaires", id, d.version);
      const questions = (
        await db.query<{
          id: string;
          question: string;
          assignee_id: string;
          answer_id: string | null;
          draft_answer: string;
          evidence_id: string | null;
          promised_document: string | null;
        }>("SELECT * FROM questions WHERE record_id=$1 ORDER BY id", [id])
      ).rows;
      if (action === "review") {
        must(
          q.status === "Draft" && questions.length,
          "Add questions before review",
        );
        must(
          !(
            await db.query(
              "SELECT id FROM tasks WHERE record_id=$1 AND kind='Question' AND status='Open'",
              [id],
            )
          ).rowCount,
          "Assigned question responses must be saved before review",
        );
        await db.query(
          "UPDATE questionnaires SET status='In Review',version=version+1 WHERE record_id=$1",
          [id],
        );
      } else if (action === "return") {
        must(q.status === "In Review", "Only an active review can be returned");
        await db.query(
          "UPDATE questionnaires SET status='Draft',version=version+1 WHERE record_id=$1",
          [id],
        );
      } else if (action === "submit") {
        must(q.status === "In Review", "Review is required");
        must(
          a.id !== q.owner_id && a.id !== r.created_by,
          "Independent QA submission review required",
        );
        const snapshot = [];
        for (const x of questions) {
          let source = null;
          if (x.answer_id) {
            const value = await validAnswer(db, x.answer_id, r.site_id);
            must(
              (!value.r.customer_id || value.r.customer_id === r.customer_id) &&
                (!value.r.project_id || value.r.project_id === r.project_id),
              "Answer scope changed",
            );
            must(
              value.answer.answer === x.draft_answer,
              "Standard answer changed after selection; return and review the question",
            );
            source = value.answer;
          }
          const fileIds = [x.evidence_id, source?.evidence_id].filter(Boolean);
          if (source?.source_revision_id) {
            const rev = await one<{ file_id: string }>(
              db,
              "SELECT file_id FROM revisions WHERE id=$1",
              [source.source_revision_id],
            );
            fileIds.push(rev.file_id);
          }
          const files = (
            await db.query(
              "SELECT id,filename,sha256,record_id FROM attachments WHERE id=ANY($1::uuid[])",
              [fileIds],
            )
          ).rows;
          snapshot.push({ ...x, source, files });
          if (x.promised_document)
            await addTask(
              db,
              id,
              x.assignee_id,
              "Delivery",
              `Provide ${x.promised_document}`,
              new Date(Date.now() + 7 * 86400000).toISOString(),
              "Attach the promised document and record delivery confirmation",
            );
        }
        await db.query(
          "INSERT INTO questionnaire_submissions(record_id,snapshot,submitted_by) VALUES($1,$2,$3)",
          [
            id,
            JSON.stringify({
              siteId: r.site_id,
              customerId: r.customer_id,
              projectId: r.project_id,
              title: r.title,
              questions: snapshot,
            }),
            a.id,
          ],
        );
        await db.query(
          "UPDATE questionnaires SET status='Submitted',reviewed_by=$1,version=version+1 WHERE record_id=$2",
          [a.id, id],
        );
      } else throw new Fault(400, "Unsupported questionnaire action");
      return { id };
    },
    { key, fingerprint: sha(JSON.stringify([id, action, d])) },
  );
}

export async function updateQuestion(
  actorId: string,
  id: string,
  input: unknown,
  key: string,
) {
  const d = questionSchema
    .extend({ version: z.number().int().positive() })
    .parse(input);
  return transaction(
    actorId,
    "Questionnaire.updateQuestion",
    d.reason,
    async (db, a) => {
      const q = await versioned<{
        record_id: string;
        assignee_id: string;
        version: number;
      }>(db, "questions", id, d.version, "id");
      const r = await getRecord(db, q.record_id, "Questionnaire");
      const parent = await one<{ status: string }>(
        db,
        "SELECT status FROM questionnaires WHERE record_id=$1 FOR UPDATE",
        [r.id],
      );
      must(
        parent.status === "Draft",
        "Only draft questionnaire responses may change",
      );
      must(
        q.assignee_id === a.id || hasRole(a, ["QA"], r.site_id),
        "Only the assigned contributor or QA may edit",
        403,
      );
      if (d.assigneeId !== q.assignee_id) requireRole(a, ["QA"], r.site_id);
      await accessibleUser(db, d.assigneeId, r.id);
      if (d.evidenceId) await evidence(db, d.evidenceId, r.id);
      let answer = d.draftAnswer;
      if (d.answerId) {
        const approved = await validAnswer(db, d.answerId, r.site_id);
        must(
          (!approved.r.customer_id ||
            approved.r.customer_id === r.customer_id) &&
            (!approved.r.project_id || approved.r.project_id === r.project_id),
          "Answer scope mismatch",
        );
        answer = approved.answer.answer;
      }
      await db.query(
        "UPDATE questions SET question=$1,assignee_id=$2,answer_id=$3,draft_answer=$4,evidence_id=$5,promised_document=$6,version=version+1 WHERE id=$7",
        [
          d.question,
          d.assigneeId,
          d.answerId ?? null,
          answer,
          d.evidenceId ?? null,
          d.promisedDocument ?? null,
          id,
        ],
      );
      await db.query(
        "UPDATE questionnaires SET version=version+1 WHERE record_id=$1",
        [r.id],
      );
      await db.query(
        "UPDATE tasks SET assignee_id=$1,status=$2,completed_at=CASE WHEN $2='Complete' THEN now() ELSE NULL END,completion_note=$3,version=version+1 WHERE question_id=$4",
        [
          d.assigneeId,
          d.assigneeId === q.assignee_id ? "Complete" : "Open",
          d.reason,
          id,
        ],
      );
      return { id: r.id };
    },
    { key, fingerprint: sha(JSON.stringify([id, d])) },
  );
}
