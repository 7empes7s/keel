# Evidence-based change attribution and approver routing (task 91)

## Status — 2026-10-03

Built on the current HEAD, on top of task 88's bounded audit ingestion, task 89's
ownership evidence and task 90's entity scope. **Fixture-tested only.** No Microsoft
audit or sign-in log was read; no live tenant, credential or Graph endpoint was used.
The Creos and Enovos entities, the users and the audit entries are synthetic fixtures.

## What attribution means

A change KEEL found (an open drift row) is one resource, the fields that differ from
the baseline, and a **change window**: from when KEEL captured the baseline's version
of that resource (the baseline's own time for an added resource) to the collection
that saw the change. `engine/identity/attribution.mjs#classifyAttribution` sorts it
into one of three verdicts:

| Verdict | When |
|---|---|
| `exact` | Exactly one account has an audit entry that names **this resource** (type and Microsoft object id from task 50's lineage, never a display name), an operation consistent with the change (create for added, update for modified, delete for removed), changed fields that do not contradict the observed ones, inside the window; **and** the audit log is known complete for the whole window. |
| `plausible` | An entry names the resource but the log is incomplete for the window (`audit-log-incomplete`); or entries by several accounts name it (`several-actors-changed-resource`); or no entry names it, the log is complete, and exactly one account signed in during the window with the sign-in log complete (`sign-in-proximity-only`). |
| `unknown` | No single resource identity (`resource-identity-unresolved`, for example two resources hold the name); no audit log (`audit-log-not-configured`); a retention gap (`audit-retention-gap`); revoked or failed reads (`audit-read-scope-revoked`, `audit-read-failed`); a window not yet read (`audit-window-not-read`); an organization archive KEEL does not read (`audit-in-organization-archive`); several accounts signed in nearby (`several-nearby-sign-ins`); or a complete log with no entry and no single sign-in (`no-audit-record-names-resource`). |

Temporal proximity alone is never exact: a sign-in carries no resource and no
operation, so it supports `plausible` at most, and only when it is the one account.

### Coverage

`coverageFromRuns` decides whether a source's log is complete for a window from task
88's own run evidence. Only `complete` and `complete-empty` runs prove a traversal, and
their windows are unioned. Budget-exhausted or failed runs prove nothing. A retention
gap Microsoft reported (run evidence or the persistent source state) that overlaps the
window, or a window older than what KEEL's own retention keeps (each run now records
`retentionDays`), is `retention-gap`. A revoked read is reported separately from an
empty log. An archive reference without traversal is `archive-reference`.

## Ingestion and minimization

Task 88's read-only adapter contract gains two optional fields, validated by
`minimizeAttributionFact`:

- audit events: `change: { targetType, targetId, operation, activity?, fields?, actorKind, actorId }`
- sign-in events: `actor: { kind, id }`

`targetId` and `actorId` must be object ids (GUIDs). `operation` accepts Microsoft's
`Add`/`Update`/`Delete`/`Assign`/`Unassign` or KEEL's `create`/`update`/`delete`.
`activity` is a bounded name and is refused if it looks like a secret. `fields` are
field **names** only, at most 64. An invalid fact refuses the page (`invalid-page`), so
the cursor does not advance. Everything else on the event is ignored.

Facts are stored in `audit_change_fact` and `audit_sign_in_fact`, keyed by
`(tenant_ref, source_event_id)`, in the same transaction as the task 88 event row and
only when that row was newly inserted. They are pruned by the same retention rule. No
UPN, display name, IP address, user agent, token, old or new value is stored. The
tables are created by `migrateAuditIngestion` (`keel-worker.mjs --audit-migrate`),
which is additive and repeatable. An install migrated before task 91 must run it again
before an adapter supplies facts; until then a page with facts fails closed without
advancing the cursor, and pages without facts behave as before.

## Naming the account

An actor is named only from KEEL's own collected inventory: the `user` or
`servicePrincipal` resource with that object id **in the same tenant**. An entity-scoped
reader sees the name and id only when that user or app is visible to their scope under
task 90's rules; otherwise the actor is shown as "an account outside your entities"
with no id. Accounts that merely signed in nearby are never named when the verdict is
unknown.

## Tenant isolation

Facts are written and read by `tenant_ref`; the classifier also refuses a fact from
another tenant; actor names resolve through the same tenant's lineage. The boundary
test gives two tenants the same actor id and the same group object id and shows that
tenant B's audit entry never attributes tenant A's change, and that tenant B's name for
the shared id is never used in tenant A.

## Approver routing

`engine/govern/approvals.mjs#routeApproval` routes a request from **current**
ownership (`entityScope.mjs#rereadApprovalOwnership`, which `approvalEligibility` now
also uses) and current grants:

- `entity`: every resource is owned by one entity, and that entity has an approver
  (an `approve` grant scoped to it). `approvers` lists them, excluding the requester.
- `central`: an explicit central handoff with a reason: `cross-entity` (resources of
  several entities, never routed to the first or any one of them), `shared-or-unattributed`,
  `ownership-expired`, `no-entity-approver` or `no-captured-scope`.
- `refused`: a resource changed owner since the scope was captured. The old request is
  never followed to the new owner; it must be made again.

`requestApproval` stores the route in the new additive column `approval_request.route`
and in the request's evidence entry. The route is advisory: eligibility is still decided
at decision time by task 90's `approvalEligibility`, unchanged in its rules, so routing
never widens who may decide. Requests made before task 91 have a null route.

## Portal

`portal/lib/portal-data.ts#getDriftData` attributes the open changes the reader can
already see (the task 90 scope filter still runs first), in a batched read of at most
200 changes, and routes a roll back of each one. Failure to attribute yields `null`
("KEEL did not check who made this change"), never a guess.
`portal/components/change-attribution.tsx` appears under a change's comparison on the
Changes page: a headline ("Confirmed by the Microsoft audit log", "Likely, not
confirmed", "Not known"), one sentence in words, the age of the audit entry when exact,
and where a roll back goes ("A roll back goes to CREOS approvers (1 person)." or "… to a
central approver (2 people), because it touches more than one entity."). The verdict and
reason codes, audit entry ids, account and resource object ids, change window, coverage
and route stay in its "Technical details: attribution" record.

## Validation (2026-10-03, isolated local PostgreSQL 16)

- `node --test engine/roadmap/change-attribution.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs`:
  11 pass, 0 fail. `cd portal && npm run typecheck` is clean; `npm test`: 137 pass, 0
  fail, including the new `portal/test/change-attribution.test.ts`.
- CI engine suite (`.github/workflows/portal.yml`, now including
  `roadmap/change-attribution.test.mjs`) plus `roadmap/audit-ingestion.test.mjs` and
  `govern/*.test.mjs`: 230 pass, 0 fail. `npm run build` succeeds. `npm run test:ui`:
  95 pass with the allowlist still empty, including a new interaction test for the
  attribution panel (sentences, record contents, plain-text and axe checks).
- Required mutations, each reverted:
  - Label nearest sign-in exact: tests 1 and 2 fail.
  - Ignore resource identity (classifier and SQL): tests 1, 2 and 3 fail.
  - Route cross-entity approval to first matching entity: test 6 fails.
  - UI contract: an object id rendered in the attribution sentence fails the
    harness identifier test.

## Limits

- **No live Microsoft adapter.** As in task 88, no Graph `directoryAudits` or
  `signIns` reader exists; a real provider must map `targetResources[].id`,
  `operationType`, `modifiedProperties[].displayName` and `initiatedBy` into the fact
  shape above and be qualified separately. Whether a given Microsoft workload emits an
  entry for each change, and how quickly, is unqualified.
- **The window is conservative.** It starts at the baseline's capture of the resource,
  not the last collection that saw it unchanged, so long-lived drift has wide windows,
  more candidate accounts and fewer exact verdicts. It never makes a verdict stronger.
- **Field matching is by name.** A record whose field names do not overlap the changed
  top-level fields is not evidence; a record without field names is accepted on
  resource and operation alone.
- **Coverage is per run window.** It relies on the last 100 runs per source and their
  recorded retention. Runs from before task 91 lack `retentionDays`, so KEEL's own
  pruning is not detected for them.
- **Routing reads every enabled principal's grants** (at most 500) per route, cached per
  page; very large principal sets are not optimized.
- Approvals page copy is unchanged; the route is shown on the Changes page and kept on
  the request row and its evidence.
