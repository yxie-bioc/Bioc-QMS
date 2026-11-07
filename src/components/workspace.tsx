"use client";
import {
  useEffect,
  useState,
  useCallback,
  useRef,
  type FormEvent,
} from "react";
import {
  LayoutDashboard,
  FileText,
  GraduationCap,
  ClipboardCheck,
  ShieldCheck,
  Layers,
  FlaskConical,
  Leaf,
  Search,
  Plus,
  ArrowUpRight,
  ChevronRight,
  ChevronLeft,
  CheckCircle2,
  Clock3,
  Bell,
  LogOut,
  Settings2,
  History,
  Download,
  Upload,
  FolderOpen,
  X,
  ArrowRight,
  Activity,
  AlertCircle,
  BookOpen,
  Users,
  RefreshCw,
} from "lucide-react";
import type {
  Overview,
  Detail,
  DialogConfig,
  Field,
  Task,
  Revision,
  RecordItem,
  Container,
  AuditEvent,
} from "./types";
import {
  createForm,
  documentForm,
  revisionForm,
  reasonField,
  evidenceField,
} from "./forms";
const nav = [
  { id: "Overview", icon: LayoutDashboard, label: "Overview" },
  { id: "Tasks", icon: ClipboardCheck, label: "My tasks" },
  { id: "Document", icon: FileText, label: "Document control" },
  { id: "Training", icon: GraduationCap, label: "Training" },
  { id: "Quality", icon: ShieldCheck, label: "Quality events" },
  { id: "Questionnaire", icon: BookOpen, label: "Questionnaires" },
  { id: "Material", icon: FlaskConical, label: "Inventory" },
  { id: "EHS", icon: Leaf, label: "EHS" },
  { id: "Audit log", icon: History, label: "Audit history" },
  { id: "Settings", icon: Settings2, label: "Administration" },
];
const qKinds = ["Deviation", "CAPA", "Change", "Audit"];
const date = (s: string | null | undefined) =>
  s
    ? new Date(s).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "—";
const fmt = (s: string) =>
  s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const options = (values: string[]) =>
  values.map((x) => ({ value: x, label: x }));
function Badge({ value }: { value: string }) {
  const cls = [
    "Effective",
    "Complete",
    "Closed",
    "Released",
    "Approved",
    "Effectiveness Complete",
  ].includes(value)
    ? "good"
    : [
          "On Hold",
          "In Review",
          "Investigation",
          "Needs Review",
          "Failed",
          "Overdue",
        ].includes(value)
      ? "warn"
      : value === "Cancelled" || value === "Obsolete"
        ? "muted"
        : "neutral";
  return (
    <span className={`badge ${cls}`}>
      <i />
      {value}
    </span>
  );
}
async function api<T>(url: string, body?: unknown, requestKey?: string) {
  const res = await fetch(
    url,
    body === undefined
      ? { cache: "no-store" }
      : {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": requestKey ?? crypto.randomUUID(),
          },
          body: JSON.stringify(body),
        },
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Request failed");
  return data as T;
}
export default function Workspace() {
  const [o, setO] = useState<Overview | null>(null),
    [loading, setLoading] = useState(true),
    [page, setPage] = useState("Overview"),
    [detail, setDetail] = useState<Detail | null>(null),
    [dialog, setDialog] = useState<DialogConfig | null>(null),
    [error, setError] = useState(""),
    [toast, setToast] = useState(""),
    [search, setSearch] = useState(""),
    [filter, setFilter] = useState("All"),
    [audit, setAudit] = useState<AuditEvent[]>([]),
    [notify, setNotify] = useState(false),
    [admin, setAdmin] = useState<{
      users: Overview["users"];
      roles: Overview["userRoles"];
      scopes: {
        id: string;
        user_id: string;
        site_id: string;
        reason: string;
      }[];
      failures: {
        id: string;
        status: string;
        attempts: number;
        last_error: string;
      }[];
    } | null>(null);
  const refresh = useCallback(async () => {
    try {
      const data = await api<Overview>("/api/overview");
      setO(data);
      setError("");
    } catch (e) {
      setO(null);
      if (e instanceof Error && !/Sign in|Session/.test(e.message))
        setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(""), 5000);
      return () => clearTimeout(t);
    }
  }, [toast]);
  async function openRecord(id: string) {
    setError("");
    try {
      setDetail(await api<Detail>(`/api/records/${id}`));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function navigate(id: string) {
    setPage(id);
    setDetail(null);
    setFilter("All");
    setSearch("");
    setError("");
    if (id === "Audit log")
      try {
        setAudit(await api<AuditEvent[]>("/api/audit"));
      } catch (e) {
        setError((e as Error).message);
      }
    if (
      id === "Settings" &&
      o?.actor.roles.some((r) => r.role === "System Administrator")
    )
      try {
        setAdmin(await api("/api/admin"));
      } catch (e) {
        setError((e as Error).message);
      }
  }
  async function done(result?: { id?: string }) {
    setDialog(null);
    setToast("Saved. Business record and audit history updated.");
    await refresh();
    if (detail) await openRecord(detail.record.id);
    else if (result?.id && page !== "Settings") await openRecord(result.id);
    if (page === "Settings") await navigate("Settings");
  }
  if (loading)
    return (
      <div className="loading">
        <div className="brand-mark">B</div>
        <p>Opening your workspace…</p>
      </div>
    );
  if (!o) return <Login onLogin={refresh} externalError={error} />;
  const can = (...roles: string[]) =>
    o.actor.roles.some(
      (r) =>
        roles.includes(r.role) &&
        (!r.site_id || !detail || r.site_id === detail.record.site_id),
    );
  const mine = o.tasks.filter(
    (t) => t.assignee_id === o.actor.id && t.status === "Open",
  );
  const overdue = mine.filter((t) => new Date(t.due_at) < new Date());
  const selected = detail?.record.kind ?? page;
  const visible = o.records.filter((r) => {
    const match =
      page === "Quality"
        ? qKinds.includes(r.kind)
        : page === "Questionnaire"
          ? ["Questionnaire", "Answer"].includes(r.kind)
          : r.kind === page;
    return (
      match &&
      (filter === "All" || r.kind === filter || r.status === filter) &&
      `${r.title} ${r.number}`.toLowerCase().includes(search.toLowerCase())
    );
  });
  const ownerFields: Field[] = [
    {
      name: "assigneeId",
      label: "New responsible person",
      type: "select",
      options: o.users
        .filter((u) => u.active)
        .map((u) => ({ value: u.id, label: u.name })),
      required: true,
    },
  ];
  const taskDialog = (t: Task, action: string) => {
    if (action === "complete") {
      void api<Detail>(`/api/records/${t.record_id}`)
        .then((record) =>
          setDialog({
            title: "Complete task",
            endpoint: `/api/tasks/${t.id}/complete`,
            base: { version: t.version },
            fields: [
              { ...evidenceField(record), required: t.requires_evidence },
              reasonField,
            ],
          }),
        )
        .catch((e) => setError((e as Error).message));
      return;
    }
    setDialog({
      title:
        action === "reassign"
          ? "Reassign task"
          : action === "extend"
            ? "Extend task deadline"
            : "Complete task",
      endpoint: `/api/tasks/${t.id}/${action}`,
      base: { version: t.version },
      fields: [
        ...(action === "reassign"
          ? ownerFields
          : action === "extend"
            ? [
                {
                  name: "dueAt",
                  label: "New due date",
                  type: "datetime-local",
                  required: true,
                } as Field,
              ]
            : []),
        reasonField,
      ],
    });
  };
  const newKind =
    page === "Quality"
      ? "Deviation"
      : page === "Questionnaire"
        ? "Questionnaire"
        : page;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            B<span />
          </div>
          <div>
            <b>BIOCYTOGEN</b>
            <small>Quality & Operations</small>
          </div>
        </div>
        <div className="workspace-switch">
          <span className="site-dot" />
          <div>
            <strong>
              {o.sites.length === 1
                ? `${o.sites[0].name} workspace`
                : "Authorized sites"}
            </strong>
            <small>Internal operations</small>
          </div>
          <ChevronRight size={15} />
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav>
          {nav.map((n) => (
            <button
              key={n.id}
              className={page === n.id ? "nav-item active" : "nav-item"}
              onClick={() => void navigate(n.id)}
            >
              <n.icon size={18} />
              <span>{n.label}</span>
              {n.id === "Tasks" && mine.length > 0 && <em>{mine.length}</em>}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="secure-note">
            <ShieldCheck size={17} />
            <span>
              Controlled access
              <br />
              <small>Site and role scoped</small>
            </span>
          </div>
          <button
            className="user-card"
            onClick={() => void navigate("Settings")}
          >
            <span className="avatar">
              {o.actor.name
                .split(" ")
                .map((x) => x[0])
                .slice(0, 2)
                .join("")}
            </span>
            <span>
              <strong>{o.actor.name}</strong>
              <small>{o.actor.roles[0]?.role ?? "Employee"}</small>
            </span>
            <Settings2 size={16} />
          </button>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div className="breadcrumb">
            Workspace <ChevronRight size={13} />
            <strong>
              {detail
                ? detail.record.kind
                : nav.find((n) => n.id === page)?.label}
            </strong>
            {detail && (
              <>
                <ChevronRight size={13} />
                <span>{detail.record.title.slice(0, 40)}</span>
              </>
            )}
          </div>
          <div className="top-actions">
            <span className="env-badge">
              {o.environment === "production"
                ? "Internal workspace"
                : "Development · Synthetic data"}
            </span>
            <button
              className="icon-btn"
              aria-label="Notifications"
              onClick={() => setNotify(!notify)}
            >
              <Bell size={19} />
              {o.notifications.length > 0 && <i className="unread-dot" />}
            </button>
            <button
              className="icon-btn"
              title="Sign out"
              aria-label="Sign out"
              onClick={async () => {
                await api("/api/auth/logout", {});
                setDetail(null);
                setO(null);
              }}
            >
              <LogOut size={18} />
            </button>
          </div>
        </header>
        {notify && (
          <div className="notification-popover">
            <h3>Notifications</h3>
            {o.notifications.length ? (
              o.notifications.map((n) => (
                <button
                  key={n.id}
                  onClick={() => {
                    setNotify(false);
                    void openRecord(n.record_id);
                  }}
                >
                  {n.message}
                  <ArrowUpRight size={14} />
                </button>
              ))
            ) : (
              <p>
                No notifications yet. Reminders are delivered by the server
                worker.
              </p>
            )}
          </div>
        )}
        <div className="content">
          {error && (
            <div role="alert" className="error">
              <AlertCircle size={18} />
              {error}
              <button onClick={() => setError("")} aria-label="Dismiss error">
                <X size={16} />
              </button>
            </div>
          )}
          {detail ? (
            <RecordDetail
              d={detail}
              o={o}
              can={can}
              onBack={() => setDetail(null)}
              onDialog={setDialog}
              onRefresh={() => void openRecord(detail.record.id)}
              onError={setError}
              onTask={taskDialog}
            />
          ) : page === "Overview" ? (
            <>
              <div className="page-head">
                <div>
                  <div className="eyebrow">YOUR WORKSPACE AT A GLANCE</div>
                  <h1>Quality in focus.</h1>
                  <p>
                    Keep controlled documents, decisions and daily work moving.
                  </p>
                </div>
                <div className="head-date">
                  <Clock3 size={16} />
                  {new Date().toLocaleDateString("en-US", {
                    weekday: "long",
                    month: "short",
                    day: "numeric",
                  })}
                </div>
              </div>
              <div className="metrics">
                {[
                  {
                    label: "Your open tasks",
                    value: mine.length,
                    caption: "Assigned to you",
                    icon: ClipboardCheck,
                    click: "Tasks",
                  },
                  {
                    label: "Controlled documents",
                    value: o.records.filter((r) => r.kind === "Document")
                      .length,
                    caption: `${o.records.filter((r) => r.kind === "Document" && r.status === "Effective").length} effective revisions`,
                    icon: FileText,
                    click: "Document",
                  },
                  {
                    label: "Quality events",
                    value: o.records.filter(
                      (r) => qKinds.includes(r.kind) && r.status !== "Closed",
                    ).length,
                    caption: "Active across your scope",
                    icon: Activity,
                    click: "Quality",
                  },
                  {
                    label: "Overdue tasks",
                    value: overdue.length,
                    caption: overdue.length
                      ? "Your attention is needed"
                      : "You are up to date",
                    icon: Clock3,
                    click: "Tasks",
                  },
                ].map((m, i) => (
                  <button
                    className={`metric metric-${i}`}
                    key={m.label}
                    onClick={() => void navigate(m.click)}
                  >
                    <div>
                      <span>{m.label}</span>
                      <m.icon size={18} />
                    </div>
                    <strong>{String(m.value).padStart(2, "0")}</strong>
                    <small>
                      {m.caption}
                      <ArrowUpRight size={14} />
                    </small>
                  </button>
                ))}
              </div>
              <div className="dashboard-grid">
                <section className="panel priority">
                  <div className="panel-head">
                    <div>
                      <h2>
                        On your desk{" "}
                        <span className="count">{mine.length}</span>
                      </h2>
                      <p>Your next reviews, approvals and follow-ups</p>
                    </div>
                    <button
                      className="text-btn"
                      onClick={() => void navigate("Tasks")}
                    >
                      View all <ArrowRight size={15} />
                    </button>
                  </div>
                  {mine.length ? (
                    <div className="desk-list">
                      {mine.slice(0, 5).map((t) => (
                        <button
                          key={t.id}
                          className="desk-task"
                          onClick={() => void openRecord(t.record_id)}
                        >
                          <div
                            className={`task-symbol ${t.kind === "Training" ? "blue" : ""}`}
                          >
                            {t.kind === "Training" ? (
                              <GraduationCap size={19} />
                            ) : (
                              <FileText size={19} />
                            )}
                          </div>
                          <div>
                            <strong>{t.title}</strong>
                            <small>
                              {t.kind} <span>·</span> Due {date(t.due_at)}
                            </small>
                          </div>
                          <Badge
                            value={
                              new Date(t.due_at) < new Date()
                                ? "Overdue"
                                : "Open"
                            }
                          />
                          <ChevronRight size={17} />
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="empty small">
                      <CheckCircle2 size={30} />
                      <h3>Your queue is clear</h3>
                      <p>Assigned work will appear here.</p>
                    </div>
                  )}
                </section>
                <section className="focus-card">
                  <div className="focus-icon">
                    <Layers size={24} />
                  </div>
                  <div className="eyebrow">DOCUMENT CONTROL</div>
                  <h2>
                    One revision.
                    <br />A complete history.
                  </h2>
                  <p>
                    Review, approve and train against the exact document people
                    will use.
                  </p>
                  <button onClick={() => void navigate("Document")}>
                    Open document register <ArrowUpRight size={17} />
                  </button>
                  <div className="focus-line">
                    <span />
                    <span />
                    <span />
                    <span />
                  </div>
                  <small>Draft → Review → Approve → Effective</small>
                </section>
              </div>
              <section className="panel">
                <div className="panel-head">
                  <div>
                    <h2>Recent records</h2>
                    <p>Visible within your authorized site and project scope</p>
                  </div>
                  <span className="subtle-label">
                    {o.records.length} RECORDS
                  </span>
                </div>
                <RecordsTable
                  rows={o.records.slice(0, 7)}
                  onOpen={openRecord}
                />
              </section>
              <div className="workspace-note">
                <ShieldCheck size={17} />
                <span>
                  Sample workflow configuration · Internal approvals · External
                  integrations are not connected
                </span>
                <span className="worker-state">
                  <i />
                  {o.worker
                    ? `Worker last ran ${new Date(o.worker.finished_at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}`
                    : "Worker has not reported yet"}
                </span>
              </div>
            </>
          ) : [
              "Document",
              "Quality",
              "Questionnaire",
              "Material",
              "EHS",
            ].includes(page) ? (
            <>
              <div className="page-head">
                <div>
                  <div className="eyebrow">
                    {page === "Material"
                      ? "LABORATORY OPERATIONS"
                      : "CONTROLLED WORKSPACE"}
                  </div>
                  <h1>{nav.find((n) => n.id === page)?.label}</h1>
                  <p>
                    {page === "Document"
                      ? "Controlled revisions, independent decisions and training evidence."
                      : page === "Material"
                        ? "Materials, lots, containers and a traceable quantity ledger."
                        : page === "Questionnaire"
                          ? "Site-specific answers, supporting evidence and fixed submissions."
                          : "Track ownership, evidence and authorized closure."}
                  </p>
                </div>
                <div className="button-row">
                  <a
                    className="btn secondary"
                    href={`/api/export?kind=${page === "Quality" ? "" : page}`}
                  >
                    <Download size={16} />
                    Export
                  </a>
                  {can(
                    "QA",
                    "Document Owner",
                    "Inventory Custodian",
                    "EHS Coordinator",
                    "Investigator",
                  ) && (
                    <button
                      className="btn"
                      onClick={() => setDialog(createForm(newKind, o))}
                    >
                      <Plus size={17} />
                      New {newKind.toLowerCase()}
                    </button>
                  )}
                </div>
              </div>
              {(page === "Quality" || page === "Questionnaire") && (
                <div className="module-tabs">
                  {(page === "Quality"
                    ? ["All", ...qKinds]
                    : ["All", "Questionnaire", "Answer"]
                  ).map((t) => (
                    <button
                      className={filter === t ? "selected" : ""}
                      key={t}
                      onClick={() => setFilter(t)}
                    >
                      {t}
                    </button>
                  ))}
                  {can("QA") && (
                    <div className="new-shortcuts">
                      {(page === "Quality"
                        ? ["CAPA", "Change", "Audit"]
                        : ["Answer"]
                      ).map((k) => (
                        <button
                          key={k}
                          onClick={() => setDialog(createForm(k, o))}
                        >
                          <Plus size={13} />
                          {k}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <section className="panel">
                <div className="table-toolbar">
                  <label className="search">
                    <Search size={17} />
                    <input
                      placeholder="Search visible records…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </label>
                  <span>{visible.length} records</span>
                </div>
                <RecordsTable rows={visible} onOpen={openRecord} />
              </section>
            </>
          ) : page === "Tasks" || page === "Training" ? (
            <>
              <div className="page-head">
                <div>
                  <div className="eyebrow">ACCOUNTABILITY & FOLLOW-THROUGH</div>
                  <h1>
                    {page === "Training" ? "Training assignments" : "My tasks"}
                  </h1>
                  <p>
                    {page === "Training"
                      ? "Reading acknowledgement and competency confirmation remain distinct."
                      : "Ownership does not grant access or approval authority."}
                  </p>
                </div>
                <button
                  className="btn secondary"
                  onClick={() => void refresh()}
                >
                  <RefreshCw size={16} />
                  Refresh
                </button>
              </div>
              <div className="module-tabs">
                {["Mine", "All accessible", "Completed"].map((t) => (
                  <button
                    key={t}
                    className={
                      (filter === "All" ? "Mine" : filter) === t
                        ? "selected"
                        : ""
                    }
                    onClick={() => setFilter(t)}
                  >
                    {t}
                  </button>
                ))}
              </div>
              <section className="panel">
                <TaskTable
                  tasks={o.tasks.filter(
                    (t) =>
                      (page !== "Training" || t.kind === "Training") &&
                      (filter === "Completed"
                        ? t.status === "Complete"
                        : t.status === "Open") &&
                      (filter === "All accessible" ||
                        filter === "Completed" ||
                        t.assignee_id === o.actor.id),
                  )}
                  onOpen={openRecord}
                  onAction={taskDialog}
                  canManage={can("QA", "System Administrator")}
                />
              </section>
            </>
          ) : page === "Audit log" ? (
            <>
              <div className="page-head">
                <div>
                  <div className="eyebrow">SERVER-RECORDED HISTORY</div>
                  <h1>Audit history</h1>
                  <p>
                    Changes retain the actual actor, server time and reason.
                  </p>
                </div>
              </div>
              <section className="panel">
                <AuditTrail events={audit} />
              </section>
            </>
          ) : (
            <>
              <div className="page-head">
                <div>
                  <div className="eyebrow">WORKSPACE ADMINISTRATION</div>
                  <h1>Access & connections</h1>
                  <p>
                    Technical administration and business approval are separate
                    grants.
                  </p>
                </div>
              </div>
              <section className="panel settings-panel">
                <h2>Signed in as {o.actor.name}</h2>
                <p>{o.actor.email}</p>
                <div className="chips">
                  {o.actor.roles.map((r, i) => (
                    <span className="chip" key={i}>
                      {r.role}
                    </span>
                  ))}
                </div>
              </section>
              <section className="panel settings-panel">
                <h2>Integration status</h2>
                <div className="integration-grid">
                  {Object.entries(o.integrations).map(([k, v]) => (
                    <div key={k}>
                      <strong>{k}</strong>
                      <Badge value={v} />
                    </div>
                  ))}
                </div>
              </section>
              {admin && (
                <section className="panel">
                  <div className="panel-head">
                    <div>
                      <h2>People & permissions</h2>
                      <p>
                        Role and scope grants are separate, reasoned actions.
                      </p>
                    </div>
                    <button
                      className="btn"
                      onClick={() =>
                        setDialog({
                          title: "Create internal account",
                          endpoint: "/api/users/create",
                          fields: [
                            { name: "name", label: "Name", required: true },
                            { name: "email", label: "Email", required: true },
                            {
                              name: "password",
                              label: "Initial password · minimum 14 characters",
                              type: "password",
                              required: true,
                            },
                            reasonField,
                          ],
                        })
                      }
                    >
                      <Plus size={16} />
                      Add person
                    </button>
                  </div>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Person</th>
                          <th>Business roles</th>
                          <th>Status</th>
                          <th>Manage</th>
                        </tr>
                      </thead>
                      <tbody>
                        {admin.users.map((u) => (
                          <tr key={u.id}>
                            <td>
                              <strong>{u.name}</strong>
                              <small>{u.email}</small>
                            </td>
                            <td>
                              {admin.roles
                                .filter((r) => r.user_id === u.id)
                                .map((r) => r.role)
                                .join(", ") || "No roles"}
                            </td>
                            <td>
                              <Badge value={u.active ? "Active" : "Disabled"} />
                            </td>
                            <td>
                              <div className="inline-actions">
                                <button
                                  onClick={() =>
                                    setDialog({
                                      title: "Grant a role",
                                      endpoint: "/api/users/grant-role",
                                      base: { userId: u.id },
                                      fields: [
                                        {
                                          name: "role",
                                          label: "Role",
                                          type: "select",
                                          options: options([
                                            "Employee",
                                            "Document Owner",
                                            "Reviewer",
                                            "Approver",
                                            "QA",
                                            "Investigator",
                                            "Inventory Custodian",
                                            "EHS Coordinator",
                                            "System Administrator",
                                          ]),
                                          required: true,
                                        },
                                        {
                                          name: "siteId",
                                          label: "Site",
                                          type: "select",
                                          options: o.sites.map((s) => ({
                                            value: s.id,
                                            label: s.name,
                                          })),
                                          value: o.sites[0]?.id,
                                        },
                                        reasonField,
                                      ],
                                    })
                                  }
                                >
                                  Role
                                </button>
                                <button
                                  onClick={() =>
                                    setDialog({
                                      title: "Revoke a business role",
                                      endpoint: "/api/users/revoke-role",
                                      base: { userId: u.id },
                                      fields: [
                                        {
                                          name: "role",
                                          label: "Role",
                                          type: "select",
                                          options: admin.roles
                                            .filter((r) => r.user_id === u.id)
                                            .map((r) => ({
                                              value: r.role,
                                              label: r.role,
                                            })),
                                          required: true,
                                        },
                                        {
                                          name: "siteId",
                                          label:
                                            "Site (blank for system administrator)",
                                          type: "select",
                                          options: o.sites.map((s) => ({
                                            value: s.id,
                                            label: s.name,
                                          })),
                                        },
                                        reasonField,
                                      ],
                                    })
                                  }
                                >
                                  Revoke role
                                </button>
                                <button
                                  onClick={() =>
                                    setDialog({
                                      title: "Grant record access",
                                      description:
                                        "Blank project and record scope grants all records at the selected site. Use the narrowest useful scope.",
                                      endpoint: "/api/users/grant-scope",
                                      base: { userId: u.id },
                                      fields: [
                                        {
                                          name: "siteId",
                                          label: "Site",
                                          type: "select",
                                          options: o.sites.map((s) => ({
                                            value: s.id,
                                            label: s.name,
                                          })),
                                          value: o.sites[0]?.id,
                                          required: true,
                                        },
                                        {
                                          name: "projectId",
                                          label: "Project (optional)",
                                          type: "select",
                                          options: [
                                            {
                                              value: "",
                                              label: "All projects at site",
                                            },
                                            ...o.projects.map((p) => ({
                                              value: p.id,
                                              label: p.code,
                                            })),
                                          ],
                                        },
                                        {
                                          name: "recordId",
                                          label: "Record (optional)",
                                          type: "select",
                                          options: [
                                            {
                                              value: "",
                                              label: "All matching records",
                                            },
                                            ...o.records.map((r) => ({
                                              value: r.id,
                                              label: r.title,
                                            })),
                                          ],
                                        },
                                        {
                                          name: "expiresAt",
                                          label: "Access expiry (optional)",
                                          type: "datetime-local",
                                        },
                                        reasonField,
                                      ],
                                    })
                                  }
                                >
                                  Scope
                                </button>
                                <button
                                  onClick={() =>
                                    setDialog({
                                      title: u.active
                                        ? "Disable account"
                                        : "Enable account",
                                      description:
                                        "Disabling immediately invalidates sessions. Open tasks retain their history and require controlled reassignment.",
                                      endpoint: `/api/users/${u.active ? "disable" : "enable"}`,
                                      base: { userId: u.id },
                                      fields: [reasonField],
                                    })
                                  }
                                >
                                  {u.active ? "Disable" : "Enable"}
                                </button>
                              </div>
                              {admin.scopes
                                .filter((g) => g.user_id === u.id)
                                .map((g) => (
                                  <div className="scope-entry" key={g.id}>
                                    <small>
                                      {o.sites.find((s) => s.id === g.site_id)
                                        ?.name ?? "Other site"}{" "}
                                      · {g.reason}
                                    </small>
                                    <button
                                      className="text-btn"
                                      onClick={() =>
                                        setDialog({
                                          title: "Revoke scope grant",
                                          endpoint: "/api/users/revoke-scope",
                                          base: { userId: u.id, scopeId: g.id },
                                          fields: [reasonField],
                                        })
                                      }
                                    >
                                      Revoke scope
                                    </button>
                                  </div>
                                ))}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {admin.failures.length > 0 && (
                    <div className="error">
                      {admin.failures.length} notification deliveries require
                      attention. Automatic retries are scheduled; inspect the
                      worker log.
                    </div>
                  )}
                </section>
              )}
              <p className="footnote">
                Development workflows are sample rules pending BBC approval. No
                GLP, GMP or 21 CFR Part 11 compliance or validation claim is
                made.
              </p>
            </>
          )}
        </div>
      </main>
      {toast && (
        <div className="toast" role="status">
          <CheckCircle2 size={18} />
          {toast}
        </div>
      )}
      {dialog && (
        <ActionDialog
          config={dialog}
          overview={o}
          onClose={() => setDialog(null)}
          onDone={done}
        />
      )}
    </div>
  );
}
function Login({
  onLogin,
  externalError,
}: {
  onLogin: () => Promise<void>;
  externalError: string;
}) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <div className="login-shell">
      <div className="login-art">
        <div className="brand light">
          <div className="brand-mark">
            B<span />
          </div>
          <div>
            <b>BIOCYTOGEN</b>
            <small>Quality & Operations</small>
          </div>
        </div>
        <div className="login-message">
          <div className="eyebrow">BBC INTERNAL PLATFORM</div>
          <h1>
            Confidence in
            <br />
            every step.
          </h1>
          <p>
            A shared workspace for controlled documents,
            <br />
            quality decisions and laboratory operations.
          </p>
          <div className="login-orbit">
            <div>
              <ShieldCheck size={45} />
            </div>
            <span>REVIEW</span>
            <span>APPROVE</span>
            <span>TRACE</span>
          </div>
        </div>
        <small className="login-bottom">Waltham · Internal access only</small>
      </div>
      <div className="login-form-wrap">
        <form
          onSubmit={async (e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            const f = new FormData(e.currentTarget);
            try {
              await api("/api/auth/login", {
                email: f.get("email"),
                password: f.get("password"),
              });
              await onLogin();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="eyebrow">WELCOME TO YOUR WORKSPACE</div>
          <h2>Sign in</h2>
          <p>Use your assigned internal account.</p>
          {(error || externalError) && (
            <div className="error" role="alert">
              {error || externalError}
            </div>
          )}
          <label>
            Email address
            <input
              name="email"
              type="email"
              required
              autoComplete="username"
              placeholder="you@company.com"
            />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              required
              autoComplete="current-password"
              placeholder="Enter your password"
            />
          </label>
          <button className="btn" disabled={busy}>
            {busy ? "Signing in…" : "Sign in to workspace"}
            <ArrowRight size={18} />
          </button>
          <div className="login-note">
            <ShieldCheck size={18} />
            <span>
              Accounts are provisioned by an administrator.
              <br />
              Public registration is disabled.
            </span>
          </div>
          <div className="sample-note">
            Internal controlled workspace · Sample rules pending approval
            <br />
            Use your assigned account. Test accounts are available only in the local test controller.
          </div>
        </form>
      </div>
    </div>
  );
}
function RecordsTable({
  rows,
  onOpen,
}: {
  rows: RecordItem[];
  onOpen: (id: string) => Promise<void>;
}) {
  return rows.length ? (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Record</th>
            <th>Type</th>
            <th>Site</th>
            <th>Status</th>
            <th>Created</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>
                <button
                  className="record-title"
                  onClick={() => void onOpen(r.id)}
                >
                  <span className="file-icon">
                    <FileText size={17} />
                  </span>
                  <span>
                    <strong>{r.title}</strong>
                    <small>{r.number || `${r.kind} record`}</small>
                  </span>
                </button>
              </td>
              <td>{r.kind}</td>
              <td>
                <span className="site-tag">{r.site_code}</span>
              </td>
              <td>
                <Badge value={r.status} />
              </td>
              <td className="muted-text">{date(r.created_at)}</td>
              <td>
                <button
                  className="icon-btn"
                  aria-label={`Open ${r.title}`}
                  onClick={() => void onOpen(r.id)}
                >
                  <ArrowUpRight size={17} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <div className="empty">
      <FolderOpen size={34} />
      <h3>No records in this view</h3>
      <p>Create a record or adjust your search.</p>
    </div>
  );
}
function TaskTable({
  tasks,
  onOpen,
  onAction,
  canManage,
}: {
  tasks: Task[];
  onOpen: (id: string) => Promise<void>;
  onAction: (t: Task, a: string) => void;
  canManage: boolean;
}) {
  return tasks.length ? (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Task & completion condition</th>
            <th>Owner</th>
            <th>Due</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {tasks.map((t) => (
            <tr key={t.id}>
              <td>
                <button
                  className="text-link"
                  onClick={() => void onOpen(t.record_id)}
                >
                  {t.title}
                </button>
                <small>{t.completion_condition}</small>
              </td>
              <td>
                {t.assignee_name}
                {!t.assignee_active && <Badge value="Disabled" />}
              </td>
              <td>{date(t.due_at)}</td>
              <td>
                <Badge
                  value={
                    t.status === "Open" && new Date(t.due_at) < new Date()
                      ? "Overdue"
                      : t.status
                  }
                />
              </td>
              <td>
                {t.status === "Open" && (
                  <div className="inline-actions">
                    <button onClick={() => void onOpen(t.record_id)}>
                      Open
                    </button>
                    {canManage && (
                      <>
                        <button onClick={() => onAction(t, "reassign")}>
                          Reassign
                        </button>
                        <button onClick={() => onAction(t, "extend")}>
                          Extend
                        </button>
                      </>
                    )}
                    {![
                      "Training",
                      "Review",
                      "Approve",
                      "Effectiveness",
                      "Question",
                      "Implementation",
                      "Finding",
                      "EHS review",
                    ].includes(t.kind) && (
                      <button onClick={() => onAction(t, "complete")}>
                        Complete
                      </button>
                    )}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <div className="empty">
      <CheckCircle2 size={32} />
      <h3>No assignments here</h3>
      <p>Tasks appear when a workflow requires action.</p>
    </div>
  );
}
function AuditTrail({ events }: { events: AuditEvent[] }) {
  return (
    <div className="audit-list">
      {events.length ? (
        events.map((e) => (
          <div className="audit-event" key={e.id}>
            <div className="audit-dot" />
            <div>
              <strong>
                {e.action}
                <span className="entity-label">{e.entity}</span>
              </strong>
              <p>{e.reason || "System-recorded change"}</p>
              <small>
                {e.actor_name || "Migration / system"} ·{" "}
                {new Date(e.occurred_at).toLocaleString("en-US")}
              </small>
              {e.before_data !== undefined && (
                <details>
                  <summary>View recorded change</summary>
                  <pre>
                    {JSON.stringify(
                      { before: e.before_data, after: e.after_data },
                      null,
                      2,
                    )}
                  </pre>
                </details>
              )}
            </div>
          </div>
        ))
      ) : (
        <div className="empty small">No events available.</div>
      )}
    </div>
  );
}
function ActionDialog({
  config,
  overview,
  onClose,
  onDone,
}: {
  config: DialogConfig;
  overview: Overview;
  onClose: () => void;
  onDone: (r: { id?: string }) => Promise<void>;
}) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const lastRequest = useRef<{ body: string; key: string } | null>(null);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
      >
        <div className="modal-head">
          <div>
            <div className="eyebrow">CONTROLLED ACTION</div>
            <h2 id="dialog-title">{config.title}</h2>
          </div>
          <button
            className="icon-btn"
            onClick={onClose}
            aria-label="Close dialog"
          >
            <X size={20} />
          </button>
        </div>
        {config.description && (
          <p className="modal-description">{config.description}</p>
        )}
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            const form = new FormData(e.currentTarget);
            const body: Record<string, unknown> = { ...config.base };
            for (const f of config.fields) {
              const v = form.get(f.name);
              if (f.type === "checkbox") body[f.name] = v === "on";
              else if (f.type === "multiselect")
                body[f.name] = form.getAll(f.name);
              else if (v !== null && v !== "")
                body[f.name] =
                  f.type === "number"
                    ? Number(v)
                    : f.type === "datetime-local"
                      ? new Date(String(v)).toISOString()
                      : String(v);
            }
            if (body.projectId) {
              const p = overview.projects.find((x) => x.id === body.projectId);
              if (p) body.customerId = p.customer_id;
            }
            try {
              const serialized = JSON.stringify(body);
              if (lastRequest.current?.body !== serialized)
                lastRequest.current = {
                  body: serialized,
                  key: crypto.randomUUID(),
                };
              await onDone(
                await api(config.endpoint, body, lastRequest.current.key),
              );
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="modal-fields">
            {config.fields.map((f, i) => (
              <label
                key={f.name}
                className={f.type === "checkbox" ? "checkbox-field" : ""}
              >
                {f.type === "checkbox" ? (
                  <>
                    <input
                      name={f.name}
                      type="checkbox"
                      defaultChecked={Boolean(f.value)}
                    />
                    {f.label}
                  </>
                ) : (
                  <>
                    <span>
                      {f.label}
                      {f.required && <b className="required"> *</b>}
                    </span>
                    {f.type === "textarea" ? (
                      <textarea
                        name={f.name}
                        required={f.required}
                        defaultValue={String(f.value ?? "")}
                        rows={3}
                      />
                    ) : f.type === "select" || f.type === "multiselect" ? (
                      <select
                        name={f.name}
                        multiple={f.type === "multiselect"}
                        required={f.required}
                        defaultValue={
                          f.type === "multiselect"
                            ? Array.isArray(f.value)
                              ? f.value
                              : []
                            : String(f.value ?? "")
                        }
                      >
                        {f.type === "select" && !f.value && (
                          <option value="">Select…</option>
                        )}
                        {f.options?.map((x) => (
                          <option key={x.value} value={x.value}>
                            {x.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        name={f.name}
                        type={f.type ?? "text"}
                        required={f.required}
                        defaultValue={String(f.value ?? "")}
                        step={f.type === "number" ? "any" : undefined}
                        autoFocus={i === 0}
                      />
                    )}
                  </>
                )}
                {f.hint && <small>{f.hint}</small>}
              </label>
            ))}
          </div>
          {error && (
            <div className="error" role="alert">
              <AlertCircle size={17} />
              {error}
            </div>
          )}
          <div className="modal-footer">
            <button
              type="button"
              className="btn secondary"
              onClick={onClose}
              disabled={busy}
            >
              Cancel
            </button>
            <button className="btn" type="submit" disabled={busy}>
              {busy ? "Saving…" : "Confirm action"}
              <ArrowRight size={16} />
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
function RecordDetail({
  d,
  o,
  can,
  onBack,
  onDialog,
  onRefresh,
  onError,
  onTask,
}: {
  d: Detail;
  o: Overview;
  can: (...roles: string[]) => boolean;
  onBack: () => void;
  onDialog: (c: DialogConfig) => void;
  onRefresh: () => void;
  onError: (e: string) => void;
  onTask: (t: Task, a: string) => void;
}) {
  const [tab, setTab] = useState("Overview"),
    [selectedRev, setSelectedRev] = useState<string | null>(null),
    [uploading, setUploading] = useState(false);
  useEffect(() => {
    setTab("Overview");
    setSelectedRev(null);
  }, [d.record.id]);
  const r = d.record,
    v = d.revisions?.find((x) => x.id === selectedRev) ?? d.revisions?.[0];
  const state = String(d.data.status ?? v?.status ?? "Registered");
  const ver = Number(d.data.version ?? 1);
  const people = o.users
    .filter((u) => u.active)
    .map((u) => ({ value: u.id, label: u.name }));
  const action = (name: string, fields: Field[] = [], title?: string) =>
    onDialog({
      title: title ?? fmt(name.replace(/-/g, " ")),
      endpoint: `/api/${r.kind === "Answer" ? "answers" : r.kind === "Questionnaire" ? "questionnaires" : "quality"}/${r.id}/${name}`,
      base: { version: ver },
      fields: [...fields, reasonField],
    });
  const eventActions: Record<string, [string, string[]][]> = {
    Deviation:
      state === "Open" || state === "Investigation"
        ? [
            ["investigate", ["QA", "Investigator"]],
            ...(state === "Investigation"
              ? [["submit", ["QA", "Investigator"]] as [string, string[]]]
              : []),
          ]
        : state === "In Review"
          ? [
              ["close", ["QA"]],
              ["return", ["QA"]],
            ]
          : state === "Closed"
            ? [["reopen", ["QA"]]]
            : [],
    CAPA:
      state === "Draft"
        ? [["approve-plan", ["Approver"]]]
        : state === "Plan Approved"
          ? [["implement", ["QA", "Investigator"]]]
          : state === "Implemented"
            ? d.data.effectiveness_required
              ? [["effectiveness", ["QA"]]]
              : [["close", ["QA"]]]
            : state === "Effectiveness Complete"
              ? [["close", ["QA"]]]
              : [],
    Change:
      state === "Draft"
        ? [["approve", ["Approver"]]]
        : state === "Approved"
          ? [["implement", ["QA", "Investigator"]]]
          : state === "Implemented"
            ? [["close", ["QA"]]]
            : [],
    Audit:
      state === "Planned"
        ? [["start", ["QA", "Investigator"]]]
        : state === "In Progress"
          ? [["submit", ["QA", "Investigator"]]]
          : state === "In Review"
            ? [["close", ["QA"]]]
            : [],
    EHS:
      state === "Open"
        ? [["assess", ["EHS Coordinator"]]]
        : state === "In Review"
          ? [
              ["assess", ["EHS Coordinator"]],
              ["close", ["EHS Coordinator"]],
            ]
          : [],
    Questionnaire:
      state === "Draft"
        ? [["review", ["QA"]]]
        : state === "In Review"
          ? [
              ["submit", ["QA"]],
              ["return", ["QA"]],
            ]
          : [],
    Answer:
      state === "Approved"
        ? [["revise", ["QA"]]]
        : [
            ["revise", ["QA"]],
            ["approve", ["QA", "Approver"]],
          ],
  };
  const eventForm = (name: string) => {
    let f: Field[] = [];
    if (name === "investigate")
      f = [
        {
          name: "impact",
          label: "Impact assessment",
          type: "textarea",
          value: String(d.data.impact ?? ""),
          required: true,
        },
        {
          name: "containment",
          label: "Containment",
          type: "textarea",
          value: String(d.data.containment ?? ""),
          required: true,
        },
        {
          name: "investigation",
          label: "Investigation",
          type: "textarea",
          required: true,
        },
        {
          name: "rootCause",
          label: "Root cause assessment",
          type: "textarea",
          required: d.data.risk !== "Low",
        },
        {
          name: "disposition",
          label: "Disposition",
          type: "textarea",
          required: true,
        },
        {
          name: "capaDecision",
          label: "CAPA decision",
          type: "select",
          options: options(["Required", "Not Required"]),
          required: true,
        },
        {
          name: "capaReason",
          label: "CAPA rationale",
          type: "textarea",
          required: true,
        },
      ];
    if (
      name === "implement" ||
      name === "effectiveness" ||
      (r.kind === "Audit" && name === "submit") ||
      (r.kind === "EHS" && name === "close")
    )
      f.push(evidenceField(d));
    if (name === "effectiveness")
      f.push({
        name: "effectivenessResult",
        label: "Effectiveness result",
        type: "select",
        options: options(["Pass", "Fail"]),
        required: true,
      });
    if (name === "assess")
      f = [
        {
          name: "assessment",
          label: "Risk / incident assessment",
          type: "textarea",
          required: true,
        },
        {
          name: "interimMeasures",
          label: "Interim measures",
          type: "textarea",
        },
        {
          name: "correctiveAction",
          label: "Corrective action / review conclusion",
          type: "textarea",
          required: true,
        },
      ];
    if (r.kind === "Answer" && name === "revise")
      f = [
        {
          name: "answer",
          label: "Standard answer",
          type: "textarea",
          value: String(d.data.answer ?? ""),
          required: true,
        },
        {
          name: "limitations",
          label: "Applicability and limitations",
          type: "textarea",
          value: String(d.data.limitations ?? ""),
          required: true,
        },
        {
          name: "validUntil",
          label: "Review by",
          type: "date",
          required: true,
        },
        evidenceField(d),
      ];
    action(name, f);
  };
  async function uploadFile(file: File, rev?: Revision) {
    setUploading(true);
    onError("");
    try {
      const data = new FormData();
      data.set("recordId", r.id);
      data.set("file", file);
      if (rev) {
        data.set("revisionId", rev.id);
        data.set("version", String(rev.version));
      }
      const res = await fetch("/api/attachments", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: data,
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      onRefresh();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setUploading(false);
    }
  }
  function inventoryDialog(c: Container, act: string) {
    const quantity = [
      "use",
      "aliquot",
      "reserve",
      "unreserve",
      "return",
    ].includes(act);
    const fields: Field[] = [];
    if (quantity)
      fields.push({
        name: "amount",
        label: `Quantity (${c.unit})`,
        required: true,
      });
    if (act === "adjust")
      fields.push({
        name: "delta",
        label: `Signed adjustment (${c.unit})`,
        required: true,
        hint: "Positive adds stock; negative removes it. A reconciliation reason is required.",
      });
    if (["use", "return"].includes(act))
      fields.push({
        name: "projectId",
        label: "Actual use project",
        type: "select",
        options: o.projects.map((p) => ({ value: p.id, label: p.code })),
        required: true,
      });
    if (["aliquot", "move"].includes(act))
      fields.push({
        name: "locationId",
        label: "Destination location",
        type: "select",
        options: o.locations.map((l) => ({ value: l.id, label: l.name })),
        required: true,
      });
    if (act === "aliquot")
      fields.push(
        { name: "label", label: "Child container label", required: true },
        { name: "passage", label: "Passage (cells only)", type: "number" },
      );
    onDialog({
      title: `${fmt(act.replace("-", " "))} · ${c.label}`,
      description: `Available: ${c.quantity} ${c.unit}; reserved: ${c.reserved} ${c.unit}. Units cannot be converted implicitly.`,
      endpoint: `/api/containers/${c.id}/${act}`,
      base: { version: c.version, unit: c.unit },
      fields: [...fields, reasonField],
    });
  }
  const actions = (eventActions[r.kind] ?? []).filter(([, roles]) =>
    roles.some((role) => can(role)),
  );
  return (
    <>
      <button className="back-link" onClick={onBack}>
        <ChevronLeft size={15} />
        Back to workspace
      </button>
      <div className="page-head detail-head">
        <div>
          <div className="eyebrow">
            {String(d.data.number ?? r.kind)} <span>·</span> CONTROLLED RECORD
          </div>
          <h1>{r.title}</h1>
          <p>
            {r.kind === "Document"
              ? "Revision-specific decisions, files and training."
              : "Ownership, supporting evidence and decision history."}
          </p>
        </div>
        <Badge value={state} />
      </div>
      <div className="record-context">
        <span>
          Site: <strong>{r.site_name ?? r.site_code}</strong>
        </span>
        <span>
          Customer:{" "}
          <strong>{r.customer_name ?? "Not customer-specific"}</strong>
        </span>
        <span>
          Project: <strong>{r.project_code ?? "Site-wide"}</strong>
        </span>
      </div>
      <div className="record-actions">
        {r.kind === "Document" && v?.status === "Draft" && can("QA") && (
          <button
            className="btn secondary"
            onClick={() =>
              onDialog({
                title: "Configure role-based training",
                description:
                  "Applies to role members with existing record access. Each submission freezes the audience and deadlines. Does not change past training.",
                endpoint: `/api/documents/${r.id}/training-rule`,
                base: { version: v.version },
                fields: [
                  {
                    name: "role",
                    label: "Applicable role",
                    type: "select",
                    options: options([
                      "Employee",
                      "Document Owner",
                      "Reviewer",
                      "Approver",
                      "QA",
                      "Investigator",
                      "Inventory Custodian",
                      "EHS Coordinator",
                    ]),
                    required: true,
                  },
                  {
                    name: "dueDays",
                    label: "Days from approval to training due",
                    type: "number",
                    value: 14,
                    required: true,
                  },
                  {
                    name: "active",
                    label: "Enable requirement for future submissions",
                    type: "checkbox",
                    value: true,
                  },
                  reasonField,
                ],
              })
            }
          >
            Training rules
          </button>
        )}
        {r.kind === "Document" && v ? (
          <>
            {v.status === "Draft" && can("Document Owner", "QA") && (
              <>
                <button
                  className="btn secondary"
                  onClick={() =>
                    onDialog({
                      ...revisionForm(d),
                      title: "Edit draft details",
                      description:
                        "Draft details may change. Approved content requires a new revision or controlled return.",
                      endpoint: `/api/documents/${r.id}/draft`,
                      base: { version: v.version },
                    })
                  }
                >
                  Edit draft
                </button>
                <label className="btn secondary file-upload">
                  <Upload size={16} />
                  {uploading ? "Uploading…" : "Upload revision file"}
                  <input
                    type="file"
                    accept=".pdf,.docx"
                    disabled={uploading}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void uploadFile(f, v);
                      e.target.value = "";
                    }}
                  />
                </label>
                <button
                  className="btn"
                  onClick={() => onDialog(documentForm(d, v, "submit", o))}
                >
                  Submit for review
                  <ArrowRight size={16} />
                </button>
              </>
            )}
            {v.status === "In Review" &&
              v.reviewer_id === o.actor.id &&
              can("Reviewer", "QA") && (
                <button
                  className="btn"
                  onClick={() => onDialog(documentForm(d, v, "review", o))}
                >
                  Record review
                </button>
              )}
            {v.status === "In Review" &&
              v.approver_id === o.actor.id &&
              can("Approver") && (
                <button
                  className="btn"
                  onClick={() => onDialog(documentForm(d, v, "approve", o))}
                >
                  Approve revision
                </button>
              )}
            {v.status === "Approved" && can("QA") && (
              <button
                className="btn"
                onClick={() => onDialog(documentForm(d, v, "activate", o))}
              >
                Make effective
              </button>
            )}
            {["In Review", "Approved"].includes(v.status) &&
              can("QA", "Reviewer", "Approver") && (
                <button
                  className="btn secondary"
                  onClick={() => onDialog(documentForm(d, v, "return", o))}
                >
                  Return
                </button>
              )}
            {["Effective", "Obsolete"].includes(d.revisions![0].status) &&
              can("Document Owner", "QA") && (
                <button
                  className="btn"
                  onClick={() => onDialog(revisionForm(d))}
                >
                  <Plus size={16} />
                  New revision
                </button>
              )}
            {["Approved", "Effective"].includes(v.status) && can("QA") && (
              <button
                className="btn secondary"
                onClick={() => onDialog(documentForm(d, v, "obsolete", o))}
              >
                Withdraw
              </button>
            )}
          </>
        ) : (
          actions.map(([name]) => (
            <button key={name} className="btn" onClick={() => eventForm(name)}>
              {fmt(name.replace(/-/g, " "))}
              <ArrowRight size={15} />
            </button>
          ))
        )}
        {r.kind === "Material" && can("Inventory Custodian") && (
          <button
            className="btn"
            onClick={() =>
              onDialog({
                title: "Receive a lot",
                description:
                  "New lots are placed On Hold. Authorized release is required before use.",
                endpoint: `/api/materials/${r.id}/receive`,
                fields: [
                  {
                    name: "lotNumber",
                    label: "Lot / batch number",
                    required: true,
                  },
                  {
                    name: "expiresOn",
                    label: "Expiry date",
                    type: "date",
                    required: true,
                  },
                  {
                    name: "containerLabel",
                    label: "Container label",
                    required: true,
                  },
                  {
                    name: "quantity",
                    label: "Received quantity",
                    required: true,
                  },
                  {
                    name: "unit",
                    label: "Unit",
                    type: "select",
                    options: options(["mL", "uL", "mg", "g", "vial", "each"]),
                    required: true,
                  },
                  {
                    name: "locationId",
                    label: "Storage location",
                    type: "select",
                    options: o.locations.map((l) => ({
                      value: l.id,
                      label: l.name,
                    })),
                    required: true,
                  },
                  {
                    name: "concentration",
                    label: "Concentration with units (if applicable)",
                  },
                  {
                    name: "passage",
                    label: "Passage (cells only)",
                    type: "number",
                  },
                  {
                    name: "coaId",
                    label: "COA (if applicable)",
                    type: "select",
                    options: d.attachments.map((f) => ({
                      value: f.id,
                      label: f.filename,
                    })),
                  },
                  {
                    name: "sdsId",
                    label: "SDS (if applicable)",
                    type: "select",
                    options: d.attachments.map((f) => ({
                      value: f.id,
                      label: f.filename,
                    })),
                  },
                  reasonField,
                ],
              })
            }
          >
            <Plus size={16} />
            Receive lot
          </button>
        )}
        {r.kind === "Questionnaire" && state === "Draft" && can("QA") && (
          <button
            className="btn secondary"
            onClick={() =>
              onDialog({
                title: "Add a question",
                endpoint: `/api/questionnaires/${r.id}/questions`,
                fields: [
                  {
                    name: "question",
                    label: "Question",
                    type: "textarea",
                    required: true,
                  },
                  {
                    name: "assigneeId",
                    label: "Assigned contributor",
                    type: "select",
                    options: people,
                    required: true,
                  },
                  {
                    name: "answerId",
                    label: "Approved answer (optional)",
                    type: "select",
                    options: o.records
                      .filter(
                        (x) =>
                          x.kind === "Answer" &&
                          x.status === "Approved" &&
                          x.site_id === r.site_id,
                      )
                      .map((x) => ({ value: x.id, label: x.title })),
                  },
                  {
                    name: "draftAnswer",
                    label: "Draft answer if no approved answer selected",
                    type: "textarea",
                    value: "Pending confirmation",
                    required: true,
                  },
                  {
                    name: "promisedDocument",
                    label: "Promised document (creates a delivery task)",
                  },
                  reasonField,
                ],
              })
            }
          >
            <Plus size={16} />
            Add question
          </button>
        )}
        {r.kind === "Audit" &&
          !["Closed", "Cancelled"].includes(state) &&
          can("QA") && (
            <button
              className="btn secondary"
              onClick={() =>
                onDialog({
                  title: "Add audit finding",
                  endpoint: `/api/findings/${r.id}/create`,
                  fields: [
                    {
                      name: "description",
                      label: "Finding",
                      type: "textarea",
                      required: true,
                    },
                    {
                      name: "grade",
                      label: "Applicable grade",
                      required: true,
                    },
                    {
                      name: "ownerId",
                      label: "Action owner",
                      type: "select",
                      options: people,
                      required: true,
                    },
                    {
                      name: "dueAt",
                      label: "Response due",
                      type: "datetime-local",
                      required: true,
                    },
                    reasonField,
                  ],
                })
              }
            >
              <Plus size={16} />
              Add finding
            </button>
          )}
        {qKinds.includes(r.kind) && can("QA") && (
          <button
            className="btn secondary"
            onClick={() =>
              action(
                "link",
                [
                  {
                    name: "relatedId",
                    label: "Related record",
                    type: "select",
                    options: o.records
                      .filter((x) => x.id !== r.id && x.site_id === r.site_id)
                      .map((x) => ({
                        value: x.id,
                        label: `${x.kind} · ${x.title}`,
                      })),
                    required: true,
                  },
                ],
                "Link a related record",
              )
            }
          >
            Link record
          </button>
        )}
      </div>
      <div className="module-tabs">
        {[
          "Overview",
          ...(r.kind === "Document" ? ["Revisions", "Training"] : []),
          "Attachments",
          "Tasks",
          "Audit history",
        ].map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={tab === t ? "selected" : ""}
          >
            {t}
            {t === "Attachments" && <span>{d.attachments.length}</span>}
          </button>
        ))}
      </div>
      {tab === "Overview" || tab === "Revisions" ? (
        <>
          {r.kind === "Document" && v ? (
            <>
              <div className="revision-layout">
                <section className="panel revision-main">
                  <div className="panel-head">
                    <div>
                      <h2>
                        Revision {v.number}
                        <span className="count">v{v.version}</span>
                      </h2>
                      <p>{v.change_reason}</p>
                    </div>
                    <Badge value={v.status} />
                  </div>
                  <div className="workflow-steps">
                    {["Draft", "In Review", "Approved", "Effective"].map(
                      (s, i) => (
                        <div
                          key={s}
                          className={
                            [
                              "Draft",
                              "In Review",
                              "Approved",
                              "Effective",
                            ].indexOf(v.status) >= i
                              ? "passed"
                              : ""
                          }
                        >
                          <span>{i + 1}</span>
                          <strong>{s}</strong>
                        </div>
                      ),
                    )}
                  </div>
                  <div className="file-snapshot">
                    <div className="file-symbol">
                      <FileText size={27} />
                    </div>
                    <div>
                      <strong>
                        {v.filename || "No revision file uploaded"}
                      </strong>
                      <small>
                        {v.file_id
                          ? "Private controlled file · fixed SHA-256 fingerprint"
                          : "Upload a PDF or DOCX before submitting for review"}
                      </small>
                      {v.sha256 && <code>{v.sha256}</code>}
                    </div>
                    {v.file_id && (
                      <a
                        className="btn secondary"
                        href={`/api/attachments/${v.file_id}`}
                      >
                        <Download size={15} />
                        Download
                      </a>
                    )}
                  </div>
                  <div className="detail-facts">
                    <div>
                      <small>Training requirement</small>
                      <strong>{v.training_mode}</strong>
                    </div>
                    <div>
                      <small>Effectiveness gate</small>
                      <strong>
                        {v.training_before_effective
                          ? "Training completion required"
                          : "Training may follow approval"}
                      </strong>
                    </div>
                    <div>
                      <small>Controlled snapshot</small>
                      <strong>{v.archive_status}</strong>
                    </div>
                    <div>
                      <small>Approval method</small>
                      <strong>{v.signing_mode} approval</strong>
                    </div>
                    <div>
                      <small>Periodic review</small>
                      <strong>{date(v.review_due)}</strong>
                    </div>
                    <div>
                      <small>Workflow rule</small>
                      <strong>
                        Sample SOP rule · version {v.workflow_version}
                      </strong>
                    </div>
                  </div>
                </section>
                <section className="panel revision-list">
                  <h3>Revision history</h3>
                  {d.revisions!.map((x) => (
                    <button
                      className={v.id === x.id ? "current" : ""}
                      key={x.id}
                      onClick={() => setSelectedRev(x.id)}
                    >
                      <span>
                        Revision {x.number}
                        <small>{x.change_reason}</small>
                      </span>
                      <Badge value={x.status} />
                    </button>
                  ))}
                </section>
              </div>
              <section className="panel">
                <div className="panel-head">
                  <div>
                    <h2>Review & approval evidence</h2>
                    <p>
                      Every decision is bound to a revision, review cycle and
                      file hash.
                    </p>
                  </div>
                </div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Decision</th>
                        <th>Actor</th>
                        <th>Cycle</th>
                        <th>Time</th>
                        <th>File fingerprint</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.approvals?.map((a) => (
                        <tr key={a.id}>
                          <td>
                            <Badge value={a.action} />
                          </td>
                          <td>{a.actor_name}</td>
                          <td>{a.cycle}</td>
                          <td>{new Date(a.created_at).toLocaleString()}</td>
                          <td>
                            <code>{a.file_hash.slice(0, 16)}…</code>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!d.approvals?.length && (
                    <div className="empty small">
                      No decisions recorded yet.
                    </div>
                  )}
                </div>
              </section>
            </>
          ) : (
            <section className="panel settings-panel">
              <h2>Record details</h2>
              <div className="detail-facts">
                {Object.entries(d.data)
                  .filter(
                    ([k, value]) =>
                      !k.endsWith("_id") &&
                      !k.endsWith("_by") &&
                      !["version", "status", "record_id"].includes(k) &&
                      value !== null,
                  )
                  .map(([k, value]) => (
                    <div
                      key={k}
                      className={String(value).length > 90 ? "wide" : ""}
                    >
                      <small>{fmt(k)}</small>
                      <strong>
                        {typeof value === "boolean"
                          ? value
                            ? "Yes"
                            : "No"
                          : String(value)}
                      </strong>
                    </div>
                  ))}
              </div>
            </section>
          )}
          {d.lots && (
            <section className="panel">
              <div className="panel-head">
                <h2>Lots & release decisions</h2>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Lot</th>
                      <th>Expiry</th>
                      <th>Status</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {d.lots.map((l) => (
                      <tr key={l.id}>
                        <td>{l.lot_number}</td>
                        <td>{date(l.expires_on)}</td>
                        <td>
                          <Badge value={l.status} />
                        </td>
                        <td>
                          {can("Inventory Custodian") && (
                            <button
                              className="text-btn"
                              onClick={() =>
                                onDialog({
                                  title:
                                    l.status === "Released"
                                      ? "Place lot on hold"
                                      : "Release lot for use",
                                  endpoint: `/api/lots/${l.id}/${l.status === "Released" ? "hold" : "release"}`,
                                  base: { version: l.version },
                                  fields: [reasonField],
                                })
                              }
                            >
                              {l.status === "Released" ? "Hold" : "Release"}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
          {d.containers && (
            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2>Containers & aliquots</h2>
                  <p>
                    Quantities are shown per container and unit. Reservations
                    reduce available stock.
                  </p>
                </div>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Container</th>
                      <th>Quantity</th>
                      <th>Reserved</th>
                      <th>Location</th>
                      <th>Status</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.containers.map((c) => (
                      <tr key={c.id}>
                        <td>
                          <strong>{c.label}</strong>
                          <small>
                            {c.lot_number}
                            {c.parent_id ? " · Aliquot" : ""}
                            {c.passage !== null
                              ? ` · P${c.passage}`
                              : ""} · {c.freeze_thaw_count} freeze/thaw
                          </small>
                        </td>
                        <td className="quantity">
                          {Number(c.quantity)} <small>{c.unit}</small>
                        </td>
                        <td>
                          {Number(c.reserved)} {c.unit}
                        </td>
                        <td>{c.location_name}</td>
                        <td>
                          <Badge value={c.status} />
                        </td>
                        <td>
                          {can("Inventory Custodian") &&
                            c.status !== "Disposed" && (
                              <select
                                aria-label={`Action for ${c.label}`}
                                value=""
                                onChange={(e) =>
                                  inventoryDialog(c, e.target.value)
                                }
                              >
                                <option value="">Choose action…</option>
                                {[
                                  "use",
                                  "aliquot",
                                  "move",
                                  "reserve",
                                  "unreserve",
                                  "adjust",
                                  "return",
                                  "dispose",
                                  "freeze-thaw",
                                  "open",
                                ].map((a) => (
                                  <option key={a} value={a}>
                                    {fmt(a.replace("-", " "))}
                                  </option>
                                ))}
                              </select>
                            )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
          {d.transactions && (
            <section className="panel">
              <div className="panel-head">
                <h2>Quantity ledger</h2>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Operation</th>
                      <th>Container</th>
                      <th>Change</th>
                      <th>Balance after</th>
                      <th>Reason</th>
                      <th>Actor</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.transactions.map((t) => (
                      <tr key={t.id}>
                        <td>
                          {t.operation}
                          <small>{date(t.created_at)}</small>
                        </td>
                        <td>{t.container_label}</td>
                        <td>
                          {Number(t.delta)} {t.unit}
                        </td>
                        <td>
                          {Number(t.balance_after)} {t.unit}
                        </td>
                        <td>{t.reason}</td>
                        <td>{t.actor_name}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
          {d.findings && (
            <section className="panel">
              <div className="panel-head">
                <h2>Audit findings</h2>
              </div>
              {d.findings.map((f) => (
                <div className="question-card" key={f.id}>
                  <div>
                    <Badge value={f.status} />
                    <strong>
                      {f.grade} · {f.description}
                    </strong>
                    <p>Action owner: {f.owner_name}</p>
                  </div>
                  {f.status === "Open" && can("QA") && (
                    <button
                      className="btn secondary"
                      onClick={() =>
                        onDialog({
                          title: "Review and close finding",
                          endpoint: `/api/findings/${r.id}/close`,
                          base: { id: f.id, version: f.version },
                          fields: [
                            {
                              name: "response",
                              label: "Response and closure rationale",
                              type: "textarea",
                              required: true,
                            },
                            evidenceField(d),
                            {
                              name: "capaId",
                              label: "Related CAPA (optional)",
                              type: "select",
                              options: o.records
                                .filter((x) => x.kind === "CAPA")
                                .map((x) => ({ value: x.id, label: x.title })),
                            },
                            reasonField,
                          ],
                        })
                      }
                    >
                      Review closure
                    </button>
                  )}
                </div>
              ))}
            </section>
          )}
          {d.questions && (
            <section className="panel">
              <div className="panel-head">
                <h2>Question register</h2>
              </div>
              {d.questions.length ? (
                d.questions.map((q, i) => (
                  <div className="question-card" key={q.id}>
                    <div className="question-number">
                      {String(i + 1).padStart(2, "0")}
                    </div>
                    <div>
                      <strong>{q.question}</strong>
                      <p>{q.draft_answer}</p>
                      {q.promised_document && (
                        <small>Promised document: {q.promised_document}</small>
                      )}
                    </div>
                    {state === "Draft" &&
                      (q.assignee_id === o.actor.id || can("QA")) && (
                        <button
                          className="btn secondary"
                          onClick={() =>
                            onDialog({
                              title: "Save question response",
                              endpoint: `/api/questions/${q.id}/update`,
                              base: { version: q.version },
                              fields: [
                                {
                                  name: "question",
                                  label: "Question",
                                  type: "textarea",
                                  value: q.question,
                                  required: true,
                                },
                                {
                                  name: "assigneeId",
                                  label: "Assigned contributor",
                                  type: "select",
                                  options: people,
                                  value: q.assignee_id,
                                  required: true,
                                },
                                {
                                  name: "answerId",
                                  label: "Approved answer (optional)",
                                  type: "select",
                                  options: o.records
                                    .filter(
                                      (x) =>
                                        x.kind === "Answer" &&
                                        x.status === "Approved" &&
                                        x.site_id === r.site_id,
                                    )
                                    .map((x) => ({
                                      value: x.id,
                                      label: x.title,
                                    })),
                                  value: q.answer_id ?? "",
                                },
                                {
                                  name: "draftAnswer",
                                  label: "Response / confirmation status",
                                  type: "textarea",
                                  value: q.draft_answer,
                                  required: true,
                                },
                                {
                                  name: "promisedDocument",
                                  label: "Promised document",
                                  value: q.promised_document ?? "",
                                },
                                reasonField,
                              ],
                            })
                          }
                        >
                          Edit response
                        </button>
                      )}
                  </div>
                ))
              ) : (
                <div className="empty small">
                  Add questions and assign contributors.
                </div>
              )}
            </section>
          )}
          {d.submissions?.map((s) => (
            <section className="panel settings-panel" key={s.id}>
              <h2>Fixed submission · {date(s.created_at)}</h2>
              <p>
                Historical answers and source/file versions are retained as
                submitted. This does not send to the client.
              </p>
              <details>
                <summary>View submission snapshot</summary>
                <pre>{JSON.stringify(s.snapshot, null, 2)}</pre>
              </details>
            </section>
          ))}
          {d.links.length > 0 && (
            <section className="panel settings-panel">
              <h2>Related records</h2>
              {d.links.map((l) => (
                <p key={l.id}>
                  {l.related_kind} · {l.related_title}
                </p>
              ))}
            </section>
          )}
        </>
      ) : tab === "Training" ? (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Revision-specific training</h2>
              <div className="chips">
                {d.trainingRequirements
                  ?.filter((x) => x.active)
                  .map((x) => (
                    <span className="chip" key={x.id}>
                      {x.role} · {x.due_days} days
                    </span>
                  ))}
              </div>
              <p>
                Competency and instructor-led completion require an independent
                confirmer and evidence.
              </p>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Trainee</th>
                  <th>Revision</th>
                  <th>Method</th>
                  <th>Status</th>
                  <th>Completion</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {d.training?.map((t) => (
                  <tr key={t.id}>
                    <td>{t.trainee_name}</td>
                    <td>{t.revision_number}</td>
                    <td>{t.method}</td>
                    <td>
                      <Badge value={t.status} />
                    </td>
                    <td>
                      {date(t.completed_at)}
                      <small>{t.confirmer_name}</small>
                    </td>
                    <td>
                      {t.status === "Assigned" &&
                        (t.user_id === o.actor.id || can("Reviewer", "QA")) && (
                          <button
                            className="btn secondary"
                            onClick={() =>
                              onDialog({
                                title:
                                  t.method === "Read acknowledgement"
                                    ? "Confirm reading and understanding"
                                    : "Confirm training / competency",
                                endpoint: `/api/training/${t.id}/complete`,
                                fields: [
                                  ...(t.method === "Read acknowledgement"
                                    ? []
                                    : [evidenceField(d)]),
                                  reasonField,
                                ],
                              })
                            }
                          >
                            {t.method === "Read acknowledgement"
                              ? "Acknowledge"
                              : "Confirm completion"}
                          </button>
                        )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!d.training?.length && (
              <div className="empty small">
                Training is assigned when the revision is approved.
              </div>
            )}
          </div>
        </section>
      ) : tab === "Attachments" ? (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Private attachments</h2>
              <p>
                Fixed file identities and SHA-256 fingerprints. Downloads
                enforce record access.
              </p>
            </div>
            {can(
              "Document Owner",
              "QA",
              "Investigator",
              "Inventory Custodian",
              "EHS Coordinator",
              "Reviewer",
            ) && (
              <label className="btn secondary file-upload">
                <Upload size={16} />
                {uploading ? "Uploading…" : "Upload evidence"}
                <input
                  type="file"
                  accept=".pdf,.docx"
                  disabled={uploading}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void uploadFile(f);
                    e.target.value = "";
                  }}
                />
              </label>
            )}
          </div>
          <div className="attachment-list">
            {d.attachments.map((f) => (
              <div key={f.id} className="attachment-row">
                <FileText size={22} />
                <div>
                  <strong>{f.filename}</strong>
                  <small>
                    {Math.ceil(Number(f.size_bytes) / 1024)} KB ·{" "}
                    {date(f.created_at)}
                  </small>
                  <code>{f.sha256}</code>
                </div>
                <a className="btn secondary" href={`/api/attachments/${f.id}`}>
                  <Download size={16} />
                  Download
                </a>
              </div>
            ))}
            {!d.attachments.length && (
              <div className="empty small">No attachments yet.</div>
            )}
          </div>
        </section>
      ) : tab === "Tasks" ? (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Linked tasks</h2>
              <p>Assignment requires existing access to this record.</p>
            </div>
            {can(
              "QA",
              "Document Owner",
              "Inventory Custodian",
              "EHS Coordinator",
            ) && (
              <button
                className="btn"
                onClick={() =>
                  onDialog({
                    title: "Assign a follow-up task",
                    endpoint: "/api/tasks",
                    base: { recordId: r.id },
                    fields: [
                      { name: "title", label: "Task title", required: true },
                      {
                        name: "assigneeId",
                        label: "Assignee",
                        type: "select",
                        options: people,
                        required: true,
                      },
                      {
                        name: "dueAt",
                        label: "Due date",
                        type: "datetime-local",
                        required: true,
                      },
                      {
                        name: "completionCondition",
                        label: "Completion condition",
                        type: "textarea",
                        required: true,
                      },
                      {
                        name: "requiresEvidence",
                        label: "Require an evidence attachment to complete",
                        type: "checkbox",
                        value: true,
                      },
                      reasonField,
                    ],
                  })
                }
              >
                <Plus size={16} />
                Assign task
              </button>
            )}
          </div>
          <TaskTable
            tasks={d.tasks}
            onOpen={async () => {}}
            onAction={(t, a) =>
              a === "complete"
                ? onDialog({
                    title: "Complete task",
                    endpoint: `/api/tasks/${t.id}/complete`,
                    base: { version: t.version },
                    fields: [
                      { ...evidenceField(d), required: t.requires_evidence },
                      reasonField,
                    ],
                  })
                : onTask(t, a)
            }
            canManage={can("QA", "System Administrator")}
          />
        </section>
      ) : (
        <section className="panel">
          <AuditTrail events={d.audit} />
        </section>
      )}
    </>
  );
}
