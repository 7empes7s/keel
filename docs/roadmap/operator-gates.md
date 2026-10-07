# Operator gates: what is left for a human to capture

Status as of 2026-10-03 (overnight run). This is the kit for every roadmap task whose
**code half has merged** but whose admission gate needs evidence that only the operator can
produce: a live tenant, the deployed build, an operator session or a configured external
system. Nothing in this file was run against the live tenant. No evidence was fabricated.
Every checked-in record listed as `pending` fails `verify --require-live` until it is
replaced by a real capture.

Each gate has exactly one capture command and one verify command. The full steps,
including fixtures, credentials and what each command touches, are in the linked
"Operator steps" section. Follow that section, not this summary, when you run them.

## Before you start

- Run from `/opt/keel` at the build you are qualifying. Each record binds to one build
  (`git rev-parse HEAD`, or `--build`). After you commit the evidence, `HEAD` moves, so
  verify with an explicit `--build <commit the capture ran on>`.
- The release runner key `KEEL_QUALIFICATION_HMAC_KEY` signs live records. Keep it out of
  git and out of shell history.
- Sandbox guardrails still apply. Use only `KEEL-RT-*` or `keel-rehearsal-*` fixtures.
  Never use your admin, break-glass or Global Reader accounts. Do not change Conditional
  Access, MFA enforcement or security defaults. One gate needs an explicit decision to
  step outside the fixture-only rule; it is marked **decision needed** below.
- A failed or refused capture is a result. Report it; never edit a record by hand.

## Ready to capture now

| Task | Gate (`--gate`) | What you need | Touches the tenant? | Expected time | Unblocks |
|---|---|---|---|---|---|
| 113 | `deployed-acceptance` | Clean `/opt/keel-live` at the candidate revision; an operator Access JWT | No: read-only GETs against the portal | ~10 min | 124 (release verification) |
| 114 | `storage-live-acceptance` | A backup set copied to a separate volume; a `keel-recovery` OS account with read-only access to the copy | No: reads local files only | ~30 min (plus copy time) | 124. Retention lock and immutability stay UNQUALIFIED by decision |
| 115 | `native-live-acceptance` | One empty `KEEL-RT-native-recovery-group` security group; the Restorer certificate with `Group.ReadWrite.All` | Yes: deletes that one group and restores it from deleted items | ~15 min | 124; native recovery claims on the Protect page |
| 116 | `drill-live-acceptance` | Both setups complete (task-76 run ids); a read-only reconstruction result (task-68) | Yes: creates and removes one `keel-rehearsal-<startAt>` group | ~30 min | 124; the measured recovery-time figure |
| 120 | `sharepoint-live-acceptance` | A disposable `KEEL-RT-<yyyymmdd>` communication site; separate Collector and Restorer apps | Yes: **decision needed** (below) | ~45 min | 121 (Teams) and enabling the SharePoint read and write adapters |
| 121 | `teams-live-acceptance` | A verified task-120 record at the same build; a disposable private `KEEL-RT-<yyyymmdd>` team; a disposable member account not yet in it; separate Collector and Restorer apps | Yes: **decisions needed** (below); writes touch only the fixture team | ~45 min, after 120 | Enabling the Teams adapter (task-104); 105 and 122 (Exchange) |
| 117 | `sentinel-live-acceptance` | **Descoped** by operator decision 2026-10-04; the release ledger reports it as an accepted gap. If ever taken up: a TEST Log Analytics workspace with the `KeelEvents_CL` table, a DCE/DCR for the `Custom-KeelEvents` stream, a sender app with Monitoring Metrics Publisher on the DCR, and a separate reader app with Log Analytics Reader on the workspace | No tenant objects. Ingests 5 probe events (each twice) into the test workspace and runs two read-only KQL queries | ~30 min, plus ingestion delay | Claiming Sentinel export as live-qualified (task-80 adapter); 124 |
| 118 | `servicenow-live-acceptance` | The non-production ServiceNow instance (2026-09-30 decision) with a non-default workflow mapped in a KEEL adapter config, the relay table, signing property and business rule (`ops/servicenow/keel-callback-relay.js`), two test accounts that are not people with their own tokens, and a `…_qualification` KEEL database | No tenant objects. Creates four records and four test-user approvals in the non-production instance only | ~45 min, plus instance setup | Claiming the ServiceNow workflow as live-qualified (task-97 adapter, D6); 124 |
| 122 | `exchange-live-acceptance` | Verified 120 and 121 records at the same build; the fixture mailbox `keel-rt-20260908-alice` (or another `keel-rt-*` user mailbox) with deleted-item retention under 30 days; separate Collector and Restorer apps with Exchange app-only access | Yes: **decisions needed** (below); writes touch only the fixture mailbox's settings | ~45 min, after 121 | Enabling the Exchange adapter (task-105); 106 and 123 (OneDrive and Purview) |
| 123 | `onedrive-purview-live-acceptance` | A verified 122 record at the same build; hand-made fixtures: a `KEEL-RT-*` label, a `KEEL-RT-*` publishing policy whose locations name only `keel-rt-*` users, and the fixture user's provisioned OneDrive; separate Collector and Restorer apps with Purview access | Yes: **decisions needed** (below); writes touch only the KEEL-RT label and policy | ~45 min, after 122 | Enabling the OneDrive and Purview adapter (task-106); 124 |

### 113: authenticated deployed release acceptance

Steps: [deployed-acceptance.md › Operator steps](deployed-acceptance.md#operator-steps).

```bash
node tools/release/deployed-acceptance.mjs capture --portal-url https://<portal-host> \
  --source /opt/keel --deployed /opt/keel-live --build "$(git -C /opt/keel-live rev-parse HEAD)" \
  --out docs/release/qualifications/deployed-acceptance.json
node tools/release/qualification.mjs verify --require-live --gate deployed-acceptance \
  --evidence docs/release/qualifications/deployed-acceptance.json
```

### 114: independent storage retention and recovery (local copy)

Steps: [storage-live-acceptance.md › Operator steps](storage-live-acceptance.md#operator-steps).
A pass qualifies only independent recovery read and manifest verification from the local
copy. Retention lock, immutability and the lock canary are reported UNQUALIFIED whatever the
result, as decided in the plan's operator decisions. Task-124's dependency list still needs
the matching edit recorded there.

```bash
sudo -u keel-recovery env KEEL_QUALIFICATION_HMAC_KEY=... KEEL_TENANT_CONFIG_PATH=/etc/keel/tenant.json \
  node tools/qualification/storageLiveAcceptance.mjs capture --live --primary-root ... --copy-root ... [see doc]
node tools/release/qualification.mjs verify --require-live --gate storage-live-acceptance \
  --evidence docs/release/qualifications/storage-live-acceptance.json --build <capture commit>
```

### 115: native recovery credential qualification

Steps: [native-live-acceptance.md › Operator steps](native-live-acceptance.md#operator-steps).
Do not use the Exchange fixture user `keel-rt-20260908-alice`; deleting it would disturb
task-122. Conditional Access recovery stays manual.

```bash
KEEL_QUALIFICATION_HMAC_KEY=... node tools/qualification/nativeRecovery.mjs capture --live --resource-type group \
  --object-id <id> --confirm-disposable-fixture <id> --target-config /etc/keel/restorer.json \
  --docs-retrieved-at <YYYY-MM-DD> --permission Group.ReadWrite.All --out docs/release/qualifications
KEEL_QUALIFICATION_HMAC_KEY=... node tools/release/qualification.mjs verify --require-live --gate native-live-acceptance \
  --evidence docs/release/qualifications/native-live-acceptance.json --tenant <ref> --build <capture commit>
```

### 116: bounded same-tenant drill and KEEL recovery acceptance

Steps: [drill-live-acceptance.md › Operator steps](drill-live-acceptance.md#operator-steps).
The doc lists three preparatory `tools/rehearsal/qualification.mjs` calls (build the
manifest, an offline plan check, then the live drill). The capture below runs after them.

```bash
node tools/release/qualification.mjs capture-drill --out docs/release/qualifications/drill-live-acceptance.json \
  --db-url "$KEEL_DB_TEST_URL" --tenant "$KEEL_QUALIFICATION_TENANT_REF" \
  --reconstruction reconstruction.json --onboarding onboarding.json --build "$(git rev-parse HEAD)"
node tools/release/qualification.mjs verify --require-live --gate drill-live-acceptance \
  --evidence docs/release/qualifications/drill-live-acceptance.json
```

### 120: SharePoint configuration workload qualification (decision needed)

Steps: [sharepoint-live-acceptance.md › Operator steps](sharepoint-live-acceptance.md#operator-steps).

**Decision needed before capture.** Graph v1.0 has no site-scoped version of the setting
task-103 restores. The capture therefore flips the tenant-wide
`isResharingByExternalUsersEnabled` for a few seconds and puts it back. That goes beyond
the fixture-only guardrail. If the setting is currently `false`, the flip widens sharing
and the command also needs `--allow-widening-toggle`. Decide whether to accept this, or
leave the SharePoint write unqualified (the read and write adapters then stay disabled).

```bash
node tools/qualification/sharepointLive.mjs plan --tenant-host <tenant>.sharepoint.com \
  --fixture-site-url https://<tenant>.sharepoint.com/sites/KEEL-RT-<yyyymmdd>   # offline preview first
node tools/qualification/sharepointLive.mjs capture --confirm-live-tenant-write [see doc for all flags] \
  --out docs/release/qualifications/sharepoint-live-acceptance.json
node tools/release/qualification.mjs verify --require-live --gate sharepoint-live-acceptance \
  --evidence docs/release/qualifications/sharepoint-live-acceptance.json
```

The record is valid for 30 days, and only for the build it names.

### 121: Teams configuration workload qualification (decisions needed)

Steps: [teams-live-acceptance.md › Operator steps](teams-live-acceptance.md#operator-steps).
It runs only after 120's record verifies at the same build; the capture refuses before any
request otherwise. It flips one setting on the fixture team only, then puts it back, and
adds, promotes, demotes and removes the fixture member. No tenant-wide Teams setting changes.

**Decisions needed before capture.**
- Whether the disposable member account may exist permanently or is created for each
  capture and deleted afterwards.
- Granting the Teams application permissions (`TeamSettings.ReadWrite.All`,
  `TeamMember.ReadWrite.All` and the read set). Graph has no per-team consent for these,
  so they apply tenant-wide even though the capture addresses only the fixture team.

```bash
node tools/qualification/teamsLive.mjs plan --fixture-team-id <team id> --fixture-member-user-id <user id>   # offline preview first
node tools/qualification/teamsLive.mjs capture --confirm-live-tenant-write [see doc for all flags] \
  --sharepoint-evidence docs/release/qualifications/sharepoint-live-acceptance.json \
  --out docs/release/qualifications/teams-live-acceptance.json
node tools/release/qualification.mjs verify --require-live --gate teams-live-acceptance \
  --evidence docs/release/qualifications/teams-live-acceptance.json
```

The record is valid for 30 days, only for the build it names, and only while the
SharePoint record beside it also verifies.

### 117: Sentinel workspace ingestion qualification (descoped)

Steps: [sentinel-live-acceptance.md › Operator steps](sentinel-live-acceptance.md#operator-steps).
Descoped by operator decision 2026-10-04 12:36 UTC; the release ledger lists it as an accepted gap. Nothing here needs doing unless you take it up again. Every Azure
resource is yours to create in a TEST subscription; the tool never provisions anything. The
capture sends probe events through the production task-80 adapter, restarts the adapter and
replays them under the same event ids, then reads them back with two read-only KQL queries.
The record proves logical dedup by event id. It never claims unique physical rows or
exactly-once ingestion.

**Decision needed before capture.** Whether to stand up the test workspace, DCE/DCR and the
two app registrations at all, and in which subscription.

```bash
node tools/qualification/sentinelLive.mjs plan --tenant-ref <tenant_ref> --destination-id <id>   # offline preview first
node tools/qualification/sentinelLive.mjs capture --confirm-live-workspace-ingest [see doc for all flags] \
  --out docs/release/qualifications/sentinel-live-acceptance.json
node tools/release/qualification.mjs verify --require-live --gate sentinel-live-acceptance \
  --evidence docs/release/qualifications/sentinel-live-acceptance.json
```

The record is valid for 30 days, only for the build and tenant it names.

### 118: ServiceNow non-default workflow qualification

Steps: [servicenow-live-acceptance.md › Operator steps](servicenow-live-acceptance.md#operator-steps).
The capture refuses any instance you have not declared non-production on its command line, and
any instance that reports `glide.installation.production=true`. It acts in the instance only as
your two declared test users, each with their own token. KEEL's own token creates the four records
and writes only KEEL's fields. The KEEL side runs in a dedicated qualification database, never the
production one.

```bash
node tools/qualification/servicenowLive.mjs plan --config servicenow-config.json --test-users servicenow-test-users.json   # offline first
node tools/qualification/servicenowLive.mjs capture --confirm-non-production-instance <instance host> --declared-by "<you>" \
  [see doc for all flags] --out docs/release/qualifications/servicenow-live-acceptance.json
node tools/release/qualification.mjs verify --require-live --gate servicenow-live-acceptance \
  --tenant <tenant_ref> --evidence docs/release/qualifications/servicenow-live-acceptance.json
```

The record is valid for 30 days, only for the build and tenant it names.

### 122: Exchange configuration workload qualification (decisions needed)

Steps: [exchange-live-acceptance.md › Operator steps](exchange-live-acceptance.md#operator-steps).
It runs only after the 120 and 121 records verify at the same build. It changes the fixture
mailbox's `timeZone` and `PopEnabled` and puts them back, extends its deleted-item retention
by one day (never shortens it), never sends `Set-OrganizationConfig`, and never reads mail
content. The PowerShell image must be rebuilt first: task-105 added `run-cmdlet.ps1` to it.

**Decisions needed before capture** (full list in the doc's "Open operator decisions"):
- **Restorer Exchange grant.** The Restorer holds Graph `MailboxSettings.ReadWrite` only
  (2026-09-30 decision). `Set-CASMailbox` and `Set-Mailbox` need `Exchange.ManageAsApp` and
  the Exchange Administrator role (or a narrower custom role, which changes task-105's
  declarations). Without it the write steps cannot be captured.
- **Collector role.** It holds the same Exchange role as the writes; the log proves it never
  ran a `Set-` cmdlet, but not that its role is read-only.
- **Organization-wide settings** stay unqualified and disabled until you decide which
  setting may be flipped and put back tenant-wide.
- **Fixture retention.** Each capture adds a day; about 16 captures fit before 30 days.

```bash
node tools/qualification/exchangeLive.mjs plan --fixture-mailbox keel-rt-20260908-alice@<tenant domain>   # offline preview first
node tools/qualification/exchangeLive.mjs capture --confirm-live-tenant-write [see doc for all flags] \
  --teams-evidence docs/release/qualifications/teams-live-acceptance.json \
  --out docs/release/qualifications/exchange-live-acceptance.json
node tools/release/qualification.mjs verify --require-live --gate exchange-live-acceptance \
  --evidence docs/release/qualifications/exchange-live-acceptance.json
```

The record is valid for 30 days, only for the build it names, and only while the Teams and
SharePoint records beside it also verify.

### 123: OneDrive and Purview configuration qualification (decisions needed)

Steps: [onedrive-purview-live-acceptance.md › Operator steps](onedrive-purview-live-acceptance.md#operator-steps).
It runs only after the 122 record verifies at the same build. It changes the fixture label's
admin-only `Comment` and puts it back, and adds the fixture label to the fixture policy. It
never removes the label, because removing it would unpublish. Before sending, it refuses
anything that would weaken protection, unpublish a label, read item-applied labels or touch
OneDrive content. A preservation-locked object is refused.

**Decisions needed before capture** (full list in the doc's "Open operator decisions"):
- **Restorer Purview grant.** `Set-Label` and `Set-LabelPolicy` need `Exchange.ManageAsApp`
  and the Compliance Administrator role (tenant-wide), or a narrower custom role group,
  which changes task-106's declarations.
- **Collector grants** (`Sites.FullControl.All` with SharePoint Administrator, and Compliance
  Administrator) can write; the log proves they never did, but not that the roles are
  read-only.
- **Tenant-wide label reads.** `Get-Label` and `Get-LabelPolicy` return every label and
  policy *definition* (never content). The record keeps only counts and a fingerprint for
  non-fixture objects. Confirm this is acceptable.
- **Fixtures are made by hand**: KEEL has no create cmdlet. Each capture leaves its label
  published to the fixture-only policy, so the next capture needs a fresh `KEEL-RT-*` label.

```bash
node tools/qualification/onedrivePurviewLive.mjs plan --fixture-site <OneDrive URL> \
  --fixture-label KEEL-RT-<label> --fixture-policy KEEL-RT-<policy>   # offline preview first
node tools/qualification/onedrivePurviewLive.mjs capture --confirm-live-tenant-write [see doc for all flags] \
  --exchange-evidence docs/release/qualifications/exchange-live-acceptance.json \
  --out docs/release/qualifications/onedrive-purview-live-acceptance.json
node tools/release/qualification.mjs verify --require-live --gate onedrive-purview-live-acceptance \
  --evidence docs/release/qualifications/onedrive-purview-live-acceptance.json
```

The record is valid for 30 days and only for the build it names.

## Already qualified

| Task | Gate | State |
|---|---|---|
| 119 | `nist-benchmark-acceptance` | Live-qualified (`docs/release/qualifications/nist-benchmark-acceptance.json`). Recapture at a new build with `tools/qualification/nistLive.mjs` ([steps](nist-benchmark-acceptance.md#operator-steps)) |
| 126 | `scubagear-benchmark-acceptance` | Live-qualified (`scubagear-benchmark-acceptance.live.json`) |

## Not yet capturable (code not built, or waiting on another gate)

| Task | Gate needs | Waiting on |
|---|---|---|
| 104, 105 | Teams and Exchange adapters (merged, ship disabled) | Enabling waits on the 120, 121 and 122 captures |
| 106 | OneDrive and Purview label configuration adapter (merged, ships disabled) | Enabling waits on the 120, 121, 122 and 123 captures |
| 112 | Six end-to-end journeys and the release ledger (merged, #68) | Its ledger reports release readiness pending until the live gates above pass (how to run it: [docs/release/acceptance.md](../release/acceptance.md)) |
| 124 | Complete roadmap release verification without overclaiming | 112–119, and the task-114 dependency edit noted above |

## Suggested order

1. **113** and **114**: neither touches the tenant.
2. **115** and **116**: one disposable group each, created or deleted only by the tool.
3. **120**, once you have made the tenant-wide toggle decision, then **121** at the same
   build once you have made its two decisions, then **122** (after the Exchange grant
   decision) and **123**. The chain is strictly ordered: each capture requires the
   previous record to verify at the same build.
4. **118**, once the non-production ServiceNow instance is set up: it touches no tenant
   object.
5. **117** is descoped (accepted gap). Only if you take it up again: it needs Azure resources in a test
   subscription and touches no tenant object.
