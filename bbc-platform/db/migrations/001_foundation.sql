CREATE TABLE sites (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text NOT NULL UNIQUE, name text NOT NULL);
CREATE TABLE customers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL);
CREATE TABLE projects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), site_id uuid NOT NULL REFERENCES sites, customer_id uuid REFERENCES customers, code text NOT NULL UNIQUE, title text NOT NULL);
CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text UNIQUE NOT NULL, name text NOT NULL, password_hash text NOT NULL, active boolean NOT NULL DEFAULT true, system_account boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE user_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users, role text NOT NULL CHECK (role IN ('Employee','Document Owner','Reviewer','Approver','QA','Investigator','Inventory Custodian','EHS Coordinator','System Administrator','System Worker')), site_id uuid REFERENCES sites, UNIQUE NULLS NOT DISTINCT(user_id,role,site_id));
CREATE TABLE access_scopes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users, site_id uuid NOT NULL REFERENCES sites, customer_id uuid REFERENCES customers, project_id uuid REFERENCES projects, record_id uuid, expires_at timestamptz, granted_by uuid REFERENCES users, reason text NOT NULL);
CREATE TABLE sessions (token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE login_attempts (email text PRIMARY KEY, failures integer NOT NULL DEFAULT 0, blocked_until timestamptz);
CREATE TABLE records (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), kind text NOT NULL CHECK(kind IN ('Document','Deviation','CAPA','Change','Audit','Questionnaire','Answer','Material','EHS')), site_id uuid NOT NULL REFERENCES sites, customer_id uuid REFERENCES customers, project_id uuid REFERENCES projects, title text NOT NULL, created_by uuid NOT NULL REFERENCES users, created_at timestamptz NOT NULL DEFAULT now(), archived boolean NOT NULL DEFAULT false);
ALTER TABLE access_scopes ADD FOREIGN KEY(record_id) REFERENCES records;
CREATE FUNCTION actor_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.actor_id',true),'')::uuid $$;
CREATE FUNCTION has_scope(u uuid, s uuid, c uuid, p uuid, r uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM access_scopes g JOIN users x ON x.id=g.user_id WHERE x.active AND g.user_id=u AND g.site_id=s AND (g.customer_id IS NULL OR g.customer_id=c) AND (g.project_id IS NULL OR g.project_id=p) AND (g.record_id IS NULL OR g.record_id=r) AND (g.expires_at IS NULL OR g.expires_at>now()))
$$;
CREATE FUNCTION can_record(r uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT EXISTS(SELECT 1 FROM records WHERE id=r AND has_scope(actor_id(),site_id,customer_id,project_id,id)) $$;
CREATE FUNCTION user_can_record(u uuid,r uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT EXISTS(SELECT 1 FROM records WHERE id=r AND has_scope(u,site_id,customer_id,project_id,id)) $$;
CREATE TABLE workflow_rules (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, version integer NOT NULL, rules jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(name,version));
CREATE TABLE attachments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), record_id uuid NOT NULL REFERENCES records, filename text NOT NULL, media_type text NOT NULL, sha256 text NOT NULL CHECK(length(sha256)=64), storage_key text NOT NULL UNIQUE, size_bytes bigint NOT NULL CHECK(size_bytes>0), uploaded_by uuid NOT NULL REFERENCES users, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE documents (record_id uuid PRIMARY KEY REFERENCES records, number text UNIQUE NOT NULL, owner_id uuid NOT NULL REFERENCES users, department text NOT NULL, document_type text NOT NULL DEFAULT 'SOP');
CREATE TABLE revisions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), record_id uuid NOT NULL REFERENCES documents, number integer NOT NULL, title text NOT NULL, change_reason text NOT NULL, status text NOT NULL DEFAULT 'Draft' CHECK(status IN ('Draft','In Review','Approved','Effective','Superseded','Obsolete')), file_id uuid REFERENCES attachments, workflow_id uuid NOT NULL REFERENCES workflow_rules, review_due date, effective_after timestamptz, effective_at timestamptz, archive_status text NOT NULL DEFAULT 'Pending' CHECK(archive_status IN ('Pending','Complete','Failed')), signing_mode text NOT NULL DEFAULT 'Internal' CHECK(signing_mode IN ('Internal','External')), training_mode text NOT NULL CHECK(training_mode IN ('None','Read acknowledgement','Instructor led','Competency')), training_before_effective boolean NOT NULL DEFAULT true, trainee_ids uuid[] NOT NULL DEFAULT '{}', reviewer_id uuid REFERENCES users, approver_id uuid REFERENCES users, version integer NOT NULL DEFAULT 1, created_by uuid NOT NULL REFERENCES users, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(record_id,number));
CREATE UNIQUE INDEX one_active_revision ON revisions(record_id) WHERE status='Effective';
CREATE UNIQUE INDEX one_working_revision ON revisions(record_id) WHERE status IN ('Draft','In Review','Approved');
CREATE TABLE approvals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), record_id uuid NOT NULL REFERENCES records, revision_id uuid NOT NULL REFERENCES revisions, action text NOT NULL CHECK(action IN ('Review','Approve','Return')), actor_id uuid NOT NULL REFERENCES users, file_id uuid NOT NULL REFERENCES attachments, file_hash text NOT NULL, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE training (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), record_id uuid NOT NULL REFERENCES documents, revision_id uuid NOT NULL REFERENCES revisions, user_id uuid NOT NULL REFERENCES users, method text NOT NULL, status text NOT NULL DEFAULT 'Assigned' CHECK(status IN ('Assigned','Complete','Cancelled')), evidence_id uuid REFERENCES attachments, completion_note text, completed_by uuid REFERENCES users, completed_at timestamptz, UNIQUE(revision_id,user_id));
CREATE TABLE tasks (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), record_id uuid NOT NULL REFERENCES records, revision_id uuid REFERENCES revisions, training_id uuid REFERENCES training, kind text NOT NULL CHECK(kind IN ('Review','Approve','Training','Follow-up','Delivery','Periodic review','Effectiveness')), title text NOT NULL, assignee_id uuid NOT NULL REFERENCES users, due_at timestamptz NOT NULL, status text NOT NULL DEFAULT 'Open' CHECK(status IN ('Open','Complete','Cancelled')), completion_condition text NOT NULL, evidence_id uuid REFERENCES attachments, completion_note text, completed_at timestamptz, version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE audit_events (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, record_id uuid REFERENCES records, entity text NOT NULL, entity_id text NOT NULL, actor_id uuid REFERENCES users, action text NOT NULL, reason text, before_data jsonb, after_data jsonb, occurred_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE idempotency (actor_id uuid NOT NULL REFERENCES users, key uuid NOT NULL, fingerprint text NOT NULL, response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(actor_id,key));
CREATE TABLE notification_outbox (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), record_id uuid NOT NULL REFERENCES records, task_id uuid NOT NULL REFERENCES tasks, recipient_id uuid NOT NULL REFERENCES users, dedupe_key text UNIQUE NOT NULL, status text NOT NULL DEFAULT 'Pending' CHECK(status IN ('Pending','Delivered','Failed','Cancelled')), attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(), last_error text, delivered_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE notifications (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), record_id uuid NOT NULL REFERENCES records, outbox_id uuid NOT NULL UNIQUE REFERENCES notification_outbox, recipient_id uuid NOT NULL REFERENCES users, message text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), read_at timestamptz);
CREATE TABLE worker_runs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, delivered integer NOT NULL DEFAULT 0, failed integer NOT NULL DEFAULT 0, error text);
CREATE FUNCTION audit_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE oldj jsonb; newj jsonb; rid uuid; eid text;
BEGIN
 oldj := CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END;
 newj := CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END;
 rid := CASE WHEN TG_TABLE_NAME='records' THEN (coalesce(newj,oldj)->>'id')::uuid ELSE (coalesce(newj,oldj)->>'record_id')::uuid END;
 eid := coalesce(coalesce(newj,oldj)->>'id',coalesce(newj,oldj)->>'record_id');
 INSERT INTO audit_events(record_id,entity,entity_id,actor_id,action,reason,before_data,after_data)
 VALUES(rid,TG_TABLE_NAME,eid,actor_id(),coalesce(nullif(current_setting('app.action',true),''),TG_OP),nullif(current_setting('app.reason',true),''), oldj-'password_hash',newj-'password_hash');
 RETURN coalesce(NEW,OLD);
END $$;
CREATE FUNCTION immutable_row() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Append-only record: corrections must be new records'; END $$;
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE TRIGGER approvals_immutable BEFORE UPDATE OR DELETE ON approvals FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE TRIGGER attachments_immutable BEFORE UPDATE OR DELETE ON attachments FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE TRIGGER rules_immutable BEFORE UPDATE OR DELETE ON workflow_rules FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE FUNCTION lock_revision_content() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.status <> 'Draft' AND (NEW.file_id,NEW.title,NEW.change_reason,NEW.workflow_id,NEW.training_mode,NEW.training_before_effective,NEW.trainee_ids,NEW.signing_mode) IS DISTINCT FROM (OLD.file_id,OLD.title,OLD.change_reason,OLD.workflow_id,OLD.training_mode,OLD.training_before_effective,OLD.trainee_ids,OLD.signing_mode) THEN RAISE EXCEPTION 'Revision content is frozen; create a new revision or return to draft first'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER revision_content_guard BEFORE UPDATE ON revisions FOR EACH ROW EXECUTE FUNCTION lock_revision_content();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['records','attachments','documents','revisions','approvals','training','tasks'] LOOP
 EXECUTE format('CREATE TRIGGER business_audit AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_change()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['users','user_roles','access_scopes'] LOOP
 EXECUTE format('CREATE TRIGGER identity_audit AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_change()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['attachments','documents','revisions','approvals','training','tasks','notification_outbox','notifications'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY record_scope ON %I USING(can_record(record_id)) WITH CHECK(can_record(record_id))',t);
 END LOOP;
END $$;
ALTER TABLE records ENABLE ROW LEVEL SECURITY;
CREATE POLICY record_scope ON records USING(has_scope(actor_id(),site_id,customer_id,project_id,id)) WITH CHECK(has_scope(actor_id(),site_id,customer_id,project_id,id));
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_scope ON audit_events FOR SELECT USING((record_id IS NOT NULL AND can_record(record_id)) OR (record_id IS NULL AND EXISTS(SELECT 1 FROM user_roles WHERE user_id=actor_id() AND role='System Administrator')));
ALTER TABLE idempotency ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_request ON idempotency USING(actor_id=public.actor_id()) WITH CHECK(actor_id=public.actor_id());
CREATE INDEX scope_user ON access_scopes(user_id,site_id);
CREATE INDEX revision_record ON revisions(record_id);
CREATE INDEX task_queue ON tasks(status,due_at);
CREATE INDEX audit_record ON audit_events(record_id,id DESC);
CREATE INDEX record_site_kind ON records(site_id,kind);
CREATE INDEX session_expiry ON sessions(expires_at);
