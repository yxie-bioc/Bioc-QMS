CREATE TABLE training_requirements (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), record_id uuid NOT NULL REFERENCES documents, role text NOT NULL CHECK(role IN ('Employee','Document Owner','Reviewer','Approver','QA','Investigator','Inventory Custodian','EHS Coordinator')), due_days integer NOT NULL CHECK(due_days BETWEEN 1 AND 365), active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1, UNIQUE(record_id,role));
ALTER TABLE training_requirements ENABLE ROW LEVEL SECURITY;
CREATE POLICY record_scope ON training_requirements USING(can_record(record_id)) WITH CHECK(can_record(record_id));
CREATE TRIGGER business_audit AFTER INSERT OR UPDATE OR DELETE ON training_requirements FOR EACH ROW EXECUTE FUNCTION audit_change();
GRANT SELECT,INSERT,UPDATE ON training_requirements TO bbc_runtime;
ALTER TABLE revisions ADD COLUMN training_policy_snapshot jsonb NOT NULL DEFAULT '[]';
CREATE OR REPLACE FUNCTION lock_revision_content() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.status <> 'Draft' AND (NEW.file_id,NEW.title,NEW.change_reason,NEW.workflow_id,NEW.training_mode,NEW.training_before_effective,NEW.trainee_ids,NEW.signing_mode,NEW.training_policy_snapshot) IS DISTINCT FROM (OLD.file_id,OLD.title,OLD.change_reason,OLD.workflow_id,OLD.training_mode,OLD.training_before_effective,OLD.trainee_ids,OLD.signing_mode,OLD.training_policy_snapshot) THEN RAISE EXCEPTION 'Revision content is frozen; create a new revision or return to draft first'; END IF;
 RETURN NEW;
END $$;
