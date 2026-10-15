# Wave 2 writer live capture (`workload-writers-live-acceptance`)

The Wave 2 cmdlet writers (PR #280: mail flow, Exchange settings, Teams org-wide and
voice policies, Purview retention, DLP and retention labels) stay off until each write
operation has a live write capture from the test tenant. `tools/qualification/workloadWritesLive.mjs`
takes those captures, one record per written workload, and the ledger import stores them.

## What a capture writes

Per writer family, on the first object whose name starts with `KEEL-RT-` (the prefix decides,
never an exact name) and that reports no preservation lock:

- one field is set to a `KEEL capture <time>` marker, read back, put back and read back;
- the field is a comment or description, or on a policy (never a rule) a switch, and only when
  the content-effect classifier finds nothing in the change either way;
- a family that can re-create a named Teams policy also creates `KEEL-RT-capture-<random>` with a
  Description. KEEL never deletes, so it stays, assigned to nobody (`--no-create` skips this).

A family with no `KEEL-RT-` object, nothing harmless to change, or a lock is skipped and listed.
Global policies, tenant-wide settings (organization, federation, ActiveSync, Defender), journal
rules and device access rules are never written, so their writers stay off.

## Operator steps

From your own checkout at the deployed build `B`, with `KEEL_QUALIFICATION_HMAC_KEY` set, once per workload:

```
node tools/qualification/workloadWritesLive.mjs plan --workload exchange-mail-flow
node tools/qualification/workloadWritesLive.mjs capture --confirm-live-tenant-write \
  --workload exchange-mail-flow --tenant-ref <ref> --directory-tenant-id <tenant guid> \
  --collector-ref app:<collector id> --restorer-ref app:<restorer id> \
  --collector-config /etc/keel/exchange-collector.json --restorer-config /etc/keel/exchange-restorer.json \
  --module-version <ExchangeOnlineManagement version> --grants grants.json --build B \
  --out docs/release/qualifications/workload-writers-exchange-mail-flow-live-acceptance.json
node tools/release/qualification.mjs verify --require-live --gate workload-writers-live-acceptance \
  --evidence docs/release/qualifications/workload-writers-exchange-mail-flow-live-acceptance.json
```

- Workloads: `exchange-mail-flow`, `exchange-extended`, `purview-retention-dlp`, `purview-governance`
  (ExchangeOnlineManagement), `teams-org-policies`, `teams-voice-policies` (MicrosoftTeams, Teams configs).
- `grants.json` is `{ "collector": { permissions, roles }, "restorer": { permissions, roles } }`.
- Use the same container image as the Exchange record (gate 122): the import binds every
  ExchangeOnlineManagement write to one module version.
- Exit 0: verified. 1: the record does not verify. 3: a setting may not be back; the output names
  the object, field and original value to set by hand.
- Then commit the record and its `.capture.json`, and run `node cli/keel-workload-collect.mjs import`.
  A writer record that is absent is listed under `absent`, not refused.

## What it proves

The import seam turns each proven write (written, read back, put back) into a `live-write-capture`
row for that operation id. `workloadWriteQualification` still enables a writer only when its read
is live-qualified, its prerequisite write is enabled and the restorer's grants are observed.
