import { readFile, writeFile, access } from "node:fs/promises";
import { randomUUID, randomBytes } from "node:crypto";
import pg from "pg";
import { hashPassword, getPool, transaction, one } from "../src/server/core";
import { createDocument, documentAction } from "../src/server/documents";
import { upload } from "../src/server/files";
import { createQuality } from "../src/server/quality";
import { createMaterial, receiveLot } from "../src/server/inventory";
import { createQuestionnaire } from "../src/server/questionnaires";
export async function populate() {
  if (process.env.APP_ENV !== "development") return;
  if (
    (await getPool().query("SELECT count(*) n FROM records")).rows[0].n !== "0"
  )
    return;
  let seeded: Record<string, unknown>;
  try {
    seeded = JSON.parse(await readFile(".local/demo-credentials.json", "utf8"));
  } catch {
    return;
  }
  const s = seeded as {
    site: string;
    customer: string;
    project: string;
    location: string;
    users: Record<
      string,
      { id: string; email: string; password: string; name: string }
    >;
  };
  const ownerDb = new pg.Client({
    connectionString: process.env.MIGRATION_DATABASE_URL,
  });
  await ownerDb.connect();
  try {
    if (
      (await ownerDb.query("SELECT count(*) n FROM records")).rows[0].n !== "0"
    )
      return;
    if (!s.users.qa_reviewer) {
      const u = {
        id: randomUUID(),
        email: "qa_reviewer@example.test",
        password: randomBytes(18).toString("base64url"),
        name: "Morgan Lee",
      };
      await ownerDb.query(
        "INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4)",
        [u.id, u.email, u.name, hashPassword(u.password)],
      );
      for (const role of ["Employee", "QA", "Approver", "EHS Coordinator"])
        await ownerDb.query(
          "INSERT INTO user_roles(user_id,role,site_id) VALUES($1,$2,$3)",
          [u.id, role, s.site],
        );
      await ownerDb.query(
        "INSERT INTO access_scopes(user_id,site_id,reason) VALUES($1,$2,$3)",
        [u.id, s.site, "Synthetic development access"],
      );
      s.users.qa_reviewer = u;
      await writeFile(
        ".local/demo-credentials.json",
        JSON.stringify(s, null, 2),
        { mode: 0o600 },
      );
    }
  } finally {
    await ownerDb.end();
  }
  const who = (k: string) => s.users[k].id;
  const key = () => randomUUID();
  const site = { siteId: s.site };
  // A valid simple PDF is used only as clearly identified synthetic evidence.
  function pdf(title: string) {
    const lines = [
      "SYNTHETIC TRAINING DOCUMENT",
      title,
      "Development data only. Not a BBC-approved procedure.",
      "1. Record the activity using assigned responsibilities.",
      "2. Review evidence before making a quality decision.",
    ];
    const content = `BT /F1 13 Tf 50 750 Td ${lines.map((x, i) => `${i ? "0 -30 Td " : ""}(${x.replace(/[()\\]/g, "")}) Tj`).join("\n")} ET`;
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    ];
    let out = "%PDF-1.4\n";
    const offsets = [0];
    objects.forEach((ob, i) => {
      offsets.push(Buffer.byteLength(out));
      out += `${i + 1} 0 obj\n${ob}\nendobj\n`;
    });
    const xref = Buffer.byteLength(out);
    out += `xref\n0 6\n0000000000 65535 f \n${offsets
      .slice(1)
      .map((n) => String(n).padStart(10, "0") + " 00000 n ")
      .join(
        "\n",
      )}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return new File([out], title.replace(/[^A-Za-z0-9]/g, "_") + ".pdf", {
      type: "application/pdf",
    });
  }
  const titles = [
    ["SYN-SOP-001", "Document control and revision management", "None"],
    ["SYN-SOP-002", "Test article receipt and storage", "Read acknowledgement"],
    [
      "SYN-SOP-003",
      "Deviation reporting and initial assessment",
      "Read acknowledgement",
    ],
    ["SYN-WI-004", "Laboratory handover checklist", "Competency"],
  ];
  for (let i = 0; i < titles.length; i++) {
    const [number, title, trainingMode] = titles[i];
    const doc = await createDocument(
      who("owner"),
      {
        ...site,
        number,
        title,
        department: i === 1 ? "Operations" : "Quality Assurance",
        documentType: i === 3 ? "Work instruction" : "SOP",
        changeReason: "Synthetic first issue for development evaluation",
        trainingMode,
        trainingBeforeEffective: true,
        reviewDue: "2027-11-01",
      },
      key(),
    );
    await upload(who("owner"), doc.id, pdf(title), doc.revisionId, 1);
    const act = async (user: string, action: string, extra: object = {}) => {
      const v = await transaction(
        who("owner"),
        "Read.seed",
        "Synthetic setup",
        (db) =>
          one<{ version: number }>(
            db,
            "SELECT version FROM revisions WHERE id=$1",
            [doc.revisionId],
          ),
      );
      return documentAction(
        who(user),
        doc.revisionId,
        action,
        {
          version: v.version,
          reason: "Synthetic workflow setup; not a formal quality record",
          ...extra,
        },
        key(),
      );
    };
    if (i < 3) {
      await act("owner", "submit", {
        reviewerId: who("reviewer"),
        approverId: who("approver"),
        traineeIds: i === 0 ? [] : [who("owner"), who("employee")],
        dueAt: "2026-11-10T17:00:00Z",
      });
      if (i < 2) {
        await act("reviewer", "review");
        await act("approver", "approve");
        if (i === 0) await act("qa", "activate");
      }
    }
  }
  await createQuality(
    who("qa"),
    "Deviation",
    {
      ...site,
      title: "Sample receipt documentation discrepancy",
      description: "Synthetic receipt lacked a second check entry.",
      occurredOn: "2026-11-03",
      reportedOn: "2026-11-03",
      risk: "Low",
      ownerId: who("qa"),
      impact: "Synthetic documentation review; no real material affected.",
      containment: "Synthetic record placed on hold for reconciliation.",
    },
    key(),
  );
  await createQuality(
    who("qa"),
    "CAPA",
    {
      ...site,
      title: "Strengthen receipt verification",
      plan: "Evaluate an independent receipt verification step using synthetic examples.",
      ownerId: who("qa"),
      dueAt: "2026-11-19T17:00:00Z",
      effectivenessRequired: true,
      effectivenessPlan: "Review three consecutive synthetic receipts.",
    },
    key(),
  );
  await createQuality(
    who("qa"),
    "Audit",
    {
      ...site,
      title: "Internal document control review",
      auditType: "Internal",
      scope: "Synthetic SOP, training and evidence records.",
      target: "Waltham development workspace",
      plannedOn: "2026-11-17",
      ownerId: who("qa"),
    },
    key(),
  );
  await createQuestionnaire(
    who("qa"),
    {
      ...site,
      title: "Synthetic client qualification questionnaire",
      ownerId: who("qa"),
    },
    key(),
  );
  const mat = await createMaterial(
    who("qa"),
    {
      ...site,
      customerId: s.customer,
      projectId: s.project,
      title: "Reference antibody · SYN-AB01",
      materialType: "Antibody",
      ownership: "Client",
      supplier: "Synthetic supplier",
      catalog: "SYN-AB01",
      clone: "Synthetic clone A",
      storageRequirements: "-80 °C (synthetic requirement)",
      useRole: "TA",
      usageRestrictions: "Development testing only. No actual stock.",
    },
    key(),
  );
  await receiveLot(
    who("qa"),
    mat.id,
    {
      lotNumber: "SYN-2026-01",
      expiresOn: "2027-10-31",
      quantity: "10",
      unit: "mL",
      locationId: s.location,
      containerLabel: "SYN-AB01-C01",
      concentration: "1 mg/mL (synthetic)",
      reason: "Synthetic receipt for platform evaluation",
    },
    key(),
  );
  await createQuality(
    who("qa"),
    "EHS",
    {
      ...site,
      title: "Quarterly inspection planning",
      category: "Inspection",
      description:
        "Synthetic task for testing inspection ownership and evidence.",
      ownerId: who("qa"),
      dueAt: "2026-11-20T17:00:00Z",
    },
    key(),
  );
  console.log(
    "Created synthetic development records with real workflow transitions.",
  );
}
