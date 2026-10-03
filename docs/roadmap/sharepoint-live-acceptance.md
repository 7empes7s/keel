# SharePoint configuration workload qualification (task 120)

Date: 2026-10-03 UTC. Status: the code half is implemented and fixture-tested.
**The gate stays pending.** No live evidence exists, no tenant was read or written,
and the SharePoint read and write both stay disabled.

The external admission gate needs two things that cannot exist in a builder
container:
- a disposable `KEEL-RT-*` SharePoint site;
- a live capture from the real tenant, signed by the release runner.

This task builds everything else: the evidence contract, the gate validator, the
capture tool the operator runs, the import seam into the task-101 and task-103
ledgers, and the boundary tests. The checked-in record
`docs/release/qualifications/sharepoint-live-acceptance.json` is a placeholder with
`status: "pending"`. It fails `verify --require-live`, and it is meant to.

## What was built

### Gate validator (`tools/qualification/sharepointAcceptance.mjs`)

`validateSharePointLiveSubject` is registered additively in
`tools/release/qualification.mjs` as gate `sharepoint-live-acceptance`. It checks
the record against the production declarations it qualifies, not against a copy:
- the four task-101 reads (`WORKLOAD_DESCRIPTORS`): `sharepoint.tenant-settings`,
  `sharepoint.site-discovery`, `sharepoint.site-properties` and
  `sharepoint.site-permissions`;
- the task-103 write (`WORKLOAD_WRITE_OPERATIONS`):
  `sharepoint.tenant-settings.update` and its five fields.

On top of the generic verifier (schema, gate, tenant, freshness, proof,
`--require-live`), a record passes only when all of these hold.

| Check | Rule |
| --- | --- |
| Identity | Operation `sharepoint.configuration-qualification`. The build matches the expected build. Credential mode is `collector-read+restorer-write`. An expected tenant and build are both required. |
| Proof | Both proofs are needed: a trusted runner signature, and the SHA-256 of the raw capture log. The log digest is also inside the signed subject (`captureLogSha256`), so a log swapped together with its proof digest still fails. |
| Prerequisites | Tasks 101, 102 and 103 are named, and their declarations exist in this build. Each read has a successful, non-synthetic capture at its declared API version, taken no more than 24 hours before the record. |
| Grants | The collector holds every permission and role the four reads declare. The restorer holds the write's permission and role. The collector must **not** hold the write permission. The two credential references must differ. |
| Fixture | One site on the tenant host whose URL name starts with `KEEL-RT-`. It must pass the task-102 `siteInScope` check. |
| Zero content calls | Every logged request is re-checked against the task-101 scope validator. No site other than the fixture is addressed by id. The restorer only reads and PATCHes `/admin/sharepoint/settings`. The collector never writes. There are exactly two PATCHes. |
| Write and post-state | Mode `reversible-change`. The field is one of the five written fields. The change read back as written, the setting was put back, and the final settings fingerprint equals the starting one. A same-value write is refused, because it cannot show that the platform applies a change. |
| Field support | All five written fields were observed in the live settings. |
| Throttle | The number of 429 and 503 responses is recorded. A count of zero is valid, since a capture cannot force throttling. |
| Documentation | The record gives a retrieval date for each of the five declared documentation URLs (Global Constraint 8). |
| No secrets | No key or value in the record looks like a token, secret, password, private key or JWT. |

A record with `status: "pending"` fails before any other check. A record that
claims `live-qualified` while synthetic, or signed by `keel-fixture-runner`, fails
even without `--require-live`.

### Capture tool (`tools/qualification/sharepointLive.mjs`)

- **`plan` (the default)** is offline. It prints every request a capture would
  send.
- **`capture`** refuses to run (exit 2, nothing sent) without
  `--confirm-live-tenant-write`. It also refuses before any request when:
  - the fixture URL is not `/sites/KEEL-RT-*` on the tenant host;
  - the two credential references are missing or the same;
  - the tokens are not in the environment.
- **Requests, in order:**
  1. The collector reads the tenant settings.
  2. The collector reads site discovery (all pages). Only the site count is kept.
  3. The collector reads the fixture site's properties and app grants.
  4. The restorer reads the settings, then PATCHes
     `isResharingByExternalUsersEnabled` to the other value. It reads that back
     (up to 5 reads, 2 s apart), PATCHes the original value back, and reads that
     back too.
- **Write leg.** It runs only if every read succeeded and the fixture was found.
  - If the setting starts `false`, the first PATCH would widen sharing. That is
    refused unless `--allow-widening-toggle` is also given.
  - After an accepted first PATCH, the put-back is always attempted.
  - If the put-back fails, the output says exactly what to set by hand, and the
    exit code is 3.
- **Tokens and proof.** Tokens are read from `KEEL_SP_COLLECTOR_TOKEN` and
  `KEEL_SP_RESTORER_TOKEN` and never written. The record holds credential
  references only. The tool writes the record and its raw request log
  (`*.capture.json`) side by side, and binds the log's digest as the artifact
  proof. With `KEEL_QUALIFICATION_HMAC_KEY` set, it signs the record as
  `keel-release-runner`. It then runs the gate verifier and prints the result.

### Import seam (`ledgerEvidenceFromAcceptance`)

A record that passes the gate with `--require-live` becomes:
- `live-capture` evidence for `buildWorkloadLedger` (task 101);
- a `live-write-capture` for `workloadWriteQualification` (task 103);
- the collector's grants.

Anything that fails verification becomes nothing. Nothing in production calls this
seam yet, so no read or write is enabled by this task.

## Migration and legacy reads

- No schema change and no data change.
- The release CLI keeps its existing behaviour for every other gate. The SharePoint
  checks apply only when `gate` is `sharepoint-live-acceptance`.
- No legacy SharePoint qualification record exists. Any record without the fields
  above fails closed.

## Operator steps

These are needed to clear the gate. Run them from `/opt/keel` at the build being
qualified. Builders must not run them.

1. **Fixture site.** Create a disposable communication site named
   `KEEL-RT-<yyyymmdd>`, for example
   `https://<tenant>.sharepoint.com/sites/KEEL-RT-20261004`. It holds no content.
2. **Decide on the tenant-wide toggle.** This is an open decision for the operator.
   Graph v1.0 has no site-scoped version of the setting that task 103 restores. The
   capture therefore flips the tenant-wide `isResharingByExternalUsersEnabled` for a
   few seconds and puts it back. That goes beyond the "only `KEEL-RT-*` fixtures"
   sandbox guardrail.
   - If the setting is `true`, the flip narrows sharing.
   - If it is `false`, the flip would widen sharing, and needs
     `--allow-widening-toggle`.
3. **Credentials.** Use two separate apps.
   - **Collector:** `SharePointTenantSettings.Read.All`, `Sites.Read.All`,
     `Sites.FullControl.All`, and the SharePoint Administrator role.
   - **Restorer:** `SharePointTenantSettings.ReadWrite.All` and the SharePoint
     Administrator role.

   Put what each app actually holds into `grants.json`:
   `{ "collector": { "permissions": [...], "roles": [...] }, "restorer": { ... } }`.
4. **Documentation.** Re-read the five pages, and record each URL with its retrieval
   time in `docs.json`: `[{ "url": "...", "retrievedAt": "<ISO time>" }]`. The URLs
   are printed by:
   ```bash
   node -e "import('./tools/qualification/sharepointAcceptance.mjs').then(m => console.log(m.requiredDocumentation().join('\n')))"
   ```
5. **Preview, offline:**
   ```bash
   node tools/qualification/sharepointLive.mjs plan --tenant-host <tenant>.sharepoint.com \
     --fixture-site-url https://<tenant>.sharepoint.com/sites/KEEL-RT-<yyyymmdd>
   ```
6. **Capture.** Tokens are acquired by the operator, and the HMAC key is the release
   runner's:
   ```bash
   KEEL_SP_COLLECTOR_TOKEN=... KEEL_SP_RESTORER_TOKEN=... KEEL_QUALIFICATION_HMAC_KEY=... \
   node tools/qualification/sharepointLive.mjs capture --confirm-live-tenant-write \
     --tenant-ref <tenant_ref> --tenant-host <tenant>.sharepoint.com \
     --fixture-site-url https://<tenant>.sharepoint.com/sites/KEEL-RT-<yyyymmdd> \
     --collector-ref app:<collector app id> --restorer-ref app:<restorer app id> \
     --grants grants.json --docs docs.json --build "$(git rev-parse HEAD)" \
     --out docs/release/qualifications/sharepoint-live-acceptance.json
   ```
   This replaces the pending placeholder and writes
   `sharepoint-live-acceptance.capture.json` next to it. Exit codes:
   - 0: verified;
   - 1: captured, but did not verify;
   - 3: check the tenant setting by hand.
7. **Verify** (the task's final Validate step):
   ```bash
   KEEL_QUALIFICATION_HMAC_KEY=... KEEL_QUALIFICATION_TENANT_REF=<tenant_ref> \
   node tools/release/qualification.mjs verify --require-live --gate sharepoint-live-acceptance \
     --evidence docs/release/qualifications/sharepoint-live-acceptance.json
   ```
   The record is valid for 30 days, and only for the build it names.

## Proof

`engine/roadmap/sharepoint-live-acceptance.test.mjs` has 9 tests. They need no
database. The capture tool runs against an in-memory Graph that:
- throttles the first discovery page;
- serves a KEEL-RT site and an HR site;
- applies PATCHes.

Records are signed with a test-only key in a temporary directory and never kept.

- **A valid capture verifies.** The HR site is never addressed, there are zero
  content calls, there are exactly two PATCHes, and the tenant ends where it
  started.
- **An altered signature, an edited field, an edited capture log, or a swapped log
  with its own digest** each fail.
- **Wrong tenant, build, operation, credential mode, gate, write operation, API
  version, shared credentials, or a non-KEEL-RT or off-host fixture** each fail,
  even when re-signed by the trusted runner.
- **Stale evidence fails:**
  - an old record;
  - a read or write captured long before the record;
  - an undated documentation entry.
- **A missing prerequisite fails:**
  - a task not named;
  - a read missing or failed;
  - a missing permission or role;
  - a collector that holds the write permission;
  - an unobserved field;
  - no write capture.
- **Missing external evidence fails.** The checked-in pending record fails, with or
  without `--require-live`, and the release CLI exits 1 on it. An absent file fails.
  So does a record without its capture log or without a runner signature.
- **Fixture evidence is never elevated:**
  - a fixture-runner signature fails, with or without `--require-live`;
  - so does a synthetic record, a `fixture-tested` level, a synthetic read, or a
    same-value write.
  - The import seam yields nothing for any of them. A verified record makes the
    four reads and the write `live-qualified` in their ledgers, for its own tenant
    only.
- **Request-log checks.** A content call (`/drive/root/children`, `/lists`),
  another site, a collector write, a restorer write elsewhere, a restorer read
  elsewhere, a third PATCH, or a token in the record each fail.
- **The tool:**
  - `plan` and an unconfirmed `capture` send nothing;
  - non-fixture and off-host sites are refused;
  - a widening first write is refused with zero PATCHes;
  - a platform that ignores the write does not verify;
  - a failed put-back is reported and never verifies.

Required mutations were each applied alone and then restored (2026-10-03):

| Mutation | Pass | Fail |
| --- | --- | --- |
| Accept missing external evidence (a pending record verifies) | 8 | 1 |
| Accept missing external evidence (no capture log required) | 7 | 2 |
| Accept mismatched operation (no operation check) | 8 | 1 |
| Accept mismatched tenant (no cross-tenant check) | 7 | 2 |
| Elevate fixture evidence to live-qualified (no fixture-claim check) | 8 | 1 |
| Elevate fixture evidence to live-qualified (import seam without `--require-live`) | 8 | 1 |

**Validation:** `node --test engine/roadmap/sharepoint-live-acceptance.test.mjs
engine/authz/*.test.mjs engine/jobs/*.test.mjs engine/collect/*.test.mjs
engine/coverage/*.test.mjs engine/cir/*.test.mjs` gives 23 pass, 0 fail.
- The final `verify --require-live` step was run on the pending placeholder. It
  exits 1 with "SharePoint live evidence pending", as it must until the operator
  captures evidence.
- The CI restore-engine set gives 224 pass, 0 fail. The new suite has been added to
  it.
- Portal: `npm test` gives 135 pass, and `npm run build` is clean.

## Limitations

- **No live proof.** This task proves the gate's code behaviour only. Whether
  Microsoft accepts the PATCH, which fields it actually returns, and the real
  permissions are all unknown until a capture runs.
- **Documentation not re-fetched.** learn.microsoft.com is blocked from this
  environment, so the declared URLs come from tasks 101 and 103. The capture
  requires the operator to re-read them.
- **One field.** The live write proves one field
  (`isResharingByExternalUsersEnabled`) round-trips. The other four written fields
  are qualified as observed by the live read only. The restore's own read-back
  (`verification-failed`) remains the per-run check for them.
- **Tenant-wide toggle.** See operator step 2. This is not resolved by this task.
- **Per-site settings.** `sharepoint.site-sharing` (PnP) is not part of this gate. It
  stays unqualified and manual.
- **Nothing is wired yet.** No worker job or portal view consumes the import seam.
  Wiring the qualification into `collectSharePointSites` and
  `executeSharePointRestore` at run time is follow-up work, once a verified record
  exists.
- **Unrelated failures.** `engine/roadmap/nist-benchmark-acceptance.test.mjs` and
  `scubagear-benchmark-acceptance.test.mjs` fail in this container on master too:
  they need `/var/lib/keel/reference-data`. They are not part of CI.
