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
| 117 | `sentinel-live-acceptance` | **Decision needed:** the gate is deferred by operator decision. When taken up: a TEST Log Analytics workspace with the `KeelEvents_CL` table, a DCE/DCR for the `Custom-KeelEvents` stream, a sender app with Monitoring Metrics Publisher on the DCR, and a separate reader app with Log Analytics Reader on the workspace | No tenant objects. Ingests 5 probe events (each twice) into the test workspace and runs two read-only KQL queries | ~30 min, plus ingestion delay | Claiming Sentinel export as live-qualified (task-80 adapter); 124 |
| 118 | `servicenow-live-acceptance` | The non-production ServiceNow instance (2026-09-30 decision) with a non-default workflow mapped in a KEEL adapter config, the relay table, signing property and business rule (`ops/servicenow/keel-callback-relay.js`), two test accounts that are not people with their own tokens, and a `…_qualification` KEEL database | No tenant objects. Creates four records and four test-user approvals in the non-production instance only | ~45 min, plus instance setup | Claiming the ServiceNow workflow as live-qualified (task-97 adapter, D6); 124 |

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
node tools/qualification/nativeRecovery.mjs capture --live --resource-type group \
  --object-id <id> --confirm-disposable-fixture <id> --target-config /etc/keel/restorer-target.json \
  --docs-retrieved-at <YYYY-MM-DD> --permission Group.ReadWrite.All --out docs/release/qualifications
node tools/release/qualification.mjs verify --require-live --gate native-live-acceptance \
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

### 117: Sentinel workspace ingestion qualification (decision needed)

Steps: [sentinel-live-acceptance.md › Operator steps](sentinel-live-acceptance.md#operator-steps).
Deferred by operator decision; nothing here needs doing until you take it up. Every Azure
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

## Already qualified

| Task | Gate | State |
|---|---|---|
| 119 | `nist-benchmark-acceptance` | Live-qualified (`docs/release/qualifications/nist-benchmark-acceptance.json`) |
| 126 | `scubagear-benchmark-acceptance` | Live-qualified (`scubagear-benchmark-acceptance.live.json`) |

## Not yet capturable (code not built, or waiting on another gate)

| Task | Gate needs | Waiting on |
|---|---|---|
| 104 | Teams adapter (merged, ships disabled) | Enabling waits on the 120 and 121 captures |
| 105, 122 | A disposable mailbox configuration fixture and a qualified Exchange app/RBAC context | 105's code (ready to build now that 104 and 121's code have merged); 122 also waits on 121's capture |
| 106, 123 | Disposable site and configuration-label fixtures plus family-specific privilege evidence | 105, 122 |
| 112 | Six end-to-end journeys and the release ledger | Its dependency list, which includes 95 and other tasks still in progress |
| 124 | Complete roadmap release verification without overclaiming | 112–119, and the task-114 dependency edit noted above |

## Suggested order

1. **113** and **114**: neither touches the tenant.
2. **115** and **116**: one disposable group each, created or deleted only by the tool.
3. **120**, once you have made the tenant-wide toggle decision, then **121** at the same
   build once you have made its two decisions. Together they unblock the Teams, Exchange
   and OneDrive chain.
4. **117**, only if you decide to take it up: it needs Azure resources in a test
   subscription and touches no tenant object.
