# App grant owner and Intune assignment observations (task-58)

Date: 2026-09-30 UTC. Status: implemented, fixture-tested only. No live
qualification is claimed; nothing here mutates a tenant, and observing an edge
implies no write capability.

## What was built

All in `engine/collect/relationships.mjs` (extending task-57's child-read
registry; nothing is inferred from the tenant-probe CATALOG):

- New explicit families, each pinning endpoint, API version and the Graph
  permission a collector needs (`requires`):
  - `appOwner` — `/applications/{id}/owners` (Application.Read.All)
  - `servicePrincipalOwner` — `/servicePrincipals/{id}/owners` (Application.Read.All)
  - `appRoleGrant` — `/servicePrincipals/{id}/appRoleAssignments`
    (Application.Read.All). The edge is (resource API, appRoleId);
    `createdDateTime` is volatile and excluded, so re-reading never manufactures
    drift.
  - `assignment` — Intune assignments, ONE family routed by parent type to
    four pinned endpoints: `deviceConfiguration`, `deviceCompliancePolicy`,
    `mobileApp` (v1.0) and `configurationPolicy` (settings catalog, **beta**).
    Permissions: DeviceManagementConfiguration.Read.All, and
    DeviceManagementApps.Read.All for apps.
- Assignment projection: the EDGE is what an assignment targets (target kind +
  group/collection). The assignment filter (`filterId`, `filterType`), intent,
  target type/mode and a digest of `settings` are edge ATTRIBUTES, preserved
  and compared. An include and an exclude of one group are two edges. An
  unrecognized target type is kept with mode `unknown`, never dropped; an item
  with no target makes the read `partial`.
- Unsupported subtype: any parent type without a registered assignment
  endpoint (enrollment configurations, intents, autopilot profiles, ...)
  yields an observation with outcome `unsupported`. Nothing is read, no generic
  endpoint is guessed, the state is `unknown` with null targets, and the diff
  reports it as `unverified` / `unsupported-relationship`, never as drift.
- `engine/store/schema.sql` — additive: `relationship_edge.edge_key` and
  `attributes`; existing task-57 rows are backfilled `edge_key = target_source_id`;
  the old (set, target) primary key is replaced by a unique index on
  (set, edge_key) so two edges may share a target. Retry-safe.
- `engine/govern/diffSnapshots.mjs` — `diffRelationships()` compares by edge
  identity: a new key is `added`, a missing key `removed`, a same-key edge with
  different attributes is `modified` (with before/after attributes — this is
  how a filter change reads). Drift resource types are distinct
  (`appRoleGrant`, `policyAssignment`, `applicationOwnership`, ...), so an app
  grant change and an Intune assignment change are separate edge drift.
- `collectSnapshot(..., { relationships: { families, parentTypes } })` selects
  parents by the types the requested families apply to; `parentTypes` names
  extra types (e.g. an unsupported one) explicitly. `true` still means the
  group member/owner default.
- `engine/coverage/report.mjs` — relationship summaries are per parent type
  (application, servicePrincipal, Intune types, group). `partial` when any
  read is current/stale, never `complete`; an `unsupported` count appears only
  when present, and an entry with only unsupported reads stays `unknown`.
- Missing permission: a 403 is a `failed` child read carrying the original
  Graph code and HTTP status — state `unknown`, cardinality null, never empty.

## Implementation and proof limitations

- The Microsoft documentation site was not reachable from this build
  environment (egress blocked), so endpoint paths, API versions and required
  permissions are DECLARED from prior knowledge of the Graph reference and were
  **not re-verified against the official pages on 2026-09-30** (Global
  Constraint 8). They are fixture-tested, not live-qualified. Verify each
  `requires`/path against the current docs before relying on a claim.
- The collector registration in `engine/bootstrap/prerequisites.mjs` does not
  yet list `Application.Read.All` or `DeviceManagementApps.Read.All`. Until it
  does, a collector onboarded from that plan will see these families fail with
  403 — reported honestly as failed coverage. Extending the registry belongs to
  the onboarding lane and was not widened here.
- Intune RBAC for the collector service principal is a separate authority
  from Graph consent (task-74) and is not modelled here.
- Only the four listed Intune parent types are supported; other subtypes stay
  unknown. Edges are opt-in per run; the scheduler does not enable them.
- Assignment `settings` are compared by digest only; the raw settings are not
  stored on the edge.

## Boundary tests

`engine/roadmap/privilege-relationships.test.mjs` (14 tests), including the
real `GraphReader` (stubbed fetch) walking three pages. The three required
mutations were each applied and killed:

- Drop assignment filter from projection.
- Mark unsupported subtype complete.
- Ignore the page-cap cut (a capped read reported complete).
