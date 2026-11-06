import { z } from "zod";
import {
  scopeInput,
  transaction,
  createRecord,
  getRecord,
  one,
  versioned,
  requireRole,
  accessibleUser,
  addTask,
  evidence,
  must,
  uuid,
  text,
  reason,
  sha,
  Fault,
  type Tx,
  type Actor,
} from "./core";
import { verifyEvidence } from "./files";
const date = z.iso.date(),
  datetime = z.iso.datetime();
const createSchemas = {
  Deviation: scopeInput.extend({
    description: text,
    occurredOn: date,
    reportedOn: date,
    risk: z.enum(["Low", "Medium", "High"]),
    ownerId: uuid,
    impact: text,
    containment: text,
  }),
  CAPA: scopeInput.extend({
    plan: text,
    ownerId: uuid,
    dueAt: datetime,
    effectivenessRequired: z.boolean(),
    effectivenessPlan: z.string().max(20000).optional(),
    sourceIds: z.array(uuid).max(30).default([]),
  }),
  Change: scopeInput.extend({
    description: text,
    impact: text,
    implementationPlan: text,
    ownerId: uuid,
  }),
  Audit: scopeInput.extend({
    auditType: z.enum(["Customer", "Supplier", "Internal"]),
    scope: text,
    target: text,
    plannedOn: date,
    ownerId: uuid,
  }),
  EHS: scopeInput.extend({
    category: z.enum([
      "Risk assessment",
      "Material introduction",
      "Permit",
      "Inspection",
      "Incident",
    ]),
    description: text,
    ownerId: uuid,
    dueAt: datetime,
  }),
};
export type QualityKind = keyof typeof createSchemas;
export async function createQuality(
  actorId: string,
  kind: QualityKind,
  input: unknown,
  key: string,
) {
  // Each business object has its own typed schema and table; records is only the scoped identity index.
  const parsed = createSchemas[kind].parse(input);
  return transaction(
    actorId,
    `${kind}.create`,
    "Created a new business record",
    async (db, a) => {
      requireRole(
        a,
        kind === "EHS" ? ["EHS Coordinator"] : ["QA", "Investigator"],
        parsed.siteId,
      );
      const r = await createRecord(db, a, kind, parsed);
      await accessibleUser(db, parsed.ownerId, r.id);
      if (kind === "Deviation") {
        const d = createSchemas.Deviation.parse(parsed);
        must(
          d.occurredOn <= d.reportedOn,
          "Occurrence must not follow report date",
          400,
        );
        await db.query(
          "INSERT INTO deviations(record_id,description,occurred_on,reported_on,risk,owner_id,impact,containment) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            r.id,
            d.description,
            d.occurredOn,
            d.reportedOn,
            d.risk,
            d.ownerId,
            d.impact,
            d.containment,
          ],
        );
      } else if (kind === "CAPA") {
        const d = createSchemas.CAPA.parse(parsed);
        must(
          !d.effectivenessRequired || d.effectivenessPlan?.trim(),
          "Effectiveness plan required",
          400,
        );
        await db.query(
          "INSERT INTO capas(record_id,plan,owner_id,due_at,effectiveness_required,effectiveness_plan) VALUES($1,$2,$3,$4,$5,$6)",
          [
            r.id,
            d.plan,
            d.ownerId,
            d.dueAt,
            d.effectivenessRequired,
            d.effectivenessPlan ?? null,
          ],
        );
        for (const id of d.sourceIds) {
          const source = await getRecord(db, id);
          must(source.site_id === r.site_id, "Source site mismatch");
          await db.query(
            "INSERT INTO quality_links(record_id,related_id,relation) VALUES($1,$2,$3)",
            [r.id, id, "CAPA source"],
          );
        }
        await addTask(
          db,
          r.id,
          d.ownerId,
          "Implementation",
          `Implement CAPA · ${r.title}`,
          d.dueAt,
          "Approved plan and implementation evidence required",
        );
      } else if (kind === "Change") {
        const d = createSchemas.Change.parse(parsed);
        await db.query(
          "INSERT INTO changes(record_id,description,impact,implementation_plan,owner_id) VALUES($1,$2,$3,$4,$5)",
          [r.id, d.description, d.impact, d.implementationPlan, d.ownerId],
        );
      } else if (kind === "Audit") {
        const d = createSchemas.Audit.parse(parsed);
        await db.query(
          "INSERT INTO audits(record_id,audit_type,scope,target,planned_on,owner_id) VALUES($1,$2,$3,$4,$5,$6)",
          [r.id, d.auditType, d.scope, d.target, d.plannedOn, d.ownerId],
        );
      } else {
        const d = createSchemas.EHS.parse(parsed);
        await db.query(
          "INSERT INTO ehs_records(record_id,category,description,owner_id,due_at) VALUES($1,$2,$3,$4,$5)",
          [r.id, d.category, d.description, d.ownerId, d.dueAt],
        );
        await addTask(
          db,
          r.id,
          d.ownerId,
          "EHS review",
          `${d.category} · ${r.title}`,
          d.dueAt,
          "Document assessment, appropriate evidence and authorized closure",
        );
      }
      return { id: r.id };
    },
    { key, fingerprint: sha(JSON.stringify([kind, parsed])) },
  );
}
interface EventRow {
  record_id: string;
  status: string;
  owner_id: string;
  version: number;
  created_by?: string;
  impact?: string;
  containment?: string;
  investigation?: string;
  root_cause?: string;
  disposition?: string;
  capa_decision?: string;
  capa_reason?: string;
  risk?: string;
  effectiveness_required?: boolean;
  effectiveness_result?: string;
  implementation_evidence_id?: string;
  effectiveness_evidence_id?: string;
  report_id?: string;
  approved_by?: string;
  assessment?: string;
  corrective_action?: string;
  evidence_id?: string;
}
const actionSchema = z.object({
  version: z.number().int().positive(),
  reason,
  impact: text.optional(),
  containment: text.optional(),
  investigation: text.optional(),
  rootCause: text.optional(),
  disposition: text.optional(),
  capaDecision: z.enum(["Required", "Not Required"]).optional(),
  capaReason: reason.optional(),
  evidenceId: uuid.optional(),
  effectivenessResult: z.enum(["Pass", "Fail"]).optional(),
  dueAt: datetime.optional(),
  assessment: text.optional(),
  interimMeasures: text.optional(),
  correctiveAction: text.optional(),
  relatedId: uuid.optional(),
});
export async function qualityAction(
  actorId: string,
  id: string,
  action: string,
  input: unknown,
  key: string,
) {
  const d = actionSchema.parse(input);
  return transaction(
    actorId,
    `Quality.${action}`,
    d.reason,
    async (db, a) => {
      const r = await getRecord(db, id);
      const tables: Record<string, string> = {
        Deviation: "deviations",
        CAPA: "capas",
        Change: "changes",
        Audit: "audits",
        EHS: "ehs_records",
      };
      const table = tables[r.kind];
      must(table, "Unsupported quality record", 400);
      const row = await versioned<EventRow>(db, table, id, d.version);
      const qa = () =>
        requireRole(
          a,
          r.kind === "EHS" ? ["EHS Coordinator"] : ["QA"],
          r.site_id,
        );
      const owner = () => {
        requireRole(
          a,
          r.kind === "EHS" ? ["EHS Coordinator"] : ["QA", "Investigator"],
          r.site_id,
        );
      };
      const setStatus = async (s: string) =>
        db.query(
          `UPDATE ${table} SET status=$1,version=version+1 WHERE record_id=$2`,
          [s, id],
        );
      if (action === "link") {
        owner();
        must(d.relatedId, "Related record required", 400);
        const related = await getRecord(db, d.relatedId);
        must(
          related.site_id === r.site_id,
          "Cross-site linkage requires a separate reviewed process",
        );
        await db.query(
          "INSERT INTO quality_links(record_id,related_id,relation) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [id, d.relatedId, d.reason],
        );
        await db.query(
          `UPDATE ${table} SET version=version+1 WHERE record_id=$1`,
          [id],
        );
      } else if (action === "cancel") {
        qa();
        must(
          !["Closed", "Cancelled"].includes(row.status),
          "Closed or cancelled records cannot be cancelled",
        );
        await setStatus("Cancelled");
        await db.query(
          "UPDATE tasks SET status='Cancelled',completion_note=$1,version=version+1 WHERE record_id=$2 AND status='Open'",
          [d.reason, id],
        );
      } else if (r.kind === "Deviation") {
        if (action === "investigate") {
          owner();
          must(
            ["Open", "Investigation"].includes(row.status),
            "Deviation cannot be edited in this state",
          );
          must(
            d.impact &&
              d.containment &&
              d.investigation &&
              d.disposition &&
              d.capaDecision &&
              d.capaReason,
            "Impact, containment, investigation, disposition and CAPA decision with rationale required",
            400,
          );
          if (row.risk !== "Low")
            must(
              d.rootCause,
              "Root cause assessment required for medium/high risk",
              400,
            );
          await db.query(
            "UPDATE deviations SET impact=$1,containment=$2,investigation=$3,root_cause=$4,disposition=$5,capa_decision=$6,capa_reason=$7,status='Investigation',version=version+1 WHERE record_id=$8",
            [
              d.impact,
              d.containment,
              d.investigation,
              d.rootCause ?? null,
              d.disposition,
              d.capaDecision,
              d.capaReason,
              id,
            ],
          );
        } else if (action === "submit") {
          owner();
          must(
            row.status === "Investigation" &&
              row.capa_decision &&
              row.capa_reason,
            "Complete investigation and CAPA rationale before review",
          );
          await setStatus("In Review");
        } else if (action === "close") {
          qa();
          must(
            row.status === "In Review",
            "Deviation must be reviewed before closing",
          );
          must(
            a.id !== row.owner_id && a.id !== r.created_by,
            "Independent QA closure required",
          );
          if (row.capa_decision === "Required")
            must(
              (
                await db.query(
                  "SELECT c.record_id FROM quality_links l JOIN capas c ON c.record_id=CASE WHEN l.record_id=$1 THEN l.related_id ELSE l.record_id END WHERE (l.record_id=$1 OR l.related_id=$1) AND c.status<>'Cancelled'",
                  [id],
                )
              ).rowCount,
              "Link an active CAPA before closure",
            );
          else
            must(row.capa_reason, "CAPA Not Required needs reviewed rationale");
          await db.query(
            "UPDATE deviations SET reviewed_by=$1 WHERE record_id=$2",
            [a.id, id],
          );
          await setStatus("Closed");
        } else if (action === "return") {
          qa();
          must(row.status === "In Review", "Only a review can be returned");
          await setStatus("Investigation");
        } else if (action === "reopen") {
          qa();
          must(
            row.status === "Closed",
            "Only a closed deviation can be reopened",
          );
          await db.query(
            "UPDATE deviations SET reviewed_by=NULL WHERE record_id=$1",
            [id],
          );
          await setStatus("Investigation");
        } else throw new Fault(400, "Unsupported deviation action");
      } else if (r.kind === "CAPA") {
        if (action === "approve-plan") {
          requireRole(a, ["Approver"], r.site_id);
          must(row.status === "Draft", "Plan is not a draft");
          must(
            a.id !== row.owner_id && a.id !== r.created_by,
            "Independent plan approval required",
          );
          await db.query("UPDATE capas SET approved_by=$1 WHERE record_id=$2", [
            a.id,
            id,
          ]);
          await setStatus("Plan Approved");
        } else if (action === "implement") {
          owner();
          must(
            row.status === "Plan Approved",
            "Approve plan before implementation",
          );
          await verifyEvidence(db, d.evidenceId!, id);
          await db.query(
            "UPDATE capas SET implementation_evidence_id=$1 WHERE record_id=$2",
            [d.evidenceId, id],
          );
          await setStatus("Implemented");
          await db.query(
            "UPDATE tasks SET status='Complete',completed_at=now(),completion_note=$1,evidence_id=$2,version=version+1 WHERE record_id=$3 AND kind='Implementation' AND status='Open'",
            [d.reason, d.evidenceId, id],
          );
          if (row.effectiveness_required)
            await addTask(
              db,
              id,
              row.owner_id,
              "Effectiveness",
              `Effectiveness check · ${r.title}`,
              d.dueAt ?? new Date(Date.now() + 30 * 86400000).toISOString(),
              "Document the result and supporting evidence; QA closure remains separate",
            );
        } else if (action === "effectiveness") {
          qa();
          must(
            row.status === "Implemented",
            "Implementation must be completed first",
          );
          must(
            row.effectiveness_required,
            "Effectiveness check was not required",
          );
          must(
            a.id !== row.owner_id,
            "Independent effectiveness review required",
          );
          must(d.effectivenessResult, "Pass/fail result required", 400);
          await verifyEvidence(db, d.evidenceId!, id);
          await db.query(
            "UPDATE capas SET effectiveness_evidence_id=$1,effectiveness_result=$2 WHERE record_id=$3",
            [d.evidenceId, d.effectivenessResult, id],
          );
          await setStatus(
            d.effectivenessResult === "Pass"
              ? "Effectiveness Complete"
              : "Plan Approved",
          );
          await db.query(
            "UPDATE tasks SET status='Complete',completed_at=now(),completion_note=$1,version=version+1 WHERE record_id=$2 AND kind='Effectiveness' AND status='Open'",
            [d.reason, id],
          );
        } else if (action === "close") {
          qa();
          must(
            row.status ===
              (row.effectiveness_required
                ? "Effectiveness Complete"
                : "Implemented"),
            "Required implementation or effectiveness check is incomplete",
          );
          must(
            a.id !== row.owner_id && a.id !== r.created_by,
            "Independent QA closure required",
          );
          await db.query("UPDATE capas SET closed_by=$1 WHERE record_id=$2", [
            a.id,
            id,
          ]);
          await setStatus("Closed");
        } else if (action === "extend") {
          qa();
          must(
            !["Closed", "Cancelled"].includes(row.status) && d.dueAt,
            "Active CAPA and new due date required",
          );
          must(
            new Date(d.dueAt) > new Date(),
            "New deadline must be in the future",
          );
          await db.query(
            "UPDATE capas SET due_at=$1,version=version+1 WHERE record_id=$2",
            [d.dueAt, id],
          );
        } else throw new Fault(400, "Unsupported CAPA action");
      } else if (r.kind === "Change") {
        if (action === "approve") {
          requireRole(a, ["Approver"], r.site_id);
          must(row.status === "Draft", "Change is not a draft");
          must(
            a.id !== row.owner_id && a.id !== r.created_by,
            "Independent approval required",
          );
          await db.query(
            "UPDATE changes SET approved_by=$1 WHERE record_id=$2",
            [a.id, id],
          );
          await setStatus("Approved");
        } else if (action === "implement") {
          owner();
          must(row.status === "Approved", "Change is not approved");
          await verifyEvidence(db, d.evidenceId!, id);
          await db.query(
            "UPDATE changes SET evidence_id=$1 WHERE record_id=$2",
            [d.evidenceId, id],
          );
          await setStatus("Implemented");
        } else if (action === "close") {
          qa();
          must(
            row.status === "Implemented",
            "Implementation evidence is required",
          );
          must(
            a.id !== row.owner_id && a.id !== r.created_by,
            "Independent QA closure required",
          );
          await setStatus("Closed");
        } else throw new Fault(400, "Unsupported change action");
      } else if (r.kind === "Audit") {
        if (action === "start") {
          owner();
          must(row.status === "Planned", "Audit is not planned");
          await setStatus("In Progress");
        } else if (action === "submit") {
          owner();
          must(row.status === "In Progress", "Audit must be in progress");
          await verifyEvidence(db, d.evidenceId!, id);
          await db.query("UPDATE audits SET report_id=$1 WHERE record_id=$2", [
            d.evidenceId,
            id,
          ]);
          await setStatus("In Review");
        } else if (action === "close") {
          qa();
          must(
            row.status === "In Review" && row.report_id,
            "Reviewed report required",
          );
          must(a.id !== row.owner_id, "Independent QA closure required");
          must(
            !(
              await db.query(
                "SELECT id FROM findings WHERE record_id=$1 AND status<>'Closed'",
                [id],
              )
            ).rowCount,
            "Open findings remain",
          );
          await setStatus("Closed");
        } else throw new Fault(400, "Unsupported audit action");
      } else if (r.kind === "EHS") {
        qa();
        if (action === "assess") {
          must(
            ["Open", "In Review"].includes(row.status),
            "EHS record is closed",
          );
          must(
            d.assessment && d.correctiveAction,
            "Assessment and corrective action required",
            400,
          );
          await db.query(
            "UPDATE ehs_records SET assessment=$1,interim_measures=$2,corrective_action=$3,status='In Review',version=version+1 WHERE record_id=$4",
            [d.assessment, d.interimMeasures ?? null, d.correctiveAction, id],
          );
        } else if (action === "close") {
          must(
            row.status === "In Review" &&
              row.assessment &&
              row.corrective_action,
            "Assessment and corrective action required",
          );
          must(
            a.id !== row.owner_id && a.id !== r.created_by,
            "Independent EHS closure required",
          );
          await verifyEvidence(db, d.evidenceId!, id);
          await db.query(
            "UPDATE ehs_records SET evidence_id=$1,closed_by=$2,status='Closed',version=version+1 WHERE record_id=$3",
            [d.evidenceId, a.id, id],
          );
          await db.query(
            "UPDATE tasks SET status='Complete',completed_at=now(),completion_note=$1,evidence_id=$2,version=version+1 WHERE record_id=$3 AND kind='EHS review' AND status='Open'",
            [d.reason, d.evidenceId, id],
          );
        } else throw new Fault(400, "Unsupported EHS action");
      }
      return { id };
    },
    { key, fingerprint: sha(JSON.stringify([id, action, d])) },
  );
}
export async function findingAction(
  actorId: string,
  auditId: string,
  action: string,
  input: unknown,
  key: string,
) {
  const d = z
    .object({
      id: uuid.optional(),
      version: z.number().int().positive().optional(),
      description: text.optional(),
      grade: text.optional(),
      ownerId: uuid.optional(),
      dueAt: datetime.optional(),
      response: text.optional(),
      evidenceId: uuid.optional(),
      capaId: uuid.optional(),
      reason,
    })
    .parse(input);
  return transaction(
    actorId,
    `Finding.${action}`,
    d.reason,
    async (db, a) => {
      const r = await getRecord(db, auditId, "Audit");
      requireRole(a, ["QA"], r.site_id);
      const audit = await one<{ status: string }>(
        db,
        "SELECT status FROM audits WHERE record_id=$1 FOR UPDATE",
        [auditId],
      );
      must(!["Closed", "Cancelled"].includes(audit.status), "Audit is closed");
      if (action === "create") {
        must(
          d.description && d.grade && d.ownerId && d.dueAt,
          "Description, grade, owner and due date required",
          400,
        );
        await accessibleUser(db, d.ownerId, auditId);
        const finding = await one<{ id: string }>(
          db,
          "INSERT INTO findings(record_id,description,grade,owner_id,due_at) VALUES($1,$2,$3,$4,$5) RETURNING id",
          [auditId, d.description, d.grade, d.ownerId, d.dueAt],
        );
        const task = await addTask(
          db,
          auditId,
          d.ownerId,
          "Finding",
          `Respond to finding · ${d.grade}`,
          d.dueAt,
          "Response, evidence and QA closure required",
        );
        await db.query("UPDATE tasks SET finding_id=$1 WHERE id=$2", [
          finding.id,
          task.id,
        ]);
        return { id: auditId, findingId: finding.id };
      }
      must(d.id && d.version, "Finding and current version required", 400);
      const f = await versioned<{
        version: number;
        record_id: string;
        status: string;
        owner_id: string;
      }>(db, "findings", d.id, d.version, "id");
      must(f.record_id === auditId && f.status === "Open", "Finding not open");
      must(action === "close", "Unsupported finding action", 400);
      must(a.id !== f.owner_id, "Independent closure required");
      must(d.response, "Finding response required", 400);
      await verifyEvidence(db, d.evidenceId!, auditId);
      if (d.capaId) {
        const c = await getRecord(db, d.capaId, "CAPA");
        must(c.site_id === r.site_id, "CAPA site mismatch");
      }
      await db.query(
        "UPDATE findings SET response=$1,evidence_id=$2,capa_id=$3,status='Closed',closed_by=$4,version=version+1 WHERE id=$5",
        [d.response, d.evidenceId, d.capaId ?? null, a.id, d.id],
      );
      await db.query(
        "UPDATE tasks SET status='Complete',completed_at=now(),completion_note=$1,evidence_id=$2,version=version+1 WHERE finding_id=$3 AND status='Open'",
        [d.reason, d.evidenceId, d.id],
      );
      return { id: auditId };
    },
    { key, fingerprint: sha(JSON.stringify([auditId, action, d])) },
  );
}
