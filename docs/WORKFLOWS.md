# Sample workflows and data semantics

All rules in this release are **sample implementation defaults pending BBC approval**. They do not determine regulatory applicability, retention or customer commitments.

## SOP and training

1. A document master owns its controlled number, owner, type and department. Revision rows own title, change rationale, file ID, rule version, training method, audience, timing and state.
2. Draft upload creates a new private attachment identity. Submitting requires a file, qualified accessible reviewer/approver, an appropriate training audience and a due date. The owner, revision creator and actual file uploader cannot serve as an independent reviewer/approver. Reviewer and approver must be different people under rule v1.
3. Submission freezes content and advances a review cycle. Review and approval retain the exact revision, cycle, file ID/hash, actual actor and server time. An obsolete review cycle cannot approve changed content.
4. Approval creates revision-bound training assignments; it does not make the SOP effective. Local fixed-file verification records archive completion. `signing_mode=Internal` is an internal authenticated decision, not a DocuSign signature or a regulated electronic signature claim. External signing is not enabled.
5. Read acknowledgement must be completed by its trainee. Instructor-led and competency training require a different qualified Reviewer/QA confirmer, evidence and a reason. A reading click cannot complete competency training.
6. QA effectiveness checks approval/file consistency, completed archive state, earliest effective date and configured training gates. It supersedes the previous effective revision atomically and creates a periodic-review task.
7. New revisions preserve prior files, approvals and training. In-review content can be returned to Draft; Approved content without training records may also be returned with historical decisions retained and invalidated by the next cycle. An approved revision with training history must be withdrawn and followed by a new revision. Withdrawal preserves history and cancels open revision assignments.

`workflow_rules` is immutable, with an increasing `(name,version)` pair. Existing revisions keep the referenced rule. A new revision selects the latest rule. In-flight rule migration has no automatic path and requires a reviewed migration. QA can configure role-to-SOP requirements and due-day windows on a draft. Submission expands active role members who already have record access, merges explicit trainees, and freezes that audience/deadline policy on the revision. Subsequent revisions apply the current matrix for retraining. Continuous new-hire assignment to already-effective revisions and a cross-document matrix administration screen remain extensions.

## Tasks and reminders

Tasks retain record/revision links, assignee, deadline, status, completion condition and evidence. Manual follow-up tasks may require an attachment. Revision review/approval, training, question response, CAPA implementation/effectiveness, finding closure and EHS review tasks complete only through their business action. Generic completion cannot bypass those workflows.

Reassignment/extension require QA or technical administration and a reason. The assignee must already have record access. Approval/review reassignment also rechecks qualification and independence; it is a recorded transfer, not impersonation or a delegated signature. Training cannot be reassigned to another trainee. Question assignments are managed on the question. Disabled accounts immediately lose sessions; their historical tasks remain for controlled reassignment.

The independently running worker scans due tasks every 30 seconds and creates at most one reminder per task/recipient/server day. In-app delivery is real and transactional. Failed delivery is retained, retried with backoff, and stops automatically after eight attempts for operator attention. Access revocation/reassignment cancels stale pending deliveries. Notification receipt never completes business work.

## Quality events

- **Deviation:** Open → Investigation → In Review → Closed. Impact/containment/investigation/disposition and a CAPA decision/rationale are required. Sample Medium/High risk requires a root-cause assessment. `Not Required` is allowed with rationale and independent QA closure. `Required` needs an accessible, active linked CAPA. Return/reopen/cancel require reason. Risk classifications and deeper investigations need the actual approved program.
- **CAPA:** Draft → Plan Approved → Implemented → Effectiveness Complete (if required) → Closed. Independent Approver grants plan approval; implementation and effectiveness require evidence. Failed effectiveness returns the record for further implementation and cannot be closed. Independent QA performs closure. Multiple source records are linked using `quality_links`. Action plan currently has one overall owner/deadline; a detailed multi-action plan editor is a remaining extension.
- **Change:** Draft → Approved → Implemented → Closed, with impact, plan, independent approval, implementation evidence and independent QA closure.
- **Audit:** Planned → In Progress → In Review → Closed; Customer/Supplier/Internal remain distinct. A report and closure of open findings are required. Each finding has owner, grade, due date, response, evidence and independent QA decision. CAPA linkage is optional. Participant/agenda planning is basic and needs expansion.
- **EHS:** Open → In Review → Closed; assessment, interim controls, corrective action, evidence and independent EHS closure. Categories include risk assessment, material introduction, permit, inspection and incident. Professional/legal determinations remain human responsibilities. These reminders do not replace emergency response.

## Answers and questionnaires

An answer owns site, customer/project scope, topic, answer, business scope, limitations, source revision/evidence, review status/person/date and next review date. Unknown facts stay `Cannot answer` or `Pending confirmation`. Approval requires independent QA + Approver and evidence. Referenced SOPs must be effective at the same site. Source changes/expiry invalidate use and the worker marks affected answers for review.

Questionnaires have independently assigned questions and drafts. Contributors must have access, save their answers and preserve explicit uncertainty. QA reviews; a different QA submits. Submission is a local finalized snapshot, **not delivery to a customer**. It stores exact answer/source versions and file IDs/hashes. Historical snapshots are immutable; later answer changes do not rewrite them. Promised documents generate delivery tasks. Source-file download still requires access to the source's owning record; a questionnaire never silently widens source evidence access.

## Inventory

- `Material` defines type (Cell/Antibody/etc.), ownership and stable identity. `material_uses` defines project-specific TA/Reference/Reagent/Other roles. TA does not duplicate stock or replace material type.
- `Lot` defines batch, expiry, COA/SDS, concentration annotation and release/hold state. New receipts start On Hold.
- `Container` defines lot, parent container, storage location, exact quantity/unit, reservation, status, and applicable passage/open/freeze-thaw fields.
- `inventory_transactions` retains operation, signed quantity change, balance and reservation after the action, actual use project, location, related container, actor, reason and time.
- Use/aliquot/reservation require released unexpired stock. Aliquot transfers equal quantities to an identified child without changing units or passage. Move changes location without changing quantity. Adjustment requires a signed amount and rationale. Returns cannot exceed the recorded use for the actual project and put the lot back On Hold. Disposal requires reservation release and records the removed amount.
- Count units (`vial`, `each`) must be whole numbers. No implicit conversion of mg/mL/uL/etc. is performed. Concentration is a labelled annotation, **not a calculation engine**. Balance must equal summed quantity deltas per container/unit.

This release is an independent **synthetic inventory evaluation**. Before real use, identify the authoritative balance system and migrate/reconcile once. No Labguru or other live inventory was copied or modified. Detailed culture expansion, freeze/revival testing, license/passage enforcement, unit/concentration conversions, barcodes and reconciliation connectors remain phase-D work.
