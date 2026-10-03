# CMDB-first ownership and explicit shared scope (task 89)

## Status — 2026-10-03

Implemented at current HEAD on top of task 50's resource lineage and the
existing `can` capability check. **Fixture-tested only.** No employer CMDB was
contacted, and no live CMDB provider is claimed or qualified. The task names no
portal surface. Entity-scoped reads, approval eligibility and their UI belong to
task 90, so this task adds no portal page, nav entry or `ui.spec.ts` allowlist entry.

## Resolution

`resolveOwnership(client, options)` in `engine/identity/ownership.mjs` resolves
one `(tenant, resource type, source id)` resource:

1. The resource must have a task-50 lineage in that tenant. Ownership is bound
   to `resource_lineage.id`, never to a name. A resource without a lineage is
   refused. A tombstoned lineage records `unknown` (`resource-tombstoned`).
2. The configured CMDB adapter is queried by resource type and source id only.
   Owner values map to entity codes through trusted configuration:
   - one mapped entity: `owned`
   - several entities, any unmapped owner value, or a record the CMDB marks
     `shared`: `shared`, which needs central approval
   - a record with no mappable owner: `unknown`
3. **Entity-code fallback.** Only when the CMDB answers `not-found`, the
   resource's *current* name (the part after `type:` in its natural key) is
   checked for a configured entity prefix followed by `-`, `_` or a space. The
   match is case-sensitive, for example `CRE-…` → CREOS and `ENO-…` → ENOVOS.
   No prefix gives `unknown`.
4. **Failure.** Any thrown error, timeout (`lookupTimeoutMs`, default 5 s,
   max 60 s), abort or malformed answer records `unresolved`, with no entity and
   `expires_at = observed_at`. A failure never uses the fallback, never keeps the
   previous owner as current and never grants a global or cross-entity allowance.

Configuration (trusted server/operator input, never a request body):

```json
{ "entities": {
    "CREOS":  { "cmdbValues": ["Creos Luxembourg S.A."],  "codePrefixes": ["CRE"] },
    "ENOVOS": { "cmdbValues": ["Enovos Luxembourg S.A."], "codePrefixes": ["ENO"] } },
  "maxEvidenceAgeMs": 86400000, "lookupTimeoutMs": 5000 }
```

CMDB values are matched trimmed and case-insensitively. A value or prefix that
maps to two entities is a configuration error. Freshness is
`min(observed_at + maxEvidenceAgeMs, record validUntil)`. The default age is
24 h and the maximum is 30 days.

## Evidence and history

`resource_ownership_evidence` (in `engine/store/schema.sql`, `CREATE … IF NOT
EXISTS`, additive and retry-safe) is tenant-scoped and append-only. Each
resolution supersedes the current row by setting `superseded_at`, and never
rewrites state, entity, record reference or time. A partial unique index keeps
one current row per lineage, and a row lock on the lineage serializes concurrent
resolutions. Each row records the natural key observed at resolution time for
display only. Ownership is never looked up by that key.

So when a resource moves from Creos to Enovos, the evidence an earlier approval
cited (`ownershipEvidenceById`) still reads Creos, with the moment it was superseded.

## Authorization seams

- `ownershipAllowsWrite(client, {…, capability, entityCode, evidenceId?, at})`
  allows a write only when the principal currently holds `capability` (the
  existing `can`), the managed tenant matches, the lineage is live, and the
  current evidence is `owned` by `entityCode` and unexpired at `at`. If an
  `evidenceId` is passed, it must still be the current evidence. Otherwise the
  refusal is `ownership-changed`.
  - `shared` refuses with `handoff: 'central'`.
  - `unknown` and `unresolved` refuse, and so do expired, missing,
    never-resolved, not-configured and tenant-mismatched evidence. Nothing
    returns a global allowance.
- `resolveOwnership` requires current `collect`. `readOwnership` and
  `ownershipEvidenceById` require current `read`. The adapter's `tenantRef` must
  equal the managed tenant.
- **Legacy reads.** If the table is absent, `readOwnership` reports
  `not-configured` with no owner, and writes refuse with
  `ownership-not-configured`.

## CMDB adapter contract

The contract is in `engine/identity/adapters/cmdb.mjs`:
`lookup({resourceType, sourceId, signal})` returns
`{status:'found', recordRef, owners, shared?, validUntil?}` or
`{status:'not-found'}`, or throws. `createFixtureCmdbAdapter` is synthetic and
network-free. Lookups are keyed by source id; there is no name lookup. It can
model a single failed record, a full outage and a record moving
(`setRecords`). A real provider must implement this contract and be qualified
separately. Under Global Constraint 8, that qualification records the vendor
documentation URL, retrieval date and credential mode, and none exists today.

## CLI

`keel-worker.mjs --ownership-config FILE [--ownership-report]` runs one
resolution or report through `runOwnershipCommand`. The file holds `tenantRef`,
`managedTenantRef`, `requestedBy`, `resourceType`, `sourceId`, `ownership`
(the configuration above) and `fixtureRecords`. Only the fixture adapter is
wired, and without `fixtureRecords` the command refuses. It starts no queue job.

## Validation (2026-10-03, isolated local PostgreSQL 16)

- `node --test engine/roadmap/ownership.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs`: 13 pass, 0 fail.
- CI engine suite with `roadmap/ownership.test.mjs` added (plus lineage and audit-ingestion): 149 pass, 0 fail.
- Portal: `npm test` 130 pass, `npm run typecheck` clean, `npm run build` succeeds.
- Required mutations, each reverted:
  - Global-allow on CMDB failure (failure becomes all-entity `shared` and shared allows): tests 2 and 3 fail.
  - Failure treated as not-found (fallback/stale owner): test 3 fails.
  - Merge ownership by display name (inherit prior `owned` evidence with the same natural key): test 4 fails.
  - Ignore evidence expiry: test 5 fails.

## Limits

- Synthetic Creos/Enovos fixtures prove code behavior only, not CMDB data quality or availability.
- Principal-to-entity scope is not modelled here. Callers pass the acting
  `entityCode`. Binding principals to entities, scoped reads/counts/exports and
  central-approver eligibility are task 90's.
- Resolution is per resource and on demand. No scheduled refresh or bulk
  backfill was added, and expired evidence simply refuses until it is re-resolved.
- The existing approval flow does not yet store `evidenceId`. The seam that
  invalidates a stale decision exists, and wiring it into approvals is task 90/91.
