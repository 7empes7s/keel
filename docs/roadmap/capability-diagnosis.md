# License, consent and role diagnosis without masking failures (task-53)

Date: 2026-09-22 UTC. Status: implemented, fixture-tested only. No live
qualification is claimed.

## What was built

- `engine/coverage/diagnosis.mjs` (new) — the versioned, source-linked
  feature prerequisite registry and the diagnosis decision. Five explicit
  states (spec Global Constraint #6): `missing-license`, `disabled-plan`,
  `missing-scope`, `missing-role`, `unknown`.
  `registerFeaturePrerequisite()` is the only way a feature becomes
  diagnosable — never inferred from an HTTP status or a CATALOG path — and
  it refuses any feature `tools/tenant-probe/catalog.mjs` does not collect,
  so every entry is source-linked to a real measured endpoint plus the
  Microsoft documentation URL and retrieval date backing its declared
  service plan, consent scopes and roles (Global Constraint #8).
  `diagnoseFailure()` joins three independent evidence dimensions against a
  failed read, under four non-negotiable rules:
  1. Only a *confirmed missing* prerequisite yields a named diagnosis. An
     ambiguous 403 stays `unknown` and keeps its original HTTP status and
     Graph code; a failure that is not authorization-shaped (500, 429,
     transport) is never re-labeled as a licensing problem.
  2. SKU ownership alone is insufficient for user entitlement or consent: an
     enabled service plan never *clears* a failure, it only removes the
     license dimension as the confirmed cause. Consent (oauth2PermissionGrant
     observations) and role (roleAssignment observations) are separate
     dimensions, evidenced separately.
  3. Evidence is time-qualified and tenant-scoped. Each dimension's *newest
     mention* decides — a newer failed read supersedes every older success
     and loads no payloads, so stale evidence can never be resurrected.
     Observations older than `PREREQUISITE_EVIDENCE_MAX_AGE_MS` (3h, the
     tier1 staleness window `report.mjs` already uses, since all three
     evidence types are tier1) or in the future are unusable; a cross-tenant
     observation refuses the join by throwing `CrossTenantObservationError`.
  4. Diagnosis never mutates the raw collection outcome (see report below).
- `engine/coverage/report.mjs` — every failed type entry gains a `diagnosis`
  field computed from the same tenant-scoped snapshot rows the report already
  reads. `loadDiagnosisEvidence()` assembles the newest mention of
  `subscribedSku`, `oauth2PermissionGrant` and `roleAssignment` exactly as
  the coverage CTE selected them (newest including failures) and loads raw
  payloads from `resource_version` only when that newest mention is a
  completed read. `status`, `covered`, `outcome`, `itemCount` and `detail`
  are untouched — diagnosis is additive; only failed entries are diagnosed,
  covered, never-collected and not-covered entries carry `diagnosis: null`.
  Legacy digests (bare counts, message-only
  failures) remain readable: a legacy failure without an HTTP status is not
  authorization-shaped, so it reads `unknown` with nothing invented.
- `engine/store/tenantRef.mjs` — new `assertTenantRef()`, the boundary that
  refuses an empty or raw (unhashed) tenant id before it can anchor a
  diagnosis join. `tenantRefFor()` is unchanged.
- `tools/tenant-probe/catalog.mjs` — new `catalogEntryFor()` lookup, the
  single source-link the prerequisite registry registers through (extending
  the existing catalogue, never a parallel registry).

## Registered prerequisites (declared, source-linked)

- `roleEligibilitySchedule` (PIM read): service plan `AAD_PREMIUM_P2`;
  scopes `RoleEligibilitySchedule.Read.Directory` /
  `RoleManagement.Read.Directory` (either satisfies); roles Global Reader /
  Privileged Role Administrator. Source:
  <https://learn.microsoft.com/en-us/graph/api/rbacapplication-list-roleeligibilityscheduleinstances?view=graph-rest-1.0>,
  retrieved 2026-09-22 (the permissions table and supported built-in roles
  were re-confirmed against the live page on that date).
- `accessReviewScheduleDefinition`: service plan `AAD_PREMIUM_P2`; scope
  `AccessReview.Read.All`; roles Global Reader / Global Administrator.
  Source:
  <https://learn.microsoft.com/en-us/graph/api/accessreviewscheduledefinition-list?view=graph-rest-1.0>,
  retrieved 2026-09-22.
- `roleAssignment` (read): no license prerequisite; scope
  `RoleManagement.Read.Directory`; roles Global Reader / Directory Readers.
  Source:
  <https://learn.microsoft.com/en-us/graph/api/rbacapplication-list-roleassignments?view=graph-rest-1.0>,
  retrieved 2026-09-22.

Scope and role lists are *alternatives*: a dimension is confirmed missing
only when NONE of the acceptable scopes/roles is present in a usable,
complete read. Role matching is by well-known built-in role template id
(Microsoft-global, identical in every tenant — the same basis as
`directoryRoleTemplate` in the catalogue).

## Implementation and proof limitations

- Everything here is fixture-tested against synthetic payloads through the
  production `diagnoseFailure()` and `buildCoverageReport()` code paths and
  the isolated test database. No live tenant was touched; collector and
  restorer credentials remain separate and were not used; Conditional Access
  is never enforced by this task.
- The registry records *declared* prerequisites with documentation sources.
  A named diagnosis is a statement about KEEL's own collected evidence
  ("a complete read of this tenant proved no SKU carries this plan"), not a
  claim about what Microsoft Graph supports. Fixture-tested, not
  live-qualified.
- Consent evidence is the tenant's collected `oauth2PermissionGrant` set
  (delegated consent), and role evidence is the collected `roleAssignment`
  set. A scope/role is confirmed missing only when it appears *nowhere* in
  a complete read — the collector identity is not separately resolved, so a
  partially-satisfied dimension always degrades to `unknown`, never to a
  guessed named diagnosis. Custom roles whose permissions duplicate a
  built-in are not resolved to the built-in template id.
- Service-plan `provisioningStatus` values other than `Disabled` (including
  `Success`, `PendingInput`, `ErrorStatus`) are all treated as "owned, not
  confirmed missing": only `Disabled` yields `disabled-plan`, matching the
  rule that only a confirmed missing prerequisite is named.
- SKU, consent and role evidence is time-qualified per observation
  (`observedAt` from the digest entry or its snapshot window); these
  observations are not presented as an atomic tenant-wide snapshot.
- No schema or migration was needed: diagnosis reads the same `snapshot`
  coverage digests and `resource_version` payloads the report already
  consumes, and the `diagnosis` field is additive — legacy digests read
  exactly as before.
- The portal (`portal/lib/portal-data.ts`) normalizes known report fields
  and safely ignores the additive `diagnosis` field; rendering it is the
  task-54 lane (capability matrix and linked observation views), which
  depends on this task. No portal files were touched.
- The PIM/access-review license mapping (`AAD_PREMIUM_P2`) is declared from
  Microsoft documentation. Microsoft licenses some features per-user; this
  registry records the tenant-level plan prerequisite only — per-user
  entitlement is explicitly out of scope (rule 2), and its absence is why an
  enabled plan can never clear a failure.

## Boundary tests

`engine/roadmap/capability-diagnosis.test.mjs` exercises the production
`diagnosis.mjs`, `report.mjs`, `tenantRef.mjs` and `catalog.mjs` against
adversarial fixtures and the isolated test database, including the three
required mutation checks:

- Classify every 403 as missing license: a 403 with the plan owned and
  enabled, scope granted and role assigned stays `unknown` with its original
  code — at both the module and report seam. A 500/429/transport failure
  with a provably missing plan also stays `unknown`.
- Use older SKU success over newer failure: a newer failed SKU read
  supersedes the older success (order-independently), degrading the license
  dimension to unusable and the diagnosis to `unknown`; the mirror image
  (newer success over older failure) decides normally. Also pinned at the
  report seam, where the older run's successful SKU payloads exist in
  `resource_version` but must not justify `missing-license` after the newer
  read failed.
- Leak diagnosis into raw complete status: a confirmed `missing-license`
  diagnosis leaves `status: 'failed'`, `covered: false`, `outcome`,
  `itemCount`, `detail` and the report failure counts exactly as collected,
  and a covered type carries `diagnosis: null` and stays covered.

Two further boundaries are pinned explicitly (both survived an earlier
mutation review and now have dedicated coverage):

- `assertTenantRef()` is an anchored match: values that merely *embed* a
  `sha256:…` suffix inside a raw or prefixed tenant id are refused, so only
  an already-derived reference can anchor a diagnosis join.
- The report's diagnosis trigger is *failed-only*: in a report containing a
  diagnosable failure, never-collected and not-covered entries still carry
  `diagnosis: null` — there is no failure to explain, so nothing is invented.
