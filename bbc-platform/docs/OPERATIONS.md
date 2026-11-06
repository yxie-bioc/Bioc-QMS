# Operations runbook

## Environments and credentials

Development: `npm ci` then `npm run dev`. The launcher runs a native PostgreSQL process, migrations, one-time synthetic seed, the web process and a separate worker. Default browser address: `http://localhost:3000`. The launcher also accepts `--host` and `--port` for managed previews. Keep that process running; data persists across restarts.

| Local path                                                         | Purpose                                                                                |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `.local/postgres/`                                                 | Persistent development PostgreSQL cluster                                              |
| `.local/demo-credentials.json`                                     | Random synthetic login credentials; private, not in source control                     |
| `.env.local`                                                       | Web-only development connection/configuration                                          |
| `.env.worker.local`                                                | Worker-only development connection/configuration                                       |
| `.env.ops.local`                                                   | Owner/admin development maintenance connections; never loaded into web/worker children |
| `var/attachments/`                                                 | Private development file bytes                                                         |
| `.local/test-runtime/`, `.env.test.local`, `var/test-attachments/` | Independent synthetic test cluster/configuration/files                                 |
| `.local/test-backup/`, `var/restored-test-attachments/`            | Repeatable restore-test outputs; not formal backups                                    |

The test runner deletes and recreates only `bbc_test.public` in its own cluster and recreates `bbc_restore_test` for restore verification. It checks `APP_ENV=test` and the database name. Do not repurpose test credentials or paths for real data.

For development maintenance in environments with isolated per-command networking, run maintenance in the same launcher:

```sh
npm run db:local -- --run bash -c 'npm run db:migrate && npm run backup -- backups/review-01'
```

Stop the development stack first if it already owns that cluster. The browser preview and separate shell commands may not share loopback networking in managed environments. On a normal workstation, the local database is reachable while `npm run dev` is running.

## Company-controlled hosting

A Docker Compose specification is supplied but **Docker execution was not available in the delivery environment**. It has not been deployed or container-tested here. Review and pin image digests in the company's delivery pipeline before production use.

```sh
node scripts/configure-production.mjs https://your-internal-host administrator@company.com
# Review the generated private .env.deploy and supply it through company secret management.
docker compose --env-file .env.deploy build
docker compose --env-file .env.deploy up -d
```

This is a handover procedure, not an instruction that has already been executed. The generated `.env.deploy` deliberately does not use a Next.js auto-loaded filename. Secrets never belong in source control, build archives, screenshots or application logs.

- PostgreSQL is not exposed as a host port.
- One-off `migrate` provisions separate `bbc_owner`, `bbc_web`, `bbc_worker`, `bbc_runtime`, applies migrations and creates **one technical administrator** and a noninteractive worker identity. It does not create synthetic business data or approval qualifications. It is idempotent and preserves existing users/passwords.
- Web receives only the web DB credential; worker receives only its credential. Only the one-off provisioning service receives owner/admin secrets. Remove/bootstrap-secret access after initial setup.
- Web binds host `127.0.0.1:3000`. Put an authenticated corporate access boundary and TLS reverse proxy in front of it; configure `APP_ORIGIN` and leave `COOKIE_SECURE=true`.
- Run web and worker continuously under the company service manager/container scheduler. Persistent volumes cover PostgreSQL and actual private attachments. Do not use an ephemeral volume for either.
- The reverse proxy must enforce request/body size and request-rate limits. The application rejects declared bodies above 12 MiB and file payloads above 10 MiB; a proxy must cap streamed/chunked input before buffering.
- Configure centralized application/worker logs, restart policy, resource limits, database TLS where connections cross trust boundaries, encrypted volumes/backups and access review. Corporate SSO/MFA and account/password recovery remain unconnected.
- Provision actual customers, projects, locations and staff through a reviewed administration procedure. This release has no general UI editor for reference-data hierarchy. Do not seed development fixtures into production.

The supplied sample workflow must be approved or replaced before accepting formal records. Qualification grants, role scopes, risk classification, training responsibility, retention and permitted signing method must be confirmed by BBC.

## Migrations and upgrades

`db/migrations/*.sql` are applied in order by the owner. `schema_migrations` retains checksums, time and applying database identity. A changed applied migration fails the run. Create a new migration; do not edit historical migrations. Deployment order is: backup → isolated restore check → migrate → start/restart web and worker → targeted smoke checks. Migrations use a database advisory lock and transaction per migration. No production migration was performed in this delivery.

Do not run the web service as a schema owner or PostgreSQL superuser. After installation, verify `current_user`, `rolsuper`, `rolbypassrls`, table owners and actual RLS filtering; the integration test contains executable examples.

## Backup

Use `bbc_owner` in an operations process; ordinary runtime RLS would omit unauthorized records. The custom versioned logical backup takes one **REPEATABLE READ** database snapshot and copies every database-referenced attachment with checksum verification. It includes business tables, users/roles/scopes, workflow rules, ledger, audit, task and notification history. It excludes live sessions/login throttling because users should authenticate again after restore.

```sh
# MIGRATION_DATABASE_URL and ATTACHMENT_DIR supplied privately to the operations shell.
node --import tsx scripts/backup.ts /secure-backups/bbc-YYYYMMDD
```

The target must be empty. Output includes `database.json`, `manifest.json`, and actual immutable file bytes in `attachments/`. The database JSON contains confidential records and password hashes: store encrypted under a restricted backup identity. Checksums detect accidental corruption; they are not signatures or protection against an attacker rewriting both data and manifest.

This is a whole-application logical backup, **not** native PostgreSQL PITR/WAL archiving. It is suitable for this initial schema and verified volume, not a replacement for an approved production recovery strategy. Company deployment should add native PostgreSQL backup/PITR, off-site copies, retention schedules and restore drills appropriate to the actual recovery objectives. Backup scheduling itself is not installed by this repository; use the company's scheduler and record failures.

## Restore

Restore into a new empty database owned by `bbc_owner`, with the runtime roles already provisioned, and an empty private attachment directory. Run the **same source release** as the backup: schema checksums must match. No overwrite restore is offered.

```sh
# Privately set RESTORE_DATABASE_URL and RESTORE_ATTACHMENT_DIR to isolated targets.
node --import tsx scripts/verify-restore.ts /secure-backups/bbc-YYYYMMDD
```

Restore applies checked migrations, copies and validates every file, inserts tables in dependency order and parents before aliquots/child locations, verifies table counts, container ledger balances and revision/file relationships, and records a maintenance restore event. Existing historical audits are restored; privileged restore operations use a separate owner identity. Cutover of a live site requires an approved operating procedure and a fresh application access test.

The automated restore test actually creates a separate `bbc_restore_test` database and storage directory and validates byte hashes and relationships. The source and target are different databases on the isolated test PostgreSQL server. It does **not** establish cross-region disaster-recovery capability or a measured production RTO/RPO.

## Worker and failed delivery

`npm run worker` runs outside the browser; closing a page does not stop it. Delivery is in-app only. Inspect `worker_runs` and `notification_outbox` for heartbeat/failures; administration shows scoped failures. Backoff is recorded in `next_attempt_at`; eight failures require operator attention. After fixing a fault, a maintenance operator can reset a failed outbox attempt with an appropriate maintenance record. There is no email retry button or real SMTP adapter yet. The `test-fail` adapter rejects use outside `APP_ENV=test`.

## Maintenance boundaries

No retention purge, record hard-delete, external invitation, email, signing request or live external inventory update is implemented. Archive/void/correction and retention policies must be adopted deliberately. Emergency alerts remain with existing site response systems. Review failed notifications, disabled-assignee tasks, expiring scopes, answer review dates and periodic-review tasks routinely.
