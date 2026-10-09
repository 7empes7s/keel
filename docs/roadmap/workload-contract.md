# Workload configuration APIs and permissions (task 101)

Date: 2026-10-03 UTC. Status: implemented, fixture-tested only. No tenant was read.
Every workload operation is disabled until a live capture proves it.

## What was built

### Workload descriptors (`engine/collect/workloadContract.mjs`)

The descriptors cover 11 read operations across 5 workloads. Each records:
- the Graph endpoint or cmdlet;
- the API or module version;
- app-only and delegated support;
- the permissions and admin roles it needs;
- paging, throttling and consistency;
- the documentation it was declared from.

| Workload | Operation | Endpoint or cmdlet | Needs |
| --- | --- | --- | --- |
| SharePoint site settings | `sharepoint.tenant-settings` | `GET /admin/sharepoint/settings` (v1.0) | SharePointTenantSettings.Read.All |
| | `sharepoint.site-properties` | `GET /sites/{site-id}` (v1.0) | Sites.Read.All |
| | `sharepoint.site-sharing` | `Get-PnPTenantSite` (PnP.PowerShell) | Sites.FullControl.All, SharePoint Administrator |
| Teams settings and membership | `teams.settings` | `GET /teams/{team-id}` (v1.0) | TeamSettings.Read.All |
| | `teams.membership` | `GET /teams/{team-id}/members` (v1.0, paged) | TeamMember.Read.All |
| Exchange mailbox settings | `exchange.mailbox-settings` | `GET /users/{user-id}/mailboxSettings` (v1.0) | MailboxSettings.Read |
| | `exchange.client-access` | `Get-CASMailbox` (ExchangeOnlineManagement) | Exchange.ManageAsApp, Exchange Administrator |
| OneDrive site-level settings | `onedrive.site-settings` | `Get-PnPTenantSite -IncludeOneDriveSites` | Sites.FullControl.All, SharePoint Administrator |
| Purview labels | `purview.label-definitions` | `Get-Label` | Exchange.ManageAsApp, Compliance Administrator |
| | `purview.label-publication` | `Get-LabelPolicy` | Exchange.ManageAsApp, Compliance Administrator |
| Teams org-wide policies | `teams.meeting-policies` | `Get-CsTeamsMeetingPolicy` (MicrosoftTeams) | Teams Administrator |

Later tasks added more reads. Issue #153 added a sixth workload, `exchange-mail-flow`,
with eleven cmdlet reads: see [exchange-mail-flow-reads.md](exchange-mail-flow-reads.md).
Issue #154 added a seventh, `teams-org-policies`, with nine MicrosoftTeams cmdlet reads,
and moved `teams.meeting-policies` (first declared under Teams settings) into it: see
[teams-org-policy-reads.md](teams-org-policy-reads.md).

### Scope validator

`validateWorkloadDescriptor` (and `scopeProblems`) refuses anything that is not a
configuration read.

**Graph endpoints**
- The method must be `GET`.
- No path segment, key-addressed segment or `$expand` may address content. The banned
  segments are:
  - files: `drive`, `drives`, `items`, `children`, `content`, `versions`, `thumbnails`;
  - lists and pages: `list`, `lists`, `pages`, `onenote`, `notebooks`;
  - messages and calendars: `messages`, `mailFolders`, `replies`, `hostedContents`,
    `chats`, `events`, `calendar`, `contacts`, `attachments`;
  - per-item labels and permissions: `extractSensitivityLabels`,
    `assignSensitivityLabel`, `permissions`.
- The endpoint is judged segment by segment, so a content path is refused under
  `/sites/{id}`, `/teams/{id}`, `/users/{id}` or `/groups/{id}` alike. The descriptor's
  name and workload play no part.

**Cmdlets**
- Only the `Get` verb is allowed.
- No noun that reads content is allowed: files, list items, folders, messages,
  attachments, compliance searches, exports or pages.
- A noun that names a policy, rule, configuration or settings about content stays
  configuration. For example, `Get-SafeAttachmentPolicy` is allowed.

An out-of-scope descriptor is `refused` in the ledger. No evidence can enable it.

### Qualification states

| State | Meaning | Enabled |
| --- | --- | --- |
| `refused` | Outside configuration scope, or an incomplete contract. | Never |
| `disabled` | Declared but unproven, or its only proof was invalidated. | No |
| `fixture-tested` | The fixture harness passed. This is synthetic proof. | No |
| `pending-prerequisite` | A permission or role is confirmed missing. The row names it and says how to fix it. | No |
| `live-qualified` | A non-synthetic capture from this tenant, at most 30 days old, at the version in use now. | Only when the collector app's grants are confirmed |

**Live evidence.** It must meet every one of these:
- `kind: "live-capture"` and an explicit `synthetic: false`. A missing flag counts as
  synthetic.
- The same tenantRef.
- A capture time that is valid, not in the future and no older than 30 days.
- A recorded version.
- A successful read.

**Pending prerequisites** come from two sources:
- Observed grants (`--grants`) that lack a declared permission or role. These win even
  over earlier live proof.
- A capture that failed in an authorization-shaped way: 401, 403, "access denied" or
  "insufficient privileges". That row names the operation's declared needs. A timeout
  or other failure is not called a prerequisite.

**Version binding.**
- A Graph operation runs at its declared API version.
- A cmdlet runs at the module version the latest capture reported.
- Evidence recorded at any other version is listed under `invalidated` with the reason,
  and stops counting.
- Rows from before version recording never qualify.

### Graph reader (`readGraphConfiguration`)

- Reads one Graph configuration operation through an injected transport.
- Follows `@odata.nextLink` and honours `Retry-After` on 429 and 503, retrying at most
  three times.
- Re-checks every next page. A link that leaves the operation's own path, or that would
  read content, is refused rather than followed.

### Command line (`tools/qualification/workloads.mjs`)

- `--harness` runs the fixture harness:
  - Graph operations go through `readGraphConfiguration` against a fake Graph that
    throttles first and then pages.
  - Cmdlet operations go through the capture mapping with a canned row marked
    synthetic.
  - All harness evidence is synthetic, so the best it can reach is `fixture-tested`.
- `--capture` reads operator-supplied, read-only captures:
  - `probe-workloads.ps1` output;
  - a Graph capture file `{ captures: [...] }`.
  - It requires `--tenant-ref`, and stamps every capture with it.
  - Each capture's proofRef is the file name plus its SHA-256.
- `--grants` reads `{ permissions, roles }`.
- `--check` exits 1 if any descriptor is refused.
- The tool makes no network call.

### PowerShell probe (`ops/powershell/probe-workloads.ps1`)

- It also runs `Get-CASMailbox -ResultSize 1`, `Get-LabelPolicy`, `Get-PnPTenantSite`
  and `Get-PnPTenantSite -IncludeOneDriveSites`. All are read-only.
- Every row now records:
  - `module` and `moduleVersion`, the highest installed version, which is what
    `Import-Module` loads;
  - `capturedAt`;
  - `synthetic: false`.
- Rows from the SharePoint child process are stamped the same way.

## Migration and legacy reads

- There is no schema change.
- Probe output from before this task has no `moduleVersion` or `synthetic` field. It
  still parses, but it reads as unqualified, with the reason "the capture predates
  version recording".
- The new row fields are additive, so `run-job.sh` and existing consumers are
  unaffected.

## Limitations

- **Documentation was not re-fetched.** The egress proxy blocks learn.microsoft.com.
  - Every descriptor's `source` therefore has `retrievedAt: null`, and the ledger
    reports `documentation.reverified: false`.
  - The endpoints, permissions and roles above come from Microsoft's published
    references as previously known. Check them before a live capture is trusted.
  - This does not gate qualification. A live capture is the proof.
- Not run against a tenant. No live capture exists yet, so every operation is
  `disabled`, or `fixture-tested` after `--harness`.
- PowerShell was not available in this environment.
  - `probe-workloads.ps1` was checked statically by the test suite: every declared
    cmdlet is probed, every probed cmdlet passes the scope validator, the script has no
    write verbs, and the version, capture-time and synthetic fields are present.
  - It has not been executed.
- The module version is the highest installed one, not one read back from the loaded
  session.
- Throttling and consistency are declared per operation from the documentation. Only
  the harness observes throttling, and only against a fake.
- There is no portal view yet. Adapters (task 102 onwards) consume this ledger, and the
  coverage UI can show it then.

## Boundary tests

`engine/roadmap/workload-contract.test.mjs` has 7 tests and needs no database.
- Every declared operation is in scope, and all are disabled before proof.
- 13 content endpoints under sites, teams, users, groups and drives are refused,
  including key-addressed, `$expand` and per-item label and permission forms. So are
  7 content or write cmdlets. Live evidence cannot rescue a refused descriptor. A
  nextLink into channel messages is refused.
- Harness proof is `fixture-tested` and never enabled. Synthetic evidence relabelled as
  a live capture, or with no synthetic flag, does not qualify. A genuine capture does.
- Missing grants name the permission or role. An access-denied capture names the needs;
  a timeout does not.
- v1.0 proof is invalidated by a move to beta. Module 3.5.0 proof is invalidated by a
  3.6.0 capture. Legacy rows never qualify.
- The command line works end to end with probe, Graph and grants files. A capture
  without a tenant is refused.
- The static probe checks described under Limitations.

Required mutations were each applied alone and then restored (2026-10-03):

| Mutation | Pass | Fail |
| --- | --- | --- |
| Allow content endpoint under a container (`/sites/`, `/teams/`, `/users/`, ...) | 6 | 1 |
| Mark synthetic probe live-qualified (drop the synthetic check) | 6 | 1 |
| Mark synthetic probe live-qualified (probe rows always non-synthetic) | 6 | 1 |
| Reuse proof after API version change (no drift check) | 6 | 1 |

Validation: `node --test engine/roadmap/workload-contract.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs engine/collect/*.test.mjs engine/coverage/*.test.mjs engine/cir/*.test.mjs`
gives 21 pass, 0 fail.
- One of four runs hit the known `engine/authz/administration.test.mjs` grant-timing
  flake.
- That file passes on its own, and this task does not touch it.
