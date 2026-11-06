ALTER TABLE tasks ADD COLUMN question_id uuid REFERENCES questions;
ALTER TABLE tasks DROP CONSTRAINT tasks_kind_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_kind_check CHECK(kind IN ('Review','Approve','Training','Follow-up','Delivery','Periodic review','Effectiveness','Question'));
CREATE INDEX question_assignment ON questions(assignee_id,record_id);
CREATE INDEX outbox_retry ON notification_outbox(status,next_attempt_at) WHERE status IN ('Pending','Failed');
