# BBC Internal Quality & Operations Platform

A working modular monolith for Waltham internal quality and laboratory operations. This release has a real Next.js server, PostgreSQL persistence, private files, explicit business actions, role/scope authorization, background reminders and append-only business audit events.

**Status:** development baseline. Phase A is implemented and integration-tested; phases B/C have working foundational workflows; phase D has initial cell/antibody fields only. This is **not** a validated production release and makes no GLP, GMP or 21 CFR Part 11 compliance claim. Sample rules and synthetic data are not BBC-approved procedures or factual qualification statements.

## Start locally

Use Node.js 24 (tested: 24.22.1), npm and an ordinary non-root user. The executed development checks used Linux; Windows/WSL2 and macOS compatibility have not been exercised.

```sh
npm ci
npm run dev
```

Open **http://localhost:3000**. The development launcher initializes a persistent PostgreSQL 17.11 cluster, applies checked migrations, creates clearly synthetic records once, and starts Next.js plus a separate reminder worker. It is not an in-memory or browser-local database. On first start, each synthetic user receives a unique randomly generated password in **`.local/demo-credentials.json`**. Open that private file locally; do not commit or share it.

| Synthetic login            | Responsibility                                     |
| -------------------------- | -------------------------------------------------- |
| `owner@example.test`       | Document owner (Alex Morgan)                       |
| `reviewer@example.test`    | Independent reviewer (Taylor Reed)                 |
| `approver@example.test`    | Qualified approver (Jordan Chen)                   |
| `qa@example.test`          | QA, investigations, inventory, EHS (Sam Patel)     |
| `qa_reviewer@example.test` | Independent QA/approver/EHS reviewer (Morgan Lee)  |
| `employee@example.test`    | Assigned trainee (Casey Brooks)                    |
| `admin@example.test`       | Technical administrator; no approval qualification |
| `outsider@example.test`    | Other synthetic site, for scope denial checks      |

Different accounts are required to exercise independent review/approval. Public registration is disabled. Sign in as the document owner, open **Document control**, create a draft, upload PDF/DOCX, submit to independent reviewers, then switch accounts for review/approval/training/QA effectiveness. The seeded approved SOP provides a ready training example.

## Verify

```sh
npm run typecheck
npm test
npm run build
```

Tests start a **separate PostgreSQL cluster**, recreate only its `bbc_test` schema, and use separate attachment storage. Never point test variables at production. `npm test` includes backup/restore into a separate database and directory. See [verification and progress](docs/STATUS.md) for exact coverage and verification limits.

## What works

- Server sessions, account activation/deactivation, explicit role/scope grants and revocation; expiring and record-specific scope.
- Private PDF/DOCX files, fixed revision/file hashes, independent SOP review and approval, training gates, effectiveness, withdrawal and revision history.
- Assigned tasks with deadlines, evidence conditions, reasoned extensions/reassignment, in-app notifications and retryable worker delivery.
- Deviation/CAPA, basic change control, audits/findings, reviewed answer library and fixed questionnaire submissions.
- Material → lot → container → immutable transaction ledger; TA as project use identity; release/hold, aliquot, move, reserve, use, adjustment, return and disposal.
- Basic EHS assessment/incident/permit/inspection tasks and independent closure.
- Scoped search and JSON record-register exports; audit views; logical database + actual-file backups with verified restore.

## Handover

- [Architecture, schema and permission matrix](docs/ARCHITECTURE.md)
- [Versioned workflows and business limits](docs/WORKFLOWS.md)
- [Deployment, backup, restore and maintenance](docs/OPERATIONS.md)
- [Stage progress, executed tests and open decisions](docs/STATUS.md)

All code, migrations, lockfiles and configuration examples are in this repository. No remote repository, production resources or external app writes were created. The company can import this Git repository and run it on company-controlled infrastructure.
