# Qualified SharePoint configuration restore (task 103)

Date: 2026-10-03 UTC. Status: implemented and fixture-tested only. The write ships
**disabled**. No tenant was read or written.

## What was built

### The restore (`engine/restore/workloads/sharepoint.mjs`)

It writes back one kind of setting: the tenant-wide sharing settings at
`PATCH /admin/sharepoint/settings`. It writes only the five fields the task-102 reader
observes:
- `sharingCapability`
- `sharingDomainRestrictionMode`
- `sharingAllowedDomainList`
- `sharingBlockedDomainList`
- `isResharingByExternalUsersEnabled`

| Source item | What happens |
| --- | --- |
| Tenant field observed in the source and different from today | Written, then read back and compared |
| Tenant field `denied`, `failed` or `unknown` in the source | Manual: there is no value to restore from |
| Site `displayName`, `name` | Manual: KEEL does not write site properties |
| Site `appPermissionGrants` | Manual: a grant gives an application access to site content, so a person re-grants it |
| Site `webUrl`, `hostname`, `createdDateTime`, `lastModifiedDateTime` | Excluded: server-owned, never written |
| Per-site sharing, lock state, label, access policy, guest expiry | Manual: not read by KEEL (needs the SharePoint admin interface) |

**Flow:**
1. `loadSharePointSource` reads a recorded task-102 collection.
2. `planSharePointRestore` builds a frozen plan. The plan holds:
   - the source;
   - the exact PATCH body (only the changed fields);
   - manual and excluded items;
   - content effects;
   - a fingerprint of every live setting Graph returned;
   - a digest over all of it.

   A source from another SharePoint host is refused.
3. `createSharePointRestoreArtifact` persists the plan as a `restore_dry_run` artifact
   (`workload_restore` column, no Entra snapshot). The task-66 approval
   (`approveContentEffects`) and gate (`assertContentEffectApproval`) apply unchanged.
4. `executeSharePointRestore` runs these checks in order, and stops at the first that
   fails:
   1. The artifact is promotable, its stored plan still matches its digest, and it
      targets the same SharePoint host.
   2. The write is qualified. Otherwise the outcome is `disabled` and **no request is
      sent**.
   3. The content effects are approved. Otherwise the outcome is
      `blocked-content-effect` and no request is sent.
   4. The settings are re-read. Any change since the plan (any field, not only the ones
      being written) is `stale`, and nothing is written.
   5. The PATCH is sent once. A preservation-lock refusal is `refused` and is never
      retried. Any other failure is `failed` and is not retried automatically.
   6. The settings are read back. Each written field must match, or the outcome is
      `verification-failed`.

Every outcome is appended to evidence as `workload-restore`.

### Content effects (`engine/safety/contentEffects.mjs`)

`sharepointTenantSettings` is a reviewed type. Each of these is `externally-sharing`:
- `sharingCapability` widens (disabled < existing guests < new guests < anyone).
- `isResharingByExternalUsersEnabled` turns on.
- `sharingDomainRestrictionMode` widens (allowList < blockList < none).
- A domain leaves `sharingBlockedDomainList`.
- A domain joins `sharingAllowedDomainList`.

Each one needs the separate approval of exactly those effects: by someone other than
the requester, who still holds `approve` when the restore runs.

### Write qualification (`engine/coverage/qualification.mjs`)

`WORKLOAD_WRITE_OPERATIONS` declares `sharepoint.tenant-settings.update`.
`workloadWriteQualification` enables it only when both of these hold:
- **The read-back is enabled.** `sharepoint.tenant-settings` is enabled in the task-101
  ledger for this tenant.
- **A live write capture exists**, with all of these properties:
  - `kind: 'live-write-capture'` and `synthetic: false`;
  - the same tenant;
  - version `v1.0`;
  - no older than 30 days;
  - `ok` and `readBackVerified`.

A fixture result gives `fixture-tested`, which stays disabled. These writes are not
catalogue types: they are not in `TYPE_DECISIONS` or the Entra capability registry.

### Wave planner (`engine/restore/wavePlanner.mjs`)

`planWaves` and `planDeletionWaves` refuse `sharepointTenantSettings` and
`sharepointSite`. Workload configuration never runs as an Entra wave.

## Proof

`engine/roadmap/sharepoint-write.test.mjs` has 7 tests against the isolated database
and an in-memory `/admin/sharepoint/settings`:

- **Plan.** It writes only supported, changed fields. A denied source field becomes
  manual. Site items are manual and server-owned fields are excluded. The plan is
  frozen. A source from another host is refused.
- **Waves.** Workload types never enter Entra waves.
- **Zero writes when unqualified.** Each of these sends zero requests:
  - a fixture pass only;
  - a synthetic capture;
  - a capture from another tenant;
  - a write that was not read back;
  - a read-back that is not enabled;
  - no qualification at all.
- **Restore.** A verified restore is GET, PATCH, GET, with only the changed field in
  the body. A write the platform ignores is `verification-failed`. A different target
  host is refused.
- **Exact approval.** Widening sharing is blocked with no request. The requester's own
  approval is refused, and so is an approval of a partial effect set. The exact
  approval succeeds.
- **Concurrent change.** A setting changed after the plan is `stale`, with no write.
- **Preservation lock.** It is refused after exactly one PATCH. A tampered stored plan
  is refused before any request.

Mutation checks, each caught by one failing test:

| Mutation | Result |
| --- | --- |
| Enable the write on a fixture pass | 6 pass, 1 fail |
| Bypass the content-effect approval | 6 pass, 1 fail |
| Skip the concurrent-change check (overwrite) | 6 pass, 1 fail |

Validation command (37 tests, all pass):

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/sharepoint-write.test.mjs engine/restore/*.test.mjs engine/reconcile/*.test.mjs engine/safety/*.test.mjs engine/policy/*.test.mjs cli/keel-restore.test.mjs cli/keel-remediate.test.mjs cli/keel-worker.test.mjs
```

## Limitations

- **No live proof.** Nothing was written to a tenant. The field names and the
  `PATCH /admin/sharepoint/settings` shape were declared from Microsoft's Graph
  documentation, which could not be re-fetched from this environment. Task-120 holds
  the live qualification.
- **No worker job kind yet.** No worker job or portal action calls
  `executeSharePointRestore`. A job kind would need a capability mapping and an
  approval flow, and it could not run anything before task-120 qualifies the write.
  Until then, the module is reachable only from tests.
- **No retention fields.** SharePoint retention lives in Purview, not in these
  settings. A retention change is not something this restore can make.
- **Tenant settings only.** Per-site settings stay manual until the SharePoint admin
  interface is qualified.
- **Does not recover content.** Restoring a sharing setting never recovers content that
  was shared or deleted in between, and this restore makes no content recovery claim.
