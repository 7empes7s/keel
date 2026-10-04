# Exchange configuration workload qualification (task 122)

Date: 2026-10-04 UTC. Status: the code half is implemented and fixture-tested.
**The gate stays pending.** No live evidence exists, no tenant or mailbox was read or
written, and every Exchange read and write stays disabled.

The external admission gate needs things that cannot exist in a builder container:
- a disposable mailbox configuration fixture (a `keel-rt-*` user mailbox);
- a qualified Exchange app and RBAC context (see the open operator decisions below);
- a verified task-121 Teams record, which itself needs the task-120 SharePoint
  record (both still pending);
- a live Exchange capture from the real tenant, signed by the release runner.

This task builds everything else: the evidence contract, the gate validator, the
capture tool the operator runs, the import seam into the task-101 and task-105
ledgers, and the boundary tests. The checked-in record
`docs/release/qualifications/exchange-live-acceptance.json` is a placeholder with
`status: "pending"`. It fails `verify --require-live`, and it is meant to.

## What was built

### Gate validator (`tools/qualification/exchangeAcceptance.mjs`)

`validateExchangeLiveSubject` is registered additively in
`tools/release/qualification.mjs` as gate `exchange-live-acceptance` (one import and
one entry in `GATE_VALIDATORS`; the wrapper passes the runner-proof result and the
release `verifyEvidence`, so the module never imports the release verifier). It checks
the record against the production declarations it qualifies, not against a copy:
- the four task-105 reads (`WORKLOAD_DESCRIPTORS`): `exchange.mailbox-settings` (Graph),
  `exchange.client-access`, `exchange.mailbox-hold` and `exchange.organization-config`
  (cmdlets);
- three task-105 writes (`WORKLOAD_WRITE_OPERATIONS`), each with its own capture:
  `exchange.mailbox-settings.update`, `exchange.client-access.update` and
  `exchange.mailbox-retention.update`.

The fourth write, `exchange.organization-config.update` (`Set-OrganizationConfig`),
changes the whole tenant. It is **not** part of the capture: a record whose log sends
it, or that carries a capture for it, fails. It stays unqualified (see the open
operator decisions).

On top of the generic verifier (schema, gate, tenant, freshness, `--require-live`),
a record passes only when all of these hold.

| Check | Rule |
| --- | --- |
| Identity | Operation `exchange.configuration-qualification`. The build matches the expected build. Credential mode is `collector-read+restorer-write`. An expected tenant and build are both required. The record names the managed directory tenant id, and the Exchange organization reports the same id (`ExternalDirectoryOrganizationId` from `Get-OrganizationConfig`). |
| Proof | Both proofs are needed: a trusted runner signature, and the SHA-256 of the raw capture log. The log digest is also inside the signed subject (`captureLogSha256`), so a log swapped together with its proof digest still fails. |
| Prerequisites | Tasks 105 and 121 are named, and the Exchange declarations exist in this build. The task-121 Teams record named in `teamsQualification` must sit beside this record and verify on its own with `--require-live`, for the same tenant and build. That in turn needs the task-120 SharePoint record beside it. The Teams capture-log digest must be the one named. |
| Teams and SharePoint are not Exchange proof | They are prerequisites only. Every Exchange read and write needs its own capture in this record; a Teams or other operation id in an Exchange slot fails; the Exchange log digest may equal neither the Teams nor the SharePoint one; the Teams and SharePoint records fail this gate (gate mismatch) and the Exchange import seam. |
| Argument-safe execution | The record names the bounded `powershell-cmdlet-job` transport and the `ExchangeOnlineManagement` module with its version. Every cmdlet in the log has its parameters recorded as a data object (a parameter string fails). |
| Reads | Each read has a successful, non-synthetic capture at the version in use: `v1.0` for Graph, the recorded module version for cmdlets. Each was taken no more than 24 hours before the record. Every field the task-105 reader keeps (mailbox settings, client access, retention and hold, organization) was observed live. |
| Grants | The collector holds `MailboxSettings.Read`, `Exchange.ManageAsApp` and the `Exchange Administrator` role. The restorer holds `MailboxSettings.ReadWrite`, `Exchange.ManageAsApp` and `Exchange Administrator`. The collector must **not** hold `MailboxSettings.ReadWrite`. The two credential references must differ. |
| Fixture | One user mailbox (`RecipientTypeDetails: UserMailbox`) whose identity is a UPN starting with `keel-rt-`, which answered as that UPN and has a directory object id. |
| Zero content calls | Every Graph request is re-checked against the task-105 `assertExchangeRequest` shapes (only `/users/{id}/mailboxSettings`, no query) and the task-101 scope validator; every cmdlet against the task-105 cmdlet allowlist with its parameter names. Only the fixture mailbox is addressed, except one absent `keel-rt-*` probe identity, which must not answer. Only the collector reads the organization. The collector never writes. |
| Hold guard | `Set-Mailbox` may carry only `RetainDeletedItemsFor`, and only a value longer than the starting value and at most 30 days. Any `LitigationHoldEnabled`, `RetentionHoldEnabled` or `SingleItemRecoveryEnabled` in a `Set-Mailbox` fails. `Set-CASMailbox` may carry only `PopEnabled`. `Set-OrganizationConfig` always fails. |
| Write counts | Exactly 2 mailboxSettings PATCHes (change, put back), 2 `Set-CASMailbox` (change, put back), 1 `Set-Mailbox` (extend). A throttled (429/503) Graph write was not applied and is not counted. |
| Settings and client-access post-state | Mode `reversible-change`, on `timeZone` and `PopEnabled`. The change read back as written, was put back, and the final fingerprint of the whole observation group equals the starting one. |
| Retention post-state | Mode `extend-only`, on `RetainDeletedItemsFor`. Retention after is longer than before and at most 30 days. The three hold and recovery switches are recorded and unchanged, and the holds Purview owns (`InPlaceHolds`, compliance tag, delay holds, litigation hold duration) have the same fingerprint before and after. |
| Refusals | The record shows `Set-Mailbox -LitigationHoldDuration` (a held field KEEL never writes) and a `/messages` path refused before anything was sent. |
| Platform errors | The absent probe identity came back as a structured failure (`CMDLET_ERROR` with the platform's `errorId` and message), never as an empty success. |
| Throttle | The number of Graph 429 and 503 responses is recorded. A count of zero is valid. |
| Documentation | The record gives a retrieval date for each of the seven declared documentation URLs (Global Constraint 8). |
| No secrets | No key or value in the record looks like a token, secret, password, private key, certificate path or thumbprint, or JWT. |

A record with `status: "pending"` fails before any other check. A record that claims
`live-qualified` while synthetic, or signed by `keel-fixture-runner`, fails even
without `--require-live`.

### Capture tool (`tools/qualification/exchangeLive.mjs`)

- **`plan` (the default)** is offline. It prints every request and cmdlet a capture
  would send.
- **`capture`** refuses to run (exit 2, nothing sent) without
  `--confirm-live-tenant-write`. It also refuses before any request when:
  - the fixture is not a `keel-rt-*` UPN, the directory tenant id is not a GUID, or
    the module version is not `x.y.z`;
  - the two credential references or the two tenant config files are missing or the
    same;
  - the Graph tokens are not in the environment;
  - the task-121 Teams record does not verify with `--require-live` for this tenant
    and build, or does not sit beside `--out`.
- **Requests, in order.** Every Graph request is checked against the task-105 request
  shapes, and every cmdlet against the task-105 allowlist, before it is sent. Cmdlets
  go through `engine/powershell/jobQueue.mjs` `runCmdlet`: the identity and every value
  are JSON data splatted in the container, never script source.
  0. Offline: asks for `Set-Mailbox -LitigationHoldDuration` and for
     `/users/{fixture}/messages`. Both are refused locally and nothing is sent.
  1. The collector reads `mailboxSettings`, `Get-OrganizationConfig`, and
     `Get-Mailbox` and `Get-CASMailbox` for the fixture. Only the fields the task-105
     reader keeps are looked at (plus the UPN, object id and recipient type, and the
     organization's directory id). Nothing else in an answer is stored.
  2. The collector runs `Get-Mailbox` on an absent `keel-rt-absent-<random>@<domain>`
     identity and records the platform error as it came back.
  3. The restorer reads `mailboxSettings`, PATCHes `timeZone` to the other of `UTC` and
     `Greenwich Standard Time`, reads it back (up to 5 reads, 2 s apart), PATCHes the
     original back, and reads that back.
  4. The restorer runs `Get-CASMailbox`, `Set-CASMailbox -PopEnabled` to the other
     value, reads back, sets it back, and reads back.
  5. The restorer runs `Get-Mailbox`, then `Set-Mailbox -RetainDeletedItemsFor` one day
     **longer** (never past 30 days), and reads back. Retention is never put back,
     because that would shorten it. If retention is already 30 days, nothing is
     written and the retention write does not qualify.
- **Write legs.** They run only when every read succeeded, the organization reports
  the managed tenant, the fixture answered as its UPN and is a user mailbox, and the
  probe identity does not exist.
  - Only the fixture mailbox is written. No hold is released or changed, no
    retention is shortened, the mailbox is never deleted, and no message, folder,
    rule, calendar or contact is read.
  - `Set-OrganizationConfig` is never sent.
  - After an accepted first change, the put-back is always attempted.
  - If a put-back fails, the output says exactly what to fix by hand, and the exit
    code is 3.
- **Credentials and proof.** Graph tokens are read from `KEEL_EXCHANGE_COLLECTOR_TOKEN`
  and `KEEL_EXCHANGE_RESTORER_TOKEN` and never written. Cmdlet credentials stay in the
  two tenant config files the container reads (`--collector-config`,
  `--restorer-config`). The record holds credential references only. The tool writes
  the record and its raw request log (`*.capture.json`) side by side and binds the
  log's digest as the artifact proof. With `KEEL_QUALIFICATION_HMAC_KEY` set, it signs
  the record as `keel-release-runner`. It then runs the gate verifier and prints the
  result.

### Import seam (`ledgerEvidenceFromExchangeAcceptance`)

A record that passes the gate with `--require-live` becomes:
- `live-capture` evidence for the four Exchange reads in `buildWorkloadLedger`;
- one `live-write-capture` for each of the three captured writes, for
  `workloadWriteQualification`;
- the collector's grants, the restorer's grants (the Exchange writes declare
  `grantsRequired`), and the module version the cmdlet captures are bound to
  (`runtime.modules`).

Anything that fails verification becomes nothing. The Exchange writes stay disabled
unless the Teams settings write (and so SharePoint's) is also qualified, through the
existing task-105 `requires`. Exchange evidence alone never enables them. A different
module version at run time invalidates the cmdlet captures. Nothing in production
calls this seam yet, so no read or write is enabled by this task.

## Server, CLI and UI integration

- **CLI:** the release CLI verifies the new gate
  (`node tools/release/qualification.mjs verify --gate exchange-live-acceptance ...`).
  The capture tool is the operator CLI.
- **Server and UI:** none in this task. There is no evidence to show yet, and the
  coverage report already shows the Exchange operations as disabled with their reason.
  Wiring the imported evidence into `collectExchange` and `executeExchangeRestore` is
  follow-up work once a verified record exists.

## Migration and legacy reads

- No schema change and no data change.
- The release CLI keeps its existing behaviour for every other gate. The Exchange
  checks apply only when `gate` is `exchange-live-acceptance`.
- No legacy Exchange qualification record exists. Any record without the fields above
  fails closed.

## Open operator decisions

These are not taken by this task. The capture works around the first; the others
block the gate until the operator decides.

1. **Organization-wide writes (`Set-OrganizationConfig`).** Any change to the
   organization configuration affects the whole tenant, even if it is put back
   seconds later. The capture never sends it, so `exchange.organization-config.update`
   stays unqualified and disabled. Qualifying it needs an explicit operator decision:
   which setting may be flipped and put back tenant-wide, and when. That would be a
   separate, additive capture leg.
2. **Exchange app-only grant for the Restorer.** The task-105 status records (operator
   decision 2026-09-30) that the Restorer holds Graph `MailboxSettings.ReadWrite` only,
   with no `Exchange.ManageAsApp` or Exchange role. `Set-CASMailbox` and `Set-Mailbox`
   cannot run without them, so steps 4 and 5 cannot be captured until the operator
   grants them (or decides on a narrower custom role, which would change the task-105
   declarations).
3. **Collector role.** The task-105 declarations give the cmdlet reads the same
   `Exchange Administrator` role as the writes. The gate can separate the Graph
   permissions (the collector may not hold `MailboxSettings.ReadWrite`), and the log
   proves the collector never ran a `Set-` cmdlet. It cannot prove the collector's
   Exchange role is read-only. A read-only role (for example View-Only Organization
   Management) would need a declaration change.
4. **Retention on the fixture.** Each capture extends the fixture's deleted item
   retention by one day and never puts it back (that would shorten it). From the
   default 14 days, about 16 captures fit before the 30-day ceiling. After that a new
   fixture mailbox is needed, or the operator shortens it by hand outside KEEL.
5. **Fixture mailbox.** The existing fixture user `keel-rt-20260908-alice` may be used
   for mailbox settings. The capture never deletes it and never reads its content. Its
   `timeZone` and `PopEnabled` are changed and put back, and its retention is extended.

## Operator steps

These are needed to clear the gate. Run them from `/opt/keel` at the build being
qualified. Builders must not run them.

1. **SharePoint and Teams first.** Complete the task-120 and task-121 operator steps
   (`docs/roadmap/sharepoint-live-acceptance.md`, `docs/roadmap/teams-live-acceptance.md`)
   at this same build. Their records and capture logs must verify and stay in
   `docs/release/qualifications/`.
2. **Fixture mailbox.** Use the fixture user `keel-rt-20260908-alice@<tenant domain>`
   (a licensed user mailbox), or another disposable `keel-rt-*` user mailbox. Check
   that its deleted item retention is below 30 days and that no hold is needed on it.
3. **Credentials.** Use two separate apps.
   - **Collector:** Graph `MailboxSettings.Read`; Exchange `Exchange.ManageAsApp` with
     the `Exchange Administrator` role; its certificate in a tenant config file such as
     `/etc/keel/exchange-collector.json` (`clientId`, `organization` = the
     `.onmicrosoft.com` domain, `certPath`, `keyPath`).
   - **Restorer:** Graph `MailboxSettings.ReadWrite`; Exchange `Exchange.ManageAsApp`
     with the `Exchange Administrator` role (open decision 2); its own tenant config
     file such as `/etc/keel/exchange-restorer.json`.

   Put what each app actually holds into `grants.json`:
   `{ "collector": { "permissions": [...], "roles": [...] }, "restorer": { ... } }`.
4. **Module version.** Record the module version in the PowerShell image:
   ```bash
   docker run --rm --entrypoint pwsh keel-powershell:latest -NoProfile -Command \
     "(Get-Module -ListAvailable ExchangeOnlineManagement | Sort-Object Version -Descending | Select-Object -First 1).Version.ToString()"
   ```
5. **Documentation.** Re-read the seven pages and record each URL with its retrieval
   time in `docs.json`: `[{ "url": "...", "retrievedAt": "<ISO time>" }]`. The URLs are
   printed by:
   ```bash
   node -e "import('./tools/qualification/exchangeAcceptance.mjs').then(m => console.log(m.exchangeRequiredDocumentation().join('\n')))"
   ```
6. **Preview, offline:**
   ```bash
   node tools/qualification/exchangeLive.mjs plan --fixture-mailbox keel-rt-20260908-alice@<tenant domain>
   ```
7. **Capture.** Graph tokens are acquired by the operator, and the HMAC key is the
   release runner's:
   ```bash
   KEEL_EXCHANGE_COLLECTOR_TOKEN=... KEEL_EXCHANGE_RESTORER_TOKEN=... KEEL_QUALIFICATION_HMAC_KEY=... \
   node tools/qualification/exchangeLive.mjs capture --confirm-live-tenant-write \
     --tenant-ref <tenant_ref> --directory-tenant-id <tenant id> \
     --fixture-mailbox keel-rt-20260908-alice@<tenant domain> \
     --collector-ref app:<collector app id> --restorer-ref app:<restorer app id> \
     --collector-config /etc/keel/exchange-collector.json --restorer-config /etc/keel/exchange-restorer.json \
     --exchange-module-version <x.y.z> --grants grants.json --docs docs.json --build "$(git rev-parse HEAD)" \
     --teams-evidence docs/release/qualifications/teams-live-acceptance.json \
     --out docs/release/qualifications/exchange-live-acceptance.json
   ```
   This replaces the pending placeholder and writes
   `exchange-live-acceptance.capture.json` next to it. Exit codes:
   - 0: verified;
   - 1: captured, but did not verify;
   - 2: refused before any request (including an unverified Teams record);
   - 3: check the fixture mailbox's `timeZone` or `PopEnabled` by hand.
8. **Verify** (the task's final Validate step):
   ```bash
   KEEL_QUALIFICATION_HMAC_KEY=... KEEL_QUALIFICATION_TENANT_REF=<tenant_ref> \
   node tools/release/qualification.mjs verify --require-live --gate exchange-live-acceptance \
     --evidence docs/release/qualifications/exchange-live-acceptance.json
   ```
   The record is valid for 30 days, only for the build it names, and only while the
   Teams and SharePoint records beside it also verify.

## Proof

`engine/roadmap/exchange-live-acceptance.test.mjs` has 9 tests. They need no database.
All three capture tools run against in-memory fakes. The SharePoint and Teams ones
produce the verified task-120 and task-121 prerequisites. The Exchange one has:
- a Graph `mailboxSettings` endpoint that throttles the first read and adds a
  content-adjacent property to its answer;
- a fake PowerShell container behind the real `jobQueue.mjs` spawn path. It plays the
  `run-cmdlet.ps1` contract, with the allowlist parsed from the script, and its
  answers carry content-adjacent properties (recent subjects, item size);
- one fixture mailbox, an organization with its directory id, and an absent probe
  identity that answers with `ManagementObjectNotFoundException`.

Records are signed with a test-only key in a temporary directory and never kept.

- **A valid capture verifies.** Only the fixture (and the absent probe) is addressed.
  There are zero content calls, every job is a data descriptor, and the collector and
  restorer use their own config files. The writes are exactly 2 PATCHes, 2
  `Set-CASMailbox` and 1 `Set-Mailbox`, and never `Set-OrganizationConfig`.
  `timeZone` and `PopEnabled` end where they started, and retention ends one day
  longer with no hold moved. The held field was refused unsent, and the platform
  error was kept structured. No content-adjacent value and no secret is in the
  record or log.
- **An altered signature, an edited field, an edited capture log, or a swapped log
  with its own digest** each fail.
- **Wrong tenant, build, operation, credential mode, gate, write operation, API or
  module version, shared credentials, a non-`keel-rt` or shared mailbox, a mailbox
  answering as another UPN, or an organization or directory in another tenant** each
  fail, even when re-signed by the trusted runner.
- **Stale evidence fails:** an old record (and its Teams prerequisite with it); a
  read, a settings write or a retention write captured long before the record; a
  capture after the record; an undated documentation entry.
- **A missing prerequisite fails:**
  - the Teams record: task-121 not named; no, absent, non-local, wrong-gate or
    wrong-digest reference; a tampered record; one missing its own SharePoint
    record; one for another build;
  - the capture itself: a missing or failed read; no module version or no bounded
    transport; a missing permission or role; a collector holding
    `MailboxSettings.ReadWrite`; an unobserved field; a missing write capture;
  - refusals and errors: no held-field refusal; a content path that was sent; a
    probe recorded as success; a platform error without its code.
- **Teams and SharePoint are not Exchange proof:** both records fail this gate and
  the Exchange seam. Teams and SharePoint evidence alone leave every Exchange read
  and write unqualified. An Exchange log digest equal to either upstream one fails.
- **Missing external evidence fails.** The checked-in pending record fails, with or
  without `--require-live`, and the release CLI exits 1 on it. An absent file fails.
  So does a record without its capture log or without a runner signature.
- **Fixture evidence is never elevated:** a fixture-runner signature, a synthetic
  record, a `fixture-tested` level, a synthetic read, a synthetic write, or a
  same-value write each fail, and the import seam yields nothing for them.
  - With the verified SharePoint and Teams records, a verified Exchange record enables
    the three captured Exchange writes, each on its own Exchange capture, for its own
    tenant only.
  - It never enables `exchange.organization-config.update`.
  - Exchange evidence without Teams' enables none; unknown restorer grants block
    them; another module version invalidates the cmdlet captures.
- **Request-log checks.** Each of these fails:
  - content: a `/messages` path, a `$expand`, `Get-MailboxFolderStatistics`,
    `Search-Mailbox`, `Remove-Mailbox`;
  - addressing: another mailbox (read or write), a probe that answered, a restorer
    organization read, a collector write;
  - writes: an extra PATCH or `Set-CASMailbox`, another client-access switch,
    `Set-OrganizationConfig`;
  - the hold guard: a `Set-Mailbox` releasing a litigation hold, disabling single
    item recovery, shortening or not extending retention, or going past 30 days;
  - the record itself: a held field, a non-cmdlet transport, parameters recorded as a
    string, a shortened or hold-changing post-state, a changed Purview hold
    fingerprint, a client-access final state that differs from the start, an
    organization write capture, a token or certificate thumbprint.

  A throttled Graph write resent after Retry-After does not fail.
- **The tool:** `plan` and an unconfirmed `capture` send nothing, and `plan` never
  lists `Set-OrganizationConfig`.
  - A non-`keel-rt` mailbox, a bad module version, a probe equal to the fixture and a
    missing Teams reference are refused.
  - The CLI refuses on an unverified Teams record with zero requests and zero jobs.
  - An organization in another tenant, a shared mailbox and an existing probe
    identity each get zero writes.
  - Retention already at 30 days is never written and does not verify.
  - The settings toggle works from either time zone.
  - A platform that ignores settings, client-access or retention writes does not
    verify.
  - A failed client-access put-back keeps the platform's message, is reported
    (exit 3) and never verifies.

Required mutations were each applied alone and then restored (2026-10-04):

| Mutation | Pass | Fail |
| --- | --- | --- |
| Accept missing external evidence (a pending Exchange record verifies) | 8 | 1 |
| Accept missing external evidence (no capture log required) | 7 | 2 |
| Accept missing external evidence (no Teams prerequisite check) | 7 | 2 |
| Accept mismatched operation (no operation check) | 8 | 1 |
| Accept mismatched tenant (organization in another directory accepted) | 8 | 1 |
| Accept mismatched tenant (capture writes an organization in another tenant) | 8 | 1 |
| Elevate fixture evidence to live-qualified (no fixture-claim check) | 8 | 1 |
| Elevate fixture evidence to live-qualified (import seam without `--require-live`) | 8 | 1 |

**Validation** (2026-10-04). It was run in a container without `/etc/keel/db.env`, with
`KEEL_DB_TEST_URL` and `KEEL_TENANT_CONFIG_PATH` exported for a local PostgreSQL 16
instead.
- `node --test engine/roadmap/exchange-live-acceptance.test.mjs engine/authz/*.test.mjs
  engine/jobs/*.test.mjs engine/collect/*.test.mjs engine/coverage/*.test.mjs
  engine/cir/*.test.mjs` gives 23 pass, 0 fail.
- The final `verify --require-live` step was run on the pending placeholder. It exits 1
  with "exchange-live-acceptance external runner evidence pending", as it must until the
  operator captures evidence.
- The CI restore-engine set, with the new suite added to `.github/workflows/portal.yml`,
  gives 394 pass, 0 fail.
- Portal: `npm test` gives 156 pass, and `npm run build` is clean.

## Limitations

- **No live proof.** This task proves the gate's code behaviour only. It is not yet
  known whether Microsoft accepts the `timeZone` PATCH and the two `Set-` cmdlets,
  what the cmdlet objects really return, how long read-back takes, or what the real
  permissions are. That needs a capture.
- **Blocked behind Teams and SharePoint,** and behind the open Exchange grant for the
  Restorer (open decision 2).
- **`ExternalDirectoryOrganizationId` is unverified.** The tenant binding relies on
  `Get-OrganizationConfig` reporting the directory tenant id under that name. If a live
  run shows it does not, the capture refuses to write (fail closed), and the binding
  must be moved to another field.
- **Module version is declared by the operator** (step 4). The container's allowlist
  has no `Get-Module`, and this task does not widen it. A wrong value only makes the
  cmdlet captures fail to match the runtime later; it cannot enable anything.
- **`run-cmdlet.ps1` is still unrun.** Its first real execution is this capture. It
  expects an `organization` in each tenant config file (task-105 limitation).
- **Documentation not re-fetched.** learn.microsoft.com is not reachable from this
  environment, so the declared URLs come from tasks 101 and 105. The capture requires
  the operator to re-read them.
- **One property per write.** The live writes prove `timeZone`, `PopEnabled` and
  `RetainDeletedItemsFor` round-trip. The other fields are qualified as observed by the
  live reads only. The restore's own read-back (`verification-failed`) remains the
  per-run check for them. Hold switches are never written by a capture, so their
  restore path (which needs the separate high-impact approval) is not live-proven.
- **Retention is one-way** (open decision 4), so the capture leaves the fixture's
  retention one day longer.
- **Nothing is wired yet.** No worker job or portal view consumes the import seam.
