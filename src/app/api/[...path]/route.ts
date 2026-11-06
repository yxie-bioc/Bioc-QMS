import { NextRequest, NextResponse } from "next/server";
import { z, ZodError } from "zod";
import {
  authenticate,
  login,
  logout,
  checkOrigin,
  manageUser,
} from "@/server/auth";
import { Fault, uuid, sha } from "@/server/core";
import {
  overview,
  listRecords,
  detail,
  auditLog,
  adminState,
  exportRecords,
} from "@/server/queries";
import {
  createDocument,
  reviseDocument,
  documentAction,
  completeTraining,
  configureTraining,
  editDraft,
} from "@/server/documents";
import { upload, download } from "@/server/files";
import { taskAction, createTask } from "@/server/tasks";
import {
  createQuality,
  qualityAction,
  findingAction,
  type QualityKind,
} from "@/server/quality";
import {
  createAnswer,
  answerAction,
  createQuestionnaire,
  addQuestion,
  questionnaireAction,
  updateQuestion,
} from "@/server/questionnaires";
import {
  createMaterial,
  receiveLot,
  lotAction,
  containerAction,
} from "@/server/inventory";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store, max-age=0" };
type Context = { params: Promise<{ path: string[] }> };
function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers });
}
function fail(e: unknown) {
  if (e instanceof ZodError)
    return json(
      {
        error: e.issues
          .map((x) => `${x.path.join(".")}: ${x.message}`)
          .join("; "),
      },
      400,
    );
  if (e instanceof Fault) return json({ error: e.message }, e.status);
  const code = typeof e === "object" && e && "code" in e ? String(e.code) : "";
  if (code === "23505")
    return json(
      { error: "A matching record already exists. Refresh before retrying." },
      409,
    );
  if (code === "42501")
    return json({ error: "Access denied by database policy" }, 403);
  if (code === "23514" || code === "23503")
    return json(
      {
        error:
          "The request violates a record relationship or quantity constraint",
      },
      409,
    );
  console.error("Request failed", {
    type: e instanceof Error ? e.name : "Unknown",
    code,
  });
  return json(
    {
      error:
        "The operation could not be completed. Contact the platform administrator.",
    },
    500,
  );
}
export async function GET(req: NextRequest, ctx: Context) {
  try {
    const p = (await ctx.params).path;
    const actor = await authenticate(req);
    if (p[0] === "overview") return json(await overview(actor));
    if (p[0] === "records" && p[1])
      return json(await detail(actor, uuid.parse(p[1])));
    if (["records", "search"].includes(p[0]))
      return json(
        await listRecords(
          actor,
          req.nextUrl.searchParams.get("q") ?? "",
          req.nextUrl.searchParams.get("kind") ?? "",
        ),
      );
    if (p[0] === "audit") return json(await auditLog(actor));
    if (p[0] === "admin") return json(await adminState(actor));
    if (p[0] === "attachments" && p[1]) {
      const { file, bytes } = await download(actor, uuid.parse(p[1]));
      return new NextResponse(new Uint8Array(bytes), {
        headers: {
          ...headers,
          "Content-Type": file.media_type,
          "Content-Disposition": `attachment; filename="${file.filename.replace(/["\\]/g, "_")}"`,
          "Content-Security-Policy": "default-src 'none'; sandbox",
        },
      });
    }
    if (p[0] === "export") {
      const rows = await exportRecords(
        actor,
        req.nextUrl.searchParams.get("q") ?? "",
        req.nextUrl.searchParams.get("kind") ?? "",
      );
      return new NextResponse(
        JSON.stringify(
          { exportedAt: new Date().toISOString(), records: rows },
          null,
          2,
        ),
        {
          headers: {
            ...headers,
            "Content-Type": "application/json",
            "Content-Disposition":
              'attachment; filename="bbc-record-export.json"',
          },
        },
      );
    }
    return json({ error: "Not found" }, 404);
  } catch (e) {
    return fail(e);
  }
}
export async function POST(req: NextRequest, ctx: Context) {
  try {
    checkOrigin(req);
    if (Number(req.headers.get("content-length") ?? 0) > 12 * 1024 * 1024)
      throw new Fault(413, "Request exceeds the upload limit");
    const p = (await ctx.params).path;
    if (p.join("/") === "auth/login") {
      const d = await req.json();
      const session = await login(d);
      const response = json({ ok: true });
      response.cookies.set("bbc_session", session.token, {
        httpOnly: true,
        sameSite: "strict",
        secure: process.env.COOKIE_SECURE === "true",
        path: "/",
        maxAge: 8 * 3600,
      });
      return response;
    }
    if (p.join("/") === "auth/logout") {
      await logout(req);
      const response = json({ ok: true });
      response.cookies.set("bbc_session", "", {
        httpOnly: true,
        sameSite: "strict",
        secure: process.env.COOKIE_SECURE === "true",
        path: "/",
        maxAge: 0,
      });
      return response;
    }
    const actor = await authenticate(req);
    const key = uuid.parse(req.headers.get("idempotency-key"));
    if (p[0] === "attachments") {
      const form = await req.formData();
      const f = form.get("file");
      if (!(f instanceof File)) throw new Fault(400, "File required");
      return json(
        await upload(
          actor,
          uuid.parse(form.get("recordId")),
          f,
          form.get("revisionId")
            ? uuid.parse(form.get("revisionId"))
            : undefined,
          form.get("version") ? Number(form.get("version")) : undefined,
        ),
      );
    }
    const d = await req.json();
    const id = p[1] ? uuid.safeParse(p[1]) : null;
    if (p[0] === "documents" && p.length === 1)
      return json(await createDocument(actor, d, key));
    if (p[0] === "documents" && id?.success && p[2] === "draft")
      return json(await editDraft(actor, id.data, d, key));
    if (p[0] === "documents" && id?.success && p[2] === "revise")
      return json(await reviseDocument(actor, id.data, d, key));
    if (p[0] === "documents" && id?.success && p[2] === "training-rule")
      return json(await configureTraining(actor, id.data, d, key));
    if (p[0] === "revisions" && id?.success && p[2])
      return json(await documentAction(actor, id.data, p[2], d, key));
    if (p[0] === "training" && id?.success && p[2] === "complete")
      return json(await completeTraining(actor, id.data, d, key));
    if (p[0] === "tasks" && p.length === 1)
      return json(await createTask(actor, d, key));
    if (p[0] === "tasks" && id?.success && p[2])
      return json(await taskAction(actor, id.data, p[2], d, key));
    const kinds: Record<string, QualityKind> = {
      deviations: "Deviation",
      capas: "CAPA",
      changes: "Change",
      audits: "Audit",
      ehs: "EHS",
    };
    if (kinds[p[0]] && p.length === 1)
      return json(await createQuality(actor, kinds[p[0]], d, key));
    if (p[0] === "quality" && id?.success && p[2])
      return json(await qualityAction(actor, id.data, p[2], d, key));
    if (p[0] === "findings" && id?.success && p[2])
      return json(await findingAction(actor, id.data, p[2], d, key));
    if (p[0] === "answers" && p.length === 1)
      return json(await createAnswer(actor, d, key));
    if (p[0] === "answers" && id?.success && p[2])
      return json(await answerAction(actor, id.data, p[2], d, key));
    if (p[0] === "questionnaires" && p.length === 1)
      return json(await createQuestionnaire(actor, d, key));
    if (p[0] === "questionnaires" && id?.success && p[2] === "questions")
      return json(await addQuestion(actor, id.data, d, key));
    if (p[0] === "questionnaires" && id?.success && p[2])
      return json(await questionnaireAction(actor, id.data, p[2], d, key));
    if (p[0] === "questions" && id?.success && p[2] === "update")
      return json(await updateQuestion(actor, id.data, d, key));
    if (p[0] === "materials" && p.length === 1)
      return json(await createMaterial(actor, d, key));
    if (p[0] === "materials" && id?.success && p[2] === "receive")
      return json(await receiveLot(actor, id.data, d, key));
    if (p[0] === "lots" && id?.success && p[2])
      return json(await lotAction(actor, id.data, p[2], d, key));
    if (p[0] === "containers" && id?.success && p[2])
      return json(await containerAction(actor, id.data, p[2], d, key));
    if (p[0] === "users" && p[1])
      return json(await manageUser(actor, p[1], d, key));
    return json({ error: "Unsupported business action" }, 404);
  } catch (e) {
    return fail(e);
  }
}
