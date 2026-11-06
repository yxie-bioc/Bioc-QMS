ALTER TABLE tasks ADD COLUMN finding_id uuid REFERENCES findings;
ALTER TABLE tasks DROP CONSTRAINT tasks_kind_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_kind_check CHECK(kind IN ('Review','Approve','Training','Follow-up','Delivery','Periodic review','Effectiveness','Question','Implementation','Finding','EHS review'));
UPDATE tasks SET kind='Implementation' WHERE kind='Follow-up' AND record_id IN (SELECT record_id FROM capas) AND title LIKE 'Implement CAPA%';
UPDATE tasks SET kind='EHS review' WHERE kind='Follow-up' AND record_id IN (SELECT record_id FROM ehs_records);
ALTER TABLE schema_migrations ADD COLUMN applied_by text NOT NULL DEFAULT current_user;
