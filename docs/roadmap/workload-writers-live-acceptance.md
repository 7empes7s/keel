# Wave 2 writer live capture (`workload-writers-live-acceptance`)

The Wave 2 cmdlet writers (PR #280: mail flow, Exchange settings, Teams org-wide and
voice policies, Purview retention, DLP and retention labels) stay off until each write
operation has a live write capture from the test tenant. `tools/qualification/workloadWritesLive.mjs`
takes those captures, one record per written workload, and the ledger import stores them.

## What a capture writes

Per writer family, on the first object whose name starts with `KEEL-RT-` (the prefix decides,
never an exact name) and that reports no preservation lock:

- one field is set to a `KEEL capture <time>` marker, read back, put back and read back. The
  put-back is sent whenever the write may have applied, even when its read-back failed;
- the field is a comment or description, or on a policy (never a rule) a switch, and only when
  the content-effect classifier finds nothing in the change either way. A field with any effect
  rule is never chosen;
- a family that can re-create a named Teams policy also creates `KEEL-RT-capture-<random>` with a
  Description. KEEL never deletes, so it stays, assigned to nobody (`--no-create` skips this).

A family with no `KEEL-RT-` object, nothing harmless to change, or a lock is skipped and listed.
Global policies, journal rules and device access rules are never written, so their writers stay off.

### Tenant-wide settings (`--allow-tenant-wide-test-writes`)

Ten settings exist once per tenant and can never carry a `KEEL-RT-` name (`TENANT_WIDE_WRITES`):
Teams federation, client, guest meeting, guest messaging, guest calling and live events
configuration, and the Exchange connection filter, quarantine global settings, ActiveSync
organization settings and Defender for Office. Marouane allowed write-and-put-back captures of these in
the test tenant on 2026-10-15. Off by default; with `--allow-tenant-wide-test-writes` a capture:

- writes one only when its family has no `KEEL-RT-` object and the read returns exactly one object,
  which the restore guard (`workloadTarget`) also sees as tenant-wide;
- changes one harmless field as above, never a switch in `TENANT_WIDE_UNSAFE_SWITCHES` (Defender
  and Safe Documents, the IP safe list, unsupported ActiveSync platforms, the shared SIP address
  space, unverified federation partners, third-party live event delivery, supervised chat and scoped
  people search), reads it back and puts it back;
- runs only on the test tenant (`TEST_TENANT_REFS`); elsewhere it refuses before sending anything;
- marks the capture `scope: tenant-wide` and the record `tenantWide: true`. The gate refuses a
  tenant-wide capture in a record without it, on any other operation, or off the test tenant.

ActiveSync organization settings and Defender for Office are always skipped: ActiveSync has no
comment or true/false field, and every Defender field turns a protection off. Federation is
skipped too: its federation and domain fields are never written (`TRUST_FIELDS`), and each
remaining switch has a content-effect rule, unless its read shows another harmless switch.

## Operator steps

From your own checkout at the deployed build `B`, with `KEEL_QUALIFICATION_HMAC_KEY` set, once per workload:

```
node tools/qualification/workloadWritesLive.mjs plan --workload exchange-mail-flow
node tools/qualification/workloadWritesLive.mjs capture --confirm-live-tenant-write \
  --workload exchange-mail-flow --tenant-ref <ref> --directory-tenant-id <tenant guid> \
  --collector-ref app:<collector id> --restorer-ref app:<restorer id> \
  --collector-config /etc/keel/exchange-collector.json --restorer-config /etc/keel/exchange-restorer.json \
  --grants grants.json --build B \
  --out docs/release/qualifications/workload-writers-exchange-mail-flow-live-acceptance.json
node tools/release/qualification.mjs verify --require-live --gate workload-writers-live-acceptance \
  --evidence docs/release/qualifications/workload-writers-exchange-mail-flow-live-acceptance.json
```

- Workloads: `exchange-mail-flow`, `exchange-extended`, `purview-retention-dlp`, `purview-governance`
  (ExchangeOnlineManagement), `teams-org-policies`, `teams-voice-policies` (MicrosoftTeams, Teams configs).
- The record is bound to the workload's own module at the version `ops/powershell/Dockerfile` pins
  (MicrosoftTeams for the Teams workloads, ExchangeOnlineManagement for the rest). `--module-version`
  is optional; a value that is not that pin is refused before anything is sent.
- `grants.json` is `{ "collector": { permissions, roles }, "restorer": { permissions, roles } }`.
- Use the same container image as the Exchange record (gate 122): the import binds every
  ExchangeOnlineManagement write to one module version, and refuses a writer record captured at
  another version than the stored read proof.
- Exchange and Purview sessions connect by `organization`. Both configs must name the same one, and
  before anything is written both sessions must answer `Get-OrganizationConfig` with that name, or
  nothing is written. A session that reports a tenant id must report the managed tenant. The test
  tenant reports none; the record then says `tenantIdSource: config`, meaning the binding rests on
  the tenant config's organization, as it does for the Exchange collector itself.
- Exit 0: verified. 1: the record does not verify. 3: a setting may not be back; the output names
  the object, field and original value to set by hand.
- Then commit the record and its `.capture.json`, and run `node cli/keel-workload-collect.mjs import`.
  A writer record that is absent is listed under `absent`, not refused.

## What it proves

The gate also checks that every write request in the record belongs to a capture (same cmdlet,
same fixture identity, only that one field, the marker or the original value, at most a write and
its put-back), and that both refusal probes were refused before sending.

The import seam turns each proven write (written, read back, put back) into a `live-write-capture`
row for that operation id. `workloadWriteQualification` still enables a writer only when its read
is live-qualified, its prerequisite write is enabled and the restorer's grants are observed.
