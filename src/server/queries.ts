import {
  transaction,
  one,
  getRecord,
  requireRole,
  hasRole,
  must,
  uuid,
  type Actor,
  type Tx,
} from "./core";
async function sequential(queries: Array<() => Promise<{ rows: unknown[] }>>) {
  const out: { rows: unknown[] }[] = [];
  for (const query of queries) out.push(await query());
  return out;
}
const summaries = `SELECT r.*,s.code site_code,u.name created_by_name,
 coalesce(rv.status,dv.status,ca.status,ch.status,au.status,qu.status,an.status,eh.status,'Registered') status,
 coalesce(doc.number,'') number,coalesce(rv.version,dv.version,ca.version,ch.version,au.version,qu.version,an.version,eh.version,1) version
 FROM records r JOIN sites s ON s.id=r.site_id JOIN users u ON u.id=r.created_by
 LEFT JOIN documents doc ON doc.record_id=r.id
 LEFT JOIN LATERAL(SELECT status,version FROM revisions WHERE record_id=r.id ORDER BY number DESC LIMIT 1) rv ON true
 LEFT JOIN deviations dv ON dv.record_id=r.id LEFT JOIN capas ca ON ca.record_id=r.id LEFT JOIN changes ch ON ch.record_id=r.id LEFT JOIN audits au ON au.record_id=r.id LEFT JOIN questionnaires qu ON qu.record_id=r.id LEFT JOIN approved_answers an ON an.record_id=r.id LEFT JOIN ehs_records eh ON eh.record_id=r.id`;
export async function listRecords(actorId: string, search = "", kind = "") {
  return transaction(
    actorId,
    "Read.records",
    "Scoped read",
    async (db) =>
      (
        await db.query(
          `${summaries} WHERE NOT r.archived AND ($1='' OR r.title ILIKE '%'||$1||'%' OR doc.number ILIKE '%'||$1||'%') AND ($2='' OR r.kind=$2) ORDER BY r.created_at DESC LIMIT 500`,
          [search.slice(0, 200), kind],
        )
      ).rows,
  );
}
export async function overview(actorId: string) {
  return transaction(
    actorId,
    "Read.dashboard",
    "Scoped read",
    async (db, a) => {
      const [
        records,
        tasks,
        sites,
        projects,
        users,
        locations,
        notifications,
        roles,
        worker,
      ] = await sequential([
        () =>
          db.query(
            `${summaries} WHERE NOT r.archived ORDER BY r.created_at DESC LIMIT 500`,
          ),
        () =>
          db.query(
            "SELECT t.*,r.title record_title,r.kind record_kind,u.name assignee_name,u.active assignee_active FROM tasks t JOIN records r ON r.id=t.record_id JOIN users u ON u.id=t.assignee_id ORDER BY CASE WHEN status='Open' THEN 0 ELSE 1 END,due_at LIMIT 500",
          ),
        () =>
          db.query(
            "SELECT DISTINCT s.* FROM sites s JOIN access_scopes g ON g.site_id=s.id WHERE g.user_id=$1 AND (g.expires_at IS NULL OR g.expires_at>now())",
            [a.id],
          ),
        () =>
          db.query(
            "SELECT p.*,c.name customer_name FROM projects p LEFT JOIN customers c ON c.id=p.customer_id WHERE has_scope(actor_id(),p.site_id,p.customer_id,p.id,NULL)",
          ),
        () =>
          db.query(
            `SELECT DISTINCT u.id,u.name,u.email,u.active FROM users u JOIN access_scopes g ON g.user_id=u.id WHERE NOT u.system_account AND ($2::boolean OR EXISTS(SELECT 1 FROM access_scopes mine WHERE mine.user_id=$1 AND mine.site_id=g.site_id AND (mine.expires_at IS NULL OR mine.expires_at>now()))) ORDER BY u.name`,
            [a.id, hasRole(a, ["System Administrator"])],
          ),
        () => db.query("SELECT * FROM locations ORDER BY name"),
        () =>
          db.query(
            "SELECT * FROM notifications WHERE recipient_id=$1 ORDER BY created_at DESC LIMIT 30",
            [a.id],
          ),
        () =>
          db.query(
            "SELECT ur.user_id,ur.role,ur.site_id FROM user_roles ur WHERE EXISTS(SELECT 1 FROM access_scopes x JOIN access_scopes y ON x.site_id=y.site_id WHERE x.user_id=$1 AND y.user_id=ur.user_id)",
            [a.id],
          ),
        () =>
          hasRole(
            a,
            ["QA", "System Administrator"],
            a.roles.find((x) => x.role === "QA")?.site_id ?? undefined,
          )
            ? db.query(
                "SELECT * FROM worker_runs ORDER BY started_at DESC LIMIT 1",
              )
            : Promise.resolve({ rows: [] }),
      ]);
      return {
        actor: a,
        records: records.rows,
        tasks: tasks.rows,
        sites: sites.rows,
        projects: projects.rows,
        users: users.rows,
        locations: locations.rows,
        notifications: notifications.rows,
        userRoles: roles.rows,
        worker: worker.rows[0] ?? null,
        environment: process.env.APP_ENV ?? "development",
        integrations: {
          DocuSign: "Not connected",
          GoogleDrive: "Not connected",
          Labguru: "Not connected",
          Smartsheet: "Not connected",
          Email: "Not connected",
          "In-app reminders": "Server worker",
        },
      };
    },
  );
}
export async function detail(actorId: string, id: string) {
  return transaction(
    actorId,
    "Read.record",
    "Scoped record read",
    async (db) => {
      const record = await getRecord(db, id);
      const context = await one(
        db,
        "SELECT s.code site_code,s.name site_name,c.name customer_name,p.code project_code FROM records r JOIN sites s ON s.id=r.site_id LEFT JOIN customers c ON c.id=r.customer_id LEFT JOIN projects p ON p.id=r.project_id WHERE r.id=$1",
        [id],
      );
      const map: Record<string, string> = {
        Document: "documents",
        Deviation: "deviations",
        CAPA: "capas",
        Change: "changes",
        Audit: "audits",
        Questionnaire: "questionnaires",
        Answer: "approved_answers",
        Material: "materials",
        EHS: "ehs_records",
      };
      const table = map[record.kind];
      must(table, "Unknown record kind", 400);
      const data = await one(db, `SELECT * FROM ${table} WHERE record_id=$1`, [
        id,
      ]);
      const [attachments, tasks, audit, links] = await sequential([
        () =>
          db.query(
            "SELECT id,record_id,filename,sha256,size_bytes,created_at FROM attachments WHERE record_id=$1 ORDER BY created_at DESC",
            [id],
          ),
        () =>
          db.query(
            "SELECT t.*,u.name assignee_name,u.active assignee_active FROM tasks t JOIN users u ON u.id=t.assignee_id WHERE record_id=$1 ORDER BY created_at DESC",
            [id],
          ),
        () =>
          db.query(
            "SELECT e.id,e.entity,e.entity_id,e.actor_id,u.name actor_name,e.action,e.reason,e.before_data,e.after_data,e.occurred_at FROM audit_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.record_id=$1 ORDER BY e.id DESC LIMIT 200",
            [id],
          ),
        () =>
          db.query(
            "SELECT l.*,r.title related_title,r.kind related_kind FROM quality_links l JOIN records r ON r.id=CASE WHEN l.record_id=$1 THEN l.related_id ELSE l.record_id END WHERE l.record_id=$1 OR l.related_id=$1",
            [id],
          ),
      ]);
      const extra: Record<string, unknown> = {};
      if (record.kind === "Document") {
        extra.trainingRequirements = (
          await db.query(
            "SELECT * FROM training_requirements WHERE record_id=$1 ORDER BY role",
            [id],
          )
        ).rows;
        extra.revisions = (
          await db.query(
            "SELECT v.*,f.filename,f.sha256,w.version workflow_version,w.rules FROM revisions v LEFT JOIN attachments f ON f.id=v.file_id JOIN workflow_rules w ON w.id=v.workflow_id WHERE v.record_id=$1 ORDER BY v.number DESC",
            [id],
          )
        ).rows;
        extra.approvals = (
          await db.query(
            "SELECT p.*,u.name actor_name FROM approvals p JOIN users u ON u.id=p.actor_id WHERE record_id=$1 ORDER BY created_at DESC",
            [id],
          )
        ).rows;
        extra.training = (
          await db.query(
            "SELECT t.*,u.name trainee_name,c.name confirmer_name,v.number revision_number FROM training t JOIN users u ON u.id=t.user_id LEFT JOIN users c ON c.id=t.completed_by JOIN revisions v ON v.id=t.revision_id WHERE t.record_id=$1 ORDER BY v.number DESC,u.name",
            [id],
          )
        ).rows;
      } else if (record.kind === "Audit")
        extra.findings = (
          await db.query(
            "SELECT f.*,u.name owner_name FROM findings f JOIN users u ON u.id=f.owner_id WHERE record_id=$1 ORDER BY due_at",
            [id],
          )
        ).rows;
      else if (record.kind === "Questionnaire") {
        extra.questions = (
          await db.query(
            "SELECT * FROM questions WHERE record_id=$1 ORDER BY id",
            [id],
          )
        ).rows;
        extra.submissions = (
          await db.query(
            "SELECT * FROM questionnaire_submissions WHERE record_id=$1 ORDER BY created_at DESC",
            [id],
          )
        ).rows;
      } else if (record.kind === "Material") {
        extra.lots = (
          await db.query(
            "SELECT * FROM lots WHERE record_id=$1 ORDER BY lot_number",
            [id],
          )
        ).rows;
        extra.containers = (
          await db.query(
            "SELECT c.*,l.name location_name,b.lot_number,b.status lot_status FROM containers c JOIN locations l ON l.id=c.location_id JOIN lots b ON b.id=c.lot_id WHERE c.record_id=$1 ORDER BY c.label",
            [id],
          )
        ).rows;
        extra.transactions = (
          await db.query(
            "SELECT t.*,c.label container_label,u.name actor_name FROM inventory_transactions t JOIN containers c ON c.id=t.container_id JOIN users u ON u.id=t.actor_id WHERE t.record_id=$1 ORDER BY created_at DESC",
            [id],
          )
        ).rows;
        extra.uses = (
          await db.query(
            "SELECT m.*,p.code project_code FROM material_uses m JOIN projects p ON p.id=m.project_id WHERE m.record_id=$1",
            [id],
          )
        ).rows;
      }
      return {
        record: { ...record, ...context },
        data,
        attachments: attachments.rows,
        tasks: tasks.rows,
        audit: audit.rows,
        links: links.rows,
        ...extra,
      };
    },
  );
}
export async function auditLog(actorId: string) {
  return transaction(
    actorId,
    "Read.audit",
    "Scoped audit view",
    async (db, a) =>
      (
        await db.query(
          "SELECT e.id,e.record_id,e.entity,e.action,e.reason,e.occurred_at,u.name actor_name FROM audit_events e LEFT JOIN users u ON u.id=e.actor_id ORDER BY e.id DESC LIMIT 500",
        )
      ).rows,
  );
}
export async function adminState(actorId: string) {
  return transaction(
    actorId,
    "Read.admin",
    "Account and integration oversight",
    async (db, a) => {
      requireRole(a, ["System Administrator"]);
      return {
        users: (
          await db.query(
            "SELECT id,name,email,active FROM users WHERE NOT system_account ORDER BY name",
          )
        ).rows,
        roles: (await db.query("SELECT * FROM user_roles")).rows,
        scopes: (await db.query("SELECT * FROM access_scopes")).rows,
        failures: (
          await db.query(
            "SELECT id,task_id,status,attempts,last_error,next_attempt_at FROM notification_outbox WHERE status='Failed'",
          )
        ).rows,
      };
    },
  );
}

export async function exportRecords(actorId: string, search = "", kind = "") {
  return transaction(
    actorId,
    "Read.export",
    "Scoped export",
    async (db) =>
      (
        await db.query(
          `${summaries} WHERE NOT r.archived AND ($1='' OR r.title ILIKE '%'||$1||'%' OR doc.number ILIKE '%'||$1||'%') AND ($2='' OR r.kind=$2) ORDER BY r.created_at DESC`,
          [search.slice(0, 200), kind],
        )
      ).rows,
  );
}
