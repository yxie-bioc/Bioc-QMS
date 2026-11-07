# Architecture and authority boundaries

## Windows portable revision (0.2.0)

The existing business application and PostgreSQL controls are retained. `packaging/` adds a production Next.js standalone bundle, pinned native Node/PostgreSQL binaries, a local Chinese maintenance controller, and an explicit local/LAN gateway. The browser remains the business client. Default listeners are loopback-only; LAN HTTPS uses company-managed certificates. Database owner credentials remain in maintenance, with distinct web and worker logins. Program versions, data instances, private attachments and backups are separate. See [Windows maintenance](WINDOWS_MAINTENANCE.md) for the process, Unicode-path, network and upgrade boundaries and [current status](STATUS.md) for executed verification.

## Original 0.1.0 decision: Next.js + TypeScript + PostgreSQL

The initial workspace was empty; no existing application or repository instructions were overwritten. Node.js was available, PostgreSQL/Docker services were not. We chose Next.js 16.4.5, React 19.3.1, strict TypeScript, Zod 4.6.7 and `pg` 8.23.1. Exact dependency versions are locked in `package-lock.json`. Frappe was considered, but its additional framework/runtime services and custom app infrastructure were unnecessary for this environment and these explicitly controlled business transitions. No parallel implementation was built.

The local-only development harness uses the `embedded-postgres` launcher package; it starts **native PostgreSQL 17.11**, not a SQL emulator. The launcher has a beta package version and is a development dependency. Company hosting uses conventional PostgreSQL 17.11. The web server and worker communicate over PostgreSQL connections; browser storage is not used for business persistence.

Cloudflare-only static/Worker hosting was not selected: this application needs conventional PostgreSQL connectivity, a private persistent filesystem and an independently running worker. No production deployment was authorized or performed.

## Code boundaries

| Path                                                                         | Responsibility                                                                                         |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `src/app/api/[...path]/route.ts`                                             | Session authentication, origin validation, Zod entrypoints, explicit command routing, safe HTTP errors |
| `src/server/core.ts`                                                         | Transactions, trusted actor context, scope checks, role requirements, optimistic versions, idempotency |
| `src/server/auth.ts`                                                         | Password verification, hashed session tokens, login throttling, identity administration                |
| `src/server/documents.ts`, `quality.ts`, `questionnaires.ts`, `inventory.ts` | Independent typed business objects and transitions                                                     |
| `src/server/files.ts`                                                        | Private bytes, content hashes, draft-only revision replacement, authenticated download                 |
| `src/server/tasks.ts`, `worker.ts`                                           | Assignment rules, completion conditions, server reminders, retry/deduplication                         |
| `src/server/queries.ts`                                                      | RLS-backed dashboard, register, search, exports and record detail                                      |
| `db/migrations/`                                                             | Ordered checksummed schema, policies, guards and privilege migrations                                  |
| `scripts/`                                                                   | Separate local/test orchestration, provisioning, migration, sample data, backup/restore                |
| `src/components/`                                                            | English user interface and explicit business-action forms                                              |

The `records` table is a stable ID/scope index, not a universal workflow table. Documents, revisions, deviations, CAPAs, changes, audits/findings, answers/questions/submissions, materials/lots/containers/transactions and EHS records each have their own columns, constraints and server rules.

## Scope and roles

A grant contains site plus optional customer, project and record restrictions, and an optional expiry. **Null means any matching value within the selected site**, not deny. Avoid broad site grants for employees who should see only selected projects/records. Project/customer consistency is checked on creation. Roles never create record access; assignment never creates access or approval qualification.

| Role                 | Business actions (all still require record scope and valid state)                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Employee             | Read permitted records; own reading acknowledgement; assigned question draft; assigned ordinary task completion                        |
| Document Owner       | Create documents, own draft/upload/revision, submit; create linked follow-up tasks                                                     |
| Reviewer             | Assigned independent review; independent instructor-led/competency confirmation                                                        |
| Approver             | Assigned SOP approval; independent CAPA plan/change approval; no QA closure solely from this role                                      |
| QA                   | Document oversight/effectiveness; quality workflows and independent closures; answer/questionnaire management; controlled task changes |
| Investigator         | Deviation investigation, implementation actions within authorized records                                                              |
| Inventory Custodian  | Receipt, release/hold and container transactions                                                                                       |
| EHS Coordinator      | EHS assessment and independent closure                                                                                                 |
| System Administrator | Provision/disable accounts; explicit roles/scopes; controlled task transfer/extension. **No automatic business approval.**             |
| System Worker        | Server service identity scoped to authorized sites; no interactive sign-in                                                             |

Some processes require multiple grants (e.g. QA + Approver for answer-library approval). A technical administrator can explicitly administer role assignments; the real company's authorization and approval process for granting business qualifications is an open governance decision. No claim is made that this sample administrative arrangement is approved by BBC.

## Database security: actual boundary

- `bbc_owner`: migrations, schema ownership, backup/restore; absent from ordinary web/worker process environments.
- `bbc_runtime`: NOLOGIN permission group.
- `bbc_web` / `bbc_worker`: distinct LOGIN roles, NOSUPERUSER, NOBYPASSRLS, NOCREATEDB and NOCREATEROLE.
- Business tables have RLS; each server transaction sets `app.actor_id` locally after session verification. No actor/time is taken from request payloads. `has_scope` / `can_record` are fixed-search-path security-definer helpers owned by the migration owner.
- **RLS is not FORCEd on the table owner.** The ordinary roles are not owners and cannot bypass it. Tests inspect both identities and demonstrate filtered reads and direct denied downloads. The owner remains able to maintain the database.
- The application server and its runtime credentials are trusted. A compromised server/SQL connection can set actor context and access identity administration tables; this is not isolation against hostile application-server code. End users never receive DB credentials or arbitrary SQL access.
- Audit inserts come from database triggers in the business transaction. Runtime roles have no INSERT/UPDATE/DELETE/TRUNCATE on audit history; immutable guards protect approval/file/snapshot/ledger rows. Ordinary business records cannot be hard deleted through runtime grants or API.
- Owners/superusers and operating-system administrators remain capable of privileged changes. Append-only does not mean physically indestructible. Independent retained copies and storage retention locks require a risk-based company decision.

## Files and consistency

Each file has an opaque UUID key, fixed SHA-256, size, media type, owning record and uploader. Bytes are stored outside the public tree and checked against the hash on download and approval/effectiveness. File metadata cannot be changed by the runtime role. Files are created exclusively and made read-only; this is an application/OS control, not WORM storage. PDF/DOCX are limited to 10 MiB with basic signature checks; antivirus/content disarm remains an integration boundary.

A file is written before its DB transaction commits. A rolled-back upload can leave an unreferenced private file; it cannot become approved content. Backups include only database-referenced files. Do not delete unreferenced bytes without a reviewed retention/cleanup procedure.

Critical actions use row locks, expected versions and transactions. Idempotency keys are actor-bound and fingerprinted; reuse for different input fails. Inventory uses PostgreSQL exact NUMERIC arithmetic and consistent units. Notifications use an outbox and unique delivery keys. No external signing/email/storage integration is represented as connected.

## Version-matched references consulted

- Next.js installed 16.4.5 docs under `node_modules/next/dist/docs/` (route handlers, deployment, data security), plus https://nextjs.org/docs/app/guides/authentication
- PostgreSQL 17 row security: https://www.postgresql.org/docs/17/ddl-rowsecurity.html
- Frappe installation comparison: https://docs.frappe.io/framework/user/en/installation
