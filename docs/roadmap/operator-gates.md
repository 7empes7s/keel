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

## Already qualified

| Task | Gate | State |
|---|---|---|
| 119 | `nist-benchmark-acceptance` | Live-qualified (`docs/release/qualifications/nist-benchmark-acceptance.json`) |
| 126 | `scubagear-benchmark-acceptance` | Live-qualified (`scubagear-benchmark-acceptance.live.json`) |

## Not yet capturable (code not built, or waiting on another gate)

| Task | Gate needs | Waiting on |
|---|---|---|
| 104 | Teams adapter; activation stays gated on SharePoint qualification | Code in progress tonight; enabling waits on 120's capture |
| 121 | A disposable Team and membership fixture plus Teams-specific evidence | 104's code; 120's capture |
| 105, 122 | A disposable mailbox configuration fixture and a qualified Exchange app/RBAC context | 104, 121 |
| 106, 123 | Disposable site and configuration-label fixtures plus family-specific privilege evidence | 105, 122 |
| 118 | A configured non-production ServiceNow instance with mapped test users and workflow | 97 (ServiceNow adapter; session A's 93 → 96 → 97 chain is in progress) |
| 117 | A test Log Analytics workspace, DCR/stream, identity and receiver query evidence | Deferred by operator decision |
| 112 | Six end-to-end journeys and the release ledger | Its dependency list, which includes 95 and other tasks still in progress |
| 124 | Complete roadmap release verification without overclaiming | 112–119, and the task-114 dependency edit noted above |

## Suggested order

1. **113** and **114**: neither touches the tenant.
2. **115** and **116**: one disposable group each, created or deleted only by the tool.
3. **120**, once you have made the tenant-wide toggle decision. A pass unblocks 121, and
   with it the Teams, Exchange and OneDrive chain.
