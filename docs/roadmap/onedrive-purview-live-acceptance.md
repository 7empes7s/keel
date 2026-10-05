# OneDrive and Purview configuration qualification (task 123)

Date: 2026-10-04 UTC. Status: the code half is implemented and fixture-tested.
**The gate stays pending.** No live evidence exists. No tenant, OneDrive, label or label
policy was read or written. Every OneDrive and Purview read and write stays disabled.

The external admission gate needs things that cannot exist in a builder container:
- a disposable `KEEL-RT-*` OneDrive personal site;
- a disposable `KEEL-RT-*` sensitivity label and a `KEEL-RT-*` label publishing policy
  that publishes only to fixtures;
- family-specific privilege evidence: what the collector and restorer apps actually hold
  for OneDrive and for Purview (see the open operator decisions below);
- a verified task-122 Exchange record, which itself needs the task-121 Teams and task-120
  SharePoint records (all three still pending);
- a live capture from the real tenant, signed by the release runner.

This task builds everything else: the evidence contract, the gate validator, the capture
tool the operator runs, the import seam into the task-101 and task-106 ledgers, and the
boundary tests. The checked-in record
`docs/release/qualifications/onedrive-purview-live-acceptance.json` is a placeholder with
`status: "pending"`. It fails `verify --require-live`, and it is meant to.

## What was built

### Gate validator (`tools/qualification/onedrivePurviewAcceptance.mjs`)

`validateOneDrivePurviewLiveSubject` is registered additively in
`tools/release/qualification.mjs` as gate `onedrive-purview-live-acceptance`. That is one
import and one entry in `GATE_VALIDATORS`. The wrapper passes the runner-proof result and
the release `verifyEvidence`, so the module never imports the release verifier.

It checks the record against the task-106 declarations it qualifies, not against a copy:
- three reads (`WORKLOAD_DESCRIPTORS`):
  - `onedrive.site-settings`: `Get-PnPTenantSite -Identity`, in the PnP session;
  - `purview.label-definitions` (`Get-Label`) and `purview.label-publication`
    (`Get-LabelPolicy`), in the Security & Compliance session;
- two writes (`WORKLOAD_WRITE_OPERATIONS`), each with its own capture:
  - `purview.label.update`: `Set-Label -Comment` on the fixture label, changed and put back;
  - `purview.label-policy.update`: `Set-LabelPolicy -AddLabels` on the fixture policy,
    add-only. Putting it back would mean `-RemoveLabels`, which unpublishes a label. KEEL
    never does that.

No OneDrive write is declared, so OneDrive is qualified read-only. A record that carries
any other write fails.

Beyond the generic verifier (signature, capture log digest, gate, tenant, freshness and
`--require-live`), a passing record must show all of the following.

**Identity**
- operation `onedrive-purview.configuration-qualification` and credential mode
  `collector-read+restorer-write`;
- two distinct credential references;
- both module versions: `PnP.PowerShell` for the OneDrive read and
  `ExchangeOnlineManagement` for Purview. Each capture is bound to its own module's
  version;
- the build;
- the directory tenant, which must equal the one the Exchange record names.

**Prerequisites**
- tasks 106 and 122 are named, and the declarations exist in this build;
- the task-122 Exchange record named in the subject sits beside this one and verifies on
  its own with `--require-live`, for the same tenant and build. In turn that needs the
  Teams and SharePoint records;
- this record's capture log is its own. The Exchange, Teams or SharePoint log can never
  stand in for it. Their proof is a prerequisite, never OneDrive or Purview proof.

**Family-specific privilege, declared and never assumed**

Grants are recorded per role and per family. Each family is checked against its own
declared needs:

| Role | Family | Needs (from the task-101 and task-106 declarations) |
| --- | --- | --- |
| collector | `onedrive` | `Sites.FullControl.All`, SharePoint Administrator |
| collector | `purview` | `Exchange.ManageAsApp`, Compliance Administrator |
| restorer | `purview` | `Exchange.ManageAsApp`, Compliance Administrator |

A family that is missing from the record fails, even when another family's grants would
cover it. Purview grants never count as OneDrive grants, and the reverse.

**Fixtures**
- The OneDrive is a `keel-rt-*` personal site, `/personal/keel-rt-...`. It must be on
  the `-my` host of the tenant the SharePoint record qualified: `contoso.sharepoint.com`
  gives `contoso-my.sharepoint.com`. It must also answer with a personal-site template
  (`SPSPERS…`).
- The label and the policy are named `KEEL-RT-*` and carry immutable ids.
- Every location of the fixture policy (`ExchangeLocation`, `ModernGroupLocation`,
  `SharePointLocation`, `OneDriveLocation`) names a `keel-rt-*` fixture. `All`, or any
  real user, fails. So publishing the label changes nothing for a real user. An empty
  location list is allowed.
- The lock state of the label and the policy is recorded.

**Reads**
- One successful, non-synthetic capture per read operation, at its module's version,
  within 24 hours of the record.
- The OneDrive read was made in the `-Identity` form the adapter uses, not the
  `-IncludeOneDriveSites` listing in the task-101 probe row.
- Every declared OneDrive, label and policy field was observed live. Get-Label keeps the label protection
  settings (encryption, content marking, watermark, site and group protection) in `LabelActions`, and the
  adapter derives them from there. Any it still cannot observe are listed in `notQualifiedFields.label`
  and are not qualified by this gate.
- Inherited versus explicit state was recorded for every OneDrive field. The conditional
  fields (`DefaultSharingLinkType`, `DefaultLinkPermission`, `ExternalUserExpirationInDays`,
  `AnonymousLinkExpirationInDays`) must be determined, not `undetermined`.

**Writes and post-state**
- Each write was applied and read back as written.
- **Label.** Only `Comment` changed, and it was put back. The label's whole definition
  fingerprint (every kept field except the save time) is the same at the end as at the
  start, so no protection setting moved.
- **Policy.** The policy gained exactly the fixture label. No label was removed. Every
  other policy setting (locations, mode, settings, priority, enabled) has the same
  fingerprint before and after.
- **Everything else.** Every other label and policy definition in the tenant has the same
  fingerprint at the end as at the start. Only counts and that fingerprint are kept for
  non-fixture objects, never their fields.

**The request log, re-derived**

Each request is re-checked against the task-106 allowlists (`assertOneDriveCmdlet`,
`assertPurviewCmdlet`) for its own module. That gives zero content calls: no file, list
item, item-applied label, label usage, content explorer or per-file permission. Beyond
that:
- `Get-PnPTenantSite` addresses only the fixture OneDrive or the absent probe, and only
  the collector sends it;
- only the restorer sends `Set-` cmdlets, and only to the fixture label and policy;
- `Set-Label` carries only `Comment`, and is sent exactly twice;
- `Set-LabelPolicy` carries only `AddLabels` with exactly the fixture label, and is sent
  exactly once;
- no write is sent to an object that reports a preservation lock;
- parameters are recorded as data, and every request uses the bounded transport.

**Refusals observed, not overridden**

These were refused before anything was sent:
- `Set-Label -EncryptionEnabled`, which would weaken protection;
- `Set-LabelPolicy -RemoveLabels`, which unpublishes a label;
- `Export-ContentExplorerData`, which reads item-applied labels;
- `Get-PnPListItem`, which reads OneDrive content;
- a path inside the OneDrive.

The production restore planner (`planPurviewRestore`) is handed the live fixture label as
if it reported a preservation lock. It must answer with a `preservation-locked` refusal.
An absent `keel-rt-*` OneDrive must come back as a structured cmdlet error, keeping its
code, `errorId` and message.

**Documentation and secrets**
- The five declaration pages were retrieved, each with a time.
- No credential material appears anywhere in the record: tokens, keys, thumbprints,
  certificate or PFX paths.

### Capture tool (`tools/qualification/onedrivePurviewLive.mjs`)

- `plan` (the default) is offline and prints every cmdlet in order.
- `capture` refuses without `--confirm-live-tenant-write`. It also refuses before sending
  anything unless all of these hold:
  - the fixtures are `KEEL-RT-*`;
  - the two tenant config files differ;
  - the module versions are given;
  - the task-122 Exchange record sits beside `--out` and verifies with `--require-live`
    for the same tenant and build.
- The fixture OneDrive must be on the `-my` host of the tenant host named by the
  SharePoint record, which it finds through the verified Exchange, Teams and SharePoint
  chain.

What a capture sends, in order:
0. Offline refusals: the four refusal probes and a path inside the OneDrive. If any one is
   sent, the capture stops.
1. Collector: `Get-PnPTenantSite -Identity <fixture>` through the production
   `readOneDriveSite`, which records inheritance; then `Get-Label` and `Get-LabelPolicy`
   through the production `readPurview`.
2. Collector: `Get-PnPTenantSite -Identity` of an absent `keel-rt-absent-*` OneDrive, to
   capture a platform error.
3. Offline: the preservation-lock probe through `planPurviewRestore`.
4. Restorer: read; `Set-Label -Comment <marker>`; read back; `Set-Label -Comment <original>`;
   read back.
5. Restorer, only once the comment is back: `Set-LabelPolicy -AddLabels <fixture label>`;
   read back.

It writes nothing when any of these holds:
- a read failed;
- the site is not a personal site (the adapter refuses a non-`SPSPERS` answer);
- the label or policy name is not unique;
- either fixture reports a lock (it is recorded, never overridden);
- the policy's audience is not fixtures only;
- the probe OneDrive exists;
- the planner did not refuse the locked label.

If the policy already publishes the fixture label, the policy write is not sent. The
capture never removes the label to add it again. The record then fails until the operator
names a fresh `KEEL-RT-*` label.

A failed comment put-back exits with code 3 and says exactly what to fix by hand. Cmdlet
parameters are JSON data in the bounded job transport, never script source. Credentials
stay in the tenant config files the container reads. With `KEEL_QUALIFICATION_HMAC_KEY`
the record is signed as `keel-release-runner`; without it the record cannot verify.

### Import seam (`ledgerEvidenceFromOneDrivePurviewAcceptance`)

A record that passes the gate with `--require-live` becomes:
- `live-capture` evidence for the three reads, for `buildWorkloadLedger`;
- one `live-write-capture` for each Purview write, for `workloadWriteQualification`;
- the collector's grants (the union of both families), the restorer's Purview grants
  (the writes declare `grantsRequired`), and both module versions (`runtime.modules`).

Anything that fails verification becomes nothing. Proved by the tests with the real
ledger code:
- With this evidence alone, the three rows are live-qualified, but
  `oneDriveActivation` and `purviewActivation` stay off and both writes stay disabled.
  They follow Exchange, which follows Teams and SharePoint.
- With SharePoint, Teams and Exchange evidence alone, no OneDrive or Purview row
  qualifies.
- With all four, both families activate and both writes are enabled, each on its own
  capture.
- OneDrive evidence activates OneDrive only, and Purview evidence activates Purview only.
- Each of these keeps the write disabled: label-policy proof without label proof,
  restorer grants without the Purview family, or another module version at run time.

Nothing in production calls this seam yet, so this task enables no read and no write.

## Server, CLI and UI integration

- **CLI.** The release CLI verifies the new gate:
  `node tools/release/qualification.mjs verify --gate onedrive-purview-live-acceptance ...`.
  The capture tool is the operator CLI.
- **Server and UI.** None in this task. There is no evidence to show yet, and the
  coverage report already shows the OneDrive and Purview workloads as disabled, with the
  reason. Wiring imported evidence into `collectOneDrive`, `collectPurview` and
  `executePurviewRestore` is follow-up work once a verified record exists.

## Migration and legacy reads

- There is no schema change and no data change.
- The release CLI behaves as before for every other gate. These checks apply only when
  `gate` is `onedrive-purview-live-acceptance`.
- No earlier OneDrive or Purview qualification record exists. A record without the
  fields above fails closed.

## Open operator decisions

This task takes none of these decisions. Anything tenant-wide is listed here and never
done silently.

1. **Restorer grants for Purview.** Operator decision 2026-09-30 gave the Restorer
   Graph `MailboxSettings.ReadWrite` only. `Set-Label` and `Set-LabelPolicy` need
   `Exchange.ManageAsApp` and the **Compliance Administrator** role, a tenant-wide
   directory role. Steps 4 and 5 cannot be captured until the operator grants them to the
   Restorer, or decides on a narrower custom role group in the Purview portal. A narrower
   role would change the task-106 declarations.
2. **Collector grants.** The task-101 and task-106 declarations give the collector
   `Sites.FullControl.All` with SharePoint Administrator for the OneDrive read, and
   Compliance Administrator for the label reads. Both can write, tenant-wide. The log
   proves the collector never sent a `Set-` cmdlet. It cannot prove the collector's roles
   are read-only. A read-only alternative (for example `Sites.Read.All` with a reader
   role, or a view-only compliance role group) would need a declaration change.
3. **Tenant-wide label reads.** `Get-Label` and `Get-LabelPolicy` take no parameters and
   return every label and policy definition in the tenant. These are definitions, never
   labeled content. The record keeps only counts and a fingerprint for non-fixture objects.
   The operator should confirm this read is acceptable.
4. **Creating the fixtures.** KEEL's allowlist holds no `New-Label`,
   `New-LabelPolicy` or OneDrive provisioning cmdlet, and this task adds none. The operator
   creates these by hand:
   - a `KEEL-RT-*` label, with no encryption needed;
   - a `KEEL-RT-*` publishing policy whose locations name only `keel-rt-*` users. For
     example, `ExchangeLocation` = `keel-rt-20260908-alice@<domain>`, never `All`.
   - the fixture user's OneDrive, which must exist (it is provisioned when the user first
     signs in, or by an administrator).
5. **Publishing is permanent per capture.** Each capture adds the fixture label to the
   fixture policy and never removes it, because KEEL never unpublishes a label. A later
   capture needs a fresh `KEEL-RT-*` label that the policy does not yet publish. Only a
   compliance administrator can clean up, outside KEEL, with `Set-LabelPolicy -RemoveLabels`.
   Because the policy publishes to fixtures only, a leftover label reaches no real user.
6. **The fixture label's `Comment`.** It is changed to a `KEEL-RT qualification <time>`
   marker and put back. It is admin-facing and never shown to users.

## Operator steps

These are needed to clear the gate. Run them from `/opt/keel` at the build being
qualified. Builders must not run them.

1. **SharePoint, Teams and Exchange first.** Complete the task-120, task-121 and task-122
   operator steps (`docs/roadmap/sharepoint-live-acceptance.md`,
   `docs/roadmap/teams-live-acceptance.md`, `docs/roadmap/exchange-live-acceptance.md`) at
   this same build. Their records and capture logs must verify and stay in
   `docs/release/qualifications/`.
2. **Fixtures** (open decision 4):
   - **OneDrive:** the personal site of `keel-rt-20260908-alice`, such as
     `https://<tenant>-my.sharepoint.com/personal/keel-rt-20260908-alice_<domain>`.
   - **Label:** a `KEEL-RT-*` sensitivity label that the fixture policy does not yet
     publish.
   - **Policy:** a `KEEL-RT-*` label policy published only to `keel-rt-*` users.
3. **Credentials.** Use two separate apps, each with its own tenant config file
   (`clientId`, `organization` = the `.onmicrosoft.com` domain, `sharePointAdminUrl`,
   `certPath`, `keyPath`):
   - **Collector:** OneDrive needs `Sites.FullControl.All` and SharePoint Administrator.
     Purview needs `Exchange.ManageAsApp` and Compliance Administrator. Use a file such as
     `/etc/keel/purview-collector.json`.
   - **Restorer:** Purview needs `Exchange.ManageAsApp` and Compliance Administrator (open
     decision 1). Use a file such as `/etc/keel/purview-restorer.json`.

   Write down what each app actually holds, per family, in `grants.json`. Never copy it
   from the table:
   ```json
   { "collector": { "onedrive": { "permissions": [], "roles": [] }, "purview": { "permissions": [], "roles": [] } },
     "restorer":  { "purview":  { "permissions": [], "roles": [] } } }
   ```
4. **Module versions.** Read both versions from the PowerShell image:
   ```bash
   for m in PnP.PowerShell ExchangeOnlineManagement; do docker run --rm --entrypoint pwsh keel-powershell:latest -NoProfile -Command \
     "(Get-Module -ListAvailable $m | Sort-Object Version -Descending | Select-Object -First 1).Version.ToString()"; done
   ```
5. **Documentation.** Re-read the five pages. Record each URL with its retrieval time in
   `docs.json`: `[{ "url": "...", "retrievedAt": "<ISO time>" }]`. Print the URLs with:
   ```bash
   node -e "import('./tools/qualification/onedrivePurviewAcceptance.mjs').then(m => console.log(m.onedrivePurviewRequiredDocumentation().join('\n')))"
   ```
6. **Preview, offline:**
   ```bash
   node tools/qualification/onedrivePurviewLive.mjs plan --fixture-site <OneDrive URL> \
     --fixture-label KEEL-RT-<label> --fixture-policy KEEL-RT-<policy>
   ```
7. **Capture.** The HMAC key is the release runner's:
   ```bash
   KEEL_QUALIFICATION_HMAC_KEY=... \
   node tools/qualification/onedrivePurviewLive.mjs capture --confirm-live-tenant-write \
     --tenant-ref <tenant_ref> --directory-tenant-id <tenant id> \
     --fixture-site <OneDrive URL> --fixture-label KEEL-RT-<label> --fixture-policy KEEL-RT-<policy> \
     --collector-ref app:<collector app id> --restorer-ref app:<restorer app id> \
     --collector-config /etc/keel/purview-collector.json --restorer-config /etc/keel/purview-restorer.json \
     --pnp-module-version <x.y.z> --exchange-module-version <x.y.z> --grants grants.json --docs docs.json \
     --build "$(git rev-parse HEAD)" \
     --exchange-evidence docs/release/qualifications/exchange-live-acceptance.json \
     --out docs/release/qualifications/onedrive-purview-live-acceptance.json
   ```
   This replaces the pending placeholder and writes
   `onedrive-purview-live-acceptance.capture.json` next to it. Exit codes:
   - 0: verified;
   - 1: captured, but did not verify;
   - 2: refused before any cmdlet, including when the Exchange record does not verify;
   - 3: check the fixture label's `Comment` by hand.
8. **Verify.** This is the task's final Validate step:
   ```bash
   KEEL_QUALIFICATION_HMAC_KEY=... KEEL_QUALIFICATION_TENANT_REF=<tenant_ref> \
   node tools/release/qualification.mjs verify --require-live --gate onedrive-purview-live-acceptance \
     --evidence docs/release/qualifications/onedrive-purview-live-acceptance.json
   ```
   The record is valid for 30 days and only for the build it names. It also stays valid
   only while the Exchange, Teams and SharePoint records beside it verify.

## Proof

`engine/roadmap/onedrive-purview-live-acceptance.test.mjs` has 9 tests and needs no
database. All four capture tools run against in-memory fakes. The SharePoint, Teams and
Exchange captures produce the verified task-120, task-121 and task-122 prerequisites.

The OneDrive and Purview capture runs against a fake container behind the real
`jobQueue.mjs` spawn path:
- It plays the `run-cmdlet.ps1` contract, with the per-session allowlists (`$AllowedPnP`,
  `$AllowedPurview`) parsed from the script itself.
- It answers any file, list-item or labeled-content cmdlet with content, so a single such
  call would show up.
- It adds label usage counts to every `Get-Label` answer, which must never be stored.

The nine tests:
1. **A valid record verifies.** Only the fixture OneDrive and the absent probe are read,
   by the collector, in the PnP session. There are zero content calls. The only cmdlets
   are `Get-PnPTenantSite`, `Get-Label`, `Get-LabelPolicy`, `Set-Label` ×2 and
   `Set-LabelPolicy` ×1, and writes come only from the restorer's config in the IPPS
   session. Afterwards:
   - the label's comment is back and its encryption untouched;
   - the policy gained only the fixture label, and the global policy is unchanged;
   - inheritance was recorded per field;
   - every refusal was observed before sending, and the platform error is structured;
   - no usage count, content or secret appears in the record or log.
2. **An altered signature or log digest fails.** This covers a forged signature, an edit
   after signing, an edited log, and a swapped log with its own matching digest.
3. **Wrong tenant, build or operation fails, even re-signed.** Cases:
   - cross-tenant evidence, another build or no expected identity;
   - the Exchange operation or a write id as the operation;
   - the wrong credential mode or gate;
   - a SharePoint read id in place of the OneDrive read;
   - an Exchange write id in place of a Purview write;
   - the wrong module version per family, or the listing form of the OneDrive read;
   - the same credential twice, or another directory tenant;
   - a non-fixture OneDrive, a OneDrive on another tenant's `-my` host, or a team-site
     template;
   - a non-fixture label or policy, or a policy published to `All`.
4. **Stale evidence fails.** Cases: an old record (and so an old Exchange prerequisite),
   an old read or write inside a fresh record, a capture after the record, and
   documentation without a retrieval time.
5. **A missing prerequisite fails, and upstream proof never stands in.** Cases:
   - task-122 not named, no Exchange record, an absent or out-of-directory one, the
     Teams gate named instead, or another Exchange log;
   - the Exchange, Teams or SharePoint log reused as this one;
   - a missing read or a failed read;
   - a missing module version or a script transport;
   - an undeclared grants family, or one family's grants borrowed for the other;
   - a missing restorer role, or flat (non-family) grants;
   - an unobserved label or OneDrive field, missing or undetermined inheritance;
   - a missing policy write;
   - each refusal missing, and a malformed platform error;
   - a tampered Exchange record;
   - a chain without the SharePoint record, which also loses the tenant host;
   - an Exchange record for another build;
   - the upstream records themselves, which fail this gate and import nothing.
6. **Missing external evidence fails.** Cases: the checked-in pending record (with and
   without `--require-live`), an absent file, a record without its capture log, and a
   record without a runner signature. The exact release CLI command exits 1 on the
   placeholder.
7. **Fixture evidence is never elevated, and only a verified record reaches the
   ledgers.** Cases: a fixture runner, `synthetic: true`, the `fixture-tested` level, a
   synthetic read or write capture, and a same-value label write. The import seam was
   checked against the real `buildWorkloadLedger`, `workloadWriteQualification`,
   `oneDriveActivation` and `purviewActivation`, with the results listed under the import
   seam above.
8. **Request log and post-state.** Each of these fails:
   - a content cmdlet (`Get-PnPListItem`, `Export-ContentExplorerData`, a Graph drive
     item), the listing parameter, or a parameterized `Get-Label`;
   - another OneDrive, a restorer site read, or a probe that answered;
   - a collector write, another label or policy, a `Tooltip` write, or an extra
     `Set-Label`;
   - `EncryptionEnabled`, `RemoveLabels`, another label added, or `Remove-Label`;
   - a non-bounded transport, or parameters as a string;
   - a write to a locked label or policy;
   - a label definition that does not read as it started, or a comment not put back;
   - a label removed from the policy, more than the fixture label added, or a put-back
     policy mode;
   - another policy setting changed, a OneDrive write, or a non-fixture definition
     changed;
   - a token or a PFX in the record.
9. **The capture tool.**
   - `plan` is offline, and `capture` without confirmation refuses.
   - A non-fixture OneDrive, label or policy is refused, as are missing flags, a missing
     Exchange reference, a bad module version, the fixture as its own probe, and a
     fixture on another tenant's host.
   - The CLI refuses before any cmdlet when the Exchange record does not verify.
   - These unsafe states send no write at all: a locked label (its definition is kept as
     it was), a locked policy, a policy published to `All`, an existing probe OneDrive, a
     team site (refused by the adapter), duplicate label names, or an absent OneDrive.
   - A label the policy already publishes is never removed and re-added, so the policy
     write is not sent.
   - Ignored writes do not read back, and another label changing during the capture is
     caught.
   - A failed comment put-back is loud, stops the policy write and never verifies.

Required mutations were each applied alone and then restored (2026-10-04):

| Mutation | Pass | Fail |
| --- | --- | --- |
| Accept missing external evidence (a pending record verifies) | 8 | 1 |
| Accept missing external evidence (no capture log required) | 7 | 2 |
| Accept missing external evidence (no Exchange prerequisite check) | 7 | 2 |
| Accept mismatched operation (no operation check) | 8 | 1 |
| Accept mismatched tenant (directory tenant not bound to the Exchange record) | 8 | 1 |
| Accept mismatched tenant (OneDrive on another tenant's host accepted) | 8 | 1 |
| Elevate fixture evidence to live-qualified (no fixture-claim check) | 8 | 1 |
| Elevate fixture evidence to live-qualified (import seam without `--require-live`) | 8 | 1 |

**Validation** (2026-10-04). The container has no `/etc/keel/db.env`, so
`KEEL_DB_TEST_URL` and `KEEL_TENANT_CONFIG_PATH` were exported for a local PostgreSQL 16
instead.
- The `node --test` part of the Validate command passes: 23 tests, 0 failures.
  ```bash
  node --test engine/roadmap/onedrive-purview-live-acceptance.test.mjs engine/authz/*.test.mjs \
    engine/jobs/*.test.mjs engine/collect/*.test.mjs engine/coverage/*.test.mjs engine/cir/*.test.mjs
  ```
- The final step,
  `node tools/release/qualification.mjs verify --require-live --gate onedrive-purview-live-acceptance --evidence docs/release/qualifications/onedrive-purview-live-acceptance.json`,
  was run and exits 1 with `external runner evidence pending`. That is the expected
  result until the operator steps above are done.
- The new suite was added to the CI engine step in `.github/workflows/portal.yml`.

## Limitations

- **No live proof, and blocked behind Exchange, Teams and SharePoint.** Nothing was read
  or written in a tenant. Cmdlet names, parameters, fields, the inheritance rules, the
  lock markers and the RBAC come from the task-101 and task-106 declarations, which were
  written from Microsoft's documentation. That documentation could not be re-fetched from
  this environment, so the capture requires the operator to record retrieval times
  (Global Constraint 8).
- **The PowerShell side is unrun.** `run-cmdlet.ps1` has never been executed: there is no
  `pwsh` and no tenant here. The PnP and IPPS connections are untested. The tenant config
  must carry `sharePointAdminUrl` and `organization`.
- **Label policy propagation.** The read-back proves that the policy definition changed.
  It does not prove that clients received the label, which Microsoft documents as taking
  up to 24 hours. Client-side publication is not claimed.
- **The policy's `Labels` entries.** They are matched by label name or immutable id,
  ignoring case. If the live answer uses another form (for example a display name), the
  read-back reads as not applied and the record fails. It never reads as a false pass.
- **The preservation-lock refusal is shown through the production planner.** It does not
  come from a live locked label: sensitivity labels are not documented to carry a
  preservation lock, and the capture never creates one. A lock reported live is recorded
  and blocks every write.
- **OneDrive is read-only.** No OneDrive write is declared, so none is qualified.
  Effective tenant OneDrive defaults (`Get-PnPTenant`) are not read. An inherited field
  shows the site's reported value only, as in task-106.
- **No worker job, CLI command or portal action** consumes the import seam yet. As in tasks
  120 to 122, the only user-visible surface is the coverage report entry, which says each
  workload is disabled and why.
