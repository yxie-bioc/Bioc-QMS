import { getPool, transaction, one, must, type Tx } from "./core";
export async function runWorker(adapter: "in-app" | "test-fail" = "in-app") {
  if (adapter === "test-fail")
    must(process.env.APP_ENV === "test", "Failure adapter is test-only");
  const system = (
    await getPool().query(
      "SELECT id FROM users WHERE system_account AND active LIMIT 1",
    )
  ).rows[0];
  must(system, "No worker service identity", 503);
  return transaction(
    system.id,
    "Notification.run",
    "Scheduled server task",
    async (db) => {
      const lock = await one<{ ok: boolean }>(
        db,
        "SELECT pg_try_advisory_xact_lock(420918) ok",
      );
      if (!lock.ok) return { delivered: 0, failed: 0, skipped: true };
      const run = await one<{ id: string }>(
        db,
        "INSERT INTO worker_runs DEFAULT VALUES RETURNING id",
      );
      await db.query(`INSERT INTO notification_outbox(record_id,task_id,recipient_id,dedupe_key)
 SELECT t.record_id,t.id,t.assignee_id,t.id::text||':'||t.assignee_id::text||':'||current_date::text FROM tasks t JOIN users u ON u.id=t.assignee_id
 WHERE t.status='Open' AND t.due_at<now()+interval '2 days' AND u.active AND user_can_record(t.assignee_id,t.record_id)
 ON CONFLICT(dedupe_key) DO NOTHING`);
      await db.query(
        "UPDATE approved_answers a SET status='Needs Review',version=version+1 WHERE a.status='Approved' AND (a.valid_until<current_date OR (a.source_revision_id IS NOT NULL AND EXISTS(SELECT 1 FROM revisions v WHERE v.id=a.source_revision_id AND v.status<>'Effective')))",
      );
      const items = await db.query<{
        id: string;
        record_id: string;
        task_id: string;
        recipient_id: string;
        attempts: number;
      }>(
        "SELECT * FROM notification_outbox WHERE status IN ('Pending','Failed') AND attempts<8 AND next_attempt_at<=now() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 100",
      );
      let delivered = 0,
        failed = 0;
      for (const n of items.rows) {
        await db.query("SAVEPOINT notification_delivery");
        try {
          const task = await one<{
            title: string;
            status: string;
            assignee_id: string;
          }>(db, "SELECT title,status,assignee_id FROM tasks WHERE id=$1", [
            n.task_id,
          ]);
          const valid = await one<{ ok: boolean }>(
            db,
            "SELECT user_can_record($1,$2) ok",
            [n.recipient_id, n.record_id],
          );
          if (
            task.status !== "Open" ||
            task.assignee_id !== n.recipient_id ||
            !valid.ok
          ) {
            await db.query(
              "UPDATE notification_outbox SET status='Cancelled',last_error='Task or recipient access changed' WHERE id=$1",
              [n.id],
            );
            continue;
          }
          if (adapter === "test-fail")
            throw new Error("Simulated delivery failure");
          await db.query(
            "INSERT INTO notifications(record_id,outbox_id,recipient_id,message) VALUES($1,$2,$3,$4) ON CONFLICT(outbox_id) DO NOTHING",
            [n.record_id, n.id, n.recipient_id, `Task due: ${task.title}`],
          );
          await db.query(
            "UPDATE notification_outbox SET status='Delivered',attempts=attempts+1,delivered_at=now(),last_error=NULL WHERE id=$1",
            [n.id],
          );
          delivered++;
        } catch (e) {
          await db.query("ROLLBACK TO SAVEPOINT notification_delivery");
          await db.query(
            "UPDATE notification_outbox SET status='Failed',attempts=attempts+1,last_error=$1,next_attempt_at=now()+(least(3600,power(2,attempts+1)*30)||' seconds')::interval WHERE id=$2",
            [
              e instanceof Error ? e.message.slice(0, 300) : "Delivery failed",
              n.id,
            ],
          );
          failed++;
        }
      }
      await db.query(
        "UPDATE worker_runs SET finished_at=now(),delivered=$1,failed=$2 WHERE id=$3",
        [delivered, failed, run.id],
      );
      return { delivered, failed, skipped: false };
    },
  );
}
