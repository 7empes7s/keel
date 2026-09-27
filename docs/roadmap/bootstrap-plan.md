# Least-privilege onboarding prerequisite planner (task-74)

Date: 2026-09-25 UTC. Status: implemented, fixture-tested only. No live
qualification is claimed; nothing in this task provisions, consents or
mutates a tenant.

## What was built

- `engine/bootstrap/prerequisites.mjs` (new) — the versioned, source-linked
  workload prerequisite registry. Four grant kinds are distinguished because
  four different authorities satisfy them: `graph-permission` (admin
  consent), `workload-rbac` (workload-side role assignment, e.g. an Intune
  RBAC role), `pim-activation` (privileged Entra role elevation for the
  onboarding operator) and `keel-app-permission` (KEEL-internal `keel.*`
  capabilities on the app registration).
  `registerWorkloadPrerequisite()` is the ONLY way a grant becomes plannable
  — never inferred from a CATALOG path, a capability claim or a SKU. Three
  rules are enforced at the boundary:
  1. `FORBIDDEN_BROAD_GRANTS` (whole-directory write, mailbox/file content,
     `full_access_as_app`) are refused at registration AND at plan-request
     time — content access is outside KEEL's configuration-only scope.
  2. `identity` is one of `engine/coverage/capabilities.mjs`'s
     CREDENTIAL_MODES; a collector registration carrying a ReadWrite scope is
     refused, so collector and restorer credentials can never collapse into
     one registration (Global Constraint #2).
  3. Every entry cites its documentation `source.url` and `retrievedAt`
     (Global Constraint #8).
  Registered workloads: `entra-collect` (collector: User/Group/
  RoleManagement/Policy read scopes, `keel.collect`), `intune-collect`
  (collector: DeviceManagement read scopes + Intune `Read Only Operator` RBAC
  role, resolved per-tenant — built-in Intune role ids are tenant objects, so
  the plan names the role and defers the id lookup rather than inventing a
  GUID) and `entra-restore` (restorer: Group/ConditionalAccess/RoleManagement
  write scopes + Privileged Role Administrator PIM activation, `keel.restore`).
  Sources: <https://learn.microsoft.com/en-us/graph/permissions-reference> and
  <https://learn.microsoft.com/en-us/intune/intune-service/fundamentals/role-based-access-control>,
  both re-checked 2026-09-25.
- `engine/bootstrap/plan.mjs` (new) — `planBootstrap()` turns the registered
  requirements plus current app/SP state into a resumable, immutable plan.
  Tenant state is read EXCLUSIVELY through injected read adapters
  (`listApplications`, `listServicePrincipals`, `listAppRoleAssignments`,
  `listRoleAssignments`, `listRoleEligibilitySchedules`, `listSubscribedSkus`)
  — the planner never calls Microsoft Graph itself, and adapter records from
  another tenant throw `CrossTenantObservationError`. Rules:
  1. Least privilege by construction: the plan asks for exactly the derived
     grants; a caller-supplied `requestedGrants` must be a subset of the
     derivation, so an unrelated or forbidden broad grant is rejected before
     any tenant state is read.
  2. An existing registration whose `requiredResourceAccess` covers the
     derived scopes is REUSED (`reuse-existing`, reference-only projection of
     `{ objectId, appId, displayName }`); an incomplete one is
     `update-required-access`. The plan never recreates an existing app.
  3. Admin consent satisfies `graph-permission` steps ONLY
     (`CONSENT_SATISFIES`). The plan's `consent` block names the consent
     scopes per identity and states explicitly that it never satisfies
     `workload-rbac`, `pim-activation` or `keel-app-permission` — one consent
     cannot provision every workload, and privileged role requirements are
     never bypassed. Missing PIM/role/consent stays an explicit named
     `pending-manual`/`pending-consent` step in `manualPrerequisites`.
  4. A purchased SKU is recorded under `licensing.observedSkus` for operator
     visibility with an explicit "never satisfies or substitutes" note and is
     never consulted to satisfy a step.
  5. Resumability: `planId` and step ids are content hashes independent of
     step state and creation time, so re-planning against fresh state closes
     satisfied steps while pending steps keep their identities. Execution and
     journaling belong to task-75 (`engine/bootstrap/execute.mjs`,
     `journal.mjs`); this module plans only.
- `tools/tenant-probe/auth.mjs` — new `assertTokenFree()` guard: recursively
  refuses JWT-shaped strings (`eyJ…` three-segment base64url) and
  secret-named fields (`accessToken`, `clientSecret`, `authorization`, …)
  before a value is persisted or rendered. `planBootstrap()` runs it over
  every finished plan, so a mutated writer that logs a token into the
  prerequisite report throws instead of emitting it (Global Constraint #7).
  `getToken()`/`decodeRoles()` are unchanged.

## Implementation and proof limitations

- Everything here is fixture-tested through the production
  `planBootstrap()`/`registerWorkloadPrerequisite()` code paths with fake
  read adapters. No live tenant was touched, no app was registered, no
  consent was granted, no PIM role was activated; collector and restorer
  credentials remain separate and unused; Conditional Access is never
  enforced by this task.
- The registry records *declared* prerequisites with documentation sources —
  fixture-tested code behavior, not live-qualified tenant evidence (Global
  Constraint #6). A satisfied step means "the injected reader observed the
  prerequisite", never that Microsoft Graph supports an operation.
- The plan models satisfaction, not execution: there is no write path, no
  journal and no CLI here (task-75's lane), and no portal surface (task-76's
  lane). No schema or migration was needed — plans are computed from
  observed state and carry stable content-hash identities, so nothing is
  persisted yet and there is no legacy data to read.
- Workload-RBAC satisfaction for `workload-lookup` roles matches the
  assignment display name the adapter reports; the per-tenant role
  definition id is resolved at execution time (task-75). PIM satisfaction
  requires an identified `operatorPrincipalId`; without one the step stays
  `pending-manual` and is never assumed.
- The Intune RBAC mapping (`Read Only Operator` for read-only collection)
  follows Microsoft's least-privilege guidance on the Intune RBAC page
  (retrieved 2026-09-25); per-tenant custom roles with equivalent rights are
  not resolved.

## Boundary tests

`engine/roadmap/bootstrap-plan.test.mjs` (26 tests) exercises the production
planner and registry against adversarial fixtures through injected fake read
adapters — the real integration seam — including the three required mutation
checks:

- Treat admin consent as all workload authority: with every Graph scope
  consented, the `workload-rbac` (Intune Read Only Operator) and
  `pim-activation` steps stay `pending-manual`, and the plan's consent block
  states `satisfiesKinds: ['graph-permission']` with the other three kinds in
  `neverSatisfies`.
- Recreate existing app unconditionally: a fully correct registration yields
  `reuse-existing` with a reference-only projection and no
  `create-registration` step anywhere; an incomplete registration yields
  `update-required-access` naming the missing scopes — never a recreate.
- Log token in prerequisite report: `assertTokenFree()` throws on JWT-shaped
  values and secret-named fields (including nested), and a plan built from
  adapter state poisoned with a token and client secret contains neither the
  values nor the field names.

Further pinned boundaries: raw (unhashed) tenant ids and cross-tenant
adapter records are refused; the planner reads exclusively through the
injected adapters (missing adapter method throws; call log asserts all six
reads); unregistered workloads and unrelated/forbidden requested grants are
rejected before any tenant state is read; a purchased E5 SKU never closes a
missing consent scope; an unidentified operator's PIM eligibility is never
assumed; re-planning keeps `planId` and step ids stable as steps close; and
collector/restorer workloads produce separate `keel-collector`/`keel-restorer`
registrations with no write scope on the collector.

## Requeued review verification

The working tree already contains the three reported fixes and their boundary
fixtures. Workload RBAC requires the current identity's service-principal id;
registration completeness counts only Microsoft Graph resource access; and
cross-tenant records are independently rejected for all six read adapters,
including `listRoleEligibilitySchedules`. Consent fixtures also reject grants
for another principal or resource. No production redesign was needed.

On 2026-09-25, all 20 planner tests passed. Each of the three required mutations
above was then applied independently and killed. The three previously surviving
mutations were independently killed as well:

- Removing the eligibility reader's tenant check fails test 17.
- Removing the workload-RBAC principal check fails test 18.
- Removing the registration resource-app filter fails test 20.

Production source was restored byte-for-byte after each mutation. These checks
use injected fixtures only and do not establish live qualification.

## Second requeued review verification — 2026-09-26

The remaining gaps were missing adversarial fixtures, not missing production
checks. Per Global Constraint 12, production behavior was preserved. Three new
boundary tests exercise the production planner through injected read adapters:

- Test 21 registers a synthetic directory-role-template requirement and checks
  absent assignments, matching names with wrong templates, matching templates
  on other principals, and the correct template with a different display name.
  This is branch coverage only, not a new production workload or authority claim.
- Test 22 independently exercises standing assignments and PIM eligibility:
  an unrelated privileged role or another operator's required role leaves the
  named manual prerequisite pending; the identified operator's required role
  satisfies the existing reader contract.
- Test 23 observes a complete app with no SP, an unrelated SP, and the matching
  SP. Only the last permits satisfied/reuse-existing registration, consent and
  RBAC. The app reference and resumable plan/step identities remain stable.

All 23 planner tests passed. Eight independently applied mutations were killed:
admin consent as workload authority; unconditional app recreation; token in the
report; directory-role-template bypass; directory-role display-name fallback;
PIM standing role-template bypass; PIM eligibility role-template bypass; and
SP-absent registration reuse. Each production mutation was restored byte-for-byte.

All evidence uses fixtures. The existing PIM reader contract treats observed
eligibility as satisfying the prerequisite; it does not prove an active PIM
session or execute activation. No external API implementation, persistent schema,
CLI or UI was added in this review. No live tenant writes or service restarts
were performed, and Conditional Access was never enforced.

## Third requeued review verification — 2026-09-26

Preserved the existing production implementation under Global Constraint 12
and added three missing boundary tests through the injected reader seam:

- Null-principal records independently exercise standing assignments and PIM
  eligibility with an unidentified operator. Both leave the named prerequisite
  pending-manual, even when the role template matches.
- Credential-shaped values in projected app/SP ids, consent scope strings and
  SKU names must reject the entire plan. A malformed app id containing a nested
  secret field also rejects. These fixtures reach the finished-plan token guard;
  removing that guard now fails the suite. Rejection messages omit fixture secrets.
- Every nested object and array in a returned plan must be frozen. Attempts to
  change step status, app references, operator roles, scope arrays, manual actions
  or source records throw and leave the serialized plan unchanged.

All 26 planner tests passed. Seven independent mutations were killed: removing
the PIM eligibility operator guard; removing the standing-assignment operator
guard; removing the finished-plan token guard; skipping array-element freezing;
treating consent as workload authority; unconditionally recreating an app; and
inserting a fixture token in the report. Production source was restored
byte-for-byte after every mutation. These are fixture proofs only; this review
adds no external API behavior, schema, CLI, UI, live qualification or tenant writes.
