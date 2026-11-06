export interface User {
  id: string;
  name: string;
  email: string;
  active: boolean;
}
export interface RecordItem {
  id: string;
  kind: string;
  site_id: string;
  customer_id: string | null;
  project_id: string | null;
  title: string;
  created_by: string;
  status: string;
  number: string;
  site_code: string;
  site_name?: string;
  customer_name?: string;
  project_code?: string;
  version: number;
  created_at: string;
}
export interface Task {
  id: string;
  record_id: string;
  record_title: string;
  record_kind: string;
  revision_id: string | null;
  training_id: string | null;
  kind: string;
  title: string;
  assignee_id: string;
  assignee_name: string;
  assignee_active: boolean;
  due_at: string;
  status: string;
  completion_condition: string;
  requires_evidence: boolean;
  version: number;
}
export interface Overview {
  actor: {
    id: string;
    name: string;
    email: string;
    roles: { role: string; site_id: string | null }[];
  };
  records: RecordItem[];
  tasks: Task[];
  sites: { id: string; code: string; name: string }[];
  projects: {
    id: string;
    code: string;
    title: string;
    site_id: string;
    customer_id: string | null;
    customer_name: string;
  }[];
  users: User[];
  locations: { id: string; name: string }[];
  notifications: { id: string; message: string; record_id: string }[];
  userRoles: { user_id: string; role: string; site_id: string | null }[];
  environment: string;
  worker: { finished_at: string; delivered: number; failed: number } | null;
  integrations: Record<string, string>;
}
export interface Revision {
  id: string;
  record_id: string;
  number: number;
  title: string;
  status: string;
  version: number;
  file_id: string | null;
  filename: string;
  sha256: string;
  change_reason: string;
  training_mode: string;
  training_before_effective: boolean;
  archive_status: string;
  signing_mode: string;
  review_due: string;
  workflow_version: number;
  reviewer_id: string;
  approver_id: string;
}
export interface Attachment {
  id: string;
  filename: string;
  sha256: string;
  size_bytes: string;
  created_at: string;
}
export interface Training {
  id: string;
  user_id: string;
  trainee_name: string;
  method: string;
  status: string;
  revision_number: number;
  completed_at: string | null;
  confirmer_name: string | null;
}
export interface AuditEvent {
  id: string;
  action: string;
  entity: string;
  reason: string;
  actor_name: string;
  occurred_at: string;
  before_data: unknown;
  after_data: unknown;
}
export interface Container {
  id: string;
  label: string;
  quantity: string;
  reserved: string;
  unit: string;
  status: string;
  lot_status: string;
  lot_number: string;
  location_name: string;
  version: number;
  parent_id: string | null;
  passage: number | null;
  freeze_thaw_count: number;
}
export interface Lot {
  id: string;
  lot_number: string;
  status: string;
  expires_on: string;
  version: number;
}
export interface Finding {
  id: string;
  description: string;
  grade: string;
  owner_name: string;
  status: string;
  version: number;
}
export interface Detail {
  record: RecordItem;
  data: Record<string, unknown>;
  revisions?: Revision[];
  trainingRequirements?: {
    id: string;
    role: string;
    due_days: number;
    active: boolean;
  }[];
  attachments: Attachment[];
  tasks: Task[];
  audit: AuditEvent[];
  links: { id: string; related_title: string; related_kind: string }[];
  training?: Training[];
  approvals?: {
    id: string;
    action: string;
    actor_name: string;
    file_hash: string;
    created_at: string;
    cycle: number;
  }[];
  lots?: Lot[];
  containers?: Container[];
  transactions?: {
    id: string;
    operation: string;
    delta: string;
    balance_after: string;
    unit: string;
    container_label: string;
    reason: string;
    actor_name: string;
    created_at: string;
  }[];
  questions?: {
    id: string;
    version: number;
    assignee_id: string;
    answer_id: string | null;
    question: string;
    draft_answer: string;
    promised_document: string;
  }[];
  submissions?: { id: string; snapshot: unknown; created_at: string }[];
  findings?: Finding[];
}
export interface Field {
  name: string;
  label: string;
  type?:
    | "text"
    | "textarea"
    | "select"
    | "date"
    | "datetime-local"
    | "number"
    | "checkbox"
    | "password"
    | "multiselect";
  options?: { value: string; label: string }[];
  value?: string | number | boolean | string[];
  required?: boolean;
  hint?: string;
}
export interface DialogConfig {
  title: string;
  description?: string;
  endpoint: string;
  fields: Field[];
  base?: Record<string, unknown>;
}
