# Bounded policy configuration restore qualification (roadmap task-108)

## Status — 2026-10-03

Implemented and fixture-tested. **Nothing here is live-qualified.** Every claim
below is `fixture-tested`: the production `applyWave()` writer and read-back
verification ran against an in-memory fake Graph. That proves KEEL's code
behaviour, not Microsoft's, and not a real recovery.

## What changed

### Two subtype-bound operation records

The policy batch (task-107's `EXPANSION_BATCHES`) gets its first qualified
operations: **create and update of custom authentication strengths**. They are
explicit records in `engine/restore/policyOperations.mjs`
(`POLICY_OPERATION_RECORDS`, two of the allowed three) and registrations in
`engine/coverage/capabilities.mjs` with `subtype: 'custom'`:

| Operation | Route | Writes | Proof |
| --- | --- | --- | --- |
| create | `POST /policies/authenticationStrengthPolicies` | `displayName`, `description`, `allowedCombinations` | `engine/roadmap/policy-fidelity.test.mjs` |
| update | `PATCH /policies/authenticationStrengthPolicies/{id}` | `displayName`, `description` | `engine/roadmap/policy-fidelity.test.mjs` |

Both need `Policy.ReadWrite.ConditionalAccess` on the KEEL Restorer.

`delete` is not registered and is refused by `verbCapability()` before any
guard: a strength referenced by a Conditional Access policy cannot be removed
safely, and KEEL has no qualified guard for that. `allowedCombinations` changes
only through the `updateAllowedCombinations` action, which is not qualified; it
stays immutable for PATCH, so its drift is reported `not-remediable`, never
claimed fixed.

"Named policy configuration" in the task is read as the policy batch's named
families: named locations and Conditional Access policies were registered before
task-107 and are unchanged; every other named policy family stays refused (see
the ledger below).

### The write-time gate (`policyWriteRefusal`)

`applyWave()` runs it right after the capability gate, before the recovery gate,
deletion and sync guards, the rollback journal or any writer call:

1. **Built-in policies are immutable.** A resource whose snapshot payload, live
   payload or target id is a built-in strength (`policyType: 'builtIn'` or one of
   the three Microsoft-global ids `00000000-0000-0000-0000-00000000000{2,3,4}`)
   is **skipped** with `immutable built-in policy`. Skipped, not failed: nobody
   can write a built-in policy, and a drifted built-in must not halt a whole
   restore run. The live payload is re-checked, so a snapshot that says
   `custom` cannot be written onto a target that is built-in.
2. **A proof is never reused across subtypes.** The resource's subtype is read
   from `policyType` (never guessed from a name). A subtype with no record —
   missing `policyType`, or any value other than `custom` — fails with
   `no proof covers ... for subtype`. A target whose subtype differs from the
   snapshot's fails with `subtype change refused`.
3. **A proof is bound to its field projection.** Each record carries a SHA-256
   `projectionDigest` of the type's reviewed known fields, immutable and
   server-owned sets, create exclusions, the record's subtype and its writable
   fields. If any of those change, the digest no longer matches and every write
   of that operation fails with `proof invalidated: the ... field projection
   changed` until the operation is re-proven and the new digest recorded.

After a create, the object must read back as `custom`; otherwise the entry is
failed and its journal outcome is `uncertain`. A deferred reference patch
(`applyPatches`) is never sent for a policy-governed type: no record covers it.

### Unknown fields are never sent

- **Create:** `createProjection()` (new in `engine/reconcile/writableProjection.mjs`)
  splits the snapshot into reviewed writable fields and unknown ones; the body is
  then cut to the record's writable fields. Unknown fields (for example
  `combinationConfigurations`, or a property Graph adds later) are not sent and
  are listed on the applied entry as `unwrittenFields`, so they do not silently
  disappear. Verification compares exactly the fields written.
- **Update:** `writableProjection()` already drops unknown, immutable and
  server-owned fields. `policyPatchRefusal()` independently refuses a PATCH body
  carrying anything beyond the record's writable fields. An unknown field that
  differs in the target is reported as residual drift (failed), never claimed
  fixed.

`policyType` and `requirementsSatisfied` are now known and **immutable** (not
server-owned) for `authenticationStrengthPolicy`, and excluded from create
bodies. Immutable keeps them in the configuration hash, so every stored snapshot
hash is unchanged: no re-hash, no data migration, and legacy snapshots read as
before.

### Conditional Access restrictions are unchanged

A strength recreated in a run gets a new id; a Conditional Access policy that
references it through `grantControls.authenticationStrength.id` is remapped to
that id through the existing, proven CA create/update remapping, and is still
forced report-only. The test suite exercises this path end to end.

### Live qualification gate

`qualifyPolicyLiveEvidence()` accepts evidence only when it names the record's
subtype and the current projection digest, and that digest is still the proven
one; it then defers to `capabilities.mjs`'s `qualifyLiveEvidence()` (tenant,
freshness, non-synthetic, contract version). Nothing calls it today.

### Server, CLI and portal

- `cli/keel-restore.mjs` no longer filters `authenticationStrengthPolicy` out of
  a restore (it was "read-only in M1"). The portal's restore resource list and
  selection preview mirror the change, so what the preview shows is what the CLI
  plans. Built-in strengths in a selection are skipped by the engine as above.
- `node tools/qualification/operations.mjs --batch policy` runs both operations
  through `applyWave()` against the fake and prints the policy family ledger:
  each record's subtype, writable fields and whether its proof is current, the
  refused `builtIn` subtype and every remaining family with its route,
  permission and reason. The report is synthetic and never changes a claim.
- The coverage report's expansion record carries `qualifiedSubtypes` (derived
  from registered capabilities, never declared in the inventory). The Protect
  type record shows it as **Write subtypes**; an older report without the field
  reads "not recorded", never a stronger claim.

## Remaining policy family ledger

| Family | Status | Why it stays refused |
| --- | --- | --- |
| conditionalAccessPolicy | qualified-subset (before task-107) | create/update/delete, forced report-only |
| namedLocation | qualified-subset (before task-107) | create/update/delete |
| authenticationStrengthPolicy | qualified-subset (task-108) | custom create/update only; built-in refused; delete and `updateAllowedCombinations` not qualified |
| authenticationContextClassReference | research-needed | ids c1..c99 are fixed per tenant and consumed by CA policies and SharePoint labels; no upsert contract |
| authenticationMethodsPolicy | research-needed | tenant-wide singleton that can disable sign-in methods for everyone; no lockout simulation gate |
| authorizationPolicy | research-needed | tenant-wide singleton changing default user and guest permissions; no simulation gate |
| crossTenantAccessPolicy | research-needed | default applies to every external tenant; no simulation gate |
| crossTenantAccessPolicyPartner | research-needed | the partner is another tenant that cannot be verified from this one |
| permissionGrantPolicy | research-needed | built-in `microsoft-*` policies immutable; includes/excludes have no qualified writer |
| adminConsentRequestPolicy | research-needed | reviewer queries need remapping, not proven |
| activityBasedTimeoutPolicy | research-needed | unparsed definition string; tenant default vs per-app assignment not distinguished |
| claimsMappingPolicy | research-needed | service principal assignment is an unqualified edge; unparsed definition |
| homeRealmDiscoveryPolicy | research-needed | changes federated sign-in routing; unqualified assignment edge |
| tokenIssuancePolicy | research-needed | unqualified assignment edge; unparsed definition |
| tokenLifetimePolicy | research-needed | tenant default vs per-app assignment not distinguished; unparsed definition |
| featureRolloutPolicy | research-needed | applies-to group membership is an unqualified edge |

The source of truth is `EXPANSION_INVENTORY` in `engine/coverage/qualification.mjs`
and `buildPolicyFamilyLedger()`; this table is a copy for reading.

## Validation (2026-10-03, build container)

- Task Validate command (with `KEEL_DB_TEST_URL` and `KEEL_TENANT_CONFIG_PATH` set
  in place of `/etc/keel/db.env`): 42 tests, 42 passed.
- CI engine step from `.github/workflows/portal.yml` (now including
  `roadmap/policy-fidelity.test.mjs`, 12 tests): 213 passed. Portal `npm test`
  (131 passed), `typecheck`, `build` and `test:ui` (94 checks) passed.
- Existing tests adjusted for the new registration only: the capability
  registry's registered list, the ledger's supported-operation and harness counts
  (17 → 19), the remappable-is-not-a-write-gate check (now per operation, since
  every remappable type has some registration), and two assertions that used
  `authenticationStrengthPolicy` as their example of an unregistered type.
- Mutation checks, each reverted afterwards:
  - PATCH immutable built-in policy (the built-in refusal removed from
    `policyWriteRefusal`) → 1 test fails;
  - reuse proof across subtype (`policyWriteRefusal` looks the proof up for
    `custom` instead of the resource's own subtype) → 1 fails;
  - forward unknown fields into writer (the create path sends the snapshot
    minus create exclusions instead of `policyCreateBody()`) → 2 fail.

## Limits

- **Documentation not re-checked.** `learn.microsoft.com` is not reachable from
  the build container, so the routes, the built-in ids, the read-only status of
  `policyType`/`requirementsSatisfied` and the PATCH immutability of
  `allowedCombinations` were not re-fetched on 2026-10-03. They are declarations
  (consistent with the task-107 inventory and `tools/tenant-probe/references.mjs`)
  to confirm against the current Graph v1.0 reference before any live
  qualification (Global Constraint 8).
- **Restorer grant unverified.** Whether `Policy.ReadWrite.ConditionalAccess` is
  granted to the KEEL Restorer was not checked; no live run was made.
- **The fake is generous.** It assigns `policyType: 'custom'` and a fixed
  `requirementsSatisfied` on create. Real Graph computes `requirementsSatisfied`
  from the combinations, and may return combination configurations; live
  qualification will show whether verification needs more normalisation.
- **Combination configurations** (FIDO2 AAGUID and certificate restrictions per
  combination) are a separate collection, not collected or written: a recreated
  strength has none until they are added by hand. They are reported as
  `unwrittenFields` if a snapshot carries them inline.
- **Digest review is manual.** Changing the projection fails the write closed;
  re-proving and recording the new digest is a reviewed source change, never
  automatic.
- **No live evidence** exists; `qualifyPolicyLiveEvidence()` is the only route to
  `live-qualified`, and nothing in this task calls it.
