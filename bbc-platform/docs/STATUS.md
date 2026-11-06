# Delivery status and verification

Development release: `0.1.0`. Work performed in the November 5, 2026 (America/New_York) session; machine logs may use November 6 UTC. This file describes a runnable development baseline, not completed formal validation or authorization to use real quality records.

## Stage progress

| Stage                               | Implemented now                                                                                                                                                                                                                                                                                                               | Remaining scope                                                                                                                                                                                     |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A — shared foundation, SOP/training | Persistent PostgreSQL; role + scope + state checks; accounts and revocation; private files; explicit SOP review/approval/effectiveness; role-based revision training matrix and explicit audience; independent competency confirmation; controlled task reassignment/deadlines/evidence; audit; worker; tested backup/restore | Corporate identity/MFA/recovery; full user acceptance; actual workflow/approval matrix and retention approval; continuous new-hire training assignment; production infrastructure/backup scheduling |
| B — QMS work                        | Working deviation with optional CAPA; separate CAPA phases; change control; audits/findings; scoped answer library; contributor drafting; independent questionnaire submission; fixed evidence/version snapshots; delivery tasks                                                                                              | Rich multi-action CAPA planning; detailed audit scheduling/participants; richer questionnaire imports/exports; controlled amendment/void UX beyond implemented transitions                          |
| C — TA inventory and EHS            | Materials/lots/containers/ledger; separate TA role; hold/release; aliquot/move/reserve/use/adjust/return/dispose; exact quantities; project use; basic EHS workflows and deadlines                                                                                                                                            | Select authoritative inventory source; real migration/reconciliation; broader storage/reference-data UI; adopted EHS procedures and incident integration                                            |
| D — expansion                       | Cell identity/passage and antibody clone/catalog/label/concentration annotation; open/freeze-thaw counters                                                                                                                                                                                                                    | Culture expansion/cryopreservation/revival/testing and restrictions; barcode hardware/workflows; advanced reports; confirmed external integrations                                                  |

## Verification performed

The integration suite runs against actual PostgreSQL 17.11 using the non-owner `bbc_web` runtime account. It invokes application services and real Next.js route handlers with HTTP Request/Response objects. It is not a mocked SQL test and does not use localStorage. The final executed results are recorded in `docs/TEST_RESULTS.txt`.

Covered scenarios:

1. Runtime role, schema ownership and active RLS; no actor yields no records.
2. Unauthenticated API/search/export/file requests and invalid-origin login denied.
3. Other-site direct record/file access denied; scoped search/export leak no records.
4. Task assignment does not grant access; unqualified technical admin cannot approve, including through the API with a forged actor field.
5. Submitted content frozen; unauthorized/stale review/approval rejected; fixed file hash matches approval.
6. Training, archived snapshot and approved state gate effectiveness; competency requires independent evidence.
7. Second revision preserves old file/approval/training history; only one effective revision.
8. Controlled task reassignment and immediate session invalidation on account disable.
9. Atomic audit rollback; runtime cannot insert/update/delete/truncate audit history.
10. CAPA Not Required rationale and independent QA review; required effectiveness cannot be bypassed.
11. Answer/site scope and immutable questionnaire submission; changed answers do not rewrite history.
12. Inventory hold/release, exact-unit checks, aliquot lineage and conserved quantity.
13. Replayed/concurrent use cannot double-deduct or overspend; ledger matches all balances.
14. Worker failure, retry and deduplication; a separately spawned worker delivers reminders and shuts down cleanly without a browser; reminders do not complete business tasks.
15. Change, audit/finding and EHS state/evidence/independence gates.
16. Record-specific, expired and revoked scopes; no runtime hard-delete of formal records.
17. Reservation/adjustment/return behavior and automatic return-to-hold.
18. Question contributor access and saved response before review.
19. Authenticated overview/detail APIs return usable records; browser-supplied identity cannot grant authority.
20. Manual task evidence requirement and protected workflow-task completion.
21. Returned approved content requires a new review cycle; uploader cannot self-review.
22. Role-based SOP training expands only accessible staff and freezes the revision audience/deadlines.
23. Actual database + actual attachment restore into separate test DB/storage; file hashes, row counts, lineage and ledger relationships verified.

Additional checks: strict TypeScript; Next.js optimized production build; npm production dependency audit. Exact final result/counts are in the test-results file, not inferred from this checklist.

Browser verification: the actual development server was started through the managed preview and the sign-in page was visually inspected at a desktop viewport. Authenticated browser click-through, mobile/browser compatibility and accessibility audits were **not completed**; authenticated business flows were verified through route/service integration tests. No test credentials were exposed in browser tool output. Docker/Compose execution, TLS hosting, production load/failover and external integrations were **not tested**.

## Decisions requiring company input

- Company-owned Git destination, hosting/network/TLS, operational owner and secret-management setup.
- Actual role/scope assignments, qualification-grant authority, independent approval rules and supported delegation policy.
- Approved SOP workflow, training/competency evidence rules, effective-date policy and ongoing new-hire training.
- Formal-record retention, correction/void/archival rules, backup RPO/RTO and independent retained audit copies.
- Existing inventory authority and approved cutover/reconciliation; actual locations, units and material restrictions.
- EHS procedure/risk categories and emergency-event integration.
- Which third-party integrations are actually needed, supported API/plan, credentials and record authority. DocuSign, Drive, Smartsheet and Labguru are explicitly not connected. NetSuite is not assumed.

Next implementation focus: company-hosted acceptance environment and browser acceptance, then adoption of actual rules/reference data and selected phase-B/C/D extensions. The full program is not marked complete.
