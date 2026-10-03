# Entity-scoped reads and approval eligibility (task 90)

## Status — 2026-10-03

Built on the current HEAD, on top of task 89's ownership evidence, task 50's
resource lineage and task 59's impact graph. **Fixture-tested only.** No
employer CMDB or live tenant was used. The Creos and Enovos entities are
synthetic fixtures.

## Grant scope

`role_grant.scope` has existed since the first schema with default `*`, but
nothing used it before this task. It now carries meaning:

- `*` is **central**: tenant-wide. Every grant made before task 90 holds `*`
  through the column default, so existing installs behave as before.
- `entity:CODE` (for example `entity:CREOS`) confines the role's capabilities
  to resources whose current, unexpired ownership evidence names that entity.
- A new additive CHECK (`role_grant_scope_check`) rejects any other value, and
  `parseGrantScope` drops a row it cannot parse. A malformed scope therefore
  grants nothing, and is never read as central.
- `grantRole(..., { entityCode })` writes an entity grant. `admin` cannot be
  entity-scoped. The grant API (`POST /api/principals/<id>/grant`) accepts an
  optional `entityCode`. The principals page shows "Viewer for CREOS resources
  only since …" and lists entity capabilities in the technical record.

`can(client, principal, capability, at)` asks the tenant-wide question, and
**only central grants answer it**. Every caller that existed before task 90 is
therefore fail-closed for entity-only principals. `can(..., { entityCode })`
also accepts that entity's grants. `capabilityScope` returns
`{ central: true }` or `{ central: false, entities: [...] }`. An empty list
means no scope, never "everything". Principal grants are configuration only,
and remain separate from Microsoft workload credentials.

## Row attribution and scoped reads

`engine/authz/entityScope.mjs#scopePredicate` produces a SQL predicate that the
reader splices into the query that also counts. A row
`(tenant, resource type, natural key, as-of time)` is visible to an entity
reader only when all of these hold:

1. Exactly one lineage held that natural key at that time. If two resources
   share a name, the row is not attributed and stays hidden.
2. That lineage's current ownership evidence is unexpired.
3. The evidence is `owned` by one of the reader's entities, or `shared` with
   one of them.

Unknown, unresolved (a failed CMDB lookup), expired, never-resolved and
unattributable rows are visible to central readers only. A central scope adds
the predicate `TRUE`. An empty scope adds `FALSE`.

Portal integration:

- `proxy.ts` downstreams a new header, `x-keel-entity-capabilities`, with tokens
  such as `read:CREOS`, and deletes any caller-supplied value. The existing
  `x-keel-capabilities` header stays central-only.
- `read.ts`: a surface marked `entityScoped: true` admits an entity-only reader
  and hands the loader its `scope`. Every other surface still requires the
  central capability, so an entity-only reader gets 403. **Only Changes (the
  drift page and `/api/drift`) is entity-scoped today.**
- `portal-data.ts#getDriftData(scope)` filters the open-drift list in SQL, and
  recounts the active baseline's resource count with the same predicate.
  The response carries `scope`, and the page says in words that only that
  entity's changes are shown.

A by-id, search or export path must be built the same way: the predicate
belongs in the server query. The boundary test checks the by-id, name-search
and count forms of the drift query.

## Safety graph

`redactImpactForScope(analysis, { isVisible })` is applied to a task-59
`analyzeImpact` result that was computed over the **full** graph. Completeness,
refusals and the fingerprint pass through unchanged, so a hidden foreign
dependency still blocks or hands off. Each list (keys, closure, impacted,
waves, cycles, hidden, truncated) replaces foreign keys with a single
`REDACTED` marker. Edges and patches that touch a foreign key are dropped. The
result gains `scopeHandoff: { required, handoff: 'central', explanation }`.
Several foreign resources collapse into one marker, so their number is not
disclosed.

## Approval eligibility

- `approval_request.entity_scope` (additive jsonb column) records, at request
  time, each resource's lineage and ownership state (`captureApprovalScope`).
  It also records `centralOnly`, which is true when any resource is not
  `owned` by exactly one entity, and the set of owning `entities`. The portal
  captures it for drift-scoped requests (`remediate` with `driftIds`). A drift
  id that does not belong to this tenant makes the request central-only.
- `approvalEligibility` runs inside the decision transaction against
  **current** ownership and grants:
  - A change of owner (state, entity or entity set) closes the request as
    `expired` with the reason `invalidated: ownership-changed`. The closure is
    committed before the refusal. Nobody can approve it, including a central
    approver.
  - Expired evidence refuses with `ownership-expired` and hands off to central.
  - For an entity-decidable request, if the requester no longer holds the job
    kind's capability for every owning entity, the request is invalidated
    (`requester-grant-changed`).
  - A central approver is eligible. An entity approver is eligible only for a
    request that is not central-only and whose owning entities are all within
    the approver's own. Otherwise the refusal is `ApprovalScopeError` with
    `handoff: 'central'`, and the request stays pending.
  - A request with no captured scope (made before task 90, or any
    non-drift action) can be decided by central approvers only.
- The portal decision guard admits approvers who hold `approve` centrally or
  only for an entity, and always calls the engine with `enforceScope`. A scope
  refusal returns `403 { error: "forbidden", handoff: "central" }`, which names
  neither the entity nor the resource.
- `listApprovalRequests({ approverScope })` filters the inbox and the sidebar
  count in SQL. An entity approver sees only requests that are entity-decidable
  and entirely within their entities.

## Validation (2026-10-03, isolated local PostgreSQL 16)

- `node --test engine/roadmap/scoped-authorization.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs`:
  12 pass, 0 fail. `cd portal && npm run typecheck` is clean. `npm test`:
  134 pass, 0 fail, including the new `portal/test/scoped-authorization.test.ts`
  and a proxy header test in `auth.test.ts`.
- CI engine suite (`.github/workflows/portal.yml`, now including
  `roadmap/scoped-authorization.test.mjs`): 152 pass, 0 fail; 179 pass, 0 fail
  after merging master (tasks 83, 84, 101, 110). Portal `npm test` 135 pass after the merge.
  `npm run build` succeeds, and `npm run test:ui` passes 91/91 (94/94 after the merge) with the
  allowlist still empty.
- Two test doubles that fake `role_grant` rows (`cli/keel-worker.test.mjs` and
  `engine/roadmap/benchmark-packs.test.mjs`) now return the `scope` column,
  which is `NOT NULL DEFAULT '*'` in the real table.
- Required mutations, each reverted:
  - Filter only client-side: the server predicate returns every row. Engine
    tests 2 and 3 fail. A portal variant, where the loader ignores the scope,
    fails portal test 2.
  - Omit hidden dependency from the safety graph: foreign keys are dropped with
    no marker or handoff. Engine test 4 fails.
  - Use stale ownership for approval: eligibility trusts the captured
    ownership. Engine test 7 fails.

## Limits

- **Only Changes is entity-scoped.** Every other page and API, including
  exports, coverage, baselines, restore, jobs and evidence, still requires a
  central capability, so an entity-only reader is refused there rather than
  shown unfiltered data. Each surface opts in only when its loader applies
  `scopePredicate`.
- The impact-graph redaction is an engine seam. No portal surface exposes
  task-59 analyses yet, and the restore selection preview requires central
  `restore`.
- Attribution uses the alias window at the row's own time (`detected_at` for
  drift, the snapshot's completion time for baseline rows). A row observed
  before its lineage was recorded, or after its alias closed, is not attributed
  and is visible to central readers only.
- Requests and every action except `remediate` with drift ids carry no captured
  scope, so they remain central-only. Routing approvals to the owning entity's
  approvers is task 91.
- Entity-scoped requesters cannot create requests through the portal yet,
  because action guards require central capabilities. The worker re-authorizes
  each job's requester with the central `can` check.
- Grant windows end at the database's `now()`. A check made in the same
  millisecond can still see the grant as active. This existed before task 90.
