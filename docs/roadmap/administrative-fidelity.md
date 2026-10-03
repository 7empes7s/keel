# Bounded administrative configuration restore qualification (roadmap task-109)

## Status — 2026-10-03

Implemented and fixture-tested. **Nothing here is live-qualified.** Every claim
below is `fixture-tested`: the production `applyWave()` writer and read-back
verification ran against an in-memory fake Graph. That proves KEEL's code
behaviour, not Microsoft's, and not a real recovery.

## What changed

### Three operation records

The administrative-configuration batch (task-107's `EXPANSION_BATCHES`) gets its
first qualified operations. They are explicit records in
`engine/restore/administrativeOperations.mjs` (`ADMINISTRATIVE_OPERATION_RECORDS`,
the allowed three) and registrations in `engine/coverage/capabilities.mjs`:

| Operation | Route | Writes | Checks | Permission |
| --- | --- | --- | --- | --- |
| administrativeUnit update | `PATCH /directory/administrativeUnits/{id}` | `displayName`, `description` | source authority; live object present; post-state of written fields | `AdministrativeUnit.ReadWrite.All` |
| groupSetting update | `PATCH /groupSettings/{id}` | `values` | tenant-wide scope; source authority; template unchanged; value names defined by the template; post-state of every value and the template | `Directory.ReadWrite.All` |
| groupSetting delete | `DELETE /groupSettings/{id}` | none | tenant-wide scope; source authority; complete snapshot observation of the collection; absent after delete | `Directory.ReadWrite.All` |

Proof for all three: `engine/roadmap/administrative-fidelity.test.mjs`. None of
the permissions is verified as granted to the KEEL Restorer.

Every other verb stays unsupported and refused by `verbCapability()`:
administrative-unit create, delete and soft-delete restore; group-setting create
and soft-delete restore. `organization`, `domain` and `subscribedSku` are
unchanged (manual / unsupported).

### The write-time gate (`administrativeWriteRefusal`)

`applyWave()` runs it **before** the capability gate, so no journal entry, guard
or writer call happens for a refused write:

1. **Global reference templates are never written.** `directorySettingTemplate`
   and `directoryRoleTemplate` are Microsoft-published and identical in every
   tenant. Every verb is **skipped** with `global reference template`, whatever
   the registry says.
2. **Source authority.** The snapshot payload, the live payload and (for a
   group-scoped setting) the parent are each passed through
   `refuseIfSynced()` (task-111's source-authority rules). On-premises, hybrid,
   unknown or `onPremisesSyncEnabled: true` is **skipped** with
   `source authority: administrative write refused`. This gate runs for
   **delete too**: applyWave's generic sync check runs only on the non-delete
   branches.
3. **Tenant-wide settings only.** A setting that names a parent group
   (`/groups/{id}/settings`) fails as unsupported. Such settings are not
   collected today.
4. **A record must exist** for exactly (type, verb), and the registry must hold a
   supported claim for it.
5. **Dependencies (update).** A live object must have been observed. For a
   setting: the snapshot must name a template, that template must equal the live
   one (a setting is never rebound — templates are global constants), the
   snapshot must not repeat a value, every snapshot value name must be defined by
   the live setting, and every live value name must have been observed by the
   snapshot. The last rule matters because a setting PATCH carries the whole
   `values` list: a value the template gained after the snapshot would otherwise
   be reset silently.
6. **Observation completeness (delete).** A delete means "the snapshot proves
   this setting did not exist". That is evidence only when the source snapshot's
   coverage entry for `groupSetting` is `complete` or `complete-empty`. A
   `partial`, `failed`, `not-requested` or missing entry (or a missing digest)
   fails with `partial observation cannot authorise delete`. A delete whose
   snapshot still holds the object is refused.

At the writer boundary, `administrativePatchRefusal()` refuses a PATCH body with
any field outside the record's writable fields (a `templateId` above all),
independently of `writableProjection()`. After the PATCH,
`administrativePostStateRefusal()` checks every written field — values by name,
not position — and that a setting is still bound to its template. It runs
**before** the hash comparison, so a template that changed under the write fails
instead of reading as an immutable, not-remediable residual. Deferred reference
patches (`applyPatches`) are refused for governed types.

### Field classification (no legacy re-hash)

`engine/cir/serverOwned.mjs`: `groupSetting.templateId` and `displayName`, and
`administrativeUnit.visibility`, `isMemberManagementRestricted`,
`membershipType`, `membershipRule` and `membershipRuleProcessingState` are
**immutable**, not server-owned. Immutable fields stay in the canonical hash, so
every stored snapshot hashes exactly as before (no migration, no re-hash) and a
change to them still reads as drift, reported `not-remediable`.
`engine/contracts/fieldProjection.mjs` registers reviewed known-field lists for
both types, so a field Graph adds later is `unknown`: never written, reported.

### What cannot be recovered (evidence, not a percentage)

`UNRECOVERABLE_CONFIGURATION` in `engine/coverage/qualification.mjs` names, per
type of the batch, the configuration and relationships KEEL cannot put back,
each with a reason. It is reviewed by hand, kept apart from
`EXPANSION_INVENTORY` (which still refuses unrecognised fields), and carries no
coverage figure. A type without an entry has **not been assessed**, which is not
the same as "nothing is lost".

| Type | Kind | Not recovered | Why |
| --- | --- | --- | --- |
| administrativeUnit | relationship | `members` | separate edge, no qualified writer |
| administrativeUnit | relationship | `scopedRoleMembers` | separate edges, no qualified writer |
| administrativeUnit | configuration | visibility, restricted management | set only at creation; drift reported not remediable |
| administrativeUnit | configuration | dynamic membership rule | not qualified for writing |
| administrativeUnit | configuration | a deleted unit | create and soft-delete restore are not qualified |
| groupSetting | relationship | `templateId` | bound to a global template for life |
| groupSetting | configuration | values the snapshot never observed | a write would reset them, so it is refused |
| groupSetting | configuration | a deleted setting | create is not qualified |
| groupSetting | relationship | group-scoped settings | not collected or written |
| directorySettingTemplate | configuration | template catalogue | Microsoft-published; never written |
| organization, domain, subscribedSku | configuration | tenant object, domains, licences | unchanged reasons from task-107 |

### Server, CLI and portal

- **Restore CLI** (`cli/keel-restore.mjs`): `observedCoverageFor()` reads the
  source snapshot's `coverage_digest`, scoped to that snapshot's own tenant, only
  when the plan holds a governed delete, and passes it to both `applyWave()`
  calls as `observedCoverage`. Another tenant's snapshot reads as no evidence.
  The remediation path (`keel-remediate` → `runRestore`) gets this unchanged.
- **Qualification CLI** (`tools/qualification/operations.mjs --batch
  administrative-configuration`): runs the three operations through
  `applyWave()` against the fake Graph and prints the family ledger: each
  record's checks, the refusals and every unrecoverable item.
- **Coverage report and portal**: `expansionFor()` adds `unrecoverable` to each
  type's batch record. The coverage page's technical record shows it as
  "Cannot be recovered"; an older report, or an unassessed type, reads
  "not assessed", never "nothing". `portal/lib/portal-data.ts` treats a malformed
  list as not assessed.

No database schema changed; no migration was needed.

## Validation (2026-10-03, build container)

`/etc/keel/db.env` does not exist in the build container, so the exact Validate
command was run with `KEEL_DB_TEST_URL=postgres://keel@localhost:5432/keel_test`
and `KEEL_TENANT_CONFIG_PATH` exported against a local PostgreSQL 16:

```bash
node --test engine/roadmap/administrative-fidelity.test.mjs engine/restore/*.test.mjs engine/reconcile/*.test.mjs engine/safety/*.test.mjs engine/policy/*.test.mjs cli/keel-restore.test.mjs cli/keel-remediate.test.mjs cli/keel-worker.test.mjs
```

Result: 41 tests, 41 pass, 0 fail (the new file: 11 tests). Also run: the CI
engine step of `.github/workflows/portal.yml` (with the new file added): 256/256
pass; portal `npm run typecheck`, `npm test`, `npm run build` and
`npm run test:ui` (101/101) pass. A wider sweep of `engine/roadmap`,
`engine/coverage`, `engine/cir`, `engine/contracts`, `engine/collect` and `tools`
tests showed 13 failures that fail identically on `origin/master` in the same
container (foundation deploy path, pinned benchmark catalogues, rehearsal
round trip — environment, not this change).

Earlier suites that asserted `administrativeUnit`/`groupSetting` were
unregistered were updated to the new state: `fidelity-ledger` (22 supported
operations; the same-tenant remapping test now drives the registered
`groupSetting` update with a live observation; the declared-only test uses
`roleEligibilitySchedule`), `fidelity-expansion` (research-needed examples moved
to `roleEligibilitySchedule` and `oauth2PermissionGrant`) and
`capability-registry` (registered set).

Required mutation checks, each applied to
`engine/restore/administrativeOperations.mjs`, run, and reverted:

| Mutation | Result |
| --- | --- |
| Write global reference template (template branch disabled) | `mutation check: a global reference template is never written` fails |
| Write global reference template, variant (`templateId` writable and rebind check disabled) | `a setting is never rebound to another template` fails |
| Skip source-authority guard | `an object whose source of authority is not the cloud is refused for every verb` fails |
| Delete from partial observation (completeness check disabled) | `a delete needs a complete snapshot observation` and the CLI coverage test fail |

## Limits

- **Fixture evidence only.** No live tenant was read or written; every claim is
  `fixture-tested`. Routes, field lists and the "PATCH carries the whole values
  list" behaviour are declarations from the Graph v1.0 reference as remembered,
  not re-fetched: learn.microsoft.com is not reachable from the build container
  (Global Constraint 8). Confirm them before any live qualification.
- **Delete evidence comes from the source snapshot only.** The live side relies
  on the existing collector, which throws on an incomplete enumeration rather
  than returning a partial list. Compensation runs pass no `observedCoverage`, so
  a governed delete inside a compensation is refused; none is reachable today
  because no governed create is registered.
- **Restricted-management units.** An administrative unit with
  `isMemberManagementRestricted: true` is updated like any other; KEEL does not
  check whether the Restorer holds a scoped role on it, so Graph may refuse the
  PATCH (reported as a failed write).
- **Dynamic units.** The display name and description of a dynamic unit are
  updated; the rule itself is never written.
- **Group-scoped settings** are neither collected nor written.
- **No live qualification gate** was added for these records: promotion would go
  through `capabilities.mjs`'s `qualifyLiveEvidence()` like any other operation.
