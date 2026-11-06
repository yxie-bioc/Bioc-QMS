import { z } from "zod";
import {
  scopeInput,
  transaction,
  createRecord,
  getRecord,
  one,
  versioned,
  requireRole,
  must,
  uuid,
  text,
  reason,
  sha,
  Fault,
  evidence,
  type Tx,
  type Actor,
} from "./core";
const decimal = z
  .string()
  .regex(
    /^\d{1,13}(\.\d{1,6})?$/,
    "Use a non-negative decimal with at most 6 decimal places",
  );
const signedDecimal = z.string().regex(/^-?\d{1,13}(\.\d{1,6})?$/);
const unit = z.enum(["mL", "uL", "mg", "g", "vial", "each"]);
const materialSchema = scopeInput.extend({
  materialType: z.enum(["Chemical", "Cell", "Antibody", "Biological", "Other"]),
  ownership: z.enum(["BBC", "Client", "Third party"]),
  supplier: text,
  catalog: z.string().max(200).optional(),
  storageRequirements: text,
  cellIdentity: z.string().max(1000).optional(),
  clone: z.string().max(200).optional(),
  label: z.string().max(200).optional(),
  usageRestrictions: text.optional(),
  useRole: z.enum(["TA", "Reference", "Reagent", "Other"]).optional(),
});
export async function createMaterial(
  actorId: string,
  input: unknown,
  key: string,
) {
  const d = materialSchema.parse(input);
  return transaction(
    actorId,
    "Material.create",
    "Registered material; quantity is established only by receipt",
    async (db, a) => {
      requireRole(a, ["Inventory Custodian"], d.siteId);
      const r = await createRecord(db, a, "Material", d);
      await db.query(
        "INSERT INTO materials(record_id,material_type,ownership,supplier,catalog,storage_requirements,cell_identity,clone,label,usage_restrictions) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          r.id,
          d.materialType,
          d.ownership,
          d.supplier,
          d.catalog ?? null,
          d.storageRequirements,
          d.cellIdentity ?? null,
          d.clone ?? null,
          d.label ?? null,
          d.usageRestrictions ?? null,
        ],
      );
      if (d.useRole) {
        must(d.projectId, "A use identity such as TA requires a project", 400);
        await db.query(
          "INSERT INTO material_uses(record_id,project_id,role) VALUES($1,$2,$3)",
          [r.id, d.projectId, d.useRole],
        );
      }
      return { id: r.id };
    },
    { key, fingerprint: sha(JSON.stringify(d)) },
  );
}
async function validLocation(db: Tx, id: string, site: string) {
  const l = await one<{ site_id: string }>(
    db,
    "SELECT site_id FROM locations WHERE id=$1",
    [id],
  );
  must(l.site_id === site, "Location belongs to a different site", 400);
}
async function validProject(
  db: Tx,
  id: string | undefined,
  site: string,
  customer: string | null,
  recordProject: string | null,
) {
  must(id, "Actual use project is required", 400);
  const p = await one<{ site_id: string; customer_id: string | null }>(
    db,
    "SELECT site_id,customer_id FROM projects WHERE id=$1",
    [id],
  );
  must(
    p.site_id === site &&
      (!customer || p.customer_id === customer) &&
      (!recordProject || recordProject === id),
    "Use project does not match material scope",
  );
  must(
    (
      await one<{ ok: boolean }>(
        db,
        "SELECT has_scope(actor_id(),$1,$2,$3,NULL) ok",
        [site, p.customer_id, id],
      )
    ).ok,
    "No access to actual use project",
    403,
  );
}
async function ledger(
  db: Tx,
  a: Actor,
  r: string,
  container: string,
  operation: string,
  delta: string,
  why: string,
  project: string | null = null,
  related: string | null = null,
) {
  await db.query(
    "INSERT INTO inventory_transactions(record_id,container_id,operation,delta,balance_after,unit,project_id,related_container_id,location_id,actor_id,reason,reserved_after) SELECT $1,id,$2,$3,quantity,unit,$4,$5,location_id,$6,$7,reserved FROM containers WHERE id=$8",
    [r, operation, delta, project, related, a.id, why, container],
  );
}
export async function receiveLot(
  actorId: string,
  id: string,
  input: unknown,
  key: string,
) {
  const d = z
    .object({
      lotNumber: text,
      expiresOn: z.iso.date(),
      quantity: decimal,
      unit,
      locationId: uuid,
      containerLabel: text,
      coaId: uuid.optional(),
      sdsId: uuid.optional(),
      concentration: z.string().max(200).optional(),
      passage: z.number().int().nonnegative().optional(),
      reason,
    })
    .parse(input);
  return transaction(
    actorId,
    "Inventory.receive",
    d.reason,
    async (db, a) => {
      const r = await getRecord(db, id, "Material");
      requireRole(a, ["Inventory Custodian"], r.site_id);
      await validLocation(db, d.locationId, r.site_id);
      must(Number(d.quantity) > 0, "Receipt quantity must be positive", 400);
      if (["vial", "each"].includes(d.unit))
        must(
          Number.isInteger(Number(d.quantity)),
          "Count units require a whole number",
          400,
        );
      if (d.coaId) await evidence(db, d.coaId, id);
      if (d.sdsId) await evidence(db, d.sdsId, id);
      const lot = await one<{ id: string }>(
        db,
        "INSERT INTO lots(record_id,lot_number,expires_on,coa_id,sds_id,concentration) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",
        [
          id,
          d.lotNumber,
          d.expiresOn,
          d.coaId ?? null,
          d.sdsId ?? null,
          d.concentration ?? null,
        ],
      );
      const c = await one<{ id: string }>(
        db,
        "INSERT INTO containers(record_id,lot_id,label,location_id,unit,quantity,passage) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id",
        [
          id,
          lot.id,
          d.containerLabel,
          d.locationId,
          d.unit,
          d.quantity,
          d.passage ?? null,
        ],
      );
      await ledger(db, a, id, c.id, "Receive", d.quantity, d.reason);
      return { id, lotId: lot.id, containerId: c.id };
    },
    { key, fingerprint: sha(JSON.stringify([id, d])) },
  );
}
export async function lotAction(
  actorId: string,
  id: string,
  action: string,
  input: unknown,
  key: string,
) {
  const d = z
    .object({ version: z.number().int().positive(), reason })
    .parse(input);
  return transaction(
    actorId,
    `Inventory.${action}`,
    d.reason,
    async (db, a) => {
      const lot = await versioned<{
        record_id: string;
        version: number;
        status: string;
        expires_on: string;
      }>(db, "lots", id, d.version, "id");
      const r = await getRecord(db, lot.record_id, "Material");
      requireRole(a, ["Inventory Custodian"], r.site_id);
      must(["release", "hold"].includes(action), "Unsupported lot action", 400);
      if (action === "release") {
        must(lot.status === "On Hold", "Only held lots may be released");
        must(
          new Date(lot.expires_on + "T23:59:59Z") >= new Date(),
          "Lot has expired",
        );
      } else must(lot.status === "Released", "Only released lots may be held");
      await db.query(
        "UPDATE lots SET status=$1,version=version+1 WHERE id=$2",
        [action === "release" ? "Released" : "On Hold", id],
      );
      return { id: r.id };
    },
    { key, fingerprint: sha(JSON.stringify([id, action, d])) },
  );
}
interface Container {
  id: string;
  record_id: string;
  lot_id: string;
  parent_id: string | null;
  label: string;
  location_id: string;
  unit: string;
  quantity: string;
  reserved: string;
  status: string;
  version: number;
  passage: number | null;
}
export async function containerAction(
  actorId: string,
  id: string,
  action: string,
  input: unknown,
  key: string,
) {
  const d = z
    .object({
      version: z.number().int().positive(),
      reason,
      amount: decimal.optional(),
      delta: signedDecimal.optional(),
      unit: unit.optional(),
      projectId: uuid.optional(),
      locationId: uuid.optional(),
      label: text.optional(),
      passage: z.number().int().nonnegative().optional(),
    })
    .parse(input);
  return transaction(
    actorId,
    `Inventory.${action}`,
    d.reason,
    async (db, a) => {
      const c = await versioned<Container>(
        db,
        "containers",
        id,
        d.version,
        "id",
      );
      const r = await getRecord(db, c.record_id, "Material");
      requireRole(a, ["Inventory Custodian"], r.site_id);
      must(c.status !== "Disposed", "Container is disposed");
      const lot = await one<{ status: string; expires_on: string }>(
        db,
        "SELECT status,expires_on FROM lots WHERE id=$1 FOR UPDATE",
        [c.lot_id],
      );
      if (["use", "aliquot", "reserve"].includes(action)) {
        must(lot.status === "Released", "Lot is on hold or disposed");
        must(
          new Date(lot.expires_on + "T23:59:59Z") >= new Date(),
          "Lot expired",
        );
      }
      if (
        ["use", "aliquot", "reserve", "unreserve", "return", "adjust"].includes(
          action,
        )
      ) {
        must(
          d.unit === c.unit,
          "Units must exactly match the container; no implicit conversion",
          400,
        );
        const number = Number(d.amount ?? d.delta);
        must(
          Number.isFinite(number) && number !== 0,
          "Non-zero quantity required",
          400,
        );
        if (["vial", "each"].includes(c.unit))
          must(
            Number.isInteger(number),
            "Count units require a whole number",
            400,
          );
      }
      let operation = "",
        delta = "0",
        childId: string | null = null;
      if (action === "use") {
        await validProject(
          db,
          d.projectId,
          r.site_id,
          r.customer_id,
          r.project_id,
        );
        must(d.amount, "Use quantity required", 400);
        const ok = await db.query(
          "UPDATE containers SET quantity=quantity-$1::numeric WHERE id=$2 AND quantity-reserved>=$1::numeric RETURNING id",
          [d.amount, id],
        );
        must(ok.rowCount, "Insufficient unreserved quantity");
        operation = "Use";
        delta = `-${d.amount}`;
      } else if (action === "aliquot") {
        must(
          d.amount && d.label && d.locationId,
          "Quantity, child label and location required",
          400,
        );
        must(
          d.passage === undefined || d.passage === c.passage,
          "Aliquoting does not change passage; a culture workflow is required",
          400,
        );
        await validLocation(db, d.locationId, r.site_id);
        const ok = await db.query(
          "UPDATE containers SET quantity=quantity-$1::numeric WHERE id=$2 AND quantity-reserved>=$1::numeric RETURNING id",
          [d.amount, id],
        );
        must(ok.rowCount, "Insufficient unreserved quantity");
        const child = await one<{ id: string }>(
          db,
          "INSERT INTO containers(record_id,lot_id,parent_id,label,location_id,unit,quantity,passage) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
          [
            r.id,
            c.lot_id,
            id,
            d.label,
            d.locationId,
            c.unit,
            d.amount,
            d.passage ?? c.passage,
          ],
        );
        childId = child.id;
        await ledger(
          db,
          a,
          r.id,
          child.id,
          "Aliquot in",
          d.amount,
          d.reason,
          null,
          id,
        );
        operation = "Aliquot out";
        delta = `-${d.amount}`;
      } else if (action === "reserve" || action === "unreserve") {
        must(d.amount, "Quantity required", 400);
        const ok = await db.query(
          action === "reserve"
            ? "UPDATE containers SET reserved=reserved+$1::numeric WHERE id=$2 AND quantity-reserved>=$1::numeric RETURNING id"
            : "UPDATE containers SET reserved=reserved-$1::numeric WHERE id=$2 AND reserved>=$1::numeric RETURNING id",
          [d.amount, id],
        );
        must(ok.rowCount, "Reservation exceeds available or reserved quantity");
        operation = action === "reserve" ? "Reserve" : "Unreserve";
      } else if (action === "adjust") {
        must(d.delta, "Signed adjustment required", 400);
        const ok = await db.query(
          "UPDATE containers SET quantity=quantity+$1::numeric WHERE id=$2 AND quantity+$1::numeric>=reserved RETURNING id",
          [d.delta, id],
        );
        must(
          ok.rowCount,
          "Adjustment would create negative or over-reserved stock",
        );
        operation = "Adjust";
        delta = d.delta;
      } else if (action === "return") {
        must(d.amount, "Return amount required", 400);
        await validProject(
          db,
          d.projectId,
          r.site_id,
          r.customer_id,
          r.project_id,
        );
        const ok = await db.query(
          `UPDATE containers SET quantity=quantity+$1::numeric WHERE id=$2 AND $1::numeric <= (SELECT coalesce(sum(CASE WHEN operation='Use' THEN -delta WHEN operation='Return' THEN -delta ELSE 0 END),0) FROM inventory_transactions WHERE container_id=$2 AND project_id=$3) RETURNING id`,
          [d.amount, id, d.projectId],
        );
        must(ok.rowCount, "Return exceeds recorded use for this project");
        await db.query(
          "UPDATE lots SET status='On Hold',version=version+1 WHERE id=$1",
          [c.lot_id],
        );
        operation = "Return";
        delta = d.amount;
      } else if (action === "move") {
        must(d.locationId, "Destination required", 400);
        await validLocation(db, d.locationId, r.site_id);
        await db.query("UPDATE containers SET location_id=$1 WHERE id=$2", [
          d.locationId,
          id,
        ]);
        operation = "Move";
      } else if (action === "dispose") {
        must(Number(c.reserved) === 0, "Release reservations before disposal");
        delta = `-${c.quantity}`;
        await db.query(
          "UPDATE containers SET quantity=0,status='Disposed' WHERE id=$1",
          [id],
        );
        operation = "Dispose";
      } else if (action === "freeze-thaw") {
        await db.query(
          "UPDATE containers SET freeze_thaw_count=freeze_thaw_count+1 WHERE id=$1",
          [id],
        );
        operation = "Freeze thaw";
      } else if (action === "open") {
        await db.query(
          "UPDATE containers SET opened_at=coalesce(opened_at,now()) WHERE id=$1",
          [id],
        );
        operation = "Open";
      } else throw new Fault(400, "Unsupported inventory action");
      await db.query(
        "UPDATE containers SET version=version+1,status=CASE WHEN status='Disposed' THEN status WHEN quantity=0 THEN 'Depleted' ELSE 'Available' END WHERE id=$1",
        [id],
      );
      await ledger(
        db,
        a,
        r.id,
        id,
        operation,
        delta,
        d.reason,
        d.projectId ?? null,
        childId,
      );
      return { id: r.id, containerId: id, childId };
    },
    { key, fingerprint: sha(JSON.stringify([id, action, d])) },
  );
}
