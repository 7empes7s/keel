# OneDrive container settings and Purview label configuration (task 106)

Date: 2026-10-04 UTC. Status: implemented and fixture-tested only. Every read and every
write ships **disabled**. No tenant, OneDrive site, label or label policy was read or
written.

Tasks 120, 121 and 122 merged only their code halves: SharePoint, Teams and Exchange are
not live-qualified yet. OneDrive and Purview both need Exchange to be qualified first,
and Exchange needs Teams and SharePoint. So nothing in this task can be enabled today,
even with OneDrive or Purview evidence.

## What was built

Two configuration families, each declared by task-101 and each with its own proof:

| Family | Read operation | Cmdlet | Session |
| --- | --- | --- | --- |
| OneDrive site settings | `onedrive.site-settings` | `Get-PnPTenantSite -Identity <personal site URL>` | PnP |
| Purview label definitions | `purview.label-definitions` | `Get-Label` (no parameters) | Security & Compliance (`Connect-IPPSSession`) |
| Purview label publishing | `purview.label-publication` | `Get-LabelPolicy` (no parameters) | Security & Compliance |

No new table and no migration: runs use the existing `workload_collection` and
`workload_observation` tables.

### OneDrive reader (`engine/collect/workloads/onedrive.mjs`)

- **Named sites only, no crawl.** The operator names personal site URLs on the tenant's
  `-my.sharepoint.com` host (at most 50 per run). Each is read with one
  `Get-PnPTenantSite -Identity`. Nothing lists OneDrive sites, and nothing reads
  anything inside one: files, folders, list items, sharing links, item labels and
  per-file permissions are never requested. A URL on another host, a path inside a site,
  a query or a fragment is `refused` and nothing is sent.
- **Only the OneDrive cmdlet.** The Node allowlist (`ONEDRIVE_CMDLET_PARAMETERS`) and the
  container allowlist (`$AllowedPnP` in `ops/powershell/run-cmdlet.ps1`) both hold only
  `Get-PnPTenantSite` with `Identity`.
- **A SharePoint site is not OneDrive.** An answer whose `Template` is not a personal
  site (`SPSPERS…`) is `refused` (`NOT_ONEDRIVE`). SharePoint's site reading is not
  reused.
- **Inherited versus explicit.** Each kept field records `inheritance` next to its value.
  The table is declared from the PnP and SharePoint Online documentation, not measured:

  | Field | Inheritance rule |
  | --- | --- |
  | `DefaultSharingLinkType`, `DefaultLinkPermission` | `None` means the site follows the tenant default (`inherited`); any other value is `explicit` |
  | `ExternalUserExpirationInDays` | `inherited` unless `OverrideTenantExternalUserExpirationPolicy` is true |
  | `AnonymousLinkExpirationInDays` | `inherited` unless `OverrideTenantAnonymousLinkExpirationPolicy` is true |
  | `StorageQuota`, `StorageQuotaWarningLevel` | `undetermined`: the answer does not say |
  | sharing capability and domain lists, override flags, `LockState`, `SensitivityLabel` (the site's container label), `ConditionalAccessPolicy`, `Owner`, `Template` | `explicit` |

  An inherited value is recorded as the value the site shows. KEEL does not read the
  tenant's OneDrive defaults, so the effective tenant value behind it is not claimed.
- **Comparison.** `compareOneDriveSites(before, after)` reports three different kinds of
  change:
  - `value`: the site's own value changed;
  - `inheritance`: the site started or stopped following the tenant default. This is a
    change even when the shown value is the same;
  - `inherited-default`: both sides follow the tenant default and the shown value moved.
    That is a tenant change, not a site change (`siteChange: false`).

  An observation recorded without inheritance (a legacy row) reads as `undetermined`,
  never as `explicit`.
- **Read-only.** No OneDrive write is declared, so every change is `restore: 'manual'`.
  A site whose `LockState` is anything but `Unlock` is flagged `locked`. Its changes say
  KEEL never changes or unlocks it.

### Purview reader (`engine/collect/workloads/purview.mjs`)

- **Definitions, never labeled content.** Only `Get-Label` and `Get-LabelPolicy` run,
  without parameters. KEEL never lists files, mail or sites to find which carry a label.
  It never reads an item-applied label and never counts label usage. Any field of an
  answer beyond the declared list (for example, usage counts) is dropped unread.
- One observation per label (`label:{immutable id}`) and per policy
  (`label-policy:{immutable id}`), with coverage per field. An answer without an
  immutable id is counted as `unidentified` and the run is `partial`.
- **Change tracking.** `collectPurview` loads the previous recorded run and
  `trackLabelChanges` stores `{ added, removed, changed: [{ resourceKey, fields, unknown }] }`
  in the run's digest. Only fields both runs observed are compared. `WhenChangedUTC` is
  ignored. A family whose read failed is unknown: its objects are not reported as
  removed.
- **Locks.** An answer carrying `RestrictiveRetention`, `IsPreservationLocked` or
  `PreservationLock` marks the object `locked` or `unlocked`. No marker reads
  `not-reported`, which is not proof that there is no lock.

### Activation

`oneDriveActivation` and `purviewActivation` require two things:
- `exchangeActivation` is enabled. That requires Teams, and Teams requires SharePoint.
- Each family's own rows are live-qualified and enabled.

`sharepoint.site-sharing` runs the same `Get-PnPTenantSite` cmdlet, but it never counts
for OneDrive. OneDrive proof never counts for Purview, and Purview proof never counts for
OneDrive. Without activation, `collectOneDrive` and `collectPurview` record a `disabled`
run that names what is missing, and they send nothing. Both workloads are registered
with `enabledByDefault: false` and appear in the coverage report.

### Writes (`engine/coverage/qualification.mjs`)

| Operation | Cmdlet | Writable | Read-back | RBAC |
| --- | --- | --- | --- | --- |
| `purview.label.update` | `Set-Label` | `DisplayName`, `Tooltip`, `Comment` | `purview.label-definitions` | `Exchange.ManageAsApp`, Compliance Administrator |
| `purview.label-policy.update` | `Set-LabelPolicy` | `AddLabels` only | `purview.label-publication` | `Exchange.ManageAsApp`, Compliance Administrator |

Each write needs all of these:
- its own live write capture;
- its read-back enabled;
- the restorer's grants observed (`grantsRequired`);
- the `ExchangeOnlineManagement` version in use (proof from another version does not count);
- `exchange.client-access.update` enabled first, which requires Teams, which requires
  SharePoint.

Proof for a predecessor, or for the other Purview write, never enables a write.

No OneDrive write is declared.

### The Purview restore (`engine/restore/workloads/purview.mjs`)

`planPurviewRestore` builds a frozen plan for the named labels and policies. It is stored
as a `restore_dry_run` artifact, so the task-66 approval and promotion checks are the
existing ones.

| Difference | What happens |
| --- | --- |
| A label's display name, tooltip or comment | `Set-Label` with the changed fields |
| A label the source policy published and the live one does not | `Set-LabelPolicy -AddLabels` |
| Encryption, content marking, site and group protection, guest access, `Disabled` | Manual. `weakensProtection: true` when restoring would weaken protection |
| Priority, content type, sharing control type, policy mode or settings | Manual. `weakensProtection: null`: KEEL cannot tell, so it never writes these |
| A label removed from a policy, or a policy location narrowed back | Manual. It would unpublish or uncover, so KEEL never does it |
| A label or policy deleted since the source | Manual. It is not recreated: a new object gets a new id, and labeled items are not relabeled |
| A label or policy created since the source | Manual. KEEL never deletes one |
| Item-applied labels, usage, labeled content | Excluded. Never read or restored |

`executePurviewRestore` runs these checks in order:
1. The artifact must be promotable, its digest must match, and it must target this tenant.
2. Each operation needs its own enabled qualification. Without it, the operation is
   `disabled`.
3. Content effects, if any, need the separate approval. The Purview types are reviewed
   with no effect rules, because what KEEL writes changes neither audience nor retention.
4. KEEL re-reads both families. A changed fingerprint makes only that operation `stale`.
5. A target that now reports a preservation lock is `refused` before writing.
6. KEEL writes once and verifies by read-back. A platform preservation-lock error is
   `refused`, recorded with its error and never retried. Any other cmdlet error is
   `failed`. A lost answer is reconciled by re-reading and never resent.

Each operation has its own `workload-restore` evidence row, followed by a summary row.

**Preservation lock at plan time.** A locked live object is passed to the task-66
classifier as `isPreservationLocked`. That produces a `preservation-locked` refusal, the
artifact status is `refused`, and promotion is refused.

### Container (`ops/powershell/run-cmdlet.ps1`)

Two new allowlists, `$AllowedPurview` and `$AllowedPnP`, sit beside the Exchange
`$Allowed` list. The cmdlet name and the job's module together choose one session:
- `exo`: `Connect-ExchangeOnline`;
- `ipps`: `Connect-IPPSSession`;
- `pnp`: `Connect-PnPOnline`, in a process that never loads ExchangeOnlineManagement.

A cmdlet sent with the wrong module is refused. Parameters are still splatted from JSON,
never parsed. The Exchange allowlist is unchanged.

### Wave planner

`onedriveSite`, `purviewLabel` and `purviewLabelPolicy` are refused by `planWaves` and
`planDeletionWaves`.

## Proof

`engine/roadmap/onedrive-purview.test.mjs` has 6 tests. They run against:
- the isolated database;
- the real task-101 ledger builder;
- a fake container behind the real `runJob` spawn path. It plays the `run-cmdlet.ps1`
  contract, enforces the per-session allowlists parsed from the script itself, and
  answers any file, list-item or labeled-content cmdlet with content, so one such call
  would show up.

- **No per-item crawl (OneDrive).** One `Get-PnPTenantSite -Identity` per named site.
  - Out-of-scope URLs (a file path, another host, a query) are refused with nothing sent.
  - File, item and listing cmdlets and the `IncludeOneDriveSites` parameter are refused.
  - A team site is refused as not OneDrive.
  - A failed read is structured and persists as `failed`.
  - The Node and container allowlists match.
- **Inherited versus explicit.** The per-field inheritance is checked and persisted.
  - A site that pins the same value is an `inheritance` change.
  - A moved tenant default is `inherited-default` with `siteChange: false`.
  - An own value change is `value`.
  - A legacy observation without inheritance never reads as explicit.
  - A locked site is flagged and every change is manual.
- **Label changes without labeled content.** Only `Get-Label` and `Get-LabelPolicy` run,
  with no parameters and in the compliance session. There are zero content calls, and
  the usage data in the answer is not stored.
  - An unchanged second run reports no change, even though save times moved.
  - A rename, an encryption change, an added label, a deleted label and a policy change
    are each tracked and stored in the digest.
  - A failed policy read does not report the policy as removed.
  - Labeled-item, usage and search cmdlets, `RemoveLabels` and `EncryptionEnabled` are
    refused.
- **Proof for another family cannot enable anything.**
  - With every predecessor read live, including `sharepoint.site-sharing`, OneDrive and
    Purview stay disabled and send nothing.
  - OneDrive and Purview proof without Exchange does not activate either.
  - OneDrive proof does not activate Purview, and the reverse.
  - With every predecessor write live, both Purview writes stay `disabled`.
  - Label-policy proof is not label proof.
  - A missing predecessor, unknown grants, a missing Compliance Administrator role,
    another module version or a disabled read-back all disable.
  - With proof for the policy write only, a restore sends only `Set-LabelPolicy`.
- **Restore.** Only `Set-Label` (display text) and `Set-LabelPolicy -AddLabels` are sent
  and verified.
  - Encryption KEEL found stays on.
  - Removing a label from the policy, narrowing a location back and changing priority
    are manual, each with its `weakensProtection` answer.
  - A new label is not deleted.
  - A change after the plan makes only that operation `stale`.
  - A lost answer is verified by re-read and not resent.
  - Another tenant id is refused.
- **Preservation lock.**
  - A lock seen at plan time gives a refused artifact and zero writes.
  - A lock that appears after the plan is refused before writing.
  - A platform lock error is refused once, with its `errorId` in the evidence row, and
    never retried.

Mutation checks. Each one was caught by failing tests and then reverted:

| Mutation | Result |
| --- | --- |
| Enumerate files for label inventory (`Get-PnPListItem` added to the Purview allowlist and called from `readPurview`) | 4 pass, 2 fail |
| Ignore inherited versus explicit state (`compareOneDriveSites` reads every inheritance as undetermined) | 5 pass, 1 fail |
| Reuse unrelated workload qualification (`oneDriveActivation` accepts the `sharepoint.site-sharing` row) | 5 pass, 1 fail |
| Same, write side (`workloadWriteQualification` treats predecessor writes as Purview proof) | 5 pass, 1 fail |

Validation command (36 tests, all pass):

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/onedrive-purview.test.mjs engine/restore/*.test.mjs engine/reconcile/*.test.mjs engine/safety/*.test.mjs engine/policy/*.test.mjs cli/keel-restore.test.mjs cli/keel-remediate.test.mjs cli/keel-worker.test.mjs
```

It was run in a container without `/etc/keel/db.env`. `KEEL_DB_TEST_URL` and
`KEEL_TENANT_CONFIG_PATH` were exported for a local PostgreSQL 16 instead. The suite was
added to the CI engine step in `.github/workflows/portal.yml`. That step passes in full
(417 tests). Portal `npm test` (159) and `npm run build` pass.

## Limitations

- **No live proof, and blocked behind Exchange, Teams and SharePoint.** Nothing was read
  or written in a tenant. Cmdlet names, parameters, fields, the inheritance rules, the
  lock markers and the RBAC were declared from Microsoft's documentation. That
  documentation could not be re-fetched from this environment, so no retrieval date is
  recorded (Global Constraint 8). Field names that differ live will read `unknown`,
  never as a value.
- **The live capture must use `-Identity`.** The task-101 probe row for
  `onedrive.site-settings` runs `Get-PnPTenantSite -IncludeOneDriveSites` (a listing).
  The adapter reads one site with `-Identity` instead. A qualification capture must
  exercise the `-Identity` form on a `keel-rt-*` OneDrive before the probe row is trusted
  for it.
- **The PowerShell side is unrun.** `run-cmdlet.ps1` has not been executed: there is no
  `pwsh` in this container and no tenant.
  - The IPPS and PnP connections are untested.
  - The PnP connection exports the PEM certificate as a PFX in memory. It expects
    `sharePointAdminUrl` and `organization` in the credential descriptor, which current
    descriptors may not carry.
- **Effective OneDrive values are not claimed.** KEEL does not read the tenant's OneDrive
  defaults (`Get-PnPTenant`), so an inherited field shows the site's reported value only.
  The tenant's sharing capability may still be narrower than a site's explicit value.
- **Locks on label policies are not known to exist.** Sensitivity label policies are not
  documented to carry a preservation lock. The marker check and the platform-error check
  are defensive. `not-reported` does not block the display-text and add-label writes,
  which cannot weaken protection.
- **Writes are deliberately narrow.** Encryption, marking, site and group protection,
  priority, policy locations, policy settings and removing labels from a policy are
  never written. A compliance administrator restores them by hand from the plan's manual
  list.
- **No worker job, CLI command or portal action.** As with tasks 103 to 105, nothing
  outside tests calls `collectOneDrive`, `collectPurview` or `executePurviewRestore`. The
  only user-visible surface is the coverage report entry, which says each workload is
  disabled and why.
- **Grants.** The restorer has no Compliance Administrator role or `Exchange.ManageAsApp`
  grant (operator decision 2026-09-30), so both Purview writes stay disabled by the RBAC
  gate even with proof. No grant is requested by this task.
- **Out of scope.** Retention labels and retention policies (`Get-ComplianceTag`,
  `Get-RetentionCompliancePolicy`), auto-labeling policies, DLP and every item-level
  label are not read or restored here.
