import type { Overview, Field, DialogConfig, Detail, Revision } from "./types";
const opt = (values: string[]) => values.map((x) => ({ value: x, label: x }));
export const reasonField: Field = {
  name: "reason",
  label: "Reason / decision",
  type: "textarea",
  required: true,
  hint: "At least 5 characters. This is retained in the audit history.",
};
export const evidenceField = (d: Detail): Field => ({
  name: "evidenceId",
  label: "Evidence attachment",
  type: "select",
  options: d.attachments.map((x) => ({ value: x.id, label: x.filename })),
  required: true,
});
export function createForm(kind: string, o: Overview): DialogConfig {
  const site = o.sites[0]?.id ?? "";
  const owners = o.users
    .filter((u) => u.active)
    .map((u) => ({ value: u.id, label: u.name }));
  const scope: Field[] = [
    { name: "title", label: "Title", required: true },
    {
      name: "siteId",
      label: "Applicable site",
      type: "select",
      options: o.sites.map((s) => ({ value: s.id, label: s.name })),
      value: site,
      required: true,
    },
    {
      name: "projectId",
      label: "Project scope",
      type: "select",
      options: [
        { value: "", label: "Site-wide · no project" },
        ...o.projects.map((p) => ({
          value: p.id,
          label: `${p.code} · ${p.title}`,
        })),
      ],
    },
  ];
  const owner: Field = {
    name: "ownerId",
    label: "Responsible owner",
    type: "select",
    options: owners,
    value: o.actor.id,
    required: true,
  };
  const due: Field = {
    name: "dueAt",
    label: "Due date",
    type: "datetime-local",
    required: true,
  };
  const desc: Field = {
    name: "description",
    label: "Description",
    type: "textarea",
    required: true,
  };
  let fields: Field[] = [];
  let endpoint = "";
  if (kind === "Document") {
    endpoint = "/api/documents";
    fields = [
      {
        name: "number",
        label: "Document number",
        value: "SOP-",
        required: true,
      },
      ...scope,
      {
        name: "department",
        label: "Department",
        value: "Quality Assurance",
        required: true,
      },
      {
        name: "documentType",
        label: "Document type",
        type: "select",
        options: opt(["SOP", "Policy", "Form", "Work instruction"]),
        value: "SOP",
      },
      {
        name: "changeReason",
        label: "Change reason",
        type: "textarea",
        required: true,
      },
      {
        name: "trainingMode",
        label: "Required training",
        type: "select",
        options: opt([
          "Read acknowledgement",
          "Instructor led",
          "Competency",
          "None",
        ]),
        value: "Read acknowledgement",
      },
      {
        name: "trainingBeforeEffective",
        label: "Complete required training before effectiveness",
        type: "checkbox",
        value: true,
      },
      {
        name: "reviewDue",
        label: "Periodic review due",
        type: "date",
        required: true,
      },
      {
        name: "effectiveAfter",
        label: "Earliest effective date (optional)",
        type: "datetime-local",
      },
    ];
  } else if (kind === "Deviation") {
    endpoint = "/api/deviations";
    fields = [
      ...scope,
      desc,
      {
        name: "occurredOn",
        label: "Occurred on",
        type: "date",
        required: true,
      },
      {
        name: "reportedOn",
        label: "Reported on",
        type: "date",
        required: true,
      },
      {
        name: "risk",
        label: "Risk (sample classification)",
        type: "select",
        options: opt(["Low", "Medium", "High"]),
        value: "Low",
      },
      owner,
      {
        name: "impact",
        label: "Initial impact assessment",
        type: "textarea",
        required: true,
      },
      {
        name: "containment",
        label: "Immediate containment",
        type: "textarea",
        required: true,
      },
    ];
  } else if (kind === "CAPA") {
    endpoint = "/api/capas";
    fields = [
      ...scope,
      owner,
      { name: "plan", label: "Action plan", type: "textarea", required: true },
      due,
      {
        name: "effectivenessRequired",
        label: "Require an effectiveness check",
        type: "checkbox",
        value: true,
      },
      {
        name: "effectivenessPlan",
        label: "Effectiveness plan",
        type: "textarea",
      },
      {
        name: "sourceIds",
        label: "Related source records",
        type: "multiselect",
        options: o.records
          .filter((r) => ["Deviation", "Audit"].includes(r.kind))
          .map((r) => ({ value: r.id, label: r.title })),
      },
    ];
  } else if (kind === "Change") {
    endpoint = "/api/changes";
    fields = [
      ...scope,
      desc,
      owner,
      {
        name: "impact",
        label: "Impact assessment",
        type: "textarea",
        required: true,
      },
      {
        name: "implementationPlan",
        label: "Implementation plan",
        type: "textarea",
        required: true,
      },
    ];
  } else if (kind === "Audit") {
    endpoint = "/api/audits";
    fields = [
      ...scope,
      {
        name: "auditType",
        label: "Audit type",
        type: "select",
        options: opt(["Customer", "Supplier", "Internal"]),
        value: "Internal",
      },
      owner,
      { name: "target", label: "Audit object / organization", required: true },
      { name: "scope", label: "Audit scope", type: "textarea", required: true },
      {
        name: "plannedOn",
        label: "Planned date",
        type: "date",
        required: true,
      },
    ];
  } else if (kind === "EHS") {
    endpoint = "/api/ehs";
    fields = [
      ...scope,
      {
        name: "category",
        label: "Category",
        type: "select",
        options: opt([
          "Risk assessment",
          "Material introduction",
          "Permit",
          "Inspection",
          "Incident",
        ]),
        value: "Risk assessment",
      },
      desc,
      owner,
      due,
    ];
  } else if (kind === "Questionnaire") {
    endpoint = "/api/questionnaires";
    fields = [...scope, owner];
  } else if (kind === "Answer") {
    endpoint = "/api/answers";
    fields = [
      ...scope,
      { name: "topic", label: "Question / topic", required: true },
      {
        name: "answer",
        label: "Proposed answer",
        type: "textarea",
        value: "Pending confirmation",
        required: true,
      },
      { name: "businessScope", label: "Business scope", required: true },
      {
        name: "limitations",
        label: "Applicability and limitations",
        type: "textarea",
        required: true,
      },
      { name: "validUntil", label: "Review by", type: "date", required: true },
      {
        name: "status",
        label: "Initial status",
        type: "select",
        options: opt(["Draft", "Cannot answer", "Pending confirmation"]),
        value: "Draft",
      },
    ];
  } else if (kind === "Material") {
    endpoint = "/api/materials";
    fields = [
      ...scope,
      {
        name: "materialType",
        label: "Material type",
        type: "select",
        options: opt(["Chemical", "Cell", "Antibody", "Biological", "Other"]),
        value: "Biological",
      },
      {
        name: "ownership",
        label: "Ownership",
        type: "select",
        options: opt(["BBC", "Client", "Third party"]),
        value: "Client",
      },
      { name: "supplier", label: "Supplier / source", required: true },
      { name: "catalog", label: "Catalog number" },
      {
        name: "storageRequirements",
        label: "Storage requirements",
        required: true,
      },
      {
        name: "useRole",
        label: "Project use identity",
        type: "select",
        options: [
          { value: "", label: "No project use assigned" },
          ...opt(["TA", "Reference", "Reagent", "Other"]),
        ],
      },
      { name: "cellIdentity", label: "Cell identity (if applicable)" },
      { name: "clone", label: "Antibody clone (if applicable)" },
      { name: "label", label: "Antibody label (if applicable)" },
      {
        name: "usageRestrictions",
        label: "Use restrictions",
        type: "textarea",
      },
    ];
  }
  return {
    title: `New ${kind.toLowerCase()}`,
    description:
      "Creates a scoped business record. Required approvals are performed separately.",
    endpoint,
    fields,
  };
}
export function revisionForm(d: Detail): DialogConfig {
  const v = d.revisions![0];
  return {
    title: "Create next revision",
    description:
      "Historical approvals, files and training remain linked to the previous revision.",
    endpoint: `/api/documents/${d.record.id}/revise`,
    fields: [
      {
        name: "title",
        label: "Revision title",
        value: v.title,
        required: true,
      },
      {
        name: "changeReason",
        label: "Change reason",
        type: "textarea",
        required: true,
      },
      {
        name: "trainingMode",
        label: "Training method",
        type: "select",
        options: opt([
          "Read acknowledgement",
          "Instructor led",
          "Competency",
          "None",
        ]),
        value: v.training_mode,
      },
      {
        name: "trainingBeforeEffective",
        label: "Complete training before effectiveness",
        type: "checkbox",
        value: v.training_before_effective,
      },
      {
        name: "reviewDue",
        label: "Periodic review due",
        type: "date",
        required: true,
      },
    ],
  };
}
export function documentForm(
  d: Detail,
  v: Revision,
  action: string,
  o: Overview,
): DialogConfig {
  const fields: Field[] = [reasonField];
  if (action === "submit") {
    const eligible = (roles: string[]) =>
      o.users
        .filter(
          (u) =>
            u.active &&
            o.userRoles.some(
              (g) =>
                g.user_id === u.id &&
                roles.includes(g.role) &&
                (!g.site_id || g.site_id === d.record.site_id),
            ),
        )
        .map((u) => ({ value: u.id, label: u.name }));
    fields.unshift(
      {
        name: "reviewerId",
        label: "Independent reviewer",
        type: "select",
        options: eligible(["Reviewer", "QA"]),
        required: true,
      },
      {
        name: "approverId",
        label: "Independent approver",
        type: "select",
        options: eligible(["Approver"]),
        required: true,
      },
      {
        name: "traineeIds",
        label: "Training audience",
        type: "multiselect",
        options: o.users
          .filter((u) => u.active)
          .map((u) => ({ value: u.id, label: u.name })),
        hint: "Assignment requires existing access. No access is granted by this action.",
      },
      {
        name: "dueAt",
        label: "Review due",
        type: "datetime-local",
        required: true,
      },
    );
  }
  return {
    title: (
      {
        submit: "Submit for review",
        review: "Record independent review",
        approve: "Approve fixed revision",
        activate: "Make revision effective",
        return: "Return for revision",
        obsolete: "Withdraw revision",
      } as Record<string, string>
    )[action],
    description:
      "The server checks current state, permissions, independence and required evidence.",
    endpoint: `/api/revisions/${v.id}/${action}`,
    base: { version: v.version },
    fields,
  };
}
