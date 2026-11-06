import { mkdir, writeFile, readFile, chmod } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  transaction,
  one,
  getRecord,
  requireRole,
  must,
  sha,
  evidence,
  type Tx,
  type Actor,
} from "./core";
export interface FileRow {
  id: string;
  record_id: string;
  filename: string;
  media_type: string;
  sha256: string;
  storage_key: string;
  size_bytes: string;
  uploaded_by: string;
}
export const attachmentRoot = () =>
  resolve(
    /* turbopackIgnore: true */ process.env.ATTACHMENT_DIR ??
      "./var/attachments",
  );
export async function readBytes(f: FileRow) {
  must(/^[a-f0-9-]{36}$/.test(f.storage_key), "Invalid storage key", 500);
  const b = await readFile(
    /* turbopackIgnore: true */ join(
      /* turbopackIgnore: true */ attachmentRoot(),
      f.storage_key,
    ),
  );
  must(
    sha(b) === f.sha256,
    "Attachment integrity check failed. Contact QA.",
    503,
  );
  return b;
}
export async function upload(
  actorId: string,
  recordId: string,
  file: File,
  revisionId?: string,
  expectedVersion?: number,
) {
  must(
    file.size > 0 && file.size <= 10 * 1024 * 1024,
    "File must be between 1 byte and 10 MB",
    400,
  );
  const bytes = Buffer.from(await file.arrayBuffer());
  const pdf = bytes.subarray(0, 5).toString() === "%PDF-";
  const docx =
    file.name.toLowerCase().endsWith(".docx") &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b;
  must(pdf || docx, "Upload a PDF or DOCX file", 400);
  const name = file.name.replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 160);
  return transaction(
    actorId,
    "File.upload",
    "Uploaded a private, version-bound attachment",
    async (db, a) => {
      const r = await getRecord(db, recordId);
      requireRole(
        a,
        [
          "Document Owner",
          "QA",
          "Investigator",
          "Inventory Custodian",
          "EHS Coordinator",
          "Reviewer",
        ],
        r.site_id,
      );
      if (revisionId) {
        requireRole(a, ["Document Owner", "QA"], r.site_id);
        const rev = await one<{
          status: string;
          record_id: string;
          version: number;
          owner_id: string;
        }>(
          db,
          "SELECT v.*,d.owner_id FROM revisions v JOIN documents d ON d.record_id=v.record_id WHERE v.id=$1 FOR UPDATE OF v",
          [revisionId],
        );
        must(
          rev.record_id === recordId && rev.status === "Draft",
          "Only a draft revision can receive new content",
        );
        must(
          rev.version === expectedVersion,
          "Revision changed; refresh before uploading",
        );
        must(
          a.id === rev.owner_id ||
            a.roles.some((g) => g.role === "QA" && g.site_id === r.site_id),
          "Only the owner or site QA can change the draft",
          403,
        );
      }
      const id = randomUUID();
      await mkdir(attachmentRoot(), { recursive: true, mode: 0o700 });
      await writeFile(
        join(/* turbopackIgnore: true */ attachmentRoot(), id),
        bytes,
        { flag: "wx", mode: 0o600 },
      );
      await chmod(
        join(/* turbopackIgnore: true */ attachmentRoot(), id),
        0o440,
      );
      const f = await one<FileRow>(
        db,
        "INSERT INTO attachments(id,record_id,filename,media_type,sha256,storage_key,size_bytes,uploaded_by) VALUES($1,$2,$3,$4,$5,$8,$6,$7) RETURNING *",
        [
          id,
          recordId,
          name,
          pdf
            ? "application/pdf"
            : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          sha(bytes),
          bytes.length,
          a.id,
          id,
        ],
      );
      if (revisionId)
        await db.query(
          "UPDATE revisions SET file_id=$1,version=version+1 WHERE id=$2",
          [id, revisionId],
        );
      return { id: f.id, sha256: f.sha256, filename: f.filename };
    },
  );
}
export async function download(actorId: string, id: string) {
  return transaction(
    actorId,
    "File.download",
    "Private attachment download",
    async (db) => {
      const f = await one<FileRow>(
        db,
        "SELECT * FROM attachments WHERE id=$1",
        [id],
      );
      return { file: f, bytes: await readBytes(f) };
    },
  );
}
export async function verifyEvidence(db: Tx, id: string, recordId: string) {
  await evidence(db, id, recordId);
  const f = await one<FileRow>(db, "SELECT * FROM attachments WHERE id=$1", [
    id,
  ]);
  await readBytes(f);
  return f;
}
